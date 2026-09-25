# Programmatic runtime API

`createDelegateRuntimeClient({ context })` exposes the production delegate core
to another co-resident Pi extension. The client has exactly five operations:

- `dispatch` (`direct` and `managed` are aliases): submit one ordinary
  `delegate` request and immediately receive a durable receipt.
- `status`: read one run's uniform current status.
- `harvest`: read one run's typed result and execution provenance.
- `steer`: use the existing in-process/detached/nested delivery ladder.
- `cancel`: use the existing destructive terminal/control-route behavior.

There is intentionally no wait, poll, loop, sequence, or retry primitive. A
caller owns those decisions. `dispatch` forces asynchronous mode and rejects an
`edit` claim because pi-delegate does not enforce one.
Submission/control failures throw `DelegateRuntimeError` with a stable `code`
(for example `unknown-agent`, `model-unavailable`, `invalid-confinement`,
`input-unreadable`, or `control-unavailable`) instead of requiring callers to
parse prose.

`reads` and `worktree: true` are deliberately incompatible in this API. The
isolated tree can differ from the caller checkout, so pre-dispatch code cannot
truthfully attest the bytes the worker will read; the combination fails before
creating a run.

```ts
import { createDelegateRuntimeClient } from "@centerforagenticai/pi-delegate";

const delegate = createDelegateRuntimeClient({ context: ctx });
const receipt = await delegate.dispatch({
  agent: "reviewer",
  task: "Judge the named inputs against the rubric.",
  reads: ["report.md", "rubric.md"],
  model: "quality",
});

// Later, in response to the ordinary completion event/wake:
const result = await delegate.harvest(receipt.runId);
```

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
  At shutdown, pi-delegate first aborts its active runs and publishes
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
hashed exactly as submitted. Every `reads` entry hashes the file bytes, not the
path. Unreadable named inputs fail before dispatch, so a receipt never claims
evidence it could not observe.

`result.json` is published automatically when a receipted run terminates,
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
