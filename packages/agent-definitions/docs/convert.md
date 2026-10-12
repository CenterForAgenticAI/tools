# Convert agent files

The `convert` command reads one agent file and writes the equivalent file for another tool. It prints a lowering report for every field that the target cannot keep.

```sh
agent-definitions convert --from <format> --to <format> [--write] [--json] <file>
```

Supported names are `agent-definitions`, `claude-code`, `codex`, `copilot`, `gemini-cli`, `opencode`, and `pi-agents`. A conversion is a dry run unless `--write` is present. A dry run prints each target path and its text, followed by the import and export lowering reports. `--json` prints one object with `files` and `reports` arrays.

`--write` creates target directories below the current working directory. It refuses an existing target and refuses a path that resolves outside the working directory. An import failure or refused write exits with status 1. Invalid arguments and unknown format names exit with status 2.

## Unmapped foreign fields

An importer never silently discards a foreign frontmatter key. A key without a canonical mapping is stored under `runtimes.<format>` and appears in the import report with action `unmapped`. Exporting to the same format writes those values back as native frontmatter keys. The `required` member of a runtime block is canonical metadata, so exporters do not write it as a native key.

## OpenCode

Project agents are written to `.opencode/agents/<name>.md`. The filename supplies the name because OpenCode Markdown frontmatter does not contain a name field.

