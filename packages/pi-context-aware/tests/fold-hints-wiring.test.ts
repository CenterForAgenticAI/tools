import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { complete as compatComplete } from "@earendil-works/pi-ai/compat";

import contextAware from "../src/index.js";
import {
	discoverContextAwareServiceV1,
	supportsContextAwareFoldHintsV1,
	type ContextAwareServiceV1,
} from "../src/context-service.js";
import { createFoldHints, MAX_HINT_CONDENSED_CHARS } from "../src/folds/fold-hints.js";
import { planFold } from "../src/folds/fold-adapter.js";

// pi-context-aware#294: the fold-hint wiring in src/index.ts, driven through the extension itself.
// Seams: the discovered service (folds.registerHint / endOwner), the session_before_compact handler,
// and a live fold turn (context_fold). Every expected string below comes from the hint the test
// registers, never from a value the test stubs for the code under test.

const BODY = "DEMO-BODY-SECRET " + "padding text ".repeat(30);
const CONDENSED = "CONDENSED-TEXT-7a2: the demo skill, reduced to its rule.";
const LINE = "demo status: green";
const SUMMARY = "TASK AS OF THIS BLOCK: the opening exchange settled the plan. Decisions: keep the numbered order. Files: src/index.ts.";
const OWNER = "wiring-test";

