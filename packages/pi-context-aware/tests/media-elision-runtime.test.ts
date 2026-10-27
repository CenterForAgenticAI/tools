import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	estimateTokens,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";

import { registerFoldEngine } from "../src/folds/fold-engine.js";
import {
	CLOSING_REPLY,
	FOLLOW_UP_REQUEST,
	OPENING_REQUEST,
	assistantToolCall,
	closingReply,
	screenshotData,
	screenshotMarker,
	screenshotResult,
	screenshotText,
} from "./provider-payloads.js";

// issue #163, remaining native path: the live fold engine counts vision input
// but does not yet elide old screenshots before the provider request.

const CONTEXT_WINDOW = 200_000;
const KEEP_RECENT = 5;
const IMAGE_CHARS = 4_000;
const NATIVE_IMAGE_TOKENS = 1_600;
const PI_ESTIMATED_IMAGE_TOKENS = 1_200;
const OVERFLOW_SCREENSHOTS = 120;

type LogicalApi = "unified" | "hypha-anthropic-oauth";

interface RuntimeRequest {
	readonly messages: readonly Message[];
	readonly resultIds: readonly string[];
	readonly contextEditCount: number;
	readonly sessionFileContextEditCount: number;
	readonly seededEntriesKeepImageBytes: boolean;
	readonly sessionFileKeepsImageBytes: boolean;
}

function contentParts(message: Message): readonly unknown[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content : [];
}

function isImagePart(part: unknown): part is { type: "image"; mimeType: string; data: string } {
	return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image";
}

function imageCount(messages: readonly Message[]): number {
	return messages.reduce((count, message) => count + contentParts(message).filter(isImagePart).length, 0);
}

function textContent(message: Message): string {
	return contentParts(message).flatMap((part) =>
		typeof part === "object"
		&& part !== null
		&& (part as { type?: unknown }).type === "text"
		&& typeof (part as { text?: unknown }).text === "string"
			? [(part as { text: string }).text]
			: [],
	).join("\n");
}

function hasAcpReference(messages: readonly Message[]): boolean {
	return messages.some((message) => /<acp tokens="[^"]+"[^>]*>m\d{5}<\/acp>/u.test(textContent(message)));
}

function screenshotMessage(messages: readonly Message[], index: number): Message {
	const message = messages.find((candidate) => candidate.role === "toolResult"
		&& (candidate as { toolCallId?: unknown }).toolCallId === `call_${index}`);
	assert.ok(message, `provider request must contain screenshot result ${index}`);
	return message;
}

/** Pi estimates 1,200 tokens per image; the native fold engine deliberately budgets 1,600. */
function nativeRequestTokens(messages: readonly Message[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0)
		+ imageCount(messages) * (NATIVE_IMAGE_TOKENS - PI_ESTIMATED_IMAGE_TOKENS);
}

function seedScreenshots(sessionManager: SessionManager, count: number, imagesPerResult = 1): string[] {
	sessionManager.appendMessage({ role: "user", content: OPENING_REQUEST, timestamp: 1 });
	const resultIds: string[] = [];
	for (let index = 1; index <= count; index++) {
		sessionManager.appendMessage(assistantToolCall(index));
		const firstImage = (index - 1) * imagesPerResult + 1;
		resultIds.push(sessionManager.appendMessage({
			...screenshotResult(index, IMAGE_CHARS),
			content: [
				{ type: "text", text: screenshotText(index) },
				...Array.from({ length: imagesPerResult }, (_, offset) => ({
					type: "image" as const,
					mimeType: "image/png",
					data: screenshotData(firstImage + offset, IMAGE_CHARS),
				})),
			],
		}));
	}
	sessionManager.appendMessage(closingReply(count));
	return resultIds;
}

