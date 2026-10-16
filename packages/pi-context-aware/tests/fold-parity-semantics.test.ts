import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compareNextRequest, hashRequestMessages, type RequestMessage } from "../src/parity/compare.js";
import { classifyBcpResult, compareOutcomes } from "../src/parity/outcome.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { appendParityRecord, PARITY_RECORD_VERSION, paritySessionFile, readParityRecords, type CompressRecord, type NextRequestRecord, type ParityRecord } from "../src/parity/records.js";
import { buildFoldParityReport } from "../src/parity/report.js";

// ---- Tool-call and tool-result semantics in the next provider request ----

const request = () => [
	{ role: "user", content: 'run it\n<acp tokens="1K" type="text">m00001</acp>' },
	{ role: "assistant", content: [{ type: "text", text: "running" }, { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "SECRET-ARGUMENT", timeout: 5 } }] },
	{ role: "toolResult", toolCallId: "call-a", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
];
type Message = ReturnType<typeof request>[number] & Record<string, unknown>;
// These tool fixtures plan no folds; certify that explicitly rather than omit evidence.
const unfolded = (messages: readonly RequestMessage[]) => ({ ...hashRequestMessages(messages), activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] });
const kinds = (ours: Message[], bcp: Message[]) => compareNextRequest(unfolded(ours), hashRequestMessages(bcp)).diffs.map((diff) => diff.kind);
function edit(change: (messages: Message[]) => void): Message[] {
	const messages = structuredClone(request()) as Message[];
	change(messages);
	return messages;
}
/** 500 calls whose next request carries `diffs`, as the cut-over report sees them. */
function readiness(diffs: NextRequestRecord["diffs"]) {
	const blocks = { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", createdIds: [], partialEntries: 0, tiers: [], absorbed: [] };
	const outcome = { type: "rejected" as const, reasons: ["summary-short" as const] };
	const calls: CompressRecord[] = Array.from({ length: 500 }, (_, i) => ({ parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 }, ours: blocks, bcp: blocks, oursOutcome: outcome, bcpOutcome: outcome, v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "probe", sessionId: "s", toolCallId: `call-${i}`, nested: false, at: new Date(i).toISOString(), awaitingNextRequest: true, verdict: "match", diffs: [] }));
	const requests: NextRequestRecord[] = calls.map((call) => ({ v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "probe", sessionId: "s", toolCallIds: [call.toolCallId], at: call.at, ours: unfolded([]), bcp: { messages: [], total: 0, tagsSeen: true }, verdict: diffs.length ? "diff" : "match", diffs }));
	return buildFoldParityReport([...calls, ...requests], [], "probe").ready;
}

test("identical tool calls and results match, and argument text is hashed, not stored", () => {
	const ours = unfolded(request());
	assert.deepEqual(compareNextRequest(ours, hashRequestMessages(request())).diffs, []);
	assert.deepEqual(ours.messages[1]?.toolCalls, [{ id: "call-a", name: "bash", argsHash: ours.messages[1]!.toolCalls![0]!.argsHash }]);
	assert.deepEqual(ours.messages[2]?.toolResult, { toolCallId: "call-a", toolName: "bash", isError: false });
	assert.doesNotMatch(JSON.stringify(ours), /SECRET-ARGUMENT/u);
	// Argument key order is not a semantic difference.
	assert.deepEqual(kinds(request(), edit((m) => { (m[1]!.content as Record<string, unknown>[])[1]!.arguments = { timeout: 5, command: "SECRET-ARGUMENT" }; })), []);
});

test("a tool-call-only difference is a diff that blocks readiness", () => {
	const renamed = edit((m) => { (m[1]!.content as Record<string, unknown>[])[1]!.name = "write"; });
	const reargued = edit((m) => { (m[1]!.content as Record<string, unknown>[])[1]!.arguments = { command: "rm -rf /" }; });
	assert.deepEqual(kinds(request(), renamed), ["tool-calls"]);
	assert.deepEqual(kinds(request(), reargued), ["tool-calls"]);
	assert.equal(compareNextRequest(unfolded(request()), hashRequestMessages(reargued)).verdict, "diff");
	assert.equal(readiness([{ kind: "tool-calls" }]), false);
	assert.equal(readiness([]), true);
});

