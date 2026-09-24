/**
 * Pure custom-range parsing and granularity-satisfiability checks for the
 * subscription-value report projection.
 *
 * Every export here is read-only and side-effect free: no file I/O, no clock
 * reads (`nowMs` and retained-granularity facts are always caller-supplied),
 * and no `process.exit`. The eventual standalone CLI maps
 * {@link ReportRangeResult.exitCode} onto its own process exit; this module
 * only ever returns that code as data.
 *
 * A custom bound is either an ISO date `YYYY-MM-DD` (resolved to local
 * midnight in the supplied report timezone) or a full RFC 3339 timestamp with
 * an explicit `Z` or numeric offset. An offsetless date-time, a bare
 * year-month, or any other shape is rejected as invalid syntax. The
 * resolved range is start-inclusive and end-exclusive.
 */

import { getPeriodBounds, resolveZonedInstant, type PeriodType } from "./period-boundaries.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const OFFSET_DATETIME_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const OFFSETLESS_DATETIME_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;

type BoundParseResult =
	| { readonly ok: true; readonly ms: number }
	| { readonly ok: false; readonly reason: string };

function parseBound(raw: string, timeZone: string): BoundParseResult {
	if (raw.length === 0) {
		return { ok: false, reason: "a custom range bound must not be empty." };
	}
	if (DATE_ONLY_PATTERN.test(raw)) {
		const [yearRaw, monthRaw, dayRaw] = raw.split("-");
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		if (month < 1 || month > 12 || day < 1 || day > 31) {
			return { ok: false, reason: `"${raw}" is not a valid ISO date.` };
		}
		try {
			return {
				ok: true,
				ms: resolveZonedInstant({ year, month: month - 1, day }, timeZone),
			};
		} catch (error) {
			return { ok: false, reason: (error as Error).message };
		}
	}
	if (OFFSET_DATETIME_PATTERN.test(raw)) {
		const ms = Date.parse(raw);
		if (!Number.isFinite(ms)) {
			return { ok: false, reason: `"${raw}" is not a valid RFC 3339 timestamp.` };
		}
		return { ok: true, ms };
	}
	if (OFFSETLESS_DATETIME_PATTERN.test(raw)) {
		return {
			ok: false,
			reason: `"${raw}" is an offsetless date-time; supply "Z" or a numeric UTC offset.`,
		};
	}
	return {
		ok: false,
		reason: `"${raw}" is not a supported ISO date (YYYY-MM-DD) or RFC 3339 timestamp.`,
	};
}

/**
 * The finest granularity actually retained over one sub-interval of history.
 * `"raw"` means per-observation precision (any instant is a valid boundary);
 * every other value is a {@link PeriodType} whose own period boundaries are
 * the finest safely-sliceable instants in that sub-interval.
 */
export type RetainedGranularity = "raw" | PeriodType;

export interface GranularitySegment {
	readonly startMs: number;
	readonly endMs: number;
	readonly granularity: RetainedGranularity;
}

export type RangeSatisfiability =
	| { readonly status: "satisfiable" }
	| { readonly status: "unsatisfiable"; readonly reason: string };

function alignsToGranularity(instantMs: number, granularity: RetainedGranularity): boolean {
	if (granularity === "raw") return true;
	return getPeriodBounds(instantMs, granularity).startMs === instantMs;
}

/**
 * Checks whether `range` can be reported without slicing a coarser retained
 * rollup to fabricate detail it never recorded. `segments` describes the
 * caller's own retained-state facts: which sub-intervals of history are only
 * available at which granularity. A range whose start or end instant falls
 * inside a segment but does not land on that segment's own granularity
 * boundary, or that reaches outside every supplied segment, is unsatisfiable.
 * An empty range (`endMs <= startMs`) is trivially satisfiable.
 */
export function assertRangeSatisfiable(
	range: { readonly startMs: number; readonly endMs: number },
	segments: readonly GranularitySegment[],
): RangeSatisfiability {
	if (range.endMs <= range.startMs) return { status: "satisfiable" };
	const startSegment = segments.find(
		(segment) => range.startMs >= segment.startMs && range.startMs < segment.endMs,
	);
	if (startSegment === undefined) {
		return {
			status: "unsatisfiable",
			reason: "the range start falls outside every retained interval.",
		};
	}
	if (!alignsToGranularity(range.startMs, startSegment.granularity)) {
		return {
			status: "unsatisfiable",
			reason: `the range start is not aligned to the retained "${startSegment.granularity}" granularity.`,
		};
	}
	const endSegment = segments.find(
		(segment) => range.endMs > segment.startMs && range.endMs <= segment.endMs,
	);
	if (endSegment === undefined) {
		return {
			status: "unsatisfiable",
			reason: "the range end falls outside every retained interval.",
		};
	}
	if (!alignsToGranularity(range.endMs, endSegment.granularity)) {
		return {
			status: "unsatisfiable",
			reason: `the range end is not aligned to the retained "${endSegment.granularity}" granularity.`,
		};
	}
	return { status: "satisfiable" };
}

export interface ReportRangeInvalid {
	readonly status: "invalid";
	readonly exitCode: 2;
	readonly reason: string;
}

export interface ReportRangeUnsatisfiable {
	readonly status: "unsatisfiable";
	readonly exitCode: 3;
	readonly reason: string;
}

export interface ReportRangeResolved {
	readonly status: "resolved";
	readonly exitCode: 0;
	readonly startMs: number;
	readonly endMs: number;
}

/**
 * A discriminated projection result, never a process exit. The standalone
 * CLI node maps {@link ReportRangeResult.exitCode} onto its own process exit
 * (2 for invalid syntax, 3 for unsatisfiable precision, 0 for a resolved,
 * reportable range -- which may still describe a truthful empty window).
 */
export type ReportRangeResult =
	| ReportRangeInvalid
	| ReportRangeUnsatisfiable
	| ReportRangeResolved;

/**
 * Resolves one custom `--from`/`--to` request. `retainedGranularity`, when
 * supplied, is checked with {@link assertRangeSatisfiable}; omitting it skips
 * the satisfiability check (useful when a caller only wants syntax
 * validation). The range is start-inclusive and end-exclusive; `from` equal
 * to `to` resolves to a valid, explicitly empty range rather than an error.
 */
export function resolveCustomRange(input: {
	readonly fromRaw: string;
	readonly toRaw: string;
	readonly timeZone?: string;
	readonly retainedGranularity?: readonly GranularitySegment[];
}): ReportRangeResult {
	const timeZone = input.timeZone ?? "UTC";
	const from = parseBound(input.fromRaw, timeZone);
	if (!from.ok) return { status: "invalid", exitCode: 2, reason: from.reason };
	const to = parseBound(input.toRaw, timeZone);
	if (!to.ok) return { status: "invalid", exitCode: 2, reason: to.reason };
	if (to.ms < from.ms) {
		return {
			status: "invalid",
			exitCode: 2,
			reason: "the range end must not precede its start.",
		};
	}
	const range = { startMs: from.ms, endMs: to.ms };
	if (input.retainedGranularity !== undefined) {
		const satisfiability = assertRangeSatisfiable(range, input.retainedGranularity);
		if (satisfiability.status === "unsatisfiable") {
			return { status: "unsatisfiable", exitCode: 3, reason: satisfiability.reason };
		}
	}
	return { status: "resolved", exitCode: 0, startMs: range.startMs, endMs: range.endMs };
}
