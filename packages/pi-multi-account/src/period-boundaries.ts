export const PERIOD_TYPES = [
	"day",
	"week",
	"month",
	"quarter",
	"half-year",
	"year",
] as const;

export type PeriodType = (typeof PERIOD_TYPES)[number];

export interface PeriodBounds {
	readonly startMs: number;
	readonly endMs: number;
}

/** More than 27 years of daily rows; a corrupt timestamp cannot walk forever. */
export const DEFAULT_PERIOD_ITERATION_CAP = 10_000;

export class PeriodEnumerationLimitError extends RangeError {
	constructor(periodType: PeriodType, maxIterations: number) {
		super(
			`Calendar ${periodType} enumeration exceeded ${maxIterations} iterations.`,
		);
		this.name = "PeriodEnumerationLimitError";
	}
}

function assertFiniteTimestamp(value: number, name: string): void {
	if (!Number.isFinite(value)) {
		throw new RangeError(`${name} must be a finite timestamp.`);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new RangeError(`${name} is outside the supported date range.`);
	}
}

function utcMonthBounds(
	year: number,
	startMonth: number,
	months: number,
): PeriodBounds {
	return {
		startMs: Date.UTC(year, startMonth, 1),
		endMs: Date.UTC(year, startMonth + months, 1),
	};
}

/** The pre-existing UTC-only implementation, kept byte-identical so every caller that omits a timezone sees no change. */
function getUtcPeriodBounds(instantMs: number, periodType: PeriodType): PeriodBounds {
	const date = new Date(instantMs);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();

	switch (periodType) {
		case "day":
			return {
				startMs: Date.UTC(year, month, day),
				endMs: Date.UTC(year, month, day + 1),
			};
		case "week": {
			const mondayOffset = (date.getUTCDay() + 6) % 7;
			return {
				startMs: Date.UTC(year, month, day - mondayOffset),
				endMs: Date.UTC(year, month, day - mondayOffset + 7),
			};
		}
		case "month":
			return utcMonthBounds(year, month, 1);
		case "quarter":
			return utcMonthBounds(year, Math.floor(month / 3) * 3, 3);
		case "half-year":
			return utcMonthBounds(year, Math.floor(month / 6) * 6, 6);
		case "year":
			return utcMonthBounds(year, 0, 12);
		default: {
			const exhaustive: never = periodType;
			throw new TypeError(`Unsupported period type: ${String(exhaustive)}`);
		}
	}
}

interface ZonedCalendarParts {
	readonly year: number;
	/** Zero-based, matching `Date.UTC`'s month argument. */
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	/** ISO weekday index: 0 = Monday .. 6 = Sunday. */
	readonly isoWeekdayIndex: number;
}

const ISO_WEEKDAY_INDEX: Readonly<Record<string, number>> = {
	Mon: 0,
	Tue: 1,
	Wed: 2,
	Thu: 3,
	Fri: 4,
	Sat: 5,
	Sun: 6,
};

const ZONED_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = ZONED_FORMATTER_CACHE.get(timeZone);
	if (cached !== undefined) return cached;
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "short",
		});
	} catch {
		throw new RangeError(`"${timeZone}" is not a supported IANA timezone.`);
	}
	ZONED_FORMATTER_CACHE.set(timeZone, formatter);
	return formatter;
}

function zonedCalendarParts(instantMs: number, timeZone: string): ZonedCalendarParts {
	const parts = zonedFormatter(timeZone).formatToParts(new Date(instantMs));
	const byType: Record<string, string> = {};
	for (const part of parts) byType[part.type] = part.value;
	const isoWeekdayIndex = ISO_WEEKDAY_INDEX[byType.weekday ?? ""];
	if (
		byType.year === undefined ||
		byType.month === undefined ||
		byType.day === undefined ||
		byType.hour === undefined ||
		byType.minute === undefined ||
		byType.second === undefined ||
		isoWeekdayIndex === undefined
	) {
		throw new RangeError(
			`Unable to resolve calendar parts for timezone "${timeZone}".`,
		);
	}
	return {
		year: Number(byType.year),
		month: Number(byType.month) - 1,
		day: Number(byType.day),
		// A rare ICU quirk renders local midnight as hour "24" under h23; normalize it.
		hour: byType.hour === "24" ? 0 : Number(byType.hour),
		minute: Number(byType.minute),
		second: Number(byType.second),
		isoWeekdayIndex,
	};
}

export interface ZonedCalendarInstant {
	readonly year: number;
	/** Zero-based, matching `Date.UTC`'s month argument; may overflow (e.g. -1 or 12) to roll into an adjacent year. */
	readonly month: number;
	readonly day: number;
	readonly hour?: number;
	readonly minute?: number;
	readonly second?: number;
	readonly millisecond?: number;
}

/**
 * Resolves wall-clock calendar components in `timeZone` to the UTC instant
 * (epoch ms) that displays as those components in that zone. Uses the
 * standard fixed-point iteration: guess the instant assuming UTC, measure how
 * far its zoned rendering drifts from the target, and correct. Two iterations
 * converge for every ordinary offset change; the loop is capped so a
 * pathological zone cannot spin forever.
 */
export function resolveZonedInstant(
	instant: ZonedCalendarInstant,
	timeZone: string,
): number {
	const ms = instant.millisecond ?? 0;
	const target = Date.UTC(
		instant.year,
		instant.month,
		instant.day,
		instant.hour ?? 0,
		instant.minute ?? 0,
		instant.second ?? 0,
		ms,
	);
	if (timeZone === "UTC") return target;
	let guess = target;
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const zoned = zonedCalendarParts(guess, timeZone);
		const zonedAsUtc = Date.UTC(
			zoned.year,
			zoned.month,
			zoned.day,
			zoned.hour,
			zoned.minute,
			zoned.second,
			ms,
		);
		const offsetMs = zonedAsUtc - guess;
		const next = target - offsetMs;
		if (next === guess) return next;
		guess = next;
	}
	return guess;
}

