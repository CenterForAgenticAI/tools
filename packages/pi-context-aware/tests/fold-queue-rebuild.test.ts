import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { applyFoldDrafts, planQueuedFolds, registerFoldEngine, type FoldEngine, type FoldRequest } from "../src/folds/fold-engine.js";
import { entryToCoreMessages } from "../src/folds/fold-adapter.js";
import {
	FOLD_ENTRY_TYPE,
	MAX_CALL_ID_LENGTH,
	checkFoldRequestId,
	coveredEntryIds,
	foldRecordsOnBranch,
	isEditableEntry,
	makeFoldRequestId,
	readFoldRecord,
	type FoldRecord,
} from "../src/folds/fold-entries.js";
import {
	FOLD_REQUEST_RECOVERY_KIND,
	MAX_RECOVERY_COVERED_IDS_PER_RECORD,
	MAX_RECOVERY_COVERED_IDS_PER_SCAN,
	MAX_RECOVERY_RECORDS_PER_SCAN,
	foldRequestDetails,
	parseFoldRequestRecovery,
	recoverFoldRequests,
	scanFoldRequests,
	type FoldRequestRecovery,
} from "../src/folds/fold-recovery.js";
import type { Config } from "../src/folds/kernel/index.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";

// A fold tool result can be saved while the engine's in-memory queue is lost
// (a durable worker restart). Recovery reads only the record the engine made
// when it accepted the request, saved in the tool result details. These tests
// drive the engine's own handlers against a real SessionManager on temp files.

const CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};
const SUMMARY = "Summary of the opening exchanges: alpha and beta were settled between user and assistant.";
const SUMMARY_B = "Summary of the later exchanges: gamma and delta were settled between user and assistant.";

function tempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-rebuild-")));
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	readonly engine: FoldEngine;
	/** Fire one event the way Pi does; returns the handler's result. */
	fire(name: string, manager: SessionManager, event?: Record<string, unknown>): { entries: SessionBoundaryDraft[] } | undefined;
	ctx(manager: SessionManager): ExtensionContext;
}

const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";

/** A new engine on a fake Pi: a fresh process, with an empty queue. */
function boot(shadow = false): Harness {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => shadow
			? ["compress", "acp_status"].map((name) => ({ name, sourceInfo: { path: BCP_PATH } }))
			: [],
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, { config: CONFIG });
	const ctx = (manager: SessionManager) => ({ cwd: manager.getCwd(), sessionManager: manager, model: undefined }) as unknown as ExtensionContext;
	return {
		engine,
		ctx,
		fire(name, manager, event = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = handler({ type: name, ...event }, ctx(manager)) ?? result;
			return result as { entries: SessionBoundaryDraft[] } | undefined;
		},
	};
}

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function assistant(manager: SessionManager, text: string): string {
	return manager.appendMessage(fauxAssistantMessage(text));
}

/** Pairs of user and assistant messages: refs m00001.. in order, two per exchange. */
function exchanges(manager: SessionManager, count: number, label = "QUESTION"): string[] {
	const ids: string[] = [];
	for (let index = 1; index <= count; index++) {
		ids.push(user(manager, label + "-" + index + " about topic " + index));
		ids.push(assistant(manager, label.replace("QUESTION", "ANSWER") + "-" + index + " with details " + index));
	}
	return ids;
}

/** What a fold tool does: save the call and a successful result whose details hold the engine's records. */
function saveFoldCall(manager: SessionManager, callId: string, recoveries: readonly FoldRequestRecovery[], toolName = "context_fold", isError = false): void {
	// The arguments are deliberately unrelated to the record: recovery must not read them.
	manager.appendMessage(fauxAssistantMessage(fauxToolCall(toolName, { folds: [{ from: "m99998", to: "m99999", summary: "WRONG-ARGUMENT-SUMMARY" }] }, { id: callId }), { stopReason: "toolUse" }));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "folded" }],
		...(recoveries.length > 0 ? { details: foldRequestDetails(recoveries) as never } : {}),
		isError,
		timestamp: Date.now(),
	});
}

/** The engine accepts the item and returns its record. */
function accept(harness: Harness, manager: SessionManager, callId: string, index: number, startRef: string, endRef: string, summary = SUMMARY): FoldRequestRecovery {
	const made = makeFoldRequestId(callId, index);
	assert.ok(made.ok, JSON.stringify(made));
	const request: FoldRequest = { startRef, endRef, summary, requestId: made.requestId };
	const result = harness.engine.request(harness.ctx(manager), request);
	assert.ok(result.ok && result.queued, JSON.stringify(result));
	assert.ok(result.recovery, "an accepted live request with an id returns its recovery record");
	return result.recovery;
}

function foldRecords(manager: SessionManager): FoldRecord[] {
	return foldRecordsOnBranch(manager.getBranch()).map(({ record }) => record);
}

/** Text the model sees from user and assistant text messages; tool calls and results are left out. */
function contextText(manager: SessionManager): string {
	return manager.buildSessionContext().messages.flatMap((message) => {
		if (message.role === "user") return [typeof message.content === "string" ? message.content : JSON.stringify(message.content)];
		if (message.role === "assistant") return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
		return [];
	}).join("\n");
}

function openFile(file: string, sessionDir: string): SessionManager {
	return SessionManager.open(file, sessionDir);
}

/** Run a boundary the way Pi does and append what the handler returns. */
function boundary(harness: Harness, manager: SessionManager): SessionBoundaryDraft[] {
	const result = harness.fire("turn_end", manager, { entries: [] });
	const drafts = result?.entries ?? [];
	applyFoldDrafts(manager, drafts);
	return drafts;
}

function foldEntryCount(manager: SessionManager): number {
	return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE).length;
}

