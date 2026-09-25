---
name: pi-delegate
description: |
  Load when dispatching work to subagents as `runs: [{agent, task, …}]`: each
  entry is one run with its own worker session, and each collapses to a single
  tool result. A `mode: "supervised"` run additionally forks the main agent into
  a private multi-turn conversation with its worker. Prefer this over the
  fire-and-forget `subagent` tool whenever the worker is likely to need review,
  clarification, redirection, or iterative refinement (advisory review,
  implementation handoffs, parallel exploration, long-running QA). Also covers
  steering and cancelling running work, background vs awaited execution, and
  git-worktree isolation for parallel work.
load: recognition
---

# pi-delegate

Use this skill when you need a subagent to do real work. One `delegate` call
dispatches a list of runs; each run gets its own worker session and collapses to
one result in the main thread.

The ordinary in-process modes are:

- **`solo`** (the default) — send the task to one worker, return its answer.
- **`supervised`** — insert a **fork of the main agent** (same model, same
  system prompt) between you and the worker. It chats privately with the worker
  for up to `rounds` turns, then collapses. Use it when you might want to push
  back on the first answer.
Solo and supervised worker conversations **never enter the main thread's
history**; only their collapsed result does.

## Empty harvests fail loudly

A run that finishes with no substantive output is now a loud failure offering
recovery, not a silent success. Do not treat a resolved worker turn or lifecycle
chatter as proof that the run completed. The solo runner and supervised
worker channel share one harvest classifier:

- substantive assistant text is a deliverable;
- an explicit provider or assistant failure is a terminal failure; and
- no assistant output, empty output, or cancellation-only output is a terminal
  `failed` result with `No substantive assistant output recovered`.

When recovery is available, the existing `delegate:fork-failed` wake offers it.
If an earlier substantive response was genuinely recovered, the harvest method
is recorded as `salvage`; a terminal substantive response uses `terminal`.
Ordered-run output, progress, and `{previous}` propagation happen only after a
validated substantive completion. This shared classifier closes the independent
blind spots that solo and supervised paths previously had.

## Slash syntax

pi-delegate registers exactly `/delegate`, `/delegate-cancel`,
`/delegate-inspector`, and `/delegate-help`. The dispatch grammar is:

```text
/delegate TASK [--direct | --fork | --supervised | --chain NAME] [--agent NAME] [--foreground | --fg] [--worktree] [--model MODEL] [--thinking LEVEL] [--skill NAME ...] [--cwd PATH]
```

```text
/delegate-cancel [RUN_ID [ENTRY]]
```

For operator cancellation, omit both values to pick one live target. Supply
`RUN_ID ENTRY` to cancel one canonical entry immediately. Supply only `RUN_ID`
to confirm whole-batch cancellation. Completion lists unique live run IDs, then
canonical entry names for the chosen run. Picker dismissal leaves work running.

The task comes first. `/delegate TASK` runs the built-in `delegate` worker
directly in the background. `--direct` is the explicit default. `--fork` and
`--supervised` select supervised execution. `--foreground` and `--fg` wait for
the result. `/delegate TASK --chain NAME` runs a saved chain and permits only the
task, `--cwd`, and foreground control.

Quote task tokens whose text looks like an option. A quote starts a structural
region only at the beginning of a token, so contractions and possessives such
as `don't` and `module's` remain ordinary task text. Backslash escapes the next
character. Unclosed quotes, unknown options, missing values, conflicting
selectors, invalid thinking levels, unknown workers or chains, and incompatible
chain options are rejected before dispatch.

```text
/delegate Review the authentication changes
/delegate "Review text ending in --foreground"
/delegate Review the change --fork --agent reviewer --thinking high --skill code-review
/delegate Summarize the repository --chain discovery-report --cwd /repo --fg
/delegate-cancel
/delegate-cancel RUN_ID ENTRY
```

Use management forms alone: `/delegate --agents`, `/delegate --chains`,
`/delegate --health`, and `/delegate --help`. Bare `/delegate` and
`/delegate-help` show the same help. Use `/delegate-inspector` for status and
transcripts. Inline chains and parallel workers remain available through the
`delegate` tool API, not the slash interface.

## Composing saved chains

A saved chain can reference another saved chain with this exact canonical
heading; do not insert whitespace after the colon:

```md
## chain:reusable-review

Review {task} after {previous}.
```

The management equivalent is `{ chain: "reusable-review", task?: "..." }`.
It is a distinct step variant and cannot carry `agent` or worker-only options.
The parser accepts legacy whitespace after `chain:` for compatibility, but the
serializer always writes `## chain:<name>`. The `chain:` heading prefix is
reserved: a worker agent used in a saved chain must not have a name beginning
with `chain:` because that spelling is parsed as a saved-chain reference.

