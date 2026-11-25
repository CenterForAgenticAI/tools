# Strategy fixtures

External context strategies for the out-of-process strategy adapter (caair/pi/pi-context-aware#470). Each is a Node script that speaks the protocol in `docs/strategy-protocol.md`.

- `mask-last-k.mjs`: the example strategy. It stubs every tool result older than the last five. `tests/strategy-conformance.test.ts` runs it through the conformance suite and the bench.
- `hostile.mjs`: a strategy that misbehaves in the way the view's model id names (hang, flood, extra fields, unknown ids, and so on). `tests/strategy-conformance-hostile.test.ts` uses it to prove each guard.
- `lead-then-mask.mjs`: answers with mask-last-k's plans after a lead plan its argument names (`say`, `empty` or `repeat`, which sends the stub plan twice). `tests/strategy-conformance.test.ts` uses it to prove that the bench checks every plan of a reply, not only those before a plan that changes nothing.

All three are executable and start with `#!/usr/bin/env node`, so the bench can run them directly.
