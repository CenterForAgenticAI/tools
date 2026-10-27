/**
 * The per-turn pass of the native fold engine in live mode (pi-context-aware#201).
 *
 * billion-context-pi 0.1.83 runs the kernel's processTurn on every outgoing
 * request (its wireContextTransform) and rebuilds the Pi messages from the
 * result (coreOutToAgentMessages). This module does the same for the native
 * engine, so after cut-over the model sees what billion-context-pi sends:
 *
 * - every user, custom and tool-result message carries its <acp> ref tag at
 *   the end of its last text block, with the token count of its own text;
 * - compress and context_fold calls whose folds a higher-tier fold absorbed,
 *   and their results, are left out, and so are failed calls beyond the newest
 *   two (the kernel's hide-compress-calls stage, keyed on each fold record's
 *   compressCallId);
 * - the kernel's nudge is appended when it recommends one, with
 *   billion-context-pi's text, thresholds and once-per-turn gate, measured on
 *   the sent view (output headroom, host-usage floor, sent-view recount).
 *
 * Deliberate differences from billion-context-pi 0.1.83 (register entries
 * FP-163, FP-201 and FP-202 in src/parity/register.ts):
 *
 * - image-heavy requests keep only the newest five image parts once they exceed
 *   provider-safe image counts or reach the nudge ceiling; the original bytes
 *   remain in their session entries;
 * - tier distillation triggers default to 10 tier-1 and 20 tier-2 blocks, as in
 *   ranxianglei/billion-context-pi#629, because the kernel defaults (1000 and
 *   2000) make the tier-2 nudge unreachable (ranxianglei/billion-context-pi#628);
 * - the emergency nudge is deferred while the latest model turn failed, as
 *   ranxianglei/billion-context-pi#666 proposes, because no compress call can
 *   land until a turn completes.
 *
 * Earlier fold calls keep their arguments as fold-call-render.ts shows them
 * (block pointers, pi-context-aware#173): the kernel's rewrite of kept compress
 * calls to 200-character stubs is not copied back into the call.
 * Messages Pi sends that no session entry owns (a live-only tail), entries that
 * are not messages (compaction and branch summaries) and the summary message of
 * each active fold pass through as they are.
 */

import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import { elideImageParts, planNativeMediaElision, type MediaElisionPlan, type ProjectedEntryView } from "../media/media-fold.js";
import { foldStateFromBranch } from "./fold-adapter.js";
import { renderEarlierFoldCalls } from "./fold-call-render.js";
import { foldRecordsOnBranch, type FoldRecord } from "./fold-entries.js";
import {
	baseIdOf,
	coveredMessageIds,
	createCore,
	defaultConfig,
	defaultCountTokens,
	defaultPrompts,
	renderNudgeText,
	viableRanges,
	type CompressionBlock,
	type CompressionCore,
	type CompressionState,
	type Config,
	type CoreMessage,
	type NudgeDecision,
	type NudgeState,
} from "./kernel/index.js";
import { isSummaryMessageId, SUMMARY_HEADER } from "./kernel/prune.js";
import { countMessageTokens, renderVisibleRefs } from "./kernel/index.js";

type Message = ContextEvent["messages"][number];
type Part = { type?: unknown; text?: unknown; id?: unknown; [key: string]: unknown };

/** The production fold tool (pi-context-aware#189); its calls are fold calls like compress. */
export const FOLD_TOOL_NAME = "context_fold";
/** The tier distillation triggers of ranxianglei/billion-context-pi#629. */
export const TIER_TRIGGERS = { tier2Trigger: 10, tier3Trigger: 20 } as const;
/** billion-context-pi's default share of the window its output headroom may take. */
const OUTPUT_HEADROOM_MAX_PCT = 0.25;
/** billion-context-pi's estimate for one image block on a vision model. */
const IMAGE_TOKEN_COST = 1600;
const HOST_USAGE_WINDOW = 4;
const HOST_USAGE_MIN_SAMPLES = 3;
const HOST_USAGE_SPREAD_MAX = 0.25;

interface SentViewMeter {
	readonly viewTokens: number;
	readonly blocksLen: number;
	readonly activeBlocks: number;
	readonly limit: number;
	readonly usable: boolean;
}

/**
 * What one session's per-turn pass carries to the next turn, in memory, as
 * billion-context-pi keeps it in its runtime and side file.
 */
