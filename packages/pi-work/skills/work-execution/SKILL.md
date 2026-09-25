---
name: work-execution
description: >-
  Execute a validated pi-work node or wave when you need the ready-set,
  by-reference work_plan brief, pi-delegate fallback, explicit tree-bound
  verification, remediation, scope amendments, or a post-integration
  refactor pass. Use after decomposition and before claiming any node is done.
disable-model-invocation: false
---

# Work execution

This is a judgment loop for the session agent, not an execution engine. pi-work
owns the work contract and evidence; pi-delegate owns worker execution,
isolation, escalation, monitoring, and collapse. Do not invent a scheduler, a
retry daemon, a dispatch receipt, or a second cache.

Load and reuse `orchestrate-work` by name when several ready nodes can run in
parallel. Load `review-and-refactor` by name for the post-integration pass.
Load `implement` by name in an implementation worker. Load exactly one matching
language orientation by name: `implement-typescript`, `implement-python`,
`implement-rust`, or `implement-frontend`.

Reuse those skills instead of copying their rules here.

## The vocabulary that prevents false greens

There are two axes:

- **Lifecycle** — `done`, `ready`, `blocked`, or `needs-decision`.
- **Verification provenance** — whether evidence was run authoritatively in the
  current session and against which tree.

Do not collapse them into one boolean or one summary word.

**Green means** the authored evidence ran through the authoritative verifier
against the explicit tree and commit, and the verifier accepted its concrete
proof and checklist accounting.

**Green does not mean** hermetic or reproducible execution, adequate criteria,
independent truth of checklist or external-action claims, review approval, or
durable authority after serialization.

For cache data, say exactly **`observed green; not verified this session`**.
Never shorten that to `verified`, `done`, or `green` for gating. A dispatch
receipt proves dispatch and correlation only. It never proves verification,
review approval, checklist completion, or that work happened.

Review approval is not part of v1 `done`. In v1, `done` derives from
current-session evidence green plus full checklist accounting, and nothing else.
A review record is reporting data. A reviewer still matters for quality and for
remediation, but a review result cannot mint verification authority.

## Round 0: establish the target and current source

1. Read the current workspec and run `work_validate({ path })`. Stop on errors.
   Treat warnings as decisions, especially `touches-concentration`.
2. Select nodes by qualified `NodeAddress` arrays. Schema ids are unique only
   within a sibling scope; never let a bare id select an ambiguous node.
3. Derive the ready set from current YAML dependencies, resolved decisions, and
   current evidence. Do not treat cached green as current completion.
4. Record the exact target tree for the next proof. A pre-merge check targets the
   worker's worktree. An integration check targets the merged tree. Capture the
   absolute worktree path and resolved commit; do not default to whichever cwd or
   `HEAD` happens to be active.

### Current v1 status limitation

`work_status --refresh` is blocked in v1. Its refresh path returns a typed
blocked result because the verify barrel deliberately exposes no authority
constructor. Therefore `work_status` can never report `verified-this-session` in
v1. The provenance vocabulary is explicit: `verified-this-session`,
`failed-this-session`, `observed-green-not-verified-this-session`,
`observed-failure-not-verified-this-session`, `stale-observation`,
`conflicting-observation`, and `unverified`. The status surface can only report
observation, stale, conflict, or unverified states because refresh is blocked.
Those reports cannot open a done gate or satisfy a dependency. Do not import a
private verifier, call a tool wrapper as an authority shortcut, or reconstruct a
verifier in a status consumer. Run `work_verify` through its real authority
path, and retain the explicit tree/commit in the evidence.

## Round 1: compile a by-reference plan

Call the real dry-run compiler with explicit addresses:

```text
work_plan({
  path: ".work/specs/<name>.yaml",
  nodeAddresses: [["api"], ["docs"]]
})
```

`work_plan` validates again, writes a brief under
`.work/.cache/briefs/`, and returns a `PlanReceipt` with:

