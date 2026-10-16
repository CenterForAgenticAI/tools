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
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemMessage,
	InMemoryCredentialStore,
	type Message,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { applyPromptSections, PROMPT_SECTION, sectionContent } from "../src/platform/prompt-sections.js";
import { piBeforeAgentStartEvent, renderPiPrompt } from "./pi-prompt-render.js";

// End to end through a real Pi agent session: context-aware's injected text
// must arrive as named prompt sections, and a focus change must reach the
// model as an update to the focus section alone.

const OWNED = ["context-awareness", "durable-focus-guidance", "session_focus"] as const;

interface SessionRun {
	/** Every system message the transcript holds after the run, in order. */
	systemMessages: SystemMessage[];
	/** The leading system message each provider request was built from. */
	requestPrompts: SystemMessage[];
}

async function runSession(
	turns: ReadonlyArray<{ prompt: string; focus?: { action: string; objective?: string } }>,
	options: { forcePrompt?: string } = {},
): Promise<SessionRun> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-prompt-sections-")));
	const faux = fauxProvider({
		provider: "prompt-sections",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const requestPrompts: SystemMessage[] = [];
	const respond = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly Message[] }) => {
		const current = getCurrentSystemMessage(context.messages as Message[]);
		assert.ok(current, "every request must carry a system prompt");
		requestPrompts.push(current);
		return reply;
	};
	faux.setResponses(turns.flatMap((turn, index) => turn.focus
		? [
			respond(fauxAssistantMessage(fauxToolCall("session_focus", turn.focus, { id: `focus-${index}` }), { stopReason: "toolUse" })),
			respond(fauxAssistantMessage(`done ${index}`)),
		]
		: [respond(fauxAssistantMessage(`done ${index}`))]));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("prompt-sections", "test-only");
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?prompt-sections=${Date.now()}`);
		extension.default(pi);
	};
	const forcing: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", () => ({ systemPrompt: options.forcePrompt }));
	};
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: path.join(cwd, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: {
				extensionFactories: options.forcePrompt === undefined ? [contextAware] : [forcing, contextAware],
				noExtensions: true,
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: faux.getModel(),
		});
		session = created.session;
		await session.bindExtensions({});
		for (const turn of turns) await session.prompt(turn.prompt);
		assert.equal(faux.getPendingResponseCount(), 0, "every scripted response must be consumed");
		const systemMessages = session.messages.filter((message): message is SystemMessage => message.role === "system");
		return { systemMessages, requestPrompts };
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("the prompt harness getter renders current sections and forced text", () => {
	const event = piBeforeAgentStartEvent({ systemPrompt: "base" });
	assert.equal(event.systemPrompt, "base");
	event.systemPromptOptions.sections.session_focus = "current focus";
	assert.equal(event.systemPrompt, "base\n\n<session_focus>\ncurrent focus\n</session_focus>");
	event.systemPromptOptions.forceSystemPrompt = "replacement";
	assert.equal(event.systemPrompt, "replacement");
	event.systemPromptOptions.forceSystemPrompt = "";
	assert.equal(event.systemPrompt, "");
});

test("the prompt harness rejects invalid and reserved section names even when empty", () => {
	for (const name of ["Bad", "1bad", "bad name", "bad>name", "preamble"]) {
		assert.throws(() => renderPiPrompt("base", { [name]: "" }), {
			message: `Invalid system prompt section name: ${name}`,
		});
	}
	assert.equal(renderPiPrompt("base", { "valid-name_1": "body" }), "base\n\n<valid-name_1>\nbody\n</valid-name_1>");
});

test("a moved block renders byte-for-byte as it did when it was appended", () => {
	const framed = "<context-awareness>\nfirst rule\nsecond rule\n</context-awareness>";
	const content = sectionContent(PROMPT_SECTION.contextAwareness, framed);
	assert.equal(content, "first rule\nsecond rule");
	assert.equal(renderPiPrompt("base", { [PROMPT_SECTION.contextAwareness]: content ?? "" }), `base\n\n${framed}`);
	// A block without its own frame is kept whole rather than truncated.
	assert.equal(sectionContent(PROMPT_SECTION.contextCache, "<context-cache>no newline</context-cache>"), "<context-cache>no newline</context-cache>");
	assert.equal(sectionContent(PROMPT_SECTION.contextCache, null), null);
});

test("a repeated handler does not append an exact block already in the forced prompt", () => {
	const base = "Forced base\n\n<context-awareness>\nother guidance\n</context-awareness>";
	const event = piBeforeAgentStartEvent({ systemPrompt: "unused", systemPromptOptions: { forceSystemPrompt: base } });
	const values = {
		[PROMPT_SECTION.contextAwareness]: "guidance",
		[PROMPT_SECTION.focusGuidance]: null,
		[PROMPT_SECTION.contextCache]: null,
		[PROMPT_SECTION.sessionFocus]: null,
		[PROMPT_SECTION.compactionHistory]: null,
	};
	const block = "<context-awareness>\nguidance\n</context-awareness>";
	const first = applyPromptSections(event, values);
	assert.equal(first, `${base}\n\n${block}`, "a different block with the same tag must not suppress this one");
	event.systemPromptOptions.forceSystemPrompt = first;
	const second = applyPromptSections(event, values);
	assert.equal(second, first);
	assert.equal(second?.split(block).length, 2, "the exact block appears once across both handler calls");
});

test("an absent block removes its section and leaves other sections alone", () => {
	const sections: Record<string, string> = { session_focus: "stale focus", mcp_servers: "other extension" };
	const forced = applyPromptSections({ systemPrompt: "base", systemPromptOptions: { sections } }, {
		[PROMPT_SECTION.contextAwareness]: "guidance",
		[PROMPT_SECTION.focusGuidance]: null,
		[PROMPT_SECTION.contextCache]: null,
		[PROMPT_SECTION.sessionFocus]: null,
		[PROMPT_SECTION.compactionHistory]: "Current session branch compaction count: 1.",
	});
	assert.equal(forced, undefined);
	assert.deepEqual(sections, {
		mcp_servers: "other extension",
		[PROMPT_SECTION.contextAwareness]: "guidance",
		[PROMPT_SECTION.compactionHistory]: "Current session branch compaction count: 1.",
	});
});

function sectionPatches(messages: readonly SystemMessage[]): Array<Record<string, string | null>> {
	return messages.flatMap((message) => message.sections ? [message.sections] : []);
}

test("a real Pi session receives context-aware text as named sections, not a replaced prompt", async () => {
	const { systemMessages, requestPrompts } = await runSession([{ prompt: "first" }, { prompt: "second" }]);
	const leading = systemMessages[0];
	assert.ok(leading?.sections, "the leading system message must be structured");
	// A handler-returned systemPrompt becomes opaque content with no sections.
	assert.equal(leading.content, "", "before_agent_start must not replace the whole prompt");
	assert.match(leading.sections["context-awareness"] ?? "", /^<context-awareness>\nContext-aware operating rule:/u);
	assert.match(leading.sections["durable-focus-guidance"] ?? "", /^<durable-focus-guidance>\nDurable focus is optional/u);
	assert.equal(leading.sections.session_focus, undefined, "no focus means no focus section");
	assert.deepEqual(sectionPatches(systemMessages.slice(1)), [], "an unchanged turn must send no section update");
	assert.equal(requestPrompts.length, 2);
	assert.deepEqual(requestPrompts[1]?.sections, requestPrompts[0]?.sections, "stable sections stay byte-identical across turns");
});

test("a focus change updates only the focus section and leaves the others byte-identical", async () => {
	const { systemMessages, requestPrompts } = await runSession([
		{ prompt: "start", focus: { action: "start", objective: "Render prompt sections" } },
		{ prompt: "edit", focus: { action: "edit", objective: "Render prompt sections end to end" } },
		{ prompt: "finish" },
	]);
	const patches = sectionPatches(systemMessages);
	assert.equal(patches.length, 3, JSON.stringify(patches.map((patch) => Object.keys(patch))));
	assert.ok(OWNED.slice(0, 2).every((name) => typeof patches[0]?.[name] === "string"));
	// Turn 2 adds the focus started in turn 1; turn 3 carries the edit from turn 2.
	assert.deepEqual(Object.keys(patches[1] ?? {}), ["session_focus"]);
	assert.match(patches[1]?.session_focus ?? "", /<objective>Render prompt sections<\/objective>/u);
	assert.deepEqual(Object.keys(patches[2] ?? {}), ["session_focus"]);
	assert.match(patches[2]?.session_focus ?? "", /<objective>Render prompt sections end to end<\/objective>/u);

	const first = requestPrompts[0]?.sections ?? {};
	const last = requestPrompts.at(-1)?.sections ?? {};
	for (const name of Object.keys(first)) {
		assert.equal(last[name], first[name], `section ${name} must stay byte-identical across a focus change`);
	}
	assert.match(last.session_focus ?? "", /^<session_focus>\n<session-workstream /u);
});

test("a prompt replaced by an earlier extension still carries the context-aware text", async () => {
	const { requestPrompts } = await runSession([{ prompt: "forced" }], { forcePrompt: "Forced base prompt." });
	const prompt = requestPrompts[0];
	assert.ok(prompt);
	const content = typeof prompt.content === "string" ? prompt.content : prompt.content.map((block) => block.text).join("");
	assert.match(content, /^Forced base prompt\.\n\n<context-awareness>\nContext-aware operating rule:/u);
	assert.match(content, /<durable-focus-guidance>\nDurable focus is optional/u);
});
