---
name: orchestrate-work
description: >-
  Orchestrator contract for running one body of work as several concurrent
  delegated lanes and merging the results. Load when a job is too big for one
  worker, when parts of it can run at the same time, or when you are deciding
  whether to parallelise. Covers cutting work into lanes by write scope, the
  contract-first wave, branch-per-lane worktrees under `.worktrees/` and the
  alternative isolation strategies, dispatch briefs, serialized integration by
  squash/merge/cherry-pick, failure and escalation handling, and provisional
  rules for nesting orchestrators. Worker rules live in `implement`; tool
  mechanics live in `pi-delegate`; the merge step itself lives in
  `merge-coordinate`.
load: recognition
disable-model-invocation: false
---

# orchestrate-work

## Your job

You hold a body of work that is bigger than one dispatch. You do not implement
it. You:

1. cut it into **lanes** — slices one worker can finish alone, each owning its
   own files;
2. group lanes into **waves** — sets that can run at the same time because none
   needs another's output;
3. dispatch each wave, isolated so the workers cannot overwrite each other;
4. put the finished work back together, in a defined order, without inventing
   resolutions; and
5. report one result upward.

Three skills divide this work. Keep them separate:

| Skill | Owner | Covers |
| --- | --- | --- |
| `orchestrate-work` (this) | you | decomposition, isolation choice, dispatch, integration order, failure policy |
| `pi-delegate` | you | `delegate` tool parameters, background wakes, steering, escalation plumbing |
| `implement` | each worker | read-before-edit, file scope, evidence, commit, `done`/`gap`/`blocked` |
| `merge-coordinate` | the merge step | applying finished lanes onto one branch, conflict taxonomy, refusal rules |

## First decide whether to parallelise at all

Serial is the default. Parallelism buys wall-clock time and costs correctness
risk, context, and merge work. Run lanes concurrently only when **all** of
these hold:

- the work splits into slices whose write scopes do not overlap;
- the shared shapes those slices depend on already exist, or can be landed
  first in one serial wave;
- each slice has its own proof that does not depend on a sibling's output; and
- integrating them is mechanical — a defined order plus the repository's own
  checks, not a judgement call about whose version is right.

Stay serial when the work is small, exploratory, concentrated in one or two
files, or when the interface is still being discovered. Two workers editing the
same file in isolation is not parallelism; it is a conflict you scheduled on
purpose.

If you split work that should have stayed serial, the cost lands at merge time,
after every worker has already spent its budget. Decide before dispatching.

## Cut lanes by write scope, not by narrative

The cut rule is mechanical: **two lanes in the same wave must not need to write
the same file.**

Procedure:

1. List the concrete changes the job needs, as paths.
2. Group paths that must change together — a module and its test, a schema and
   its migration.
3. Any path that appears in more than one group is a **shared file**. It is the
   whole problem. Resolve it one of three ways, in order of preference:
   - move it into an earlier serial wave, so it is settled before fan-out;
   - assign it to exactly one lane and make the others read-only against it; or
   - if neither works, the lanes are not independent — merge them into one lane.
4. What remains, with disjoint write scopes, are your lanes.
5. Order lanes into waves by what they consume, not by importance.

A feature described as "backend, frontend, docs" is a narrative, not a cut. The
cut is whichever grouping makes the write scopes disjoint, even when it splits a
feature down the middle or puts two unrelated features in one lane.

## The contract wave

If several lanes depend on the same type, schema, protocol message, trait,
interface, or public signature, land that shape **first, alone, serially**.
Fanning out before the shape exists produces N incompatible versions of it and
an unmergeable wave. This is the single most common way a parallel plan fails.

What belongs in the contract wave, by stack:

| Stack | Land first |
| --- | --- |
| TypeScript | shared types and interfaces, runtime schemas, discriminated-union variants, barrel/export surface, public signatures |
| Python | protocols and ABCs, dataclasses and model classes, enums, public function signatures, package exports |
| Rust | traits, enums and their variants, public struct fields, error types, `Cargo.toml` members and feature flags |
| Frontend | design tokens, component prop types, route definitions, API client types, shared state shape |

The contract wave is a normal lane in every other respect: one worker, real
proof, a commit. Dispatch it with a type-first brief — the `implement` skill's
type-first method and the matching `implement-<language>` orientation already
describe how a worker executes it. Merge it, verify it, and only then plan the
fan-out against the shape that actually landed.

If a later lane discovers the contract is wrong, that is a `gap` coming back to
you, not a licence for that lane to change the shared shape. Amend the contract
in a serial step and re-dispatch.

