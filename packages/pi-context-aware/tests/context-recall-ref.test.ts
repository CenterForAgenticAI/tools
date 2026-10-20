import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { MAX_REF_PAGE_CHARACTERS, type ContextRecallRefResult } from "../src/context-tools/context-recall-ref.js";
import { createContextRecallSurface } from "../src/context-tools/context-recall.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { foldDrafts, renderFoldSummary, type FoldRecord } from "../src/folds/fold-entries.js";
import { guardErasureWrites } from "../src/erasure/write-boundary.js";
import { createHostPi, createSession, type FakeHostPi } from "./compaction-owner-harness.js";

// These tests refuse sessions on purpose. Without UI, a refusal sets process.exitCode = 1, which node:test reads as a failed file.
let exitCodeBefore: typeof process.exitCode;
beforeEach(() => { exitCodeBefore = process.exitCode; });
afterEach(() => { process.exitCode = exitCodeBefore; });

// Seams: the registered context_recall and decompress tools after session_start,
// over a real Pi SessionManager holding a fold written with foldDrafts.

interface RefTool {
	exposure?: string;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ContextRecallRefResult>;
}

const SUMMARY = "Summary: the user asked about the deploy and the assistant answered.";
// Known-good original text, written into the session below and expected back byte for byte.
const ORIGINAL_QUESTION = "FOLDED-QUESTION: how do we deploy?\n  Keep  the two spaces,\ttabs, and \"quotes\" exactly.";
const ORIGINAL_ANSWER = "FOLDED-ANSWER: run `npm run release` — then tag it.";

function record(carrierId: string, hiddenIds: string[], blockId = "b1"): FoldRecord {
	return {
		version: 1,
		blockId,
		runId: "r1",
		tier: 1,
		topic: "deploy",
		carrierId,
		hiddenIds,
		range: { startId: carrierId, endId: hiddenIds.at(-1) ?? carrierId },
		refs: { start: "m00001", end: "m00002" },
		directBlockIds: [],
		compressedTokens: 40,
		createdAt: 1,
		origin: "fold",
	};
}

/** A session with one folded exchange followed by one visible exchange. */
function foldedSession(texts: { question: string; answer: string } = { question: ORIGINAL_QUESTION, answer: ORIGINAL_ANSWER }) {
	const manager = SessionManager.inMemory("/tmp");
	const question = manager.appendMessage({ role: "user", content: texts.question, timestamp: 1 });
	const answer = manager.appendMessage(fauxAssistantMessage(texts.answer));
	manager.appendMessage({ role: "user", content: "VISIBLE-QUESTION still open", timestamp: 3 });
	manager.appendMessage(fauxAssistantMessage("VISIBLE-ANSWER in progress"));
	applyFoldDrafts(manager, foldDrafts(record(question, [answer]), renderFoldSummary(SUMMARY, "deploy")));
	return { manager, question, answer };
}

function contextText(manager: SessionManager): string {
	return JSON.stringify(manager.buildSessionContext().messages);
}

const entriesOfType = (manager: SessionManager, type: string) => JSON.stringify(manager.getBranch().filter((entry) => entry.type === type || (entry.type === "custom" && type === "fold" && entry.customType === "context-aware.fold.v1")));

async function started(manager: SessionManager, options: { billionContextPi?: boolean; refused?: () => boolean } = {}) {
	const host: FakeHostPi = createHostPi();
	if (options.billionContextPi) for (const name of ["compress", "acp_status"]) host.tools.set(name, { name });
	const pi: ExtensionAPI = options.refused ? guardErasureWrites(host.api, options.refused) : host.api;
	const surface = createContextRecallSurface(pi, {
		listSessions: async () => { throw new Error("ref mode must not list sessions"); },
		erasedSessionIds: () => new Set(),
		cachePools: () => [],
		home: () => os.homedir(),
	});
	const tools = [...host.tools.values()] as Array<{ name: string }>;
	surface.apply(decideContextToolSurface(tools, undefined), options.billionContextPi === true);
	const ctx = { ...createSession("/tmp", "ref-session").ctx, sessionManager: manager } as unknown as ExtensionContext;
	const call = (name: string, params: Record<string, unknown>) => (host.tools.get(name) as RefTool | undefined)?.execute(`${name}-call`, params, new AbortController().signal, undefined, ctx);
	return { host, call };
}

