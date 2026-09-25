/**
 * Who is speaking in a transcript entry, and how that is worded.
 *
 * Extracted from `transcript-overlay.ts` so the transcript block model can use
 * it without importing the renderer, which would be a cycle. The rules are
 * unchanged; only their home is new.
 *
 * The heading rule is shape-aware on purpose. A direct or chain run has no
 * supervisor, and naming one would describe an actor the run does not have
 * (issue #198).
 */

import type { DelegateDispatchState } from "./runtime.js";
import type { TranscriptEntry } from "./summarize.js";

export type TranscriptSpeaker = "you" | "main" | "supervisor" | "worker" | "run";

/** Only explicit supervised runs have a supervisor session. */
export function runHasSupervisor(runShape: string | undefined): boolean {
	return runShape === "supervised";
}

/** Only explicit supervised runs support steering. */
export function runSupportsSteering(
	run: Pick<DelegateDispatchState, "shape"> | undefined,
): boolean {
	return run !== undefined && runHasSupervisor(run.shape);
}

/** Resolve the real speaker for an entry. Pure; exported for unit testing. */
export function transcriptSpeaker(
	entry: Pick<TranscriptEntry, "source" | "role">,
	runShape?: string,
): TranscriptSpeaker {
	// Unknown shape/source/role combinations are not attributable to a worker.
	// Return the canonical neutral run bucket; the heading remains `unknown`, so
	// this never invents a main-thread, supervisor, or worker audience.
	if (runShape !== "supervised" && runShape !== "direct" && runShape !== "chain") return "run";
	if (runShape === "direct" || runShape === "chain") {
		if (entry.role === "user") return "main";
		return entry.source === "worker" ? "worker" : "main";
	}
	if (entry.source === "supervisor") return entry.role === "user" ? "you" : "supervisor";
	return entry.role === "user" ? "supervisor" : "worker";
}

/** Speaker → audience heading shown above a message node. */
export function speakerHeading(
	entry: Pick<TranscriptEntry, "source" | "role">,
	runShape?: string,
): string {
	if (runShape !== "supervised" && runShape !== "direct" && runShape !== "chain") return "unknown";
	switch (transcriptSpeaker(entry, runShape)) {
		case "you":
			return "you \u2192 supervisor";
		case "main":
			return entry.role === "user" ? "main thread \u2192 worker" : "main thread";
		case "supervisor":
			// A `user` entry in the worker session IS the supervisor addressing the
			// worker; the supervisor's own assistant prose addresses the main thread.
			return entry.source === "worker" ? "supervisor \u2192 worker" : "supervisor";
		case "worker":
			return entry.role === "assistant"
				? runHasSupervisor(runShape) ? "worker \u2192 supervisor" : "worker \u2192 main thread"
				: "worker";
	}
}

/** Heading colour per speaker. The wording carries the meaning without colour. */
export const SPEAKER_COLOR: Record<TranscriptSpeaker, "warning" | "accent" | "success" | "dim"> = {
	you: "warning",
	main: "warning",
	supervisor: "accent",
	worker: "success",
	run: "dim",
};
