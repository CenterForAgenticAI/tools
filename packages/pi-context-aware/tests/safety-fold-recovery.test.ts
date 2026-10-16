/** REQ-C4/#172 controls: a fold request accepted before a crash is written once,
 * to the branch it was accepted on and over the source it was accepted over,
 * through Pi's real SessionManager, session files and navigateTree.
 * Mutations: see the "#172" entries in tests/fixtures/safety/mutations.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionFactory, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { guardErasureWrites } from "../src/erasure/write-boundary.js";
import { foldStateFromBranch } from "../src/folds/fold-adapter.js";
import { FOLD_ENTRY_TYPE, coveredEntryIds, foldRecordsOnBranch } from "../src/folds/fold-entries.js";
import { registerFoldEngine, type FoldEngine, type FoldRequestResult } from "../src/folds/fold-engine.js";
import { FOLD_REQUEST_RECOVERY_KIND, foldRequestDetails, type FoldRequestRecovery } from "../src/folds/fold-recovery.js";
import { fold, requestText, SAFETY_CONFIG, safetyRoot, safetySession, seedOpening, assistant, user } from "./fixtures/safety/session.js";

const SUMMARY = "SAFETY-RECOVERED-SUMMARY: alpha and beta were settled, so nothing before gamma needs to be read again.";
const SUMMARY_LATER = "SAFETY-LATER-SUMMARY: the middle of the opening was folded by a request that finished first.";
const SUMMARY_AGGREGATE = "SAFETY-AGGREGATE-SUMMARY: both earlier folds together say that alpha through delta are settled.";

/** The process that accepted the request and died before its drain: an engine with no Pi handlers. */
function crashingProcess(): ExtensionFactory {
	const inert = { on: () => () => {}, getAllTools: () => [] } as unknown as ExtensionAPI;
	return (pi) => {
		const engine = registerFoldEngine(inert, { config: SAFETY_CONFIG });
		pi.registerTool({ name: "fold_crash", label: "fold_crash", description: "Accepts a fold request in a process that dies before the drain.",
			parameters: Type.Object({ start: Type.String(), end: Type.String(), summary: Type.String() }),
			async execute(id, params, _signal, _update, ctx) {
				const result = engine.request(ctx, { startRef: params.start, endRef: params.end, summary: params.summary, requestId: id + "#0" });
				assert.ok(result.ok && result.queued && result.recovery, JSON.stringify(result));
				return { content: [{ type: "text", text: "folded" }], details: foldRequestDetails([result.recovery]) as never };
			} });
	};
}

interface Live { engine: FoldEngine; ctx: () => ExtensionContext; replays: FoldRequestResult[] }

/** The restarted process: the real engine on Pi's handlers, and a tool that runs a request again. */
function restartedProcess(live: Live): ExtensionFactory {
	return (pi) => {
		let captured: ExtensionContext | undefined;
		live.engine = registerFoldEngine(pi, { config: SAFETY_CONFIG });
		live.ctx = () => captured!;
		pi.on("session_start", (_event, ctx) => {
			captured = ctx;
			// From Pi 1.3.0 a resumed session restores the tool loadout its transcript declared.
			// The crashed process never declared this test-only tool, so activate it here.
			if (!pi.getActiveTools().includes("fold_replay")) pi.setActiveTools([...pi.getActiveTools(), "fold_replay"]);
		});
		pi.registerTool({ name: "fold_replay", label: "fold_replay", description: "Runs a fold request again with a given id.",
			parameters: Type.Object({ start: Type.String(), end: Type.String(), summary: Type.String(), requestId: Type.String() }),
			async execute(_id, params, _signal, _update, ctx) {
				live.replays.push(live.engine.request(ctx, { startRef: params.start, endRef: params.end, summary: params.summary, requestId: params.requestId }));
				return { content: [{ type: "text", text: "replayed" }], details: {} };
			} });
	};
}

function newLive(): Live {
	return { engine: undefined as unknown as FoldEngine, ctx: () => undefined as unknown as ExtensionContext, replays: [] };
}

function foldEntries(manager: SessionManager): number {
	return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE).length;
}

/** Create a persisted session with the fixed opening. */
function createSession(root: string): { manager: SessionManager; file: string; sessions: string; ids: string[] } {
	const sessions = path.join(root, "sessions");
	const manager = SessionManager.create(root, sessions);
	const ids = seedOpening(manager);
	const file = manager.getSessionFile();
	assert.ok(file);
	return { manager, file, sessions, ids };
}

