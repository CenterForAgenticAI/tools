/** Carrying a session objective and its constraints through a dispatch.
 *
 * This is the pi-delegate half of the versioned `pi-workstream.focus-seed.v1`
 * contract, also written as `context-aware.focus-seed.v1` for pi-context-aware
 * 0.8.x. The receiver is optional, so this module deliberately carries the
 * small wire contract as plain JSON rather than importing it.
 */

/** The channel and durable entry type owned by a focus-aware extension. */
export const FOCUS_SEED_CHANNEL = "pi-workstream.focus-seed.v1" as const;
export const FOCUS_ENTRY_TYPE = FOCUS_SEED_CHANNEL;
export const FOCUS_SEED_CONTRACT_VERSION = 1 as const;

/** Bounds mirrored from the context-aware focus-seed contract. */
export const MAX_FOCUS_OBJECTIVE_CHARS = 1000;
export const MAX_FOCUS_BOUNDARIES = 50;
export const MAX_FOCUS_BOUNDARY_CHARS = 512;
export const MAX_FOCUS_HOST_CHARS = 256;
export const MAX_FOCUS_PARENT_SESSION_ID_CHARS = 256;
export const MAX_FOCUS_REFS = 50;
export const MAX_FOCUS_REF_VALUE_CHARS = 512;

/**
 * Ref kinds every focus receiver accepts: pi-context-aware 0.8.x's list, which
 * pi-workstream's wider list contains. Both receivers drop the whole seed,
 * objective included, for one ref outside this shape.
 */
export const FOCUS_REF_KINDS = ["gitlab-mr", "github-issue", "graft-spec", "branch", "commit", "path", "url", "other"] as const;
export type FocusRefKind = (typeof FOCUS_REF_KINDS)[number];

export interface FocusRef {
	readonly kind: FocusRefKind;
	readonly value: string;
}

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

/** The tool pi-workstream registers when it owns a durable focus entry. */
export const FOCUS_TOOL_NAME = "workstream_focus" as const;
/** The tool, channel and entry type pi-context-aware 0.8.x uses for the same entry. */
export const SESSION_FOCUS_TOOL_NAME = "session_focus" as const;
export const SESSION_FOCUS_ENTRY_TYPE = "context-aware.focus-seed.v1" as const;

/**
 * One extension that can own a worker's focus entry. The payload shape is the
 * same for every claimant, and focus carries no status, so only names differ.
 */
export interface FocusSeamClaimant {
	readonly toolName: string;
	readonly seedChannel: string;
	readonly entryType: string;
}

export const WORKSTREAM_FOCUS_CLAIMANT: FocusSeamClaimant = {
	toolName: FOCUS_TOOL_NAME,
	seedChannel: FOCUS_SEED_CHANNEL,
	entryType: FOCUS_ENTRY_TYPE,
};

export const SESSION_FOCUS_CLAIMANT: FocusSeamClaimant = {
	toolName: SESSION_FOCUS_TOOL_NAME,
	seedChannel: SESSION_FOCUS_ENTRY_TYPE,
	entryType: SESSION_FOCUS_ENTRY_TYPE,
};

/** Every focus claimant, in preference order: pi-workstream first. */
export const FOCUS_SEAM_CLAIMANTS: readonly FocusSeamClaimant[] = [WORKSTREAM_FOCUS_CLAIMANT, SESSION_FOCUS_CLAIMANT];
export const FOCUS_TOOL_NAMES: readonly string[] = FOCUS_SEAM_CLAIMANTS.map((claimant) => claimant.toolName);

/** The preferred claimant whose tool passes `isUsable`, or undefined for the prompt fallback. */
export function selectFocusSeamClaimant(isUsable: (toolName: string) => boolean): FocusSeamClaimant | undefined {
	return FOCUS_SEAM_CLAIMANTS.find((claimant) => isUsable(claimant.toolName));
}

function boundedFocusString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isFocusRefKind(value: unknown): value is FocusRefKind {
	return (FOCUS_REF_KINDS as readonly unknown[]).includes(value);
}

/**
 * Turn caller refs into the v1 ref shape every receiver reads. A bare string
 * and an unknown kind become `other`; a ref with no usable value is dropped,
 * and only the first `MAX_FOCUS_REFS` are kept. Only `kind` and `value` are
 * copied. Returns undefined when no ref survives.
 */
export function normalizeFocusRefs(value: unknown): FocusRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const refs: FocusRef[] = [];
	for (const candidate of value) {
		if (refs.length === MAX_FOCUS_REFS) break;
		const raw = isRecord(candidate) ? candidate.value : candidate;
		if (!boundedFocusString(raw, MAX_FOCUS_REF_VALUE_CHARS)) continue;
		const kind = isRecord(candidate) && isFocusRefKind(candidate.kind) ? candidate.kind : "other";
		refs.push({ kind, value: raw });
	}
	return refs.length === 0 ? undefined : refs;
}

/**
 * Whether a built seed passes the receivers' `parseFocusSeed`. A seed that
 * fails it must go to the prompt, because the receiver would silently drop it.
 */
export function isReadableFocusSeed(seed: FocusSeed): boolean {
	if (seed.schemaVersion !== FOCUS_SEED_CONTRACT_VERSION) return false;
	if (!boundedFocusString(seed.objective, MAX_FOCUS_OBJECTIVE_CHARS)) return false;
	if (seed.boundaries !== undefined && (!Array.isArray(seed.boundaries) || seed.boundaries.length > MAX_FOCUS_BOUNDARIES ||
		seed.boundaries.some((boundary) => !boundedFocusString(boundary, MAX_FOCUS_BOUNDARY_CHARS)))) return false;
	if (seed.refs !== undefined && (!Array.isArray(seed.refs) || seed.refs.length > MAX_FOCUS_REFS ||
		seed.refs.some((ref) => !isRecord(ref) || !isFocusRefKind(ref.kind) || !boundedFocusString(ref.value, MAX_FOCUS_REF_VALUE_CHARS)))) return false;
	if (seed.host !== undefined && !boundedFocusString(seed.host, MAX_FOCUS_HOST_CHARS)) return false;
	if (seed.parentPiSessionId !== undefined &&
		!boundedFocusString(seed.parentPiSessionId, MAX_FOCUS_PARENT_SESSION_ID_CHARS)) return false;
	return true;
}

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
	const { refs: suppliedRefs, ...rest } = focus;
	const refs = normalizeFocusRefs(suppliedRefs);
	return {
		...rest,
		...(refs === undefined ? {} : { refs }),
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
