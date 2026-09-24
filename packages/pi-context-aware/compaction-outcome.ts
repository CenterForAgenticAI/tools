import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCtxUsable } from "./ctx-liveness.js";
import { isTransientFailure } from "./transient-retry.js";

const COMPACTION_CANCELLED_MESSAGE = "Compaction cancelled";
const NOTHING_TO_COMPACT_MESSAGE = "Nothing to compact (session too small)";
const ALREADY_COMPACTED_MESSAGE = "Already compacted";
const NOTHING_TO_COMPACT_TOOL_MESSAGE =
	"Nothing to compact (session too small); the conversation is unchanged.";

export type CompactionErrorKind =
	| "transient"
	| "cancelled"
	| "nothing-to-compact"
	| "already-compacted"
	| "other";

export type CompactionErrorClassification = {
	kind: CompactionErrorKind;
	error: Error;
	message: string;
};

export interface CompactionErrorDecision {
	notification: { message: string; level: "info" | "warning" | "error" } | null;
	injectRecoveryFollowUp: boolean;
	proactiveLifecycle: "failed" | "cancelled" | "none";
	clearPendingSeedMetadata: boolean;
	/** Stop Pi's built-in retry/fallback path for an exhausted extension transport call. */
	failClosed: boolean;
	recoveryFollowUp?: (seed: string) => string;
	debugNote?: string;
}

/** Classify Pi's terminal compaction outcomes without treating normal outcomes as errors. */
export function classifyCompactionError(error: unknown): CompactionErrorClassification {
	const normalized = error instanceof Error ? error : new Error(String(error));
	const kind = normalized.message === COMPACTION_CANCELLED_MESSAGE || normalized.name === "AbortError"
		? "cancelled"
		: normalized.message === NOTHING_TO_COMPACT_MESSAGE
			? "nothing-to-compact"
			: normalized.message === ALREADY_COMPACTED_MESSAGE
				? "already-compacted"
				: isTransientFailure(normalized)
					? "transient"
					: "other";
	return { kind, error: normalized, message: normalized.message };
}

/**
 * Decide how the caller should report a compaction outcome.
 *
 * A cancellation has no reliable cause marker at this boundary: Pi uses the
 * same error for Escape and for a session replacement. The message names both
 * likely causes rather than claiming one that the extension cannot prove.
 */
export function decideCompactionError(
	classification: CompactionErrorClassification,
): CompactionErrorDecision {
	if (classification.kind === "cancelled") {
		return {
			notification: {
				message: "Compaction cancelled; cause not determined (likely a session replacement/reload or user interrupt).",
				level: "info",
			},
			injectRecoveryFollowUp: false,
			proactiveLifecycle: "cancelled",
			clearPendingSeedMetadata: true,
			failClosed: false,
			debugNote: "compaction cancelled; cause not determined; likely session replacement/reload or user interrupt; no recovery follow-up injected",
		};
	}

	if (classification.kind === "nothing-to-compact" || classification.kind === "already-compacted") {
		const label = classification.kind === "nothing-to-compact"
			? NOTHING_TO_COMPACT_TOOL_MESSAGE
			: "Already compacted";
		return {
			notification: null,
			injectRecoveryFollowUp: false,
			proactiveLifecycle: "none",
			clearPendingSeedMetadata: true,
			failClosed: false,
			debugNote: `suppressing notification and recovery follow-up for ${label}; conversation remains unchanged`,
		};
	}

	return {
		notification: { message: `Compaction failed: ${classification.message}`, level: "error" },
		injectRecoveryFollowUp: true,
		proactiveLifecycle: "failed",
		clearPendingSeedMetadata: true,
		failClosed: classification.kind === "transient",
		recoveryFollowUp: (seed) => `(Compaction failed: ${classification.message}. Continuing with original context.)\n\n${seed}`,
	};
}

/**
 * Recovery decision for a proactive compaction whose commit was refused because
 * an agent run was still in flight past the drain budget (#101, follow-up to
 * #55).
 *
 * A refusal compacted nothing, so the context pressure that triggered it still
 * holds. `PROACTIVE_COOLDOWN_MS` exists to space out *effective* compactions;
 * applying that full success-spacing cooldown to a refusal needlessly delays the
 * compaction the session still needs. This predicate runs only at Pi's genuine
 * idle boundary, where the blocking run has finished and a clean commit is
 * possible, so clearing the cooldown there cannot cause per-turn thrash while a
 * run is still in flight. A genuine compaction *failure* never sets the owed
 * marker, so it keeps its existing cooldown behaviour.
 */
export interface OwedCompactionReattemptInput {
	/** The last proactive attempt was an in-flight commit refusal that abandoned. */
	readonly owedByRefusal: boolean;
	/**
	 * The cooldown currently in effect is the same one the refusal set, not a
	 * later genuine-failure cooldown that happened to replace it. The marker owns
	 * only its own cooldown; it must never clear a genuine failure's cooldown.
	 */
	readonly refusalCooldownStillCurrent: boolean;
	/** Context is still at/above the threshold (or the generation reserve is unsafe). */
	readonly contextStillOverThreshold: boolean;
	/** A proactive cooldown is currently blocking the next threshold re-trigger. */
	readonly withinCooldown: boolean;
}

