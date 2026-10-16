import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { resolveFoldConfig } from "../src/folds/fold-engine.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";
import { compareNextRequest, hashRequestMessages, previewShadowCalls, type RequestMessage } from "../src/parity/compare.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";
import { PARITY_RECORD_VERSION, type CompressRecord, type RequestHashes } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { aggregateParityDifferences, buildFoldParityReport } from "../src/parity/report.js";

// These request/register fixtures use a matched validation rejection; summaries are prior active folds.
const call: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "test", sessionId: "s", toolCallId: "c", at: "2026-01-01", nested: false, verdict: "match", diffs: [], awaitingNextRequest: true,
	parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
	ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", createdIds: [], partialEntries: 0, tiers: [], absorbed: [] },
	bcp: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", partialEntries: 0, tiers: [], absorbed: [] },
	oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] } };
function report(ours: RequestHashes, bcp: RequestHashes) {
	return buildFoldParityReport([call, { ...call, kind: "next-request", toolCallIds: ["c"], ours, bcp: { ...bcp, tagsSeen: true }, ...compareNextRequest(ours, { ...bcp, tagsSeen: true }) }], PARITY_REGISTER, "test");
}
const summary = (text = "settled") => ({ role: "user", content: `[Compressed conversation section]\n${text}` });
const tool = (name: string, args: unknown): RequestMessage => ({ role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }] });
const result: RequestMessage = { role: "toolResult", toolCallId: "c", toolName: "compress", content: "ok" };
// Argument-only fixtures have no planned folds.
const unfolded = (messages: readonly RequestMessage[]) => ({ ...hashRequestMessages(messages), activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] });
const expectedSettled = { activeFoldCount: 1, activeFoldIds: ["b1"], expectedSummaryHashes: ["d31e014808ec"], expectedSummaryTopicHashes: ["67915b1640e0"] };

test("historical diagnostics explain only evidence-backed differences without counting legacy records toward readiness", () => {
	const ours = { ...hashRequestMessages([summary()]), ...expectedSettled };
	const bcp = { ...hashRequestMessages([]), tagsSeen: true };
	const records = [call, { ...call, kind: "next-request" as const, toolCallIds: ["c"], ours, bcp, ...compareNextRequest(ours, bcp) }].map((record) => ({ ...record, v: 1 })) as unknown as Parameters<typeof buildFoldParityReport>[0];
	assert.deepEqual(aggregateParityDifferences(records, []).unexplainedKinds, { summaries: 1 });
	assert.deepEqual(aggregateParityDifferences(records, PARITY_REGISTER).explainedKinds, { summaries: 1 });
	assert.deepEqual(aggregateParityDifferences(records, PARITY_REGISTER).unexplainedKinds, {});
	assert.equal(buildFoldParityReport(records, PARITY_REGISTER, "test").count, 0);
});

test("FP-001 explains native summary placement when bcp has no summary", () => {
	const output = report({ ...hashRequestMessages([summary()]), ...expectedSettled }, hashRequestMessages([]));
	assert.equal(output.counts.explained, 1);
	assert.match(output.text, /FP-001: 1/u);
});
test("FP-001 does not explain wrong summary text when bcp has no summary", () => {
	const ours = { ...hashRequestMessages([summary("corrupted")]), ...expectedSettled };
	assert.deepEqual(report(ours, hashRequestMessages([])).unexplainedKinds, { summaries: 1 });
});

for (const [name, messages] of [
	["one missing summary among several", [summary()]],
	["an extra summary", [summary(), summary("other"), summary("extra")]],
	["reordered summaries", [summary("other"), summary()]],
] as const) {
	test(`FP-001 does not explain ${name}`, () => {
		const ours = { ...hashRequestMessages(messages), activeFoldCount: 2, activeFoldIds: ["b1", "b2"], expectedSummaryHashes: ["d31e014808ec", "d9298a10d1b0"], expectedSummaryTopicHashes: ["67915b1640e0", "67915b1640e0"] };
		assert.deepEqual(report(ours, hashRequestMessages([])).unexplainedKinds, { summaries: 1 });
	});
}

test("FP-001 fails closed without expected-summary evidence", () => {
	const output = report(hashRequestMessages([summary()]), hashRequestMessages([]));
	assert.equal(output.counts.inconclusive, 1);
	assert.deepEqual(output.unexplainedKinds, { "recorder-error": 1, summaries: 1 });
});

