# pi-multi-account

`pi-multi-account` keeps Pi working when an Anthropic or OpenAI Codex OAuth
account reaches a limit or loses authorization. It registers numbered account
aliases, observes provider health, and moves a settled turn to an eligible
account. **Failover** means moving that turn after the active account fails.

The extension is OAuth-first. Credentials remain in Pi's `AuthStorage`.
Discovery uses Pi's public credential adapter first and a narrow read-only
`auth.json` fallback when that adapter is unavailable. Both paths project only
presence, expiry, a derived fingerprint, and an optional Codex label. Raw values
do not leave that boundary. The package never writes `auth.json` or puts tokens
in its own state or diagnostics. OpenRouter is available only as an explicitly
enabled, budgeted final rung in a non-delegate Pi session. It is off by default
and blocked inside delegate sessions.

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
A configured account label appears last inside the parentheses. A retry replaces
the account with the new exact route. Selecting any physical or unrelated provider
removes the widget.

The indicator uses the same machine-shared quota observations as the status view.
Fresh utilization leads; fresh request or token counts are used only when utilization
is absent. Old quota is shown as `usage stale`, and an account with no quota
observation is `usage unknown`; stale values never appear as current headroom. An
optional account label is read from live config on every render and appears last.
Updates are event-driven by model selection, route attempts, usage observations, and
terminal settlement. The indicator creates no timer, polling loop, retained record,
or diagnostic state.

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

## Accounts

The managed physical families are:

- `anthropic` — an OAuth credential is a subscription; an `api_key` credential
  is the Anthropic owning-vendor API tier;
- `openai-codex` — the ChatGPT/Codex subscription tier;
- `openai` — the OpenAI owning-vendor API tier;
- `google-antigravity` — the Google Antigravity subscription tier. It has no
  owning-vendor API tier: unlike `anthropic`/`openai`, there is no separate
  pay-per-token `google` family, so a `google-antigravity` slot is always an
  OAuth subscription account.

Proactive subscription routing, OAuth usage fetching, and the version-1
exact-model resolver remain limited to `anthropic` subscriptions and
`openai-codex`. The logical provider itself also routes an owning-vendor API
tier as a same-vendor fallback — the OpenAI `openai` API tier, and an Anthropic
`api_key` account as the Tier-2 destination described next. An Anthropic `api_key` account is not a Tier-1 peer and is
not a Codex-origin cross-vendor destination. It is reachable only as the
same-vendor Tier-2 destination of a turn that started on an Anthropic
subscription.

Each family has a base provider ID and numbered aliases from `-account-2` up to
`accountLimit`. With the default limit of four, the Codex IDs are
`openai-codex`, `openai-codex-account-2`, `openai-codex-account-3`, and
`openai-codex-account-4`; the canonical `google-antigravity` family follows the
same `google-antigravity`, `google-antigravity-account-2`, … pattern.

`accountLimit` is a whole number from `1` to `32`. `32` is the shared maximum,
and the limit applies independently to each managed family — `anthropic`,
`openai-codex`, and `google-antigravity` each get their own `1`..`accountLimit`
slot range under the one configured number (`MAX_ACCOUNT_LIMIT`). Startup rejects a persisted `accountLimit`
of `0`, `33`, a fraction, a string, or any unsafe value before it discovers any
account, and it rejects a canonical numbered `accountLabels` or
`monthlySubscriptionUsd` key above `32`. To lower the limit, remove or remap any
above-limit metadata key first, then re-login the account you still need into an
in-range slot. Stored credentials above the limit are left byte-for-byte
untouched; the extension never opens, moves, rewrites, or deletes them.

Authenticate each slot through Pi's public `/login` flow. The extension delegates
Anthropic OAuth lifecycle and ordinary requests to the in-tree
`pi-anthropic-oauth@0.2.5-intel.1` workspace, vendored byte-for-byte from the
reviewed fork commit `a52b62a05b0990ba3e2b1fa47d794b5f686435a5` before the
recorded workspace-only additions. For live models whose metadata requires
adaptive thinking, a selected reasoning level uses the extension-owned adapter.
Before either stream runs, the selector reconstructs Pi transcript system text
and active tools in the legacy context form consumed by the vendored code. The
base provider and numbered aliases share this selector, which sends one request
and never replays an adapter error. The extension re-asserts that base
registration once at session start, so another Anthropic OAuth extension that
loads later cannot restore a different request path. No separate global
installation is required. Codex aliases use Pi's native OAuth surface and
`openai-codex-responses` transport.

