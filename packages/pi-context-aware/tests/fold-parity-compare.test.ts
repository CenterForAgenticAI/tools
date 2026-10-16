import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compareCompressCall, compareNextRequest, hashRequestMessages, MAX_BRANCH_ENTRIES, previewShadowCalls } from "../src/parity/compare.js";
import { foldEngineFingerprint } from "../src/parity/fingerprint.js";
import { classifyBcpResult } from "../src/parity/outcome.js";
import { appendParityRecord, PARITY_RECORD_VERSION, paritySessionFile, readParityRecords } from "../src/parity/records.js";
import { MAX_SIDE_FILE_BYTES, parseSideSnapshot, snapshotSideFile } from "../src/parity/side-file.js";

const ACCEPTED = "\u25A3 ACP | 40.0K \u2192 1.0K tokens (~39.0K reclaimed, blocks: b1=m00001\u2013m00004)";
const ABORTED = classifyBcpResult("Operation aborted", true);
const summary = "The early conversation is now settled. Preserve the agreed decisions and implementation details.";
function fixture() {
	const manager = SessionManager.inMemory("/tmp");
	const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage({ role: "user", content: `${i}: ${"message history ".repeat(2500)}`, timestamp: 1 }));
	const byRef = Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id]));
	const side = (blocks: unknown[] = [], extra = {}) => parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef }, ...extra }));
	const block = { blockId: "b1", runId: "r1", compressCallId: "call", tier: 1, active: true, summary, directBlockIds: [], effectiveMessageIds: ids.slice(0, 4) };
	return {
		manager, ids, block, side,
		input: { folds: { firstUserMessage: "fold" as const, firstUserMessageMaxTokens: 8_000 }, sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000, toolCallId: "call", input: { content: [{ startId: "m00001", endId: "m00004", summary }] }, before: side(), after: side([block]), observed: classifyBcpResult(ACCEPTED, false) },
	};
}

test("shadow preview records expected summaries independently from accepted inputs", () => {
	const { input } = fixture();
	const preview = previewShadowCalls(input, [input]);
	assert.equal(preview.activeFoldCount, 1);
	assert.deepEqual(preview.expectedSummaryHashes, ["d495b71d4b65"]);
});

const secondSummary = "Second section settled. Preserve its distinct decisions and next steps for the following request.";

test("shadow expected summaries include imported blocks and accepted inputs in carrier order", () => {
	const { input, side, block } = fixture();
	const before = side([block]);
	const preview = previewShadowCalls(input, [{ ...input, before, input: { content: [{ startId: "m00005", endId: "m00006", summary: secondSummary }, { startId: "m00007", endId: "m00007", summary: "short" }] } }]);
	assert.deepEqual(preview.diffs, []);
	assert.equal(preview.dropped, 1);
	assert.equal(preview.activeFoldCount, 2);
	assert.deepEqual(preview.expectedSummaryHashes, ["d495b71d4b65", "3ab8031e16e0"]);
	assert.equal(preview.firstUserReplacementHash, "d495b71d4b65");
});

test("shadow expected summary order follows carriers rather than acceptance order", () => {
	const { input } = fixture();
	const preview = previewShadowCalls(input, [{ ...input, input: { content: [
		{ startId: "m00005", endId: "m00006", summary: secondSummary },
		{ startId: "m00001", endId: "m00004", summary },
	] } }]);
	assert.deepEqual(preview.diffs, []);
	assert.equal(preview.dropped, 0);
	assert.deepEqual(preview.expectedSummaryHashes, ["d495b71d4b65", "3ab8031e16e0"]);
});

test("shadow expected summaries discard absorbed bodies and bind the opening to the replacement", () => {
	const { input, side, block } = fixture();
	const preview = previewShadowCalls(input, [{ ...input, before: side([block]), input: { content: [{ startId: "b1", endId: "m00006", summary: secondSummary }] } }]);
	assert.deepEqual(preview.diffs, []);
	assert.equal(preview.dropped, 0);
	assert.equal(preview.activeFoldCount, 1);
	assert.deepEqual(preview.expectedSummaryHashes, ["3ab8031e16e0"]);
	assert.equal(preview.firstUserReplacementHash, "3ab8031e16e0");
});

test("shadow preview fails closed when existing active folds have no source-body evidence", () => {
	const { input } = fixture();
	const first = previewShadowCalls(input, [input]);
	assert.ok(first.preview);
	const second = previewShadowCalls({ ...input, branch: first.preview.getBranch() }, [{ ...input, input: { content: [] } }]);
	assert.equal(second.expectedSummaryHashes, undefined);
	assert.equal(second.firstUserReplacementHash, undefined);
	assert.equal(second.firstUserFolded?.role, "user");
});

test("pure comparison includes carrier and hidden ids without mutating the branch or side snapshots", () => {
	const { input, ids } = fixture();
	const before = structuredClone(input);
	const comparison = compareCompressCall(input);
	assert.equal(comparison.verdict, "match");
	assert.deepEqual(comparison.ours?.coverageIds, ids.slice(0, 4).sort());
	assert.deepEqual(input, before);
	assert.deepEqual(comparison.refContinuity, { same: 2, used: 2 });
});

