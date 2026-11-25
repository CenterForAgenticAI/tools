/**
 * The frozen view a strategy reads for one request (pi-context-aware#467). Runtime code: it reads the
 * session, so it lives outside src/strategy, which may import only the contract and other strategy code.
 *
 * `buildContextView` takes what the fold pass already holds for the request (the branch, the entries
 * Pi still sends, Pi's projection, the model, the fold pass's token count, the reachable tools and the
 * fold hints) and copies the fields a strategy may read into a new, deep-frozen object. It copies named
 * fields only: no input object, function or session reference reaches the view. It reads; it writes
 * nothing.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ProjectedEntryView } from "../media/media-fold.js";
import { foldStateFromBranch, hintsOnBranch, keptFirstUserId, protectedZone } from "../folds/fold-adapter.js";
import type { FoldHintView, ResolvedFoldHint } from "../folds/fold-hints.js";
import { imageTokens } from "../folds/fold-turn.js";
import { activeHides } from "../folds/hide-entries.js";
import { defaultConfig, defaultCountTokens, type Config } from "../folds/kernel/index.js";
import type { FoldsConfig } from "../platform/config-layers.js";
import type { ContextView, ViewCompactionOwner, ViewEntry, ViewFold, ViewHide, ViewHint, ViewRole } from "../strategy/contract.js";

export interface ContextViewInput {
	/** The session branch, root to leaf. */
	readonly branch: readonly SessionEntry[];
	/** The entries Pi still sends to the model (after compaction), as the fold pass reads them. */
	readonly contextEntries: readonly SessionEntry[];
	/** Pi's projection of the branch: the model-visible messages of each entry, after context edits. */
	readonly projection: { readonly entries: readonly ProjectedEntryView[] };
	readonly model: { readonly id: string; readonly contextWindow: number };
	/** The fold pass's token count for this request: `FoldTurnResult.tokens.before`. */
	readonly tokens: number;
	/** Tool names the session can call now (`extensionToolReachability` in src/index.ts). */
	readonly reachableTools: readonly string[];
	/** Every tool name the session has registered, reachable or not (`pi.getAllTools()`). A reachable tool missing here is added. */
	readonly registeredTools: readonly string[];
	readonly hints?: FoldHintView;
	/** Engine settings that differ from its defaults, as the fold pass and `planFold` take them. */
	readonly config?: Partial<Config>;
	/** The fold policy in force; it decides whether the opening user message is kept. */
	readonly folds?: FoldsConfig;
	/** Which messages the protected zone counts as the user's; `planFold`'s rule (pi-context-aware#319). Defaults to `typed`. */
	readonly protectedZone?: "typed" | "all-user-role";
	/** The request time in epoch milliseconds; the prompt-cache age is measured from it. */
	readonly now: number;
	/**
	 * Who holds the compaction-owner claim, from the session's `CompactionOwnerClaim`
	 * (src/compaction/owner-claim.ts): `self` while this package's claim is held, `other` while another
	 * owner holds it, `none` while nobody does. Required, with no default: a caller that left the claim out
	 * would switch the one-writer rule for compaction off, so every caller states it.
	 */
	readonly compactionOwner: ViewCompactionOwner;
}

const OWNERS: ReadonlySet<string> = new Set<ViewCompactionOwner>(["self", "other", "none"]);

/**
 * The request's one pressure value: the fold pass's token count over the context window, the figure
 * the metrics record stores as `pressure` (src/metrics/recorder.ts).
 *
 * TODO(pi-context-aware#461): replace this with the one per-request pressure value every consumer reads.
 */
export function requestPressure(tokens: number, contextWindow: number): number {
	if (!Number.isFinite(tokens) || tokens < 0) throw new RangeError(`token count must be a finite number of at least 0, got ${String(tokens)}`);
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new RangeError(`context window must be a finite number above 0, got ${String(contextWindow)}`);
	return tokens / contextWindow;
}

