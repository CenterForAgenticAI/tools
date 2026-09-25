# Example draft

## Summary <!-- work:summary -->

Ship an example.

## Why <!-- work:rationale -->

Because a source draft should remain useful.

## Acceptance criteria <!-- work:criteria -->

- A1: Output preserves YAML: {x: [1, 2]} and unicode ✓
  continuation with `ticks` and trailing spaces

- A2: It handles a fenced example
  ```yaml
  ---
  - nested: true
  ```