export interface FoldTurnMemory {
	nudge?: NudgeState;
	tokenSnapshot?: Record<string, number>;
	lastPassIds?: string[];
	/** blockId/runId of every fold seen last turn; a new fold resets the nudge stamps. */
	blockKeys?: ReadonlySet<string>;
	/** Turns (last user entry id) that already got a nudge, and the token count it was shown at. */
	readonly shownTurns: Set<string>;
	readonly shownTokens: Map<string, number>;
	readonly hostSamples: number[];
	scaleStale?: boolean;
	meter?: SentViewMeter;
}

export function createFoldTurnMemory(): FoldTurnMemory {
	return { shownTurns: new Set(), shownTokens: new Map(), hostSamples: [] };
}

/** A detached copy for parity and other read-only previews of the next live request. */
export function cloneFoldTurnMemory(memory: FoldTurnMemory): FoldTurnMemory {
	return {
		...(memory.nudge ? { nudge: structuredClone(memory.nudge) } : {}),
		...(memory.tokenSnapshot ? { tokenSnapshot: { ...memory.tokenSnapshot } } : {}),
		...(memory.lastPassIds ? { lastPassIds: [...memory.lastPassIds] } : {}),
		...(memory.blockKeys ? { blockKeys: new Set(memory.blockKeys) } : {}),
		shownTurns: new Set(memory.shownTurns),
		shownTokens: new Map(memory.shownTokens),
		hostSamples: [...memory.hostSamples],
		...(memory.scaleStale !== undefined ? { scaleStale: memory.scaleStale } : {}),
		...(memory.meter ? { meter: { ...memory.meter } } : {}),
	};
}

export interface FoldTurnModel {
	readonly contextWindow: number;
	readonly maxOutputTokens?: number;
	readonly api?: string;
	readonly vision?: boolean;
}

export interface FoldTurnInput {
	/** The request Pi is about to send, without system messages. */
	readonly messages: readonly Message[];
	/** Pi's projection of the branch: which entry each request message comes from. */
	readonly projection: { readonly entries: readonly ProjectedEntryView[] };
	readonly branch: readonly SessionEntry[];
	readonly contextEntries: readonly SessionEntry[];
	readonly model: FoldTurnModel;
	readonly systemPromptTokens: number;
	/** Pi's context usage for this request (ctx.getContextUsage().tokens). */
	readonly hostTokens?: number;
	readonly memory: FoldTurnMemory;
	/** Engine settings that differ from its defaults. */
	readonly config?: Partial<Config>;
	/** Also decide the nudge billion-context-pi 0.1.83 would send (parity evidence). */
	readonly compatibility?: boolean;
}

/** A nudge that differs from billion-context-pi's only because of a fix above. */
export interface NudgeFix {
	readonly cause: "tier-trigger" | "emergency-defer";
	/** The nudge sent; absent when none was. */
	readonly sent?: string;
	/** The nudge billion-context-pi 0.1.83 would send; absent when none. */
	readonly compatible?: string;
}

export interface FoldTurnResult {
	readonly messages: Message[];
	/** Session entry of each returned message; undefined for the nudge and a live-only tail. */
	readonly sources: (string | undefined)[];
	/** Entries whose image parts were replaced only in this outgoing request. */
	readonly mediaElidedEntryIds?: readonly string[];
	/** Rebuilt request messages immediately before their image parts were replaced. */
	readonly mediaElisionBefore?: readonly { readonly entryId: string; readonly message: Message }[];
	/** Text of the nudge appended to the request, if any. */
	readonly nudge?: string;
	readonly nudgeFix?: NudgeFix;
}

/**
 * The request billion-context-pi would send for this turn, built from the native
 * fold records. Undefined when the request does not line up with Pi's projection;
 * the caller then sends it with the block pointers only.
 */
export interface FoldTurnPreview {
	readonly result?: FoldTurnResult;
	readonly memory: FoldTurnMemory;
}

/** Run the per-turn pass on a snapshot and return both its request and detached next-turn state. */
export function previewFoldTurnState(input: FoldTurnInput): FoldTurnPreview {
	const memory = cloneFoldTurnMemory(input.memory);
	const result = prepareFoldTurn({ ...input, memory });
	return { ...(result ? { result } : {}), memory };
}


