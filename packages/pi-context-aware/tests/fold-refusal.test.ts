import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { refusalTail, runFold } from "../src/context-tools/context-fold.js";
import { foldStateFromBranch, offeredFoldRanges } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts, planQueuedFolds, registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { createFoldHints } from "../src/folds/fold-hints.js";
import { MAX_LISTED_FOLDS, nativeRefusal } from "../src/folds/fold-refusal.js";
import { createFoldTurnMemory, prepareFoldTurn } from "../src/folds/fold-turn.js";
import { removeFixtureDir } from "./fixture-cleanup.js";
import type { Config } from "../src/folds/kernel/index.js";

// pi-context-aware#434: a fold refusal names only tools this package registers, and says how to fold
// folded history again. pi-context-aware#457: every range offered to the model is one a fold accepts.

/** Tools of billion-context-pi that are not registered when this package owns folds. */
const FOREIGN_TOOLS = /acp_status|search_context|decompress|(?<![A-Za-z_])compress\(\{|the compress tool/u;

const ref = (n: number) => "m" + String(n).padStart(5, "0");

function engineFor(config: Partial<Config>, hints = createFoldHints()): FoldEngine {
	return registerFoldEngine({ on() {}, getAllTools: () => [] } as unknown as ExtensionAPI, { config, hints: () => hints });
}

function ctxOf(manager: SessionManager): ExtensionContext {
	return { cwd: "/tmp", sessionManager: manager, model: { contextWindow: 64_000 } } as unknown as ExtensionContext;
}

let call = 0;
function fold(engine: FoldEngine, manager: SessionManager, startId: string, endId: string): string {
	const result = runFold(engine, ctxOf(manager), "call-" + ++call, { content: [{ startId, endId, summary: "Every exchange in this range was settled earlier." }] });
	const part = result.content[0];
	return part && part.type === "text" ? part.text : "";
}

/** `exchanges` question/answer pairs of `size` characters each, and one fold per pair from `foldFrom` on, except the last two pairs. */
function foldedSession(exchanges: number, size: number, foldFrom: number, config: Partial<Config>): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= exchanges; i++) {
		manager.appendMessage({ role: "user", content: "QUESTION-" + i + " " + "q".repeat(size), timestamp: i });
		manager.appendMessage(fauxAssistantMessage("ANSWER-" + i + " " + "a".repeat(size)));
	}
	for (let pair = foldFrom; pair <= exchanges - 2; pair++) {
		const plan = planQueuedFolds(manager, [{ startRef: ref(2 * pair - 1), endRef: ref(2 * pair), summary: "Exchange " + pair + " was settled." }], 64_000, config);
		assert.deepEqual(plan.dropped, [], "fixture fold of exchange " + pair);
		applyFoldDrafts(manager, plan.drafts);
	}
	return manager;
}