A deterministic command stage uses `## run:<label>` followed by required
`command` and optional `cwd`, `env`, and `timeoutMs` lines. Its management shape
is `{ run, command, cwd?, env?, timeoutMs? }`; it cannot carry a task or worker
fields. It starts no LLM. A successful command leaves scoped `{previous}`
unchanged. Any failure stops the chain. Project-scoped commands require project
trust, and all command stages are preflighted before the first worker starts. A
confined nested caller cannot invoke a command stage because its separate shell
process cannot inherit the caller's write guard.

Every reference creates a local template scope. The reference task is evaluated
once against the parent's scoped `{task}` and current `{previous}`. That result
is frozen as `{task}` for the referenced chain, including its first worker and
all deeper references. `{previous}` is different: it starts empty inside each
referenced chain, advances after each local worker or completed child reference,
stays unchanged across a successful command stage, and returns the referenced
chain's final output to its parent.

Resolution is recursive and eager. Every referenced name uses normal saved-chain
discovery precedence. The complete reference graph resolves and every command
stage validates before any worker starts. A missing reference, cycle, or invalid
command stage rejects the whole invocation before side effects begin.

Nested-delegation policy applies to the resolved worker leaves, not to
saved-chain names. `nestedDelegateAgents` must allow every resolved leaf agent. The
caller's write-confinement authority also bounds every resolved leaf: inherited
worker directories must remain within the caller's roots, and a leaf cannot
waive confinement or add an outside root. Allow-list or confinement rejection
happens before worker construction.

Composition expands in place. All workers and command stages belong to one
chain run and share its single `chainDir`; a referenced chain never creates a
second artifact directory.
Expansion makes no nested `delegate` call, so each reference adds zero delegation
depth.

## When to prefer `delegate` over `subagent`

| Situation | Tool |
| --- | --- |
| Likely to need review / clarify / redirect with the worker | **`delegate`** |
| Parallel specialists where each may iterate independently | **`delegate`** (up to 6 runs) |
| Long-running review/QA you can dispatch and forget | **`delegate`** (background is the default) |
| Git-isolated parallel implementation work | **`delegate`** with `worktree: true` |
| Truly fire-and-forget single-shot question | `subagent` (simpler) |
| You specifically need pi-subagents' chain/parallel orchestration DSL | `subagent` |

Default to `delegate` unless the task is clearly one-shot.

## Tool surface

- `delegate` — dispatch 1..6 parallel runs. The main call.
- `delegate_control` — inspect and control ordinary runs:
  - `status` — list active/completed dispatched runs.
  - `result` — replay a dispatched run's authoritative output by `runId`.
  - `steer` — guide an explicit supervised run's copied supervisor `fork`.
    Direct workers, chain steps, and unknown in-process shapes reject steering;
    use sparingly.
  - `cancel` — abort one run or the whole dispatch.
  - `recover` — relaunch a single failed worker entry. Foreground-only: a
    delegated worker is refused this action.
- `delegate_escalation` — one tool, three actions:
  - `list` — list canonical pending escalation requests and their holders.
  - `resolve` — resolve a root-held request within root authority, or a
    user-held request only after the operator actually chose and
    `onBehalfOfUser: true` is supplied.
  - `pass_up` — pass a root-held request upward, normally to the user.

Both appear only once there is something to control, so they are absent from an
idle session. The eleven names they replace still work in a `tools:` allowlist.

## Minimum viable call

```ts
delegate({
  runs: [
    { agent: "reviewer", task: "Review packages/api/src/session-store.ts for race conditions" }
  ]
})
```

Solo and supervised background runs return immediately with a `runId`; when they
finish, the main agent gets a `custom_message` wake-up containing the collapsed
output.

## Key parameters per run entry

```ts
delegate({ runs: [{
  agent: "reviewer",                // agent definition name (required)
  task: "...",                      // initial framing (required unless `after`-gated)
  name?: "reviewer-a",              // the key you steer/cancel/recover this run by
  mode?: "solo",                    // "solo" (default) | "supervised"

  // solo only — reject on a supervised entry
  after?: ["scout"] | "previous",   // order this run behind a whole earlier layer
  count?: 3,                        // fan out N copies of this entry
  artifact?: "notes.md",            // private returned file; basename only, never a workspace path
  check?: "validate-notes notes.md", // validate that artifact; independent solo runs only
  reads?: ["spec.md"],              // seed the worker with file contents
  progress?: true,                  // direct/chain progress file; supervised ignores and warns once

  // supervision. `rounds` REJECTS on a solo entry; `clone_mode` and
  // `collapse_mode` are accepted there and silently do nothing (#286).
  rounds?: 5,                       // total worker-message budget; exact first turn consumes one
  clone_mode?: "full" | "snippet" | "task_only",   // history seeding, default "full"
  task_delivery?: "direct-first-turn" | "supervisor-mediated", // exact caller task first by default
  snippet_last_n?: 10,              // for "snippet" mode
  collapse_mode?: "final_output" | "summary",
  // Omit for no provider call; pin provider/model, or use "auto" for built-in Haiku 4.5.
  summary_model?: "anthropic/claude-haiku-4-5" | "auto",
  supervisor_instructions?: "be strict about error handling",

  // solo and supervised
  thinking?: "high" | false,        // worker-only initial level override
  thinkingMin?: "medium" | false,   // worker-local adaptive lower bound
  thinkingMax?: "high" | false,     // worker-local adaptive upper bound
  skills?: "code-review" | ["code-review"] | false,
  cwd?: "packages/api",             // per-run cwd (rejected when worktree:true)
  interactive?: false,              // route worker UI prompts to overlay
  worktree?: false,                 // one fresh git worktree for this run
  escalation?: "off" | "local" | object, // per-entry structured escalation policy

  model?: "openai/gpt-5",           // worker model override
  depth?: 1,                        // nested-delegation cap
  env?: { GRAFT_MAIN_REF?: string | null }, // per-worker env patch
  handoff?: { tasks: [...] },       // seed the durable task list
}] })
```