export function prepareFoldTurn(input: FoldTurnInput): FoldTurnResult | undefined {
	const sources = alignSources(input.messages, input.projection);
	if (!sources) return undefined;
	const records = foldRecordsOnBranch(input.branch).map(({ record }) => record);
	const messages = renderEarlierFoldCalls(input.messages as ContextEvent["messages"], records);
	// The kernel reads earlier fold calls as the model sees them: with block pointers.
	const contextEntries = input.contextEntries.map((entry) => withPointers(entry, records));
	const state = foldStateFromBranch(input.branch, contextEntries);
	// The kernel hides and protects fold calls by the name billion-context-pi gives them.
	state.messages.forEach((message, i) => { if (message.toolName === FOLD_TOOL_NAME) state.messages[i] = { ...message, toolName: "compress" }; });
	const memory = input.memory;
	const kernel = restoreMemory(state.kernel, memory);
	asBillionContextBlocks(kernel, state.messages);
	const limit = headroomLimit(input.model);
	const config = turnConfig(limit, input.config);
	const core = createCore();
	const allImages = imageTokens(input.projection.entries);
	const sys = input.systemPromptTokens;
	const sentWithAllImages = estimateTokens(state.messages, coveredMessageIds(kernel), allImages) + sys;
	const mediaElision = planNativeMediaElision(
		input.projection.entries,
		sentWithAllImages,
		config.nudge.maxContextLimitPct * config.modelContextLimit,
	);
	const images = imageTokens(input.projection.entries, mediaElision);
	const sent = estimateTokens(state.messages, coveredMessageIds(kernel), images) + sys;
	const { predates, netReclaimed } = anchorStaleness(input.contextEntries, kernel.blocks);
	const real = input.hostTokens !== undefined && Number.isFinite(input.hostTokens) && input.hostTokens > 0 ? input.hostTokens : 0;
	const hostFloor = real > 0 ? Math.max(0, real - (predates ? netReclaimed : 0)) : 0;
	const stable = !predates && real > 0 ? noteHostUsage(memory, real) : false;
	const floors = (base: number) => Math.max(stable ? Math.min(base, Math.ceil(real * 1.2)) : base, hostFloor);
	let tokenCount = floors(sent);
	if (kernel.blocks.some((block) => block.active && block.effectiveMessageIds.length > 0)) {
		const meter = memory.meter;
		if (meter && meterMatches(meter, kernel, config)) {
			if (Math.abs(meter.viewTokens - sent) > Math.max(1_000, 0.1 * sent)) tokenCount = floors(meter.viewTokens);
		} else {
			const cap = config.modelContextLimit > 0 ? Math.max(0, Math.floor(config.truncate.threshold * config.modelContextLimit) - 1) : Number.MAX_SAFE_INTEGER;
			const probe = core.processTurn({ messages: state.messages, state: structuredClone(kernel), config, tokenCount: Math.min(tokenCount, cap) });
			const viewTokens = estimateTokens(probe.messages, coveredMessageIds(probe.state), images) + sys;
			if (Math.abs(viewTokens - tokenCount) > Math.max(1_000, 0.1 * tokenCount)) tokenCount = floors(viewTokens);
		}
	}
	const stale = hostFloor <= sent;
	if (memory.scaleStale !== undefined && memory.scaleStale !== stale) {
		// The token scale switched between host usage and the estimate: re-anchor the stamps.
		kernel.nudge.lastNudgeShownTokens = kernel.nudge.lastNudgeShownTokens > 0 ? tokenCount : 0;
		kernel.nudge.lastPerMessageNudgeTokens = kernel.nudge.lastPerMessageNudgeTokens > 0 ? tokenCount : 0;
		kernel.nudge.lastShownByTier = Object.fromEntries(Object.entries(kernel.nudge.lastShownByTier).filter(([, shown]) => shown > 0).map(([tier]) => [tier, tokenCount]));
		memory.shownTokens.clear();
	}
	memory.scaleStale = stale;
	const compatibleKernel = input.compatibility ? structuredClone(kernel) : undefined;
	const turn = core.processTurn({ messages: state.messages, state: kernel, config, tokenCount });
	memory.nudge = turn.state.nudge;
	memory.tokenSnapshot = turn.state.tokenSnapshot;
	memory.lastPassIds = turn.state.lastPassIds;
	const truncateBand = config.modelContextLimit > 0 ? Math.floor(config.truncate.threshold * config.modelContextLimit) : Number.MAX_SAFE_INTEGER;
	memory.meter = {
		viewTokens: estimateTokens(turn.messages, coveredMessageIds(turn.state), images) + sys,
		blocksLen: turn.state.blocks.length,
		activeBlocks: turn.state.blocks.filter((block) => block.active).length,
		limit: config.modelContextLimit,
		usable: tokenCount < truncateBand,
	};

	const rebuilt = rebuild(messages, sources, contextEntries, turn.messages, new Set(state.active.map((record) => record.carrierId)));
	const turnKey = lastTurnBoundaryId(input.contextEntries) ?? "";
	const gate = nudgeGate(memory, turnKey, tokenCount, config);
	const failed = lastAssistantFailed(input.contextEntries);
	const decided = decideInjection(turn.nudge, gate, failed, turn.state.blocks);
	if (decided.text !== undefined && turn.nudge?.breakdown?.emergencyOverride !== 1) markShown(memory, turnKey, tokenCount);
	let nudgeFix: NudgeFix | undefined;
	if (compatibleKernel) {
		const compatible = compatibleNudge(core, state.messages, compatibleKernel, limit, input.config, tokenCount, gate);
		if (decided.deferred && compatible.text !== undefined) nudgeFix = { cause: "emergency-defer", compatible: compatible.text };
		else if (compatible.text !== decided.text) nudgeFix = { cause: "tier-trigger", ...optionalText("sent", decided.text), ...optionalText("compatible", compatible.text) };
	}
	if (decided.text !== undefined) {
		const at = lastSourcedIndex(rebuilt.sources) + 1;
		rebuilt.messages.splice(at, 0, { role: "user", content: [{ type: "text", text: decided.text }], timestamp: Date.now() } as Message);
		rebuilt.sources.splice(at, 0, undefined);
	}
	if (turn.state.blocks.length > 0) dropOrphanResults(rebuilt);
	const appliedMedia = applyMediaElision(rebuilt, mediaElision);
	return {
		messages: rebuilt.messages,
		sources: rebuilt.sources,
		...(appliedMedia.entryIds.length > 0 ? { mediaElidedEntryIds: appliedMedia.entryIds, mediaElisionBefore: appliedMedia.before } : {}),
		...(decided.text !== undefined ? { nudge: decided.text } : {}),
		...(nudgeFix ? { nudgeFix } : {}),
	};
}