test("a mispaired tool-result id is a result and pairing diff", () => {
	const mispaired = edit((m) => { m[2]!.toolCallId = "unpaired"; });
	assert.deepEqual(kinds(request(), mispaired), ["tool-results", "tool-pairing"]);
	assert.equal(readiness([{ kind: "tool-results" }, { kind: "tool-pairing" }]), false);
});

test("a flipped tool-result error flag is a result diff", () => {
	const flipped = edit((m) => { m[2]!.isError = true; });
	assert.deepEqual(kinds(request(), flipped), ["tool-results"]);
	assert.equal(readiness([{ kind: "tool-results" }]), false);
});

test("the review probe's combined tool changes no longer match", () => {
	const altered = edit((m) => {
		const call = (m[1]!.content as Record<string, unknown>[])[1]!;
		call.name = "write";
		call.arguments = { path: "wrong", content: "wrong" };
		m[2]!.toolCallId = "unpaired";
		m[2]!.isError = true;
	});
	const comparison = compareNextRequest(unfolded(request()), hashRequestMessages(altered));
	assert.equal(comparison.verdict, "diff");
	assert.deepEqual(comparison.diffs.map((diff) => diff.kind), ["tool-calls", "tool-results", "tool-pairing"]);
});

/** Two valid read calls answered in order; the bodies and error states are each call's own. */
const twoReads = (bodies: readonly [string, string] = ["a=1", "b=2"], errors: readonly [boolean, boolean] = [false, false]) => [
	{ role: "user", content: 'read both\n<acp tokens="1K" type="text">m00001</acp>' },
	{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } }] },
	{ role: "toolResult", toolCallId: "call-a", toolName: "read", isError: errors[0], content: [{ type: "text", text: bodies[0] }] },
	{ role: "toolResult", toolCallId: "call-b", toolName: "read", isError: errors[1], content: [{ type: "text", text: bodies[1] }] },
];
/** Readiness from the comparison's own output, not canned diff kinds. */
function readinessOf(ours: readonly RequestMessage[], bcp: readonly RequestMessage[], expectedSummaryHashes: readonly string[] = [], expectedSummaryTopicHashes: readonly string[] = []) {
	const comparison = compareNextRequest({ ...hashRequestMessages(ours), activeFoldCount: expectedSummaryHashes.length, expectedSummaryHashes, expectedSummaryTopicHashes }, hashRequestMessages(bcp));
	return { comparison, ready: readiness(comparison.diffs) };
}

test("result bodies swapped between two valid calls are a result diff and keep readiness false", () => {
	const { comparison, ready } = readinessOf(twoReads(), twoReads(["b=2", "a=1"]));
	assert.equal(comparison.verdict, "diff");
	assert.deepEqual(comparison.diffs.map((diff) => diff.kind), ["tool-results"]);
	assert.equal(ready, false);
});

test("error text swapped between two failed calls is a result diff and keeps readiness false", () => {
	const errors = [true, true] as const;
	const { comparison, ready } = readinessOf(twoReads(["ENOENT: a", "EACCES: b"], errors), twoReads(["EACCES: b", "ENOENT: a"], errors));
	assert.deepEqual(comparison.diffs.map((diff) => diff.kind), ["tool-results"]);
	assert.equal(ready, false);
});

