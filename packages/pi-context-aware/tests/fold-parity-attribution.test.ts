import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compareBatchRequest, compareNextRequest, coverageHash, previewShadowCalls, requestEvidence, hashRequestMessages, type BatchCall, type PreviewFold, type PreviewInput, type RequestMessage, type ShadowCall } from "../src/parity/compare.js";
import { SUMMARY_HEADER } from "../src/folds/kernel/prune.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { PARITY_RECORD_VERSION, readParityRecords, type CompressRecord, type NextRequestRecord, type ParityRecord, type RefusalOutcome } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { buildFoldParityReport } from "../src/parity/report.js";
import { snapshotSideFile } from "../src/parity/side-file.js";
import { configuredFoldFingerprint } from "../src/parity/fingerprint.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry, type FoldsConfig } from "../src/platform/config-layers.js";

// ---- Request differences are explained only when a refusal causes them (review finding CR-REQUEST-ATTRIBUTION) ----

const SUMMARY = "The opening work is settled; keep the agreed decisions, file paths and values for the next phase.";
const range = (start: number, end: number, summary = SUMMARY) => ({ content: [{ startId: ref(start), endId: ref(end), summary }] });
const ref = (n: number) => `m${String(n).padStart(5, "0")}`;
const RESULTS = {
	deadRange: { text: "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)\n[ACP] REJECTED — this exact compress call has now failed 2× (ranges m00001..m00004).", isError: false },
	aborted: { text: "Operation aborted", isError: true },
	capped: { text: "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)\n[ACP] PAUSED — 3 compress attempts already failed this turn.", isError: false },
	tier3: { text: "Range b1..b2 only re-condenses terminal tier-3 block(s) — Nothing was compressed.", isError: true },
	// billion-context-pi rejects a short summary the same way the native engine does: the sibling matches.
	shortSummary: { text: "▣ ACP | 48.0K → 48.0K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00005..m00008: Summary too short (5 chars, min 50).", isError: false },
};
type Call = { readonly id: string; readonly input: unknown; readonly text: string; readonly isError: boolean };
/**
 * These fixtures fold the opening user message with the rest of its range, as the native engine did
 * before the first-user policy existed, so a range of entries 1-4 covers four entries. The recorder keys
 * its records by the engine fingerprint and this effective policy.
 */
const FOLD_OPENING: FoldsConfig = { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 };
const PROBE = configuredFoldFingerprint("probe", FOLD_OPENING);
const foldOpening = (manager: SessionManager) => manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));

/**
 * A session whose first folded range holds a read call and its result, so the native fold changes
 * tool calls and results too, and whose last two entries are a retained read the fold never touches.
 */
function session(dir: string) {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	foldOpening(manager);
	const ids = [
		manager.appendMessage({ role: "user", content: `0 ${"history ".repeat(4000)}`, timestamp: 1 }),
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read-folded", name: "read", arguments: { path: "folded" } }], timestamp: 1 } as never),
		manager.appendMessage({ role: "toolResult", toolCallId: "read-folded", toolName: "read", isError: false, content: [{ type: "text", text: `folded ${"result ".repeat(4000)}` }], timestamp: 1 } as never),
		...Array.from({ length: 9 }, (_, i) => manager.appendMessage({ role: "user", content: `${i + 3} ${"history ".repeat(4000)}`, timestamp: 1 })),
	];
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read-retained", name: "read", arguments: { path: "correct" } }], timestamp: 1 } as never);
	manager.appendMessage({ role: "toolResult", toolCallId: "read-retained", toolName: "read", isError: false, content: [{ type: "text", text: "correct result" }], timestamp: 1 } as never);
	fs.writeFileSync(`${manager.getSessionFile()}.acp.json`, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [ref(i + 1), id])) } }));
	return manager;
}
/** billion-context-pi's next request after it refused or rejected every call: the unfolded branch, with its ACP tags. */
function bcpRequest(manager: SessionManager, corrupt = false): RequestMessage[] {
	const messages = structuredClone(manager.buildSessionContext().messages) as unknown as { role: string; content: unknown }[];
	const first = messages[0]!;
	first.content = `${String(first.content)}\n<acp tokens="1K" type="text">m00001</acp>`;
	if (corrupt) {
		// Fault injection outside the folded range: a retained read call's arguments change.
		const retained = messages.find((message) => Array.isArray(message.content) && (message.content as { id?: string }[]).some((part) => part.id === "read-retained"))!;
		(retained.content as { arguments?: unknown }[])[0]!.arguments = { path: "WRONG" };
	}
	return messages as RequestMessage[];
}