/** Run a test body on a persisted session in a temp dir. */
function withSession(body: (manager: SessionManager, file: string, sessionDir: string) => void): void {
	const cwd = tempDir();
	const sessionDir = path.join(cwd, "sessions");
	try {
		const manager = SessionManager.create(cwd, sessionDir);
		const file = manager.getSessionFile();
		assert.ok(file, "the session must be persisted");
		body(manager, file, sessionDir);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("a restart between the accepted request and the drain still writes the fold, once", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 3); // m00001..m00006
		const first = boot();
		const recovery = accept(first, manager, "call_fold_1", 0, "m00001", "m00004");
		assert.equal(recovery.kind, FOLD_REQUEST_RECOVERY_KIND);
		assert.equal(recovery.requestId, "call_fold_1#0");
		assert.equal(recovery.coveredEntryIds.length, 3, "the opening user message is kept by default, so three entries fold");
		saveFoldCall(manager, "call_fold_1", [recovery]);
		exchanges(manager, 1, "TAILQ");
		assert.equal(first.engine.pending(first.ctx(manager)), 1);
		assert.equal(foldRecords(manager).length, 0, "nothing was written before the crash");

		// Restart: a new process, an empty queue, the same file.
		const reopened = openFile(file, sessionDir);
		const second = boot();
		assert.equal(second.engine.pending(second.ctx(reopened)), 0, "a restarted engine starts with an empty queue");
		second.fire("session_start", reopened, { reason: "resume" });
		assert.equal(second.engine.pending(second.ctx(reopened)), 1, "the saved record is queued again");

		const drafts = boundary(second, reopened);
		assert.ok(drafts.length > 0, "the recovered request drains at the next boundary");
		const records = foldRecords(reopened);
		assert.equal(records.length, 1, "exactly one fold on the branch");
		assert.equal(records[0]?.requestId, "call_fold_1#0", "the fold records the request id");
		assert.deepEqual(coveredEntryIds(records[0]!), recovery.coveredEntryIds, "the fold hides exactly the recorded entries");
		assert.match(contextText(reopened), /Summary of the opening exchanges/u);
		assert.doesNotMatch(contextText(reopened), /ANSWER-1 |QUESTION-2 |ANSWER-2 /u);
		assert.match(contextText(reopened), /QUESTION-1 /u, "the kept opening message stays");
		assert.match(contextText(reopened), /QUESTION-3 /u, "the entries after the range stay");
		assert.deepEqual(second.engine.dropped(second.ctx(reopened)), []);

		// A further restart and boundary finds the id on the branch and writes nothing more.
		const again = openFile(file, sessionDir);
		const third = boot();
		third.fire("session_start", again, { reason: "resume" });
		assert.equal(third.engine.pending(third.ctx(again)), 0, "a fold that is already written is not queued again");
		assert.equal(boundary(third, again).length, 0);
		assert.equal(foldEntryCount(again), 1);
	});
});

test("draining the same request twice writes one fold and reports nothing dropped", () => {
	withSession((manager) => {
		exchanges(manager, 3);
		const request: FoldRequest = { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_twice#0" };

		// Through the engine: the tool run is replayed, so the same id is queued twice.
		const harness = boot();
		const firstResult = harness.engine.request(harness.ctx(manager), request);
		const secondResult = harness.engine.request(harness.ctx(manager), request);
		assert.ok(firstResult.ok && !firstResult.replayed && firstResult.recovery, JSON.stringify(firstResult));
		assert.ok(secondResult.ok && secondResult.replayed === true && secondResult.queued, JSON.stringify(secondResult));
		assert.deepEqual(secondResult.recovery, firstResult.recovery, "the replay gets the existing record back");
		assert.equal(harness.engine.pending(harness.ctx(manager)), 1, "a replay of a queued id queues nothing new");
		assert.ok(boundary(harness, manager).length > 0);
		assert.equal(foldRecords(manager).length, 1, "two requests with one id make one fold");
		assert.deepEqual(harness.engine.dropped(harness.ctx(manager)), [], "the repeat is skipped, not reported as an error");

		// The same request queued again after the fold was written: reported as written, nothing queued.
		const replay = harness.engine.request(harness.ctx(manager), request);
		assert.ok(replay.ok && !replay.queued && replay.recovery === undefined, JSON.stringify(replay));
		assert.equal(boundary(harness, manager).length, 0);
		assert.equal(foldRecords(manager).length, 1);

		// Straight through the planner: the same array drained twice.
		const queue = [request];
		assert.equal(planQueuedFolds(manager, queue, 64_000, CONFIG).drafts.length, 0);
		assert.deepEqual(planQueuedFolds(manager, queue, 64_000, CONFIG), { drafts: [], dropped: [] });
		assert.equal(foldRecords(manager).length, 1);
	});
});

test("requests without an id keep today's behaviour and return no recovery record", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 3);
	const harness = boot();
	const result = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY });
	assert.ok(result.ok && result.queued);
	assert.equal(result.recovery, undefined, "an id-less request cannot be recovered, so it gets no record");
	const request = { startRef: "m00001", endRef: "m00004", summary: SUMMARY };
	const plan = planQueuedFolds(manager, [request], 64_000, CONFIG);
	assert.equal(plan.dropped.length, 0);
	applyFoldDrafts(manager, plan.drafts);
	assert.equal(foldRecords(manager)[0]?.requestId, undefined, "no id was given, so none is recorded");
	const repeat = planQueuedFolds(manager, [request], 64_000, CONFIG);
	assert.equal(repeat.drafts.length, 0, "a range that is already folded is still refused");
	assert.equal(repeat.dropped.length, 1, "and still reported");
});

test("a call with several folds gets one record per item, and each is written once", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 5);
		const harness = boot();
		const first = accept(harness, manager, "call_multi", 0, "m00001", "m00004");
		const second = accept(harness, manager, "call_multi", 1, "m00005", "m00008", SUMMARY_B);
		saveFoldCall(manager, "call_multi", [first, second]);
		exchanges(manager, 1, "TAILQ");
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 2);
		assert.ok(boundary(restarted, reopened).length > 0);
		assert.deepEqual(restarted.engine.dropped(restarted.ctx(reopened)), []);
		assert.deepEqual(foldRecords(reopened).map((record) => record.requestId), ["call_multi#0", "call_multi#1"]);
		assert.deepEqual(recoverFoldRequests(reopened.getBranch()), [], "both items are on the branch");
	});
});

// ---- the six review findings, as regression tests ----------------------------------------------

test("review 1: billion-context-pi's compress results never match, however their arguments or details look", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 3);
	// The legacy shape: arguments name refs, the result has no engine record.
	manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("compress", { content: [{ startId: "m00004", endId: "m00005", summary: SUMMARY }] }, { id: "call_bcp" }), { stopReason: "toolUse" }));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_bcp", toolName: "compress", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() });
	// Its result details do not hold the record either, even when they carry look-alike keys.
	manager.appendMessage({
		role: "toolResult", toolCallId: "call_bcp2", toolName: "compress", content: [{ type: "text", text: "ok" }],
		details: { startId: "m00004", endId: "m00005", summary: SUMMARY, blockId: "b1" } as never, isError: false, timestamp: Date.now(),
	});
	assert.deepEqual(recoverFoldRequests(manager.getBranch()), []);
	const harness = boot();
	harness.fire("session_start", manager, { reason: "resume" });
	assert.equal(harness.engine.pending(harness.ctx(manager)), 0);
	assert.equal(boundary(harness, manager).length, 0);
	assert.equal(foldRecords(manager).length, 0, "nothing was folded from a legacy compress call");
});