const body = (result: ContextRecallRefResult | undefined): string => result?.content.map((part) => part.text).join("\n") ?? "";

test("REQ-193-4: after a fold written with foldDrafts, context_recall({ ref }) returns the original text byte for byte", async () => {
	const { manager, question, answer } = foldedSession();
	// The folded context view hides the original and shows the summary.
	assert.doesNotMatch(contextText(manager), /FOLDED-QUESTION/u);
	assert.match(contextText(manager), /Summary: the user asked about the deploy/u);
	const { call } = await started(manager);
	const result = await call("context_recall", { ref: "b1" });
	assert.ok(result);
	assert.equal(result.isError, undefined, body(result));
	assert.deepEqual(result.details.entry_ids, [question, answer]);
	const text = body(result);
	assert.ok(text.includes(`--- ${question} (user) ---\n${ORIGINAL_QUESTION}\n\n--- ${answer} (assistant) ---\n${ORIGINAL_ANSWER}`), text);
	assert.doesNotMatch(text, /Summary: the user asked about the deploy/u, "ref mode must not read the folded view");
	assert.doesNotMatch(text, /VISIBLE-QUESTION/u, "ref mode returns the fold's entries only");
});

test("REQ-193-4: ref mode writes nothing: the context_edit and fold entries stay, and the next context still shows the fold", async () => {
	const { manager } = foldedSession();
	const before = { entries: manager.getEntries().length, edits: entriesOfType(manager, "context_edit"), folds: entriesOfType(manager, "fold"), context: contextText(manager) };
	const { call, host } = await started(manager);
	await call("context_recall", { ref: "b1" });
	await call("decompress", { blockId: "b1" });
	assert.equal(manager.getEntries().length, before.entries);
	assert.equal(entriesOfType(manager, "context_edit"), before.edits);
	assert.equal(entriesOfType(manager, "fold"), before.folds);
	assert.equal(contextText(manager), before.context, "the next context still shows the fold");
	assert.doesNotMatch(contextText(manager), /FOLDED-QUESTION/u);
	assert.deepEqual(host.entries, [], "no extension entry was appended");
	assert.deepEqual(host.messages, [], "no message was sent");
});

test("REQ-193-4: decompress is an alias of context_recall({ ref }) and is deferred while billion-context-pi is absent", async () => {
	const { manager } = foldedSession();
	const { call, host } = await started(manager);
	assert.equal((host.tools.get("decompress") as RefTool).exposure, "deferred");
	const viaAlias = await call("decompress", { blockId: "b1", full: true, inline: true, toFile: "/tmp/ignored.txt" });
	const direct = await call("context_recall", { ref: "b1" });
	assert.deepEqual(viaAlias, direct);
	assert.equal(fs.existsSync("/tmp/ignored.txt"), false, "toFile is ignored, not written");
});

test("REQ-193-4: an unknown ref, or a query with a ref, is refused without reading anything", async () => {
	const { manager } = foldedSession();
	const { call } = await started(manager);
	const unknown = await call("context_recall", { ref: "b9" });
	assert.equal(unknown?.isError, true);
	assert.equal(unknown?.details.error, "unknown ref");
	assert.match(body(unknown), /Folds on this branch: b1\./u);
	const both = await call("context_recall", { ref: "b1", query: "deploy" });
	assert.equal(both?.isError, true);
	assert.equal(both?.details.error, "query and ref");
});

