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
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { removeFixtureDir } from "./fixture-cleanup.js";

// Section attribution when the provider payload carries no section tags (pi-context-aware#565).
// pi-multi-account folds the system prompt into one text without Pi's `<name>\n...\n</name>`
// wrappers, so the guard cannot read the changed section from the payload. It must take the
// name from the leading system message's `sections` map that it sees in context_with_system.
//
// The test runs a real Pi agent session. A test-only extension, registered before
// context-aware, strips the wrappers in before_provider_request; Pi chains that hook in
// extension order, so the guard sees the tagless payload.

const GUARD_ENTRY_TYPE = "context-aware.cache-guard.v1";
const PROVIDER = "cache-guard";
const MODEL_ID = "claude-sonnet-4-5";
const RULE = "Answer every question in French.";
const DATE = "Current date: 2026-11-20";
const HANDBOOK = Array.from({ length: 400 }, (_, index) => "Handbook line " + index + ": keep this paragraph exactly as it is.").join("\n");
const SECTION_TAG = /<([\w-]+)>\n([\s\S]*?)\n<\/\1>/gu;

type Json = Record<string, unknown>;

function anthropicModel(): Model<"anthropic-messages"> {
	return {
		id: MODEL_ID,
		name: "Cache guard model",
		api: "anthropic-messages",
		provider: PROVIDER,
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 4_096,
	} as Model<"anthropic-messages">;
}

/** Encode one request with pi-ai's Anthropic encoder and run Pi's before_provider_request chain on it. */
async function encodeRequest(context: TranscriptContext, options: SimpleStreamOptions | undefined): Promise<Json> {
	let captured: unknown;
	const done = new Error("cache-guard payload captured");
	const model = anthropicModel();
	const events = streamAnthropic(model, context, {
		apiKey: "test-only",
		...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		async onPayload(payload: unknown) {
			const next = (await options?.onPayload?.(payload, model)) ?? payload;
			captured = structuredClone(next);
			throw done;
		},
	});
	for await (const event of events) {
		if (event.type === "error" && event.error.errorMessage !== done.message) throw new Error(event.error.errorMessage ?? "payload capture failed");
	}
	assert.ok(captured && typeof captured === "object", "the encoder must expose the request body");
	return captured as Json;
}

/** The system prompt as one text with every `<name>\n...\n</name>` wrapper removed, as pi-multi-account sends it. */
function withoutSectionTags(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const body = payload as Json;
	const strip = (text: string) => text.replace(SECTION_TAG, "$2");
	if (typeof body.system === "string") return { ...body, system: strip(body.system) };
	if (!Array.isArray(body.system)) return payload;
	return { ...body, system: (body.system as Json[]).map((block) => typeof block.text === "string" ? { ...block, text: strip(block.text) } : block) };
}

function systemText(payload: Json): string {
	const system = payload.system;
	if (typeof system === "string") return system;
	return (Array.isArray(system) ? system as Json[] : []).map((block) => typeof block.text === "string" ? block.text : "").join("\n");
}

/** Two turns with the guard on; the second adds RULE to the prompt guidelines. */
async function runTwoTurns(): Promise<{ readonly requests: Json[]; readonly records: Json[] }> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-guard-attribution-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ cacheGuard: { enabled: true, askAboveUsd: 0.001 } }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = root;

	const faux = fauxProvider({
		provider: PROVIDER,
		models: [{ id: MODEL_ID, contextWindow: 200_000, maxTokens: 4_096, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const requests: Json[] = [];
	faux.setResponses([0, 1].map((index) => async (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => {
		requests.push(await encodeRequest(context, streamOptions));
		return fauxAssistantMessage("done " + index);
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(PROVIDER, "test-only");

	let turn = -1;
	const tagless: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => {
			turn += 1;
			const sections = event.systemPromptOptions.sections;
			sections.date = DATE;
			sections.handbook = HANDBOOK;
			if (turn === 1) event.systemPromptOptions.promptGuidelines.push(RULE);
		});
		pi.on("before_provider_request", (event) => withoutSectionTags(event.payload));
	};
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import("../src/index.js?cache-guard-attribution=" + Date.now() + "-" + Math.random());
		extension.default(pi);
	};
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: { extensionFactories: [tagless, contextAware], noExtensions: true },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: faux.getModel() });
		session = created.session;
		await session.bindExtensions({});
		await session.prompt("first");
		await session.prompt("second");
		assert.equal(faux.getPendingResponseCount(), 0, "every scripted reply must be consumed");
		const records = session.sessionManager.getEntries().flatMap((entry) => {
			const custom = entry as { type?: string; customType?: string; data?: unknown };
			return custom.type === "custom" && custom.customType === GUARD_ENTRY_TYPE && typeof custom.data === "object" && custom.data !== null ? [custom.data as Json] : [];
		});
		return { requests, records };
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await removeFixtureDir(root);
	}
}

test("S9: a rule change in a tagless system prompt is reported under its section name, not whole-prompt", async () => {
	const { requests, records } = await runTwoTurns();
	assert.equal(requests.length, 2);
	for (const request of requests) assert.doesNotMatch(systemText(request), /<rules>|<handbook>/u, "the provider payload carries no section tags");
	assert.match(systemText(requests[1]!), /Answer every question in French/u, "the rule reaches the second request");
	assert.equal(records.length, 1, "one break is logged");
	assert.equal(records[0]!.kind, "system-section");
	const sections = Array.isArray(records[0]!.sections) ? records[0]!.sections.map(String) : [];
	assert.deepEqual(sections, ["rules"], "the changed section is named from the system message's sections");
});
