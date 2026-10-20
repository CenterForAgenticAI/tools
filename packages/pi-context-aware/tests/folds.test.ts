import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { foldStateFromBranch, planFold as nativePlanFold, validFoldRefs } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts, planQueuedFolds } from "../src/folds/fold-engine.js";
import { FOLD_ENTRY_TYPE, readFoldRecord } from "../src/folds/fold-entries.js";
import { importAcpSideFile } from "../src/folds/acp-import.js";
import type { Config } from "../src/folds/kernel/index.js";

// The engine's defaults refuse ranges under 5,000 characters and protect the
// last five messages. These tests use short messages, so they lower both.
const TEST_CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};

// These storage/tool-atomicity cases exercise the explicit legacy folding policy.
const planFold = (input: Parameters<typeof nativePlanFold>[0]) => nativePlanFold({ folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 }, ...input });

const SUMMARY = "Summary of the first exchange: the user asked about alpha and the assistant answered.";

function tempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-folds-")));
}

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function assistant(manager: SessionManager, text: string): string {
	return manager.appendMessage(fauxAssistantMessage(text));
}

/** Six messages; m00001..m00004 are the first two exchanges. */
function seed(manager: SessionManager): string[] {
	return [
		user(manager, "ALPHA-QUESTION about the first topic"),
		assistant(manager, "ALPHA-ANSWER with details"),
		user(manager, "BETA-QUESTION about the second topic"),
		assistant(manager, "BETA-ANSWER with details"),
		user(manager, "GAMMA-QUESTION still open"),
		assistant(manager, "GAMMA-ANSWER in progress"),
	];
}

function contextText(manager: SessionManager): string {
	return JSON.stringify(manager.buildSessionContext().messages);
}

/** Every visible result has a visible call, and every visible call has a result. */
function assertToolPairsVisible(manager: SessionManager): void {
	const messages = manager.buildSessionContext().messages;
	const calls = messages.flatMap((message) => message.role === "assistant"
		? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
		: []);
	const results = messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
	assert.deepEqual([...calls].sort(), [...results].sort(), "visible tool calls and results must match in both directions");
}

function seedMixedToolEntry(manager: SessionManager): { ids: string[]; callIds: string[] } {
	const first = user(manager, "READ-REQUEST please read two files");
	const calls = [fauxToolCall("read", { path: "one.txt" }), fauxToolCall("read", { path: "two.txt" })];
	const mixed = manager.appendMessage(fauxAssistantMessage([
		{ type: "text", text: "MIXED-TEXT I will read both files." }, ...calls,
	], { stopReason: "toolUse" }));
	const results = calls.map((call) => manager.appendMessage({
		role: "toolResult", toolCallId: call.id, toolName: "read",
		content: [{ type: "text", text: "FILE-BODY" }], isError: false, timestamp: Date.now(),
	}));
	assistant(manager, "READ-DONE");
	user(manager, "NEXT-QUESTION");
	assistant(manager, "NEXT-ANSWER");
	assertToolPairsVisible(manager);
	return { ids: [first, mixed, ...results], callIds: calls.map((call) => call.id) };
}
function foldFirstExchanges(manager: SessionManager): void {
	const plan = planFold({
		branch: manager.getBranch(),
		startRef: "m00001",
		endRef: "m00004",
		summary: SUMMARY,
		topic: "first exchanges",
		modelContextLimit: 64_000,
		config: TEST_CONFIG,
	});
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
}

function assertFolded(manager: SessionManager, message: string): void {
	const text = contextText(manager);
	assert.match(text, /Summary of the first exchange/u, `${message}: summary missing`);
	for (const original of ["ALPHA-QUESTION", "ALPHA-ANSWER", "BETA-QUESTION", "BETA-ANSWER"]) {
		assert.doesNotMatch(text, new RegExp(original, "u"), `${message}: ${original} still in context`);
	}
	assert.match(text, /GAMMA-QUESTION/u, `${message}: unfolded message lost`);
	const state = foldStateFromBranch(manager.getBranch());
	assert.deepEqual(
		state.active.map((record) => record.blockId),
		["b1"],
		`${message}: fold metadata not rebuilt from the branch`,
	);
}

