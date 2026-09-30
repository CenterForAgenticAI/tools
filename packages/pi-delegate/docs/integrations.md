# Integrations and migration

This guide is for consumers integrating prompt templates, pi-subagents workflows, Fabric, event-bus listeners, or the CLI API.

## Working with pi-prompt-template-model

If you also use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)
(PTM) — the slash-command runner with `model:` / `skill:` / `loop:` /
`chain:` / `bestOfN:` frontmatter — `pi-delegate` can serve as the
delegation backend whenever a template uses `subagent:`, `parallel:`, or
`bestOfN:`.

```yaml
---
description: Audit the diff in three parallel workers
model: claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
parallel: 3
worktree: true
---
Audit the diff: $@
```

Running `/audit-diff something` with both extensions installed will:

1. Render the prompt body via PTM (model selection, skill injection,
   `$@` substitution).
2. Hand the delegated batch to `pi-delegate` via the
   `prompt-template:subagent:request` event channel.
3. Run three direct-mode workers on PTM's resolved worker model(s) in their own git worktrees, all visible
   in `pi-delegate`'s transcript overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`). Direct-mode workers
   do not support steering. Explicit supervised runs and authenticated detached drivers use their
   documented steering routes. PTM can still cancel the direct request through its cancellation event.
4. Return a combined response so PTM can continue with its loop / chain /
   compare flow.

### How the bridge picks who handles a request

`pi-delegate` and the legacy `subagent` extension can both answer PTM
events. The `ptmBridge.handleRequests` config controls which one wins:

- `auto` (default): `pi-delegate` listens iff
  `~/.pi/agent/extensions/subagent/agents.{ts,js}` does **not** exist.
  Install `pi-delegate` over the legacy ext by uninstalling `subagent`.
- `always`: `pi-delegate` always answers. Use when both are installed but
  you want `pi-delegate`'s overlay / steering / dispatch.
- `never`: don't touch PTM events. Use to roll back without uninstalling.

When the bridge is active, it sets `PI_SUBAGENT_RUNTIME_ROOT` so PTM's
`discoverAgents` lookup imports `pi-delegate`'s agent registry (no
filesystem games). If you've already exported that env-var manually, the
bridge respects your value.

### Model and context compatibility

- PTM's resolved `model` now drives the worker that `pi-delegate` starts.
  In parallel requests, `tasks[i].model` overrides the request-level
  `model` for that slot.
- PTM model selection is applied as an invocation-scoped clone of the
  agent config. Durable agent files are not mutated.
- Because PTM sends an explicit model and does not describe a fallback
  policy, an unresolvable PTM model fails clearly instead of silently
  falling back to the agent's durable model or the foreground session
  model.
- PTM v1 response fields (`context`, `model`, `messages`,
  `parallelResults`, etc.) are preserved. Additional optional provenance
  fields report requested vs. actual model (`requestedModel`,
  `actualModel`, `attemptedModels`, `modelFallback`) and requested vs.
  effective context (`requestedContext`, `effectiveContext`,
  `contextWarning`).
- `inheritContext: true` arrives from PTM as `context: "fork"`. The Phase 1
  bridge does **not** scrape or serialize the parent session and does not
  silently run the request with fresh context. It rejects the request before
  agent discovery and delegate execution with an actionable compatibility
  error. Responses preserve `requestedContext: "fork"` while omitting
  `effectiveContext` because no worker ran. Bounded producer context seeds are
  deferred to a trusted-producer/focused P1 follow-up.
- The bridge is installed on Pi `session_start` with the live
  `ExtensionContext` and disposed on `session_shutdown`; PTM request cwd is
  passed separately to direct execution, so model registry/auth/session
  lifecycle hooks remain the real Pi context rather than a fabricated stub.

### Phase 1 limits (current shipping behaviour)

