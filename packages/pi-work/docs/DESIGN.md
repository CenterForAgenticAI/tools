# Design constraints

For contributors: the original design constraints that explain why pi-work has its current shape.

## What it does

Author a workspec, decompose it deliberately, execute it node by node, and
judge the result against evidence that fails closed. A check that did not run
did not pass.

Every design choice traces to an ADR under `.spec/decisions/` or to one of the
eight anti-goals in `.spec/postmortem.md`, drawn from two predecessors that
failed in understood ways. The constraints that carry the most weight:

- **No status field in a spec.** Progress is derived, never set. The git commit
  is the approval record.
- **One authority per fact.** The cache is derived, loses to its sources on
  conflict, and is safe to delete.
- **Handoffs are lossless or they are bugs.** One total contract assembler
  renders every worker brief and review contract, so a dropped field is a build
  failure rather than a hope.
- **No surface without a live consumer.** Speculative generality is what made
  the predecessors unmaintainable.
