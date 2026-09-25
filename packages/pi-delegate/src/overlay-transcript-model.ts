/**
 * Turn a flat `TranscriptEntry[]` into the blocks the detail pane draws.
 *
 * The previous renderer walked the entries and emitted lines in one pass, so
 * every layout question — is this message folded, does this tool call have a
 * result yet, where does a round begin — was answered inline and could only be
 * tested by matching rendered text. This module answers them first, as data.
 *
 * Pure and total: no clock beyond the `nowMs` passed in, no theme, no width.
 * Rendering happens in `overlay-transcript-render.ts`.
 */

import type { RunRound, RunRoundProjection } from "./fork-digest.js";
import type { InProcessRunShape } from "./runtime.js";
import type { TranscriptEntry } from "./summarize.js";
import {
	speakerHeading,
	transcriptSpeaker,
	type TranscriptSpeaker,
} from "./transcript-speaker.js";

/**
 * The supervisor tool that re-awaits an in-flight worker reply.
 *
 * It does not re-prompt the worker and does not consume a round: it re-awaits
 * the same promise after a heartbeat returns control to the supervisor model.
 * One row appears per heartbeat interval for the life of a slow fork, which is
 * why it is the only tool call that collapses. Every other supervisor tool is
 * a decision and stays visible.
 */
export const WAIT_TOOL_NAME = "wait_for_worker";

/** A prose message: `user` or `assistant`, from either side. */
export interface ProseBlock {
	readonly kind: "prose";
	readonly entryIndex: number;
	readonly speaker: TranscriptSpeaker;
	readonly heading: string;
	readonly text: string;
	readonly timestamp?: number;
	/** The newest prose block is live, and is never folded. */
	readonly newest: boolean;
}

/** A thinking trace. Collapsed by default; `Enter` expands the selected one. */
export interface ThinkingBlock {
	readonly kind: "thinking";
	readonly entryIndex: number;
	readonly speaker: TranscriptSpeaker;
	readonly source: TranscriptEntry["source"];
	readonly text: string;
}

/** A tool call, paired with its result when one has arrived. */
export interface ToolBlock {
	readonly kind: "tool";
	readonly entryIndex: number;
	readonly speaker: TranscriptSpeaker;
	readonly name: string;
	/** Short single-line preview: the command, path, or query. */
	readonly meta?: string;
	/** Full argument text, shown when the block is expanded. */
	readonly args?: string;
	readonly state: "ok" | "error" | "pending";
	readonly durationMs?: number;
	/** Result output, carried so an error can auto-expand without a re-lookup. */
	readonly output?: string;
	readonly resultEntryIndex?: number;
}

/** A `system` entry, or any role this model does not otherwise name. */
export interface NoteBlock {
	readonly kind: "note";
	readonly entryIndex: number;
	readonly speaker: TranscriptSpeaker;
	readonly text: string;
}

/**
 * A labelled round boundary, carrying the counts the deleted rounds view used
 * to show. Rounds stop being a level you navigate and become a separator you
 * scroll past, so nothing is lost by removing that level.
 */
export interface RoundSeparatorBlock {
	readonly kind: "round";
	readonly entryIndex: number;
	readonly index: number;
	readonly toolCount: number;
	readonly errorCount: number;
	readonly timestamp?: number;
	readonly resolution: RunRound["resolution"];
}

export type TranscriptBlock =
	| ProseBlock
	| ThinkingBlock
	| ToolBlock
	| NoteBlock
	| RoundSeparatorBlock;

/**
 * A live `wait_for_worker` that has not returned, summarised for the pinned
 * row at the foot of the detail pane.
 */
export interface WaitingSummary {
	/** How long the supervisor has been parked in the current wait. */
	readonly elapsedMs: number;
	/** Consecutive waits observed since the last worker reply. */
	readonly consecutive: number;
	/** Cap from policy, when known. */
	readonly maxConsecutive?: number;
}

export interface TranscriptModel {
	readonly blocks: readonly TranscriptBlock[];
	/**
	 * The live wait, when the supervisor is currently parked in one. Absent
	 * when the newest wait already returned: a resolved wait is history, and
	 * pinning it would claim the fork is still waiting.
	 */
	readonly waiting?: WaitingSummary;
	/** Collapsed `wait_for_worker` calls, for an honest count in the UI. */
	readonly collapsedWaits: number;
}

export interface BuildTranscriptModelOptions {
	readonly runShape: InProcessRunShape | undefined;
	readonly nowMs: number;
	/** Round boundaries, when the projection has them. */
	readonly rounds?: RunRoundProjection | undefined;
	readonly maxConsecutiveHeartbeats?: number | undefined;
	/**
	 * Whether the fork is still live.
	 *
	 * A wait is only live if the fork is. An interrupted `wait_for_worker`
	 * leaves a call with no result entry, so a fork that was cancelled or
	 * failed mid-wait looks identical to one still waiting when you read the
	 * transcript alone — and the overlay reported "waiting for worker"
	 * indefinitely for finished work (review finding OV-14).
	 *
	 * Defaults to `true` so an omitted flag keeps the previous behaviour for
	 * callers that genuinely only have a transcript.
	 */
	readonly entryIsLive?: boolean;
}