function optionalText<K extends "sent" | "compatible">(key: K, text: string | undefined): { [P in K]?: string } {
	return (text === undefined ? {} : { [key]: text }) as { [P in K]?: string };
}

/** Engine settings for the per-turn pass: the engine defaults with the #629 tier triggers. */
export function turnConfig(limit: number, overrides: Partial<Config> = {}): Config {
	return defaultConfig(limit, { ...overrides, tiers: { ...defaultConfig(limit).tiers, ...TIER_TRIGGERS, ...overrides.tiers } });
}

/** billion-context-pi's applyOutputHeadroom: reserve the model's output, at most a quarter of the window. */
export function headroomLimit(model: FoldTurnModel): number {
	const window = model.contextWindow;
	const maxOutput = model.maxOutputTokens ?? 0;
	if (model.api === "anthropic-messages") return window;
	if (Number.isFinite(window) && window > 0 && Number.isFinite(maxOutput) && maxOutput > 0 && maxOutput < window) {
		const reserved = Math.min(maxOutput, OUTPUT_HEADROOM_MAX_PCT * window);
		return reserved > 0 ? window - reserved : window;
	}
	return window;
}

function withPointers(entry: SessionEntry, records: readonly FoldRecord[]): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const [rendered] = renderEarlierFoldCalls([entry.message], records);
	return rendered === entry.message ? entry : { ...entry, message: rendered } as SessionEntry;
}

function restoreMemory(kernel: CompressionState, memory: FoldTurnMemory): CompressionState {
	const keys = new Set(kernel.blocks.map((block) => blockKey(block)));
	const created = memory.blockKeys !== undefined && [...keys].some((key) => !memory.blockKeys!.has(key));
	memory.blockKeys = keys;
	if (memory.nudge) kernel.nudge = structuredClone(memory.nudge);
	if (memory.tokenSnapshot) kernel.tokenSnapshot = { ...memory.tokenSnapshot };
	if (memory.lastPassIds) kernel.lastPassIds = [...memory.lastPassIds];
	if (created) {
		// A new fold resets the growth baselines, as the kernel's applyCompression does.
		kernel.nudge.lastPerMessageNudgeTokens = 0;
		kernel.nudge.lastNudgeShownTokens = 0;
		kernel.nudge.lastShownByTier = {};
	}
	return kernel;
}

