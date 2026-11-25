/**
 * The production fold tool, context_fold (pi-context-aware#189).
 *
 * The arguments are billion-context-pi's compress arguments: { topic?, content, summaryMaxChars? },
 * where content is an array of { startId, endId, summary, topic? }, or the same array as a JSON
 * string. Neither content nor the alias ranges is required by the schema, and each range may name its
 * bounds startRef/endRef or from/to: foldItems reads the call through the kernel parser and refuses what
 * it cannot read with the expected shape (pi-context-aware#287). The pointer display (fold-call-render.ts) reads content and each item's summary, so
 * the shape must stay; a test drives this tool in a live Pi session to hold it.
 *
 * Each item is sent to FoldEngine.request with requestId "<tool call id>#<item index>", the
 * index being the item's position in the content array. The tool follows the "Contract for the
 * fold tool" in fold-recovery.ts: every accepted item's recovery record goes into the result
 * details through foldRequestDetails. A refused item is reported in the text. A call with at least
 * one accepted item is never an error result, because an error result is never read back; a call
 * that accepts nothing is one (pi-context-aware#282), so the caller sees at once that nothing will
 * be folded. A replay (a durable worker running the call again) gets the engine's replay answer.
 *
 * The tool registers only while billion-context-pi is not loaded: with it loaded the engine is
 * in shadow mode and would write nothing.
 */

