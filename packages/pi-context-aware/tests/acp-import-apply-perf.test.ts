import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { applyDraftsLinear } from "../src/folds/branch-cache.js";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { registerAcpStartupImport } from "../src/folds/acp-startup-import.js";
import { foldDrafts, type FoldRecord } from "../src/folds/fold-entries.js";

// pi-context-aware#254: applying imported folds must cost time in proportion to the session. Pi's
// appendContextEdit walks the whole branch for every append, which made a 24,000-entry import take
// 31 s to 189 s (quadratic) and block session_start. These tests drive the real handler and the real
// session manager on temp files under the test temp root.

function tempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-acp-perf-")));
}

function appendEntries(manager: SessionManager, count: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		ids.push(i % 2 === 0
			? manager.appendMessage({ role: "user", content: `question ${i}`, timestamp: 1 })
			: manager.appendMessage(fauxAssistantMessage(`answer ${i}`)));
	}
	return ids;
}

function block(blockId: string, tier: number, cover: string[], direct: string[] = []) {
	return {
		blockId, runId: "r1", tier, summary: `SUMMARY ${blockId}`, directMessageIds: cover, effectiveMessageIds: cover, directBlockIds: direct,
		compressedTokens: 1, createdAt: 1, survivedCount: 0, generation: "young", active: true,
	};
}

function threeTierSideFile(ids: string[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		blocks: [block("b1", 1, ids), block("b2", 2, ids, ["b1"]), block("b3", 3, ids, ["b2"])],
		messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 4, nextRunId: 2,
	});
}

async function startImport(root: string, manager: SessionManager): Promise<string[]> {
	const handlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { if (name === "session_start") handlers.push(handler); }, getAllTools: () => [] } as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi);
	const warnings: string[] = [];
	registerAcpStartupImport(pi, { engine, agentDir: () => root, warn: (_ctx, message) => warnings.push(message) });
	const ctx = { cwd: manager.getCwd(), sessionManager: manager, model: undefined, hasUI: false } as unknown as ExtensionContext;
	for (const handler of handlers) await handler({ type: "session_start", reason: "resume" }, ctx);
	return warnings;
}

// Bound: 15 s for a 24,000-entry session with a three-tier fold (72,003 appended entries). The linear
// apply takes under 1 s on the development host; the quadratic one took 189 s there. 15 s leaves 15x
// headroom for a slow shared CI runner, and is still more than 10x under the smallest quadratic
// measurement, so a slow runner does not fail it and a regression to a per-append branch walk does.
// A regressed run is synchronous, so it cannot be cut short: it fails on the bound after it ends.
// The next test is the fast, deterministic guard for the same regression.
const BOUND_MS = 15_000;

