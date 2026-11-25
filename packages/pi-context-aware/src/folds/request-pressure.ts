/**
 * One context-pressure value per model request (pi-context-aware#461).
 *
 * The fold pass counts the request it builds: Pi's view with the active folds applied, before this pass
 * truncates or hides anything and without the injection it adds, and not below Pi's last measured size less
 * what a newer fold has reclaimed. It is the metrics record's `tokensBefore`; the view actually sent is
 * `tokensAfter`. That count is the request's pressure, and every consumer reads it: the action line merged into the fold nudge, proactive compaction and
 * the owed-compaction retry, the check-in, the metrics record, `context_status`, `/context-status`, the footer,
 * the compaction owner and the context service. When the fold pass does not run (shadow mode, or a pass that
 * failed), the request is Pi's own view, and Pi's measured usage is its count.
 *
 * Nothing here is persisted: the action line rides in the request only, so it never becomes part of the
 * session and is gone from the next request.
 */

import type { EntryPressure } from "../compaction/entry-pressure.js";
import type { UsageView } from "../compaction/usage-view.js";
import { contextAwarePressureBandEdgesV1 } from "../context-service.js";
import type { PressureTelemetryMode } from "../platform/config-layers.js";
import { contextBand, EXTENSION_NOTE_LABEL } from "../platform/context-telemetry.js";
import { DEFAULT_PRESSURE_LADDER, type PressureLadderConfig } from "../policy/context-policy.js";
import { COMPACT_TOOL_NAME, type NudgeTools } from "./nudge-tools.js";

export type RequestPressureBand = "OK" | "WARN" | "URGENT" | "UNKNOWN";

/**
 * The customType of the usage marker that sessions saved before pi-context-aware#461 persisted on every outer turn.
 * Its band described the context of that turn, so a resumed session must not send it as the newest pressure
 * statement. It stays in the session file and in the display; only the request leaves it out.
 */
export const RETIRED_USAGE_MARKER_TYPE = "context-aware-usage-marker";

const isRetiredUsageMarker = (message: unknown): boolean =>
	typeof message === "object" && message !== null
	&& (message as { role?: unknown }).role === "custom"
	&& (message as { customType?: unknown }).customType === RETIRED_USAGE_MARKER_TYPE;

/** The request without retired usage markers; the same array when it holds none, or when it is not an array. */
export function withoutRetiredUsageMarkers<T>(messages: T[]): T[] {
	if (!Array.isArray(messages) || !messages.some(isRetiredUsageMarker)) return messages;
	return messages.filter((message) => !isRetiredUsageMarker(message));
}

/**
 * The pressure of one request. A `UsageView`, so compaction decisions narrow it with `measuredUsage` as
 * before: `unmeasured` is set when Pi had not measured the size behind the count (right after a
 * compaction or an overflow recovery), and proactive compaction then waits (#168).
 */
export type RequestPressure = UsageView & {
	/** `UNKNOWN` only when nothing counted the request: no fold pass and no measured size. */
	readonly band: RequestPressureBand;
	/** `fold-pass`: the fold pass counted the request it built. `host`: Pi's usage, the request being Pi's own view. */
	readonly source: "fold-pass" | "host";
	/**
	 * Set only when the entries on the branch since the last compaction have reached their limit
	 * (pi-context-aware#441). A counted request is then URGENT at any token count, and the action line names
	 * the entry count as the reason; an UNKNOWN one stays UNKNOWN and sends no line, but still carries the
	 * count for the footer. A fold hides an entry but leaves it on the path Pi rebuilds, so only a
	 * compaction lowers this count.
	 */
	readonly entries?: EntryPressure;
};

export interface RequestPressureInput {
	readonly tokens: number;
	readonly window: number;
	/** Pi measured the size behind `tokens`. */
	readonly measured: boolean;
	readonly source: RequestPressure["source"];
	/** The branch's entry count against its limit, or null when the check is off (pi-context-aware#441). */
	readonly entries?: EntryPressure | null;
}

/**
 * The request's pressure on the ladder in force. The fold pass always has a count of the request it builds,
 * so its band is never `UNKNOWN`, even before Pi has measured the size again. A host count that Pi has
 * not measured is `UNKNOWN`.
 */
