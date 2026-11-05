/**
 * Which context tool names this extension registers, and how the model reaches each.
 *
 * The four context tools register directly. `context_fold` registers only while
 * billion-context-pi is not loaded: with it loaded the native fold engine is in
 * shadow mode and writes nothing (pi-context-aware#189). `acp_cache` has no
 * tool, because cache numbers moved to a user command.
 *
 * Decide at `session_start`: `pi.getAllTools()` throws while extensions load.
 */

import type { ToolExposure } from "@earendil-works/pi-coding-agent";

import { isBillionContextPiLoaded, type CompactionBlocker, type RegisteredToolView } from "../compaction/compaction-blocker.js";

export type ContextToolName = "context_recall" | "context_status" | "context_compact" | "context_fold";

export interface ContextToolSurfaceEntry {
	readonly name: ContextToolName;
	readonly exposure: ToolExposure;
}

const NEW_TOOLS: readonly ContextToolName[] = ["context_recall", "context_status", "context_compact"];

/**
 * The names to register for one session, in registration order.
 *
 * @param tools what `pi.getAllTools()` returns at `session_start`.
 * @param blocker the session's compaction blocker (`detectCompactionBlocker`).
 *   Compacting cannot finish while a blocker cancels it, so `context_compact` is hidden then.
 */
export function decideContextToolSurface(
	tools: readonly RegisteredToolView[],
	blocker: CompactionBlocker | undefined,
): ContextToolSurfaceEntry[] {
	const names = [...NEW_TOOLS, ...(isBillionContextPiLoaded(tools) ? [] : ["context_fold" as const])];
	return names.map((name) => ({ name, exposure: blocker && name === "context_compact" ? "hidden" : "direct" }));
}