function zonedMonthBounds(
	year: number,
	startMonth: number,
	months: number,
	timeZone: string,
): PeriodBounds {
	return {
		startMs: resolveZonedInstant({ year, month: startMonth, day: 1 }, timeZone),
		endMs: resolveZonedInstant(
			{ year, month: startMonth + months, day: 1 },
			timeZone,
		),
	};
}

function getZonedPeriodBounds(
	instantMs: number,
	periodType: PeriodType,
	timeZone: string,
): PeriodBounds {
	const local = zonedCalendarParts(instantMs, timeZone);
	switch (periodType) {
		case "day":
			return {
				startMs: resolveZonedInstant(
					{ year: local.year, month: local.month, day: local.day },
					timeZone,
				),
				endMs: resolveZonedInstant(
					{ year: local.year, month: local.month, day: local.day + 1 },
					timeZone,
				),
			};
		case "week":
			return {
				startMs: resolveZonedInstant(
					{
						year: local.year,
						month: local.month,
						day: local.day - local.isoWeekdayIndex,
					},
					timeZone,
				),
				endMs: resolveZonedInstant(
					{
						year: local.year,
						month: local.month,
						day: local.day - local.isoWeekdayIndex + 7,
					},
					timeZone,
				),
			};
		case "month":
			return zonedMonthBounds(local.year, local.month, 1, timeZone);
		case "quarter":
			return zonedMonthBounds(
				local.year,
				Math.floor(local.month / 3) * 3,
				3,
				timeZone,
			);
		case "half-year":
			return zonedMonthBounds(
				local.year,
				Math.floor(local.month / 6) * 6,
				6,
				timeZone,
			);
		case "year":
			return zonedMonthBounds(local.year, 0, 12, timeZone);
		default: {
			const exhaustive: never = periodType;
			throw new TypeError(`Unsupported period type: ${String(exhaustive)}`);
		}
	}
}

/**
 * Assign an observation instant to a start-inclusive/end-exclusive calendar
 * period. `timeZone` is an IANA zone identifier and defaults to `"UTC"`; the
 * UTC path is untouched from the original implementation, so every caller
 * that omits it keeps its exact prior behavior. Account-cost allocation must
 * still split at UTC month boundaries regardless of this timezone -- see
 * {@link splitAtUtcMonthBoundaries}.
 */
export function getPeriodBounds(
	instantMs: number,
	periodType: PeriodType,
	timeZone: string = "UTC",
): PeriodBounds {
	assertFiniteTimestamp(instantMs, "instantMs");
	return timeZone === "UTC"
		? getUtcPeriodBounds(instantMs, periodType)
		: getZonedPeriodBounds(instantMs, periodType, timeZone);
}

/**
 * Splits `[startMs, endMs)` into contiguous, non-overlapping segments so that
 * no segment crosses a UTC calendar-month boundary. Always uses UTC months,
 * independent of any report display timezone: account-cost allocation must
 * never let the display timezone change its denominator.
 */
export function splitAtUtcMonthBoundaries(
	startMs: number,
	endMs: number,
): readonly PeriodBounds[] {
	assertFiniteTimestamp(startMs, "startMs");
	assertFiniteTimestamp(endMs, "endMs");
	if (endMs <= startMs) return [];
	const segments: PeriodBounds[] = [];
	let cursor = startMs;
	let iterations = 0;
	while (cursor < endMs) {
		iterations += 1;
		if (iterations > DEFAULT_PERIOD_ITERATION_CAP) {
			throw new PeriodEnumerationLimitError("month", DEFAULT_PERIOD_ITERATION_CAP);
		}
		const month = getUtcPeriodBounds(cursor, "month");
		const segmentEnd = Math.min(endMs, month.endMs);
		segments.push({ startMs: cursor, endMs: segmentEnd });
		cursor = segmentEnd;
	}
	return segments;
}

/**
 * Enumerate completed periods from the period containing the first observation.
 * The current partial period is excluded. Every stored-record-driven walk is
 * capped so malformed or far-future timestamps become a reportable error.
 */
export function enumerateCompletedPeriods(
	periodType: PeriodType,
	firstObservedAtMs: number,
	nowMs: number,
	options: { readonly maxIterations?: number; readonly timeZone?: string } = {},
): readonly PeriodBounds[] {
	assertFiniteTimestamp(firstObservedAtMs, "firstObservedAtMs");
	assertFiniteTimestamp(nowMs, "nowMs");
	const maxIterations =
		options.maxIterations ?? DEFAULT_PERIOD_ITERATION_CAP;
	if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
		throw new RangeError("maxIterations must be a positive safe integer.");
	}
	const timeZone = options.timeZone ?? "UTC";
	if (nowMs <= firstObservedAtMs) return [];

	const completed: PeriodBounds[] = [];
	let bounds = getPeriodBounds(firstObservedAtMs, periodType, timeZone);
	while (bounds.endMs <= nowMs) {
		if (completed.length >= maxIterations) {
			throw new PeriodEnumerationLimitError(periodType, maxIterations);
		}
		completed.push(bounds);
		const next = getPeriodBounds(bounds.endMs, periodType, timeZone);
		if (next.startMs !== bounds.endMs || next.endMs <= next.startMs) {
			throw new RangeError(`Calendar ${periodType} enumeration did not advance.`);
		}
		bounds = next;
	}
	return completed;
}
