import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ContextEvent,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { planFold } from "../src/folds/fold-adapter.js";
import { foldPointer, renderEarlierFoldCalls } from "../src/folds/fold-call-render.js";
import { foldRecordsOnBranch, type FoldRecord } from "../src/folds/fold-entries.js";
import { planQueuedFolds, registerFoldEngine, type FoldRequestResult } from "../src/folds/fold-engine.js";
import { createInitialState, hideConsumedCompressCalls, type Config, type CoreMessage } from "../src/folds/kernel/index.js";
import { compareCompressCall } from "../src/parity/compare.js";
import { classifyBcpResult } from "../src/parity/outcome.js";
import { PARITY_RECORD_VERSION, type CompressRecord, type NextRequestRecord, type ParityDiff } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { buildFoldParityReport } from "../src/parity/report.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";

// pi-context-aware#173: models copy the 200-character summary stubs that
// billion-context-pi shows for earlier compress calls. The engine's own minimum
// summary length (50) accepts them, so the adapter must refuse the shape, and the
// native engine must show earlier fold calls with a block pointer instead.
const CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 50 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};

const FULL_SUMMARY = [
	"TASK AS OF THIS BLOCK: the user asked for a rundown of open merge requests and a rebase of every branch onto main.",
	"Decisions: squash the tmux-jobs branch; keep the caair-build branch open until its pipeline passes.",
	"Files: src/folds/fold-adapter.ts:197 planFold; src/parity/compare.ts:111 compareCompressCall.",
	"Error seen: `endId=\"m00004\" does not exist in this session`. Open work: push the rebased branches.",
].join(" ");