export function requestPressure(input: RequestPressureInput, ladder: PressureLadderConfig = DEFAULT_PRESSURE_LADDER): RequestPressure {
	const tokens = Math.max(0, input.tokens);
	const window = input.window;
	const fraction = window > 0 ? tokens / window : 0;
	const sized = { tokens, window, fraction, headroom: Math.max(0, window - tokens) };
	const sizeBand: RequestPressureBand = !input.measured && input.source === "host"
		? "UNKNOWN"
		: contextBand(fraction, contextAwarePressureBandEdgesV1(ladder));
	// The entry limit raises a counted request to URGENT; an UNKNOWN one stays UNKNOWN, as proactive
	// compaction also waits for a measured size (#168).
	const entries = input.entries?.exceeded ? input.entries : undefined;
	const band: RequestPressureBand = entries && sizeBand !== "UNKNOWN" ? "URGENT" : sizeBand;
	const raised = entries ? { entries } : {};
	return input.measured
		? { ...sized, band, source: input.source, ...raised }
		: { ...sized, unmeasured: true, band, source: input.source, ...raised };
}

function formatHeadroom(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.max(0, Math.round(n)));
}

export interface PressureActionOptions {
	/** `pressureTelemetry.mode`: `full` shows the band, percent and headroom, `band` the band only, `off` no line. */
	readonly mode: PressureTelemetryMode;
	/** The context tools this session can call now; the line names only those. */
	readonly tools: NudgeTools;
	readonly foldTool: string;
	/**
	 * How the model calls the tool that still reduces context when another package cancels every compaction,
	 * such as billion-context-pi's `compress`; named only when neither context tool is reachable.
	 */
	readonly replacementTool?: string;
}

/**
 * The one action line for a WARN or URGENT request; `undefined` at OK, at UNKNOWN, and when the mode is `off`.
 *
 * UNKNOWN sends nothing: it occurs only right after a compaction or an overflow recovery, when the context
 * was just reduced, and on the next request Pi has measured the size again. Pi's own overflow recovery
 * still applies meanwhile.
 */
export function pressureActionLine(pressure: RequestPressure, options: PressureActionOptions): string | undefined {
	if (options.mode === "off") return undefined;
	if (pressure.band !== "WARN" && pressure.band !== "URGENT") return undefined;
	const fold = "`" + options.foldTool + "`";
	const compact = "`" + COMPACT_TOOL_NAME + "`";
	const sizeFigures = `${Math.round(pressure.fraction * 100)}% used, about ${formatHeadroom(pressure.headroom)} tokens of headroom`;
	// A raised band names its cause, so URGENT beside a low percentage is not read as a mistake (pi-context-aware#441).
	const entries = pressure.entries;
	const figures = entries
		? options.mode === "full"
			? ` (${entries.entriesSinceCompaction} entries since the last compaction, at the limit of ${entries.limit}; ${sizeFigures})`
			: " (entry count at its limit)"
		: options.mode === "full"
			? ` (${sizeFigures})`
			: "";
	// The line labels itself: it arrives with role `user`, and the rule that explains it reaches only sessions
	// that can call `context_compact`.
	const head = `${EXTENSION_NOTE_LABEL} Context pressure ${pressure.band}${figures}.`;
	if (pressure.band === "WARN") {
		const steps = [
			"keep the next action small",
			...(options.tools.fold ? [`fold finished ranges with ${fold}`] : []),
			...(options.tools.compact ? [`call ${compact} at a clean boundary`] : []),
			...(!options.tools.fold && !options.tools.compact && options.replacementTool ? [`call ${options.replacementTool} on finished, older ranges`] : []),
			"delegate bounded work",
		];
		return `${head} Before broad reads, long test loops or a phase switch, ${steps.slice(0, -1).join(", ")}, or ${steps.at(-1)}.`;
	}
	if (options.tools.compact) return `${head} Before the next nontrivial tool call, call ${compact}, unless you are finishing one atomic edit or validation that is unsafe to interrupt.`;
	// Folding adds entries rather than removing them, so at the entry limit only a compaction helps.
	if (entries) return `${head} Only a compaction lowers this count, and none can be called here. Finish only the atomic edit or validation in progress, keep every further action small, and tell the user that the session needs a compaction.`;
	if (options.tools.fold) return `${head} Before the next nontrivial tool call, fold finished, older ranges with ${fold}, unless you are finishing one atomic edit or validation that is unsafe to interrupt.`;
	if (options.replacementTool) return `${head} Before the next nontrivial tool call, call ${options.replacementTool} on finished, older ranges, unless you are finishing one atomic edit or validation that is unsafe to interrupt.`;
	return `${head} Finish only the atomic edit or validation in progress, keep every further action small, and tell the user that context is nearly full.`;
}