test("review 2: an earlier unwritten request whose range overlaps a written fold is dropped, and the fold stays", () => {
	withSession((manager, file, sessionDir) => {
		const ids = exchanges(manager, 4); // m00001..m00008
		const harness = boot();
		// Earlier request A: m00001..m00004. It is accepted, then the process dies before the drain.
		const a = accept(harness, manager, "call_a", 0, "m00001", "m00004");
		saveFoldCall(manager, "call_a", [a]);
		// Later request B: m00003..m00006, written as b1 by an earlier drain.
		const b = planQueuedFolds(manager, [{ startRef: "m00003", endRef: "m00006", summary: SUMMARY_B, requestId: "call_b#0" }], 64_000, CONFIG);
		assert.equal(b.dropped.length, 0, JSON.stringify(b.dropped));
		applyFoldDrafts(manager, b.drafts);
		const [written] = foldRecords(manager);
		assert.ok(written && written.blockId === "b1");
		const before = JSON.stringify(manager.getBranch().filter((entry) => entry.type === "custom"));
		const hiddenBefore = contextText(manager);
		assert.ok(ids.length > 0);

		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1, "the earlier request is recovered");
		assert.equal(boundary(restarted, reopened).length, 0, "and writes nothing");
		const dropped = restarted.engine.dropped(restarted.ctx(reopened));
		assert.equal(dropped.length, 1);
		assert.equal(dropped[0]?.code, "coverage-changed");
		assert.equal(dropped[0]?.requestId, "call_a#0");
		assert.match(dropped[0]?.errors[0] ?? "", /coverage-changed/u);
		assert.deepEqual(foldRecords(reopened).map((record) => record.blockId), ["b1"], "b1 is not absorbed by a wider fold");
		assert.equal(JSON.stringify(reopened.getBranch().filter((entry) => entry.type === "custom")), before, "fold entries are unchanged");
		assert.equal(contextText(reopened), hiddenBefore, "the model context is unchanged");
		assert.doesNotMatch(contextText(reopened), /Summary of the opening exchanges/u);

		// The drop repeats on the next restart without writing anything: see the handoff for why.
		const again = openFile(file, sessionDir);
		const third = boot();
		third.fire("session_start", again, { reason: "resume" });
		assert.equal(boundary(third, again).length, 0);
		assert.equal(third.engine.dropped(third.ctx(again))[0]?.code, "coverage-changed");
		assert.equal(foldEntryCount(again), 1);
	});
});

test("review 3: a refused request leaves no record and is never folded later", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 2); // m00001..m00004; the last two messages are protected
		const harness = boot();
		const refused = harness.engine.request(harness.ctx(manager), { startRef: "m00003", endRef: "m00004", summary: SUMMARY, requestId: "call_refused#0" });
		assert.equal(refused.ok, false, "the protected recent messages refuse this range");
		assert.equal("recovery" in refused, false);
		assert.equal(harness.engine.pending(harness.ctx(manager)), 0);
		// The tool saved its result with isError false and nothing in details.
		saveFoldCall(manager, "call_refused", []);
		// More messages arrive, so the same refs are no longer protected. Then a restart.
		exchanges(manager, 3, "TAILQ");
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 0);
		assert.equal(boundary(restarted, reopened).length, 0);
		assert.equal(foldRecords(reopened).length, 0, "a refusal does not become a fold after a restart");
	});
});

test("review 4: call 'same' item 0 and call 'same#0' item 0 stay distinct", () => {
	const one = makeFoldRequestId("same", 0);
	const two = makeFoldRequestId("same#0", 0);
	assert.ok(one.ok && two.ok);
	assert.equal(one.requestId, "same#0");
	assert.equal(two.requestId, "same#0#0");
	const first = checkFoldRequestId("same#0");
	const second = checkFoldRequestId("same#0#0");
	assert.ok(first.ok && second.ok);
	assert.deepEqual([first.callId, first.index], ["same", 0]);
	assert.deepEqual([second.callId, second.index], ["same#0", 0]);
	assert.equal(checkFoldRequestId("same").ok, false, "an unsuffixed id is not a request id");

	withSession((manager, file, sessionDir) => {
		exchanges(manager, 5);
		const harness = boot();
		const a = accept(harness, manager, "same", 0, "m00001", "m00004");
		const b = accept(harness, manager, "same#0", 0, "m00005", "m00008", SUMMARY_B);
		saveFoldCall(manager, "same", [a]);
		saveFoldCall(manager, "same#0", [b]);
		exchanges(manager, 1, "TAILQ");
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 2, "both calls are recovered");
		boundary(restarted, reopened);
		assert.deepEqual(restarted.engine.dropped(restarted.ctx(reopened)), []);
		assert.deepEqual(foldRecords(reopened).map((record) => record.requestId), ["same#0", "same#0#0"]);
	});
});

test("review 4b: a record cannot carry another call's ids", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 4);
	const harness = boot();
	const record = accept(harness, manager, "call_owner", 0, "m00001", "m00004");
	saveFoldCall(manager, "call_other", [record]);
	assert.deepEqual(recoverFoldRequests(manager.getBranch()), [], "the result belongs to call_other, the record to call_owner");
});

test("review 5: a call id too long for a suffix is an explicit error, not a silent drop", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 3);
	const harness = boot();
	const ok = makeFoldRequestId("c".repeat(MAX_CALL_ID_LENGTH), 0);
	assert.ok(ok.ok, "the longest call id that leaves room for #<index> works");
	assert.equal(ok.requestId.length, MAX_CALL_ID_LENGTH + 2);
	assert.ok(harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: ok.requestId }).ok);

	for (const callId of ["c".repeat(MAX_CALL_ID_LENGTH + 1), "c".repeat(256), "c".repeat(300)]) {
		const made = makeFoldRequestId(callId, 0);
		assert.equal(made.ok, false, "call id of " + callId.length);
		const direct = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: callId + "#0" });
		assert.equal(direct.ok, false);
		assert.ok(!direct.ok && /tool call id is \d+ characters/u.test(direct.errors[0] ?? ""), JSON.stringify(direct));
	}
	// Any other malformed id is also an error and is not queued.
	for (const requestId of ["", "no-suffix", "x#", "x#01", "x#-1", "x#1000", "#0", "x#a"]) {
		const result = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId });
		assert.equal(result.ok, false, "requestId " + JSON.stringify(requestId));
	}
	assert.equal(harness.engine.pending(harness.ctx(manager)), 1, "only the valid id was queued");
});