- Direct-mode only for supported PTM requests — no supervisor-fork loop yet.
  Each `context: "fresh"` request runs one worker (or N parallel workers)
  without an inner review-and-iterate layer. `context: "fork"` is rejected
  until a bounded parent-context seed contract is implemented.
- Parallel cap is 6. `bestOfN` lineups with > 6 slots fail with a clear
  error; chunking is planned.
- Live progress widget (PTM's above-editor card) shows "running…" but no
  per-tool / token detail. The transcript overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`) has
  the full picture.
- Loop convergence works for `write` / `edit` tool calls (synthesized
  from worker transcript) but not for other tools.

`docs/ptm-support.md` is the support contract: the full matrix of which PTM
fields, protocol versions, and request shapes are accepted or rejected, with
the exact refusal messages. Read it to answer "will my template work?".
`docs/prompt-template-bridge.md` is the design document behind it — rationale,
architecture, and roadmap.

## Replacing pi-subagents

`pi-delegate` is intended to cover the common `pi-subagents` workflows while
adding supervised review-and-iterate forks. Most prompts, skills, and slash
invocations port over with no edits other than the tool name (`subagent` →
`delegate`), but this is not a blanket claim that every pi-subagents field is
accepted or has identical semantics. The caveats below summarize the remaining
follow-up gaps.

### Parameter mapping

Every ordinary `delegate` run shape dispatches in the background by default.
Where an existing pi-subagents caller depends on receiving the final result
before its next action, add `await: true`; changing only the tool name changes
the delivery timing.

| pi-subagents shape                       | pi-delegate equivalent                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `subagent({agent, task})`                | `delegate({runs: [{agent, task}], await: true})` to preserve foreground return; omit `await` for background |
| `subagent({tasks: [...]})`               | `delegate({runs: [...], await: true})` to preserve foreground return; omit `await` for background |
| `subagent({chain: [...]})`               | `delegate({runs: [...], await: true})` with `after: "previous"` on each ordered entry; omit `await` for background |
| `subagent({chain: "saved-chain"})`       | `delegate({chain: "saved-chain", await: true})` to preserve foreground return |
| `subagent({action: "list"})`             | `delegate({action: "list"})`                                                 |
| `subagent({action: "create", config:…})` | `delegate({action: "create", config:…})`                                     |
| `subagent({context: "fresh"})` (default) | `delegate({…})` (direct workers/chain steps seed fresh by default)                  |
| `subagent({context: "fork"})`            | follow-up: direct-worker `seed_from: "branch"` is not implemented |
| `subagent({async: true})`                | `delegate({…})` already dispatches by default; use `delegate({await: false})` when the intent should be explicit |
| `subagent({clarify: true})`              | follow-up: no agent-manager / chain-clarify TUI in pi-delegate yet           |
| `subagent({share: true})`                | follow-up: session sharing is not implemented                                |

### Slash command mapping

pi-delegate does not register pi-subagents slash aliases. Use `/delegate TASK --agent NAME` for one worker, `/delegate TASK --chain NAME` for a saved chain, `/delegate --agents` for discovery, and `/delegate-inspector` for status and transcripts. Use the `delegate` tool API for inline chains and parallel workers.

### Co-installation

Both extensions can run side by side. pi-delegate owns only `/delegate`, `/delegate-cancel`, `/delegate-inspector`, and `/delegate-help`; pi-subagents keeps its own slash names. The `delegate` tool name is also distinct. Each extension has its own runtime registry, so their inspection surfaces show different work.

### Invocation-scoped worker overrides

Worker-slot overrides are intentionally invocation-scoped. `model`, `thinking`,
`fallbackModels`, and `skill`/`skills` apply to the effective worker
`AgentConfig` for only the call/entry where they appear; `skill:false` disables
injected skills for that worker invocation. These fields are supported on every
run entry and on saved chain steps.

For supervised runs, this is **worker-only**: the fork-clone supervisor remains
a clone of the main agent and still uses `clone_mode`, `rounds`,
`supervisor_instructions`, and `summary_model` for the supervision/collapse
loop. If you need a different supervisor model, that is a separate follow-up
design, not the current worker override surface.

The detached driver mode is separate from worker-slot overrides.
The legacy `orchestrate.model` transport field is supported for the hosted driver
process, while `orchestrate.thinking` is deliberately deferred and should not be
passed expecting an effect.

### Remaining follow-up gaps

Do not treat these pi-subagents fields/shapes as drop-in parity yet:

- Direct-worker `context:"fork"` / `seed_from:"branch"` support. Slash `--fork` instead selects supervised execution.
- Dynamic chain fan-out (`expand`/`collect`) and strict `outputSchema` contracts.
- Per-call `acceptance` contracts, review/repair loops, `outputMode`, and structured verification metadata.
- Foreground `timeoutMs` / `maxRuntimeMs` aliases and the `async:true` alias (`delegate` already runs in the background by default; use `await:false` to be explicit).
- `share`, `sessionDir`, `artifacts`, `clarify`, `includeProgress`, and subagent-specific control telemetry knobs.
- Exact `interrupt` / `resume` / `doctor` action compatibility aliases.
- Chain-parallel automatic `worktree:true` parity beyond the currently supported direct/parallel worktree paths.

### Known semantic differences

- **Supervised forks vs subprocess isolation**. pi-delegate runs every
  worker in-process (`AgentSession`), inheriting the parent's process
  state. pi-subagents spawns a `pi` subprocess. In practice this matters
  only if your agent installs/modifies the global Node module cache, mucks
  with `process.env`, or relies on subprocess-level signal handling.
- **mcpDirectTools**. The `tools: mcp:foo` syntax is parsed but the in-
  process API can't host an MCP server. Both supervised and direct mode
  emit a one-time warning when an agent declares mcpDirectTools and skip
  them. Use `extensions:` instead.
- **Direct-worker branch seeding**. Direct workers and chain steps still start fresh.
  `/delegate --fork` selects supervised execution; it does not seed a direct
  worker from the caller's branch.

## Management actions

`delegate({action: ...})` reads and writes agent / chain definition files
on disk without spawning any worker. Mirrors the pi-subagents surface.
Inside delegate-owned nested workers, mutation actions (`create`, `update`,
`delete`) are denied; only read-only management actions remain available.

For foreground management input, `config` list fields use arrays or `false`; on create, `false` leaves a list field absent, and on update, it clears an existing field. CSV strings such as `tools: "read, bash"` are rejected. This does not change on-disk frontmatter parsing: existing agent files with comma-separated `tools`, `skills`, or other list fields remain readable.

`delegate({action: "health"})` or `/delegate --health`
is the read-only operator surface: active/completed **in-process** run counts,
separate active/terminal detached-driver counts, on-disk
substrate sizes (`run-state.json`, `orchestrate/`, `event-bus/`), pending
dispatch wakes / driver results, stale two-phase claims, and the
maintenance-timer status. Use it to spot bloat before it bites.

### Periodic maintenance

Foreground sessions arm an unref'd ~45s interval (never in spawned child
processes, never keeps the event loop alive). Each tick first reconciles any
route-backed detached driver runner whose process identity disappeared
before writing a terminal record, then re-runs the two pending delivery legs —
driver results finished while the parent stayed alive, and dispatch wakes
dropped across a session replacement — so recovery no longer waits for the
next `session_start`.

Abrupt-runner reconciliation uses an owner-only, stale-recoverable per-run
claim. A run with a complete secret-safe launch record may start one replacement
runner, retaining the run ID and authenticated control route. Invocation or
agent environment overrides are never persisted, so those runs fail closed
instead of replaying without their original transport. Replacement after the
`running` phase is whole-attempt replay: task side effects completed before the
crash may run again. It is not mid-turn session resumption.

If replacement is unavailable or also exits, the first reconciler atomically
persists a categorical `runner-exited` failure, publishes it through the normal
pending-result outbox, and removes the secret-bearing route plus active marker.
A prepared-payload phase lets another foreground resume after a reconciler
crash without double-terminalizing or manufacturing a second logical pending
enqueue after publication. Persisted diagnostics contain only bounded
categories/scalars (last whitelisted phase/activity, PID, stderr-capture
presence, and unknown exit/signal sentinels); prompts, control secrets, raw
stderr, and model output are never copied. `delegate_control(action="result", runId)` continues
to read the canonical result after pending delivery consumes the wake copy.

The delivery legs remain idempotent and claim-disciplined, so the timer adds
liveness rather than a polling requirement. The existing sink boundary remains
at-least-once: a process crash after `sendMessage()` acceptance but before
claim consumption can still cause a retry because the sink has no durable
receiver-side deduplication ID. Every ~20th tick (and once at
startup, after the startup deliveries) `sweepOldCompletedRuns` applies a 7-day
retention window to completed runs in `run-state.json` (owner-scoped: a live
sibling session's history is never touched).

```js
// List agents and chains across all scopes
delegate({ action: "list" })

// Get full detail (read-only)
delegate({ action: "get", agent: "scout" })
delegate({ action: "get", chain: "recon-plan" })

// Create a user-scope agent
delegate({
  action: "create",
  config: {
    name: "scout",
    description: "Recon helper",
    systemPrompt: "You are scout. Investigate and report.",
    model: "openai/gpt-5",
    tools: ["read", "bash"],
    skills: ["librarian"],
    scope: "user", // or "project" — defaults to "user"
  },
})

// Update — falsy values clear: `{model: false}` removes the model field.
delegate({
  action: "update",
  agent: "scout",
  config: { model: false, description: "Renamed scout" },
})

// Create a chain template
delegate({
  action: "create",
  config: {
    name: "recon-plan-implement",
    description: "Validated delivery pipeline",
    steps: [
      { agent: "scout", task: "scan {task}", artifact: "context.md" },
      { run: "verify-context", command: "node scripts/verify-context.mjs", timeoutMs: 10_000 },
      { chain: "review-context", task: "review {previous}" },
      { agent: "planner", task: "plan based on {previous}", reads: ["context.md"] },
      { agent: "worker", task: "implement {previous}" },
    ],
  },
})

// Then run it by name:
delegate({ chain: "recon-plan-implement", task: "fix the auth bug" })
```

Files land at:

- User scope: `~/.agents/<name>.md` and `~/.agents/<name>.chain.md`
- Project scope: `<repo>/.pi/agents/<name>.md` and `<repo>/.pi/agents/<name>.chain.md`

The format is YAML frontmatter followed by `## <agent>` sections for worker
steps. A composed step uses `## chain:<saved-chain-name>` and a task body; its
management shape is `{ chain: "saved-chain-name", task?: "..." }`. A native
command stage uses `## run:<label>`, requires `command`, and has no task body:

```md
## run:verify-context
command: node scripts/verify-context.mjs
cwd: tools
env: {"MODE":"strict"}
timeoutMs: 10000
```

The matching management shape is
`{ run: string, command: string, cwd?: string, env?: Record<string, string | null>, timeoutMs?: number }`.
The worker, reference, and run shapes are mutually exclusive. A run stage starts
no LLM. Its `cwd` resolves against the top-level chain working directory,
`timeoutMs` defaults to 60 seconds, and `env` uses the same protected-key
filtering as worker environment overrides. The command receives the absolute
shared chain directory — the `{chain_dir}` — in `PI_DELEGATE_CHAIN_DIR`; command
text does not expand `{task}`, `{previous}`, or `{chain_dir}`. This is the
chain's own coordination directory, distinct from each producer's private v2
artifact attempt. A run stage is not handed another step's retained snapshot
through this variable.

A successful run stage leaves the scoped `{previous}` value unchanged. A
non-zero exit, timeout, cancellation, invalid configuration, unavailable `cwd`,
or process-start failure halts the chain. Standard output and standard error are
sanitized and capped at 8 KiB each for diagnostics. Project-scoped run stages
require project trust. A confined nested caller cannot invoke a run stage because
its separate shell process cannot inherit the caller's write guard.

Saved-chain references resolve recursively with the same user/project scope
precedence as a top-level saved chain. The complete reference graph and every
run stage are preflighted before any worker starts and before a nested caller's
agent allow-list or write-confinement checks. A missing reference, cycle, or
invalid deterministic stage therefore starts no partial pipeline. Composition
expands into the root run: every worker and run stage shares one `chainDir`, and
a reference consumes no extra delegation depth.

Each reference opens a task scope. Its task is evaluated once at that boundary,
so `{task}` stays frozen for every step in the referenced chain. `{previous}` is
local to that chain, advances after each worker, stays unchanged across a
successful run stage, and returns its final value to the parent chain when the
reference completes.

## Fabric mode

When a compatible [pi-fabric](https://www.npmjs.com/package/pi-fabric) runtime
(provider protocol v1) is active in the session, pi-delegate registers itself
as the Fabric provider `delegate`. No manual adapter is needed, and pi-fabric
stays optional:
pi-delegate has no dependency on it. Fabric mode is tested in CI with npm
pi-fabric 0.96.4 on Pi 0.85.1; the CAAIR fork build is checked by hand. There
is no dev SDK bump: Pi 0.85.1 is installed only into the test copy of
pi-fabric. Inside `fabric_exec` the model dispatches with the same request the
native tool takes:

```ts
const receipt = await tools.call({ ref: "delegate.dispatch", args: { runs: [{ agent: "reviewer", mode: "supervised", task: "Review the patch." }] } });
const result = await tools.call({ ref: "delegate.harvest", args: { runId: receipt.runId } });
```

Fabric mode is selected only after Fabric's discovery handshake succeeds and
`fabric_exec` is active. The model then gets Fabric-mode instructions instead
of the native `delegate` guidance, and the native `delegate`,
`delegate_control` and `delegate_escalation` tools leave the active set while
staying registered. An installed but inactive Fabric, an unsupported protocol
version, or a failed registration changes nothing and keeps the native tools.
Delegate-only mode always keeps the native surface. See
[`docs/fabric-mode.md`](fabric-mode.md) for activation, lifecycle and host
limits, error codes, and the capability matrix.

## Event-bus channels

pi-delegate announces run lifecycle on Pi's in-process event bus (`pi.events`).
Another extension loaded into the same Pi process can subscribe to follow runs
without calling a tool. The bus does not cross a process boundary: RPC mode,
pi-daemon and session files do not carry these events.

Every channel is named `delegate:<kebab-case>`. Import the names from the
`./events` subpath instead of repeating the strings:

```ts
import { DELEGATE_EVENTS } from "@centerforagenticai/pi-delegate/events";

pi.events.on(DELEGATE_EVENTS.complete, ({ runId, finalResult }) => {
	// A run reached a terminal state.
});
```

`DELEGATE_EVENTS` lists every channel pi-delegate emits or listens to, with its
payload fields (a contract test keeps it complete). Payloads only
grow: ignore fields you do not know. A host that wants these events under its
own naming scheme should subscribe here and translate at its own boundary.

`delegate:complete` is also the `customType` of the completion wake message
that pi-delegate adds to the session. The two share a name but are separate
mechanisms.

**Deprecated names.** Earlier releases emitted three channels under different
names: `legacy.delegate.complete`, `legacy.delegate.guidance_delivered`, and
`legacy.delegate.worker_notify`. This release emits each of them right after
its canonical name (`delegate:complete`, `delegate:guidance-delivered`,
`delegate:worker-notify`), with the same payload object. The deprecated names
will be removed in the next minor release.

## Calling from a CLI process (no live pi session)

For Node CLIs that need to dispatch subagents but cannot rely on pi being
the host process, `pi-delegate` exports a free-standing
`delegateFromCli()` entrypoint:

```ts
import { delegateFromCli } from "@centerforagenticai/pi-delegate";

const result = await delegateFromCli({
  tasks: [{ name: "scout", agent: "scout", task: "Scan src/" }],
  cwd: process.cwd(),
});
console.log(result.combinedContent);
```

The entrypoint covers **solo runs only** (single + parallel) — supervised and
saved-chain dispatch stays pi-runtime-coupled because it needs the
slash-command overlay, transcript widget, and dispatch wake-up. Its `tasks`
field is this entrypoint's own input shape, not the `delegate` tool's `runs[]`
grammar. Sync-only return shape with per-run status, output, optional graft
commit-SHA trailer extraction, and AbortSignal cancellation.

See [`docs/cli-delegate.md`](cli-delegate.md) for the full API
reference, security notes (project-trust auto-accept), and a migration
example for downstream consumers.

## Caveats / known limitations

- The fork-clone model must exist in your `ModelRegistry` (`ctx.model`). If
  your main model has no configured auth, fork-clone creation fails.
- `clone_mode: "full"` dumps the entire main-thread history into the
  fork-clone — watch costs if the main thread is huge. Use `"snippet"` or
  `"task_only"` for cheap delegations.
- Worker sessions are stored under `~/.pi/agent/sessions/forks/` — a
  discoverable subdir of the main sessions dir (so host/session readers that
  scan `sessions/` can resolve a `workerSessionFile`), kept out of your main
  `/resume` picker (which lists per-cwd sessions) to avoid clutter. Open them
  with `pi --session <path>` or by copying their path.
- Outside the opt-in escalation native prompt and existing overlay controls,
  there is no general mid-fork user-driven supervisor UI. The main agent still
  drives the fork; a `supervisor: "user"` mode is not implemented.
- `completionNotifyStrategy: "synthetic-tool-pair"` is reserved for a future
  pi release that exposes `appendMessage` to extensions. Setting it today
  logs a warning and falls back to `custom-message`.

### Durable worker origin

New direct and supervised worker sessions persist a `delegate.worker-origin`
custom entry before their first turn when both the owning session ID and run ID
are available. Its version-1 data contains `ownerSessionId`, `runId`, `forkName`,
and `agent`. These are exact producer identifiers; nested dispatches refer to
the invoking coordinator. The entry survives operational run-history pruning
because it belongs to the worker transcript. Workers without dispatch identity
omit it; no parent is inferred. Existing transcripts are not backfilled.

Consumers may read this generic record and project their own application
metadata. Application-specific entries and task previews remain consumer-owned.

## Event name reference

Import `DELEGATE_EVENTS` instead of copying these strings. The object contains every current channel:

| Event | Meaning |
| --- | --- |
| `delegate:register` | A run registered or changed its registration. |
| `delegate:registration-revoked` | A run's registration was withdrawn. |
| `delegate:update` | One run entry changed state. |
| `delegate:transcript-append` | A run entry received another transcript entry. |
| `delegate:activity-status` | A run entry's bounded activity line changed. |
| `delegate:prompt-pending` | A worker question is waiting for an answer. |
| `delegate:prompt-resolved` | A pending worker question was answered or withdrawn. |
| `delegate:guidance-queued` | Guidance entered a worker's queue. |
| `delegate:guidance-drained` | A worker took queued guidance. |
| `delegate:guidance-delivered` | Queued guidance reached the worker's transcript. |
| `delegate:worker-notify` | A worker called `ctx.ui.notify`. |
| `delegate:complete` | A run reached a terminal state. |
| `delegate:sync-orphan-recovery-surfaced` | An interrupted synchronous run surfaced recovery information. |
| `delegate:reveal-control-tools` | Another extension asked pi-delegate to reveal lazy control tools. |