/** Drive the real recorder through one batch of calls and its next provider request. */
async function recordBatch(calls: readonly Call[], options: { corrupt?: boolean } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-")));
	try {
		const manager = session(dir);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const agentDir = path.join(dir, "agent");
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir, fingerprint: "probe", limits: { maxSnapshots: 8 } });
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 1_000_000 } } as unknown as ExtensionContext;
		for (const call of calls) {
			handlers.get("tool_call")!({ toolName: "compress", toolCallId: call.id, input: call.input }, ctx);
			handlers.get("tool_result")!({ toolName: "compress", toolCallId: call.id, content: [{ type: "text", text: call.text }], isError: call.isError }, ctx);
		}
		handlers.get("context")!({ type: "context", messages: bcpRequest(manager, options.corrupt) }, ctx);
		await recorder.flush();
		// The counterfactual preview reuses the batch's snapshot: nothing stays retained once the batch is written.
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
		const records = await readParityRecords(agentDir);
		const request = records.find((record): record is NextRequestRecord => record.kind === "next-request");
		assert.ok(request, "the batch has next-request evidence");
		return { records, request, calls: records.filter((record): record is CompressRecord => record.kind === "compress") };
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
/** 499 matching calls in another session, later than every recorded batch, each with its own matching next request. */
const NO_BLOCKS = { count: 0, coverageCount: 0, coverageIds: [], coverageHash: coverageHash([]), partialEntries: 0, tiers: [], absorbed: [] };
const fillers: ParityRecord[] = Array.from({ length: 499 }, (_, i): ParityRecord[] => {
	const base = { v: PARITY_RECORD_VERSION, fingerprint: PROBE, sessionId: "other", at: `2999-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, verdict: "match" as const, diffs: [] };
	return [
		{ ...base, kind: "compress", toolCallId: `match-${i}`, nested: false, parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
			ours: { ...NO_BLOCKS, createdIds: [] }, bcp: NO_BLOCKS, oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] } },
		{ ...base, kind: "next-request", toolCallIds: [`match-${i}`], ours: { messages: [], total: 0, tagsSeen: true, activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] }, bcp: { messages: [], total: 0, tagsSeen: true } },
	];
}).flat();
const kinds = (diffs: readonly { kind: string }[] | undefined) => diffs?.map((diff) => diff.kind);

for (const [name, result, entry] of [["dead-range", RESULTS.deadRange, "FP-005"], ["aborted", RESULTS.aborted, "FP-007"], ["capped-retry", RESULTS.capped, "FP-004"], ["tier3-rewrite", RESULTS.tier3, "FP-006"]] as const) {
	test(`a recorded ${name} refusal explains the next request's summaries, content, tool calls and results`, async () => {
		const { records, request } = await recordBatch([{ id: "refused", input: range(1, 4), ...result }]);
		assert.deepEqual(kinds(request.diffs), ["summaries", "content", "tool-calls", "tool-results"]);
		assert.deepEqual(request.refused, [{ toolCallId: "refused", type: name }]);
		// The full request is the counterfactual one with the refused fold of entries 1-4 applied.
		assert.deepEqual(request.counterfactual, { diffs: [], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
		const report = buildFoldParityReport([...records, ...fillers], PARITY_REGISTER, PROBE);
		assert.deepEqual(report.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
		assert.equal(report.ready, true);
		assert.ok((report.registerHits[entry]?.differences ?? 0) > 0);
	});
}

test("a refusal does not explain a retained tool call that changed outside the folded range", async () => {
	const { records, request } = await recordBatch([{ id: "refused", input: range(1, 4), ...RESULTS.deadRange }], { corrupt: true });
	assert.deepEqual(request.refused, [{ toolCallId: "refused", type: "dead-range" }]);
	assert.deepEqual(kinds(request.counterfactual?.diffs), ["tool-calls"]);
	const report = buildFoldParityReport([...records, ...fillers], PARITY_REGISTER, PROBE);
	assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
	assert.equal(report.ready, false);
});

test("a batch with a matching sibling and a refused call keeps only the refusal's request delta explained", async () => {
	const batch = [{ id: "sibling", input: range(5, 8, "short"), ...RESULTS.shortSummary }, { id: "refused", input: range(1, 4), ...RESULTS.deadRange }];
	const genuine = await recordBatch(batch);
	assert.equal(genuine.calls.find((call) => call.toolCallId === "sibling")?.verdict, "match");
	assert.deepEqual(genuine.request.toolCallIds, ["sibling", "refused"]);
	assert.deepEqual(genuine.request.refused, [{ toolCallId: "refused", type: "dead-range" }]);
	assert.deepEqual(genuine.request.counterfactual, { diffs: [], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.deepEqual(buildFoldParityReport(genuine.records, PARITY_REGISTER, PROBE).counts, { match: 0, explained: 2, diff: 0, inconclusive: 0 });
	const corrupted = await recordBatch(batch, { corrupt: true });
	assert.deepEqual(kinds(corrupted.request.counterfactual?.diffs), ["tool-calls"]);
	assert.deepEqual(buildFoldParityReport(corrupted.records, PARITY_REGISTER, PROBE).counts, { match: 0, explained: 0, diff: 2, inconclusive: 0 });
	// With the sibling outside the 500-call window, the refused call alone still keeps the corruption.
	const sibling = corrupted.calls.find((call) => call.toolCallId === "sibling")!;
	const windowed = buildFoldParityReport([{ ...sibling, at: "1999-01-01T00:00:00.000Z" }, ...corrupted.records.filter((record) => record !== sibling), ...fillers], PARITY_REGISTER, PROBE);
	assert.equal(windowed.window?.calls, 500);
	assert.deepEqual(windowed.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
	assert.equal(windowed.ready, false);
});

test("several refused calls in one batch are omitted together from the counterfactual preview", async () => {
	const batch = [{ id: "dead", input: range(1, 4), ...RESULTS.deadRange }, { id: "aborted", input: range(5, 8), ...RESULTS.aborted }];
	const genuine = await recordBatch(batch);
	assert.deepEqual(genuine.request.refused, [{ toolCallId: "dead", type: "dead-range" }, { toolCallId: "aborted", type: "aborted" }]);
	// The native preview folds entries 1-4 and, for the second range in this session, entries 5-7.
	assert.deepEqual(genuine.request.counterfactual, { diffs: [], delta: { verdict: "refused-folds-only", refusedFolds: 2, coveredEntries: 7, removedMessages: 7 } });
	const report = buildFoldParityReport([...genuine.records, ...fillers.slice(2)], PARITY_REGISTER, PROBE);
	assert.deepEqual(report.counts, { match: 498, explained: 2, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
	const corrupted = await recordBatch(batch, { corrupt: true });
	assert.deepEqual(kinds(corrupted.request.counterfactual?.diffs), ["tool-calls"]);
	assert.deepEqual(buildFoldParityReport(corrupted.records, PARITY_REGISTER, PROBE).counts, { match: 0, explained: 0, diff: 2, inconclusive: 0 });
});

test("a batch without refused calls carries no counterfactual evidence", async () => {
	const { request } = await recordBatch([{ id: "sibling", input: range(5, 8, "short"), ...RESULTS.shortSummary }], { corrupt: true });
	assert.deepEqual(kinds(request.diffs), ["tool-calls"]);
	assert.equal(request.refused, undefined);
	assert.equal(request.counterfactual, undefined);
});

// ---- The review probe: fault injection on the native side ----

test("the review probe's native-side corruption of a retained read is not explained by a dead-range refusal", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-probe-")));
	try {
		const manager = session(dir);
		const snapshot: PreviewInput = { sessionId: manager.getSessionId(), cwd: dir, header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000, folds: FOLD_OPENING };
		const call: ShadowCall = { toolCallId: "dead-range", input: range(1, 4), before: snapshotSideFile(manager.getSessionFile()) };
		/** The native preview's request, with the probe's corruption of the retained read call. */
		const corruptedNative = (omit?: ReadonlySet<string>) => {
			const planned = previewShadowCalls(snapshot, [call], omit);
			const messages = structuredClone(planned.preview!.buildSessionContext().messages) as unknown as { role: string; content: unknown }[];
			const retained = messages.find((message) => Array.isArray(message.content) && (message.content as { id?: string }[]).some((part) => part.id === "read-retained"));
			assert.ok(retained, "the retained read survives the native fold");
			(retained.content as { arguments?: unknown }[])[0]!.arguments = { path: "WRONG" };
			return requestEvidence(planned, messages as RequestMessage[]);
		};
		const bcp = hashRequestMessages(bcpRequest(manager));
		const full = compareNextRequest(corruptedNative(), bcp);
		assert.deepEqual(kinds(full.diffs), ["summaries", "content", "tool-calls", "tool-results"]);
		const counterfactual = compareNextRequest(corruptedNative(new Set([call.toolCallId])), bcp);
		assert.deepEqual(kinds(counterfactual.diffs), ["tool-calls"]);
		const at = "2026-10-11T00:00:00.000Z";
		const covered = ["e1", "e2", "e3", "e4"];
		const refused: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: PROBE, sessionId: "s", toolCallId: call.toolCallId, nested: false, at, verdict: "diff", diffs: [{ kind: "outcome", reason: "ours=accepted; bcp=dead-range" }, { kind: "block-count" }],
			parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
			oursOutcome: { type: "accepted", reasons: [] }, bcpOutcome: { type: "dead-range", reasons: [] }, ours: { count: 1, coverageCount: 4, coverageIds: covered, coverageHash: coverageHash(covered), createdIds: ["b1"], partialEntries: 0, tiers: [1], absorbed: [] }, bcp: { ...NO_BLOCKS } };
		const request: NextRequestRecord = { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: PROBE, sessionId: "s", toolCallIds: [call.toolCallId], at, ours: corruptedNative(), bcp, ...full, refused: [{ toolCallId: call.toolCallId, type: "dead-range" }], counterfactual: { diffs: counterfactual.diffs } };
		const report = buildFoldParityReport([refused, request, ...fillers], PARITY_REGISTER, PROBE);
		assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
		assert.equal(report.ready, false);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Round-4 review probe: partial delta evidence (CR-REQUEST-ATTRIBUTION, reopened) ----

/**
 * The round-4 review's probe: valid version-5 call and request evidence for one dead-range refusal,
 * a clean counterfactual, a retained read whose arguments changed in the full native preview only,
 * and a delta that holds only its verdict. The recorder's own delta is `other`; the stored one is
 * replaced, as a corrupted or hand-edited record would hold it.
 */
async function partialDeltaProbe(delta: unknown, options: { corrupt?: boolean } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-delta-")));
	try {
		const manager = session(dir);
		const snapshot: PreviewInput = { sessionId: manager.getSessionId(), cwd: dir, header: structuredClone(manager.getHeader()), branch: structuredClone(manager.getBranch()), contextWindow: 1_000_000, folds: FOLD_OPENING };
		const batch: BatchCall[] = [{ toolCallId: "refused", input: range(1, 4), before: snapshotSideFile(manager.getSessionFile()), refusal: "dead-range" }];
		const bcp = hashRequestMessages(bcpRequest(manager));
		const compared = compareBatchRequest(snapshot, batch, bcp, options.corrupt ? wrongRetainedRead : previewShadowCalls);
		const at = "2026-10-11T00:00:00.000Z";
		const covered = ["e1", "e2", "e3", "e4"];
		const call: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: PROBE, sessionId: "s", toolCallId: "refused", nested: false, at, verdict: "diff",
			diffs: [{ kind: "outcome", reason: "ours=accepted; bcp=dead-range" }, { kind: "block-count" }, { kind: "coverage", oursOnlyCount: 4, bcpOnlyCount: 0, oursOnly: covered, bcpOnly: [] }, { kind: "tier" }],
			parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 }, oursOutcome: { type: "accepted", reasons: [] }, bcpOutcome: { type: "dead-range", reasons: [] },
			ours: { count: 1, coverageCount: 4, coverageIds: covered, coverageHash: coverageHash(covered), createdIds: ["b1"], partialEntries: 0, tiers: [1], absorbed: [] }, bcp: { ...NO_BLOCKS } };
		const stored = delta === undefined ? compared.counterfactual : { ...compared.counterfactual!, delta };
		const request: NextRequestRecord = { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: PROBE, sessionId: "s", toolCallIds: ["refused"], at, bcp, ...compared, counterfactual: stored as NextRequestRecord["counterfactual"] };
		return { compared, request, report: buildFoldParityReport([call, request, ...fillers], PARITY_REGISTER, PROBE) };
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("the round-4 probe: a delta that holds only its verdict does not explain a full-only retained-read corruption", async () => {
	// Control: the genuine record, with the recorder's own complete delta, is explained.
	const genuine = await partialDeltaProbe(undefined);
	assert.deepEqual(genuine.compared.counterfactual, { diffs: [], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.deepEqual(genuine.report.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	assert.equal(genuine.report.ready, true);
	// The probe: the counterfactual is clean and its recomputation agrees, but the full request changed a retained read.
	const probe = await partialDeltaProbe({ verdict: "refused-folds-only" }, { corrupt: true });
	assert.deepEqual(probe.compared.counterfactual?.diffs, []);
	assert.ok(kinds(probe.compared.diffs)?.includes("tool-calls"));
	assert.equal(probe.compared.counterfactual?.delta?.verdict, "other");
	assert.deepEqual(probe.report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
	assert.equal(probe.report.ready, false);
	assert.ok(probe.report.blocking.some((blocked) => blocked.toolCallId === "refused"));
	assert.match(probe.report.text, /refused/u);
});

// ---- The counterfactual preview stays within the existing bounds ----

test("a counterfactual preview that cannot be computed leaves the request inconclusive, never explained", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-fail-")));
	try {
		const manager = session(dir);
		const snapshot: PreviewInput = { sessionId: manager.getSessionId(), cwd: dir, header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000, folds: FOLD_OPENING };
		const calls = [{ toolCallId: "refused", input: range(1, 4), before: snapshotSideFile(manager.getSessionFile()), refusal: "dead-range" as const }];
		const bcp = hashRequestMessages(bcpRequest(manager));
		const previews: (ReadonlySet<string> | undefined)[] = [];
		const failing: typeof previewShadowCalls = (input, batch, omit) => {
			previews.push(omit);
			if (omit) throw new Error("counterfactual preview failed");
			return previewShadowCalls(input, batch, omit);
		};
		const compared = compareBatchRequest(snapshot, calls, bcp, failing);
		assert.deepEqual(previews.map((omit) => omit && [...omit]), [undefined, ["refused"]]);
		assert.equal(compared.verdict, "inconclusive");
		assert.deepEqual(kinds(compared.diffs), ["summaries", "content", "tool-calls", "tool-results", "recorder-error"]);
		assert.equal(compared.counterfactual, undefined);
		const request: ParityRecord = { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: PROBE, sessionId: "s", toolCallIds: ["refused"], at: "2026-10-11T00:00:01.000Z", bcp, ...compared };
		const refused: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: PROBE, sessionId: "s", toolCallId: "refused", nested: false, at: "2026-10-11T00:00:00.000Z", verdict: "diff", diffs: [{ kind: "outcome", reason: "ours=accepted; bcp=dead-range" }], oursOutcome: { type: "accepted", reasons: [] }, bcpOutcome: { type: "dead-range", reasons: [] } };
		assert.deepEqual(buildFoldParityReport([refused, request], PARITY_REGISTER, PROBE).counts, { match: 0, explained: 0, diff: 0, inconclusive: 1 });
		// A clean full comparison needs no counterfactual and runs one preview.
		previews.length = 0;
		const unfolded = compareBatchRequest(snapshot, [{ ...calls[0]!, input: range(1, 4, "short") }], bcp, failing);
		assert.deepEqual(previews, [undefined]);
		assert.deepEqual(unfolded.diffs, []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- A refused call and an accepted sibling: the full request must differ only by the refused fold (review round 2) ----

const ACCEPTED = "This accepted sibling has its own decisions and files; preserve this exact summary for the continuing work.";
const ACCEPTED_PANEL = "▣ ACP | 48.0K → 40.0K tokens (~8.0K reclaimed, blocks: b1=m00005..m00008)";
type SiblingCall = { readonly id: string; readonly input: unknown; readonly text: string; readonly refusal?: RefusalOutcome; readonly acceptedBlock?: boolean };
/** A native preview that applies `fault` to the full preview's request only, never to the counterfactual's. */
function fullOnly(fault: (messages: { role: string; content: unknown }[]) => void): typeof previewShadowCalls {
	return (input, calls, omit) => {
		const planned = previewShadowCalls(input, calls, omit);
		if (omit || !planned.preview) return planned;
		const real = planned.preview;
		const context = real.buildSessionContext();
		const messages = structuredClone(context.messages) as unknown as { role: string; content: unknown }[];
		fault(messages);
		// Provenance stays the real preview's: only the request text is wrong.
		const preview = Object.assign(Object.create(real) as SessionManager, { buildSessionContext: () => ({ ...context, messages }) });
		return { ...planned, preview };
	};
}
const wrongAcceptedSummary = fullOnly((messages) => {
	const sibling = messages.find((message) => message.content === `${SUMMARY_HEADER}\n${ACCEPTED}`);
	assert.ok(sibling, "the full preview holds the accepted sibling's summary");
	sibling.content = `${SUMMARY_HEADER}\nWRONG ACCEPTED SUMMARY`;
});
const wrongRetainedRead = fullOnly((messages) => {
	const retained = messages.find((message) => Array.isArray(message.content) && (message.content as { id?: string }[]).some((part) => part.id === "read-retained"));
	assert.ok(retained, "the retained read survives both folds");
	(retained.content as { arguments?: unknown }[])[0]!.arguments = { path: "WRONG" };
});

/**
 * The review's accepted-sibling fixture: sixteen user entries and a retained read outside every
 * folded range. billion-context-pi refused one call and accepted another that folded entries 5-8.
 * Its next request is built by hand from the session, not by the code under test: the accepted
 * summary replaces entry 5, entries 6-8 are gone, and entry 1 carries an ACP tag.
 */
async function recordSiblingBatch(calls: readonly SiblingCall[], options: { identicalNeighbours?: boolean } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-sibling-")));
	try {
		const manager = SessionManager.create(dir, path.join(dir, "sessions"));
		foldOpening(manager);
		// With `identicalNeighbours`, entries 15 and 16 hold the same text, so their messages hash the same.
		const text = (i: number) => options.identicalNeighbours && (i === 14 || i === 15) ? `identical neighbour ${"history ".repeat(4000)}` : `${i} ${"history ".repeat(4000)}`;
		const ids = Array.from({ length: 16 }, (_, i) => manager.appendMessage({ role: "user", content: text(i), timestamp: 1 }));
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read-retained", name: "read", arguments: { path: "correct" } }], timestamp: 1 } as never);
		manager.appendMessage({ role: "toolResult", toolCallId: "read-retained", toolName: "read", isError: false, content: [{ type: "text", text: "correct result" }], timestamp: 1 } as never);
		const sideFile = `${manager.getSessionFile()}.acp.json`;
		const byRef = Object.fromEntries(ids.map((id, i) => [ref(i + 1), id]));
		const writeSide = (blocks: unknown[]) => fs.writeFileSync(sideFile, JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef } }));
		writeSide([]);
		const acceptedBlock = { blockId: "b1", runId: "r1", tier: 1, summary: ACCEPTED, effectiveMessageIds: ids.slice(4, 8), directBlockIds: [], compressedTokens: 100, createdAt: 1, active: true };
		const bcpMessages = structuredClone(manager.buildSessionContext().messages) as unknown as { role: string; content: unknown }[];
		bcpMessages[4]!.content = `${SUMMARY_HEADER}\n${ACCEPTED}`;
		bcpMessages.splice(5, 3);
		bcpMessages[0]!.content = `${String(bcpMessages[0]!.content)}\n<acp tokens="1K" type="text">m00001</acp>`;
		const bcp = hashRequestMessages(bcpMessages as RequestMessage[]);
		const snapshot: PreviewInput = { sessionId: manager.getSessionId(), cwd: dir, header: structuredClone(manager.getHeader()), branch: structuredClone(manager.getBranch()), contextWindow: 1_000_000, folds: FOLD_OPENING };
		const before = snapshotSideFile(manager.getSessionFile());
		const batch: BatchCall[] = calls.map((call) => ({ toolCallId: call.id, input: call.input, before, ...(call.refusal ? { refusal: call.refusal } : {}) }));

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const agentDir = path.join(dir, "agent");
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir, fingerprint: "probe", limits: { maxSnapshots: 8 } });
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 1_000_000 } } as unknown as ExtensionContext;
		for (const call of calls) {
			handlers.get("tool_call")!({ toolName: "compress", toolCallId: call.id, input: call.input }, ctx);
			if (call.acceptedBlock) writeSide([acceptedBlock]);
			handlers.get("tool_result")!({ toolName: "compress", toolCallId: call.id, content: [{ type: "text", text: call.text }], isError: false }, ctx);
		}
		handlers.get("context")!({ type: "context", messages: bcpMessages }, ctx);
		await recorder.flush();
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
		const records = await readParityRecords(agentDir);
		const request = records.find((record): record is NextRequestRecord => record.kind === "next-request");
		assert.ok(request, "the batch has next-request evidence");
		const compress = records.filter((record): record is CompressRecord => record.kind === "compress");
		/** The same batch compared with an injected native preview, reported with the recorded calls. */
		const rerun = (preview: typeof previewShadowCalls) => {
			const compared = compareBatchRequest(snapshot, batch, bcp, preview);
			return { compared, report: buildFoldParityReport([...compress, { ...request, ...compared }, ...fillers.slice(2)], PARITY_REGISTER, PROBE) };
		};
		return { ids, records, request, compress, report: buildFoldParityReport([...records, ...fillers.slice(2)], PARITY_REGISTER, PROBE), rerun };
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const DEAD_FIRST: SiblingCall = { id: "refused-first", input: range(1, 4), text: RESULTS.deadRange.text, refusal: "dead-range" };
const ACCEPTED_SECOND: SiblingCall = { id: "accepted-second", input: range(5, 8, ACCEPTED), text: ACCEPTED_PANEL, acceptedBlock: true };

test("a dead-range refusal with an accepted sibling fold is explained when the full request differs only by the refused fold", async () => {
	const { compress, request, report } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	assert.equal(compress.find((call) => call.toolCallId === ACCEPTED_SECOND.id)?.verdict, "match");
	assert.deepEqual(kinds(request.diffs), ["summaries", "content"]);
	assert.deepEqual(request.refused, [{ toolCallId: DEAD_FIRST.id, type: "dead-range" }]);
	assert.deepEqual(request.counterfactual, { diffs: [], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.deepEqual(report.counts, { match: 498, explained: 2, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
});

test("a wrong accepted-sibling summary in the full preview alone is not explained by a clean counterfactual", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(wrongAcceptedSummary);
	assert.deepEqual(compared.counterfactual?.diffs, []);
	// Message 0 is the refused summary; message 1 is the accepted sibling's summary, which is wrong.
	assert.deepEqual(compared.counterfactual?.delta, { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 1 });
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
	assert.equal(report.ready, false);
});

test("changed arguments of a retained read outside both ranges, in the full preview alone, are not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(wrongRetainedRead);
	assert.deepEqual(kinds(compared.diffs), ["summaries", "content", "tool-calls"]);
	assert.deepEqual(compared.counterfactual?.diffs, []);
	// The two summaries and entries 9-16 come first; message 10 is the retained read call.
	assert.deepEqual(compared.counterfactual?.delta, { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 10 });
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
	assert.equal(report.ready, false);
});

test("a refused fold that covers or absorbs an accepted sibling's block is not explained", async () => {
	// The refused fold of entries 1-8 comes first, so the native preview rejects the sibling as consumed.
	const covering = await recordSiblingBatch([{ ...DEAD_FIRST, input: range(1, 8) }, ACCEPTED_SECOND]);
	assert.equal(covering.compress.find((call) => call.toolCallId === ACCEPTED_SECOND.id)?.verdict, "match");
	assert.deepEqual(covering.request.counterfactual?.diffs, []);
	assert.deepEqual(covering.request.counterfactual?.delta, { verdict: "other", reason: "sibling-covered", refusedFolds: 1, coveredEntries: 8 });
	assert.deepEqual(covering.report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
	// The sibling folds first; the refused fold of entries 1-10 then absorbs its block.
	const absorbing = await recordSiblingBatch([ACCEPTED_SECOND, { ...DEAD_FIRST, input: range(1, 10) }]);
	assert.deepEqual(absorbing.request.counterfactual?.diffs, []);
	assert.deepEqual(absorbing.request.counterfactual?.delta, { verdict: "other", reason: "sibling-covered", refusedFolds: 1, coveredEntries: 10 });
	assert.deepEqual(absorbing.report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
});

test("a refused summary in the request that differs from the summary its fold wrote is not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(fullOnly((messages) => {
		const refusedSummary = messages.find((message) => message.content === `${SUMMARY_HEADER}\n${SUMMARY}`);
		assert.ok(refusedSummary, "the full preview holds the refused fold's summary");
		refusedSummary.content = `${SUMMARY_HEADER}\nA summary the refused fold never wrote.`;
	}));
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 0 } });
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
});

test("an accepted sibling whose fold differs in the full preview is not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	// Fault injection in the full preview's fold record only: the request text is unchanged.
	const { compared, report } = rerun((input, calls, omit) => {
		const planned = previewShadowCalls(input, calls, omit);
		return omit ? planned : { ...planned, folds: planned.folds.map((fold) => fold.callId === ACCEPTED_SECOND.id ? { ...fold, tier: 2 } : fold) };
	});
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "sibling-changed", refusedFolds: 1, coveredEntries: 4 } });
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
});

test("a preview whose messages cannot be traced to entries leaves the request unexplained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	// The review probe's wrapper exposes the request but not the projection it came from.
	const { compared, report } = rerun((input, calls, omit) => {
		const planned = previewShadowCalls(input, calls, omit);
		const context = planned.preview!.buildSessionContext();
		return { ...planned, preview: { buildSessionContext: () => context } as unknown as SessionManager };
	});
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "attribution-unavailable", refusedFolds: 1, coveredEntries: 4 } });
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 2, inconclusive: 0 });
});

