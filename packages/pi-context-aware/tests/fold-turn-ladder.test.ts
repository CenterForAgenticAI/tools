import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import {
	createFoldTurnMemory,
	emergencyLogLine,
	emergencyNotices,
	prepareFoldTurn,
	turnConfig,
	type FoldTurnInput,
	type FoldTurnMemory,
	type FoldTurnResult,
} from "../src/folds/fold-turn.js";
import type { Config } from "../src/folds/kernel/index.js";
import { DEFAULT_PRESSURE_LADDER, type PressureLadderConfig } from "../src/policy/context-policy.js";
import { assistantToolCall } from "./provider-payloads.js";

// pi-context-aware#244: the pressure ladder drives the fold pass. Each test moves a ladder step
// and asserts the behaviour moves with it; the 'default' arm of each pair proves the fixture sits
// where the default ladder acts, so a ladder that is ignored fails the other arm.

const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const ladder = (over: Partial<PressureLadderConfig>): PressureLadderConfig => ({ ...DEFAULT_PRESSURE_LADDER, ...over });

type Message = FoldTurnInput["messages"][number];

function input(manager: SessionManager, memory: FoldTurnMemory, options: { hostTokens?: number; contextWindow: number; maxOutputTokens?: number; ladder?: PressureLadderConfig }): FoldTurnInput {
	return {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: options.contextWindow, ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }, systemPromptTokens: 0,
		...(options.hostTokens !== undefined ? { hostTokens: options.hostTokens } : {}), memory, config: CONFIG,
		...(options.ladder ? { ladder: options.ladder } : {}),
	};
}

function turn(manager: SessionManager, memory: FoldTurnMemory, options: Parameters<typeof input>[2]): FoldTurnResult {
	const result = prepareFoldTurn(input(manager, memory, options));
	assert.ok(result, "the request lines up with the projection");
	return result;
}

const textOf = (message: Message): string => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && part.text ? [part.text] : [])).join("|") : "";
};

/** Four large archived exchanges and a short tail: the kernel has ranges to offer. */
function nudgeSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}

const nudgeOf = (result: FoldTurnResult): string | undefined => result.nudge;

test("turnConfig builds the nudge, emergency and truncation thresholds from the ladder, and an override still wins", () => {
	const moved = turnConfig(200_000, {}, ladder({ foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.7 }));
	assert.equal(moved.nudge.minContextLimitPct, 0.3);
	assert.equal(moved.nudge.maxContextLimitPct, 0.5);
	assert.equal(moved.nudge.emergencyThresholdPct, 0.7);
	assert.equal(moved.truncate.threshold, 0.7);
	assert.equal(moved.modelContextLimit, 200_000, "the denominator is the window it was given");
	const pinned = turnConfig(200_000, { nudge: { maxContextLimitPct: 0.6 } as Config["nudge"] }, ladder({ foldNudgeEndFraction: 0.5 }));
	assert.equal(pinned.nudge.maxContextLimitPct, 0.6, "an explicit engine setting beats the ladder");
	const starting = turnConfig(200_000);
	assert.equal(starting.nudge.minContextLimitPct, 0.45);
	assert.equal(starting.nudge.maxContextLimitPct, 0.75);
	assert.equal(starting.nudge.emergencyThresholdPct, 0.95);
	assert.equal(starting.truncate.threshold, 0.95);
});

test("fold nudge start: moving foldNudgeStartFraction moves when the first nudge is sent", () => {
	const manager = nudgeSession();
	const atDefault = turn(manager, createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 60_000 });
	assert.ok(nudgeOf(atDefault), "50% of the window is past the default 45% start");
	const later = turn(manager, createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 60_000, ladder: ladder({ foldNudgeStartFraction: 0.7, foldNudgeEndFraction: 0.8 }) });
	assert.equal(nudgeOf(later), undefined, "a ladder that starts nudging at 70% sends none at 50%");
});

test("fold nudge end: moving foldNudgeEndFraction moves the over-limit nudge", () => {
	const manager = nudgeSession();
	const overAtDefault = turn(manager, createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 100_000 });
	const overLimitText = nudgeOf(overAtDefault);
	assert.ok(overLimitText, "83% is past the default 75% end");
	const raised = turn(manager, createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 100_000, ladder: ladder({ foldNudgeEndFraction: 0.88, seededCompactionFraction: 0.9 }) });
	assert.notEqual(nudgeOf(raised), overLimitText, "at 83% a ladder whose end is 88% is not over its limit yet");
});

test("emergency nudge: moving recoverableHideFraction moves the emergency threshold", () => {
	// The emergency nudge, unlike the over-limit one, waits while the latest model turn failed.
	const failed = (): SessionManager => {
		const manager = nudgeSession();
		manager.appendMessage(fauxAssistantMessage("", { stopReason: "error" }));
		return manager;
	};
	const atDefault = turn(failed(), createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 116_000 });
	assert.equal(nudgeOf(atDefault), undefined, "97% is past the default 95%: the emergency nudge is deferred after a failed turn");
	const raised = turn(failed(), createFoldTurnMemory(), { contextWindow: 120_000, hostTokens: 116_000, ladder: ladder({ recoverableHideFraction: 0.99 }) });
	assert.match(nudgeOf(raised) ?? "", /^\u26A0\uFE0F Context limit reached/u, "a ladder whose last step is 99% treats 97% as over-limit, which is not deferred");
});