## Sizing and fan-out

- One `delegate` call takes **1..6** entries. `concurrency` (default 4) caps how
  many run at once.
- Prefer 2–4 lanes per wave. Six lanes that each need review is usually slower
  end to end than three that do not.
- Size a lane to one worker's context: a handful of files, one coherent
  behavior, one proof command. A lane that will exhaust its context returns a
  `gap` and you pay for the work twice.
- More waves with fewer lanes beats one wide wave, whenever a later lane can
  read an earlier lane's landed code instead of guessing at it.

## Write the lane brief

Each lane's `task` is a contract. The worker loads `implement`, which expects
these fields, so supply them explicitly:

```text
requirements: REQ-1 ... (numbered, so evidence and gaps can cite them)
write scope:  exact paths this lane may change
read scope:   paths to read for context, explicitly read-only
proof:        the command(s) that must pass, and what they cover
branch:       the branch to commit on
commit:       message style and any required trailers
handoff:      done | gap | blocked, per the implement skill
```

Add the two fields that only exist because the lane is running in parallel:

```text
concurrent lanes: <what else is running, in one line each>
do not change:    <shared files owned by another lane or by the contract wave>
```

Rules for the brief:

- Never give two lanes in one wave overlapping write scopes. This is the
  invariant the whole plan rests on; check it before dispatching, not after.
- Tell the lane what it may **not** touch, by path. A worker that hits a
  compiler-forced ripple into another lane's file must return a `gap`, and it
  can only do that if it knows the boundary.
- Do not paste sibling lanes' plans into a brief. One line of awareness prevents
  duplicate work; a full copy invites a worker to implement its neighbour's job.
- Keep `clone_mode: "task_only"` or `"snippet"` for lane dispatches. A lane
  brief is self-contained by construction, and `full` copies your entire
  orchestration history into every worker.

## Isolation: one branch and one worktree per lane

**Default strategy: `branch-worktree`.** Give every lane its own branch, checked
out in its own worktree under `<repo>/.worktrees/`, let its worker commit there,
and integrate by merging branches. This is ordinary Git. The history is real,
the work survives a crash, `git log`/`bisect`/`revert` keep working, and the
merge step has something to merge.

Three strategies exist. Choose deliberately; the choice decides how you
integrate.

| Strategy | Set | Lane produces | Use |
| --- | --- | --- | --- |
| **`branch-worktree`** (default) | `worktree: false` + per-run `cwd` into a worktree you provisioned | **commits on a branch that persists** | almost always; required for squash merges, review, and nesting |
| `patch-capture` | `worktree: true` | a **patch file**; branch and worktree are deleted | short throwaway waves whose history is worthless |
| `shared-checkout` | neither | edits in place | serial lanes, or read-only fan-out |

### `branch-worktree` — the default

Load `delivering-work` for the procedure.

### `patch-capture` (`worktree: true`) — available, lossy

The extension creates one temporary worktree per run from the current `HEAD`,
rejects per-worker `cwd`, captures committed and uncommitted work as one
cumulative patch, and removes the branch and worktree unless capture fails.

The patch is the only durable artifact. Because capture runs `git add -A`, stray
unignored files land in it. It preserves no commit history and cannot nest. Use
it only for a short independent wave you deliberately want as patches;
otherwise prefer `branch-worktree`.

### `shared-checkout`

Do not run two writing lanes concurrently in one checkout. There is no
isolation; the last write wins and neither worker knows. Read-only lanes
(`scout`, `reviewer`) are safe to fan out this way and usually should be.

## Seed lane checklists

If a lane has more than one step worth tracking and its worker has a
`session_tasks` claimant, seed its durable checklist when you cut the dispatch.
Without a claimant, the handoff becomes a prompt checklist only; it is not durable
and has no subtree progress to read:

```ts
delegate({
  runs: [{
    name: "lane-a",
    agent: "worker",
    task: "Complete lane A.",
    handoff: { tasks: [{ title: "Inspect" }, { title: "Implement and verify" }] },
  }],
})
```

When the worker loads a `session_tasks` claimant, the handoff seeds a durable
list; read the lane subtree with `session_tasks action=subtree` to see progress
rather than asking the worker for a status update. Without a claimant, the worker
receives a prompt checklist only: it has no durability or subtree progress. A
`blocked` row includes either its reason or, when the event budget cannot retain the
full reason, an explicit `…` truncation marker. Act on a real reason; investigate
or escalate a marker-only row.

## Dispatch

