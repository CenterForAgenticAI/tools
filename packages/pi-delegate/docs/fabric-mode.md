# Fabric mode

pi-delegate ships an optional adapter for [pi-fabric](https://www.npmjs.com/package/pi-fabric).
When a compatible Fabric runtime is active in the Pi session, the model reaches
pi-delegate inside `fabric_exec` through the Fabric provider `delegate`. The
adapter is a thin layer over the [typed runtime client](runtime-api.md). It adds
no second execution engine and no second copy of the core.

Fabric stays optional. pi-delegate has no pi-fabric dependency of any kind and
imports nothing from it. The two protocol event names and the few structural
types the adapter needs are copied into `src/fabric-protocol.ts`. A contract test
compares that copy with the published declarations.

## Compatibility

Fabric mode is tested with npm `pi-fabric` 0.96.4 on Pi 0.85.1. The CI job
`fabric_contract` runs those checks on every pipeline. The CAAIR fork build is
checked by hand, not in CI. pi-delegate's development SDK stays at Pi 0.84.2:
there is no dev SDK bump for Fabric. Pi 0.85.1 is installed only into the
scratch copy of pi-fabric that the tests load, because the pi-fabric extension
factory needs Pi 0.85.1 or later.

| Fabric build | Provider protocol | Status |
| --- | --- | --- |
| npm `pi-fabric` 0.96.4 on Pi 0.85.1 | v1 | Tested in CI: declarations, real extension factory, `fabric_exec` calls |
| Other npm `pi-fabric` 0.96.x releases | v1 | Expected to work: same protocol, not tested |
| CAAIR fork build of 0.96.4 | v1 | Checked by hand with the same tests, not in CI |
| Any other version | — | Not claimed. A discovery payload with another protocol version is refused with a diagnostic |

## When Fabric mode is selected

Fabric mode is chosen at runtime, never because a package is installed on
disk.

1. At each foreground `session_start`, after its runtime core is live,
   pi-delegate emits `pi-fabric:provider:register:v1` with
   `{ version: 1, provider, overwrite: true }`. A loaded Fabric stores the
   provider for its next activation. With no Fabric listener, nothing happens.
2. When Fabric's runtime activates in the session (eagerly, or on the first
   `fabric_exec` call), it emits `pi-fabric:provider:discover:v1`. pi-delegate
   answers with `register(provider, { overwrite: true })`. A version 1 payload
   whose `register` accepts the provider is the handshake: the Fabric surface is
   now **ready**.
3. Fabric mode is **selected** only when all of these hold:
   - the surface is ready;
   - the installed core supports every runtime capability, and each one has a
     provider action;
   - `fabric_exec` is in the model's active tool set;
   - no mode that needs the native surface is on (delegate-only mode keeps
     the native tools and instructions).

The same provider object answers both paths, and every registration uses
`overwrite: true`. Either load order, repeated `session_start`, or repeated
discovery therefore leaves exactly one `delegate` provider in Fabric.

While Fabric mode is selected:

- The model receives the Fabric-mode instructions (below) instead of the native
  `delegate` tool line and guidelines. The native call examples are not sent.
- `delegate`, `delegate_control`, and `delegate_escalation` leave the active
  tool set. They stay **registered**, so Fabric's tool capture, slash commands,
  worker allowlists, and the runtime client keep working. The state-gated
  control tools are still registered when runs or escalations exist, but they
  are not advertised again while Fabric covers them.
- Wakes and tool results that tell the model how to reach a control name the
  Fabric refs instead of the native tools: for example a failed entry points to
  `delegate.recover`, and a failed driver or a recovered run points to
  `delegate.harvest`. The wording is chosen for the session that receives the
  message, with the same selection rule.

When the surface is not ready, or selection stops holding, pi-delegate restores
exactly the native names it removed before the next model turn. There is no
interval in which both interfaces are withheld: native advertisement is removed
only after the discovery handshake succeeded.

### Unsupported versions and registration failure

A discovery payload that is not version 1, has no `register` function, or whose
`register` throws (for example a reserved provider name) leaves the native
surface untouched. pi-delegate writes one bounded diagnostic (at most 600
characters) to its diagnostics log and shows it once as a warning at the next
foreground turn when the session has a UI:

