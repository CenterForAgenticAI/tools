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
| `scripts/smoke-package.mjs` | Packed-package install, contract import, Pi extension, and public-reference smoke test. |
| `scripts/public-reference-scan.ts` | Internal-name and machine-reference guard for public artifacts. |

## Commands

Node.js 24 or newer and npm are required.

```sh
npm install
npm run test:public
```

The public test runs the test suite and the packed-package smoke test. The release
pipeline scans the exported tree, and the smoke test scans the final unpacked npm
tarball. Tests run TypeScript files directly with Node.js type stripping, so
runtime code should avoid TypeScript-only syntax.