export type OwedCompactionReattempt =
	/** Clear the success-spacing cooldown so the next turn re-triggers promptly. */
	| "clear-cooldown"
	/** Drop the owed marker (recovered, expired, or a different cooldown is now in effect). */
	| "clear-owed"
	/** Nothing to do. */
	| "none";

export function decideOwedCompactionReattempt(
	input: OwedCompactionReattemptInput,
): OwedCompactionReattempt {
	if (!input.owedByRefusal) return "none";
	// The refusal's own cooldown is gone — it expired, was cleared, or a later
	// genuine-failure cooldown replaced it. The marker is stale: drop it without
	// touching whatever cooldown is in effect now, so a genuine failure keeps its
	// cooldown (#101, CR-OWED-MARKER-STALE).
	if (!input.refusalCooldownStillCurrent || !input.withinCooldown) return "clear-owed";
	// The refusal's cooldown is still the one in effect but the session recovered
	// on its own; drop the marker and leave the cooldown to expire normally.
	if (!input.contextStillOverThreshold) return "clear-owed";
	return "clear-cooldown";
}

export interface CompactionPreflightInput {
	ctx: ExtensionContext;
	seed: string;
	summaryFocus?: string | null;
	metadata?: unknown;
	summaryFocusHints?: readonly string[];
}

export type CompactionPreflightResult =
	| { kind: "proceed" }
	| {
			kind: "nothing-to-compact";
			toolMessage: typeof NOTHING_TO_COMPACT_TOOL_MESSAGE;
			serviceStatus: "nothing-to-compact";
	  };

/**
 * Pi exposes the compaction settings only on the later preparation event.
 * Context usage alone cannot reproduce Pi's keepRecentTokens/reserveTokens
 * predicate, so preflight deliberately refuses to guess and suppress a real
 * compaction. The asynchronous Pi error is classified above instead.
 */
export function preflightCompaction(_input: CompactionPreflightInput): CompactionPreflightResult {
	return { kind: "proceed" };
}

export interface ReusableSummaryLookupInput {
	ctx: ExtensionContext;
	preparation: unknown;
	event: unknown;
}

interface PreparationShape {
	firstKeptEntryId?: unknown;
}

interface SessionManagerShape {
	getSessionId?: () => string;
	getSessionFile?: () => string | undefined;
	getBranch?: () => readonly unknown[];
}

interface RetainedSummary {
	summary: string;
	branchIdentity: string;
	sessionIdentity: string;
	sessionKey: string;
	firstKeptEntryId: string;
	summarizedPrefix: string[];
	tokensBefore: number;
}

// Pi creates a fresh ExtensionContext wrapper for each event. Retention must
// therefore be keyed by the session and summarized boundary, not by ctx.
const retainedSummaries = new Map<string, RetainedSummary>();

function preparationFirstKeptEntryId(preparation: unknown): string | null {
	if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)) return null;
	const value = (preparation as PreparationShape).firstKeptEntryId;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function entryId(entry: unknown): string | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	const candidate = entry as { id?: unknown; entryId?: unknown };
	const id = typeof candidate.id === "string"
		? candidate.id
		: typeof candidate.entryId === "string"
			? candidate.entryId
			: null;
	return id && id.length > 0 ? id : null;
}

function entryIdentity(entry: unknown, index: number): string | null {
	const id = entryId(entry);
	if (!id) return null;
	const type = entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { type?: unknown }).type === "string"
		? (entry as { type: string }).type
		: "entry";
	return `${index}:${type}:${id}`;
}

function sessionIdentity(ctx: ExtensionContext): { identity: string; key: string } | null {
	const manager = ctx.sessionManager as unknown as SessionManagerShape;
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	try {
		sessionId = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
		sessionFile = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
	} catch {
		return null;
	}
	const key = sessionId || sessionFile;
	if (!key) return null;
	return {
		key,
		identity: JSON.stringify({ sessionId: sessionId ?? null, sessionFile: sessionFile ?? null }),
	};
}

/**
 * The branch key is the stable session identity plus the ordered Pi entries
 * through the preparation's first kept entry. A changed summarized prefix or
 * compaction boundary therefore cannot consume a summary produced for another
 * branch, while a newly appended retained tail does not require another summary.
 */