const blockKey = (block: CompressionBlock) => block.blockId + "/" + block.runId;

/**
 * Block figures as billion-context-pi keeps them, so the nudge and its token counts match:
 * the summary without the heading line the fold's message adds, and the folded size counted
 * on the tagged text the kernel folded (fold records count the session's own text).
 */
function asBillionContextBlocks(kernel: CompressionState, messages: readonly CoreMessage[]): void {
	// A fold whose range starts at the pinned opening message keeps it visible and out of its
	// record; billion-context-pi's block still lists it, so its nudge never offers it again.
	const opening = messages.find((message) => message.role === "user");
	if (opening) {
		const ref = kernel.messageRefs.byRaw[opening.id];
		for (const block of kernel.blocks) {
			if (ref === undefined || block.startRef !== ref || block.effectiveMessageIds.includes(opening.id)) continue;
			block.directMessageIds = [opening.id, ...block.directMessageIds];
			block.effectiveMessageIds = [opening.id, ...block.effectiveMessageIds];
		}
	}
	const tagged = new Map(renderVisibleRefs([...messages], kernel, defaultCountTokens).map((message) => [message.id, message]));
	const summaries = new Map<string, string>();
	for (const block of kernel.blocks) {
		if (block.summary.startsWith(SUMMARY_HEADER)) {
			const newline = block.summary.indexOf("\n");
			block.summary = newline < 0 ? "" : block.summary.slice(newline + 1);
		}
		summaries.set(block.blockId, block.summary);
	}
	for (const block of kernel.blocks) {
		const own = block.directMessageIds.reduce((sum, id) => sum + (tagged.has(id) ? countMessageTokens(tagged.get(id)!) : 0), 0);
		const absorbed = block.directBlockIds.reduce((sum, id) => sum + defaultCountTokens(summaries.get(id) ?? ""), 0);
		if (own + absorbed > 0) block.compressedTokens = own + absorbed;
	}
}

/** The entry each request message comes from, by Pi's projection; undefined when they do not line up. */
function alignSources(messages: readonly Message[], projection: FoldTurnInput["projection"]): (string | undefined)[] | undefined {
	const projected = projection.entries.flatMap((entry) => entry.messages.filter((message) => message.role !== "system").map((message) => ({ id: entry.sourceEntry.id, role: message.role })));
	if (projected.length > messages.length) return undefined;
	for (let i = 0; i < projected.length; i++) if (projected[i]!.role !== messages[i]!.role) return undefined;
	return messages.map((_message, i) => projected[i]?.id);
}

interface Rebuilt { messages: Message[]; sources: (string | undefined)[] }

interface AppliedMediaElision {
	readonly entryIds: string[];
	readonly before: { readonly entryId: string; readonly message: Message }[];
}

function applyMediaElision(rebuilt: Rebuilt, plan: MediaElisionPlan): AppliedMediaElision {
	const planned = new Map(plan.targets.map((target) => [target.targetId, target.keepNewestImages]));
	const applied = new Set<string>();
	const before: AppliedMediaElision["before"][number][] = [];
	for (let index = 0; index < rebuilt.messages.length; index++) {
		const source = rebuilt.sources[index];
		const message = rebuilt.messages[index]!;
		const keepNewestImages = source === undefined ? undefined : planned.get(source);
		if (source === undefined || keepNewestImages === undefined) continue;
		const elided = elideImageParts((message as { content?: unknown }).content, source, keepNewestImages);
		if (elided.refs.length === 0) continue;
		before.push({ entryId: source, message });
		rebuilt.messages[index] = { ...message, content: elided.content } as Message;
		applied.add(source);
	}
	return { entryIds: [...applied], before };
}

/** billion-context-pi's coreOutToAgentMessages, over the request Pi built. */
function rebuild(messages: readonly Message[], sources: readonly (string | undefined)[], entries: readonly SessionEntry[], out: readonly CoreMessage[], carriers: ReadonlySet<string>): Rebuilt {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const coreByEntry = new Map<string, CoreMessage[]>();
	for (const message of out) {
		if (isSummaryMessageId(message.id)) continue;
		const base = baseIdOf(message.id);
		const list = coreByEntry.get(base);
		if (list) list.push(message); else coreByEntry.set(base, [message]);
	}
	const result: Rebuilt = { messages: [], sources: [] };
	messages.forEach((message, i) => {
		const id = sources[i];
		const entry = id === undefined ? undefined : byId.get(id);
		if (id === undefined || !entry || (entry.type !== "message" && entry.type !== "custom_message") || carriers.has(id)) {
			result.messages.push(message);
			result.sources.push(id);
			return;
		}
		const cores = coreByEntry.get(id);
		// Hidden by the kernel (an absorbed or old failed fold call, or its result), or nothing to send.
		if (!cores?.length) return;
		result.messages.push(cores[0]!.id.includes("#") ? withSurvivingCalls(message, cores) : patchRefTag(message, cores[0]!));
		result.sources.push(id);
	});
	return result;
}