```text
pi-delegate: Fabric adapter not registered (<reason>). Native delegate tools stay active. Use a pi-fabric build that speaks provider protocol v1 (tested with 0.96.x), or report the pi-fabric version.
```

## Lifecycle and host limits

| Event | Behavior |
| --- | --- |
| Fabric withdraws the provider (`close()`, at Fabric session shutdown or when its activation fails) | Surface becomes withdrawn; native advertisement returns before the next turn. The next discovery selects Fabric again. |
| `/fabric reload` (Fabric reinitializes its runtime) | Fabric closes its registry but excludes external providers, so it does not call `close()`. It mounts the stored provider again and repeats discovery; pi-delegate answers with `overwrite: true`. The surface stays ready and Fabric mode stays selected across the reload. |
| pi-delegate `session_shutdown` | The discovery listener is released and the surface resets. The runtime core is withdrawn after that, so a late Fabric call fails with `[core-unavailable]`. |
| Session switch, `/new`, `/resume`, `/fork`, reload | Pi runs `session_shutdown` and `session_start`. The provider binds a fresh runtime client to the invoking `fabric_exec` context on every call, so it never reuses a previous session's context. |
| pi-delegate loads before Fabric, with pending results at startup | Startup wakes (recovered sync output, orphaned or failed driver results, dropped dispatch and escalation wakes) name a control route. While a loaded Fabric host has not selected its interface yet, pi-delegate delivers them after every `session_start` handler has run (at `resources_discover`, or the first `turn_start`), so the hint follows the settled selection. Without Fabric they are delivered during `session_start`, as before. In both cases the startup retention sweep runs after them, so an old recovered run is shown before it is removed. |
| Delegate-owned worker sessions | The worker's pi-delegate instance never registers a provider and never changes instructions. |
| Pi reload without restart | Pi's extension runtime unsubscribes event-bus listeners on invalidation. A stale module instance cannot answer discovery. |

Host limits, stated plainly:

