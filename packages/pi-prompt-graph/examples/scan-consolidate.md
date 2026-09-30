---
description: Scan front end and back end in parallel worktrees, then consolidate
budget: 12
mode: orchestrated
maxConcurrency: 2
graph:
  entry: plan

  nodes:
    plan:
      template: scope-audit
      args: "{input.task}"
      output: working.plan
      next: [scan-frontend, scan-backend]

    scan-frontend:
      agent: auditor
      task: "Audit the front end against {working.plan}."
      cwd: "{input.repo}"
      worktree: true
      output: working.scan.frontend
      contract:
        type: object
        required: [findings]
        properties:
          findings:
            type: array
            items:
              type: object
              required: [path, severity, note]
              properties:
                path:     { type: string }
                severity: { enum: [low, medium, high] }
                note:     { type: string }
      next: consolidate

    scan-backend:
      agent: auditor
      task: "Audit the back end against {working.plan}."
      cwd: "{input.repo}"
      worktree: true
      output: working.scan.backend
      contract:
        type: object
        required: [findings]
        properties:
          findings:
            type: array
            items:
              type: object
              required: [path, severity, note]
              properties:
                path:     { type: string }
                severity: { enum: [low, medium, high] }
                note:     { type: string }
      next: consolidate

    consolidate:
      join: all
      template: merge-findings
      timeoutMs: 900000
      reads: [working.scan.frontend, working.scan.backend]
      output: result.report
      storage: artifact
      next: done

result:
  paths: [result.report]
---

# scan-consolidate

Fan-out, join, and the two rules that make parallel work safe without merge machinery.

## Disjoint writes instead of reducers

The two scan nodes run in the same step and write **different paths** — `working.scan.frontend` and `working.scan.backend`. The compiler enforces this: two co-scheduled nodes writing one path is `E-CONFLICTING-PARALLEL-WRITE`.

That single rule removes the need for reducers in the first version of the runtime. The general answer — a declared reducer per path, `collect` for fan-out inside a cycle — is deferred until a graph is actually blocked without it. Every graph legal under the disjoint rule stays legal when reducers arrive, so nothing written now has to be rewritten later.

## Commit once, at the end of the step

Both scans read the same immutable snapshot of state. Neither sees the other's half-finished result. When both resolve, their writes apply in scheduled order and commit together; only then are edges evaluated. A run's committed state therefore does not depend on which branch happened to finish first.

## Worktrees, not hope

`worktree: true` gives each branch its own checkout. Two auditors editing one working tree concurrently is the failure this avoids, and it is `pi-delegate`'s mechanism, not ours to rebuild.

The related constraint is write confinement: a delegated worker is confined to its cwd, the temp directory, and declared writable roots, so a node cannot simply write its contract result into the graph run directory. The preferred resolution is the delegate `output` file, copied in by the adapter — never widening a worker's writable roots to the whole run directory, which would let one branch overwrite a sibling's result.

## The join

`consolidate` declares `join: all`, so it fires once both sources have arrived.

`any` and `quorum(n)` say **how many arrivals the join needs before it proceeds**. They do not cancel a slow sibling and cannot: execution is bulk-synchronous, so every node scheduled in a step runs to completion and all writes commit together. In this graph both scans are scheduled in one step and arrive in the same step, so all three modes would behave identically here.

Where they differ is a join fed across *different* steps — which is what a cycle produces. A join consumes the arrivals that satisfied it, and each arrival carries the activation that produced it, so a second lap cannot be satisfied by the first lap's arrivals. That is what lets a join sit inside a cycle without wedging or double-firing.

## `storage: artifact`

The merged report is a document, not routing state. It is written to a content-addressed file in the run directory and state keeps a reference — URI, media type, byte length, hash, and a bounded preview. Hot state is the working set that routing needs; a graph whose state grows with each finding will meet its state budget and stop.