function session(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (const [i, name] of ["ALPHA", "BETA", "GAMMA"].entries()) {
		manager.appendMessage({ role: "user", content: `${name}-QUESTION ${i}`, timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(`${name}-ANSWER ${i}`));
	}
	return manager;
}

function fold(summary: string) {
	return planFold({ branch: session().getBranch(), startRef: "m00001", endRef: "m00004", summary, modelContextLimit: 64_000, config: CONFIG });
}

function refusal(summary: string): string | undefined {
	const plan = fold(summary);
	return plan.ok ? undefined : plan.errors.join("\n");
}

/** The summary of an earlier compress call, as the copied kernel shows it to the model. */
function renderedEarlierSummary(summary: string): string {
	const state = createInitialState();
	state.blocks.push({
		blockId: "b1", runId: "r1", tier: 1, summary, directMessageIds: ["e1"], effectiveMessageIds: ["e1"], directBlockIds: [],
		compressedTokens: 100, createdAt: 0, survivedCount: 0, generation: "young", active: true,
		compressCallId: "call-1", startRef: "m00001", endRef: "m00004",
	});
	const call: CoreMessage = {
		id: "e9", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "call-1",
		text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00004", topic: "Rebase work", summary }] }),
	};
	const [rendered] = hideConsumedCompressCalls(state, [call]).messages;
	return (JSON.parse(rendered!.text!) as { content: { summary: string }[] }).content[0]!.summary;
}

test("a summary copied from the kernel's rendering of an earlier call is refused; the full summary folds", () => {
	const copied = renderedEarlierSummary(FULL_SUMMARY);
	assert.equal(copied.length, 200);
	assert.ok(copied.endsWith("\u2026"));
	assert.ok(FULL_SUMMARY.startsWith(copied.slice(0, -1)));

	const error = refusal(copied);
	assert.ok(error, "a copied stub must be refused");
	assert.ok(error.startsWith("[stub-summary] "), error);
	assert.match(error, /200 characters/u);
	assert.match(error, /Write the complete summary/u);
	assert.ok(!error.includes(copied.slice(0, 60)), "the refusal must not echo the summary");
	assert.ok(error.length < 2_000);

	const accepted = fold(FULL_SUMMARY);
	assert.equal(accepted.ok, true);
});

test("only a summary of at most 200 characters that ends in an ellipsis is refused", () => {
	assert.ok(refusal(`${"a".repeat(199)}\u2026`)?.startsWith("[stub-summary]"), "200 characters is the kernel's stub length");
	assert.ok(refusal(`${"a".repeat(198)}\u2026`)?.startsWith("[stub-summary]"), "199 characters: the kernel dropped a split surrogate");
	assert.ok(refusal(`${"a".repeat(198)}\u2026 \n`)?.startsWith("[stub-summary]"), "trailing whitespace does not hide the ellipsis");
	assert.ok(refusal(`${"a".repeat(60)}\u2026`)?.startsWith("[stub-summary]"), "a shorter stub is refused too");
	assert.equal(refusal(`${"a".repeat(200)}\u2026`), undefined, "201 characters is longer than any kernel stub");
	assert.equal(refusal(`${"a".repeat(239)}\u2026`), undefined, "240 characters ending in an ellipsis may fold");
	assert.equal(refusal(`${"a".repeat(100)}\u2026${"b".repeat(99)}`), undefined, "an ellipsis inside the text is fine");
	assert.equal(refusal(`${"a".repeat(197)}...`), undefined, "three dots are not the kernel's stub marker");
});

test("a queued fold with a cut-off summary is dropped with the refusal, not written", () => {
	const manager = session();
	const before = manager.getEntries().length;
	const stub = `${FULL_SUMMARY.slice(0, 199)}\u2026`;
	const queued = planQueuedFolds(manager, [{ startRef: "m00001", endRef: "m00004", summary: stub }], 64_000, CONFIG);
	assert.deepEqual(queued.drafts, []);
	assert.equal(queued.dropped.length, 1);
	assert.ok(queued.dropped[0]!.errors[0]!.startsWith("[stub-summary]"));
	assert.equal(manager.getEntries().length, before);
});
test("a copied block pointer is refused; a summary that mentions one is not", () => {
	const pointer = foldPointer(["b6"], 9_585);
	assert.equal(pointer, "summary kept in block b6 (9,585 chars)");
	for (const copied of [pointer, ` ${pointer}\n`, foldPointer(["b2", "b10"], 12)]) {
		const error = refusal(copied);
		assert.ok(error?.startsWith("[stub-summary] "), `${JSON.stringify(copied)}: ${error}`);
		assert.match(error ?? "", /block pointer/u);
		assert.match(error ?? "", /Write the complete summary/u);
	}
	assert.equal(refusal(`${FULL_SUMMARY} The earlier work is ${pointer}.`), undefined);
});

const record = (blockId: string, requestId?: string, directBlockIds: string[] = []): FoldRecord => ({
	version: 1, blockId, runId: "r1", tier: directBlockIds.length ? 2 : 1, carrierId: `${blockId}-carrier`, hiddenIds: [], range: { startId: `${blockId}-carrier`, endId: `${blockId}-carrier` },
	refs: { start: "m00001", end: "m00002" }, directBlockIds, compressedTokens: 10, createdAt: 0, origin: "fold", ...(requestId ? { requestId } : {}),
});

const foldCall = (id: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage => fauxAssistantMessage(fauxToolCall("fold", args, { id }), { stopReason: "toolUse" });

function argumentsOf(messages: ContextEvent["messages"], index: number): Record<string, unknown> {
	const message = messages[index];
	assert.equal(message?.role, "assistant");
	const part = (message as AssistantMessage).content[0];
	assert.equal(part?.type, "toolCall");
	return (part as ToolCall).arguments;
}

test("an earlier fold call shows a block pointer for each item whose fold is written", () => {
	const items: Record<string, string>[] = [
		{ startId: "m00001", endId: "m00002", topic: "Opening", summary: FULL_SUMMARY },
		{ startId: "m00003", endId: "m00004", summary: "A second, refused summary that must stay visible." },
		{ startId: "m00005", endId: "m00006", summary: `${FULL_SUMMARY} again` },
	];
	const messages: ContextEvent["messages"] = [
		foldCall("call-1", { content: items }),
		foldCall("call-2", { content: JSON.stringify(items.slice(0, 1)) }),
		foldCall("other", { content: items }),
	];
	const records = [record("b1", "call-1#0"), record("b2", "call-1#2"), record("b3", "call-2#0"), record("b4")];
	const rendered = renderEarlierFoldCalls(messages, records);

	const first = argumentsOf(rendered, 0).content as { summary: string; topic?: string; startId: string }[];
	assert.deepEqual(first.map((item) => item.summary), [
		`summary kept in block b1 (${FULL_SUMMARY.length} chars)`,
		items[1]!.summary,
		`summary kept in block b2 (${FULL_SUMMARY.length + 6} chars)`,
	]);
	assert.deepEqual(first.map((item) => [item.startId, item.topic]), items.map((item) => [item.startId, item.topic]), "only the summary changes");
	for (const item of [first[0]!, first[2]!]) assert.ok(!item.summary.endsWith("\u2026") && !item.summary.includes(FULL_SUMMARY.slice(0, 40)));

	const second = argumentsOf(rendered, 1).content;
	assert.equal(typeof second, "string", "a stringified content array stays a string");
	assert.deepEqual(JSON.parse(second as string), [{ ...items[0], summary: `summary kept in block b3 (${FULL_SUMMARY.length} chars)` }]);
	assert.equal(rendered[2], messages[2], "a call without a written fold is unchanged");
	assert.deepEqual(argumentsOf(messages, 0).content, items, "the input messages are not edited");
	assert.equal(renderEarlierFoldCalls(messages, [record("b4")]), messages, "nothing to render returns the same list");
});

test("a pointer to an absorbed fold names the fold that absorbed it", () => {
	const messages: ContextEvent["messages"] = [foldCall("call-1", { content: [{ startId: "m00001", endId: "m00002", summary: FULL_SUMMARY }] })];
	const rendered = renderEarlierFoldCalls(messages, [record("b1", "call-1#0"), record("b2", undefined, ["b1"]), record("b3", undefined, ["b2"])]);
	const [item] = argumentsOf(rendered, 0).content as { summary: string }[];
	assert.equal(item?.summary, `summary kept in block b3 (${FULL_SUMMARY.length} chars)`);
});

// End to end through a real Pi session in live mode: a test-only fold tool sends one
// item with a full summary. The fold is written at turn_end; the next request must
// show the call with a pointer, and the summary once, in the fold's message. The
// model then copies what it sees into a new call, and the engine refuses it.
test("live mode: the next request shows the earlier fold call as a pointer and a copied pointer is refused", async () => {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-stub-summary-")));
	const faux = fauxProvider({ provider: "stub-summary", models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const requests: string[] = [];
	let shown: unknown;
	faux.setResponses([
		(context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage(fauxToolCall("fold_probe", { content: [{ startId: "m00001", endId: "m00004", topic: "Opening", summary: FULL_SUMMARY }] }, { id: "fold-call-1" }), { stopReason: "toolUse" });
		},
		(context) => {
			requests.push(JSON.stringify(context.messages));
			const call = context.messages.flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === "fold-call-1");
			shown = call?.type === "toolCall" ? (call.arguments.content as { summary?: unknown }[] | undefined)?.[0]?.summary : undefined;
			return fauxAssistantMessage(fauxToolCall("fold_probe", { content: [{ startId: "m00005", endId: "m00006", summary: typeof shown === "string" ? shown : "" }] }, { id: "fold-call-2" }), { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage("Done."),
	]);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("stub-summary", "test-only");
	const results: FoldRequestResult[] = [];
	const folds: ExtensionFactory = (pi) => {
		const engine = registerFoldEngine(pi, { config: { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 } });
		pi.registerTool({
			name: "fold_probe", label: "fold_probe", description: "Test-only fold tool.",
			parameters: Type.Object({ content: Type.Array(Type.Object({ startId: Type.String(), endId: Type.String(), topic: Type.Optional(Type.String()), summary: Type.String() })) }),
			async execute(id, params, _signal, _update, ctx) {
				params.content.forEach(({ startId, endId, topic, summary }, index) => results.push(engine.request(ctx, { startRef: startId, endRef: endId, summary, ...(topic ? { topic } : {}), requestId: `${id}#${index}` })));
				return { content: [{ type: "text", text: "requested" }], details: {} };
			},
		});
	};
	const sessionManager = SessionManager.inMemory(cwd);
	for (const name of ["ALPHA", "BETA"]) {
		sessionManager.appendMessage({ role: "user", content: `${name}-QUESTION`, timestamp: Date.now() });
		sessionManager.appendMessage(fauxAssistantMessage(`${name}-ANSWER`));
	}
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd, agentDir: path.join(cwd, "agent"), modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: { extensionFactories: [folds], noExtensions: true },
		});
		session = (await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() })).session;
		await session.bindExtensions({});
		await session.prompt("Fold the opening, please.");
		await session.waitForIdle();

		assert.ok(results[0]?.ok && results[0].queued, JSON.stringify(results[0]));
		const written = foldRecordsOnBranch(sessionManager.getBranch()).map(({ record }) => record);
		assert.deepEqual(written.map((fold) => [fold.blockId, fold.requestId]), [["b1", "fold-call-1#0"]]);

		const pointer = `summary kept in block b1 (${FULL_SUMMARY.length.toLocaleString("en-US")} chars)`;
		assert.equal(shown, pointer, "the earlier fold call shows the pointer");
		const next = requests[1] ?? "";
		assert.equal(next.split(FULL_SUMMARY.slice(0, 80)).length - 1, 1, "the summary is sent once, in the fold's message");
		assert.doesNotMatch(next, /ALPHA-ANSWER|BETA-QUESTION|BETA-ANSWER/u, "the folded range is hidden");
		assert.ok(!next.includes("\u2026"), "no cut-off summary is shown");

		const copied = results[1];
		assert.equal(copied?.ok, false, "a copied pointer must be refused");
		assert.ok(!copied.ok && copied.errors[0]?.startsWith("[stub-summary] "), JSON.stringify(copied));
		assert.equal(foldRecordsOnBranch(sessionManager.getBranch()).length, 1);

		const entry = sessionManager.getBranch().find((item) => item.type === "message" && item.message.role === "assistant" && item.message.content.some((part) => part.type === "toolCall" && part.id === "fold-call-1"));
		assert.ok(entry && JSON.stringify(entry).includes(FULL_SUMMARY.slice(0, 80)), "the session file keeps the call as written");
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

function parityFixture(summary: string) {
	const manager = SessionManager.inMemory("/tmp");
	const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage({ role: "user", content: `${i}: ${"message history ".repeat(2500)}`, timestamp: 1 }));
	const byRef = Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id]));
	const side = (blocks: unknown[] = []) => parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef } }));
	const block = { blockId: "b1", runId: "r1", compressCallId: "call", tier: 1, active: true, summary, directBlockIds: [], effectiveMessageIds: ids.slice(0, 4) };
	// billion-context-pi accepts the cut-off summary and folds the range.
	const accepted = classifyBcpResult("\u25A3 ACP | 40.0K \u2192 1.0K tokens (~39.0K reclaimed, blocks: b1=m00001\u2013m00004)", false);
	return compareCompressCall({
		sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000,
		toolCallId: "call", input: { content: [{ startId: "m00001", endId: "m00004", summary }] }, before: side(), after: side([block]), observed: accepted,
	});
}

