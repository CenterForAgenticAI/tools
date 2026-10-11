# Format decisions

The maintainers settled eighteen decisions on 7 October 2026, then five parser defaults and six field decisions on 8 October, and the context, release and skill-scoping decisions on 8 and 9 October. Each row gives the decision and the reason for it.

Some reasons cite earlier design notes that are not published: decisions D6, D8 to D10, D14 and D19, and section 13 of a design draft from 24 September 2026.

## Names and terms

| ID | Decision | Reason |
|---|---|---|
| N1 | The project and the format are called **Agent Definitions**. | "Agent definition" is the term already in use, including Claude's Agent SDK type `AgentDefinition`. The npm names `agent-definitions` and `agentdefinitions` and the `@agent-definitions` scope were free on 7 October 2026. Names starting "Open Agent" are taken by three other projects. Not yet checked: GitHub organisation names and trademarks. |
| N2 | Rename the project now, and add a glossary to the README in the same change. | Nothing imported the package yet, and the old project path redirects. Done: the project was called agent-definition before. |
| N3 | Keep "model role" for model routing, always qualified. | Existing `role:<name>` model routing stays. No code changes. |
| N4 | Stop calling agent definitions "roles". Adopt the glossary in the README. | "Role" also means a model role, and a user role in access control. A converter for a format that calls the agent's name `role` maps it to `name`. |

## File format

| ID | Decision | Reason |
|---|---|---|
| F1 | A file with `name`, `description` and a body is a complete definition, so a Claude Code subagent file is valid. Every other field has a written default. `inherit` is an explicit value. `name` may not contain `:`. | Claude Code, Gemini CLI, OpenCode, Copilot and the pi subagent extension use the same shape. D14 already promised that Claude Code files keep working. |
| F2 | Portable tool names are GitHub Copilot's seven aliases: `execute`, `read`, `edit`, `search`, `agent`, `web`, `todo`. Claude Code names are aliases. Every other name is namespaced, such as `mcp:<server>/<tool>`. `disallowedTools` uses the same names. | It is the only published cross-tool vocabulary. The names are coarse; isolation (D10) covers what they cannot say. |
| F3 | `invocation: { model, user }`, two flags. | The section 13 enum could not say that both the model and people may pick an agent. |
| F4 | `limits: { maxTurns, timeoutMinutes }`. Reaching a limit ends the run with `status: partial`. | Claude Code, Gemini CLI, OpenCode and Docker Agent all have turn limits. |
| F5 | The converter exports as well as imports, with a lowering report per export. The linter suggests our spelling for other tools' field names. | People adopt a format by writing once and generating each tool's file. The report says what each target lost. |
| F6 | Keep D10: `workspace.isolation: shared \| worktree \| ephemeral` only. | D10 replaced the 24 September `workspace.writes` field. D6 gives the reason: workers are isolated instead of refused. |
| F7 | Out of 0.1: agents as directories, orchestration and sub-agent graphs, memory and writeback, persona and sampling settings, display colour, hooks, and Copilot handoffs. One file defines one agent. | Each belongs to the runtime, to actors, or under `runtimes.<runtime>`. |
| F8 | Options for one runtime go under `runtimes.<runtime>`. A block may set `required: true`. | Other formats ignore unknown runtime options silently. The flag lets an author say "do not run this without X". |
| F9 | The field is `effort`, with `thinking` as an alias. | Claude Code and Codex call it effort. pi-delegate files keep working through the alias. |

## Carried over from section 13

| ID | Decision | Reason |
|---|---|---|
| Q1 | An adapter that cannot enforce a required restriction refuses to launch, unless a person approves a downgrade. The approval is recorded with the run. | Adapter rule 5 of section 13. Silent ignoring is the failure this avoids. |
| Q2 | The same file serves one-shot runs and actors; the caller chooses. Actor-only settings wait, under `runtimes.fabric` until then. | D8 already loads one definition for `agents.run`, `spawn` and `create`. |
| Q3 | `instructions.mode: replace` replaces the runtime's default agent prompt only. Safety rules, managed policy and injected guidance always load. Project context is a separate switch. | Claude Code's `omitClaudeMd` works the same way, and our guidance already reaches workers that use replace. |
| Q4 | The first sample: the maintainers' own `implementer`, `reviewer` and `scout`; one agent in an internal product's format; one Claude Code file and one OpenCode file. R3 later moved the private files to their own repositories. | The two outside files test that foreign definitions load. |
| Q5 | Skills have a short form (a name) and a long form `{ name, source, version, required }`. Listed skills are preloaded. Definitions from a package cannot add MCP servers, hooks or permission changes. | Names alone cannot tell two versions of one skill apart. Claude Code applies the same limit to plugin agents. |

