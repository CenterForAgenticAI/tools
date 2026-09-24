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
	InMemoryCredentialStore,
	type Context,
} from "@earendil-works/pi-ai";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-compaction-queue-"));
}

async function waitForCondition(condition: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const QUEUED_PROMPT = "Queued while compaction was active; handle this before the handoff seed.";
const HANDOFF_SEED = "Resume the preserved next phase after queued input finishes.";
const UNSAFE_EARLY_SEED = "This prompt was submitted too early from session_compact and must not run.";

function escaped(value: string): RegExp {
	return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function lastUserText(context: Context): string {
	const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
	if (!message || message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => part.type === "text" ? part.text : "")
		.filter(Boolean)
		.join("\n");
}

test("Pi 0.84.1 rejects session_compact prompts and accepts a timer-deferred handoff after queued input", async () => {
	const cwd = tmpDir();
	const agentDir = path.join(cwd, "agent-state");
	const faux = fauxProvider({
		provider: "compaction-seed-queue",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	let releaseQueuedPrompt: (() => void) | undefined;
	const queuedPromptBlocked = new Promise<void>((resolve) => { releaseQueuedPrompt = resolve; });
	let markQueuedPromptStarted!: () => void;
	const queuedPromptStarted = new Promise<void>((resolve) => { markQueuedPromptStarted = resolve; });
	const providerRequests: string[] = [];
	let queuedRequestIndex = -1;
	let seedRequestIndex = -1;
	const respond = async (context: Context) => {
		const serialized = JSON.stringify(context);
		const currentPrompt = lastUserText(context);
		const requestIndex = providerRequests.push(serialized) - 1;
		if (currentPrompt.includes(QUEUED_PROMPT)) {
			queuedRequestIndex = requestIndex;
			markQueuedPromptStarted();
			await queuedPromptBlocked;
			return fauxAssistantMessage("The queued prompt finished first.");
		}
		if (currentPrompt.includes(HANDOFF_SEED)) {
			seedRequestIndex = requestIndex;
			return fauxAssistantMessage("The timer-deferred handoff seed ran once.");
		}
		return fauxAssistantMessage("The earlier work was compacted.");
	};
	faux.setResponses(Array.from({ length: 8 }, () => respond));

	let sessionCompactEvents = 0;
	const deferHandoffAtPublicBoundary: ExtensionFactory = (pi) => {
		pi.on("session_compact", () => {
			sessionCompactEvents++;
			// Pi 0.84.1 still owns compaction during this extension event. Its
			// public API rejects this call; the provider must never receive it.
			pi.sendUserMessage(UNSAFE_EARLY_SEED, { deliverAs: "followUp" });
			// A timer runs only after the awaited extension event returns and Pi's
			// synchronous compaction_end listeners have submitted their queue.
			setTimeout(() => pi.sendUserMessage(HANDOFF_SEED, { deliverAs: "followUp" }), 0);
		});
	};

	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("compaction-seed-queue", "test-only");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 512 },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	for (let index = 0; index < 4; index += 1) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Historical request ${index}: ${"context ".repeat(200)}` }],
			timestamp: Date.now() + index,
		});
		sessionManager.appendMessage(fauxAssistantMessage(`Historical response ${index}: ${"result ".repeat(200)}`));
	}

	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let releaseOnFailure = true;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [deferHandoffAtPublicBoundary],
				noExtensions: true,
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
			noTools: "all",
		});
		session = created.session;
		await session.bindExtensions({});

		let queuedPrompt: Promise<void> | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.aborted || !event.result || queuedPrompt) return;
			queuedPrompt = session!.prompt(QUEUED_PROMPT);
		});

		try {
			await withDeadline(session.compact("Exercise Pi's real compaction lifecycle."), "Pi's real compaction lifecycle", 10_000);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; idle=${session.isIdle}; providerCalls=${faux.state.callCount}; requests=${providerRequests.length}`,
				{ cause: error },
			);
		}
		assert.equal(sessionCompactEvents, 1);
		assert.ok(queuedPrompt, "the host must submit its queued input at compaction_end");
		await withDeadline(queuedPromptStarted, "the host's queued prompt provider turn");
		assert.ok(queuedRequestIndex >= 1, "compaction must finish before the queued host prompt starts");
		assert.equal(seedRequestIndex, -1, "the deferred seed must remain queued while host input is active");
		assert.match(providerRequests[queuedRequestIndex]!, escaped(QUEUED_PROMPT));
		assert.doesNotMatch(providerRequests[queuedRequestIndex]!, escaped(HANDOFF_SEED));
		assert.equal(providerRequests.some((request) => escaped(UNSAFE_EARLY_SEED).test(request)), false);

		releaseQueuedPrompt?.();
		releaseOnFailure = false;
		await withDeadline(queuedPrompt!, "the host's queued prompt to finish");
		await waitForCondition(() => seedRequestIndex >= 0, "the deferred handoff seed provider turn");
		await session.waitForIdle();

		assert.equal(seedRequestIndex, queuedRequestIndex + 1, "the seed must be the single provider turn after queued input");
		assert.match(providerRequests[seedRequestIndex]!, escaped(HANDOFF_SEED));
		unsubscribe();
	} finally {
		if (releaseOnFailure) releaseQueuedPrompt?.();
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
