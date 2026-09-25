# pi-delegate ⇆ pi-prompt-template-model bridge

Design doc for letting `pi-delegate` serve as a delegation backend for
[`pi-prompt-template-model`](https://github.com/nicobailon/pi-prompt-template-model)
(hereafter **PTM**) without restructuring either extension's core.

Status: **Phase 1 shipped** with a few remaining roadmap items. Companion to `subagent-parity-plan.md`.

> **Looking for what actually works?** This is the design document — rationale,
> architecture, and roadmap, including phases that have not shipped. The
> support contract lives in `ptm-support.md`: which PTM fields, protocol
> versions, and request shapes are accepted or rejected, with the exact
> refusal messages. Start there unless you are changing the bridge itself.

---

## 1. Why

PTM is a frontmatter-driven slash-command runner: it parses `model`, `skill`,
`thinking`, `loop`, `chain`, `bestOfN`, `subagent`, `inheritContext`,
`parallel`, deterministic shell steps, etc. on `.md` prompt templates and
orchestrates the right execution flow. It already has a clean event-bus seam
for handing the actual work off to a separate runtime.

`pi-delegate` is a forked-supervisor runtime: it makes the main agent fork a
copy of itself into a private session that drives a worker through
`message_subagent` ↔ `finish_delegation` rounds, with a live overlay,
steering, dispatch mode, and worktree isolation.

The two extensions are **almost orthogonal**: PTM is a prompt-template
language, `pi-delegate` is an execution runtime. Today PTM only knows how to
hand work to the legacy `subagent` extension (`~/.pi/agent/extensions/subagent`,
fire-and-forget), so any prompt template that uses `subagent: true` /
`inheritContext: true` / `parallel: N` / `bestOfN` loses out on
`pi-delegate`'s overlay, steering, supervisor-fork pattern, and dispatch.

The bridge closes that gap by registering `pi-delegate` as an additional
listener for PTM's request events and translating each request into
`pi-delegate` direct execution.

### What this is *not*

This proposal does **not**:

- Move loop / chain / best-of-N / `<if-model>` / deterministic-step
  orchestration into `pi-delegate`. Those stay in PTM. They are
  template-language concerns and have no business inside the runtime.
- Pull frontmatter parsing into `pi-delegate`'s critical path. Phase 3
  optionally shares the parser, but the runtime never depends on PTM at
  load time.
- Change `pi-delegate`'s tool surface or supervisor-fork semantics. The
  bridge is purely additive.

### Goals

1. Any PTM template that delegates (`subagent:`, `parallel:`, `bestOfN:`)
   transparently runs through `pi-delegate` when both extensions are
   installed, with no template-author changes required.
2. The bridge is **opt-in at install time** but **transparent at use time**.
   Users never have to reach for it explicitly; templates Just Work.
3. PTM receives compatible `started` / `response` events in Phase 1; later
   phases can translate per-worker status snapshots into PTM's
   `DelegatedSubagentUpdate` shape.
4. If both `pi-delegate` and the legacy `subagent` extension are installed,
   exactly one answers each PTM request — no double-execution.
5. PTM-less users see zero behavioural change. The bridge is dormant when
   PTM isn't present.

### Non-goals (now)

- Rewriting PTM's event schema. We adopt it as-is.
- Sharing TypeBox schemas across packages. `pi-delegate` keeps owning its
  own.
- Bidirectional steering from PTM into `pi-delegate` mid-run. PTM doesn't
  expose a steer surface today. Phase 1 runs direct-mode workers, which do not
  support `delegate_control` action `steer`; PTM can cancel an in-flight request, while
  supervised `pi-delegate` workers can be steered from the overlay
  (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`).

### Eventual success criterion

A user with both extensions installed runs:

```yaml
---
model: claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
parallel: 3
worktree: true
---
Audit the diff: $@
```

…and gets three direct-mode workers running in worktrees, visible in
`pi-delegate`'s overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`). Direct-mode
workers do not support `delegate_control` action `steer`; PTM cancellation remains available. In
Phase 1, PTM's above-editor progress widget receives `started` and final
`response` events; live elapsed/token/tool updates are a later phase. When the run
completes, PTM receives a single `DelegatedSubagentResponse` and continues
template execution (e.g. enters the next chain step or the next loop
iteration). At no point does the user edit a config file or learn a new
flag.

---

## 2. PTM's existing event protocol

PTM dispatches every delegated task through five `pi.events` channels.
These are stable identifiers exported from `subagent-runtime.ts`:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `prompt-template:subagent:request` | PTM → backend | One delegated task or parallel batch |
| `prompt-template:subagent:started` | backend → PTM | Acknowledge receipt + show widget |
| `prompt-template:subagent:update` | backend → PTM | Live progress (currentTool, tokens, taskProgress) |
| `prompt-template:subagent:response` | backend → PTM | Final result |
| `prompt-template:subagent:cancel` | PTM → backend | User aborted; abort in-flight runs |

The `prompt-template:subagent:started` acknowledgement is additive and carries
the backend identity and progress-surface ownership:

```ts
{
  requestId: string,
  backend: "pi-delegate",
  ownsProgress: true,
}
```

Both new fields are optional for compatibility with older backends. A consumer
must treat a missing `ownsProgress` field as `false` (no ownership claim), not
as an implicit claim. Older PTM front ends ignore the unknown fields.

For an accepted request, `ownsProgress` is true only when the delegate status
widget can mount; the PTM bridge then runs through `executeDirectShape`, which
registers the run in pi-delegate's shared runtime store that the widget renders.
Malformed requests emit `ownsProgress: false` because they register no run and
there is no delegate progress for the backend to draw.

Delegation requests support the legacy unversioned shape and the
pi-subagents v1 shape. Both carry the selected agent name and ordered skill
names. Neither contract requires the bridge to expose an `agents.ts` module or
participate in PTM's prompt discovery. The bridge still validates requested
agent names against pi-delegate's injected discovery function before starting
direct workers.

The name `protocolVersion` also appears in PTM prompt lifecycle and invoke
events. Those events have their own protocols and field ownership; their
`protocolVersion` values are not delegation-request markers. Retiring the
removed delegation request path does not change either event protocol.

### Request shape (relevant fields)

```ts
interface DelegatedSubagentRequest {
  version?: 1;                       // v1 single requests may opt in
  requestId: string;
  agent: string;                    // agent definition name
  task: string;                     // rendered prompt body
  tasks?: DelegatedSubagentTask[];  // present iff parallel > 1
  context: "fresh" | "fork";        // fresh runs; fork is fail-closed until bounded seeding
  model: string;                    // resolved provider/model-id
  skill?: string[];                 // ordered names; single requests only
  cwd: string;                      // absolute working directory
  worktree?: boolean;
}
```

Parallel tasks share the same `requestId`. Each entry in `tasks[]` has its
own `agent` + `task` + optional `model`/`skill`/`cwd`, so the bridge can run
heterogeneous fan-outs (e.g. `bestOfN.workers` with mixed models). `skill`
is an ordered array of non-empty names. Upstream v1 parallel requests omit
`version` and carry skills only on their task entries. Parallel requests remain
unversioned and return the legacy parallel response.

### Response shape

```ts
interface DelegatedSubagentResponse {
  requestId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  model: string;
  cwd: string;
  messages: Message[];                              // worker transcript
  parallelResults?: DelegatedSubagentParallelResult[];
  contentText?: string;                             // collapsed final text
  isError: boolean;
  errorText?: string;
  requestedContext?: "fresh" | "fork";
  effectiveContext?: "fresh";                    // omitted when fork is rejected
  contextWarning?: string;
}
```

A versioned single request may instead receive the pi-subagents v1 response:

```ts
interface SubagentDelegationV1Response {
  version: 1;
  requestId: string;
  status: string;             // "completed" or a failure status
  error?: string;
  agent?: string;
  model?: string;
  output?: string;
  effects?: { fileMutation?: {
    status?: string;
    expected?: boolean;
    attempted?: boolean;
  } };
}
```

Unversioned single requests keep the legacy response above. Parallel requests
also keep the legacy response because v1 has no per-task result representation.
The checked-in fixtures under `tests/fixtures/ptm/` cover the v1 single
request/response pair and legacy single/parallel request/response pairs.

For successful fresh requests, `messages` is the AI-SDK `Message[]` from the
worker session — PTM uses it for chain context summaries (`chainContext:
summary`). A rejected legacy-context response has no worker transcript and returns an
empty `messages` array. If bounded parent-context seeding is added later, the
bridge must still surface the *worker* transcript, not a fork-clone
supervisor's transcript.

### Update shape

```ts
interface DelegatedSubagentUpdate {
  requestId: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
  taskProgress?: DelegatedSubagentTaskProgress[];   // per-worker in parallel
}
```

`pi-delegate`'s `status-widget.ts` already collects most of this from each
worker's session (tool count, recent tool, elapsed). The bridge maps
those snapshots into this shape.

---

## 3. Architecture

```
                 ┌──────────────────────────────────────┐
                 │ PTM template (.md frontmatter)       │
                 │   subagent: reviewer                 │
                 │   inheritContext: true               │
                 │   parallel: 3                        │
                 │   worktree: true                     │
                 └──────────────────┬───────────────────┘
                                    │ requestDelegatedRun()
                                    ▼
                 pi.events.emit("prompt-template:subagent:request",
                   { requestId, agent, tasks?, context, model, cwd, worktree })
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     legacy subagent ext     pi-delegate bridge      (no listener)
       (if installed)        (if installed)              ↓
              │                     │                  timeout
              ▼                     ▼                  → PTM error
     fire-and-forget         executeDirectShape()
     subagent runtime          (sync direct workers)
                                    │
                         worker AgentSession(s)
                         (overlay/status visible)
                                    │
                                    ▼
                pi.events.emit("prompt-template:subagent:response",
                   { requestId, messages, isError, ... })
                                    │
                                    ▼
                          PTM continues template
                          (next chain step / loop / etc.)
```

The bridge lives entirely inside `pi-delegate` as one new module
(`src/ptm-bridge.ts`) plus a small registration block in `src/index.ts`.
PTM does not change.

### 3.1 Single-listener guarantee

If both `pi-delegate` and the legacy `subagent` extension are installed,
both will receive the same request. We need exactly one to answer.

Strategy:

1. The bridge exposes a config flag `ptmBridge.handleRequests` (default
   `"auto"`). Values:
   - `"auto"` — listen iff the legacy subagent extension is **not** loaded.
   - `"always"` — listen unconditionally (user explicitly prefers
     `pi-delegate`).
   - `"never"` — disable the bridge entirely.
2. Detection: at `session_start`, the bridge checks
   `pi.getExtensions?.()` (or the equivalent SDK lookup) for an extension
   whose source path resolves under `.../extensions/subagent`. If found,
   `auto` → don't listen.
3. The legacy extension is detected by path, not by event subscription
   count, because pi's event bus doesn't expose listener counts cheaply.
4. Documented escape hatch: `ptmBridge.handleRequests: "always"` lets the
   user explicitly prefer `pi-delegate` even when both are installed.

Edge case — both listen anyway (misconfiguration): both will run the same
delegate. Only the first response wins on PTM's side (it `finish()`es on
first matching `requestId`); the second emits to a stale listener and is
dropped. The bridge does not currently detect that duplicate response; the
risk remains tracked below.

