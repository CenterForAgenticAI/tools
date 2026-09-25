---
name: work-decomposition
description: >-
  Turn a validated pi-work intent into a strict workspec work graph when the
  work is too large for one bounded worker. Use when assigning criterion homes,
  dependencies, honest write scopes, open decisions, or optional model-change
  nodes before planning execution.
disable-model-invocation: false
---

# Work decomposition

Use this skill after authoring and before execution. Decomposition is a design
step: it chooses boundaries, ownership, proof, and order. It does not dispatch
workers, infer readiness from a stale cache, or declare anything done.

Load and reuse `domain-modeling` by name for boundaries and state transitions.
Load `compiled-intent` by name only when the target repository has an adopted
Lean model.
Load `work-authoring` when the intent or criteria are not yet stable. Do not
rewrite those skills here.

## Decomposition invariants

A valid workspec is strict YAML with this shape:

```yaml
title: Ship the widget importer
description: !md |
  What outcome this work produces.
intent: !md |
  Why it exists, including constraints and non-goals.
work:
  - id: implementation
    task: Build the importer
    touches: [src/import/schema]
    acceptance:
      - id: import-output
        statement: The importer emits the named output for the fixture set.
        evidence:
          kind: command
          run: !bash |
            npm test -- importer
          expect:
            exit: 0
            output_includes: passed
          timeout_ms: 180000
```

`timeout_ms` is optional command evidence: an integer from 1,000 to
3,600,000 milliseconds (one hour); omitting it keeps the 30,000 ms default.
The validator rejects unknown keys and lifecycle fields. The following are
non-negotiable:

- `work` is the schedulable child graph. A `checklist` is a plain list owned by
  one leaf worker, not a set of child nodes. A node has `work` or `checklist`,
  never both.
- Acceptance criteria are node-owned. Give every criterion exactly one home.
  There is no spec-level requirement list and no `satisfies` mapping.
- Promotion retains the source-draft path in the generated first line. Preserve
  that visible path while assigning criterion homes. Validation re-reads the
  named draft and derives each statement's SHA-256 root; a missing or unreadable
  draft, or a criterion id absent from it, fails closed. Editing draft prose or
  repointing the visible path can redefine the anchor and therefore requires
  explicit review; no workspec field may supply a replacement root.
- `depends_on` resolves only to sibling ids in the same `work` array. Nested ids
  may repeat, so use qualified addresses such as `["importer", "tests"]` when
  selecting or reporting a node. The current standalone `work_verify` input is
  still `nodeId`-only and recursively finds the first matching id; do not use
  repeated ids with that entry point. Give nodes globally unique ids when they
  must be verified through standalone `work_verify`, or wait for an address-aware
  consumer. `work_plan` already requires qualified `nodeAddresses`.
- `touches` is a declared write scope and contract. `work_plan` maps it to
  pi-delegate `writableRoots`, but the current delegate policy keeps the worker
  cwd writable and treats `writableRoots` as additional roots; it does not
  narrow the cwd to the listed paths. Use a dedicated worker tree and treat
  writes outside `touches` as a contract violation even when the guard cannot
  refuse a path inside that cwd. Declare literal relative paths (a directory
  root such as `reports/source` or an exact file), not shell globs:
  `writableRoots` are path roots and do not expand `**`. A node that needs a
  path outside its worker cwd must declare it or use the amendment flow in
  `work-execution`.
- `refs` are read hints with a path, optional lines, and a reason. They do not
  become extra acceptance criteria or hidden dependencies.
