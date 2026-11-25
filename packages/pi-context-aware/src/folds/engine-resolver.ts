/**
 * The one place that names the context engine in use (pi-context-aware#309).
 *
 * Internal: no package entry point re-exports it. The fold engine, the context tool
 * surface and the recall surface read the answer here instead of each asking
 * whether billion-context-pi is loaded.
 *
 * Order: an explicit override (`folds.engine`: `folds` or `compaction-only`) first; then
 * billion-context-pi presence, which gives `compaction-only` with the native folds in
 * shadow; otherwise `folds`. `detectCompactionBlocker` is a different question (is a
 * loaded extension cancelling compaction) and does not read this.
 */

import { isBillionContextPiLoaded, type RegisteredToolView } from "../compaction/compaction-blocker.js";

export type ContextEngine = "folds" | "compaction-only";
export type ContextEngineOverride = "auto" | "folds" | "compaction-only";

export const CONTEXT_ENGINE_OVERRIDES: readonly ContextEngineOverride[] = ["auto", "folds", "compaction-only"];

export interface ContextEngineInput {
	readonly tools: readonly RegisteredToolView[];
	readonly override?: ContextEngineOverride;
}

export function resolveContextEngine({ tools, override = "auto" }: ContextEngineInput): ContextEngine {
	if (override !== "auto") return override;
	return isBillionContextPiLoaded(tools) ? "compaction-only" : "folds";
}

/** True when an override forces `folds` although billion-context-pi is loaded. */
export function engineOverrideContradictsPresence({ tools, override = "auto" }: ContextEngineInput): boolean {
	return override === "folds" && isBillionContextPiLoaded(tools);
}

/** The fold engine's mode for an engine: the native folds write only when they are the engine. */
export function foldModeForEngine(engine: ContextEngine): "live" | "shadow" {
	return engine === "folds" ? "live" : "shadow";
}