For a supervised run, omission of `task_delivery` means `direct-first-turn`: the
runtime sends the caller's exact `task` to the worker, then seeds the supervisor
with that completed exchange. The exchange consumes round 1. Use explicit
`task_delivery: "supervisor-mediated"` only when the supervisor should compose
the first worker instruction.

`progress?: boolean` is accepted on a supervised entry for compatibility, but it
is ignored and warns once per dispatch because the supervisor controls the
message stream. The supervised `artifact` and `reads` fields remain
rejected. Direct and chain runs retain their existing `progress.md` behavior.

`env` merges over the inherited process environment on direct and chain worker
surfaces; `null` explicitly unsets a non-delegate-owned variable. Delegate
lineage, routing, authentication, and child-control variables cannot be replaced
or removed. Saved agent defaults may declare the same field and invocation
values take precedence. Workers use the already-loaded extension code from the
parent session; rebuilding an extension while a session is running does not
update existing runs.
Durable agent/chain/config definitions store `env` values in plaintext.
Name-only operational displays are redaction, not encryption of those files.
Never save API keys, tokens, passwords, or other secrets in these definitions;
use the process environment or a secret manager instead.
Start/reload a fresh Pi session when a task depends on newly built extension
code.

**`clone_mode` cheat sheet.** It seeds a supervisor, so it only means something
with `mode: "supervised"`. A solo entry accepts it and drops it — inert, not
invalid — so it never fails a dispatch, and never does anything either:
- `full` — the supervisor fork sees the entire main thread (highest fidelity,
  costs the most). Default. Watch token cost on long sessions.
- `snippet` — the fork sees only the last N main-thread messages. Cheap
  mid-session delegations.
- `task_only` — the fork sees just the task framing. Cheapest; use for
  self-contained questions.

### Seed and read a worker checklist

When a delegated worker has several steps worth tracking and a `session_tasks`
claimant is loaded, request a durable checklist in that entry's namespaced handoff:

```ts
delegate({
  runs: [{
    name: "worker-lane",
    agent: "worker",
    task: "Implement the requested change.",
    handoff: { tasks: [{ title: "Read the spec" }, { title: "Implement and test" }] },
  }],
})
```

When a `session_tasks` claimant is loaded, the runtime stores the seed as a
`context-aware.tasks.v1` session entry and supplies the worker's list-maintenance
instruction; do not duplicate that runtime instruction here. Without a claimant,
the worker receives a prompt checklist instead; it is not durable and has no subtree
or progress rows to read. With a claimant, progress rows ride the
existing `updated` bus event; read the worker's subtree with `session_tasks action=subtree`
rather than waiting for a prose update. Worker task IDs belong to its own address space
and are marked `id-kind="local"`; never reconcile them against the dispatcher's own `t1`/`t2` ids.

The receiver bounds come from `src/task-seam.ts`: `MAX_SEED_TASKS` tasks,
one-level subtasks via the `parseSlotTask` depth guard and `MAX_SEED_SUBTASKS`,
and notes capped by `MAX_SEED_NOTE_CHARS`. Keep these names in documentation and
code references so the limits cannot drift silently.

### Name your runs

`name:` is the addressing key. Every later `delegate_control` call takes it, the completion envelope reports it as
`forkNames`, and the widget shows it. Set it on every entry of a multi-run
dispatch, and name it after the **work** — an issue reference, a lane, a
component — never after the agent.

Omitted, it falls back to the agent's name, with `#2`, `#3` appended for
duplicates. The runtime then derives a display label from the task so the row
still says something, but it can only work from the text you sent: three entries
briefed from the same file are indistinguishable to it and come back as
`worker 1/3`, `worker 2/3`, `worker 3/3`. Naming them costs one field and makes
the whole run legible.

```ts
runs: [
  { name: "#128-widget", agent: "implementer", task: "…" },
  { name: "#128-overlay", agent: "implementer", task: "…" },
]
```

