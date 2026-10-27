import {
	buildSessionProjection,
	estimateTokens,
	sessionEntryToContextMessages,
	SettingsManager,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { ALREADY_COMPACTED_TOOL_MESSAGE, NOTHING_TO_COMPACT_TOOL_MESSAGE } from "./compaction-outcome.js";

// Pi refuses a manual compaction in AgentSession.compact(): prepareCompaction()
// returns nothing when the projected branch has no history before its cut
// point, and compact() then throws "Already compacted" or "Nothing to compact
// (session too small)". Neither prepareCompaction() nor its cut-point helpers
// are exported, so predictCompaction() ports their refusal decision onto the
// exported projection and token estimate (#43).
//
// The private code it ports, the cut-point functions and prepareCompaction() in
// dist/core/compaction/compaction.js, was verified against every release listed
// here. Any other release proceeds and leaves the decision to Pi; the drift
// tests in tests/compaction-preflight.test.ts pin each release's file and fail
// when the installed Pi changes.
//
// Only supported releases are listed (#243). Pi 1.0.3 to
// 1.3.0 carried the same cut-point code, but they are below the supported
// minimum (PI_MINIMUM_VERSION in scripts/check-pi-dependencies.mjs), so no
// compatibility job reinstalls them to recheck the pin. On them the preflight
// proceeds and Pi's own refusal stays handled by decideCompactionError().
export const VERIFIED_PI_VERSIONS: ReadonlySet<string> = new Set(["1.4.0"]);

/**
 * Estimated tokens for this compact_session call's persisted result and the
 * nearby tail that commonly lands before Pi compacts. Later entries from
 * turn_end, agent_before_settle, or other extensions are outside the snapshot
 * contract and may exceed this estimate.
 */
export const TOOL_CALL_TAIL_MARGIN_TOKENS = 2_048;

export type CompactionPrediction =
	| { kind: "compactable"; firstKeptEntryId: string; isSplitTurn: boolean }
	| { kind: "nothing-to-compact" }
	| { kind: "already-compacted" };

type ProjectedMessage = ProjectedSessionEntry["messages"][number];

interface CutPoint {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

// The functions below up to predictCompaction() are a line-for-line port of
// Pi's private helpers; keep them identical in behavior, not idiomatic.

function isCutPointMessage(message: ProjectedMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		default:
			return false;
	}
}

function isTurnStartMessage(message: ProjectedMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		default:
			return false;
	}
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(entries: readonly ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isProjectedTurnStart(entries[i]!)) return i;
	}
	return -1;
}

function findProjectedCutPoint(
	entries: readonly ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPoint {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i]!;
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0]!;
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = entries[i]!.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1]!;
			break;
		}
	}
	// Pi advances the cut past a closed suffix that holds only an omitted
	// assistant recovery attempt and its omission edits.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedSessionEntry): boolean => isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some((entry) =>
		entry.sourceEntry.type === "context_edit" &&
		entry.sourceEntry.replacement !== null &&
		!omittedSuffixIds.has(entry.sourceEntry.targetId));
	const isRecoveryOmissionSuffix = exceededBudget &&
		!hasExternalReplacement &&
		suffix.some((entry) => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry)) &&
		suffix.every((entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)));
	if (isRecoveryOmissionSuffix) cutIndex++;
	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1]!;
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]!);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

/** Pi's getMessagesFromProjectedEntryForCompaction(), reduced to "yields at least one". */
function hasMessagesToSummarize(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some((message) => message.role !== "system");
}

/**
 * Pi's manual-compaction decision for a branch: prepareCompaction() plus the
 * refusal ordering of AgentSession.compact(). `pathEntries` is what
 * `sessionManager.getBranch()` returns, oldest first.
 */