Before starting an `implementer` on multi-file work with no plan artifact, warn
once: planner-first work averaged 2.7 review rounds versus 5.7 without a plan
(n=31 with a plan, n=15 without). Advisory, not a gate.

```ts
delegate({
  concurrency: 3,
  runs: [
    { name: "<lane-a>", agent: "implementer", task: "<lane brief A>", cwd: ".worktrees/<plan>-a",
      mode: "supervised", clone_mode: "task_only", escalation: "local", rounds: 6 },
    { name: "<lane-b>", agent: "implementer", task: "<lane brief B>", cwd: ".worktrees/<plan>-b",
      mode: "supervised", clone_mode: "task_only", escalation: "local", rounds: 6 },
  ],
})
```

- **Name every lane.** `name:` is the key you will use to steer, cancel, or
  recover that lane, and it is what you will read in the widget and in the
  completion result. Name it after the work — the lane id, issue reference, or
  component — never after the agent. Two unnamed `implementer` slots come back
  as `implementer` and `implementer#2`, which tells you nothing about which one
  failed. This is your responsibility, not the tool's: without `name:` the
  runtime can only derive a label from the task text, and lanes briefed from the
  same file are indistinguishable to it.

- **Dispatch in the background.** It is the default. The call returns a `runId`
  and the combined result wakes you when every lane finishes. Never poll
  `delegate_control(action="status")`, never `sleep`. End your turn and let the wake arrive.
- **Enable `escalation: "local"` on writing lanes.** A lane that hits a
  cross-lane decision must be able to reach you instead of guessing. Escalation
  requires background dispatch; `await: true` is rejected when any slot resolves
  to enabled.
- **Do not steer routinely.** Steering a lane mid-flight usually means the brief
  was wrong. Fix the brief and re-dispatch rather than negotiating through
  `delegate_control(action="steer")`.
- Dispatch one wave per call where you can. A single call gives you one
  completion wake and one place to compare results; two overlapping calls give
  you interleaved wakes and no natural integration point.

## Integration

Integration is mechanical and serialized. It is not a place for judgement.

**Order.** Apply lanes in the order you planned them, not the order they
finished. Completion order is nondeterministic; planned order is reproducible
and reviewable.

**Serialize per target.** One merge into one branch at a time. Never apply two
lanes concurrently to the same branch, at any depth.

**Preflight, all-or-nothing.** Before applying anything:

1. Collect each lane's changed paths.
2. Confirm each lane changed only its declared write scope. A lane that
   exceeded scope is a finding, not something to clean up silently.
3. Confirm no two lanes changed the same path. If they did, the plan's
   invariant broke — stop, do not merge the "safe subset", and re-plan or
   escalate.

**Pick one apply strategy for the wave and name it in the merge brief:**
`squash`, `merge`, `cherry-pick`, or `apply`.

Load `delivering-work` for the procedure.

**Delegate the merge when it is more than trivial.** A compatible development-tool
package's `integrator` agent exists for exactly this and loads
`merge-coordinate`, the narrow contract:
supplied sources, a declared strategy, a supplied path whitelist, an
all-or-nothing preflight, a small taxonomy of resolvable conflicts, and
escalation for everything else.

```ts
delegate({ runs: [{ agent: "integrator", mode: "supervised", clone_mode: "task_only",
                    task: "<merge brief JSON>" }] })
```

`merge-coordinate` defines the brief's JSON shape and repeats the preflight
above against real Git state, so a decomposition error surfaces there too rather
than only in your bookkeeping. The integrator returns `success`, `partial`, or
`escalate` — treat `escalate` as the safety mechanism working, not as a failed
run.

**Verify after integrating, not per lane.** Each lane proved itself against the
base commit in isolation. Only the integrated tree proves they compose. Run the
repository's real gate — its `check`, test, typecheck, and lint commands — after
the wave lands, and treat a failure there as the wave's failure, not the last
lane's.

**Stale parent.** If the integration branch moved after a lane branched (an
earlier lane landed, or a sibling orchestrator merged), re-check that lane
against the new head before applying it. A lane that no longer applies goes back
as a remediation dispatch with the conflict as its input. Never hand-edit a
worker's output into applying; you would be implementing, unreviewed, in the
orchestrator.

Load `delivering-work` for the procedure.

## When a lane does not come back clean