async function requestThroughLiveFoldEngine(api: LogicalApi, screenshots: number, imagesPerResult = 1): Promise<RuntimeRequest> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-media-elision-runtime-")));
	const providerId = `media-elision-${api}`;
	const faux = fauxProvider({
		api,
		provider: providerId,
		models: [{ id: "vision", input: ["text", "image"], contextWindow: CONTEXT_WINDOW, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const requests: Message[][] = [];
	faux.setResponses([
		(context) => {
			requests.push(structuredClone(context.messages));
			return fauxAssistantMessage("Request captured.");
		},
	]);

	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(providerId, "test-only");

	const folds: ExtensionFactory = (pi) => {
		registerFoldEngine(pi);
	};
	const sessionDir = path.join(cwd, "sessions");
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const resultIds = seedScreenshots(sessionManager, screenshots, imagesPerResult);
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: path.join(cwd, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: { extensionFactories: [folds], noExtensions: true },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() });
		session = created.session;
		await session.bindExtensions({});
		await session.prompt(FOLLOW_UP_REQUEST);
		await session.waitForIdle();
		assert.equal(faux.state.callCount, 1, "the scenario should make one provider request");
		const messages = requests.at(-1);
		assert.ok(messages, "the faux provider must expose the final request");
		const entries = sessionManager.getEntries();
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile, "the runtime scenario must use a file-backed session");
		const sessionFileText = fs.readFileSync(sessionFile, "utf8");
		return {
			messages,
			resultIds,
			contextEditCount: entries.filter((entry) => entry.type === "context_edit").length,
			sessionFileContextEditCount: sessionFileText.split("\n").filter((line) => line.includes('"type":"context_edit"')).length,
			seededEntriesKeepImageBytes: resultIds.every((id, index) => Array.from({ length: imagesPerResult }, (_, offset) => (index * imagesPerResult) + offset + 1)
				.every((imageIndex) => JSON.stringify(sessionManager.getEntry(id)).includes(screenshotMarker(imageIndex)))),
			sessionFileKeepsImageBytes: Array.from({ length: screenshots * imagesPerResult }, (_, index) => index + 1)
				.every((imageIndex) => sessionFileText.includes(screenshotMarker(imageIndex))),
		};
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function assertEveryTextSurvives(messages: readonly Message[], screenshots: number): void {
	const serialized = JSON.stringify(messages);
	for (const text of [OPENING_REQUEST, CLOSING_REPLY, FOLLOW_UP_REQUEST]) {
		assert.ok(serialized.includes(text), `provider request lost text: ${text}`);
	}
	for (let index = 1; index <= screenshots; index++) {
		assert.ok(serialized.includes(screenshotText(index)), `provider request lost tool-result text ${index}`);
	}
}

for (const api of ["unified", "hypha-anthropic-oauth"] as const) {
	test(`${api}: native live mode elides old screenshots before the provider request`, async () => {
		const { messages, resultIds, contextEditCount, sessionFileContextEditCount, seededEntriesKeepImageBytes, sessionFileKeepsImageBytes } = await requestThroughLiveFoldEngine(api, OVERFLOW_SCREENSHOTS);
		const serialized = JSON.stringify(messages);

		assert.ok(hasAcpReference(messages), "the native fold engine context pass must run in live mode");
		assert.equal(imageCount(messages), KEEP_RECENT, "native live mode must keep only the five newest screenshot images");
		for (let index = 1; index <= OVERFLOW_SCREENSHOTS; index++) {
			const kept = index > OVERFLOW_SCREENSHOTS - KEEP_RECENT;
			assert.equal(serialized.includes(screenshotMarker(index)), kept, `image ${index} kept=${kept}`);
		}
		const refTag = /<acp tokens="[^"]+"[^>]*>m\d{5}<\/acp>/u;
		for (let index = 0; index < OVERFLOW_SCREENSHOTS - KEEP_RECENT; index++) {
			const placeholder = `[image/png, ~3 KB image omitted from context; the original is in session entry ${resultIds[index]}]`;
			const text = textContent(screenshotMessage(messages, index + 1));
			assert.ok(text.includes(placeholder), `missing placeholder for session entry ${resultIds[index]}`);
			assert.match(text, refTag, `elided screenshot result ${index + 1} lost its native ref tag`);
		}
		for (let index = OVERFLOW_SCREENSHOTS - KEEP_RECENT + 1; index <= OVERFLOW_SCREENSHOTS; index++) {
			assert.match(textContent(screenshotMessage(messages, index)), refTag, `kept screenshot result ${index} must carry the control ref tag`);
		}
		assertEveryTextSurvives(messages, OVERFLOW_SCREENSHOTS);
		assert.equal(contextEditCount, 0, "the live pass must not append context_edit entries");
		assert.equal(sessionFileContextEditCount, 0, "the session file must not gain context_edit entries");
		assert.equal(seededEntriesKeepImageBytes, true, "seeded entries must retain every original image byte string");
		assert.equal(sessionFileKeepsImageBytes, true, "the session file must retain every original image byte string");
		const tokens = nativeRequestTokens(messages);
		assert.ok(tokens < CONTEXT_WINDOW, `elided provider request is ${tokens} tokens for a ${CONTEXT_WINDOW}-token window`);
	});

	test(`${api}: native live mode keeps five image parts across multi-image screenshot results`, async () => {
		const screenshots = 7;
		const imagesPerResult = 3;
		const { messages, resultIds, contextEditCount, sessionFileContextEditCount, seededEntriesKeepImageBytes, sessionFileKeepsImageBytes } = await requestThroughLiveFoldEngine(api, screenshots, imagesPerResult);
		const serialized = JSON.stringify(messages);
		const boundary = screenshotMessage(messages, 6);

		assert.ok(hasAcpReference(messages), "the native fold engine context pass must run in live mode");
		assert.equal(imageCount(messages), 5, "native live mode must keep exactly five image parts");
		for (let index = 1; index <= 21; index++) assert.equal(serialized.includes(screenshotMarker(index)), index >= 17, `image ${index} sent=${index >= 17}`);
		assert.equal((serialized.match(/image omitted from context/gu) ?? []).length, 16);
		assert.equal(contentParts(boundary).filter(isImagePart).length, 2, "the boundary result keeps only its newest two images");
		assert.match(textContent(boundary), new RegExp(`original is in session entry ${resultIds[5]}`, "u"));
		assertEveryTextSurvives(messages, screenshots);
		assert.equal(contextEditCount, 0, "the live pass must not append context_edit entries");
		assert.equal(sessionFileContextEditCount, 0, "the session file must not gain context_edit entries");
		assert.equal(seededEntriesKeepImageBytes, true, "seeded entries must retain every original image byte string");
		assert.equal(sessionFileKeepsImageBytes, true, "the session file must retain every original image byte string");
	});
}

test("native live mode leaves a small screenshot session unchanged", async () => {
	const screenshots = 10;
	const { messages } = await requestThroughLiveFoldEngine("unified", screenshots);
	const serialized = JSON.stringify(messages);

	assert.ok(hasAcpReference(messages), "the native fold engine context pass must run in live mode");
	assert.equal(imageCount(messages), screenshots);
	for (let index = 1; index <= screenshots; index++) assert.ok(serialized.includes(screenshotMarker(index)), `image ${index} must remain`);
	assert.doesNotMatch(serialized, /image omitted from context/u);
	assertEveryTextSurvives(messages, screenshots);
	const tokens = nativeRequestTokens(messages);
	assert.ok(tokens < CONTEXT_WINDOW, `small provider request is ${tokens} tokens for a ${CONTEXT_WINDOW}-token window`);
});