### Bounded adaptive thinking

Agent frontmatter can declare `thinking`, `thinkingMin`, and `thinkingMax` from
`off|minimal|low|medium|high|xhigh`. A bounded worker begins at `thinking`, then
a compatible adaptive-thinking extension may adjust only inside the session's
range. Bounds are isolated per worker and never rewrite global adaptive-thinking
configuration. Invocation and chain-slot overrides use the same fields; `false`
clears one field for that invocation.

For least privilege, load the extension explicitly and select only its adaptive
tool, for example:

```yaml
thinking: high
thinkingMin: medium
thinkingMax: high
extensions: /path/to/adaptive-thinking/index.ts
tools: read, bash, ext:adaptive-thinking/set_thinking_effort
```

`ext:<extension>/<tool>` resolves after worker extension loading. If the provider is
missing, the selector is skipped with a diagnostic; it never activates sibling
extension tools. A configured provider that fails to load or is removed by explicit policy
remains a setup error. Ambiguous or malformed selectors still fail closed. Explicit
allowlists that select no usable tools also fail closed instead of widening to
Pi defaults. Bounds remain dormant if adaptive-thinking is absent. A loaded
`set_thinking_effort` provider must acknowledge pi-delegate's session-local
policy protocol v1 or the worker fails before model work.

Nested delegation uses a separate depth policy. Its conservative default is 3,
but a fresh root agent may set `maxSubagentDepth` to 3, 4, 5, or another
deliberate value up to the global hard ceiling of 16. Ordinary descendants can
tighten that inherited root cap but cannot raise it. This keeps ordinary calls
shallow without rejecting valid multi-stage orchestrator trees.

## Detached driver mode

`mode: "driver"` hosts exactly one durable `pi-daemon` session that survives
caller exit. Launch returns after prompt acceptance; use `delegate_control`
`prompt_status` and `result` to retrieve completion after caller or daemon
restart. Pi-daemon's session file is authoritative; pi-delegate stores only its
locator.

Driver entries accept `model`, `env`, and task handoff, but reject `cwd`,
`interactive`, `worktree`, and `escalation`; `thinking` and `skills` are inert.
Task handoff reaches a usable session-tasks claimant before the first model
request, otherwise it is delivered once as Markdown. The child rechecks
adaptive-thinking policy and keeps the established minimum nested-delegation
depth of 3. Foreground write confinement does not cover the detached child.

Driver control uses the authenticated daemon route:

- `prompt_status` queries the durable prompt outcome without a lease.
- `steer`, `follow_up`, and `ui_answer` deliver guidance or a correlated answer.
- `cancel` acquires the lease and calls `abort`; live contention returns
  `lease_held`.
- `recover` resumes an interrupted driver.

The overlay shows drivers in a status-only section with elapsed time, last
activity, PID, phase, and terminal reason. `status` returns that projection;
`health` reports the active-detached count; raw errors remain result-only. A
runner that exits before publishing a result is persisted as `runner-exited` and
delivered through the normal pending-wake path.

Driver runs cannot use `retryOf`; recover them through the control route.

## Top-level parameters

```ts
{
  runs: [...],                      // 1..6 entries, required
  task?: "shared task",             // used by entries that omit their own
  concurrency?: 4,                  // max simultaneous workers
  failFast?: false,                 // stop an ordered dispatch at the first failed layer
  chain?: "saved-chain-name",       // invoke a saved `.chain.md` template
  agent_scope?: "user" | "project" | "both",  // default "both"
  worktree?: false,                 // one fresh git worktree per run
  await?: false,                    // true only when the next action requires the result
  sync?: false,                     // deprecated compatibility alias for await
  notifyOnFailure?: true,            // default true; set false to opt out of early failure wakes
}
```

## Background (default) vs awaited completion

- **Background** (default for every ordinary dispatch): the tool returns immediately
  with `runId` + run names; runs execute in the background; the main agent keeps
  working. Combined output arrives later as a `custom_message` that
  **automatically triggers a new turn** — you do NOT need to poll, sleep, or
  check status. Just continue with other work or let your turn end; the results
  will wake you up.
- **`await: true`**: the tool blocks until all runs finish and returns the
  combined output as the current tool result. Use this explicit dependency
  barrier only when the next action requires the answer and blocking the normal
  conversational path for run-control instructions is acceptable. `sync: true` is
  a deprecated compatibility alias.

**⚠️ Anti-pattern: polling / sleeping after dispatch.**
Do NOT call `delegate_control(action="status")` in a loop waiting for completion. Do NOT use
`bash sleep N && echo done`. Do NOT busy-wait. The dispatch mechanism handles
notification automatically — a new agent turn is triggered with the full
output the moment all runs finish.

### Early failure wakes and recovery (default-on)

