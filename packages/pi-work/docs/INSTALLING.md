# Installation and development reference

For users and contributors: how to install pi-work for one project, develop it safely, and keep its compiled extension current.

Use `pi install npm:@centerforagenticai/pi-work -l` for the required project-local installation. The unchanged reference text below also shows Pi's user-wide install command; that command loads pi-work in every project.

## Installing pi-work

### Install from npm

```sh
pi install npm:@centerforagenticai/pi-work
```

This installs the pi-work extension and its three skills.

pi-work is **opt-in per project**. Do not add it to `~/.pi/agent/settings.json`.

A globally installed pi-work loads into every pi session on the machine. Its
seven tools land in every tool list, and its three skills land in every
session's `<available_skills>` block carrying descriptions that read as
directives — `work-authoring` says "Use this before turning a conversation,
issue, or design into a markdown draft". Agents then reach for workspecs in
projects that never adopted them. That has happened.

### Opt a project in

Create `.pi/settings.json` in the consuming project:

```json
{
  "packages": ["/absolute/path/to/pi-work"]
}
```

Use an **absolute path** in a consuming project. Relative paths in project
settings resolve against `<project>/.pi`, so a session started in a linked
worktree resolves them inside `<project>/.worktrees/<id>/`, where the package is
absent and silently contributes nothing.

Merge into an existing `packages` array rather than overwriting the file, and
note that project settings apply only once the project is trusted.

### This repository is the exception

`.pi/settings.json` here is committed and uses a relative path:

```json
{
  "packages": [".."]
}
```

`..` resolves to the checkout that holds the settings file, so a session started
in a linked worktree of this repository loads that worktree's own copy. That is
what you want while developing it — provided that worktree's `dist/` is built.
See [Keeping `dist/` current](#keeping-dist-current-optional-git-hooks).

### Verify

```sh
cd <project>
pi list          # pi-work must be listed under "Project packages"
```

Extensions are resolved when the pi process starts. A session already running
keeps its old set until pi restarts. When the installed pi-work changes under a
running process, `work_validate`, `work_status`, and `work_verify` end their
output with `pi-work loaded <old>; installed is <new>. Restart pi to use it.`

Identity checks accept only bounded version strings and full Git commit IDs.
Malformed or unreadable metadata is unknown, so it cannot by itself trigger a
restart hint. Each metadata read accepts only regular files up to 64 KiB; pipes
and other special files are ignored without waiting for input. Tool output stays
within its text limit even if a supplied hint is too long.

### Load it once without installing

```sh
pi -e /absolute/path/to/pi-work
```

Loads the package for that run only and writes nothing to settings.

### Narrowing instead of removing

A project entry whose identity matches a global one replaces it; for a local
path the identity is the resolved absolute path. Two ways to keep a global
install but reduce what it contributes to one project:

```jsonc
// .pi/settings.json — load the extension, drop the skills and prompts
{ "packages": [{ "source": "/absolute/path/to/pi-work", "skills": [], "prompts": [] }] }
```

```jsonc
// .pi/settings.json — a delta over the global entry rather than a replacement
{ "packages": [{ "source": "/absolute/path/to/pi-work", "autoload": false, "skills": ["-skills/work-authoring"] }] }
```

`[]` loads none of that resource type, `!glob` excludes matches, and `+path` /
`-path` are exact paths relative to the package root. `pi config -l` edits the
same settings interactively.

## Requirements and setup

- Node.js 22.19 or newer
- npm

Install dependencies and run the aggregate gate:

```sh
npm install
npm run check
```

`npm run check` runs lint, strict source and test typechecks, the compiled
JavaScript test suite with c8 coverage, the production build, and the package
smoke. `npm test` compiles `src/` and `tests/` into `.test-dist/` before running
only the emitted `.js` tests. Focused commands are available as
`npm run lint`, `npm run typecheck`, `npm run typecheck:tests`,
`npm run test:compile`, `npm run test:run`, and `npm run build`.

The package smoke must run after a build. pi's local directory loader does not
run npm lifecycle hooks, so `npm run smoke:package` fails clearly when the
compiled `dist/` entry is absent. The manifest deliberately points
`pi.extensions` at `./dist/index.js`: `src/` is not published, and a manifest
entry for an absent file can otherwise be silently dropped by local discovery.

## Keeping `dist/` current (optional git hooks)

A pi session loads this package and runs the compiled `dist/` of one checkout.
Pulling `main` updates `src/` but leaves `dist/` at the previous commit, so
sessions keep running old code until someone remembers to build.

Four tracked hooks under `.githooks/` close that window. They rebuild `dist/`
after `git commit`, `git merge`/`git pull`, `git rebase`/`git commit --amend`,
and a branch `git checkout`, but only when the incoming commits touched `src/`,
`tsconfig.build.json`, or `package.json`.

Installing them is opt-in; nothing runs during `npm install` or `npm ci`:

```sh
npm run hooks:install                          # every tracked hook
sh scripts/install-git-hooks.sh --build-only   # only the four rebuild hooks
```

`--build-only` writes shims into the shared hooks directory and leaves
`core.hooksPath` alone, which matters because `core.hooksPath` is
all-or-nothing across every linked worktree.

The hooks never fail the git command that invoked them: a failed build is
reported loudly and `dist/` is left stale rather than blocking a checkout.
They rebuild in the main checkout only, they skip a rebuild already in flight,
and they never run `npm install`. To change that:

```sh
git config piwork.autobuild true    # rebuild in this linked worktree too
git config piwork.autobuild false   # never rebuild, anywhere
PI_WORK_NO_AUTOBUILD=1 git commit   # skip the rebuild for one command
```

`npm run test:hooks` proves the guard logic against throwaway repositories with
a stubbed `npm`; it is part of `npm run check` and never builds anything real.

## Repository layout

- `src/` — TypeScript extension source
- `tests/` — source/compiled-layout contract and unit tests
- `scripts/` — build, package smoke, and git-hook helpers
- `.githooks/` — optional tracked hooks that rebuild `dist/`
- `dist/` — generated production JavaScript and declarations
- `.test-dist/` — generated test JavaScript
- `.work/specs/` and `.work/drafts/` — tracked authoring directories
- `.spec/` — the design record; implementation docs do not duplicate its ADRs
- `.pi/settings.json` — this repository's own opt-in entry (`".."`)

`src/index.ts` registers the whole surface: seven tools and five commands.

## Working on this repository

Never run `npm install` or a build in a shared checkout that live pi sessions
load. Pi loads the compiled `dist/`, so installing or rebuilding underneath a
running session swaps the module under it. Do dependency work in a worktree
with its own `node_modules`.
