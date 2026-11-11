# @centerforagenticai/kleya-server

The Kleya server runtime, which runs beside pi-durable. It has no root entry: import the subpath you need, for example `@centerforagenticai/kleya-server/grants`.

Status: in progress. Every subpath exists and loads; the ones with a section below have their contents, and the rest arrive with later work packages.

Subpaths: `./grants`, `./context`, `./feed`, `./host`, `./http`, `./node`, `./tools`, `./tools/openapi`, `./interaction`, `./exec`, `./egress`, `./gateway`, `./events`, `./testing`. Only `./node` may use Node APIs; every other subpath runs on Node, in workerd and in browsers.

## `./grants`

Session grants (spec 5.3.1) and `authorize` (5.3.3), ported from the S2 spike. The module imports nothing and uses WebCrypto only, so a product can verify grants on its own HTTP API, not only at Kleya's edge.

A grant is a compact JWS: header `{alg: "EdDSA", typ: "kleya-grant+jwt", kid}`, claims `{iss, aud, sub, ten, hid, role | rights, name?, iat, exp, jti}`. It carries exactly one of `role` or `rights`.

- **Roles** are Kleya's bundles: `viewer` holds `read`; `participant` and `owner` hold `read`, `submit`, `steer` and `cancel` (`ROLE_RIGHTS`).
- **Rights** let a product list its own instead, 1 to 32 lowercase words such as `report` or `answer`. Kleya checks them by name and never widens them. A product's API calls `authorize(principal, hid, "answer", directory)` for its own rights.

The functions:

- `mintGrant({claims, key, lifetimeSeconds})` signs a grant. It sets `iat`, `exp` and a random `jti`, signs the named claims only, and refuses a lifetime over 900 seconds. `generateSigningKey(kid)` makes an Ed25519 key whose `publicJwk` goes to verifiers.
- `IssuerKeyStore` holds each issuer's public keys, looked up by `(iss, kid)`. `setIssuerKeys(issuer, {keys})` replaces an issuer's whole set, which is how keys rotate.
- `verifyGrant(token, {keys, audience, now?, isRevoked?})` never throws. It refuses another algorithm, type or audience, `crit`, an unknown `kid`, a bad signature, an expired or future grant, a lifetime over 900 seconds, a revoked `jti`, and a token over 4096 characters.
- `principalOf(grant)` gives the principal.
- `authorize(principal, hid, right, directory, now?)` checks the session, the tenant and issuer the directory records for it, expiry, and the right.
- `authorOf(principal)` gives a message's author, always from the verified principal.

## `./host`

`createHost({ports, ...})` opens one session per scope and serves it as a `SessionHost`. A platform adapter supplies `ports`: `owner` fences one writer per session, `storage` opens and drops a session's store, and the optional `alarm` wakes a session that is not open.

With `ports.alarm`, the host keeps one alarm per session. `set(id, scope, at)` is called whenever the session's next wake changes: `now() + RECOVERY_DELAY_MS` while a turn runs, so a killed process's turn is resumed; the earliest sleep's time while a task sleeps; `undefined` once nothing is due. The adapter persists it and, when it fires, calls `host.wake(scope)`. Keep `scope` out of file names and logs, and use `sessionName(id)` there. While a session stays open, the host runs its sleeps itself.

- `host.wake(scope)` opens the session, which resumes what its last owner left, or resumes an open one.
- `host.release(scope)` closes one session when it is idle: no turn or task can run and no follow waits. It answers `true` when it closed it and `false` otherwise, and the session stays open. A later `session(scope)` opens the same store, and its cursors read on.
- `host.drop(scope)` closes the session, drops its store and clears its alarm.

## `./node`

`nodePorts({ dir, idleMs? })` gives the host its ports on Node. Each session is one SQLite file in `dir`, named by `sessionName`, never by scope, and the change index is written in the same transaction as each commit, so cursors read on after a restart.

