/**
 * The production fold tool, context_fold, and its compress alias (pi-context-aware#189).
 *
 * The arguments are billion-context-pi's compress arguments: { topic?, content, summaryMaxChars? },
 * where content is an array of { startId, endId, summary, topic? }, or the same array as a JSON
 * string. The pointer display (fold-call-render.ts) reads content and each item's summary, so
 * the shape must stay; a test drives this tool in a live Pi session to hold it.
 *
 * Each item is sent to FoldEngine.request with requestId "<tool call id>#<item index>", the
 * index being the item's position in the content array. The tool follows the "Contract for the
 * fold tool" in fold-recovery.ts: every accepted item's recovery record goes into the result
 * details through foldRequestDetails, and the result is never an error result, because an error
 * result is never read back. A refused item is reported in the text. A replay (a durable worker
 * running the call again) gets the engine's replay answer.
 *
 * The tool registers only while billion-context-pi is not loaded: with it loaded the engine is
 * in shadow mode and would write nothing.
 */

import type { ExtensionAPI, ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { summaryLimitOf } from "../folds/fold-adapter.js";
import type { FoldEngine, FoldRequestResult } from "../folds/fold-engine.js";
import { MAX_FOLD_ITEMS_PER_CALL } from "../folds/fold-entries.js";
import { foldRequestDetails, type FoldRequestRecovery } from "../folds/fold-recovery.js";
import { FOLD_TOOL_NAME } from "../folds/fold-turn.js";
import type { ContextToolSurfaceEntry } from "./surface.js";

const RangeSpec = Type.Object({
	startId: Type.String({ description: "Message ref, e.g. \"m00005\" (from the acp tag), or a block id \"b3\"." }),
	endId: Type.String({ description: "Inclusive end ref. Must be at or after startId." }),
	summary: Type.String({ description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)." }),
	topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for THIS range. Omit to use the top-level topic." })),
});

export const contextFoldSchema = Type.Object({
	topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own." })),
	content: Type.Union([
		Type.Array(RangeSpec),
		Type.String({ description: "JSON-encoded array of ranges, accepted because some providers stringify array arguments." }),
	], { description: "One or more ranges to fold, each with start/end boundaries and a summary. Give unrelated ranges their own topic." }),
	summaryMaxChars: Type.Optional(Type.Number({ description: "Override the maximum summary length (default 20000 characters)." })),
});
export type ContextFoldInput = Static<typeof contextFoldSchema>;

const DESCRIPTION = "Replace older conversation ranges with detailed summaries you write. Single range: context_fold({ content: [{ startId, endId, summary }] }). Batch: context_fold({ content: [{ topic, startId, endId, summary }, ...] }); each entry gets its own summary.";
const SNIPPET = "context_fold({ content: [{ startId, endId, summary }] }) or batch multiple ranges";
const GUIDELINES = [
	"Each message has an acp tag with its mNNNNN ref, token size, and type. Fold ranges by their refs.",
	"Batch multiple unrelated ranges in one call; each gets its own topic and summary.",
	"Write dense, self-contained summaries; preserve file paths, signatures, errors, and decisions verbatim.",
	"Never fold content the current step is actively using.",
] as const;

export interface FoldItem {
	readonly startRef: string;
	readonly endRef: string;
	readonly summary: string;
	readonly topic?: string;
}

/** The items of a call, by position in its content array. An item that is not a range is null. */
export function foldItems(params: { readonly topic?: unknown; readonly content?: unknown }): (FoldItem | null)[] | string {
	let content: unknown = params.content;
	if (typeof content === "string") {
		try {
			content = JSON.parse(content);
		} catch {
			return "content is a string but not a JSON array of ranges.";
		}
	}
	if (!Array.isArray(content)) return "content must be an array of { startId, endId, summary } ranges.";
	if (content.length === 0) return "No ranges provided.";
	if (content.length > MAX_FOLD_ITEMS_PER_CALL) return "A call may fold at most " + MAX_FOLD_ITEMS_PER_CALL + " ranges.";
	const fallback = typeof params.topic === "string" && params.topic.trim() ? params.topic : undefined;
	return content.map((item: unknown): FoldItem | null => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
		const { startId, endId, summary, topic } = item as Record<string, unknown>;
		if (typeof startId !== "string" || typeof endId !== "string" || typeof summary !== "string") return null;
		const own = typeof topic === "string" && topic.trim() ? topic : fallback;
		return { startRef: startId, endRef: endId, summary, ...(own ? { topic: own } : {}) };
	});
}

export interface ContextFoldDetails {
	readonly results: readonly FoldRequestResult[];
}

/** Run one call: one engine request per item, ids by position. */
export function runFold(engine: Pick<FoldEngine, "request">, ctx: ExtensionContext, toolCallId: string, params: ContextFoldInput) {
	const items = foldItems(params);
	if (typeof items === "string") return { content: [{ type: "text" as const, text: items }], details: undefined };
	const summaryMaxChars = summaryLimitOf(params.summaryMaxChars);
	const lines: string[] = [];
	const recoveries: FoldRequestRecovery[] = [];
	items.forEach((item, index) => {
		const label = "range " + (index + 1);
		if (!item) {
			lines.push(label + ": not a { startId, endId, summary } range; skipped.");
			return;
		}
		const result = engine.request(ctx, { ...item, ...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}), requestId: toolCallId + "#" + index });
		const span = item.startRef + ".." + item.endRef;
		if (!result.ok) {
			const valid = result.validRefs.length > 0 ? " Valid refs: " + result.validRefs.slice(0, 40).join(", ") + (result.validRefs.length > 40 ? ", ..." : "") + "." : "";
			lines.push(label + " (" + span + ") refused: " + result.errors.join(" ") + valid);
			return;
		}
		if (result.recovery) recoveries.push(result.recovery);
		// A queued fold gets its block id when it is written; only a written fold has a final id.
		const state = result.replayed
			? (result.queued ? "already accepted; still queued" : "already folded as " + result.blockIds.join(", "))
			: result.queued ? "accepted; written at the end of this turn" : "planned";
		const warnings = result.warnings.length > 0 ? " Warnings: " + result.warnings.join(" ") : "";
		lines.push(label + " (" + span + ") " + state + "." + warnings);
	});
	return { content: [{ type: "text" as const, text: lines.join("\n") }], details: foldRequestDetails(recoveries) };
}

