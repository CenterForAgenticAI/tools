# Programmatic runtime API

`createDelegateRuntimeClient({ context })` exposes the production delegate core
to another co-resident Pi extension. The client exposes typed dispatch, inspection,
control, escalation and definition-management operations:

- `dispatch`: the canonical entry point to submit one ordinary `delegate`
  request and receive a durable receipt.
  `direct` and `managed` are deprecated compatibility aliases; see
  [Migrating to dispatch](#migrating-to-dispatch).
- `status`: read one run's uniform current status.
- `harvest`: read one run's typed result and execution provenance.
- `steer`: use the existing in-process/detached/nested delivery ladder.
- `cancel`: use the existing destructive terminal/control-route behavior.

- `listRuns`, `logs`, and finite `wait`: inspect and observe existing work.
- `recover`, `promptStatus`, `followUp`, and `uiAnswer`: native recovery and daemon interactions.
- `listEscalations`, `resolveEscalation`, and `passUpEscalations`: durable escalation controls.
- `manage` and `health`: explicit definition management and diagnostics.

A host extension with its own operator feed can claim selected user-held kinds.
Subscribe at extension load, before foreground startup:

```ts
import { DELEGATE_EVENTS } from "@centerforagenticai/pi-delegate/events";
import type { DelegateHostEscalationDeliveryEvent } from "@centerforagenticai/pi-delegate";

pi.events.on(DELEGATE_EVENTS.hostEscalationDelivery, (payload) => {
  const { context, configure } = payload as DelegateHostEscalationDeliveryEvent;
  if (hostOwnsThisSession(context)) configure(["decision"]);
});
```

The event runs synchronously after the foreground core is installed and before
restored wakes replay. Register the claim synchronously; an asynchronous handler
cannot protect startup delivery. For later changes use a live bound client's
`configureHostEscalationDelivery(kinds)` method.

Claims affect only durable user-held requests owned by that session. Other
kinds, other sessions, and requests without an owner ID retain normal delivery.
Pass `[]` to release the claim; the next scan may prompt pending requests.
Claims reset on session start/replacement and shutdown, including replacement
with the same durable session ID. A retained client or event callback cannot
change the successor's policy. The host re-registers on every startup or reload;
this is session adapter policy, not durable escalation state. It neither answers
requests nor claims mailbox leases, and final-hop timeouts continue normally.

`nativeEscalationUi: false` remains the directory-wide policy for hosts that own
all user-held kinds. Host claims are additive and do not override that setting.

`dispatch` forces asynchronous mode and rejects an
`edit` claim because pi-delegate does not enforce one.
Submission/control failures throw `DelegateRuntimeError` with a stable `code`
(for example `unknown-agent`, `model-unavailable`, `invalid-confinement`,
`input-unreadable`, or `control-unavailable`) instead of requiring callers to
parse prose. The native handler sets each code: an unknown run for `harvest` or
a missing saved chain (root or nested reference) is `not-found`; a nested
caller's writable-root confinement refusal is `invalid-confinement`, including a
read-only (write-confined `readOnly`) caller that dispatches a child slot without
`readOnly: true`; a steer the
run cannot accept is `control-unavailable`.

`reads` and `worktree: true` are rejected at the shared native/client boundary. The
isolated tree can differ from the caller checkout, so pre-dispatch code cannot
truthfully attest the bytes the worker will read; the combination fails before
creating a run.

```ts
import { createDelegateRuntimeClient } from "@centerforagenticai/pi-delegate";

const delegate = createDelegateRuntimeClient({ context: ctx });
const receipt = await delegate.dispatch({
  runs: [{
    agent: "reviewer",
    mode: "solo",
    task: "Judge the named inputs against the rubric.",
    reads: ["report.md", "rubric.md"],
  }],
  model: "quality",
});

// Later, in response to the ordinary completion event/wake:
const result = await delegate.harvest(receipt.runId);
```

## Capability matrix

`client.capabilities` lists the methods supported by the installed core. Check it
before using an optional capability. Missing lifecycle support or an incompatible
structured result fails with `unsupported-capability`; there is no second engine.
The version 1 global handle, receipts and results remain compatible.
`observeDelegateRuntimeStatus(status, runId)` classifies native state as `pending`,
`terminal`, `orphan`, or `unavailable`, retaining the underlying run details.
Definition results expose environment key names, never environment secret values.
Agent tool lists retain `mcp:` selectors. Chain `envKeys` is the sorted union of
step environment names. Result schemas require operation-specific outcomes and
identities; a result for another target fails with `unsupported-capability`.

`listRuns()` retains readable dispatches when a native scan is partial. Check
`degraded` and `truncated` before treating the list as complete. `logs().truncated`
reports byte or line clipping of the returned tail, not the separate native
`stderrTruncated` diagnostic marker.

All operations use the same schema-validated, action-authorized native handlers.
Legacy internal handler names do not bypass action grants. Unknown envelope fields
are not forwarded; unknown dispatch fields are rejected on both surfaces. Invalid identifiers, options and mixed UI answers fail before
storage or control effects. Errors carry `DelegateRuntimeError.code`; the client
does not classify native prose. Unsupported native operations stay unavailable.

| Native operation | Typed client | Request/result | Authority and availability | Test evidence |
|---|---|---|---|---|
| `delegate` solo, count, supervised, ordered, saved nested chain, command stages, driver | `dispatch` | `DelegateRuntimeDispatchRequest` → version 1 receipt | Existing trust, nesting, confinement and mode rules; daemon needed for driver | `runtime-dispatch-evidence`, `runtime-invocation`, `daemon-driver` |
| `delegate_control:status` (one/all) | `status(runId)`, `listRuns()` | `DelegateRuntimeStatus`; `dispatches` has uniform pending/terminal states and source | Status action grant; all-runs enumeration is owner-scoped; detached discovery retains degraded/truncated flags | `runtime-parity`, `run-introspect` |
| `delegate_control:result` | `harvest(runId)` | Version 1 result, including terminal worker failure and persisted provenance | Result action grant; terminal worker failure is a result, not a transport failure | `runtime-api`, `runtime-dispatch-evidence` |
| Status childlog tail | `logs({runId,tail?,tailLines?})` | `available` with sanitized text, or `unavailable` | Status grant; native default 40 lines/8 KiB, maximum 256 lines/64 KiB | `runtime-parity`, `run-introspect` |
| Completion observation | `wait({runId,timeoutMs})` | `terminal`, `timeout`, `aborted`, or `unavailable` | Status grant, current binding; event subscription/read-only daemon attachment/persisted records | `runtime-parity`, `daemon-dispatch-evidence`, `daemon-driver` |
| `delegate_control:steer` / `cancel` | `steer`, `cancel` | Named target/message/reason/lineage/token fields → structured effect fields | Action grant plus native owner, fork and capability checks | `runtime-invocation`, `control-action-matrix` |
| `delegate_control:recover` | `recover` | Run/fork/strategy/message → recovery child identity or reconciled daemon identity | Worker recovery is foreground-only; native idempotence and descriptor rules retained | `runtime-parity`, `daemon-driver` |
| `delegate_control:prompt_status` | `promptStatus(runId)` | Typed pending/unknown/settled/failed/aborted prompt status | Prompt-status grant; daemon record required | `daemon-driver` |
| `delegate_control:follow_up` | `followUp` | Run/message → queued/input identity | Action grant and daemon owner/lease checks | `daemon-driver` |
| `delegate_control:ui_answer` | `uiAnswer` | Run/question ID plus exactly `{value}`, `{confirmed}`, or `{cancelled:true}` | Action grant, owner, live correlated question and lease | `runtime-parity`, `daemon-driver` |
| `delegate_escalation:list` | `listEscalations` | Root/request filter → typed holder/options | List grant; canonical durable store | `runtime-parity` |
| `delegate_escalation:resolve` | `resolveEscalation` | Selection/custom instruction → typed resolution | Resolve grant, current holder and declared authority; `onBehalfOfUser` only after an actual operator choice | `runtime-parity`, `escalation-surface` |
| `delegate_escalation:pass_up` | `passUpEscalations` | Filter/context/recommendation → forwarded/no-op/error entries | Pass-up grant and holder policy | `runtime-parity`, `escalation-surface` |
| `delegate` list/get/create/update/delete/canonicalize | `manage` | `DelegateRuntimeManagementRequest` → structured definitions/file/warnings | Native project trust, immutable package/builtin and nested mutation rules; canonicalize supports agents, not chains | `runtime-parity`, `management-roundtrip` |
| `delegate` health | `health()` | `DelegateRuntimeHealth` | Bounded native diagnostic scan; no dispatch | `runtime-parity` |

Test names above identify suites, not a claim that every gate ran.
Native formatted text, widgets and automatic wake presentation are not recreated.
The typed API returns structured data from those same handlers instead.

### Bounded wait and explicit management

```ts
const outcome = await delegate.wait({ runId: receipt.runId, timeoutMs: 30_000 }, {
  signal: observation.signal,
});
if (outcome.kind === "terminal") {
  const result = await delegate.harvest(outcome.runId);
}
const definitions = await delegate.manage({ action: "list" });
```

The timeout bounds the whole wait, including daemon connection and attachment.
`timeoutMs` must be an integer from 0 through 2147483647. Wait subscribes before
checking state. It releases timers, event/file subscriptions and read-only daemon
attachments on completion, timeout, abort, stale binding, teardown or failure.
Aborting observation never cancels or resubmits work. Call `cancel` explicitly to
cancel. A replaced context returns an unavailable wait; other operations reject
with `stale-context`. Durable terminal records can answer without a live worker.
Wait observes existing work; it does not emit an `accepted` update or create
acceptance evidence. Every terminal observation emits one `terminal` update,
whether it came from an event, inspection, or a persisted record. Legacy detached
processes use real PID liveness checks; daemon targets use native daemon status.
These fallback checks back off: the first runs after 100 ms and the interval
doubles to a 2 s ceiling, because each daemon status check opens daemon
connections. Events, record watches and the daemon attachment still report
terminal state immediately. Read-only liveness checks stop with the wait,
including when its deadline wins before a detached connection completes.

Management is separate from dispatch: `dispatch({action: ...})` is rejected.
Create uses `config.name` and `config.description`; update/get/delete address
`agent` or `chainName`. `agentScope` filters selection, while `config.scope` selects
the creation destination. Agent and chain list/get return `definitions` with
named configuration fields. Native chain canonicalization remains explicitly
unsupported; it is not silently treated as a successful no-op.

## Migrating to dispatch

Replace `client.direct(request)` or `client.managed(request)` with
`client.dispatch(request)`. Keep the request unchanged. All three names refer to
the same function and retain the same validation, authorization, errors,
receipts, and outcomes. The request selects the execution mode, not the method
name: `direct` accepts supervised requests, and `managed` accepts solo requests.
Mixed-mode requests still fail validation; split them into separate dispatches.

Use explicit modes for new code:

```ts
// One worker, without a supervisor.
const solo = await delegate.dispatch({
  runs: [{ agent: "reviewer", mode: "solo", task: "Review the patch." }],
});

// A supervisor works with the worker.
const supervised = await delegate.dispatch({
  runs: [{ agent: "reviewer", mode: "supervised", task: "Review and refine the patch." }],
});

// A detached driver dispatches its own work. Requires the optional pi-daemon package.
const driver = await delegate.dispatch({
  runs: [{ agent: "orchestrator", mode: "driver", task: "Coordinate the review." }],
});
```

Driver requests require exactly one run. Their receipts use the daemon’s durable
prompt acceptance, not an in-memory worker registration.

Both aliases remain callable in this release, without runtime warnings. Removal
is reserved for a future breaking release with a separate migration notice;
no removal version is scheduled.

### Reference inventory

- `DelegateRuntimeClient` is exported from the package root (`src/index.ts`).
  Its declarations originate in `src/runtime-api.ts` and ship as
  `dist/runtime-api.d.ts`, re-exported by `dist/index.d.ts`. Both aliases carry
  `@deprecated` guidance to `dispatch()`.
- The README and this API guide recommend `dispatch()`. Package-owned runtime
  examples and ordinary API tests already use it. Dedicated alias tests and
  the consumer compilation fixture retain all three names deliberately.
- Historical plans and release notes remain unchanged. The Fabric adapter
  (#568) maps `dispatch` to `delegate.dispatch` and exposes no alias actions;
  see [Fabric mode](fabric-mode.md). Consumer-repository migrations are separate
  work.

## Reaching the loaded instance from another extension

The client works only through the core that the **loaded** pi-delegate
installs. That core is module-level state. A consumer that imports its own copy
of `@centerforagenticai/pi-delegate` gets a module with no installed core, and every call
fails with `core-unavailable`. When pi-delegate and the consumer are installed
as separate Pi packages, a bare import usually cannot resolve the package at
all.

To reach the live instance, read the handle pi-delegate publishes on
`globalThis`:

```ts
import type { DelegateRuntimeApiHandle } from "@centerforagenticai/pi-delegate";

const key = Symbol.for("pi-delegate.runtime-api.v1"); // DELEGATE_RUNTIME_API_HANDLE_KEY
const handle = (globalThis as Record<symbol, unknown>)[key] as DelegateRuntimeApiHandle | undefined;
if (handle) {
  const delegate = handle.createDelegateRuntimeClient({ context: ctx });
}
```

- **Shape.** `{ createDelegateRuntimeClient, normalizeDelegateParams }`. The
  `v1` suffix versions this shape; a breaking change uses a new key.
  `DELEGATE_RUNTIME_API_HANDLE_KEY` and `DelegateRuntimeApiHandle` are exported
  from the package root.
- **Lifecycle.** Only the foreground session owns the handle. It is published
  at each foreground `session_start` and withdrawn at `session_shutdown`. It is
  never published merely because the module loaded: Pi loads a separate
  pi-delegate module instance for every in-process worker session, and those
  instances skip foreground lifecycle, so they never publish or withdraw it.
  At shutdown, pi-delegate first invalidates client bindings and observers, then aborts its active runs and publishes
  `result.json` for every receipted run it aborted, then withdraws the handle.
  A client created before a shutdown then fails with `core-unavailable`
  instead of reaching invalidated handlers. A module instance removes the
  handle only while it is still its own, so a reloaded successor's handle is
  never deleted by the outgoing instance.
- **Validation.** Treat the value as untrusted input: check that
  `createDelegateRuntimeClient` is a function before calling it. If the handle
  is absent, fall back to importing the package, which reaches a live core only
  when both extensions share one resolved copy.
- **Trust.** The handle object is frozen, so its properties cannot be replaced.
  The global slot itself stays writable, like any `globalThis` property. This is
  not a security boundary: every extension in the process already runs with
  full process authority and could replace the slot or the functions it
  reaches.

The facade calls the exact handler closures registered as `delegate`,
`delegate_status`, `delegate_result`, `delegate_steer`, and `delegate_cancel` —
the internal invoke keys, which keep their original names and are unaffected by
the model-facing consolidation.
Validation, authority, detached routing, status projection, and failure
semantics therefore cannot drift between tool and programmatic entrypoints.

## Invoking session and invocation lifetime

Create a client from the **actual invoking callback's** `ExtensionContext`. The
factory binds the installed core, exact session ID, current session-manager
identity, and foreground lifecycle generation. Each operation checks that binding
again. A fresh callback wrapper is valid when it shares the current manager.
A new client made from an old manager is stale, even if its session ID matches.

After a session switch, reload, or repeated `session_start` with the same session
ID, retained clients reject with `stale-context`. Construct a new client from the
new callback context. Never replace the caller's context with a cached global
context. A changed session manager beneath a retained context also invalidates it.
Missing session identity yields `context-unavailable`; no live core yields
`core-unavailable`; a core without binding/observation support yields
`unsupported-capability`. These errors reject operations, not factory creation.
No fallback session is fabricated.

All existing methods accept an optional second argument:

```ts
import type { DelegateRuntimeInvocationOptions } from "@centerforagenticai/pi-delegate";

const observation = new AbortController();
const options: DelegateRuntimeInvocationOptions = {
  signal: observation.signal,
  onUpdate(update) {
    if (update.kind === "accepted") console.log(update.acceptance.runId);
    if (update.kind === "progress") console.log(update.forks);
    if (update.kind === "terminal") console.log(update.state);
  },
};
const receipt = await delegate.dispatch({
  runs: [{ agent: "reviewer", mode: "supervised", task: "Review this patch." }],
}, options);
observation.abort(); // Stop observing. Do not cancel the accepted run.
const result = await delegate.harvest(receipt.runId);
// Only an explicit delegate.cancel({ runId: receipt.runId }) requests cancellation.
```

The same options work with `direct`, `managed`, `status`, `harvest`, `steer`, and
`cancel`; the aliases remain the exact `dispatch` function.

- **Before acceptance:** abort rejects with `invocation-aborted` and starts no
  work. Checks run at entry, after preparation, and at registration or daemon
  prompt submission. Session/core replacement during preparation also prevents
  launch. Durable retry admission is acceptance; a failed registration transaction
  is not acceptance.
- **Submission in flight:** do not race away from a daemon prompt request. Its
  eventual accepted or uncertain identity remains in the receipt or typed failure
  evidence, even when observation was aborted. Recovery looks up the same claim;
  it never resubmits it.
- **After acceptance:** abort only detaches observation. Receipt publication still
  completes, or throws the existing acceptance-bearing publication error. The
  publication-failure cancellation attempt is separate from observation abort.
- **Lifetime:** dispatch returns its receipt without waiting for completion. Its
  observer remains until terminal completion, observer abort/error, dispatch
  failure, session replacement, or core teardown. Other invocations release their
  resources when they settle. Bounded wait uses this same observation
  policy; timeout/abort must not mean run cancellation.

Updates are ordered `accepted`, then progress, then terminal. Startup progress
is buffered until acceptance and may be coalesced. Progress contains only run ID
and entry name, worker agent, status, and optional round counts. Terminal state
uses the same classification as status/harvest. No transcript, task text,
capability token, or mutable runtime object is passed to observers. Callback
mutation cannot change receipt evidence. Callbacks start in event order, but the
runtime does not wait for their promises before delivering later updates or
publishing receipts. Async callbacks can finish out of order. A synchronous throw,
rejected promise, or rejected thenable detaches observation and produces a fixed,
bounded diagnostic without its exception text. Already-started callbacks can
finish after detachment; accepted execution continues. In-process observation subscribes before launch. Daemon observation
uses a read-only live attachment and prompt status, without taking a control
lease or advancing harvest's durable cursor. Transport failure detaches that
observer and logs a diagnostic; status/harvest remain the recovery path.

## Supervision context and resources

The named `agent` is the **specialist worker**. The supervisor is a separate clone
of the invoking session's model and system prompt, with delegation framing and
restricted worker-control tools. Receipt `agent` identifies the worker;
`forkName` addresses the supervised entry, not another named supervisor agent.

| Option | Context and behavior |
| --- | --- |
| `clone_mode: "full"` (default) | Uses the invoking session's branch. Removes unresolved trailing assistant tool calls before seeding the supervisor. |
| `clone_mode: "snippet"` | Quotes summaries of the last `snippet_last_n` branch messages, default 10. It does not install those messages as conversation history. |
| `clone_mode: "task_only"` | No parent conversation history. Still uses the invoking model/system prompt and delegation framing. |
| `task_delivery: "direct-first-turn"` (default) | Sends the exact task to the worker first. Seeds the completed exchange before the supervisor's first generated turn. That exchange consumes round 1. |
| `task_delivery: "supervisor-mediated"` | Lets the supervisor generate the first worker instruction. |
| `max_rounds` | Bounds worker exchanges; direct-first-turn counts toward the bound. |
| `collapse_mode: "final_output"` | Returns the supervisor's final output under the existing collapse contract. |
| `collapse_mode: "summary"` | Uses existing summary-model routing and its no-model fallback. |

The worker's resources follow its agent configuration and the existing worker
loader. The supervisor's isolated loader imports no extensions, skills, prompt
templates, themes, or context files—even when those directories are populated.
Clone modes select conversation context, **not worker privileges**.

## Shared policy boundary and hook bypass

The client invokes the registered handler closures directly. It does **not**
traverse Pi's model-tool dispatch hooks, such as argument/tool-call interception
or tool-result hooks. Do not depend on those hooks to authorize programmatic
calls. Required normalization, agent lookup, project trust, confinement,
lineage/capability checks, and control ownership remain in shared execution
boundaries. Worker tool execution still follows its normal worker runtime.

A caller cannot gain control of a foreign session's run by changing `forkName`.
Native and client steer/cancel use the same owner checks; nested targets still
require their capability token. At teardown, an internal authorized result path
publishes terminal envelopes after public bindings are invalidated. Public stale
clients receive no teardown bypass.

## Stable disk envelopes

Programmatic runs write owner-only (`0700` directories, `0600` files), atomic
JSON envelopes below:

```text
<agentDir>/extensions/pi-delegate/runtime-api/<runId>/receipt.json
<agentDir>/extensions/pi-delegate/runtime-api/<runId>/result.json
```

Both contracts use `version: 1`; additive fields may be introduced within a
version, while removing or changing a field requires a version increment.
External observers may read these paths without a server or live client.

`receipt.json` is published before `dispatch()` returns. It records the run ID,
shape, entry names, resolved agent identity, effective worker cwd, model/skills,
confinement settings, and per-input SHA-256 digests. Task/checklist values are
hashed as declared. Available ordinary named-file inputs hash file bytes, not paths.
Unavailable string-file reads preserve the native optional-read warning behavior
and omit unavailable digests; artifact-reference failures remain fatal. Chain reads are resolved at execution:
they can name an earlier step’s artifact, which does not yet exist at admission.
The receipt does not invent a digest for those future bytes.

For in-process runs, `result.json` is published automatically when a receipted run terminates,
including a run aborted because its foreground session shut down, and is
also atomically refreshed by an explicit `harvest()`. It binds the durable run
ID to each entry's resolved worker model, worker session, cwd, timings, terminal
outcome, receipt input digests, and `actualInputDigests`: ordered SHA-256 values
of the exact user messages delivered to the worker. A consumer must require a terminal state and
the provenance fields it needs. A standalone verdict-shaped object is not
evidence.

The TypeScript contracts are exported as `DelegateRuntimeReceipt` and
`DelegateRuntimeResult`. For process-independent inspection, use
`readDelegateRuntimeReceipt()` and `readDelegateRuntimeResult()`; neither
requires a live extension core.

## Saved chains and ordered evidence

`dispatch({ chain: "saved-name", task: "..." })` uses the same discovery,
recursive expansion, command-stage validation and executor as the native tool.
Ordered `runs` use the existing compiler. The client does not build an execution
plan. Missing or invalid definitions fail before worker creation.

Version-1 receipts and results add optional `acceptance` and `steps` fields.
Each step has an opaque `id` equal to its runtime entry `name`, a `stepIndex`,
`dependsOn` identifiers, a `kind` (`worker` or `command`), and a state:
`planned`, `started`, `completed`, `failed`, `aborted`, or `skipped`.
Unstarted successors remain in the evidence after a predecessor fails. Existing
`forks`, `provenance`, envelope versions, readers and aliases remain supported.

Top-level `inputDigests` preserve the declared chain task; per-step
`inputDigests` describe declared step inputs. `actualInputDigests` remain empty until
there is execution evidence. For workers they hash delivered user messages;
for command stages they hash the executed command; for daemon drivers they hash
the accepted prompt retained in the durable cfg. They do not attest tool reads
that happen later. Result `content` preserves native output, including daemon
text that is not present in native `details`.

Accepted daemon steps are `started` even without an in-memory worker snapshot.
Status and harvest use the durable locator and prompt status to report the same
step as completed, failed, or aborted. Native retries with the same run identity
preserve the original plan evidence, including its timestamp. A changed declared
task or step name is rejected before another submission; a later validation
failure cannot replace the original evidence.

## Acceptance failures and recovery

A `DelegateRuntimeError` with code `provenance-unavailable` can carry `evidence`:

- `acceptance`: the stable `runId`, transport, accepted/uncertain state, and any
  known daemon session, prompt and idempotency identities.
- `stage`: `metadata`, `receipt`, `submission`, or `locator`.
- `cleanup`: `not-requested`, `acknowledged`, `rejected`, or `unknown`.
- `terminalConfirmed: false`: a cancellation acknowledgment is not proof that
  execution stopped.
- `recovery`: the existing run ID and the recovery action to use.

Do not redispatch after this error. For accepted work, call `status(runId)` and
`harvest(runId)`. For an uncertain daemon submission, the persisted idempotency
key identifies the original prompt. Native
`delegate_control({ action: "recover", runId, forkName: "driver" })` repairs a
pending-only locator by looking up that key; it can restart the daemon service,
but does not submit another prompt.
An unknown claim remains an explicit error rather than authorizing a retry.
Control recovery retains the existing owner-session authorization.

After foreground replacement, construct a client from the new live context and
use the same run ID. Daemon status/harvest reconnect through the durable cfg and
can repair a pending-only locator. Explicit daemon harvest writes `result.json`;
there is no promise of automatic client-file publication while no foreground
client exists. In-process runs still use the runtime’s persisted terminal/orphan
classification; a lost runtime is not evidence of successful completion.
