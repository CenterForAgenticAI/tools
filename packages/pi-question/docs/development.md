# Development reference

This page describes the public snapshot layout and runnable checks.

## Layout

| Path | Purpose |
| --- | --- |
| `src/contract/` | Pure types, normalization, and narration with no runtime dependencies. |
| `src/adapters/` | Dialog behavior and answer-surface adapters. |
| `src/kernel/` | Surface selection, timeouts, and blocked-signal lifecycle. |
| `src/tools/` | Pi `ask` tool registration and execution. |
| `tests/` | Node.js test suites. |
| `scripts/smoke-package.mjs` | Packed-package install, contract import, and Pi extension smoke test. |

## Commands

Node.js 24 or newer and npm are required.

```sh
npm install
npm run test:public
```

The public test runs the test suite and the packed-package smoke test. Tests run
TypeScript files directly with Node.js type stripping, so runtime code should
avoid TypeScript-only syntax.
