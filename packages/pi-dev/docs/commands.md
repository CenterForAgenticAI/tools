# Command reference

For Pi extension developers: the full `/dev` command list and context-usage controls.

## `/dev` command hub

Run `/dev` or `/dev help` for the in-session command list.

| Command | Behavior |
| --- | --- |
| `/dev tools [active\|all]` | Reads `getActiveTools()` and `getAllTools()` at invocation time. Shows the exact public `ToolInfo.parameters` schema rendered as YAML for readability, plus the description, prompt guidelines, source metadata, and active/inactive state in the main chat transcript. Defaults to active tools only. |
| `/dev prompt [--write PATH]` | Shows the effective system prompt: `ctx.getSystemPrompt()` verbatim, including extension/context injection already applied for the current runtime. While `--pi-dev-mode` is active it additionally projects the extension-authoring pointer that this package contributes through `before_agent_start`, so the output matches what the next agent turn receives rather than only what the API returns at rest. With the mode off, the output is `ctx.getSystemPrompt()` and nothing else. In the TUI viewer, press `c` to copy the raw prompt to the clipboard. `--write PATH` writes the exact prompt to that path instead of opening the viewer.
| `/dev context` | Shows the current compaction-aware branch returned by `ReadonlySessionManager.buildContextEntries()`, the corresponding messages projected with public `sessionEntryToContextMessages()`, model identity, and context usage, rendered as YAML. It does not walk inactive branches. |
| `/dev usage` | Opens a right-anchored hierarchical context-usage overlay. It refreshes every 750 ms while open and can also be opened with `Ctrl+Shift+U`, including while the agent is running. It separates the latest provider-reported total from a local `chars/4` allocation estimate, then groups the estimate by system-prompt input, extension stage, active tool source/tool/description/schema, and semantic message content. |
| `/dev extensions` | Groups observable tool and slash-command `sourceInfo`, plus package versions read only from each public `baseDir/package.json`. Also reports Pi and pi-dev versions. |
| `/dev ui [toggle\|on\|off\|status]` | Toggles a custom header/footer, extension status, above/below-editor widgets, terminal title, working message/indicator, and hidden-thinking marker. `off` clears widgets/status, restores built-in header/footer/working defaults, and resets the title to `pi`. Sessions loaded before a UI-key rename can retain old-key state; restart the session to clear that residue. |
| `/dev demo [help\|message\|entry\|tool\|dialogs\|overlay\|all]` | Exercises custom messages and renderers, durable custom entries and renderers, select/input/confirm dialogs, and a custom overlay. The extension also registers the agent-callable `pi_dev_demo` tool; the `tool` demo previews its shared echo behavior. The message demo participates in model context; the custom entry does not. |
| `/dev events [status\|on\|off\|show [N]\|clear]` | Controls opt-in, in-memory, bounded lifecycle tracing. `show` renders retained metadata as YAML. The default capacity is 200 records (hard maximum 1,000). |
| `/dev doctor` | Checks required public APIs, Pi/pi-dev versions, extension-authoring mode, and current persisted session state. It reads no prompt or session content. |

The usage overlay opens with the top two levels visible and deeper branches collapsed. The `›` marker shows the selected row; `▾` and `▸` show expanded and collapsed branches. Use `↑`/`↓` or `j`/`k` to select a row, `←`/`→` to collapse or expand and move between parent and child rows, and `Space` to toggle a branch. `PgUp`, `PgDn`, `Home`, and `End` move through longer trees. Descendants start in descending estimated-usage order; press `o` to toggle alphabetical source order. The three top-level categories remain fixed, and ordering applies only among rows with the same parent.

`/dev usage` measures exact character spans for structured prompt inputs that Pi exposes: the custom and appended prompt, context files, skill catalog entries, and active-tool prompt snippets/guidelines. An **append-only change** adds text without changing text already present; those extension additions can be measured exactly. If an extension rewrites or replaces prompt text, the overlay marks the rewrite, assigns the final prompt to an unattributed row, and excludes transient stage sizes instead of claiming false precision.

Skill rows measure the name, description, and location cataloged in the system prompt. They do not count a full `SKILL.md` body unless that body later enters the conversation through a read or invocation. Tool rows split each active tool's public description from its parameter schema and group both under `sourceInfo`. Provider-specific request wrappers are not public and are therefore not estimated.

Message rows classify user text and images, assistant text/reasoning/tool calls, tool results, custom messages, direct shell content, compaction summaries, and branch summaries. Images have no character length, so each image uses a fixed 4,800-character stand-in, or about 1,200 local estimated tokens.

Arguments are validated and slash-command completions are provided for subcommands and modes. Unknown subcommands, invalid limits, unmatched quotes, and extra arguments produce an error notification instead of falling through to the model.

`/dev tools` uses a durable custom session entry so its full output appears in normal main-window scrollback rather than overlaid on background content. The entry is persisted in the session but never participates in model context. Prompt and context inspection remain in the temporary viewer so invoking them does not duplicate sensitive content into the session file. The prompt viewer's `c` action copies its raw body without terminal formatting.
