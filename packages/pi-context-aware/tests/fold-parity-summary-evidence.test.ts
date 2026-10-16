import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compareCompressCall, compareNextRequest, hashRequestMessages, previewShadowCalls, coverageHash } from "../src/parity/compare.js";
import { classifyBcpResult } from "../src/parity/outcome.js";
import { appendParityRecord, paritySessionFile, readParityRecords, PARITY_RECORD_VERSION, type ParityRecord, type CompressRecord, type RequestHashes } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { buildFoldParityReport } from "../src/parity/report.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";

const body = "The early conversation is now settled. Preserve the agreed decisions and implementation details.";
function acceptedPreview(withTopics = false) {
	const manager = SessionManager.inMemory("/tmp");
	const ids = Array.from({ length: 16 }, (_, index) => manager.appendMessage({ role: "user", content: `${index}: ${"message history ".repeat(2500)}`, timestamp: 1 }));
	const byRef = Object.fromEntries(ids.map((id, index) => [`m${String(index + 1).padStart(5, "0")}`, id]));
	const side = (blocks: unknown[]) => parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef } }));
	const input = { sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000,
		toolCallId: "c", before: side([]), input: { content: withTopics ? [
			{ startId: "m00002", endId: "m00004", topic: "Topic A", summary: body },
			{ startId: "m00005", endId: "m00007", topic: "Topic B", summary: body },
		] : [{ startId: "m00002", endId: "m00004", summary: body }] },
		after: side([
			{ blockId: "b1", runId: "r1", compressCallId: "c", tier: 1, active: true, summary: body, directBlockIds: [], effectiveMessageIds: ids.slice(1, 4) },
			...(withTopics ? [{ blockId: "b2", runId: "r1", compressCallId: "c", tier: 1, active: true, summary: body, directBlockIds: [], effectiveMessageIds: ids.slice(4, 7) }] : []),
		]),
		observed: classifyBcpResult(withTopics ? "▣ ACP | 40.0K → 1.0K tokens (~39.0K reclaimed, blocks: b1=m00002–m00004, b2=m00005–m00007)"
			: "▣ ACP | 40.0K → 1.0K tokens (~39.0K reclaimed, blocks: b1=m00002–m00004)", false) };
	const comparison = compareCompressCall(input);
	assert.equal(comparison.verdict, "match");
	assert.deepEqual(comparison.oursOutcome, { type: "accepted", reasons: [] });
	assert.deepEqual(comparison.bcpOutcome, { type: "accepted", reasons: [] });
	assert.equal(comparison.ours?.coverageCount, withTopics ? 6 : 3);
	assert.equal(comparison.bcp?.coverageCount, withTopics ? 6 : 3);
	const planned = previewShadowCalls(input, [input]);
	assert.deepEqual(planned.diffs, []);
	assert.ok(planned.preview);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), expectedSummaryHashes: planned.expectedSummaryHashes,
		expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes, activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds };
	const messages = ours.messages.filter((message) => !message.summary);
	const bcp = { messages, total: messages.length, tagsSeen: true };
	const call: CompressRecord = { ...comparison, v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "probe", sessionId: input.sessionId,
		toolCallId: "c", at: "2026-01-01", nested: false, awaitingNextRequest: true };
	return { input, ours, bcp, call };
}
function probe(call: CompressRecord, ours: RequestHashes, bcp: RequestHashes, storedMatch = false) {
	const comparison = compareNextRequest(ours, bcp);
	const records = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId], ours, bcp, ...(storedMatch ? { verdict: "match" as const, diffs: [] } : comparison) }];
	}).flat();
	return { comparison, report: buildFoldParityReport(records, PARITY_REGISTER, "probe") };
}

test("R5 coverage hash is the full sorted SHA-256 digest", () => {
	// Independently computed SHA-256 of the UTF-8 JSON bytes ["a","b"].
	assert.equal(coverageHash(["b", "a"]), "0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13");
});