test("#254 import of a 24,000-entry session with a three-tier fold is fast and complete", async () => {
	const root = tempDir();
	try {
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const ids = appendEntries(manager, 24_000);
		const file = manager.getSessionFile();
		assert.ok(file);
		fs.writeFileSync(`${file}.acp.json`, threeTierSideFile(ids));
		const before = manager.getEntries().length;
		const started = performance.now();
		const warnings = await startImport(root, manager);
		const elapsed = performance.now() - started;
		assert.deepEqual(warnings, []);
		// Per block: one carrier edit, 23,999 hide edits, one metadata entry; three blocks.
		assert.equal(manager.getEntries().length - before, 3 * 24_001);
		assert.ok(elapsed < BOUND_MS, `import took ${Math.round(elapsed)} ms, bound ${BOUND_MS} ms`);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254 applying n drafts walks the branch O(1) times, not once per draft", () => {
	const manager = SessionManager.inMemory();
	const ids = appendEntries(manager, 3000);
	const proto = SessionManager.prototype as unknown as { getBranch(this: SessionManager, fromId?: string): unknown[] };
	const original = proto.getBranch;
	let visited = 0;
	proto.getBranch = function (this: SessionManager, fromId?: string) { const path = original.call(this, fromId); visited += path.length; return path; };
	try {
		applyDraftsLinear(manager, foldDrafts(record(ids[0]!, ids.slice(1)), "FOLDED"));
	} finally { proto.getBranch = original; }
	// A walk per draft would visit about 3000 x 4500 entries. One walk to start visits the 3000.
	assert.ok(visited < 3000 * 4, `getBranch visited ${visited} entries`);
});

function record(carrierId: string, hiddenIds: string[]): FoldRecord {
	return {
		version: 1, blockId: "b1", runId: "r1", tier: 1, carrierId, hiddenIds, range: { startId: carrierId, endId: hiddenIds.at(-1) ?? carrierId },
		refs: { start: "", end: "" }, directBlockIds: [], compressedTokens: 1, createdAt: 1, origin: "acp-import",
	};
}

test("#254 applyDraftsLinear appends what Pi's own appends append, and leaves the manager as it found it", () => {
	const plain = SessionManager.inMemory();
	const fast = SessionManager.inMemory();
	const plainIds = appendEntries(plain, 40);
	const fastIds = appendEntries(fast, 40);
	const shape = (manager: SessionManager, ids: string[], ids2 = ids) =>
		manager.getEntries().slice(40).map((entry) => entry.type === "context_edit"
			? { type: entry.type, target: ids2.indexOf(entry.targetId), replacement: entry.replacement }
			: { type: entry.type });
	const drafts = (ids: string[]) => foldDrafts(record(ids[0]!, ids.slice(1, 30)), "FOLDED");
	for (const draft of drafts(plainIds)) {
		if (draft.type === "context_edit") plain.appendContextEdit(draft.targetId, draft.replacement); else if (draft.type === "custom") plain.appendCustomEntry(draft.customType, draft.data);
	}
	applyDraftsLinear(fast, drafts(fastIds));
	assert.deepEqual(shape(fast, fastIds), shape(plain, plainIds));
	assert.equal(fast.getBranch().length, plain.getBranch().length);
	assert.equal(Object.getOwnPropertyDescriptor(fast, "getBranch"), undefined, "the instance override is removed");
	assert.equal(JSON.stringify(fast.buildSessionContext().messages).includes("FOLDED"), true);
});

test("#254 applyDraftsLinear still refuses a target that is not on the active branch", () => {
	const manager = SessionManager.inMemory();
	const ids = appendEntries(manager, 6);
	// Move the leaf back and add a sibling branch; ids[4] and ids[5] are now off the active branch.
	manager.branch(ids[2]!);
	const side = manager.appendMessage({ role: "user", content: "side", timestamp: 1 });
	const entriesBefore = manager.getEntries().length;
	assert.throws(() => applyDraftsLinear(manager, [{ type: "context_edit", targetId: ids[4]!, replacement: { content: "x" } }]), /not on the active branch/u);
	assert.equal(manager.getEntries().length, entriesBefore);
	assert.doesNotThrow(() => applyDraftsLinear(manager, [{ type: "context_edit", targetId: side, replacement: { content: "ok" } }]));
	assert.equal(Object.getOwnPropertyDescriptor(manager, "getBranch"), undefined, "the instance override is removed after a refusal too");
});

test("#254 applyDraftsLinear refuses a draft of a kind folds never contain, and a later append still works", () => {
	const manager = SessionManager.inMemory();
	const ids = appendEntries(manager, 4);
	const bad = { type: "compaction" } as unknown as SessionBoundaryDraft;
	assert.throws(() => applyDraftsLinear(manager, [{ type: "context_edit", targetId: ids[0]!, replacement: { content: "x" } }, bad]), /never contain compaction/u);
	assert.doesNotThrow(() => manager.appendContextEdit(ids[1]!, { content: "later" }));
});

test("#254 applyDraftsLinear counts the entries .some scans: the shortcut keeps it linear", () => {
	const manager = SessionManager.inMemory();
	const ids = appendEntries(manager, 3000);
	const original = Array.prototype.some;
	let scanned = 0;
	// Only scans that reach Array.prototype.some are counted; the branch's own shortcut bypasses it.
	Array.prototype.some = function (this: unknown[], predicate: (value: unknown, index: number, all: unknown[]) => unknown, thisArg?: unknown): boolean {
		return original.call(this, (value: unknown, index: number, all: unknown[]) => { scanned++; return predicate.call(thisArg, value, index, all); });
	};
	try {
		applyDraftsLinear(manager, foldDrafts(record(ids[0]!, ids.slice(1)), "FOLDED"));
	} finally { Array.prototype.some = original; }
	// Without the shortcut each hide edit scans up to its target's position: about 3000 x 3000 / 2 entries.
	assert.ok(scanned < 3000 * 4, `.some scanned ${scanned} entries`);
});

test("#254 applyDraftsLinear drops the cache when an append lands under a parent other than the tip", () => {
	const manager = SessionManager.inMemory();
	const ids = appendEntries(manager, 6);
	const append = manager.appendContextEdit.bind(manager);
	let calls = 0;
	// The first append is placed under ids[1], so ids[2..5] leave the active branch. The leaf still moves to the new entry.
	manager.appendContextEdit = (targetId, replacement) => {
		if (calls++ === 0) manager.branch(ids[1]!);
		return append(targetId, replacement);
	};
	const drafts: SessionBoundaryDraft[] = [
		{ type: "context_edit", targetId: ids[0]!, replacement: { content: "x" } },
		{ type: "context_edit", targetId: ids[5]!, replacement: { content: "y" } },
	];
	assert.throws(() => applyDraftsLinear(manager, drafts), /not on the active branch/u);
	assert.equal(Object.getOwnPropertyDescriptor(manager, "getBranch"), undefined);
});

