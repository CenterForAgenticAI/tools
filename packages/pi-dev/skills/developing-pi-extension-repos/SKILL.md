---
name: developing-pi-extension-repos
description: >-
  Keep tests, dependencies, CI reproduction, and coverage reliable across Pi extension repositories. Load when editing, testing, or setting up a worktree in a pi extension repository, when tests pass from source but fail from compiled output (or vice versa), before running `npm install` in a checkout other sessions may be using. For writing extension code itself, load `authoring-pi-extensions`.
load: recognition
---

# Developing Pi extension repositories

Use this skill for repository hygiene around a Pi extension. Use that
repository's `AGENTS.md` for its exact scripts, output directories, helper names,
CI image, manifest entries, cache paths, and coverage floors. When the two
disagree, stop and report the conflict rather than replacing a repository rule
with a generic example from this skill.

## Prove source and compiled test layouts

A source-mode inner loop and a compiled full suite exercise different layouts.
A test must behave the same in both.

TypeScript rewrites static import specifiers during emit. It cannot repair paths
assembled as strings, loader arguments passed to spawned children, or paths used
to read committed source. Use the repository's central helpers for all three.
The shared helper contract used by several Pi extension repositories is:

| Need | Helper |
| --- | --- |
| a source module URL | `sourceModuleUrl()` |
| loader arguments for a spawned child | `childLoaderArgs()` |
| a root for committed-source reads | `REPO_ROOT` |

Use the exact equivalents named by the repository when it differs.

Do not hard-code a source extension, source directory, or TypeScript loader in a
test that also runs as emitted JavaScript. If a file intentionally remains
uncompiled, document that exception at its call site.

Use both layouts while changing tests:

1. Run the repository's source-mode focused test for fast feedback.
2. Run its test compile or build.
3. Run the emitted test file directly when diagnosing a layout mismatch.
4. Run the repository's full compiled test gate before handoff.

A green source run is not evidence that the compiled suite passes. A green
compiled run is not evidence that the source inner loop still works. Keep or add
a layout-contract test that scans for forbidden hard-coded module paths and
loader arguments when the repository provides one.

## Build what the package manifest loads

Read the `pi.extensions` entries before package or path-loader smoke tests. If
they point at emitted files, build first. A local directory loader and a packed
install do not necessarily run lifecycle scripts such as `prepare`; a command
can exit successfully after loading nothing.

Make the smoke test assert the resolved extension entry or an observable
registration. Do not treat a successful CLI exit alone as proof that the
extension loaded.

## Run one output-writing job per worktree

Incremental test compilers commonly share an emitted-test directory and a build
metadata file. Coverage jobs may read that directory while they run. A second
compile, prune, test, or coverage job in the same worktree can rewrite files
under the first job and produce missing-module failures, lost test files, or
implausibly low coverage.

Run gate jobs serially within one worktree. For parallelism, use separate
worktrees with separate writable caches and `node_modules` directories. After a
race, discard the affected output and coverage captures according to the
repository's cleanup rule, then rerun. Never merge measurements from a known
clobbered run into a clean result.

## Keep installs away from live shared checkouts

A registered Pi extension can be loaded by many running sessions from one
checkout. `npm install` and `npm ci` replace parts or all of `node_modules`.
Running either command in that shared checkout can remove the live Pi SDK from
under those sessions and make unrelated workers fail with missing-module errors.

Before dependency work:

1. Identify whether the checkout is registered or used by live sessions.
2. Create a worktree for the branch.
3. Give that worktree its own real `node_modules` directory and writable caches.
4. Install only in an isolated worktree whose dependencies are not shared, or
   reuse an unchanged primary environment with the non-installing procedure below.

Never symlink a worktree's whole `node_modules` directory to a shared checkout.
That makes an install in either location destructive to both.

## Reuse a matching primary environment safely

Prefer the repository's worktree-setup helper when `AGENTS.md` names one. Pass
it the primary checkout and worktree paths exactly as that repository documents.
The helper should verify that both paths belong to the same repository, compare
the dependency manifest and lockfile byte-for-byte, remove only the worktree's
existing dependency entry, and create local writable caches. If either manifest
differs, do a private clean install in the worktree instead. Never reuse across
a changed lockfile.

When no helper exists, first remove the worktree entry without following a
symlink:

```sh
if [ -L node_modules ]; then
  rm node_modules
elif [ -d node_modules ]; then
  rm -rf node_modules
fi
```

Never write `rm -rf node_modules/` in this situation. On GNU systems, the
trailing slash can make `rm` follow a directory symlink, empty the primary
checkout's dependency tree, and leave the symlink behind.

Then create a real local directory. Keep writable caches local and symlink only
individual dependency and executable entries from the matching primary
checkout. Preserve scoped-package directories:

```sh
PRIMARY=/absolute/path/to/primary-checkout
mkdir -p node_modules/.cache node_modules/.bin
for entry in "$PRIMARY/node_modules"/*; do
  name=${entry##*/}
  if [ "${name#@}" != "$name" ]; then
    mkdir -p "node_modules/$name"
    for package in "$entry"/*; do
      ln -s "$package" "node_modules/$name/${package##*/}"
    done
  else
    ln -s "$entry" "node_modules/$name"
  fi
done
for executable in "$PRIMARY/node_modules/.bin"/*; do
  ln -s "$executable" "node_modules/.bin/${executable##*/}"
done
```

Treat this as reuse, not as an installable tree. A symlinked dependency entry
still names shared mutable state. Do not run `npm install`, `npm ci`, or a
mutating postinstall script in it. Use reuse only on the same host, platform,
and Node runtime; native modules and realpath-sensitive tooling can otherwise
resolve the wrong artifacts or escape the worktree.

A fresh worktree with an empty real `node_modules` can make ESLint report
`Cannot find package '@eslint/js'`, even when the failure is simply missing
dependencies. Check that reuse populated the directory before diagnosing the
gate:

```sh
ls .worktrees/<name>/node_modules | wc -l
```

## Reproduce the CI Node runtime

Read the CI configuration and use its exact Node image or version. A local green
run cannot prove behavior under a different event loop, timer, child-process, or
module-loading implementation.

Compile first, then run the emitted failing test in the pinned container:

```sh
npm run <test-compile-script>
docker run --rm --init -v "$PWD":/work -w /work node:<ci-version> \
  node --test <compiled-test-path>
```

Keep `--init`. Without it, Node runs as PID 1 and may not reap orphaned child
processes, creating a failure that the CI runner does not have. A failure that
cannot also be produced in the CI runtime and process model is not yet a valid
CI reproduction.

Suspect a runtime difference when CI fails a whole test file without an
assertion, or after changes to timers, promise races, teardown, or child-process
cleanup.

## Never lower a coverage floor

Coverage floors record an established measurement; they are not a knob for
landing untested code. Never lower a floor. Never add a test whose only purpose
is to move a percentage.

Before changing a floor or blaming a change:

- establish a clean baseline with the same command, runtime, and sharding;
- compare per-file lines, branches, functions, and statements;
- inspect logs when the movement is larger than the change can plausibly cause;
- rule out raced output, missing test files, and tool-version counting changes.

Raise a floor when the repository's policy requires the new measured baseline.
Keep the exact percentages and rounding rule in that repository's `AGENTS.md`.
