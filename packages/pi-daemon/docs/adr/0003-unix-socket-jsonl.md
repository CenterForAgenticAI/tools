# ADR 0003 — Use a private Unix socket and JSONL frames

MVP uses one mode-`0600` Unix-domain socket with LF-delimited JSON request, response, and event frames. Filesystem ownership authenticates the local user. The envelope is transport-neutral so a later token-authenticated tailnet transport does not require protocol redesign.

- **Status:** Accepted
- **Date:** 2026-03-12

## Context

Current consumers are local and include TypeScript and Python. They need strict schemas, easy diagnostics, request correlation, session addressing, and streaming. Pi's RPC mode already uses LF-only JSON serialization (`dist/modes/rpc/jsonl.js:5-18`), so an RPC-speaking client can adapt by adding pi-daemon's session envelope.

Remote use needs different authentication and threat analysis. It is not an MVP requirement.

## Decision

The daemon listens at `PI_DAEMON_SOCKET`, otherwise an XDG runtime path with a private state-directory fallback. The parent is mode `0700`; the socket is mode `0600`; ownership and mode are verified before requests are accepted.

Each UTF-8 JSON object ends with LF. Frames use:

```text
{t:"req",id,op,session?,params}
{t:"res",id,ok,result|error}
{t:"ev",session,kind,...}
```

The first request is `hello` with protocol version. A major mismatch is refused. One canonical strict schema source generates TypeScript types and JSON Schema.

Transport authentication happens before `hello`. Nothing in the envelope treats a Unix path, PID, peer credential, or file descriptor as session authority.

## Consequences

- Local access control is small and inspectable.
- Python and TypeScript clients can use the same JSON Schemas.
- Logs and packet captures are readable, so payload logging must still be forbidden.
- An inbound request-size limit and bounded outbound backlogs are mandatory. Outbound response/stream lines have no protocol size cap and clients stream-parse them.
- A future WebSocket or TCP listener can carry the same objects after token/TLS authentication.
- Remote transport, tokens, rate limits, TLS, and origin policy require a new ADR.

## Rejected alternatives

### A. Length-prefixed CBOR through upstream `pi-protocol`

Rejected for this product. The installed protocol uses four-byte length plus CBOR and is experimental with no compatibility guarantee (`node_modules/@earendil-works/pi-protocol/README.md:3-10,44-69`). Its schema lacks this daemon's cursor, UI, lifecycle, and follow-up contract.

### B. Stdio per session

Rejected. It implies one supervised child/channel per session, does not provide a local singleton or multi-session observation, and pushes lifecycle back into every consumer.

### C. TCP/WebSocket in MVP

Deferred. Network exposure needs token issuance, revocation, TLS and ingress ownership, abuse limits, and a security review. Local filesystem permissions are not enough.