/** Run one tool-call turn that accepts a fold request, then drop the process. The record is saved; nothing is drained. */
async function crashAfterAccepting(root: string, manager: SessionManager, start: string, end: string, summary: string, id = "crash-call", foldsBefore = 0): Promise<void> {
	const crash = await safetySession(root, manager, [crashingProcess()]);
	try {
		await crash.prompt("SAFETY-ACCEPT-FOLD", [
			fauxAssistantMessage(fauxToolCall("fold_crash", { start, end, summary }, { id }), { stopReason: "toolUse", timestamp: 1 }),
			fauxAssistantMessage("SAFETY-CRASH-DONE", { timestamp: 1 }),
		]);
	} finally { crash.session.dispose(); }
	assert.equal(foldEntries(manager), foldsBefore, "the process died before the drain, so it wrote no fold");
}

function recordsOf(manager: SessionManager) { return foldRecordsOnBranch(manager.getBranch()); }

test("#172: a crash before the drain, then a restart, writes exactly the accepted fold once", async () => {
	const root = safetyRoot();
	const { manager, file, sessions, ids } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		const reopened = SessionManager.open(file, sessions);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		assert.equal(live.engine.pending(live.ctx()), 1, "the saved record is queued again at session start");
		await restarted.prompt("SAFETY-AFTER-RESTART-ONE");
		assert.equal(foldEntries(reopened), 1, "exactly one fold after the first boundary");
		await restarted.prompt("SAFETY-AFTER-RESTART-TWO");
		assert.equal(foldEntries(reopened), 1, "later boundaries write nothing more");
		const [written] = recordsOf(reopened);
		assert.equal(written?.record.requestId, "crash-call#0");
		assert.deepEqual(coveredEntryIds(written!.record), ids.slice(1, 4), "the fold hides exactly the three accepted entries after the kept opening message");
		const request = requestText(restarted.requests[1]!);
		assert.ok(request.includes(SUMMARY));
		assert.doesNotMatch(request, /SAFETY-ALPHA-ANSWER|SAFETY-BETA-ANSWER/u);
		assert.match(request, /SAFETY-ALPHA-QUESTION/u, "the kept opening message stays");
		assert.match(request, /SAFETY-TAIL-ONE/u);
		assert.deepEqual(live.engine.dropped(live.ctx()), []);
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172 B1: a recovered fold is not written to another branch, and is written to its own, through navigateTree", async () => {
	const root = safetyRoot();
	const { manager, file, sessions, ids } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		const reopened = SessionManager.open(file, sessions);
		const leafA = reopened.getLeafId();
		assert.ok(leafA);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		assert.equal(live.engine.pending(live.ctx()), 1, "recovered on branch A");

		// Branch B starts at the shared opening. It has no record.
		await restarted.session.navigateTree(ids[7]!);
		assert.equal(reopened.getLeafId(), ids[7], "navigateTree moved to the shared leaf");
		assert.equal(live.engine.pending(live.ctx()), 0, "the queue is rebuilt from branch B's records");
		await restarted.prompt("SAFETY-BRANCH-B-ONE");
		const leafB = reopened.getLeafId();
		assert.ok(leafB);
		const bRequest = requestText(restarted.requests[0]!);
		assert.doesNotMatch(bRequest, /SAFETY-RECOVERED-SUMMARY/u, "A's summary must not reach B's provider request");
		assert.match(bRequest, /SAFETY-ALPHA-QUESTION/u);
		assert.equal(foldEntries(reopened), 0, "nothing was written anywhere");

		// Back on A the fold is written.
		await restarted.session.navigateTree(leafA);
		assert.equal(live.engine.pending(live.ctx()), 1);
		await restarted.prompt("SAFETY-BACK-ON-A-ONE");
		await restarted.prompt("SAFETY-BACK-ON-A-TWO");
		assert.equal(foldEntries(reopened), 1);
		assert.ok(requestText(restarted.requests[2]!).includes(SUMMARY));
		assert.deepEqual(coveredEntryIds(recordsOf(reopened)[0]!.record), ids.slice(1, 4));

		// And B is still unfolded.
		await restarted.session.navigateTree(leafB);
		assert.deepEqual(foldStateFromBranch(reopened.getBranch()).active, []);
		await restarted.prompt("SAFETY-BRANCH-B-TWO");
		assert.doesNotMatch(requestText(restarted.requests[3]!), /SAFETY-RECOVERED-SUMMARY/u);
		assert.equal(foldEntries(reopened), 1, "the one fold is still the one written on A");
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172 B2: running the tool call again with the same request id cannot write a different fold", async () => {
	const root = safetyRoot();
	const { manager, file, sessions } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		// A later request that overlaps the range finished first and is written.
		fold(manager, "m00003", "m00006", SUMMARY_LATER);
		assert.equal(foldEntries(manager), 1);
		const reopened = SessionManager.open(file, sessions);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		assert.ok(restarted.session.getActiveToolNames().includes("fold_replay"), "the replay tool is active after the restart");
		await restarted.prompt("SAFETY-RECOVERY-BOUNDARY");
		assert.equal(live.engine.dropped(live.ctx())[0]?.code, "coverage-changed", "recovery drops the four-entry request");
		assert.equal(foldEntries(reopened), 1);

		// The durable worker runs the call again with the same id.
		await restarted.prompt("SAFETY-REPLAY", [
			fauxAssistantMessage(fauxToolCall("fold_replay", { start: "m00001", end: "m00004", summary: SUMMARY, requestId: "crash-call#0" }, { id: "replay-call" }), { stopReason: "toolUse", timestamp: 1 }),
			fauxAssistantMessage("SAFETY-REPLAY-DONE", { timestamp: 1 }),
		]);
		assert.equal(live.replays.length, 1);
		const [replay] = live.replays;
		assert.ok(replay && !replay.ok && replay.code === "coverage-changed", JSON.stringify(replay));
		await restarted.prompt("SAFETY-AFTER-REPLAY");
		assert.equal(foldEntries(reopened), 1, "no second fold was written");
		assert.deepEqual(recordsOf(reopened).map(({ record }) => record.blockId), ["b1"]);
		assert.equal(recordsOf(reopened)[0]?.record.requestId, undefined, "the surviving fold is the later one");
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172 B3: a fold of folds over a rewritten block summary is dropped as source-changed", async () => {
	const root = safetyRoot();
	const { manager, file, sessions } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		// Two ordinary folds, b1 and b2, over the four opening exchanges.
		fold(manager, "m00001", "m00002", "SAFETY-BLOCK-ONE: alpha was settled between the user and the assistant.");
		fold(manager, "m00003", "m00004", "SAFETY-BLOCK-TWO: beta was settled between the user and the assistant.");
		assert.deepEqual(recordsOf(manager).map(({ record }) => record.blockId), ["b1", "b2"]);
		await crashAfterAccepting(root, manager, "b1", "b2", SUMMARY_AGGREGATE, "crash-call", 2);
		// Someone rewrites block one's summary after the aggregate was accepted.
		const [first] = recordsOf(manager);
		manager.appendContextEdit(first!.record.carrierId, { content: [{ type: "text", text: "SAFETY-REWRITTEN-BLOCK-ONE: alpha was reversed after all." }] });
		const reopened = SessionManager.open(file, sessions);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		await restarted.prompt("SAFETY-AFTER-REWRITE");
		const [drop] = live.engine.dropped(live.ctx());
		assert.equal(drop?.code, "source-changed");
		assert.equal(drop?.requestId, "crash-call#0");
		assert.equal(foldEntries(reopened), 2, "no aggregate was written");
		await restarted.prompt("SAFETY-AFTER-REWRITE-TWO");
		const request = requestText(restarted.requests[1]!);
		assert.ok(request.includes("SAFETY-REWRITTEN-BLOCK-ONE"));
		// The aggregate text still appears in the saved tool call arguments, so check the folds in effect instead.
		assert.deepEqual(foldStateFromBranch(reopened.getBranch()).active.map((record) => record.blockId), ["b1", "b2"], "no tier 2 aggregate replaced the two blocks");
		assert.ok(request.includes("SAFETY-BLOCK-TWO"), "block two stays as it was");
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172: a session whose erasure is refused writes nothing on recovery; the same session writes when allowed", async () => {
	const root = safetyRoot();
	const { manager, file, sessions } = createSession(root);
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		const run = (refused: boolean) => {
			const reopened = SessionManager.open(file, sessions);
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			const host = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), getAllTools: () => [] } as unknown as ExtensionAPI;
			const pi = guardErasureWrites(host, () => refused);
			const engine = registerFoldEngine(pi, { config: SAFETY_CONFIG });
			const ctx = { cwd: root, sessionManager: reopened } as unknown as ExtensionContext;
			handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
			const drained = handlers.get("turn_end")!({ type: "turn_end", entries: [] }, ctx) as { entries: SessionBoundaryDraft[] } | undefined;
			return { pending: engine.pending(ctx), drained };
		};
		const before = fs.readFileSync(file);
		const refused = run(true);
		assert.equal(refused.drained, undefined, "no draft is returned to Pi");
		assert.equal(refused.pending, 0);
		assert.deepEqual(fs.readFileSync(file), before, "the session file is unchanged");
		const allowed = run(false);
		assert.equal(allowed.drained?.entries.length, 4, "positive control: one carrier edit, two hide edits and one record");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172 S1: a persisted entry with message:null does not stop a valid recovered fold", async () => {
	const root = safetyRoot();
	const { manager, file, sessions, ids } = createSession(root);
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		// A hand-edited or damaged file: a message entry without a message, at the end of the branch.
		fs.appendFileSync(file, JSON.stringify({ type: "message", id: "nullmsg1", parentId: manager.getLeafId(), timestamp: "2026-01-01T00:00:00.000Z", message: null }) + "\n");
		const reopened = SessionManager.open(file, sessions);
		assert.equal(reopened.getLeafId(), "nullmsg1");
		// Pi's own session builder cannot run on this file, so the engine's handlers are driven directly.
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const host = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), getAllTools: () => [] } as unknown as ExtensionAPI;
		const engine = registerFoldEngine(host, { config: SAFETY_CONFIG });
		const ctx = { cwd: root, sessionManager: reopened } as unknown as ExtensionContext;
		handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
		assert.equal(engine.pending(ctx), 1);
		const drained = handlers.get("turn_end")!({ type: "turn_end", entries: [] }, ctx) as { entries: SessionBoundaryDraft[] } | undefined;
		assert.deepEqual(engine.dropped(ctx), [], "the damaged entry did not drop the valid request");
		assert.equal(drained?.entries.length, 4, "one carrier edit, two hide edits and the record");
		const record = drained!.entries.find((draft) => draft.type === "custom");
		assert.ok(record && record.type === "custom" && record.customType === FOLD_ENTRY_TYPE);
		assert.deepEqual(coveredEntryIds(record.data as never), ids.slice(1, 4));
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#172: a record inside a failed tool result is ignored", async () => {
	const root = safetyRoot();
	const { manager, file, sessions } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		// The same call again, this time saved as a failed result carrying a valid-shaped record.
		const saved = recordsInToolResult(manager);
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("fold_crash", { start: "m00001", end: "m00004", summary: SUMMARY }, { id: "failed-call" }), { stopReason: "toolUse" }));
		manager.appendMessage({ role: "toolResult", toolCallId: "failed-call", toolName: "fold_crash", content: [{ type: "text", text: "failed" }],
			details: { ...saved, requestId: "failed-call#0" } as never, isError: true, timestamp: 1 });
		const reopened = SessionManager.open(file, sessions);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		assert.equal(live.engine.pending(live.ctx()), 1, "only the successful result's record is queued");
		await restarted.prompt("SAFETY-AFTER-FAILED");
		assert.deepEqual(recordsOf(reopened).map(({ record }) => record.requestId), ["crash-call#0"]);
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