import type { ExtensionAPI, ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import { arr, obj, opt, str, type Static, union } from "@earendil-works/pi-schema";

import { summaryLimitOf } from "../folds/fold-adapter.js";
import type { FoldEngine, FoldRequestFailure, FoldRequestResult } from "../folds/fold-engine.js";
import { MAX_FOLD_ITEMS_PER_CALL, pickFoldRangesKey } from "../folds/fold-entries.js";
import { parseCompressArgs } from "../folds/kernel/index.js";
import { foldRequestDetails, type FoldRequestRecovery } from "../folds/fold-recovery.js";
import type { Steer } from "../strategy/guidance.js";
import { FOLD_TOOL_NAME } from "../folds/fold-turn.js";
import { finite, schemaTool } from "../schema-tool.js";
import { hasMethod } from "../strategy/methods.js";
import type { ContextToolSurfaceEntry } from "./surface.js";

const RangeSpec = obj({
	startId: opt(str({ description: "Message ref, e.g. \"m00005\" (from the acp tag), or a block id \"b3\"." })),
	endId: opt(str({ description: "Inclusive end ref. Must be at or after startId." })),
	summary: str({ description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)." }),
	topic: opt(str({ description: "Short label (3-5 words) for THIS range. Omit to use the top-level topic." })),
	startRef: opt(str({ description: "Accepted as a spelling of startId." })),
	endRef: opt(str({ description: "Accepted as a spelling of endId." })),
	from: opt(str({ description: "Accepted as a spelling of startId." })),
	to: opt(str({ description: "Accepted as a spelling of endId." })),
}, { open: true });

const RangeList = (description: string) => union([
	arr(RangeSpec),
	str({ description: "JSON-encoded array of ranges, accepted because some providers stringify array arguments." }),
], { description });

/**
 * Neither `content` nor `ranges` is required: the shape of a range is checked by foldItems, through the
 * kernel's parser, so a call that drifts from the documented shape is read or refused with a message that
 * names the shape. A required property would make the host refuse such a call before this tool saw it
 * (pi-context-aware#287; see "Wire-legality" in kernel/compress-tools.ts).
 */
export const contextFoldSchema = obj({
	topic: opt(str({ description: "Fallback topic for entries without their own." })),
	content: opt(RangeList("One or more ranges to fold, each with start/end boundaries and a summary. Give unrelated ranges their own topic. Give content (preferred) or ranges.")),
	ranges: opt(RangeList("Alias of content, accepted because some models name the array this way.")),
	summaryMaxChars: opt(finite({ description: "Override the maximum summary length (default 20000 characters)." })),
}, { open: true });
export type ContextFoldInput = Static<typeof contextFoldSchema>;

const DESCRIPTION = "Replace older conversation ranges with detailed summaries you write. Single range: context_fold({ content: [{ startId, endId, summary }] }). Batch: context_fold({ content: [{ topic, startId, endId, summary }, ...] }); each entry gets its own summary.";
const SNIPPET = "context_fold({ content: [{ startId, endId, summary }] }) or batch multiple ranges";
/** The one guideline that names context_compact, left out while the session's methods leave out compact (pi-context-aware#526). */
const COMPACT_GUIDELINE = "If context_compact is available, use it instead at a phase boundary, or when most of the context is already fold summaries and folding again frees too little.";
/**
 * That guideline as each steer words it (pi-context-aware#459). It is the only guideline a guidance variant changes,
 * and `default` is today's line.
 */
const STEERED_COMPACT_GUIDELINES: Readonly<Record<Steer, string>> = {
	"default": COMPACT_GUIDELINE,
	"compact-boundary": "If context_compact is available and a phase is finished, compact rather than fold that phase range by range. Fold within a running phase.",
	"fold-first": "Prefer folding. If context_compact is available, use it only at a phase boundary, when most of the context is already fold summaries and folding again frees too little.",
};
/**
 * How to fold: which ranges to pick and what a summary keeps (pi-context-aware#456). The fold nudge points here
 * instead of resending the rules, and these lines count toward the context-tool guidance limit of
 * pi-context-aware#195 (tests/context-tool-guidance.test.ts). The bounds are the engine's defaults: minCompressRange
 * 5,000 characters, summaries of 50 to maxSummaryLength 20,000 characters, preserveRecentMessages 5.
 */
const GUIDELINES = [
	"Each message has an acp tag with its mNNNNN ref, token size, and type. Fold ranges by their refs.",
	"Fold every range a nudge lists that is finished work: spent tool output, logs, exploration, settled discussion. Fold by need, not to reach a percentage, and keep context small by folding, not by avoiding tools. Never fold what the current task still uses, the last few messages (protected), or entries a verbatim fold hint keeps.",
	"Start and end a range so each tool call stays with its result. A range needs 5,000 characters or more; a summary 50 to 20,000 (raise summaryMaxChars rather than lose facts).",
	"Batch unrelated ranges in one call, each with its own topic and summary. To fold earlier folds again, name their fold ids (bN) as startId and endId; raw messages between them join the new fold.",
	"The summary is the only record of the range: make it self-contained, so the task can continue without the original. Record task state as history (TASK AS OF THIS FOLD: ...), not as an instruction.",
	"Keep verbatim: full paths with line numbers, signatures and the code line that is the finding, exact errors, values and versions, decisions with their reason, constraints, the user's goal and how it changed, why each step was taken, open questions, and the refs of key messages.",
	"Quote the user only with the message ref (User said (m00132): \"...\"); otherwise mark it paraphrased. For a message too long to quote, the summary must not change its scope, constraints, priorities or acceptance criteria. Keep an Open objectives: line with the ref of each request neither done nor superseded, also when folding folds again.",
	"Drop logs once the error or result is kept, repeated reads and status checks, spent search output, and back-and-forth once the outcome is known. Keep a dead end as one line (tried X, failed because Y), and one line on what each large dropped item covered.",
	"When space is short keep, in order: goal and constraints, decisions, exact artifacts, findings, lessons. Write dense bullets under short headers in plain unicode, never \\uXXXX escapes, and not in the style of earlier summaries.",
	COMPACT_GUIDELINE,
] as const;

export interface FoldItem {
	readonly startRef: string;
	readonly endRef: string;
	readonly summary: string;
	readonly topic?: string;
}

/** The shape every refusal of an unreadable call names. */
export const FOLD_SHAPE = "content: [{ startId, endId, summary }]";
const SHAPE_HINT = "Expected " + FOLD_SHAPE + ", for example context_fold({ content: [{ startId: \"m00005\", endId: \"m00009\", summary: \"...\" }] }).";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The kernel parser's field names for one entry: from/to are read as startId/endId when those are absent
 * (pi-context-aware#287). Named fields are copied; the caller's object is not passed on.
 */
function normalizedEntry(entry: unknown): unknown {
	if (!isRecord(entry)) return entry;
	const { startId, startRef, messageId, endId, endRef, from, to, summary, topic } = entry;
	const named = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
	const hasStart = named(startRef) ?? named(startId) ?? named(messageId);
	const hasEnd = named(endRef) ?? named(endId) ?? named(messageId);
	return { startRef, startId: hasStart ? startId : from, messageId, endRef, endId: hasEnd ? endId : to, summary, topic };
}

/**
 * Spell the from/to keys of a string the kernel parser must repair as startId/endId, which it reads. The text is
 * scanned as JSON-like tokens, so only a quoted key of an object is renamed: a quoted from/to inside a summary is
 * left alone. In an object that already names a start (startRef, startId, messageId) or an end (endRef, endId,
 * messageId), from or to is left as it is and the named bound wins, as in strict JSON. The kernel parser stays the
 * only repair of the text.
 */
function withBoundKeys(text: string): string {
	interface Key { readonly start: number; readonly end: number; readonly name: string; readonly object: number }
	const keys: Key[] = [];
	const stack: number[] = [];
	let objects = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "{") {
			stack.push(objects++);
		} else if (ch === "}") {
			stack.pop();
		} else if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
			const end = Math.min(j, text.length - 1);
			if (j < text.length && stack.length > 0 && /^\s*:/u.test(text.slice(j + 1, j + 64))) {
				keys.push({ start: i, end, name: text.slice(i + 1, j), object: stack[stack.length - 1]! });
			}
			i = end;
		}
	}
	const names = (object: number): Set<string> => new Set(keys.filter((key) => key.object === object).map((key) => key.name));
	let out = "";
	let at = 0;
	for (const key of keys) {
		if (key.name !== "from" && key.name !== "to") continue;
		const own = names(key.object);
		const taken = key.name === "from" ? ["startRef", "startId", "messageId"] : ["endRef", "endId", "messageId"];
		if (taken.some((name) => own.has(name))) continue;
		out += text.slice(at, key.start + 1) + (key.name === "from" ? "startId" : "endId");
		at = key.end;
	}
	return out + text.slice(at);
}