export function predictCompaction(pathEntries: readonly SessionEntry[], keepRecentTokens: number): CompactionPrediction {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1]!.type === "compaction") {
		return { kind: "already-compacted" };
	}
	const projectedEntries = buildSessionProjection([...pathEntries]).entries;
	// Only the newest compaction projects a summary; older ones project nothing.
	const prevCompactionIndex = projectedEntries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const boundaryStart = prevCompactionIndex >= 0 ? prevCompactionIndex + 1 : 0;
	const cutPoint = findProjectedCutPoint(projectedEntries, boundaryStart, projectedEntries.length, keepRecentTokens);
	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return { kind: "nothing-to-compact" };
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const hasHistory = projectedEntries.slice(boundaryStart, historyEnd).some(hasMessagesToSummarize);
	const hasTurnPrefix = cutPoint.isSplitTurn &&
		projectedEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).some(hasMessagesToSummarize);
	if (!hasHistory && !hasTurnPrefix) return { kind: "nothing-to-compact" };
	return { kind: "compactable", firstKeptEntryId: firstKeptEntry.id, isSplitTurn: cutPoint.isSplitTurn };
}

export type CompactionPreflightBoundary =
	/** Pi compacts now, before anything else can change the session. */
	| { kind: "idle" }
	/**
	 * compact_session is executing. Pi compacts after this run settles, so the
	 * branch will also hold this call's result, whose text is `resultText`.
	 */
	| { kind: "tool-call"; toolCallId: string; resultText: string };

export interface CompactionPreflightEnvironment {
	/** Pi's effective settings, from `ExtensionAPI.getSettings()`. */
	getSettings?: ExtensionAPI["getSettings"];
	/** Context edits this extension's fold engine will write at the next turn boundary. */
	pendingFolds?: (ctx: ExtensionContext) => number;
	/** The running Pi version. Defaults to the loaded Pi package's VERSION. */
	piVersion?: string;
}

export interface CompactionPreflightInput extends CompactionPreflightEnvironment {
	ctx: ExtensionContext;
	boundary: CompactionPreflightBoundary;
}

/** Why a preflight left the decision to Pi. Exposed for tests and debug logs. */
export type CompactionPreflightProceedReason =
	| "compactable"
	| "unverified-pi"
	| "no-model"
	| "settings-unavailable"
	| "pending-input"
	| "not-idle"
	| "pending-folds"
	| "branch-unavailable"
	| "tool-call-not-last"
	| "tail-reaches-keep-recent"
	| "prediction-failed";

export type CompactionPreflightResult =
	| { kind: "proceed"; reason: CompactionPreflightProceedReason }
	| {
			kind: "nothing-to-compact";
			refusal: "nothing-to-compact" | "already-compacted";
			toolMessage: string;
			serviceStatus: "nothing-to-compact";
	  };

function proceed(reason: CompactionPreflightProceedReason): CompactionPreflightResult {
	return { kind: "proceed", reason };
}

function readKeepRecentTokens(getSettings: CompactionPreflightEnvironment["getSettings"], model: NonNullable<ExtensionContext["model"]>): number | undefined {
	if (typeof getSettings !== "function") return undefined;
	try {
		// Resolve through Pi's own SettingsManager so model overrides and
		// defaults match what AgentSession.compact() reads.
		const value = SettingsManager.inMemory(getSettings()).getCompactionSettings(model).keepRecentTokens;
		return Number.isFinite(value) ? value : undefined;
	} catch {
		// Pi rejects the same invalid settings with its own error.
		return undefined;
	}
}