function recordsInToolResult(manager: SessionManager): FoldRequestRecovery {
	for (const entry of manager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && (entry.message.details as { kind?: unknown } | undefined)?.kind === FOLD_REQUEST_RECOVERY_KIND) {
			return entry.message.details as unknown as FoldRequestRecovery;
		}
	}
	throw new Error("no recovery record saved");
}

test("#172 S2: oversized records are reported as too-large and do not stop a valid one", async () => {
	const root = safetyRoot();
	const { manager, file, sessions } = createSession(root);
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		await crashAfterAccepting(root, manager, "m00001", "m00004", SUMMARY);
		const valid = recordsInToolResult(manager);
		for (const [callId, count] of [["huge-call", 40_000], ["limit-call", 5_001]] as const) {
			const ids = Array.from({ length: count }, (_, index) => "forged" + index);
			manager.appendMessage(fauxAssistantMessage(fauxToolCall("fold_crash", {}, { id: callId }), { stopReason: "toolUse" }));
			manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "fold_crash", content: [{ type: "text", text: "folded" }], isError: false, timestamp: 1,
				details: { ...valid, requestId: callId + "#0", coveredEntryIds: ids, startEntryId: ids[0], endEntryId: ids[count - 1] } as never });
		}
		const reopened = SessionManager.open(file, sessions);
		const live = newLive();
		restarted = await safetySession(root, reopened, [restartedProcess(live)]);
		assert.equal(live.engine.pending(live.ctx()), 1);
		assert.deepEqual(live.engine.dropped(live.ctx()).map((drop) => [drop.requestId, drop.code]), [["huge-call#0", "too-large"], ["limit-call#0", "too-large"]]);
		await restarted.prompt("SAFETY-AFTER-LIMITS");
		assert.equal(foldEntries(reopened), 1, "the valid record was still written");
		assert.deepEqual(recordsOf(reopened).map(({ record }) => record.requestId), ["crash-call#0"]);
		assert.deepEqual(live.engine.dropped(live.ctx()).map((drop) => drop.code), ["too-large", "too-large"], "the report survives the drain");
	} finally { restarted?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Silence unused helper imports that other cases of this file may need.
void assistant; void user;
