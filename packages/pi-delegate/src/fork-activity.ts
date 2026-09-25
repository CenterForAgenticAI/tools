import type { TranscriptEntry } from "./summarize.js";
import { boundActivityText, safeActivityToolName } from "./activity-status.js";
import { sanitizeRecoveryText, truncateRecoveryText } from "./fork-recovery.js";
import { isSubstantiveAssistantText } from "./harvest-outcome.js";
import { unresolvedToolCallIndexes, type ToolPairingEvent } from "./tool-pairing.js";

export const TIMEOUT_RECEIPT_MAX_BYTES = 4_096;
export const TIMEOUT_ASSISTANT_MAX_BYTES = 16 * 1024;
export const TIMEOUT_TRANSCRIPT_MAX_ENTRIES = 50;
export const TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES = 4_096;
const TIMEOUT_RECEIPT_MAX_ACTIVITIES = 8;

type WorkerToolActivity = ToolPairingEvent & { toolName?: string; toolMeta?: string };

export interface RunActivitySummary {
	/** User + assistant prose turns (excludes tool, thinking, and system entries). */
	messageCount: number;
	/** Name of the most-recent structured tool call, if any. */
	lastToolName?: string;
	/** Bounded metadata attached to the most-recent structured tool call. */
	lastToolMeta?: string;
	/** True when any structured tool call remains unresolved. */
	toolActive: boolean;
	/** True when the most-recent call itself remains unresolved. */
	lastToolActive?: boolean;
	/** Number of unresolved calls, including one anonymous legacy call when applicable. */
	activeToolCount: number;
	/** Source of the most-recent tool call, when present. */
	lastToolSource?: TranscriptEntry["source"];
	/** Source of the most-recent unresolved tool call, when one exists. */
	activeToolSource?: TranscriptEntry["source"];
	/** Maximum timestamp in the transcript, when any entry carries one. */
	lastEventAt?: number;
	/** Maximum timestamp among worker-session entries, when any carries one. */
	lastWorkerEventAt?: number;
	/** True when an unresolved structured worker tool call remains. */
	workerToolActive: boolean;
	/** Number of unresolved structured worker tool calls. */
	activeWorkerToolCount: number;
	/** Consecutive suffix of worker tool results marked as errors. */
	consecutiveWorkerToolErrors: number;
	/** Repeated worker call signature in the bounded recent-call window. */
	repeatedWorkerCall?: { toolName: string; repetitions: number };
}

export interface RunRoundProjection {
	setup: { startEntryIndex: number; endEntryIndexExclusive: number };
	rounds: readonly RunRound[];
}

export interface RunRound {
	/** One-based position among boundaries recoverable from this transcript. */
	index: number;
	askEntryIndex: number;
	startEntryIndex: number;
	endEntryIndexExclusive: number;
	ask: TranscriptEntry;
	replyEntryIndex?: number;
	replyHeadline?: string;
	workerToolCount: number;
	workerErrorCount: number;
	openWorkerToolCount: number;
	firstTimestamp?: number;
	lastTimestamp?: number;
	durationMs?: number;
	resolution: "resolved" | "open";
}

export interface RunTranscriptProjection {
	activity: RunActivitySummary;
	rounds?: RunRoundProjection;
}

interface RunActivityProjection extends RunActivitySummary {
	workerCalls: WorkerToolActivity[];
	workerResultCount: number;
	workerErrorCount: number;
	latestWorkerCheckpoint?: string;
}

interface RoundAccumulator extends Omit<RunRound, "durationMs" | "openWorkerToolCount" | "resolution"> {
	workerToolCalls: ToolPairingEvent[];
	workerResults: ToolPairingEvent[];
}

interface InternalRunTranscriptProjection extends RunTranscriptProjection {
	activity: RunActivityProjection;
}