test("keep policy compares editable coverage without bcp's metadata-only pinned opening", () => {
	const { input, ids } = fixture();
	const comparison = compareCompressCall({ ...input, folds: { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 } });
	assert.equal(comparison.verdict, "match");
	assert.deepEqual(comparison.ours?.coverageIds, ids.slice(1, 4).sort());
	assert.deepEqual(comparison.bcp?.coverageIds, ids.slice(1, 4).sort());
});

test("block identity fallback works when nested event ids differ from bcp execute ids", () => {
	const { input, block, side } = fixture();
	const result = compareCompressCall({ ...input, after: side([{ ...block, compressCallId: "fabric-other-id" }]) });
	assert.equal(result.verdict, "match");
	assert.equal(result.bcp?.count, 1);
});

test("outcomes, block count, tiers and absorbed folds remain distinct diagnostic kinds", () => {
	const { input, block, side } = fixture();
	assert.deepEqual(compareCompressCall({ ...input, after: side(), observed: ABORTED }).diffs.map((diff) => diff.kind), ["outcome", "block-count", "coverage", "tier"]);
	assert.deepEqual(compareCompressCall({ ...input, after: side([{ ...block, tier: 2, directBlockIds: ["b9"] }]) }).diffs.map((diff) => diff.kind), ["tier", "absorbed"]);
});

test("unmapped input refs and unknown imports are inconclusive, not successful comparisons", () => {
	const { input } = fixture();
	const ref = compareCompressCall({ ...input, input: { content: [{ startId: "m99999", endId: "m99999", summary }] } });
	assert.equal(ref.verdict, "inconclusive");
	assert.ok(ref.diffs.some((diff) => diff.kind === "ref-unmapped"));
	const missing = compareCompressCall({ ...input, before: snapshotSideFile(undefined) });
	assert.equal(missing.verdict, "inconclusive");
	assert.ok(missing.diffs.some((diff) => diff.kind === "side-file-missing"));
	const unsupported = compareCompressCall({ ...input, before: parseSideSnapshot('{"schemaVersion":2}') });
	assert.equal(unsupported.verdict, "inconclusive");
	assert.ok(unsupported.diffs.some((diff) => diff.kind === "import-unsupported"));
});

test("malformed input produces input-parse evidence without storing raw input", () => {
	const { input, side } = fixture();
	const result = compareCompressCall({ ...input, input: 'SECRET SUMMARY NOT JSON', after: side(), observed: classifyBcpResult("Invalid compress content (not-object): got a string.", true) });
	assert.deepEqual(result.diffs.map((diff) => diff.kind), ["input-parse"]);
	assert.doesNotMatch(JSON.stringify(result), /SECRET SUMMARY/u);
});

test("partial-entry coverage is counted when bcp folds only one core message of an assistant entry", () => {
	const { manager, input, side, block } = fixture();
	const id = manager.appendMessage(fauxAssistantMessage([ { type: "text", text: "reason" }, fauxToolCall("bash", { command: "true" }, { id: "split" }) ]));
	const result = compareCompressCall({ ...input, branch: manager.getBranch(), after: side([{ ...block, effectiveMessageIds: [`${id}#split`] }]) });
	assert.equal(result.bcp?.partialEntries, 1);
	assert.deepEqual(result.bcp?.coverageIds, [id]);
});

test("8 MB side file and 50,000-entry branch bounds produce too-large", () => {
	const { input } = fixture();
	assert.deepEqual(parseSideSnapshot(" ".repeat(MAX_SIDE_FILE_BYTES + 1)), { ok: false, diff: { kind: "too-large", reason: "side file exceeds 8 MB" } });
	const result = compareCompressCall({ ...input, branch: Array.from({ length: MAX_BRANCH_ENTRIES + 1 }, () => input.branch[0]!) });
	assert.equal(result.verdict, "inconclusive");
	assert.deepEqual(result.diffs.map((diff) => diff.kind), ["too-large"]);
});

