# Usage reference

For users configuring or controlling adaptive thinking, this page preserves the detailed tool, command, shortcut, and configuration reference.

## How it works

Pi's thinking effort levels (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`) are normally a static user setting. This extension exposes a `set_thinking_effort` tool that the LLM can call mid-response to change its reasoning depth, with an explicit scope and mandatory reason. The default agent ceiling remains `xhigh`; `max` becomes agent-selectable only when the user explicitly widens configured bounds to include it.

### The agent is only offered levels the model can run

Not every model exposes every level, and the ladder has holes: in Pi 0.84.2's
catalog, 67 models expose `max` without exposing `xhigh`, and `claude-opus-4-5`
exposes neither. The levels the agent sees are therefore the **intersection** of
your configured bounds with the active model's own capabilities:

- The `set_thinking_effort` JSON-schema enum contains exactly those levels, and
  is re-registered whenever the model changes.
- The tool description names only those levels. It travels with the schema, so
  it is always current. With a `xhigh` ceiling the agent is never told about
  `max`.
- The prompt snippet and guidelines name no level at all. Pi bakes those into
  the base system prompt when the tool is registered, so a level named there
  could outlive a model change; they point at the `<thinking-effort>` block,
  which is rebuilt every turn.
- The `<thinking-effort>` block lists them, and names any level your bounds
  allow that the model withholds, so a short list does not read as a mystery.
- When the intersection is empty the tool is removed from the active set for
  that session and the block says so.
- When Pi itself has filtered the tool out — `--no-tools`, `--tools`,
  `--exclude-tools` — the block says that instead of blaming the model, and
  prints no level list. Wanting the tool active is not the same as having it,
  so this is read from Pi's active tool set rather than assumed.

Configured bounds are never rewritten. The model only narrows what is offered.

### Tool: `set_thinking_effort`