- **One owner per store.** The first `acquire` of a store in a process takes `<name>.lock` in SQLite's exclusive locking mode, which the operating system frees when the process dies, `SIGKILL` included. Another process gets `OwnerBusy`, which the HTTP edge answers `503` with `Retry-After: 1` and no text. In one process each `acquire` raises the epoch, and a store write under an older fence fails.
- **Alarms.** `alarm.set` stores each session's wake in `alarms.db`. `ports.start(host)` arms one timer for the earliest; when it fires it calls `host.wake(scope)`, including for alarms an earlier process stored. A woken session is not woken again for `RECOVERY_DELAY_MS` unless the host sets a new alarm; a wake that fails, such as one another process owns, is tried again after a second.
- **Idle sweep.** `ports.start(host)` also offers each session unused for `idleMs` (default five minutes) to `host.release`, which keeps it open while a turn runs or a follower waits.

```ts
const ports = nodePorts({ dir: "/var/lib/my-product/sessions" });
const host = createHost({ ports, ...options });
ports.start(host);
// at shutdown
await host.close(context);
await ports.close();
```

## `./gateway`

`openRouterGateway({url, secret, models})` is a `Gateway` for `createHost` that reaches OpenRouter models through a gateway service, such as the reference one in `apps/model-gateway`. `models` are OpenRouter ids from pi-ai's catalog; Anthropic models speak Anthropic messages, the rest OpenAI completions. `access` posts the session scope to `<url>/v1/access` with the client `secret` and keeps the credential it gets per scope until a minute before it expires. No option takes a provider key: the service holds it.

## `./http`

`edge(options)` serves the turn API (spec 5.2) as one fetch handler: `(request, context?) => Promise<Response>`. It runs on Node, in workerd and in browsers.

Routes, under `<base>/<key 1>/…/<key n>`:

| Route | Answer |
|---|---|
| `POST submit` with a `SubmitBody` | `202` and `Accepted` |
| `POST turn` with a `SubmitBody` | submit, then the turn's pages as a stream. This is the optional wrapper. Closing it never aborts the turn. |
| `GET events?after=` | session follow, as a stream. With `wait=<seconds>`, one `SessionPage` as JSON. |
| `GET turns/<id>?conversation=` | `TurnStatus` |
| `GET turns/<id>/events?after=&conversation=` | follow, as a stream. `Last-Event-ID` stands in for `after`. With `wait=<seconds>`, one `TurnPage` as JSON. |
| `POST turns/<id>/abort` with an `AbortBody` | `TurnStatus` |

What the edge does on every request, in order:

1. **Authenticate.** `authenticate(request)` returns the caller and, optionally, the turn's product credential. Without it the answer is `401`. The body never names who submits or the credential. Two helpers make one. `bearerToken({token, caller, scope})` is for a service token of at least 32 characters, compared in constant time over SHA-256 digests. `grantAuth({keys, audience, directory, isRevoked?})` is for a session grant (see `./grants`): the caller is the grant's `sub`, with each Kleya right that `authorize` allows in the grant's own Harness, and the edge refuses every other scope with `403`. No helper reads a principal from a header.
2. **Parse the path.** Malformed percent-encoding answers `404`, never `500`.
3. **Authorize the scope.** `authorize(caller, scope)` runs before `session(scope)` opens anything. A refusal answers `403`, whether or not the scope has a session.
4. **Read the body.** A POST must be `application/json`; anything else answers `415`. A body is bounded while it streams, chunked or not, and over `LIMITS.bodyBytes` answers `413`.

Streams are SSE, or NDJSON when the request accepts `application/x-ndjson`. One SSE message or NDJSON line is one whole page, with the page's cursor as the SSE `id`. A failure answers `503` with `Retry-After` and none of the error's text. A stream that fails after its first page ends with a bare error frame instead. A `busy` refusal answers `429` without `Retry-After`.