### 3.2 Agent validation and runtime compatibility

PTM selects the prompt-template agent name and resolves requested skills
before emitting the event request. Upstream v1 sends ordered names. The bridge
therefore does not claim or require an `agents.ts` import contract from PTM. It
validates each requested agent through its injected pi-delegate discovery
function immediately before direct execution. This keeps the bridge's worker
mapping independent of PTM's prompt-loader implementation.

`PI_SUBAGENT_RUNTIME_ROOT` remains a compatibility hook for older PTM
installations that still look for a subagent-shaped runtime. The bridge sets
it only while active and never overwrites a value supplied by the user.

Gating mirrors §3.1 (`handleRequests: "auto" | "always" | "never"`):

- `auto` (default): set the var iff PTM appears loaded **and**
  `~/.pi/agent/extensions/subagent/agents.{ts,js}` does **not** exist
  (legacy ext absent).
- `always`: set the var unconditionally — pi-delegate always wins.
- `never`: do not set the var; do not subscribe to any PTM events.

If `PI_SUBAGENT_RUNTIME_ROOT` is already set externally (user exported it
in their shell), we respect that value and don't overwrite.

**Symlink + upstream-PR fallbacks (Options A/B in the original draft) are
deprecated** by the env-var path. Filesystem-level fixes are no longer
required.

