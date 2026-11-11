# @centerforagenticai/kleya-cloudflare

The Kleya session host for Cloudflare Workers and Durable Objects. Its surface may still change.

Each session is one Durable Object, named `harnessIdOf(scope)` from `@centerforagenticai/kleya-server/host`. Inside the object runs the host core, over ports on the object's own SQLite storage. The Worker runs the HTTP edge from `@centerforagenticai/kleya-server/http` unchanged and reaches the object with one RPC call per operation.

`@centerforagenticai/kleya-cloudflare/object` exports:

- `sessionObject(ctx, options)`: the object's methods (`submit`, `status`, `follow`, `abort`, `followSession`, `alarm`, `close`). `options` are the host core's `HostOptions` without `ports`, plus `maxFailures`, `stopMs`, `maxEntryBytes` and `report`. Your Durable Object class builds one in its constructor and forwards its RPC methods and `alarm` to it.
- `objectSession(stub, scope)`: the `SessionHost` the edge's `session` hook returns, as in `session: (scope) => objectSession(env.SESSIONS.getByName(harnessIdOf(scope)), scope)`.
- `sizeGuard(registry, maxEntryBytes)`: refuses, as a tool error, a tool result too large to store in one row. `sessionObject` installs it; when `settings.extensions` names the extensions to run, it adds `kleya.size-guard` to that list.
- `MAX_FAILURES` (3), `STOP_MS` (5 minutes) and `MAX_ENTRY_BYTES` (1,900,000), the defaults; and the types `SessionObject`, `SessionObjectOptions`, `SessionStub`, `ObjectState` and `ObjectEvent`.

`conformance/rv1/worker.ts` is a complete example.

## What the object does

- It serves only the scope its name encodes. Every method takes the scope and refuses any other, so the Worker must still authorize the caller for the scope before it calls.
- Its alarm wakes the session at the core's next wake, and a running turn keeps an alarm within the recovery delay. A turn interrupted by an eviction resumes from the alarm. A model request in flight at the eviction is not resent; it fails under `settings.retry` with reason `interrupted`.
- A failed open, or a storage failure in an open session, counts as a failure. The object writes the count, waits for `storage.sync()`, and resets itself with `ctx.abort()`. After `maxFailures` consecutive failures it refuses every call for `stopMs`, and the edge answers 503 with `Retry-After: 1`. The first call after the stop opens the session again. A turn that ends with an answer clears the count.
- `documentRetentionMs` and `contextRetentionMs` default to 0, because a retention timer keeps the object from being evicted. You may override them.
- It sets no SQLite pragma: the object's storage is the platform's.

The object's own tables stay bounded: the change index keeps 10,000 commits, and the object keeps one alarm row per session and one failure row. The host core prunes request records: each shrinks to a seen marker after 7 days, and the marker is deleted after `markerRetentionMs` (90 days by default). See spec 5.2 "Retention".

Licence: MIT.