**A page of events.** A client that cannot read a stream, such as a herdr-app mod whose `fetch` returns only a whole body, adds `wait=<seconds>` to either follow route. The edge then reads until a page has events or the turn ends, or until `min(wait, LIMITS.pageWaitMs)` (25 s) has passed, and answers that one page as `200` JSON, the same `SessionPage` or `TurnPage` a stream sends as one frame. A page with nothing new carries the cursor to ask from next. `wait` is a whole number of seconds, and anything else answers `400`. Authentication, authorization, cursors and errors are the stream's. After a page with events, ask again at once.

**CORS.** The edge sets no CORS headers, and adding them is the product's job. Requiring JSON keeps a cross-site form post from reaching a product that authenticates with cookies, but it is no CORS policy.

## `./tools`

`productTools({name, origin, tools, fetch?, timeoutMs?})` turns a product's HTTP operations into a pi-durable extension. Each operation becomes a tool. Install the extension in the registry you hand `createHost`.

An operation, an `HttpTool`, names its `method`, its `path` below the origin (such as `/tenants/{tenant}/notes/{note}`), the `parameters` the model may send, and its `bound` keys. Bound keys are scope keys the host fills from the conversation's context (`HostOptions.context`), never from the model.

`productTools` throws at definition when:

- `origin` is not a bare origin: it has userinfo, a path, a query or a fragment;
- `origin` uses http on a host that is not loopback;
- a schema is not an object schema with `additionalProperties: false`;
- a schema declares a bound key at any depth, or uses `patternProperties`;
- a parameter or bound key is named `__proto__`;
- a bound key is named after any other Object.prototype member, such as `constructor`, `toString` or `hasOwnProperty`;
- a path placeholder is neither a parameter nor a bound key, or does not fill one whole path segment;
- a path does not start with one `/`, or does not survive URL parsing unchanged. This refuses tab, CR, LF, `\`, dot segments, `?`, `#`, spaces and other characters that need encoding;
- a method is not `GET`, `POST`, `PUT`, `PATCH` or `DELETE`;
- two tools have the same name.

A call:

- Reads each bound key from the conversation's context. When a key is missing, the call fails and sends nothing.
- Sends the turn's product credential (`turnCredential`) only to `origin`, only as `Authorization: Bearer`, and with `redirect: "error"`. When the turn has no credential, nothing is sent.
- Builds the request from named fields only. Path values are percent-encoded; `.`, `..` and empty values are refused. A GET sends the other fields as its query, and other methods send them as a JSON body.
- Sends `Idempotency-Key: kleya1.<base64url SHA-256>` on every write. The key is a hash of the session id, the store's id and the call's task id, so one call keeps its key across retries and restarts. A dropped and recreated store gives new keys.
- Reads at most 1 MiB of the response. A longer one stops the read and becomes the error result `response too large`; no part of it is kept.
- Replaces every copy of the credential in a result or error text with `[redacted]`.

No scope key may be named after an Object.prototype member, anywhere. Besides `productTools`, three more places refuse one:

- the host, on every session open, for each key `HostOptions.context` returns;
- `writeContext`, so a tool cannot add such a key either;
- `contextBinder`, at definition, for each required key.

The extension's guard blocks a tool call, for any tool in a conversation that selects the extension, when an argument key at any depth names a bound key or a key in the conversation's context. A key is NFKC-normalised, split into words at separators, case changes, letter-digit boundaries and inside capital runs, and lowercased. It names a bound key when a run of its words, joined, equals the bound key's words joined, optionally followed by `s`, `id`, `ids`, `key`, `keys`, `name`, `names` or `uuid`. So for bound key `tenant`, `tenantId`, `tenant_ids`, `tenantid` and `TENANTID` are blocked, and `content` and `lieutenant` are not. The block names the key and never its value.

A crash during a call follows the call's effect class. `effect` defaults to `read-only` for GET and to `once-only` otherwise. A `once-only` call is never sent again; the model gets an `interrupted` error.

`./tools` loads pi-durable when imported. Its guard is a pi-durable hook, which must exist when `productTools()` runs, and a product imports `./tools` only to build the registry it gives the host.

Licence: MIT.