function branchIdentity(ctx: ExtensionContext, preparation: unknown): {
	key: string;
	sessionIdentity: string;
	sessionKey: string;
	firstKeptEntryId: string;
	summarizedPrefix: string[];
} | null {
	const firstKeptEntryId = preparationFirstKeptEntryId(preparation);
	if (!firstKeptEntryId) return null;
	const manager = ctx.sessionManager as unknown as SessionManagerShape;
	if (typeof manager.getBranch !== "function") return null;
	const session = sessionIdentity(ctx);
	if (!session) return null;
	let branch: readonly unknown[];
	try {
		branch = manager.getBranch();
	} catch {
		return null;
	}
	if (!Array.isArray(branch)) return null;
	const firstKeptIndex = branch.findIndex((entry) => entryId(entry) === firstKeptEntryId);
	if (firstKeptIndex < 0) return null;
	// Only the prefix represented by the generated summary identifies the
	// retained work. Entries appended after firstKeptEntryId are Pi's retained
	// tail and may legitimately arrive while the summary is being generated or
	// drained; they must not force a second summary request.
	const summarizedPrefix = branch.slice(0, firstKeptIndex + 1).map(entryIdentity);
	if (summarizedPrefix.some((entry): entry is null => entry === null)) return null;
	const stableSummarizedPrefix = summarizedPrefix.filter((entry): entry is string => entry !== null);
	return {
		sessionIdentity: session.identity,
		sessionKey: session.key,
		firstKeptEntryId,
		summarizedPrefix: stableSummarizedPrefix,
		key: JSON.stringify({
			session: session.identity,
			summarizedPrefix,
			firstKeptEntryId,
		}),
	};
}

function retentionFailure(reason: string): void {
	console.debug(`[context-aware] compaction summary retention unavailable: ${reason}`);
}

/** Remove all retained summaries belonging to a stable session key. */
export function clearRetainedSummariesForSession(sessionKey: string): void {
	for (const [identity, retained] of retainedSummaries) {
		if (retained.sessionKey === sessionKey || retained.sessionIdentity === sessionKey) retainedSummaries.delete(identity);
	}
}

export interface ReusableSummary {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

/** Look up a summary retained after Pi aborted a completed summarization. */
export function lookupReusableSummaryWithBoundary(input: ReusableSummaryLookupInput): ReusableSummary | null {
	if (!isCtxUsable(input.ctx)) {
		retentionFailure("session context was disposed before retry");
		return null;
	}
	const session = sessionIdentity(input.ctx);
	if (!session || ![...retainedSummaries.values()].some((retained) => retained.sessionIdentity === session.identity)) return null;
	const currentIdentity = branchIdentity(input.ctx, input.preparation);
	if (!currentIdentity) {
		if (session) clearRetainedSummariesForSession(session.identity);
		retentionFailure("the retry did not expose a stable branch identity");
		return null;
	}
	let retained = retainedSummaries.get(currentIdentity.key);
	if (!retained) {
		retained = [...retainedSummaries.values()].find((candidate) =>
			candidate.sessionIdentity === currentIdentity.sessionIdentity &&
			candidate.summarizedPrefix.every((entry, index) => currentIdentity.summarizedPrefix[index] === entry),
		);
	}
	if (!retained) {
		const stale = [...retainedSummaries.values()].find((candidate) => candidate.sessionIdentity === currentIdentity.sessionIdentity);
		if (stale) {
			clearRetainedSummariesForSession(stale.sessionIdentity);
			retentionFailure("the retry was on a different session branch or compaction boundary");
		}
		return null;
	}
	retainedSummaries.delete(retained.branchIdentity);
	return {
		summary: retained.summary,
		firstKeptEntryId: retained.firstKeptEntryId,
		tokensBefore: retained.tokensBefore,
	};
}

export function lookupReusableSummary(input: ReusableSummaryLookupInput): string | null {
	return lookupReusableSummaryWithBoundary(input)?.summary ?? null;
}

export interface RetainedSummaryInput {
	ctx: ExtensionContext;
	summary: string;
	preparation: unknown;
}

/** Retain a completed summary until the same branch retries compaction. */
export function recordRetainedSummary(input: RetainedSummaryInput): void {
	if (!isCtxUsable(input.ctx)) {
		retentionFailure("session context was already disposed after summarization");
		return;
	}
	if (input.summary.trim().length === 0) {
		retentionFailure("the generated summary was empty");
		return;
	}
	const identity = branchIdentity(input.ctx, input.preparation);
	if (!identity) {
		retentionFailure("the completed compaction did not expose a stable branch identity");
		return;
	}
	clearRetainedSummariesForSession(identity.sessionIdentity);
	const tokensBefore = input.preparation && typeof input.preparation === "object" &&
		"tokensBefore" in input.preparation && typeof input.preparation.tokensBefore === "number"
		? input.preparation.tokensBefore
		: 0;
	retainedSummaries.set(identity.key, {
		summary: input.summary,
		branchIdentity: identity.key,
		sessionIdentity: identity.sessionIdentity,
		sessionKey: identity.sessionKey,
		firstKeptEntryId: identity.firstKeptEntryId,
		summarizedPrefix: identity.summarizedPrefix,
		tokensBefore,
	});
}

export interface SummaryRetentionFailureInput {
	ctx: ExtensionContext;
	reason: unknown;
}

/** Record why a retained summary could not be reused. */
export function recordSummaryRetentionFailure(input: SummaryRetentionFailureInput): void {
	const reason = input.reason instanceof Error ? input.reason.message : String(input.reason);
	if (isCtxUsable(input.ctx)) {
		const session = sessionIdentity(input.ctx);
		if (session) clearRetainedSummariesForSession(session.identity);
	}
	retentionFailure(reason);
}
