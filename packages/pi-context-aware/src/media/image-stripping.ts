/**
 * Removes old images from a provider request body (issue #163).
 *
 * The protocol comes from the body's shape, never from `ctx.model.api`. Under
 * pi-multi-account the session model's api is `unified`, and the Anthropic
 * aliases report `hypha-anthropic-oauth`; an api lookup maps both to nothing,
 * so stripping silently did nothing. Pi's `before_provider_request` hook
 * receives the body pi-ai built for the physical model, so the shape of that
 * body is the reliable signal.
 *
 * Only the newest `keepRecent` image-bearing messages keep their images. Every
 * older image becomes a short text placeholder that names its type and size.
 * The session file is not touched, so the originals stay recoverable.
 */

export type ProviderPayloadProtocol = "anthropic-messages" | "openai-chat" | "openai-responses";

export type PayloadProtocolDetection =
	| { readonly ok: true; readonly protocol: ProviderPayloadProtocol | null }
	| { readonly ok: false; readonly reason: string };

export type ImageStripOutcome =
	| {
		readonly kind: "stripped";
		readonly protocol: ProviderPayloadProtocol;
		readonly payload: Record<string, unknown>;
		readonly removedImages: number;
		readonly strippedMessages: number;
	}
	/** Nothing to remove. `protocol` is null when the body carries no protocol markers and no media. */
	| { readonly kind: "unchanged"; readonly protocol: ProviderPayloadProtocol | null }
	/** The body has a shape this module cannot strip safely. The caller must report it. */
	| { readonly kind: "unsupported"; readonly reason: string };

