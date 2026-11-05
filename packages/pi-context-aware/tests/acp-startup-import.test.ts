import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { registerAcpStartupImport } from "../src/folds/acp-startup-import.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";
import { importAcpSideFile } from "../src/folds/acp-import.js";
import { SessionDatabase } from "../src/erasure/database.js";

// pi-context-aware#254: a session with a billion-context-pi side file and no native folds is imported
// once, at session_start, and only when this extension owns folding. These tests drive the real fold
// engine and the real session manager on temp files; the host is a fake Pi that fires session_start.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";

function tempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-acp-startup-")));
}

interface Harness {
	readonly warnings: string[];
	readonly logs: string[];
	start(manager: SessionManager): Promise<void>;
}

function boot(agentDir: string, shadow = false): Harness {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => shadow ? ["compress", "acp_status"].map((name) => ({ name, sourceInfo: { path: BCP_PATH } })) : [],
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi);
	const warnings: string[] = [];
	const logs: string[] = [];
	registerAcpStartupImport(pi, { engine, agentDir: () => agentDir, warn: (_ctx, message) => warnings.push(message), log: (message) => logs.push(message) });
	return {
		warnings,
		logs,
		async start(manager) {
			const ctx = { cwd: manager.getCwd(), sessionManager: manager, model: undefined, hasUI: false } as unknown as ExtensionContext;
			for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "resume" }, ctx);
		},
	};
}

function seed(manager: SessionManager): string[] {
	const user = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	const assistant = (text: string) => manager.appendMessage(fauxAssistantMessage(text));
	return [
		user("ALPHA-QUESTION about the first topic"), assistant("ALPHA-ANSWER with details"),
		user("BETA-QUESTION about the second topic"), assistant("BETA-ANSWER with details"),
		user("GAMMA-QUESTION still open"), assistant("GAMMA-ANSWER in progress"),
	];
}

function sideFile(ids: string[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		producer: "billion-context-pi@0.1.83",
		blocks: [{
			blockId: "b1", runId: "r1", tier: 1, topic: "opening", summary: "LEGACY-B1 alpha and beta settled",
			directMessageIds: ids.slice(0, 4), effectiveMessageIds: ids.slice(0, 4), directBlockIds: [],
			compressedTokens: 40, createdAt: 1, survivedCount: 0, generation: "young", active: true,
			startRef: "m00001", endRef: "m00004",
		}],
		messageRefs: { byRaw: {}, byRef: {} },
		nextBlockId: 2,
		nextRunId: 2,
	});
}

const foldEntries = (entries: readonly SessionEntry[]) =>
	entries.filter((entry) => entry.type === "context_edit" || (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE));
const contextText = (manager: SessionManager) => JSON.stringify(manager.buildSessionContext().messages);

/** A persisted session with six entries and the given side-file text next to it. */
function fixture(root: string, text?: (ids: string[]) => string) {
	const dir = path.join(root, "sessions");
	const manager = SessionManager.create(root, dir);
	const ids = seed(manager);
	const file = manager.getSessionFile();
	assert.ok(file, "the fixture session has a file");
	const sidePath = `${file}.acp.json`;
	if (text) fs.writeFileSync(sidePath, text(ids));
	return { dir, manager, ids, file, sidePath };
}

