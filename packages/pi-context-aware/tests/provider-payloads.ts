import assert from "node:assert/strict";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

/**
 * Real provider request bodies for the media tests (issue #163).
 *
 * Each body comes from pi-ai's own encoder through its `onPayload` hook, which
 * runs before any network I/O, so the tests strip what Pi actually sends.
 */

export const WIRE_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const OPENING_REQUEST = "Walk through the checkout flow and take a screenshot of every step.";
export const CLOSING_REPLY = "All steps are captured. The layout shifts at step 97.";
export const FOLLOW_UP_REQUEST = "Which step should we fix first?";

/** Eight base64-alphabet characters unique to one screenshot. */
export function screenshotMarker(index: number): string {
	return `SHOT${String(index).padStart(4, "0")}`;
}

/** Image data made only of one screenshot's marker, so a test can tell which images survived. */
export function screenshotData(index: number, chars: number): string {
	const unit = screenshotMarker(index);
	const length = chars - (chars % 4);
	return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

export function screenshotText(index: number): string {
	return `Screenshot ${index}: checkout step ${index} rendered without errors`;
}

export function assistantToolCall(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${index}`, name: "browser_screenshot", arguments: { step: index } }],
		api: "anthropic-messages",
		provider: "capture",
		model: "capture-model",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: index * 2,
	};
}

export function screenshotResult(index: number, imageChars: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${index}`,
		toolName: "browser_screenshot",
		content: [
			{ type: "text", text: screenshotText(index) },
			{ type: "image", mimeType: "image/png", data: screenshotData(index, imageChars) },
		],
		isError: false,
		timestamp: index * 2 + 1,
	} as ToolResultMessage;
}

export function closingReply(count: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: CLOSING_REPLY }],
		api: "anthropic-messages",
		provider: "capture",
		model: "capture-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: count * 2 + 2,
	};
}

/** A user request, `count` screenshot tool calls with their results, a reply, and a follow-up. */
export function screenshotTranscript(count: number, imageChars: number): Message[] {
	const messages: Message[] = [{ role: "user", content: OPENING_REQUEST, timestamp: 1 }];
	for (let index = 1; index <= count; index++) {
		messages.push(assistantToolCall(index), screenshotResult(index, imageChars));
	}
	messages.push(closingReply(count), { role: "user", content: FOLLOW_UP_REQUEST, timestamp: count * 2 + 3 });
	return messages;
}

function captureModel(api: WireApi): Model<WireApi> {
	return {
		id: "capture-model",
		name: "Capture model",
		api,
		provider: "capture",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 1_024,
	} as Model<WireApi>;
}

/** The request body pi-ai would send for `messages` on `api`, captured before network I/O. */
export async function captureProviderPayload(api: WireApi, messages: Message[]): Promise<Record<string, unknown>> {
	let captured: unknown;
	const captureComplete = new Error("provider payload captured");
	const context = normalizeContext({ systemPrompt: "You are a careful QA agent.", messages, tools: [] });
	const options = {
		apiKey: "test-only",
		onPayload(payload: unknown) {
			captured = structuredClone(payload);
			throw captureComplete;
		},
	};
	const model = captureModel(api);
	const events = api === "anthropic-messages"
		? streamAnthropic(model as Model<"anthropic-messages">, context, options)
		: api === "openai-completions"
			? streamCompletions(model as Model<"openai-completions">, context, options)
			: streamResponses(model as Model<"openai-responses">, context, options);
	for await (const event of events) {
		if (event.type === "error" && event.error.errorMessage !== captureComplete.message) {
			throw new Error(event.error.errorMessage ?? `${api} payload capture failed`);
		}
	}
	assert.ok(captured && typeof captured === "object", `${api} onPayload must expose the request body`);
	return captured as Record<string, unknown>;
}