### 3.3 Translation layer

Per-request mapping from PTM → `pi-delegate` direct execution:

| PTM field | `executeDirectShape` input | Notes |
| --- | --- | --- |
| `request.agent` (single-task) | `tasks[0].agent` | Direct passthrough after agent discovery |
| `request.tasks[i].agent` (parallel) | `tasks[i].agent` | One direct worker per task |
| `request.task` / `tasks[i].task` | `tasks[i].task` | PTM has already rendered `$@`/`$1`/etc.; bridge forwards the task text verbatim |
| `request.context: "fresh"` | fresh direct worker | Worker sees only the rendered task |
| `request.context: "fork"` | rejected before direct execution | Phase 1 does not support parent-context seeding; the bridge returns an actionable compatibility error instead of silently running a fresh worker |
| `request.model` | cloned `AgentConfig.model` | Request-level model drives the worker |
| `request.skill` (versioned single) | cloned `AgentConfig.skills` | Ordered non-empty names are applied to that invocation only |
| `request.tasks[i].model` | cloned `AgentConfig.model` for that slot | Task-level model overrides request-level model |
| `request.tasks[i].skill` | cloned `AgentConfig.skills` for that slot | Each task receives only its own ordered skill names; no sibling leakage |
| `request.cwd` / `tasks[i].cwd` | request-scoped execution cwd / task cwd | The live `ExtensionContext` is still passed through; cwd is an execution override. The bridge validates PTM's promised cwd values with `node:path.isAbsolute`; task cwd equal to request cwd is omitted so `worktree:true` batches do not trip per-task-cwd incompatibility. |
| `request.worktree` | top-level `worktree: true` | Same direct-worker worktree semantics |
| `tasks[].length > 1` | one entry per task in `tasks[]` | Cap at 6 — see 3.5 |
| _(synthetic)_ | `sync: true` | Bridge always runs sync; PTM expects a single response |
| _(synthetic)_ | `mainModel: null` | Explicit PTM model must not silently fall back to the foreground session model |
| _(synthetic)_ | `name: tasks[i].agent + "#" + i` | Disambiguate slot labels in overlay |

