import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry, type FoldsConfig } from "../src/platform/config-layers.js";
import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts, planQueuedFolds, registerFoldEngine, resolveFoldConfig } from "../src/folds/fold-engine.js";

const config = { compress: { minCompressRange: 0, minSummaryLength: 10, maxSummaryLength: 20_000 }, preserveRecentMessages: 0, preserveRecentTokens: 0 };
function fixture(first = "OPENING") {
	const manager = SessionManager.inMemory("/tmp");
	const ids = [manager.appendMessage({ role: "user", content: first, timestamp: 1 }), manager.appendMessage(fauxAssistantMessage("ANSWER")), manager.appendMessage(fauxAssistantMessage("TAIL"))];
	return { manager, ids };
}

test("keep by default moves the carrier off the first user and keeps its rendered text", () => {
	const { manager, ids } = fixture();
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00002", summary: "Opening exchange settled.", modelContextLimit: 64_000, config });
	assert.ok(plan.ok, JSON.stringify(plan));
	assert.equal(plan.records[0]?.carrierId, ids[1]);
	assert.deepEqual(plan.records[0]?.hiddenIds, []);
	assert.equal(plan.records[0]?.compressedTokens, 2, "only ANSWER (6 characters) was folded, not OPENING");
	applyFoldDrafts(manager, plan.drafts);
	assert.match(JSON.stringify(manager.buildSessionContext().messages), /OPENING/u);
	assert.doesNotMatch(JSON.stringify(manager.buildSessionContext().messages), /ANSWER/u);
});

for (const [name, first, folds, kept] of [
	["fold explicitly", "OPENING", { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 }, false],
	["threshold equality keeps", "x".repeat(32_000), { firstUserMessage: "keep-under-tokens", firstUserMessageMaxTokens: 8_000 }, true],
	["over threshold folds", "x".repeat(32_001), { firstUserMessage: "keep-under-tokens", firstUserMessageMaxTokens: 8_000 }, false],
	["kernel CJK estimate folds", "界".repeat(9), { firstUserMessage: "keep-under-tokens", firstUserMessageMaxTokens: 8 }, false],
] as const) {
	test(`${name}: rendered request retains a user before the first assistant`, () => {
		const { manager, ids } = fixture(first);
		const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00002", summary: "Opening exchange settled.", modelContextLimit: 64_000, config, folds: folds as FoldsConfig });
		assert.ok(plan.ok, JSON.stringify(plan));
		assert.equal(plan.records[0]?.carrierId, kept ? ids[1] : ids[0]);
		applyFoldDrafts(manager, plan.drafts);
		const messages = manager.buildSessionContext().messages;
		assert.equal(messages[0]?.role, "user");
		assert.equal(messages.findIndex((message) => message.role === "assistant"), 1);
		assert.equal(JSON.stringify(messages).includes(first), kept);
	});
}

test("live request validation uses the session fold policy before queueing an opening-only fold", () => {
	const { manager } = fixture();
	const engine = registerFoldEngine({ on() {}, getAllTools: () => [] } as unknown as ExtensionAPI, { config });
	const ctx = { cwd: "/tmp", sessionManager: manager, model: { contextWindow: 64_000 } } as unknown as ExtensionContext;
	const request = { startRef: "m00001", endRef: "m00001", summary: "Opening exchange settled." };
	manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));
	assert.equal(engine.request(ctx, request).ok, true);
	assert.equal(engine.pending(ctx), 1);
	manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "keep" }));
	assert.equal(engine.request(ctx, request).ok, false);
	assert.equal(engine.pending(ctx), 1, "the rejected opening-only fold must not queue");
});

test("fold settings read global, project and current session branch without writes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fold-settings-"));
	const agent = path.join(root, "agent");
	try {
		fs.mkdirSync(agent);
		fs.mkdirSync(path.join(root, ".pi"));
		const globalFile = path.join(agent, "context-aware.json");
		const projectFile = path.join(root, ".pi", "context-aware.json");
		fs.writeFileSync(globalFile, '{"folds":{"firstUserMessage":"fold","firstUserMessageMaxTokens":100}}');
		fs.writeFileSync(projectFile, '{"folds":{"firstUserMessage":"keep-under-tokens"}}');
		const manager = SessionManager.inMemory(root);
		const leaf = manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
		const ctx = { cwd: root, sessionManager: manager };
		assert.deepEqual(resolveFoldConfig(ctx, agent), { firstUserMessage: "keep-under-tokens", firstUserMessageMaxTokens: 100, condensedSkills: false });
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "keep", "folds.firstUserMessageMaxTokens": 42 }));
		assert.deepEqual(resolveFoldConfig(ctx, agent), { firstUserMessage: "keep", firstUserMessageMaxTokens: 42, condensedSkills: false });
		manager.branch(leaf);
		assert.deepEqual(resolveFoldConfig(ctx, agent), { firstUserMessage: "keep-under-tokens", firstUserMessageMaxTokens: 100, condensedSkills: false });
		assert.equal(fs.readFileSync(globalFile, "utf8"), '{"folds":{"firstUserMessage":"fold","firstUserMessageMaxTokens":100}}');
		assert.equal(fs.readFileSync(projectFile, "utf8"), '{"folds":{"firstUserMessage":"keep-under-tokens"}}');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("keep drops a first-user-only range with a reported reason", () => {
	const { manager } = fixture();
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00001", summary: "Opening exchange settled.", modelContextLimit: 64_000, config });
	assert.equal(plan.ok, false);
	assert.ok(!plan.ok);
	assert.match(plan.errors.join(" "), /first user message.*nothing else/iu);
	assert.equal(manager.getEntries().length, 3);
});

test("keep refuses a message range whose only unfolded entry is the kept opening message", () => {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 3; i++) {
		manager.appendMessage({ role: "user", content: "QUESTION-" + i, timestamp: i });
		manager.appendMessage(fauxAssistantMessage("ANSWER-" + i));
	}
	const keep: FoldsConfig = { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 };
	const request = { startRef: "m00001", endRef: "m00004", summary: "Opening exchanges settled." };
	const first = planQueuedFolds(manager, [request], 64_000, config, keep);
	assert.deepEqual(first.dropped, []);
	applyFoldDrafts(manager, first.drafts);
	const again = planQueuedFolds(manager, [request], 64_000, config, keep);
	assert.equal(again.drafts.length, 0, "the same range again hides nothing new, so it is not refolded");
	// The end ref lies inside b1, so billion-context-pi's turn preparation has pruned it: already folded (pi-context-aware#184).
	assert.match(again.dropped[0]?.errors[0] ?? "", /already compressed: blocked by b1/u);
	const wider = planQueuedFolds(manager, [{ ...request, endRef: "m00006" }], 64_000, config, keep);
	assert.deepEqual(wider.dropped, [], "a range with unfolded entries besides the opening still folds");
	applyFoldDrafts(manager, wider.drafts);
	const text = JSON.stringify(manager.buildSessionContext().messages);
	assert.match(text, /QUESTION-1/u);
	assert.doesNotMatch(text, /ANSWER-3/u);
});
