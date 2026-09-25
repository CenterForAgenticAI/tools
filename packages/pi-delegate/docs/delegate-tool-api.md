# `delegate({})` tool and API reference

`pi-delegate` lets a Pi session run specialist agents in several ways:

- one or more workers can run independently, in parallel or in a set order;
- a private supervisor can question and redirect a worker before returning one result;
- a detached driver can own a long-running, nested pipeline; and
- agent and chain definitions can be managed without starting any worker.

This page describes the contract registered by the `delegate` tool, its companion control tools, and the separate `delegateFromCli()` Node API. The registered schema in `src/index.ts` is the source of truth.

## At a glance

One dispatch is a list of runs. Each entry is one run with its own worker
session, and each collapses to one result.

```ts
delegate({
  runs: [{ agent: "reviewer", task: "Review the session store" }],
})
```

`mode` on an entry selects how that run is driven:

| `mode` | Supervisor | Use it for |
| --- | --- | --- |
| `solo` (default) | No | Independent jobs, in parallel or ordered with `after` |
| `supervised` | Yes | Review, clarification, and iteration |
| `driver` | Driver agent | A long-running detached multi-agent pipeline |

A dispatch is **homogeneous**: all-solo (with or without `after`), all-supervised,
or exactly one `driver` entry. Mixed modes reject with
`mixed run modes are not dispatchable in one call in v1; split the dispatch`.

Two top-level fields select something other than an inline run list:

| Selector | Meaning |
| --- | --- |
| `chain: "name"` | Resolve and run a saved `.chain.md` template |
| `action: ...` | Management: list or change definitions, or inspect health |

`action` is special: when present, management mode wins and run selectors are ignored. Do not mix them even though management dispatch is deterministic.

Most invalid mode/field pairs **reject with a pointer-quality error**. A few are
accepted and do nothing — `inert` below. The distinction matters: a rejection
tells you at dispatch, an inert field never will.

| Field | solo | supervised | driver |
| --- | --- | --- | --- |
| `after`, `count` | yes | rejected | rejected |
| `artifact`, `reads` | yes | rejected | rejected |
| `progress` | yes | accepted, ignored, warns once | rejected |
| `rounds` | rejected | yes | rejected |
| `clone_mode` | inert | yes | rejected |
| `task_delivery` | rejected | yes; defaults to `direct-first-turn` | rejected |
| `collapse_mode` | inert | yes | **inert** |
| `interactive`, `worktree`, `cwd`, `escalation` | yes | yes | rejected |
| `max_duration_ms`, `wind_down_grace_ms` | yes | yes | rejected |
| `depth` | yes | yes | yes |

`collapse_mode` on a driver entry is the one asymmetry: `clone_mode` rejects
there, `collapse_mode` does not, and the driver path then ignores it. That is
current behaviour, recorded here rather than implied away.

The advertised schema is deliberately compact. A runtime tail
(`confineWrites`, `writableRoots`, `readOnly`, `fallbackModels`, `thinkingMin`,
`thinkingMax`, `collapse_mode`, `summary_model`, `supervisor_instructions`,
`snippet_last_n`, `heartbeat_interval_ms`, `max_consecutive_heartbeats`,
`max_duration_ms`, `wind_down_grace_ms`) is accepted and strictly validated but
is not serialized to the model.

### Legacy call shapes

`agents: [...]`, `tasks: [...]`, an array `chain: [...]`, `chainName`,
`agent` + `task`, and `orchestrate: {...}` are **permanently accepted** and
normalized onto `runs[]` on ingress by `normalizeDelegateParams()`. They are no
longer advertised to the model and are not documented here. Write `runs[]`.

### Naming decision (#361; related reviews #144, #330, and #359)

`driver` is the canonical public mode and the role of the agent that may
create nested delegation. `detached` is a launch-lifecycle property: a detached
child survives the foreground turn and session lifecycle. It is not a second
mode name. `orchestrate` is retained only as the legacy top-level compatibility
transport and in internal implementation/path names; it is never a result mode,
status label, or new public spelling. New callers should write `mode: "driver"`.

## Common top-level options

```ts
interface CommonDelegateOptions {
  concurrency?: number;
  agent_scope?: "user" | "project" | "both";
  worktree?: boolean;

  await?: boolean;
  sync?: boolean; // deprecated alias for await
  notifyOnFailure?: boolean;
}
```

These fields apply only to modes that can use them.

### Agent discovery: `agent_scope`

`agent_scope` defaults to `"both"`. Discovery uses the following override order, with later same-named definitions winning:

```text
builtin < installed package < user < project
```

Builtin agents remain available unless global configuration disables all builtins or disables one through `agentOverrides`. Project-local definitions require Pi's native project-trust approval before a run starts.

### Background delivery and `await`

Every ordinary call runs in the background by default:

```ts
delegate({ runs: [{ agent: "worker", task: "Implement the parser fix" }] })
```

The immediate tool result contains a `runId`. When the run reaches a terminal state, `pi-delegate` automatically injects the complete output and starts a new agent turn. Callers must not poll, sleep, or busy-wait.

Use `await: true` only when the caller's next action cannot proceed without the result:

```ts
delegate({
  runs: [{ agent: "worker", task: "Implement the parser fix" }],
  await: true,
})
```

`sync` is the deprecated compatibility alias. Conflicting values are rejected:

```ts
{ await: true, sync: false } // error
```

Omitting both `await` and `sync` always selects background execution.

### Early failure delivery: `notifyOnFailure`

`notifyOnFailure` defaults to `true`. When a background direct worker, supervised run, or chain step fails, `pi-delegate` emits an early bounded `delegate:fork-failed` wake. Healthy siblings continue and the normal aggregate completion wake still occurs.

Set `notifyOnFailure: false` for aggregate-only delivery:

```ts
delegate({
  runs: [
    { agent: "reviewer", task: "Review package A" },
    { agent: "reviewer", task: "Review package B" },
  ],
  notifyOnFailure: false,
})
```

The early payload contains only the run and entry identity, categorical reason, sibling states, and recovery availability. It does not contain the task, prompts, transcript, paths, environment values, free-form output, or raw errors.

### Concurrency

Top-level `concurrency` applies to supervised and top-level direct batches. It defaults to `4` and is capped at the expanded number of workers. Use a positive integer.

Inline parallel chain steps have their own `concurrency` field.

### Git worktree isolation

Top-level `worktree: true` is supported by supervised and direct calls, including a single direct call. It:

- requires a clean Git working tree;
- creates one temporary Git worktree per worker;
- rejects any per-worker `cwd`;
- captures a diff before cleanup; and
- removes the temporary worktree after the worker finishes.

```ts
delegate({
  worktree: true,
  runs: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" },
  ],
})
```

A worktree is created off `HEAD` and carries only committed, tracked files (plus a symlinked `node_modules`), so a `reads` entry resolves against a tree that does not contain your untracked or gitignored working-tree files. For that reason `reads` and `worktree: true` are rejected together at dispatch — the whole combination, including absolute paths and typed artifact references, because none of them can be attested against the isolated tree. Give the worker its inputs another way: copy the files into the worktree with a `worktreeSetupHook`, or drop worktree isolation for that worker so an ordinary `reads` resolves against the caller's checkout.

Current chain caveats:

- top-level `worktree` has no chain effect;
- `worktree` is present on an inline parallel-chain step but current chain execution does not create worktrees for it; and
- detached driver mode rejects top-level `worktree`, including `worktree: false`, because the option must be omitted entirely.

## Shared worker-slot overrides

Direct workers, chain slots, and supervised inner workers accept invocation-local worker overrides:

```ts
type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type SkillOverride = string | string[] | false;
type EnvironmentPatch = Record<string, string | null>;

interface WorkerOverrides {
  model?: string;
  env?: EnvironmentPatch;

  thinking?: ThinkingLevel | false;
  thinkingMin?: ThinkingLevel | false;
  thinkingMax?: ThinkingLevel | false;
  fallbackModels?: string | string[];

  skill?: SkillOverride;
  skills?: SkillOverride;

  interactive?: boolean;
}
```

These values patch a cloned effective agent configuration for one slot only. They do not modify agent files, global settings, or sibling slots.

