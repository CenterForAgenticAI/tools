import test from "node:test";
import assert from "node:assert/strict";

import type { AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

import { NOTHING_TO_COMPACT_TOOL_MESSAGE } from "../src/compaction/compaction-outcome.js";
import { compactionStarts, largeHistory, NOTHING_TO_COMPACT, SEED, settle, smallHistory, waitFor, withSession } from "./compaction-preflight-harness.js";

// The compaction preflight in a real Pi session, for context_compact,
// /compact-then and the compaction owner claim. The service's cases are in
// tests/context-service.test.ts.

function compactSessionCall(): FauxResponseStep {
	return fauxAssistantMessage(
		[fauxToolCall("context_compact", { seed_prompt: SEED, rewrite_seed: false }, { id: "preflight-call" })],
		{ stopReason: "toolUse" },
	);
}

function compactSessionEnd(events: readonly AgentSessionEvent[]): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	const end = events.find((event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
		event.type === "tool_execution_end" && event.toolName === "context_compact");
	assert.ok(end, "context_compact ran");
	return end;
}

test("context_compact on a session Pi refuses answers at once and the run goes on", async () => {
	await withSession(() => {}, [compactSessionCall(), fauxAssistantMessage("Nothing was compacted; carrying on.")], async ({ session, faux, events }) => {
		await session.prompt("Hand off to the next phase.");
		await settle(session);

		const end = compactSessionEnd(events);
		assert.equal(end.isError, false);
		assert.deepEqual(end.result.content, [{ type: "text", text: NOTHING_TO_COMPACT_TOOL_MESSAGE }]);
		assert.deepEqual(end.result.details, { status: "nothing-to-compact" });
		const updates = events.filter((event) => event.type === "tool_execution_update" && event.toolName === "context_compact");
		assert.doesNotMatch(JSON.stringify(updates), /queued/iu, "no queued report before the refusal");
		// The result did not end the run: the model was asked again.
		assert.equal(faux.state.callCount, 2);
		assert.equal(compactionStarts(events), 0, "nothing was queued for Pi to compact");

		// Pi's own compaction of the same session refuses it too.
		await assert.rejects(session.compact(), { message: NOTHING_TO_COMPACT });
	});
});

test("context_compact on a session Pi compacts is queued and Pi then compacts it", async () => {
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

const FABRIC_CHILD_LINEAGE = JSON.stringify({ version: 1, rootSessionId: "root", runId: "child-run", depth: 1, childIndex: 0, worker: true });

async function asFabricChild(body: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_FABRIC_LINEAGE;
	process.env.PI_FABRIC_LINEAGE = FABRIC_CHILD_LINEAGE;
	try {
		await body();
	} finally {
		if (previous === undefined) delete process.env.PI_FABRIC_LINEAGE;
		else process.env.PI_FABRIC_LINEAGE = previous;
	}
}

// A Fabric child ends when its run ends, so a context_compact handoff there
// would never deliver its seed and the rest of the work would be lost silently.
test("context_compact in a Fabric child does not end the run or compact", async () => {
	await asFabricChild(async () => {
		let secondRequest = "";
		const carryOn: FauxResponseStep = (context) => {
			secondRequest = JSON.stringify(context.messages);
			return fauxAssistantMessage("Kept working in this run.");
		};
		await withSession(largeHistory, [compactSessionCall(), carryOn], async ({ session, faux, events, preparations }) => {
			assert.equal(session.getActiveToolNames().includes("context_compact"), false, "a child is not offered context_compact");
			// A model that calls it anyway gets Pi's not-found error and keeps going;
			// the next test covers a call that reaches the tool.
			await session.prompt("Hand off to the next phase.");
			await settle(session);

			const end = compactSessionEnd(events);
			assert.equal(end.isError, true, "the model sees an error, not a queued handoff");
			assert.doesNotMatch(JSON.stringify(end.result), /Compaction queued/u);
			assert.equal(faux.state.callCount, 2, "the run went on: the model was asked again");
			assert.match(JSON.stringify(end.result), /Tool context_compact not found/u);
			assert.match(secondRequest, /Tool context_compact not found/u, "the model sees the error in the next request");
			assert.equal(compactionStarts(events), 0, "nothing was queued for Pi to compact");
			assert.equal(preparations.length, 0);
		});
	});
});

test("context_compact called directly in a Fabric child refuses with a reason and queues nothing", async () => {
	await asFabricChild(async () => {
		await withSession(largeHistory, [], async ({ session, events, preparations }) => {
			const tool = session.extensionRunner.getToolDefinition("context_compact");
			assert.ok(tool, "context_compact stays registered");
			await assert.rejects(
				tool.execute("child-call", { seed_prompt: SEED, rewrite_seed: false }, new AbortController().signal, undefined, session.extensionRunner.createToolContext("child-call", undefined)),
				/^Error: Refused: context_compact is unavailable in a Fabric child session..*Nothing was compacted. Keep working/su,
			);
			await settle(session);
			assert.equal(compactionStarts(events), 0);
			assert.equal(preparations.length, 0);
		});
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

test("/compact-then /<command> sends the command as a command only after Pi's compaction is committed", async () => {
	const seen: string[] = [];
	const command: ExtensionFactory = (api) => {
		api.registerCommand("phase-two", {
			description: "Starts the next phase",
			handler: async (args) => {
				seen.push(args);
				api.sendUserMessage(`PHASE-TWO-RAN ${args}`);
			},
		});
	};
	const summary = fauxAssistantMessage("## Goal\nMigration summary.");
	const reply = fauxAssistantMessage("Phase two started.");
	await withSession(largeHistory, [summary, reply], async ({ session, events, notifications }) => {
		await session.prompt("/compact-then /phase-two --fast now");
		await waitFor(() => seen.length > 0, "the command to run");
		await settle(session);

		assert.deepEqual(notifications.filter((message) => /could not be invoked|Compaction failed/u.test(message)), []);
		assert.deepEqual(seen, ["--fast now"], "the registered command ran once, with its arguments");
		const entries = session.sessionManager.getEntries();
		const compactionAt = entries.findIndex((entry) => entry.type === "compaction");
		assert.ok(compactionAt >= 0, "the transcript holds a compaction entry");
		const after = entries.slice(compactionAt + 1);
		const userTexts = after
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map((entry) => JSON.stringify((entry as { message: { content: unknown } }).message.content));
		assert.equal(userTexts.length, 1, "exactly one user message follows the compaction: no seed message");
		assert.match(userTexts[0]!, /PHASE-TWO-RAN --fast now/u, "it is the command's own output, not the literal /compact-then text");
		assert.doesNotMatch(userTexts[0]!, /compact-then|\/phase-two/u);
		const before = entries.slice(0, compactionAt);
		assert.ok(!before.some((entry) => JSON.stringify(entry).includes("PHASE-TWO-RAN")), "nothing of the command precedes the compaction");
		const order = events.map((event) => event.type).filter((type) => type === "compaction_end" || type === "message_start");
		assert.ok(order.includes("compaction_end"));
	}, { completeCompaction: true, extensions: [command] });
});