test("a counterfactual preview that returns inconclusive diagnostics makes the request inconclusive", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	// The second preview returns a diagnostic instead of throwing.
	// It keeps the counterfactual's own summary evidence, which every request comparison now requires, but no request.
	const { compared, report } = rerun((input, calls, omit) => omit ? { ...previewShadowCalls(input, calls, omit), preview: undefined, diffs: [{ kind: "too-large", reason: "branch exceeds 50,000 entries" }] } : previewShadowCalls(input, calls, omit));
	assert.equal(compared.verdict, "inconclusive");
	assert.deepEqual(kinds(compared.diffs), ["summaries", "content", "recorder-error"]);
	assert.equal(compared.diffs.at(-1)?.reason, "counterfactual preview inconclusive");
	// The returned diagnostic comes first; the empty request also lacks the retained read.
	assert.deepEqual(kinds(compared.counterfactual?.diffs), ["too-large", "summaries", "content", "tool-calls", "tool-results"]);
	assert.equal(compared.counterfactual?.delta, undefined);
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 0, inconclusive: 2 });
	assert.equal(report.ready, false);
});

// ---- Structural faults in the full preview alone (review round 3, CR-DELTA-REGRESSION-COVERAGE) ----

type SourcedMessage = { id: string; message: { role: string; content: unknown } };
/**
 * A native preview that applies `fault` to the full preview's request and projection together, never
 * to the counterfactual's. Each message keeps the entry id it is shown as coming from, so an edited,
 * moved, added or dropped message is still traceable and the comparison sees the fault itself, not a
 * missing projection. `folds` may also change the full preview's fold records.
 */
