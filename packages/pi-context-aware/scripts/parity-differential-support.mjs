import { createHash } from "node:crypto";
import assert from "node:assert/strict";

/** Independent scenario checks prevent a no-op run from masquerading as corpus coverage. */
export function verifyCorpusEvidence(records, item) {
	const calls = records.filter((r) => r.kind === "compress");
	assert.equal(calls.length, item.steps.length, "each corpus step must be recorded");
	assert.deepEqual(calls.flatMap((c) => c.bcp?.tiers ?? []), item.expectedBcpTiers, "corpus must exercise its stated bcp fold tiers");
	if (item.nested) {
		assert.equal(calls[0].nested, true, "nested flag must be recorded");
		assert.equal(calls[0].parentToolCallId, "fabric_synthetic_parent", "Fabric parent must be recorded");
		assert.match(calls[0].toolCallId, /^fabric_synthetic_parent\//u, "child id must belong to Fabric parent");
	}
	if (item.id === "tier-two") assert.deepEqual(calls[1].bcp.absorbed, ["b1", "b2"], "tier two must absorb earlier folds");
	if (item.id === "invalid-range") assert.deepEqual(calls[0].bcpOutcome, { type: "rejected", reasons: ["unknown-ref"] }, "invalid refs must be rejected by real bcp");
}


// Pinned from npm view billion-context-pi@0.1.83 dist.integrity.
export const BCP_INTEGRITY = "sha512-122CcPmZvC5Yqqbj75UMppOFlkdAN8kbzvJ4OugV6xBPW6wbiHbaZ9YDYWQwDy4hJ/Vc98eOREGkWLWKflbnZw==";
export const differentialExitCode = (failed) => failed ? 1 : 0;

export function verifyTarball(bytes) {
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actual !== BCP_INTEGRITY) throw new Error("bcp tarball integrity mismatch");
}

/**
 * Enumerate all failures, without the readiness report's 20-row or 500-call display bounds.
 * `version` is the record version the built recorder writes, so older records count as stale.
 * `judgeCalls` is `judgeParityCalls` from src/parity/report.ts, the judgment the readiness report
 * counts: it recomputes diffs from both sides' evidence, so a stored match cannot hide a difference.
 */
export function inspectParityCase(records, register, fingerprint, version, judgeCalls) {
	if (!Number.isInteger(version)) throw new Error("inspectParityCase needs the current parity record version");
	if (typeof judgeCalls !== "function") throw new Error("inspectParityCase needs the shared parity call judgment");
	const failures = [];
	const current = records.filter((r) => r.v === version && r.fingerprint === fingerprint);
	if (current.length !== records.length) failures.push({ kind: "record-stale" });
	const judgments = judgeCalls(current, register, fingerprint);
	if (!judgments.length) failures.push({ kind: "calls-missing" });
	// A request that links no call in this case was never judged.
	const judged = new Set(judgments.flatMap((judgment) => judgment.requests));
	for (const record of current) {
		if (record.kind === "next-request" && !judged.has(record)) failures.push({ kind: "request-unlinked", toolCallIds: record.toolCallIds });
	}
	for (const { call, evidence, unexplained, missingRequest, inconclusive } of judgments) {
		if (missingRequest) failures.push({ kind: "next-request-pending", toolCallId: call.toolCallId });
		else if (inconclusive) failures.push({ kind: "inconclusive", toolCallId: call.toolCallId, reasons: [...new Set(evidence.map(({ diff }) => diff.kind))] });
		for (const { diff, source } of unexplained) failures.push({ ...diff, record: source, toolCallId: call.toolCallId });
	}
	return { count: judgments.length, failures };
}
