---
name: authoring-delegate-agents
description: >-
  Write, place, and verify a pi-delegate agent definition — the Markdown file
  with YAML frontmatter that defines a subagent's model, tool surface, prompt,
  and delegation limits. Load when creating or editing an agent file, shipping
  agents from a package, debugging discovery or runtime configuration, or
  choosing between a durable agent file and a per-invocation override. Covers
  authoring judgement; the exhaustive field inventory lives in the README.
load: recognition
---

# authoring-delegate-agents

## What you are writing

An agent definition is one Markdown file: a YAML frontmatter block that
configures the worker, then a body that becomes its system prompt. This skill
covers the four discovery scopes and their precedence, the replace-vs-append
prompt decision, exact `mcp:` and `ext:` tool selection, which fields apply to
which delegation shape, the nested-delegation opt-in, and the failure modes that
make an agent file vanish silently.

```markdown
---
name: doc-auditor
description: Reads documentation against the code it describes and reports drift.
model: openai/gpt-5.6-sol
tools: [read, bash]
systemPromptMode: replace
---

You audit documentation against the code it describes.

Report only drift you can point at with a file path and line range.
Do not edit files.
```

That is a complete, working agent. Everything else in this skill is about the
decisions layered on top.

**The body is a system prompt, not a task.** Write standing instructions that
hold for every dispatch — role, working rules, output shape, prohibitions. The
per-dispatch specifics arrive as the `task`. An agent body that reads like a
one-off request is a sign the content belongs in the dispatch instead.

## Where the file goes, and who wins

Four sources, resolved by name. Later wins:

| Precedence | Source    | Location |
| ---------- | --------- | -------- |
| 1 (lowest) | `builtin` | shipped inside pi-delegate |
| 2          | `package` | an installed package's declared agents dir |
| 3          | `user`    | `~/.agents/*.md`, `~/.pi/agent/agents/*.md` |
| 4 (highest)| `project` | `<repo>/.pi/agents/*.md`, `<repo>/.agents/*.md` |

Two consequences worth internalising:

- **You override by shadowing, never by editing.** Builtin and package agents
  are immutable. To change one, write a same-named file at user or project
  scope. `delegate({action: "update"})` on an immutable agent is refused with a
  message telling you exactly this.
- **A package agent silently outranks a builtin of the same name.** If you ship
  `reviewer` from a package, pi-delegate's builtin `reviewer` stops being
  reachable for anyone with that package installed — including future edits to
  it. This is the intended mechanism, but it makes upstream changes to the
  shadowed builtin invisible. Prefer a distinct name unless you specifically
  intend to replace.

`name` comes from the frontmatter, **not** the filename. `agents/x.md` declaring
`name: reviewer` registers as `reviewer`. Keep them matching anyway; mismatches
are a reliable source of "I edited the file and nothing changed".

For shipping agents from a package, see `docs/package-agents.md` — that page
owns the manifest declaration, the `pi:` signal, and the npm `files` gotcha.

## Core fields you always set

```yaml
---
name: <unique-identifier>          # required
description: <what it does>        # required — this is what a dispatcher reads
model: <provider/id>               # omit to inherit the caller's model
tools: [read, bash]                # omit to inherit the host default surface
systemPromptMode: replace          # replace | append
---
```

`description` is not decoration. It is the text a dispatching agent sees when
choosing between agents, so write it as selection criteria — what this agent is
for and when to reach for it — not as a restatement of the name.

The complete field inventory, including every optional field and its legal
values, lives in the README's **"Agent definition frontmatter"** section. Do
not duplicate that table into agent files, other docs, or here; read it there
and link to it. Once the generated JSON Schema ships (issue #178), that becomes
the machine-readable source of truth.

### Spelling

Use **camelCase** field names and **YAML arrays** for lists:

```yaml
tools: [read, bash, edit, write]
skills: [implement, implement-typescript]
collapseMode: summary
defaultMaxRounds: 3
```

The parser also accepts legacy `snake_case` (`collapse_mode`,
`default_max_rounds`, …) and comma-separated strings (`tools: read, bash`), so
existing files keep working, and you will see both in the wild. Write new files
in the canonical form; management actions emit it, and the legacy spellings are
deprecated.

To convert an existing file rather than hand-editing it:

```
delegate({ action: "canonicalize", agent: "<name>" })
```

It rewrites that agent's frontmatter in place to canonical camelCase and YAML
arrays, and is idempotent — running it twice changes nothing. It only works on
files you can actually edit: builtin and package agents are refused, as are
chain definitions and files whose YAML does not parse.

## The prompt-mode decision

`systemPromptMode` is the field most likely to produce a confusing agent, so
decide it deliberately:

- **`replace`** (the default) — your body *is* the whole system prompt. The
  worker knows nothing about the host's persona or standing instructions. Use
  this for agents with a specific, self-contained job. Nearly every purpose-built
  agent wants `replace`.
- **`append`** — your body is added after the host's system prompt. The worker
  keeps the host's identity and behaviour and gains your instructions. Use this
  for a general-purpose helper that should behave like the main agent with an
  extra constraint.

Two companions, both defaulting to `false`:

- `inheritProjectContext` — pulls in project context files (`AGENTS.md` and
  friends). Turn this **on** for any agent that edits code in a repository; a
  worker that cannot see the project's conventions will violate them.
- `inheritSkills` — hands the worker the host's active skills. Usually leave it
  off and name the skills you actually want with `skills:`, so the worker's
  context stays predictable.

## Tool surface

Omit `tools:` and the worker gets the host's default surface (`read`, `bash`,
`edit`, `write`). Name `tools:` and you get **exactly** what you list — an
allowlist, not an addition.