for (const corruption of ["count", "prefix", "tail"] as const) {
	test(`R5 capped coverage ${corruption} contradiction blocks readiness at 500`, () => {
		const { call, ours, bcp } = acceptedPreview();
		const ids = Array.from({ length: 55 }, (_, index) => `entry-${String(index).padStart(3, "0")}`);
		const blocks = { ...call.ours!, coverageCount: 55, coverageIds: ids.slice(0, 50), coverageHash: coverageHash(ids) };
		const changed = { ...blocks,
			...(corruption === "count" ? { coverageCount: 56 } : {}),
			...(corruption === "prefix" ? { coverageIds: ["different", ...ids.slice(1, 50)] } : {}),
			...(corruption === "tail" ? { coverageHash: coverageHash([...ids.slice(0, 54), "different-tail"]) } : {}) };
		const output = probe({ ...call, ours: changed, bcp: blocks }, ours, bcp, true);
		assert.equal(output.report.unexplainedKinds.coverage, 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 uncapped coverage must agree with its full digest", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, ours: { ...call.ours!, coverageHash: "0".repeat(64) },
		bcp: { ...call.bcp!, coverageHash: "0".repeat(64) } }, ours, bcp, true);
	assert.equal(output.report.unexplainedKinds.coverage, 500);
	assert.equal(output.report.ready, false);
});

test("R5 block counts must agree with tier evidence", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, ours: { ...call.ours!, tiers: [] }, bcp: { ...call.bcp!, tiers: [] } }, ours, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

test("R5 failed parse evidence cannot be cleared into a match at 500", () => {
	const { input, call, ours, bcp } = acceptedPreview();
	const comparison = compareCompressCall({ ...input, input: "NOT JSON", after: input.before,
		observed: classifyBcpResult("Invalid compress content (malformed-json)", true) });
	assert.equal(comparison.parseKind, "malformed-json");
	assert.deepEqual(comparison.diffs.map((diff) => diff.kind), ["input-parse"]);
	const output = probe({ ...call, ...comparison, verdict: "match", diffs: [] }, ours, bcp, true);
	assert.equal(output.report.unexplainedKinds["input-parse"], 500);
	assert.equal(output.report.ready, false);
});

test("R5 ok parse with dropped items cannot lose input-parse", () => {
	const { input, call, ours, bcp } = acceptedPreview();
	const comparison = compareCompressCall({ ...input, input: { content: [...input.input.content, null] } });
	assert.equal(comparison.parseKind, "ok");
	assert.equal(comparison.parseInvalidItems, 1);
	const output = probe({ ...call, ...comparison, verdict: "match", diffs: [] }, ours, bcp, true);
	assert.equal(output.report.unexplainedKinds["input-parse"], 500);
	assert.equal(output.report.ready, false);
});

test("R5 unmapped stored refs are reconstructed", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, refs: [{ bcp: "m00002" }], refContinuity: { same: 0, used: 1 } }, ours, bcp, true);
	assert.equal(output.report.unexplainedKinds["ref-unmapped"], 500);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

function importedAbsorptionBatch() {
	const { input, call } = acceptedPreview(true);
	assert.ok(input.after.ok);
	const absorber = { ...input, toolCallId: "absorber", before: input.after, input: { content: [
		{ startId: "b1", endId: "b2", summary: body },
		{ startId: "m00008", endId: "m00010", summary: body },
	] } };
	const after = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, messageRefs: { byRef: input.after.byRef }, blocks: [
		...input.after.blocks,
		{ blockId: "b3", runId: "r3", compressCallId: "absorber", tier: 2, active: true, summary: body, directBlockIds: ["b1", "b2"], effectiveMessageIds: input.branch.slice(1, 7).map((entry) => entry.id) },
		{ blockId: "b4", runId: "r4", compressCallId: "absorber", tier: 1, active: true, summary: body, directBlockIds: [], effectiveMessageIds: input.branch.slice(7, 10).map((entry) => entry.id) },
	] }));
	const comparison = compareCompressCall({ ...absorber, after, observed: classifyBcpResult("▣ ACP | 40.0K → 1.0K tokens (~39.0K reclaimed, blocks: b3=b1–b2, b4=m00008–m00010)", false) });
	assert.equal(comparison.verdict, "match");
	assert.deepEqual(comparison.ours?.createdIds, ["b3", "b4"]);
	assert.deepEqual(comparison.ours?.absorbed, ["b1", "b2"]);
	const planned = previewShadowCalls(input, [absorber]);
	assert.ok(planned.preview);
	assert.equal(planned.activeFoldCount, 2);
	assert.deepEqual(planned.activeFoldIds, ["b3", "b4"]);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), activeFoldCount: planned.activeFoldCount,
		activeFoldIds: planned.activeFoldIds, expectedSummaryHashes: planned.expectedSummaryHashes, expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes };
	const messages = ours.messages.filter((message) => !message.summary);
	return { call: { ...call, ...comparison }, ours, bcp: { messages, total: messages.length, tagsSeen: true } };
}

