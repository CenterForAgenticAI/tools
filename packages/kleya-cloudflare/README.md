# @centerforagenticai/kleya-cloudflare

The Kleya session host for Cloudflare Workers and Durable Objects (WP-14, RV1). It is unreleased and its surface may still change.

`@centerforagenticai/kleya-cloudflare/object` exports:

- `conversationObjectName({ tenant, conversation })`: the object name. A Worker derives it from the verified tenant and the conversation id, never from the URL alone.
- `forwardToConversation(namespace, identity, request, path)`: sends a request to that object with the identity headers `TENANT_HEADER` and `CONVERSATION_HEADER`. Only `content-type` and `upgrade` are copied from the caller's headers.
- `ConversationHost`: one root conversation per Durable Object. It opens pi-durable on the object's SQLite storage under the journal decorator, sets the recovery alarm, serves turns and the Feed socket, and stops resetting after `maxFailures` consecutive failures.
- `sizeGuard(registry, maxEntryBytes)`: refuses, as a tool error, a tool result too large to store as one entry.
- `parseObjectName(name)`: the inverse of `conversationObjectName`.

Your Durable Object class constructs a `ConversationHost` from its state and forwards `fetch`, `alarm`, `webSocketMessage` and `webSocketClose` to it. `conformance/rv1/worker.ts` is a complete example.

The object refuses a request whose identity headers do not match the tenant and conversation its name encodes. Set those headers only in your Worker, after it has verified the caller.

A turn whose text is larger than `maxEntryBytes` as stored JSON, or whose requestId is longer than 256 characters, is refused with HTTP 413 `too_large` before anything is stored. A Feed frame that is not a JSON object closes its socket with code 1002. A `since` frame's `maxBytes` can only lower the page byte cap; a value that is not a positive finite number is ignored.

The host always installs its size guard. When `settings.extensions` names the extensions to run, the host adds `kleya.size-guard` to that list.

Licence: MIT.
