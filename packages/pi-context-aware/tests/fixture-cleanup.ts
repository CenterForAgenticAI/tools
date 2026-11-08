import fs from "node:fs";
import { pendingMetricsWrites, settleMetricsWrites } from "../src/metrics/recorder.js";

/**
 * Remove a fixture directory after the metrics recorder's queued writes finish.
 * The recorder writes under the agent directory on its own promise chain, so a bare
 * `fs.rmSync` can race it and fail with ENOTEMPTY (pi-context-aware#360).
 */
export async function removeFixtureDir(dir: string): Promise<void> {
	await settleMetricsWrites();
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Remove a directory synchronously, but refuse if a metrics write is pending anywhere in the process. */
export function removeFixtureDirNow(dir: string): void {
	if (pendingMetricsWrites() > 0) throw new Error(`refusing to remove ${dir}: ${pendingMetricsWrites()} metrics write(s) pending`);
	fs.rmSync(dir, { recursive: true, force: true });
}