- `nodeId` and qualified `nodeAddress`;
- `briefPath` and `briefSha256`;
- delegate `agent`, optional `skills` and `model`, `reads`, and `task`;
- `writableRoots` when `touches` exists;
- `confineWrites: true`, `escalation: "local"`, and `worktree`; and
- a `touch-overlap` advisory when selected scopes overlap.

`touches` becomes delegate `writableRoots`, but the current pi-delegate
policy keeps the worker cwd writable and treats those roots as additions; it
does not narrow the cwd to `touches`. Use a dedicated worker tree, treat writes
outside `touches` as a contract violation, and use literal relative directory
roots or exact file paths, not `**` globs: path containment does not expand
shell globs.

The brief is the contract. Pass it by reference and make the worker read it.
Do not paste a shortened contract into a new task and call that lossless.

If the compiler returns `worker-profile-unsupported`, do not remove the profile
silently. Profiles are blocked until pi-delegate #142 ships; revise the spec or
raise the product decision.

## Criterion amendment flow: an authority changes accepted text

A criterion change is a distinct recorded act. Do not edit `statement`, the
source draft, or the workspec's retained draft path to manufacture lineage. Call
the non-interactive tool with the exact current text and the authority-backed
replacement:

```text
work_amend_criterion({
  path: ".work/specs/<name>.yaml",
  criterionId: "A1",
  before: "The exact current statement",
  after: "The authority-approved replacement",
  reason: "Why the accepted wording changed",
  authority: "Issue, note, or ADR reference"
})
```

The tool refuses a stale `before`, an invalid pre-existing chain, an unknown
criterion, or a no-op. On success it appends `criterion_id`, `before`, `after`,
`reason`, `authority`, and the execution timestamp, then validates the new
endpoint before writing. Run `work_validate` again and inspect its rendered
result. A spec whose retained source draft is absent or unreadable fails with
`criterion-draft-unavailable`; restore the named original draft or correct the
visible path before amending it. A criterion id absent from that draft also
fails. Never infer lineage from the current spec, because that would bless the
silent edit this check exists to detect. Editing the draft's authored prose or
repointing the visible draft path can still redefine the anchor, so review both
changes explicitly; this mechanism is not absolute authentication.

This flow changes one proof obligation's text. Splitting or merging criteria
changes how many proof obligations exist and needs a separate decision; do not
encode it as an amendment chain.

### Choose a wave

The overlap advisory is mechanical. Decide deliberately:

1. **Serialize** nodes that write the same path or otherwise depend on one
   another.
2. **Re-cut** `touches` or node ownership if the overlap is accidental.
3. **Accept knowingly** only when the shared path is a real integration point,
   and record why merge order and post-merge verification are safe.

For independent nodes, load `orchestrate-work`. Its default branch-worktree
procedure provisions persistent lane worktrees and merges them in a defined
order. The pi-delegate `worktree: true` option creates temporary worktrees,
captures their diffs, and removes them after completion; it is not a persistent
worker tree and is not proof that work was integrated. Before `work_verify`,
either use a caller-managed persistent worktree with `worktree: false`, or apply
the returned diff to the persistent worker/integration tree and verify that tree.
For remediation, the "same worktree" rule means the same persistent tree, not a
cleaned-up temporary worktree.

## Round 2: dispatch honestly

Use `work_dispatch` to dispatch one planned node. It performs exactly one
pi-delegate dispatch through the live pi-delegate instance and records a
durable node-to-run receipt. It never loops, waits, or retries. Do not write a
fake receipt.

When the pi-delegate runtime is unavailable in the session, for example when
pi-delegate is not loaded, `work_dispatch` returns a `degraded` result with
`dispatchState: "not-dispatched"` and a `delegate-client-unavailable` finding,
and carries the plan back. Only then fall back to the paste-ready delegate invocation in the `PlanReceipt`. That
fallback is not a `work_dispatch` receipt and cannot advance lifecycle.

