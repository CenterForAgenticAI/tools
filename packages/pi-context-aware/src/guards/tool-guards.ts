/**
 * Native replacements for two billion-context-pi tool guardrails
 * (pi-context-aware#255): a head cap on oversized tool output, and a
 * warn-only repetition guard on the model's own direct tool calls.
 *
 * Neither guard ever blocks or aborts a call. Nested calls (issued by a Fabric
 * or Jev program) are never counted and never capped: no model reads them.
 */
import type { ToolOutputCapConfig } from "../platform/config-layers.js";
import { isNestedToolCallId } from "../skills/skill-registry.js";

/** The warning is appended from this many identical consecutive direct calls on. */
export const REPETITION_WARN_AT = 3;

export const TOOL_OUTPUT_CAP_MARKER = "[context-aware: tool output capped";

interface TextPart { type: "text"; text: string }
type ContentPart = { type: string; text?: string };

function isTextPart(part: ContentPart): part is TextPart {
	return part.type === "text" && typeof part.text === "string";
}

/** Cut `text` to at most `bytes` UTF-8 bytes without splitting a character. */
export function headBytes(text: string, bytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= bytes) return text;
	let end = bytes;
	// Back off continuation bytes (10xxxxxx) so the cut lands on a character start.
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

export interface CapOutcome<T extends ContentPart> {
	readonly content: T[];
	readonly capped: boolean;
}

/**
 * Head-truncate the text parts of one tool result to `maxBytes` in total and
 * append one notice. Non-text parts pass through. A result that already carries
 * this notice, or that Pi reports as truncated, is returned as it came.
 */
export function capToolOutput<T extends ContentPart>(
	content: readonly T[],
	maxBytes: number,
	options: { readonly alreadyTruncated?: boolean } = {},
): CapOutcome<T> {
	if (maxBytes <= 0 || options.alreadyTruncated) return { content: [...content], capped: false };
	const total = content.reduce((sum, part) => sum + (isTextPart(part) ? Buffer.byteLength(part.text, "utf8") : 0), 0);
	if (total <= maxBytes) return { content: [...content], capped: false };
	if (content.some((part) => isTextPart(part) && part.text.includes(TOOL_OUTPUT_CAP_MARKER))) {
		return { content: [...content], capped: false };
	}
	let remaining = maxBytes;
	const out: T[] = [];
	for (const part of content) {
		if (!isTextPart(part)) {
			out.push(part);
			continue;
		}
		const kept = headBytes(part.text, remaining);
		remaining -= Buffer.byteLength(kept, "utf8");
		// Some providers refuse an empty text block.
		if (kept.length > 0) out.push({ ...part, text: kept });
	}
	out.push({
		type: "text",
		text: `${TOOL_OUTPUT_CAP_MARKER} at ${maxBytes} bytes; the result had ${total}. The rest was dropped. Re-run the tool with a narrower request.]`,
	} as unknown as T);
	return { content: out, capped: true };
}

/** True when a tool result is a candidate for capping at all. */
export function shouldCapToolResult(
	config: ToolOutputCapConfig,
	event: { readonly toolName: string; readonly toolCallId: string; readonly parentToolCallId?: string },
): boolean {
	if (config.maxBytes <= 0) return false;
	if (event.parentToolCallId || isNestedToolCallId(event.toolCallId)) return false;
	return !config.skipTools.includes(event.toolName);
}

/** Stable JSON: object keys sorted, so key order never hides a repeat. */
export function canonicalInput(value: unknown): string {
	const seen = new WeakSet<object>();
	const walk = (v: unknown): unknown => {
		if (typeof v !== "object" || v === null) return v;
		if (seen.has(v)) return "[circular]";
		seen.add(v);
		if (Array.isArray(v)) return v.map(walk);
		return Object.fromEntries(Object.keys(v).sort().map((key) => [key, walk((v as Record<string, unknown>)[key])]));
	};
	try {
		return JSON.stringify(walk(value)) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

export interface RepetitionTracker {
	/** Note one tool call. Returns the run length of identical consecutive direct calls, or 0 when the call is not counted. */
	note(call: { toolCallId: string; parentToolCallId?: string; toolName: string; input: unknown }): number;
	/** User input starts a new count. */
	reset(): void;
}

export function createRepetitionTracker(): RepetitionTracker {
	let last: string | undefined;
	let run = 0;
	return {
		note(call) {
			if (call.parentToolCallId || isNestedToolCallId(call.toolCallId)) return 0;
			const fingerprint = `${call.toolName}\u0000${canonicalInput(call.input)}`;
			run = fingerprint === last ? run + 1 : 1;
			last = fingerprint;
			return run;
		},
		reset() {
			last = undefined;
			run = 0;
		},
	};
}

export function repetitionWarning(toolName: string, count: number): string {
	return `[context-aware: \`${toolName}\` has now been called ${count} times in a row with identical arguments. The result will not change; try a different approach or ask the user.]`;
}
