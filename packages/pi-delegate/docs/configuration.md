# Configuration

This reference is for operators who need every configuration key, environment variable, default, and failure behavior.

## Configuration

Optional `config.json` at `~/.pi/agent/config/pi-delegate/config.json`:

```json
{
  "worktreeSetupHook": "/abs/path/to/hook.sh",
  "worktreeSetupHookTimeoutMs": 30000,
  "perForkMaxDurationMs": 0,
  "perForkMinDurationMs": 0,
  "skill": { "excludeSections": ["Cancelling"] },
  "globalToolWhitelist": {
    "tools": ["ext:skill:load"],
    "skills": ["implement"]
  },
  "escalation": { "mode": "off" },
  "nativeEscalationUi": true,

  "overlayShortcut": "ctrl+alt+d",
  "inspectorLayout": "full",
  "inspectorThinking": "preview",
  "inspectorToolDetail": "chip",
  "inspectorFoldMessages": true,
  "autoCloseInspectorOnComplete": false,
  "completionNotifyStrategy": "auto",
  "notifyOnFailure": true,
  "activityTicker": {
    "enabled": true,
    "minSummaryIntervalMs": 15000,
    "debounceMs": 2000,
    "maxConcurrentSummaries": 2,
    "summaryTimeoutMs": 10000,
    "terminalRetentionMs": 5000,
    "maxHeadlineChars": 100,
    "maxInputChars": 4000
  },
  "ptmBridge": { "handleRequests": "auto" }
}
```

### Global tool and skill baseline

Despite its historical “Tool” name, the `globalToolWhitelist` first cut includes both tools and skills. The object shape keeps the two resource kinds explicit:

```json
{
  "globalToolWhitelist": {
    "tools": ["read", "ext:skill:load"],
    "skills": ["implement", "test-execution"]
  }
}
```

The global baseline is applied before agent frontmatter and before durable `agentOverrides`. With a configured baseline, non-empty durable `tools` or `skills` lists extend the composed list, an explicit empty list clears it, and omitted fields retain it. Without a baseline, durable lists keep their existing whole-array replacement behavior. If the baseline is the first non-empty tool declaration, the worker also keeps `read`, `bash`, `edit`, and `write`.

Skill inheritance stays intentional. `inheritSkills:false` with no explicit skills uses the non-empty global skill list. `inheritSkills:true` with no explicit skills keeps `skills` absent and exposes the full discovered registry. With explicit skills, both `inheritSkills:false` and `inheritSkills:true` put global skills before agent skills. Invocation `skill:false` remains the final per-call opt-out.

`extensionExclude` can opt one agent out of a provider; the affected global-only `ext:` selector will warn and drop when that provider is absent or excluded. The same selector remains a hard error when agent frontmatter, a durable override, or an invocation also names it. An explicit empty durable `tools` list opts out of all configured global tool entries.