- `worker` is optional and, in v1, may contain only `profile`, `agent`, `skills`,
  and `model`. `worker.profile` is opaque and cannot be compiled until
  pi-delegate profile support (#142) ships; `work_plan` returns the typed
  `worker-profile-unsupported` finding instead of ignoring it.
- There is no `status`, `lifecycle`, `done`, `verified`, or review gate field in
  authored YAML. Completion is derived outside the spec.

## 1. Find boundaries, not file lists

Start with the outcome and its failure modes. Identify deliverables that can be
built, checked, and reported independently. A useful node has:

- one coherent task and one accountable worker;
- a small, honest `touches` scope;
- explicit inputs and read references;
- acceptance criteria that belong only to this node; and
- dependencies only where an output is required by a later node.

Split a node when one worker would need unrelated context, when it has two
independent proof obligations, or when its write scope would force unrelated
work to serialize. Keep work together when splitting would create coordination
without a separate artifact or proof.

A composite node organizes child work and may own an integration criterion. A
leaf node owns an implementation or a checklist and its direct criteria. Do not
make strings in a checklist into schedulable nodes. Do not make every command a
node: commands belong in evidence unless they produce a separately owned
artifact.

### Criterion-home table

Before writing YAML, make a table outside the spec:

| Criterion | Observable result | Owning address | Evidence kind | Why here |
|---|---|---|---|---|
| import-output | fixture run emits `passed` | `importer` | command | importer owns the output |
| published-copy | human confirms the report | `publish` | user | v1 has no trusted agent judge |

Every source criterion appears once in the table and once in one node. If a
criterion spans nodes, create an integration node with a new criterion rather
than attaching the same criterion to several workers.

## 2. Scope `touches` honestly

Declare the narrowest path set that contains the intended writes. Check each
scope against neighboring nodes before accepting the graph:

1. A shared target in two nodes is an intentional serialization point, not a
   reason to widen both nodes.
2. A broad target such as the literal `src` directory is a smell. Re-cut the
   work or explain why the node truly owns that surface.
3. `touches` concentration is an advisory lint, not a blocking validator error.
   Treat `touches-concentration` as a prompt to re-cut, serialize knowingly, or
   leave a documented reason; never silence it by deleting needed scope.
4. A worker must not self-widen its declared scope when it reaches an
   undeclared path, even though the current delegate cwd may still permit a
   write inside that cwd. It raises an amendment through pi-delegate; the spec
   is edited only after approval, then the redispatch receives the widened
   literal roots. See `work-execution` for the exact API.

Keep `touches` at the node root. It describes the work, not the worker profile.
Do not put `touches` inside `worker` or invent an execution-policy block.

## 3. Model dependencies and decisions

Use `depends_on` only for real sibling outputs. A dependency is not a way to
express importance, review order, or a guessed status. Check for duplicate ids,
unresolved references, self-dependencies, and cycles in every sibling scope.

If a choice changes the graph, scope, product, security, compatibility, or
proof, record it instead of choosing silently:

```yaml
open_decisions:
  - id: OD-auth-mode
    question: Which authentication mode does the importer use?
    tripwire: before decomposing the authentication subtree
    decides: user
```

An `open_decisions` entry is a frontier, not a status field. Name the question,
when it blocks safe decomposition, and who decides it. Do not parse the
`tripwire` prose later to pretend that a decision was resolved. Until the v1
status contract can scope decisions to nodes, treat an unresolved decision as a
conservative blocker for execution and say so.

## 4. Optional compiled-intent hook

If the repository contains an adopted Lean model for the domain, consult it
before finalizing boundaries. Ask whether the planned work changes allowable
states or transitions. If it does, add an explicit model-change node and make
affected implementation nodes depend on it. Give that node its own criterion:

```yaml
- id: model-change
  task: Update the adopted model for the new importer state
  touches: [model]
  acceptance:
    - id: model-build
      statement: The adopted model and its difftests build successfully.
      evidence:
        kind: command
        run: !bash |
          lake build
        expect:
          exit: 0
          output_includes: "Build completed"
```

Use the repository's real model command and output, not a guessed `lake` path.
If `model/` is a Lean Lake project and `lake build` fails, stop and report the
red model build; do not make the workspec claim green. If there is no adopted
model, this hook is absent. Do not add a speculative Lean sidecar or a schema
field for it.

## 5. Validate in layers

Run the real validator after every meaningful graph edit:

```text
work_validate({ path: ".work/specs/<name>.yaml" })
```

Read both `details.valid` and the typed `findings`. `valid: true` permits
warning-only lints; inspect warnings before execution. In particular:

- `touches-concentration` is advisory and needs a decomposition decision;
- `worker-profile-unsupported` is a planning failure, not a warning; and
- a schema-valid command with no non-empty `output_includes` can still fail at
  `work_verify`'s positive-effect floor.

Then compile explicit addresses with:

```text
work_plan({
  path: ".work/specs/<name>.yaml",
  nodeAddresses: [["importer"], ["publish"]]
})
```

`work_plan` is a dry-run compiler. It writes by-reference briefs under
`.work/.cache/briefs/` and returns a `PlanReceipt` containing `nodeId`, the
qualified `nodeAddress`, `briefPath`, `briefSha256`, and a delegate invocation.
It does not dispatch or wait. Select addresses explicitly; do not pass a bare
id when sibling scopes can repeat it.

Its plan may contain a `touch-overlap` advisory. The advisory names overlap;
it does not decide whether the nodes are safe. Choose one of:

1. serialize the overlapping nodes;
2. re-cut their `touches` or ownership; or
3. accept the overlap knowingly, with the reason and a review of merge risk.

That is an agent judgment, not a hidden scheduler.

## 6. Demonstrated decomposition

`tests/fixtures/skills/decomposition-valid.yaml` is the committed dry-run
example for this skill. It decomposes publishing an accessibility report into
source collection, copy review, and publication. It demonstrates:

- sibling `depends_on` edges;
- disjoint `touches` scopes;
- one criterion home per node;
- a `user` criterion for judgment that v1 can actually capture;
- a checklist that stays on a leaf; and
- `!md` and `!bash` tags without assigning semantic authority to the tags.

Prove the fixture with the real `work_validate` tool and require zero errors:

```text
work_validate({ path: "tests/fixtures/skills/decomposition-valid.yaml" })
→ details.valid === true
→ details.errorCount === 0
```

This validates structure and semantic dependencies. It does not execute the
commands or establish any green evidence.

## v1 limits to state at the point of use

- `work_status --refresh` is blocked in v1 because the verify barrel exposes no
  authority constructor. The status surface is a concurrent v1 lane and may not
  be registered in the host you are using; when present, `work_status` cannot
  report `verified-this-session`. A cache hit is a record, not a green. Use the
  exact wording `observed green; not verified this session` for a cached pass,
  and never use `verified`, `done`, or `green` as a gate for it.
- `agent` evidence is a typed `agent-unavailable` failure, not a skipped check.
  The pi-work trusted adapter for pi-delegate's required programmatic-client
  contract is not available in v1. Injected judges are observational and cannot
  mint trust. Authors needing judgment in v1 should use `user` evidence.
- `work_dispatch` performs exactly one delegate dispatch and records a durable
  receipt. `work_plan`'s delegate invocation is deliberately not a runtime
  receipt: it is a paste-ready fallback and cannot prove that work happened.
- A source-level exported tool is not evidence that the host registered or ran
  it. Do not claim a tool call occurred when the host did not expose it.
- A dispatch or review result never substitutes for `work_verify`. Review
  approval is not part of v1 `done`; `done` derives from current-session
  evidence green plus complete checklist accounting.