test("FP-001 corrupted-summary probe cannot make 500 calls ready", () => {
	const planned = foldedOpening("keep");
	const ours = { ...planned.ours, messages: planned.ours.messages.map((message) => message.summary ? { ...message, hash: "corrupted" } : message) };
	const bcp = planned.bcp;
	const records = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId], ours, bcp, ...compareNextRequest(ours, bcp) }];
	}).flat();
	const output = buildFoldParityReport(records, PARITY_REGISTER, "test");
	assert.equal(output.count, 500);
	assert.equal(output.counts.diff, 500);
	assert.deepEqual(output.unexplainedKinds, { summaries: 500 });
	assert.equal(output.ready, false);
});

test("FP-001 total-summary-loss probe cannot make 500 calls ready", () => {
	const planned = foldedOpening("keep");
	const messages = planned.ours.messages.filter((message) => !message.summary);
	const ours = { ...planned.ours, messages, total: messages.length };
	const bcp = planned.bcp;
	const records = Array.from({ length: 500 }, (_, index) => {
		const toolCallId = `c${index}`;
		return [{ ...call, toolCallId }, { ...call, kind: "next-request" as const, toolCallIds: [toolCallId], ours, bcp, ...compareNextRequest(ours, bcp) }];
	}).flat();
	const output = buildFoldParityReport(records, PARITY_REGISTER, "test");
	assert.equal(output.count, 500);
	assert.equal(output.counts.diff, 500);
	assert.deepEqual(output.unexplainedKinds, { summaries: 500 });
	assert.equal(output.ready, false);
});

test("FP-001 does not explain different summary text when both sides have summaries", () => {
	const output = report({ ...hashRequestMessages([summary()]), ...expectedSettled }, hashRequestMessages([summary("wrong")]));
	assert.equal(output.counts.diff, 1);
	assert.deepEqual(output.unexplainedKinds, { summaries: 1 });
});
test("FP-002 explains only the exact compress summary shortening and stores no arguments", () => {
	const ours = unfolded([tool("compress", { content: [{ startId: "m00001", endId: "m00002", summary: "x".repeat(250) }] }), result]);
	const bcp = hashRequestMessages([tool("compress", { content: [{ startId: "m00001", endId: "m00002", summary: `${"x".repeat(199)}…` }] }), result]);
	assert.equal(report(ours, bcp).counts.explained, 1);
	assert.match(report(ours, bcp).text, /FP-002: 1/u);
	assert.doesNotMatch(JSON.stringify(ours), /xxxxx|startId|m00001/u);
});
test("FP-002 handles JSON-string content and surrogate-safe prefixes exactly", () => {
	const long = `${"x".repeat(198)}😀${"z".repeat(60)}`;
	const ours = unfolded([tool("compress", { content: JSON.stringify([{ summary: long }]) }), result]);
	const bcp = hashRequestMessages([tool("compress", { content: JSON.stringify([{ summary: `${"x".repeat(198)}…` }]) }), result]);
	assert.equal(report(ours, bcp).counts.explained, 1);
});

test("FP-002 leaves malformed, short and unrelated compress arguments without shortening evidence", () => {
	for (const args of [undefined, null, [], { content: "bad JSON" }, { content: {} }, { content: [null, "x", { summary: "x".repeat(200) }] }]) {
		assert.equal(hashRequestMessages([tool("compress", args)]).messages[0]?.toolCalls?.[0]?.compactedArgsHash, undefined);
	}
});

