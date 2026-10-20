/** pi-context-aware#176: a queued fold is written only to the branch it was requested on.
 *
 * The engine queues an accepted request until `turn_end` or `agent_before_settle`.
 * It records the branch leaf the request was made on and the entries its refs
 * resolved to. At the drain the selected branch must still hold that leaf;
 * entries appended after it on the same branch are normal turn growth. A
 * request saved for restart recovery carries the same leaf, so a record whose
 * tool result was saved on another branch is not written there either.
 *
 * The range folded here is on the opening that branches A and B share. Its
 * entries exist on both branches, so only the leaf check keeps A's fold off B.
 * Mutations: the "C2 queued fold branch leaf" entries in tests/fixtures/safety/mutations.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { foldStateFromBranch } from "../src/folds/fold-adapter.js";
import { FOLD_ENTRY_TYPE, coveredEntryIds, foldRecordsOnBranch } from "../src/folds/fold-entries.js";
import { planQueuedFolds, registerFoldEngine, type FoldEngine, type FoldRequestResult } from "../src/folds/fold-engine.js";
import { foldRequestDetails, parseFoldRequestRecovery, type FoldRequestRecovery } from "../src/folds/fold-recovery.js";
import { assistant, requestText, SAFETY_CONFIG, safetyRoot, safetySession, seedOpening, user } from "./fixtures/safety/session.js";

const SUMMARY_A = "BRANCH-A-SUMMARY: alpha and beta were settled while branch A was selected.";

interface Branches { readonly opening: string[]; readonly leafA: string; readonly leafB: string }

/** The fixed opening (m00001..m00008), then sibling branches B and A of one exchange each. A is selected. */
function siblingBranches(manager: SessionManager): Branches {
	const opening = seedOpening(manager);
	user(manager, "BRANCH-B-QUESTION");
	const leafB = assistant(manager, "BRANCH-B-ANSWER");
	manager.branch(opening[opening.length - 1]!);
	user(manager, "BRANCH-A-QUESTION");
	const leafA = assistant(manager, "BRANCH-A-ANSWER");
	return { opening, leafA, leafB };
}

interface Probe { engine?: FoldEngine; ctx?: ExtensionContext; leafAtRequest?: string | null; result?: FoldRequestResult }

/**
 * A tool that requests a fold of m00001..m00004 and then runs `after` before it
 * returns. With `requestId` it saves the recovery record in its result, as a fold tool must.
 */
function foldTool(probe: Probe, after: (manager: SessionManager) => void, requestId = false): ExtensionFactory {
	return (pi) => {
		probe.engine = registerFoldEngine(pi, { config: SAFETY_CONFIG });
		pi.registerTool({ name: "fold_probe", label: "fold_probe", description: "Requests a fold, then changes the session before returning.", parameters: Type.Object({}),
			async execute(id, _params, _signal, _update, ctx) {
				probe.ctx = ctx;
				probe.leafAtRequest = ctx.sessionManager.getLeafId();
				const result = probe.engine!.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY_A, ...(requestId ? { requestId: id + "#0" } : {}) });
				probe.result = result;
				assert.ok(result.ok && result.queued, JSON.stringify(result));
				after(ctx.sessionManager as SessionManager);
				return { content: [{ type: "text", text: "fold requested" }], details: (result.recovery ? foldRequestDetails([result.recovery]) : {}) as never };
			} });
	};
}

const toolTurn = (id: string) => [
	fauxAssistantMessage(fauxToolCall("fold_probe", {}, { id }), { stopReason: "toolUse", timestamp: 1 }),
	fauxAssistantMessage("SAFETY-TURN-DONE", { timestamp: 1 }),
];

function foldEntries(manager: SessionManager): number {
	return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE).length;
}