- `model` accepts `provider/id` or a bare model ID. A value equal to the active
  session model ID preserves that session's provider route. When a routed
  model ID itself has `provider/id` shape, that exact string is reserved for
  the active route and cannot simultaneously select the nested provider
  directly. Selecting that provider's same model is intentionally ambiguous
  and therefore remains on the active route.
- For invocation-local worker overrides, `fallbackModels` accepts a comma-separated string or string array; management `config` uses an array instead.
- `thinking` is the initial level; `thinkingMin` and `thinkingMax` bound compatible adaptive changes.
- Literal `false` clears one saved thinking field for this invocation.
- `skill` and `skills` are aliases. Use one. If both are supplied, `skill` wins.
- `skill: false` removes injected skills and disables inherited skills for that worker.
- `env` merges over the agent's default environment; `null` removes a variable.
- Delegate-owned lineage, authentication, routing, and child-control variables cannot be replaced or removed.

Saved agent, chain, and global override files store environment values in plaintext. Do not put API keys, passwords, tokens, or other secrets in durable `env` configuration.

### Dispatched checklists

A run entry may carry a checklist through `handoff.tasks`: the concrete steps the worker is expected to work through. It is accepted on solo, supervised, and `driver` entries. For a driver, the checklist belongs to the detached child session rather than the foreground session. A legacy top-level `checklist` is still accepted and normalized into `handoff.tasks`.

```ts
type ChecklistItem =
  | string
  | {
      title: string;
      status?: "pending" | "active" | "done" | "blocked" | "deferred";
      note?: string;
      subtasks?: ChecklistItem[];
    };

type Checklist = ChecklistItem[];
```

A bare string is read as a title, so the short form is usually enough:

```ts
delegate({
  runs: [{
    agent: "implement",
    task: "Add the retry policy described in the spec.",
    handoff: { tasks: ["read the spec", "write a failing test", "implement", "run the suite"] },
  }],
});
```

The checklist rides the `handoff` carrier's `tasks` namespace. A legacy
top-level `checklist` is still accepted and normalized into it.

It travels one of two ways, decided per run:

- **Seeded.** When the worker loads an extension that owns a `session_tasks` tool, the checklist is written into the worker's session before its first turn, as a durable entry that survives compaction.
- **Degraded.** When nothing claims it, the checklist is appended to the worker's prompt as a markdown list. The worker still sees the plan; it is simply not durable. Nothing here requires an extension to be installed.

The two are mutually exclusive — a checklist is never both seeded and pasted into the prompt.

A driver sends the checklist only to its authoritative detached child session; it never seeds the foreground session's task list. The child makes the seeded-or-degraded decision after `session_start` and `before_agent_start` registrations and after final tool selection. If the active child scope contains a usable `session_tasks` claimant, the child writes one bounded versioned `context-aware.tasks.v1` entry before its first model request. Otherwise it injects the assignment once as Markdown. A static explicit allowlist may gain `session_tasks` for this dispatch-created obligation; a dynamic `ext:` scope must select the claimant itself. Structured and Markdown delivery remain mutually exclusive. The owner-only detached cfg retains the structured seed so replacement and recovery can reapply it without duplicating a snapshot in one child session.

Sub-tasks go exactly one level deep. `blocked` and `deferred` describe different situations — "all done or deferred" is finished, "any blocked" needs a person — so both require a `note`; a status sent without one is downgraded to `pending` rather than rejected. One malformed entry is skipped rather than failing the dispatch.

Progress comes back through the existing public surfaces. In-process run-entry rows show task counts (`☑2/5`, with `⚠1` when work is blocked). Detached status and event-log records carry the child's bounded task progress. A detached terminal status, automatic completion wake, and `delegate_control(action="result")` details carry a bounded `taskLedger` naming unfinished work:

```ts
type TaskStatus = "pending" | "active" | "done" | "blocked" | "deferred";

interface TaskLedger {
  outcome: "complete" | "gap" | "stuck";
  counts: { done: number; total: number; active: string | null; blocked: number; pending: number; deferred: number };
  unfinished: { id: string; title: string; status: TaskStatus; note?: string; ownerTaskId?: string }[];
  rows: {
    idKind?: "owner" | "local";
    ownerTaskId?: string;
    localTaskId?: string;
    status: TaskStatus;
    reason?: string;
  }[];
}
```

This lets a caller classify a worker result mechanically. A worker result that returns with unfinished work is a `gap` because its checklist says so, not because someone read its closing paragraph. `taskLedger` is absent when the dispatch carried no checklist, which is not the same as an empty one.

### Interactive workers

Workers default to `interactive: false`. This has two independent safeguards:

- Pi UI requests remain unavailable or are auto-denied, matching non-interactive CLI behavior.
- Each inherited non-`ask` extension-tool invocation has a 30-minute deadline.

If the extension-tool deadline expires, the direct worker fails with a
deterministic error and any later completion or progress from that invocation
is ignored. The deadline does not apply to built-in tools, `ask`, interactive
workers, or supervised workers. It does not disable extension loading, provider
authentication, request routing, or the outer run timeout setting.

With `interactive: true`, supported confirm, select, and input prompts are routed to the delegate overlay. Unanswered prompts auto-deny after their timeout.

## Supervised mode: `mode: "supervised"`

A supervised run inserts a private copy of the main agent — a fork — that can question and redirect one worker before returning one result. The private supervisor-worker conversation never enters the foreground thread.

```ts
delegate({
  runs: [
    {
      agent: "reviewer",
      task: "Review the session-store implementation",
      name: "store-review",
      mode: "supervised",

      model: "openai/gpt-5",
      env: { MODE: "strict" },
      thinking: "high",
      thinkingMin: "medium",
      thinkingMax: "high",
      fallbackModels: ["anthropic/claude-sonnet-4"],
      skill: ["code-review"],

      clone_mode: "snippet",
      snippet_last_n: 12,
      rounds: 8,

      collapse_mode: "final_output",
      summary_model: "anthropic/claude-haiku-4-5",
      supervisor_instructions: "Reject untested race fixes.",

      cwd: "packages/api",
      interactive: false,

      max_duration_ms: 900_000,
      wind_down_grace_ms: 60_000,

      heartbeat_interval_ms: 180_000,
      max_consecutive_heartbeats: 5,

      escalation: "local",
    },
  ],

  concurrency: 4,
  agent_scope: "both",
  worktree: false,
  await: false,
  notifyOnFailure: true,
})
```

### Full supervised slot

```ts
interface SupervisedRun extends WorkerOverrides {
  agent: string;
  task: string;
  name?: string;
  mode: "supervised";

  clone_mode?: "full" | "snippet" | "task_only";
  task_delivery?: "direct-first-turn" | "supervisor-mediated";
  snippet_last_n?: number;
  rounds?: number;

  collapse_mode?: "final_output" | "summary";
  summary_model?: string;
  supervisor_instructions?: string;

  cwd?: string;
  progress?: boolean; // accepted, ignored, and warned about once

  max_duration_ms?: number;
  wind_down_grace_ms?: number;

  heartbeat_interval_ms?: number;
  max_consecutive_heartbeats?: number;

  escalation?: EscalationPolicy;

  // Removed compatibility fields: accepted, ignored, and warned about.
  decisionPlane?: unknown;
  decisionRouting?: unknown;
}
```

A dispatch carries 1–6 entries. There is no supervised `count` shorthand — `count` is solo-only. Duplicate names are automatically suffixed with `#2`, `#3`, and so on.

### Run names and display labels

A run carries two identifiers with two different jobs.

`name` is the **addressing key**. It is what every `delegate_control` action takes, what the dispatch envelope reports as `forkNames`, and what run history records. It is unique within a run and fixed for its lifetime. Set it on every entry of a multi-run dispatch, and name it after the work rather than the agent.

The **display label** is what a human reads in the status widget and the transcript overlay. When you supply `name:`, the label is that name. When you do not, it is derived once at dispatch from the task text: an issue reference, spec id, or path found near the top, followed by a couple of content words from the first line that is not a heading, machine header, file pointer, or role framing. A task that yields nothing usable falls back to the agent's name rather than an invented slug, and runs whose labels would collide render as `worker 1/3`, `worker 2/3`, `worker 3/3`. Ordered steps keep their `step{N}.` prefix on the label as well as the name.