### Google Antigravity

`google-antigravity` resolves from the in-tree
`pi-antigravity@0.7.2-intel.1` workspace. Its public baseline is
`Rahularya01/pi-antigravity` release `v0.7.2`; the recorded local patch series
reconstructs the reviewed fork commit
`254a08d73ff8d21c3d84583587a87c0dc7ebad12`. The series projects current Pi
transcript system and tool changes before request
conversion, avoiding the observed `MALFORMED_FUNCTION_CALL` failure. This
repository imports only the five reviewed public barrels (`src/auth`,
`src/client`, `src/models`, `src/stream`, `src/usage`) and never invokes the
vendored root factory. The root factory's base `antigravity` provider, commands,
image tool, and optional connection prewarm are therefore unreachable through
this extension. See [`NOTICE`](NOTICE) for upstream attribution and the summary
of local changes.

The current catalog has eight models: `gemini-3.8-flash`, `gemini-3.7-flash`,
`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-pro`, `claude-opus-4-6`,
`claude-sonnet-4-6`, and `gpt-oss-120b`. `/multi-account add google-antigravity`
registers the next free numbered slot the same way as the other families, and
`/multi-account rediscover` picks up a credential added outside the running
session.

Usage fetching honors an `AbortSignal` end to end: `UsageFetcher` forwards it
through to the pinned fork's `fetchAccountUsage(apiKey?, { signal })`, and a
bounded per-attempt deadline aborts the raw call and awaits its real
settlement — never just the deadline — before releasing the shared machine
usage lease. A lease handed off to a background drain is kept renewed at the
lease's own interval so a peer process can never acquire it and start a
duplicate real call while one is still outstanding.

