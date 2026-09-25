# Package-shipped agents

> **Status:** stable. Available in `pi-delegate` ≥ 0.2.0.
>
> **Companion docs:** `cli-delegate.md` (the CLI dispatch surface that
> resolves these agents), `subagent-parity-plan.md` (where the .md agent
> format is anchored).

`pi-delegate` discovers agent definitions from four sources:

| Source     | Location                                                     | Mutable? |
| ---------- | ------------------------------------------------------------ | -------- |
| builtin    | `pi-delegate/builtin-agents/*.md`                            | no       |
| **package**| `<cwd>/`, `<node_modules>/<pkg>/`, `<cwd>/.pi/{npm,git}/...`, `~/.pi/agent/{git,extensions}/...` | no |
| user       | `~/.agents/*.md`, `~/.pi/agent/agents/*.md`                  | yes      |
| project    | `<repo>/.agents/*.md`, `<repo>/.agents/agents/*.md`, `<repo>/.pi/agents/*.md` | yes |

Override priority is **builtin < package < user < project** — later wins
on duplicate names, so a project's `.pi/agents/worker.md` overrides a
user's `~/.agents/worker.md`, which overrides a package's `worker.md`,
which overrides the bundled builtin. Within project scope, definitions load
from `.agents/` < `.agents/agents/` < `.pi/agents/`; later definitions win on
duplicate names. Agent and chain files use the same project locations and
precedence. This page covers the package layer; the others are documented in
the main README.

### Global tool and skill baseline

An installation can grant the same starting tool and skill surface to package, builtin, user, and project agents without editing their files. Despite its historical “Tool” name, the `globalToolWhitelist` first cut includes both tools and skills:

```json
{
  "globalToolWhitelist": {
    "tools": ["read", "ext:skill:load"],
    "skills": ["implement", "test-execution"]
  }
}
```

The global baseline is applied before agent frontmatter and before durable `agentOverrides`. With a configured baseline, a package agent's frontmatter extends it, non-empty durable `tools` and `skills` arrays extend the result, explicit empty durable arrays clear it, and omitted fields retain it. Without the baseline, durable arrays keep their whole-array replacement behavior. If the baseline is the first non-empty tool declaration, `read`, `bash`, `edit`, and `write` remain available.

`inheritSkills:false` with no explicit skills uses the non-empty global skill list. `inheritSkills:true` with no explicit skills keeps `skills` absent and exposes the full discovered registry. With explicit skills, both `inheritSkills:false` and `inheritSkills:true` put global skills before agent skills. Invocation `skill:false` remains the final per-call opt-out.

`extensionExclude` can opt a package agent out of a provider; the affected global-only `ext:` selector will warn and drop when that provider is absent or excluded. A selector repeated by package-agent frontmatter or a durable/invocation override remains explicit and fail-closed. Malformed, ambiguous, and provider-registration-failed selectors also remain hard errors.

The `delegate` and `worker` definitions are the only builtins shipped by
`pi-delegate`. Companion development-tool packages can ship `implementer`,
`integrator`, `planner`, `reviewer`, and `scout` workflow agents through this
package scope.

## Why package-shipped agents?

Pi packages already ship four resource types via auto-discovery —
`extensions`, `skills`, `prompts`, `themes` — but agents are
pi-delegate's domain, and there was no symmetric mechanism to ship
custom agents from an installed npm package. This forced consumers
(`graft`, hypothetical `pi-rust-toolkit`, etc.) to either copy agent
files into the user's `~/.agents/` manually, or hand-translate
profile YAML to in-memory `AgentConfig` objects passed to
`delegateFromCli({tasks: [{agent: <AgentConfig>, …}]})`.

Both workarounds shifted complexity downstream. Package-shipped
agents give consumers a clean, declarative path: drop a `.md` file
into your package's `agents/` directory, declare it in
`package.json`, and pi-delegate finds it automatically.

## Author guide — shipping agents from your package

### Step 1 — Author the agent file

Same standard `.md`-with-YAML-frontmatter format as user / project
agents. Place it under your package's `agents/` directory (or any
directory you'll list in `pi-delegate.agents` below):

```markdown
---
name: ts-implementer
description: TypeScript implementer for graft work specs. Reads the codebase, makes surgical edits, runs validation.
model: anthropic/claude-sonnet-4
skills: [graft-implement]
tools: [read, bash, edit, write]
---

# ts-implementer

You are a TypeScript implementer dispatched by graft. Read the work
spec at `.graft/work/<task>.yaml` and produce the smallest correct
diff that satisfies the acceptance criteria.

…
```