test("one denominator: the output reserve no longer shrinks the limit the ladder is a fraction of", () => {
	const manager = nudgeSession();
	// The session is about 72k tokens. A 100k output cap used to cut a 200k window to 150k, which read
	// 48%, past the 45% start. The ladder is a fraction of the window: 36%.
	const options = { contextWindow: 200_000, maxOutputTokens: 100_000 };
	assert.equal(nudgeOf(turn(manager, createFoldTurnMemory(), options)), undefined, "36% of the window is under the default 45% start");
	assert.ok(nudgeOf(turn(manager, createFoldTurnMemory(), { ...options, ladder: ladder({ foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.75 }) })), "and past a 30% start");
});

// ---- the last step ----

/** Old tool output in the middle and a short tail: emergency truncation has something to shorten. */
function truncatableSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Inspect the log.", timestamp: 1 });
	manager.appendMessage(assistantToolCall(1));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "browser_screenshot", content: [{ type: "text", text: "HEAD\n" + "x".repeat(100_000) + "\nTAIL" }], isError: false, timestamp: 2 });
	for (let i = 1; i <= 6; i++) manager.appendMessage(i % 2 ? fauxAssistantMessage("Short note " + i + ".") : { role: "user", content: "Short question " + i + ".", timestamp: 1 });
	return manager;
}

/** Big content only inside the protected tail: usage is high and nothing can be shortened. */
function stuckSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Start.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Ready."));
	manager.appendMessage({ role: "user", content: "Large paste. " + "y".repeat(200_000), timestamp: 1 });
	return manager;
}

const truncatedIn = (result: FoldTurnResult): number => result.messages.filter((message) => textOf(message).includes("[truncated for context space]")).length;

test("95% step: truncation starts at the ladder's last step, not at a constant", () => {
	const manager = truncatableSession();
	const atDefault = turn(manager, createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 191_000 });
	assert.equal(truncatedIn(atDefault), 1, "96% of the window is past the default 95%: the old tool output is shortened");
	assert.equal(atDefault.emergency?.truncated, 1);
	assert.deepEqual(atDefault.emergency?.announce, ["truncated"]);
	const raised = turn(manager, createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 191_000, ladder: ladder({ recoverableHideFraction: 0.99 }) });
	assert.equal(truncatedIn(raised), 0, "a ladder whose last step is 99% truncates nothing at 96%");
	assert.equal(raised.emergency, undefined);
	const lowered = turn(manager, createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 170_000, ladder: ladder({ foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.8 }) });
	assert.equal(truncatedIn(lowered), 1, "a ladder whose last step is 80% truncates at 85%");
	assert.equal(truncatedIn(turn(manager, createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 170_000 })), 0, "and the default ladder does not");
});

test("95% step: a request below the last step carries no emergency and clears the announced events", () => {
	const manager = truncatableSession();
	const memory = createFoldTurnMemory();
	assert.deepEqual(turn(manager, memory, { contextWindow: 200_000, hostTokens: 191_000 }).emergency?.announce, ["truncated"]);
	assert.deepEqual(turn(manager, memory, { contextWindow: 200_000, hostTokens: 191_000 }).emergency?.announce, [], "the same stretch is not announced twice");
	assert.equal(turn(manager, memory, { contextWindow: 200_000, hostTokens: 50_000 }).emergency, undefined);
	assert.deepEqual(turn(manager, memory, { contextWindow: 200_000, hostTokens: 191_000 }).emergency?.announce, ["truncated"], "a new stretch is announced again");
});

test("95% step: truncation that reclaims nothing is reported as skipped, with the kernel's reason", () => {
	const result = turn(stuckSession(), createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 191_000 });
	assert.equal(truncatedIn(result), 0);
	assert.match(result.emergency?.skipped ?? "", /found no truncatable content/u);
	assert.deepEqual(result.emergency?.announce, ["skipped"]);
	const notices = emergencyNotices(result.emergency!);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /reclaimed nothing/u);
	assert.match(emergencyLogLine(result.emergency!), /usage=96% threshold=95% .*skipped="emergency-truncate ran/u);
});

test("95% step: the kernel's terminal escape reaches the host after three stuck requests in a row", () => {
	const manager = stuckSession();
	const memory = createFoldTurnMemory();
	const options = { contextWindow: 200_000, hostTokens: 191_000 };
	assert.equal(turn(manager, memory, options).emergency?.terminalEscape, undefined);
	assert.equal(turn(manager, memory, options).emergency?.terminalEscape, undefined);
	const third = turn(manager, memory, options);
	assert.match(third.emergency?.terminalEscape ?? "", /compression cannot reduce this context below the limit/u);
	assert.ok(third.emergency?.announce.includes("terminal"));
	assert.match(emergencyNotices(third.emergency!).join("\n"), /Start a new session or use native compaction/u);
	assert.equal(turn(manager, memory, options).emergency?.announce.includes("terminal"), false, "announced once per stretch");
});

test("the truncation marker the host counts is the one the kernel writes", () => {
	assert.equal(truncatedIn(turn(truncatableSession(), createFoldTurnMemory(), { contextWindow: 200_000, hostTokens: 191_000 })), 1);
});
