import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import { createFoldTurnMemory, prepareFoldTurn, type FoldTurnInput, type FoldTurnResult } from "../src/folds/fold-turn.js";
import type { Config } from "../src/folds/kernel/index.js";
import { hashRequestMessages, type RequestMessage } from "../src/parity/compare.js";
import { requestHashesFault } from "../src/parity/evidence.js";
import { PARITY_RECORD_VERSION, type CompressRecord, type NextRequestRecord, type RequestHashes } from "../src/parity/records.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { assistantToolCall } from "./provider-payloads.js";

// pi-context-aware#244: the native pass reads every ladder step as a share of the whole window; billion-context-pi
// reads it as a share of the window less the model's output reserve. The parity register must name that difference
// (FP-203 for the nudge, FP-204 for where truncation starts) and must not file it under FP-201's tier-2 fix.
// The model is a current one from the pinned @earendil-works/pi-ai catalog.

const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const gpt = getBuiltinModel("openai", "gpt-5.5" as never) as { contextWindow: number; maxTokens: number; api: string };
// billion-context-pi keeps min(max output, a quarter of the window) back from the window.
const BCP_LIMIT = gpt.contextWindow - Math.min(gpt.maxTokens, 0.25 * gpt.contextWindow);

const call: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "current", sessionId: "s", toolCallId: "call", nested: false, at: new Date(1).toISOString(), verdict: "match", diffs: [] };
const entry = (id: string) => { const found = PARITY_REGISTER.find((item) => item.id === id); assert.ok(found, id + " is in the parity register"); return found; };

function input(manager: SessionManager, options: { hostTokens: number; contextWindow: number; maxOutputTokens?: number; compatibility?: boolean }): FoldTurnInput {
	return {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: options.contextWindow, ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens, api: gpt.api } : {}) }, systemPromptTokens: 0,
		hostTokens: options.hostTokens, memory: createFoldTurnMemory(), config: CONFIG,
		...(options.compatibility ? { compatibility: true } : {}),
	};
}
function pass(manager: SessionManager, options: Parameters<typeof input>[1]): FoldTurnResult {
	const result = prepareFoldTurn(input(manager, options));
	assert.ok(result, "the request lines up with the projection");
	return result;
}
const hashed = (result: FoldTurnResult): RequestHashes => ({ ...hashRequestMessages(result.messages as unknown as RequestMessage[]), tagsSeen: true });
function requestRecord(ours: RequestHashes, bcp: RequestHashes): NextRequestRecord {
	return { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "current", sessionId: "s", toolCallIds: ["call"], at: new Date(2).toISOString(), verdict: "diff", diffs: [{ kind: "content" }], ours, bcp };
}

function nudgeSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}
function truncatableSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Inspect the log.", timestamp: 1 });
	manager.appendMessage(assistantToolCall(1));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "browser_screenshot", content: [{ type: "text", text: "HEAD\n" + "x".repeat(100_000) + "\nTAIL" }], isError: false, timestamp: 2 });
	for (let i = 1; i <= 6; i++) manager.appendMessage(i % 2 ? fauxAssistantMessage("Short note " + i + ".") : { role: "user", content: "Short question " + i + ".", timestamp: 1 });
	return manager;
}

test("the fixture model is a current large-output model whose billion-context-pi limit differs from its window", () => {
	assert.ok(gpt.maxTokens >= 0.25 * gpt.contextWindow, "its output limit is at least a quarter of the window, so billion-context-pi reserves a quarter");
	assert.ok(BCP_LIMIT < gpt.contextWindow);
});

test("FP-203: a nudge the denominator moves is recorded as such, not as the tier-2 fix, and the register explains it", () => {
	const manager = nudgeSession();
	// A 120k window with a 40k output cap: billion-context-pi's limit is 90k, so 72k tokens is past its 75% step (67.5k) and short of ours (90k).
	const options = { hostTokens: 72_000, contextWindow: 120_000, maxOutputTokens: 40_000 };
	const preview = prepareFoldTurn(input(manager, { ...options, compatibility: true }));
	assert.equal(preview?.nudgeFix?.cause, "denominator", JSON.stringify(preview?.nudgeFix));
	assert.equal(preview?.denominator?.bcpLimit, 90_000);
	assert.equal(preview?.denominator?.window, 120_000);
	const ours = hashed(preview!);
	const { sent, compatible } = preview!.nudgeFix!;
	assert.ok(sent && compatible && sent !== compatible);
	// billion-context-pi's request is ours with its own nudge in place of ours.
	const hashOf = (text: string) => hashRequestMessages([{ role: "user", content: [{ type: "text", text }] } as RequestMessage]).messages[0]!.hash;
	const bcp: RequestHashes = { ...ours, messages: ours.messages.map((message) => message.role === "user" && message.hash === hashOf(sent) ? { ...message, hash: hashOf(compatible) } : message) };
	const record = requestRecord({ ...ours, nudgeFix: { cause: "denominator", sent: hashOf(sent), compatible: hashOf(compatible) } }, bcp);
	assert.equal(requestHashesFault(record.ours), undefined);
	assert.equal(entry("FP-203").matches({ kind: "content" }, call, record), true);
	assert.equal(entry("FP-201").matches({ kind: "content" }, call, record), false, "the tier-2 entry must not claim it");
	const other: NextRequestRecord = { ...record, bcp: { ...bcp, messages: [...bcp.messages, { role: "user", summary: false, hash: "unrelated" }], total: bcp.total + 1 } };
	assert.equal(entry("FP-203").matches({ kind: "content" }, call, other), false, "any other content difference stays unexplained");
	assert.equal(entry("FP-203").matches({ kind: "summaries" }, call, record), false);
});