/** Parse a tool name out of a legacy `name(args)` transcript entry. */
export function toolNameFromTranscriptEntry(
	entry: Pick<TranscriptEntry, "text" | "toolName">,
): string | undefined {
	if (entry.toolName) return entry.toolName;
	return /^([A-Za-z0-9_.-]+)\(/.exec(entry.text)?.[1];
}

function finiteTimestamp(entry: TranscriptEntry): number | undefined {
	return typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
		? entry.timestamp
		: undefined;
}

function startRound(index: number, entryIndex: number, ask: TranscriptEntry): RoundAccumulator {
	return {
		index,
		askEntryIndex: entryIndex,
		startEntryIndex: entryIndex,
		endEntryIndexExclusive: entryIndex,
		ask,
		workerToolCount: 0,
		workerErrorCount: 0,
		workerToolCalls: [],
		workerResults: [],
	};
}

function finishRound(round: RoundAccumulator, closedByLaterAsk: boolean): RunRound {
	const openWorkerToolCount = unresolvedToolCallIndexes(
		round.workerToolCalls,
		round.workerResults,
	).length;
	const durationMs = round.firstTimestamp !== undefined && round.lastTimestamp !== undefined
		? Math.max(0, round.lastTimestamp - round.firstTimestamp)
		: undefined;
	return {
		index: round.index,
		askEntryIndex: round.askEntryIndex,
		startEntryIndex: round.startEntryIndex,
		endEntryIndexExclusive: round.endEntryIndexExclusive,
		ask: round.ask,
		...(round.replyEntryIndex !== undefined
			? { replyEntryIndex: round.replyEntryIndex, replyHeadline: round.replyHeadline }
			: {}),
		workerToolCount: round.workerToolCount,
		workerErrorCount: round.workerErrorCount,
		openWorkerToolCount,
		...(round.firstTimestamp !== undefined ? { firstTimestamp: round.firstTimestamp } : {}),
		...(round.lastTimestamp !== undefined ? { lastTimestamp: round.lastTimestamp } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		resolution: closedByLaterAsk || (
			round.replyEntryIndex !== undefined && openWorkerToolCount === 0
		) ? "resolved" : "open",
	};
}

/**
 * Project normalized transcript facts in one pass. Callers that need rounds and
 * activity together use this batch; activity-only surfaces skip round state.
 */
function projectTranscript(
	transcript: readonly TranscriptEntry[] | undefined,
	includeRounds: boolean,
): InternalRunTranscriptProjection {
	const activity: RunActivityProjection = {
		messageCount: 0,
		toolActive: false,
		activeToolCount: 0,
		workerToolActive: false,
		activeWorkerToolCount: 0,
		consecutiveWorkerToolErrors: 0,
		workerCalls: [],
		workerResultCount: 0,
		workerErrorCount: 0,
	};
	const entries = transcript ?? [];
	const rounds: RunRound[] = [];
	let setupEndEntryIndexExclusive = entries.length;
	let currentRound: RoundAccumulator | undefined;
	let lastCallName: string | undefined;
	let lastCallMeta: string | undefined;
	let lastCallSource: TranscriptEntry["source"] | undefined;
	let lastCallIndex = -1;
	const calls: Array<ToolPairingEvent & { source: TranscriptEntry["source"] }> = [];
	const results: ToolPairingEvent[] = [];
	const workerResults: ToolPairingEvent[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (includeRounds && entry.source === "worker" && entry.role === "user") {
			if (currentRound) {
				currentRound.endEntryIndexExclusive = index;
				rounds.push(finishRound(currentRound, true));
			} else setupEndEntryIndexExclusive = index;
			currentRound = startRound(rounds.length + 1, index, entry);
		}

		const timestamp = finiteTimestamp(entry);
		if (timestamp !== undefined) {
			activity.lastEventAt = activity.lastEventAt === undefined
				? timestamp
				: Math.max(activity.lastEventAt, timestamp);
			if (entry.source === "worker") {
				activity.lastWorkerEventAt = activity.lastWorkerEventAt === undefined
					? timestamp
					: Math.max(activity.lastWorkerEventAt, timestamp);
				if (currentRound) {
					if (index === currentRound.askEntryIndex) currentRound.firstTimestamp = timestamp;
					currentRound.lastTimestamp = timestamp;
				}
			}
		}

		switch (entry.role) {
			case "user":
				activity.messageCount += 1;
				break;
			case "assistant": {
				activity.messageCount += 1;
				if (entry.source !== "worker" || !isSubstantiveAssistantText(entry.text)) break;
				activity.latestWorkerCheckpoint = entry.text;
				if (currentRound) {
					const headline = boundActivityText(entry.text);
					if (headline) {
						currentRound.replyEntryIndex = index;
						currentRound.replyHeadline = headline;
					}
				}
				break;
			}
			case "toolCall": {
				const safeName = safeActivityToolName(toolNameFromTranscriptEntry(entry));
				lastCallName = safeName ?? "tool";
				lastCallMeta = safeName ? entry.toolMeta : undefined;
				lastCallSource = entry.source;
				lastCallIndex = index;
				const call = { id: entry.toolCallId, index, source: entry.source };
				calls.push(call);
				if (entry.source === "worker") {
					const workerCall = {
						id: entry.toolCallId,
						index,
						toolName: safeName,
						toolMeta: safeName ? entry.toolMeta : undefined,
					};
					activity.workerCalls.push(workerCall);
					if (currentRound) {
						currentRound.workerToolCount += 1;
						currentRound.workerToolCalls.push(workerCall);
					}
				}
				break;
			}
			case "toolResult": {
				const result = { id: entry.toolCallId, index };
				results.push(result);
				if (entry.source !== "worker") break;
				workerResults.push(result);
				activity.workerResultCount += 1;
				if (entry.isError === true) {
					activity.consecutiveWorkerToolErrors += 1;
					activity.workerErrorCount += 1;
				} else activity.consecutiveWorkerToolErrors = 0;
				if (currentRound) {
					currentRound.workerResults.push(result);
					if (entry.isError === true) currentRound.workerErrorCount += 1;
				}
				break;
			}
			default:
				break;
		}
	}

	if (currentRound) {
		currentRound.endEntryIndexExclusive = entries.length;
		rounds.push(finishRound(currentRound, false));
	}

	const activeCallIndexes = new Set(unresolvedToolCallIndexes(calls, results));
	let latestActiveIndex = -1;
	for (const call of calls) {
		if (activeCallIndexes.has(call.index) && call.index > latestActiveIndex) {
			latestActiveIndex = call.index;
			activity.activeToolSource = call.source;
		}
	}
	if (lastCallName !== undefined) {
		activity.lastToolName = lastCallName;
		activity.lastToolMeta = lastCallMeta;
		activity.lastToolSource = lastCallSource;
		activity.lastToolActive = activeCallIndexes.has(lastCallIndex);
	}
	activity.activeToolCount = activeCallIndexes.size;
	activity.toolActive = activity.activeToolCount > 0;
	activity.activeWorkerToolCount = unresolvedToolCallIndexes(
		activity.workerCalls,
		workerResults,
	).length;
	activity.workerToolActive = activity.activeWorkerToolCount > 0;

	const repeatedBySignature = new Map<string, { toolName: string; repetitions: number; lastIndex: number }>();
	for (const call of activity.workerCalls.slice(-8)) {
		if (!call.toolName || typeof call.toolMeta !== "string") continue;
		const toolMeta = boundActivityText(call.toolMeta);
		if (!toolMeta) continue;
		const signature = `${call.toolName}\u0000${toolMeta}`;
		const prior = repeatedBySignature.get(signature);
		if (prior) {
			prior.repetitions += 1;
			prior.lastIndex = call.index;
		} else repeatedBySignature.set(signature, { toolName: call.toolName, repetitions: 1, lastIndex: call.index });
	}
	let latestRepeatedIndex = -1;
	for (const candidate of repeatedBySignature.values()) {
		if (candidate.repetitions >= 2 && candidate.lastIndex > latestRepeatedIndex) {
			activity.repeatedWorkerCall = {
				toolName: candidate.toolName,
				repetitions: candidate.repetitions,
			};
			latestRepeatedIndex = candidate.lastIndex;
		}
	}

	return {
		activity,
		...(includeRounds ? {
			rounds: {
				setup: { startEntryIndex: 0, endEntryIndexExclusive: setupEndEntryIndexExclusive },
				rounds,
			},
		} : {}),
	};
}

export function projectRunTranscript(
	transcript: readonly TranscriptEntry[] | undefined,
	includeRounds = true,
): RunTranscriptProjection {
	return projectTranscript(transcript, includeRounds);
}

export function summarizeRunActivity(
	transcript: readonly TranscriptEntry[] | undefined,
): RunActivitySummary {
	return projectTranscript(transcript, false).activity;
}

export function reduceRunRounds(transcript: readonly TranscriptEntry[]): RunRoundProjection {
	return projectTranscript(transcript, true).rounds!;
}

/** Bounded timeout collapse result using existing RunResult fields. */
export interface RunTimeoutCollapse {
	content: string;
	recoveredOutput: boolean;
}

/** Bound timeout transcript observations without copying open-ended fields. */
export function boundRunTimeoutTranscript(transcript: readonly TranscriptEntry[]): TranscriptEntry[] {
	return transcript.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES).map((entry) => ({
		source: entry.source,
		role: entry.role,
		text: truncateRecoveryText(entry.text, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES),
		...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
		...(entry.toolName === undefined ? {} : { toolName: truncateRecoveryText(entry.toolName, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) }),
		...(entry.toolCallId === undefined ? {} : { toolCallId: truncateRecoveryText(entry.toolCallId, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) }),
		...(entry.toolMeta === undefined ? {} : { toolMeta: truncateRecoveryText(entry.toolMeta, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) }),
		...(entry.isError === undefined ? {} : { isError: entry.isError }),
	}));
}

/** Select the last substantive worker checkpoint from the complete transcript. */
export function lastSubstantiveWorkerCheckpoint(
	transcript: readonly TranscriptEntry[],
): string | undefined {
	for (let index = transcript.length - 1; index >= 0; index -= 1) {
		const entry = transcript[index]!;
		if (entry.source === "worker" && entry.role === "assistant" && isSubstantiveAssistantText(entry.text)) {
			return entry.text;
		}
	}
	return undefined;
}

/**
 * Collapse live observations at an internal hard timeout. Prefer the latest
 * worker assistant checkpoint from the complete transcript, otherwise retain
 * the bounded activity receipt.
 */
export function buildRunTimeoutCollapse(transcript: readonly TranscriptEntry[]): RunTimeoutCollapse {
	const checkpoint = lastSubstantiveWorkerCheckpoint(transcript);
	if (checkpoint?.trim()) {
		return {
			content: truncateRecoveryText(sanitizeRecoveryText(checkpoint), TIMEOUT_ASSISTANT_MAX_BYTES),
			recoveredOutput: true,
		};
	}
	return { content: buildRunTimeoutReceipt(transcript), recoveredOutput: false };
}

/** Render a bounded, structurally projected receipt when timeout prevents collapse. */
export function buildRunTimeoutReceipt(transcript: readonly TranscriptEntry[]): string {
	const projection = projectTranscript(transcript, false).activity;
	const shown = projection.workerCalls.length <= TIMEOUT_RECEIPT_MAX_ACTIVITIES
		? projection.workerCalls
		: Array.from({ length: TIMEOUT_RECEIPT_MAX_ACTIVITIES }, (_, index) =>
			projection.workerCalls[Math.round(index * (projection.workerCalls.length - 1) / (TIMEOUT_RECEIPT_MAX_ACTIVITIES - 1))]!);
	const omitted = projection.workerCalls.length - shown.length;
	const lines = [
		"⚠️ PARTIAL TIMEOUT RECEIPT",
		"The run timed out before the worker or supervisor committed a deliverable.",
		"",
		`Worker activity (${projection.workerResultCount} result(s), ${projection.workerErrorCount} error(s), ${projection.activeWorkerToolCount} unfinished call(s)):`,
		...shown.map((item) => {
			const meta = item.toolMeta ? boundActivityText(item.toolMeta) : "";
			return `- ${item.toolName ?? "tool"}${meta ? ` ${meta}` : ""}`;
		}),
		...(shown.length === 0 ? ["- none observed"] : []),
		...(omitted > 0 ? [`- ${omitted} activity item(s) omitted from this whole-run sample`] : []),
		"",
		`Latest checkpoint: ${projection.latestWorkerCheckpoint ? boundActivityText(projection.latestWorkerCheckpoint) : "no worker checkpoint was observed"}`,
		`Unfinished scope: timeout interrupted the run before collapse; ${projection.activeWorkerToolCount} tool call(s) had no observed result.`,
	];
	return truncateRecoveryText(lines.join("\n"), TIMEOUT_RECEIPT_MAX_BYTES);
}


/** @deprecated Use {@link RunActivitySummary}; retained for compatibility. */
export type ForkActivitySummary = RunActivitySummary;
/** @deprecated Use {@link RunRoundProjection}; retained for compatibility. */
export type ForkRoundProjection = RunRoundProjection;
/** @deprecated Use {@link RunRound}; retained for compatibility. */
export type ForkRound = RunRound;
/** @deprecated Use {@link RunTranscriptProjection}; retained for compatibility. */
export type ForkTranscriptProjection = RunTranscriptProjection;
/** @deprecated Use {@link projectRunTranscript}; retained for compatibility. */
export const projectForkTranscript = projectRunTranscript;
/** @deprecated Use {@link summarizeRunActivity}; retained for compatibility. */
export const summarizeForkActivity = summarizeRunActivity;
/** @deprecated Use {@link reduceRunRounds}; retained for compatibility. */
export const reduceForkRounds = reduceRunRounds;
/** @deprecated Use {@link buildRunTimeoutReceipt}; retained for compatibility. */
export const buildTimeoutReceipt = buildRunTimeoutReceipt;
