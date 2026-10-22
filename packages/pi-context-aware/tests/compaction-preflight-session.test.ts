import test from "node:test";
import assert from "node:assert/strict";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

import { NOTHING_TO_COMPACT_TOOL_MESSAGE } from "../src/compaction/compaction-outcome.js";
import { compactionStarts, largeHistory, NOTHING_TO_COMPACT, SEED, settle, smallHistory, waitFor, withSession } from "./compaction-preflight-harness.js";

// The compaction preflight in a real Pi session, for compact_session,
// /compact-then and the compaction owner claim. The service's cases are in
// tests/context-service.test.ts.

function compactSessionCall(): FauxResponseStep {
	return fauxAssistantMessage(
		[fauxToolCall("compact_session", { seed_prompt: SEED, rewrite_seed: false }, { id: "preflight-call" })],
		{ stopReason: "toolUse" },
	);
}

function compactSessionEnd(events: readonly AgentSessionEvent[]): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	const end = events.find((event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
		event.type === "tool_execution_end" && event.toolName === "compact_session");
	assert.ok(end, "compact_session ran");
	return end;
}

test("compact_session on a session Pi refuses answers at once and the run goes on", async () => {
	await withSession(() => {}, [compactSessionCall(), fauxAssistantMessage("Nothing was compacted; carrying on.")], async ({ session, faux, events }) => {
		await session.prompt("Hand off to the next phase.");
		await settle(session);

		const end = compactSessionEnd(events);
		assert.equal(end.isError, false);
		assert.deepEqual(end.result.content, [{ type: "text", text: NOTHING_TO_COMPACT_TOOL_MESSAGE }]);
		assert.deepEqual(end.result.details, { status: "nothing-to-compact" });
		const updates = events.filter((event) => event.type === "tool_execution_update" && event.toolName === "compact_session");
		assert.doesNotMatch(JSON.stringify(updates), /queued/iu, "no queued report before the refusal");
		// The result did not end the run: the model was asked again.
		assert.equal(faux.state.callCount, 2);
		assert.equal(compactionStarts(events), 0, "nothing was queued for Pi to compact");

		// Pi's own compaction of the same session refuses it too.
		await assert.rejects(session.compact(), { message: NOTHING_TO_COMPACT });
	});
});

test("compact_session on a session Pi compacts is queued and Pi then compacts it", async () => {
	await withSession(largeHistory, [compactSessionCall()], async ({ session, faux, events, preparations }) => {
		await session.prompt("Hand off to the next phase.");
		await session.waitForIdle();

		const end = compactSessionEnd(events);
		assert.equal(end.isError, false);
		assert.match(end.result.content[0].text, /^Compaction queued\./u);
		assert.equal(faux.state.callCount, 1, "the queued result ended the run");
		await waitFor(() => preparations.length > 0, "Pi's compaction");
		assert.equal(compactionStarts(events), 1);
		assert.ok(preparations[0]!.messagesToSummarize.length > 0, "Pi found history to summarize");
	});
});

test("/compact-then refuses an idle session Pi refuses, with Pi's message", async () => {
	await withSession(smallHistory, [], async ({ session, events, notifications, preparations }) => {
		await session.prompt(`/compact-then ${SEED}`);
		assert.ok(notifications.includes(NOTHING_TO_COMPACT_TOOL_MESSAGE), JSON.stringify(notifications));
		await settle(session);
		assert.equal(compactionStarts(events), 0);
		assert.equal(preparations.length, 0);

		await assert.rejects(session.compact(), { message: NOTHING_TO_COMPACT });
	});
});

test("a compact.request through the owner claim refuses an idle session Pi refuses", async () => {
	await withSession(smallHistory, [], async ({ session, events, preparations, fabric }) => {
		assert.ok(fabric?.claim, "context-aware holds the owner claim");
		const result = await fabric.call("request", { seed: SEED }, undefined);
		assert.deepEqual(result, { queued: false, reason: NOTHING_TO_COMPACT_TOOL_MESSAGE });
		await settle(session);
		assert.equal(compactionStarts(events), 0);
		assert.equal(preparations.length, 0);

		await assert.rejects(session.compact(), { message: NOTHING_TO_COMPACT });
	}, { ownerClaim: true });
});

test("a compact.request through the owner claim hands an idle session Pi compacts to Pi", async () => {
	await withSession(largeHistory, [], async ({ events, preparations, fabric }) => {
		assert.ok(fabric?.claim, "context-aware holds the owner claim");
		const result = await fabric.call("request", { seed: SEED }, undefined) as { queued: boolean };
		assert.equal(result.queued, true, JSON.stringify(result));
		await waitFor(() => preparations.length > 0, "Pi's compaction");
		assert.equal(compactionStarts(events), 1);
		assert.ok(preparations[0]!.messagesToSummarize.length > 0, "Pi found history to summarize");
	}, { ownerClaim: true });
});