function assertUnfolded(manager: SessionManager, message: string): void {
	const text = contextText(manager);
	assert.doesNotMatch(text, /Summary of the first exchange/u, `${message}: summary leaked`);
	assert.match(text, /ALPHA-QUESTION/u, `${message}: original missing`);
	assert.deepEqual(foldStateFromBranch(manager.getBranch()).active, [], `${message}: fold leaked`);
}

test("a fold is one carrier edit, hide edits and one metadata entry; originals stay in the session", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = seed(manager);
	const before = manager.getEntries().length;
	const plan = planFold({
		branch: manager.getBranch(),
		startRef: "m00001",
		endRef: "m00004",
		summary: SUMMARY,
		topic: "first exchanges",
		modelContextLimit: 64_000,
		config: TEST_CONFIG,
	});
	assert.ok(plan.ok, JSON.stringify(plan));
	assert.equal(manager.getEntries().length, before, "planning must not write");
	assert.deepEqual(
		plan.drafts.map((draft) => (draft.type === "context_edit" ? `${draft.targetId}:${draft.replacement === null ? "hide" : "summary"}` : draft.type)),
		[`${ids[0]}:summary`, `${ids[1]}:hide`, `${ids[2]}:hide`, `${ids[3]}:hide`, "custom"],
	);
	const [record] = plan.records;
	assert.equal(record?.blockId, "b1");
	assert.equal(record?.tier, 1);
	assert.equal(record?.topic, "first exchanges");
	assert.deepEqual(record?.range, { startId: ids[0], endId: ids[3] });
	assert.deepEqual(record?.refs, { start: "m00001", end: "m00004" });

	applyFoldDrafts(manager, plan.drafts);
	assertFolded(manager, "after the fold");
	const originals = manager.getEntries().filter((entry) => entry.type === "message");
	assert.equal(originals.length, 6, "originals must remain in the session file");
});