| Signal | Action |
| --- | --- |
| `delegate:fork-failed` wake with `recoveryAvailable: true` | `delegate_control({action: "recover", runId, forkName, strategy: "auto"})` for **that lane only**. Healthy siblings continue; the aggregate wake still arrives once. |
| `status: gap` | Read what is missing. Dispatch a follow-up lane with a brief that names exactly the gap, or widen scope deliberately and re-dispatch. Do not finish it yourself. |
| `status: blocked` | Fix the cause at your level: supply the missing input, make the decision, land the prerequisite. Then re-dispatch. |
| Escalation raised | `delegate_escalation(action="list")` to re-read canonical state, then resolve inside your authority or pass it up with action `pass_up`. Never infer the operator's answer. |
| Lane exceeded write scope | Do not merge it. Either re-dispatch with corrected scope or accept the wider scope explicitly and re-plan the wave whose invariant it broke. |
| Two lanes touched one file | The cut was wrong. Re-plan; the merge is not the place to fix a decomposition error. |

Partial waves are normal. Merge the lanes that came back clean, keep the
integration branch green, and re-dispatch the rest. Do not hold a whole wave
hostage to one lane.

## Nesting (provisional)

A lane can itself be a body of work. Then its worker is an orchestrator: it
loads this skill, cuts its slice into sub-lanes, and returns one collapsed
handoff to you. The tree is orchestrator → orchestrator → worker.

Rules that already hold:

- **Depth is budgeted.** Nested delegation obeys `maxSubagentDepth` (default 2;
  a fresh root may set a deliberate higher value up to the hard ceiling of 16;
  descendants may tighten but never raise it). A detached `driver` root
  keeps its minimum of 3. Plan the depth you need before dispatching, and give
  each level an agent whose `allowNestedDelegate` and `nestedDelegateAgents`
  permit its children.
- **Each level integrates only its own children.** A sub-orchestrator merges its
  sub-lanes into its own branch and hands you one result. It never merges into
  your branch, and it never reaches past you.
- **Each level reports one handoff upward**, in the same `done`/`gap`/`blocked`
  shape a worker uses. Depth must not multiply the reporting surface.
- **Isolation must follow the tree.** Today only caller-provisioned worktrees
  can do this, because `worktree: true` always branches from the main checkout's
  HEAD and rejects per-run `cwd`.

Two or three levels is a real plan. Deeper is speculation: every level adds a
brief that can be wrong, a merge that can conflict, and a summary that can lose
detail. Keep the tree shallow until #136 makes provisioning and lineage
first-class, then revisit.

## Worked example

A change adding a new record type to an API, its client, and its docs.
Plan id `records`; integration branch `records/integration`, branched from `main`.

```text
wave 1 (contract, serial)
  lane types    branch records/types    .worktrees/records-types
    write: src/types/record.ts, src/types/index.ts
    proof: npm run typecheck
  → squash-merge into records/integration, verify, then branch wave 2 from its head

wave 2 (fan-out, 3 lanes, disjoint scopes, all branched from records/integration)
  lane server   branch records/server   .worktrees/records-server
    write: src/server/records/**, tests/server/records/**
  lane client   branch records/client   .worktrees/records-client
    write: src/client/records/**, tests/client/records/**
  lane docs     branch records/docs     .worktrees/records-docs
    write: docs/records.md
  do not change (all three): src/types/**
  → preflight, squash-merge server → client → docs, then npm run check on the result

wave 3 (serial)
  lane wiring   branch records/wiring   .worktrees/records-wiring
    write: src/server/router.ts, src/client/index.ts
    (both are shared files; that is exactly why they are not in wave 2)

close out
  merge records/integration into main, remove the four worktrees,
  git branch -d each lane branch
```

The wiring lane exists because two files could not be assigned to a single wave-2
lane. Naming them in wave 3 is cheaper than discovering them in a merge.

## Checklist

Before you dispatch a wave:

- no two lanes in it write the same path;
- every shared shape they depend on has already landed and been verified;
- every brief carries requirements, write scope, read scope, proof, branch,
  commit, handoff, concurrent lanes, and do-not-change;
- every lane slot has a `name:` describing its work, not its agent;
- the isolation strategy is named, and every lane's worktree and branch exist and
  are branched from the same integration-branch head;
- the apply strategy (`squash`, `merge`, `cherry-pick`, `apply`) is chosen;
- writing lanes have `escalation: "local"`, and the dispatch is in the
  background.

Before you call the work done:

- every lane returned a terminal handoff, and every `gap` is either closed or
  reported upward;
- integration applied lanes in planned order, serialized, with no invented
  conflict resolution;
- the repository's own gate passed on the **integrated** tree;
- every worktree and branch you provisioned is removed or deliberately kept;
- your own report upward is one handoff, not a transcript of the wave.
