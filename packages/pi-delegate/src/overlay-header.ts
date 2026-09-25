/**
 * The overlay header — what the selected worker *is*, and what it was
 * *allowed to do*.
 *
 * The previous header spent four rows on navigation: run id, run counter,
 * shape, live state, entry count, current view name, and a numbered entry list.
 * The left column now answers every one of those, so the space goes to the two
 * questions the overlay could never answer (epic #326).
 *
 * Pure and total. Produces tone-tagged segments rather than themed strings, so
 * the renderer owns colour and this module stays testable without a theme.
 */

import { runEntryDisplayLabel, shouldShowAgentSuffix } from "./fork-label.js";
import { getDelegatePresentationTerminology } from "./footer-presentation.js";
import type { RunLiveState } from "./runtime.js";

/**
 * Colour role for one segment.
 *
 * These are pi theme colour names, so the renderer can pass them straight to
 * `theme.fg` without a translation table that could drift out of step.
 */
export type HeaderTone = "text" | "dim" | "accent" | "muted" | "warning" | "success" | "error";

export interface HeaderSegment {
	readonly text: string;
	readonly tone: HeaderTone;
	/** Rendered bold by the renderer. */
	readonly bold?: true;
}

/** The separator placed between header facts. */
export const HEADER_SEPARATOR: HeaderSegment = { text: " · ", tone: "dim" };

function join(parts: readonly HeaderSegment[][]): HeaderSegment[] {
	const out: HeaderSegment[] = [];
	for (const part of parts) {
		if (part.length === 0) continue;
		if (out.length > 0) out.push(HEADER_SEPARATOR);
		out.push(...part);
	}
	return out;
}

/** Flatten segments to plain text. Exported for tests and width budgeting. */
export function headerText(segments: readonly HeaderSegment[]): string {
	return segments.map((segment) => segment.text).join("");
}

/** `3m 21s` / `2h 4m` — compact, and never longer than it has to be. */
export function formatHeaderElapsed(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/**
 * Model reference as the header shows it.
 *
 * The resolved reference wins: it is what actually ran. A requested reference
 * that never resolved is still worth showing — a run entry that failed during model
 * selection would otherwise name no model at all.
 */
export function headerModel(entry: RunLiveState): { text: string; resolved: boolean } | undefined {
	const resolved = typeof entry.resolvedModel === "string" ? entry.resolvedModel.trim() : "";
	if (resolved.length > 0) return { text: resolved, resolved: true };
	const requested = typeof entry.requestedModel === "string" ? entry.requestedModel.trim() : "";
	if (requested.length > 0) return { text: requested, resolved: false };
	return undefined;
}

/**
 * Line 1 — identity: who is running, on what model, in what shape, how far in.
 *
 * The status glyph is prepended by the renderer, which owns the existing
 * `statusGlyph` mapping.
 */
export function buildIdentitySegments(
	entry: RunLiveState,
	shape: string | undefined,
	nowMs: number,
): HeaderSegment[] {
	const label = runEntryDisplayLabel(entry);
	const agent = typeof entry.agent === "string" ? entry.agent : "";
	const identity: HeaderSegment[] = shouldShowAgentSuffix(label, agent)
		? [
			{ text: agent, tone: "text" },
			{ text: "(", tone: "dim" },
			{ text: label, tone: "text", bold: true },
			{ text: ")", tone: "dim" },
		]
		: [{ text: label, tone: "text", bold: true }];

	const model = headerModel(entry);
	const modelPart: HeaderSegment[] = model
		? [{ text: model.text, tone: model.resolved ? "accent" : "dim" }]
		: [];

	const shapePart: HeaderSegment[] = [{ text: getDelegatePresentationTerminology(shape).label, tone: "text" }];

	// A direct or chain entry is structurally 1/1, so a round counter says
	// nothing for it — the same rule the entry list already applied.
	const roundsPart: HeaderSegment[] = shape === "supervised"
		? [
			{ text: "round ", tone: "dim" },
			{ text: `${entry.currentRound}/${entry.maxRounds}`, tone: "text", bold: true },
		]
		: [];

	const elapsed = formatHeaderElapsed(
		entry.startedAt === undefined
			? undefined
			: (entry.endedAt ?? nowMs) - entry.startedAt,
	);
	const elapsedPart: HeaderSegment[] = elapsed ? [{ text: elapsed, tone: "text" }] : [];

	return join([identity, modelPart, shapePart, roundsPart, elapsedPart]);
}

/**
 * Line 2 — policy: what this worker was actually allowed to do.
 *
 * Read-only is stated first and coloured, because it is the one policy fact
 * that changes how you read everything below it. A run entry with no policy facts
 * at all returns a single dim placeholder rather than an empty row, so the
 * header keeps a stable height.
 */
export function buildPolicySegments(entry: RunLiveState): HeaderSegment[] {
	const parts: HeaderSegment[][] = [];

	if (entry.readOnly === true) {
		parts.push([{ text: "read-only", tone: "warning" }]);
	} else if (typeof entry.workerCwd === "string" && entry.workerCwd.length > 0) {
		parts.push([
			{ text: "writes ", tone: "dim" },
			{ text: entry.workerCwd, tone: "text" },
		]);
	}

	if (entry.confineWrites === true) {
		parts.push([{ text: "confined", tone: "warning" }]);
	}

	if (typeof entry.workerBranch === "string" && entry.workerBranch.length > 0) {
		parts.push([
			{ text: "branch ", tone: "dim" },
			{ text: entry.workerBranch, tone: "text" },
		]);
	}

	const skills = Array.isArray(entry.skills)
		? entry.skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0)
		: [];
	if (skills.length > 0) {
		parts.push([
			{ text: "skills ", tone: "dim" },
			{ text: skills.join(", "), tone: "text" },
		]);
	}

	if (typeof entry.cloneMode === "string" && entry.cloneMode.length > 0) {
		parts.push([
			{ text: "clone ", tone: "dim" },
			{ text: entry.cloneMode, tone: "text" },
		]);
	}

	const heartbeat = formatHeartbeatPolicy(entry);
	if (heartbeat) {
		parts.push([
			{ text: "heartbeat ", tone: "dim" },
			{ text: heartbeat, tone: "text" },
		]);
	}

	const joined = join(parts);
	return joined.length > 0 ? joined : [{ text: "no policy constraints recorded", tone: "dim" }];
}

/**
 * `3m×5` — interval and the consecutive-heartbeat cap that bounds it.
 *
 * An explicit `0` interval disables the heartbeat entirely and is reported as
 * `off`; that is a real policy fact, not a missing one.
 */
export function formatHeartbeatPolicy(entry: RunLiveState): string | undefined {
	const interval = entry.heartbeatIntervalMs;
	if (interval === undefined || !Number.isFinite(interval)) return undefined;
	if (interval <= 0) return "off";
	const seconds = Math.round(interval / 1000);
	const readable = seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
	const max = entry.maxConsecutiveHeartbeats;
	return max !== undefined && Number.isFinite(max) && max > 0 ? `${readable}×${max}` : readable;
}
