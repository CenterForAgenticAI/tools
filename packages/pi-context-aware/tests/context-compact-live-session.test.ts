import test from "node:test";
import assert from "node:assert/strict";

import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";

import { settle, smallHistory, withSession } from "./compaction-preflight-harness.js";

// pi-context-aware#194: in a real Pi session the model is offered one compaction tool, context_compact, and the system
// prompt names it.
// The harness registers the extension through Pi's resource loader, so these read what Pi really activates and sends.

interface Seen {
	readonly messages: string;
}

function recordingResponse(seen: Seen[]): FauxResponseStep {
	return (context) => {
		seen.push({ messages: JSON.stringify(context.messages) });
		return fauxAssistantMessage("Noted.");
	};
}

test("#194: a live session declares context_compact and no compact_session, and the prompt names context_compact", async () => {
	const seen: Seen[] = [];
	await withSession(smallHistory, [recordingResponse(seen)], async ({ session }) => {
		await session.prompt("Where do we stand?");
		await settle(session);

		const active = session.getActiveToolNames();
		assert.ok(active.includes("context_compact"), "context_compact is active: " + active.join(","));
		assert.equal(active.includes("compact_session"), false, "compact_session is not active: " + active.join(","));
		const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool.exposure]));
		assert.equal(registered.get("context_compact"), "direct");
		assert.equal(registered.has("compact_session"), false, "the old name is not registered");

		// What Pi hands the provider: the agent's declared tools and the system prompt of the run.
		const declared = session.agent.state.tools.map((tool) => tool.name);
		assert.ok(declared.includes("context_compact"), "the request declares context_compact: " + declared.join(","));
		assert.equal(declared.includes("compact_session"), false, "the request does not declare compact_session");
		const prompt = session.agent.state.systemPrompt;
		assert.match(prompt, /call context_compact at a clean boundary/u);
		assert.match(prompt, /URGENT: before nontrivial tool use, call context_compact /u);
		assert.doesNotMatch(prompt, /compact_session/u, "the system prompt names no old tool");
	});
});

test("#194: the check-in prompt a live session queues names context_compact", async () => {
	const seen: Seen[] = [];
	await withSession(smallHistory, [recordingResponse(seen), recordingResponse(seen)], async ({ session }) => {
		await session.prompt("/checkin");
		await settle(session);
		const checkin = seen.map((entry) => entry.messages).join("\n");
		assert.match(checkin, /Do not call context_compact/u, "the check-in ran: " + seen.length);
		assert.doesNotMatch(checkin, /compact_session/u);
	});
});