/** Tool name for an entry, falling back to parsing `name(` out of the text. */
export function toolNameOf(entry: TranscriptEntry): string {
	if (typeof entry.toolName === "string" && entry.toolName.length > 0) return entry.toolName;
	return /^([A-Za-z0-9_\-.]+)\(/.exec(entry.text)?.[1] ?? "tool";
}

/** Argument text between the outermost parentheses of a call. */
export function argsOf(entry: TranscriptEntry): string | undefined {
	const open = entry.text.indexOf("(");
	const close = entry.text.lastIndexOf(")");
	if (open < 0 || close <= open + 1) return undefined;
	const args = entry.text.slice(open + 1, close).trim();
	return args.length > 0 ? args : undefined;
}

/** Result text with a leading `toolName:` label removed. */
export function outputOf(entry: TranscriptEntry): string | undefined {
	const text = entry.text.replace(/^[A-Za-z0-9_\-.]+:\s*/, "").trim();
	return text.length > 0 ? text : undefined;
}

/**
 * Build the block model.
 *
 * Tool results are folded into their call, so a result never becomes a block
 * of its own; it supplies the call's state, duration, and output.
 */
export function buildTranscriptModel(
	entries: readonly TranscriptEntry[],
	options: BuildTranscriptModelOptions,
): TranscriptModel {
	const blocks: TranscriptBlock[] = [];
	if (entries.length === 0) return { blocks, collapsedWaits: 0 };

	const resultByCallId = new Map<string, { entry: TranscriptEntry; index: number }>();
	for (const [index, entry] of entries.entries()) {
		if (entry.role === "toolResult" && entry.toolCallId !== undefined) {
			resultByCallId.set(entry.toolCallId, { entry, index });
		}
	}

	// Round separators are keyed by the entry they precede, so they interleave
	// without a second ordering pass.
	const roundAt = new Map<number, RunRound>();
	for (const round of options.rounds?.rounds ?? []) roundAt.set(round.askEntryIndex, round);

	const newestProseIndex = findNewestProse(entries);

	let collapsedWaits = 0;
	let consecutiveWaits = 0;
	let liveWait: { startedAt: number | undefined } | undefined;

	for (const [index, entry] of entries.entries()) {
		const round = roundAt.get(index);
		if (round !== undefined) {
			blocks.push({
				kind: "round",
				entryIndex: index,
				index: round.index,
				toolCount: round.workerToolCount,
				errorCount: round.workerErrorCount,
				resolution: round.resolution,
				...(round.firstTimestamp === undefined ? {} : { timestamp: round.firstTimestamp }),
			});
		}

		if (entry.role === "toolResult") continue;
		const speaker = transcriptSpeaker(entry, options.runShape);

		if (entry.role === "user" || entry.role === "assistant") {
			// A worker reply ends the wait the supervisor was in.
			consecutiveWaits = 0;
			liveWait = undefined;
			blocks.push({
				kind: "prose",
				entryIndex: index,
				speaker,
				heading: speakerHeading(entry, options.runShape),
				text: entry.text,
				newest: index === newestProseIndex,
				...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
			});
			continue;
		}

		if (entry.role === "thinking") {
			blocks.push({
				kind: "thinking",
				entryIndex: index,
				speaker,
				source: entry.source,
				text: entry.text,
			});
			continue;
		}

		if (entry.role === "toolCall") {
			const name = toolNameOf(entry);
			const paired = entry.toolCallId === undefined
				? undefined
				: resultByCallId.get(entry.toolCallId);

			if (name === WAIT_TOOL_NAME) {
				// Collapsed rather than dropped: the count is reported, and a
				// still-open wait becomes the pinned live row.
				collapsedWaits += 1;
				consecutiveWaits += 1;
				liveWait = paired === undefined ? { startedAt: entry.timestamp } : undefined;
				continue;
			}

			const durationMs = paired?.entry.timestamp !== undefined && entry.timestamp !== undefined
				? paired.entry.timestamp - entry.timestamp
				: undefined;
			const output = paired === undefined ? undefined : outputOf(paired.entry);
			const args = argsOf(entry);
			blocks.push({
				kind: "tool",
				entryIndex: index,
				speaker,
				name,
				state: paired === undefined ? "pending" : paired.entry.isError === true ? "error" : "ok",
				...(entry.toolMeta === undefined ? {} : { meta: entry.toolMeta }),
				...(args === undefined ? {} : { args }),
				...(durationMs === undefined ? {} : { durationMs }),
				...(output === undefined ? {} : { output }),
				...(paired === undefined ? {} : { resultEntryIndex: paired.index }),
			});
			continue;
		}

		blocks.push({ kind: "note", entryIndex: index, speaker, text: entry.text });
	}

	// A terminal fork is not waiting for anything, whatever its last entry says.
	if (liveWait === undefined || options.entryIsLive === false) {
		return { blocks, collapsedWaits };
	}
	const elapsedMs = liveWait.startedAt === undefined
		? 0
		: Math.max(0, options.nowMs - liveWait.startedAt);
	return {
		blocks,
		collapsedWaits,
		waiting: {
			elapsedMs,
			consecutive: consecutiveWaits,
			...(options.maxConsecutiveHeartbeats === undefined
				? {}
				: { maxConsecutive: options.maxConsecutiveHeartbeats }),
		},
	};
}

/** Index of the newest prose entry, or `-1`. */
function findNewestProse(entries: readonly TranscriptEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const role = entries[index]!.role;
		if (role === "user" || role === "assistant") return index;
	}
	return -1;
}