const compressRecord = (compared: ReturnType<typeof compareCompressCall>, toolCallId = "call"): CompressRecord => ({
	v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "current", sessionId: "session", toolCallId, nested: false, at: new Date(1).toISOString(), ...compared,
});

/** A next request with complete, empty evidence on both sides, so it has no difference of its own. */
const matchingRequest: NextRequestRecord = {
	v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "current", sessionId: "session", toolCallIds: ["call"], at: new Date(2).toISOString(), verdict: "match", diffs: [],
	ours: { activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages: [], total: 0, tagsSeen: true },
	bcp: { messages: [], total: 0, tagsSeen: true },
};

const FP_008 = PARITY_REGISTER.find((entry) => entry.id === "FP-008");

test("shadow parity classifies the refusal as stub-summary, never keeps the summary, and FP-008 explains only the call differences", () => {
	const stub = `${FULL_SUMMARY.slice(0, 199)}\u2026`;
	const call = compressRecord(parityFixture(stub));
	assert.deepEqual(call.oursOutcome, { type: "rejected", reasons: ["stub-summary"] });
	assert.deepEqual(call.bcpOutcome, { type: "accepted", reasons: [] });
	assert.deepEqual(call.diffs.map((diff) => diff.kind), ["outcome", "block-count", "coverage", "tier"]);
	assert.doesNotMatch(JSON.stringify(call), /TASK AS OF THIS BLOCK|cut off/u);

	const report = buildFoldParityReport([call, matchingRequest], PARITY_REGISTER, "current");
	assert.deepEqual(report.counts, { match: 0, explained: 1, diff: 0, inconclusive: 0 });
	assert.match(report.text, /FP-008: \d+/u);

	const otherRejection: CompressRecord = { ...call, oursOutcome: { type: "rejected", reasons: ["no-fold"] } };
	assert.equal(buildFoldParityReport([otherRejection, matchingRequest], PARITY_REGISTER, "current").counts.diff, 1, "without the stub-summary reason the same differences stay unexplained");

	const full = compressRecord(parityFixture(FULL_SUMMARY));
	assert.deepEqual(full.oursOutcome, { type: "accepted", reasons: [] });
	assert.equal(full.verdict, "match");
});