function fullOnlySourced(fault: (messages: SourcedMessage[]) => void, folds?: (folds: readonly PreviewFold[]) => PreviewFold[]): typeof previewShadowCalls {
	return (input, calls, omit) => {
		const planned = previewShadowCalls(input, calls, omit);
		if (omit || !planned.preview) return planned;
		const real = planned.preview;
		const context = real.buildSessionContext();
		const projection = real.buildSessionProjection();
		const sourced = projection.entries.flatMap((entry) => entry.messages.map((message) => ({ id: entry.sourceEntry.id, message: structuredClone(message) as unknown as SourcedMessage["message"] })));
		assert.equal(sourced.length, context.messages.length, "the projection lines up with the request");
		fault(sourced);
		const messages = sourced.map((item) => item.message) as unknown as typeof context.messages;
		const preview = Object.assign(Object.create(real) as SessionManager, {
			buildSessionContext: () => ({ ...context, messages }),
			buildSessionProjection: () => ({ ...projection, messages, entries: sourced.map((item) => ({ sourceEntry: { id: item.id }, messages: [item.message] })) }),
		});
		return { ...planned, preview, ...(folds ? { folds: folds(planned.folds) } : {}) };
	};
}
// The full preview's request in the sibling fixture, by position: 0 the refused summary at entry 1,
// 1 the accepted summary at entry 5, 2-9 entries 9-16, 10 the retained read call, 11 its result.
// Each fault below leaves the counterfactual clean, so only the delta check can keep the batch unexplained.
const UNEXPLAINED = { match: 498, explained: 0, diff: 2, inconclusive: 0 };