test("REQ-193-5: with billion-context-pi loaded, ref mode refuses and names decompress", async () => {
	const { manager } = foldedSession();
	const { call, host } = await started(manager, { billionContextPi: true });
	assert.equal(host.tools.has("decompress"), false, "billion-context-pi keeps its own decompress");
	const result = await call("context_recall", { ref: "b1" });
	assert.equal(result?.isError, true);
	assert.equal(result?.details.error, "folds owned by billion-context-pi");
	assert.match(body(result), /decompress\(\{ blockId: "b1" \}\)/u);
	assert.doesNotMatch(body(result), /FOLDED-QUESTION/u);
});

test("REQ-193-6: long output is capped and pages with an offset back to the exact original", async () => {
	const longQuestion = `LONG-START ${"0123456789".repeat(1_500)} LONG-END`;
	const { manager, question, answer } = foldedSession({ question: longQuestion, answer: ORIGINAL_ANSWER });
	const { call } = await started(manager);
	const expected = `--- ${question} (user) ---\n${longQuestion}\n\n--- ${answer} (assistant) ---\n${ORIGINAL_ANSWER}`;
	let offset = 0;
	let rebuilt = "";
	let pages = 0;
	for (;;) {
		const page = await call("context_recall", { ref: "b1", offset });
		assert.ok(page);
		assert.equal(page.details.offset, offset);
		assert.ok(page.details.end - page.details.offset <= MAX_REF_PAGE_CHARACTERS, "each page is capped");
		assert.equal(page.details.total_characters, expected.length);
		rebuilt += expected.slice(page.details.offset, page.details.end);
		assert.ok(body(page).includes(expected.slice(page.details.offset, page.details.end)));
		pages++;
		if (page.details.next_offset === undefined) {
			assert.doesNotMatch(body(page), /\[More:/u);
			break;
		}
		assert.match(body(page), new RegExp(`offset: ${page.details.next_offset}`, "u"));
		offset = page.details.next_offset;
	}
	assert.equal(pages, Math.ceil(expected.length / MAX_REF_PAGE_CHARACTERS));
	assert.ok(pages >= 2);
	assert.equal(rebuilt, expected);
	assert.ok(body(await call("context_recall", { ref: "b1" })).length < expected.length, "the first page is shorter than the whole fold");
});

test("REQ-193-7: registered through the erasure-wrapped pi, ref mode refuses in an erased session", async () => {
	const { manager } = foldedSession();
	let refused = false;
	const { call } = await started(manager, { refused: () => refused });
	assert.match(body(await call("context_recall", { ref: "b1" })), /FOLDED-QUESTION/u);
	refused = true;
	await assert.rejects(async () => call("context_recall", { ref: "b1" }), /Session activation refused; tool execution is blocked\./u);
	await assert.rejects(async () => call("decompress", { blockId: "b1" }), /Session activation refused; tool execution is blocked\./u);
});

test("REQ-193-7: through the extension, recall tools are registered on the erasure-wrapped pi", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-ref-erasure-")));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	try {
		const host = createHostPi();
		const extension = await import(`../src/index.js?context-recall-ref=${Date.now()}`);
		extension.default(host.api);
		const { manager } = foldedSession();
		const ctx = { ...createSession(root, "ref-erasure").ctx, sessionManager: manager, shutdown: () => {} } as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const tool = host.tools.get("context_recall") as RefTool;
		assert.match(body(await tool.execute("ok", { ref: "b1" }, new AbortController().signal, undefined, ctx)), /FOLDED-QUESTION/u);
		// A session the erasure guard refuses: its database path is unusable, so start fails closed.
		const blockedDir = path.join(root, "agent-file");
		fs.writeFileSync(blockedDir, "not a directory");
		process.env.PI_CODING_AGENT_DIR = blockedDir;
		const refusedCtx = { ...ctx, sessionManager: manager } as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "resume" }, refusedCtx);
		await assert.rejects(async () => tool.execute("refused", { ref: "b1" }, new AbortController().signal, undefined, refusedCtx), /Session activation refused/u);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