test("hash comparison strips tags, preserves summary order and non-summary multiplicity, and excludes system state", () => {
	const ours = { ...hashRequestMessages([{ role: "system", content: "ignored" }, { role: "user", content: "hello" }, { role: "user", content: "[Compressed conversation section] — topic\nbody" }]), activeFoldCount: 1, expectedSummaryHashes: ["230d8358dc8e"], expectedSummaryTopicHashes: ["3b07618efe7c"] };
	const bcp = hashRequestMessages([{ role: "user", content: 'hello\n<acp tokens="1K" type="text">m00001</acp>' }, { role: "user", content: "[Compressed conversation section] — topic\nbody" }]);
	assert.equal(compareNextRequest(ours, bcp).verdict, "match");
	assert.deepEqual(compareNextRequest(ours, { ...bcp, messages: [...bcp.messages, bcp.messages[0]!] }).diffs.map((diff) => diff.kind), ["content"]);
	const summaries = { ...hashRequestMessages([{ role: "user", content: "[Compressed conversation section] — one\n1" }, { role: "user", content: "[Compressed conversation section] — two\n2" }]), activeFoldCount: 2, expectedSummaryHashes: ["6b86b273ff34", "d4735e3a265e"], expectedSummaryTopicHashes: ["bb8f30f64c6e", "0b93a8841228"] };
	assert.deepEqual(compareNextRequest(summaries, { ...summaries, tagsSeen: true, messages: [...summaries.messages].reverse() }).diffs.map((diff) => diff.kind), ["summaries"]);
	assert.deepEqual(compareNextRequest(ours, { ...bcp, tagsSeen: false }).diffs.map((diff) => diff.kind), ["tags-absent"]);
	const huge = hashRequestMessages(Array.from({ length: 2001 }, () => ({ role: "user", content: "message" })));
	assert.equal(huge.messages.length, 2000);
	assert.equal(compareNextRequest(huge, { ...huge, tagsSeen: true }).verdict, "inconclusive");
});

test("an imported active block's refs translate by raw id, not by unstable legacy message number", () => {
	const { input, side, block } = fixture();
	const byRef = Object.fromEntries(input.branch.map((entry, i) => [`m${String(i + 101).padStart(5, "0")}`, entry.id]));
	const before = side([block], { messageRefs: { byRef } });
	const preview = previewShadowCalls(input, [{ toolCallId: "later", before, input: { content: [{ startId: "m00105", endId: "m00108", summary }] } }]);
	assert.deepEqual(preview.diffs, []);
	assert.equal(preview.records.length, 1);
	assert.deepEqual(preview.refs, [{ bcp: "m00105", ours: "m00005" }, { bcp: "m00108", ours: "m00008" }]);
});

test("fingerprint uses sorted recursive compiled JS path/content pairs only", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-fingerprint-"));
	try {
		fs.mkdirSync(path.join(dir, "kernel"));
		fs.writeFileSync(path.join(dir, "kernel", "a.js"), "first");
		fs.writeFileSync(path.join(dir, "b.js"), "second");
		const original = foldEngineFingerprint(dir);
		fs.writeFileSync(path.join(dir, "notes.md"), "ignored");
		assert.equal(foldEngineFingerprint(dir), original);
		fs.writeFileSync(path.join(dir, "kernel", "a.js"), "changed");
		assert.notEqual(foldEngineFingerprint(dir), original);
		const changed = foldEngineFingerprint(dir);
		fs.renameSync(path.join(dir, "b.js"), path.join(dir, "c.js"));
		assert.notEqual(foldEngineFingerprint(dir), changed);
		assert.match(foldEngineFingerprint(fileURLToPath(new URL("../src/folds/", import.meta.url))), /^[a-f0-9]{64}$/u);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("records are per-session outside transcripts, reject path traversal and surface corrupt complete lines", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-records-"));
	try {
		assert.deepEqual(await readParityRecords(dir), []);
		assert.throws(() => paritySessionFile(dir, "../../secret"), /Invalid/u);
		assert.throws(() => paritySessionFile(dir, ".."), /Invalid/u);
		const record = { v: PARITY_RECORD_VERSION, kind: "compress" as const, fingerprint: "test", sessionId: "safe-session", at: "2026-01-01", toolCallId: "call", nested: false, verdict: "match" as const, diffs: [] };
		await appendParityRecord(dir, record);
		assert.deepEqual(await readParityRecords(dir), [record]);
		fs.appendFileSync(paritySessionFile(dir, "safe-session"), "garbage\n");
		await assert.rejects(readParityRecords(dir));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("read-only snapshots never rewrite bytes and detect missing, unsupported, and oversized files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-side-"));
	const session = path.join(dir, "session.jsonl");
	const file = `${session}.acp.json`;
	try {
		assert.equal(snapshotSideFile(session).ok, false);
		const text = '{"schemaVersion":1,"blocks":[],"messageRefs":{"byRef":{"m00001":"entry"}},"producer":{"name":"bcp","version":"0.1.83"}}';
		fs.writeFileSync(file, text);
		const read = snapshotSideFile(session);
		assert.ok(read.ok);
		assert.equal(read.byRef.m00001, "entry");
		assert.equal(read.text, text);
		assert.equal(fs.readFileSync(file, "utf8"), text);
		fs.writeFileSync(file, '{"schemaVersion":1,"blocks":[{}],"messageRefs":{"byRef":{}}}');
		assert.deepEqual(snapshotSideFile(session), { ok: false, diff: { kind: "import-unsupported", reason: "invalid JSON or unsupported side-file schema" } });
		fs.truncateSync(file, MAX_SIDE_FILE_BYTES + 1);
		assert.deepEqual(snapshotSideFile(session), { ok: false, diff: { kind: "too-large", reason: "side file exceeds 8 MB" } });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