test("R5 imported absorption cannot hide a surviving created id at 500", () => {
	const { call, ours, bcp } = importedAbsorptionBatch();
	assert.equal(probe(call, ours, bcp, true).report.ready, true, "genuine two-survivor batch");
	let removed = false;
	const messages = ours.messages.filter((message) => {
		if (message.summary && !removed) { removed = true; return false; }
		return true;
	});
	const corrupted = { ...ours, activeFoldCount: 1, activeFoldIds: ["b3"], expectedSummaryHashes: ours.expectedSummaryHashes!.slice(0, 1),
		expectedSummaryTopicHashes: ours.expectedSummaryTopicHashes!.slice(0, 1), messages, total: messages.length };
	const output = probe(call, corrupted, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

test("R5 an absorbed imported id cannot remain active", () => {
	const { call, ours, bcp } = importedAbsorptionBatch();
	const summary = ours.messages.find((message) => message.summary)!;
	const corrupted = { ...ours, activeFoldCount: 3, activeFoldIds: ["b1", "b3", "b4"],
		expectedSummaryHashes: [...ours.expectedSummaryHashes!, summary.hash],
		expectedSummaryTopicHashes: [...ours.expectedSummaryTopicHashes!, summary.topicHash!],
		messages: [...ours.messages, summary], total: ours.total + 1 };
	assert.equal(probe(call, corrupted, bcp, true).report.counts.inconclusive, 500);
	assert.equal(probe(call, corrupted, bcp, true).report.ready, false);
});

for (const fault of ["missing", "length", "duplicate", "capped"] as const) {
	test(`R5 active ids ${fault} evidence is inconclusive`, () => {
		const { call, ours, bcp } = acceptedPreview();
		const summary = ours.messages.find((message) => message.summary)!;
		const corrupted = { ...ours, activeFoldIds: fault === "missing" ? undefined : fault === "length" ? ["b1", "b999"] : fault === "duplicate" ? ["b1", "b1"] : ours.activeFoldIds,
			...(fault === "duplicate" ? { activeFoldCount: 2, expectedSummaryHashes: [summary.hash, summary.hash],
				expectedSummaryTopicHashes: [summary.topicHash!, summary.topicHash!], messages: [...ours.messages, summary], total: ours.total + 1 } : {}),
			...(fault === "capped" ? { activeFoldIdsCapped: true } : {}) };
		const output = probe(call, corrupted, bcp, true);
		assert.equal(output.report.counts.inconclusive, 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 active ids must remain sorted", () => {
	const { call, ours, bcp } = importedAbsorptionBatch();
	const output = probe(call, { ...ours, activeFoldIds: ["b4", "b3"] }, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

for (const fault of ["missing", "length", "duplicate"] as const) {
	test(`R5 created ids ${fault} evidence is inconclusive`, () => {
		const { call, ours, bcp } = importedAbsorptionBatch();
		const createdIds = fault === "missing" ? undefined : fault === "length" ? [] : ["b3", "b3"];
		const output = probe({ ...call, ours: { ...call.ours!, createdIds } }, ours, bcp, true);
		assert.equal(output.report.counts.inconclusive, 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 linked calls cannot reuse a created block id", () => {
	const { call, ours, bcp } = acceptedPreview();
	const records = Array.from({ length: 250 }, (_, index) => {
		const ids = [`first-${index}`, `second-${index}`];
		return [{ ...call, toolCallId: ids[0]! }, { ...call, toolCallId: ids[1]! },
			{ ...call, kind: "next-request" as const, toolCallIds: ids, ours, bcp, verdict: "match" as const, diffs: [] }];
	}).flat();
	const output = buildFoldParityReport(records, PARITY_REGISTER, "probe");
	assert.equal(output.counts.inconclusive, 500);
	assert.equal(output.ready, false);
});

for (const field of ["parseKind", "parseInvalidItems", "refs", "refContinuity"] as const) {
	test(`R5 conclusive calls require ${field} evidence`, () => {
		const { call, ours, bcp } = acceptedPreview();
		const output = probe({ ...call, [field]: undefined }, ours, bcp, true);
		assert.equal(output.report.counts.inconclusive, 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 capped ref evidence is inconclusive", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, refContinuity: { same: 2, used: 2001 } }, ours, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

for (const side of ["created", "absorbed"] as const) {
	test(`R5 ${side} ids capped evidence is inconclusive`, () => {
		const { call, ours, bcp } = acceptedPreview();
		const output = probe({ ...call, ...(side === "created" ? { ours: { ...call.ours!, blockIdsCapped: true } } : { bcp: { ...call.bcp!, blockIdsCapped: true } }) }, ours, bcp, true);
		assert.equal(output.report.counts.inconclusive, 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 import-skipped remains blocking even with a register explanation", () => {
	const { call, ours, bcp } = acceptedPreview();
	const records = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, toolCallId, verdict: "diff" as const, diffs: [{ kind: "import-skipped" as const }] },
			{ ...call, kind: "next-request" as const, toolCallIds: [toolCallId], ours, bcp, verdict: "match" as const, diffs: [] }];
	}).flat();
	const report = buildFoldParityReport(records, [{ id: "FP-999", title: "test", reason: "test", matches: () => true }], "probe");
	assert.equal(report.counts.inconclusive, 500);
	assert.equal(report.ready, false);
});

test("R4 lost summaries with stored match are recomputed at 500", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe(call, { ...ours, messages: bcp.messages, total: bcp.total }, bcp, true);
	assert.deepEqual(output.report.unexplainedKinds, { summaries: 500 });
	assert.equal(output.report.counts.diff, 500);
	assert.equal(output.report.ready, false);
});

test("R4 block-count is recomputed despite empty stored diffs", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, ours: { ...call.ours!, count: 2 } }, ours, bcp, true);
	assert.equal(output.report.unexplainedKinds["block-count"], 500);
	assert.equal(output.report.ready, false);
});

test("R4 conclusive records missing either side or outcome are inconclusive", () => {
	const { call, ours, bcp } = acceptedPreview();
	for (const verdict of ["match", "diff"] as const) {
		for (const field of ["ours", "bcp", "oursOutcome", "bcpOutcome"] as const) {
			const output = probe({ ...call, verdict, [field]: undefined }, ours, bcp, true);
			assert.equal(output.report.counts.inconclusive, 500, `${verdict} compress missing ${field}`);
			assert.equal(output.report.ready, false);
		}
		for (const field of ["ours", "bcp"] as const) {
			const records = Array.from({ length: 500 }, (_, index) => {
				const toolCallId = `c${index}`;
				return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId],
					ours, bcp, verdict, diffs: [], [field]: undefined }];
			}).flat();
			const report = buildFoldParityReport(records, PARITY_REGISTER, "probe");
			assert.equal(report.counts.inconclusive, 500, `${verdict} request missing ${field}`);
			assert.equal(report.ready, false);
		}
	}
});

test("R4 stored inconclusive verdicts cannot be promoted by recomputation", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe({ ...call, verdict: "inconclusive", diffs: [] }, ours, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
	const records = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId], ours, bcp, verdict: "inconclusive" as const, diffs: [] }];
	}).flat();
	const report = buildFoldParityReport(records, PARITY_REGISTER, "probe");
	assert.equal(report.counts.inconclusive, 500);
	assert.equal(report.ready, false);
});

