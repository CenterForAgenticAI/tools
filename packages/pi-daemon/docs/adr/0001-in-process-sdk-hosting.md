# ADR 0001 — Host pi sessions in process through the SDK

pi-daemon will create pi sessions inside the daemon process with an injected `SessionManager` and `ResourceLoader`. It will not supervise `pi --mode rpc`, adopt the upstream experimental server protocol, or modify pi core. Daemon-owned worker processes that still embed the SDK are the later hardening path.

- **Status:** Accepted
- **Date:** 2026-03-12

## Context

The product needs pi's session JSONL to remain the sole historical record and needs daemon records in that same tree. The public factory accepts `sessionManager` and `resourceLoader` (`dist/core/sdk.d.ts:10-56,73-107`). `SessionManager.appendCustomEntry()` adds entries that do not enter model context (`dist/core/session-manager.d.ts:59-73,224-225`; `docs/session-format.md:263-271`). Those host seams are available only when pi-daemon owns the SDK objects.

Installed 0.84.4 returns `session`, `extensionsResult`, and optional `modelFallbackMessage`; it does not return `runtime?` (`dist/core/sdk.d.ts:57-65`). `AgentSessionRuntime` is a separate replacement API (`dist/core/agent-session-runtime.d.ts:44-93`).

The upstream `@earendil-works/pi-protocol` is explicitly experimental, uses length-prefixed CBOR, and has no compatibility guarantee (`node_modules/@earendil-works/pi-protocol/README.md:3-10,44-69`). Its command union contains only list/create/attach/detach/prompt/steer/abort/set_model/set_thinking (`node_modules/@earendil-works/pi-protocol/dist/schemas.d.ts:1731-1820`).

## Decision

Each awake session is an in-process `AgentSession` created by:

```ts
createAgentSession({ sessionManager, resourceLoader, ...options })
```

The daemon binds its own headless UI context, observes persistence, and appends only namespaced custom entries through the SDK. One daemon process may own several awake sessions, subject to the Wave-0 extension-isolation policy.

## Consequences

- The pi file can hold conversation and daemon records in one append-only tree.
- The daemon can use direct SDK prompt, queue, abort, subscription, UI, and cold-read APIs.
- A faulty extension, tool, native module, global mutation, or unhandled process error can affect every awake session.
- M0 must test shared ESM state, cwd/environment changes, listeners, and timers before unrestricted concurrency.
- A later coordinator/worker topology may isolate failures while each worker still embeds the SDK. That needs a superseding ADR; it is not MVP and not RPC mode.
- Every SDK update must pass the fail-loud compatibility stamp.

## Rejected alternatives

### A. Upstream `pi-server` / `pi-client` / `pi-protocol`

Rejected for MVP. The 0.84.x protocol is experimental CBOR with a fixed command schema. It lacks follow-up, extension UI responses, committed-entry replay cursors, daemon custom-entry semantics, and the required consumer state. Extending it would require changes to pi core and still would not give this daemon ownership of the hosted `SessionManager`.

### B. Supervise `pi --mode rpc` subprocesses

Rejected. A subprocess boundary hides the SDK and manager. The daemon could not append its records through `SessionManager.appendCustomEntry()` or observe the exact commit boundary. It would force a second history store or an unsupported direct file writer.

### C. Session-host worker processes now

Deferred, not rejected permanently. They cost IPC, lifecycle, extension-loading, and fault-recovery complexity before measurements show a need. If adopted, they run our SDK host, not `pi --mode rpc`.
