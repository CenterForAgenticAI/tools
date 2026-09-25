---
name: delegate-only
description: >-
  Load when working under delegate-only mode: size tasks for workers, dispatch
  without blocking, use nested delegation safely, choose transcript access
  deliberately, and verify worker claims without reading the work.
load: recognition
disable-model-invocation: false
---

# delegate-only

Delegate-only mode removes every foreground built-in except `read`. `bash`,
`edit`, `write`, and all other built-ins are unavailable. `find_tool` is banned
by rule, even when an allowlist names it. Do not try to work around these rules.


## Allowlist selectors

Delegate-only allowlists use the shared tool-selector grammar. Built-ins stay
bare. Extension tools use `ext:<owner>[#<module>]:<tool>[:<action>]`. The old
final-slash form remains readable during the migration window, but new config
uses colons. Delegate-only mode checks the current `ToolInfo.sourceInfo` before
lowering an extension grant to its bare tool name. If the effective provider's
owner or module changes, the tool is removed. The default `load_skill` grant is
qualified to the host's development-tool provider; session state tools are
qualified to the context-aware provider. `find_tool` remains banned regardless
of any authored grant.
## Route removed capabilities

Delegate any task that needs a removed capability to a worker:

- running a command;
- searching the repository or the web;
- fetching data; or
- reading a large file or large slice.

Use `delegate` to dispatch the work. Use `delegate_control` with
`action=result` to inspect a terminal result, `action=status` to inspect progress
or terminal state, `action=steer` to redirect a run, or `action=cancel` to stop
one. Treat a worker's claim as unverified until its result and proof are checked.

## Size the task

- Keep a small, coherent task serial. Parallelise only independent work with
  disjoint write scopes.
- Split larger work into 2–4 lanes when useful. Each lane should fit one
  worker's context, own a clear path set, and have one proof command.
- A dispatch accepts 1–6 runs. Name each run after the work, not the worker.
- Give a worker the smallest complete brief: goal, requirements, write scope,
  read scope, proof, branch, and handoff format.

## Keep the main thread moving

Background dispatch is the default. Call `delegate` without `await`, continue
work that does not depend on the result, and let the completion wake start the
next turn automatically. Do not poll `delegate_control` with `action=status`, sleep, or
busy-wait.
Use `await: true` only when the next action cannot start until every result is
available.

## Nested delegation

Nest only when the child can split and integrate a genuine body of work. Set a
clear `depth` budget and ensure the parent agent's nested-delegation policy
allows the child agent. A child cannot raise an inherited depth limit. Keep
write scopes and branches isolated at every level; each level integrates only
its own children and returns one handoff upward.

## Grant parent-transcript access deliberately

Use `clone_mode: "task_only"` for a self-contained task. Use `"snippet"` with a
small `snippet_last_n` when recent context is needed. Use `"full"` only when
the task depends on the whole parent conversation; it costs more context and
may expose unrelated user data. Never grant full history for convenience.

## Verify a worker claim without reading the work

Do not manually read the worker's transcript or implementation to turn prose
into trust. Verify the boundary and the proof instead:

1. Call `delegate_control` with `action=status` and confirm the named run
   reached the expected terminal state.
2. Call `delegate_control` with `action=result` and check the reported changed
   paths, commit, proof commands, and exit statuses.
3. Dispatch a verifier/publisher worker to run the narrow proof plus `git status`,
   `git diff --check`, and `git show --stat`; inspect its STRUCTURED EVIDENCE for
   cleanliness, boundaries, and commit shape without opening the changed files.
4. Reject a missing result, failed proof, out-of-scope path, or mismatched commit.
   Dispatch a follow-up or report the gap; do not silently repair it in the
   foreground.

## Caps in force

The active mode supplies these values. The defaults are:

- `readBytesPerCall=16384` bytes per `read` call;
- `readBytesPerTurn=65536` bytes across one turn;
- `resultAdvisoryBytes=4096` bytes as the result advisory threshold;
- `resultHardCapBytes=16384` bytes as the result hard cap; and
- `nestingDepth=2` as the nested-delegation depth.

Stay within the active values in the injected delegate-only system section.
