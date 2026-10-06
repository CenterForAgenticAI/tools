# Routing and recovery

For operators and integrators: route order, logical-model behavior, exact-model resolution, metered fallback, and recovery boundaries.

## Routing behavior

The route order is:

1. another healthy subscription account in the turn's starting family;
2. a same-vendor account that uses the vendor's own pay-per-token API;
3. an explicitly configured cross-vendor subscription destination;
4. explicitly enabled OpenRouter with a successful budget reservation;
5. a bounded parked turn that waits for a permitted managed account to recover.

A **parked turn** is held without replaying the failed request. The extension
re-checks live account state for up to 30 minutes. `/multi-account stop`
cancels it.

Routing has these guarantees:

- Same-family subscription failover prefers an eligible account whose catalog
  serves the active model. If none does, routing may choose another eligible
  subscription account and use its catalog head.
- The owning-vendor API tier stays within the model's vendor. It uses the exact
  requested model ID when the destination catalog contains it, then a matching
  `tierModelMap` entry. If neither is available, that account is skipped. It
  never substitutes the account's catalog head.
- Cross-family subscription failover is directional and disabled by default.
  It uses the first supported model in `preferredModels` for the destination
  family, then its catalog head if no preference is supported.
- Parked recovery keeps the same family policy as the failure that created it.
  Polling does not create cooldowns or widen the route.
- A confirmed switch sends one fixed follow-up message with `deliverAs:
  "followUp"`. It never resubmits the original prompt or provider request.
- A failed model selection sends no follow-up.
- Two 429 responses within 15 minutes temporarily invalidate an optimistic usage
  reading. A provider snapshot cannot keep an account selectable while live
  requests prove that it is limited.
- Authentication refresh is bounded to one forced attempt per provider and
  session. A changed account identity is rejected rather than silently replacing
  the selected account.
- Watchdogs cancel stalled continuations. Every timeout is retained as a
  diagnostic, while identical operator notices are limited to one per 15
  minutes across continuations.

Pi performs its own provider retries before the extension acts. Reactive routing
runs at `agent_settled`, after Pi's retry and compaction loop has finished. A
visible pause before failover is normally Pi's backoff, not an extra retry made
by this extension.

## Delegate account-group confinement

In-process and durable delegate children inherit the parent's complete cached
effective account group at startup and resume. This covers session overrides,
exact-cwd defaults, global defaults, and unrestricted results. The original source
is retained. No child-cwd rule can replace that inherited result, including when
the child's cwd has no exact default. Each child caches the same result under its
own session id, so nested in-process and durable descendants inherit it too.

Missing, malformed, or duplicate parent origin, or an absent or unreadable parent
cache, blocks physical requests. It never permits fallback to child-cwd policy.
`/multi-account group status` reports the held effective policy without resolving
or rewriting it. Explicit operator `group use` and `group reset` remain available
and resolve this session's own policy after startup; they are not agent-tool
actions. Delegate resume applies parent inheritance again.

## Unified logical model provider

The extension can register one extra provider, `unified`, whose models come from
the managed subscription catalogs. A unified OpenAI model can run on either an
`openai-codex` subscription or the owning-vendor `openai` API tier. Routing tries
eligible subscriptions first. It uses the API tier only when the exact model ID
is in that tier's catalog or `tierModelMap.openai` explicitly maps the unified ID
to a catalog model. An unresolved API model is skipped; routing never chooses the
API catalog head as a substitute.

Public assistant stream events, including the final result, carry `unified` as
provider and API and the selected logical model ID. Physical account identities
remain private to routing and usage attribution. When a logical turn finishes,
the extension records its token usage and retained provider cost under the
physical account that served it, never under `unified`. A subscription-tier turn
records subscription usage and cost; an owning-vendor API-tier turn records
provider cost only, not subscription usage. It also records normalized rate-limit
observations when the physical transport exposes response headers. Anthropic
does. Codex does on SSE, but `openai-codex-responses` does not call `onResponse` on its WebSocket branch.
Logical Codex header observations are therefore absent on WebSocket; the existing
five-minute usage poll remains the fallback.

While a `unified` model is selected, Pi renders `(unified)` in its model line and
shows one compact, right-aligned below-editor route widget under model/thinking status.
It starts at `unified(waiting)`, then shows the exact physical account serving an
attempt and its live usage, such as `unified(anthropic-account-2 · 75% left)`.
A configured account label appears last inside the parentheses. An in-call
recovery send replaces the account with the new exact route. Selecting any physical or unrelated provider
removes the widget.

