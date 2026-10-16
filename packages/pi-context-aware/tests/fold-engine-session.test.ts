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
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry, type FirstUserMessageMode } from "../src/platform/config-layers.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";
import { foldModeFor, registerFoldEngine, type FoldRequestResult, type DroppedFold } from "../src/folds/fold-engine.js";

// End to end through a real Pi agent session. A test-only tool asks the fold
// engine for a fold during a turn. With billion-context-pi's tool pair loaded
// the engine is in shadow mode and must leave the session file unchanged;
// without it, the fold is written at turn_end and the next provider request
// already sees the summary instead of the originals.

const billionContextStub: ExtensionFactory = (pi) => {
	for (const name of ["compress", "acp_status"]) {
		pi.registerTool({
			name,
			label: name,
			description: `Stub of billion-context-pi's ${name}.`,
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "stub" }], details: {} };
			},
		});
	}
};

interface Run {
	results: FoldRequestResult[];
	dropped: readonly DroppedFold[];
	foldEntries: number;
	contextEdits: number;
	provider: string[];
	/** Tools, commands and flags the fold engine itself registered. */
	engineRegistrations: string[];
}

async function run(withBillionContext: boolean, duplicate = false, firstUserMessage: FirstUserMessageMode = "fold"): Promise<Run> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-engine-")));
	const faux = fauxProvider({
		provider: "fold-engine",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const provider: string[] = [];
	faux.setResponses([
		(context) => {
			provider.push(JSON.stringify(context.messages));
			return fauxAssistantMessage(fauxToolCall("fold_probe", {}), { stopReason: "toolUse" });
		},
		(context) => {
			provider.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("Folded.");
		},
	]);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("fold-engine", "test-only");

	const results: FoldRequestResult[] = [];
	let droppedForSession: () => readonly DroppedFold[] = () => [];
	const engineRegistrations: string[] = [];
	const folds: ExtensionFactory = (pi) => {
		const recording = new Proxy(pi, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver) as unknown;
				if (typeof value !== "function") return value;
				if (key === "registerTool" || key === "registerCommand" || key === "registerFlag" || key === "registerShortcut") {
					return (...args: unknown[]) => {
						engineRegistrations.push(String(key));
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return (value as (...a: unknown[]) => unknown).bind(target);
			},
		});
		const engine = registerFoldEngine(recording, {
			config: { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 },
		});
		// Test-only trigger; the engine itself registers no tools.
		pi.registerTool({
			name: "fold_probe",
			label: "fold_probe",
			description: "Test-only fold trigger.",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _update, ctx) {
				results.push(
					engine.request(ctx, {
						startRef: "m00001",
						endRef: "m00004",
						summary: "FOLD-SUMMARY: alpha and beta were settled.",
						topic: "opening",
					}),
				);
				if (duplicate) results.push(engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: "DUPLICATE fold of the same opening." }));
				droppedForSession = () => engine.dropped(ctx);
				return { content: [{ type: "text", text: "requested" }], details: {} };
			},
		});
	};

	const sessionManager = SessionManager.inMemory(cwd);
	sessionManager.appendMessage({ role: "user", content: "ALPHA-QUESTION", timestamp: Date.now() });
	sessionManager.appendMessage(fauxAssistantMessage("ALPHA-ANSWER"));
	sessionManager.appendMessage({ role: "user", content: "BETA-QUESTION", timestamp: Date.now() });
	sessionManager.appendMessage(fauxAssistantMessage("BETA-ANSWER"));
	sessionManager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": firstUserMessage }));
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: path.join(cwd, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: {
				extensionFactories: withBillionContext ? [folds, billionContextStub] : [folds],
				noExtensions: true,
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() });
		session = created.session;
		await session.bindExtensions({});
		await session.prompt("Fold the opening, please.");
		await session.waitForIdle();
		const entries = sessionManager.getEntries();
		return {
			results,
			dropped: droppedForSession(),
			foldEntries: entries.filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE).length,
			contextEdits: entries.filter((entry) => entry.type === "context_edit").length,
			provider,
			engineRegistrations,
		};
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("shadow mode: with billion-context-pi loaded, a fold is planned but nothing is written", async () => {
	const shadow = await run(true);
	assert.equal(shadow.results.length, 1);
	const [result] = shadow.results;
	assert.ok(result?.ok, JSON.stringify(result));
	assert.equal(result.mode, "shadow");
	assert.equal(result.queued, false);
	assert.deepEqual(result.blockIds, ["b1"], "shadow mode still plans with the engine");
	assert.equal(shadow.foldEntries, 0, "shadow mode wrote fold metadata");
	assert.equal(shadow.contextEdits, 0, "shadow mode wrote context edits");
	assert.match(shadow.provider[1] ?? "", /ALPHA-QUESTION/u, "shadow mode changed model context");
});