test("REQ-FOLD-002: a fold survives restart and follows its branch", () => {
	const cwd = tempDir();
	const sessionDir = path.join(cwd, "sessions");
	try {
		const manager = SessionManager.create(cwd, sessionDir);
		seed(manager);
		const beforeFold = manager.getLeafId();
		assert.ok(beforeFold);
		foldFirstExchanges(manager);
		const afterFold = manager.getLeafId();
		assert.ok(afterFold);
		const file = manager.getSessionFile();
		assert.ok(file && fs.existsSync(file), "the session must be persisted");

		const reopened = SessionManager.open(file, sessionDir);
		assertFolded(reopened, "after restart");

		// Switch to a branch made before the fold: the originals come back.
		reopened.branch(beforeFold);
		user(reopened, "DELTA-QUESTION on the other branch");
		assertUnfolded(reopened, "on a branch made before the fold");

		// Back on the fold's branch, after another restart.
		const again = SessionManager.open(file, sessionDir);
		again.branch(afterFold);
		assertFolded(again, "back on the fold branch after restart");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("REQ-FOLD-002: a fold survives fork into a new session and branch extraction", () => {
	const cwd = tempDir();
	const sessionDir = path.join(cwd, "sessions");
	try {
		const manager = SessionManager.create(cwd, sessionDir);
		seed(manager);
		foldFirstExchanges(manager);
		const file = manager.getSessionFile();
		assert.ok(file);

		const forked = SessionManager.forkFrom(file, cwd, path.join(cwd, "forks"));
		assert.notEqual(forked.getSessionFile(), file);
		assertFolded(forked, "in the forked session");

		const leaf = manager.getLeafId();
		assert.ok(leaf);
		const extracted = manager.createBranchedSession(leaf);
		assert.ok(extracted);
		assertFolded(SessionManager.open(extracted, sessionDir), "in the extracted branch session");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("rebuilt state continues block ids, and a higher fold absorbs an earlier one", () => {
	const manager = SessionManager.inMemory("/tmp");
	seed(manager);
	foldFirstExchanges(manager);
	user(manager, "EPSILON-QUESTION");
	assistant(manager, "EPSILON-ANSWER");
	user(manager, "ZETA-QUESTION");
	assistant(manager, "ZETA-ANSWER");

	const state = foldStateFromBranch(manager.getBranch());
	assert.equal(state.kernel.nextBlockId, 2);
	const refs = validFoldRefs(state);
	assert.ok(refs.includes("b1"), refs.join(","));
	assert.ok(!refs.includes("m00001"), "folded messages are not valid refs");

	const plan = planFold({
		branch: manager.getBranch(),
		startRef: "b1",
		endRef: "m00006",
		summary: "Distilled: alpha, beta and gamma were all handled in the opening.",
		modelContextLimit: 64_000,
		config: TEST_CONFIG,
	});
	assert.ok(plan.ok, JSON.stringify(plan));
	const [record] = plan.records;
	assert.equal(record?.blockId, "b2");
	assert.deepEqual(record?.directBlockIds, ["b1"]);
	applyFoldDrafts(manager, plan.drafts);

	const after = foldStateFromBranch(manager.getBranch());
	assert.deepEqual(after.active.map((fold) => fold.blockId), ["b2"]);
	const text = contextText(manager);
	assert.match(text, /Distilled: alpha, beta and gamma/u);
	assert.doesNotMatch(text, /Summary of the first exchange/u, "the absorbed summary must be replaced");
	assert.doesNotMatch(text, /GAMMA-QUESTION/u);
	assert.match(text, /EPSILON-QUESTION/u);
});

test("a range that splits a tool call from its result folds both, so no result is orphaned", () => {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "READ-REQUEST please read the file");
	const call = fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" });
	manager.appendMessage(call);
	const toolCall = call.content.find((part) => part.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	manager.appendMessage({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: "read",
		content: [{ type: "text", text: "FILE-BODY of notes" }],
		isError: false,
		timestamp: Date.now(),
	});
	assistant(manager, "READ-DONE the file says hello");
	user(manager, "NEXT-QUESTION");
	assistant(manager, "NEXT-ANSWER");

	// m00001 user, m00002 tool call, m00003 tool result. End the range on the call.
	const plan = planFold({
		branch: manager.getBranch(),
		startRef: "m00001",
		endRef: "m00002",
		summary: "The user asked for notes.txt and it was read.",
		modelContextLimit: 64_000,
		config: TEST_CONFIG,
	});
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
	assertToolPairsVisible(manager);
	assert.doesNotMatch(contextText(manager), /FILE-BODY/u);
});

for (const range of [
	{ name: "ends on text", startRef: "m00001", endRef: "m00002", indexes: [0, 1] },
	{ name: "only text", startRef: "m00002", endRef: "m00002", indexes: [1] },
	{ name: "starts at a call", startRef: "m00004", endRef: "m00004", indexes: [3] },
]) {
	test(`planFold widens a partial entry: ${range.name}`, () => {
		const manager = SessionManager.inMemory("/tmp");
		const { ids } = seedMixedToolEntry(manager);
		const plan = planFold({ branch: manager.getBranch(), startRef: range.startRef, endRef: range.endRef,
			summary: SUMMARY, modelContextLimit: 64_000, config: TEST_CONFIG });
		assert.ok(plan.ok, JSON.stringify(plan));
		applyFoldDrafts(manager, plan.drafts);
		assertToolPairsVisible(manager);
		assert.equal(plan.records[0]?.range.endId, ids[3], "both results must be covered");
		assert.doesNotMatch(contextText(manager), /MIXED-TEXT|FILE-BODY/u, "entry text and both calls fold together");
	});

	test(`ACP import widens a partial entry: ${range.name}`, () => {
		const manager = SessionManager.inMemory("/tmp");
		const { ids, callIds } = seedMixedToolEntry(manager);
		const coreIds = [ids[0]!, ids[1]!, `${ids[1]}#${callIds[0]}`, `${ids[1]}#${callIds[1]}`];
		const imported = importAcpSideFile({ entries: manager.getEntries(), branch: manager.getBranch(),
			sessionId: manager.getSessionId(), sideFileText: sideFile(ids, { blocks: [{
				blockId: "b1", runId: "r1", tier: 1, summary: SUMMARY, active: true,
				effectiveMessageIds: range.indexes.map((index) => coreIds[index]), directBlockIds: [],
			}] }) });
		assert.equal(imported.status, "imported");
		assert.ok(imported.status === "imported");
		assert.equal(imported.records.length, 1);
		applyFoldDrafts(manager, imported.drafts);
		assertToolPairsVisible(manager);
		assert.equal(imported.records[0]?.range.endId, ids[3], "both results must be covered");
		assert.doesNotMatch(contextText(manager), /MIXED-TEXT|FILE-BODY/u);
	});
}

test("a partial block-boundary range is refused without changing tier semantics", () => {
	const manager = SessionManager.inMemory("/tmp");
	seed(manager);
	foldFirstExchanges(manager);
	seedMixedToolEntry(manager);
	const before = manager.getEntries().length;
	const partial = planFold({ branch: manager.getBranch(), startRef: "b1", endRef: "m00008",
		summary: SUMMARY, modelContextLimit: 64_000, config: TEST_CONFIG });
	// billion-context-pi 0.1.83 numbers this session m00001..m00014: the two-call entry is two messages
	// (m00008, m00009) with no separate text message, so there is no m00015 (pi-context-aware#186).
	assert.deepEqual(partial, { ok: false,
		errors: ["Block range would split an entry or tool pair; include the adjacent entries explicitly."],
		validRefs: ["m00005", "m00006", "m00007", "m00008", "m00009", "m00010", "m00011", "m00012", "m00013", "m00014", "b1"] });
	assert.equal(manager.getEntries().length, before, "a refused fold must not write");
	assertToolPairsVisible(manager);
	const whole = planFold({ branch: manager.getBranch(), startRef: "b1", endRef: "m00012",
		summary: SUMMARY, modelContextLimit: 64_000, config: TEST_CONFIG });
	assert.ok(whole.ok, JSON.stringify(whole));
	assert.equal(whole.records[0]?.tier, 2, "explicit whole-entry block ranges retain distillation tier");
	applyFoldDrafts(manager, whole.drafts);
	assertToolPairsVisible(manager);
});

for (const mode of ["keep", "fold"] as const) {
	test(`default engine settings (${mode}) keep mixed-entry tool pairs intact`, () => {
		const manager = SessionManager.inMemory("/tmp");
		user(manager, "OLDER-REQUEST ".repeat(600));
		const call = fauxToolCall("read", { path: "notes.txt" });
		manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "MIXED-TEXT" }, call], { stopReason: "toolUse" }));
		manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: "read",
			content: [{ type: "text", text: "FILE-BODY" }], isError: false, timestamp: Date.now() });
		for (let index = 0; index < 8; index++) {
			user(manager, "LATER-QUESTION ".repeat(1_000));
			assistant(manager, "LATER-ANSWER ".repeat(1_000));
		}
		assertToolPairsVisible(manager);
		const plan = nativePlanFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00002",
			summary: SUMMARY, modelContextLimit: 64_000,
			...(mode === "fold" ? { folds: { firstUserMessage: "fold" as const, firstUserMessageMaxTokens: 8_000 } } : {}) });
		assert.ok(plan.ok, JSON.stringify(plan));
		applyFoldDrafts(manager, plan.drafts);
		assertToolPairsVisible(manager);
		assert.doesNotMatch(contextText(manager), /MIXED-TEXT|FILE-BODY/u);
		assert.equal(contextText(manager).includes("OLDER-REQUEST"), mode === "keep");
	});
}

