import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compareNextRequest, hashRequestMessages, previewShadowCalls } from "../src/parity/compare.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { PARITY_RECORD_VERSION, readParityRecords, verdictFor, type CompressRecord, type NextRequestRecord, type ParityDiff, type ParityRecord, type RequestHashes } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { buildFoldParityReport } from "../src/parity/report.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";

// ---- pi-context-aware#185 item 1: bare entry ids from billion-context-pi's side file ----

const summary = "The early conversation is now settled. Preserve the agreed decisions and implementation details.";
const ref = (n: number) => `m${String(n).padStart(5, "0")}`;

/**
 * Four large user messages, an assistant entry with one tool call and no text, its result, an
 * assistant entry with text and one tool call, its result, then four more user messages.
 * billion-context-pi projects each single-call entry as one message keyed by the bare entry id, so
 * its side file maps m00001..m00012 to the twelve entry ids. The native projection is the same
 * since pi-context-aware#186, so every bare id names one native message and the refs agree.
 */
function splitEntryFixture() {
	const manager = SessionManager.inMemory("/tmp");
	const user = (i: number) => manager.appendMessage({ role: "user", content: `${i}: ${"message history ".repeat(2500)}`, timestamp: 1 });
	const result = (toolCallId: string) => manager.appendMessage({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 });
	const ids = [user(0), user(1), user(2), user(3)];
	ids.push(manager.appendMessage(fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: "solo" })])), result("solo"));
	ids.push(manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "reason" }, fauxToolCall("bash", { command: "pwd" }, { id: "pair" })])), result("pair"));
	ids.push(user(4), user(5), user(6), user(7));
	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [ref(i + 1), id])) } }));
	const input = { folds: { firstUserMessage: "fold" as const, firstUserMessageMaxTokens: 8_000 }, sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000 };
	const preview = (startId: string, endId: string) => previewShadowCalls(input, [{ toolCallId: "call", input: { content: [{ startId, endId, summary }] }, before }]);
	return { preview };
}
const unmapped = (diffs: readonly ParityDiff[]) => diffs.filter((diff) => diff.kind === "ref-unmapped");

test("a start ref to a text-less single-call entry resolves to that entry's first native message", () => {
	const { preview } = splitEntryFixture();
	const planned = preview(ref(5), ref(9));
	assert.deepEqual(unmapped(planned.diffs), []);
	assert.deepEqual(planned.refs, [{ bcp: "m00005", ours: "m00005" }, { bcp: "m00009", ours: "m00009" }]);
});

test("an end ref to a text-less single-call entry resolves to that entry's last native message", () => {
	const { preview } = splitEntryFixture();
	const planned = preview(ref(1), ref(5));
	assert.deepEqual(unmapped(planned.diffs), []);
	assert.deepEqual(planned.refs, [{ bcp: "m00001", ours: "m00001" }, { bcp: "m00005", ours: "m00005" }]);
});

test("a bare id of an entry with text and one call names the whole entry: start takes the text, end the call", () => {
	const { preview } = splitEntryFixture();
	assert.deepEqual(preview(ref(7), ref(9)).refs, [{ bcp: "m00007", ours: "m00007" }, { bcp: "m00009", ours: "m00009" }]);
	assert.deepEqual(preview(ref(1), ref(7)).refs, [{ bcp: "m00001", ours: "m00001" }, { bcp: "m00007", ours: "m00007" }]);
});

test("a ref the side file does not map stays unmapped", () => {
	const { preview } = splitEntryFixture();
	const planned = preview(ref(1), "m99999");
	assert.deepEqual(unmapped(planned.diffs).map((diff) => diff.reason), ["unmapped ref m99999"]);
});

// ---- item 2: next-request content of custom and bashExecution messages ----

/** Native request evidence for a request with no folds. */
const noFolds = (hashes: RequestHashes): RequestHashes => ({ ...hashes, activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] });
const tag = (n: number) => `<acp tokens="12" type="text">${ref(n)}</acp>`;

test("a custom_message is the same content whether it is sent with role custom or role user", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendCustomMessageEntry("note", "note from an extension", true);
	const messages = manager.buildSessionContext().messages;
	assert.deepEqual(messages.map((message) => message.role), ["user", "custom"]);
	const ours = noFolds(hashRequestMessages(messages));
	// billion-context-pi rebuilds a custom_message as a user message with the same text.
	const bcp = hashRequestMessages([{ role: "user", content: `hello\n${tag(1)}` }, { role: "user", content: [{ type: "text", text: `note from an extension\n\n${tag(2)}` }] }]);
	assert.deepEqual(compareNextRequest(ours, bcp).diffs, []);
	// The role is normalised for the comparison only; different text is still a content difference.
	const other = hashRequestMessages([{ role: "user", content: `hello\n${tag(1)}` }, { role: "user", content: [{ type: "text", text: `another note\n\n${tag(2)}` }] }]);
	assert.deepEqual(compareNextRequest(ours, other).diffs.map((diff) => diff.kind), ["content"]);
});