/** The entries of a content or ranges value, or the string to repair when it is not a JSON value the entries can be read from. */
function entriesOf(raw: unknown): unknown[] | string | undefined {
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return withBoundKeys(raw);
		}
		// A double-stringified array parses to the inner string.
		if (typeof value === "string") {
			const inner: string = value;
			try {
				value = JSON.parse(inner);
			} catch {
				return withBoundKeys(inner);
			}
		}
	}
	if (Array.isArray(value)) return value;
	if (isRecord(value)) return Array.isArray(value.ranges) ? value.ranges : Array.isArray(value.content) ? value.content : [value];
	return undefined;
}

/**
 * The items of a call, by position in its content (or ranges) array. An item that is not a range is null.
 * The ranges are read by the kernel's parseCompressArgs, so the drift it recovers applies here: startRef,
 * startId and messageId bounds, a nested ranges array, a JSON string, a truncated string and the line form.
 * A string that is not a JSON value is read as a whole, and its items are numbered in the order recovered.
 */
export function foldItems(params: { readonly topic?: unknown; readonly content?: unknown; readonly ranges?: unknown }): (FoldItem | null)[] | string {
	const read = readFold(params);
	return typeof read === "string" ? read : read.items;
}

interface FoldRead {
	readonly items: (FoldItem | null)[];
	/** The parser's reason for each null item, by position; "" for a readable item. */
	readonly reasons: readonly string[];
}

/** The kernel's reason for one dropped entry, without its "entry N: " prefix. */
const reasonOf = (reasons: readonly string[] | undefined): string => (reasons?.[0] ?? "not a range").replace(/^entry \d+: /u, "");