A bounded `delegate:fork-failed` wake is emitted immediately when a background
run reaches terminal failure. This is **on by default** (`notifyOnFailure: true`).
Set `notifyOnFailure: false` to opt out to aggregate-only behavior. The wake is
bounded to `runId`, run identity, categorical reason, sibling statuses, and
recovery availability; it contains no free-form error/task/prompt/transcript,
path, URL, environment, or worker-output data.
Healthy siblings continue and the normal aggregate `delegate:complete` wake still
arrives once.

When the wake says `recoveryAvailable: true`, call
`delegate_control({action: "recover", runId, forkName, strategy: "auto"})` only for that failed
run. Recovery dispatches an **independent child run** with its own `runId` and
completion wake — the original dispatch is never delayed or mutated. `auto` tries
`resume` (new child seeded only with a categorical failure kind, whether partial
output existed, and bounded categorical tool-activity facts) if available,
otherwise falls back to `fresh` (exact original config, no prior context).
`strategy: "resume"` fails closed when no safe context exists. Recovery preserves
the exact applicable original invocation configuration (including explicit
false/zero values), is idempotent per run, never cancels healthy siblings,
and is also available after the original aggregate completes while the same live
process and dispatching foreground session own the descriptor. Hydrated,
replacement-session, and pending-wake paths fail closed. A halted chain step is
intentionally not recoverable. See [`docs/early-failure-recovery.md`](../../docs/early-failure-recovery.md).

Omitting both `await` and deprecated `sync` always dispatches in the background.

## Structured escalation (strict opt-in, resolved per slot)

Enable escalation when safe progress may require a bounded decision outside the
worker's authority, the worker may be unable to proceed, or the task, plan,
spec, or model may need amendment. Workers should still decide reversible
implementation-local details supported by task and repository evidence. Do not
guess material scope/product changes, conflicting requirements, security or
permission questions, compatibility or migration risk, destructive or
irreversible actions, external side effects, meaningful cost, or anything the
task explicitly requires to be escalated.

Escalation is **strictly opt-in**, and every slot resolves its effective mode
independently. Only a resolved `mode: "local"` enables a slot. Use
`escalation: "local"` or an object with `mode: "local"` to opt in an individual
run entry or saved chain step.
An agent or global policy may also supply the opt-in mode for a slot, while a
higher-precedence layer can opt it back out; authority alone does not enable
escalation. Enabled workers receive:

- `escalate_decision` for a bounded choice with 2–5 explicit options; include the required `category`: `implementation` for reversible implementation-local choices, `scope-product` for material scope/product/UX changes, or `security-permission` for security or permission questions;
- `escalate_blocker` when progress is impossible, including the cause and what
  would unblock it; and
- `escalate_amendment` when the task/plan/spec/model needs an exact proposed
  change and rationale.

A generic extension `ask` never reaches the operator from a worker dispatch. In an
escalation-enabled slot it is safely routed to `escalate_decision` only when
question, 2–5 options, zero-based recommendation, explicit category, and
multiselect semantics are representable; otherwise the adapter fails closed.
Translated decisions do not apply a timeout default. In an escalation-disabled
slot, `ask` returns an actionable error telling the worker to stop and report the
unresolved question upward; no escalation tool exists there to call. Do not
self-answer, infer `implementation` for scope/product or security/permission
questions, or treat cancellation as an answer. Foreground interactive `ask`
remains unchanged.

In supervised mode, the fork supervisor uses `resolve_escalation` only when its
declared authority covers the request and it can choose safely. Otherwise it
uses `escalate` to pass the request upward with useful context and a
recommendation. At the root, first call `delegate_escalation(action="list")` to re-read
canonical state. Resolve root-held requests only inside root authority; use
action `pass_up` for “not mine; pass up.” A user-held request may be resolved
with `delegate_escalation(action="resolve", ..., onBehalfOfUser: true)` **only after the
operator actually chose**. Never infer or manufacture the operator's answer.

A pending request durably suspends **only the raiser's tool call**, without
model-token burn. Supervisors and root hops wake briefly to resolve or pass;
they must not poll, sleep, or busy-wait. Escalation relies on background
delivery, so preflight rejects `await: true` (and `sync: true`) whenever any
slot resolves to enabled. Let the current turn end while an operator-held
request remains pending; a later resolution wakes and resumes the raiser.

See [`docs/escalation.md`](../../docs/escalation.md) for the complete schemas,
authority matrix, routing, timeout defaults, and cleanup semantics.

## Parallel work with git worktrees

```ts
delegate({
  worktree: true,
  runs: [
    { agent: "worker", task: "Implement feature A on branch a" },
    { agent: "worker", task: "Implement feature B on branch b" },
  ]
})
```

Each run gets a fresh worktree under the OS tmpdir, branched from current
HEAD. Diffs are summarised in the combined output and the worktree is cleaned
up automatically. Requires a clean git tree in the main cwd. Per-run `cwd`
is rejected when `worktree: true` (worktree owns cwd assignment).