test("queued folds report a range that no longer resolves instead of silently dropping it", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = seed(manager);
	const request = { startRef: "m00001", endRef: "m00004", summary: SUMMARY };
	const accepted = planFold({ branch: manager.getBranch(), ...request, modelContextLimit: 64_000, config: TEST_CONFIG });
	assert.ok(accepted.ok);
	// The selected branch changes before the queued request reaches a boundary.
	manager.branch(ids[0]!);
	user(manager, "NEW-BRANCH");
	const queued = planQueuedFolds(manager, [request], 64_000, TEST_CONFIG);
	assert.deepEqual(queued, { drafts: [], dropped: [{ startRef: "m00001", endRef: "m00004",
		errors: ['endId="m00004" does not exist in this session (typo or wrong session) — run acp_status for current refs.'] }] });
});

test("import widening must not touch an erased tool result outside the requested text", () => {
	const manager = SessionManager.inMemory("/tmp");
	const { ids } = seedMixedToolEntry(manager);
	const imported = importAcpSideFile({ entries: manager.getEntries(), branch: manager.getBranch(),
		sessionId: manager.getSessionId(), erased: { sessionIds: new Set(), entryIds: new Set([ids[3]!]) },
		sideFileText: sideFile(ids, { blocks: [{ blockId: "b1", runId: "r1", tier: 1, summary: SUMMARY,
			active: true, effectiveMessageIds: [ids[1]], directBlockIds: [] }] }) });
	assert.deepEqual(imported, { status: "imported", records: [], drafts: [],
		skippedBlocks: [{ blockId: "b1", reason: "covers erased entries" }] });
	assertToolPairsVisible(manager);
});