- Fabric decides when it activates. Before activation a loaded Fabric is
  "installed but inactive", and pi-delegate stays in native mode. In Fabric's
  full-code mode the native tools are already hidden, so until the first
  `fabric_exec` call triggers discovery the model sees no delegate guidance
  (tracked in #574).
- Fabric's extension-tool roster lists captured tools by name. Once
  `delegate_control` has been revealed it appears there too, next to the
  Fabric-mode instructions that route control through the `delegate`
  provider. The roster belongs to Fabric; prefer the provider refs.
- Fabric mode changes model-facing advertisement only. It is not a sandbox and
  it adds no confinement beyond what pi-delegate and the host already enforce.
- Fabric calls to the `delegate` provider do not pass through Pi's model-tool
  hooks (`tool_call`, `tool_result`). pi-delegate's own checks — schema and
  unknown-field validation, trust, nesting, confinement, run ownership and
  control grants — run inside the shared handlers, so they apply unchanged.
  Fabric's approval policy does not replace a hook-based confirmation. Its
  default approvals allow every risk class (`read`, `write`, `execute`,
  `network`, `agent`) in npm 0.96.4 and in the CAAIR fork, so a `delegate`
  call is not gated by Fabric unless you configure Fabric approvals.
- Updating either extension still needs a Pi restart or `/reload`, as for any
  extension.

## Fabric inside a worker

A worker whose profile loads Fabric gets `fabric_exec` when its tool surface
leaves Fabric room: no explicit `tools` list and no extension selectors.

Most workers are also restricted. An ordinary worker has the delegate family
denied, and a `readOnly` or write-confined worker has write confinement.
Several Fabric providers (`agents`, `mcp`, `sessions`, `jev` and others)
do not replay Pi `tool_call` hooks, so neither restriction would see them.
Before such a worker gets `fabric_exec`, pi-delegate sends the worker's Fabric
a host policy (`pi-fabric:host-policy:v1`). The policy refuses:

- the denied tool names through `pi.*` and `extensions.*`;
- every non-read action of the other providers;
- native executors (CPython, `node-process`, `bun-process`).

`pi.*` and `extensions.*` calls still replay `tool_call`, so write
confinement guards `write`, `edit` and `bash` inside programs as it does
outside them.

The worker gets `fabric_exec` only after Fabric acknowledges the policy. A
Fabric build without the handshake never replies, and such a worker keeps the
native tools without `fabric_exec`, as before. For a detached worker,
pi-delegate performs this handshake inside the child process after that child's
Fabric has loaded; the parent's detached-scope envelope carries only the policy
to request and cannot grant `fabric_exec` by itself.

pi-delegate delivers this request directly to the single listener registered
from the loaded `pi-fabric` package instead of broadcasting it on the worker's
event bus. This binding prevents broadcast exposure and accidental or naive
spoofing by other extensions; it is not a sandbox, and in-process extension
code — including code running inside Fabric's package — remains trusted with
Node authority.

## Using it from `fabric_exec`

```ts
const receipt = await tools.call({
  ref: "delegate.dispatch",
  args: { runs: [{ agent: "reviewer", mode: "supervised", task: "Review the patch." }] },
});
const outcome = await tools.call({ ref: "delegate.wait", args: { runId: receipt.runId, timeoutMs: 600000 } });
if (outcome.kind === "terminal") {
  const result = await tools.call({ ref: "delegate.harvest", args: { runId: receipt.runId } });
  return result.content;
}
return receipt.runId;
```

`args` is the same request the native `delegate` tool accepts. A supervised run
forks the session that is running `fabric_exec`: its model, system prompt and
branch. The named `agent` is the worker. Solo and supervised completion still
wakes the session, so `wait` is needed only when the same program uses the
result.

### Errors

Every failure rejects with a message that begins with the stable runtime code,
for example `[invalid-request] ...` or `[authorization-denied] ...`. The codes
are the `DelegateRuntimeError` codes of the runtime client. A post-acceptance
failure rejects with `[provenance-unavailable]` and carries the accepted run
identity and recovery action in the message, for example
`evidence={"acceptance":{"runId":"..."},...,"recovery":{"action":"status-and-harvest"}}`.
The run exists: inspect it with `delegate.status` and `delegate.harvest`, and do
not dispatch it again. Messages are at most 2 000 characters.

Argument schemas describe fields but do not constrain them. pi-delegate's shared
boundary is the single validator, so a malformed call gets the same code through
Fabric as through the client, and creates no run.

### Cancellation and progress

- Aborting the `fabric_exec` call before acceptance rejects with
  `[invocation-aborted]` and launches nothing.
- After acceptance, abort only stops observation. Only `delegate.cancel` stops
  accepted work. Aborting a `delegate.wait` returns `{ kind: "aborted" }` and
  leaves the run running.
- `dispatch` and `wait` report progress through Fabric's activity surface: an
  `entity` update with the run ID on acceptance, then `progress` messages with
  entry status and round counts. No transcript or task text is sent.

### Result size

Results pass through Fabric's nested result bound (`executor.maxNestedResultChars`,
default 2 000 000 characters, minimum 10 000). A larger result arrives as
`{ fabricTruncated: true, originalChars, preview }`. The full harvested
envelope is always on disk at the receipt's `resultPath`. Log tails keep their
native bounds (default 40 lines/8 KiB, maximum 256 lines/64 KiB).

## Capability matrix

Each runtime-client capability is one provider action, with the ref
`delegate.<action>`. Deprecated client aliases (`direct`, `managed`) are not
actions. Fabric's approval policy reads the risk class only when you configure
Fabric approvals: its defaults allow every risk class.

