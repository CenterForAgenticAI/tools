# Development

This public release snapshot supports the same install and test flow as the package directory:

```sh
bun install
npm test
```

Bun installs the dependencies and Node runs the scripts and tests. `bunfig.toml` selects Bun's hoisted layout, which gives the flat `node_modules` tree the checks expect. Bun copies packages from its global cache with hard links, so each worktree's install takes little extra disk.

## Pi SDK versions

The Pi SDK ships as several `@earendil-works/*` packages released together. `package.json` pins `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` as exact development dependencies. Its `overrides` point every other SDK package at those pins with `$` references, so an install without `bun.lock` still gets one copy of each SDK package at the pinned version. Overrides apply only to this package's own install; consumers are unaffected.

`npm run sdk:check` fails when the lockfile or the installed tree disagrees with the pins, or holds a nested second copy of an SDK package. The release verifier runs `npm run release:verify`, which checks the installed tree before the tests. When a new SDK package appears in the lockfile, add an override for it.

## Safety-case mutation replay

`npm run check` runs `tests/fixtures/safety/mutations.mjs` after the coverage run has compiled the tests. For each safety-case control, the script removes the control in a disposable copy of the compiled tests, expects the named replay to fail an assertion, then restores the control and expects the replay to pass. When you add a safety case, add its control to the `mutations` list. Run the replay alone with `npm run test:safety-mutations`.

## Fold engine copy

`src/folds/kernel` is a verbatim copy of the [acp-kernel](https://github.com/ranxianglei/acp-kernel) engine. `src/folds/kernel/PROVENANCE.md` records the npm version, the source commit and the upstream license. Do not edit the copy; change the adapter in `src/folds` instead. The adapter adds one rule the engine lacks: it refuses a cut-off summary (`src/folds/stub-summary.ts`, pi-context-aware#173), recorded as parity difference FP-008 in `docs/fold-parity.md`. To update it, run `node scripts/sync-acp-kernel.mjs <version>`, review the diff and run `npm run check`. The script refuses to copy when a mapped repository source differs from the embedded source-map content in the published package. `src/folds/PROVENANCE.md` explains how the five unmapped modules are covered and which checks do not establish tarball equivalence. The copy is excluded from ESLint and type-checked with the rest of `src`.

## Vendored kernel tests (REQ-PARITY-001)

Run the pinned upstream engine tests locally, without installing tsx:

```sh
node scripts/with-temp-root.mjs node scripts/acp-kernel-tests.mjs --run
node scripts/acp-kernel-tests.mjs --check
node scripts/acp-kernel-tests.mjs --upstream-check
```

`--run` checks provenance, then uses the existing TypeScript compiler to transpile
into a temporary directory and runs Node's test runner there. Like upstream's
tsx command, it does not type-check the upstream test bodies. Production code
is still type-checked by `npm run check`. The 66 test files contain 845 tests;
three prompt fixtures are also copied. These tests are separate from the
package's `npm test` glob and ESLint rules. The CI `acp-kernel-tests` job runs
both upstream verification and the suite.

`--check` is offline. It verifies the complete file inventory, local SHA-256,
and the upstream SHA-256 after reversing only the recorded import-specifier
changes. `--upstream-check` also clones the pinned commit and independently
compares bytes and the complete upstream inventory. It needs GitHub access.
`tests/acp-kernel/provenance.json` records each file, both hashes, every import
change and occurrence count, and all 21 exclusions. Mixed test files importing
uncopied wire, panel or persist modules are excluded whole; `search.test.ts`
also imports the uncopied semantic-search implementation. No assertions are
changed or skipped. The upstream license is in `src/folds/kernel/PROVENANCE.md`.

To refresh the tests, check out the new pinned upstream commit in a temporary
clone, update the pin in `scripts/acp-kernel-tests-source.mjs`, then run
`node scripts/acp-kernel-tests.mjs --sync <checkout>`. Review the provenance and
exclusions before committing. Kernel syncing and test syncing are separate;
the scripts must use the same source commit.

## Synthetic differential parity (REQ-PARITY-002)

```sh
npm run build
node scripts/parity-differential.mjs
# Optional persistent download cache (tarball integrity is checked on every run):
node scripts/parity-differential.mjs --cache /tmp/parity-bcp-cache
```

This online command is not part of `npm test`. On a cache miss it runs
`npm view billion-context-pi@0.1.83 dist.integrity` and
`npm pack billion-context-pi@0.1.83`. It requires the registry integrity to match
the pinned SHA-512 in `scripts/parity-differential-support.mjs`, verifies the
cached tarball bytes, and extracts into a fresh temporary directory. It adds
no package dependency. The CI `parity-differential` job runs it after building.
The `acp-kernel-tests` and `parity-differential` jobs gate package publishing.
The `parity-differential` job runs in branch, merge request, `main` and tag
pipelines, and it is not allowed to fail: a change that breaks parity with bcp
fails both the branch pipeline and the merge request pipeline. It is a gate for
the native-compaction cut-over.

The runner uses Pi's faux provider with the real bcp extension loaded before
our compiled extension. Our shadow recorder does the comparisons; the existing
register and the readiness report's per-call judgment classify them. Records are
keyed by the same fingerprint the recorder writes: the engine hash plus the
session's effective fold settings. It prints every unexplained
record difference, per-case/kind counts, and the call count. Any unexplained
difference, inconclusive record, missing evidence, stale record, or unexercised
scenario makes the command exit nonzero. The synthetic run need not meet the
live cut-over threshold of 500 calls. Individual cases have a 60-second deadline;
the isolated worker has an eight-minute deadline.

`tests/fixtures/parity-corpus/` contains eight hand-written cases: direct and
Fabric-prefixed nested calls, a multi-range call, tier-two absorption, an invalid
range, the first user message, a summary longer than 200 characters, and
call/result pairs at range edges. Each uses a new temporary session. HOME,
agent settings, logs and side files stay under the temporary test root; only the
verified package download stays in the cache. Do not copy real session content
into the corpus. The pure runner tests remain offline in `npm test`.

The job passes on `main`: every remaining difference is explained by an entry in
`src/parity/register.ts`. A new unexplained difference or inconclusive record
fails the pipeline. Register explanations cannot make an inconclusive record pass.