## Parser defaults, 8 October 2026

| ID | Decision | Reason |
|---|---|---|
| P1 | Omitting `tools` means `inherit`: every tool the parent session has. | Claude Code, Gemini CLI and Codex do the same, so a Claude Code file means the same thing here. The pi-delegate importer writes an explicit list. |
| P2 | Project context is `context.project`, default `true`. pi-delegate's `inheritProjectContext` and Claude Code's `omitClaudeMd` are read into it with a warning. | Matches Claude Code. `context` can later hold the history settings section 13 lists. |
| P3 | Omitting `invocation` means `{ model: true, user: true }`. | Claude Code and Copilot do the same. |
| P4 | pi tool names are aliases: `bash` is `execute`; `edit` and `write` are `edit`; `grep`, `find` and `ls` are `search`; the `delegate` tools are `agent`. The parsed result keeps the written name and records the portable name beside it. | A pi runtime still grants exactly `grep`, not all of `search`. |
| P5 | A Claude Code field with no portable meaning, such as `color`, is read under `runtimes.claude-code` with a warning. A field no format defines still fails. | Without it, strict validation rejects real Claude Code files and breaks F1. |

P1 and P2 give more access than pi-delegate gives today to a file that omits the field. The 0.1 tracking issue lists the affected files.

## Field homes, 8 October 2026

Six fields in current pi-delegate files had no place in the 0.1 field table. Since an unknown field fails, those files could not load. F10 to F13 give each one a home. F14 and F15 take ideas from Agent Format (agentformat.org).

| ID | Decision | Reason |
|---|---|---|
| F10 | `model` takes one model or an ordered list. Each entry is tried when the one before it is unavailable. pi-delegate's `fallbackModels` is read into the list with a warning. | Copilot uses the same list form, so one field does the job of two. pi-delegate also moves on when a model refuses the prompt; that stays runtime behaviour. |
| F11 | `agents` lists the agents this agent may start: names, `*` for any, or `[]` for none. Omitting it means none. pi-delegate's `nestedDelegateAgents` list becomes `agents`; `allowNestedDelegate: true` without a list becomes `*`. | Copilot's field. "None" keeps pi-delegate's rule that sub-agents are off unless enabled. That matters because omitting `tools` now inherits the `agent` tool (P1). |
| F12 | `context.skills`, default `true`, says whether the agent sees the parent session's skills beyond the ones it lists. Listed skills are always preloaded (Q5). pi-delegate's `inheritSkills` is read into it with a warning. | Claude Code subagents can use skills they do not list. Follows P2. |
| F13 | pi-delegate's `artifact: <file>` becomes one entry in `result.artifacts`. `defaultProgress` goes under `runtimes.pi-delegate`. | `result` already declares artifacts (24 September). Progress files belong to chains, which become Fabric saved programs. |
| F14 | A caller may tighten a definition but not loosen it. A per-call or saved override may narrow `tools`, `agents` and `limits`, or ask for more isolation. Loosening any of them needs the person-approved downgrade from Q1, recorded with the run. | Agent Format's `tighten_only_invariant` says the same. pi-delegate already applies it to sub-agent depth. Without it, an override can quietly undo a restriction the file sets. |
| F15 | Also taken from Agent Format and the Agent Skills spec: an optional `license` and a `metadata` map of strings; a lint warning for a `name` that is not lowercase letters, digits and hyphens; conformance levels in the suite, "parses" and "enforces"; lint severities `error`, `warning` and `hint`. Token and tool-call budgets stay out. | All 19 current names pass the name check. Budgets stay out because Q1 makes a runtime refuse a limit it cannot enforce, and no runtime enforces them per agent today. |

