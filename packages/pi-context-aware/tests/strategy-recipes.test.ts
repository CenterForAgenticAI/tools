/**
 * Two trivial recipes written against the strategy contract (pi-context-aware#467). They live only in this
 * test and are not wired into a live session; they prove the contract types are usable as written.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import type { Config } from "../src/folds/kernel/index.js";
import { STRATEGY_CONTRACT_VERSION, type ContextPlan, type ContextView, type Recipe, type Stage, type StageTiming } from "../src/strategy/index.js";
import { buildContextView } from "../src/strategy-runtime/index.js";

/** Does nothing on any request. */
const emptyRecipe: Recipe = {
	id: "empty-v1",
	contractVersion: STRATEGY_CONTRACT_VERSION,
	stages: [{ id: "nothing", offers: [], wants: () => null, plan: () => [] }],
};

/** Stubs the oldest tool result over `limit` tokens that no rule protects. */
function stubOldestToolResult(limit: number): Recipe {
	const target = (view: ContextView) => view.entries.find((entry) =>
		entry.role === "toolResult" && entry.tokens > limit && !view.protectedEntryIds.includes(entry.id));
	const stage: Stage = {
		id: "stub-oldest-tool-result",
		offers: ["context_recall"],
		wants: (view) => (target(view) ? "now" : null),
		plan: (view) => {
			const entry = target(view);
			return entry ? [{ kind: "stub", entryId: entry.id, text: `[${entry.toolName ?? "tool"} output, ${entry.tokens} tokens, stubbed]` }] : [];
		},
		nudge: (view) => (view.tools.includes("context_recall") ? { kind: "say", text: "Stubbed tool output can be read back with context_recall." } : null),
	};
	return { id: `stub-oldest-over-${limit}`, contractVersion: STRATEGY_CONTRACT_VERSION, stages: [stage] };
}

/** The runtime loop in miniature: each stage that wants to act now contributes its plan. */
function plansNow(recipe: Recipe, view: ContextView): ContextPlan {
	return recipe.stages.flatMap((stage) => {
		const when: StageTiming | null = stage.wants(view);
		return when === "now" ? stage.plan(view) : [];
	});
}

const CONFIG: Partial<Config> = { preserveRecentMessages: 2, preserveRecentTokens: 0 };

/** Three tool results of known sizes, then a closing exchange that fills the protected zone. */
function session() {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Read the three files.", timestamp: 1 });
	const result = (id: string, text: string) => {
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: id }, { id }), { stopReason: "toolUse" }));
		return manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 2 });
	};
	const small = result("call_a", "short file");
	const firstLarge = result("call_b", "alpha ".repeat(2_000));
	const secondLarge = result("call_c", "beta ".repeat(2_000));
	manager.appendMessage(fauxAssistantMessage("All three are read."));
	manager.appendMessage({ role: "user", content: "Thanks.", timestamp: 3 });
	manager.appendMessage(fauxAssistantMessage("Done."));
	const view = buildContextView({
		branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), projection: manager.buildSessionProjection(),
		model: { id: "m", contextWindow: 200_000 }, tokens: 40_000, reachableTools: ["context_recall"], registeredTools: ["bash", "context_recall"], config: CONFIG, now: 5, compactionOwner: "none",
	});
	return { view, small, firstLarge, secondLarge };
}

test("the empty recipe returns an empty plan", () => {
	const { view } = session();
	assert.equal(emptyRecipe.contractVersion, 1);
	assert.deepEqual(plansNow(emptyRecipe, view), []);
});

test("the stub recipe stubs the oldest tool result over its limit, not a smaller or a newer one", () => {
	const { view, firstLarge } = session();
	const plan = plansNow(stubOldestToolResult(1_000), view);
	assert.equal(plan.length, 1);
	const [op] = plan;
	assert.equal(op?.kind, "stub");
	assert.equal(op?.kind === "stub" ? op.entryId : undefined, firstLarge);
	assert.deepEqual(stubOldestToolResult(1_000).stages[0]?.nudge?.(view), { kind: "say", text: "Stubbed tool output can be read back with context_recall." });
});

test("the stub recipe does not act when no tool result is over its limit", () => {
	const { view } = session();
	const recipe = stubOldestToolResult(1_000_000);
	assert.equal(recipe.stages[0]?.wants(view), null);
	assert.deepEqual(plansNow(recipe, view), []);
});