test("review 6: one malformed entry or message does not stop the other recoveries", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 5);
	const harness = boot();
	const good = accept(harness, manager, "call_good", 0, "m00001", "m00004");
	const later = accept(harness, manager, "call_later", 0, "m00005", "m00008", SUMMARY_B);
	saveFoldCall(manager, "call_good", [good]);
	const real = manager.getBranch();
	const hostile = {
		type: "message", id: "hostile",
		message: { role: "toolResult", toolCallId: "call_hostile", get details(): unknown { throw new Error("boom"); } },
	};
	const broken = [
		...real,
		null,
		42,
		"entry",
		{ type: "message", id: "m1", message: null },
		{ type: "message", id: "m2" },
		{ type: "message", id: "m3", message: { role: "toolResult", toolCallId: 7, details: good } },
		{ type: "message", id: "m4", message: { role: "toolResult", toolCallId: "x", details: { foldRequests: "no" } } },
		{ type: "message", id: "m5", message: { role: "toolResult", toolCallId: "x", details: { foldRequests: [null, 3, { kind: FOLD_REQUEST_RECOVERY_KIND }] } } },
		{ type: "custom", id: "c1", customType: FOLD_ENTRY_TYPE, data: null },
		hostile,
		{
			type: "message", id: "m6",
			message: { role: "toolResult", toolCallId: "call_later", toolName: "any_tool", content: [], isError: false, timestamp: 1, details: later },
		},
	] as unknown as SessionEntry[];
	let recovered: ReturnType<typeof recoverFoldRequests> = [];
	assert.doesNotThrow(() => { recovered = recoverFoldRequests(broken); });
	assert.deepEqual(recovered.map((item) => item.recovery.requestId), ["call_good#0", "call_later#0"]);
	assert.deepEqual(recoverFoldRequests(null as never), []);
	assert.deepEqual(recoverFoldRequests([null, undefined] as never), []);
});

// ---- more safety and shape checks --------------------------------------------------------------

test("a record that names an entry no longer on the branch is dropped as entry-missing", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 4);
	const harness = boot();
	const record = accept(harness, manager, "call_gone", 0, "m00001", "m00004");
	const forged: FoldRequestRecovery = { ...record, coveredEntryIds: [...record.coveredEntryIds, "deadbeef"], endEntryId: "deadbeef" };
	saveFoldCall(manager, "call_gone", [forged]);
	const restarted = boot();
	restarted.fire("session_start", manager, { reason: "resume" });
	assert.equal(restarted.engine.pending(restarted.ctx(manager)), 1);
	assert.equal(boundary(restarted, manager).length, 0);
	assert.equal(restarted.engine.dropped(restarted.ctx(manager))[0]?.code, "entry-missing");
	assert.equal(foldRecords(manager).length, 0);
});

test("only results after the newest compaction are recovered", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = exchanges(manager, 4);
	const harness = boot();
	const record = accept(harness, manager, "call_old", 0, "m00001", "m00004");
	saveFoldCall(manager, "call_old", [record]);
	assert.equal(recoverFoldRequests(manager.getBranch()).length, 1);
	manager.appendCompaction("summary of everything before", ids[6]!, 1000);
	assert.deepEqual(recoverFoldRequests(manager.getBranch()), []);
});

test("a fold of folds is recovered at the same tier", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 6); // m00001..m00012
	const planned = planQueuedFolds(manager, [
		{ startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_one#0" },
		{ startRef: "m00005", endRef: "m00008", summary: SUMMARY_B, requestId: "call_two#0" },
	], 64_000, CONFIG);
	assert.equal(planned.dropped.length, 0, JSON.stringify(planned.dropped));
	applyFoldDrafts(manager, planned.drafts);
	assert.deepEqual(foldRecords(manager).map((record) => record.blockId), ["b1", "b2"]);
	const harness = boot();
	const record = accept(harness, manager, "call_blocks", 0, "b1", "b2", "Summary of both earlier folds: alpha through delta, all settled.");
	assert.equal(record.startBlockId, "b1");
	assert.equal(record.endBlockId, "b2");
	saveFoldCall(manager, "call_blocks", [record]);
	const restarted = boot();
	restarted.fire("session_start", manager, { reason: "resume" });
	assert.equal(restarted.engine.pending(restarted.ctx(manager)), 1);
	boundary(restarted, manager);
	assert.deepEqual(restarted.engine.dropped(restarted.ctx(manager)), [], JSON.stringify(restarted.engine.dropped(restarted.ctx(manager))));
	const records = foldRecords(manager);
	assert.equal(records.length, 3);
	assert.equal(records[2]?.tier, 2, "folding two folds makes a tier 2 fold");
	assert.equal(records[2]?.requestId, "call_blocks#0");
});