Google Antigravity has no supported inner-retry behavior yet, so recovery uses
the same conservative zero-retry default already used for every non-Anthropic
family; it is not a product gap specific to this family. Reported model `cost`
fields from the upstream usage endpoint are API-style rate estimates, not
retained subscription charges — this repository keeps retained provider cost
separate from those estimates and reports an unpriced case as `unpriced`
rather than guessing. The upstream usage result's raw project ID is projected
to a bounded digest before this repository records status, diagnostics, or
history; see [Storage and privacy](#storage-and-privacy).

Authenticating and exercising a real Google account end to end is an operator
action, not something automated verification performs: `integration:verify`
and this package's own tests use only isolated temporary `AuthStorage`,
synthetic fixture credentials, and blocked or faked network transports. See
Use the same operator-controlled rollout pattern used for Anthropic and Codex
enablement.

## Install

Pi packages run with the user's full system permissions. Review the source
before installation.

Install the public package globally:

```sh
pi install npm:@centerforagenticai/pi-multi-account
```

The package carries both modified provider forks inside its own `packages/`
directory. It does not fetch the private `-intel.1` package versions from a
registry; Pi SDK dependencies remain host peers.

Install a local checkout instead:

```sh
pi install /absolute/path/to/pi-multi-account
```

For a one-session test from a local checkout without changing settings:

```sh
npm ci
pi -e ./src/index.ts
```

The package manifest exposes one extension entrypoint:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Requirements:

- Node.js 22.19 or newer;
- a current Pi build with `agent_settled`, provider-response observation, dynamic
  provider registration, and the public model-registry credential runtime;
- OAuth credentials stored through Pi for each managed slot.

The development lock used by TypeScript and unit tests pins
`@earendil-works/pi-ai@0.84.4` and
`@earendil-works/pi-coding-agent@0.84.4`. The release gate also runs the
extension in an isolated real Pi child. Start a new Pi process or run `/reload`
after installing or updating the package. Use `/multi-account rediscover` after
adding or changing account credentials.

## Configuration

The extension reads one machine-global file:

```text
$PI_CODING_AGENT_DIR/pi-multi-account/config.json
```

When `PI_CODING_AGENT_DIR` is unset, the root is `~/.pi/agent`. The extension
does not load project-local config files. Missing config uses conservative
defaults. A malformed file, including one with an unknown top-level field,
makes extension session initialization fail closed: Pi records a sanitized
diagnostic and does not rediscover managed aliases. Pi itself stays running
because extension event handlers are crash-isolated.

```json
{
  "accountLimit": 4,
  "sameFamilyFailover": true,
  "crossFamilyChainEnabled": true,
  "crossFamilyChains": [
    { "from": "anthropic", "to": "openai-codex" }
  ],
  "preferredModels": {
    "openai-codex": ["replace-with-a-supported-codex-model-id"],
    "anthropic": ["replace-with-a-supported-anthropic-model-id"]
  },
  "tierModelMap": {
    "openrouter": { "replace-with-a-source-model-id": "openrouter/replace-with-a-router-model-id" }
  },
  "watchdogIntervalMs": 30000,
  "cooldownMaxMs": 300000,
  "preemptiveExpiryWindowMs": 120000,
  "usageFetchEnabled": {
    "anthropic": true,
    "openai-codex": true,
    "google-antigravity": true
  },
  "accountLabels": {
    "anthropic-account-2": "team subscription"
  },
  "projectLabels": {
    "project-0123456789abcdef01234567": "example project"
  },
  "monthlySubscriptionUsd": {
    "anthropic-account-2": 100,
    "openai-codex-account-2": 20
  }
}
```

Replace the two `preferredModels` values with exact model IDs from the current
Anthropic and OpenAI Codex catalogs. They are destination-family IDs, not
OpenRouter IDs.

Key behavior:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `accountLimit` | `4` | Maximum slot number per managed family. A whole number from `1` to `32`. |
| `sameFamilyFailover` | `true` | Permit another account in the same family. |
| `crossFamilyChainEnabled` | `false` | Enable the directional chains listed in `crossFamilyChains`. |
| `crossFamilyChains` | `[]` | Allowed cross-family transitions. Six directions are recognized, each its own explicit tuple: both `anthropic`↔`openai-codex` directions, and all four directions between `google-antigravity` and each of its two managed partners (`anthropic`, `openai-codex`). Direction matters — authorizing one direction never authorizes the reverse. |
| `preferredModels` | `{}` | Ordered destination-family models for cross-family routing. |
| `tierModelMap` | `{}` | Destination-keyed cross-tier model map (`anthropic`/`openai`/`openrouter` → `{ sourceId: destId }`). The source key is the ID shown by `unified`; the value is the same model's physical destination ID. Owning-vendor API and OpenRouter routing first use an exact catalog match, then this map, and fail closed when neither resolves. IDs are bounded to 256 characters and the map holds at most 256 entries total. The `"*"` source key is rejected. |
| `watchdogIntervalMs` | `30000` | No-progress interval before cancelling a continuation. |
| `cooldownMaxMs` | `300000` | Maximum bounded cooldown. |
| `preemptiveExpiryWindowMs` | `120000` | Prefer a fresher same-family credential before expiry. Set `0` to disable. |
| `usageFetchEnabled` | all `true` | Enable fail-soft provider usage fetches by family. |
| `accountLabels` | `{}` | Operator display labels keyed by canonical provider ID. |
| `projectLabels` | `{}` | Display labels keyed by `project-<24 hex>` digest. |
| `monthlySubscriptionUsd` | `{}` | Legacy, retroactive monthly price for subscription-value reporting, kept readable for compatibility. Superseded by `accountRateHistory` (see `multi-account account set-plan`); reading or writing either field never converts, deletes, or migrates the other, and neither reporting surface sums them together. |

`/multi-account reload` validates and reloads this file. It assigns the complete
persisted config and rediscovers accounts and provider catalogs. A failed reload
leaves the last valid in-memory config active and returns a sanitized command
error.

### Configuring cross-family routing

`/multi-account configure` is the only production path that writes this file. It
is interactive and runs in the Pi terminal UI only. Use it to view the current
policy, authorize one Anthropic↔Codex direction, and set the best-first
destination model list for that direction.

It writes three fields: `crossFamilyChainEnabled`, `crossFamilyChains`, and
`preferredModels`. Every other field is carried over from a fresh read of the
file taken at commit time, so an unrelated setting is never lost. `tierModelMap`
is one of those carried-over fields: `configure` preserves it unchanged and
shows only a bounded destination/entry-count summary, never a per-entry editor.
The dialog offers every direction whose two families both have a discovered
account, so an Antigravity-involving direction (`anthropic`↔`google-antigravity`
or `google-antigravity`↔`openai-codex`) appears the same way the existing
Anthropic↔Codex directions do, once both sides of that pair have a
rediscovered account.

The write is short and cooperative:

- dialogs hold no lock. The extension takes a `config.lock` lease only after you
  answer, with at most three attempts inside 300 ms;
- under that lease it re-reads the file and abandons the change if the routing
  policy on disk moved while the dialog was open;
- the replacement is atomic, uses a `0700` directory, and lands at mode `0600`;
- the new routing policy reaches the current Pi process immediately, without
  account rediscovery. Other running processes keep their existing policy until
  `/multi-account reload` or a restart.

The command refuses to widen policy on its own. It authorizes one direction at a
time, never the reverse direction, and it rejects a model list that would leave
any managed destination account without a preferred model. Removing an
authorization still means editing the file and running `/multi-account reload`.

Duplicate `crossFamilyChains` entries are collapsed to their first occurrence
when the file is read. That does not change which routes are allowed. The first
explicit write also materializes omitted fields at their existing default
values.

Recover from an interrupted write or an outside edit with `/multi-account
reload`. If a `config.lock` file is left behind, confirm that no Pi process is
committing, then remove it.

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

## Commands and agent tool

`/multi-account` supports:

| Command | Result |
| --- | --- |
| `status [account-id\|--json]` | Health, active model, utilization, credential freshness, and metered-rung state. |
| `limits` | Token totals, remaining quotas, and human-readable recovery intervals. |
| `models [account-id]` | Available and session-rejected models by account. |
| `model [id]` | Select a unified logical model by exact id; with no id, show the selectable models. Replaces the deprecated `/multi-account-model`. |
| `cost [day\|week\|month\|quarter\|half-year\|year]` | Retained provider cost and separate API-equivalent estimates. |
| `log [lines]` | The latest sanitized diagnostics; default 20, maximum 100. |
| `rediscover` | Refresh account metadata and provider slots. |
| `add <family> [slot]` | Register a new OAuth login slot. Authentication still uses Pi `/login`. |
| `remove <account-id>` | Use Pi's public removal API when available; otherwise direct the operator to `/logout`. |
| `clear <account-id>` | Clear process-local state, disable the slot, and preserve credentials. |
| `next` | Report the next healthy account without switching. |
| `switch <account-id>` | Make an explicit operator-requested switch. |
| `stop` | Cancel parked or queued automatic continuation work. |
| `reset` | Clear process-local routing, usage, watchdog, continuation, and disabled state. |
| `reload` | Validate and reload machine-global config. |
| `configure` | Configure cross-family routing directions and destination models. Interactive TUI only. |
| `group use <id>` | Bind this session id to one configured account group. |
| `group reset` | Clear this session override and return to the exact-cwd default, global default, or unrestricted routing. |
| `group status` | Show the effective group and source plus each member's current eligible or blocked reason. |
| `enable` | Re-enable managed accounts and reset process-local state. |
| `disable <family>` | Disable one managed family in the current process. |

The registered `multi_account_status` tool exposes only `status`, `limits`,
`models`, `cost`, and `log`. Every `group` action and every other subcommand remains
operator-only. An agent can inspect general account state but cannot set or reset a
session group, edit cwd/global defaults, or change account policy or lifecycle state.
Automatic failover is a reaction to a classified provider failure;
discretionary account changes remain operator actions.

Account groups are named allow-lists in machine-global config. `accountGroups` maps
a group id to canonical account ids from any managed subscription family in
`ALLOWED_FAMILIES`; `accountGroupCwdDefaults` maps an exact absolute directory to
a configured group; `defaultAccountGroup` is
the optional machine-wide fallback. Resolution order is session override, exact-cwd
default, global default, then unrestricted. A selected unknown, empty, exhausted, or
otherwise ineligible group fails closed rather than widening to another account.

## Command autocomplete

Both commands offer argument suggestions as you type. Pi calls each command's
`getArgumentCompletions` callback with the text after the command name and
replaces the whole argument prefix with the chosen item's `value`. Suggestions
are read-only: the callback parses the prefix, never runs the command, and never
reads a credential or a human label. It reads model objects only to filter and
order logical rows, and emits and retains only named fields (a bare value and a
display label), never a credential, a human label, or an arbitrary model or
account property. It returns freshly copied items or `null`, so a failure in one
source suppresses suggestions rather than leaking anything.

### `/multi-account` grammar

The `/multi-account` callback walks a finite grammar. Every suggested `value` is
the full argument prefix to insert, for example `status --json` or
`add anthropic 3`, not a bare token.

- With no argument it lists all 19 subcommands in source order: `status`,
  `limits`, `models`, `model`, `cost`, `log`, `rediscover`, `add`, `remove`,
  `clear`, `next`, `switch`, `stop`, `reset`, `reload`, `configure`, `enable`,
  `disable`, `group`.
- `status` suggests `--json` and every account ID.
- `models` suggests `install`, `update`, and every account ID.
- `model` suggests every selectable unified logical model id, with the same
  labels and bare-id insertion as `/multi-account-model`.
- `remove`, `clear`, and `switch` suggest every account ID.
- `group` suggests `use`, `reset`, and `status`; `group use` then suggests every
  configured group id.
- `cost` suggests exactly `day`, `week`, `month`, `quarter`, `half-year`, `year`.
- `log` suggests exactly `1`, `20`, `50`, `100`.
- `add` suggests `anthropic` then `openai-codex`; after a family it suggests the
  ascending, current, free, in-range numbered slots for that family.
- `disable` suggests `anthropic` then `openai-codex`.
- `limits`, `rediscover`, `next`, `stop`, `reset`, `reload`, `configure`, and
  `enable` take no argument and suggest nothing.

The account IDs offered are only discovered slots within the current limit that
also back a live model.

Add-slot suggestions follow live state. They exclude occupied, spare, and
out-of-range slots, skip the `openai-codex` family while it is disabled, and
refresh after `rediscover` or a config change. Selecting a complete prefix such
as `add anthropic 3` runs that exact slot. A prefix matches a suggestion by
fuzzy search until it exactly names one; an exact terminal token then closes to
`null` so a valid, complete command is not re-suggested.

### `/multi-account model` logical completion

The `/multi-account model` and deprecated `/multi-account-model` callbacks share
the same logical completion projection. They build a fresh logical inventory each time
and suggest only currently available `unified` rows, in live catalog order,
narrowed by session scope. Search is an order-preserving filter over `unified`,
the legacy `pi-multi-account` search alias, `unified/<model-id>`, the bare
`<model-id>`, and the configured display name. Completion labels render
`<model-id> [unified]`; the inserted `value` stays
the canonical bare `<model-id>` and is never `unified/<model-id>`. Slashes inside
a model ID are preserved.

A duplicate row whose bare ID collides with a prefixed form is omitted, a
physical (non-logical) row never appears, and a closed inventory returns `null`.
As with the command grammar, an exact bare ID that names a retained candidate
closes to `null` rather than re-suggesting the model you already typed. The
direct switch form still rejects a partial, fuzzy, or foreign reference: it acts
only on one exact bare ID or one exact `unified/<id>` reference.

### Limits

Suggestions need Pi's terminal UI. Argument autocomplete is a host non-goal in
RPC, JSON, and print (`pi -p`) contexts; the callbacks run zero times there and
handler output is identical with or without them. Re-opening the argument
picker with Tab after a token is a host behavior this extension does not change.
The built-in `/model` picker is unchanged. Only the extension-owned
`/multi-account model` picker rows and completion labels render `[unified]`;
their search includes the
`unified` field described above.

## Usage and cost intelligence

Usage comes from two independent record types:

- response records carry token totals and retained provider cost;
- provider headers and fail-soft usage fetches carry utilization, remaining
  quota, and recovery times.

A token record with no utilization does not hide a real utilization reading.
Fresh local and machine-shared observations inform routing. Stale observations
remain display evidence only.

`/multi-account cost` reports two separate facts:

1. Pi's retained provider cost;
2. an API-equivalent estimate based on a bounded cached public rate snapshot.

The estimate is not a bill. Missing, stale, or malformed pricing stays
`unpriced`; it is never treated as zero or substituted for retained cost.

Reported cost and value figures are scoped to this extension's own retained
provider-response history; they never read or sum a delegate rollup. Joining
delegate usage remains separate future work.

Full-detail utilization-window and response-cost history is retained for 90
days. The first append on each UTC day removes older recognized records under
the history lock; a capacity-bound append repeats expiry before refusing the
write. Closed UTC calendar periods are immutable. Days derive from raw history; ISO weeks and months derive from days;
quarters, half-years, and years derive from months. A missing child period is a
coverage gap, not zero usage. Period closure runs on the first observation in a
new UTC day and before cost rendering under one machine-global lease. It does
not create one timer per Pi process.

## Standalone CLI

The package also ships a standalone `multi-account` shell command (`bin` entry
`multi-account`, `scripts/multi-account.mjs`) that runs independent of any
running Pi session.

### `multi-account cost`

```text
multi-account cost
multi-account cost --period quarter --timezone America/New_York --format json
multi-account cost --from 2026-01-01 --to 2026-04-01 --timezone UTC --format json
multi-account cost --from 2026-01-01T12:00:00-05:00 --to 2026-01-02T12:00:00-05:00 --format json
multi-account cost --all-history --format text
multi-account cost refresh-pricing
multi-account cost close-periods
```

Plain `cost` (default `--period month --format text`) is a strict read-only,
offline probe. It never contacts a provider, refreshes pricing, closes a
period, migrates configuration, edits an account rate, or creates a catalog,
including on an empty first run. It feeds the same pure report projection as
`/multi-account cost` and the `multi_account_status` agent tool. Its
tier-aware API-equivalent pricing draws on the same installed-catalog data
those surfaces use: this package's own pinned `@earendil-works/pi-ai`
dependency inside the standalone process, and the running session's live
model registry inside Pi.

`--period <day|week|month|quarter|half-year|year>`, paired `--from`/`--to`,
and `--all-history` are mutually exclusive; `--format` is `text` or `json`
(one versioned document); `--timezone` is an IANA zone (default `UTC`) that
sets calendar-period boundaries and local midnight for date-only custom
bounds. Account-cost allocation always splits at UTC calendar-month
boundaries regardless of this display timezone. A custom bound is an ISO date
(`YYYY-MM-DD`) or an RFC 3339 timestamp with an explicit `Z` or numeric
offset; the range is start-inclusive and end-exclusive.

`multi-account cost refresh-pricing` and `multi-account cost close-periods`
are explicit write actions, kept separate from the read-only report path.
They reach the same authorized OpenRouter pricing cache and machine-leased
period closer the existing slash/tool observation-driven closure already uses.

Exit codes are stable across every standalone command: `0` success
(including a declined confirmation or a truthful empty report), `1` an
unexpected internal failure, `2` a syntax, argument, or domain validation
failure, `3` when retained data cannot satisfy the requested precision, `4`
for corrupt retained cost history, and `5` for an explicit
`refresh-pricing`/`close-periods` action failure. Text or JSON goes to
standard output; diagnostics go to standard error.

### `multi-account account set-plan`

```text
multi-account account set-plan <account-id> --type <preset-id> --effective-from <timestamp> [--monthly-usd <amount>]
```

Assigns a shipped or operator-added catalog preset as an account's new
effective rate record. `--effective-from` is always required as an RFC 3339
instant with an explicit `Z` or numeric offset; it is never inferred from a
history start or renewal boundary. The command resolves the preset, prints a
preview naming the account, provider, account type, preset, monthly rate,
effective instant, and catalog version, then asks for a literal `y`/`yes`
confirmation before writing anything. `--monthly-usd` overrides the preset's
default rate; an explicit `0` is a valid rate and differs from having no rate
at all. A later catalog edit never rewrites an existing rate record or a past
report result.

This command never migrates the legacy `monthlySubscriptionUsd` value: it does
not read, convert, or delete it, and it never invents an `--effective-from`
from a history start or renewal boundary. Recording rate history for an
account that already has a legacy value requires this explicit,
operator-supplied instant; there is no automatic migration path.

Run `multi-account --help`, `multi-account cost --help`, or
`multi-account account set-plan --help` for the exact current grammar.

## Storage and privacy

All files live below `$PI_CODING_AGENT_DIR/pi-multi-account/` or the equivalent
`~/.pi/agent/pi-multi-account/` default.

| File | Default file bound | Contents |
| --- | ---: | --- |
| `config.json` | operator-managed | Configuration; no credential values. |
| `config.lock` | 2 KiB | Short machine-global lease, mode `0600`, held only while `configure` commits. |
| `usage.ndjson` | 512 KiB | Per-account token and rate-limit observations shared across Pi processes. |
| `diagnostics.ndjson` | 1 MiB | Sanitized routing events, mode `0600`; compaction keeps the newest complete records. |
| `window-history.ndjson` | 128 MiB, 90 days | Utilization-window history. |
| `cost-history.ndjson` | ≤512 MiB, 90 days | Bounded response-cost observations; the byte cap never exceeds Node's safe decoded-string limit. |
| `*-history.ndjson.retention` | one integer line | UTC-day marker that limits ordinary expiry compaction to once per store per day. |
| `cost-period-digest.ndjson` | 64 MiB | Immutable closed-period project/account/model rollups. |
| `api-pricing.json` | 1,000,000 bytes | Cached public pricing data. |
| `openrouter-budget.json` | 64 KiB, 512 projects | Per-project UTC-day worst-case OpenRouter reservations; inactive entries expire after seven days. |
| `declaration-notice.json` | 1 KiB | UTC-day and stale/not-installed condition for the throttled startup warning. |

History expiry is append-driven. The first append to each store on a new UTC day
removes recognized records older than 90 days. A capacity-bound append may repeat
that check during the same day. An idle store retains its existing bytes until
its next append.

Stop every running Pi process before upgrading across the `usage.ndjson` append-cap
change, then restart them. Older processes do not take the new usage mutation
lease. Mixing old and new processes can bypass the cap or race usage compaction.

Observation, diagnostic, digest, pricing, and budget stores may contain
canonical provider IDs, model IDs, token and cost numbers, timestamps, bounded
error categories, and `project-<digest>` keys. They do not contain OAuth tokens,
API keys, authorization headers, request or response bodies, prompts, assistant
text, tool content, request IDs, raw provider errors, or raw project paths.
Human account and project labels remain in `config.json`; renderers resolve them
at output time instead of copying them into retained observations.

Persistent diagnostics reuse the same sanitizer as `/multi-account log`.
Oversized, malformed, or unsafe records are rejected. Storage failures are
fail-soft for managed subscription routing and fail-closed for a metered budget
reservation.

## Architecture

| Layer | Modules |
| --- | --- |
| Provider integration | `upstream-anthropic.ts`, `anthropic-context-compat.ts`, `anthropic-alias-stream.ts`, `codex-adapter.ts`, `provider-registration.ts`, `catalog-rebinding.ts` |
| Account discovery and credentials | `discovery.ts`, `credential-lifecycle.ts`, `credential-refresh.ts`, `warmer.ts`, `account-labels.ts` |
| Routing policy | `runtime-state.ts`, `error-classification.ts`, `cooldowns.ts`, `routing.ts`, `preflight.ts`, `model-support.ts` |
| Continuation lifecycle | `continuation.ts`, `watchdog.ts`, `compaction.ts`, `lifecycle.ts` |
| Operator surfaces | `commands.ts`, `command-completions.ts`, `fuzzy.ts`, `status-view.ts`, `logical-route-indicator.ts`, `diagnostics.ts`, `diagnostic-store.ts`, `logical-model-switcher.ts`, `logical-model-selector.ts` |
| Usage and shared state | `usage.ts`, `shared-usage.ts`, `usage-fetch.ts`, `window-history.ts`, `history-store.ts`, `machine-lease.ts` |
| Cost intelligence | `cost-history.ts`, `cost-digest.ts`, `cost-digest-store.ts`, `cost-period-closer.ts`, `cost-report*.ts`, `coverage-attestation.ts` |
| Metered last resort | `openrouter-fallback.ts`, `openrouter-budget.ts`, `pricing-cache.ts`, `api-pricing.ts` |
| Composition | `index.ts` |

The extension does not register `before_provider_request`. The captured in-tree
Anthropic configuration still owns OAuth callbacks, headers, and ordinary
requests. A narrow stateless selector sends adaptive requests to the
MIT-licensed local adapter and leaves every other request on the vendored
`0.2.5-intel.1` stream. Before invoking either stream, the selector reconstructs current Pi
transcript system text and active tool declarations in the legacy context form
that both implementations consume. The adaptive adapter imports the vendored
prompt, message, and tool helpers and changes only adaptive-thinking fields.
The base provider and numbered aliases use that same selector; it does not
replay errors. Because Pi merges a later provider registration over an earlier
one, the extension registers that base configuration again once at session
start. This is its only permitted base-provider exception.

## Known boundaries

- Pi defaults to three retries for a retryable provider error before
  `agent_settled`; Pi settings can change that count. This extension cannot
  suppress the host retry layer.
- Same-turn replay is intentionally excluded. Recovery uses a fixed continuation
  message after settlement.
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
- `google-antigravity` has no supported inner-retry behavior yet, so recovery
  reserves zero inner retries for it, the same conservative default already
  used for `openai` and `openai-codex`.
- Automated verification never performs a real Google sign-in. Exercising a
  live `google-antigravity` account end to end is an operator action performed
  after `integration:verify` passes, the same deferred pattern already used for
  Anthropic and Codex.

## Verification

The canonical release gate is `integration:verify`. Its child smoke requires
the current Pi session path. Run Pi's public `/session` command in this checkout
and copy its `File:` value:

```sh
npm ci
PI_BIN="$(command -v pi)" \
PI_MULTI_ACCOUNT_CURRENT_SESSION='/absolute/path/from-pi-session.jsonl' \
  npm run integration:verify
```

`PI_BIN` is required whenever the Pi executable is not beside `process.execPath`.
The child smoke looks only next to the running Node binary, so a Homebrew or
nvm-managed Node needs this override. The session file must be real and have a
recorded cwd matching this checkout.

The gate runs TypeScript, all Vitest tests with file parallelism disabled, the
credential canary, the isolated child smoke, `upstream:check`, and
`npm pack --dry-run`. `upstream:check` verifies both exact bundled provider
dependencies and their workspace links, each package's structured `UPSTREAM.md`,
and every file in its recorded baseline manifest. It reverse-applies each
package's recorded patch series, verifies the clean baseline, applies the series
forward, and compares the result with the vendored package. The check makes no
network request and fails on an unrecorded changed, added, or removed file,
including files below nested `node_modules` or `.test-dist` directories. Only
those generated directories at a package root are excluded.
`npm run upstream:verify-baseline` is the
separate network check that fetches each recorded upstream commit; it is not part
of `check` or the CI gate.

The Vitest suite's `actual-delegate-runtime` case requires `PI_DELEGATE_PACKAGE_DIR`
(the installed `pi-delegate` package root) and is otherwise skipped, so the
release gate additionally requires that variable to be set, failing closed
rather than passing green on a silently skipped probe. That case measures the
delegate worker's own bundled Pi SDK version at runtime instead of assuming it
matches the host `PI_BIN` — this repository's development lock pins the host to
`@earendil-works/pi-coding-agent@0.84.4`, but a worker session resolves its own
installed copy independently, and the two are not assumed equal.

The smoke starts real offline Pi child processes with fresh `HOME` and
`PI_CODING_AGENT_DIR` directories. It blocks external sockets and model prompts,
checks production-only loading and both coexistence orders, and verifies that
the selected settings, `AuthStorage`, and invoking session files do not change.

Every behavioral change must also pass a mutation control: break production in
the specific way the defect would occur, prove a named test fails, then restore
from a backup and rerun the test.

## License

Our code is available under the [MIT License](LICENSE). This package also
contains modified MIT-licensed copies of `pi-anthropic-oauth` and
`pi-antigravity`; see [NOTICE](NOTICE) and each fork's included `LICENSE` file.
