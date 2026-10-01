import type { ModelThinkingLevel as PiModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Runtime copy of pi-ai's erased `ModelThinkingLevel` union, kept in the
 * SDK's ordering so range comparisons and user-facing descriptions agree.
 * The union cannot provide a runtime value, so the `satisfies` check plus the
 * exactness checks below make an SDK level change a typecheck failure instead
 * of a silently stale capability list.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly PiModelThinkingLevel[];
export type ThinkingLevel = PiModelThinkingLevel;

type MissingSdkThinkingLevels = Exclude<PiModelThinkingLevel, (typeof THINKING_LEVELS)[number]>;
type ExtraDelegateThinkingLevels = Exclude<(typeof THINKING_LEVELS)[number], PiModelThinkingLevel>;
type AssertNoThinkingLevelDrift<T extends never> = T;
type _NoMissingSdkThinkingLevels = AssertNoThinkingLevelDrift<MissingSdkThinkingLevels>;
type _NoExtraDelegateThinkingLevels = AssertNoThinkingLevelDrift<ExtraDelegateThinkingLevels>;

const THINKING_LEVEL_INDEX = new Map<ThinkingLevel, number>(
	THINKING_LEVELS.map((level, index) => [level, index]),
);

export interface NormalizedThinkingFields {
	thinking?: ThinkingLevel;
	thinkingMin?: ThinkingLevel;
	thinkingMax?: ThinkingLevel;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVEL_INDEX.has(value.trim().toLowerCase() as ThinkingLevel);
}

function normalizeLevel(value: unknown, field: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${field} must be one of ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}`);
	}
	const normalized = value.trim().toLowerCase();
	if (!THINKING_LEVEL_INDEX.has(normalized as ThinkingLevel)) {
		throw new Error(`${field} has invalid level ${JSON.stringify(value)}; valid levels: ${THINKING_LEVELS.join(", ")}`);
	}
	return normalized as ThinkingLevel;
}

/**
 * Normalize and validate the three durable agent thinking fields as one
 * contract. Validation is shared by discovery and the post-override runtime
 * path so settings/invocation patches cannot create an invalid effective
 * policy after a valid file was parsed.
 */
export function normalizeThinkingFields(input: {
	thinking?: unknown;
	thinkingMin?: unknown;
	thinkingMax?: unknown;
}): NormalizedThinkingFields {
	const thinking = normalizeLevel(input.thinking, "thinking");
	const thinkingMin = normalizeLevel(input.thinkingMin, "thinkingMin");
	const thinkingMax = normalizeLevel(input.thinkingMax, "thinkingMax");

	if (
		thinkingMin !== undefined &&
		thinkingMax !== undefined &&
		THINKING_LEVEL_INDEX.get(thinkingMin)! > THINKING_LEVEL_INDEX.get(thinkingMax)!
	) {
		throw new Error(`thinkingMin ${JSON.stringify(thinkingMin)} must not exceed thinkingMax ${JSON.stringify(thinkingMax)}`);
	}
	if (
		thinking !== undefined &&
		thinkingMin !== undefined &&
		THINKING_LEVEL_INDEX.get(thinking)! < THINKING_LEVEL_INDEX.get(thinkingMin)!
	) {
		throw new Error(
			`thinking ${JSON.stringify(thinking)} is outside the declared range ${thinkingMin}–${thinkingMax ?? THINKING_LEVELS.at(-1)}`,
		);
	}
	if (
		thinking !== undefined &&
		thinkingMax !== undefined &&
		THINKING_LEVEL_INDEX.get(thinking)! > THINKING_LEVEL_INDEX.get(thinkingMax)!
	) {
		throw new Error(
			`thinking ${JSON.stringify(thinking)} is outside the declared range ${thinkingMin ?? "off"}–${thinkingMax}`,
		);
	}

	return {
		...(thinking !== undefined ? { thinking } : {}),
		...(thinkingMin !== undefined ? { thinkingMin } : {}),
		...(thinkingMax !== undefined ? { thinkingMax } : {}),
	};
}

