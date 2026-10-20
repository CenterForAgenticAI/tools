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


/** Call differences a turn-preparation case must not show (pi-context-aware#186, pi-context-aware#184). */
const ENGINE_DIFFS = new Set(["outcome", "error-type", "block-count", "coverage", "tier", "absorbed", "ref-unmapped"]);

/**
 * Check one turn-preparation case: real bcp must take the stated path (outcome and coverage per
 * step, so the case exercises its mechanism), and the native plan must agree with it on every call.
 * Returns the reasons the case fails; empty when it passes.
 */
export function mechanismFailures(records, item) {
	const calls = records.filter((r) => r.kind === "compress");
	const failures = [];
	item.expect.forEach((expected, step) => {
		const call = calls[step];
		if (!call) { failures.push(`step ${step}: no record`); return; }
		if (call.bcpOutcome?.type !== expected.outcome) failures.push(`step ${step}: bcp outcome ${call.bcpOutcome?.type}, expected ${expected.outcome}`);
		if (expected.reasons && JSON.stringify(call.bcpOutcome?.reasons) !== JSON.stringify(expected.reasons)) failures.push(`step ${step}: bcp reasons ${JSON.stringify(call.bcpOutcome?.reasons)}`);
		if (expected.coverage !== undefined && call.bcp?.coverageCount !== expected.coverage) failures.push(`step ${step}: bcp covers ${call.bcp?.coverageCount} entries, expected ${expected.coverage}; ours ${call.ours?.coverageCount}`);
		for (const diff of call.diffs ?? []) if (ENGINE_DIFFS.has(diff.kind)) failures.push(`step ${step}: ${diff.kind}${diff.reason ? ` (${diff.reason})` : ""}${diff.oursOnlyCount || diff.bcpOnlyCount ? ` ours-only ${diff.oursOnlyCount ?? 0}, bcp-only ${diff.bcpOnlyCount ?? 0}` : ""}`);
	});
	return failures;
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
	const all = judgeCalls(current, register, fingerprint);
	// As in buildFoldParityReport, a call in a session without a session file can never be compared: it neither counts nor fails.
	const judgments = all.filter((judgment) => !judgment.notComparable);
	if (!judgments.length) failures.push({ kind: "calls-missing" });
	// A request that links no call in this case was never judged.
	const judged = new Set(all.flatMap((judgment) => judgment.requests));
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
