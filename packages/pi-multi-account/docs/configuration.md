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
| `imageStripping` | off | Stopgap: remove old images from `unified` and Anthropic alias requests. See [Removing old images (stopgap)](#removing-old-images-stopgap). |
| `accountLabels` | `{}` | Manual nicknames keyed by canonical provider ID. Edit with `/multi-account nickname set <id> <text>` or `nickname clear <id>`. Not verified identity; detected Anthropic email stays in AuthStorage. |
| `projectLabels` | `{}` | Display labels keyed by `project-<24 hex>` digest. |
| `monthlySubscriptionUsd` | `{}` | Legacy, retroactive monthly price for subscription-value reporting, kept readable for compatibility. Superseded by `accountRateHistory` (see `multi-account account set-plan`); reading or writing either field never converts, deletes, or migrates the other, and neither reporting surface sums them together. |

`/multi-account reload` validates and reloads this file. It assigns the complete
persisted config and rediscovers accounts and provider catalogs. A failed reload
leaves the last valid in-memory config active and returns a sanitized command
error.

### Removing old images (stopgap)

A session that collects many screenshots can exceed the provider's request limit
on every turn. Context compression does not remove images for the `unified`
model or for Anthropic aliases, because it chooses the payload format from the
session model's API, and those APIs name no known format. Set
`imageStripping` to remove old images from those requests:

```json
{
  "imageStripping": { "enabled": true, "keepNewest": 8 }
}
```

With `enabled: true`, each outgoing request keeps the images of the newest
`keepNewest` messages that hold an image. In every older message, each run of
image blocks becomes one text block, `[image removed to fit the request limit]`.
This includes images in tool results. `keepNewest` is a whole number from `1`
through `1000` and defaults to `8`. `enabled` is required.

The policy applies to every `unified` attempt that routes to a numbered alias,
whatever the account's family, and to every request sent to a numbered
Anthropic alias (`anthropic-account-N`). Base providers (`anthropic`,
`openai-codex`, `openai`, and `google-antigravity`) are never changed, whether a `unified` call routes to them or a
request goes to them directly. Requests to other alias families and the session
file are never changed either: only the request copy loses its
images, so the model can no longer see them. With the setting absent or `enabled: false`,
requests are unchanged. `/multi-account reload` applies a change to the next
request.

Each new image-bearing message moves the cutoff, so an older message changes and
the provider's prompt cache misses from that point on that turn. Expect extra
cache writes while the policy is on.

This is a stopgap. It will be removed when pi-context-aware folds media itself.
Removal will keep accepting and ignoring the key, because the first explicit
config write materializes it with its default value.

### Configuring cross-family routing

`/multi-account configure`, `/multi-account account exclude|include`, and
`/multi-account group create|delete|add|remove|default|dir` write this file.
The account and group edits use the same locked, atomic writer. See
[Excluding accounts from automatic routing](#excluding-accounts-from-automatic-routing)
and [Editing account groups from a session](#editing-account-groups-from-a-session).
`configure` is interactive and runs in the Pi terminal UI only. Use it to view the current
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

### Excluding accounts from automatic routing

`automaticRoutingExcludedAccounts` lists managed accounts that automatic
routing must skip:

```json
{
  "accountLimit": 4,
  "automaticRoutingExcludedAccounts": ["anthropic-account-3"]
}
```

Each entry is a canonical managed provider ID within `accountLimit`: a family
ID such as `anthropic` or `openai-codex`, or a numbered alias such as
`anthropic-account-3`. The parser rejects a value that is not an array, an
entry that is not a string, an unknown or non-canonical ID, an ID above
`accountLimit`, and a duplicate. Its message never echoes the rejected value.
A rejected entry makes the whole file invalid, like a bad `accountGroups`
member: requests stay blocked until valid config loads, and a failed
`/multi-account reload` keeps the last valid config. Lowering `accountLimit`
below an excluded slot is invalid in the same way. An absent key or an empty
list excludes nothing.

An excluded account stays signed in and can still be used directly. Automatic
routing skips it. [Routing and recovery](routing.md#excluding-accounts-from-automatic-routing)
lists every path this covers. An entry for an account that is later signed out
stays valid, and `status` shows it as not authorized.

An account group that lists an excluded account overrides the exclusion for
sessions that use the group: their automatic routing may choose it. The
configured list is unchanged, and sessions under another group or no group still
skip the account. `group status` marks such a member `excluded from automatic
routing; this pool overrides the opt-out`.

Change the list with `/multi-account account exclude <account-id>` and
`/multi-account account include <account-id>`. Each takes the same `config.lock`
lease as `configure`, re-reads the file under that lease, changes only this key,
validates the whole file, and replaces it atomically at mode `0600`. Every other
field, including one another process wrote after the command started, is kept.
Including the last excluded ID removes the key. The current Pi process applies
the change at once. Other running processes apply it after
`/multi-account reload` or a restart.

Older builds reject this key as unknown, which makes the whole file invalid.
Before downgrading, run `/multi-account account include <account-id>` for each
excluded ID, or delete the key, then downgrade.

### Account-group defaults by folder tree

`accountGroupDirectoryDefaults` maps an absolute folder to a configured group.
The rule covers that folder and every folder below it:

```json
{
  "accountGroups": {
    "client": ["anthropic-account-2", "openai"],
    "lab": ["anthropic"]
  },
  "accountGroupDirectoryDefaults": {
    "/srv/work/client": "client",
    "/srv/work/client/lab": "lab"
  }
}
```

A session resolves its group in this order:

1. its `group use` override;
2. an `accountGroupCwdDefaults` rule for exactly its cwd;
3. the deepest `accountGroupDirectoryDefaults` folder that contains its cwd;
4. `defaultAccountGroup`;
5. unrestricted routing.

In the example, a session in `/srv/work/client/lab/tool` uses `lab`, and a
session in `/srv/work/client/api` uses `client`. A folder contains a cwd when the
two are equal or the cwd continues the folder after a path separator, so
`/srv/work/client` does not cover `/srv/work/client-old`. Both paths are made
absolute and have symbolic links resolved first, as for the exact key; a path
that cannot be resolved is compared as written. Key order never decides.

Each key must be an absolute path and each value a configured group, or the
whole file is invalid. When two keys resolve to the same folder but name
different groups, sessions that this folder decides fail with the `policy`
cause. A conflict at a shallower folder does not matter where a deeper rule
decides. `group status` shows the source as `directory default`, and a delegate
child that inherits its parent's group keeps that source.

Older builds reject this key as unknown, which makes the whole file invalid.
They also reject a cached `directory-default` source in
`session-account-groups.json` as `store-invalid`, which blocks every session.
Before downgrading, delete the key, then move `session-account-groups.json` and
`session-account-groups.last-used.json` aside. That discards every session's
saved `group use` choice.

### Editing account groups from a session

Six `/multi-account group` actions edit `accountGroups`, `defaultAccountGroup`,
`accountGroupCwdDefaults`, and `accountGroupDirectoryDefaults`, so you need not
edit the file by hand:

```text
/multi-account group create client-a
/multi-account group add client-a anthropic-account-2
/multi-account group dir ~/Code/client-a client-a --tree
/multi-account group default client-a
```

Each action takes the same `config.lock` lease as `configure`, re-reads the file
under that lease, changes only the account-group keys, validates the whole file,
and replaces it atomically at mode `0600`. Every other field, including one
another process wrote after the command started, is kept. When another process
holds the lease, the file is malformed, or the write fails, nothing changes and
the reply says so. The current session applies a change at once and resolves its
group again. Other running sessions apply it after `/multi-account reload` or a
restart, and new sessions read it when they start.

- `group create <id>` adds a group with no members. An id is 1–64 letters,
  digits, dots, underscores, or hyphens, starting with a letter or digit;
  `none` is reserved.
- `group add <id> <account>` accepts every reference a hand-edited file may
  list. See [Account-group members](#account-group-members). A reference that
  cannot serve this session yet, such as a misspelling or a provider that is
  not signed in, is stored, and the reply warns once. A provider this extension
  does not route, such as `google`, lets a selected model on it run inside the
  group, but `unified`, failover, recovery, parking, and preflight never choose
  it; the reply says so. A non-canonical managed slot, a slot above
  `accountLimit`, or an unsafe reference is refused.
- `group remove <id> <account>` keeps a group it empties, and warns that
  sessions using the group are blocked until it has a usable member.
- `group delete <id>` is refused while `defaultAccountGroup` or any folder rule
  names the group. The reply lists each one; change them with `group default`
  and `group dir` first.
- `group default <id|none>` sets or clears `defaultAccountGroup`.
- `group dir <path> <id|none> [--tree]` stores the folder as an absolute path:
  `~` and `~/...` start at your home folder, and any other relative path starts
  at the session's cwd. Without `--tree` it edits `accountGroupCwdDefaults`;
  with it, `accountGroupDirectoryDefaults`. A rule for a folder that already
  has one replaces it, including a key that names the same folder through a
  trailing separator, `..`, or a symbolic link, and the reply names the group
  it replaced. A folder that does not exist yet is stored, with a note. `none`
  removes the rule. Command arguments are split at spaces, so a folder whose
  path contains a space cannot be set here; edit the config file instead.

A refusal or an unchanged reply never repeats an argument that did not
validate, because it may be a label or an email address.

## Additional accepted keys

These keys were already accepted by the shipped parser but were not listed in
the pre-standard README table:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `recoveryIdleTimeoutMs` | `300000` | Maximum time without qualifying recovery progress, at least `1000` ms and more than `recoveryStallTimeoutMs`. |
| `recoveryAbsoluteTimeoutMs` | `1800000` | Maximum elapsed time for one complete recovery invocation. |
| `recoveryStallTimeoutMs` | `180000`, or one less than `recoveryIdleTimeoutMs` when that is shorter | Longest one `unified` physical attempt may wait for the provider's `start` event (opening included), from `1000` through `1800000` ms and less than `recoveryIdleTimeoutMs`; otherwise the idle limit would end the call before a stalled attempt could move. A stall before `start` is a pre-start transient that may move to another account. After `start` the provider has answered and keeps the connection alive, and a model may think silently for minutes, so later waits are bounded only by `recoveryIdleTimeoutMs` before the first content and by `recoveryAbsoluteTimeoutMs` after it. |
| `recoveryMaxAttempts` | `6` | Most physical sends one `unified` call may make, the first send included, as an integer from `1` through `6`. Recovery rolls over to each other eligible account serving the same model at most once, so a call stops after this many sends or when no further account is eligible, whichever comes first. `1` turns in-call recovery off. Any other value is rejected. |
| `accountGroups` | `{}` | Named allow-lists of exact Pi provider IDs, including configured built-in and custom providers. Managed numbered aliases must remain canonical and within `accountLimit`. |
| `accountGroupCwdDefaults` | `{}` | Exact absolute cwd-to-group defaults. |
| `accountGroupDirectoryDefaults` | `{}` | Absolute folder-to-group defaults that also cover every folder below; the deepest folder wins. See [Account-group defaults by folder tree](#account-group-defaults-by-folder-tree). |
| `defaultAccountGroup` | absent | Optional machine-wide group when no session, exact-cwd, or folder-tree choice applies. |
| `automaticRoutingExcludedAccounts` | absent | Managed provider IDs that automatic routing skips. See [Excluding accounts from automatic routing](#excluding-accounts-from-automatic-routing). |
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

Membership confines the extension's automatic routing: `unified`, failover,
recovery, parking, preflight, and the metered OpenRouter rung. In an operator
session, a model selected with `/model` from a provider outside the group runs
as selected. A delegate child keeps its inherited policy, so its out-of-group
selection is refused, never replaced with an in-group model. Listed members still
need live availability. See
[Selecting a provider outside the account group](routing.md#selecting-a-provider-outside-the-account-group). It does not enroll a
custom provider in extension-owned refresh, usage, cost, unified routing, parking,
or recovery. Those candidate sets remain managed-only. `group status` shows
availability and exclusion through credential-free public metadata.

Listing `openrouter` lets sessions in the group use OpenRouter, but listing is
never enough on its own. An explicit `openrouter/<model>` selection still needs
exact `conversation-egress` consent, a concrete configured model, a positive
daily cap, credentials, known pricing, and a budget reservation for each turn.
Delegate and Fabric children in the group may make that selection too; their
spend counts against the same per-project daily cap. The automatic metered last
resort can run inside a group that lists `openrouter`, and it still excludes
delegates. A group that does not list `openrouter` blocks it in every session.
See [OpenRouter in an account group](routing.md#openrouter-in-an-account-group).
Unrestricted OpenRouter is unchanged. Older builds block metered OpenRouter
under every named group, and reject these new member kinds; remove them before
downgrading and reload valid config.
