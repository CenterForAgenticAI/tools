# PTM support reference

What actually works when [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)
(**PTM**) delegates to `pi-delegate`, and what is refused.

> **Scope.** This page is the support contract for the shipped bridge —
> the answer to "will my template work?". `docs/prompt-template-bridge.md`
> is the design document: it covers rationale, architecture, and the
> roadmap. When the two disagree, trust this page and the tests.
>
> **Reading the tables:** ✅ supported · ⚠️ accepted with a caveat ·
> ❌ rejected with an error. Rejections are *fail-closed by design* —
> the bridge refuses rather than silently running something other than
> what was asked.

## The short version

PTM stays the prompt-template language. `pi-delegate` becomes the runtime
it hands delegated work to. A template that uses `subagent:`, `parallel:`,
or `bestOfN:` runs on `pi-delegate`'s direct workers, visible in its
transcript overlay, with no template changes.

The three limits that decide most "does this work?" questions:

1. **`inheritContext: true` is rejected.** Only fresh context runs.
2. **More than 6 parallel tasks is rejected.** No chunking yet.
3. **Direct workers only.** No supervisor-fork review loop, and therefore
   no `delegate_control` action `steer` on a PTM-originated run.

## Is the bridge even listening?

Both `pi-delegate` and the legacy `subagent` extension can answer PTM's
events. Exactly one should. `ptmBridge.handleRequests` decides:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Listen **iff** `~/.pi/agent/extensions/subagent/agents.{ts,js}` does not exist. |
| `always` | Listen unconditionally. Use when both are installed and you want `pi-delegate`. |
| `never` | Ignore PTM events entirely. Roll back without uninstalling. |

Detection is a filesystem probe of the legacy extension's path, not a
listener count. If you installed the legacy extension somewhere
non-standard, `auto` will not see it and **both** backends will answer.
PTM accepts the first response and drops the second, so the cost is a
wasted duplicate run rather than corruption — but set `always` or `never`
explicitly rather than relying on the probe.

While active, the bridge sets `PI_SUBAGENT_RUNTIME_ROOT` as a
compatibility hook for older PTM installations that still look for a
subagent-shaped runtime. **If you already exported that variable, your
value is respected and never overwritten.**

The bridge is installed on Pi `session_start` with the live extension
context and disposed on `session_shutdown`. It has no static import of
PTM — it only subscribes to string event channels — so uninstalling PTM
cannot break `pi-delegate`.

## Event channels

Verbatim from PTM's `subagent-runtime.ts`:

| Channel | Direction | Supported |
| --- | --- | --- |
| `prompt-template:subagent:request` | PTM → bridge | ✅ |
| `prompt-template:subagent:started` | bridge → PTM | ✅ emitted on receipt |
| `prompt-template:subagent:response` | bridge → PTM | ✅ emitted once, terminal |
| `prompt-template:subagent:cancel` | PTM → bridge | ✅ aborts in-flight runs |
| `prompt-template:subagent:update` | bridge → PTM | ❌ never emitted |

Because no `update` events are emitted, PTM's above-editor widget shows
that a run is active but not per-tool or token detail. The full picture is
in `pi-delegate`'s transcript overlay (`Option-O` / `Alt+O`, or
`Ctrl+Alt+D`).

## Protocol versions

Two request envelopes are accepted, and they are not interchangeable:

| Envelope | Marker | Supported | Response shape |
| --- | --- | --- | --- |
| Legacy | no `version`, no `protocolVersion` | ✅ single and parallel | legacy |
| v1 | `version: 1` | ✅ **single only** | v1 (`status`/`output`) |

Rules the validator enforces:

- **`version: 1` with `tasks[]` is rejected.** v1 is a single-request
  contract; parallel batches must stay unversioned.
- **Any defined top-level `protocolVersion` is rejected.** This includes the
  retired value `2` and unknown values. It is not treated as a legacy request.
  The error identifies the supplied value and names the supported shapes:
  legacy unversioned single/parallel requests and `version: 1` single requests.
  For example:

  ```text
  Unsupported PTM delegation protocolVersion 2; supported shapes are legacy unversioned single/parallel requests and version 1 single requests.
  ```

  The rejection happens before legacy parsing, agent discovery, or worker
  execution; the payload cannot fall through to a supported shape.
- **Any other version number is rejected**, naming the supported shapes.

This field name also appears in PTM prompt lifecycle and invoke events. Those
are separate event protocols, not delegation-request envelopes; their
`protocolVersion` fields remain unchanged. Do not copy one of those markers
onto a delegation request.

Both accepted envelopes use **explicit field allowlists** where their shape
requires them: an unrecognised field is rejected with "refusing to discard
possible behavior" rather than ignored. This is the bridge's core safety
property — if PTM adds a behaviour-bearing field, you get an error, not a run
that quietly ignored it.

## Request field support

| PTM field | Supported | Notes |
| --- | --- | --- |
| `requestId` | ✅ required | non-empty string |
| `agent` | ✅ required | validated against pi-delegate discovery before execution |
| `task` | ✅ required | forwarded verbatim; PTM has already rendered `$@`/`$1` |
| `context: "fresh"` | ✅ | the only supported context |
| `context: "fork"` | ❌ | see below |
| `model` | ✅ required | drives the worker; see model semantics |
| `cwd` | ✅ required | **must be absolute** |
| `worktree` | ✅ | boolean only; one git worktree per worker |
| `skill` | ⚠️ single requests only | ordered non-empty names; rejected alongside `tasks[]` |
| `tasks[]` | ✅ up to 6 | heterogeneous agent/model/cwd/skill per slot |
| `tasks[i].model` | ✅ | overrides request-level `model` for that slot |
| `tasks[i].skill` | ✅ | applies to that slot only, no sibling leakage |
| `tasks[i].cwd` | ✅ | must be absolute; equal-to-request cwd is omitted so `worktree: true` batches work |