test("R4 every call needs a linked request without trusting awaitingNextRequest", () => {
	const { call } = acceptedPreview();
	const records = Array.from({ length: 500 }, (_, index) => ({ ...call, toolCallId: `c${index}`, awaitingNextRequest: undefined }));
	const report = buildFoldParityReport(records, PARITY_REGISTER, "probe");
	assert.equal(report.counts.inconclusive, 500);
	assert.deepEqual(report.unexplainedKinds, { "next-request-pending": 500 });
	assert.equal(report.ready, false);
});

test("R4 erased count and evidence cannot contradict linked accepted calls at 500", async () => {
	const { call, ours, bcp } = acceptedPreview();
	assert.equal(call.ours?.count, 1);
	assert.equal(call.bcp?.count, 1);
	const erased = { ...ours, activeFoldCount: 0, expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages: bcp.messages, total: bcp.total };
	const output = probe(call, erased, bcp, true);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
	// Persisted records must give the same answer, not just in-memory previews.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-r4-"));
	try {
		for (let index = 0; index < 500; index++) {
			const toolCallId = `c${index}`;
			await appendParityRecord(dir, { ...call, toolCallId });
			await appendParityRecord(dir, { ...call, kind: "next-request", toolCallIds: [toolCallId], ours: erased, bcp, verdict: "match", diffs: [] });
		}
		const read = buildFoldParityReport(await readParityRecords(dir), PARITY_REGISTER, "probe");
		assert.equal(read.counts.inconclusive, 500);
		assert.equal(read.ready, false);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("R4 genuine accepted evidence and FP-001 reach readiness at 500", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe(call, ours, bcp, true);
	assert.equal(output.report.counts.explained, 500);
	assert.deepEqual(output.report.unexplainedKinds, {});
	assert.equal(output.report.ready, true);
});

for (const kind of ["coverage", "tier", "absorbed", "outcome", "error-type", "outcome-unknown"] as const) {
	test(`R4 ${kind} is recomputed from compress evidence`, () => {
		const { call, ours, bcp } = acceptedPreview();
		let changed = call;
		if (kind === "tier") changed = { ...call, bcp: { ...call.bcp!, tiers: [2] } };
		if (kind === "absorbed") changed = { ...call, bcp: { ...call.bcp!, absorbed: ["b9"] } };
		if (kind === "coverage") changed = { ...call, bcp: { ...call.bcp!, coverageIds: ["other-entry", ...call.bcp!.coverageIds.slice(1)] } };
		if (kind === "outcome") changed = { ...call, bcpOutcome: { type: "no-op", reasons: [] } };
		if (kind === "error-type") changed = { ...call, bcpOutcome: { type: "accepted", reasons: ["no-fold"] } };
		if (kind === "outcome-unknown") changed = { ...call, bcpOutcome: { type: "unknown", reasons: [] } };
		const output = probe(changed, ours, bcp, true);
		assert.deepEqual(output.report.unexplainedKinds, { [kind]: 500 });
		assert.equal(output.report.counts[kind === "outcome-unknown" ? "inconclusive" : "diff"], 500);
		assert.equal(output.report.ready, false);
	});
}

test("R5 matching capped coverage preserves stored diagnostics in the union", () => {
	const { call, ours, bcp } = acceptedPreview();
	const ids = Array.from({ length: 51 }, (_, index) => `entry-${index}`);
	const coverage = { coverageCount: 51, coverageIds: ids.sort().slice(0, 50), coverageHash: coverageHash(ids) };
	const changed = { ...call, ours: { ...call.ours!, ...coverage }, bcp: { ...call.bcp!, ...coverage } };
	assert.equal(probe(changed, ours, bcp, true).report.ready, true);
	const stored = probe({ ...changed, verdict: "diff", diffs: [{ kind: "coverage" }] }, ours, bcp, true).report;
	assert.deepEqual(stored.unexplainedKinds, { coverage: 500 });
	assert.equal(stored.ready, false);
});

test("R4 within-call absorption and later zero-created calls preserve a sound bound", () => {
	const { input, call } = acceptedPreview();
	const batchInput = { ...input, input: { content: [
		{ startId: "m00002", endId: "m00004", summary: body },
		{ startId: "m00002", endId: "m00006", summary: body },
	] } };
	const side = (blocks: unknown[]) => parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks,
		messageRefs: { byRef: input.before.ok ? input.before.byRef : {} } }));
	const after = side([
		{ blockId: "b1", runId: "r1", compressCallId: "c", tier: 1, active: false, summary: body, directBlockIds: [], effectiveMessageIds: input.branch.slice(1, 4).map((entry) => entry.id) },
		{ blockId: "b2", runId: "r2", compressCallId: "c", tier: 1, active: true, summary: body, directBlockIds: ["b1"], effectiveMessageIds: input.branch.slice(1, 6).map((entry) => entry.id) },
	]);
	const comparison = compareCompressCall({ ...batchInput, after });
	assert.equal(comparison.verdict, "match");
	assert.equal(comparison.ours?.count, 2);
	assert.deepEqual(comparison.ours?.createdIds, ["b1", "b2"]);
	assert.deepEqual(comparison.ours?.absorbed, ["b1"]);
	const zero = { ...input, toolCallId: "zero", before: after, input: { content: [] } };
	const planned = previewShadowCalls(input, [batchInput, zero]);
	assert.ok(planned.preview);
	assert.equal(planned.activeFoldCount, 1);
	assert.deepEqual(planned.activeFoldIds, ["b2"]);
	assert.deepEqual(planned.outcomes, [{ type: "accepted", reasons: [] }, { type: "no-op", reasons: [] }]);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds,
		expectedSummaryHashes: planned.expectedSummaryHashes, expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes };
	const messages = ours.messages.filter((message) => !message.summary);
	const bcp = { messages, total: messages.length, tagsSeen: true };
	assert.equal(probe({ ...call, ...comparison }, ours, bcp, true).report.ready, true);
	const zeroComparison = compareCompressCall({ ...input, ...zero, branch: planned.preview.getBranch(), after,
		observed: classifyBcpResult("No ranges provided.", false) });
	assert.equal(zeroComparison.ours?.count, 0);
	assert.equal(zeroComparison.bcp?.count, 0);
	const records = Array.from({ length: 250 }, (_, index) => {
		const ids = [`c${index}`, `z${index}`];
		return [{ ...call, ...comparison, toolCallId: ids[0]! }, { ...call, ...zeroComparison, toolCallId: ids[1]! },
			{ ...call, kind: "next-request" as const, toolCallIds: ids, ours: { ...ours, activeFoldCount: 0, expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages, total: messages.length },
				bcp, verdict: "match" as const, diffs: [] }];
	}).flat();
	const report = buildFoldParityReport(records, PARITY_REGISTER, "probe");
	assert.equal(report.counts.inconclusive, 500);
	assert.equal(report.ready, false);
});