const REF_TAG_SOURCE = "(?:<acp\\s[^>]*>m\\d{5}</acp>|\\[m\\d{1,5}\\])";
const REF_TAG = new RegExp("^" + REF_TAG_SOURCE + "\\s?\\n?", "u");
const TRAILING_REF_TAG = new RegExp("\\n*" + REF_TAG_SOURCE + "\\s*$", "u");
const stripRefTag = (text: string) => text.replace(REF_TAG, "").replace(TRAILING_REF_TAG, "");

function partsOf(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter((part): part is Part => typeof part === "object" && part !== null) : [];
}
function textOf(content: unknown): string {
	return partsOf(content).flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [stripRefTag(part.text)] : [])).join("\n");
}
function peelRefTags(parts: readonly Part[]): Part[] {
	const out: Part[] = [];
	for (const part of parts) {
		if (part.type === "text" && typeof part.text === "string") {
			const stripped = stripRefTag(part.text);
			if (stripped.length > 0 || part.text.length === 0) out.push({ ...part, text: stripped });
		} else out.push(part);
	}
	return out;
}
function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 10_000) return (tokens / 1_000).toFixed(1) + "K";
	return Math.round(tokens / 1_000) + "K";
}
const rewriteTagTokens = (tag: string, body: string) => tag.replace(/tokens="[^"]*"/u, 'tokens="' + formatTokens(defaultCountTokens(body)) + '"');
function coreBodyOf(coreText: string, tag: string): string {
	let start = tag.replace(/\s+$/u, "").length;
	if (coreText.charAt(start) === "\n") start += 1;
	return coreText.slice(start);
}
const trimEnd = (text: string) => text.replace(/\s+$/u, "");

/** billion-context-pi's patchRefTag: the kernel's tag at the end of the message's last text. */
export function patchRefTag(original: Message, core: CoreMessage): Message {
	// Assistant messages carry no tag. Kept fold calls keep their arguments (block pointers).
	if (original.role === "assistant") return original;
	const tag = core.text?.match(REF_TAG)?.[0];
	if (!tag) return original;
	const coreBody = coreBodyOf(core.text ?? "", tag);
	const content = (original as { content?: unknown }).content;
	const originalBody = textOf(content);
	if (coreBody && trimEnd(coreBody) !== trimEnd(originalBody)) {
		const text = trimEnd(coreBody) + "\n\n" + rewriteTagTokens(tag, coreBody);
		if (typeof content === "string") return { ...original, content: text } as Message;
		const kept = Array.isArray(content) ? partsOf(content).filter((part) => part.type !== "text") : [];
		return { ...original, content: [...kept, { type: "text", text }] } as Message;
	}
	const stableTag = rewriteTagTokens(tag, originalBody);
	const parts = peelRefTags(partsOf(content));
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i]!;
		if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
			parts[i] = { ...part, text: part.text.replace(/\n*$/u, "") + "\n\n" + stableTag };
			return { ...original, content: parts } as Message;
		}
	}
	return { ...original, content: [...parts, { type: "text", text: stableTag }] } as Message;
}

/** billion-context-pi's reconstructToolCallMessage for an entry with several calls: drop the hidden calls. */
function withSurvivingCalls(original: Message, cores: readonly CoreMessage[]): Message {
	const surviving = new Set(cores.flatMap((core) => (core.toolCallId ? [core.toolCallId] : [])));
	const parts = partsOf((original as { content?: unknown }).content).filter((part) => part.type !== "toolCall" || surviving.has(typeof part.id === "string" ? part.id : ""));
	return { ...original, content: peelRefTags(parts) } as Message;
}