When a defined agent name and display label are distinct, human-facing identities render as `agent-name(task-label)`: the opening parenthesis is adjacent to the agent name, with no space. If the label already contains the agent name, including a token-contained chain or fan-out label, the redundant agent is suppressed. Legacy records without `displayLabel` use the stored `name` as the task label, so for example `reviewer(legacy-entry)` remains readable. Compact rows intentionally show only the label, and narrow or shape-specific projections may omit the combined identity.

The label never addresses anything by itself — but the control tools accept it as an alias, so a name a human read off the screen still works. See [Steer a supervised fork](#steer-a-supervised-fork) below.

### Supervisor versus worker

`progress?: boolean` is accepted on supervised entries for compatibility, but it
is ignored and produces one deterministic warning per dispatch. Direct and chain
runs retain their existing `progress.md` completion behavior. The supervised
`artifact` and `reads` fields remain rejected because the supervisor controls the
message stream.

The supervisor:

- uses the foreground agent's model and system prompt;
- normally receives the six supervision tools `message_subagent`, `wait_for_worker`, `inspect_worker`, `cancel_worker`, `restart_worker`, and `finish_delegation`;
- additionally receives `resolve_escalation` and `escalate` when escalation is enabled;
- can send up to `rounds` total messages to the worker, including the default exact first turn; and
- is unaffected by worker `model`, thinking, skill, environment, or fallback overrides.

The inner worker uses the selected agent definition plus the invocation-local worker overrides.

### Clone modes

`clone_mode` seeds a supervisor, so it only means something on a supervised
entry. A solo entry **accepts it and drops it at compile time** (#286): inert,
not invalid. A driver entry rejects it.

```ts
clone_mode: "full"      // all foreground branch history; default
clone_mode: "snippet"   // bounded recent context
clone_mode: "task_only" // only the delegated framing
```

`snippet_last_n` defaults to `10`. Prefer `task_only` for self-contained work and `snippet` for bounded context.

### First-turn task delivery

A supervised run defaults to `task_delivery: "direct-first-turn"`. The runtime
sends the caller's exact task to the worker before the supervisor generates a
turn, then seeds the supervisor with that completed exchange. The worker
exchange consumes round 1. This preserves
paths, identifiers, requirements, and output contracts while still allowing
review and follow-up.

Set `task_delivery: "supervisor-mediated"` explicitly when the supervisor
should interpret the task and compose the worker's first instruction.

### Rounds

`rounds` caps the total number of messages accepted by the worker. Under the
default direct-first-turn delivery, the runtime-delivered exact task consumes
round 1; each later supervisor follow-up consumes another round. Under explicit
`supervisor-mediated` delivery, each supervisor message consumes one round. The
default is the selected agent's `defaultMaxRounds` or `5`. It is supervised-only,
and unlike `clone_mode` it is genuinely **rejected** on a solo entry.

When the cap is reached, the supervisor must finish rather than silently start another worker round. A forced finish can be represented as a terminal `paused` result rather than a successful completion.

### Collapse modes

`collapse_mode: "final_output"` returns the supervisor's `finish_delegation({final_output})` text verbatim.

`collapse_mode: "summary"` returns the supervisor's summary. If `summary_model` is omitted, there is no separate summarizer provider call.

`summary_model` may be:

- an explicit `provider/model`; or
- `"auto"`, which selects only `anthropic/claude-haiku-4-5`.

`"auto"` does not select another model if Haiku is unavailable.

#### When the summary model does not produce a collapse

A summarizer failure never fails an otherwise-successful delegated result. Four cases fall back to the supervisor hint — `finish_delegation({summary})`, then `final_output`, then the last worker text — and keep `status: "completed"`:

| Case | `summaryFallbackReason` |
|---|---|
| No summary model resolved | set only when a model was explicitly configured but unavailable |
| The model call throws | records the provider error |
| The model returns empty or whitespace text | records the empty-text case |
| The model declines the task instead of collapsing the transcript | records the refusal and the rejected opening |

The last case exists because the summarizer receives the rendered transcript, which contains the brief written for the worker. A model that reads those imperatives as its own assignment can decline them, and the reply would otherwise become the delegation's tool response in place of the worker's deliverable. A fixed reminder follows the transcript to keep the collapser's own job the most recent instruction, and `isNonSummaryRefusal` rejects a response whose opening declines to produce the collapse.

That guard is deliberately narrow. It judges only the opening content line, and only present-tense inability to produce the response. Reporting failure is part of a collapse's job, so past-tense accounts such as `I could not find a root cause` or `the worker was unable to run the tests` are content and are kept. Every rejection is logged with its opening, because the fallback is the supervisor's own words rather than a loss, but a wrong threshold must be visible.

### Wall-clock timeouts and heartbeats

The absolute timeout resolution is:
```text
selected duration: invocation max_duration_ms > agent maxDurationMs > global perForkMaxDurationMs
then: positive global perForkMaxDurationMs ceiling
then: positive global perForkMinDurationMs floor
```

`0` disables a timeout layer unless a positive global ceiling applies. Both global
bounds default to `0`. A positive ceiling prevents a lower layer's `0` from
removing the ceiling. A positive floor does not create a deadline for explicit
zero or no selected duration; it raises only a stated positive selected duration.
A positive floor above a positive ceiling is diagnosed and ignored; the valid
ceiling remains. The default wind-down grace is 90 seconds. The effective
duration remains the existing `timeout.maxDurationMs` result field.

`max_duration_ms` is the explicit supervised worker wall-clock budget. It does
not guarantee that the outer `delegate` call returns at that exact wall-clock
instant. With the default `enforceWallClockBudget: false`, a caller- or
agent-supplied budget sends the one-shot wind-down steer and starts grace, but
leaves hard cancellation disabled. Set `enforceWallClockBudget: true` to hard-
cancel after grace. A positive global `perForkMaxDurationMs` always hard-cancels
after grace and remains an operator ceiling. Shutdown overhead can make observed
wall-clock time exceed `max_duration_ms`.

A solo run may declare one authoritative file-backed artifact with `artifact`.
The worker must write that file at the absolute artifact-workspace path the runtime injects.
That candidate path is inside its private v2 attempt.
After clean completion, the runtime opens and hashes that non-empty regular file,
runs an optional check, rejects checker-altered bytes, and atomically publishes the
exact checked bytes as an immutable retained snapshot. The result keeps the
compatible `outputFile: { absolutePath, bytes }` and adds a validated
`artifactRef`; artifact content does not replace the final assistant handoff.

Timeout, cancellation, failed checks, missing candidates, and failed publication
return no `outputFile` or `artifactRef`. Retained snapshots expire after seven days
by default unless a live reader or durable result/wake pin extends them.

```ts
interface WorkerArtifactReference {
  schema: "pi-worker-artifact";
  version: 2;
  artifactId: string;
  worktreeHash: string;
  runId: string;
  forkName: string;
  attempt: number;
  artifactName: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  expiresAt: string;
  absolutePath: string;
  snapshotDev: number;
  snapshotIno: number;
}
```

Provider-independent result, persistence, wake, recovery, and CLI boundaries copy
these fields by name and drop unknown keys. `artifactError` is either
`{ kind: "storage-busy", message, retryable: true }` or
`{ kind: "artifact-unavailable", message, retryable: false }`.

On an enforced timeout, `pi-delegate` sends one wind-down instruction, then
hard-cancels after the grace window if the run has not become terminal. A soft
budget still records the wind-down and keeps its grace handling without hard
cancellation. For practical budgets,
start bounded inspections and code reviews at 5–10 minutes, and use 15–30 minutes
for builds or integration tests. If a timeout is otherwise healthy, retry once at
roughly 2× the worker budget with a matching grace window. A second timeout is a
signal to inspect the result/activity and narrow or split the task rather than
retrying indefinitely.

Both `max_duration_ms` and `wind_down_grace_ms` apply to solo and supervised entries. The precedence, the meaning of `0`, and the three-phase expiry are identical; only the recipient of the wind-down differs. A supervised fork steers its supervisor clone, which drives the worker to a final answer. A solo run has no clone, so the wrap-up goes straight to the worker session. When hard enforcement is enabled, the grace window is the cancellation backstop; soft budgets retain the wind-down without cancelling.

For a solo entry the budget is armed inside the direct worker runner, which is the one point every solo execution path shares: a single direct worker, each worker of a parallel batch, every step of a chain, and any programmatic caller. An after-gated dispatch compiles to a chain, so this is what keeps its budget enforceable rather than merely accepted. A refusal fallback shares the first deadline; changing models does not restart the clock. A solo run hard-cancelled after its grace window reports `aborted` with `cancelReason: "timeout"`, and its result carries `steered: true` whether it concluded inside the grace or not. A retried run inherits the original budget, including an explicit `0` that deliberately disables it.

A driver entry rejects both fields. Its durable daemon session owns its own budget, so a limit set on the dispatch would validate and then govern nothing.

Heartbeat defaults are a 180-second silence interval and five consecutive heartbeats. Heartbeats let the supervisor inspect or wind down a worker that is still alive but has not produced visible progress.

## Solo mode: `mode: "solo"` (the default)

A solo run sends its worker one task and lets it run its normal agent loop. There is no private supervisor conversation. This is what an entry does when it omits `mode`.

### One worker

```ts
delegate({
  runs: [{
    agent: "worker",
    task: "Implement the parser fix",

    cwd: "packages/parser",
    artifact: "result.md",
    reads: ["plan.md", "requirements.md"],
    progress: true,

    model: "openai/gpt-5",
    thinking: "high",
    fallbackModels: ["anthropic/claude-sonnet-4"],
    skills: ["test-driven-development"],
    env: { MODE: "strict" },
    interactive: false,

    escalation: "local",
  }],
  await: false,
})
```

### Several workers in parallel

```ts
delegate({
  runs: [
    {
      agent: "scout",
      task: "Map the call sites",
      count: 2,
    },
    {
      agent: "reviewer",
      task: "Audit the locking rules",
      reads: ["design.md"],
    },
  ],
  concurrency: 3,
})
```

### Full solo run

```ts
interface SoloRun extends WorkerOverrides {
  agent: string;
  task: string;

  cwd?: string;
  artifact?: string | false;
  reads?: Array<string | WorkerArtifactReference> | false;
  progress?: boolean;

  escalation?: EscalationPolicy;

  count?: number;

  // Removed compatibility fields: accepted, ignored, and warned about.
  decisionPlane?: unknown;
  decisionRouting?: unknown;
}
```

`runs` contains 1–6 entries. `count` expands a solo entry after validation, so the total worker count can exceed six. Repeated instances receive suffixes such as `worker#2`.

Solo entries expanded with `count` do not expose a per-instance user-supplied `name`. The current allocator does not reserve every generated suffix across separate entries; mixing `count` with another entry for the same agent can therefore produce a duplicate label. Avoid that shape until the allocator is fixed.

### Direct file fields

- `reads` injects files as `<context-file>` blocks in the first worker message. Ordinary string paths resolve from the worker's effective `cwd`. A typed `WorkerArtifactReference`, or an exact returned v2 payload path, is admitted through its manifest and held by a reader usage record until the worker ends. In chain mode, an exact logical artifact name maps to its producer's returned reference; a same-spelled cwd file cannot replace it. Duplicate names from an earlier parallel layer are rejected as ambiguous. No read chooses a worktree-wide latest or legacy same-name file. `reads: false` suppresses an agent `defaultReads` before matching.
- `artifact` names one canonical basename with an extension for a private file returned through delegate. It never names a destination inside the worker cwd: a caller that needs `notes/result.md` omits `artifact` and tells the worker to use its authorized `write` tool there. The runtime allocates a private attempt, injects its absolute candidate path, validates and optionally checks the bytes, then publishes a read-only UUID snapshot. Missing, unreadable, empty, absolute, nested, escaping, symlinked, hardlinked, replaced, or checker-mutated candidates fail. The runtime never writes final assistant text to the file.
- `progress` appends a completion line to `progress.md` in `chainDir`; chain coordination directories are not artifact roots.
- Literal `false` for `reads` or `artifact` suppresses an agent-level default.

### Artifact containment

An artifact producer receives write authority only for its own private attempt
scratch and output leaves. Sibling attempts, retained snapshots, quarantine, data
parents, and stable control metadata are excluded. Publication reopens the
candidate with no-follow semantics, requires link count one, and binds the retained
manifest to producer identity, size, SHA-256, and snapshot device/inode identity.
Readers repeat those checks. An exact unavailable or expired reference returns
`artifact-unavailable`; metadata lock timeout returns retryable `storage-busy`.

Asynchronous quarantine deletion requires a traversable `/proc/self/fd` or
`/dev/fd` directory namespace so every recursive lookup remains anchored to the
captured directory descriptor. If neither namespace is usable, cleanup preserves
the quarantine for a later retry instead of falling back to an unsafe pathname
walk. Linux CI exercises the detected descriptor branch.

## Ordering runs with `after`

`after` turns a flat list of solo runs into ordered layers. Every non-first
layer names the **entire** preceding layer, or uses the `"previous"` sugar. An
`after`-gated entry that omits `task` defaults to `"{previous}"`, so the earlier
layer's aggregate output becomes this run's input.

```ts
delegate({
  runs: [
    {
      name: "scout",
      agent: "scout",
      task: "Inspect {task}",
      artifact: "context.md",
    },
    {
      name: "security",
      agent: "reviewer",
      task: "Review {previous} for security problems",
      after: "previous",
    },
    {
      name: "correctness",
      agent: "reviewer",
      task: "Review {previous} for correctness",
      after: "previous",
      count: 2,
    },
    {
      name: "implement",
      agent: "worker",
      task: "Implement this plan:\n{previous}",
      after: ["security", "correctness"],
    },
  ],

  task: "repair the auth flow",
  concurrency: 3,
  failFast: false,
  chainDir: "/path/to/resumable-chain-dir",
})
```

Subset-parenting rejects with `not expressible as layers in v1; name the whole
preceding layer`. `{previous}` under a multi-parent layer resolves to the
parallel-aggregate format; `{previous}` in an entry with no `after` rejects.

### Sequential step

```ts
interface ChainSequentialStep extends WorkerOverrides {
  agent: string;
  task?: string;

  cwd?: string;
  artifact?: string | false;
  reads?: Array<string | WorkerArtifactReference> | false;
  progress?: boolean;

  escalation?: EscalationPolicy;

  // Removed compatibility fields: accepted, ignored, and warned about.
  decisionPlane?: unknown;
  decisionRouting?: unknown;
}
```

The first omitted step task defaults to the top-level chain input. A later omitted step task defaults to `{previous}`.

Available substitutions:

| Variable | Value |
| --- | --- |
| `{task}` | The original top-level chain input |
| `{previous}` | The preceding step's collapsed output |
| `{chain_dir}` | The absolute chain artifact directory |

A failed sequential or parallel step halts the chain. A logical `reads` name that exactly matches an earlier successful `artifact` uses that producer's validated exact reference before checking the worker cwd. A same-named worker-cwd file does not override it. Duplicate artifact names from an earlier parallel step fail deterministically as ambiguous; explicit references, absolute reads, and unmatched relative reads retain their ordinary semantics.

### Parallel step

```ts
interface ChainParallelStep {
  parallel: Array<ChainSequentialStep & {
    name?: string;
    count?: number;
  }>;

  concurrency?: number;
  failFast?: boolean;
  worktree?: boolean;
}
```

`concurrency` defaults to the expanded slot count. `failFast` defaults to `false`.

`failFast` is an advisory request for sibling cancellation. Where cooperative cancellation is available, `true` requests that still-running siblings stop after the first terminal failure; it cannot undo already-started side effects and callers must not depend on every sibling stopping before completion. With `false`, siblings are allowed to finish. In every case, a failed parallel step prevents later sequential steps from starting.

`worktree` is accepted by the schema but current chain execution does not create worktrees for the parallel slots. Do not rely on it yet.

### Saved chains

Invoke a stored `.chain.md` template by name:

```ts
delegate({
  chain: "recon-plan",
  task: "investigate the cache bug",
})

```

Saved `.chain.md` definitions represent sequential worker, deterministic `run`,
and saved-chain reference steps. Runtime parallel blocks cannot be stored in that
format. A reference has this on-disk form:

```md
## chain:reusable-review

Review {task} after {previous}.
```

A deterministic stage has an explicit `run:` heading and no task body:

```md
## run:verify-artifacts
command: node scripts/verify-artifacts.mjs
cwd: tools
env: {"MODE":"strict"}
timeoutMs: 2500
```

`command` is required and runs through the platform shell without starting an
LLM. `cwd` is optional and resolves against the top-level chain `cwd`. `env`
uses the same protected-key filtering as worker overrides. The child receives
the absolute shared chain coordination directory as `PI_DELEGATE_CHAIN_DIR`; command text
does not expand `{task}`, `{previous}`, or `{chain_dir}`. `timeoutMs` defaults to
60 seconds.

Exit code 0 continues the chain and leaves the preceding worker's collapsed
output unchanged for the next worker. Non-zero exit, timeout, cancellation,
invalid configuration, an unavailable `cwd`, or process-start failure stops the
chain. Captured standard output and standard error are sanitized and limited to
8 KiB each. A project-scoped run stage executes only when the project is trusted.
A confined nested caller cannot invoke a run stage because its separate shell
process cannot inherit the caller's write guard.
All run-stage configuration and every recursive reference are checked before the
first worker starts.

The `chain:` and `run:` heading prefixes are reserved. A worker agent whose
name begins with either prefix cannot be represented as a saved-chain worker
heading; the serializer rejects that ambiguous name instead of writing a file
that would parse as a reference or run stage.

References resolve recursively before any worker starts. Every lookup uses the
same saved-chain scope precedence as the top-level lookup. Missing references
and direct or indirect cycles reject the whole invocation before nested agent
allow-list and write-confinement checks run.

A reference opens a local template scope. The reference task is evaluated once
against its parent's `{task}` and `{previous}` and becomes the referenced
chain's frozen `{task}`. Its `{previous}` starts empty, advances after each
worker, and stays unchanged across a successful run stage. The final value
becomes the parent chain's `{previous}` when the reference finishes. All
expanded workers and run stages remain in one run, share one `chainDir`, and add
zero delegation depth.

`chainDir` overrides the generated chain directory used for progress records. Declared artifacts are written to private v2 attempt candidates and published as retained snapshots, never into the chain directory.

## Driver mode: `mode: "driver"` (detached lifecycle)

```ts
delegate({
  runs: [{
    agent: "graft-orchestrator",
    task: "Drive spec 0042 through implementation, review, and close",
    mode: "driver",
    model: "openai/gpt-5",
    env: { PIPELINE_MODE: "strict" },
    depth: 5,
  }],
})
```

Exactly one driver entry per dispatch; a second rejects with `exactly one driver
entry per dispatch; split into separate calls`. A driver entry rejects `cwd`,
`worktree`, and `escalation`, and sends `handoff` only to the detached child.
The child durably seeds `handoff.tasks` when its final active tool scope has a
usable `session_tasks` claimant; otherwise it injects exactly one Markdown fallback.

### Full driver run

```ts
interface DriverRun {
  agent: string;
  task: string;
  mode: "driver";
  model?: string;
  env?: Record<string, string | null>;
  depth?: number; // integer from 0 through 16
}
```

The driver:

- runs in a stable `pi-daemon` session addressed by the durable run identity;
- returns after the daemon accepts the idempotent prompt and survives caller or daemon restart;
- keeps only `{daemonSessionId, promptId, idempotencyKey, cursor, generation}` in the run locator—the daemon's Pi file remains authoritative;
- appears in `delegate_control(action="status")` and the delegate overlay; and
- supports durable `prompt_status`/result replay plus `steer`, `follow_up`, `ui_answer`, and lease-protected `cancel` controls.

A fresh driver tree has an effective minimum depth cap of `3`, even if the caller requests less. The global hard ceiling is `16`.

The daemon-backed driver is a fresh durable session. It does not replay the foreground session's complete in-memory message transcript. Agent/model reconfiguration after session creation is not part of this transport milestone; `model_change` requires a follow-up migration.

Do not pass top-level `await`, `sync`, or `worktree`. Their presence is rejected even when the value is `false`. The legacy `orchestrate.thinking` transport field is not supported; configure thinking on the selected agent definition.

## Structured escalation

Escalation lets an enabled worker suspend one tool call and raise a bounded decision, blocker, or proposed amendment. Only the raiser's tool call waits, and the wait consumes no model tokens.

Enable one slot with:

```ts
escalation: "local"
```

Disable one slot explicitly with:

```ts
escalation: "off"
```

### Full escalation policy

```ts
interface EscalationAuthority {
  decision?: "none" | "implementation" | "all";
  blocker?: "none" | "all";
  amendment?: "none" | "all";
  tags?: string[]; // carried but reserved in v1
}

type EscalationTimeoutBehavior =
  | "useDefault"
  | "noDefaultError"
  | "cancel";

interface EscalationPolicyObject {
  mode?: "off" | "local";
  authority?: EscalationAuthority;
  intermediate?: boolean;
  hopTimeoutMs?: number | null;

  timeoutMs?:
    | number
    | {
        decision?: number;
        blocker?: number;
        amendment?: number;
      };

  timeoutBehavior?:
    | EscalationTimeoutBehavior
    | {
        decision?: EscalationTimeoutBehavior;
        blocker?: EscalationTimeoutBehavior;
        amendment?: EscalationTimeoutBehavior;
      };

  holdStrategy?: "hold-open" | "park";
}

type EscalationPolicy =
  | "off"
  | "local"
  | EscalationPolicyObject;
```

`"park"` is reserved and currently rejected. Only an effective `mode: "local"` enables the feature. Policy fields merge through global, agent, and invocation layers.

Any escalation-enabled slot must run in the background. `await: true` and `sync: true` are rejected because a responsive chain is required to route the request.

Enabled workers receive:

- `escalate_decision` for a bounded choice with 2–5 options;
- `escalate_blocker` when progress is impossible; and
- `escalate_amendment` when the task, plan, specification, or model needs an exact change.

The removed `decisionPlane` and `decisionRouting` fields remain accepted only for compatibility. They are ignored with a warning and should not be used.

See [`escalation.md`](escalation.md) for raise-tool schemas, authority rules, routing, timeout defaults, and cleanup behavior.

## Management mode

Management calls do not start workers.

### List and inspect definitions

```ts
delegate({ action: "list" })

delegate({
  action: "list",
  agent_scope: "user",
})

delegate({
  action: "get",
  agent: "reviewer",
})

delegate({
  action: "get",
  chain: "recon-plan",
})
```

`get` may receive both `agent` and `chain`.

Management input is separate from on-disk frontmatter parsing. The `config` object for `action: "create"` and `action: "update"` accepts arrays or `false` for list fields; on create, `false` leaves that field absent, and on update, it clears an existing field. It rejects CSV strings such as `tools: "read, bash"` with a field-specific validation error. Existing agent frontmatter may still use legacy comma-separated lists, which remain readable.

### Create an agent

```ts
delegate({
  action: "create",
  config: {
    name: "strict-reviewer",
    description: "Reviews implementation and test evidence",
    systemPrompt: "Review every claimed requirement.",
    model: "openai/gpt-5",
    tools: ["read", "bash"],
    skills: ["code-review"],
    thinking: "high",
    scope: "user",
  },
})
```

Meaningful agent creation and update fields are:

> **Schema budget.** This list is the reference; the `config` field's own
> schema description deliberately does not repeat it. Every character in a
> `delegate` parameter description is serialized into the tool schema the
> model carries on *every* request, and the shared slot fields are inlined
> 6–11 times each. Add new field documentation here, not to the descriptions
> in `src/index.ts`. The accepted fields are already declared structurally by
> `ManagementConfigSchema`, so prose enumerations are pure duplication —
> `tests/unit/schema-validation.test.ts` pins that contract against the
> schema shape rather than against description text.

```ts
interface ManagedAgentConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  env?: Record<string, string | null>;
  fallbackModels?: string[] | false;
  tools?: string[] | false;
  skills?: string[] | false;
  extensions?: string[] | false;
  extensionInclude?: string[] | false;
  extensionExclude?: string[] | false;

  thinking?: ThinkingLevel;
  thinkingMin?: ThinkingLevel;
  thinkingMax?: ThinkingLevel;

  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;

  artifact?: string;
  reads?: string[] | false;
  progress?: boolean;

  maxSubagentDepth?: number;
  allowNestedDelegate?: boolean;
  nestedDelegateAgents?: string[] | false;

  maxDurationMs?: number;
  windDownGraceMs?: number;

  scope?: "user" | "project"; // create only
}
```

### Create a saved chain

The presence of `steps` makes a create config a chain rather than an agent:

```ts
delegate({
  action: "create",
  config: {
    name: "recon-plan",
    description: "Reconnaissance followed by planning",
    scope: "project",
    steps: [
      {
        agent: "scout",
        task: "Inspect {task}",
        artifact: "context.md",
      },
      {
        run: "verify-context",
        command: "node scripts/verify-context.mjs",
        timeoutMs: 10_000,
      },
      {
        agent: "planner",
        task: "Plan from {previous}",
      },
    ],
  },
})
```

Persisted chain steps use a discriminated union:

```ts
interface ManagedChainWorkerStep {
  agent: string;
  task?: string;
  env?: Record<string, string | null>;
  artifact?: string | false;
  reads?: string[] | false;
  model?: string;
  thinking?: ThinkingLevel | false;
  thinkingMin?: ThinkingLevel | false;
  thinkingMax?: ThinkingLevel | false;
  skills?: string[] | false;
  progress?: boolean;
}

interface ManagedChainReferenceStep {
  chain: string;
  task?: string;
}

interface ManagedChainRunStep {
  run: string;
  command: string;
  cwd?: string;
  env?: Record<string, string | null>;
  timeoutMs?: number;
}

type ManagedChainStep =
  | ManagedChainWorkerStep
  | ManagedChainReferenceStep
  | ManagedChainRunStep;
```

The three variants are exclusive. A reference step cannot carry worker or run
fields. A run step cannot set `agent`, `chain`, `task`, artifact, model,
thinking, skill, or progress fields.

### Update or delete

```ts
delegate({
  action: "update",
  agent: "strict-reviewer",
  agent_scope: "user",
  config: {
    model: false,
    description: "Updated description",
  },
})

delegate({
  action: "delete",
  chain: "recon-plan",
  agent_scope: "project",
})
```

`agent_scope` disambiguates same-named user and project definitions. Builtin and installed-package definitions are immutable.

Literal `false` clears supported optional fields during update. For the list fields above, `false` is also accepted on create and leaves that field absent in the new file. The registered schema deliberately types management `config` broadly; runtime code performs detailed validation.

Files are written to:

```text
user agent:   ~/.agents/<name>.md
user chain:   ~/.agents/<name>.chain.md
project agent: <repo>/.pi/agents/<name>.md
project chain: <repo>/.pi/agents/<name>.chain.md
```

### Health

```ts
delegate({ action: "health" })
```

The health report includes active and completed in-process runs, detached-driver counts, state-substrate sizes, pending wakes and results, stale claims, and maintenance-timer state.

The machine-readable `details.health` object names its driver-specific fields `activeDetachedDrivers`, `terminalDetachedDrivers`, `driverStorageBytes`, and `pendingDriverResults`.

A nested delegate worker may use `list`, `get`, and `health`. It may not create, update, or delete persistent definitions.

## Result and delivery contract

### Immediate background result

A direct background dispatch resembles:

```ts
{
  content: [{
    type: "text",
    text: "Dispatched runId=... with 2 direct worker(s)...",
  }],
  details: {
    dispatched: true,
    runId: "...",
    shape: "direct",
    forkNames: ["scout", "reviewer"],
    mode: "direct",
  },
}
```

The additive `shape` field is explicit for every dispatch form. A supervised background dispatch uses `shape: "supervised"` with its `forkNames`; a chain dispatch uses `shape: "chain"`, retains the legacy `mode: "chain"`, and adds `chainDir` and the declared step count. The shape-bearing details are:

```ts
// supervised
{ dispatched: true, runId: "...", shape: "supervised", forkNames: ["reviewer"] }

// chain
{ dispatched: true, runId: "...", shape: "chain", mode: "chain", chainDir: "...", steps: 3 }
```

A driver dispatch adds the driver name, process ID, depth information, and whether authenticated later-turn control is available.

For in-process background runs, the complete content arrives through the automatic completion wake. A detached driver writes a durable pending result instead. On session start or periodic maintenance, whichever live foreground session sharing the same `agentDir` successfully claims that result receives the wake. This delivery boundary is at-least-once: a process crash after sink acceptance but before claim consumption can cause a duplicate wake. A successful detached wake contains the collapsed output; a failed wake directs the caller to `delegate_control({action: "result", runId})` for the failure details.

### Awaited result

Direct and supervised awaited results resemble:

```ts
{
  content: [{ type: "text", text: "<combined output>" }],
  details: {
    runId: "...",
    shape: "direct", // "supervised" for a supervised awaited result
    forks: [/* per-run results */],
    usage: {/* aggregate tokens and cost */},
    usageByFork: {/* per-run tokens and cost */},
    worktreeDiffs: [/* present when worktree isolation was used */],
  },
  isError: false,
}
```

Chain results additionally include `chainDir` and the number of executed steps. `isError` is true when any run or executed chain step ends with a status other than `completed`, including `failed`, `aborted`, or `paused`.

Terminal statuses for delegated entries include:

```text
completed
failed
aborted
paused
```

### Harvest outcome

`details.forks[].harvest` is a supported caller-visible result field on direct
worker entries (`agent` + `task`, `tasks`, and chain steps). It
records how the worker output was classified before the delegated result was
collapsed. Supervised entries do not expose this internal per-turn field;
their terminal status and recovery metadata carry the corresponding outcome.
The field has one of these shapes:

```ts
{
  kind: "substantive",
  method: "terminal" | "salvage",
  text: string,
} | {
  kind: "failure",
  error: string,
  errorKind?: string,
  stopReason?: string,
} | {
  kind: "missing",
  reason: "no-assistant" | "empty" | "cancellation-only",
  text: "",
}
```

- `substantive` is non-empty assistant text that is not short, single-block
  bracketed lifecycle chatter. Its `method` is `terminal` when the terminal
  assistant message supplied the text, or `salvage` when an earlier substantive
  response was recovered. Short text beginning with bare `Error:` or
  `retrying` is substantive; only the bracketed lifecycle form is treated as
  chatter.
- `failure` is an explicit provider or assistant failure, such as an
  `errorMessage` or `stopReason: "error"`.
- `missing` means `no-assistant`, `empty`, or `cancellation-only` output.
  `no-assistant` and `empty` are terminal failures. A supervised
  `cancellation-only` turn is first returned to the supervisor as a non-terminal
  signal so it can steer or retry while the channel remains usable. If the
  supervisor finishes without a later substantive worker turn, finalization
  preserves the terminal `failed` result, `delegate:fork-failed` wake, and
  recovery descriptor. Direct workers have no supervisor, so a cancellation-only
  result is terminal `failed`; its raw assistant text remains in the collapsed
  content rather than being discarded.

Chain output, progress, and `{previous}` propagation are gated on a validated
substantive completion.

`paused` is preserved as `status: "paused"` when run finalization writes
run history. It is a terminal status, but it is not converted to `failed` in
that history.

### Model selection and usage accounting

Automatic model selection accepts a model only when both pricing fields are
present, finite, and non-negative. Exact `0` pricing remains eligible. A model
with missing, non-finite, or negative input or output pricing is ineligible for
automatic selection; if no policy-eligible model remains, selection fails
closed. An explicit `provider/id` reference is a separate operator choice and is
honored verbatim unless the full value equals the active session model ID. That
exact repetition preserves the active route, so a parent using
`openrouter/openai/gpt-5.6-sol` remains on OpenRouter when a worker repeats the
model ID `openai/gpt-5.6-sol`.

Parent-session model scope (`--models`) is enforced on every delegated model
choice — worker primaries, fallbacks, fork clones, summaries, the activity
ticker, and detached driver execution. Enforcement requires pi-coding-agent
0.83.0 or newer: older runtimes do not expose the session scope to
extensions, so delegated models run unrestricted there and delegate records a
`session model scope unavailable` diagnostic.

Usage producers pass counters through `normalizeUsageCounters`. Missing fields
contribute zero. Supplied values must be numeric, finite, and non-negative;
invalid values are excluded from totals and produce per-field diagnostics with
reasons `not-a-number`, `non-finite`, or `negative`. Usage records carry a
schema `version` and explicit cache provenance. `aggregate-includes-ticker`
means aggregate cache fields already include ticker usage; `split-excludes-ticker`
means supervisor/worker cache fields exclude ticker usage and ticker fields must
be added to obtain the aggregate.

Worker sessions are persisted under `~/.pi/agent/sessions/forks/` and can be inspected by opening the recorded JSONL path.

## Companion control tools

### Inspect status

```ts
delegate_control({
  action: "status",
  runId?: string,
  tail?: boolean,
  tailLines?: number, // server-capped at 256
})
```

Omit `runId` to list runs owned by the current session. Pass it to inspect one in-process or detached run. Do not use this tool to poll for completion.

### Re-read a result

```ts
delegate_control({
  action: "result",
  runId: string,
  tail?: boolean,
  tailLines?: number, // server-capped at 256
})
```

Normal in-process completion is automatically delivered. For a daemon driver, use the durable prompt outcome and committed-entry replay after reconnect.

### Read daemon prompt status

```ts
delegate_control({
  action: "prompt_status",
  runId: string,
})
```

This query is read-only: it needs no attachment, driver lease, generation, or awake runtime.

### Queue a daemon follow-up

```ts
delegate_control({
  action: "follow_up",
  runId: string,
  message: string,
})
```

Unlike `steer`, `follow_up` waits behind the current daemon turn.

### Answer a daemon UI question

```ts
delegate_control({
  action: "ui_answer",
  runId: string,
  questionId: string,
  answer: { value: string } | { confirmed: boolean } | { cancelled: true },
})
```

The answer is correlated to a pending daemon question and is sent while holding the driver lease.

### Steer a supervised fork or daemon driver

```ts
delegate_control({
  action: "steer",
  runId: string,
  forkName?: string,
  message: string,
  deliverAs?: "steer" | "followUp" | "queue",

  targetLineagePath?: string,
  capToken?: string,
})
```

For supervised forks:

- `steer` interrupts the supervisor's current turn;
- `followUp` delivers after its current turn;
- `queue` places guidance at the beginning of the worker's next round; and
- omission uses the best-effort ladder `steer → followUp → queue`.

Omit `forkName` to broadcast to every live supervised fork in the run. Direct workers and chain steps do not support steering because they have no supervisor. Runs with missing, future, mixed, or otherwise unrecognized shape metadata are shown as neutral runs and reject steering rather than guessing an actor. Detached driver runs support authenticated driver-level steering.

`forkName` resolves in a fixed order, and fails closed. An exact `name` match wins unconditionally. Otherwise the value is matched against display labels. Steering restricts candidates to supervised entries (or an authenticated driver route); cancellation accepts any live delegated entry; recovery accepts failed entries. Exactly one candidate resolves, and the result says which entry it picked. Zero or several candidates change nothing and return an error naming the real entry names to retry with.

An **unresolvable** `forkName` is never treated as an omitted one. Omission means "every supervised entry"; a misspelling does not.

`targetLineagePath` and `capToken` are advanced controls for an explicitly identified nested descendant.

### Cancel

```ts
delegate_control({
  action: "cancel",
  runId: string,
  forkName?: string,
  reason?: string,

  targetLineagePath?: string,
  capToken?: string,
})
```

Omit `forkName` to cancel every live delegated entry in the run. Cancellation is destructive; for a supervised fork, prefer steering for a recoverable course correction. `forkName` resolves against the live entries that cancellation can address, and an unresolvable one cancels nothing at all.

### Recover one failed run

```ts
delegate_control({
  action: "recover",
  runId: string,
  forkName: string,
  strategy?: "auto" | "fresh" | "resume",
  message?: string,
})
```

- `fresh` exactly redispatches the original slot configuration.
- `resume` starts a new child with bounded categorical prior-attempt context and fails if no safe context exists.
- `auto` uses resume when possible and otherwise falls back to fresh.

For ordinary worker recovery, recovery creates an independent child run with its own `runId`; it does not change the original aggregate or cancel healthy siblings. A daemon driver omits `forkName` and instead rebuilds its durable session index through the daemon protocol. Chain-step recovery is intentionally unavailable because later steps may depend on the failed output.

When an isolated direct worker times out or is aborted, the result and failure
notice include bounded changed-path, branch, diff-stat, count, and readable patch
path evidence. Inspect or apply that patch before retrying or using recovery;
recovery does not apply a saved patch automatically. If patch capture itself
fails, the entry carries `worktreeDiff.captureFailed: true` with the preserved
`worktreePath` instead of a usable patch, and the result and failure wake tell
the caller to recover that worktree manually; cleanup leaves it and its branch
on disk.

## Root escalation tools

A `delegate:escalation-pending` wake is a hint to re-read durable state before acting.

### List pending requests

```ts
delegate_escalation({
  action: "list",
  rootRunId?: string,
  requestIds?: string[],
})
```

### Resolve a request

```ts
delegate_escalation({
  action: "resolve",
  rootRunId?: string,
  requestId: string,
  selected: number | number[],
  customInstruction?: string,
  note?: string,
  onBehalfOfUser?: boolean,
})
```

Selections use zero-based option indices. `onBehalfOfUser: true` is valid only after the operator explicitly chose an answer; it must never represent an inferred answer.

### Pass a request upward

```ts
delegate_escalation({
  action: "pass_up",
  rootRunId?: string,
  requestIds?: string[],
  context?: string,
  recommendation?: string,
})
```

Use this when the root agent lacks authority to decide. Omit `requestIds` to pass all root-held requests in scope.

## Nested delegation

Worker access to delegate-family tools is stripped by default. Direct workers need both
`allowNestedDelegate: true` and a trusted `pi-delegate` extension selector; a bare
name alone never authorizes a delegate-family registration. Expose only the exact
capabilities required:

```yaml
allowNestedDelegate: true
tools: read, bash, ext:@centerforagenticai/pi-delegate:delegate, ext:@centerforagenticai/pi-delegate:delegate_control:status
```

A nested call is capped at the lesser of 30 minutes and half the positive
remaining parent wall-clock budget. A zero or negative remainder fails before
execution with guidance to commit and push the work before another nested
attempt, or rerun without nesting. A call that started and then exceeded that
cap fails with a distinct "started but exceeded its nested deadline" error
naming the allocated milliseconds; treat it as possibly partially run and
inspect its side effects before retrying. Without a positive parent deadline, the
existing 30-minute ceiling remains. The cap applies only to explicitly granted
non-interactive direct extension calls; built-ins, `ask`, interactive workers,
and supervised workers retain their existing behavior.

It may also restrict the child agent names:

```yaml
nestedDelegateAgents: scout, reviewer
```

Depth rules:

- ordinary calls default to a maximum delegation depth of `3`, enough for
  driver → implementer → reviewer;
- an executable slot can set `maxSubagentDepth` to raise the cap when that slot
  starts a fresh delegation root; a nested slot cannot raise its inherited cap
  and may only tighten it;
- the hard ceiling is `16`;
- descendants can tighten but cannot raise the inherited cap; and
- detached driver execution preserves its effective minimum cap of `3` at its re-root boundary.

The opt-in grants capability inside the bounded tree; it does not permit nested workers to mutate persistent agent or chain definitions.

## Global configuration that affects calls

Optional configuration lives at `~/.pi/agent/config/pi-delegate/config.json`, with `config.local.json` merged over it.

Call-relevant fields include:

| Field | Purpose |
| --- | --- |
| `notifyOnFailure` | Global default for early bounded failure wakes |
| `worktreeSetupHook` | Executable called after each worktree is created |
| `worktreeSetupHookTimeoutMs` | Timeout for the setup hook |
| `perForkMaxDurationMs` | Global runtime ceiling for solo and supervised runs (#287); `0` disables |
| `perForkMinDurationMs` | Global runtime floor for solo and supervised runs; `0` disables, and positive values raise only a stated positive selected budget after the ceiling. Explicit zero and no selected budget remain unlimited when the floor is the only bound. |
| `skill.excludeSections` | Exact, case-sensitive visible Markdown heading selectors. A match removes through the next equal-or-higher heading, including nested sections. Missing, empty, malformed, or partly unknown values fall back to the complete skill with fixed redacted warnings. |
| `globalToolWhitelist` | Tool and skill baseline applied to every discovered delegate agent |
| `windDownGraceMs` | Grace after timeout wind-down before hard cancellation |
| `heartbeatIntervalMs` | Global supervised worker silence interval |
| `maxConsecutiveHeartbeats` | Consecutive heartbeat threshold |
| `heartbeatTailLines` | Bound on recent worker transcript entries in heartbeat evidence |
| `escalation` | Global partial escalation policy and root authority |
| `disableBuiltins` | Remove bundled agents from discovery |
| `agentOverrides` | Durable per-agent policy overrides |
| `intercomBridge` | Optional worker coordination-instruction injection |
| `ptmBridge` | pi-prompt-template-model bridge ownership |
| `completionNotifyStrategy` | Defaults to `"auto"`; `"auto"` and `"custom-message"` use custom-message wakes, while reserved `"synthetic-tool-pair"` warns and falls back to custom-message |
| `activityTicker` | Footer activity and optional semantic-headline configuration |

The same file also controls overlay layout, shortcuts, cancellation confirmation thresholds, and inspector behavior. `skill.excludeSections` is recomputed on startup and public resource reload. Pi package filters, `autoload`, project trust, and direct/CLI loading remain authoritative, so this bridge cannot re-enable a disabled package skill. It does not interpolate runtime timeout values into skill prose. See the main [`README.md`](../README.md) configuration section for those UI options.

### `globalToolWhitelist`

Despite its historical “Tool” name, the `globalToolWhitelist` first cut includes both tools and skills. Configure the two resource kinds explicitly:

```json
{
  "globalToolWhitelist": {
    "tools": ["read", "ext:skill:load"],
    "skills": ["implement", "test-execution"]
  }
}
```

The global baseline is applied before agent frontmatter and before durable `agentOverrides`. With a configured baseline, non-empty durable `tools` or `skills` arrays extend the composed list, explicit empty arrays clear it, and omitted fields retain it. Without the baseline, durable arrays still replace the whole corresponding array. A worker whose first non-empty tool declaration comes from the baseline retains `read`, `bash`, `edit`, and `write`.

`inheritSkills:false` with no explicit skills uses the non-empty global skill list. `inheritSkills:true` with no explicit skills keeps `skills` absent and exposes the full discovered registry. With explicit skills, both `inheritSkills:false` and `inheritSkills:true` put global skills before agent skills. Invocation `skill:false` is still the final per-call skill opt-out.

`extensionExclude` can opt one agent out of a provider; the affected global-only `ext:` selector will warn and drop when the provider is absent or excluded. A selector repeated in agent frontmatter or a durable/invocation override is explicit and remains fail-closed. Malformed or ambiguous selectors and provider-registration failures also remain hard errors.

### Verify that a skill exclusion applied

The supported `@centerforagenticai/pi-delegate/skill-resource` subpath exports `resolveSkillResource` and `bundledSkillPath`. Use them to fail closed when you must prove that an exclusion produced a filtered resource:

```ts
import assert from "node:assert/strict";
import {
  bundledSkillPath,
  resolveSkillResource,
} from "@centerforagenticai/pi-delegate/skill-resource";

const root = "/absolute/path/to/node_modules/@centerforagenticai/pi-delegate";
const filtered = await resolveSkillResource({
  packageRoot: root,
  config: { skill: { excludeSections: ["Cancelling"] } },
});
assert(filtered !== undefined && filtered !== bundledSkillPath(root));
```

The `undefined` check also rejects a disabled package skill. As a negative control, use a deliberately wrong heading and confirm that the fail-safe fallback returns the complete skill:

```ts
const unfiltered = await resolveSkillResource({
  packageRoot: root,
  config: { skill: { excludeSections: ["deliberately-wrong-heading"] } },
});
assert.equal(unfiltered, bundledSkillPath(root));
```

## Separate Node API: `delegateFromCli()`

The package exports a headless Node entry point in addition to the in-Pi tool:

```ts
function delegateFromCli(
  options: CliDelegateOptions,
): Promise<CliDelegateResult>;
```

It supports direct workers only and always waits for completion.

```ts
interface CliDelegateTaskInput {
  name?: string;
  agent: string | AgentConfig;
  task: string;
  cwd?: string;
  artifact?: string | false;
  reads?: Array<string | WorkerArtifactReference> | false;
  progress?: boolean;
  interactive?: boolean; // currently no effective CLI prompt UI
  env?: Record<string, string | null>;
}

interface CliDelegateOptions {
  tasks: CliDelegateTaskInput[];
  concurrency?: number;
  worktree?: boolean;
  cwd?: string;
  signal?: AbortSignal;

  agentDir?: string;
  agentScope?: "user" | "project" | "both";
  trustProject?: boolean;

  authStorage?: object; // legacy compatibility
  modelRuntime?: ModelRuntimeLike;
  modelRegistry?: ModelRegistry;
  mainModel?: { provider: string; id: string };

  onUpdate?: (snapshot: CliDelegateSnapshot) => void;
  extractCommit?: boolean; // default true
}
```

A discovered project-local agent requires `trustProject: true` because a headless caller has no Pi trust context. Caller-constructed `AgentConfig` objects are caller-owned and are not project-gated.

The promise resolves with per-worker results even when one worker fails. Check `result.anyFailed` and each worker's status. Validation errors, cancellation, and catastrophic setup failures reject the promise.

See [`cli-delegate.md`](cli-delegate.md) for the complete result types, model/auth setup, project-trust behavior, cancellation, worktree diffs, and optional Graft commit-trailer extraction.

## Related source and documentation

- `src/index.ts` — registered tool schemas and execution routing
- `src/direct-shape.ts` — direct shape detection and task expansion
- `src/chain-execution.ts` — chain semantics
- `src/agent-management.ts` — management validation and persistence
- [`escalation.md`](escalation.md) — escalation schemas, authority, routing, and cleanup
- [`early-failure-recovery.md`](early-failure-recovery.md) — early failure wakes and recovery
- [`run-history.md`](run-history.md) — JSONL row shape, versions, usage provenance, and consumer status
- [`cli-delegate.md`](cli-delegate.md) — headless Node API
- [`package-agents.md`](package-agents.md) — package-shipped agent discovery

## Retry replacement

Ordinary supervised run entries, parallel-direct run entries, and a single
direct run entry accept `retryOf: { runId, forkName }`. The reference uses the exact stored
fork name, never a display label, task text, agent name, or similarity. The
caller supplies the corrected `task` and any `cwd` or worktree settings again.
Only failed or aborted predecessors are eligible. Missing, live, completed,
paused, malformed, cyclic, already-replaced, and `count > 1` references are
rejected before dispatch side effects. Distinct claims in one batch are
validated atomically; one predecessor has one direct successor, and longer
chains use stable `attempt` numbers. Legacy or missing metadata means attempt 1.

Examples:

```json
{"runs":[{"agent":"reviewer","task":"Retry the corrected review.","cwd":"/workspace/project","retryOf":{"runId":"run-123","forkName":"reviewer"}}]}
```

```json
{"runs":[{"name":"reviewer-retry","agent":"reviewer","task":"Retry the corrected review.","retryOf":{"runId":"run-123","forkName":"reviewer"}}]}
```

A retry is admitted only after normal model, trust, escalation, and cwd
preflights, but before worktree, chain-directory, session, prompt, or worker
creation. Invalid claims leave no new run or artifact. A predecessor that is
missing, malformed, live, completed, paused, cyclic, already replaced, or used
more than once in a batch is rejected. A retry successor may itself be retried,
forming a bounded longer chain. The chain may contain at most 24 admitted attempts;
a retry that would exceed that retention-safe bound is rejected with the structured
`invalid-attempt` reason. Missing or legacy attempt metadata means 1.

Each attempt has independent results and append-only history. Hydration validates
whole components to a fixed point; unsafe links are quarantined, both endpoints
remain visible, and admission fails closed. A valid unresolved lane is retained
as one component through age/count sweeps. The widget suppresses only a valid
predecessor in the same owner-scoped projection, keeps failed/aborted/paused
rows visible, and applies completed grace as before. It may show cumulative lane
usage even for an absent or zero-usage current attempt; ordinary run/session/global
accounting remains attempt-local.

Status, result, synchronous completion, live wakes, and durable redelivery use
one closed projection containing only ordinal, attempt, retry flag, safe
predecessor run ID, finite cumulative totals, and categorical incomplete state.
The public entry cap is 32; the retention-safe lineage attempt bound is 24. They are separate,
and `retryMetadataIncomplete` and `retryMetadataTruncated` are explicit. Raw
predecessor fork names, tasks, agents, errors, and relationship objects stay
local. Chain steps, saved chains, and the legacy `orchestrate` transport do not support `retryOf`.
`delegate_recover` remains the separate in-memory recovery/resumption mechanism.