The indicator uses the same machine-shared quota observations as the status view.
Fresh utilization leads; fresh request or token counts are used only when utilization
is absent. Old quota is shown as `usage stale`, and an account with no quota
observation is `usage unknown`; stale values never appear as current headroom. An
optional account label is read from live config on every render and appears last.
Updates are event-driven by model selection, route attempts, usage observations, and
terminal settlement. The indicator creates no timer, polling loop, retained record,
or diagnostic state.

### In-call recovery

A `unified` call recovers an account failure inside the same logical call,
through the recovery engine, instead of through host retry or a settled
continuation. The rules are fixed:

- At most two physical provider sends per logical call. The first send uses the
  exact selected account and model. The one recovery action changes the account
  only, to another eligible account of the same vendor that serves the same
  model. It never changes the model. With `sameFamilyFailover: false` there is
  no recovery action: every `unified` call is one attempt. The setting is read
  per call, so `/multi-account reload` applies to the next call.
- Every physical send carries `maxRetries: 0`, so a provider SDK adds no sends of
  its own.
- Output means assistant content: a text, thinking, or tool-call event. The
  provider's `start` event is not output. pi-ai sends it as soon as the response
  headers arrive, before any content, so each attempt's leading `start` is held:
  it is not published and does not count as progress. A failure after a held
  `start` but before content is a failure before any output, and the failed
  attempt's `start` is never published; after a recovery send the consumer sees
  only the second attempt's `start` and events. A successful terminal with no
  content is published as its held `start` and then the terminal.
- Output streams live. The first content event hands the attempt to the
  consumer, preceded by that attempt's one held `start`, and nothing after it is
  ever sent again: a later failure ends the call with the bounded text `Unified
  recovery stopped after its bounded provider attempt.`, which the host does not
  retry.