PTM's `bestOfN.workers/reviewers/finalApplier` is *not* a single request —
PTM itself orchestrates each phase as a separate `request`/`response`
round-trip, so the bridge sees them as ordinary parallel batches and
doesn't need to know about the compare flow.

Model behavior is invocation-scoped: the bridge clones the discovered
`AgentConfig`, applies PTM's resolved model to that clone, and leaves the
durable agent definition unchanged. Because PTM supplies an explicit model
without a fallback policy, the bridge clears agent fallbacks and calls direct
execution with `mainModel: null`; an unresolvable PTM model fails clearly
instead of silently running on the durable agent model or the foreground
session model.

Responses preserve legacy PTM fields (`context`, `model`, `messages`,
`parallelResults`, etc.) and add optional provenance fields that existing
consumers ignore: `requestedModel`, `actualModel`, `attemptedModels`,
`modelFallback`, `requestedContext`, `effectiveContext`, and
`contextWarning`. A `version: 1` single request receives the upstream v1 shape
(`version`, `status`, `output`, and optional `error`/`effects`); its `model`
field remains the PTM-requested model while bridge provenance stays in the
optional fields. Unversioned single requests and every parallel request keep
the legacy shape, including `parallelResults` for parallel work.

The validator accepts legacy unversioned single and parallel requests, and
exactly `version: 1` for a single request. Any defined top-level
`protocolVersion` is rejected before legacy parsing, including the retired
value `2`; it cannot select a delegation shape or fall through to execution.
The refusal names the two supported shapes: legacy unversioned
single/parallel requests and `version: 1` single requests. Retired behavior
fields such as `fallbackModels`, `thinking`, `skills`, `contextSeed`,
`compatibility`, and `capabilities` also fail closed. Versioned v1 uses an
explicit top-level field allowlist so unknown behavior cannot be silently
discarded; malformed `worktree` values and versioned-v1 parallel requests are
rejected. These checks, unknown versions, and every `context: "fork"` request
fail before agent discovery or worker execution.
For a `context: "fork"` request in Phase 1, the bridge rejects before agent
discovery and delegate execution. The response keeps legacy `context: "fork"`
and reports `requestedContext: "fork"`, but omits `effectiveContext` because
no worker ran. `errorText` carries the actionable compatibility error;
`contextWarning` is omitted to avoid duplication.

