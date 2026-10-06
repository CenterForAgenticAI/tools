# Configuration reference

For operators: every machine-global configuration key, cross-family policy, defaults, and the safe interactive configuration flow.

## Configuration

The extension reads one machine-global file:

```text
$PI_CODING_AGENT_DIR/pi-multi-account/config.json
```

When `PI_CODING_AGENT_DIR` is unset, the root is `~/.pi/agent`. The extension
does not load project-local config files. Missing config uses conservative
defaults. A malformed file, including one with an unknown top-level field,
keeps numbered OAuth discovery, `/login`, model catalogs, and operator repair
available. Discovery retains an independently valid `accountLimit` from `1`
through `32`, or uses the default limit when that field is invalid. These
discovery defaults do not authorize requests: direct input, custom-message runs,
`unified` dispatch, automatic recovery, parking, and OpenRouter stay blocked
until a complete valid config is loaded. An installed or stale `unified`
declaration still gets a registered handler with safe correction guidance.

Pi stays running and reports bounded guidance that names a known invalid field
without copying config values or raw errors. Correct the global config, then
run `/multi-account reload` or `/reload`; existing credentials need no changes.
`/multi-account rediscover` alone does not clear the policy block.

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
  "modelFallbacks": {
    "replace-with-an-exact-source-unified-model-id": [
      "replace-with-an-exact-fallback-model-id"
    ]
  },
  "modelFallbackEgress": [
    {
      "sourceModelId": "replace-with-an-exact-source-unified-model-id",
      "destinationModelId": "replace-with-an-exact-cross-vendor-model-id"
    }
  ],
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
| `modelFallbacks` | `{}` | **Not yet wired: no request path reads this key yet.** Exact source unified model ID to an ordered list of exact fallback model IDs. An absent or empty map authorizes no substitution. The parser accepts at most 128 sources and 16 destinations per source, rejects a source listed as its own destination and duplicate destinations, and rejects any ID the diagnostic sanitizer would redact, without echoing it. |
| `modelFallbackEgress` | `[]` | **Not yet wired.** Exact directional `sourceModelId`→`destinationModelId` authorizations for a destination from another vendor or served through OpenRouter. One direction never authorizes the reverse. A same-vendor managed destination does not need an entry. The parser accepts at most 256 edges. |
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

## Additional accepted keys

These keys were already accepted by the shipped parser but were not listed in
the pre-standard README table:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `recoveryIdleTimeoutMs` | `300000` | Maximum time without qualifying recovery progress, at least `1000` ms and more than `recoveryStallTimeoutMs`. |
| `recoveryAbsoluteTimeoutMs` | `1800000` | Maximum elapsed time for one complete recovery invocation. |
| `recoveryStallTimeoutMs` | `180000`, or one less than `recoveryIdleTimeoutMs` when that is shorter | Longest one `unified` physical attempt may wait for the provider's `start` event (opening included), from `1000` through `1800000` ms and less than `recoveryIdleTimeoutMs`; otherwise the idle limit would end the call before a stalled attempt could move. A stall before `start` is a pre-start transient that may move once to another account. After `start` the provider has answered and keeps the connection alive, and a model may think silently for minutes, so later waits are bounded only by `recoveryIdleTimeoutMs` before the first content and by `recoveryAbsoluteTimeoutMs` after it. |
| `accountGroups` | `{}` | Named allow-lists of exact Pi provider IDs, including configured built-in and custom providers. Managed numbered aliases must remain canonical and within `accountLimit`. |
| `accountGroupCwdDefaults` | `{}` | Exact absolute cwd-to-group defaults. |
| `defaultAccountGroup` | absent | Optional machine-wide group when no session or exact-cwd choice applies. |
| `subscriptionPlanCatalogOverrides` | `{}` | Replace or add machine-global subscription-plan presets. |
| `accountRateHistory` | `{}` | Effective-dated copied plan and rate records per account. |

### Account-group members

Use the exact provider ID from Pi, not a model ID, API name, display name, endpoint,
or credential label. For example:

```json
{
  "accountLimit": 4,
  "accountGroups": {
    "client": ["anthropic-account-2", "openai", "google", "google-vertex", "abliteration.ai"]
  },
  "defaultAccountGroup": "client"
}
```

Each reference is 1–128 ASCII letters, digits, dots, underscores, or hyphens and
starts with a letter or digit. This is the extension's safe reference syntax;
Pi's provider registry uses string IDs. A syntactically valid reference is not
authorization: Pi must recognize that exact provider, the group must list it, and
Pi's cached catalog/auth-check snapshot must include the selected model. A misspelling
or removed provider stays inactive. This eligibility check does not verify request
credentials: a configured credential command can pass without running, even if later
resolution fails. Pi resolves request credentials separately before a physical send.
An unavailable snapshot blocks dispatch. Status reads metadata only; it does not
resolve credentials or execute credential commands.

A virtual model is a selectable model that chooses a physical model for each
request. Newer Pi hosts mark these models with API `pi-virtual`. A virtual-only
provider can be keyless and available, and a physical provider can also list virtual
models. Neither provider membership nor authentication confines a virtual router's
physical targets. Under a restricted account group, virtual selected models are
unsupported, including virtual entries named `unified` or listed under a managed
provider. Ordinary input is blocked and custom-message runs are aborted before
dispatch. Select a listed physical model or use `group reset` to resolve your own
default policy. Reset removes the restriction only when that policy is unrestricted.
Physical models on a mixed physical/virtual provider remain usable. Unrestricted
virtual selection keeps the host's behavior. This is a session lifecycle guard,
not a firewall for arbitrary nested calls made by trusted extensions.

Managed family IDs and numbered aliases remain canonical within `accountLimit`
(`1` through `32`). The reserved `<managed-family>-account-` prefixes cannot be
used to evade that limit: `openai-account-33`, `anthropic-account-01`, and
`anthropic-account-custom` are invalid. A truly custom name such as
`custom-account-99` is not a managed alias. Subscription plan and monthly-cost
keys remain subscription-only; adding `openai` to a group does not make it a
subscription account.

Unknown, removed, or auth-unavailable members are individually inactive. Other
explicitly listed usable members can serve. An empty or wholly unusable group
blocks requests without falling back outside the group. Discovery, `/login`,
`rediscover`, and operator repair remain available. A successful `reload` applies
the new membership; failed reload keeps the last valid policy.

Membership restricts direct ordinary and custom-message requests, including
restored model selections and inherited delegate policy. It does not enroll a
custom provider in extension-owned refresh, usage, cost, unified routing, parking,
or recovery. Those candidate sets remain managed-only. `group status` shows
availability and exclusion through credential-free public metadata.

`openrouter` is a valid reference, but this release still blocks metered OpenRouter
under a named group, even when listed. The separate group-enabled OpenRouter,
tree-directory rules, and opt-out precedence changes are not part of this feature.
Unrestricted OpenRouter retains all existing consent, concrete-model, positive-cap,
credential, pricing, budget, and delegate-exclusion checks. Older builds reject
these new member kinds; remove them before downgrading and reload valid config.