- Recoverable before any output: an account-local rate limit or quota, an
  account-local authentication failure, and a pre-start transient (a network or
  transport failure, a 5xx, a retryable setup failure, or a stall before the
  provider's `start`). The failed account is cooled
  exactly as before. A caller abort while a `start` is held aborts the live send
  and ends the call with no recovery send.
- A structured refusal or unknown stop is an outcome, not a failure. It is sent
  once, cools nothing, and the consumer receives the provider's own text and its
  `code`.
- A context overflow is sent once. A setup-shaped overflow is published as
  `context_length_exceeded (provider_error)`, so the host still compacts.
- A route served through `tierModelMap` under a different API model ID is one
  attempt with no in-call recovery.
- Routed Codex calls are pinned to SSE and may recover. A Google Antigravity
  attempt has an unknown inner send count, so it is never followed by a recovery
  send.
- `recoveryStallTimeoutMs` (default three minutes) bounds the wait for a
  physical attempt's `start`, opening included. After `start` the provider has
  answered and a model may think silently for minutes, so later waits are not
  stalls: `recoveryIdleTimeoutMs` bounds the wait for the first content and
  `recoveryAbsoluteTimeoutMs` bounds the whole call.
- Anthropic attempts also report connection activity, keep-alive pings
  included. Each report restarts the idle wait, so a model thinking silently
  is never cut off while its connection is alive. Once an attempt has reported
  activity, 90 seconds without a single byte ends it as a dead connection.
  Before any output that is a pre-start transient and recovers on another
  account; activity is not output and never blocks recovery.
- The host's own retry and the settled continuation are not used for `unified`
  turns. A failed unified call ends with a final message the host does not
  retry; the operator can resend.

Selection is exact. A request for a model ID no account serves is refused, not
redirected. A cross-tier ID may differ only when the operator records that model
identity in `tierModelMap`. Substituting a catalog head, a same-family sibling,
or a vendor default would quietly run a different model than the one that was
chosen, and the reply would look entirely normal.

The provider's own rows are never marked enabled or disabled. Which models
appear in the picker is Pi's decision, expressed through its `enabledModels`
setting, and this extension does not write that setting on the operator's
behalf.

A model id served by more than one managed family is left out of the
declaration and reported. No tie-break can be right without knowing which
vendor was meant, and guessing would send the request to the wrong one.

Two commands manage the declaration in Pi's `models.json`:

| Command | Result |
| --- | --- |
| `/multi-account models install` | Write the declaration and approved Codex context defaults. Refused if a declaration is already present. |
| `/multi-account models update` | Refresh the declaration and approved Codex context defaults from the current catalogs. Refused if no declaration is present. |
| `/multi-account model [id]` | Select an exact logical model, or open the logical model picker when `id` is omitted. |
| `/multi-account-model [id]` | Deprecated one-release alias for `/multi-account model [id]`; it prints a migration notice and otherwise behaves identically. |

Pi checks the declaration once at session start. A stale declaration still
registers the fresh live projection, so logical routing stays on, while a warning
and `/multi-account status` banner point to `/multi-account models update`. An
unreadable declaration keeps logical routing off and shows the same update remedy.
A declaration that is not installed leaves the logical provider unregistered and
stays silent at startup; use `/multi-account models install` to add it. Startup
warnings appear at most once per machine per UTC day. A stale status banner stays
visible for the session until the declaration is updated and Pi restarts.

Both commands show the declaration and Codex override changes, then wait for
confirmation. The offline-approved defaults supply `contextWindow: 1050000`
when needed for `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, and `gpt-6-astra`. During these explicit commands only, other
lowercase, versioned IDs already in the live Codex catalog can receive the same
default when that exact model's
`https://developers.openai.com/api/docs/models/<id>.md` page names the exact ID
and lists a `1,050,000 context window` under Model details. Documentation reads
send no credential or prompt, follow no redirects, and have fixed candidate,
time, and response-size limits. When more than eight valid IDs need evidence, a
UTC-day rotating window checks at most eight and reports the remainder as skipped.
Offline, malformed, mismatched, or otherwise unverified pages add no default; the
confirmation shows only a bounded reason-count summary. Every explicit install or
update verifies new IDs again; a prior override or `unified` row is not evidence.
A live catalog window already at or above `1050000` requires no new override. For
one of the six offline-approved IDs, an update removes a prior transaction-managed
`contextWindow` so the higher live value wins, preserving every other override
field and deleting the entry only when nothing remains. Operator-owned overrides
for IDs outside the offline-approved list are always retained; exact documentation
can create a missing dynamic override and project the default into `unified`, but
it does not rewrite an existing one.

The current transaction's offline-approved and newly verified ID-to-window map
powers both physical override changes and generated `unified` rows. An existing
dynamic override can therefore differ from its `unified` row: verified rows use
the documented default there, while unverified rows continue to copy the current
live catalog. Every other catalog field,
including `maxTokens` and tiered cost metadata, is preserved. This metadata
preservation does not make the separate API-equivalent estimate tier-aware.

Before reading the live catalog or model documentation, the command validates
every existing `openai-codex.modelOverrides` entry against Pi's supported shape.
If the container or any entry is malformed, it leaves the file unchanged and
does not ask for confirmation.

A successful install or update removes the old `pi-multi-account` provider entry
only when its API and reserved base URL identify it as this extension's previous
declaration. The transaction otherwise owns the `unified` declaration and the
resolved `contextWindow` fields above. It leaves every other provider, override,
and field structurally untouched: each value parses back deeply equal to the one
it replaced. The file is rewritten with standard JSON formatting, so original
indentation, number spelling, and string escapes are not preserved character for
character.

The write is atomic: the candidate goes
to an owner-only temporary file beside the target and is renamed into place, so
no reader ever sees a half-written file. If the file changes between the read
and the write, the command aborts rather than overwriting the other writer.

Before `/multi-account models update`, make a byte-for-byte backup of `models.json`
and set its mode to owner-only (`0600`). A successful update keeps no extra copy.
To roll back, restore that backup to the same path and restart Pi. The older
declaration may remain unavailable until a later update, but physical aliases and
session history are unchanged.

### Switching logical models

Use the operator-only `/multi-account model` command to choose a logical model
without changing account policy:

```text
/multi-account model
/multi-account model gpt-5.6-luna
/multi-account model unified/gpt-5.6-luna
```

The deprecated `/multi-account-model [id]` alias remains for one release. It
prints a one-line notice pointing to `/multi-account model` and then follows the
same selection path.

With no argument, the command opens a searchable terminal picker. It shows only
currently available `unified` rows, in live catalog order, narrowed by
`enabledModels` or `--models` when the session has a non-empty scope. An empty
scope admits every available logical row. Each picker row renders
`<model-id> [unified]`; selection keeps the canonical bare `<model-id>` as the
model identity and never changes it to `unified/<model-id>`. Search is an
order-preserving filter over exactly five fields for each row: `unified`, the
legacy `pi-multi-account` search alias, `unified/<model-id>`, the bare `<model-id>`,
and the configured display name.

An argument must be one exact bare model ID or one exact
`unified/<model-id>` reference. Slashes inside a model ID are preserved.
Partial, fuzzy, duplicate, foreign-provider, unavailable, and out-of-scope
references are refused. The no-argument picker requires terminal UI; the direct
form remains deterministic in RPC and print contexts.

Cancellation leaves the current model unchanged. If Pi refuses or throws while
selecting the exact model, the command reports that refusal and leaves the
extension's active-model projection unchanged. Recovery output distinguishes a
missing declaration (install it), an unusable declaration (update it), scope,
availability, and invalid references. A successful `pi.setModel` call may add
Pi's normal `model_change` and `thinking_level_change` session entries. The
extension does not write those entries, settings, declarations, credentials,
retained state, or history, and the command is not available to the
`multi_account_status` agent tool.

## Exact-model route resolver

The package root exports `resolveExactModelRoutes`, the request and result
TypeScript types, and `publishRouteResolver` / `lookupRouteResolver`. The
resolver is a read-only, credential-free policy boundary for consumers that
need exact managed routes. It does not select Pi's active model and no current
foreground or reactive path consumes it.

The process-local discovery key is
`Symbol.for("@caair/pi-multi-account/route-resolver")`. Its stored value is
an immutable `{ purpose: "exact-model-routing", version: 1, resolve }` service.
`lookupRouteResolver()` returns exactly one of `absent`, `incompatible`, or
`available`. It reads only an own data-property descriptor, never invokes a
registry accessor, and catches hostile structural inspection. Every present
malformed value maps to `incompatible`. An available service may still return
`unresolved` with `reason: "no-eligible-routes"`; that is different from absent
discovery.

Version 1 requests contain `purpose`, `version`, and an exact `modelId`, with
optional `family`, `preferredProviderId`, and `excludedProviderIds`. A bare
model ID infers its family only when exactly one managed family advertises it.
A supplied family must advertise it. A model written as
`provider/model` is physical intent when `provider` is a canonical managed
provider ID; everything after the first slash remains the exact model ID and
only that provider may be returned.

A resolved result has `reason: "eligible-routes"` and an immutable ordered
`routes` array. Each route contains only
`{ providerId, modelId, family }`. An affinity preference can reorder eligible
routes but cannot admit one. Exclusions, disabled or cleared accounts,
cooldowns, invalidation, exhaustion, dead credentials, duplicate or malformed
accounts, unsupported model observations, and missing catalog membership are
filtered before serialization. Unresolved reasons are closed:
`invalid-input`, `unsupported-purpose`, `incompatible-version`,
`unknown-model`, `ambiguous-model-family`, `family-model-mismatch`, and
`no-eligible-routes`.

Each version-1 publication replaces the frozen public facade with a new one, but
every reload-safe facade — including one a consumer retained before a reload —
dispatches through a process-local coordinator to the newest live session owner,
so a consumer does not have to look the service up again. When a session shuts
down, its owner is revoked before Pi invalidates the extension context. Between
that revocation and the next publication, and after the final owner is revoked,
a retained facade returns `unresolved` with `reason: "no-eligible-routes"`
without reaching any stale context; a fresh `lookupRouteResolver()` normally
becomes `absent` because the public slot is deleted. A higher version is
retained only when its purpose matches exactly, its version is finite and
greater than 1, and its resolver is callable; it remains `incompatible` to this
version-1 lookup contract. Malformed higher, same-version, older, and
accessor-backed values are replaced when the registry slot is replaceable.
Consumers should handle `absent` and `incompatible` as no resolver, and inspect
the result status separately when the service is available.

The first deployment of the coordinator-backed resolver, and any rollback from
it, requires a full Pi process restart, not only `/reload`: a facade created by
the older direct-closure build is frozen around the old function and cannot be
rewritten in place. The reload guarantee also covers only the paths that emit
`session_shutdown` before invalidation — the pinned reload path and
`AgentSessionRuntime` replacement or disposal. A direct low-level SDK call to
`AgentSession.dispose()` emits no such event and stays outside the guarantee; an
SDK integration that loads this resolver must use `AgentSessionRuntime`, or emit
and await `session_shutdown`, before disposing directly.

## Optional OpenRouter last resort

OpenRouter requires credentials available to Pi plus three extension policy
variables in the non-delegate Pi session. Authenticate with Pi's OpenRouter
OAuth `/login` flow or provide `OPENROUTER_API_KEY`. For example:

```sh
export OPENROUTER_API_KEY='<secret>'
export PI_MULTI_ACCOUNT_OPENROUTER_ENABLED=conversation-egress
export PI_MULTI_ACCOUNT_OPENROUTER_MODEL='<provider>/<model-id>'
export PI_MULTI_ACCOUNT_OPENROUTER_DAILY_USD_LIMIT=10
```

After authenticating, run `pi --no-extensions --list-models openrouter`.
Copy the model column only from a row whose provider column is exactly
`openrouter`. The extension rejects `~`-prefixed aliases and rows from providers
such as `openrouter-plus`. Replace the placeholder before starting Pi.

The exact enable value records consent to send the conversation outside the two
managed subscription families. Any missing, malformed, or partial setting keeps
the rung disabled. The daily limit must be greater than zero and no more than
`1000`, with at most four decimal places.

`PI_MULTI_ACCOUNT_OPENROUTER_MODEL` is the default OpenRouter destination when
`tierModelMap.openrouter` has no entry for the turn's original model. At runtime,
the extension applies that default only to the current source model; it does not
create or accept a `"*"` map entry. A specific map entry wins. The resolved ID
must exist in the live OpenRouter catalog and have bounded pricing; otherwise the
turn parks without a reservation.

Before each metered turn, the extension reserves a conservative worst-case cost
from Pi's live model catalog. Reservations are machine-global, per project, and
per UTC day. They are stored under a bounded `project-<digest>` key in
`openrouter-budget.json`. A missing file means zero reserved. A malformed file,
failed lease, unknown price, or uncertain write disables the rung for that turn.
Reservations are not reduced or refunded after a response. One OpenRouter
provider failure disables the rung for the rest of the session.

OpenRouter is never sticky. Before another metered reservation, the extension
checks managed accounts again. Any available subscription account still blocks
OpenRouter as before. An owning-vendor API account blocks it only when that
account can resolve and serve the turn's original model. Delegate environments
identified by `PI_DELEGATE_LINEAGE_*` cannot use this rung.

## Known boundaries

- Pi defaults to three retries for a retryable provider error before
  `agent_settled`; Pi settings can change that count. This extension cannot
  suppress the host retry layer.
- Same-turn replay is intentionally excluded for aliases and base providers.
  Recovery uses a fixed continuation message after settlement. The only
  exception is `unified` in-call recovery before any output; see
  [In-call recovery](#in-call-recovery).
- Provider usage endpoints are not guaranteed to be available. Fetches time out,
  fail soft, and report their bounded state.
- Only sessions that load this extension can use its failover lifecycle. At this
  release, the `pi-delegate` package may load project extensions in workers, but
  its isolated supervisor and collapse sessions run with extensions disabled.
  Provider errors from those calls are outside this package.
- The current `pi-fork-delegate` repository's worker runtime can discover
  numbered alias models yet fail to resolve their alias credentials. Use a base
  provider for delegated work until the upstream runtime fix is deployed and
  verified.
- OpenRouter is a non-delegate-session escape hatch, not a delegate fallback and
  not a replacement for managed OAuth accounts.
- Cross-family subscription model IDs are not portable. Configure
  `preferredModels` for every enabled subscription destination family or accept
  its catalog head. Owning-vendor API and OpenRouter routes instead use
  `tierModelMap` and fail closed rather than choosing a catalog head.
- The `config.lock` lease binds cooperating Pi processes. An editor that ignores
  it can still replace the file. `configure` narrows that window by re-reading
  under the lease, but a change landing between that read and the atomic rename
  is not detectable.
- `google-antigravity` invocations have an unknown provider send count.
  Recovery passes `maxRetries: 0`, but the vendored stream ignores it and can
  resend inside one invocation across empty-response retries, runtime-model
  candidates, and three endpoint fallbacks. Recovery therefore reserves an
  unknown count for Antigravity, never uses an Antigravity candidate for the
  recovery send, and stops with `uncertain-external-effects` after a failed
  initial Antigravity attempt. The at-most-two-sends guarantee does not hold for
  Antigravity calls; only the two-invocation bound does.
- Automated verification never performs a real Google sign-in. Exercising a
  live `google-antigravity` account end to end is an operator action performed
  after `integration:verify` passes, the same deferred pattern already used for
  Anthropic and Codex.