function readFold(params: { readonly topic?: unknown; readonly content?: unknown; readonly ranges?: unknown }): FoldRead | string {
	const raw = params[pickFoldRangesKey(params)];
	if (raw === undefined || raw === null) return "No ranges given. " + SHAPE_HINT;
	const entries = entriesOf(raw);
	const fallback = typeof params.topic === "string" && params.topic.trim() ? params.topic : undefined;
	const toItem = (range: { readonly startRef: string; readonly endRef: string; readonly summary: string; readonly topic?: string }): FoldItem => {
		const own = range.topic?.trim() ? range.topic : fallback;
		return { startRef: range.startRef, endRef: range.endRef, summary: range.summary, ...(own ? { topic: own } : {}) };
	};
	let items: (FoldItem | null)[];
	let reasons: string[] = [];
	if (typeof entries === "string") {
		const parsed = parseCompressArgs({ content: entries });
		items = parsed.ranges.map(toItem);
		if (items.length === 0) reasons = ["the text holds no range (" + parsed.diagnostics.kind + ")"];
	} else if (entries === undefined) {
		return "The ranges are not an array. " + SHAPE_HINT;
	} else {
		if (entries.length === 0) return "No ranges provided.";
		if (entries.length > MAX_FOLD_ITEMS_PER_CALL) return "A call may fold at most " + MAX_FOLD_ITEMS_PER_CALL + " ranges.";
		reasons = [];
		items = entries.map((entry): FoldItem | null => {
			const parsed = parseCompressArgs({ content: [normalizedEntry(entry)] });
			const range = parsed.ranges[0];
			reasons.push(range ? "" : reasonOf(parsed.diagnostics.invalidReasons));
			return range ? toItem(range) : null;
		});
	}
	if (items.length > MAX_FOLD_ITEMS_PER_CALL) return "A call may fold at most " + MAX_FOLD_ITEMS_PER_CALL + " ranges.";
	if (items.every((item) => item === null)) {
		const named = reasons.map((reason, index) => (reason ? "item " + (index + 1) + ": " + reason : "")).filter(Boolean);
		const why = named.length > 0 ? " " + named.join("; ") + "." : reasons.length === 1 ? " " + reasons[0] + "." : "";
		return "No readable range in the call." + why + " " + SHAPE_HINT;
	}
	return { items, reasons };
}

export interface ContextFoldDetails {
	readonly results: readonly FoldRequestResult[];
}

/** Ranges a refusal lists by name; the rest are counted. */
const MAX_OFFERED_RANGES = 8;

/**
 * What a refused range can fold instead (pi-context-aware#457). The ranges the engine would accept now,
 * as the fold nudge offers them: a list of single refs was read as a menu, and models folded one or
 * two refs at a time, below the size minimum. The ref list remains only when no offer was computed.
 */
export function refusalTail(result: Pick<FoldRequestFailure, "validRefs" | "offeredRanges">, compact = true): string {
	const offered = result.offeredRanges;
	if (offered === undefined) {
		return result.validRefs.length > 0 ? " Valid refs: " + result.validRefs.slice(0, 40).join(", ") + (result.validRefs.length > 40 ? ", ..." : "") + "." : "";
	}
	if (offered.length === 0) return compact ? " No other range can be folded now; if context is still too large, call context_compact at a clean boundary." : " No other range can be folded now.";
	const listed = offered.slice(0, MAX_OFFERED_RANGES).map((range) => range.startRef + ".." + range.endRef + " (~" + range.tokens + " tokens)");
	const more = offered.length > MAX_OFFERED_RANGES ? ", and " + (offered.length - MAX_OFFERED_RANGES) + " more" : "";
	return " Ranges you can fold now, each whole: " + listed.join(", ") + more + ".";
}

/**
 * Run one call: one engine request per item, ids by position. A refusal names context_compact only while the
 * session's methods include compact (pi-context-aware#526); an engine that cannot say keeps today's advice.
 */