test("summary-style results swapped between two valid calls are a result diff and keep readiness false", () => {
	// Same shared tail, different topic lines: only the topic hash tells the two answers apart.
	const bodies = ["[Compressed conversation section] — Topic A\nshared body", "[Compressed conversation section] — Topic B\nshared body"] as const;
	const swapped = twoReads(bodies);
	// Each complete answer goes to the other call; the result order keeps the summary sequence unchanged.
	[swapped[2]!.toolCallId, swapped[3]!.toolCallId] = [swapped[3]!.toolCallId, swapped[2]!.toolCallId];
	const hashes = hashRequestMessages(twoReads(bodies));
	assert.notEqual(hashes.messages[2]?.topicHash, hashes.messages[3]?.topicHash);
	assert.equal(hashes.messages[2]?.hash, hashes.messages[3]?.hash);
	assert.doesNotMatch(JSON.stringify(hashes), /Topic [AB]|shared body/u);
	const { comparison, ready } = readinessOf(twoReads(bodies), swapped, ["dd9305d302f1", "dd9305d302f1"], ["c36339a3ad29", "89b9f0fb0e1b"]);
	assert.equal(comparison.verdict, "diff");
	assert.deepEqual(comparison.diffs.map((diff) => diff.kind), ["tool-results"]);
	assert.equal(ready, false);
	// Reordering the same summary-style results without moving them between calls is only a summary-order change.
	const reordered = twoReads(bodies);
	[reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
	assert.deepEqual(readinessOf(twoReads(bodies), reordered, ["dd9305d302f1", "dd9305d302f1"], ["c36339a3ad29", "89b9f0fb0e1b"]).comparison.diffs.map((diff) => diff.kind), ["summaries"]);
});

test("result order alone is not a difference while each body stays with its call", () => {
	const reordered = twoReads();
	[reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
	const { comparison, ready } = readinessOf(twoReads(), reordered);
	assert.deepEqual(comparison.diffs, []);
	assert.equal(ready, true);
});

test("duplicate tool-call ids make the result binding ambiguous, so the comparison is inconclusive", () => {
	const duplicated = twoReads();
	((duplicated[1]!.content as Record<string, unknown>[])[1]!).id = "call-a";
	duplicated[3]!.toolCallId = "call-a";
	const comparison = compareNextRequest(unfolded(duplicated), hashRequestMessages(duplicated));
	assert.equal(comparison.verdict, "inconclusive");
	assert.deepEqual(comparison.diffs.map((diff) => [diff.kind, diff.reason]), [["tool-evidence", "two tool calls share an id"]]);
});

test("result bodies are bound by hash, never stored", () => {
	const hashes = hashRequestMessages(twoReads(["SECRET-RESULT-A", "SECRET-RESULT-B"]));
	assert.doesNotMatch(JSON.stringify(hashes), /SECRET-RESULT/u);
	assert.notEqual(hashes.messages[2]?.hash, hashes.messages[3]?.hash);
});

test("tool evidence that cannot be represented is inconclusive, not a match", () => {
	const missingId = edit((m) => { delete (m[1]!.content as Record<string, unknown>[])[1]!.id; });
	const comparison = compareNextRequest(unfolded(missingId), hashRequestMessages(missingId));
	assert.equal(comparison.verdict, "inconclusive");
	assert.ok(comparison.diffs.some((diff) => diff.kind === "tool-evidence"));
	const resultWithoutId = edit((m) => { delete m[2]!.toolCallId; });
	assert.equal(compareNextRequest(unfolded(resultWithoutId), hashRequestMessages(resultWithoutId)).verdict, "inconclusive");
});

// ---- Typed outcome and error categories for each compress call ----

const SHORT = { content: [{ startId: "m00001", endId: "m00004", summary: "short" }] };
const VALID = { content: [{ startId: "m00001", endId: "m00004", summary: "The opening work is settled; keep the agreed decisions, file paths and values for the next phase." }] };
const PANEL_REJECTED = "▣ ACP | 48.0K → 48.0K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00001..m00004: Summary too short (5 chars, min 50). The summary must capture the compressed range's key information.";
const RESULTS = {
	validation: { text: PANEL_REJECTED, isError: false },
	invalidInput: { text: "Invalid compress content (not-object): got a string. content must be an ARRAY of {startId, endId, summary} objects.", isError: true },
	aborted: { text: "Operation aborted", isError: true },
	deadRange: { text: "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)\n[ACP] REJECTED — this exact compress call has now failed 2× (ranges m00001..m00004). Those refs are stale.", isError: false },
	capped: { text: "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)\n[ACP] PAUSED — 3 compress attempts already failed this turn; further compress calls are rejected until the next user message.", isError: false },
	tier3: { text: "Range b1..b2 only re-condenses terminal tier-3 block(s) — T3 is the highest tier, so rewriting it reclaims nothing and can repeat forever (dog/billion-context-pi#3). Nothing was compressed.", isError: true },
	unknown: { text: "Some host failure nobody has classified", isError: true },
};

async function recordCalls(calls: readonly { id: string; input: unknown; text: string; isError: boolean }[]): Promise<CompressRecord[]> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-outcome-")));
	try {
		const manager = SessionManager.create(dir, path.join(dir, "sessions"));
		const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage({ role: "user", content: `${i} ${"history ".repeat(4000)}`, timestamp: 1 }));
		fs.writeFileSync(`${manager.getSessionFile()}.acp.json`, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id])) } }));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir: path.join(dir, "agent"), fingerprint: "probe" });
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 1_000_000 } } as unknown as ExtensionContext;
		for (const call of calls) {
			assert.equal(handlers.get("tool_call")!({ toolName: "compress", toolCallId: call.id, input: call.input }, ctx), undefined);
			assert.equal(handlers.get("tool_result")!({ toolName: "compress", toolCallId: call.id, content: [{ type: "text", text: call.text }], isError: call.isError }, ctx), undefined);
		}
		await recorder.flush();
		const records = await readParityRecords(path.join(dir, "agent"));
		for (const call of calls) assert.ok(!JSON.stringify(records).includes(call.text.split("\n").at(-1)!.slice(0, 40)), "raw result text must not be persisted");
		return records.filter((record): record is CompressRecord => record.kind === "compress");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const byId = (records: readonly CompressRecord[], id: string) => records.find((record) => record.toolCallId === id)!;