test("a same-hash neighbour duplicated over its twin in the full preview alone is not explained", async () => {
	const { ids, rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND], { identicalNeighbours: true });
	const { compared, report } = rerun(fullOnlySourced((messages) => {
		const at15 = messages.findIndex((item) => item.id === ids[14]);
		const at16 = messages.findIndex((item) => item.id === ids[15]);
		assert.deepEqual([at15, at16], [8, 9]);
		assert.deepEqual(messages[at15]!.message, messages[at16]!.message, "the neighbours' messages are identical");
		// Entry 15 is shown twice and entry 16 is gone; every hash and the message count are unchanged.
		messages[at16] = structuredClone(messages[at15]!);
	}));
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 9 } });
	assert.deepEqual(report.counts, UNEXPLAINED);
	assert.equal(report.ready, false);
});

test("the refused summary shown at an entry other than its carrier, in the full preview alone, is not explained", async () => {
	const { ids, rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(fullOnlySourced((messages) => {
		assert.equal(messages[0]!.id, ids[0], "the refused summary stands at entry 1");
		assert.equal(messages[0]!.message.content, `${SUMMARY_HEADER}\n${SUMMARY}`);
		// The same summary text, attributed to entry 2, which the refused fold covers but does not carry.
		messages[0]!.id = ids[1]!;
	}));
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 0 } });
	assert.deepEqual(report.counts, UNEXPLAINED);
	assert.equal(report.ready, false);
});