/** Build the frozen view of one request. Throws a RangeError when the token count or the context window is not a usable number, or the compaction owner is not one the contract names. */
export function buildContextView(input: ContextViewInput): ContextView {
	const pressure = requestPressure(input.tokens, input.model.contextWindow);
	// No default: a caller that left the claim out (an untyped caller passes undefined) is refused here, not read as none.
	const compactionOwner: unknown = input.compactionOwner;
	if (typeof compactionOwner !== "string" || !OWNERS.has(compactionOwner)) throw new RangeError(`compaction owner must be self, other or none, got ${String(compactionOwner).replace(/[^\x20-\x7e]/gu, "?").slice(0, 40)}`);
	// The hints planFold acts on: an oversized verbatim pair has already dropped every hint of the pair.
	const hints = hintsOnBranch(input.branch, input.hints);
	const images = imageTokens(input.projection.entries);
	const entries = input.projection.entries.flatMap((projected): ViewEntry[] =>
		projected.messages.length === 0 ? [] : [viewEntry(projected, hintOf(hints.get(projected.sourceEntry.id)), images.get(projected.sourceEntry.id) ?? 0)]);
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const folds = state.active.map((record): ViewFold => ({
		blockId: record.blockId,
		tier: record.tier,
		topic: record.topic ?? null,
		carrierId: record.carrierId,
		hiddenIds: [...record.hiddenIds],
		startId: record.range.startId,
		endId: record.range.endId,
		compressedTokens: record.compressedTokens,
	}));
	const hides = activeHides(input.branch).map(({ record }): ViewHide => ({ hideId: record.hideId, targetId: record.targetId, originalTokens: record.originalTokens }));
	const zone = protectedZone(state, defaultConfig(input.model.contextWindow, input.config ?? {}), input.branch, input.protectedZone ?? "typed");
	const verbatim = [...hints].flatMap(([id, hint]) => (hint.policy === "verbatim" ? [id] : []));
	const kept = new Set([...zone.entryIds, ...verbatim]);
	const first = keptFirstUserId(input.branch, input.folds);
	if (first) kept.add(first);
	return deepFreeze({
		entries,
		pressure,
		unownedTokens: input.tokens - entries.reduce((sum, entry) => sum + entry.tokens, 0),
		cacheAgeMs: cacheAgeMs(input.branch, input.now),
		model: { id: String(input.model.id), contextWindow: input.model.contextWindow },
		tools: toolNames(input.reachableTools),
		registeredTools: toolNames([...input.registeredTools, ...input.reachableTools]),
		folds,
		hides,
		protectedEntryIds: entries.filter((entry) => kept.has(entry.id)).map((entry) => entry.id),
		compactionOwner: compactionOwner as ViewCompactionOwner,
	});
}

/** Tool names once each, sorted, without empty or non-string names. */
function toolNames(names: readonly unknown[]): string[] {
	return [...new Set(names.filter((name): name is string => typeof name === "string" && name.length > 0))].sort();
}

function hintOf(hint: ResolvedFoldHint | undefined): ViewHint | null {
	const policy = hint?.policy;
	return policy === "verbatim" || policy === "one-line" || policy === "condensed" || policy === "drop-after-read" ? policy : null;
}

const ROLES: ReadonlySet<string> = new Set<ViewRole>(["user", "assistant", "toolResult", "custom", "bashExecution", "compactionSummary", "branchSummary"]);

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined => (typeof value === "object" && value !== null ? value as Fields : undefined);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** One entry; `images` is the fold pass's estimate for the entry's image parts. */
function viewEntry(projected: ProjectedEntryView, hint: ViewHint | null, images: number): ViewEntry {
	const first = fieldsOf(projected.messages[0]);
	const role = stringOf(first?.role);
	const tokens = projected.messages.reduce((sum, message) => sum + defaultCountTokens(visibleText(fieldsOf(message))), images);
	const entry: { -readonly [K in keyof ViewEntry]: ViewEntry[K] } = {
		id: projected.sourceEntry.id,
		role: role !== undefined && ROLES.has(role) ? role as ViewRole : "other",
		tokens,
		hint,
	};
	if (role === "toolResult") {
		const toolName = stringOf(first?.toolName);
		const toolCallId = stringOf(first?.toolCallId);
		if (toolName !== undefined) entry.toolName = toolName;
		if (toolCallId !== undefined) entry.toolCallId = toolCallId;
	} else if (role === "assistant") {
		entry.toolCallIds = projected.messages.flatMap((message) => partsOf(fieldsOf(message)?.content))
			.flatMap((part) => (part.type === "toolCall" && typeof part.id === "string" ? [part.id] : []));
	}
	return entry;
}

function partsOf(content: unknown): Fields[] {
	return Array.isArray(content) ? content.flatMap((part: unknown): Fields[] => { const fields = fieldsOf(part); return fields ? [fields] : []; }) : [];
}

/** The text the model reads for one message: text and thinking parts, tool calls with their arguments, and the summary or command fields Pi renders. */
function visibleText(message: Fields | undefined): string {
	if (!message) return "";
	const texts: string[] = [];
	const content = message.content;
	if (typeof content === "string") texts.push(content);
	for (const part of partsOf(content)) {
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "thinking" && typeof part.thinking === "string") texts.push(part.thinking);
		else if (part.type === "toolCall") texts.push(`${stringOf(part.name) ?? ""} ${JSON.stringify(part.arguments ?? {})}`);
	}
	for (const key of ["summary", "command", "output"] as const) {
		const value = stringOf(message[key]);
		if (value !== undefined) texts.push(value);
	}
	return texts.join("\n");
}

/** Milliseconds from the branch's latest assistant message to `now`; `null` when there is none or `now` is not a time. The view's `cacheAgeMs`. */
export function cacheAgeMs(branch: readonly SessionEntry[], now: number): number | null {
	if (!Number.isFinite(now)) return null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const at = entry.message.timestamp;
		return typeof at === "number" && Number.isFinite(at) ? Math.max(0, now - at) : null;
	}
	return null;
}

/** Freeze `value` and everything it holds. Only called on objects this module built. */
function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const key of Object.keys(value)) deepFreeze((value as Fields)[key]);
		Object.freeze(value);
	}
	return value;
}