test("the strict parser accepts the engine's record and nothing looser", () => {
	const good = {
		kind: FOLD_REQUEST_RECOVERY_KIND, requestId: "call_1#0", startRef: "m00001", endRef: "m00004", startEntryId: "a", endEntryId: "c",
		coveredEntryIds: ["a", "b", "c"], sourceDigest: "0".repeat(63) + "a", summary: "s", topic: "t",
	};
	assert.deepEqual(parseFoldRequestRecovery({ ...good, extra: "dropped", __proto__: { polluted: true } }), good);
	assert.equal("topic" in (parseFoldRequestRecovery({ ...good, topic: undefined }) ?? { topic: 1 }), false);
	const bad: unknown[] = [
		undefined, null, "x", 7, [], {}, { ...good, kind: "other" }, { ...good, kind: undefined },
		{ ...good, requestId: "call_1" }, { ...good, requestId: 5 }, { ...good, requestId: "c".repeat(300) + "#0" },
		{ ...good, startEntryId: "" }, { ...good, endEntryId: 5 }, { ...good, summary: "" }, { ...good, topic: "" }, { ...good, topic: 5 },
		{ ...good, coveredEntryIds: [] }, { ...good, coveredEntryIds: "a" }, { ...good, coveredEntryIds: ["a", "a", "c"] },
		{ ...good, coveredEntryIds: ["a", 3, "c"] }, { ...good, coveredEntryIds: ["a", "b"] }, { ...good, startEntryId: "z" },
		{ ...good, startBlockId: "x1" }, { ...good, endBlockId: 3 },
		// The source digest is required, exactly 64 lower-case hex characters.
		{ ...good, sourceDigest: undefined }, { ...good, sourceDigest: "0".repeat(63) }, { ...good, sourceDigest: "A".repeat(64) }, { ...good, sourceDigest: 5 },
		{ ...good, startRef: "" }, { ...good, endRef: undefined }, { ...good, startRef: "m".repeat(65) },
		// A record of the earlier version has no digest and is not read.
		{ ...good, kind: "context-aware.fold-request.v1", sourceDigest: undefined },
		{ ...good, kind: "context-aware.fold-request.v1" },
		// More entry ids than a record may name.
		{ ...good, coveredEntryIds: Array.from({ length: MAX_RECOVERY_COVERED_IDS_PER_RECORD + 1 }, (_, index) => "e" + index), startEntryId: "e0", endEntryId: "e1" },
	];
	for (const value of bad) assert.equal(parseFoldRequestRecovery(value), undefined, String(JSON.stringify(value)).slice(0, 200));
	// The largest record is accepted: 5000 distinct ids.
	const largest = { ...good, coveredEntryIds: Array.from({ length: 5_000 }, (_, index) => "e" + index), startEntryId: "e0", endEntryId: "e4999" };
	assert.equal(parseFoldRequestRecovery(largest)?.coveredEntryIds.length, 5_000);
	assert.equal(MAX_RECOVERY_COVERED_IDS_PER_RECORD, 5_000);
	const hostile = { get kind(): unknown { throw new Error("boom"); } };
	assert.equal(parseFoldRequestRecovery(hostile), undefined);
	assert.equal(foldRequestDetails([]), undefined);
});

test("shadow mode queues nothing, returns no record, and writes nothing", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 3);
		const live = boot();
		const record = accept(live, manager, "call_shadow", 0, "m00001", "m00004");
		saveFoldCall(manager, "call_shadow", [record]);
		const before = fs.readFileSync(file, "utf8");
		const reopened = openFile(file, sessionDir);
		const harness = boot(true);
		harness.fire("session_start", reopened, { reason: "resume" });
		assert.equal(harness.engine.mode(harness.ctx(reopened)), "shadow");
		assert.equal(harness.engine.pending(harness.ctx(reopened)), 0, "shadow mode queues nothing");
		const result = harness.engine.request(harness.ctx(reopened), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_s2#0" });
		assert.ok(result.ok && !result.queued && result.recovery === undefined, JSON.stringify(result));
		assert.equal(harness.fire("turn_end", reopened, { entries: [] }), undefined);
		assert.equal(harness.fire("agent_before_settle", reopened, { entries: [] }), undefined);
		assert.equal(foldRecords(reopened).length, 0);
		assert.equal(fs.readFileSync(file, "utf8"), before, "the session file is unchanged");
	});
});

test("a fold entry written before request ids existed still parses and stays in effect", () => {
	const base = {
		version: 1, blockId: "b1", runId: "r1", tier: 1, carrierId: "a", hiddenIds: ["b"],
		range: { startId: "a", endId: "b" }, refs: { start: "m00001", end: "m00002" },
		directBlockIds: [], compressedTokens: 10, createdAt: 1, origin: "fold",
	};
	const old = readFoldRecord(base);
	assert.ok(old);
	assert.equal(old.requestId, undefined);
	assert.equal("requestId" in old, false, "no id key is invented");
	assert.equal(readFoldRecord({ ...base, requestId: "call_1#0" })?.requestId, "call_1#0");
	for (const requestId of [7, null, {}, "", "x".repeat(1_000)]) {
		const record = readFoldRecord({ ...base, requestId });
		assert.ok(record, "a bad id does not void the fold");
		assert.equal(record.requestId, undefined);
	}

	// An old fold on the branch, written without an id, beside a new request with one.
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 5);
	const oldPlan = planQueuedFolds(manager, [{ startRef: "m00001", endRef: "m00002", summary: SUMMARY }], 64_000, CONFIG);
	applyFoldDrafts(manager, oldPlan.drafts);
	assert.equal(foldRecords(manager)[0]?.requestId, undefined);
	const fresh = planQueuedFolds(manager, [{ startRef: "m00003", endRef: "m00004", summary: SUMMARY, requestId: "call_new#0" }], 64_000, CONFIG);
	assert.equal(fresh.dropped.length, 0, JSON.stringify(fresh.dropped));
	applyFoldDrafts(manager, fresh.drafts);
	assert.deepEqual(foldRecords(manager).map((record) => record.requestId), [undefined, "call_new#0"]);
	assert.equal(foldEntryCount(manager), 2);
});

// ---- #172 round 2: branch provenance, source digest, replay, rebuild on navigation ------------------

/** Four exchanges: A = m00001..m00004 is the range the tests fold. */
function acceptedOnBranchA(harness: Harness, manager: SessionManager, callId = "call_a"): { recovery: FoldRequestRecovery; shared: string } {
	const ids = exchanges(manager, 3); // m00001..m00006
	const shared = ids[ids.length - 1]!;
	const recovery = accept(harness, manager, callId, 0, "m00001", "m00004");
	saveFoldCall(manager, callId, [recovery]);
	exchanges(manager, 1, "TAILA");
	return { recovery, shared };
}

test("B1: a recovered request is not written to a sibling branch, and still is on its own", () => {
	withSession((manager, file, sessionDir) => {
		const { recovery, shared } = acceptedOnBranchA(boot(), manager);
		const leafA = manager.getLeafId();
		assert.ok(leafA);
		const reopened = openFile(file, sessionDir);
		reopened.branch(shared);
		user(reopened, "BRANCH-B-ONLY");
		assistant(reopened, "BRANCH-B-ANSWER");
		const leafB = reopened.getLeafId();
		assert.ok(leafB);

		// Restarted on branch A: the record is queued. Moving to B rebuilds the queue from B's records.
		reopened.branch(leafA);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1);
		reopened.branch(leafB);
		restarted.fire("session_tree", reopened, { newLeafId: leafB, oldLeafId: leafA });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 0, "branch B has no record, so nothing is queued for it");
		assert.equal(boundary(restarted, reopened).length, 0);
		assert.equal(foldEntryCount(reopened), 0, "nothing was written to either branch");
		assert.doesNotMatch(contextText(reopened), /Summary of the opening exchanges/u);

		// Back on A the record is read again and the fold is written there.
		reopened.branch(leafA);
		restarted.fire("session_tree", reopened, { newLeafId: leafA, oldLeafId: leafB });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1);
		assert.ok(boundary(restarted, reopened).length > 0);
		assert.deepEqual(foldRecords(reopened).map((record) => record.requestId), ["call_a#0"]);
		assert.deepEqual(coveredEntryIds(foldRecords(reopened)[0]!), recovery.coveredEntryIds);
		reopened.branch(leafB);
		assert.deepEqual(foldRecords(reopened), [], "branch B still has no fold");
	});
});

