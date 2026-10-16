/** REQ-C3 control: widenFoldCoverage makes mixed assistant entries and all
 * their tool results indivisible; protected carving refuses partial entries.
 * Mutations: disable coverage widening, call/result identity mapping, or the
 * post-plan split guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { assistant, requestText, SAFETY_CONFIG, safetyRoot, safetySession, user } from "./fixtures/safety/session.js";

function assertPaired(messages: ReturnType<SessionManager["buildSessionContext"]>["messages"]): void {
	const outstanding = new Set<string>();
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			assert.ok(!outstanding.has(part.id) && !answered.has(part.id), "tool ids must be unambiguous");
			outstanding.add(part.id);
		}
		if (message.role === "toolResult") {
			assert.ok(outstanding.delete(message.toolCallId), `orphan result: ${message.toolCallId}`);
			answered.add(message.toolCallId);
		}
	}
	assert.deepEqual([...outstanding], [], "provider request holds an unanswered call");
}

for (const scenario of [
	{ name: "text-only endpoint", startRef: "m00002", endRef: "m00002", protectedTools: [] },
	{ name: "one result endpoint", startRef: "m00004", endRef: "m00005", protectedTools: [] },
	{ name: "protected sibling call", startRef: "m00002", endRef: "m00002", protectedTools: ["read"] },
]) {
	test(`REQ-C3: ${scenario.name} cannot split a mixed entry or orphan tool history`, async () => {
		const root = safetyRoot();
		const manager = SessionManager.inMemory(root);
		user(manager, "SAFETY-READ-REQUEST");
		const calls = [fauxToolCall("read", { path: "synthetic-one.txt" }, { id: "safety-read" }),
			fauxToolCall("bash", { command: "synthetic-only", timeout: 1 }, { id: "safety-bash" })];
		const mixedId = manager.appendMessage(fauxAssistantMessage([{ type: "text", text: "SAFETY-MIXED-TEXT" }, ...calls], { stopReason: "toolUse", timestamp: 1 }));
		const resultIds = calls.map((call) => manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
			content: [{ type: "text", text: `SAFETY-BODY-${call.id}` }], isError: false, timestamp: 1 }));
		assistant(manager, "SAFETY-READ-DONE");
		user(manager, "SAFETY-RECENT");
		assistant(manager, "SAFETY-RECENT-ANSWER");
		assertPaired(manager.buildSessionContext().messages);
		const entriesBefore = structuredClone(manager.getEntries());
		const plan = planFold({ branch: manager.getBranch(), startRef: scenario.startRef, endRef: scenario.endRef,
			summary: "SAFETY-TOOLS-SUMMARY: both synthetic files were inspected together.", modelContextLimit: 64_000,
			config: { ...SAFETY_CONFIG, protectedTools: scenario.protectedTools } });
		if (scenario.protectedTools.length > 0) {
			assert.equal(plan.ok, false, "protected call must prohibit folding only the entry text");
			assert.deepEqual(manager.getEntries(), entriesBefore, "rejection must not append anything");
		} else {
			assert.ok(plan.ok, JSON.stringify(plan));
			assert.deepEqual([plan.records[0]?.carrierId, ...plan.records[0]!.hiddenIds], [mixedId, ...resultIds],
				"a partial endpoint must cover the entire mixed assistant and both results");
			applyFoldDrafts(manager, plan.drafts);
		}
		let live: Awaited<ReturnType<typeof safetySession>> | undefined;
		try {
			live = await safetySession(root, manager);
			await live.prompt("SAFETY-TOOL-HISTORY-PROBE");
			const request = live.requests[0]!;
			assertPaired(request);
			if (scenario.protectedTools.length > 0) {
				assert.match(requestText(request), /SAFETY-MIXED-TEXT|SAFETY-BODY-safety-read/u);
				assert.equal(request.filter((message) => message.role === "toolResult").length, 2);
			} else {
				assert.match(requestText(request), /SAFETY-TOOLS-SUMMARY/u);
				assert.doesNotMatch(requestText(request), /SAFETY-MIXED-TEXT|SAFETY-BODY|safety-read|safety-bash/u);
			}
		} finally { live?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
	});
}