test("REQ-176-1: a fold queued on branch A is not written to branch B when B is selected before the drain", async () => {
	const root = safetyRoot();
	const manager = SessionManager.inMemory(root);
	const { opening, leafA, leafB } = siblingBranches(manager);
	const probe: Probe = {};
	let live: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		live = await safetySession(root, manager, [foldTool(probe, (selected) => selected.branch(leafB))]);
		await live.prompt("SAFETY-QUEUE-ON-A", toolTurn("branch-race"));
		assert.ok(probe.result?.ok && probe.result.queued, "the request was accepted on branch A");
		assert.ok(manager.getBranch().some((entry) => entry.id === leafB) && !manager.getBranch().some((entry) => entry.id === leafA), "branch B is selected at the drain");
		assert.ok(opening.slice(1, 4).every((id) => manager.getBranch().some((entry) => entry.id === id)), "the folded entries are on branch B too");

		assert.equal(foldStateFromBranch(manager.getBranch()).active.length, 0, "A's queued fold must not land on branch B");
		assert.equal(foldEntries(manager), 0, "no fold was written anywhere");
		const next = requestText(live.requests[1]!);
		assert.doesNotMatch(next, /BRANCH-A-SUMMARY/u, "A's summary must not reach B's provider request");
		assert.match(next, /SAFETY-ALPHA-ANSWER/u, "B still sees the originals");
		assert.match(next, /BRANCH-B-QUESTION/u);

		// REQ-176-3: the dropped request is reported with its reason.
		const dropped = probe.engine!.dropped(probe.ctx!);
		assert.deepEqual(dropped.map((drop) => [drop.startRef, drop.endRef, drop.code]), [["m00001", "m00004", "branch-changed"]]);
		assert.match(dropped[0]!.errors.join("\n"), new RegExp(`^branch-changed: the branch leaf entry ${probe.leafAtRequest} this fold was accepted on is not on the current branch`, "u"));
	} finally { live?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("REQ-176-2: a fold requested in a normal turn still lands when entries are appended on its branch before the drain", async () => {
	const root = safetyRoot();
	const manager = SessionManager.inMemory(root);
	const { opening } = siblingBranches(manager);
	const probe: Probe = {};
	let live: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		// The tool appends an entry of its own; Pi then appends the tool result. Both follow the request's leaf.
		live = await safetySession(root, manager, [foldTool(probe, (selected) => { selected.appendCustomEntry("safety-turn-growth", {}); })]);
		await live.prompt("SAFETY-QUEUE-ON-A", toolTurn("normal-turn"));
		const branch = manager.getBranch();
		const leafIndex = branch.findIndex((entry) => entry.id === probe.leafAtRequest);
		const growth = branch.findIndex((entry) => entry.type === "custom" && entry.customType === "safety-turn-growth");
		const toolResult = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
		assert.ok(leafIndex >= 0 && growth > leafIndex && toolResult > growth, "entries were appended after the leaf the request was made on");

		assert.deepEqual(probe.engine!.dropped(probe.ctx!), []);
		const records = foldRecordsOnBranch(manager.getBranch());
		assert.equal(records.length, 1, "the fold was written at the boundary");
		assert.deepEqual(coveredEntryIds(records[0]!.record), opening.slice(1, 4));
		const next = requestText(live.requests[1]!);
		assert.match(next, /BRANCH-A-SUMMARY/u);
		assert.doesNotMatch(next, /SAFETY-ALPHA-ANSWER|SAFETY-BETA-QUESTION|SAFETY-BETA-ANSWER/u);
	} finally { live?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

/** The restarted process: the real engine on Pi's handlers. */
function restartedEngine(probe: Probe): ExtensionFactory {
	return (pi) => {
		probe.engine = registerFoldEngine(pi, { config: SAFETY_CONFIG });
		pi.on("session_start", (_event, ctx) => { probe.ctx = ctx; });
	};
}

test("REQ-176-5: a saved request whose tool result landed on branch B is not written to B after a restart", async () => {
	const root = safetyRoot();
	const sessions = path.join(root, "sessions");
	const manager = SessionManager.create(root, sessions);
	const { leafB } = siblingBranches(manager);
	const file = manager.getSessionFile();
	assert.ok(file);
	const first: Probe = {};
	const second: Probe = {};
	let live: Awaited<ReturnType<typeof safetySession>> | undefined;
	let restarted: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		// The tool navigates before it returns, so Pi saves its result, and the record in it, on branch B.
		live = await safetySession(root, manager, [foldTool(first, (selected) => selected.branch(leafB), true)]);
		await live.prompt("SAFETY-QUEUE-ON-A", toolTurn("saved-race"));
		const recovery = first.result?.ok ? first.result.recovery : undefined;
		assert.ok(recovery, "the accepted request returned a recovery record");
		assert.equal(recovery.leafEntryId, first.leafAtRequest, "the record names the leaf the request was made on");
		assert.equal(foldEntries(manager), 0, "the live drain did not write it to B");
		live.session.dispose();
		live = undefined;

		const reopened = SessionManager.open(file, sessions);
		assert.ok(reopened.getBranch().some((entry) => entry.id === leafB), "the session resumes on branch B");
		restarted = await safetySession(root, reopened, [restartedEngine(second)]);
		await restarted.prompt("SAFETY-AFTER-RESTART");
		assert.equal(foldEntries(reopened), 0, "A's saved request must not land on branch B");
		assert.equal(foldStateFromBranch(reopened.getBranch()).active.length, 0);
		// The saved record in the tool result carries the summary text, so check that B still sees the originals.
		assert.match(requestText(restarted.requests[0]!), /SAFETY-ALPHA-ANSWER.*SAFETY-BETA-QUESTION.*SAFETY-BETA-ANSWER/su, "B still sees the originals");
		const dropped = second.engine!.dropped(second.ctx!);
		assert.deepEqual(dropped.map((drop) => [drop.requestId, drop.code]), [["saved-race#0", "branch-changed"]]);
		assert.match(dropped[0]!.errors.join("\n"), new RegExp(`^branch-changed: the branch leaf entry ${first.leafAtRequest} `, "u"));
	} finally {
		live?.session.dispose();
		restarted?.session.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** An engine with no Pi handlers, a request with an id, and its record saved in a tool result on the selected branch. */
function savedRequest(manager: SessionManager, root: string): { recovery: FoldRequestRecovery; toolResultEntryId: string; leaf: string } {
	const inert = { on: () => () => {}, getAllTools: () => [] } as unknown as ExtensionAPI;
	const engine = registerFoldEngine(inert, { config: SAFETY_CONFIG });
	const ctx = { cwd: root, sessionManager: manager, model: undefined } as unknown as ExtensionContext;
	const leaf = manager.appendMessage(fauxAssistantMessage(fauxToolCall("context_fold", {}, { id: "call_saved" }), { stopReason: "toolUse", timestamp: 1 }));
	const result = engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY_A, requestId: "call_saved#0" });
	assert.ok(result.ok && result.recovery, JSON.stringify(result));
	const toolResultEntryId = manager.appendMessage({ role: "toolResult", toolCallId: "call_saved", toolName: "context_fold", content: [{ type: "text", text: "folded" }],
		details: foldRequestDetails([result.recovery]) as never, isError: false, timestamp: 1 });
	return { recovery: result.recovery, toolResultEntryId, leaf };
}

test("REQ-176-5: the record's leaf is read back strictly, and a record without one is planned as before", () => {
	const root = safetyRoot();
	try {
		const manager = SessionManager.inMemory(root);
		siblingBranches(manager);
		const { recovery, toolResultEntryId, leaf } = savedRequest(manager, root);
		assert.equal(recovery.leafEntryId, leaf, "the leaf when the request was made: the assistant entry holding the fold call");
		assert.equal(parseFoldRequestRecovery(structuredClone(recovery))?.leafEntryId, leaf);
		for (const leafEntryId of ["", 5, null, "e".repeat(257), { id: leaf }]) {
			assert.equal(parseFoldRequestRecovery({ ...recovery, leafEntryId }), undefined, JSON.stringify(leafEntryId));
		}

		// A record saved before the leaf was recorded: its tool result is still checked, and it is planned as before.
		const { leafEntryId: _leaf, ...older } = recovery;
		const olderParsed = parseFoldRequestRecovery(older);
		assert.ok(olderParsed, "a record without the leaf is still read");
		assert.equal("leafEntryId" in olderParsed, false);
		const planned = planQueuedFolds(manager, [{ recovery: olderParsed, toolResultEntryId }], 64_000, SAFETY_CONFIG);
		assert.deepEqual(planned.dropped, []);
		assert.ok(planned.drafts.length > 0, "the older record is written on its own branch");

		// The same record with a leaf that is not on the branch is dropped, even though its tool result is.
		const elsewhere = planQueuedFolds(manager, [{ recovery: { ...recovery, leafEntryId: "not-on-this-branch" }, toolResultEntryId }], 64_000, SAFETY_CONFIG);
		assert.equal(elsewhere.drafts.length, 0);
		assert.deepEqual(elsewhere.dropped.map((drop) => [drop.requestId, drop.code]), [["call_saved#0", "branch-changed"]]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
