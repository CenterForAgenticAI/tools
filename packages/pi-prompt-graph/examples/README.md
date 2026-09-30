# Worked examples

These four complete graphs are public reference material and package fixtures.
The source test suite runs each graph to a terminal with stub adapters. The
public-package smoke test also compiles each exported file from the cleaned
release tree.

| File | Shows |
| --- | --- |
| [fix-until-green.md](fix-until-green.md) | A back edge, an exit-code verdict, and a visit limit with a graceful fallback |
| [review-revise.md](review-revise.md) | An output contract, ordered conditions, an explicit round counter, and graceful degradation |
| [scan-consolidate.md](scan-consolidate.md) | Parallel fan-out with disjoint write paths, delegated agents, worktree isolation, and a join |
| [release-gate.md](release-gate.md) | A human approval step and the refusal path for a non-interactive run |

Each example declares a `budget`, gives every limited node an `onLimit` route,
and provides a terminal path. Templates and agents named in these graphs must
exist in the Pi installation that runs them; the examples reference existing
units rather than defining inline prompts.