/** billion-context-pi's sanitizeToolPairing: a result whose call is not in the request is dropped. */
function dropOrphanResults(rebuilt: Rebuilt): void {
	const calls = new Set<string>();
	for (const message of rebuilt.messages) {
		if (message.role !== "assistant") continue;
		for (const part of partsOf(message.content)) if (part.type === "toolCall" && typeof part.id === "string" && part.id) calls.add(part.id);
	}
	for (let i = rebuilt.messages.length - 1; i >= 0; i--) {
		const message = rebuilt.messages[i]!;
		if (message.role !== "toolResult") continue;
		const id = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof id !== "string" || !id || !calls.has(id)) {
			rebuilt.messages.splice(i, 1);
			rebuilt.sources.splice(i, 1);
		}
	}
}

function lastSourcedIndex(sources: readonly (string | undefined)[]): number {
	for (let i = sources.length - 1; i >= 0; i--) if (sources[i] !== undefined) return i;
	return sources.length - 1;
}

/** billion-context-pi's estimateTokens: compress calls and folded messages do not count. */
function estimateTokens(messages: readonly CoreMessage[], covered: ReadonlySet<string>, images: ReadonlyMap<string, number>): number {
	let tokens = 0;
	for (const message of messages) {
		if (message.toolName === "compress" || covered.has(message.id)) continue;
		tokens += defaultCountTokens(message.text ?? "") + (message.thinkingTokens ?? 0) + (images.get(message.id) ?? 0);
	}
	return tokens;
}

function imageTokens(
	entries: FoldTurnInput["projection"]["entries"],
	plan?: MediaElisionPlan,
): Map<string, number> {
	const keptByEntry = new Map(plan?.targets.map((target) => [target.targetId, target.keepNewestImages]) ?? []);
	const out = new Map<string, number>();
	for (const entry of entries) {
		const count = entry.messages.reduce<number>((total, message) => {
			return total + partsOf(message.content).filter((part) => part.type === "image").length;
		}, 0);
		const plannedCount = keptByEntry.get(entry.sourceEntry.id);
		const sentCount = plannedCount === undefined ? count : Math.min(count, plannedCount);
		if (sentCount > 0) out.set(entry.sourceEntry.id, sentCount * IMAGE_TOKEN_COST);
	}
	return out;
}

function meterMatches(meter: SentViewMeter, state: CompressionState, config: Config): boolean {
	return meter.usable && meter.limit === config.modelContextLimit && meter.blocksLen === state.blocks.length
		&& meter.activeBlocks === state.blocks.filter((block) => block.active).length;
}

function noteHostUsage(memory: FoldTurnMemory, tokens: number): boolean {
	memory.hostSamples.push(tokens);
	if (memory.hostSamples.length > HOST_USAGE_WINDOW) memory.hostSamples.shift();
	if (memory.hostSamples.length < HOST_USAGE_MIN_SAMPLES) return false;
	const low = Math.min(...memory.hostSamples);
	return (Math.max(...memory.hostSamples) - low) / low <= HOST_USAGE_SPREAD_MAX;
}

type MessageFields = { role?: unknown; stopReason?: unknown; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; toolCallId?: unknown; isError?: unknown };
const messageOf = (entry: SessionEntry): MessageFields | undefined => entry.type === "message" && typeof entry.message === "object" && entry.message !== null ? entry.message as MessageFields : undefined;

/**
 * billion-context-pi's compressionAnchorStaleness: whether Pi's usage reading predates the
 * latest fold, and the tokens folds written after it reclaimed. A fold result is the result of
 * a call that made a fold on this branch.
 */
function anchorStaleness(entries: readonly SessionEntry[], blocks: readonly CompressionBlock[]): { predates: boolean; netReclaimed: number } {
	const callIds = new Set(blocks.flatMap((block) => (block.compressCallId ? [block.compressCallId] : [])));
	let lastUsage = -1;
	let lastFold = -1;
	const foldAt = new Map<string, number>();
	entries.forEach((entry, i) => {
		const message = messageOf(entry);
		if (!message) return;
		const usage = message.usage;
		const total = usage ? (usage.totalTokens ?? 0) || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
		if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" && total > 0) lastUsage = i;
		else if (message.role === "toolResult" && message.isError !== true && typeof message.toolCallId === "string" && callIds.has(message.toolCallId)) {
			lastFold = i;
			foldAt.set(message.toolCallId, i);
		}
	});
	let netReclaimed = 0;
	for (const block of blocks) {
		if (!block.active || !block.compressCallId) continue;
		const at = foldAt.get(block.compressCallId);
		if (at === undefined || at <= lastUsage) continue;
		netReclaimed += Math.max(0, (block.compressedTokens ?? 0) - defaultCountTokens(block.summary ?? ""));
	}
	return { predates: lastFold > lastUsage, netReclaimed };
}

