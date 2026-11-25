/**
 * Guidance variants (pi-context-aware#526, ADR 0002 decision 5): what a live experiment varies between sessions.
 * `strategy.assign` draws one of these per new session; it never draws methods, so every session keeps every method
 * its settings list. A variant changes how the session's methods word what they say, never which methods run.
 *
 * - `default`: today's wording.
 * - `by-model-v1` (pi-context-aware#459): the request's model chooses the wording, against each model's lean. Opus
 *   (`claude-opus-*`) is told to compact at a finished phase; GPT (`gpt-*`) to fold first; every other model gets
 *   the default wording, so its sessions act as an A/A check. The wording changes in two places only: the fold
 *   nudge's rule for choosing between the tools (folds/nudge-tools.ts) and the one context_fold guideline that
 *   names context_compact (context-tools/context-fold.ts). Both apply only while the session can call both tools;
 *   with one tool the text names that tool alone, as under `default`.
 *
 * A new variant is added here, reviewed, with the behaviour it changes.
 */

export const GUIDANCE_VARIANTS = ["default", "by-model-v1"] as const;

export type GuidanceVariant = (typeof GUIDANCE_VARIANTS)[number];

/** The guidance a session runs when nothing is drawn for it. */
export const DEFAULT_GUIDANCE: GuidanceVariant = "default";

/** True only for an id in `GUIDANCE_VARIANTS`, compared exactly. */
export function isGuidanceVariant(id: string): id is GuidanceVariant {
	return (GUIDANCE_VARIANTS as readonly string[]).includes(id);
}

/**
 * Which wording a request gets (pi-context-aware#459): `default` (today's), `compact-boundary` (compact when a phase
 * is finished, fold within a running one) or `fold-first` (fold first, compact only at a phase boundary).
 */
export const STEERS = ["default", "compact-boundary", "fold-first"] as const;
export type Steer = (typeof STEERS)[number];

/** The model families `by-model-v1` tells apart. */
export type ModelFamily = "opus" | "gpt" | "other";

/** Longest model id that is matched; a longer one is `other`. */
const MAX_MODEL_ID_CHARS = 128;

/**
 * The family of a request's model id. The id may carry a provider path (`openrouter/anthropic/claude-opus-4.5`): only
 * its last `/` segment is matched, case-insensitively. `claude-opus-` followed by a version is `opus`; `gpt-` followed
 * by anything is `gpt`; a missing, empty or overlong id, and every other id, is `other`.
 */
export function modelFamily(modelId: string | null | undefined): ModelFamily {
	if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > MAX_MODEL_ID_CHARS) return "other";
	const name = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
	if (/^claude-opus-./u.test(name)) return "opus";
	if (/^gpt-./u.test(name)) return "gpt";
	return "other";
}

/** The wording `guidance` chooses for a request to `modelId`. */
export function steerFor(guidance: GuidanceVariant, modelId: string | null | undefined): Steer {
	if (guidance !== "by-model-v1") return "default";
	switch (modelFamily(modelId)) {
		case "opus": return "compact-boundary";
		case "gpt": return "fold-first";
		case "other": return "default";
	}
}