test("B1: with no navigation event, the drain still refuses an item whose branch is gone", () => {
	// A recovered item: its tool result is not on the branch any more.
	withSession((manager, file, sessionDir) => {
		const { shared } = acceptedOnBranchA(boot(), manager);
		const leafA = manager.getLeafId();
		const reopened = openFile(file, sessionDir);
		reopened.branch(leafA!);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1);
		reopened.branch(shared);
		assert.equal(boundary(restarted, reopened).length, 0);
		const [drop] = restarted.engine.dropped(restarted.ctx(reopened));
		assert.equal(drop?.code, "branch-changed");
		assert.equal(drop?.requestId, "call_a#0");
		assert.equal(foldEntryCount(reopened), 0);
	});
	// A live item: the leaf it was accepted on is not on the branch any more.
	const manager = SessionManager.inMemory("/tmp");
	const ids = exchanges(manager, 3);
	const harness = boot();
	assert.ok(harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_live#0" }).ok);
	manager.branch(ids[4]!); // a point before the leaf the request was accepted on; the range itself is still there
	assert.equal(boundary(harness, manager).length, 0);
	const [drop] = harness.engine.dropped(harness.ctx(manager));
	assert.equal(drop?.code, "branch-changed");
	assert.equal(foldRecords(manager).length, 0);
});

test("B1: a tree navigation discards live items accepted on the old branch", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = exchanges(manager, 3);
	const harness = boot();
	const result = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_live#0" });
	assert.ok(result.ok && result.queued);
	assert.equal(harness.engine.pending(harness.ctx(manager)), 1);
	manager.branch(ids[4]!);
	harness.fire("session_tree", manager, { newLeafId: ids[4], oldLeafId: ids[5] });
	assert.equal(harness.engine.pending(harness.ctx(manager)), 0, "the queue is rebuilt from the records on the new branch, and there are none");
	assert.equal(boundary(harness, manager).length, 0);
});

test("B2: a replay of an accepted request id never plans a second, different fold", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 5); // m00001..m00010
		const first = boot();
		const recovery = accept(first, manager, "call_a", 0, "m00001", "m00004");
		saveFoldCall(manager, "call_a", [recovery]);
		// A later request overlapping the range was written first.
		const later = planQueuedFolds(manager, [{ startRef: "m00003", endRef: "m00006", summary: SUMMARY_B, requestId: "call_b#0" }], 64_000, CONFIG);
		assert.equal(later.dropped.length, 0);
		applyFoldDrafts(manager, later.drafts);
		assert.equal(foldRecords(manager).length, 1);

		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(boundary(restarted, reopened).length, 0, "the recovered request is dropped");
		assert.equal(restarted.engine.dropped(restarted.ctx(reopened))[0]?.code, "coverage-changed");

		// The durable worker runs the tool call again with the same id.
		const replay = restarted.engine.request(restarted.ctx(reopened), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_a#0" });
		assert.equal(replay.ok, false, JSON.stringify(replay));
		assert.ok(!replay.ok && replay.code === "coverage-changed" && /coverage-changed/u.test(replay.errors[0] ?? ""), JSON.stringify(replay));
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 0);
		assert.equal(boundary(restarted, reopened).length, 0, "nothing is queued, so nothing is written");
		assert.deepEqual(foldRecords(reopened).map((record) => record.blockId), ["b1"]);
		assert.equal(foldEntryCount(reopened), 1);
	});
});

test("B2: a replay with the same coverage and source returns the existing result and writes nothing new", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 4);
		const first = boot();
		const recovery = accept(first, manager, "call_a", 0, "m00001", "m00004");
		saveFoldCall(manager, "call_a", [recovery]);
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		const args = { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_a#0" };
		// Already queued (recovered): the same request again.
		const queued = restarted.engine.request(restarted.ctx(reopened), args);
		assert.ok(queued.ok && queued.replayed === true && queued.queued, JSON.stringify(queued));
		assert.deepEqual(queued.recovery, recovery);
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1, "still one item");
		// The same id with another summary is another fold: refused.
		const other = restarted.engine.request(restarted.ctx(reopened), { ...args, summary: SUMMARY_B });
		assert.ok(!other.ok && other.code === "source-changed", JSON.stringify(other));
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1);
		assert.ok(boundary(restarted, reopened).length > 0);
		assert.equal(foldEntryCount(reopened), 1);
		// Already written: the same request again reports the fold, queues nothing.
		const written = restarted.engine.request(restarted.ctx(reopened), args);
		assert.ok(written.ok && written.replayed === true && !written.queued && written.recovery === undefined, JSON.stringify(written));
		assert.deepEqual(written.blockIds, ["b1"]);
		// Written, and a different range under the same id: refused.
		const moved = restarted.engine.request(restarted.ctx(reopened), { ...args, startRef: "m00005", endRef: "m00006" });
		assert.ok(!moved.ok && moved.code === "coverage-changed", JSON.stringify(moved));
		assert.equal(boundary(restarted, reopened).length, 0);
		assert.equal(foldEntryCount(reopened), 1);
	});
});