function lastTurnBoundaryId(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) if (messageOf(entries[i]!)?.role === "user") return entries[i]!.id;
	return undefined;
}

/** True when the latest model turn did not complete (ranxianglei/billion-context-pi#666). */
export function lastAssistantFailed(entries: readonly SessionEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = messageOf(entries[i]!);
		if (message?.role === "assistant") return message.stopReason === "error" || message.stopReason === "aborted";
	}
	return false;
}

interface Gate { readonly shown: boolean; readonly reInjectReady: boolean }

/** billion-context-pi's once-per-turn nudge gate, with its re-anchor when the context shrank. */
function nudgeGate(memory: FoldTurnMemory, turnKey: string, tokenCount: number, config: Config): Gate {
	const limit = config.modelContextLimit;
	const adaptive = !limit || limit <= 0 ? config.nudge.growthFloor : Math.min(config.nudge.growthCap, Math.max(config.nudge.growthFloor, Math.round(limit * config.nudge.growthRatio)));
	const reInjectFloor = Math.max(config.nudge.minGrowthFloor, config.nudge.minGrowthRatio * adaptive);
	let shownAt = memory.shownTokens.get(turnKey);
	if (shownAt !== undefined && tokenCount < shownAt - adaptive) {
		shownAt = tokenCount;
		markShown(memory, turnKey, tokenCount);
	}
	return { shown: memory.shownTurns.has(turnKey), reInjectReady: shownAt === undefined || tokenCount - shownAt >= reInjectFloor };
}

function markShown(memory: FoldTurnMemory, turnKey: string, tokenCount: number): void {
	memory.shownTurns.add(turnKey);
	memory.shownTokens.set(turnKey, tokenCount);
}

function decideInjection(nudge: NudgeDecision | undefined, gate: Gate, turnFailed: boolean, blocks: readonly CompressionBlock[], deferEmergency = true): { text?: string; deferred: boolean } {
	if (!nudge?.shouldInject) return { deferred: false };
	const emergency = nudge.breakdown?.emergencyOverride === 1;
	const deferred = deferEmergency && emergency && turnFailed;
	if (deferred || (!emergency && gate.shown && !gate.reInjectReady)) return { deferred };
	return { text: nudgeText({ ...nudge, compressibleRanges: viableRanges(nudge.compressibleRanges) }, blocks.filter((block) => block.active)), deferred };
}

/** The nudge billion-context-pi 0.1.83 would send: kernel tier triggers, no emergency deferral. */
function compatibleNudge(core: CompressionCore, messages: CoreMessage[], kernel: CompressionState, limit: number, overrides: Partial<Config> | undefined, tokenCount: number, gate: Gate): { text?: string } {
	const turn = core.processTurn({ messages, state: kernel, config: defaultConfig(limit, overrides ?? {}), tokenCount });
	return decideInjection(turn.nudge, gate, false, turn.state.blocks, false);
}

/** billion-context-pi's nudgeMessage text: the kernel's nudge and a line on the active blocks. */
export function nudgeText(nudge: NudgeDecision, blocks: readonly CompressionBlock[]): string {
	const lines = [renderNudgeText(nudge, defaultPrompts, {}).text];
	if (blocks.length > 0) {
		const summary = blocks.reduce((sum, block) => sum + Math.ceil((block.summary || "").length / 4), 0);
		const compressed = blocks.reduce((sum, block) => sum + (block.compressedTokens || 0), 0);
		const k = (n: number) => (n >= 1_000 ? (n / 1_000).toFixed(1) + "K" : String(n));
		const tiers: Record<number, number> = {};
		for (const block of blocks) tiers[block.tier ?? 1] = (tiers[block.tier ?? 1] ?? 0) + 1;
		const tierList = Object.keys(tiers).map(Number).sort().map((tier) => "T" + tier + ":" + tiers[tier]).join(" ");
		const ids = blocks.slice(0, 10).map((block) => block.blockId).join(", ");
		const extra = blocks.length > 10 ? " (+" + (blocks.length - 10) + " more)" : "";
		lines.push("", "Compressed blocks: " + blocks.length + " active (" + tierList + ") \u2014 " + k(summary) + " summary, " + k(compressed) + " original compressed. Blocks: " + ids + extra + ".");
	}
	return lines.join("\n");
}