test("a missing final message in the full preview alone is not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(fullOnlySourced((messages) => {
		assert.equal(messages.length, 12);
		messages.pop();
	}));
	assert.deepEqual(compared.counterfactual?.diffs, []);
	// Messages 0-10 agree; the retained read's result, message 11, is missing.
	assert.deepEqual(compared.counterfactual?.delta, { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 11 });
	assert.deepEqual(report.counts, UNEXPLAINED);
	assert.equal(report.ready, false);
});

test("an extra final message in the full preview alone is not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(fullOnlySourced((messages) => {
		assert.equal(messages.length, 12);
		messages.push(structuredClone(messages[11]!));
	}));
	assert.deepEqual(compared.counterfactual?.diffs, []);
	// Messages 0-11 agree; message 12 should not exist.
	assert.deepEqual(compared.counterfactual?.delta, { verdict: "other", reason: "message-changed", refusedFolds: 1, coveredEntries: 4, removedMessages: 4, mismatchAt: 12 });
	assert.deepEqual(report.counts, UNEXPLAINED);
	assert.equal(report.ready, false);
});

test("a refused fold whose carrier entry is absent from the counterfactual request is not explained", async () => {
	const { rerun } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const { compared, report } = rerun(fullOnlySourced((messages) => {
		assert.equal(messages[0]!.message.content, `${SUMMARY_HEADER}\n${SUMMARY}`);
		// The refused summary is gone from the request ...
		messages.shift();
	}, (folds) => {
		const refused = folds.filter((fold) => fold.callId === DEAD_FIRST.id);
		assert.equal(refused.length, 1);
		// ... and the refused fold names a carrier no request message comes from. Its coverage is unchanged.
		return folds.map((fold) => fold.callId === DEAD_FIRST.id ? { ...fold, carrierId: "carrier-not-in-the-request" } : fold);
	}));
	assert.deepEqual(compared.counterfactual, { diffs: [], delta: { verdict: "other", reason: "summary-missing", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.deepEqual(report.counts, UNEXPLAINED);
	assert.equal(report.ready, false);
});

// ---- Composition with main's register (FP-001 to FP-003): known differences outside the batch ----

const PRIOR = "An earlier batch folded these entries; keep their agreed decisions, file paths and values visible.";
/** Longer than billion-context-pi's 200-character limit for summaries inside compress arguments. */
const LONG = `A compress call earlier in this session kept a long summary: ${"its decisions, file paths and values stay in the arguments; ".repeat(5)}`;
type Background = "earlier-fold" | "long-summary" | "opening-folded";
/**
 * The attribution session with a known difference from earlier in the session, and billion-context-pi's
 * next request built by hand as main's register describes it: no summary messages (FP-001), compress
 * summaries over 200 characters shortened to 199 characters and an ellipsis (FP-002), and the opening
 * user message pinned (FP-003). Only `refused` is in the batch.
 */
async function recordWithBackground(background: Background, refused: { readonly input: unknown }, options: { corrupt?: boolean } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-attribution-background-")));
	try {
		const manager = SessionManager.create(dir, path.join(dir, "sessions"));
		foldOpening(manager);
		const ids = [
			manager.appendMessage({ role: "user", content: `0 ${"history ".repeat(4000)}`, timestamp: 1 }),
			manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read-folded", name: "read", arguments: { path: "folded" } }], timestamp: 1 } as never),
			manager.appendMessage({ role: "toolResult", toolCallId: "read-folded", toolName: "read", isError: false, content: [{ type: "text", text: `folded ${"result ".repeat(4000)}` }], timestamp: 1 } as never),
			...Array.from({ length: 9 }, (_, i) => manager.appendMessage({ role: "user", content: `${i + 3} ${"history ".repeat(4000)}`, timestamp: 1 })),
		];
		const longArgs = { content: [{ startId: "m00099", endId: "m00099", summary: LONG }] };
		if (background === "long-summary") {
			manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "compress-earlier", name: "compress", arguments: longArgs }], timestamp: 1 } as never);
			manager.appendMessage({ role: "toolResult", toolCallId: "compress-earlier", toolName: "compress", isError: false, content: [{ type: "text", text: "▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)" }], timestamp: 1 } as never);
		}
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read-retained", name: "read", arguments: { path: "correct" } }], timestamp: 1 } as never);
		manager.appendMessage({ role: "toolResult", toolCallId: "read-retained", toolName: "read", isError: false, content: [{ type: "text", text: "correct result" }], timestamp: 1 } as never);
		// The earlier fold: entries 9-11, or entries 1-3 with the opening user message.
		const earlier = background === "earlier-fold" ? [8, 11] : background === "opening-folded" ? [0, 3] : undefined;
		const blocks = earlier ? [{ blockId: "b1", runId: "r1", tier: 1, summary: PRIOR, effectiveMessageIds: ids.slice(earlier[0], earlier[1]), directBlockIds: [], compressedTokens: 100, createdAt: 1, active: true }] : [];
		fs.writeFileSync(`${manager.getSessionFile()}.acp.json`, JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [ref(i + 1), id])) } }));

		const messages = structuredClone(manager.buildSessionContext().messages) as unknown as { role: string; content: unknown }[];
		const bcp = messages.filter((_, i) => background === "earlier-fold" ? i < 8 || i >= 11 : background === "opening-folded" ? i === 0 || i >= 3 : true);
		if (background === "long-summary") {
			const call = bcp.find((message) => Array.isArray(message.content) && (message.content as { id?: string }[]).some((part) => part.id === "compress-earlier"))!;
			(call.content as { arguments?: unknown }[])[0]!.arguments = { content: [{ startId: "m00099", endId: "m00099", summary: `${LONG.slice(0, 199)}…` }] };
		}
		bcp[0]!.content = `${String(bcp[0]!.content)}\n<acp tokens="1K" type="text">m00001</acp>`;
		if (options.corrupt) {
			const retained = bcp.find((message) => Array.isArray(message.content) && (message.content as { id?: string }[]).some((part) => part.id === "read-retained"))!;
			(retained.content as { arguments?: unknown }[])[0]!.arguments = { path: "WRONG" };
		}

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const agentDir = path.join(dir, "agent");
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir, fingerprint: "probe", limits: { maxSnapshots: 8 } });
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 1_000_000 } } as unknown as ExtensionContext;
		handlers.get("tool_call")!({ toolName: "compress", toolCallId: "refused", input: refused.input }, ctx);
		handlers.get("tool_result")!({ toolName: "compress", toolCallId: "refused", content: [{ type: "text", text: RESULTS.deadRange.text }], isError: false }, ctx);
		handlers.get("context")!({ type: "context", messages: bcp }, ctx);
		await recorder.flush();
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
		const records = await readParityRecords(agentDir);
		const request = records.find((record): record is NextRequestRecord => record.kind === "next-request");
		assert.ok(request, "the batch has next-request evidence");
		return { records, request, report: buildFoldParityReport([...records, ...fillers], PARITY_REGISTER, PROBE) };
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** True when main's entry `id` explains `diff` on the counterfactual's own request evidence. */
function explainsCounterfactual(id: string, diff: { kind: "summaries" | "content" | "tool-calls" }, request: NextRequestRecord, records: readonly ParityRecord[]) {
	const call = records.find((record): record is CompressRecord => record.kind === "compress")!;
	assert.ok(request.counterfactualOurs, "the request keeps the counterfactual's evidence");
	return PARITY_REGISTER.find((entry) => entry.id === id)!.matches(diff, call, { ...request, ours: request.counterfactualOurs });
}

