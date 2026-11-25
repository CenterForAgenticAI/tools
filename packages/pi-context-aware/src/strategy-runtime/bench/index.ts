/**
 * The strategy bench (pi-context-aware#469): offline replay of recorded sessions, tier 1 (cost, not quality).
 * Internal: no package entry point re-exports it. Run it with `npm run bench:strategy`; see docs/strategy-bench.md.
 */
export * from "./conformance.js";
export * from "./corpus.js";
export * from "./external-protocol.js";
export * from "./external-strategy.js";
export * from "./pricing.js";
export * from "./recipes.js";
export * from "./recipes/mask-then-fold.js";
export * from "./recipes/tool-output.js";
export * from "./recipes/trim-then-fold.js";
export * from "./recording.js";
export * from "./replay.js";
export * from "./report.js";
export { runBench, runCli, type BenchRun, type CliResult } from "./cli.js";