/** `undefined` when the host does not provide the predicate or it throws. */
function readPredicate(ctx: ExtensionContext, name: "isIdle" | "hasPendingMessages"): boolean | undefined {
	const predicate = (ctx as unknown as Record<string, unknown>)[name];
	if (typeof predicate !== "function") return undefined;
	try {
		const value: unknown = predicate.call(ctx);
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** An entry that adds nothing to model context and cannot edit or end it. */
function isStateOnly(entry: SessionEntry): boolean {
	return entry.type !== "compaction" && entry.type !== "context_edit" && sessionEntryToContextMessages(entry).length === 0;
}

/**
 * This tool call's estimated persisted result, including
 * TOOL_CALL_TAIL_MARGIN_TOKENS. `undefined` unless the newest context entry on
 * the branch is an assistant message whose only tool call is this one; only
 * state entries, such as usage or custom records, may follow it.
 */
function queuedToolResult(
	branch: readonly SessionEntry[],
	boundary: Extract<CompactionPreflightBoundary, { kind: "tool-call" }>,
): SessionMessageEntry | undefined {
	let index = branch.length - 1;
	while (index >= 0 && isStateOnly(branch[index]!)) index--;
	const call = branch[index];
	if (!call || call.type !== "message" || call.message.role !== "assistant") return undefined;
	const calls = call.message.content.filter((block) => block.type === "toolCall");
	const toolCall = calls[0];
	if (calls.length !== 1 || !toolCall || toolCall.id !== boundary.toolCallId) return undefined;
	const leaf = branch[branch.length - 1]!;
	return {
		type: "message",
		id: `${leaf.id}:context-aware-preflight-result`,
		parentId: leaf.id,
		timestamp: leaf.timestamp,
		message: {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [
				{ type: "text", text: boundary.resultText },
				{ type: "text", text: " ".repeat(TOOL_CALL_TAIL_MARGIN_TOKENS * 4) },
			],
			isError: false,
			timestamp: 0,
		},
	};
}

function refusalResult(prediction: CompactionPrediction): CompactionPreflightResult {
	if (prediction.kind === "compactable") return proceed("compactable");
	return {
		kind: "nothing-to-compact",
		refusal: prediction.kind,
		toolMessage: prediction.kind === "already-compacted" ? ALREADY_COMPACTED_TOOL_MESSAGE : NOTHING_TO_COMPACT_TOOL_MESSAGE,
		serviceStatus: "nothing-to-compact",
	};
}

/**
 * Answer whether Pi would refuse this compaction for the session snapshot as it
 * stands when asked. Uncertain inputs return `proceed`, and Pi's asynchronous
 * refusal stays handled by decideCompactionError().
 *
 * - `idle`: covers the branch at the point of the check.
 * - `tool-call`: covers the branch at the point of the check plus an estimate
 *   of this call's persisted result using TOOL_CALL_TAIL_MARGIN_TOKENS. Entries
 *   that land later are not covered and may change Pi's eventual decision.
 *   Context edits are not monotone, so a pending fold proceeds; so does an
 *   estimated result that alone reaches keepRecentTokens, where the cut can
 *   land past the tool call.
 */
export function preflightCompaction(input: CompactionPreflightInput): CompactionPreflightResult {
	const { ctx, boundary } = input;
	if (!VERIFIED_PI_VERSIONS.has(input.piVersion ?? VERSION)) return proceed("unverified-pi");
	const model = ctx.model;
	if (!model) return proceed("no-model");
	const keepRecentTokens = readKeepRecentTokens(input.getSettings, model);
	if (keepRecentTokens === undefined) return proceed("settings-unavailable");
	// Queued input starts another turn before Pi compacts.
	if (readPredicate(ctx, "hasPendingMessages") !== false) return proceed("pending-input");
	if (boundary.kind === "idle" && readPredicate(ctx, "isIdle") !== true) return proceed("not-idle");
	if (boundary.kind === "tool-call") {
		let folds: number;
		try {
			folds = input.pendingFolds?.(ctx) ?? 0;
		} catch {
			return proceed("pending-folds");
		}
		if (folds !== 0) return proceed("pending-folds");
	}
	let branch: SessionEntry[];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		return proceed("branch-unavailable");
	}
	if (!Array.isArray(branch)) return proceed("branch-unavailable");
	try {
		if (boundary.kind === "idle") return refusalResult(predictCompaction(branch, keepRecentTokens));
		const result = queuedToolResult(branch, boundary);
		if (!result) return proceed("tool-call-not-last");
		if (estimateTokens(result.message) >= keepRecentTokens) return proceed("tail-reaches-keep-recent");
		return refusalResult(predictCompaction([...branch, result], keepRecentTokens));
	} catch {
		return proceed("prediction-failed");
	}
}