test("#254: session_start imports the side file once into a session with no native folds", async () => {
	const root = tempDir();
	try {
		const { dir, manager, file, sidePath } = fixture(root, sideFile);
		const bytes = fs.readFileSync(sidePath);
		const harness = boot(root);
		await harness.start(manager);
		assert.ok(foldEntries(manager.getEntries()).length > 0, "folds were written");
		assert.match(contextText(manager), /LEGACY-B1 alpha and beta settled/u);
		assert.doesNotMatch(contextText(manager), /ALPHA-QUESTION|BETA-ANSWER/u);
		assert.match(contextText(manager), /GAMMA-QUESTION/u, "the uncovered tail stays visible");
		assert.deepEqual(harness.warnings, []);

		// The same runtime starting the session again, and a fresh process reading it from disk, write nothing more.
		const written = foldEntries(manager.getEntries()).length;
		await harness.start(manager);
		assert.equal(foldEntries(manager.getEntries()).length, written, "second start in the same runtime");
		const reopened = SessionManager.open(file, dir);
		assert.equal(foldEntries(reopened.getEntries()).length, written, "the folds were persisted");
		await boot(root).start(reopened);
		assert.equal(foldEntries(reopened.getEntries()).length, written, "second start in a new process");
		assert.deepEqual(fs.readFileSync(sidePath), bytes, "the side file is never written");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254: in shadow mode (billion-context-pi loaded) nothing is imported", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, sideFile);
		const before = manager.getEntries().length;
		const harness = boot(root, true);
		await harness.start(manager);
		assert.equal(manager.getEntries().length, before);
		assert.deepEqual(harness.warnings, []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254: a corrupt side file gives one warning and leaves the session unchanged and usable", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, () => "{ not json");
		const before = manager.getEntries().length;
		const harness = boot(root);
		await harness.start(manager);
		await harness.start(manager);
		assert.equal(harness.warnings.length, 1, harness.warnings.join("\n"));
		assert.match(harness.warnings[0]!, /side file/u);
		assert.equal(manager.getEntries().length, before);
		manager.appendMessage({ role: "user", content: "still works", timestamp: Date.now() });
		assert.match(contextText(manager), /still works/u);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254: an unsupported side-file schema gives one warning and writes nothing", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, (ids) => sideFile(ids).replace('"schemaVersion":1', '"schemaVersion":2'));
		const before = manager.getEntries().length;
		const harness = boot(root);
		await harness.start(manager);
		assert.equal(harness.warnings.length, 1);
		assert.match(harness.warnings[0]!, /schemaVersion/u);
		assert.equal(manager.getEntries().length, before);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254: a session with no side file, or one that already has native folds, is left alone without a warning", async () => {
	const root = tempDir();
	try {
		const bare = fixture(root);
		const harness = boot(root);
		await harness.start(bare.manager);
		assert.equal(foldEntries(bare.manager.getEntries()).length, 0);
		assert.deepEqual(harness.warnings, []);

		// Native folds win: a corrupt side file next to a folded session is not even read.
		const folded = fixture(path.join(root, "folded"), sideFile);
		await boot(root).start(folded.manager);
		const written = foldEntries(folded.manager.getEntries()).length;
		fs.writeFileSync(folded.sidePath, "{ not json");
		const again = boot(root);
		await again.start(folded.manager);
		await again.start(SessionManager.open(folded.file, folded.dir));
		assert.equal(foldEntries(folded.manager.getEntries()).length, written);
		assert.deepEqual(again.warnings, []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254: an erased session is never imported", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, sideFile);
		const db = new SessionDatabase(root);
		db.erase([manager.getSessionId()]);
		db.close();
		const before = manager.getEntries().length;
		const harness = boot(root);
		await harness.start(manager);
		assert.equal(manager.getEntries().length, before);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function blockFor(blockId: string, ids: string[], extra: Record<string, unknown> = {}) {
	return {
		blockId, runId: "r1", tier: 1, summary: `LEGACY-${blockId}`, directMessageIds: ids, effectiveMessageIds: ids,
		directBlockIds: [], compressedTokens: 1, createdAt: 1, survivedCount: 0, generation: "young", active: true, ...extra,
	};
}
const sideOf = (blocks: unknown[], schemaVersion: unknown = 1) => JSON.stringify({ schemaVersion, blocks, messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 2, nextRunId: 2 });

test("#254 CR-SIDECAR-DUP-BLOCK-AMPLIFY: a sidecar that repeats one blockId is imported once, fast", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, (ids) => sideOf(Array.from({ length: 4000 }, () => blockFor("b1", ids.slice(0, 4)))));
		const before = manager.getEntries().length;
		const harness = boot(root);
		const started = Date.now();
		await harness.start(manager);
		assert.ok(Date.now() - started < 2000, "the import finishes fast");
		// One block: a carrier edit, three hidden edits, one metadata entry.
		assert.equal(manager.getEntries().length - before, 5);
		assert.deepEqual(harness.warnings, []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254 CR-SIDECAR-DUP-BLOCK-AMPLIFY: more blocks than the cap gives one warning and imports nothing", async () => {
	const root = tempDir();
	try {
		const blocks = (ids: string[]) => [blockFor("b1", ids.slice(0, 4)), ...Array.from({ length: 2000 }, (_, i) => blockFor(`b${i + 2}`, ids.slice(0, 2), { active: false }))];
		const { manager } = fixture(root, (ids) => sideOf(blocks(ids)));
		const before = manager.getEntries().length;
		const harness = boot(root);
		await harness.start(manager);
		assert.equal(harness.warnings.length, 1, harness.warnings.join("\n"));
		assert.match(harness.warnings[0]!, /too many blocks/u);
		assert.equal(manager.getEntries().length, before, "no partial import");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function longSession(count: number): { manager: SessionManager; ids: string[] } {
	const manager = SessionManager.inMemory();
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push(manager.appendMessage({ role: "user", content: `m${i}`, timestamp: Date.now() }));
	return { manager, ids };
}

test("#254 CR-SIDECAR-ENTRY-CAP-REFUSES-LONG-SESSION: a legitimate fold over 4,000 entries imports fully", () => {
	const { manager, ids } = longSession(4100);
	const result = importAcpSideFile({
		sideFileText: sideOf([blockFor("b1", ids)]), entries: manager.getEntries(), branch: manager.getBranch(), sessionId: manager.getSessionId(),
	});
	assert.equal(result.status, "imported");
	// One carrier, 4,099 hidden entries, one metadata entry.
	assert.equal((result as { drafts: unknown[] }).drafts.length, 4101);
});

test("#254 CR-SIDECAR-DUP-BLOCK-AMPLIFY: blocks that each re-cover the whole branch past the budget import nothing, fast", () => {
	const { manager, ids } = longSession(4100);
	// 20 distinct kept blocks x 4,100 entries = 82,000 drafts; the budget is 4 x 4,100 + 2 x 20.
	const blocks = Array.from({ length: 20 }, (_, i) => blockFor(`b${i + 1}`, ids));
	const started = Date.now();
	const result = importAcpSideFile({
		sideFileText: sideOf(blocks), entries: manager.getEntries(), branch: manager.getBranch(), sessionId: manager.getSessionId(),
	});
	assert.ok(Date.now() - started < 2000, "refusal is fast");
	assert.equal(result.status, "unsupported");
	assert.match((result as { reason: string }).reason, /too many entries/u);
});

test("#254 CR-SIDECAR-REASON-UNBOUNDED: a huge schemaVersion is cut in the warning and the log", async () => {
	const root = tempDir();
	try {
		const { manager } = fixture(root, () => sideOf([], "x".repeat(3_000_000)));
		const harness = boot(root);
		await harness.start(manager);
		assert.equal(harness.warnings.length, 1);
		assert.match(harness.warnings[0]!, /schemaVersion/u);
		assert.ok(harness.warnings[0]!.length < 400, `warning is ${harness.warnings[0]!.length} characters`);
		assert.ok(harness.logs.length > 0);
		assert.ok(harness.logs.every((line) => line.length < 400), "log lines are bounded");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254 CR-DRYRUN-GUARD-UNTESTED: a draft Pi refuses leaves the session file unchanged", async () => {
	const root = tempDir();
	try {
		// Pi refuses the third edit of the fold (as a newer Pi might refuse a draft this code builds). The refusal
		// comes after the carrier and one hide edit, so only a dry run keeps those two out of the file.
		const { manager, file, ids } = fixture(root, (ids) => sideOf([blockFor("b1", ids.slice(0, 4))]));
		const before = fs.readFileSync(file, "utf8");
		const proto = SessionManager.prototype as unknown as { appendContextEdit(targetId: string, replacement: unknown): string };
		const original = proto.appendContextEdit;
		proto.appendContextEdit = function (this: unknown, targetId, replacement) {
			if (targetId === ids[2]) throw new Error("Pi refuses this edit");
			return original.call(this, targetId, replacement);
		};
		const harness = boot(root);
		try { await harness.start(manager); } finally { proto.appendContextEdit = original; }
		assert.equal(harness.warnings.length, 1, harness.warnings.join("\n"));
		assert.match(harness.warnings[0]!, /Pi refuses this edit/u);
		assert.equal(fs.readFileSync(file, "utf8"), before, "nothing half-applied reached the file");
		assert.equal(manager.getEntries().length, ids.length);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254 CR-DRYRUN-GUARD-UNTESTED: a session with native folds never opens its side file", async () => {
	const root = tempDir();
	try {
		const folded = fixture(root, sideFile);
		await boot(root).start(folded.manager);
		assert.ok(foldEntries(folded.manager.getEntries()).length > 0);
		// A directory in place of the side file: opening it as a file warns, so no warning shows it was never opened.
		fs.rmSync(folded.sidePath);
		fs.mkdirSync(folded.sidePath);
		const again = boot(root);
		await again.start(SessionManager.open(folded.file, folded.dir));
		assert.deepEqual(again.warnings, []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("#254 CR-FORK-BRANCH-UNTESTED: a sidecar that covers part of the session folds that part and never imports the rest", async () => {
	const root = tempDir();
	try {
		const dir = path.join(root, "sessions");
		const manager = SessionManager.create(root, dir);
		const ids = seed(manager);
		manager.branch(ids[1]!);
		const other = [
			manager.appendMessage({ role: "user", content: "FORK-QUESTION on the other branch", timestamp: Date.now() }),
			manager.appendMessage(fauxAssistantMessage("FORK-ANSWER on the other branch")),
		];
		manager.branch(ids[5]!);
		const file = manager.getSessionFile()!;
		fs.writeFileSync(`${file}.acp.json`, sideOf([blockFor("b1", ids.slice(0, 4)), blockFor("b2", other, { summary: "LEGACY-OTHER-BRANCH" })]));

		const harness = boot(root);
		await harness.start(manager);
		assert.match(contextText(manager), /LEGACY-b1/u, "the covered part is folded");
		assert.deepEqual(harness.warnings, []);

		// The same session resumed on the other branch: native folds exist, so b2 is not imported.
		const reopened = SessionManager.open(file, dir);
		reopened.branch(other[1]!);
		const written = foldEntries(reopened.getEntries()).length;
		await boot(root).start(reopened);
		assert.equal(foldEntries(reopened.getEntries()).length, written);
		assert.doesNotMatch(contextText(reopened), /LEGACY-OTHER-BRANCH/u);
		assert.match(contextText(reopened), /FORK-ANSWER/u, "the other branch stays unfolded");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("#279 acp-import bounds block and run ids to nine digits", () => {
	const { manager, ids } = longSession(4);
	const run = (block: unknown) => importAcpSideFile({
		sideFileText: sideOf([block]), entries: manager.getEntries(), branch: manager.getBranch(), sessionId: manager.getSessionId(),
	}) as { status: string; records: { blockId: string; runId: string }[]; skippedBlocks: { reason: string }[] };
	const huge = "9".repeat(400);
	const hugeBlock = run(blockFor(`b${huge}`, ids));
	assert.equal(hugeBlock.records.length, 0, "a 400-digit block id imports nothing");
	assert.deepEqual(hugeBlock.skippedBlocks.map((s) => s.reason), ["invalid blockId"]);
	const hugeRun = run(blockFor("b1", ids, { runId: `r${huge}` }));
	assert.equal(hugeRun.records.length, 0, "a 400-digit run id imports nothing");
	assert.deepEqual(hugeRun.skippedBlocks.map((s) => s.reason), ["invalid runId"]);
	const tenDigits = run(blockFor("b1000000000", ids));
	assert.deepEqual(tenDigits.skippedBlocks.map((s) => s.reason), ["invalid blockId"]);
	assert.deepEqual(run(blockFor("b1", ids, { runId: "r1000000000" })).skippedBlocks.map((s) => s.reason), ["invalid runId"]);
	const nine = run(blockFor("b999999999", ids, { runId: "r999999999" }));
	assert.equal(nine.status, "imported");
	assert.deepEqual(nine.records.map((r) => [r.blockId, r.runId]), [["b999999999", "r999999999"]]);
	assert.deepEqual(nine.skippedBlocks, []);
});

