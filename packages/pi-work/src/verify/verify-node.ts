import { decodeVerificationCacheUpdate } from "./results.js";
import type { ObservedVerificationCacheUpdate, ObservedVerificationResult, VerificationResult } from "./results.js";
import {
	createObservationalVerifier,
	verificationFailures,
	type ObservationalVerifier,
	type ObservationalVerifierAdapters,
	type VerificationTarget,
	type VerifyNodeOptions,
	type VerifyNodeRequest,
} from "./internal.js";

export type { ObservationalVerifier, ObservationalVerifierAdapters, VerificationTarget, VerifyNodeOptions, VerifyNodeRequest };
export { createObservationalVerifier, verificationFailures };

/** The legacy free function is observational and cannot mint authority. */
export async function verifyNode(options: VerifyNodeRequest): Promise<ObservedVerificationResult> {
	return createObservationalVerifier().verifyNode(options);
}

/** The legacy free function returns an observed cache update only. */
export async function verifyNodeAndCache(options: VerifyNodeRequest): Promise<{ result: ObservedVerificationResult; cacheUpdate?: ObservedVerificationCacheUpdate }> {
	return createObservationalVerifier().verifyNodeAndCache(options);
}

/** Build a reporting-only cache observation; callers cannot mint cache authority. */
export function makeCacheUpdate(specPath: string, result: VerificationResult): ObservedVerificationCacheUpdate {
	const observed = decodeVerificationCacheUpdate({
		kind: "verification-cache-update",
		specPath,
		nodeId: result.nodeId,
		recordedAt: result.recordedAt,
		tree: result.tree,
		record: result,
	});
	if (!observed) throw new TypeError("invalid verification cache observation");
	return observed;
}
