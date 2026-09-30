# Development notes

Load this document when changing the Pi seam, test harness, or a shared response shape.

## UI and RPC seams

When a change reaches `ctx.ui`, `pi.events`, or a `pi.on` handler, drive it through
`piCallbacks(pi)` with a fake context and assert what the boundary receives. Pure formatter
tests do not prove registration or wiring.

`ctx.ui.setStatus` and `ctx.ui.setWidget` clear only with `undefined`; an empty string leaves
stale UI. `hasUI === true` does not guarantee component rendering: RPC mode accepts string
arrays and ignores component factories, while TUI mode can render components. Test the mode
that the changed path supports.

## Shared shapes

Before changing `/health`, `DaemonStatus`, the store schema, or the exported service contract,
use `rg` to enumerate consumers and check each one. A response or type change is complete only
when all current renderers, services, and tests agree.

## Test harness

Use `PI_CALLBACKS_DIR` with a test-owned temporary directory for every store test. Start test
daemons with `port: 0`; the fixed port `47837` belongs to the user-facing daemon and is not a
test fixture. Stop only the daemon created by the test. Never signal or stop a shared daemon.

These rules preserve isolation between concurrent worktrees and avoid turning a port collision
into a process-wide test-runner exit.

## Public test setup

This package is tested on Node 22. From the exported package directory, install
dependencies and run the test suite:

```bash
npm install
npm test
```

`npm test` uses Node's built-in test runner. Store-touching tests use a temporary
`PI_CALLBACKS_DIR`, and daemon tests bind to port `0`, so the suite does not read
or signal a user's running callback daemon.