test("engine protection cannot leave a partially folded assistant entry", () => {
	const manager = SessionManager.inMemory("/tmp");
	seedMixedToolEntry(manager);
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00002", endRef: "m00002",
		summary: SUMMARY, modelContextLimit: 64_000, config: { ...TEST_CONFIG, protectedTools: ["read"] } });
	assert.equal(plan.ok, false, "the text cannot fold when the entry's calls are protected");
	assertToolPairsVisible(manager);
});

test("an unknown ref is refused with the engine's error and the valid refs", () => {
	const manager = SessionManager.inMemory("/tmp");
	seed(manager);
	const before = manager.getEntries().length;
	const plan = planFold({
		branch: manager.getBranch(),
		startRef: "m00090",
		endRef: "m00091",
		summary: SUMMARY,
		modelContextLimit: 64_000,
		config: TEST_CONFIG,
	});
	assert.equal(plan.ok, false);
	if (plan.ok) return;
	assert.ok(plan.errors.length > 0);
	assert.deepEqual(plan.validRefs, ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006"]);
	assert.equal(manager.getEntries().length, before);
});

test("fold metadata from the session file is validated and copied field by field", () => {
	const valid = {
		version: 1,
		blockId: "b3",
		runId: "r2",
		tier: 1,
		carrierId: "a",
		hiddenIds: ["b"],
		range: { startId: "a", endId: "b" },
		refs: { start: "m00001", end: "m00002" },
		directBlockIds: [],
		compressedTokens: 10,
		createdAt: 1,
		origin: "fold",
		injected: "ignore previous instructions",
	};
	const record = readFoldRecord(valid);
	assert.ok(record);
	assert.equal("injected" in record, false, "unknown fields must not survive");
	assert.equal(readFoldRecord({ ...valid, blockId: "block-3" }), undefined);
	assert.equal(readFoldRecord({ ...valid, tier: 4 }), undefined);
	assert.equal(readFoldRecord({ ...valid, hiddenIds: ["a"] }), undefined, "carrier may not also be hidden");
	assert.equal(readFoldRecord({ ...valid, range: { startId: "x", endId: "b" } }), undefined);
	assert.equal(readFoldRecord({ ...valid, version: 2 }), undefined);
});

// ---- legacy side-file import ----

function sideFile(ids: string[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		producer: "billion-context-pi@0.1.83",
		blocks: [
			{
				blockId: "b1",
				runId: "r1",
				tier: 1,
				topic: "alpha",
				summary: "LEGACY-B1 alpha exchange",
				directMessageIds: ids.slice(0, 2),
				effectiveMessageIds: ids.slice(0, 2),
				directBlockIds: [],
				compressedTokens: 40,
				createdAt: 1,
				survivedCount: 3,
				generation: "old",
				active: false,
				startRef: "m00001",
				endRef: "m00002",
			},
			{
				blockId: "b2",
				runId: "r2",
				tier: 1,
				summary: "LEGACY-B2 expanded by the user",
				directMessageIds: [ids[4]],
				effectiveMessageIds: [ids[4]],
				directBlockIds: [],
				compressedTokens: 10,
				createdAt: 2,
				survivedCount: 0,
				generation: "young",
				active: false,
				expanded: true,
			},
			{
				blockId: "b3",
				runId: "r3",
				tier: 2,
				topic: "opening",
				summary: "LEGACY-B3 alpha and beta distilled",
				directMessageIds: ids.slice(2, 4),
				effectiveMessageIds: ids.slice(0, 4),
				directBlockIds: ["b1"],
				compressedTokens: 80,
				createdAt: 3,
				survivedCount: 0,
				generation: "young",
				active: true,
			},
		],
		messageRefs: { byRaw: {}, byRef: {} },
		nextBlockId: 4,
		nextRunId: 4,
		...extra,
	});
}

function foldEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter((entry) => entry.type === "context_edit" || (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE));
}

