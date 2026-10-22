import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";

import contextAware from "../src/index.js";
import { foldRecordsOnBranch } from "../src/folds/fold-entries.js";
import { scanFoldRequests } from "../src/folds/fold-recovery.js";

// pi-context-aware#189: the production fold tool, driven through the real extension in a
// live-mode Pi session. The model sees its own earlier context_fold call with a block pointer
// in place of each written item's summary; the session file keeps the call as written.
const SUMMARY_ONE = "TASK AS OF THIS BLOCK: the opening exchange settled the archive plan. Decisions: keep the numbered order; push nothing yet. Files: src/folds/fold-turn.ts.";
const SUMMARY_TWO = "TASK AS OF THIS BLOCK: the middle exchange settled the review plan. Decisions: rebase every branch; keep the tmux-jobs branch open until it passes.";

type Args = { content: { startId: string; endId: string; summary: string; topic?: string }[] };

interface Live {
	readonly requests: Context["messages"][];
	readonly manager: SessionManager;
	prompt(text: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): Promise<void>;
	dispose(): void;
}

async function liveSession(): Promise<Live> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-context-fold-")));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ summarizer: { enabled: false }, proactiveCompaction: { enabled: false }, contextCache: { enabled: false }, restartNotice: { enabled: false } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({ provider: "context-fold", models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("context-fold", "test-only");
	const manager = SessionManager.inMemory(cwd);
	// Long exchanges: the engine's minimum fold size is 5,000 characters.
	for (const name of ["ALPHA", "BETA", "GAMMA", "DELTA"]) {
		manager.appendMessage({ role: "user", content: name + "-QUESTION " + "archived detail ".repeat(400), timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage(name + "-ANSWER " + "archived reply ".repeat(400)));
	}
	const services = await createAgentSessionServices({
		cwd, agentDir, modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: [contextAware as ExtensionFactory], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	await session.bindExtensions({});
	const requests: Context["messages"][] = [];
	return {
		requests, manager,
		async prompt(text, responses) {
			faux.setResponses(responses.map((response) => typeof response === "function"
				? (context: Context, ...rest: unknown[]) => { requests.push(structuredClone(context.messages)); return (response as (c: Context, ...r: unknown[]) => ReturnType<typeof fauxAssistantMessage>)(context, ...rest); }
				: (context: Context) => { requests.push(structuredClone(context.messages)); return response; }));
			await session.prompt(text);
			await session.waitForIdle();
		},
		dispose() {
			session.dispose();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			fs.rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function foldCallIn(messages: Context["messages"], id: string): Args | undefined {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "toolCall" && part.id === id) return part.arguments as Args;
	}
	return undefined;
}
const resultText = (messages: Context["messages"], id: string) => messages.flatMap((message) => message.role === "toolResult" && message.toolCallId === id ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");

test("#189: an earlier context_fold call shows a block pointer for each written item and keeps a refused item's summary", async () => {
	const live = await liveSession();
	try {
		const call: Args = { content: [
			{ startId: "m00002", endId: "m00003", topic: "Opening", summary: SUMMARY_ONE },
			{ startId: "m99998", endId: "m99999", summary: "A refused range whose summary must stay visible to the model." },
			{ startId: "m00004", endId: "m00005", summary: SUMMARY_TWO },
		] };
		await live.prompt("Fold the archive, please.", [
			fauxAssistantMessage(fauxToolCall("context_fold", call, { id: "fold-call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Folded."),
			fauxAssistantMessage("Next."),
		]);
		await live.prompt("What next?", [fauxAssistantMessage("Next.")]);

		// Criterion 5: one request per item, id <tool call id>#<item index>.
		const written = foldRecordsOnBranch(live.manager.getBranch()).map(({ record }) => record);
		assert.deepEqual(written.map((record) => [record.blockId, record.requestId]), [["b1", "fold-call-1#0"], ["b2", "fold-call-1#2"]]);
		assert.match(resultText(live.requests[1]!, "fold-call-1"), /range 2 \(m99998\.\.m99999\) refused:/u);

		// Criteria 1, 3 and 4: the next request shows pointers for the written items only.
		const shown = foldCallIn(live.requests.at(-1)!, "fold-call-1");
		assert.ok(shown, "the earlier call is sent");
		assert.deepEqual(shown.content.map((item) => item.summary), [
			"summary kept in block b1 (" + SUMMARY_ONE.length + " chars)",
			call.content[1]!.summary,
			"summary kept in block b2 (" + SUMMARY_TWO.length + " chars)",
		]);
		assert.deepEqual(shown.content.map((item) => [item.startId, item.endId, item.topic]), call.content.map((item) => [item.startId, item.endId, item.topic]), "only the summaries change");
		// What the provider is sent: message content, not tool-result details (the recovery records).
		const next = JSON.stringify(live.requests.at(-1)!.map((message) => message.content));
		assert.equal(next.split(SUMMARY_ONE.slice(0, 60)).length - 1, 1, "each summary is sent once, in its fold's message");
		assert.doesNotMatch(next, /ALPHA-ANSWER|BETA-QUESTION|BETA-ANSWER/u, "the folded ranges are hidden");

		// Criterion 2: the session file keeps the call as the model wrote it.
		const entry = live.manager.getBranch().find((item) => item.type === "message" && item.message.role === "assistant" && item.message.content.some((part) => part.type === "toolCall" && part.id === "fold-call-1"));
		assert.ok(entry?.type === "message" && entry.message.role === "assistant");
		const stored = entry.message.content.find((part) => part.type === "toolCall");
		assert.deepEqual(stored?.type === "toolCall" ? stored.arguments : undefined, call);
	} finally { live.dispose(); }
});

test("#189: the same tool call run again is answered as a replay and writes nothing new", async () => {
	const live = await liveSession();
	try {
		const call: Args = { content: [{ startId: "m00002", endId: "m00003", summary: SUMMARY_ONE }] };
		// The worker runs the call, then (a durable replay) the same call id again before the turn ends.
		await live.prompt("Fold, twice.", [
			fauxAssistantMessage(fauxToolCall("context_fold", call, { id: "fold-call-r" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("context_fold", call, { id: "fold-call-r" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const results = live.manager.getBranch().flatMap((item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolCallId === "fold-call-r" ? [item.message] : []);
		assert.equal(results.length, 2);
		assert.match(results[0]!.content.map((part) => part.type === "text" ? part.text : "").join(""), /accepted; written at the end of this turn./u);
		assert.match(results[1]!.content.map((part) => part.type === "text" ? part.text : "").join(""), /already (accepted; still queued|folded as b1)./u);
		assert.equal(results.every((result) => result.isError === false), true, "fold results are never error results");
		assert.deepEqual(foldRecordsOnBranch(live.manager.getBranch()).map(({ record }) => record.requestId), ["fold-call-r#0"], "one fold, written once");
		// The accepted item's recovery record is in the result details (fold-recovery.ts contract).
		assert.equal(scanFoldRequests(live.manager.getBranch()).dropped.length, 0);
		assert.equal((results[0]!.details as { requestId?: string } | undefined)?.requestId, "fold-call-r#0");
	} finally { live.dispose(); }
});
