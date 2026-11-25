/**
 * Which context tool names this extension registers, and how the model reaches each.
 *
 * The four context tools register directly. `context_fold` registers only while the
 * session's methods include `fold` (pi-context-aware#526): without it, as when
 * billion-context-pi is loaded, the native fold engine is in shadow mode and writes
 * nothing (pi-context-aware#189). `context_compact` is hidden while the methods leave
 * `compact` out. `acp_cache` has no tool, because cache numbers moved to a user command.
 *
 * Decide at `session_start`: `pi.getAllTools()` throws while extensions load.
 */

import type { ToolExposure } from "@earendil-works/pi-coding-agent";

import type { CompactionBlocker, RegisteredToolView } from "../compaction/compaction-blocker.js";
import { resolveSessionStrategy } from "../folds/engine-resolver.js";
import { hasMethod, type ContextMethod } from "../strategy/methods.js";

export type ContextToolName = "context_recall" | "context_status" | "context_compact" | "context_fold";

export interface ContextToolSurfaceEntry {
	readonly name: ContextToolName;
	readonly exposure: ToolExposure;
}

/** The context tools: they change only the session's own context, so no mode blocks them. */
export const CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set<ContextToolName>(["context_recall", "context_status", "context_compact", "context_fold"]);

const NEW_TOOLS: readonly ContextToolName[] = ["context_recall", "context_status", "context_compact"];

/**
 * The names to register for one session, in registration order.
 *
 * @param tools what `pi.getAllTools()` returns at `session_start`.
 * @param blocker the session's compaction blocker (`detectCompactionBlocker`).
 *   Compacting cannot finish while a blocker cancels it, so `context_compact` is hidden then.
 * @param methods the session's methods (`resolveSessionStrategy`); without settings, the auto rule's.
 *   `context_fold` is left out without `fold`; `context_compact` is hidden without `compact`.
 */
export function decideContextToolSurface(
	tools: readonly RegisteredToolView[],
	blocker: CompactionBlocker | undefined,
	methods: readonly ContextMethod[] = resolveSessionStrategy({ tools, settings: {} }).methods,
): ContextToolSurfaceEntry[] {
	const names = [...NEW_TOOLS, ...(hasMethod(methods, "fold") ? ["context_fold" as const] : [])];
	const hidden = (name: ContextToolName) => name === "context_compact" && (blocker !== undefined || !hasMethod(methods, "compact"));
	return names.map((name) => ({ name, exposure: hidden(name) ? "hidden" : "direct" }));
}