function seedWindow(name: string, summarizer = false): { dir: string; restore: () => void } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-hint-wiring-" + name + "-")));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({
		...(summarizer ? {} : { summarizer: { enabled: false } }), proactiveCompaction: { enabled: false, commitDrainTimeoutMs: 0 }, contextCache: { enabled: false },
		restartNotice: { enabled: false }, seedRewrite: false, sessionNaming: { scope: "off" }, workstream: { enabled: false },
	}));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return {
		dir,
		restore() {
			if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
			if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

// ---- a bare extension harness for the service and compaction seams -------------------------------

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

function fakePi(flags: Record<string, unknown>): { api: ExtensionAPI; handlers: Map<string, Handler[]>; bus: EventBus } {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBus = {
		emit(channel, data) { for (const listener of listeners.get(channel) ?? []) listener(data); },
		on(channel, listener) {
			const set = listeners.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(listener);
			listeners.set(channel, set);
			return () => { set.delete(listener); };
		},
	};
	const api = {
		events: bus,
		registerFlag() {},
		getFlag: (name: string) => flags[name],
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {},
		registerCommand() {},
		getCommands: () => [],
		sendMessage() {},
		sendUserMessage() {},
		getActiveTools: () => ["read", "bash", "edit"],
		getAllTools: () => [],
		setActiveTools() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, handlers, bus };
}

async function dispatch(harness: { handlers: Map<string, Handler[]> }, name: string, event: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
	let result: unknown;
	for (const handler of harness.handlers.get(name) ?? []) {
		const next = await handler(event, ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

function sessionContext(root: string, label: string, model: unknown): ExtensionContext {
	const entries: unknown[] = [];
	return {
		hasUI: false,
		cwd: root,
		model,
		getContextUsage: () => ({ tokens: 128_000 }),
		isProjectTrusted: () => true,
		isIdle: () => true,
		signal: undefined,
		modelRegistry: {
			find: (provider: string, id: string) => (provider === (model as { provider: string }).provider && id === (model as { id: string }).id ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			complete: compatComplete,
		},
		ui: { notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {} },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionDir: () => root,
			getSessionFile: () => path.join(root, label + ".jsonl"),
			getSessionId: () => label,
			appendCustomEntry() {},
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => label + "-leaf",
		},
	} as unknown as ExtensionContext;
}

interface Bench {
	readonly harness: ReturnType<typeof fakePi>;
	readonly seen: string[];
	readonly model: unknown;
	start(label: string): Promise<{ ctx: ExtensionContext; service: ContextAwareServiceV1 }>;
	compact(ctx: ExtensionContext, preparation: Record<string, unknown>, branchEntries?: unknown[]): Promise<string>;
	dispose(): void;
}

async function bench(): Promise<Bench> {
	const window = seedWindow("compact", true);
	const compat = await import(new URL("./compat.js", import.meta.resolve("@earendil-works/pi-ai")).href) as typeof import("@earendil-works/pi-ai/compat");
	const faux = compat.registerFauxProvider({
		api: "openai-completions", provider: "hint-wiring", models: [{ id: "summary", contextWindow: 32_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const seen: string[] = [];
	faux.setResponses(Array.from({ length: 16 }, () => (context: Context) => {
		seen.push(JSON.stringify(context.messages));
		return compat.fauxAssistantMessage("Wiring summary.");
	}));
	const harness = fakePi({ "context-aware-model": "hint-wiring/summary" });
	contextAware(harness.api);
	const model = faux.getModel();
	return {
		harness, seen, model,
		async start(label) {
			const ctx = sessionContext(window.dir, label, model);
			await dispatch(harness, "session_start", {}, ctx);
			const service = discoverContextAwareServiceV1(harness.bus, "wiring-" + label);
			assert.ok(service, "session_start publishes the service");
			return { ctx, service };
		},
		async compact(ctx, preparation, branchEntries) {
			const before = seen.length;
			const result = await dispatch(harness, "session_before_compact", {
				reason: "manual", willRetry: false, signal: new AbortController().signal, preparation,
				...(branchEntries ? { branchEntries } : {}),
			}, ctx) as { compaction?: { summary?: string } } | undefined;
			assert.match(result?.compaction?.summary ?? "", /Wiring summary\./u, "the override model wrote the summary");
			assert.equal(seen.length, before + 1, "one summary request");
			return seen.at(-1)!;
		},
		dispose() { faux.unregister(); compat.resetApiProviders(); window.restore(); },
	};
}

function demoMessage(content = BODY): Record<string, unknown> {
	return { role: "custom", customType: "demo-status", content, display: true, details: { state: "green" }, timestamp: 1_700_000_000_000 };
}

function preparation(messages: unknown[], turnPrefix: unknown[] = []): Record<string, unknown> {
	return { firstKeptEntryId: "kept", messagesToSummarize: messages, turnPrefixMessages: turnPrefix, tokensBefore: 120_000 };
}

const oneLineHint = { ownerKey: OWNER, match: { customType: "demo-status" }, policy: "one-line" as const, summarize: (details: unknown) => "demo status: " + String((details as { state?: unknown }).state) };

// ---- service exposure and the per-session registry ------------------------------------------------

test("#294: the discovered service offers fold hints, and a registered hint reaches session_before_compact", async () => {
	const b = await bench();
	try {
		const { ctx, service } = await b.start("exposure");
		assert.equal(supportsContextAwareFoldHintsV1(service), true, "the service declares fold hints v1");
		assert.deepEqual(service.folds?.registerHint(oneLineHint), { ok: true, replaced: false });
		const prompt = await b.compact(ctx, preparation([demoMessage(), { role: "user", content: "next request", timestamp: 1_700_000_000_001 }]));
		assert.ok(prompt.includes("extension message kept as one line"), "the hint's marker line is what the summarizer reads");
		assert.ok(prompt.includes(LINE), prompt);
		assert.equal(prompt.includes("DEMO-BODY-SECRET"), false, "the message body does not reach the summarizer");
	} finally { b.dispose(); }
});

test("#294: hints are per session, and endOwner removes only that owner's hints", async () => {
	const b = await bench();
	try {
		const a = await b.start("session-a");
		assert.ok(a.service.folds?.registerHint(oneLineHint).ok);
		assert.ok(a.service.folds?.registerHint({ ownerKey: "other-owner", match: { customType: "other-note" }, policy: "one-line", line: "other note line" }).ok);
		const other = { role: "custom", customType: "other-note", content: "OTHER-BODY-SECRET", display: true, timestamp: 1_700_000_000_002 };
		const input = () => preparation([demoMessage(), other, { role: "user", content: "next request", timestamp: 1_700_000_000_003 }]);

		assert.equal(a.service.folds?.endOwner(OWNER), 1, "endOwner reports the one hint it removed");
		const afterEnd = await b.compact(a.ctx, input());
		assert.ok(afterEnd.includes("DEMO-BODY-SECRET"), "the ended owner's hint no longer applies");
		assert.ok(afterEnd.includes("other note line") && !afterEnd.includes("OTHER-BODY-SECRET"), "the other owner's hint still applies");

		const second = await b.start("session-b");
		assert.ok(second.service.folds?.registerHint({ ownerKey: "b-owner", match: { customType: "demo-status" }, policy: "one-line", line: "session b line" }).ok);
		const inB = await b.compact(second.ctx, preparation([demoMessage(), { role: "user", content: "next", timestamp: 1_700_000_000_004 }]));
		assert.ok(inB.includes("session b line"), "session B sees its own hint");
		const inA = await b.compact(a.ctx, preparation([demoMessage(), { role: "user", content: "next", timestamp: 1_700_000_000_005 }]));
		assert.equal(inA.includes("session b line"), false, "session A does not see session B's hint");
		assert.ok(inA.includes("DEMO-BODY-SECRET"), "session A still folds nothing for demo-status");
	} finally { b.dispose(); }
});

// ---- session_before_compact -----------------------------------------------------------------------

test("#294: compaction names verbatim tools and drops a read note through the handler", async () => {
	const b = await bench();
	try {
		const { ctx, service } = await b.start("policies");
		assert.ok(service.folds?.registerHint({ ownerKey: OWNER, match: { customType: "read-note" }, policy: "drop-after-read" }).ok);
		assert.ok(service.folds?.registerHint({ ownerKey: OWNER, match: { toolName: "demo_tool" }, policy: "verbatim" }).ok);
		const note = { role: "custom", customType: "read-note", content: "READ-NOTE-BODY", display: true, timestamp: 1_700_000_000_010 };
		const call = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "demo_tool", arguments: {} }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1_700_000_000_011 };
		const result = { role: "toolResult", toolCallId: "t1", toolName: "demo_tool", content: [{ type: "text", text: "TOOL-RESULT-VERBATIM" }], isError: false, timestamp: 1_700_000_000_012 };
		const prompt = await b.compact(ctx, preparation([note, call, result]));
		assert.equal(prompt.includes("READ-NOTE-BODY"), false, "a note the assistant already answered is dropped");
		assert.ok(prompt.includes("TOOL-RESULT-VERBATIM"));
		assert.ok(prompt.includes("Quote every call and result of these tools word for word in the summary, as decisions: demo_tool."), "the instruction reaches the summarizer");
	} finally { b.dispose(); }
});

test("#294: a fold carrier keeps its summary through the handler (CR-HINT-CARRIER-SUMMARY-LOST)", async () => {
	const b = await bench();
	try {
		const { ctx, service } = await b.start("carrier");
		assert.ok(service.folds?.registerHint(oneLineHint).ok);
		const iso = "2023-11-14T22:13:20.000Z";
		const carrier = { role: "custom", customType: "demo-status", content: "CARRIER-FOLD-SUMMARY-9c1", display: true, details: { state: "green" }, timestamp: new Date(iso).getTime() };
		const branch = [
			{ type: "custom_message", id: "c1", parentId: null, timestamp: iso, customType: "demo-status", content: BODY, display: true },
			{ type: "context_edit", id: "e1", parentId: "c1", timestamp: iso, targetId: "c1", replacement: { content: "CARRIER-FOLD-SUMMARY-9c1" } },
		];
		const prompt = await b.compact(ctx, preparation([carrier, { role: "user", content: "next", timestamp: 1_700_000_000_020 }]), branch);
		assert.ok(prompt.includes("CARRIER-FOLD-SUMMARY-9c1"), "the fold summary reaches the summarizer");
		assert.equal(prompt.includes("extension message kept as one line"), false, "the carrier is not rewritten as a one-line message");
	} finally { b.dispose(); }
});

test("#294: the condensed policy puts the condensed text into the compaction input", async () => {
	const b = await bench();
	try {
		const { ctx, service } = await b.start("condensed");
		assert.ok(CONDENSED.length < MAX_HINT_CONDENSED_CHARS);
		assert.ok(service.folds?.registerHint({ ownerKey: OWNER, match: { customType: "demo-status" }, policy: "condensed", condensed: CONDENSED }).ok);
		const prompt = await b.compact(ctx, preparation([demoMessage(), { role: "user", content: "next", timestamp: 1_700_000_000_030 }]));
		assert.ok(prompt.includes(CONDENSED), "the condensed text is what the summarizer reads");
		assert.equal(prompt.includes("DEMO-BODY-SECRET"), false);
	} finally { b.dispose(); }
});

test("#294: a hint transform that throws leaves the compaction input unchanged and compaction goes on", async () => {
	const b = await bench();
	try {
		const { ctx, service } = await b.start("failure");
		assert.ok(service.folds?.registerHint(oneLineHint).ok);
		// The first read of the message list, inside the transform, throws; later reads are real.
		const messages = [demoMessage(), { role: "user", content: "next", timestamp: 1_700_000_000_040 }];
		let reads = 0;
		const failing = Object.assign([...messages], {
			[Symbol.iterator]: function* () {
				reads += 1;
				if (reads === 1) throw new Error("transform boom");
				yield* messages;
			},
		});
		const prompt = await b.compact(ctx, preparation(failing as unknown as unknown[]));
		assert.ok(reads >= 1, "the transform ran");
		assert.ok(prompt.includes("DEMO-BODY-SECRET"), "the raw event is used when the transform fails");
		const log = fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "context-aware-debug.log"), "utf8");
		assert.match(log, /fold hints: compaction transform failed: Error: transform boom/u, "the failure is logged through debugLog");
	} finally { b.dispose(); }
});

// ---- a live fold turn ------------------------------------------------------------------------------

interface Live {
	readonly requests: Context["messages"][];
	readonly manager: SessionManager;
	service(): ContextAwareServiceV1 | undefined;
	prompt(text: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): Promise<void>;
	dispose(): void;
}

async function liveSession(): Promise<Live> {
	const window = seedWindow("fold");
	const cwd = window.dir;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const faux = fauxProvider({ provider: "hint-fold", models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("hint-fold", "test-only");
	const manager = SessionManager.inMemory(cwd);
	const long = (label: string) => label + " " + "archived detail ".repeat(400);
	manager.appendMessage({ role: "user", content: long("ALPHA-QUESTION"), timestamp: Date.now() });
	manager.appendCustomMessageEntry("demo-status", BODY + " " + CONDENSED_SOURCE, true, { state: "green" });
	manager.appendMessage(fauxAssistantMessage(long("ALPHA-ANSWER")));
	for (const name of ["BETA", "GAMMA", "DELTA"]) {
		manager.appendMessage({ role: "user", content: long(name + "-QUESTION"), timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage(long(name + "-ANSWER")));
	}
	let bus: EventBus | undefined;
	const probe: ExtensionFactory = (api) => { bus = api.events; };
	const services = await createAgentSessionServices({
		cwd, agentDir, modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: [contextAware as ExtensionFactory, probe], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	await session.bindExtensions({});
	const requests: Context["messages"][] = [];
	return {
		requests, manager,
		service: () => (bus ? discoverContextAwareServiceV1(bus, "wiring-fold") : undefined),
		async prompt(text, responses) {
			faux.setResponses(responses.map((response) => (context: Context) => { requests.push(structuredClone(context.messages)); return response as ReturnType<typeof fauxAssistantMessage>; }));
			await session.prompt(text);
			await session.waitForIdle();
		},
		dispose() { session.dispose(); window.restore(); },
	};
}
const CONDENSED_SOURCE = "full demo skill text";

async function foldTurn(hint: Record<string, unknown> | undefined): Promise<string> {
	const live = await liveSession();
	try {
		if (hint) {
			const service = live.service();
			assert.ok(supportsContextAwareFoldHintsV1(service));
			assert.deepEqual(service.folds.registerHint(hint as never), { ok: true, replaced: false });
		}
		const call = { content: [{ startId: "m00001", endId: "m00003", summary: SUMMARY }] };
		await live.prompt("Fold the archive, please.", [
			fauxAssistantMessage(fauxToolCall("context_fold", call, { id: "fold-wiring" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Folded."),
		]);
		await live.prompt("What next?", [fauxAssistantMessage("Next.")]);
		return JSON.stringify(live.requests.at(-1)!.map((message) => message.content));
	} finally { live.dispose(); }
}

test("#294: a fold turn through the extension uses the registered one-line hint, and differs without it", async () => {
	const hinted = await foldTurn(oneLineHint);
	const plain = await foldTurn(undefined);
	assert.ok(hinted.includes(SUMMARY.slice(0, 40)), "the fold was written");
	assert.ok(hinted.includes("Extension messages in this fold") && hinted.includes(LINE), "the hinted fold records the hint's line");
	assert.equal(hinted.includes("DEMO-BODY-SECRET"), false);
	assert.ok(plain.includes(SUMMARY.slice(0, 40)), "the unhinted fold was written");
	assert.equal(plain.includes(LINE), false, "without the hint the fold records no line");
});

// A live fold turn does not show the condensed swap today: the boundary plans again over only the entries the
// fold hides, and the swapped entry is no longer among them. This gap is not covered by a live-fold test and is
// tracked as a follow-up issue (finding CR-CONDENSED-LIVE-FOLD-GAP).
// The fold plan itself, with the same registry the service writes to, does carry the swap.
test("#294: the condensed policy swaps the message for its condensed text in a fold plan", () => {
	const manager = SessionManager.inMemory("/tmp");
	const hints = createFoldHints();
	assert.ok(hints.register({ ownerKey: OWNER, match: { customType: "demo-status" }, policy: "condensed", condensed: CONDENSED }).ok);
	manager.appendMessage({ role: "user", content: "OPENING " + "archived detail ".repeat(40), timestamp: 1 });
	manager.appendCustomMessageEntry("demo-status", BODY, true, { state: "green" });
	manager.appendMessage(fauxAssistantMessage("FIRST-ANSWER " + "archived detail ".repeat(40)));
	for (const name of ["NEXT", "MORE"]) {
		manager.appendMessage({ role: "user", content: name + " request", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage(name + " answer"));
	}
	const config = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00003", summary: SUMMARY, modelContextLimit: 64_000, config: config as never, hints });
	assert.ok(plan.ok, JSON.stringify(plan));
	const swaps = plan.drafts.filter((draft) => draft.type === "context_edit" && JSON.stringify((draft as { replacement: unknown }).replacement) === JSON.stringify({ content: CONDENSED }));
	assert.equal(swaps.length, 1, "the demo-status message is replaced by its condensed text");
});
