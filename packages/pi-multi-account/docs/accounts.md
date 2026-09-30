# Accounts and provider integration

For operators and integrators: managed provider families, account slots, OAuth behavior, and Google Antigravity integration.

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
this extension. See [`NOTICE`](../NOTICE) for upstream attribution and the summary
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
history; see [Storage and privacy](privacy.md).

Authenticating and exercising a real Google account end to end is an operator
action, not something automated verification performs: `integration:verify`
and this package's own tests use only isolated temporary `AuthStorage`,
synthetic fixture credentials, and blocked or faked network transports. See
Use the same operator-controlled rollout pattern used for Anthropic and Codex
enablement.