test("a validation rejection is recorded with typed native and observed categories and matches", async () => {
	const [record] = await recordCalls([{ id: "validation", input: SHORT, ...RESULTS.validation }]);
	assert.deepEqual(record?.oursOutcome, { type: "rejected", reasons: ["summary-short"] });
	assert.deepEqual(record?.bcpOutcome, { type: "rejected", reasons: ["summary-short"] });
	assert.equal(record?.verdict, "match", JSON.stringify(record));
});

test("validation and abort rejections are distinguished: abort is an outcome diff", async () => {
	const records = await recordCalls([{ id: "validation", input: SHORT, ...RESULTS.validation }, { id: "aborted", input: SHORT, ...RESULTS.aborted }]);
	const aborted = byId(records, "aborted");
	assert.deepEqual(aborted.bcpOutcome, { type: "aborted", reasons: [] });
	assert.equal(aborted.verdict, "diff");
	assert.deepEqual(aborted.diffs.map((diff) => [diff.kind, diff.reason]), [["outcome", "ours=rejected; bcp=aborted"]]);
	assert.notDeepEqual(aborted.bcpOutcome, byId(records, "validation").bcpOutcome);
});

test("an invalid-input exception is classified on both sides", async () => {
	const [record] = await recordCalls([{ id: "invalid", input: "NOT JSON", ...RESULTS.invalidInput }]);
	assert.equal(record?.bcpOutcome?.type, "invalid-input");
	assert.equal(record?.oursOutcome?.type, "invalid-input");
	assert.deepEqual(record?.diffs.map((diff) => diff.kind), ["input-parse"]);
});

test("dead-range and capped-retry rejections are typed and differ from the native engine", async () => {
	const records = await recordCalls([{ id: "dead", input: VALID, ...RESULTS.deadRange }, { id: "capped", input: VALID, ...RESULTS.capped }]);
	assert.equal(byId(records, "dead").bcpOutcome?.type, "dead-range");
	assert.equal(byId(records, "capped").bcpOutcome?.type, "capped-retry");
	for (const record of records) {
		assert.equal(record.verdict, "diff", JSON.stringify(record));
		assert.ok(record.diffs.some((diff) => diff.kind === "outcome"));
	}
});

test("a tier-3 rewrite rejection is typed and differs from the native engine", async () => {
	const [record] = await recordCalls([{ id: "tier3", input: VALID, ...RESULTS.tier3 }]);
	assert.equal(record?.bcpOutcome?.type, "tier3-rewrite");
	assert.equal(record?.verdict, "diff");
	assert.ok(record?.diffs.some((diff) => diff.kind === "outcome" && /bcp=tier3-rewrite/u.test(diff.reason ?? "")));
});

