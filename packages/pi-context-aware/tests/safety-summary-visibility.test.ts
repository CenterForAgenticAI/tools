/** REQ-C6 / #175 control: foldDrafts persists the complete summary on a carrier
 * outside the compress call/result; later folds of a nested caller cannot hide it.
 * Direct creator folding is a gap: kernel ALWAYS_PROTECTED_TOOLS includes compress.
 * Mutations: remove the carrier edit, or truncate its content to 200 chars.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerFoldEngine, type FoldRequestResult } from "../src/folds/fold-engine.js";
import { foldStateFromBranch } from "../src/folds/fold-adapter.js";
import { assistant, requestText, SAFETY_CONFIG, safetyRoot, safetySession, seedOpening, user } from "./fixtures/safety/session.js";

const FULL_SUMMARY = "SAFETY-FULL-SUMMARY: The agreed plan is to keep alpha immutable, validate beta offline, and retain the task and focus authority in their transcript records. "
	+ "The second phase must inspect every tool pair, preserve branch isolation, and reconstruct the same request after restarting the session. "
	+ "SAFETY-SUMMARY-END: none of these constraints may be inferred from a shortened tool-result preview.";
const LATER_SUMMARY = "SAFETY-LATER-SUMMARY: the earlier compress invocation completed successfully.";

for (const nested of [false, true]) {
	test(nested ? "REQ-C6: full nested compress summary survives folding its creator call" : "REQ-C6: full direct compress summary reaches the next provider request", async () => {
		const root = safetyRoot();
		const manager = SessionManager.inMemory(root);
		seedOpening(manager);
		const accepted: FoldRequestResult[] = [];
		const calls: string[] = [];
		const tools: ExtensionFactory = (pi) => {
			const engine = registerFoldEngine(pi, { config: SAFETY_CONFIG });
			pi.registerTool({ name: "compress", label: "compress", description: "Synthetic native fold entry point.",
				parameters: Type.Object({ later: Type.Boolean() }),
				async execute(id, params, _signal, _update, ctx) {
					calls.push(id);
					accepted.push(engine.request(ctx, params.later
						? { startRef: "m00009", endRef: "m00012", summary: LATER_SUMMARY }
						: { startRef: "m00001", endRef: "m00004", summary: FULL_SUMMARY }));
					// Deliberately no summary in the result: only the persisted carrier can pass.
					return { content: [{ type: "text", text: "Fold queued." }], details: {} };
				} });
			pi.registerTool({ name: "nested_compress", label: "nested", description: "Synthetic executeTool caller.", parameters: Type.Object({}),
				async execute(_id, _params, _signal, _update, ctx) {
					const executed = await ctx.executeTool("compress", { later: false });
					return executed.result;
				} });
		};
		let live: Awaited<ReturnType<typeof safetySession>> | undefined;
		try {
			live = await safetySession(root, manager, [tools]);
			await live.prompt("SAFETY-CREATE-FOLD", [
				fauxAssistantMessage(fauxToolCall(nested ? "nested_compress" : "compress", nested ? {} : { later: false }, { id: "creator-call" }), { stopReason: "toolUse", timestamp: 1 }),
				fauxAssistantMessage("SAFETY-CREATOR-DONE", { timestamp: 1 }),
			]);
			assert.equal(accepted.length, 1);
			assert.ok(accepted[0]?.ok && accepted[0].mode === "live" && accepted[0].queued, JSON.stringify(accepted));
			assert.equal(calls[0], nested ? "creator-call/1" : "creator-call", "nested coverage must really traverse ctx.executeTool");
			const firstRequest = requestText(live.requests[1]!);
			assert.ok(firstRequest.includes(FULL_SUMMARY), "the first provider request after folding must hold the entire summary");
			assert.doesNotMatch(firstRequest, /SAFETY-ALPHA-ANSWER|SAFETY-BETA-ANSWER/u);

			// The kernel always protects direct compress calls. The failing direct
			// creator-coverage replay is retained in the worker handoff, not this gate.
			if (!nested) return;
			// m00009..12 are the user, nested caller, result and closing answer.
			user(manager, "SAFETY-PADDING");
			assistant(manager, "SAFETY-PADDING-ANSWER");
			await live.prompt("SAFETY-FOLD-CREATOR", [
				fauxAssistantMessage(fauxToolCall("compress", { later: true }, { id: "later-call" }), { stopReason: "toolUse", timestamp: 1 }),
				fauxAssistantMessage("SAFETY-LATER-DONE", { timestamp: 1 }),
			]);
			assert.equal(accepted.length, 2);
			assert.ok(accepted[1]?.ok && accepted[1].queued, JSON.stringify(accepted));
			assert.deepEqual(foldStateFromBranch(manager.getBranch()).active.map((record) => record.blockId), ["b1", "b2"]);
			const next = live.requests[3]!;
			const serialized = requestText(next);
			assert.ok(serialized.includes(FULL_SUMMARY), "active summary vanished or was truncated after folding its creator");
			assert.ok(serialized.includes(LATER_SUMMARY), "the second fold must actually reach the provider");
			assert.doesNotMatch(serialized, /creator-call|SAFETY-CREATOR-DONE|SAFETY-CREATE-FOLD/u, "the creator history must actually be folded");
		} finally {
			live?.session.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
