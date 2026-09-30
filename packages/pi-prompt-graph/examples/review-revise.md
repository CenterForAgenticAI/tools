---
description: Draft, review, and revise until a reviewer approves or the rounds run out
budget: 24
mode: orchestrated
graph:
  entry: draft

  nodes:
    draft:
      agent: writer
      task: "Write the change described in {input.task}."
      output: working.draft
      next: review

    review:
      agent: reviewer
      task: "Review {working.draft}. Return the declared contract."
      output: working.review
      contract:
        type: object
        additionalProperties: false
        required: [verdict, issues, severity]
        properties:
          verdict:  { enum: [approve, revise] }
          issues:   { type: array, items: { type: string } }
          severity: { enum: [none, minor, major] }
      retry:
        attempts: 3
        backoffMs: 500
      when:
        - if: { path: working.review.verdict, op: eq, value: approve }
          to: ship
        - if: { path: memory.rounds, op: gte, value: 3 }
          to: best-effort
      default: revise

    revise:
      set:
        - { path: memory.rounds, op: increment }
        - { path: working.draft, op: unset }
      next: draft

    ship:
      template: write-changelog
      output: result.changelog
      next: done

    best-effort:
      agent: writer
      task: "Produce the best version you can from {working.draft} and the outstanding issues in {working.review.issues}. Say plainly what is unresolved."
      output: result.partial
      next: done

result:
  paths: [result.changelog, result.partial, working.review]
---

# review-revise

The shape most agent workflows actually want, and the one most often written badly.

## The three rules it exists to demonstrate

**A reviewer saying no is a success.** `review` returning `verdict: revise` is a node that ran correctly and reported a result. It is routed by an ordinary edge. `onError` is not involved and must never be: it handles a node *failing* — adapter error, contract violation, timeout. Conflating them produces a graph that treats "the reviewer said no" as a crash.

**The contract decides, not the prose.** `review` declares a schema with `additionalProperties: false`. The result is validated before it enters state and before any edge is evaluated; an invalid result is a retryable node failure, so unvalidated data never reaches `revise`. The reviewer has no channel through which to declare the run successful — only a `verdict` field whose meaning the graph owns.

**The loop degrades before the budget fires.** `revise` increments `memory.rounds`, and the second `when:` clause routes to `best-effort` at three rounds. `budget: 24` never comes into it. A graph that relied on the budget would end with a limit error and no output; this one ends with a partial result and an explicit statement of what is unresolved.

## Details worth copying

- **`when:` is ordered, `default:` catches the rest.** Approve first, then the round check, then revise. Without `default:`, the compiler would reject the graph for non-total routing (`E-NON-TOTAL-ROUTING`).
- **`revise` unsets the draft.** A new round starts from a clean `working.draft` rather than accumulating. Combined with a bounded `memory.*`, this is what stops a cycle inflating state until it hits a byte budget.
- **`result.paths` includes `working.review`.** The caller gets the last review, not the whole internal state. `includeState` stays false by default; a hundred kilobytes of run state must not land back in the calling agent's context.

## Why `mode: orchestrated`

The reviewer should not inherit the writer's reasoning. Delegated nodes start fresh, which is exactly the independence a review needs. In session-guarded mode both nodes would share the same transcript, and the reviewer would be reviewing its own argument.