test("an unclassified result is inconclusive, never assumed equal", async () => {
	const [record] = await recordCalls([{ id: "unknown", input: SHORT, ...RESULTS.unknown }]);
	assert.equal(record?.bcpOutcome?.type, "unknown");
	assert.equal(record?.verdict, "inconclusive");
	assert.ok(record?.diffs.some((diff) => diff.kind === "outcome-unknown"));
});

test("different rejection reasons with the same outcome are an error-type diff", async () => {
	const unknownRef = "▣ ACP | 48.0K → 48.0K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00001..m00004: startId=\"m00001\" does not exist in this session (typo or wrong session) — run acp_status for current refs.";
	const [record] = await recordCalls([{ id: "reason", input: SHORT, text: unknownRef, isError: false }]);
	assert.deepEqual(record?.bcpOutcome, { type: "rejected", reasons: ["unknown-ref"] });
	assert.equal(record?.verdict, "diff");
	assert.deepEqual(record?.diffs.map((diff) => [diff.kind, diff.reason]), [["error-type", "ours=summary-short; bcp=unknown-ref"]]);
});

// ---- Joined error panels: every error group keeps its own classification ----

const REJECTED_HEAD = "▣ ACP | 48.0K → 48.0K tokens (~0 reclaimed, 0 blocks)";
const SHORT_ERROR = "range m00001..m00004: Summary too short (5 chars, min 50)";
const UNKNOWN_REF_ERROR = "range m00005..m00006: startId=\"m00005\" does not exist in this session";
const UNCLASSIFIED_ERROR = "range m00007..m00008: NEW UNCLASSIFIED ERROR";
const panelReasons = (text: string) => {
	const observed = classifyBcpResult(text, false);
	assert.equal(observed.kind, "panel");
	return observed.kind === "panel" ? observed.reasons : [];
};

test("a recognized error does not mask an unclassified one joined on the same line", () => {
	const text = `${REJECTED_HEAD}\nErrors: ${SHORT_ERROR}; ${UNCLASSIFIED_ERROR}`;
	assert.deepEqual(panelReasons(text), ["other", "summary-short"]);
	const observed = classifyBcpResult(text, false);
	const diffs = compareOutcomes({ type: "rejected", reasons: ["summary-short"] }, observed.kind === "panel" ? { type: "rejected", reasons: observed.reasons } : { type: "unknown", reasons: [] });
	assert.deepEqual(diffs.map((diff) => diff.kind), ["outcome-unknown"]);
});

test("an unclassified error on a later line of the panel is kept", () => {
	assert.deepEqual(panelReasons(`${REJECTED_HEAD}\nErrors: ${SHORT_ERROR}\n${UNCLASSIFIED_ERROR}`), ["other", "summary-short"]);
	assert.deepEqual(panelReasons(`${REJECTED_HEAD}\nErrors: ${SHORT_ERROR}\nan unexpected continuation`), ["other", "summary-short"]);
	assert.deepEqual(panelReasons(`${REJECTED_HEAD}\nErrors: `), ["other"], "an empty error section is still unclassified");
});

test("known errors joined in one panel keep each reason and add no unknown", () => {
	assert.deepEqual(panelReasons(`${REJECTED_HEAD}\nErrors: ${SHORT_ERROR}; ${UNKNOWN_REF_ERROR}`), ["summary-short", "unknown-ref"]);
	// A semicolon inside one error's message does not start a new group.
	assert.deepEqual(panelReasons(`${REJECTED_HEAD}\nErrors: range m00001..m00004: Summary too short (5 chars; min 50)`), ["summary-short"]);
});

test("the compressible-ranges list after a partial panel is not read as errors", () => {
	const text = `▣ ACP | 48.0K → 40.0K tokens (~8.0K reclaimed, blocks: b1=m00001..m00004)\nErrors: ${UNKNOWN_REF_ERROR}\nCurrent compressible ranges (use these refs exactly as listed):\nm00009..m00012 (3 messages)`;
	assert.deepEqual(panelReasons(text), ["unknown-ref"]);
});

