# File format

This page specifies the Agent Definitions 0.1 file format. [decisions.md](decisions.md) records the reason for each rule.

## File layout

An agent definition is a UTF-8 text file: YAML frontmatter between two fence lines, then a Markdown body.

- The first line is the opening fence: exactly `---`, optionally followed by spaces or tabs. A file that does not start this way is not an agent definition. A blank line or an indent before the fence is not allowed.
- The frontmatter ends at the next line that is exactly `---`, optionally followed by spaces or tabs. `----` and an indented `---` do not end it.
- Everything after the closing fence is the body, including any later `---` lines. The body is kept as written; only line endings change.
- A byte order mark at the start is dropped. Windows line endings (`\r\n`) are read as `\n`. Line numbers count lines of the original file.
- `...` does not close the frontmatter, unlike a YAML document end marker.

The splitter reports two errors, each with a line number: `missing-opening-fence` and `missing-closing-fence`.

## Fields

`name`, `description`, and a non-blank Markdown body are required. `name` cannot contain `:`. A name outside lowercase letters, digits, and single hyphens loads with a warning. The parser returns the following canonical fields:

| Field | Authoring form | Parsed default |
|---|---|---|
| `name` | non-empty string without `:` | required |
| `description` | non-empty string | required |
| `schemaVersion` | `1` | `1` |
| `version` | string | `null` |
| `instructions` | `{ mode: append \| replace, include: string[] }`; the body is `text` | body, `replace`, `[]` |
| `model` | a string or non-empty string list | `["inherit"]` |
| `effort` | a level or `{ default, min, max }` | all three values `null` |
| `context` | `{ project, user, skills, files }` | booleans `true`; files `[]` |
| `tools` | `inherit`, a list, or a comma-separated string | `inherit` |
| `disallowedTools` | a list or comma-separated string | `[]` |
| `agents` | names, package-qualified IDs, or `*` alone | `[]` |
| `skills` | names or `{ name, source, version, required }` | `[]` |
| `services`, `requires` | string lists | `[]` |
| `workspace` | `{ isolation: shared \| worktree \| ephemeral }` | `shared` |
| `invocation` | `{ model, user }` booleans | both `true` |
| `limits` | positive integer `maxTurns` and `timeoutMinutes` | both `null` |
| `result` | `{ schema, artifacts }`; artifacts are paths or `{ path, check }` | `null`, `[]` |
| `runtimes` | runtime-name to options map; each block can set `required` | `{}` |
| `license` | string | `null` |
| `metadata` | string-to-string map | `{}` |

The effort levels, in order, are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. When bounds are present, `min <= default <= max` must hold. Runtime names use lowercase letters, digits, and hyphens. Unknown fields fail, except options inside a runtime block, keys in `metadata`, and keys in `result.schema`.

### Context

`context.project` loads project instruction files from the working directory and its parents, such as `AGENTS.md` or `CLAUDE.md`. pi also loads `.pi/APPEND_SYSTEM.md`. `context.user` loads the same kind of files from the user's agent directory, such as `~/.pi/agent/AGENTS.md`. `context.skills` controls inherited skills. All three switches default to `true`. The caller selects parent conversation history for each run; history is not part of `context`.

`context.files` is a YAML list of workspace files to place in the agent's first message. An entry is a path or `{ path, required }`; `required` defaults to `false`. Paths stay as written. They must be relative, use `/`, contain no `..` segment, NUL, backslash or glob character (`*`, `?`, `[`, `]`, `{`, `}`), and cannot start with `/`, `\\`, a drive letter or `~`. Duplicate paths are errors. Legacy `defaultReads` accepts a list or comma-separated string and maps each path to `context.files` with `required: false`.

At load time, call `resolveContextFiles` before launching the agent. It resolves the workspace and each file through symlinks. A target outside the real workspace, or a target that is not a regular file, is an error. A missing optional file is skipped with a warning; a missing required file is an error. Do not launch when the result has `ok: false`. Read each returned `realPath` straight away. A file can still change between resolution and reading.

### Skills

`skills` lists the skills preloaded in full when the agent starts. An entry is a name or `{ name, source, version, required }`. `context.skills` says whether the agent also sees the parent session's other skills; it defaults to `true`.

The format has no field that keeps a skill away from the main agent while named agents still get it (decision F20). In pi, a skill with `disable-model-invocation: true` in its own frontmatter is left out of the skill list in the prompt, but any agent can still load it by name. To give such a skill to one agent, list it in that agent's `skills`.

### Tools

Portable tool names are `execute`, `read`, `edit`, `search`, `agent`, `web`, and `todo`, matched without regard to case. Claude Code and pi names map onto those portable names. The parsed entry keeps the written name as well as its portable meaning. Other tools must be namespaced, for example `mcp:github/create_issue`, `pi:anchor_grep`, or `ext:package/tool`. Claude Code's `mcp__server__tool` form loads as `mcp:server/tool` with a warning. An explicitly empty `tools` list is an error.

### Compatibility spellings

Current legacy and foreign spellings load with a warning: `systemPrompt`, `systemPromptMode`, `inheritProjectContext`, `omitClaudeMd`, `inheritSkills`, `defaultReads`, `thinking`, `thinkingMin`, `thinkingMax`, `fallbackModels`, `nestedDelegateAgents`, `allowNestedDelegate`, `artifact`, `defaultProgress`, top-level `isolation` and `maxTurns`, and Claude Code's runtime-only fields. Snake-case and kebab-case top-level spellings also load with a warning. Writing two spellings of the same field is an error.

A definition loaded with `origin: "package"` cannot declare non-empty `services`, MCP servers, hooks, or permission changes. The restriction applies to top-level compatibility fields and to every runtime block.

The machine-readable canonical authoring form is published as `@centerforagenticai/agent-definitions/schema.json`.

## Diagnostics

`parseDefinition` returns diagnostics in source order where practical. A diagnostic has `severity`, stable `code`, field `path`, `message`, and a 1-based whole-file `line` when the parser can identify one.

- `error`: the definition does not load. `ok` is `false` if and only if at least one error exists.
- `warning`: the definition loads, but the author should change it.
- `hint`: an optional suggestion.

Paths use the spelling in the source file. Nested paths use dots and list indexes, such as `tools[1]` and `runtimes.claude-code.color`. A whole-frontmatter problem uses the empty path. A body problem uses `instructions`.

## Adapter checks

`checkIsolation({ definition, requested, grant? })` compares isolation from loosest to strictest: `shared`, `worktree`, `ephemeral`. Equal or stricter requests pass. A looser request passes only with an `isolation-downgrade` grant whose `from` and `to` exactly match and whose `approvedBy` is non-empty. A passing downgraded result returns that grant so the run can record it.

`checkRuntime(definition, { runtime, knownKeys })` fails if another runtime block is marked `required: true`. It also fails if the selected runtime's block contains an option, other than `required`, that is absent from `knownKeys`. Non-required blocks for other runtimes are ignored.