For the fallback, when a plan's receipt has `worktree: false`, use the real
single-direct pi-delegate shape, adapting the receipt fields without renaming
them:

```ts
delegate({
  agent: plan.delegate.agent,
  task: plan.delegate.task,
  reads: plan.delegate.reads,
  skills: plan.delegate.skills,
  model: plan.delegate.model,
  writableRoots: plan.delegate.writableRoots,
  confineWrites: true,
  escalation: "local",
  worktree: false,
  await: false,
})
```

Omit optional properties whose receipt value is absent. Do not blindly paste a
parallel receipt with `worktree: true`: the real pi-delegate runtime API rejects
`reads` together with `worktree: true`, and temporary worktree mode rejects a
per-worker `cwd`. For a parallel wave, use `orchestrate-work` to provision
caller-managed persistent worktrees, then dispatch each lane with
`worktree: false`, its `cwd`, and the by-reference `reads` path. Alternatively,
apply the captured temporary diff before verification; do not call that diff a
receipt of integrated work.

Keep `await: false` (or omit it) when escalation is enabled: pi-delegate
rejects `await: true` and `sync: true` for an escalation-enabled slot.
Background delivery is the real completion path. Do not poll or sleep; use the
wake or a normal later turn to inspect the result.

For a supervised review or implementation that needs clarification, use the
real `agents: [...]` form of `delegate`, with `clone_mode: "task_only"` or
`"snippet"`, a named fork, and `escalation: "local"` on that slot. For
independent one-turn nodes use `tasks: [...]` or separate single-direct calls.
Do not combine `agents`, `tasks`, and a direct `agent` selector in one call.

Record only what actually returned: run id, fork name, task, brief hash, target
tree, and any worktree/branch. A manual `delegate` call is not a pi-work
dispatch receipt; only `work_dispatch` records one.

## Round 3: worker completion and pre-merge evidence

The worker reports its changed paths, commit, command output, checklist item
accounting, and any gap. Inspect the proof, not only the report. The current
standalone `work_verify` input is `nodeId`-only and recursively selects the first
matching id; it cannot safely distinguish repeated nested ids. Use globally
unique ids for nodes verified through this entry point, even though
`work_plan` and future status consumers use qualified addresses. In the
persistent tree that contains the worker's changes, run `work_verify` with
explicit inputs:

```text
work_verify({
  path: ".work/specs/<name>.yaml",
  nodeId: "api",
  worktreePath: "/absolute/path/to/worker-tree",
  expectedCommit: "<full-commit-sha>",
  checklistReports: [
    { index: 0, done: true }
  ]
})
```

If the dispatch used temporary `worktree: true`, apply its captured diff to a
persistent worker or integration tree first; do not point `work_verify` at a
worktree that pi-delegate has already removed. A remediation redispatch must
reuse that same persistent tree and the revised literal writable roots.

Require the verifier's concrete proof, including the authored path, captured
output, monitoring, and exact tree identity. A command criterion needs a
non-empty `expect.output_includes` floor. A `user` criterion needs the host's
explicit confirmation. An `agent` criterion is a typed `agent-unavailable`
failure in v1, not a skipped item. Injected judges and copied results are
observational and cannot mint trust.

If the worker's branch is later merged, the pre-merge result is not enough.
Run the evidence again in the merged tree, with the merged tree's path and
resolved commit. Never carry a green result across a merge merely because the
files look similar.

## Amendment flow: a worker needs a path outside `touches`

A declared-scope escape is a contract problem, not permission to edit broadly.
The current delegate guard may still allow a path inside the worker cwd because
that cwd is its primary writable root; a path outside the cwd is refused unless
an explicit root permits it. Follow this exact amendment flow for any needed
scope widening. The names and fields below are the real pi-delegate escalation
surface, checked against its `src/escalation-tools.ts`, `src/index.ts`, and
`docs/escalation.md`.

### A. Raise from the worker