test("FP-008 matches only the call differences a refused fold can cause", () => {
	assert.ok(FP_008);
	const refused: CompressRecord = {
		v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "current", sessionId: "session", toolCallId: "call", nested: false, at: new Date(1).toISOString(), verdict: "diff", diffs: [],
		oursOutcome: { type: "rejected", reasons: ["stub-summary"] },
		bcpOutcome: { type: "accepted", reasons: [] },
		ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "none", partialEntries: 0, tiers: [], absorbed: [] },
		bcp: { count: 1, coverageCount: 4, coverageIds: ["a", "b", "c", "d"], coverageHash: "abcd", partialEntries: 0, tiers: [1], absorbed: [] },
	};
	const partial: CompressRecord = { ...refused, oursOutcome: { type: "partial", reasons: ["stub-summary"] }, bcp: { ...refused.bcp!, count: 2, tiers: [1, 1] }, ours: { ...refused.bcp! } };
	const moreFolds: CompressRecord = { ...refused, ours: { ...refused.bcp!, count: 2, tiers: [1, 1] } };
	const otherReason: CompressRecord = { ...refused, oursOutcome: { type: "rejected", reasons: ["no-fold"] } };
	const bcpPartial: CompressRecord = { ...refused, bcpOutcome: { type: "partial", reasons: ["unknown-ref"] } };
	const cases: [ParityDiff, CompressRecord, boolean][] = [
		[{ kind: "outcome", reason: "ours=rejected; bcp=accepted" }, refused, true],
		[{ kind: "outcome", reason: "ours=partial; bcp=accepted" }, partial, true],
		[{ kind: "outcome", reason: "ours=partial; bcp=accepted" }, refused, false],
		[{ kind: "outcome", reason: "ours=accepted; bcp=rejected" }, refused, false],
		[{ kind: "outcome", reason: "ours=rejected; bcp=dead-range" }, refused, false],
		[{ kind: "outcome", reason: "ours=rejected; bcp=partial" }, bcpPartial, false],
		[{ kind: "outcome" }, refused, false],
		[{ kind: "error-type", reason: "ours=stub-summary; bcp=unknown-ref" }, refused, false],
		[{ kind: "outcome-unknown" }, refused, false],
		[{ kind: "coverage", oursOnlyCount: 0, bcpOnlyCount: 4 }, refused, true],
		[{ kind: "coverage", oursOnlyCount: 1, bcpOnlyCount: 4 }, refused, false],
		[{ kind: "coverage", oursOnlyCount: 0, oursOnly: ["x"], bcpOnlyCount: 4 }, refused, false],
		[{ kind: "absorbed", oursOnlyCount: 0, bcpOnlyCount: 1 }, refused, true],
		[{ kind: "absorbed", oursOnlyCount: 2, bcpOnlyCount: 0 }, refused, false],
		[{ kind: "block-count" }, refused, true],
		[{ kind: "block-count" }, partial, true],
		[{ kind: "block-count" }, moreFolds, false],
		[{ kind: "block-count" }, bcpPartial, false],
		[{ kind: "tier" }, refused, true],
		[{ kind: "tier" }, moreFolds, false],
		// The next request's differences need evidence that the missing fold alone causes them.
		[{ kind: "summaries" }, refused, false],
		[{ kind: "content" }, refused, false],
		[{ kind: "tool-calls" }, refused, false],
		[{ kind: "tool-results" }, refused, false],
		[{ kind: "tool-pairing" }, refused, false],
		[{ kind: "tool-evidence" }, refused, false],
		[{ kind: "input-parse" }, refused, false],
		[{ kind: "import-skipped" }, refused, false],
		[{ kind: "block-count" }, otherReason, false],
		[{ kind: "block-count" }, { ...refused, oursOutcome: undefined }, false],
	];
	for (const [diff, record, expected] of cases) {
		assert.equal(FP_008.matches(diff, record), expected, `${diff.kind} ${diff.reason ?? ""} ours=${JSON.stringify(record.oursOutcome)} bcp=${JSON.stringify(record.bcpOutcome)} counts=${record.ours?.count}/${record.bcp?.count}`);
	}
	const noEvidence: CompressRecord = { ...refused, ours: undefined, bcp: undefined };
	assert.equal(FP_008.matches({ kind: "block-count" }, noEvidence), false);
});