test("a refusal after an earlier accepted fold is explained: FP-001 explains the counterfactual's summary placement", async () => {
	const { records, request, report } = await recordWithBackground("earlier-fold", { input: range(1, 4) });
	assert.deepEqual(kinds(request.diffs), ["summaries", "content", "tool-calls", "tool-results"]);
	assert.deepEqual(request.refused, [{ toolCallId: "refused", type: "dead-range" }]);
	// billion-context-pi drops the earlier fold's summary message, so the counterfactual is not identical.
	assert.deepEqual(request.counterfactual, { diffs: [{ kind: "summaries" }], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.ok(explainsCounterfactual("FP-001", { kind: "summaries" }, request, records));
	assert.deepEqual(report.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
	assert.ok((report.registerHits["FP-005"]?.differences ?? 0) > 0);
});

test("a refusal after a compress call with a long summary is explained: FP-002 explains the counterfactual's compress arguments", async () => {
	const { records, request, report } = await recordWithBackground("long-summary", { input: range(1, 4) });
	assert.deepEqual(kinds(request.diffs), ["summaries", "content", "tool-calls", "tool-results"]);
	assert.deepEqual(request.counterfactual, { diffs: [{ kind: "tool-calls" }], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.ok(explainsCounterfactual("FP-002", { kind: "tool-calls" }, request, records));
	assert.deepEqual(report.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
	assert.ok((report.registerHits["FP-005"]?.differences ?? 0) > 0);
});

test("a refusal after the opening user message was folded is explained: FP-001 and FP-003 explain the counterfactual", async () => {
	const { records, request, report } = await recordWithBackground("opening-folded", { input: range(4, 7) });
	assert.deepEqual(request.counterfactual, { diffs: [{ kind: "summaries" }, { kind: "content" }], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } });
	assert.ok(explainsCounterfactual("FP-001", { kind: "summaries" }, request, records));
	assert.ok(explainsCounterfactual("FP-003", { kind: "content" }, request, records));
	assert.deepEqual(report.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	assert.equal(report.ready, true);
	assert.ok((report.registerHits["FP-005"]?.differences ?? 0) > 0);
});

for (const background of ["earlier-fold", "long-summary", "opening-folded"] as const) {
	test(`after ${background}, a counterfactual difference no register entry explains keeps the refusal unexplained`, async () => {
		// billion-context-pi's request also changes a retained read call: no entry explains that.
		const { request, report } = await recordWithBackground(background, { input: background === "opening-folded" ? range(4, 7) : range(1, 4) }, { corrupt: true });
		assert.ok(kinds(request.counterfactual?.diffs)?.includes("tool-calls"));
		assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
		assert.equal(report.ready, false);
	});
}

test("a stored clean counterfactual cannot hide a difference its own evidence shows", async () => {
	const { records, request } = await recordWithBackground("earlier-fold", { input: range(1, 4) }, { corrupt: true });
	assert.deepEqual(kinds(request.counterfactual?.diffs), ["summaries", "tool-calls"]);
	// The stored list claims only the known difference; the counterfactual's evidence still has the changed read.
	const forged = { ...request, counterfactual: { ...request.counterfactual!, diffs: [{ kind: "summaries" as const }] } };
	const report = buildFoldParityReport([...records.filter((record) => record !== request), forged, ...fillers], PARITY_REGISTER, PROBE);
	assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
	assert.equal(report.ready, false);
});

test("a counterfactual without its request evidence explains nothing, even when its stored list is empty", async () => {
	const { records, request } = await recordWithBackground("earlier-fold", { input: range(1, 4) });
	const { counterfactualOurs: _, ...withoutEvidence } = request;
	for (const diffs of [request.counterfactual!.diffs, []]) {
		const record = { ...withoutEvidence, counterfactual: { ...request.counterfactual!, diffs } };
		const report = buildFoldParityReport([...records.filter((item) => item !== request), record, ...fillers], PARITY_REGISTER, PROBE);
		assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 }, JSON.stringify(diffs));
	}
});

test("a malformed counterfactual diff that a known entry would match is never explained", async () => {
	const { records, request } = await recordWithBackground("earlier-fold", { input: range(1, 4) });
	assert.deepEqual(kinds(request.counterfactual?.diffs), ["summaries"]);
	const report = (diffs: unknown[]) => buildFoldParityReport([...records.filter((record) => record !== request), { ...request, counterfactual: { ...request.counterfactual!, diffs: diffs as [] } }, ...fillers], PARITY_REGISTER, PROBE);
	// Control: FP-001 explains the counterfactual's summary placement.
	assert.deepEqual(report([{ kind: "summaries" }]).counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	for (const diff of [{ kind: "summaries", oursOnlyCount: -1 }, { kind: "summaries", bcpOnlyCount: 1.5 }, { kind: "summaries", oursOnly: "b1" }, { kind: "summaries", bcpOnly: [7] }, { kind: "summaries", reason: 7 }]) {
		assert.deepEqual(report([diff]).counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 }, JSON.stringify(diff));
	}
});

test("malformed counterfactual request evidence is a recorder fault", async () => {
	const { records, request } = await recordWithBackground("earlier-fold", { input: range(1, 4) });
	// One message hash fewer than the request's total.
	const malformed = { ...request, counterfactualOurs: { ...request.counterfactualOurs!, messages: request.counterfactualOurs!.messages.slice(1) } };
	const report = buildFoldParityReport([...records.filter((record) => record !== request), malformed, ...fillers], PARITY_REGISTER, PROBE);
	assert.deepEqual(report.counts, { match: 499, explained: 0, diff: 0, inconclusive: 1 });
	assert.equal(report.ready, false);
});

test("a refused list that names an accepted call cannot take that call's block ids out of the active-fold bound", async () => {
	const { compress, request, records } = await recordSiblingBatch([DEAD_FIRST, ACCEPTED_SECOND]);
	const sibling = compress.find((call) => call.toolCallId === ACCEPTED_SECOND.id)!;
	assert.deepEqual(sibling.ours?.createdIds, ["b1"]);
	// The sibling claims a block the request does not have, and the request names the sibling as refused too.
	const forgedCall = { ...sibling, ours: { ...sibling.ours!, createdIds: ["b9"] } };
	const forgedRequest = { ...request, refused: [...request.refused!, { toolCallId: ACCEPTED_SECOND.id, type: "dead-range" as const }] };
	const report = buildFoldParityReport([...records.filter((record) => record !== sibling && record !== request), forgedCall, forgedRequest, ...fillers.slice(2)], PARITY_REGISTER, PROBE);
	assert.deepEqual(report.counts, { match: 498, explained: 0, diff: 0, inconclusive: 2 });
	assert.ok(report.blocking.some((blocked) => blocked.toolCallId === "accepted-second"));
	assert.match(report.text, /accepted-second/u);
});