test("R4 imported absorption keeps one survivor and batch order is independent of timestamps", () => {
	const { input, call } = acceptedPreview(true);
	assert.ok(input.after.ok);
	const absorption = { ...input, toolCallId: "absorber", before: input.after,
		input: { content: [{ startId: "b1", endId: "b2", summary: body }] } };
	const after = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, messageRefs: { byRef: input.after.byRef }, blocks: [
		...input.after.blocks,
		{ blockId: "b3", runId: "r3", compressCallId: "absorber", tier: 2, active: true, summary: body, directBlockIds: ["b1", "b2"], effectiveMessageIds: input.branch.slice(1, 7).map((entry) => entry.id) },
	] }));
	const comparison = compareCompressCall({ ...absorption, after });
	assert.equal(comparison.verdict, "match");
	assert.equal(comparison.ours?.count, 1);
	assert.deepEqual(comparison.ours?.absorbed, ["b1", "b2"]);
	const planned = previewShadowCalls(input, [input, absorption]);
	assert.ok(planned.preview);
	assert.equal(planned.activeFoldCount, 1);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds,
		expectedSummaryHashes: planned.expectedSummaryHashes, expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes };
	const messages = ours.messages.filter((message) => !message.summary);
	const bcp = { messages, total: messages.length, tagsSeen: true };
	const records = Array.from({ length: 250 }, (_, index) => {
		const ids = [`c${index}`, `a${index}`];
		return [{ ...call, toolCallId: ids[0]!, at: "2026-01-02" }, { ...call, ...comparison, toolCallId: ids[1]!, at: "2026-01-01" },
			{ ...call, kind: "next-request" as const, toolCallIds: ids, ours, bcp, verdict: "match" as const, diffs: [] }];
	}).flat();
	assert.equal(buildFoldParityReport(records, PARITY_REGISTER, "probe").ready, true);
	// With both prior blocks imported, only the producing call is linked. It still leaves one survivor.
	assert.equal(probe({ ...call, ...comparison }, ours, bcp, true).report.ready, true);
	const erased = probe({ ...call, ...comparison }, { ...ours, activeFoldCount: 0, expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages, total: messages.length }, bcp, true).report;
	assert.equal(erased.counts.inconclusive, 500);
	assert.equal(erased.ready, false);
});