test("B3: the same entry ids over a rewritten block summary are dropped as source-changed", () => {
	for (const rewrite of [false, true]) {
		const manager = SessionManager.inMemory("/tmp");
		exchanges(manager, 6);
		const planned = planQueuedFolds(manager, [
			{ startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_one#0" },
			{ startRef: "m00005", endRef: "m00008", summary: SUMMARY_B, requestId: "call_two#0" },
		], 64_000, CONFIG);
		applyFoldDrafts(manager, planned.drafts);
		const [b1] = foldRecords(manager);
		assert.equal(b1?.blockId, "b1");
		const harness = boot();
		const record = accept(harness, manager, "call_blocks", 0, "b1", "b2", "Summary of both earlier folds: alpha through delta, all settled.");
		saveFoldCall(manager, "call_blocks", [record]);
		if (rewrite) manager.appendContextEdit(b1!.carrierId, { content: [{ type: "text", text: "REWRITTEN source summary: alpha was reversed." }] });
		const restarted = boot();
		restarted.fire("session_start", manager, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(manager)), 1);
		const drafts = boundary(restarted, manager);
		const dropped = restarted.engine.dropped(restarted.ctx(manager));
		if (rewrite) {
			assert.equal(drafts.length, 0, "the aggregate was written over the old summary");
			assert.equal(dropped[0]?.code, "source-changed");
			assert.equal(foldRecords(manager).length, 2);
		} else {
			assert.deepEqual(dropped, []);
			assert.equal(foldRecords(manager).length, 3, "unchanged source: the tier 2 fold is written");
		}
	}
});

/** A fold call saved with the given result status, then a restarted engine on the same branch. */
function restartAfterFoldCall(isError: boolean): { manager: SessionManager; restarted: Harness } {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 4);
	const record = accept(boot(), manager, "call_err", 0, "m00001", "m00004");
	saveFoldCall(manager, "call_err", [record], "context_fold", isError);
	const restarted = boot();
	restarted.fire("session_start", manager, { reason: "resume" });
	return { manager, restarted };
}

test("records inside a failed tool result are ignored, and a replay of their id is a new request", () => {
	const { manager, restarted } = restartAfterFoldCall(true);
	assert.equal(recoverFoldRequests(manager.getBranch()).length, 0);
	assert.equal(restarted.engine.pending(restarted.ctx(manager)), 0);
	const replay = restarted.engine.request(restarted.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_err#0" });
	assert.ok(replay.ok && !replay.replayed, "a failed result's record is not an accepted request");
});

test("the same record inside a successful tool result is queued again after a restart", () => {
	const { manager, restarted } = restartAfterFoldCall(false);
	assert.equal(recoverFoldRequests(manager.getBranch()).length, 1);
	assert.equal(restarted.engine.pending(restarted.ctx(manager)), 1);
});

test("S1: a message-less entry holds no engine messages, and one request that throws does not clear the queue", () => {
	const hollow = { type: "message", id: "hollow", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: null } as unknown as SessionEntry;
	assert.deepEqual(entryToCoreMessages(hollow), []);
	assert.deepEqual(entryToCoreMessages({ ...hollow, message: "text" } as unknown as SessionEntry), []);
	assert.equal(isEditableEntry(hollow), false);

	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 4);
	const hostile = { startRef: "m00001", endRef: "m00002", summary: SUMMARY, requestId: "call_bad#0", get accepted(): never { throw new Error("boom"); } };
	const good: FoldRequest = { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_ok#0" };
	const planned = planQueuedFolds(manager, [hostile as never, good], 64_000, CONFIG);
	assert.equal(planned.dropped.length, 1);
	assert.equal(planned.dropped[0]?.code, "plan-failed");
	assert.equal(planned.dropped[0]?.requestId, "call_bad#0");
	assert.match(planned.dropped[0]?.errors[0] ?? "", /plan-failed: boom/u);
	assert.equal(planned.drafts.length, 4, "the valid request after it is still written: one carrier edit, two hide edits, one record (the opening message is kept)");
});

// ---- S2: bounded startup work, with literal counts -------------------------------------------------

/** A well-formed record that names `count` entry ids; only the scan sees it, nothing plans it. */
function forgedRecord(callId: string, count: number): FoldRequestRecovery {
	const ids = Array.from({ length: count }, (_, index) => "e" + index);
	return {
		kind: FOLD_REQUEST_RECOVERY_KIND, requestId: callId + "#0", startRef: "m00001", endRef: "m00002",
		startEntryId: ids[0]!, endEntryId: ids[count - 1]!, coveredEntryIds: ids, sourceDigest: "ab".repeat(32), summary: SUMMARY,
	};
}

function forgedBranch(counts: readonly number[]): SessionEntry[] {
	const manager = SessionManager.inMemory("/tmp");
	counts.forEach((count, index) => saveFoldCall(manager, "call_" + index, [forgedRecord("call_" + index, count)]));
	return manager.getBranch();
}

test("S2: the limits are the documented literal values", () => {
	assert.equal(MAX_RECOVERY_COVERED_IDS_PER_RECORD, 5_000);
	assert.equal(MAX_RECOVERY_RECORDS_PER_SCAN, 256);
	assert.equal(MAX_RECOVERY_COVERED_IDS_PER_SCAN, 50_000);
});

test("S2: a record naming more than 5000 ids is dropped as too-large, never truncated", () => {
	const scan = scanFoldRequests(forgedBranch([5_000, 5_001, 40_000]));
	assert.deepEqual(scan.recovered.map((item) => [item.recovery.requestId, item.recovery.coveredEntryIds.length]), [["call_0#0", 5_000]]);
	assert.deepEqual(scan.dropped.map((drop) => [drop.requestId, drop.code]), [["call_1#0", "too-large"], ["call_2#0", "too-large"]]);
	assert.match(scan.dropped[1]?.errors[0] ?? "", /^too-large: .*call_2#0.* it names 40000 entries; at most 5000/u);
	assert.deepEqual(recoverFoldRequests(forgedBranch([5_001])), []);
});

test("S2: at most 256 records are queued per scan; the rest are reported, not silently lost", () => {
	const scan = scanFoldRequests(forgedBranch(Array.from({ length: 300 }, () => 1)));
	assert.equal(scan.recovered.length, 256);
	assert.equal(scan.recovered[255]?.recovery.requestId, "call_255#0");
	assert.equal(scan.dropped.length, 44);
	assert.ok(scan.dropped.every((drop) => drop.code === "too-large"));
	assert.equal(scan.dropped[0]?.requestId, "call_256#0");
	assert.match(scan.dropped[0]?.errors[0] ?? "", /already queued 256 requests/u);
});

test("S2: at most 50000 entry ids are queued per scan in all", () => {
	const scan = scanFoldRequests(forgedBranch(Array.from({ length: 11 }, () => 5_000)));
	assert.equal(scan.recovered.length, 10, "ten records of 5000 ids reach the 50000 limit exactly");
	assert.deepEqual(scan.dropped.map((drop) => drop.requestId), ["call_10#0"]);
	assert.match(scan.dropped[0]?.errors[0] ?? "", /requests naming 50000 entries; at most 50000/u);
});

test("S2: the dropped report is itself bounded", () => {
	const scan = scanFoldRequests(forgedBranch(Array.from({ length: 700 }, () => 5_001)));
	assert.equal(scan.recovered.length, 0);
	assert.equal(scan.dropped.length, 257, "256 listed plus one line for the rest");
	assert.match(scan.dropped[256]?.errors[0] ?? "", /^too-large: 444 more saved fold requests were not recovered/u);
});

test("S2: a duplicated entry id in a record of 5000 is rejected, and a large valid record parses", () => {
	const record = forgedRecord("call_dup", 5_000);
	assert.equal(parseFoldRequestRecovery({ ...record, coveredEntryIds: [...record.coveredEntryIds.slice(0, 4_999), "e0"] }), undefined);
	assert.equal(parseFoldRequestRecovery(record)?.coveredEntryIds.length, 5_000);
});

test("S2: a replay of a saved request id whose record is too large is refused, not planned", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 4);
	const huge = forgedRecord("call_huge", 5_001);
	saveFoldCall(manager, "call_huge", [huge]);
	const harness = boot();
	harness.fire("session_start", manager, { reason: "resume" });
	assert.equal(harness.engine.pending(harness.ctx(manager)), 0, "the record was not queued");
	assert.deepEqual(harness.engine.dropped(harness.ctx(manager)).map((drop) => [drop.requestId, drop.code]), [["call_huge#0", "too-large"]]);
	const replay = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_huge#0" });
	assert.ok(!replay.ok && replay.code === "too-large" && /names 5001 entries; at most 5000/u.test(replay.errors[0] ?? ""), JSON.stringify(replay));
	assert.equal(harness.engine.pending(harness.ctx(manager)), 0);
});