### 3.4 `inheritContext: true` semantics — fail-closed until bounded seeding

PTM's `context: "fork"` (produced by `inheritContext: true`) means "the
subagent should see the conversation". The bridge does not currently have a
safe, bounded parent-context snapshot to seed into a worker. There are three
plausible future mappings:

1. **Direct-mode worker** (`pi-delegate`'s `executeDirectShape` path) —
   spawn one worker `AgentSession`, run the agent's full tool loop, return
   the worker's final text. No supervisor, no review loop. This is what
   the legacy `subagent` extension does, and it's what PTM template
   authors actually expect today.
2. **Forked-supervisor (`clone_mode: "full"`)** — fork the *main agent's*
   thread to seed a *fork-clone supervisor* that drives the worker through
   `message_subagent` ↔ `finish_delegation` rounds. Adds an extra LLM in
   the loop; useful for review-and-iterate, overkill for "just run this
   task".
3. **Worker-side seeding** — copy the parent thread directly onto the
   worker's session messages. PTM's documented behaviour today, but
   semantically a bit muddled because the worker's system prompt may not
   match the seeded thread's structure.

**Phase 1 supports `context: "fresh"` only.** Fresh requests map to
`executeDirectShape({ sync: true })`. A `context: "fork"` request is rejected
before agent discovery and before `runDelegate` so it cannot accidentally
execute with fresh context while claiming that the parent conversation was
available. The compatibility error directs callers to `context: "fresh"`.
When UI is available, the bridge emits that rejection once per bridge handle.

The safe follow-up requires a producer-owned, explicitly labelled and bounded
parent-context snapshot (with a token/size limit and truncation semantics).
The bridge must consume that package as an explicit input; it must not scrape
Pi session internals or copy an unbounded transcript by default. Once that
bounded-seed contract exists, a future implementation can choose worker-side
seeding or an explicitly requested supervisor clone and report the resulting
effective context separately.

**Phase 5+ (deferred): supervisor-fork as opt-in.** A future PTM
frontmatter knob like `runtime: supervised` (or runtime override
`--runtime=supervised`) routes through `pumpForks` instead of
`pumpDirectWorkers` to get the multi-turn review loop. Out of scope for
the MVP — adds latency + cost + behavioural surprise without a clear
demand signal yet.

### 3.5 Parallel cap

`pi-delegate`'s public delegation surfaces are capped at 6 entries. PTM's
`parallel` field accepts ≥ 2 with no explicit upper bound; `bestOfN`
lineups can also exceed 6 when slots use `count: N`.

Phase 1 intentionally preserves the cap: if `tasks.length <= 6`, the bridge
forwards the batch as one direct execution call; if `tasks.length > 6`, it
fails with a clear `PTM bridge phase 1: parallel cap is 6` error. Chunking
is still future work because PTM's result ordering and progress semantics
need to remain explicit.

### 3.6 Update emission

Phase 1 emits `started` and final `response` events only. PTM's widget can
show that a run is active, while detailed activity remains available through
`pi-delegate`'s transcript overlay. A later phase can add a timer that polls
each direct worker's status snapshot and emits `prompt-template:subagent:update`.
Future mapping:

| PTM field | Source in `pi-delegate` |
| --- | --- |
| `currentTool` / `currentToolArgs` | Latest worker tool call from `worker-channel.ts` per-worker stream |
| `recentOutput` / `recentOutputLines` | Worker's last assistant text (truncated to ~500 chars / 8 lines) |
| `recentTools[]` | Last 5 worker tool calls |
| `model` | The worker's resolved model |
| `toolCount` | Cumulative worker tool count |
| `durationMs` | `Date.now() - entry.startedAt` |
| `tokens` | Sum of `usage.totalTokens` from worker session |
| `taskProgress[].status` | `"pending" \| "running..." \| "completed" \| "failed"` per worker |

Because Phase 1 is direct-mode only, there is no supervisor turn in this
path. Future supervised mode will need to define how supervisor activity
appears in PTM's widget.

### 3.7 Cancellation

PTM emits `prompt-template:subagent:cancel` with `{ requestId }` when the
user aborts a template (Ctrl+C, `/cancel`, etc.). The bridge keeps a
`Map<ptmRequestId, AbortController>` for in-flight direct executions; cancel
aborts the matching signal and direct execution unwinds through the normal
error response path.

---

## 4. Module layout

Phase 1 code lives in `src/ptm-bridge.ts` and the session lifecycle wiring
in `src/index.ts`.

```
src/
├── ptm-bridge.ts          ← event validation, context/model mapping,
│                             cancellation, response translation
└── index.ts                ← installs the bridge on session_start with the
                              live ExtensionContext and disposes it on shutdown
```

Tests:

```
tests/
├── unit/ptm-bridge.test.ts             — validation, translation, gating,
│                                         context/model mapping, cancel signal
└── integration/ptm-bridge-direct.test.ts — bridge + real executeDirectShape
                                          with mock providers
```

Config addition to `config.json`:

```json
{
  "ptmBridge": {
    "handleRequests": "auto"
  }
}
```

The optional `handleRequests` values are `auto`, `always`, and `never`.

### 4.1 Wiring in `index.ts`

`index.ts` installs the bridge inside `session_start` with the live
`ExtensionContext`, after the other session-scoped handles are refreshed. It
disposes the prior bridge before replacement and disposes the active bridge
again on `session_shutdown`. This is deliberate: direct execution needs the
real `modelRegistry`, auth storage, UI hooks, and session manager from Pi;
PTM request cwd is passed separately as `ctxCwd` rather than by fabricating a
partial context object.

The bridge has zero static imports of PTM — it only listens for string
event channels, so dropping PTM doesn't break the bundle.

---

## 5. Phasing

**Phase 1 — minimum viable bridge.** Listens for `request`, routes to
`executeDirectShape({ sync: true })` (direct mode, no supervisor),
emits `started` + `response`. Accepts legacy and PTM v1 requests, translates
ordered skill names to invocation-local worker overrides, and sets
`PI_SUBAGENT_RUNTIME_ROOT` only for older PTM runtime lookup. Cancel works via abort signal +
`response { isError: true, errorText: "cancelled" }`. No update events
yet. No worktree chunking beyond the 6-cap. `messages[]` is a synthesized
2-message array (`user` + `assistant`) with worker `write`/`edit`
toolCalls reconstructed from the transcript so PTM's loop-convergence
detection still works (lossy but functional).

  Exit: A user with both extensions installed flips a PTM template from
  legacy subagent to `pi-delegate` (transparently, just by removing the
  legacy ext or setting `handleRequests: "always"`) and the run completes
  correctly with `pi-delegate`'s overlay + the `delegate-status` /
  `delegate-cancel` tools working. PTM widget shows "running…" but no
  per-tool detail yet.

**Phase 2 — live updates.** Adds the polling timer that translates run
status snapshots into `update` events. PTM's widget now shows
currentTool / tokens / elapsed live.

  Exit: Visual parity between PTM widget and the legacy subagent ext on a
  same-task A/B comparison.

**Phase 3 — chunking beyond 6.** Heterogeneous `tasks[]` with mixed
agents/models/cwds are supported in Phase 1. Remaining Phase 3 work is
chunking requests with > 6 tasks while preserving PTM result ordering and
progress semantics.

  Exit: A `bestOfN` template with 8 mixed workers runs end-to-end through
  the bridge with no manual chunking.

**Phase 4 (optional) — shared frontmatter parser.** Lift PTM's
`prompt-loader.ts` parsing rules into `pi-delegate`'s `agents.ts` so a
single `.md` file can serve as both a PTM slash command and a
`pi-delegate` agent definition. Adds a `kind: "prompt-template" | "agent"`
discriminator if needed. Strictly additive; existing agent files stay
valid.

  Exit: A user can author one `.md` under `~/.pi/agent/agents/reviewer.md`
  with PTM-style frontmatter and use it both as `/reviewer some task` and
  as `delegate({ runs: [{ agent: "reviewer", task: "..." }] })`.

Each phase ships independently. Phase 1 is the only blocker for "PTM
templates can target `pi-delegate`".

---

## 6. Dependencies on other work

Phase 1 no longer requires core runtime dependencies beyond the small
`executeDirectShape` extension points shipped here:

1. **Request-scoped cwd with live context.** `executeDirectShape` accepts
   `ctxCwd` so the bridge can honor PTM's request cwd without fabricating
   or mutating the live Pi `ExtensionContext`.

2. **Explicit main-model control.** `executeDirectShape` accepts
   `mainModel: null` to disable the implicit foreground-session model rung
   for explicit PTM model requests.

Remaining optional follow-ups:

3. **Chunk or lift the parallel-6 cap** so the bridge can handle large
   `bestOfN` lineups without failing.

4. **Live update events** translating direct-worker status snapshots into
   PTM's `prompt-template:subagent:update` shape.

---

## 7. Risks and open questions

### Risks

- **PTM event schema drift.** PTM versions can rename fields or add required
  fields. Mitigation: accept the legacy shape and exactly v1; reject defined
  delegation-request `protocolVersion` values and behavior-bearing retired
  fields before execution, and keep legacy/v1 fixtures in the bridge tests.
- **Double-execution if both extensions listen.** Covered by the auto-gate
  in §3.1, but if detection fails (e.g. legacy ext installed at a
  non-standard path), both will run. The cost is a wasted run — not data
  corruption — but it's a footgun. Add a runtime warning on first
  duplicate-response observation.
- **Update event throughput.** PTM's widget refreshes ~1Hz. A six-worker
  parallel run polling every 750ms = 8 events/sec on the bus. Should be
  fine but worth measuring; debounce/coalesce if needed.
- **Worker transcript shape mismatch.** PTM consumes `messages: Message[]`
  and uses them for chain-context summaries. `pi-delegate` worker sessions
  are AI-SDK-shaped already, so this should be a direct passthrough — but
  validate in tests against PTM's actual reader.

### Open questions

1. **Should the bridge emit on the PTM event channels even when the
   request originated from `delegate_control` action `steer` / overlay actions?** I.e.
   should manual overlay activity surface in PTM's widget if a PTM-
   originated run was steered? Probably yes — same `requestId`, just
   richer data — but worth confirming.

2. **Cancel direction symmetry.** PTM cancels `pi-delegate` cleanly
   (§3.7). The reverse — `delegate_control` action `cancel` cancelling a run that PTM is
   `await`ing — already works because we emit `response` with `isError:
   true`, but worth a test.

3. **Chain context summaries.** PTM's `chainContext: summary` mode reads
   `response.messages` to build a preamble for the next step. If
   `pi-delegate` runs `collapse_mode: "summary"`, the supervisor's summary
   is what PTM gets — not the raw worker transcript. Does PTM care? Open
   question; default to passing the raw worker transcript (richer signal
   for the summary step).

4. **`pi.getExtensions()` API availability.** The auto-gate needs a way
   to ask the SDK what other extensions are loaded. If that's not exposed
   today, fall back to a filesystem probe of the legacy ext path (already
   reliable).

5. **Should we publish the bridge as a separate npm package?** Pro: PTM
   users can install just the bridge without all of `pi-delegate`. Con:
   the bridge is meaningless without `pi-delegate`'s runtime. Recommend
   keeping it inside `pi-delegate`'s extension and gating with config.

---

## 8. Out of scope for this proposal

- Embedding PTM's chain / loop / best-of-N orchestration inside
  `pi-delegate`. Stays in PTM.
- Replacing `pi-delegate`'s own agent-`.md` discovery with PTM's
  prompt-template directory layout. Optional Phase 4 only.
- Cross-extension steering hooks (PTM → `pi-delegate.steer()`). PTM
  doesn't have a steer surface; not our problem yet.
- Replacing the legacy `subagent` extension. We coexist; users pick.

---

## 9. Shipped decisions

1. **Bridge lives inside `pi-delegate`.** Phase 1 uses
   `src/ptm-bridge.ts` plus session lifecycle wiring in `src/index.ts`.
2. **Direct mode is the compatibility baseline.** PTM requests map to
   `executeDirectShape({ sync: true })`; supervisor-fork runtime remains a
   future opt-in.
3. **PTM model selection is authoritative for the invocation.** The bridge
   applies it to cloned agent configs and disables implicit session-model
   fallback for explicit PTM requests.
4. **Agent validation is bridge-owned.** PTM v1 sends resolved agent and
   skill names in its request. The bridge validates agent names through its
   injected discovery function and retains `PI_SUBAGENT_RUNTIME_ROOT` only
   as a compatibility hook for older PTM installations; no symlink or
   upstream PTM change is required for Phase 1.
