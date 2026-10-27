import type {
	ImageContent,
	Message,
	SystemMessage,
	TextContent,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";

// Mirrors @earendil-works/pi-ai/dist/utils/estimate.js as audited for Pi
// 1.4.0. Keep the parity test pinned to the dev-only upstream module.
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4800;

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function contentText(content: SystemMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

function estimateToolsTokens(tools: SystemMessage["toolsAdded"] | SystemMessage["toolsRemoved"]): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function estimateMessageTokens(message: Message): number {
	let chars = 0;
	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else chars += block.name.length + safeJsonStringify(block.arguments).length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const usageAppliesToPrefix = message.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				message.stopReason !== "aborted" &&
				message.stopReason !== "error" &&
				calculateContextTokens(message.usage) > 0
			) {
				usageInfo = { usage: message.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	return usageInfo;
}

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