1. Stop before writing outside the declared scope.
2. Ensure the worker slot was enabled with effective `escalation: "local"`.
   `work_plan` places this on its delegate invocation.
3. Call the real amendment raise tool:

   ```text
   escalate_amendment({
     target: "<spec path and node address>",
     change: "Add the literal reports/published directory to this node's touches",
     rationale: "The publication step creates this artifact and the current scope confines the required write."
   })
   ```

   `target` is an opaque reference. `change` is the exact proposed change.
   `rationale` explains why it is needed. Do not substitute a made-up
   `amendmentId`, `scope`, or `approve` parameter.
4. The raise tool call is held while the durable request is pending. Do not
   continue by self-widening, poll, sleep, or report an approval you have not
   received.

### B. Re-read canonical state at a hop

A `delegate:escalation-pending` wake is only a hint. The root or supervisor
re-reads the durable mailbox with:

```text
# supervisor mailbox
# (the supervisor receives these when escalation is enabled)
resolve_escalation({
  requestId: "<request-id>",
  selected: 0,
  note: "<optional audit note>"
})

# Or pass it upward when it is not that supervisor's decision
escalate({
  requestIds: ["<request-id>"],
  context: "<useful context>",
  recommendation: "<recommendation, if any>"
})
```

A supervisor may resolve only within declared authority. `selected` is a
zero-based option index or an array only when a decision permits multi-select.
It must not infer an operator's answer. If the request is not the supervisor's
decision, use `escalate`; do not call a nonexistent generic `ask` route.

At the root, first call:

```text
delegate_escalation({
  action: "list",
  rootRunId: "<optional root run>",
  requestIds: ["<optional request-id>"]
})
```

Omit filters only when scanning all roots is intended. This call re-reads
canonical durable state; wake holder data alone is not authoritative.

### C. Resolve or pass at the root

If root authority covers the amendment, resolve the root-held request with the
real root tool:

```text
delegate_escalation({
  action: "resolve",
  rootRunId: "<optional root run>",
  requestId: "<request-id>",
  selected: 0,
  note: "Approved because the artifact is owned by this node"
})
```

Amendments use the real bounded options `Approve`, `Approve with modifications
(see note)`, and `Reject`, plus the structural custom option. Select by its
zero-based index; do not rely on a label or assume an index for a custom option.
A custom answer requires selecting the option marked `custom: true` exclusively
and providing non-empty `customInstruction`.

If root authority does not cover the request, pass it to the operator:

```text
delegate_escalation({
  action: "pass_up",
  rootRunId: "<optional root run>",
  requestIds: ["<request-id>"],
  context: "The worker is held at the declared confinement boundary.",
  recommendation: "Approve widening only to the literal reports/published directory."
})
```

The root has no matching `escalate_amendment` raise tool in this API. It can
inspect, resolve within authority, or pass an existing worker request; it cannot
invent a new typed amendment by passing it up with `delegate_escalation(action="pass_up")`. If no worker
request exists, ask the operator through the host's actual user surface or
redispatch the worker with an enabled escalation slot so the worker can raise
the amendment. Do not fabricate a request id or a resolution.

A user-held request may be resolved with `delegate_escalation(action="resolve")` only
after the operator actually chose an option, and only with
`onBehalfOfUser: true`. Never infer that choice from silence, a recommendation,
or a default. `note` is audit metadata; it is not the answer.

### D. Continue only from the outcome

On approval, edit the authoritative workspec `touches` to the approved exact
scope. Re-run `work_validate`, recompile the node, and redispatch with revised
literal `writableRoots`. An approval does not mutate the live slot's immutable
confinement. Reuse the same persistent worktree for the redispatch unless the
orchestrator deliberately changes the execution topology; never point at a
cleaned-up temporary worktree. Record the amendment in pi-delegate's escalation
trace; pi-work must not create a second amendment log.

On rejection or cancellation, leave the spec and scope unchanged. Report a
blocked or incomplete node. A worker never edits around the refusal.

## Round 4: review, rejection, and remediation