type FoldToolName = typeof FOLD_TOOL_NAME | "compress";

export interface ContextFoldSurface {
	/** Register the fold names this session's surface decision lists; withdraw the rest as hidden. */
	apply(entries: readonly ContextToolSurfaceEntry[]): void;
}

export function createContextFoldSurface(pi: ExtensionAPI, engine: Pick<FoldEngine, "request">): ContextFoldSurface {
	const register = (name: FoldToolName, exposure: ToolExposure) => pi.registerTool({
		name,
		label: name === FOLD_TOOL_NAME ? "Context Fold" : "Compress",
		description: DESCRIPTION,
		promptSnippet: SNIPPET,
		promptGuidelines: [...GUIDELINES],
		parameters: contextFoldSchema,
		exposure,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => runFold(engine, ctx, toolCallId, params),
	});
	const registered = new Map<FoldToolName, ToolExposure>();
	return {
		apply(entries) {
			const wanted = new Map<FoldToolName, ToolExposure>();
			for (const entry of entries) {
				if (entry.name === FOLD_TOOL_NAME || (entry.name === "compress" && entry.aliasOf === FOLD_TOOL_NAME)) wanted.set(entry.name, entry.exposure);
			}
			for (const [name, exposure] of wanted) {
				if (registered.get(name) === exposure) continue;
				register(name, exposure);
				registered.set(name, exposure);
			}
			for (const [name, exposure] of registered) {
				if (wanted.has(name) || exposure === "hidden") continue;
				register(name, "hidden");
				registered.set(name, "hidden");
			}
		},
	};
}
