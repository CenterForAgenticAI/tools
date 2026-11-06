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
  wrappers). Read-only git commands remain usable. A read-only slot also checks
  the directory git runs in; see [Read-only slots](#read-only-slots).

## Read-only slots

Set `readOnly: true` on an `agents[]`, `tasks[]`, chain step, or top-level
single-worker slot. This is an invocation policy, not agent frontmatter or
prose: prose and `tools: [read, bash]` do not enforce read-only behavior.
`readOnly` guards against accidental writes through `write`, `edit`, and git.
It is not isolation: a read-only worker's `bash` runs on the host with the
worker's own permissions and can write anywhere the operating system allows.
To isolate a worker from your checkout, use `worktree: true`.

A read-only slot enforces three things, and returns structured refusals with
the `readOnly` boundary. It remains active when `confineWrites: false` is used.

- `write` and `edit` are refused outside the worker's owned scratch and private
  candidate-output directories. The primary root and any candidate root that is
  equal to or an ancestor of it are excluded. Containment uses lexical and real
  paths with case-aware matching and refuses when the relationship is uncertain.
- Mutating git is refused unless every explicit target (`-C`, `--git-dir`,
  `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`) and the directory git runs in are
  inside the scratch or candidate-output directories. The directory git runs in
  is the tool's working directory, or the last `-C` directory. A leading
  `cd <dir> &&` is not followed, so `cd <scratch> && git commit` is refused;
  use `git -C <scratch> commit` instead. A target that uses shell expansion
  (`git -C "$REPO" commit`) is refused because it cannot be checked. The
  refusal names both remedies: run git with `-C` inside scratch, or dispatch
  the worker with `worktree: true`.
- The guards every confined worker has also apply to `bash`: the trusted project
  config and reserved artifact names (below).

Read-only git forms stay allowed anywhere, including the shared checkout:
`git status`, `git log`, `git diff`, `git show`, `git rev-parse`, `git branch
--show-current`, `git remote -v`, `git worktree list`, and the other forms the
git guard classifies as read-only. A git form counts as mutating, and so falls
under the rule above, when it carries `--output`; Git's global `-c`,
`--config-env`, or `--exec-path` options; the transport-program options
`--upload-pack`, `--receive-pack`, or `ls-remote -u`; pager execution through
`grep -O` or `--open-files-in-pager`; or `--ext-diff`. `hash-object` is always
mutating because configured clean filters can execute programs. An environment
assignment in front of `git` (directly or through `env`) also makes the form
mutating unless it is a locale/display setting (`LC_*`, `LANG`, `TZ`, `TERM`,
`NO_COLOR`), a git target (`GIT_DIR`, `GIT_WORK_TREE`), or `GIT_PAGER`/`PAGER`
set to `cat` or empty. Abbreviated long options (`--outp=`, `--ext`) count as the
full option.

Every other shell command runs unclassified. Redirection, command substitution,
pipes, and interpreters such as `python3 -c` and `node -e` are not refused.

The worker's write-scope prompt names each writable directory once, even when a
root is reached through a symlink. When the guard permits no path at all, the
prompt says so instead of promising scratch.

Scratch access and tool availability are separate. An explicit agent `tools:`
list must include built-in `write` (and `edit` if needed) to save files.
Allocating scratch does not widen that list. For example, a review agent that
must save JSON and Markdown needs `tools: [read, bash, write]` alongside the
dispatch-time `readOnly: true` policy.

## Reserved artifact names

Inside a Git working tree, the guard refuses `write`/`edit` targets whose basename
is reserved or matches the declared `artifact`. It also checks common bash writes:
`>`/`>>`, `tee`, in-place `sed`, parseable `cp`, `mv`, and `install` destinations,
the effective (last) static `dd of=` operand, awk output redirection whose complete
target expression is one string-literal path, and static paths used by common
interpreter write APIs. Existing hardlink aliases to a
protected artifact or `.pi/pi-delegate.json` are refused, as are parseable commands
that create a hardlink from either protected source.

A run may always write its own declared artifact path (the absolute path the
runtime injects inside the run's private attempt output directory) with `write`
and `edit`, even when the run is `readOnly` or that directory lies inside a Git
working tree (pi-delegate#472). Only the name check is waived for that one path;
inode, hardlink, and trusted-config checks still apply, and another run's file
with the same name stays refused. The exemption is withheld while the file at
that path has more than one hard link, because writing it would also change the
other name, which may be a tracked or protected file.

A project can exempt legitimate repository paths in `.pi/pi-delegate.json`:

```json
{"artifactNameExceptions":["docs/plan.md"]}
```

Each exception is a repository-root-relative path or glob. Exceptions apply only
to their Git working tree. The config is trusted-source-only: delegate workers
cannot create or modify it, including through a hardlink alias.

The bash name guard is **best-effort defense-in-depth against accidental
writes, not a sandbox**. Dynamic or computed target construction, unmodelled
interpreter file-open APIs such as `os.open`, `fs.openSync`, `sysopen`, and
`File.binwrite`, nested shells, aliases, functions, variables, command
substitution, `eval`, unparsed mutators such as `rsync`, `tar`, `make`,
`find -delete`, and `xargs rm`, and arbitrary custom or extension tools can
still write reserved files. Detached driver execution and the supervisor clone
are outside this boundary. The authoritative guarantee that reserved files never
reach Git is the delivery/CI gate: its git-level staged/tracked check catches
files however they were created.

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
read-only caller is clamped the same way: it may dispatch writable children,
but their cwd and writable roots must stay inside the caller's own roots.
Detached driver execution remains outside the guard, as does the supervisor clone.
Custom and extension tools other than the guarded built-in write/edit shapes are
outside the path-extraction contract.