const SMALL: Partial<Config> = { compress: { minCompressRange: 0, minSummaryLength: 10, maxSummaryLength: 20_000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const GATED: Partial<Config> = { compress: { minCompressRange: 5_000, minSummaryLength: 10, maxSummaryLength: 20_000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };

test("#434: a refusal over many earlier folds names only registered tools, a fold-id merge and context_compact", () => {
	const manager = foldedSession(14, 400, 1, SMALL);
	const text = fold(engineFor(SMALL), manager, "m00001", "m00024");
	assert.match(text, /refused: .*already compressed/u);
	assert.doesNotMatch(text, FOREIGN_TOOLS);
	assert.match(text, /context_fold\(\{ content: \[\{ startId: "b1", endId: "b12", summary: "\.\.\." \}\] \}\)/u, "names the fold-id merge of the folds it overlaps");
	assert.match(text, /context_compact/u);
	assert.equal(text.match(/blocked by b\d+/gu)?.length, MAX_LISTED_FOLDS, "the list of blocking folds is capped");
	assert.match(text, /and 4 more/u);
});

test("#434: the fold-id merge a refusal names is accepted", () => {
	const manager = foldedSession(14, 400, 1, SMALL);
	const engine = engineFor(SMALL);
	const text = fold(engine, manager, "m00003", "m00004");
	const [, start, end] = /startId: "(b\d+)", endId: "(b\d+)"/u.exec(text) ?? [];
	assert.equal(start, "b2");
	assert.match(fold(engine, manager, start!, end!), /accepted/u);
});

test("#434: a size refusal over a mostly folded range says it is already folded, not to add messages", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Short opening.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Short reply."));
	for (let i = 2; i <= 6; i++) {
		manager.appendMessage({ role: "user", content: "QUESTION-" + i + " " + "q".repeat(3_000), timestamp: i });
		manager.appendMessage(fauxAssistantMessage("ANSWER-" + i + " " + "a".repeat(3_000)));
	}
	manager.appendMessage({ role: "user", content: "Short question.", timestamp: 7 });
	manager.appendMessage(fauxAssistantMessage("Short answer."));
	manager.appendMessage({ role: "user", content: "QUESTION-8 " + "q".repeat(3_000), timestamp: 8 });
	manager.appendMessage(fauxAssistantMessage("ANSWER-8 " + "a".repeat(3_000)));
	for (let pair = 2; pair <= 6; pair++) {
		const plan = planQueuedFolds(manager, [{ startRef: ref(2 * pair - 1), endRef: ref(2 * pair), summary: "Exchange " + pair + " was settled." }], 64_000, GATED);
		applyFoldDrafts(manager, plan.drafts);
	}
	const text = fold(engineFor(GATED), manager, "m00001", "m00014");
	assert.match(text, /compressible content too small/u, "the size phrase fold parity classifies by is kept");
	assert.doesNotMatch(text, /Combine more messages/u);
	assert.match(text, /Most of that range is already folded, in b1, b2, b3, b4, b5\./u);
	assert.match(text, /startId: "b1", endId: "b5"/u);
	assert.doesNotMatch(text, FOREIGN_TOOLS);
});

test("#434: each engine refusal phrase is rewritten to this package's tools", () => {
	const none = { overlapping: () => [] };
	const cases = [
		"Requested range(s) already compressed (e.g. m00002..m00004) — its content is already summarized in active block(s) b1 — use search_context or decompress b1 if you need details from it. Refold blocked: blocked by b1 (not restored). Restore the affected block(s) inline (decompress with inline:true), then recompressing the same range updates them in place. Nothing new to compress in that window. Continue the task, or run acp_status and target one of the CURRENT compressible ranges it reports. Example: compress({ content: [{ startId: \"b1\" }] })",
		"Some refs were stale. Run acp_status, then call the compress tool again using only the refs it reports.",
		'endId="m00004" does not exist in this session (typo or wrong session) — run acp_status for current refs.',
		"Ref m00009 is hidden — run acp_status to verify.",
		"Range m00001..m00004 contains no new compressible messages — every message in it is already covered by active block(s) b1, b2, b3, b4, b5, b6, b7, b8, b9, b10. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (first..last); otherwise run acp_status and compress a range it reports as compressible.",
	];
	for (const error of cases) {
		const text = nativeRefusal(error, none);
		assert.doesNotMatch(text, FOREIGN_TOOLS, text);
	}
	assert.match(nativeRefusal(cases[0]!, none), /context_recall\(\{ ref: "b1" \}\)/u);
	assert.match(nativeRefusal(cases[4]!, none), /active block\(s\) b1, b2, b3, b4, b5, b6, b7, b8, and 2 more\./u);
	assert.equal(nativeRefusal("Summary too short.", none), "Summary too short.", "a refusal naming no engine tool is unchanged");
});

test("#457: offered ranges never span a fold, and each one is accepted when requested", () => {
	const manager = foldedSession(14, 400, 2, SMALL);
	const offered = offeredFoldRanges({ branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), modelContextLimit: 64_000, config: SMALL });
	assert.deepEqual(offered.map((range) => range.startRef + ".." + range.endRef), ["m00001..m00002", "m00025..m00026"], "the folds between the two exchanges split them");
	for (const range of offered) assert.match(fold(engineFor(SMALL), manager, range.startRef, range.endRef), /accepted/u, range.startRef);
});

test("#457: a refusal lists the ranges that can be folded now, not single refs", () => {
	const manager = foldedSession(14, 400, 2, SMALL);
	const text = fold(engineFor(SMALL), manager, "m00003", "m00004");
	// The opening user message is kept visible, and m00002 alone is too small to offer.
	assert.match(text, /Ranges you can fold now, each whole: m00025\.\.m00026 \(~\d+ tokens\)\./u);
	assert.doesNotMatch(text, /Valid refs/u);
});

test("#457: a range a fold queued this turn takes is not offered again", () => {
	const manager = foldedSession(14, 400, 2, SMALL);
	const engine = engineFor(SMALL);
	assert.match(fold(engine, manager, "m00001", "m00002"), /accepted/u);
	const text = fold(engine, manager, "m00003", "m00004");
	assert.doesNotMatch(text, /m00001\.\.m00002/u);
	assert.match(text, /Ranges you can fold now, each whole: m00025\.\.m00026 /u);
});

test("#457: entries a verbatim hint keeps are never offered", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "QUESTION " + "q".repeat(3_000), timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("keepme", {}, { id: "keep-1" }), { stopReason: "toolUse" }));
	manager.appendMessage({ role: "toolResult", toolCallId: "keep-1", toolName: "keepme", content: [{ type: "text", text: "KEPT " + "k".repeat(3_000) }], isError: false, timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("ANSWER " + "a".repeat(3_000)));
	for (let i = 0; i < 2; i++) {
		manager.appendMessage({ role: "user", content: "TAIL " + i, timestamp: 3 + i });
		manager.appendMessage(fauxAssistantMessage("TAIL ANSWER " + i));
	}
	const hints = createFoldHints();
	assert.equal(hints.register({ ownerKey: "test", match: { toolName: "keepme" }, policy: "verbatim" }).ok, true);
	const engine = engineFor(SMALL, hints);
	const text = fold(engine, manager, "m00002", "m00003");
	assert.match(text, /kept word for word by a fold hint/u);
	const offered = /Ranges you can fold now, each whole: (.*)\./u.exec(text)?.[1] ?? "";
	assert.doesNotMatch(offered, /m0000[23]\b/u, "the kept call and result are not offered");
	assert.match(offered, /^m00004\.\.m00006 /u, "the opening user message is kept, so the offer starts after the kept pair");
});