export function runFold(engine: Pick<FoldEngine, "request"> & Partial<Pick<FoldEngine, "engine">>, ctx: ExtensionContext, toolCallId: string, params: ContextFoldInput) {
	const read = readFold(params);
	if (typeof read === "string") return { content: [{ type: "text" as const, text: read }], details: undefined, isError: true };
	const { items, reasons } = read;
	const summaryMaxChars = summaryLimitOf(params.summaryMaxChars);
	const compactOffered = () => engine.engine === undefined || hasMethod(engine.engine(ctx).strategy.methods, "compact");
	const lines: string[] = [];
	const recoveries: FoldRequestRecovery[] = [];
	let accepted = 0;
	items.forEach((item, index) => {
		const label = "range " + (index + 1);
		if (!item) {
			lines.push(label + ": " + (reasons[index] || "not a { startId, endId, summary } range") + "; skipped.");
			return;
		}
		const result = engine.request(ctx, { ...item, ...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}), requestId: toolCallId + "#" + index });
		const span = item.startRef + ".." + item.endRef;
		if (!result.ok) {
			lines.push(label + " (" + span + ") refused: " + result.errors.join(" ") + refusalTail(result, compactOffered()));
			return;
		}
		accepted++;
		if (result.recovery) recoveries.push(result.recovery);
		// A queued fold gets its block id when it is written; only a written fold has a final id.
		const state = result.replayed
			? (result.queued ? "already accepted; still queued" : "already folded as " + result.blockIds.join(", "))
			: result.queued ? "accepted; written at the end of this turn" : "planned";
		const warnings = result.warnings.length > 0 ? " Warnings: " + result.warnings.join(" ") : "";
		lines.push(label + " (" + span + ") " + state + "." + warnings);
	});
	// Only a call that accepted nothing is an error result: its details hold no recovery record to lose.
	return { content: [{ type: "text" as const, text: lines.join("\n") }], details: foldRequestDetails(recoveries), isError: accepted === 0 };
}

export interface ContextFoldSurface {
	/**
	 * Register the fold names this session's surface decision lists; withdraw the rest as hidden. `compact` is false
	 * when the session's methods leave out compact: the guidelines then name no context_compact.
	 */
	apply(entries: readonly ContextToolSurfaceEntry[], compact?: boolean): void;
	/**
	 * Word the guideline that names context_compact by `steer` (pi-context-aware#459). Registered tools are registered
	 * again only when the steer changes, so the tool guidance stays the same between requests of one session until
	 * its guidance, methods or model change.
	 */
	steer(steer: Steer): void;
}

/** The context_fold guidelines for a session: the compact line worded by `steer`, or left out without compact. */
function guidelinesFor(compact: boolean, steer: Steer): string[] {
	return compact ? GUIDELINES.map((line) => (line === COMPACT_GUIDELINE ? STEERED_COMPACT_GUIDELINES[steer] : line)) : GUIDELINES.filter((line) => line !== COMPACT_GUIDELINE);
}

export function createContextFoldSurface(pi: ExtensionAPI, engine: Pick<FoldEngine, "request"> & Partial<Pick<FoldEngine, "engine">>): ContextFoldSurface {
	let guidedCompact = true;
	let steered: Steer = "default";
	const register = (name: typeof FOLD_TOOL_NAME, exposure: ToolExposure) => pi.registerTool(schemaTool({
		name,
		label: "Context Fold",
		description: DESCRIPTION,
		promptSnippet: SNIPPET,
		promptGuidelines: guidelinesFor(guidedCompact, steered),
		parameters: contextFoldSchema,
		exposure,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => runFold(engine, ctx, toolCallId, params),
	}));
	const registered = new Map<typeof FOLD_TOOL_NAME, ToolExposure>();
	return {
		apply(entries, compact = true) {
			const wanted = new Map<typeof FOLD_TOOL_NAME, ToolExposure>();
			for (const entry of entries) {
				if (entry.name === FOLD_TOOL_NAME) wanted.set(entry.name, entry.exposure);
			}
			const guidanceChanged = guidedCompact !== compact;
			guidedCompact = compact;
			for (const [name, exposure] of wanted) {
				if (registered.get(name) === exposure && !guidanceChanged) continue;
				register(name, exposure);
				registered.set(name, exposure);
			}
			for (const [name, exposure] of registered) {
				if (wanted.has(name) || exposure === "hidden") continue;
				register(name, "hidden");
				registered.set(name, "hidden");
			}
		},
		steer(steer) {
			if (steer === steered) return;
			steered = steer;
			for (const [name, exposure] of registered) register(name, exposure);
		},
	};
}
