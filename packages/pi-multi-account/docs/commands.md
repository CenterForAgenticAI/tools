# Commands, tools, and autocomplete

For operators and agents: slash commands, the read-only agent tool, account groups, and terminal argument completion.

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
| `group status` | Report the cached effective group and original source, listed members' availability, and recognized excluded providers, without changing policy. |
| `enable` | Re-enable managed accounts and reset process-local state. |
| `disable <family>` | Disable one managed family in the current process. |

The registered `multi_account_status` tool exposes only `status`, `limits`,
`models`, `cost`, and `log`. Every `group` action and every other subcommand remains
operator-only. An agent can inspect general account state but cannot set or reset a
session group, edit cwd/global defaults, or change account policy or lifecycle state.
Automatic failover is a reaction to a classified provider failure;
discretionary account changes remain operator actions.

Account groups are named allow-lists in machine-global config. `accountGroups` maps
a group id to exact Pi provider IDs, including configured built-in and custom
providers. Managed numbered aliases must be canonical and within `accountLimit`.
See [member identity and availability](configuration.md#account-group-members).
`accountGroupCwdDefaults` maps an exact absolute directory to a configured group;
`defaultAccountGroup` is the optional machine-wide fallback. Resolution order is
session override, exact-cwd default, global default, then unrestricted. Unknown,
removed, or unauthenticated members are individually inactive. Other listed usable
members can serve; an unknown, empty, or wholly unusable group blocks requests
rather than widening access. Discovery and login remain available.

`group status` distinguishes recognized and available, excluded, unknown or removed,
authentication unavailable, model unavailable, virtual model unsupported by active
group, and authorization snapshot unavailable. A virtual-only provider is blocked
under a restricted group; a mixed provider can still have usable physical models.
It reads Pi's public catalog and authorization metadata without resolving API keys
or displaying credential labels. Managed health or disablement can add a routing
block. Status does not select a model or change group policy. Group membership does
not give this extension ownership of a custom provider's refresh, usage, cost,
unified routing, parking, or recovery. Listing `openrouter` leaves the current
named-group metered block intact.

At startup and resume, in-process and durable delegate children inherit the parent's
complete cached effective result. The child's cwd does not replace it. Status keeps
the original source, such as `cwd default`; it does not add an `inherited` source or
recompute policy. Missing or invalid parent identity or cache blocks requests.
After startup, explicit operator `group use` and `group reset` retain the semantics
in the table: they resolve this session's own policy. A later delegate resume
inherits the parent's effective result again.

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