test("#457: the fold nudge does not offer entries a queued fold takes", () => {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 8; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	const input = {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 200_000 }, systemPromptTokens: 0, hostTokens: 150_000, config: SMALL,
	};
	const open = prepareFoldTurn({ ...input, memory: createFoldTurnMemory() });
	assert.match(open?.nudge ?? "", /m00001/u, "without exclusions the archive is offered");
	const taken = manager.getBranch().slice(0, 2).map((entry) => entry.id);
	const sent = prepareFoldTurn({ ...input, memory: createFoldTurnMemory(), offerExclusions: taken });
	assert.ok(sent?.nudge, "the session is still over the nudge threshold");
	assert.doesNotMatch(sent.nudge, /m0000[12]\b/u);
	assert.match(sent.nudge, /m00003/u);
});

test("#457: the engine's nudge leaves out what a fold queued this turn takes", () => {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 8; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const host = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), getAllTools: () => [] } as unknown as ExtensionAPI;
	const engine = registerFoldEngine(host, { config: SMALL, hints: () => createFoldHints() });
	const ctx = { cwd: "/tmp", sessionManager: manager, model: { contextWindow: 200_000 }, getContextUsage: () => ({ tokens: 150_000 }) } as unknown as ExtensionContext;
	const nudgeOf = () => {
		const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system");
		const result = handlers.get("context")!({ type: "context", messages }, ctx) as { messages?: unknown[] } | undefined;
		return JSON.stringify(result?.messages?.slice(messages.length) ?? []);
	};
	const accepted = runFold(engine, ctx, "queue-1", { content: [{ startId: "m00001", endId: "m00002", summary: "The first archive exchange was settled." }] });
	assert.match(JSON.stringify(accepted.content), /accepted/u);
	const after = nudgeOf();
	assert.match(after, /Compressible ranges/u, "the session still gets a nudge");
	assert.doesNotMatch(after, /m0000[12]\b/u);
});