/** Fold the opening user message too, through the session's policy entry. */
function foldOpening(manager: SessionManager): void {
	manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));
}

test("MR177-F2: a recovered request accepted with the opening folded is re-planned with the same setting", () => {
	withSession((manager, file, sessionDir) => {
		foldOpening(manager);
		exchanges(manager, 3);
		const recovery = accept(boot(), manager, "call_fold_mode", 0, "m00001", "m00004");
		assert.equal(recovery.coveredEntryIds.length, 4, "fold mode accepts the opening message too");
		saveFoldCall(manager, "call_fold_mode", [recovery]);
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1);
		boundary(restarted, reopened);
		assert.deepEqual(restarted.engine.dropped(restarted.ctx(reopened)), []);
		const records = foldRecords(reopened);
		assert.equal(records.length, 1);
		assert.deepEqual(coveredEntryIds(records[0]!), recovery.coveredEntryIds);
		assert.doesNotMatch(contextText(reopened), /QUESTION-1 /u, "the folded opening message is hidden");
	});
});

test("MR177-F2: a replay of a request accepted with the opening folded is the same request", () => {
	withSession((manager, file, sessionDir) => {
		foldOpening(manager);
		exchanges(manager, 3);
		const recovery = accept(boot(), manager, "call_fold_replay", 0, "m00001", "m00004");
		saveFoldCall(manager, "call_fold_replay", [recovery]);
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		const replay = restarted.engine.request(restarted.ctx(reopened), { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_fold_replay#0" });
		assert.ok(replay.ok && replay.replayed === true && replay.queued, JSON.stringify(replay));
		assert.equal(restarted.engine.pending(restarted.ctx(reopened)), 1, "still the one recovered item");
	});
});

test("MR177-F2: a queued request without an accepted source is planned with the given fold settings", () => {
	const manager = SessionManager.inMemory("/tmp");
	exchanges(manager, 3);
	const request = { startRef: "m00001", endRef: "m00004", summary: SUMMARY };
	const folded = planQueuedFolds(manager, [request], 64_000, CONFIG, { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 });
	assert.deepEqual(folded.dropped, []);
	assert.equal(folded.drafts.length, 5, "fold: one carrier edit, three hide edits, one record");
	const kept = planQueuedFolds(manager, [request], 64_000, CONFIG, { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 });
	assert.equal(kept.drafts.length, 4, "keep: one carrier edit, two hide edits, one record");
});

test("MR177-F2: a request without an id is written with the fold settings it was validated with", () => {
	withSession((manager) => {
		foldOpening(manager);
		exchanges(manager, 3);
		const harness = boot();
		const result = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: SUMMARY });
		assert.ok(result.ok && result.queued, JSON.stringify(result));
		boundary(harness, manager);
		const records = foldRecords(manager);
		assert.equal(records.length, 1);
		assert.equal(coveredEntryIds(records[0]!).length, 4);
		assert.doesNotMatch(contextText(manager), /QUESTION-1 /u, "the folded opening message is hidden");
	});
});

test("MR177-F2: a request accepted with the opening kept is written over the same entries after the setting changes to fold", () => {
	withSession((manager, file, sessionDir) => {
		exchanges(manager, 3);
		const recovery = accept(boot(), manager, "call_keep", 0, "m00001", "m00004");
		assert.equal(recovery.coveredEntryIds.length, 3, "accepted with the opening message kept");
		saveFoldCall(manager, "call_keep", [recovery]);
		foldOpening(manager);
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		boundary(restarted, reopened);
		assert.deepEqual(restarted.engine.dropped(restarted.ctx(reopened)), []);
		const records = foldRecords(reopened);
		assert.equal(records.length, 1);
		assert.deepEqual(coveredEntryIds(records[0]!), recovery.coveredEntryIds, "not widened to the opening message");
		assert.match(contextText(reopened), /QUESTION-1 /u);
	});
});

test("MR177-F2: a request accepted with the opening folded is dropped, not narrowed, after the setting changes to keep", () => {
	withSession((manager, file, sessionDir) => {
		foldOpening(manager);
		exchanges(manager, 3);
		const recovery = accept(boot(), manager, "call_fold", 0, "m00001", "m00004");
		assert.equal(recovery.coveredEntryIds.length, 4);
		saveFoldCall(manager, "call_fold", [recovery]);
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "keep" }));
		const reopened = openFile(file, sessionDir);
		const restarted = boot();
		restarted.fire("session_start", reopened, { reason: "resume" });
		assert.equal(boundary(restarted, reopened).length, 0, "nothing is written over other entries than the accepted ones");
		assert.equal(restarted.engine.dropped(restarted.ctx(reopened))[0]?.code, "coverage-changed");
		assert.equal(foldRecords(reopened).length, 0);
		assert.match(contextText(reopened), /QUESTION-1 /u);
	});
});