test("live mode: the fold is written at turn_end and the next request sees only the summary", async () => {
	const live = await run(false);
	const [result] = live.results;
	assert.ok(result?.ok, JSON.stringify(result));
	assert.equal(result.mode, "live");
	assert.equal(result.queued, true);
	assert.equal(live.foldEntries, 1);
	assert.equal(live.contextEdits, 4, "one carrier edit and three hide edits");
	assert.match(live.provider[0] ?? "", /ALPHA-QUESTION/u);
	const next = live.provider[1] ?? "";
	assert.match(next, /FOLD-SUMMARY: alpha and beta were settled/u);
	assert.doesNotMatch(next, /ALPHA-QUESTION|ALPHA-ANSWER|BETA-QUESTION|BETA-ANSWER/u);
});

test("live mode exposes queued folds dropped at the boundary with their errors", async () => {
	const live = await run(false, true);
	assert.equal(live.results.length, 2);
	for (const result of live.results) {
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal(result.queued, true, "both requests were accepted before the boundary");
	}
	assert.equal(live.foldEntries, 1, "only the first queued fold survives");
	assert.equal(live.dropped.length, 1);
	assert.equal(live.dropped[0]?.startRef, "m00001");
	assert.equal(live.dropped[0]?.endRef, "m00004");
	assert.ok(live.dropped[0]?.errors[0], "the dropped fold must explain why it could not resolve");
});

test("session keep reaches the live planner and the provider receives the opening user", async () => {
	const live = await run(false, false, "keep");
	assert.ok(live.results[0]?.ok, JSON.stringify(live.results));
	assert.equal(live.contextEdits, 3);
	assert.match(live.provider[1] ?? "", /ALPHA-QUESTION/u);
	assert.doesNotMatch(live.provider[1] ?? "", /ALPHA-ANSWER|BETA-QUESTION|BETA-ANSWER/u);
});

test("fold mode sends a user-role summary before the first assistant to the provider", async () => {
	const live = await run(false);
	const messages = JSON.parse(live.provider[1] ?? "[]") as { role: string; content: unknown }[];
	assert.equal(messages[0]?.role, "user");
	assert.match(JSON.stringify(messages[0]?.content), /FOLD-SUMMARY/u);
	assert.ok(messages.findIndex((message) => message.role === "assistant") > 0);
	assert.doesNotMatch(JSON.stringify(messages), /ALPHA-QUESTION/u);
});

test("the fold engine registers no tools of its own", async () => {
	const live = await run(false);
	assert.deepEqual(live.engineRegistrations, []);
	const shadow = await run(true);
	assert.deepEqual(shadow.engineRegistrations, []);
});

test("fold mode is shadow only for billion-context-pi's tool pair from one extension", () => {
	const bcp = { path: "/profile/node_modules/billion-context-pi/dist/index.js" };
	assert.equal(foldModeFor([]), "live");
	assert.equal(foldModeFor([{ name: "compress", sourceInfo: bcp }, { name: "acp_status", sourceInfo: bcp }]), "shadow");
	assert.equal(
		foldModeFor([{ name: "compress", sourceInfo: bcp }, { name: "acp_status", sourceInfo: { path: "/other/index.js" } }]),
		"live",
	);
});