test("FP-002 does not explain argument changes on another tool or a changed compress boundary", () => {
	const args = { content: [{ startId: "m00001", endId: "m00002", summary: "x".repeat(250) }] };
	const shortened = { content: [{ startId: "m00001", endId: "m00002", summary: `${"x".repeat(199)}…` }] };
	for (const [ours, bcp] of [
		[tool("read", args), tool("read", shortened)],
		[tool("compress", args), tool("compress", { content: [{ ...shortened.content[0], startId: "m00003" }] })],
	]) {
		assert.equal(report(unfolded([ours!]), hashRequestMessages([bcp!])).counts.diff, 1);
	}
});
function foldedOpening(mode: "keep" | "fold" = "fold") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-opening-"));
	try {
		const manager = SessionManager.inMemory(root);
		const opening: RequestMessage = { role: "user", content: "OPENING ".repeat(1_000) };
		manager.appendMessage({ ...opening, role: "user", content: opening.content as string, timestamp: 1 });
		for (let index = 1; index < 12; index++) {
			const text = `${index}: ${"history ".repeat(1_000)}`;
			manager.appendMessage(index % 2 ? fauxAssistantMessage(text) : { role: "user", content: text, timestamp: 1 });
		}
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": mode }));
		const branch = manager.getBranch();
		const byRef = Object.fromEntries(branch.filter((entry) => entry.type === "message").map((entry, index) => [`m${String(index + 1).padStart(5, "0")}`, entry.id]));
		const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef } }));
		const planned = previewShadowCalls({ cwd: root, header: manager.getHeader(), branch, sessionId: manager.getSessionId(), contextWindow: 1_000_000,
			folds: resolveFoldConfig({ cwd: root, sessionManager: manager }, path.join(root, "agent")) },
		[{ toolCallId: "c", before, input: { content: [{ startId: "m00001", endId: "m00004", summary: "Opening exchange settled. Preserve the agreed decisions for the next request." }] } }]);
		assert.deepEqual(planned.diffs, []);
		assert.equal(planned.records.length, 1);
		assert.ok(planned.preview);
		const ours = { ...hashRequestMessages(planned.preview.buildSessionContext().messages), expectedSummaryHashes: planned.expectedSummaryHashes,
			activeFoldCount: planned.activeFoldCount, activeFoldIds: planned.activeFoldIds, expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes, firstUserFolded: planned.firstUserFolded, firstUserReplacementHash: planned.firstUserReplacementHash };
		const tail = ours.messages.filter((message) => !message.summary);
		const bcp = { messages: mode === "fold" ? [...hashRequestMessages([opening]).messages, ...tail] : tail, total: tail.length + (mode === "fold" ? 1 : 0), tagsSeen: true };
		return { ours, bcp };
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("FP-003 explains only an opening user actually folded under the effective setting", () => {
	const { ours, bcp } = foldedOpening();
	assert.deepEqual(ours.expectedSummaryHashes, ["8a53c3f03202"]);
	assert.equal(ours.firstUserReplacementHash, "8a53c3f03202");
	assert.equal(ours.messages[0]?.role, "user");
	assert.equal(ours.messages[0]?.hash, "8a53c3f03202");
	const output = report(ours, bcp);
	assert.equal(output.counts.explained, 1);
	assert.match(output.text, /FP-003: 1/u);
	assert.equal(foldedOpening("keep").ours.firstUserFolded, undefined);
});

for (const mutation of ["missing", "assistant role", "non-user role", "after first assistant", "wrong body"] as const) {
	test(`FP-003 does not explain replacement summary ${mutation}`, () => {
		const { ours, bcp } = foldedOpening();
		const [replacement, ...tail] = ours.messages;
		assert.ok(replacement?.summary);
		const messages = mutation === "missing" ? tail
			: mutation === "assistant role" ? [{ ...replacement, role: "assistant" }, ...tail]
			: mutation === "non-user role" ? [{ ...replacement, role: "developer" }, ...tail]
			: mutation === "wrong body" ? [{ ...replacement, hash: "badbody" }, ...tail]
			: [tail[0]!, tail[1]!, replacement, ...tail.slice(2)];
		assert.equal(report({ ...ours, messages, total: messages.length }, bcp).unexplainedKinds.content, 1);
	});
}

test("FP-003 requires a summary, not coincidental non-summary body content", () => {
	const { ours, bcp } = foldedOpening();
	const nonSummary = { ...ours.messages[0]!, summary: false };
	const messages = [nonSummary, ...ours.messages.slice(1)];
	const theirs = [bcp.messages[0]!, nonSummary, ...bcp.messages.slice(1)];
	assert.equal(report({ ...ours, messages }, { ...bcp, messages: theirs, total: theirs.length }).unexplainedKinds.content, 1);
});

test("FP-003 fails closed without expected replacement evidence", () => {
	const { ours, bcp } = foldedOpening();
	const { firstUserReplacementHash: _replacement, ...legacy } = ours;
	assert.equal(report(legacy, bcp).unexplainedKinds.content, 1);
});

test("FP-003 does not explain a missing user without folded-setting evidence or an additional content mismatch", () => {
	const { ours, bcp } = foldedOpening();
	const { firstUserFolded: _opening, ...legacy } = ours;
	assert.equal(report(legacy, bcp).unexplainedKinds.content, 1);
	assert.equal(report(ours, { ...bcp, messages: [...bcp.messages, { role: "assistant", hash: "unexpected", summary: false }], total: bcp.total + 1 }).unexplainedKinds.content, 1);
});