Review only the node's owned criteria and checklist. Give the reviewer the
assembler-rendered review contract and the worker's reported evidence plus the
`work_verify` results. Do not review the whole spec as if every criterion were
owned by this node.

If a reviewer rejects:

1. Capture the failed criterion ids, each cited concern with file/line
   citations, and prior evidence results verbatim.
2. Redispatch the implementer in the **same worktree**, not a fresh one, so the
   remediation sees the rejected changes and keeps tree identity explicit.
3. Use the assembler's remediation projection as the brief. It must include
   the failed ids, concerns, citations, and prior evidence. Do not replace this
   data with an agent-written summary.
4. The default remediation budget is **two rounds per node**, tunable per
   dispatch. This is an execution-skill convention, not a schema field.
5. After each remediation, rerun focused evidence in that same worker tree and
   inspect the new proof. If it is later merged, re-run evidence in the merged
   tree again.
6. When the budget is exhausted, raise a typed escalation to the user. Do not
   attempt an N+1th silent retry.

The current public `work_plan` tool accepts only `path` and `nodeAddresses`; do
not invent a `remediation` parameter. The plan module's real assembler exposes
the `renderRemediationBrief` projection, but if the host cannot call that
projection, preserve the structured rejection data and report the missing
wiring rather than writing a substitute brief that claims lossless assembly.

A reviewer result is not v1 verification. In particular, an `agent` acceptance
criterion remains `agent-unavailable`; a reviewer cannot turn it into a trusted
pass by returning `approve` through an injected callback.

## Round 5: integrate and run the refactor agent

After a wave is integrated:

1. Re-read the combined diff and confirm the merge landed in the intended tree.
2. Run the integration node's evidence in the merged tree, with its explicit
   path and full commit. This is a new evidence run, not a replay of worker
   output.
3. Once behavior and tests are green, send a fresh-context refactor agent over
   the combined result. This is a convention, not a hidden pi-work engine. Use
   the real supervised delegate shape so the worker has no stale implementation
   transcript:

   ```ts
   delegate({
     agents: [{
       name: "post-integration-refactor",
       agent: "implementer",
       task: "Read the merged-tree diff and run review-and-refactor. Reuse shared utilities, reconcile types, and split god-file drift only within the declared integration scope. Preserve behavior and report every changed path.",
       skill: ["review-and-refactor"],
       clone_mode: "task_only",
       cwd: "/absolute/path/to/integration-tree",
       escalation: "local",
     }],
     worktree: false,
     await: false,
   })
   ```

   Run it serially in the dedicated integration tree. The exact worker name can
   vary with the host's discovered agents; do not claim a `refactor-agent`
   executable exists. The role is a fresh-context agent loaded with
   `review-and-refactor`.
4. The refactor agent must not widen scope on its own. If it needs a path outside
   the integration node's declared `touches`, use the amendment flow above.
5. Inspect its actual diff. If it changes code, rerun focused tests, typechecks,
   and integration evidence against the new merged commit. If it finds no safe
   refactor, record a no-op; do not manufacture a change.
6. Report any god-file or cross-node finding as a new node or follow-up when it
   is outside scope. Do not turn the post-integration pass into an unrelated
   rewrite.

## Terminal truth checklist

Before calling a node done, verify all of these from current authoritative data:

- the workspec validates with no errors;
- every dependency and open decision permits the node;
- the worker's actual tree and full commit are named;
- `work_verify` ran in that tree and accepted every authored criterion;
- every checklist item has exactly one accounted-for `done` report;
- integration evidence ran again after merge, in the merged tree;
- any review is reported separately and was limited to owned criteria;
- no cached observation was called verified or used as a gate;
- no dispatch receipt was called proof of work; and
- no v1 limitation was silently routed around.

If one item is missing, report `ready`, `blocked`, or incomplete rather than
`done`. A confident summary cannot replace a proof path, output, monitoring
record, tree identity, or current-session authority.