```yaml
tools: [read, bash]                                        # inspection surface only
tools: [read, bash, edit, write]                           # can change files
# Dispatch-entry policy, not agent frontmatter:
# { runs: [{ agent: "reviewer", task: "...", readOnly: true }] }
tools: [read, mcp:some_mcp_tool]                           # MCP direct tool
tools: [read, ext:adaptive-thinking:set_thinking_effort]   # one extension tool
tools: [read, ext:adaptive-thinking]                       # all of that extension's tools
```

Four rules that catch people:

1. **Built-ins are bare; extension-owned tools are qualified.** Use
   `ext:<owner>[#<module>]:<tool>[:<action>]` for extension tools. Pi-delegate's own delegate
   tools accept `ext:@centerforagenticai/pi-delegate:delegate` and the action
   grant `ext:@centerforagenticai/pi-delegate:delegate_control:status`.
2. **Loading an extension is not the same as exposing its tools.** Workers
   inherit the host's extensions, but once you write an explicit `tools:` list,
   an extension tool appears only if you select it with `ext:`.
3. **Use the colon-uniform grammar.** Write
   `ext:<owner>[#<module>]:<tool>[:<action>]`. The owner ends at the first `#` or
   `:`. A kebab-case module id ends at the next `:`. The next field is the tool;
   an optional second colon starts its action grant. A package declares module
   ids in its own `package.json` `pi-delegate.modules` map. Absolute, escaping,
   missing, and symlink-escaping module paths fail closed. During the migration
   window, the old final-slash form
   `ext:<owner>[#<entrypoint-path>]/<tool>[:<action>]` is accepted silently, but
   new and serialized definitions use the colon form. This grammar does not
   replace the separate portable-identity grammar used by `extensionInclude`
   and `extensionExclude`.
4. **Unknown plain tools are skipped; extension selector failures are not.** A
   missing or ambiguous owner, unknown module, undeclared tool, or provider
   mismatch fails closed with `[tool-selector:<CODE>] …`. It never selects a
   same-named tool, built-in, or Pi default. Only verified bare names reach
   `setActiveTools()` or CLI `--tools`.

A qualified `pi-delegate` selector follows the same strip-by-default nested-delegation policy
as its bare equivalent; `allowNestedDelegate: true` is still required. For a live direct
worker, the selector is also the ownership grant: bare delegate-family aliases never
authorize a built-in, foreign, or late-registered same-named tool.

For the portable extension policy — `extensionInclude`, `extensionExclude`, and
how identities are derived — see the README's "Portable extension policy and
exact extension tools".

### A read-only slot must use the dispatch policy

Set `readOnly: true` on the run entry. This removes `write` and `edit`, returns
structured refusals, and blocks a best-effort list of obvious mutating bash
commands. Agent frontmatter, prose, and `tools: [read, bash]` alone do not
enforce the boundary:

```ts
// invocation shape, not agent frontmatter
delegate({
  runs: [{ agent: "reviewer", task: "review the change", readOnly: true }],
})
```

The bash list is not a sandbox. Interpreters (`python -c`, `node -e`), nested
shells, wrappers, aliases, unlisted mutators, and arbitrary custom tools can
still write. Keep the prose rule as defense in depth:

```markdown
Use `bash` only for read-only inspection — `git diff`, `git log`, `rg`, test
runs. Never use it to modify repository files or state.
```

## Which fields apply to which shape

pi-delegate runs agents in several shapes, and a field set for the wrong shape
is silently inert. Group them mentally:

| Group | Fields | Applies to |
| --- | --- | --- |
| Universal | `name`, `description`, `model`, `fallbackModels`, `thinking`, `thinkingMin`/`thinkingMax`, `tools`, `skills`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `extensions`, `extensionInclude`/`extensionExclude`, `env` | every shape |
| Supervised only | `defaultMaxRounds`, `stopConditionHint`, `collapseMode`, `summaryModel` | `mode: "supervised"` entries |
| Wall-clock budget | `maxDurationMs`, `windDownGraceMs` | `mode: "solo"` and `mode: "supervised"` entries (#287); a driver rejects both |
| Solo only | `defaultReads`, `defaultProgress`, `artifact` | `mode: "solo"` entries and saved chain steps |
| Delegation limits | `maxSubagentDepth`, `allowNestedDelegate`, `nestedDelegateAgents` | any worker that itself delegates |

Setting `collapseMode: summary` on an agent you only ever dispatch as a solo
run does nothing. Setting `artifact: plan.md` on a supervised entry is rejected
because the supervisor controls the message stream.

### `artifact` and `reads`

`artifact` declares one file the worker must write; pi-delegate never captures
its final message into that file. Set it in agent frontmatter or on a solo
`runs[]` entry. The entry wins, and `artifact: false` suppresses the agent
default. The declaration grants no tools, so give the worker a write-capable
tool surface:

```markdown
---
name: planner
description: Produces implementation plans.
tools: [read, write]
artifact: plan.md
---

Write your deliverable to the artifact path in your write-scope instruction.
```

**Keep the body path-independent.** The body must not name `plan.md` or any
other output filename. The runtime appends the absolute path to the worker's
system prompt:

```text
Your declared deliverable is <abs path>; write that exact path. Your final message is your handoff, not the artifact.
```

Two instructions naming different paths send the worker to the wrong file. A
worker using `artifact` must write to that injected absolute path.

The path is inside a stable per-worktree artifact workspace,
`os.tmpdir()/pi-workspace/<sha256(worktree-path)>/artifacts/`, never the worker
cwd. The workspace is keyed on the Git worktree, so workers dispatched separately
into the same worktree share one `artifacts/` directory; it is allocated lazily
(a run that declares no artifact creates nothing) and swept once the worktree is
gone.
Writing the declared filename inside a Git working tree is refused with a
redirect to the workspace path. After clean completion, a missing or empty file
fails the run; there is no final-message fallback. On success, the file contents
replace `collapsedContent`. A standalone direct result also reports
`output: <abs path>` in its `<direct-session>` header. The caller already has the
contents; the path is diagnostic. Timeouts remain `aborted` and do not publish
the artifact. Sources:
`src/direct-shape.ts`, `src/direct-runner.ts`, `src/output-file.ts`,
`src/tool-surface.ts`, and `src/write-confinement.ts`.

`reads` on a solo entry and `defaultReads` in agent frontmatter preload files.
Relative paths resolve against the **worker cwd**, not the artifact workspace;
absolute paths stay absolute. Missing, unreadable, and non-file paths warn but
do not fail the run. Files over 200 KiB are truncated and warn. Use relative
`defaultReads` only for files guaranteed to exist in every worker cwd. Source:
`src/context-files.ts`.

Any `runs[]` dispatch with an `after:` entry is compiled into a chain.
`{previous}` and `{chain_dir}` are chain-only: string-valued `task` and
`artifact` fields reject them on entries without `after`. Use placeholders only
in an after-gated `task`: `{previous}` is the preceding layer's
`collapsedContent`, including artifact contents, and `{chain_dir}` is the
chain's separate shared directory. Artifact names are literal. When any step
declares an artifact, every step shares one per-worktree artifact workspace, and an exact
relative later read such as
`reads: ["plan.md"]` is rewritten to the earlier `artifact: "plan.md"` absolute
path. Sources: `src/delegate-runs.ts` and `src/chain-execution.ts`.

One ordered dispatch can pass both the content and the file:

```ts
delegate({
  runs: [
    { name: "plan", agent: "planner", task: "Plan the change", artifact: "plan.md" },
    { agent: "worker", after: ["plan"], task: "Implement {previous}", reads: ["plan.md"] },
  ],
  await: true,
})
```

Across two separate dispatches, pass content rather than the workspace path:

```ts
delegate({ runs: [{ agent: "planner", task: "Plan the change", artifact: "plan.md" }], await: true })
// Paste the artifact content returned above, not outputFile.absolutePath.
delegate({ runs: [{ agent: "worker", task: "Implement this plan:\n\n<returned artifact content>" }], await: true })
```

The artifact workspace is lifecycle-owned: cleanup begins when its worktree lease
releases, and stale workspaces are swept later. `outputFile.absolutePath` is therefore not a
durable handoff. For a separately dispatched later run, paste the returned
content into `task`, or copy it to a caller-owned path and name that path in
`reads`. Source: `src/output-file.ts`.

## Letting a worker delegate

Nested delegation is **off by default**, even if `tools:` includes `delegate`.
Opt in explicitly:

```yaml
tools: [read, bash, "ext:@centerforagenticai/pi-delegate:delegate", "ext:@centerforagenticai/pi-delegate:delegate_control"]
allowNestedDelegate: true
nestedDelegateAgents: [scout, reviewer]
```

- Without `allowNestedDelegate: true`, the delegate-family tools are withheld.
- With `allowNestedDelegate: true` but **no** trusted `pi-delegate` selector in
  `tools:`, the worker keeps the normal default surface and gets no delegate tools.
  You must provide both parts of the opt-in.
- An opted-in nested call is capped at the lesser of 30 minutes and half the
  parent's positive remaining direct-worker budget. An exhausted budget fails
  before the child starts; commit and push before another attempt, or rerun
  without nesting.
- `nestedDelegateAgents` restricts which children it may spawn. Omit it and any
  resolvable agent is permitted, still bounded by depth caps.
- A supervisor clone does not inherit this opt-in; it keeps its supervision
  harness only.

## Pitfalls

**An unquoted colon deletes your agent.** This is the single most common cause
of "my agent file isn't showing up". YAML reads `description: Reviewer: strict`
as a nested map, the file fails to parse, and discovery *skips the file with a
warning and moves on* — the rest of the directory still loads, so nothing looks
broken.

```yaml
description: "Reviewer: strict about error handling."   # quote it
```

The same applies to any frontmatter string containing `:`, `#`, `&`, `*`, or a
leading `?`.

**Missing `name` or `description` also skips the file**, with a warning, for the
same reason. If an agent vanished, check discovery warnings before anything
else.

**Do not name an agent file `*.chain.md`.** That suffix is reserved for saved
chain definitions and is explicitly excluded from agent discovery. A file named
`reviewer.chain.md` will never register as an agent.

**`fallbackModels` identical to `model` is a no-op** that reads like a safety
net. Either list a genuinely different model or omit the field.

**A declared `thinking` must fall inside `thinkingMin`/`thinkingMax`.** Setting
`thinking: high` with `thinkingMax: medium` is rejected, not clamped.

**Guarded commands are auto-denied in non-interactive workers.** Delegated
workers run without UI by default, so a command-guard confirmation prompt is
answered "no" automatically and the worker sees a denial it did not ask for. If
an agent is expected to run guarded commands, either dispatch it with
`interactive: true` or tell it in the body to report the denial in its handoff
rather than working around it.

**Package agents need the directory shipped.** If agents resolve in your dev
checkout but disappear for consumers, the `agents` directory is missing from
`package.json:files`.

## Verify before you rely on it

Never assume a new agent file registered. Check:

```
delegate({ action: "list" })            # does it appear, with the right source?
delegate({ action: "get", agent: "<name>" })   # did every field parse as intended?
```

Confirm three things: the agent **appears**, its `source` is the scope you
intended, and the fields you set actually landed. A file that parsed but ignored
your `tools:` line looks identical to a working one until dispatch.

Programmatically, `discoverAgents(cwd, scope)` returns both the resolved agents
and the `warnings` array — that array is where a skipped file explains itself,
and where a deprecated-spelling warning shows up.

## Worked example: a review worker

```markdown
---
name: contract-reviewer
description: "Read-only reviewer: checks an implementation against its stated acceptance criteria and returns a pass/fail handoff."
model: openai/gpt-5.6-sol
thinking: high
tools: [read, bash]
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultReads: [plan.md, progress.md]
---

You review an implementation against the acceptance criteria you are given.

Working rules:
- Read the plan and progress files first when they are provided.
- Use `bash` only for read-only inspection: `git diff`, `git log`, `rg`, and
  test commands. Never modify repository files or state.
- Cite every finding with an exact file path and line range.
- Report only issues you can justify from the code in front of you.

Return one of:
- `pass` — every criterion is met, with the evidence for each.
- `fail` — which criteria are unmet, and the concrete change each needs.
```

Note the choices: `replace` because the job is self-contained,
`inheritProjectContext: true` because it judges code against repo conventions,
no `edit`/`write` because it must not fix things itself, the quoted
`description` because it contains a colon, and `defaultReads` because this agent
is dispatched as a direct worker or chain step.

## Related

- README, **"Agent definition frontmatter"** — the exhaustive field inventory.
- `docs/package-agents.md` — shipping agents from an installed package.
- `pi-delegate` skill — the tool surface that dispatches these agents.
- `docs/ptm-support.md` — how agent definitions are used when a
  pi-prompt-template-model template delegates.