The full frontmatter schema (skills, fallbackModels, thinking,
collapseMode, defaultReads, …) is documented in
`subagent-parity-plan.md` and the top of `src/agents.ts`.

### Portable extension policy in package agents

Package agents inherit the worker environment's configured Pi extensions.
`extensions:` remains a list of **additional paths**; it is not an allowlist and
must not be used to express isolation. Package-shipped agents can instead use:

```yaml
extensionInclude: adaptive-thinking
extensionExclude: pi-delegate
tools: read, bash, ext:adaptive-thinking/set_thinking_effort
```

Includes require a discovered match but retain the rest of the inherited set;
excludes run last. Empty include/exclude lists are no-ops. Unknown selectors and
ambiguous package names fail closed. When package-name matching is ambiguous,
qualify with the canonical source (`npm:@scope/pkg` or
`git:host/owner/repo`), and add `#extensions/entry.ts` when a package ships
multiple extension entrypoints. Absolute paths are compatibility fallbacks,
not preferred portable identities.

Identity derivation uses the nearest package name and package-relative
entrypoint. For local checkouts it prefers `package.json.repository.url`, then
Git `remote.origin.url`; Git SSH/HTTPS spellings normalize without `.git` or a
ref. Host aliases require explicit canonicalization and are not trust proofs.

An extension being loaded does not automatically expose its tools when the
agent has an explicit `tools:` list. Select one tool with
`ext:<extension>/<tool>`. The final slash is the tool delimiter, so qualified
source and entrypoint identities use the same syntax, for example:

```yaml
tools: read, ext:git:github.com/acme/tools#extensions/guard.ts/guard_check
```

The exact allowlist rejects missing tools and ownership collisions instead of
broadening authority. Excluded extension factories are not imported, so none of
their handlers, commands, renderers, flags, shortcuts, or tools register. Pi
does not yet expose owning-extension metadata for separately discovered skills,
prompts, and themes, so exclusion intentionally does not guess ownership from
directory prefixes; that package-resource policy requires an upstream Pi API.
Hosted CLI workers with exact `ext:` selectors preflight selected factories to
discover registered tool names before launching the CLI, so selected factories
must tolerate initialization in both processes. Direct, chain, supervised-inner,
boot-proof, and production driver paths otherwise use the same policy resolver.

Nested delegation is disabled by default for package/user/project agents even
when their `tools:` list includes `delegate`. To opt a plain worker session into
bounded nested delegation—whether launched directly or as the inner worker
beneath a supervised run—set `allowNestedDelegate: true` (or
`allow_nested_delegate: true`) and list exact trusted `pi-delegate` extension
selectors such as `ext:@centerforagenticai/pi-delegate:delegate` in `tools:`. Bare aliases
never authorize a built-in, foreign, or late same-named registration. The supervisor clone itself retains only its supervision harness
and does not inherit this opt-in. If `allowNestedDelegate` is true but `tools:`
is absent, the agent keeps the normal default worker tools and receives no
delegate tools. Add
`nestedDelegateAgents: reviewer, scout` (or `nested_delegate_agents`) to restrict
which child agents that worker may spawn; omitting the allow-list permits any
resolved child agent, still subject to `maxSubagentDepth` / lineage depth caps.
Nested extension calls receive the lesser of 30 minutes and half the positive
remaining parent budget; an exhausted budget fails before execution. Commit and
push before another attempt, or rerun without nesting.

### Step 2 — Declare in `package.json`

There are two equivalent ways to opt in. Pick whichever fits your
package layout.

#### Option A — Explicit (recommended)

```jsonc
{
  "name": "graft",
  "version": "0.42.0",
  "pi-delegate": {
    "agents": ["./agents"]
  },
  "files": ["dist", "agents", "README.md"]
}
```

`pi-delegate.agents` is an array of relative directory paths, walked
in order. **Later paths win on name collisions** (so you can override
your own defaults from a more-specific subdir).

Don't forget to list the `agents` directory in `package.json:files`
or include it via your `.npmignore`, otherwise the dir won't ship in
the npm tarball.

#### Option B — Convention directory

If your package already has a `pi: {...}` manifest field for some
other reason (e.g. it ships skills or extensions), pi-delegate will
auto-discover an `agents/` directory at the package root without an
explicit `pi-delegate` declaration:

