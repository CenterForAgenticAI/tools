/**
 * The view's protected entries are the entries planFold refuses to fold (pi-context-aware#467,
 * CR-VIEW-PROTECTED-TOKENCOUNT). Expected values come from planFold itself, never from the view.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { foldStateFromBranch, planFold } from "../src/folds/fold-adapter.js";
import { baseIdOf, type Config } from "../src/folds/kernel/index.js";
import type { FoldsConfig } from "../src/platform/config-layers.js";
import { buildContextView, type ContextViewInput } from "../src/strategy-runtime/index.js";

const WINDOW = 200_000;
/** Default preserve settings (5 recent messages, 5000 recent tokens); only the size gate is lowered so one entry can fold. */
const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 } };
/** The opening user message folds like any other, so the only reason left to keep an entry is the protected zone. */
const FOLDS = { firstUserMessage: "fold", firstUserMessageMaxTokens: 0, condensedSkills: false } as unknown as FoldsConfig;
const SUMMARY = "Summary: the probe looked at the parser and found nothing new.";

/** Eleven entries; entry 6 is a probe result of about 24k tokens, which the engine shortens from 95% pressure on. */
function session(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	const call = (id: string) => fauxAssistantMessage(fauxToolCall("probe_tool", { id }, { id }), { stopReason: "toolUse" });
	const result = (id: string, text: string, timestamp: number) => ({ role: "toolResult" as const, toolCallId: id, toolName: "probe_tool", content: [{ type: "text" as const, text }], isError: false, timestamp });
	manager.appendMessage({ role: "user", content: "Find the bug in the parser.", timestamp: 1 });
	manager.appendMessage(call("call_1"));
	manager.appendMessage(result("call_1", "probe one: tokenizer fine", 2));
	manager.appendMessage(fauxAssistantMessage("The tokenizer is fine; probing the parser next."));
	manager.appendMessage(call("call_2"));
	manager.appendMessage(result("call_2", "parser trace\n" + "trace line with detail ".repeat(4_400), 3));
	manager.appendMessage(fauxAssistantMessage("The trace shows the parser loops on empty input."));
	manager.appendMessage({ role: "user", content: "Check the fix.", timestamp: 4 });
	manager.appendMessage(call("call_3"));
	manager.appendMessage(result("call_3", "probe three: loop gone", 5));
	manager.appendMessage(fauxAssistantMessage("The fix holds."));
	return manager;
}

function inputOf(manager: SessionManager, tokens: number): ContextViewInput {
	return {
		branch: manager.getBranch(),
		contextEntries: manager.buildContextEntries(),
		projection: manager.buildSessionProjection(),
		model: { id: "test-model", contextWindow: WINDOW },
		tokens,
		reachableTools: ["probe_tool"],
		registeredTools: ["probe_tool"],
		config: CONFIG,
		folds: FOLDS,
		now: 10_000,
		compactionOwner: "none",
	};
}

/** The first and last message ref of one entry, as a fold request names them. */
function refsOf(branch: readonly SessionEntry[], entryId: string): { startRef: string; endRef: string } {
	const state = foldStateFromBranch(branch);
	const refs = state.messages.filter((message) => baseIdOf(message.id) === entryId).map((message) => state.kernel.messageRefs.byRaw[message.id]!);
	assert.ok(refs.length > 0, `entry ${entryId} has a message ref`);
	return { startRef: refs[0]!, endRef: refs[refs.length - 1]! };
}

const PROTECTED_REASON = /protected zone|protected-zone/u;

for (const tokens of [0.96 * WINDOW, 0.2 * WINDOW]) {
	test(`at ${tokens / WINDOW} pressure, an entry is protected in the view exactly when planFold refuses it alone for the protected zone`, () => {
		const manager = session();
		const branch = manager.getBranch();
		const view = buildContextView(inputOf(manager, tokens));
		assert.ok(view.pressure >= 0.95 || tokens < 0.95 * WINDOW);
		const refused = view.entries.map((entry) => {
			const plan = planFold({ branch, ...refsOf(branch, entry.id), summary: SUMMARY, modelContextLimit: WINDOW, config: CONFIG, folds: FOLDS });
			return { id: entry.id, refused: !plan.ok && plan.errors.some((error) => PROTECTED_REASON.test(error)), plan: plan.ok ? "ok" : plan.errors.join(" | ") };
		});
		const byPlanFold = refused.filter((row) => row.refused).map((row) => row.id);
		assert.ok(byPlanFold.length > 0 && byPlanFold.length < view.entries.length, `control: planFold refuses some entries and folds others: ${JSON.stringify(refused)}`);
		assert.deepEqual(view.protectedEntryIds, byPlanFold, JSON.stringify(refused, null, 1));
	});
}