export interface ImageStripOptions {
	/** How many of the newest image-bearing messages keep their images. */
	readonly keepRecent: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Content-part types only the Anthropic Messages API uses. */
const ANTHROPIC_PART_TYPES = new Set([
	"tool_use",
	"tool_result",
	"thinking",
	"redacted_thinking",
	"document",
	"server_tool_use",
	"web_search_tool_result",
	// Mid-conversation tool changes, sent in system turns by pi-ai.
	"tool_addition",
	"tool_removal",
]);

/** Content-part types only OpenAI Chat Completions (and compatible APIs) use. */
const OPENAI_CHAT_PART_TYPES = new Set(["image_url", "input_audio", "file", "refusal"]);

type PartKind = "anthropic" | "chat" | "neutral" | "unknown";

function partKind(part: unknown): PartKind {
	if (!isRecord(part) || typeof part.type !== "string") return "unknown";
	if (part.type === "text") return "neutral";
	if (part.type === "image") return isRecord(part.source) ? "anthropic" : "unknown";
	if (ANTHROPIC_PART_TYPES.has(part.type)) return "anthropic";
	if (OPENAI_CHAT_PART_TYPES.has(part.type)) return "chat";
	return "unknown";
}

/**
 * A described part is at most this many characters, so a request body cannot
 * flood the notice or the debug log with its own text.
 */
export const UNRECOGNIZED_PART_DESCRIPTION_LIMIT = 64;

/**
 * Replace control characters and cut the text to the limit. The cut never
 * splits a surrogate pair, so the notice holds no broken character.
 */
function boundedDescription(text: string): string {
	const printable = text.replace(/\p{Cc}/gu, "?");
	if (printable.length <= UNRECOGNIZED_PART_DESCRIPTION_LIMIT) return printable;
	let cut = UNRECOGNIZED_PART_DESCRIPTION_LIMIT - 1;
	const last = printable.charCodeAt(cut - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
	return `${printable.slice(0, cut)}…`;
}

function describePart(part: unknown): string {
	if (!isRecord(part)) return typeof part;
	if (typeof part.type === "string") return boundedDescription(`type ${part.type}`);
	return boundedDescription(`keys ${Object.keys(part).slice(0, 4).join(", ") || "(none)"}`);
}

function detectMessagesProtocol(messages: readonly unknown[]): PayloadProtocolDetection {
	let anthropic = false;
	let chat = false;
	let unrecognized: string | undefined;
	for (const message of messages) {
		if (!isRecord(message)) {
			unrecognized ??= "a message that is not an object";
			continue;
		}
		// A mid-conversation `system` turn appears in both APIs, so it is not a marker.
		if (message.role === "tool" || message.role === "developer" || message.role === "function") chat = true;
		if (Array.isArray(message.tool_calls) || typeof message.tool_call_id === "string") chat = true;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const kind = partKind(part);
			if (kind === "anthropic") anthropic = true;
			else if (kind === "chat") chat = true;
			else if (kind === "unknown") unrecognized ??= describePart(part);
		}
	}
	if (anthropic && chat) return { ok: false, reason: "the request body has both Anthropic and OpenAI chat markers" };
	if (anthropic) return { ok: true, protocol: "anthropic-messages" };
	if (chat) return { ok: true, protocol: "openai-chat" };
	if (unrecognized !== undefined) return { ok: false, reason: `the request body has an unrecognized content part (${unrecognized})` };
	return { ok: true, protocol: null };
}

/** Choose the wire protocol from the request body alone. */
export function detectPayloadProtocol(payload: unknown): PayloadProtocolDetection {
	if (!isRecord(payload)) return { ok: false, reason: "the request body is not a JSON object" };
	const hasMessages = Array.isArray(payload.messages);
	const hasInput = Array.isArray(payload.input) || typeof payload.input === "string";
	if (hasMessages && hasInput) return { ok: false, reason: "the request body has both messages and input" };
	if (hasInput) return { ok: true, protocol: "openai-responses" };
	if (hasMessages) return detectMessagesProtocol(payload.messages as unknown[]);
	if (Array.isArray(payload.contents)) return { ok: false, reason: "Google-style contents are not supported" };
	return { ok: false, reason: "the request body has no messages, input, or contents list" };
}

function isTopLevelImage(protocol: ProviderPayloadProtocol, part: unknown): part is JsonRecord {
	if (!isRecord(part)) return false;
	if (protocol === "anthropic-messages") return part.type === "image";
	if (protocol === "openai-chat") return part.type === "image_url";
	return part.type === "input_image";
}

interface ImageDescription {
	readonly mimeType?: string;
	readonly bytes?: number;
}

function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function describeDataUrl(url: unknown): ImageDescription {
	if (typeof url !== "string") return {};
	const match = /^data:([^;,]+)(;base64)?,/u.exec(url);
	if (!match) return {};
	const data = url.slice(match[0].length);
	return { mimeType: match[1], ...(match[2] ? { bytes: base64Bytes(data) } : { bytes: data.length }) };
}

function describeImage(protocol: ProviderPayloadProtocol, part: JsonRecord): ImageDescription {
	if (protocol === "anthropic-messages") {
		const source = isRecord(part.source) ? part.source : {};
		const mimeType = typeof source.media_type === "string" ? source.media_type : undefined;
		const bytes = source.type === "base64" && typeof source.data === "string" ? base64Bytes(source.data) : undefined;
		return { ...(mimeType ? { mimeType } : {}), ...(bytes === undefined ? {} : { bytes }) };
	}
	if (protocol === "openai-chat") {
		const imageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
		return describeDataUrl(imageUrl);
	}
	return describeDataUrl(part.image_url);
}

/** A size a person can read: bytes below 1 KB, then KB, then MB. */
export function formatApproxBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function placeholderText(description: ImageDescription): string {
	const details = [description.mimeType, description.bytes === undefined ? undefined : `~${formatApproxBytes(description.bytes)}`]
		.filter((value): value is string => value !== undefined);
	const label = details.length > 0 ? `image (${details.join(", ")})` : "image";
	return `[${label} omitted from this request; the session file keeps the original]`;
}

function placeholderPart(protocol: ProviderPayloadProtocol, image: JsonRecord): JsonRecord {
	const text = placeholderText(describeImage(protocol, image));
	if (protocol === "openai-responses") return { type: "input_text", text };
	// An Anthropic cache breakpoint on a removed image moves to its placeholder,
	// so the request keeps the same number of breakpoints in the same place.
	if (protocol === "anthropic-messages" && image.cache_control !== undefined) {
		return { type: "text", text, cache_control: image.cache_control };
	}
	return { type: "text", text };
}

interface PartsResult {
	readonly parts: unknown[];
	readonly removed: number;
}

function stripParts(protocol: ProviderPayloadProtocol, parts: readonly unknown[]): PartsResult | null {
	let removed = 0;
	const next = parts.map((part) => {
		if (isTopLevelImage(protocol, part)) {
			removed++;
			return placeholderPart(protocol, part);
		}
		if (protocol === "anthropic-messages" && isRecord(part) && part.type === "tool_result" && Array.isArray(part.content)) {
			const nested = stripParts(protocol, part.content);
			if (nested) {
				removed += nested.removed;
				return { ...part, content: nested.parts };
			}
		}
		return part;
	});
	return removed > 0 ? { parts: next, removed } : null;
}

/** The key of an item's content list: Responses tool outputs carry it in `output`. */
function contentKey(protocol: ProviderPayloadProtocol, item: JsonRecord): "content" | "output" {
	if (protocol === "openai-responses" && (item.type === "function_call_output" || item.type === "custom_tool_call_output")) {
		return "output";
	}
	return "content";
}

function stripItem(protocol: ProviderPayloadProtocol, item: unknown): { item: JsonRecord; removed: number } | null {
	if (!isRecord(item)) return null;
	const key = contentKey(protocol, item);
	const parts = item[key];
	if (!Array.isArray(parts)) return null;
	const result = stripParts(protocol, parts);
	return result ? { item: { ...item, [key]: result.parts }, removed: result.removed } : null;
}

/**
 * Return a copy of `payload` with every image older than the newest
 * `keepRecent` image-bearing messages replaced by a text placeholder.
 * The input is never modified; untouched messages keep their identity.
 */
export function stripHistoricalImages(payload: unknown, options: ImageStripOptions): ImageStripOutcome {
	const detection = detectPayloadProtocol(payload);
	if (!detection.ok) return { kind: "unsupported", reason: detection.reason };
	const { protocol } = detection;
	if (protocol === null) return { kind: "unchanged", protocol: null };
	const body = payload as JsonRecord;
	const listKey = protocol === "openai-responses" ? "input" : "messages";
	const items = body[listKey];
	if (!Array.isArray(items)) return { kind: "unchanged", protocol };

	const stripped = items.map((item) => stripItem(protocol, item));
	const imageBearing = stripped.flatMap((result, index) => (result ? [index] : []));
	const keepRecent = Number.isFinite(options.keepRecent) ? Math.max(0, Math.floor(options.keepRecent)) : 0;
	const toStrip = new Set(imageBearing.slice(0, Math.max(0, imageBearing.length - keepRecent)));
	if (toStrip.size === 0) return { kind: "unchanged", protocol };

	let removedImages = 0;
	const nextItems = items.map((item, index) => {
		const result = toStrip.has(index) ? stripped[index] : null;
		if (!result) return item;
		removedImages += result.removed;
		return result.item;
	});
	return {
		kind: "stripped",
		protocol,
		payload: { ...body, [listKey]: nextItems },
		removedImages,
		strippedMessages: toStrip.size,
	};
}