All delegate-owned in-process workers enforce writable-root confinement by
default and receive a unique per-worker scratch directory. `write`/`edit` paths
are checked lexically, case-aware per filesystem root, and through existing
symlinks. Use `readOnly: true` on the run entry to restrict primary-root
`write`/`edit` paths; scratch and separate artifact roots remain writable, while
the primary root and its ancestors are excluded. It also rejects common mutating
bash commands; prose and a tool list do not enforce read-only behavior.
The repository-pollution guard rejects reserved or declared artifact names and
the protected `.pi/pi-delegate.json` config for `write`/`edit` and common shell
writes in Git worktrees. It detects the effective (last) static `dd of=` operand
and awk output redirection whose complete target expression is one string-literal
path. Projects can use that config's `artifactNameExceptions` list for legitimate
repository paths. The bash name
guard is best effort against deliberate command-form evasion, not a sandbox.
Dynamic or computed target construction, unmodelled interpreter file-open APIs
such as `os.open`, `fs.openSync`, `sysopen`, and `File.binwrite`, nested shells,
unlisted mutators, and arbitrary custom tools remain accepted residuals. The
authoritative guarantee that reserved files never reach Git is the delivery/CI
gate, whose git-level staged/tracked check catches files however they were
created. Direct
workers and supervised forks report git-only mutation attribution. Configure
`writableRoots` or `confineWrites: false` per slot; see
[`docs/write-confinement.md`](../../docs/write-confinement.md).

A worker may write only inside its assigned cwd, its own scratch directory, and
any roots you grant with `writableRoots` (a `readOnly` worker cannot write its
cwd — only scratch and separate artifact roots). Arbitrary absolute paths are
refused, and the rest of `/tmp` (the OS temp directory) is **not** writable —
only the worker's own scratch and artifact-workspace subdirectories are.
So a task that says "write the report to `/tmp/foo.md`" is refused every time, no
matter how the caller phrases it. For a private file returned through delegate, set
`artifact: "foo.md"`; the value is one canonical basename with an extension. The
runtime injects a separate absolute artifact-workspace path, then validates and
returns that file. `artifact: "notes/foo.md"` is rejected: it is not a destination
inside the worker cwd. For a durable workspace file, omit `artifact` and instruct
the worker to use its `write` tool at an authorized workspace-relative path. To
write outside the worker cwd, grant `writableRoots` on a worker that is NOT
`readOnly`.

`readOnly: true` does not combine with `writableRoots`. A read-only worker may
write only its scratch directory and its artifact workspace, so a granted root
never takes effect -- including one outside the worker's own root. A grant at,
inside, or containing the primary root is now rejected at dispatch rather than
silently ignored; before that, the worker did its whole task and the write
failed at the end, after which the scratch directory was removed and the work
was unrecoverable.

**For a read-only worker that must produce a file, use `artifact:`.** It is the
only supported route, not merely the preferred one.

The worker is told its own write scope automatically, so the task text does not need
to name a scratch path — and must not hard-code an out-of-scope one.

## Steering a supervised fork

Steering is supported for an explicit supervised run. It targets the `fork`,
the copied main-agent supervisor context; guidance reaches that supervisor,
which guides the delegated `worker`. Direct workers, chain steps, and unknown
in-process shapes reject steering rather than assuming a supervisor.

Use it sparingly — frequent interruptions defeat the purpose of delegation.
Prefer letting the supervised session finish unless it's clearly off-track.

```ts
delegate_control({
  action: "steer",
  runId: "...",
  forkName: "reviewer-a",     // the compatibility field for this run's address
  message: "Focus only on the locking logic; skip naming nits.",
  deliverAs: "steer"          // or "followUp" or "queue"; default = best-effort ladder
})
```

`forkName` also accepts the display label the widget shows, when exactly one
live supervised entry owns it; the result then tells you which supervised entry it resolved to. A name
that matches nothing, or a label that matches two supervised entries, is an error that
changes nothing — it never falls back to the broadcast. The run name is the generic
addressing key used by control actions across direct workers, supervised forks,
and chain steps; `forkName` remains the control API's compatibility spelling.

The user can also steer interactively from the overlay (`Option-O` / `Alt+O`,
or `Ctrl+Alt+D` → select entry → `Tab` → type → `Enter`).

## Cancelling

The operator-facing command is `/delegate-cancel [RUN_ID [ENTRY]]`. With no
arguments it lists live targets. `RUN_ID ENTRY` cancels one exact entry without
confirmation. Bare `RUN_ID` confirms whole-batch cancellation.

`Esc` keeps its local context: foreground-turn interruption, inspector ascent or
close, and confirmation dismissal. Use `/delegate-cancel` for an explicit target.

The agent-facing equivalent is:

```ts
delegate_control({ action: "cancel", runId, forkName?, reason? })
```

Cancellation addresses any ordinary delegated run entry: a direct `worker`, a
supervised `fork` plus its delegated `worker`, or a chain `step`. Existing
authorization rules still apply. Omit `forkName` to abort the whole batch. Any
blocking worker UI prompts resolve to their default. Completion still wakes the
main agent.