```jsonc
{
  "name": "my-pi-toolkit",
  "pi": {
    "skills": ["./skills"]
  }
  // No `pi-delegate.agents` — but `agents/*.md` is auto-loaded
  // because the `pi.*` field signals "this is a pi package".
}
```

The `pi.*` signal is **required**. Packages with an `agents/`
directory but no `pi.*` manifest field are deliberately skipped, so
arbitrary npm packages that happen to have an `agents/` directory
don't bleed into discovery.

### Step 3 — Verify

After installing the consuming project:

```bash
$ npx -p pi-delegate -c "node -e 'console.log(require(\"pi-delegate\").discoverAgents(process.cwd(), \"both\").agents.filter(a => a.source === \"package\").map(a => a.name))'"
[ 'ts-implementer' ]
```

Or interactively from a pi session in a project that has your
package as a dep:

```
> /delegate --agents
Workers (12):
- ts-implementer (package): TypeScript implementer for graft work specs.
- delegate (builtin): …
- worker (builtin): …
…
```

The `(package)` tag tells you it came from an installed package
rather than a builtin / user / project file.

## Discovery semantics

### Where pi-delegate looks

`loadPackageAgents(cwd)` walks five location families:

1. **The cwd's own root** — when `cwd/package.json` is itself a pi
   package (the dogfood case: graft running from its own checkout,
   pi-delegate developing in-tree, …).
2. **`node_modules/` ancestor chain** — every `node_modules/`
   directory from `cwd` upward (standard Node module resolution,
   so transitive deps are reachable too).
3. **`<cwd>/.pi/npm/node_modules/`** — pi's project-scope npm
   install root (`pi install --local npm:<pkg>`).
4. **`<cwd>/.pi/git/<host>/<path…>/<repo>` and
   `<getAgentDir()>/git/<host>/<path…>/<repo>`** — pi's project-
   scope and user-scope git installs (`pi install
   git:host/owner/repo`). Both walked recursively because the path
   depth varies (`host/owner/repo` is typical, `host/repo` works
   for top-level repos).
5. **`<getAgentDir()>/extensions/<name>`** — pi's user-scope
   extensions directory. Most often these are dev symlinks back
   to a working repo (e.g. `~/.pi/agent/extensions/graft` →
   `~/Code/.../crust/`); the realpath dedupe collapses them
   against the underlying repo so a package isn't double-loaded.

Each candidate package is checked for one of two opt-in signals:

1. `package.json` has `pi-delegate: { agents: [...] }` — load each
   listed path.
2. `package.json` has any `pi: {...}` manifest field AND an
   `agents/` directory exists at the package root — load that dir.

Packages without either signal are ignored. The signal check is
applied uniformly across all five families above, so the cwd's own
root is held to the same standard as a transitive dep.

> `getAgentDir()` reads `PI_CODING_AGENT_DIR` if set, otherwise
> falls back to `~/.pi/agent`. Pi's documented user-scope install
> root.

### Scope filtering

`discoverAgents(cwd, scope)`'s scope parameter affects whether
package agents show up in the result:

| Scope     | Builtin | Package | User | Project |
| --------- | ------- | ------- | ---- | ------- |
| `both`    | ✅      | ✅      | ✅   | ✅      |
| `user`    | ✅      | ✅      | ✅   |         |
| `project` | ✅      |         |      | ✅      |

Package agents are excluded under `scope: "project"` because the
typical use of project scope is "show me what THIS repo ships",
which doesn't include system-wide installed packages.

### Override priority

Within `discoverAgents` (`scope: "both"`), agents with the same name
follow **builtin < package < user < project**. So if your project's
`.pi/agents/ts-implementer.md` exists alongside a package-shipped
`ts-implementer`, the project file wins. Ditto for user-scope
overrides.

### Multiple packages, same agent name

If two installed packages both ship an agent named `foo`, the
walk-order determines which wins (later-loaded wins, matching the
generic `dedupeByName` semantic). The walk traverses families
1 → 5 in the order listed under "Where pi-delegate looks", so a
user-scope extension can override an in-tree dogfood agent of the
same name.

Symlinked packages are deduped by **realpath**: a single underlying
repo reachable through multiple paths (`~/.pi/agent/extensions/graft`
symlinked to `~/Code/caair/crust`, while `~/Code/caair/crust` IS the
cwd) loads exactly once. The realpath check uses `fs.realpathSync`
internally and falls back gracefully when the symlink target is
missing.

There is no manifest-level priority; if you need deterministic
ordering across packages, ship the agent at user or project scope
and let the explicit override chain handle it.

## Mutability — package agents are immutable

Like builtins, package agents cannot be modified through
`delegate({action: "update" | "delete"})`. The handler returns:

```
Agent 'ts-implementer' is installed by package 'graft' and cannot
be modified. Create a same-named agent in user or project scope to
override it.
```

This mirrors the builtin behavior: shadow-and-override, never
in-place edit. To customize a package-shipped agent, use the
`delegate({action: "create"})` action (or just drop a same-named
file into your project's `.pi/agents/` directory) — the
priority chain takes care of the rest.

`create` warns when shadowing a package agent, mirroring the
existing builtin shadow warning:

```
Created agent 'ts-implementer' at /repo/.pi/agents/ts-implementer.md.
Note: this shadows the package agent 'ts-implementer' (from graft).
```

## Common gotchas

### `package.json:files` must include the agents directory

For npm-published consumers, agents won't ship in the npm tarball
unless either `agents` is listed in `package.json:files` or your
`.npmignore` permits it. Symptom: agents resolve fine in your dev
checkout (where `agents/` is on disk) but disappear after a
consumer runs `pi install npm:<your-package>`. Fix:

```json
{
  "files": ["dist", "agents", "README.md"]
}
```

### YAML colons in `description:`

`description:` values that contain a colon (`:`) need to be
double-quoted, otherwise YAML's compact-mapping rules try to
parse the colon as a nested map and the file fails to load.
pi-delegate logs a `console.warn(...)` naming the file and
moves on — the bad agent is skipped, others in the same dir
still load — but you'll lose the agent until the file is
fixed. Quote the value:

```diff
 ---
 name: ts-implementer
-description: TypeScript implementer: surgical edits + validation.
+description: "TypeScript implementer: surgical edits + validation."
 ---
```

The same rule applies to any frontmatter string that contains
YAML special characters (`:`, `#`, `&`, `*`, leading `?`, …).

### Dev symlinks under `~/.pi/agent/extensions/`

Pi extensions installed via `pi install` are stored under
`<getAgentDir()>/extensions/<name>`. For development you'll often
symlink that path back to your working repo. pi-delegate's
discovery walks both the symlink target and any other path the
underlying repo is reachable through (cwd-own root, transitive
node_modules, …) and dedupes them via `fs.realpathSync`. So
the in-progress dev edits you make in your repo will pick up
through the symlinked extension immediately — no install dance
needed.

## Security note

Pi's existing security model already treats package installation as
an explicit trust action: when a user runs `pi install <pkg>`, they
accept that the package can register extensions, skills, prompts,
themes — code paths with full system access. Package-shipped agents
fit the same model.

This means:

- **No `confirmProjectAgents` prompt for package agents.** That
  per-repo gate exists to protect users against running unfamiliar
  agents from an untrusted clone of a repo. Package agents are
  installed deliberately and globally; the install itself is the
  trust event.
- **A package's `skills:` references resolve through the existing
  pi skill discovery.** A package shipping an agent that depends on
  a skill it doesn't also ship will fail at dispatch time with the
  standard "skill X not found" error.
- **Package agents respect `tools:` constraints.** The same
  allow-list mechanism that gates user/project agents applies — a
  package-shipped agent declaring `tools: [read, bash]` won't get
  `edit` access just because it came from an installed package.

## Migration path for existing tools

If you previously used the runtime-bridge workaround — translating
profile YAML to `AgentConfig` objects in your own dispatch code and
passing them to `delegateFromCli({tasks: [{agent: <AgentConfig>}]})` —
you can simplify post-migration:

```diff
- const profile = parseProfileYaml(profilePath);
- const agentConfig = profileToAgentConfig(profile);
- await delegateFromCli({
-   tasks: [{ agent: agentConfig, task: ... }],
- });

+ // 1. Author the agent as `agents/ts-implementer.md` in your package.
+ // 2. Add `"pi-delegate": { "agents": ["./agents"] }` to package.json.
+ // 3. Reference it by name:
+ await delegateFromCli({
+   tasks: [{ agent: "ts-implementer", task: ... }],
+ });
```

Native discovery resolves `"ts-implementer"` via the same priority
chain consumers expect (project > user > package > builtin), so any
project-local override Just Works.

## Related

- `cli-delegate.md` — the CLI dispatch surface that consumes these
  agents (`delegateFromCli({tasks: [{agent: "name", ...}]})`).
- `subagent-parity-plan.md` — phase document for the `.md` agent
  format and how it aligns with pi-subagents.
- The `loadPackageAgents` and `discoverAgents` exports in
  `src/agents.ts` — programmatic API if you need to introspect
  discovery from another extension.
