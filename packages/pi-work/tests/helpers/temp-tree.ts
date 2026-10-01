import { rm } from "node:fs/promises";

/** Retry fixture teardown when concurrent test work briefly races recursive removal. */
export function removeTempTree(target: string): Promise<void> {
	return rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