test("a nudge both limits send alike records no denominator fix", () => {
	const preview = prepareFoldTurn(input(nudgeSession(), { hostTokens: 60_000, contextWindow: 120_000, maxOutputTokens: 1_000, compatibility: true }));
	// The two nudges differ only in the fold tool's name (pi-context-aware#257), so the fix is "tool-name", never "denominator".
	assert.equal(preview?.nudgeFix?.cause, "tool-name", JSON.stringify(preview?.nudgeFix));
});

test("FP-204: truncation that starts on one side only is recorded with billion-context-pi's request, and the register explains it", () => {
	const manager = truncatableSession();
	// 200k window, 100k output limit: billion-context-pi's limit is 150k, so its 95% step is 142.5k; ours is 190k.
	const window = 200_000;
	const maxOutputTokens = 100_000;
	const hostTokens = 160_000;
	const preview = prepareFoldTurn(input(manager, { hostTokens, contextWindow: window, maxOutputTokens, compatibility: true }));
	assert.equal(preview?.denominator?.truncationStartDiffers, true);
	assert.equal(preview?.emergency, undefined, "the native pass has not reached its last step");
	// The request billion-context-pi sends is the pass run with its own limit as the window; an independent route to the same request.
	const bcpRequest = pass(manager, { hostTokens, contextWindow: window - maxOutputTokens / 2 });
	assert.equal(bcpRequest.emergency?.truncated, 1, "billion-context-pi shortens the old tool output");
	const ours = hashed(preview!);
	const bcp = hashed(bcpRequest);
	assert.notDeepEqual(ours.messages.map((message) => message.hash), bcp.messages.map((message) => message.hash), "the two requests differ");
	const denominator = (await_free(preview!));
	const record = requestRecord({ ...ours, denominator }, bcp);
	assert.equal(requestHashesFault(record.ours), undefined);
	assert.equal(entry("FP-204").matches({ kind: "tool-results" }, call, record), true);
	assert.equal(entry("FP-203").matches({ kind: "tool-results" }, call, record), false);
	assert.equal(entry("FP-201").matches({ kind: "content" }, call, record), false);
	const changed: NextRequestRecord = { ...record, bcp: { ...bcp, messages: bcp.messages.map((message, index) => index === 0 ? { ...message, hash: "different" } : message) } };
	assert.equal(entry("FP-204").matches({ kind: "content" }, call, changed), false, "a difference beyond the truncation stays unexplained");
	const noEvidence: NextRequestRecord = { ...record, ours };
	assert.equal(entry("FP-204").matches({ kind: "tool-results" }, call, noEvidence), false, "without the denominator evidence nothing is explained");
});

function await_free(result: FoldTurnResult) {
	const found = result.denominator!;
	const limit = hashed({ ...result, messages: found.bcpMessages! } as FoldTurnResult);
	const keys = limit.messages.filter((message) => !message.summary).map((message) => (message.role === "custom" ? "user" : message.role) + ":" + message.hash).sort();
	const toolKeys = limit.messages.flatMap((message) => message.toolResult ? [JSON.stringify([message.toolResult.toolCallId, message.toolResult.toolName, message.toolResult.isError, message.summary, message.topicHash ?? null, message.hash])] : []).sort();
	return { window: found.window, bcpLimit: found.bcpLimit, truncationStartDiffers: found.truncationStartDiffers, limitKeys: keys, limitToolResultKeys: toolKeys };
}

test("the denominator register entries are documented in docs/fold-parity.md", () => {
	const doc = fs.readFileSync("docs/fold-parity.md", "utf8");
	for (const id of ["FP-203", "FP-204"]) assert.match(doc, new RegExp("\\| " + id + " \\|"), id);
});
