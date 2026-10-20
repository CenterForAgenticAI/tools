/**
 * Which context tool names this extension registers, and how the model reaches each.
 *
 * The new names always register. The old names stay one release as `deferred`
 * aliases: tool search finds them, but they cost no tool declaration. Our own
 * old names always register. billion-context-pi's names register only while it
 * is not loaded, because Pi keeps the first tool registered under a name and
 * reports the second as a conflict.
 *
 * Decide at `session_start`: `pi.getAllTools()` throws while extensions load.
 * `context_fold`, and with it a working `compress`, comes with the engine batch
 * (pi-context-aware#189); `acp_cache` gets no alias, because cache numbers move
 * to a user command.
 */

import type { ToolExposure } from "@earendil-works/pi-coding-agent";

import { isBillionContextPiLoaded, type CompactionBlocker, type RegisteredToolView } from "../compaction/compaction-blocker.js";

export type ContextToolName = "context_recall" | "context_status" | "context_compact" | "context_fold";

export type ContextToolAliasName =
	| "search_prior_sessions"
	| "session_recall"
	| "session_compaction_history"
	| "compact_session"
	| "compress"
	| "decompress"
	| "search_context"
	| "acp_status";

export interface ContextToolSurfaceEntry {
	readonly name: ContextToolName | ContextToolAliasName;
	readonly exposure: ToolExposure;
	/** The new tool an old name stands for. Undefined for the new names themselves. */
	readonly aliasOf?: ContextToolName;
}

const NEW_TOOLS: readonly ContextToolName[] = ["context_recall", "context_status", "context_compact"];

const OWN_ALIASES: ReadonlyArray<readonly [ContextToolAliasName, ContextToolName]> = [
	["search_prior_sessions", "context_recall"],
	["session_recall", "context_recall"],
	["session_compaction_history", "context_status"],
	["compact_session", "context_compact"],
];

const BILLION_CONTEXT_PI_ALIASES: ReadonlyArray<readonly [ContextToolAliasName, ContextToolName]> = [
	["compress", "context_fold"],
	["decompress", "context_recall"],
	["search_context", "context_recall"],
	["acp_status", "context_status"],
];

/** Compacting cannot finish while a blocker cancels it, so neither compact tool is offered then. */
const COMPACTION_TOOLS: ReadonlySet<string> = new Set(["context_compact", "compact_session"]);

/**
 * The names to register for one session, in registration order.
 *
 * @param tools what `pi.getAllTools()` returns at `session_start`. This
 *   extension's own tools are ignored, so its own `compress` and `acp_status`
 *   aliases never withdraw themselves at the next session.
 * @param blocker the session's compaction blocker (`detectCompactionBlocker`).
 */
export function decideContextToolSurface(
	tools: readonly RegisteredToolView[],
	blocker: CompactionBlocker | undefined,
): ContextToolSurfaceEntry[] {
	const aliases = isBillionContextPiLoaded(tools) ? OWN_ALIASES : [...OWN_ALIASES, ...BILLION_CONTEXT_PI_ALIASES];
	const entries: ContextToolSurfaceEntry[] = [
		...NEW_TOOLS.map((name) => ({ name, exposure: "direct" as const })),
		...aliases.map(([name, aliasOf]) => ({ name, exposure: "deferred" as const, aliasOf })),
	];
	if (!blocker) return entries;
	return entries.map((entry) => (COMPACTION_TOOLS.has(entry.name) ? { ...entry, exposure: "hidden" } : entry));
}
