/** Carrying a session objective and its constraints through a dispatch.
 *
 * This is the pi-delegate half of the versioned `context-aware.focus-seed.v1`
 * contract. The receiver is optional, so this module deliberately carries the
 * small wire contract as plain JSON rather than importing it.
 */

/** The channel and durable entry type owned by a focus-aware extension. */
export const FOCUS_SEED_CHANNEL = "context-aware.focus-seed.v1" as const;
export const FOCUS_ENTRY_TYPE = FOCUS_SEED_CHANNEL;
export const FOCUS_SEED_CONTRACT_VERSION = 1 as const;

/** Bounds mirrored from the context-aware focus-seed contract. */
export const MAX_FOCUS_OBJECTIVE_CHARS = 1000;
export const MAX_FOCUS_BOUNDARIES = 50;
export const MAX_FOCUS_BOUNDARY_CHARS = 512;
export const MAX_FOCUS_HOST_CHARS = 256;
export const MAX_FOCUS_PARENT_SESSION_ID_CHARS = 256;

export interface FocusSeed {
	readonly schemaVersion: typeof FOCUS_SEED_CONTRACT_VERSION;
	readonly objective: string;
	readonly boundaries?: readonly string[];
	readonly refs?: readonly unknown[];
	readonly host?: string;
	readonly parentPiSessionId?: string;
	readonly [key: string]: unknown;
}

export interface FocusBoundaryOptions {
	readonly cwd: string;
	readonly writableRoots?: readonly string[];
	readonly confineWrites?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tool an extension registers when it owns a durable focus entry. */
export const FOCUS_TOOL_NAME = "session_focus" as const;

/**
 * Read a focus payload without rewriting its caller-owned fields. Validation is
 * performed by handoff-validation.ts before this seam is reached.
 */
export function parseSlotFocus(value: unknown): FocusSeed | undefined {
	if (!isRecord(value) || typeof value.objective !== "string") return undefined;
	return value as FocusSeed;
}

/** Add the dispatch-owned write-scope facts without changing caller ordering. */
export function deriveFocusBoundaries(options: FocusBoundaryOptions): string[] {
	const boundaries = [`Worker cwd: ${options.cwd}`];
	if (options.writableRoots !== undefined) {
		for (const root of options.writableRoots) boundaries.push(`Writable root: ${root}`);
	}
	boundaries.push(`Write confinement: ${options.confineWrites === false ? "disabled" : "enabled"}`);
	return boundaries;
}

/**
 * Build the receiver payload. The input object is never mutated and its own
 * fields are copied before delegate-owned provenance and boundaries are added.
 */
export interface FocusSeedSessionOptions extends FocusBoundaryOptions {
	readonly parentPiSessionId?: string;
}

export function buildFocusSeed(
	value: unknown,
	options: FocusBoundaryOptions & { readonly parentPiSessionId?: string },
): FocusSeed | undefined {
	const focus = parseSlotFocus(value);
	if (!focus) return undefined;
	const suppliedBoundaries = focus.boundaries === undefined ? [] : [...focus.boundaries];
	const boundaries = [...suppliedBoundaries, ...deriveFocusBoundaries(options)];
	if (boundaries.length > MAX_FOCUS_BOUNDARIES) {
		throw new Error(`focus.boundaries has ${boundaries.length} entries; the limit is ${MAX_FOCUS_BOUNDARIES}`);
	}
	for (const [index, boundary] of boundaries.entries()) {
		if (typeof boundary !== "string" || boundary.trim().length === 0) {
			throw new Error(`focus.boundaries[${index}] must be a non-empty string`);
		}
		if (boundary.length > MAX_FOCUS_BOUNDARY_CHARS) {
			throw new Error(`focus.boundaries[${index}] is ${boundary.length} characters; the limit is ${MAX_FOCUS_BOUNDARY_CHARS}`);
		}
	}
	if (options.parentPiSessionId !== undefined &&
		(options.parentPiSessionId.trim().length === 0 || options.parentPiSessionId.length > MAX_FOCUS_PARENT_SESSION_ID_CHARS)) {
		throw new Error(`focus.parentPiSessionId must be non-empty and at most ${MAX_FOCUS_PARENT_SESSION_ID_CHARS} characters`);
	}
	return {
		...focus,
		schemaVersion: FOCUS_SEED_CONTRACT_VERSION,
		boundaries,
		host: focus.host ?? "pi-delegate",
		...(focus.parentPiSessionId !== undefined || options.parentPiSessionId === undefined
			? {}
			: { parentPiSessionId: options.parentPiSessionId }),
	};
}

/** Append an unseedable focus as readable instructions. */
export function appendFocusToPrompt(task: string, value: unknown, options: FocusBoundaryOptions): string {
	const focus = buildFocusSeed(value, options);
	if (!focus) return task;
	const constraints = (focus.boundaries ?? []).map((boundary) => `- ${boundary}`).join("\n");
	return `${task}\n\n## Objective\n\n${focus.objective}\n\n## Constraints\n\n${constraints || "- No additional constraints."}`;
}