test("#457: the refusal tail", () => {
	const range = (n: number) => ({ startRef: ref(n), endRef: ref(n + 1), tokens: 500 });
	assert.equal(refusalTail({ validRefs: ["m00001", "b1"] }), " Valid refs: m00001, b1.", "without an offer the refs remain");
	assert.match(refusalTail({ validRefs: ["m00001"], offeredRanges: [] }), /No other range can be folded now; .*context_compact/u);
	const many = refusalTail({ validRefs: [], offeredRanges: Array.from({ length: 11 }, (_, i) => range(2 * i + 1)) });
	assert.equal(many.match(/\.\./gu)?.length, 8);
	assert.match(many, /, and 3 more\.$/u);
	assert.ok(foldStateFromBranch([]).messages.length === 0);
});

// CR-FOLD-ONLY-COMPACT-NUDGE (pi-context-aware#526): a session whose strategy.methods leave out compact hides and
// refuses context_compact, so a context_fold refusal must not advise calling it.

/** Run `fn` with a private agent directory whose config sets strategy.methods. */
async function withMethods<T>(methods: readonly string[], fn: () => T): Promise<T> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fold-refusal-methods-")));
	const saved = process.env.PI_CODING_AGENT_DIR;
	fs.writeFileSync(path.join(root, "context-aware.json"), JSON.stringify({ strategy: { methods } }));
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
		await removeFixtureDir(root);
	}
}

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"fold\"] a refold refusal keeps the fold-id merge and names no context_compact", async () => {
	const both = await withMethods(["fold", "compact"], () => fold(engineFor(SMALL), foldedSession(14, 400, 1, SMALL), "m00001", "m00024"));
	assert.match(both, /context_compact/u, "with compact the refusal still offers it");
	const text = await withMethods(["fold"], () => fold(engineFor(SMALL), foldedSession(14, 400, 1, SMALL), "m00001", "m00024"));
	assert.match(text, /refused: .*already compressed/u);
	assert.match(text, /context_fold\(\{ content: \[\{ startId: "b1", endId: "b12", summary: "\.\.\." \}\] \}\)/u, "the merge advice stays");
	assert.doesNotMatch(text, /context_compact/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"fold\"] a refusal with no range left to fold names no context_compact", () => {
	const refused = { ok: false as const, errors: ["Range refused."], validRefs: [], offeredRanges: [] };
	const engineWith = (methods: readonly ("fold" | "compact")[]) => ({
		request: () => refused,
		engine: () => ({ strategy: { methods } }),
	}) as unknown as Pick<FoldEngine, "request" | "engine">;
	const textOf = (methods: readonly ("fold" | "compact")[]) => {
		const part = runFold(engineWith(methods), ctxOf(SessionManager.inMemory("/tmp")), "no-range", { content: [{ startId: "m00001", endId: "m00002", summary: "Settled." }] }).content[0];
		return part && part.type === "text" ? part.text : "";
	};
	assert.match(textOf(["fold", "compact"]), /No other range can be folded now; .*context_compact/u);
	const foldOnly = textOf(["fold"]);
	assert.match(foldOnly, /No other range can be folded now\./u);
	assert.doesNotMatch(foldOnly, /context_compact/u);
});
