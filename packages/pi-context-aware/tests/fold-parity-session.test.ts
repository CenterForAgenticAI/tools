import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory, type SessionEntry, type ContextEvent,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { entryToCoreMessages } from "../src/folds/fold-adapter.js";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { renderFoldSummary } from "../src/folds/fold-entries.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { readParityRecords } from "../src/parity/records.js";

const SUMMARY = "The opening decisions are settled. Keep the agreed alpha and beta answers for the next phase.";
interface Options { differentRange?: boolean; differentSummary?: boolean; nested?: boolean; absent?: boolean; recorder?: boolean; batch?: boolean; }

/** A real tool/session boundary, with an independently hand-built bcp block. */
async function run(options: Options = {}) {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fold-parity-session-")));
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const expectedCoverage: string[] = [];
	for (const [role, label] of [["user", "ALPHA-QUESTION"], ["assistant", "ALPHA-ANSWER"], ["user", "BETA-QUESTION"], ["assistant", "BETA-ANSWER"]] as const) {
		const content = `${label}\n${"opening history ".repeat(2200)}`;
		expectedCoverage.push(manager.appendMessage(role === "user" ? { role, content, timestamp: 1 } : fauxAssistantMessage(content)));
	}
	for (let i = 0; i < 8; i++) manager.appendMessage({ role: "user", content: `TAIL-${i}\n${"recent history ".repeat(1600)}`, timestamp: 1 });
	const branchSeed = structuredClone(manager.getBranch());
	// This summary-parity fixture intentionally tests the opt-in legacy opening fold.
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "context-aware.json"), JSON.stringify({ folds: { firstUserMessage: "fold" } }));
	const agentDir = path.join(cwd, "agent");
	const sideFile = `${manager.getSessionFile()}.acp.json`;
	let side: { schemaVersion: number; producer: string; blocks: Record<string, unknown>[]; messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> }; } = { schemaVersion: 1, producer: "bcp-stub", blocks: [], messageRefs: { byRaw: {}, byRef: {} } };
	let callEventId = "";
	let executeId = "";
	let beforeRecorderEntries: SessionEntry[] = [];
	let beforeRecorderSide = "";
	let afterRecorderEntries: SessionEntry[] = [];
	let afterRecorderSide = "";
	let flush = async () => {};
	const toolsRegistered: string[] = [];
	const notifications: string[] = [];

	const bcp: ExtensionFactory = (pi) => {
		pi.on("context", (event, ctx) => {
			const messages = ctx.sessionManager.getBranch().flatMap(entryToCoreMessages);
			for (const message of messages) {
				if (side.messageRefs.byRaw[message.id]) continue;
				const ref = `m${String(Object.keys(side.messageRefs.byRaw).length + 1).padStart(5, "0")}`;
				side.messageRefs.byRaw[message.id] = ref;
				side.messageRefs.byRef[ref] = message.id;
			}
			fs.mkdirSync(path.dirname(sideFile), { recursive: true });
			fs.writeFileSync(sideFile, JSON.stringify(side));
			const covered = new Set(side.blocks.flatMap((block) => block.effectiveMessageIds as string[]));
			// This fixture has one carrier (first user) and no assistant split entries.
			const contextEntries = ctx.sessionManager.buildContextEntries().filter((entry) => entry.type === "message");
			return { messages: event.messages.flatMap((message, index): ContextEvent["messages"] => {
				const entry = contextEntries[index];
				if (entry && covered.has(entry.id)) {
					const block = side.blocks.find((block) => (block.effectiveMessageIds as string[])[0] === entry.id);
					if (!block) return [];
					return [{ role: "user" as const, content: renderFoldSummary(options.differentSummary ? "A different summary appeared in bcp's next request." : block.summary as string, "opening"), timestamp: 1 }];
				}
				if (message.role !== "user" && message.role !== "toolResult") return [message];
				const tag = `<acp tokens="1K" type="text">${entry ? side.messageRefs.byRaw[entry.id] : "m99999"}</acp>`;
				const content = typeof message.content === "string" ? `${message.content}\n${tag}` : [...message.content, { type: "text" as const, text: tag }];
				return message.role === "toolResult" ? [{ ...message, content: [...message.content, { type: "text", text: tag }] }] : [{ ...message, content }];
			}) };
		});
		pi.on("tool_call", (event) => { if (event.toolName === "compress") callEventId = event.toolCallId; });
		pi.registerTool({ name: "acp_status", label: "status", description: "bcp marker", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "status" }], details: {} }; } });
		pi.registerTool({
			name: "compress", label: "compress", description: "bcp stub", parameters: Type.Object({ content: Type.Array(Type.Object({ startId: Type.String(), endId: Type.String(), summary: Type.String(), topic: Type.Optional(Type.String()) })) }),
			async execute(id, params) {
				executeId = id;
				const range = params.content[0]!;
				const ids = options.differentRange ? branchSeed.slice(0, 2).map((entry) => entry.id) : range.startId === "m00005" ? branchSeed.slice(4, 8).map((entry) => entry.id) : [...expectedCoverage];
				const n = side.blocks.length + 1;
				side = { ...side, blocks: [...side.blocks, { blockId: `b${n}`, runId: `r${n}`, active: true, tier: 1, topic: "opening", summary: range.summary, directMessageIds: ids, effectiveMessageIds: ids, directBlockIds: [], startRef: range.startId, endRef: range.endId, compressedTokens: 12000, createdAt: 1, compressCallId: id, survivedCount: 0, generation: "young" }] };
				fs.writeFileSync(sideFile, JSON.stringify(side));
				// bcp's real result panel format; the recorder classifies it into a typed outcome.
				return { content: [{ type: "text", text: `\u25A3 ACP | 40.0K \u2192 1.0K tokens (~39.0K reclaimed, blocks: b${n}=${range.startId}\u2013${range.endId})` }], details: {} };
			},
		});
	};
	const request = { content: [{ startId: "m00001", endId: "m00004", summary: SUMMARY, topic: "opening" }] };
	const observer: ExtensionFactory = (pi) => {
		pi.on("tool_result", (_event, ctx) => { beforeRecorderEntries = structuredClone(ctx.sessionManager.getEntries()); beforeRecorderSide = fs.existsSync(sideFile) ? fs.readFileSync(sideFile, "utf8") : ""; });
		if (options.recorder !== false) {
			const recording = new Proxy(pi, { get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver) as unknown;
				if (typeof value !== "function") return value;
				if (key === "registerTool") return (...args: unknown[]) => { toolsRegistered.push(String((args[0] as { name: string }).name)); return (value as (...args: unknown[]) => unknown).apply(target, args); };
				return (value as (...args: unknown[]) => unknown).bind(target);
			} });
			const engine = registerFoldEngine(pi);
			flush = registerFoldParityRecorder(recording, { engine, agentDir, fingerprint: "engine" }).flush;
		}
		pi.on("tool_result", (_event, ctx) => { afterRecorderEntries = structuredClone(ctx.sessionManager.getEntries()); afterRecorderSide = fs.existsSync(sideFile) ? fs.readFileSync(sideFile, "utf8") : ""; });
		if (options.nested) pi.registerTool({ name: "nested_probe", label: "nested", description: "nested compress", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx) {
			const first = await ctx.executeTool("compress", request);
			if (options.batch) await ctx.executeTool("compress", { content: [{ startId: "m00005", endId: "m00008", summary: "The middle conversation was also settled, after the opening. Keep this second summary in order.", topic: "opening" }] });
			return first.result;
		} });
		if (options.absent) pi.registerTool({ name: "compress", label: "other compress", description: "not bcp", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "unrelated tool" }], details: {} }; } });
	};
	const faux = fauxProvider({ provider: "fold-parity", models: [{ id: "test", contextWindow: 1_000_000, maxTokens: 4096 }], tokensPerSecond: Infinity });
	faux.setResponses([fauxAssistantMessage(fauxToolCall(options.nested ? "nested_probe" : "compress", options.nested || options.absent ? {} : request, { id: "parity-probe" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("fold-parity", "test");
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: { extensionFactories: options.absent ? [observer] : [bcp, observer], noExtensions: true } });
		session = (await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() })).session;
		await session.bindExtensions({ uiContext: { ...session.extensionRunner.createContext().ui, notify: (message) => { notifications.push(message); } } });
		await session.prompt("Fold the opening.");
		await session.waitForIdle();
		await flush();
		const sideBeforeReport = fs.existsSync(sideFile) ? fs.readFileSync(sideFile, "utf8") : "";
		if (options.recorder !== false) await session.prompt("/fold-parity");
		const records = await readParityRecords(agentDir);
		return { records, expectedCoverage, callEventId, executeId, toolsRegistered, notifications, entries: manager.getEntries(), beforeRecorderEntries, afterRecorderEntries, beforeRecorderSide, afterRecorderSide, sideBeforeReport, sideAfterReport: fs.existsSync(sideFile) ? fs.readFileSync(sideFile, "utf8") : "", toolNames: session.getAllTools().map((tool) => tool.name).sort() };
	} finally { session?.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
}

