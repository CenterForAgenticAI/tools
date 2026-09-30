---
description: Verify, ask a person, then release
budget: 10
mode: session
policy:
  requireInteractive: true
graph:
  entry: verify

  nodes:
    verify:
      command: [npm, run, check]
      timeoutMs: 900000
      output: working.check
      on:
        pass: preview
        fail: report

    preview:
      template: summarise-release
      reads: [working.check]
      output: working.preview
      next: approve

    approve:
      human: "Release this? The summary is in working.preview."
      kind: confirm
      on:
        confirmed: release
        declined: report

    release:
      command: [./scripts/release.sh]
      timeoutMs: 600000
      output: result.release
      on:
        pass: done
        fail: report

    report:
      template: write-status
      reads: [working.check, working.preview, result.release]
      output: result.status
      next: done

result:
  paths: [result.status, result.release]
---

# release-gate

A graph that touches something irreversible, and therefore spends most of its design on refusing to.

## The human node is the approval, not an interruption

`approve` is a modelled step. It pauses the run, records an interrupt, and persists; the run resumes with `/graph resume <runId> true`, and the value is injected into the interrupted node only.

The alternative — letting `release` run and relying on `command-guard` to prompt — puts the decision in a confirmation dialog that no one reviewed in advance and that does not appear in the graph. A reader of this file can see that a person approves before anything ships. That is the difference between a gate and a hope.

This is also the right destination for `onLimit` in any graph that mutates something outside itself. "Ask a person" is a better third branch than "try again" or "give up".

## Non-interactive runs fail fast, and say why

`requireInteractive: true` means this graph refuses to run unattended. A graph file can only tighten this way; the permission to run unattended is granted when a run is started, never by the file itself. If it were allowed to, `approve` would have no one to answer it, and `release` would meet a `command-guard` confirmation that auto-denies — surfacing as a confusing node failure several steps from the real cause.

The rule is that a non-interactive run meeting a confirmation **fails fast and specifically**, naming the node and the operation, and does not retry into the same wall. Unattended mutating execution requires two explicit policy flags, because silence is not consent.

## Everything routes to a report

Every failure edge — checks failed, approval declined, release script failed — reaches `report`, which writes `result.status` and ends at `done`. There is no path that leaves the operator with nothing to read.

Note that a declined approval ends at `done`, not `fail`. The graph did exactly what it was asked to do. A person chose not to release, which is a successful outcome of a gate, and recording it as a failure would make the run history lie about what happened.

## What is deliberately absent

No retry on `release`. A release script that half-succeeded and is run again is the exact scenario the at-least-once execution guarantee cannot protect anyone from: node execution can repeat after a crash, and no checkpoint protocol makes an external effect exactly-once. A node with real-world side effects carries its own idempotency key, or it does not get retried.