### `inheritContext: true` → rejected

PTM's `inheritContext: true` arrives as `context: "fork"`, meaning "the
subagent should see the conversation". The bridge **rejects it before agent
discovery and before any worker starts**:

```
PTM bridge context:"fork" is not supported: bounded parent-context snapshot
is not yet supported. Use context:"fresh" or provide a bounded, trusted
producer-context seed when that compatibility path is available.
```

This is the most important refusal on this page, and the reasoning is worth
stating plainly: the alternative would be running with fresh context while
the template believes the parent conversation was available. A wrong answer
produced confidently is worse than a clear failure, so the bridge fails.

The response preserves `context: "fork"` and reports
`requestedContext: "fork"`, but **omits `effectiveContext`** because no
worker ran, and carries the guidance in `errorText`. When UI is available
the rejection is surfaced once per bridge handle.

**Workaround:** drop `inheritContext: true` and pass what the worker needs
in the template body, where you control the size and content.

### Parallel cap is 6

Six tasks forward as one direct execution. Seven or more fail:

```
PTM bridge phase 1: parallel cap is 6, got 8.
```

This bites `bestOfN` lineups whose slots use `count: N`. There is no
automatic chunking, because PTM's result ordering and progress semantics
have to stay explicit. Split the template into rounds if you need more.

Note that `bestOfN` is not one request — PTM orchestrates each phase
(workers, reviewers, final applier) as its own request/response round-trip,
so the bridge sees ordinary parallel batches and the cap applies per phase.

## Model semantics

- PTM's resolved `model` drives the worker. In parallel requests,
  `tasks[i].model` overrides it per slot.
- Selection is **invocation-scoped**: the bridge clones the discovered agent
  config and applies the model to the clone. Durable agent files are never
  mutated.
- Because PTM sends an explicit model with no fallback policy, the bridge
  **clears agent fallbacks and disables the foreground-session model rung**.
  An unresolvable PTM model fails clearly instead of quietly running on the
  agent's durable model or your session model.

Responses add optional provenance fields that existing consumers ignore:
`requestedModel`, `actualModel`, `attemptedModels`, `modelFallback`,
`requestedContext`, `effectiveContext`, `contextWarning`.

## Response shapes

Which shape you get depends on the request envelope:

| Request | Response |
| --- | --- |
| Legacy single | legacy: `messages[]`, `contentText`, `isError` |
| Legacy parallel | legacy plus `parallelResults[]` |
| v1 single | v1: `version: 1`, `status`, `output`, optional `error`/`effects` |

**A gotcha worth knowing:** for parallel requests the top-level `messages`
array is **empty**. Per-task transcripts live in `parallelResults[i].messages`.
Code that reads `response.messages` for a parallel run finds nothing.

`messages[]` is **synthesized**, not a faithful transcript: a two-message
`user` + `assistant` array with the worker's `write`/`edit` tool calls
reconstructed from the transcript. This exists so PTM's loop-convergence
detection keeps working. It is lossy but functional — and it means
**convergence detection only sees `write` and `edit`**, not other tools.

## Cancellation

PTM emits `prompt-template:subagent:cancel` with `{ requestId }` when a user
aborts. The bridge holds a map of in-flight requests to abort controllers,
aborts the match, and unwinds through the normal error path — a `response`
with `isError: true` and `errorText: "cancelled"`.

The reverse direction works too: `delegate_control` action `cancel` on a PTM-originated run
emits the same error response, so PTM stops awaiting.

`delegate_control` action `steer` does **not** apply. Steering requires a supervisor, and PTM
requests run as direct workers.

## Validation failures

Malformed payloads are rejected **before any worker executes**. The bridge
still emits `started` and then a terminal error `response`, so PTM is never
left awaiting a reply it will not get — provided `requestId` is a usable
string. A payload without one is dropped silently, because there is no
correlation key to answer on.

Error responses match the request envelope: a v1 single request gets a v1
`status: "failed"` response; everything else gets the legacy shape with
`isError: true`.

Categories, all fail-closed:

- unknown or mismatched protocol version
- defined delegation-request `protocolVersion` (including the retired value
  `2`)
- unrecognised field in a versioned envelope
- retired behaviour-bearing field (`fallbackModels`, `thinking`, `skills`,
  `contextSeed`, `compatibility`, or `capabilities`)
- missing or wrong-typed required field
- `skill` on a parallel request
- non-absolute `cwd`
- non-boolean `worktree`
- `context: "fork"`
- more than 6 tasks

## Not supported

| Capability | Status |
| --- | --- |
| `inheritContext: true` / `context: "fork"` | ❌ rejected; needs a bounded producer-context seed contract |
| Live `update` events | ❌ not emitted; widget shows "running…" only |
| More than 6 parallel tasks | ❌ no chunking |
| Supervisor-fork mode | ❌ direct workers only; a `runtime: supervised` opt-in is deferred |
| `delegate_control` action `steer` on PTM runs | ❌ direct workers cannot be steered |
| Loop convergence on non-`write`/`edit` tools | ❌ synthesized messages carry only those |

PTM keeps ownership of loop, chain, `bestOfN`, `<if-model>`, and
deterministic shell steps. Those are template-language concerns and are not
moving into the runtime.

## Related

- `docs/prompt-template-bridge.md` — design, architecture, and roadmap.
- README, **"Working with pi-prompt-template-model"** — the quick-start view.
- README, **"Configuration"** — `ptmBridge.handleRequests`.
- `skills/authoring-delegate-agents` — writing the agent definitions PTM
  dispatches by name.