test("a bashExecution message hashes as the command and output billion-context-pi sends, not as empty text", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	manager.appendMessage({ role: "bashExecution", command: "ls -1", output: "a.txt\nb.txt", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 });
	const ours = noFolds(hashRequestMessages(manager.buildSessionContext().messages));
	// SHA-256 prefixes of "$ ls -1\na.txt\nb.txt" and of the empty string.
	assert.equal(ours.messages[1]?.hash, "39ea50a10b90");
	assert.notEqual(ours.messages[1]?.hash, "e3b0c44298fc");
	// billion-context-pi keeps the bashExecution message and writes its text, with a ref tag, into the content.
	const sent = { role: "bashExecution", command: "ls -1", output: "a.txt\nb.txt", exitCode: 0, content: [{ type: "text", text: `$ ls -1\na.txt\nb.txt\n\n${tag(2)}` }] };
	const bcp = hashRequestMessages([{ role: "user", content: `hello\n${tag(1)}` }, sent]);
	assert.deepEqual(compareNextRequest(ours, bcp).diffs, []);
	const otherOutput = { ...sent, content: [{ type: "text", text: `$ ls -1\nc.txt\n\n${tag(2)}` }] };
	assert.deepEqual(compareNextRequest(ours, hashRequestMessages([{ role: "user", content: `hello\n${tag(1)}` }, otherOutput])).diffs.map((diff) => diff.kind), ["content"]);
	// billion-context-pi 0.1.83 keeps the bashExecution role (`collectOriginals`, then `patchRefTag` or
	// `rebuildBodyFromCore`), and Pi turns that message into user text that starts "Ran `ls -1`".
	// A user message holding the same text reaches the provider as different text, so it stays a content difference.
	const asUser = { role: "user", content: [{ type: "text", text: `$ ls -1\na.txt\nb.txt\n\n${tag(2)}` }] };
	assert.deepEqual(compareNextRequest(ours, hashRequestMessages([{ role: "user", content: `hello\n${tag(1)}` }, asUser])).diffs.map((diff) => diff.kind), ["content"]);
});

// ---- item 3: sessions without a session file are not comparable ----

const EMPTY_COVERAGE = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const NO_FILE: ParityDiff = { kind: "side-file-missing", reason: "session has no file" };
const call = (n: number, sessionId = "session", diffs: ParityDiff[] = []): CompressRecord => ({
	v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "current", sessionId, toolCallId: `call-${n}`, nested: false,
	at: new Date(n).toISOString(), verdict: verdictFor(diffs), diffs,
	parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
	ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: EMPTY_COVERAGE, createdIds: [], partialEntries: 0, tiers: [], absorbed: [] },
	bcp: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: EMPTY_COVERAGE, partialEntries: 0, tiers: [], absorbed: [] },
	oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] },
});
const request = (call: CompressRecord, diffs: ParityDiff[] = []): NextRequestRecord => ({
	v: call.v, kind: "next-request", fingerprint: call.fingerprint, sessionId: call.sessionId, toolCallIds: [call.toolCallId],
	at: call.at, verdict: verdictFor(diffs), diffs,
	ours: { activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages: [], total: 0, tagsSeen: true },
	bcp: { messages: [], total: 0, tagsSeen: true },
});
const matching = (count: number): ParityRecord[] => Array.from({ length: count }, (_, i) => call(i)).flatMap((record) => [record, request(record)]);
/** The records the recorder writes for one call in a session without a file. */
const noFileCall = (n: number): ParityRecord[] => {
	const record = { ...call(n, "in-memory", [NO_FILE, NO_FILE]), ours: undefined, bcp: undefined, oursOutcome: undefined, parseKind: undefined, parseInvalidItems: undefined, refs: undefined, refContinuity: undefined } as CompressRecord;
	return [record, { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "current", sessionId: "in-memory", toolCallIds: [record.toolCallId], at: record.at, verdict: "inconclusive", diffs: [NO_FILE], bcp: { messages: [], total: 0, tagsSeen: true } }];
};

test("a call in a session without a session file is left out of the 500-call window", () => {
	const report = buildFoldParityReport([...matching(500), ...noFileCall(1_000)], PARITY_REGISTER, "current");
	assert.equal(report.count, 500);
	assert.deepEqual(report.counts, { match: 500, explained: 0, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
	assert.match(report.text, /count 500\/500 \(window 500\)\nnot comparable 1 \(session has no file\)\n/u);
});

test("a session whose side file is missing or unreadable stays inconclusive", () => {
	const unreadable: ParityDiff = { kind: "side-file-missing", reason: "side file is missing or unreadable" };
	const missing = call(1_000, "session", [unreadable]);
	const report = buildFoldParityReport([...matching(500), missing, request(missing, [unreadable])], PARITY_REGISTER, "current");
	assert.equal(report.count, 501);
	assert.equal(report.counts.inconclusive, 1);
	assert.equal(report.ready, false);
	assert.doesNotMatch(report.text, /not comparable/u);
});

test("the recorder's records for an in-memory session are classed not comparable", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-no-file-")));
	try {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		assert.equal(manager.getSessionFile(), undefined);
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 200_000 } } as unknown as ExtensionContext;
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir: dir, fingerprint: "test" });
		const emit = (name: string, event: unknown) => handlers.get(name)!(event, ctx);
		emit("tool_call", { type: "tool_call", toolName: "compress", toolCallId: "call", input: { content: [] } });
		emit("tool_result", { type: "tool_result", toolName: "compress", toolCallId: "call", content: [{ type: "text", text: "failed" }], isError: true });
		emit("context", { type: "context", messages: [{ role: "user", content: `next\n${tag(1)}` }] });
		await recorder.flush();
		const records = await readParityRecords(dir);
		assert.deepEqual(records.map((record) => record.kind), ["compress", "next-request"]);
		const report = buildFoldParityReport(records, PARITY_REGISTER, records[0]!.fingerprint);
		assert.equal(report.count, 0);
		assert.deepEqual(report.counts, { match: 0, explained: 0, diff: 0, inconclusive: 0 });
		assert.match(report.text, /not comparable 1 \(session has no file\)/u);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