Reference: [OpenCode agents](https://opencode.ai/docs/agents/).

| Agent Definitions | OpenCode | Result |
|---|---|---|
| `description` | `description` | Preserved. |
| `instructions.text` | Markdown body | Preserved. |
| `tools`, `disallowedTools` | `permission` | Portable categories become permission keys. The report marks the conversion as weakened because exact tool spellings and denylist structure are not retained. |
| `model` | `model` | One model is preserved. Fallback models are reduced to the first model and reported. |
| `limits.maxTurns` | `steps` | Preserved. |
| `effort` | none | Dropped and reported. |
| `invocation` | `mode`, `hidden` | No exact mapping. Canonical controls are dropped; imported native keys are kept under `runtimes.opencode`. |
| `workspace.isolation` | none | Dropped and reported. An edit-denying permission imports as a tool list without `edit`; it is not treated as isolation. |
| `context`, `skills`, `services` | none | Dropped and reported when non-default. |

OpenCode has no canonical equivalents for options such as `temperature`, `mode`, and `hidden`. Imports preserve them under `runtimes.opencode`.

## Claude Code

Project subagents are written to `.claude/agents/<name>.md`.

Reference: [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

| Agent Definitions | Claude Code | Result |
|---|---|---|
| `name`, `description` | `name`, `description` | Preserved. |
| `instructions.text` | Markdown body | Preserved. |
| `tools`, `disallowedTools` | `tools`, `disallowedTools` | Claude tool names are used. A spelling or coarse portable-category change is reported as weakened. |
| `model` | `model` | One model is preserved. Fallback models are reduced to the first model and reported. |
| `effort.default` | `effort` | `low`, `medium`, `high`, `xhigh`, and `max` are preserved. `off`, `minimal`, and effort bounds are dropped and reported. |
| `limits.maxTurns` | `maxTurns` | Preserved. `timeoutMinutes` is dropped and reported. |
| `workspace.isolation: worktree` | `isolation: worktree` | Preserved. |
| `workspace.isolation: ephemeral` | `isolation: worktree` | Weakened and reported because Claude Code keeps worktree changes. |
| `context.project`, `context.user` | `omitClaudeMd` | Both can be disabled together. A mixed value is tightened and reported. |
| `skills` | `skills` | Name-only required skills are preserved. Source, version, and optional status are weakened and reported. |
| `invocation`, `services` | none | Dropped and reported when non-default. |

Claude-only fields such as `permissionMode`, `mcpServers`, `hooks`, `memory`, `background`, `initialPrompt`, `color`, and `experimental` are preserved under `runtimes.claude-code` on import and restored on export.

## GitHub Copilot

Project custom agents are written to `.github/agents/<name>.agent.md`. An omitted native `name` imports from the filename.

References: [creating custom agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents) and [custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

| Agent Definitions | GitHub Copilot | Result |
|---|---|---|
| `name`, `description` | `name`, `description` | Preserved. |
| `instructions.text` | Markdown body | Preserved. |
| `tools` | `tools` | Portable aliases are native. Other spellings and namespaced MCP tools are normalized and reported as weakened. |
| `disallowedTools` | none | Dropped and reported. |
| `model` | `model` | One model is preserved. Fallback models are reduced to the first model and reported. |
| `invocation.model` | `disable-model-invocation` | Preserved with inverse boolean meaning. Retired `infer` still imports when the modern field is absent. |
| `invocation.user` | `user-invocable` | Preserved. |
| `metadata` | `metadata` | Preserved. |
| `effort`, `limits`, `workspace.isolation`, `context`, `skills`, `services` | none | Dropped and reported when non-default. |

Copilot-only fields such as `target` and `mcp-servers` are preserved under `runtimes.copilot` on import and restored on export.

## Codex

Official reference: [Codex subagents](https://developers.openai.com/codex/agent-configuration/subagents).

Project-scoped custom agents are standalone TOML files at `.codex/agents/<name>.toml`. Codex also supports personal files at `~/.codex/agents/`. Each file requires `name`, `description`, and `developer_instructions`; it can also contain normal Codex session configuration keys.

| Canonical field | Codex field | Conversion |
| --- | --- | --- |
| `name` | `name` | Exact. |
| `description` | `description` | Exact. |
| `instructions.text` | `developer_instructions` | Exact string, including quotes, newlines, and backslashes. |
| `model` | `model` | The first model is written. Additional fallback models are weakened. |
| `effort.default` | `model_reasoning_effort` | Exact. `effort.min` and `effort.max` are dropped. |
| `tools` | none | Explicit portable tool lists are dropped. Native tool and MCP settings can survive under `runtimes.codex`. |
| `invocation` | none | Non-default invocation flags are dropped. |
| `limits` | none | Per-agent turn and timeout limits are dropped. |
| `workspace.isolation` | none | Dropped. Codex `sandbox_mode` controls permissions, not worktree or ephemeral workspace copies, so the converter does not claim equivalence. |
| `context` | inherited session behavior | Non-default switches and `context.files` are dropped. |
| `skills` | `skills.config` is native-only | Portable required-skill entries are dropped because Codex skill configuration has different semantics. |
| `services` | none | Dropped. |
| `disallowedTools` | none | Dropped. |

Unknown native TOML keys are imported under `runtimes.codex`, reported as `unmapped`, and written back on export. The built-in TOML reader and writer cover the scalar, array, and inline-table subset that the exporter emits; no TOML dependency is added.

Other export losses are `version`, instruction includes or append mode, nested-agent restrictions, requirements, result schema and artifacts, another runtime's options, the required-runtime flag, `license`, and `metadata`.

## Gemini CLI

Official reference: [Gemini CLI subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md).

Project subagents are Markdown files with YAML frontmatter at `.gemini/agents/<name>.md`. User files live at `~/.gemini/agents/`. The Markdown body is the subagent system prompt.

| Canonical field | Gemini CLI field | Conversion |
| --- | --- | --- |
| `name` | `name` | Exact. |
| `description` | `description` | Exact. |
| `instructions.text` | Markdown body | Exact. Append mode and instruction includes are not supported. |
| `model` | `model` | The first model is written. Additional fallback models are weakened. |
| `effort` | none | Dropped. |
| `tools` | `tools` | Portable categories map to representative Gemini names: `execute` → `run_shell_command`, `read` → `read_file`, `edit` → `write_file`, `search` → `grep_search`, and `web` → `google_web_search`. Unsupported categories are omitted and the field is reported as weakened. Unknown Gemini tool names survive as `gemini-cli:<name>`. |
| `invocation` | none | Non-default invocation flags are dropped. |
| `limits.maxTurns` | `max_turns` | Exact positive integer. Gemini defaults to 30 when omitted. |
| `limits.timeoutMinutes` | `timeout_mins` | Exact positive integer. Gemini defaults to 10 when omitted. |
| `workspace.isolation` | isolated context only | Dropped because Gemini context isolation does not create an isolated workspace. |
| `context` | none | Non-default switches and context files are dropped. |
| `skills` | none | Dropped. |
| `services` | none | Dropped. Native `mcp_servers` remains runtime-specific. |
| `disallowedTools` | external policy | Dropped; Gemini applies deny rules outside the subagent file. |

Other native keys, including `kind`, `display_name`, `temperature`, and `mcp_servers`, are imported under `runtimes.gemini-cli`, reported as `unmapped`, and written back on export. An explicit empty native `tools` list is kept in that runtime block because the canonical parser rejects an empty portable tool list.

Other export losses are `version`, nested-agent permissions, requirements, result schema and artifacts, another runtime's options, the required-runtime flag, `license`, and `metadata`.

## pi-agents 0.30.0

Official references: [agent profiles](https://github.com/mavam/pi-agents/blob/v0.30.0/docs/profiles.md) and the [profile parser](https://github.com/mavam/pi-agents/blob/v0.30.0/src/catalog/profiles.ts).

Project profiles are Markdown files with YAML frontmatter at `.pi/agents/<name>.md`. Version 0.30.0 accepts exactly seven frontmatter keys: `name`, `description`, `model`, `thinking`, `skills`, `tools`, and `delegate`. Unknown keys are rejected. The Markdown body extends the agent system prompt.

| Canonical field | pi-agents field | Conversion |
| --- | --- | --- |
| `name` | `name` | Exact. |
| `description` | `description` | Exact. |
| `instructions.text` | Markdown body | Exact text. `instructions.mode: replace` is weakened because pi-agents always appends the body. |
| `model` | `model` | The first model is written. Additional fallback models are weakened. |
| `effort.default` | `thinking` | Exact. `effort.min` and `effort.max` are dropped. |
| `tools` | `tools` | Exact Pi built-in names are retained. Portable categories translate to representative built-ins. Unsupported tools are omitted and reported as weakened. |
| `agents` | `delegate` | `[]` omits the key. `*` writes `delegate: true`. A named allowlist also writes `true` and is reported as weakened because the target cannot retain names. |
| `invocation` | none | Non-default invocation flags are dropped. |
| `limits` | none | Dropped. |
| `workspace.isolation` | none | Dropped. |
| `context.project`, `context.user`, `context.files` | none | Non-default values are dropped. |
| `context.skills` | skill catalog behavior | Omitting `skills` keeps the ambient catalog. An explicit skill list disables ambient skills; that combination is reported as weakened when the canonical definition requested both. |
| `skills` | `skills` | Names are written. Source, version, and required metadata are weakened. An empty list disables skills. |
| `services` | none | Dropped. |
| `disallowedTools` | none | Dropped. |

The exporter never writes an eighth key. An unsupported imported key is retained under `runtimes.pi-agents` and reported as `unmapped`, but export drops and reports it because pi-agents would reject it. Supported native keys under that runtime block are written back. The portable required-runtime flag is dropped.

Other export losses are `version`, instruction includes, requirements, result schema and artifacts, another runtime's options, `license`, and `metadata`.

## Names

Converters keep `name` as written. A name that is not lowercase letters, digits and hyphens keeps its `name-spelling` warning after conversion, including a round trip back to the same format. Rename the agent by hand to clear the warning.

## Canonical files

Use `agent-definitions` on either side to parse or write the canonical format. Canonical output is `<name>.md`. It uses canonical field names, omits default-valued fields, and places `instructions.text` in the Markdown body.
