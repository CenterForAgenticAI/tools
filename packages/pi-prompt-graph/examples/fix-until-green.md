---
description: Apply a fix and re-apply it until the test suite passes
budget: 20
mode: session
collapse: on-back-edge
graph:
  entry: implement

  nodes:
    implement:
      template: apply-fix
      args: "{input.task}"
      output: working.change
      next: verify

    verify:
      command: [npm, test, --silent]
      timeoutMs: 600000
      output: working.tests
      on:
        pass: document
        fail: implement
      limit: 3
      onLimit: escalate

    document:
      template: write-changelog
      output: result.changelog
      next: done

    escalate:
      template: summarise-failure
      args: "{working.tests.tail}"
      output: result.summary
      next: fail

result:
  paths: [result.changelog, result.summary]
---

# fix-until-green

The smallest graph that justifies the package: `verify` routes back to `implement` on failure.

## What each rule is doing

**`verify` is a command node.** Its verdict is an exit code, so the routing decision costs nothing, involves no model, and cannot be talked out of by an agent having a bad day. Where a deterministic prompt template already wraps the same command, `template:` would be preferred so the result card appears in the session the user is watching.

**`limit: 3` with `onLimit: escalate`.** Three attempts, then a different kind of node. Without `onLimit`, the compiler refuses the graph (`E-MISSING-ONLIMIT`), which is deliberate: the graceful path should cost one line, not a remembered pattern.

**`escalate` ends at `fail`.** The run is a failure — the tests never passed — but it produces `result.summary` on the way out. Compare this with letting `budget: 20` stop the run: that ends with a limit error and nothing to read.

**`collapse: on-back-edge`.** Each return to `implement` folds the previous attempt's span back to the run anchor with a summary. Without it, the third attempt reasons over two attempts of noise. This requires a valid session anchor, so the run coordinates with `pi-context-aware` before starting each node.

## Shorthand

```yaml
budget: 20
graph: implement -> verify@3>fail ?pass=document ?fail=implement -> document -> done
```

The `@3` sits on `verify`, matching the long form, where it is `verify` whose visits are capped. Written `?fail=implement@3>fail` it would cap `implement` instead — a different graph, and one the compiler cannot tell you that you did not mean.

**The shorthand cannot express this graph, and the difference is worth seeing.** Its limit routes to `fail` rather than to `escalate`, because the shorthand has nowhere to define `escalate`: a segment with no routes takes the *following* segment as its destination, so writing `-> escalate ->` anywhere in the chain would send it onward to `document` instead of ending the run. The long form's `escalate` ends at `fail` after writing `result.summary`.

So the one-liner loses the summary a person reads when the tests never pass. It also loses everything hanging off every node — `args`, `output`, `verify`'s `timeoutMs`, and the context collapse. That is the trade: topology in one line, detail nowhere, and one shape the long form has that the one-liner simply cannot reach.

## What it does not do

Nothing distinguishes "the tests fail because the fix is wrong" from "the tests fail because they were already broken". A more honest version runs `verify` first, before `implement`, and routes an initially-red suite somewhere else.