test("accepted three-entry compress with all summaries and evidence removed blocks 500-call readiness", () => {
	const { call, ours, bcp } = acceptedPreview();
	const { expectedSummaryHashes: _bodies, expectedSummaryTopicHashes: _topics, ...missing } = ours;
	const lost = { ...missing, messages: bcp.messages, total: bcp.total };
	const output = probe(call, lost, bcp);
	assert.equal(output.comparison.verdict, "inconclusive");
	assert.ok(output.comparison.diffs.some((diff) => diff.kind === "recorder-error"));
	assert.equal(output.report.count, 500);
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

for (const direction of ["empty", "excess"] as const) {
	test(`${direction} expected evidence disagrees with active folds and blocks 500-call readiness`, () => {
		const { call, ours, bcp } = acceptedPreview();
		assert.equal(call.ours?.count, 1);
		assert.equal(ours.activeFoldCount, 1);
		const bodies = direction === "empty" ? [] : ["d495b71d4b65", "d495b71d4b65"];
		const topics = direction === "empty" ? [] : ["67915b1640e0", "67915b1640e0"];
		const contradictory = { ...ours, expectedSummaryHashes: bodies, expectedSummaryTopicHashes: topics,
			messages: bcp.messages, total: bcp.total };
		const output = probe(call, contradictory, bcp);
		assert.equal(output.comparison.verdict, "inconclusive");
		assert.equal(output.report.counts.inconclusive, 500);
		assert.equal(output.report.ready, false);
		// A stored match without diagnostic diffs must be revalidated by the report.
		const records = Array.from({ length: 500 }, (_, index) => {
			const toolCallId = `c${index}`;
			return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId],
				ours: contradictory, bcp, verdict: "match" as const, diffs: [] }];
		}).flat();
		const report = buildFoldParityReport(records, PARITY_REGISTER, "probe");
		assert.equal(report.counts.inconclusive, 500);
		assert.equal(report.ready, false);
	});
}

