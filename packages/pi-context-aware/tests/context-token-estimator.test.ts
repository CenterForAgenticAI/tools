import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateContextTokens as piEstimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { estimateContextTokens as localEstimateContextTokens } from "../src/compaction/context-token-estimator.js";

const normalizedContext = (systemPrompt: string | undefined, text: string) =>
	normalizeContext({
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
	});

const assistantWithUsage = (timestamp: number): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "A response already counted by provider usage." }],
	api: "anthropic-messages",
	provider: "fixture",
	model: "fixture-model",
	usage: {
		input: 120,
		output: 30,
		cacheRead: 8,
		cacheWrite: 4,
		totalTokens: 162,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp,
});

const cases: ReadonlyArray<readonly [string, Parameters<typeof localEstimateContextTokens>[0]]> = [
	["plain text", normalizedContext(undefined, "A short user message with punctuation: 1, 2, 3.")],
	[
		"system prompt",
		normalizedContext("Follow the system instruction exactly.", "Summarize this message."),
	],
	[
		"history compaction request",
		normalizedContext(
			"You are a context summarization assistant.",
			"<conversation>\n[User]: preserve this work\n</conversation>\n\nCreate a structured context checkpoint summary.",
		),
	],
	[
		"split-turn compaction request",
		normalizedContext(
			"You are a context summarization assistant.",
			"# Conversation\n[Assistant/analysis]: unfinished reasoning\n\n# Instructions\nSummarize the conversation prefix.",
		),
	],
	[
		"image content",
		[
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this image." },
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
				],
				timestamp: 1,
			},
		] satisfies Message[],
	],
	[
		"tool result content",
		[
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "The requested file contents." }],
				isError: false,
				timestamp: 2,
			},
		] satisfies Message[],
	],
	["assistant provider usage", [assistantWithUsage(3)]],
	[
		"messages trailing assistant provider usage",
		[
			assistantWithUsage(4),
			{ role: "user", content: "Follow-up after the measured prefix.", timestamp: 5 },
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "Trailing command output." }],
				isError: false,
				timestamp: 6,
			},
		] satisfies Message[],
	],
];

test("local context estimator matches pi-ai 1.4 for representative compaction contexts", async (t) => {
	for (const [name, context] of cases) {
		await t.test(name, () => {
			assert.deepEqual(localEstimateContextTokens(context), piEstimateContextTokens(context));
		});
	}
});