test("shadow recorder agrees on hand-written four-entry coverage and next-request summaries", async () => {
	const result = await run();
	const compress = result.records.find((record) => record.kind === "compress");
	assert.ok(compress);
	assert.equal(compress.verdict, "match", JSON.stringify(compress));
	assert.deepEqual(compress.ours?.coverageIds, [...result.expectedCoverage].sort());
	assert.deepEqual(compress.bcp?.coverageIds, [...result.expectedCoverage].sort());
	const next = result.records.find((record) => record.kind === "next-request");
	assert.ok(next);
	assert.equal(next.verdict, "match", JSON.stringify(next));
	assert.equal(next.bcp?.messages.filter((message) => message.summary).length, 1);
	assert.match(result.notifications.join("\n"), /count 1\/500.*\nmatch 1/u);
	assert.doesNotMatch(JSON.stringify(result.records), /opening decisions|ALPHA-QUESTION|opening history/u);
});

test("shadow recorder reports coverage when bcp folds a different range", async () => {
	const result = await run({ differentRange: true });
	const call = result.records.find((record) => record.kind === "compress");
	assert.equal(call?.verdict, "diff");
	const coverage = call?.diffs.find((diff) => diff.kind === "coverage");
	assert.deepEqual(coverage?.oursOnly, result.expectedCoverage.slice(2).sort());
	assert.equal(coverage?.oursOnlyCount, 2);
	assert.equal(coverage?.bcpOnlyCount, 0);
});

