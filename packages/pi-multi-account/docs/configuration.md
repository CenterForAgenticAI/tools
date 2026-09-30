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

## Additional accepted keys

These keys were already accepted by the shipped parser but were not listed in
the pre-standard README table:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `recoveryIdleTimeoutMs` | `300000` | Maximum time without qualifying recovery progress. |
| `recoveryAbsoluteTimeoutMs` | `1800000` | Maximum elapsed time for one complete recovery invocation. |
| `accountGroups` | `{}` | Named allow-lists of canonical managed subscription account IDs. |
| `accountGroupCwdDefaults` | `{}` | Exact absolute cwd-to-group defaults. |
| `defaultAccountGroup` | absent | Optional machine-wide group when no session or exact-cwd choice applies. |
| `subscriptionPlanCatalogOverrides` | `{}` | Replace or add machine-global subscription-plan presets. |
| `accountRateHistory` | `{}` | Effective-dated copied plan and rate records per account. |