Run-entry timeout policy is opt-in by default: global `perForkMaxDurationMs`
(`0` by default) is an absolute operator ceiling. Agent definitions and
run entries can set `max_duration_ms` and
`wind_down_grace_ms`; precedence is invocation > agent > global, with explicit
`0` disabling a layer unless a positive global ceiling clamps it. Solo runs
resolve the same budget at the dispatch boundary through the same precedence
(#287). They arm it when the first worker session becomes steerable, before
extension binding and prompt delivery. `max_duration_ms` is the
explicit worker execution limit; it is not a promise that the
outer `delegate` call returns at that exact wall-clock instant. On timeout,
the supervisor/fork-clone still has to wind down, cancel its worker, persist
the terminal result, and collapse the fork. That shutdown overhead can make
observed wall-clock duration exceed `max_duration_ms`, while the result still
correctly reports `cancelReason: "timeout"`. A refusal fallback shares that first
deadline; changing models does not restart the clock.

For a long solo run that writes incremental findings, set one `artifact` file.
The worker must write it at the absolute artifact-workspace path the runtime injects. On clean
completion, the runtime reads its non-empty contents and uses them as the
worker's deliverable. Missing or invalid artifacts fail the step; the runtime
never substitutes the final assistant message.

`check` is an optional shell command beside `artifact` on an independent solo run.
The runtime runs it after the producer finishes. A failed check retries that producer
exactly once with the checker's bounded output, and a second failure fails the run.
A successful artifact writes `manifest.json`: `check.status` is `pending` without a
checker and records the checker result otherwise.

Per-run `check` does not compile into ordered runs. A dispatch with any `after` entry
rejects a per-run `check` instead of dropping it. For an ordered or saved-chain
producer, declare both `artifact` and `check` in that producer's agent frontmatter;
the agent-level checker applies to its chain step.

Timeouts do not inspect or publish a declared artifact. The run remains
truthfully `aborted`/`timeout`, and any final message remains a handoff.

### Choosing and retrying timeout budgets

Budget for the work the worker must do, not just the model's next response:

- Start bounded inspections and code reviews at 5–10 minutes. Use 15–30 minutes for
  builds, integration tests, or work that may wait on tools.
- Add a `wind_down_grace_ms` large enough for the supervisor to collect a useful
  result. A 60–120 second grace window is a practical starting point when the
  worker may finish near the limit.
- If a timeout is otherwise healthy, retry once with roughly 2× the worker budget
  and a matching grace window before changing the task or model.
- If a second timeout occurs, inspect `delegate_control(action="result")` and the
  run activity. Then narrow the task, split the work, or stop retrying. Do not
  treat a longer outer wall-clock wait as proof that the worker received more
  execution time.

## Discovering available agents

Bundled builtin agents (always available): `delegate` and `worker`. Companion
development-tool packages can ship the `scout`, `planner`, `reviewer`,
`implementer`, and `integrator` workflow agents. Plus anything in
`~/.pi/agent/agents/`, `~/.agents/`, or project-local `.agents/` / `.pi/agents/`
directories.

`implementer` is the language-agnostic implementation worker (it loads
`implement` plus the matching `implement-<language>` orientation).
`integrator` is the narrow merge helper for putting finished parallel work onto
one branch (it loads `merge-coordinate`). For planning and dispatching that
parallel work in the first place, load `orchestrate-work`.

Use `/delegate --agents` (humans) or read the relevant `.md` definition
(agents) to see what each one does.

## Picking a collapse mode

- **`final_output`** (default) — return whatever the supervisor passes to
  `finish_delegation({ final_output })`. Use this when the supervisor itself
  has produced the answer you want.
- **`summary`** — ask the supervisor for a concise closing note. With no
  `summary_model`, that note is returned verbatim with zero summarizer provider
  calls. Pin `provider/model` to refine the full transcript, or use literal
  `"auto"` to select only `anthropic/claude-haiku-4-5`. If Haiku is unavailable,
  collapse retains the supervisor hint and does not select another model. Before
  any worktree or fork is created, the dispatch preflight emits at most one
  diagnostic warning when configured summary references are unavailable in the
  active registry or session scope. For a narrow registry, set per-run
  `summary_model`, agent frontmatter `summary_model`, or
  `delegateConfig.agentOverrides.<agent>.summaryModel` to an available model.
  The per-run value wins over the effective agent default. The warning is
  advisory and never selects a fallback. For reviews, prefer `final_output`
  unless a separate transcript-collapse pass is genuinely needed.

## Common patterns

**Advisory review of staged work** (supervised, so `clone_mode` is valid):
```ts
delegate({ runs: [{ agent: "reviewer", task: "Review the diff for bugs",
                    mode: "supervised", clone_mode: "snippet", snippet_last_n: 20 }] })
```

**Two specialists in parallel:**
```ts
delegate({ runs: [
  { name: "callsites", agent: "scout",   task: "Find every call site of foo()" },
  { name: "refactor",  agent: "planner", task: "Plan a refactor that renames foo to bar" },
]})
```

**Cheap self-contained research** (solo — no `clone_mode`, there is no supervisor):
```ts
delegate({ runs: [{ agent: "worker", task: "Summarise the OAuth2 PKCE flow" }] })
```

For web research, see the README guidance on host-specific search/fetch tools.

**Ordered pipeline** — each layer waits for the whole one before it:
```ts
delegate({ runs: [
  { name: "scout",  agent: "scout",   task: "Inventory the session store" },
  { name: "plan",   agent: "planner", task: "{previous}", after: "previous" },
  { name: "review", agent: "reviewer", task: "{previous}", after: "previous" },
]})
```

**Implementation handoff with git isolation:**
```ts
delegate({ worktree: true, runs: [
  { agent: "worker", task: "Implement plan in scratch/plan.md", mode: "supervised", rounds: 8 },
]})
```

## Watching delegated work live

- **Status widget** below the editor — one line per active run. Wide rows show
  each run's current deterministic or opt-in semantic ticker headline and
  update immediately when it changes; a ~10 s refresh advances elapsed time.
  Each row also shows a compact rolling chip such as `12k tok/$0.084`, summed
  across the supervisor clone (when present), worker, caches, and that run's
  activity-ticker usage. Message counts use the compact `8msg` form. The narrow
  `◆N` row aggregates usage over the visible runs.
- **Footer ticker** — aggregate live and briefly retained terminal counts for
  every run count; per-run identities and headlines stay in the widget.
- **Transcript inspector** — `Option-O` / `Alt+O`, `Ctrl+Alt+D`, or `/delegate-inspector`.
  - The header keeps a persistent `live N:` summary; `N live elsewhere` explains historical selection.
  - `←/→` switch run entry, `{/}` switch run, `[/]` jump message, `l` jumps to/cycles live runs.
  - `↑/↓` scroll, `End` resumes auto-follow, `t` cycles thinking detail, and `g` cycles tool detail.
  - `s` → compose → `Enter` to steer the selected supervised fork.
  - `x` then `y` to cancel the selected run entry.

## Gotchas

- **Never poll or sleep after dispatching.** Dispatch mode auto-triggers a new
  turn with results. Calling `delegate_control(action="status")` in a loop or `bash sleep` wastes
  tokens and time.
- `clone_mode: "full"` copies the entire main-thread history into the fork.
  Cheap mid-session delegations should use `snippet` or `task_only`.
- Fork-clone needs the main agent's model configured in `ModelRegistry` —
  if your main model lacks auth, fork creation fails.
- Worker sessions are saved under `~/.pi/agent/sessions/forks/` — a
  discoverable subdir of the main sessions dir, kept out of `/resume`'s
  per-cwd picker. Open with `pi --session <path>`.
- Outside the opt-in escalation native prompt and existing overlay controls,
  there is no general mid-fork user-driven supervisor UI. The main agent still
  drives the fork; a `supervisor: "user"` mode is not implemented.

## Reference

- Use `pi list` to locate the active package source; editable package checkouts
  should not live under `~/.pi/agent/extensions/`.
- Full package docs: `README.md` and `docs/escalation.md` relative to the active
  package root (parameters, config, builtin agents, testing, and security notes).

## Retrying a failed attempt

Use `retryOf: { runId, forkName }` on an ordinary supervised run entry, direct
run entry, or single direct run. Copy the exact stored `forkName`, provide a corrected
`task` and any needed `cwd` or worktree settings, and expect a new `attempt`.
Only failed and aborted predecessors qualify; `count > 1`, live/completed/
paused predecessors, duplicate or already-replaced references, chains, and
saved chains are rejected. A valid unresolved lane is retained as one component within the 25-run durable
completed-record budget; malformed hydrated relationships are quarantined and fail
closed without hiding their rows. `retryOf` hides only the valid predecessor
row in the owner-scoped ambient widget. Public retry metadata is capped at 32
entries separately from the 24-attempt retention-safe lineage bound and reports explicit
incomplete/truncated flags consistently across status, result, synchronous
returns, live wakes, and durable redelivery. Cumulative presentation may carry
prior usage for a zero-usage attempt, while accounting stays attempt-local. It
is not `delegate_recover`, which has separate recovery/resumption authority.

## Nested coordinator synthesis

For a nested coordinator, `delegate:complete` starts a fresh result window. Its
next answer must be one self-contained synthesis of the completed children;
pre-wake progress is not concatenated into that result. While owned children
remain live, pi-delegate keeps the coordinator session available through
`agent_end` until a child wake, queued input, cancellation, or provider failure
advances the lifecycle. Coordinator shutdown aborts its unfinished children.