F12 also gives more access than pi-delegate gives today to a file that omits `inheritSkills`: one internal agent file and pi-delegate's fixtures `smoke-plain.md`, `smoke-narrow.md` and `smoke-nested.md`.

## Context, release and records, 8 and 9 October 2026

F16 to F19 replace pi-delegate's `defaultReads` with one field for everything an agent loads automatically. F20 settles, for 0.1, a request to limit a skill to named agents. R1 to R7 cover the release, the public mirror, the pi-durable research, sample provenance and the schema identifier.

| ID | Decision | Reason |
|---|---|---|
| F16 | One optional field, `context: { project, user, skills, files }`, controls what an agent loads automatically. `project` and `user` switch the runtime's instruction files, such as `AGENTS.md`, from the working directory and from the user's agent directory. `files` lists workspace files placed in the agent's first message. The three switches default to `true` and `files` to `[]`. pi-delegate's `defaultReads` is read into `files` with a warning. It ships in 0.1. | The maintainers wanted one portable field for all automatically loaded context, including `AGENTS.md`. `defaultReads` named only extra files, and only pi-delegate read it. P2 and F12 had already put two of the switches under `context`. Per-file switches inside `project` or `user`, and glob patterns in `files`, wait until someone needs them. |
| F17 | `context.files` paths are relative to the working directory. Absolute paths, `~`, `..` segments, backslashes and glob characters fail when the file is parsed. A symlink that resolves outside the working directory fails when the agent launches. | A definition from a package or from someone else's repository must not be able to read a file outside the workspace into the agent's prompt. |
| F18 | A missing file is skipped with a warning. `{ path, required: true }` makes the runtime refuse to launch instead. | Most listed files help but are optional. The flag covers a file the agent cannot work without. |
| F19 | Whether the agent starts with the parent conversation's history stays the caller's choice for each run. It is not a `context` key. | One definition serves one-shot runs, forked runs and actors (Q2). Only the caller knows whether the history helps this run. |
| F20 | No field limits a skill to named agents. The format docs say what works today: in pi, `disable-model-invocation: true` keeps a skill out of the skill list in the prompt, an agent that lists the skill under `skills` gets it preloaded, and any agent can still load it by name. Loading a skill by name does not check the flag. | A refusal when a skill is loaded by name was chosen first, then dropped on 9 October. About 50 of the maintainers' skills carry the flag, and commands load many of them by name in the main session. A refusal would also stop fleet workers, which run as ordinary sessions, from loading the skills they work with. No misuse has been seen. |
| R1 | Release 0.1 with `REQ-AD-CONF-003` deferred. It needs the importers for OpenCode and other foreign formats. | The importers are separate work. Holding 0.1 for them would hold up the runtime work that waits on 0.1. |
| R2 | Publish to npm as `@centerforagenticai/agent-definitions`, with the source in the CenterForAgenticAI/tools repository on GitHub, as pi-delegate and pi-context-aware are. An internal build is also published to the maintainers' private registry. | A shared format needs a public home that anyone can install from. |
| R3 | Samples from private repositories move to those repositories, which run the conformance runner ([conformance.md](conformance.md)) against them. The OpenCode and Claude Code samples stay here; both are MIT-licensed. | The public mirror must not carry private agent files, and each repository can still test its own. |
| R4 | Publish `README.md` and this file, rewritten so they name no private people, paths or hosts. | The reasons for the format belong with it. |
| R5 | Record the pi-durable research in the issue tracker: related work, an export to pi-agents' six-field profile, a pi-durable adapter, and Fabric actor templates read from these files. Draft a note to the pi-agents author once 0.1 is public. | No agent file format exists for pi-durable. At least five projects load their own small field sets. |
| R6 | Each copied sample records where it came from. A file published at a fixed commit records the commit-pinned HTTPS URL. A file with no such URL records the public npm package whose source repository holds it, and its path there. Both record the licence and the SHA-256 of the copied bytes. | The digest pins the bytes either way. Six useful MIT samples have no public URL, and a private repository path would not help a public reader. |
| R7 | The schema's `$id` is `https://www.centerforairesearch.org/schemas/agent-definition-0.1.json`. | It is the publisher's own domain. A JSON Schema `$id` names the schema; validators do not fetch it, so the URL need not serve the file. |