test("a genuine no-fold preview remains a valid match at 500 calls", () => {
	const { input, call } = acceptedPreview();
	const rejected = { content: [{ startId: "m00002", endId: "m00004", summary: "short" }] };
	const planned = previewShadowCalls(input, [{ ...input, input: rejected }]);
	assert.ok(planned.preview);
	assert.equal(planned.activeFoldCount, 0);
	assert.deepEqual(planned.expectedSummaryHashes, []);
	assert.deepEqual(planned.expectedSummaryTopicHashes, []);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds,
		expectedSummaryHashes: planned.expectedSummaryHashes, expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes };
	const comparison = compareCompressCall({ ...input, input: rejected, after: input.before,
		observed: classifyBcpResult("▣ ACP | 40.0K → 40.0K tokens (~0.0K reclaimed, 0 blocks)\nErrors: Summary too short", false) });
	assert.deepEqual(comparison.oursOutcome, { type: "rejected", reasons: ["summary-short"] });
	assert.deepEqual(comparison.bcpOutcome, { type: "rejected", reasons: ["summary-short"] });
	assert.equal(comparison.verdict, "match");
	assert.equal(comparison.ours?.count, 0);
	assert.equal(comparison.bcp?.count, 0);
	const output = probe({ ...call, ...comparison }, ours, { ...ours, tagsSeen: true });
	assert.equal(output.comparison.verdict, "match");
	assert.equal(output.report.counts.match, 500);
	assert.equal(output.report.ready, true);
});

test("active folds without source evidence cannot match an empty summary render", () => {
	const { input, call, bcp } = acceptedPreview();
	const first = previewShadowCalls(input, [input]);
	assert.ok(first.preview);
	const planned = previewShadowCalls({ ...input, branch: first.preview.getBranch() }, [{ ...input, input: { content: [] } }]);
	assert.ok(planned.preview);
	assert.equal(planned.expectedSummaryHashes, undefined);
	assert.equal(planned.expectedSummaryTopicHashes, undefined);
	const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), expectedSummaryHashes: planned.expectedSummaryHashes,
		expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes, activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds, messages: bcp.messages, total: bcp.total };
	const output = probe(call, ours, bcp);
	assert.equal(output.comparison.verdict, "inconclusive");
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

test("missing topic evidence is inconclusive even with body evidence and no rendered summaries", () => {
	const { call, ours, bcp } = acceptedPreview();
	const output = probe(call, { ...ours, expectedSummaryTopicHashes: undefined, messages: bcp.messages, total: bcp.total }, bcp);
	assert.equal(output.comparison.verdict, "inconclusive");
	assert.ok(output.comparison.diffs.some((diff) => diff.kind === "summaries"), "known expected bodies still diagnose loss without topic evidence");
	assert.equal(output.report.counts.inconclusive, 500);
	assert.equal(output.report.ready, false);
});

for (const mutation of ["corrupted topic", "swapped equal-body summaries"] as const) {
	test(`FP-001 ${mutation} stays unexplained and blocks 500-call readiness`, () => {
		const { call, ours, bcp } = acceptedPreview(true);
		assert.equal(call.ours?.count, 2);
		assert.equal(call.bcp?.count, 2);
		assert.equal(probe(call, ours, bcp).report.ready, true, "uncorrupted control reaches readiness");
		const indices = ours.messages.flatMap((message, index) => message.summary ? [index] : []);
		assert.equal(indices.length, 2);
		assert.equal(ours.messages[indices[0]!]!.hash, ours.messages[indices[1]!]!.hash);
		assert.notEqual(ours.messages[indices[0]!]!.topicHash, ours.messages[indices[1]!]!.topicHash);
		const messages = [...ours.messages];
		if (mutation === "corrupted topic") messages[indices[0]!] = { ...messages[indices[0]!]!, topicHash: "bad-topic" };
		else [messages[indices[0]!], messages[indices[1]!]] = [messages[indices[1]!]!, messages[indices[0]!]!];
		const output = probe(call, { ...ours, messages }, bcp);
		assert.deepEqual(output.report.unexplainedKinds, { summaries: 500 });
		assert.equal(output.report.counts.diff, 500);
		assert.equal(output.report.ready, false);
	});
}

