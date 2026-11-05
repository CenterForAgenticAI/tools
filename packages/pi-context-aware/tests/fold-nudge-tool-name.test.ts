import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { createFoldTurnMemory, nudgeText, prepareFoldTurn, renameFoldTool, type FoldTurnInput } from "../src/folds/fold-turn.js";
import { renderNudgeText, type NudgeDecision } from "../src/folds/kernel/index.js";
import type { Config } from "../src/folds/kernel/index.js";

// pi-context-aware#257 (cut-over checklist row 10 on pi-context-aware#137): the fold nudge names the fold tool the model can
// call. With pi-context-aware owning folds that is context_fold; compress is not a tool of this package.

const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };

function turnInput(manager: SessionManager, memory: ReturnType<typeof createFoldTurnMemory>, hostTokens: number): FoldTurnInput {
	return {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 200_000 }, systemPromptTokens: 0, hostTokens, memory, config: CONFIG,
	};
}

/** A session over the nudge threshold: four large archived exchanges and a short recent tail. */
function nudgeSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}

const BASE: NudgeDecision = {
	shouldInject: true, tier: null, contextUsage: 0.5, compressibleRanges: [], protectedRanges: [],
	contextBreakdown: { system: 1, user: 1, assistant: 1, tool: 1, text: 1, total: 5 }, breakdown: {},
} as unknown as NudgeDecision;
const TIER_2: NudgeDecision = { ...BASE, tier: 2, tierTargetBlocks: [{ blockId: "b1", tier: 1, effectiveMessageIds: [], compressedTokens: 1, summary: "" }, { blockId: "b2", tier: 1, effectiveMessageIds: [], compressedTokens: 1, summary: "" }] } as unknown as NudgeDecision;
const EMERGENCY: NudgeDecision = { ...BASE, breakdown: { emergencyOverride: 1 } } as unknown as NudgeDecision;

/** Every way the model can be told to call the fold tool: a call example, or a backticked name. */
const COMPRESS_CALL = /(?<![A-Za-z-])compress\(\{/u;
const COMPRESS_TOOL_NAME = /`compress`/u;

test("#257: the nudge a native-fold session sends names context_fold, never compress", () => {
	const manager = nudgeSession();
	const sent = prepareFoldTurn(turnInput(manager, createFoldTurnMemory(), 90_000));
	assert.ok(sent?.nudge, "the session is over the nudge threshold");
	assert.match(sent.nudge, /When you call `context_fold`, the summary you write/u);
	assert.doesNotMatch(sent.nudge, COMPRESS_TOOL_NAME);
	assert.doesNotMatch(sent.nudge, COMPRESS_CALL);
});

test("#257: the tier nudge's call example names context_fold", () => {
	const text = nudgeText(TIER_2, []);
	assert.match(text, /Example: context_fold\(\{ content: \[\{ startId: "b1", endId: "b2", summary: "\.\.\." \}\] \}\)/u);
	assert.doesNotMatch(text, COMPRESS_CALL);
	assert.doesNotMatch(text, COMPRESS_TOOL_NAME);
});

test("#257: the emergency and tier nudges, with active blocks, name no compress call either", () => {
	for (const decision of [BASE, TIER_2, EMERGENCY]) {
		const text = nudgeText(decision, []);
		assert.doesNotMatch(text, COMPRESS_CALL, JSON.stringify(decision));
		assert.doesNotMatch(text, COMPRESS_TOOL_NAME, JSON.stringify(decision));
		assert.match(text, /`context_fold`/u, JSON.stringify(decision));
	}
});

test("#257: while billion-context-pi is loaded the nudge keeps naming compress, which is then the live tool", () => {
	const kernel = renderNudgeText(TIER_2).text;
	assert.match(kernel, COMPRESS_CALL, "the kernel's own text names compress; this is what a native-fold session must not send");
	assert.equal(renameFoldTool(kernel, "compress"), kernel, "naming compress changes nothing");
	assert.equal(nudgeText(TIER_2, [], "compress"), nudgeText(TIER_2, []).replaceAll("context_fold", "compress"));
});

test("#257: only the tool name changes; the rest of the kernel's nudge is byte for byte the same", () => {
	for (const decision of [BASE, TIER_2, EMERGENCY]) {
		const kernel = renderNudgeText(decision).text;
		const renamed = nudgeText(decision, []);
		assert.equal(renamed.replaceAll("context_fold", "compress"), kernel, JSON.stringify(decision));
	}
	// Words that merely contain "compress" are left alone.
	assert.equal(renameFoldTool("compress early; compress-as-anchor; decompress(x); `compress` or compress({ a })", "context_fold"), "compress early; compress-as-anchor; decompress(x); `context_fold` or context_fold({ a })");
});