```
set_thinking_effort({ level: "high", reason: "multi-file refactor across 8 modules" })
set_thinking_effort({ level: "low", reason: "simple formatting question", scope: "this_response" })
set_thinking_effort({ level: "xhigh", reason: "debugging race condition", scope: "next_N", turns: 3 })
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `level`   | ✓ | Target thinking level. The enum holds only levels within your bounds that the active model supports |
| `reason`  | ✓ | Why the change is needed — helps calibrate future decisions |
| `scope`   | | `this_response` (default), `next_N`, or `until_changed` |
| `turns`   | | Number of responses to maintain override (required when scope is `next_N`) |

### Override scopes

| Scope | Behavior |
|-------|----------|
| `this_response` | Elevated for the current agent run only; reverts at `agent_end` |
| `next_N` | Elevated for N complete agent runs, then reverts |
| `until_changed` | Stays elevated until explicitly changed |

### System prompt injection

On every turn, the extension injects a `<thinking-effort>` block into the system prompt so the LLM sees its current thinking state, the allowed range, and guidelines for when to escalate or de-escalate. GPT/OpenAI-family models also receive a small model-specific reminder to make the escalation preflight the first tool call when the user prompt already signals complex work.

If the selected model advertises `compat.forceAdaptiveThinking`, the extension guards against Pi's disabled-thinking mode by substituting `minimal` for `off` when needed. This substitution is silent: several catalog models set `compat.forceAdaptiveThinking` while their `thinkingLevelMap` still omits `"off": null`, so Pi's own `Shift+Tab` cycle keeps offering `off` and a warning would fire every time you passed through it. See [Removing `off` from Pi's own cycle](#removing-off-from-pis-own-cycle). Manual user thinking-level changes are treated as the new session baseline and clear any active agent override. An ordinary-session manual `max` remains selected and visible in status/snapshots, but does not silently rewrite the global configuration or widen agent authority.

### Status bar status

The extension provides an adaptive-thinking status item in Pi's status bar:

```
🧠 medium                    — baseline, no override
🧠 high ↑ (this response)    — elevated for current run
🧠 high ↑ (2 responses left) — elevated for N runs
🧠 high ↑ (persistent)       — until_changed
```

Bounds and scope details are available from `/thinking-status`.

## Commands

| Command | Description |
|---------|-------------|
| `/thinking-baseline <level\|status>` | Set or view the baseline thinking level |
| `/thinking-higher` | Move one level higher through the active model's supported levels |
| `/thinking-lower` | Move one level lower through the active model's supported levels |
| `/thinking-bounds <min> <max>` | Set the agent-selectable range; accepts `model-min`/`model-max` |
| `/thinking-status` | Full state dump, including what the model supports and what the agent can select |
| `/thinking-reset` | Clear override, revert to baseline |
| `/thinking-toggle` | Enable/disable dynamic agent-controlled thinking changes |

### Manual directional controls

`/thinking-higher` and `/thinking-lower` also use `Alt+.` and `Alt+,`,
respectively. They derive a fresh candidate list from the
active model before every action. The list keeps Pi's canonical order, removes
levels the model does not support, preserves non-contiguous capability sets,
and intersects bounds only while a session-local delegate policy is active.
Global `minLevel` and `maxLevel` remain agent authority in ordinary sessions.

Each action moves exactly one candidate and never wraps at the lowest or
highest endpoint. A successful move clears an agent override and becomes the
user baseline. It does not widen delegated authority or write delegated bounds
to global configuration. Force-adaptive models, including `claude-opus-5`, do
not expose `off` as a candidate. Provider validation repeats the fresh model
check and aborts rather than sending an unsupported transient level.

`Shift+Tab` remains Pi's reserved built-in thinking-cycle shortcut; this
extension does not register or replace it. Unlike `Shift+Tab`, the directional
controls do not wrap and are filtered to the active model's levels.

The chords are `Alt`-prefixed because a terminal sends them as an escape
sequence Pi can read. The earlier `Alt+Shift+Tab` and `Ctrl+Shift+Tab` bindings
were replaced: terminals bind `Ctrl+Shift+Tab` to "previous tab" and mostly
cannot encode it at all, and window managers take `Alt+Shift+Tab` for reverse
window switching. Extension shortcuts are registered in code, so they cannot be
remapped from `~/.pi/agent/keybindings.json`.

## Configuration

`~/.pi/agent/adaptive-thinking.json`

```json
{
  "baseline": "medium",
  "enabled": true,
  "minLevel": "low",
  "maxLevel": "xhigh"
}
```

The default `xhigh` ceiling preserves existing configurations and causes an agent request for `max` to clamp to `xhigh`. To explicitly permit agent-selected `max`, widen the bound:

```json
{
  "baseline": "medium",
  "enabled": true,
  "minLevel": "low",
  "maxLevel": "max"
}
```

### Bounds that follow the model: `model-min` and `model-max`

A fixed ceiling behaves inconsistently across models, because Pi's canonical
order is not the order every model implements. With `"maxLevel": "xhigh"` the
agent's top level on `claude-opus-4-6`, `deepseek-v4-pro`, `glm-5.2`, or
`kimi-k3` is `high` — those models expose `max` but no `xhigh`, so the ceiling
silently removes all escalation headroom.

`minLevel` and `maxLevel` therefore also accept two sentinels:

| Value | Meaning |
|-------|---------|
| `model-min` | The lowest level the active model exposes |
| `model-max` | The highest level the active model exposes |

```json
{
  "baseline": "medium",
  "enabled": true,
  "minLevel": "low",
  "maxLevel": "model-max"
}
```

This keeps `max` opt-in — you still have to choose it — while adapting to each
model instead of naming one level that some models do not have. `/thinking-status`
and `/thinking-bounds status` show both the sentinel and what it resolved to,
for example `low–model-max (max)`.

Resolution rules:

- The default stays the literal `xhigh`. Nothing changes unless you opt in.
- With no model observed yet, a sentinel falls back to the built-in default
  bound (`low` / `xhigh`) rather than guessing.
- If the resolved floor ends up above the resolved ceiling, the ceiling wins:
  a model's capability is a hard limit and a preference is not.
- Under a `pi-delegate` worker policy, a sentinel in the global fallback
  resolves against the built-in defaults, not the worker's model. A worker's
  authority is fixed by its caller, and re-reading the sentinel per worker
  model would let the worker widen past what the caller granted.

### Removing `off` from Pi's own cycle

This is a Pi model-catalog gap, not an extension setting. Several models carry
`compat.forceAdaptiveThinking: true` — they reject `thinking: {type:"disabled"}`
— while their `thinkingLevelMap` omits `"off": null`. `claude-fable-5` has the
entry; `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`,
`claude-sonnet-4-6`, and `claude-sonnet-5` do not.

Pi's built-in `Shift+Tab` cycle reads `getSupportedThinkingLevels()`, so it
still offers `off` on those models. This extension corrects the level, but it
cannot remove a level from Pi's cycle. Fix it at the source in
`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-opus-5": { "thinkingLevelMap": { "off": null } }
      }
    }
  }
}
```

`modelOverrides.thinkingLevelMap` merges key by key, so `xhigh` and `max` are
preserved. Pi reloads the file whenever you open `/model`; no restart needed.