test("source topic evidence binds imported blocks and accepted inputs in carrier order", () => {
	const { input } = acceptedPreview();
	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: "b1", runId: "r1", compressCallId: "prior", tier: 1, active: true,
		topic: "Topic A", summary: body, directBlockIds: [], effectiveMessageIds: input.branch.slice(1, 4).map((entry) => entry.id) }],
		messageRefs: input.before.ok ? { byRef: input.before.byRef } : {} }));
	const planned = previewShadowCalls(input, [{ ...input, before, input: { content: [{ startId: "m00005", endId: "m00007", topic: "Topic B", summary: body }] } }]);
	assert.deepEqual(planned.diffs, []);
	assert.deepEqual(planned.expectedSummaryHashes, ["d495b71d4b65", "d495b71d4b65"]);
	assert.deepEqual(planned.expectedSummaryTopicHashes, ["c36339a3ad29", "89b9f0fb0e1b"]);
});

test("v2 matches with the same fingerprint cannot establish readiness and are skipped on disk", async () => {
	const { call } = acceptedPreview();
	const legacy = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, v: 2, toolCallId }, { ...call, v: 2, kind: "next-request", toolCallIds: [toolCallId] }];
	}).flat() as unknown as ParityRecord[];
	const output = buildFoldParityReport(legacy, PARITY_REGISTER, "probe");
	assert.equal(output.count, 0);
	assert.equal(output.ready, false);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-v2-"));
	try {
		await appendParityRecord(dir, call);
		fs.appendFileSync(paritySessionFile(dir, call.sessionId), legacy.map((record) => `${JSON.stringify(record)}\n`).join(""));
		assert.deepEqual(await readParityRecords(dir), [call]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("v3 and v4 records cannot establish v5 readiness and the reader skips them", async () => {
	const { call } = acceptedPreview();
	const legacy = Array.from({ length: 500 }, (_, index) => ({ ...call, v: index % 2 ? 4 : 3, toolCallId: `c${index}` })) as unknown as ParityRecord[];
	const report = buildFoldParityReport(legacy, PARITY_REGISTER, "probe");
	assert.equal(report.count, 0);
	assert.equal(report.ready, false);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-v3-"));
	try {
		await appendParityRecord(dir, call);
		fs.appendFileSync(paritySessionFile(dir, call.sessionId), `${JSON.stringify(legacy[0])}\n${JSON.stringify(legacy[1])}\n`);
		const read = await readParityRecords(dir);
		assert.deepEqual(read.map((record) => [record.v, (record as CompressRecord).toolCallId]), [[PARITY_RECORD_VERSION, call.toolCallId]]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the parity reader rejects records from a newer or unknown schema version", async () => {
	const { call } = acceptedPreview();
	for (const v of [PARITY_RECORD_VERSION + 1, 0, 2.5, "4"]) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-vx-"));
		try {
			await appendParityRecord(dir, call);
			fs.appendFileSync(paritySessionFile(dir, call.sessionId), `${JSON.stringify({ ...call, v, toolCallId: "later" })}\n`);
			await assert.rejects(readParityRecords(dir), /Invalid parity record/u, `version ${String(v)} must be rejected`);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	}
});

test("accepted three-entry compress with evidence but no rendered summary blocks 500-call readiness", () => {
	const { call, ours, bcp } = acceptedPreview();
	assert.deepEqual(ours.expectedSummaryHashes, ["d495b71d4b65"]);
	const output = probe(call, { ...ours, messages: bcp.messages, total: bcp.total }, bcp);
	assert.deepEqual(output.comparison.diffs, [{ kind: "summaries" }]);
	assert.deepEqual(output.report.unexplainedKinds, { summaries: 500 });
	assert.equal(output.report.counts.diff, 500);
	assert.equal(output.report.ready, false);
});