test("a mixed panel recorded from a live call is inconclusive and stores no error text", async () => {
	const [record] = await recordCalls([{ id: "mixed", input: SHORT, text: `${REJECTED_HEAD}\nErrors: ${SHORT_ERROR}; ${UNCLASSIFIED_ERROR}`, isError: false }]);
	assert.deepEqual(record?.bcpOutcome, { type: "rejected", reasons: ["other", "summary-short"] });
	assert.equal(record?.verdict, "inconclusive");
	assert.ok(record?.diffs.some((diff) => diff.kind === "outcome-unknown"));
	assert.doesNotMatch(JSON.stringify(record), /UNCLASSIFIED|Summary too short/u);
});

test("records carry the current schema version and older records do not count", async () => {
	const records = await recordCalls([{ id: "validation", input: SHORT, ...RESULTS.validation }]);
	assert.equal(records[0]?.v, PARITY_RECORD_VERSION);
	assert.ok(PARITY_RECORD_VERSION > 1);
	const legacy = { ...records[0]!, v: 1 } as unknown as ParityRecord;
	assert.equal(buildFoldParityReport([legacy], [], "probe").count, 0);
});

test("a mixed-schema JSONL file is read without its legacy records, and a legacy request cannot clear a pending call", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-legacy-")));
	try {
		const agentDir = path.join(dir, "agent");
		const common = { fingerprint: "probe", sessionId: "mixed", nested: false, verdict: "match" as const, diffs: [] };
		const pending: CompressRecord = { ...common, v: PARITY_RECORD_VERSION, kind: "compress", toolCallId: "call-1", at: "2026-01-01T00:00:01Z", awaitingNextRequest: true,
			parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
			ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", createdIds: [], partialEntries: 0, tiers: [], absorbed: [] },
			bcp: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", partialEntries: 0, tiers: [], absorbed: [] },
			oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] } };
		const answered: CompressRecord = { ...pending, toolCallId: "call-2", at: "2026-01-01T00:00:02Z" };
		const answer: NextRequestRecord = { ...common, v: PARITY_RECORD_VERSION, kind: "next-request", toolCallIds: ["call-2"], ours: unfolded([]), bcp: { messages: [], total: 0, tagsSeen: true }, at: "2026-01-01T00:00:03Z" };
		await appendParityRecord(agentDir, pending);
		// Version 1 lines interleaved on disk: a legacy call and a request naming the current pending call.
		const legacyCall = { ...common, v: 1, kind: "compress", toolCallId: "legacy", at: "2026-01-01T00:00:00Z" };
		const legacyRequest = { ...common, v: 1, kind: "next-request", toolCallIds: ["call-1"], at: "2026-01-01T00:00:04Z" };
		fs.appendFileSync(paritySessionFile(agentDir, "mixed"), `${JSON.stringify(legacyCall)}\n${JSON.stringify(legacyRequest)}\n`);
		await appendParityRecord(agentDir, answered);
		await appendParityRecord(agentDir, answer);
		const records = await readParityRecords(agentDir);
		assert.deepEqual(records, [pending, answered, answer], "legacy records are skipped, current ones kept in order");
		const report = buildFoldParityReport(records, [], "probe");
		assert.equal(report.count, 2);
		assert.deepEqual(report.counts, { match: 1, explained: 0, diff: 0, inconclusive: 1 });
		assert.match(report.text, /call-1 nested=false next-request-pending/u);
		// The report filter holds on its own too: the legacy request still cannot answer call-1.
		const direct = buildFoldParityReport([...records, legacyRequest as unknown as ParityRecord], [], "probe");
		assert.deepEqual(direct.counts, report.counts);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the shipped register explains a recorded dead-range or abort refusal only through its own entry", async () => {
	const records = await recordCalls([{ id: "dead", input: VALID, ...RESULTS.deadRange }, { id: "aborted", input: VALID, ...RESULTS.aborted }]);
	const { PARITY_REGISTER } = await import("../src/parity/register.js");
	for (const [id, entry] of [["dead", "FP-005"], ["aborted", "FP-007"]] as const) {
		const record = byId(records, id);
		assert.ok(record.diffs.some((diff) => diff.kind === "block-count"), JSON.stringify(record));
		for (const diff of record.diffs) assert.deepEqual(PARITY_REGISTER.filter((candidate) => candidate.matches(diff, record)).map((candidate) => candidate.id), [entry], JSON.stringify(diff));
	}
});