| Ref | Client method | Risk | Arguments |
| --- | --- | --- | --- |
| `delegate.dispatch` | `dispatch` | agent | The native `delegate` request: `runs`, `chain` and `task`, and the other dispatch fields |
| `delegate.status` | `status` | read | `runId` |
| `delegate.harvest` | `harvest` | read | `runId` |
| `delegate.steer` | `steer` | agent | `runId`, `message`, `forkName?`, `deliverAs?`, `targetLineagePath?`, `capToken?` |
| `delegate.cancel` | `cancel` | agent | `runId`, `forkName?`, `reason?`, `targetLineagePath?`, `capToken?` |
| `delegate.listRuns` | `listRuns` | read | none |
| `delegate.logs` | `logs` | read | `runId`, `tail?`, `tailLines?` |
| `delegate.wait` | `wait` | read | `runId`, `timeoutMs` |
| `delegate.recover` | `recover` | agent | `runId`, `forkName?`, `strategy?`, `message?` |
| `delegate.promptStatus` | `promptStatus` | read | `runId` |
| `delegate.followUp` | `followUp` | agent | `runId`, `message` |
| `delegate.uiAnswer` | `uiAnswer` | agent | `runId`, `questionId`, `answer` |
| `delegate.listEscalations` | `listEscalations` | read | `rootRunId?`, `requestIds?` |
| `delegate.resolveEscalation` | `resolveEscalation` | agent | `requestId`, `selected`, `rootRunId?`, `customInstruction?`, `note?`, `onBehalfOfUser?` |
| `delegate.passUpEscalations` | `passUpEscalations` | agent | `rootRunId?`, `requestIds?`, `context?`, `recommendation?` |
| `delegate.manage` | `manage` | write | `action`, `agent?`, `chainName?`, `agentScope?`, `config?` |
| `delegate.health` | `health` | read | none |

## Instructions the model receives

The Fabric-mode instructions are exported as `FABRIC_MODE_INSTRUCTIONS` from
`@centerforagenticai/pi-delegate/fabric`. They cover programmatic dispatch, the
worker/supervisor distinction, asynchronous receipts with `wait` and `harvest`,
authorization, error codes, cancellation and bounded results. They contain no
native `delegate(...)` call example.

## Package surface

`@centerforagenticai/pi-delegate/fabric` exports:

- `createDelegateFabricProvider()`: the provider, for hosts that register it
  themselves;
- `DELEGATE_FABRIC_PROVIDER_NAME`, `DELEGATE_FABRIC_ACTIONS`,
  `FABRIC_MODE_INSTRUCTIONS`, `FABRIC_ADAPTER_MAX_MESSAGE_CHARS`;
- `FABRIC_PROVIDER_REGISTER_EVENT`, `FABRIC_PROVIDER_DISCOVER_EVENT`,
  `FABRIC_PROVIDER_PROTOCOL_VERSION`, and the vendored protocol types.

No manual adapter is needed: the pi-delegate extension registers the provider
itself.

## Verification

| Check | Test |
| --- | --- |
| Vendored constants and types match npm 0.96.x and the CAAIR fork | `tests/unit/fabric-protocol-contract.test.ts` (set `PI_DELEGATE_FABRIC_NPM_ROOT`, `PI_DELEGATE_FABRIC_FORK_ROOT`) |
| Real Fabric factory + pi-delegate, both load orders, real `fabric_exec` calls | `tests/integration/fabric-real-host.test.ts` (same variables) |
| Absent, inactive, unsupported, failure, teardown, session switch, suppression, wake hints | `tests/integration/fabric-adapter-lifecycle.test.ts` |
| Shared-core contract: solo/supervised/driver dispatch, evidence, controls, auth, cancellation | `tests/integration/fabric-adapter-contract.test.ts` (the driver case needs the pi-daemon fixture: Node 24 and the optional pi-daemon package; CI runs it in `daemon_node24`) |
| Wake and result hints name Fabric refs, never a removed native tool | `tests/unit/model-interface.test.ts` |
| Installed package: exports, shipped files, registration, matrix | `tests/integration/fabric-packed-artifact.test.ts` via `npm run smoke:pack` |

`node scripts/fetch-fabric-contract-builds.mjs --with-peers --fork <fork-root>`
packs npm pi-fabric 0.96.4 into the system temp directory (never into this
checkout), installs the Pi 0.85.1 peers into that copy only, and prints the
variables. Without a variable, the matching build's tests are skipped.

CI runs the first two rows for the npm build only. It uses `--npm-only`, which
ignores the fork, and sets `PI_DELEGATE_FABRIC_REQUIRED=npm`. That variable
takes a comma-separated list of builds (`npm`, `fork`) and turns a missing
build into a test failure instead of a skip, so the job cannot pass without
running the npm checks. To check the fork by hand, prepare it with `--fork`
and set `PI_DELEGATE_FABRIC_REQUIRED=npm,fork`.
