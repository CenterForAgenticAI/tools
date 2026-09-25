# Worker write confinement

In-process delegate-owned workers use a writable-root guard by default. The
assigned worker cwd is the primary root. An artifact-free worker also receives a
unique scratch leaf under `os.tmpdir()/pi-delegate-<scope>/worker-runs/`; only that
leaf, not its parent or siblings, is writable. Stale ordinary scratch is swept after
24 hours.

An `artifact:` producer instead receives one private v2 attempt:

```
<root>/pi-workspace-v2/data/<worktree-hash>/attempts/<attempt-id>/
  scratch/
  output/<artifact-name>
```

Only that attempt's `scratch/` and `output/` directories are recursive writable
roots. The attempts parent, sibling attempts, retained `artifacts/`, `quarantine/`,
data parent, and stable `control/` metadata are never granted. There is no shallow
shared-parent grant. Attempt and output directory identities are captured at
allocation and rechecked before candidate validation and publication.

A chain keeps progress records under
`os.tmpdir()/pi-delegate-<scope>/chain-runs/<runId>` or an explicit `chainDir`.
That coordination directory is not an artifact root. Worker writes elsewhere under
the OS temporary directory are refused; the error names `Granted scratch directory:
<path>` so the worker can retry in its owned leaf. Explicit `writableRoots` remains
the opt-in escape for work that needs broader temporary access.

## What is enforced

- `write` calls are blocked when their target is outside the allowed roots.
- `edit` calls are blocked for `path`, `file_path`, `multi[].path`, and
  Codex-style patch targets.
- Targets are normalized the way Pi's own `write`/`edit` tools normalize their
  `path` argument. The raw spelling is checked too, so resolver drift can only
  refuse more, never permit an escape.
- The check uses lexical paths and the real path of the deepest existing
  ancestor. Symlink escapes, dangling links that escape, and resolution errors
  refuse rather than fall back to a lexical decision.
- Each root is probed once for filesystem case behavior and the result is
  cached. Alternate-case spellings are accepted only when that root's actual
  filesystem is case-insensitive. If probing cannot complete, `darwin` and
  `win32` use the platform heuristic; other platforms remain case-sensitive.
  Case folding is never applied unconditionally.
- Ordinary confinement gives `bash` a best-effort check for explicit git
  targeting flags (`-C`, `--git-dir`, `--work-tree`, assignments, and `env`
  wrappers). Read-only git commands remain usable.

## Read-only slots

Set `readOnly: true` on an `agents[]`, `tasks[]`, chain step, or top-level
single-worker slot. This is an invocation policy, not agent frontmatter or
prose: prose and `tools: [read, bash]` do not enforce read-only behavior. The
policy blocks `write` and `edit` for primary-root paths, permits owned scratch and
private candidate-output writes, blocks obvious mutating `bash` commands, and returns structured
refusals with the `readOnly` boundary. It remains active when `confineWrites: false` is used.

A read-only worker may still write through `write`/`edit` to its owned scratch and
private candidate-output directories. The primary root and any candidate root that
is equal to or an ancestor of it are excluded. Containment uses lexical and real
paths with case-aware matching and refuses when the relationship is uncertain.

Scratch access and tool availability are separate. An explicit agent `tools:`
list must include built-in `write` (and `edit` if needed) to save files.
Allocating scratch does not widen that list. For example, a review agent that
must save JSON and Markdown needs `tools: [read, bash, write]` alongside the
dispatch-time `readOnly: true` policy.

The scratch exception applies to built-in `write`/`edit`, not to bash.
Read-only bash still refuses output redirection, `tee`, and interpreter code,
including `node <script>`, even when the destination is inside scratch. A
workflow requiring a validator script needs a separately scoped capability;
granting `write` alone does not make that script executable.

The bash denylist blocks, at minimum, `rm`, `mv`, `cp`, `tee`, `truncate`, `dd`,
`mkdir`, `touch`, `chmod`, `chown`, `ln`, `install`, in-place `sed`, recognized
package installs (`npm install`, `yarn add`, `pnpm add`, and `pip install`),
mutating git subcommands, and unquoted output redirection. Inspection commands
such as `rg`, `git log`, `git status`, `git diff`, `wc`, `ls`, `cat`, `find`, and
`fd` remain available.

The in-session bash reserved-name check is **best-effort defense-in-depth, not a sandbox**. Arbitrary shell
syntax, interpreters (`bash -c`, `python -c`, `node -e`, Perl, Ruby), nested shells, aliases, functions,
variables, command substitution, wrappers such as `sudo` or `command`, `eval`, unlisted mutators
such as `rsync`, `tar`, `make`, `find -delete`, and `xargs rm`, unrecognized package-manager aliases,
and arbitrary custom or extension tools can still write reserved files. `find` is available for inspection;
its mutating forms are not parsed. Detached driver execution and the supervisor clone are outside this
boundary. The authoritative guarantee that reserved files never reach Git is the delivery/CI gate:
its git-level staged/tracked check catches files however they were created.

## Reserved artifact names

Inside a Git working tree, the guard refuses `write`/`edit` targets whose basename
is reserved or matches the declared `artifact`. It also checks common bash writes:
`>`/`>>`, `tee`, in-place `sed`, parseable `cp`, `mv`, and `install` destinations,
the effective (last) static `dd of=` operand, awk output redirection whose complete
target expression is one string-literal path, and static paths used by common
interpreter write APIs. Existing hardlink aliases to a
protected artifact or `.pi/pi-delegate.json` are refused, as are parseable commands
that create a hardlink from either protected source.

A project can exempt legitimate repository paths in `.pi/pi-delegate.json`:

```json
{"artifactNameExceptions":["docs/plan.md"]}
```

Each exception is a repository-root-relative path or glob. Exceptions apply only
to their Git working tree. The config is trusted-source-only: delegate workers
cannot create or modify it, including through a hardlink alias.

The bash name guard is **best effort against deliberate command-form evasion, not
a sandbox**. Dynamic or computed target construction and unmodelled interpreter
file-open APIs such as `os.open`, `fs.openSync`, `sysopen`, and `File.binwrite`
remain accepted residuals. The delivery/CI gate remains the authoritative check
for reserved files in Git.

If a check fails, it refuses rather than allowing an unchecked write. Refusals
produce delegate diagnostics throttled per worker root. `confineWrites: false`
removes writable-root checks and is logged; it does not remove `readOnly`.

## Mutation attribution

Every direct worker and supervised run snapshots `git status --porcelain` before the
worker starts and compares it at collapse. The result reports changed paths
within that time window, or explicitly says `mutation tracking: not tracked`
for a non-git directory or failed observation. This is git-only attribution,
not proof of causation. It cannot see ignored files, edits that leave an
already-dirty porcelain signature unchanged, changes made and reverted within
the window, or distinguish overlapping workers in one checkout.

## Nested delegation and coverage boundary

A confined worker that can call `delegate` cannot grant a child wider filesystem
authority. It also cannot invoke a saved-chain native `run` stage: that command
starts in a separate process that cannot inherit the caller's write guard. A
read-only caller may dispatch only explicitly read-only children.
Detached driver execution remains outside the guard, as does the supervisor clone.
Custom and extension tools other than the guarded built-in write/edit shapes are
outside the path-extraction contract.