test("shadow recorder reports changed summary at the next provider request", async () => {
	const result = await run({ differentSummary: true });
	const next = result.records.find((record) => record.kind === "next-request");
	assert.equal(next?.verdict, "diff");
	assert.deepEqual(next?.diffs.map((diff) => diff.kind), ["summaries"]);
	assert.match(result.notifications.join("\n"), /diff 1.*\n.*Ready: no[\s\S]*summaries/u);
});

test("native nested compress calls are recorded with the execute toolCallId and nested flag", async () => {
	const result = await run({ nested: true });
	const call = result.records.find((record) => record.kind === "compress");
	assert.ok(call);
	assert.equal(call.nested, true);
	assert.equal(call.toolCallId, result.executeId);
	assert.equal(result.callEventId, result.executeId);
	assert.match(call.toolCallId, /\/1$/u);
	assert.ok(call.parentToolCallId);
	assert.equal(call.verdict, "match", JSON.stringify(call));
});

test("several nested calls before one provider request are previewed in order from the first pre-state", async () => {
	const result = await run({ nested: true, batch: true });
	const calls = result.records.filter((record) => record.kind === "compress");
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.verdict), ["match", "match"]);
	const requests = result.records.filter((record) => record.kind === "next-request");
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]?.toolCallIds, ["parity-probe/1", "parity-probe/2"]);
	assert.equal(requests[0]?.verdict, "match", JSON.stringify(requests[0]));
	assert.equal(requests[0]?.ours?.messages.filter((message) => message.summary).length, 2);
	assert.match(result.notifications.join("\n"), /count 2\/500/u);
});

test("without bcp the recorder ignores even an unrelated compress tool", async () => {
	const result = await run({ absent: true });
	assert.deepEqual(result.records, []);
	assert.match(result.notifications.join("\n"), /count 0\/500/u);
});

test("recorder is observe-only: identical session entries, side bytes, and tool names", async () => {
	const withRecorder = await run();
	const withoutRecorder = await run({ recorder: false });
	assert.deepEqual(withRecorder.afterRecorderEntries, withRecorder.beforeRecorderEntries);
	assert.equal(withRecorder.afterRecorderSide, withRecorder.beforeRecorderSide);
	assert.equal(withRecorder.sideBeforeReport, withRecorder.sideAfterReport);
	assert.deepEqual(withRecorder.toolsRegistered, []);
	assert.deepEqual(withRecorder.toolNames, withoutRecorder.toolNames);
	assert.equal(withRecorder.entries.filter((entry) => entry.type === "context_edit" || entry.type === "custom").length, 0);
	// Random Pi ids and timestamps differ across independent real sessions; compare entry payloads.
	const payloads = (entries: SessionEntry[]) => entries.map((entry) => {
		const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = entry;
		if (payload.type === "message") { const { timestamp: _time, ...message } = payload.message; return { ...payload, message }; }
		return payload;
	});
	const stable = (entries: SessionEntry[]) => JSON.stringify(payloads(entries), (key, value: unknown) => key === "durationMs" ? undefined : value)
		.replace(/fold-parity-session-[A-Za-z0-9]+/gu, "fold-parity-session-TEMP")
		.replace(/faux:\d+:[a-z0-9]+/gu, "faux:API")
		.replace(/tool:\d+:[a-z0-9]+/gu, "tool:CALL");
	assert.equal(stable(withRecorder.entries), stable(withoutRecorder.entries));
});