| Field                        | Meaning                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `worktreeSetupHook`          | Executable run once per new worktree after creation. Receives a JSON payload on stdin.                  |
| `worktreeSetupHookTimeoutMs` | Positive integer ms cap for the hook.                                                                   |
| `perForkMaxDurationMs`       | Optional global absolute ceiling for solo and supervised runs (#287). Default `0` (disabled); positive values clamp agent/entry budgets and always hard-enforce after grace. Addressable direct runs still have an activity-based safety bound: 15 minutes without worker or descendant activity sends one wind-down steer, then hard-cancels after `windDownGraceMs`. Values must be safe integer milliseconds up to 2,147,483,647. |
| `enforceWallClockBudget`     | Boolean, default `false`. When `true`, caller- and agent-supplied wall-clock budgets hard-cancel after wind-down grace. A positive `perForkMaxDurationMs` hard-enforces regardless of this setting. |
| `perForkMinDurationMs`       | Optional global absolute floor for solo and supervised runs. Default `0` (disabled); positive values raise only a stated positive selected budget after the ceiling. Explicit zero and no selected budget remain unlimited when the floor is the only bound. A positive floor above a positive ceiling is diagnosed and ignored. Values must be safe integer milliseconds up to 2,147,483,647. |
| `skill.excludeSections`      | Optional array of exact, case-sensitive visible Markdown heading text. Each match removes that heading through the next heading at the same or higher level, including nested subsections. Missing, empty, malformed, or partly unknown values expose the complete bundled skill; malformed and unknown values emit fixed redacted warnings. |
| `globalToolWhitelist`        | Optional `{ tools?: string[], skills?: string[] }` baseline for every discovered agent. See “Global tool and skill baseline” above. |
| `escalation`                 | Global partial escalation policy and root authority. Built-in `mode` is `"off"`; escalation is opt-in and merges field-wise with agent and invocation layers. See [`docs/escalation.md`](escalation.md). |
| `nativeEscalationUi`         | Boolean, default `true`. Set `false` when a host renders user-held escalations in its own operator UI. Pi then neither opens its native dialog nor wakes the root agent for them; the request stays pending in the durable feed for the host escalation API. Non-boolean values are ignored with a warning. See [`docs/escalation.md`](escalation.md). |
| `overlayShortcut`            | Fallback keybinding for opening the transcript overlay, registered in addition to the built-in `alt+o` / Option-O toggle. Default `ctrl+alt+d` (d = delegate). Set to `""` to disable both shortcuts (slash command still works). Avoid `ctrl+shift+letter` defaults because many terminals collapse them to plain `ctrl+letter`. |
| `inspectorLayout`            | Transcript inspector placement: `"full"` (default) centres a near-fullscreen modal; `"dock"` anchors a narrow right-side panel and renders the single-column drill-down. Invalid values fall back to `"full"`. |
| `inspectorThinking`          | Initial thinking detail for each new Pi session: `"hidden"`, `"preview"` (default), or `"full"`. Runtime `t` changes persist only within that session. |
| `inspectorToolDetail`        | Initial tool-call detail for each new Pi session: `"chip"` (default), `"hidden"`, or `"expanded"`. Runtime `g` changes persist only within that session. |
| `inspectorFoldMessages`      | Retained for compatibility and currently inert: long finished messages always fold, and `Enter` expands the one message or tool result you select. |
| `autoCloseInspectorOnComplete` | Close the open overlay when its owned runs transition from live to all-terminal. Default `false`: a centered modal that dismisses itself takes a just-arrived result off the screen, so a completion banner reports the outcome instead and closing stays your decision. Set `true` for the old auto-dismiss. |
| `completionNotifyStrategy`   | `auto` (the default), `custom-message`, and the reserved `synthetic-tool-pair` alias all resolve to the supported `custom-message` wake. The reserved value logs a warning and falls back. |
| `notifyOnFailure`            | Enable/disable early bounded `delegate:fork-failed` wakes for background direct workers, supervised runs, or chain steps. Default `true` (on by default); set `false` to opt out to aggregate-only behavior. Per-call `notifyOnFailure` overrides this setting. The aggregate completion wake is always emitted. |
| `activityTicker`             | Default-on deterministic footer activity in eligible interactive foreground sessions. `enabled: false` disables it; omitted `model` means zero ticker provider calls, cost, and provider-bound egress; explicit `provider/model` pins the destination; model `"auto"` selects only `anthropic/claude-haiku-4-5` and fails closed when unavailable. Cadence, concurrency, timeout, terminal grace, privacy allowlist, and separate ticker cost counters are documented in [`docs/activity-ticker.md`](activity-ticker.md). |
| `ptmBridge.handleRequests`   | pi-prompt-template-model bridge. `auto` (default) listens iff the legacy `~/.pi/agent/extensions/subagent` is absent. `always` always wins. `never` disables. See `docs/prompt-template-bridge.md`. |

Missing file / bad JSON / unreadable file degrade to `{}` with at most one
warning — config loading never blocks a tool call. A `config.local.json`
overlay next to `config.json` is merged on top (overlay wins per key), so
runtime-specific settings stay out of the extension package checkout. On
startup/load, legacy config files under
`~/.pi/agent/extensions/pi-delegate/{config.json,config.local.json}` are moved
to `~/.pi/agent/config/pi-delegate/` when the destination file does not already
exist; if both exist, the new location wins and the legacy file is left for
manual merge/removal.

`skill.excludeSections` is re-read during startup and resource reload. Pi package filters, `autoload`, project trust, and direct/CLI loading remain authoritative; a disabled package skill is not re-enabled by this setting. This setting does not interpolate runtime timeout values into skill prose.

Other knobs: `windDownGraceMs` (global fallback grace window after the
per-run wall-clock budget before hard-cancel; default 90s),
`max_duration_ms` / `wind_down_grace_ms` on agent definitions and on solo or
supervised run entries (invocation > agent > global; `0` explicitly disables
unless a positive global ceiling is configured; a positive floor alone does not
create a deadline for zero or no selected duration), `heartbeatIntervalMs` /
`maxConsecutiveHeartbeats` / `heartbeatTailLines` (see `docs/heartbeat.md`;
`maxConsecutiveHeartbeats` sends a one-shot wind-down steer, and hard abort
follows only after the additional heartbeat grace intervals; these settings tune
supervised channels, while direct runs use the built-in 3min × 5 silence bound),
`cancelForkShortcut` / `cancelForkBypassShortcut` / `cancelConfirmCostUsd` /
`cancelConfirmRuntimeMs` (overlay cancel guards), `intercomBridge` (see
pi-intercom docs).

## Environment variables

| Variable                   | Direction  | Meaning |
| -------------------------- | ---------- | ------- |
| `PI_DELEGATE_CHILD`        | *internal* | Set to `"1"` by pi-delegate on every spawned child pi process (driver hosted agents, worker children). The extension uses it to suppress **foreground-only** startup logic in children — hydrate-and-deliver, pending-wake redelivery, widgets. Do not set it yourself; unsetting it inside a child would make the child misbehave as if it were a foreground session. |
| `PI_DELEGATE_ASCII`        | user       | Set to `"1"` to force the ASCII icon vocabulary on every delegate surface — footer, below-editor widget, and transcript overlay — whatever `footerIcons` is set to. `TERM=dumb` enables the same fallback automatically. |
| `PI_DELEGATE_DEBUG`        | user       | `"1"` echoes the file-routed diagnostics (`<agentDir>/extensions/pi-delegate/event-bus/diagnostics.log`, spec 0017) to `console.warn` and enables raw-RPC-frame verbosity. Detached-child capture is always on; this flag does not gate childlogs. |
| `PI_OFFLINE`               | both       | Honoured by pi itself (suppresses model-catalog updates). pi-delegate **temporarily overlays it as `"1"`** around each worker resource reload so a burst of N parallel workers doesn't trigger N concurrent model-update fetches. The overlay is async-local and never changes the foreground environment. |

Internal lineage/control variables (`PI_DELEGATE_LINEAGE_*`,
`PI_DELEGATE_CONTROL_SECRET`) are spawn-env plumbing with integrity
checks — never set or forward them manually.

### Diagnosing a stalled detached driver run

Detached driver capture is always on. Inspect the per-run childlog at
`<agentDir>/extensions/pi-delegate/orchestrate/logs/<runId>.childlog` (with one
rotated predecessor at `.childlog.1`) while diagnosing a stalled run. The log
contains the runner lifecycle, bounded structured RPC diagnostics, and the
terminal classification (`terminal` and `reason`). `PI_DELEGATE_DEBUG=1` adds
the raw RPC frames and echoes file-routed diagnostics to `console.warn`; it is
not required for the childlog to exist.

Unknown RPC events are rendered as bounded JSON metadata. The fallback
allowlist admits only known-safe root-level scalar fields; all other fields,
including prompts, messages, model output, credentials, and tokens, are omitted
with a marker rather than copied into this log.

## Additional top-level keys

These top-level keys are also accepted by `config.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `delegateOnly` | See the table below. | Set read and result byte limits, add foreground tool grants, and cap nested delegation while delegate-only mode is active. |
| `footerIcons` | `"nerd-font"` | Select `"nerd-font"`, `"unicode"`, or `"ascii"` for the footer, status widget, and transcript inspector. `PI_DELEGATE_ASCII=1` and `TERM=dumb` force ASCII. |
| `inspectTailLines` | `10` | Reserve the recent-transcript tail size for `inspect_worker`; values must be at least 1. |
| `disableBuiltins` | `false` | Hide every builtin agent before user, package, and project definitions are merged. |
| `agentOverrides` | none | Apply per-agent model, tool, skill, extension, timeout, nesting, environment, and enable/disable overrides after discovery. |
| `intercomBridge.mode` | `"always"` when pi-intercom is available | Use `"off"`, `"always"`, or `"fork-only"` to control worker instruction injection. |
| `intercomBridge.instructionFile` | built-in instructions | Read a non-empty Markdown instruction template. The template may contain `{orchestratorTarget}`. |

`mode`, `instructionFile`, and `handleRequests` are nested fields of `intercomBridge` or `ptmBridge`, as shown above and in the main field table.

`delegateOnly` accepts these fields:

| Field | Default | Limit |
| --- | --- | --- |
| `allowlist` | `[]` | Additional non-empty tool-grant selectors. The mode also keeps its built-in session-state and control grants. |
| `readBytesPerCall` | `16384` | Finite, non-negative integer bytes. |
| `readBytesPerTurn` | `65536` | Finite, non-negative integer bytes. |
| `resultAdvisoryBytes` | `4096` | Finite, non-negative integer bytes before the worker is asked for a shorter result. |
| `resultHardCapBytes` | `16384` | Finite, non-negative integer bytes retained in a returned result. |
| `nestingDepth` | `2` | Safe integer from 0 through the hard delegation-depth ceiling of 16. |