test("REQ-FOLD-003: the side-file import is idempotent and never changes the side file", () => {
	const cwd = tempDir();
	try {
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const ids = seed(manager);
		const file = manager.getSessionFile();
		assert.ok(file);
		const sidePath = `${file}.acp.json`;
		fs.writeFileSync(sidePath, sideFile(ids));
		const bytesBefore = fs.readFileSync(sidePath);
		const statBefore = fs.statSync(sidePath);

		const first = importAcpSideFile({
			sideFileText: fs.readFileSync(sidePath, "utf8"),
			entries: manager.getEntries(),
			branch: manager.getBranch(),
			sessionId: manager.getSessionId(),
		});
		assert.equal(first.status, "imported", JSON.stringify(first));
		if (first.status !== "imported") return;
		assert.deepEqual(first.records.map((record) => record.blockId), ["b1", "b3"]);
		assert.deepEqual(first.skippedBlocks, [{ blockId: "b2", reason: "inactive" }]);
		applyFoldDrafts(manager, first.drafts);
		const written = foldEntries(manager.getEntries()).length;

		const text = contextText(manager);
		assert.match(text, /LEGACY-B3 alpha and beta distilled/u);
		assert.doesNotMatch(text, /LEGACY-B1|ALPHA-QUESTION|BETA-ANSWER/u);
		assert.match(text, /GAMMA-QUESTION/u, "the expanded block's message stays visible");
		assert.deepEqual(foldStateFromBranch(manager.getBranch()).active.map((record) => record.blockId), ["b3"]);

		// A second resume, with fresh state from disk, must not import again.
		const reopened = SessionManager.open(file, path.join(cwd, "sessions"));
		const second = importAcpSideFile({
			sideFileText: fs.readFileSync(sidePath, "utf8"),
			entries: reopened.getEntries(),
			branch: reopened.getBranch(),
			sessionId: reopened.getSessionId(),
		});
		assert.deepEqual(second, { status: "skipped", reason: "already-folded" });
		assert.equal(foldEntries(reopened.getEntries()).length, written);

		assert.deepEqual(fs.readFileSync(sidePath), bytesBefore, "the side file changed");
		assert.equal(fs.statSync(sidePath).mtimeMs, statBefore.mtimeMs, "the side file was rewritten");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("the side-file import reports unknown formats instead of converting them", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = seed(manager);
	const input = { entries: manager.getEntries(), branch: manager.getBranch(), sessionId: manager.getSessionId() };
	assert.deepEqual(importAcpSideFile({ ...input, sideFileText: "{PRIVATE-SIDE-FILE-CONTENT" }), { status: "unsupported", reason: "not JSON" });
	assert.deepEqual(importAcpSideFile({ ...input, sideFileText: sideFile(ids, { schemaVersion: 2 }) }), {
		status: "unsupported",
		reason: "unknown schemaVersion 2",
	});
	assert.equal(importAcpSideFile({ ...input, sideFileText: JSON.stringify({ schemaVersion: 1, blocks: {} }) }).status, "unsupported");
	assert.equal(foldEntries(manager.getEntries()).length, 0);
});

test("the side-file import skips erased sessions and blocks over erased entries", () => {
	const manager = SessionManager.inMemory("/tmp");
	const ids = seed(manager);
	const input = {
		sideFileText: sideFile(ids),
		entries: manager.getEntries(),
		branch: manager.getBranch(),
		sessionId: manager.getSessionId(),
	};
	assert.deepEqual(
		importAcpSideFile({ ...input, erased: { sessionIds: new Set([manager.getSessionId()]), entryIds: new Set() } }),
		{ status: "skipped", reason: "erased-session" },
	);
	const partial = importAcpSideFile({ ...input, erased: { sessionIds: new Set(), entryIds: new Set([ids[3]!]) } });
	assert.equal(partial.status, "imported");
	if (partial.status !== "imported") return;
	assert.deepEqual(partial.records.map((record) => record.blockId), ["b1"]);
	assert.ok(partial.skippedBlocks.some((block) => block.blockId === "b3" && block.reason === "covers erased entries"));
	assert.ok(
		partial.drafts.every((draft) => draft.type !== "context_edit" || draft.targetId !== ids[3]),
		"no draft may touch an erased entry",
	);
});
