/**
 * Cross-replacement completion wake redelivery (issue #2).
 *
 * A dispatched (`sync:false`) supervised/chain/direct run auto-wakes its
 * parent session via `notifyCompletion` → `sendMessage` on the ExtensionAPI
 * ctx captured at tool-registration time. When the session is replaced or
 * reloaded mid-run (compaction, /new, /reload, resume), that ctx goes stale
 * and the wake is DROPPED — the result is persisted (completeRun runs before
 * the wake) but nothing ever tells the successor session. The ORCHESTRATE
 * shape never had this problem: its detached child writes a pending-result
 * FILE that `session_start` hydrate-and-deliver picks up with a fresh ctx.
 *
 * This module extends that file-based pattern to the three in-process shapes,
 * plus a faster same-process leg the orchestrate shape doesn't need:
 *
 *   1. LIVE-SINK RETRY (same process, new session): pi reloads extensions
 *      with `moduleCache: false`, so module state does NOT survive a session
 *      replacement — but `globalThis` does. Each foreground `session_start`
 *      registers its fresh ExtensionAPI in a `globalThis` slot keyed by a
 *      well-known Symbol; when a wake bounces off a stale ctx,
 *      `notifyCompletion` retries once through the registered live sink.
 *      In the common case (compaction mid-run, completion lands after the
 *      new session is up) this delivers the wake IMMEDIATELY.
 *
 *   2. PENDING-WAKE FILE (everything else): if there is no live sink (the
 *      completion landed inside the replacement window) or the retry also
 *      fails, the full wake payload is written to
 *      `<agentDir>/extensions/pi-delegate/pending-wakes/<runId>.json` and
 *      `deliverPendingDispatchWakes` redelivers it on the next
 *      `session_start` — same claim/unclaim/stale-sweep discipline as the
 *      orchestrate pending-results leg (at-least-once, duplicates bounded to
 *      a crash inside the claim window, never silent loss).
 *
 * OWNERSHIP: a pending wake is stamped with the pid+process nonce of the
 * process that dropped it AND, when the originator can provide it, the owning
 * foreground session id. The scan delivers a record to the matching foreground
 * session, or adopts a stale session id when the record is provably from this
 * same process replacement (pid+nonce match) or from a dead prior owner. Legacy
 * records without a session id still redeliver for same-process replacement
 * (pid+nonce match), but a dead-owner legacy record is NOT broadcast to whoever
 * starts next — that would risk waking an unrelated foreground session sharing
 * the same agentDir (GitLab #18).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	resolveCompletionNotifyStrategy,
	type CompletionNotifyStrategy,
} from "./config.js";
import {
	claimPendingResult,
	consumePendingResult,
	sweepStaleClaims,
	unclaimPendingResult,
} from "./detached-spawn.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { captureCurrentAsyncContext } from "./depth-guard.js";
import { pidAlive } from "./event-bus.js";
import {
	pinWorkerArtifactSync,
	unpinWorkerArtifactSync,
	validateWorkerArtifactReference,
	WorkerArtifactStorageBusyError,
	type WorkerArtifactReference,
} from "./artifact-workspace.js";
import type { RunResult } from "./fork-runner.js";
import { formatWorktreeCaptureFailureGuidance, type WorktreeDiff } from "./worktree.js";
import { capDelegateOnlyResult } from "./delegate-only/result-caps.js";
import { projectRunResults } from "./run-result-boundary.js";
import {
	aggregateRunResults,
	buildDelegateUsageMetadata,
	summarizeRunUsages,
	type DelegateUsageMetadata,
	type DelegateUsageTotals,
} from "./usage-rollup.js";
import { isSafeRunId } from "./run-id.js";
import {
	STATE_FILE_MODE,
	ensureOwnerOnlyDirectory,
	ensureOwnerOnlyFile,
	tryWithStateFileLock,
	withStateFileLock,
} from "./state-io.js";
import type { EscalationKind } from "./escalation-store.js";
import type { WorkerErrorKind, WorkerFailureCause } from "./refusal.js";
import { sanitizeRecoveryText, truncateRecoveryText } from "./fork-recovery.js";
import { getDelegatePresentationTerminology } from "./footer-presentation.js";
import { getProcessNonce } from "./process-identity.js";
import { getRun, listRuns, type RunLiveStatus } from "./runtime.js";
import { buildRetryProjection, MAX_RETRY_PROJECTION_ENTRIES, RETRY_PROJECTION_USAGE_KEYS, type RetryProjectionFork } from "./retry-projection.js";

export { getProcessNonce } from "./process-identity.js";

/**
 * The minimal sendMessage surface `notifyCompletion` / redelivery need. The
 * production sink is the live ExtensionAPI (`pi`); tests pass fakes.
 */
export interface NotifyCompletionSink {
	sendMessage: ExtensionAPI["sendMessage"];
	/** Optional fresh-session durable metadata append surface (ExtensionAPI.appendEntry). */
	appendEntry?: ExtensionAPI["appendEntry"];
}

/**
 * Bind a wake sink to the recipient's dispatch-time async context.
 *
 * Run-entry callbacks execute inside the sender's `runWithDepth` frame. Calling
 * an originator sink directly there makes Pi's trigger-turn continuation inherit
 * the dead run entry's ALS lineage. Capture this wrapper before starting the run
 * entry so delivery restores the recipient's frame instead (runbook field note,
 * bug 1).
 */
export function bindWakeSinkToCurrentContext(
	sink: NotifyCompletionSink,
): NotifyCompletionSink {
	const runInRecipientContext = captureCurrentAsyncContext();
	const bound: NotifyCompletionSink = {
		sendMessage: (message, options) =>
			runInRecipientContext(() => sink.sendMessage(message, options)),
	};
	if (sink.appendEntry) {
		bound.appendEntry = (customType, data) =>
			runInRecipientContext(() => sink.appendEntry!(customType, data));
	}
	const observer = wakeDeliveryObservers.get(sink);
	if (observer) wakeDeliveryObservers.set(bound, observer);
	return bound;
}

// A final report may land while the recipient is mid-turn. `followUp` is Pi's
// persistent queue rung and avoids the bare-send "Agent is already processing"
// race recorded in the runbook field note (bug 2).
const WAKE_DELIVERY_OPTIONS = {
	triggerTurn: true,
	deliverAs: "followUp",
} as const;

const WAKE_DELIVERY_OBSERVERS_KEY = Symbol.for("pi-delegate.wakeDeliveryObservers");
const wakeDeliveryObservers = (() => {
	const shared = globalThis as Record<symbol, unknown>;
	const existing = shared[WAKE_DELIVERY_OBSERVERS_KEY];
	if (existing instanceof WeakMap) return existing as WeakMap<object, () => void>;
	const observers = new WeakMap<object, () => void>();
	shared[WAKE_DELIVERY_OBSERVERS_KEY] = observers;
	return observers;
})();

export function setWakeDeliveryObserver(sink: object, observer: () => void): void {
	wakeDeliveryObservers.set(sink, observer);
}

/**
 * Barrier run immediately before ANY wake is delivered (#265).
 *
 * A wake enters the prompt path directly and never emits `before_agent_start`,
 * so a tool revealed by run or escalation state would otherwise be missing from
 * the very request the wake tells the model to act on. Registering the barrier
 * here rather than at each call site means a wake added later cannot forget it.
 */
let preDeliveryBarrier: (() => void) | undefined;

export function setWakeDeliveryBarrier(barrier: (() => void) | undefined): void {
	preDeliveryBarrier = barrier;
}

export function deliverWakeMessage(
	sink: NotifyCompletionSink,
	message: Parameters<NotifyCompletionSink["sendMessage"]>[0],
): void {
	try {
		preDeliveryBarrier?.();
	} catch {
		// Never let visibility bookkeeping stop a wake from being delivered.
	}
	const g = globalThis as Record<symbol, unknown>;
	const liveSink = g[LIVE_WAKE_SINK_KEY];
	const liveContext = g[LIVE_WAKE_SINK_CONTEXT_KEY];
	if (sink === liveSink && typeof liveContext === "function") {
		(liveContext as <T>(fn: () => T) => T)(() => sink.sendMessage(message, WAKE_DELIVERY_OPTIONS));
	} else {
		sink.sendMessage(message, WAKE_DELIVERY_OPTIONS);
	}
	// Only terminal completion wakes authorize a delegated coordinator's final
	// synthesis turn. Early failure, escalation, and recovery wakes may trigger a
	// turn, but must leave the completion gate parked for the terminal wake.
	if (message.customType === "delegate:complete") {
		try {
			wakeDeliveryObservers.get(sink)?.();
		} catch {
			// Observer bookkeeping must not turn a delivered wake into a retry.
		}
	}
}

function isProcessingRace(error: unknown): boolean {
	return /Agent is already processing|Specify streamingBehavior/i.test(
		String((error as Error)?.message ?? error),
	);
}

export interface NotifyCompletionInput {
	runId: string;
	/** Delegate execution mode, used only for non-context durable metadata. */
	mode?: string;
	/** Configured transport alias; persisted wakes carry its effective value. */
	completionNotifyStrategy?: CompletionNotifyStrategy;
	finalResults: RunResult[];
	combinedContent: string;
	error?: string;
	/** Bounded retry facts; fork names never cross this boundary. */
	retry?: Array<Record<string, unknown>>;
	retryMetadataIncomplete?: boolean;
	retryMetadataTruncated?: boolean;
}

/** Identity and diagnostic payload for an individual dispatched run-entry failure. */
export interface RunFailureSiblingState {
	/** Bounded failure-entry label; no task/prompt/output content is carried here. */
	forkName: string;
	status: RunLiveStatus;
}

/**
 * Closed categorical diagnosis carried by the early `delegate:fork-failed`
 * wake. Free-form failure text never crosses this boundary, so this is the
 * whole of what a caller learns before the aggregate wake arrives.
 *
 * `provider-capacity` (issues #469, #197) separates "the provider had no quota
 * or rate-limit headroom left" from the generic `fork-failed`. Those call for
 * opposite responses -- wait or move account, versus read the transcript and
 * fix a defect -- and before it existed both arrived as the literal string
 * `fork-failed`, which only restated the status.
 *
 * `no-model-alternative` is deliberately kept distinct rather than replaced: it
 * describes the runner exhausting its declared ladder, which can happen for a
 * transient fault or a harness failure that is not a capacity problem at all.
 */
export type RunFailureReason =
	| "fork-failed"
	| "provider-capacity"
	| "model-refusal"
	| "no-model-alternative"
	| "fork-crashed"
	| "fork-setup-failed";

/**
 * Map a terminal worker outcome onto the wake's closed category.
 *
 * Every shape that publishes an early failure wake -- direct, supervised, and
 * each chain step -- calls this, so the four call sites cannot drift apart and
 * report different categories for the same failure. That drift is how #197 was
 * originally missed: `fork-failed` was the shared default, repeated by hand.
 *
 * Order matters. `failureCause` is checked first because it names WHY the
 * worker died, which is what a caller can act on; `errorKind` only says what
 * the runner did next, and `no-model-alternative` covers a capacity death, a
 * transient fault, and a harness failure alike.
 *
 * Takes only the two closed discriminants. It is deliberately not given the
 * error text: nothing here may reclassify from prose, and no prose may reach
 * the payload this feeds.
 */
export function runFailureReasonFor(outcome: {
	failureCause?: WorkerFailureCause;
	errorKind?: WorkerErrorKind;
}): RunFailureReason {
	if (outcome.failureCause === "provider-capacity") return "provider-capacity";
	if (outcome.errorKind === "refusal") return "model-refusal";
	if (outcome.errorKind === "no-model-alternative") return "no-model-alternative";
	return "fork-failed";
}

export interface RunFailureRecovery {
	/** Whether the originator can request a targeted recovery before aggregation. */
	available: boolean;
	/** Whether bounded prior-attempt context is currently available for a new child. */
	contextAvailable?: boolean;
	/** Recommended strategy for a new independent child; no provider session is reused. */
	strategy: "resume" | "fresh";
}

export interface NotifyRunFailedInput {
	runId: string;
	/** Delegate shape/mode (for example `direct` or `supervised`). */
	mode: string;
	forkName: string;
	status: "failed";
	/** Fixed categorical reason; free-form failure text is never carried. */
	reason?: RunFailureReason;
	/** Bounded snapshot of sibling states at the first failed transition. */
	siblingStates?: RunFailureSiblingState[];
	/** Explicit availability flag kept easy for an agent to inspect. */
	recoveryAvailable?: boolean;
	recovery?: RunFailureRecovery;
	/** Bounded isolated-worktree recovery evidence captured before cleanup. */
	worktreeDiff?: WorktreeDiff;
}

/** The exact `delegate:complete` custom message a completion wake sends. */
export interface CompletionMessage {
	customType: "delegate:complete";
	content: string;
	display: true;
	details: {
		runId: string;
		mode?: string;
		forks: RunResult[];
		usage: DelegateUsageTotals;
		usageByFork: ReturnType<typeof summarizeRunUsages>;
		error?: string;
		retry?: Array<Record<string, unknown>>;
		retryMetadataIncomplete?: boolean;
		retryMetadataTruncated?: boolean;
	};
}

export type PendingWakeKind = "completion" | "fork-failed" | "escalation-pending";

/** Minimal durable hint; canonical escalation data remains in the store. */
export interface EscalationPendingWakePayload {
	rootRunId: string;
	requestId: string;
	holderId: string;
	kind: EscalationKind;
}

export interface WritePendingEscalationWakeInput extends EscalationPendingWakePayload {
	/** Owning foreground session. Required so escalation wakes fail closed. */
	ownerSessionId: string;
}

/** Recovery wake for a holder whose canonical mailbox already contains the request. */
export interface EscalationPendingMessage {
	customType: "delegate:escalation-pending";
	content: string;
	display: true;
	details: EscalationPendingWakePayload;
}

/** The distinct early failure wake; never substitutes for `delegate:complete`. */
export interface RunFailedMessage {
	customType: "delegate:fork-failed";
	content: string;
	display: true;
	details: NotifyRunFailedInput;
}

/**
 * Build the `delegate:complete` wake message from a completion input. Single
 * source of truth shared by the happy-path send (`notifyCompletion`), the
 * live-sink retry, and file-based redelivery.
 */
export function buildCompletionMessage(input: NotifyCompletionInput): CompletionMessage {
	const { runId, finalResults, error } = input;
	const mode = input.mode === "orchestrate" ? "driver" : input.mode;
	const combinedContent = capDelegateOnlyResult(input.combinedContent, runId, { claimAdvisory: false }).text;
	const header = error
		? `[delegate runId=${runId} failed: ${error}]`
		: `[delegate runId=${runId} completed]`;
	return {
		customType: "delegate:complete",
		content: `${header}\n\nReturn one self-contained synthesis incorporating all relevant completed child results, including earlier results. Your next answer replaces earlier progress and addenda.\n\n${combinedContent || "(no output)"}`,
		display: true,
		details: {
			runId,
			...(mode ? { mode } : {}),
			forks: projectRunResults(finalResults, { includeDetailExtensions: true }),
			usage: aggregateRunResults(finalResults),
			usageByFork: summarizeRunUsages(finalResults),
			error,
			...(input.retry !== undefined ? { retry: input.retry } : {}),
			...(input.retryMetadataIncomplete ? { retryMetadataIncomplete: true } : {}),
			...(input.retryMetadataTruncated ? { retryMetadataTruncated: true } : {}),
		},
	};
}

const MAX_FAILURE_WAKE_SIBLINGS = 16;
const MAX_FAILURE_WAKE_ID_BYTES = 120;
const MAX_PENDING_WAKE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_FAILURE_WAKE_FILE_BYTES = 64 * 1024;

function isBoundedWakeOwnerId(value: unknown): value is string {
	return typeof value === "string" &&
		Buffer.byteLength(value, "utf8") > 0 &&
		Buffer.byteLength(value, "utf8") <= 512 &&
		!/^pid-\d+$/.test(value) &&
		!/\p{Cc}/u.test(value);
}

function boundFailureId(value: string): string {
	const safe = sanitizeRecoveryText(value)
		.replace(/\p{Cc}+/gu, " ")
		.trim();
	return truncateRecoveryText(safe, MAX_FAILURE_WAKE_ID_BYTES);
}

function boundFailureWorktreeDiff(value: unknown): WorktreeDiff | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const integer = (key: string): number | undefined => {
		const value = candidate[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	};
	const index = integer("index");
	const filesChanged = integer("filesChanged");
	const insertions = integer("insertions");
	const deletions = integer("deletions");
	if (index === undefined || filesChanged === undefined || insertions === undefined || deletions === undefined ||
		typeof candidate.agent !== "string" || typeof candidate.branch !== "string" ||
		typeof candidate.diffStat !== "string" || typeof candidate.patchPath !== "string") return undefined;
	return {
		index,
		agent: truncateRecoveryText(candidate.agent, 1024),
		branch: truncateRecoveryText(candidate.branch, 1024),
		diffStat: truncateRecoveryText(candidate.diffStat, 4096),
		filesChanged,
		insertions,
		deletions,
		patchPath: truncateRecoveryText(candidate.patchPath, 4096),
		...(candidate.captureFailed === true ? { captureFailed: true as const } : {}),
		...(candidate.captureFailed === true && typeof candidate.worktreePath === "string"
			? { worktreePath: truncateRecoveryText(candidate.worktreePath, 4096) }
			: {}),
	};
}

function boundFailureInput(input: NotifyRunFailedInput): NotifyRunFailedInput {
	const validReasons = new Set<RunFailureReason>([
		"fork-failed",
		"provider-capacity",
		"model-refusal",
		"no-model-alternative",
		"fork-crashed",
		"fork-setup-failed",
	]);
	const boundedReason = validReasons.has(input.reason as RunFailureReason)
		? input.reason as RunFailureReason
		: undefined;
	const validStatuses = new Set<RunLiveStatus>([
		"pending",
		"constructing",
		"running",
		"awaiting-escalation",
		"completed",
		"failed",
		"aborted",
		"paused",
	]);
	const siblingStates = input.siblingStates?.slice(0, MAX_FAILURE_WAKE_SIBLINGS)
		.filter((s) => validStatuses.has(s.status))
		.map((s) => ({
			forkName: boundFailureId(String(s.forkName)),
			status: s.status,
		}));
	const rawRunId = String(input.runId);
	const runId = boundFailureId(rawRunId);
	const rawEntryName = String(input.forkName);
	const forkName = boundFailureId(rawEntryName);
	// A rejected/redacted/truncated identifier can no longer address the live
	// descriptor exactly. Fail closed rather than advertise an unusable action.
	const recoveryIdentitySafe =
		isSafeRunId(rawRunId) && runId === rawRunId && forkName === rawEntryName;
	const validRecovery = input.recovery &&
		typeof input.recovery.available === "boolean" &&
		(input.recovery.strategy === "resume" || input.recovery.strategy === "fresh")
		? input.recovery
		: undefined;
	const recoveryAvailable = recoveryIdentitySafe &&
		input.recoveryAvailable === true &&
		validRecovery?.available === true;
	const worktreeDiff = boundFailureWorktreeDiff(input.worktreeDiff);
	return {
		runId,
		mode: (["direct", "supervised", "chain"] as const).includes(
			input.mode as "direct" | "supervised" | "chain",
		) ? input.mode : "unknown",
		forkName,
		status: "failed",
		...(boundedReason ? { reason: boundedReason } : {}),
		...(siblingStates ? { siblingStates } : {}),
		...(typeof input.recoveryAvailable === "boolean"
			? { recoveryAvailable }
			: {}),
		...(validRecovery
			? {
				recovery: {
					available: recoveryAvailable,
					...(typeof validRecovery.contextAvailable === "boolean"
						? { contextAvailable: recoveryAvailable && validRecovery.contextAvailable }
						: {}),
					strategy: recoveryAvailable ? validRecovery.strategy : "fresh",
				},
			}
			: {}),
		...(worktreeDiff !== undefined ? { worktreeDiff } : {}),
	};
}

/** A wake crossing a session/module boundary cannot advertise in-memory recovery. */
function withoutLiveRecovery(input: NotifyRunFailedInput): NotifyRunFailedInput {
	return {
		...input,
		recoveryAvailable: false,
		recovery: {
			available: false,
			contextAvailable: false,
			strategy: "fresh",
		},
	};
}

export function buildForkFailedMessage(input: NotifyRunFailedInput): RunFailedMessage {
	const bounded = boundFailureInput(input);
	const detail = bounded.reason ? `: ${bounded.reason}` : "";
	const terminology = getDelegatePresentationTerminology(bounded.mode);
	const entryNoun = terminology.singular;
	const identityKey = entryNoun;
	const recoveryHint = bounded.recovery?.available === true
		? `Recovery is available; call delegate_control action recover (strategy: ${bounded.recovery.strategy}). `
		: "Recovery is not available for this failure. ";
	const worktreeHint = bounded.worktreeDiff?.captureFailed === true
		? `Worktree recovery: ${formatWorktreeCaptureFailureGuidance(bounded.worktreeDiff)} `
		: bounded.worktreeDiff &&
			(bounded.worktreeDiff.filesChanged > 0 || bounded.worktreeDiff.diffStat.trim().length > 0)
			? `Worktree recovery patch: ${bounded.worktreeDiff.patchPath}. Inspect or apply it before retrying. `
			: "";
	return {
		customType: "delegate:fork-failed",
		content:
			`[delegate runId=${bounded.runId} ${identityKey}=${bounded.forkName} failed]` +
			`\n\n${bounded.mode} ${entryNoun} '${bounded.forkName}' failed${detail}. ` +
			recoveryHint + worktreeHint +
			"The normal batch-completion wake will follow.",
		display: true,
		details: bounded,
	};
}

/** Build the owner-scoped escalation recovery hint (invariant 5). */
export function buildEscalationPendingMessage(
	payload: EscalationPendingWakePayload,
): EscalationPendingMessage {
	return {
		customType: "delegate:escalation-pending",
		content:
			`[delegate escalation requestId=${payload.requestId} pending]\n\n` +
			`Durable escalation state is authoritative for rootRunId=${payload.rootRunId}; ` +
			`current holder=${payload.holderId}, kind=${payload.kind}.`,
		display: true,
		details: { ...payload },
	};
}

/**
 * Append the non-context, durable usage metadata entry to the same *fresh*
 * session sink that successfully received the completion custom message.
 * This keeps dispatch completions safe across reload/compaction: the stale
 * captured ctx is never used for metadata after its sendMessage bounces; the
 * live-sink or pending-wake redelivery path appends through the replacement
 * session instead. Best-effort: completion-message details carry the same
 * rollup, so a metadata append failure must never lose the wake.
 */
export function appendCompletionUsageMetadata(
	sink: NotifyCompletionSink,
	input: NotifyCompletionInput,
	agentDir?: string,
): DelegateUsageMetadata | undefined {
	if (typeof sink.appendEntry !== "function") return undefined;
	const metadata = buildDelegateUsageMetadata(input.runId, input.finalResults, input.mode);
	if (metadata.usage.totalTokens <= 0 && metadata.usage.cost <= 0 && metadata.usage.forks <= 0) {
		return undefined;
	}
	try {
		sink.appendEntry(metadata.customType, metadata);
		return metadata;
	} catch (err) {
		logDelegateDiagnostic(
			`failed to append delegate usage metadata (runId=${input.runId}): ${(err as Error)?.message ?? err}`,
			{ agentDir, level: "warn" },
		);
		return undefined;
	}
}

/**
 * Send a completion wake, with stale-session live-sink retry and pending-wake
 * persistence. Kept here so pending-wake tests can exercise the redelivery
 * behavior without importing the extension entrypoint and all of its providers.
 */
export function notifyCompletion(
	sink: NotifyCompletionSink,
	input: NotifyCompletionInput,
	opts?: { agentDir?: string; ownerSessionId?: string },
): void {
	const { runId } = input;
	const wakeRetry = retryProjectionForWake(runId, input.finalResults);
	const effectiveInput: NotifyCompletionInput = {
		...input,
		...(input.mode === "orchestrate" ? { mode: "driver" } : {}),
		completionNotifyStrategy: resolveCompletionNotifyStrategy(input.completionNotifyStrategy),
		...(wakeRetry.projection ? { retry: wakeRetry.projection } : {}),
		...(wakeRetry.incomplete ? { retryMetadataIncomplete: true } : {}),
		...(wakeRetry.truncated ? { retryMetadataTruncated: true } : {}),
	};
	// Normal callers gate this one-shot side effect on completeRun's successful
	// terminal transition; durable redelivery is serialized by the file claim.
	// No secondary in-memory dedup key set is maintained here.
	const message = buildCompletionMessage(effectiveInput);
	try {
		deliverWakeMessage(sink, message);
		appendCompletionUsageMetadata(sink, effectiveInput, opts?.agentDir);
	} catch (err) {
		if (String((err as Error)?.message ?? "").includes("stale after session replacement")) {
			const live = getLiveWakeSink();
			const liveOwnerSessionId = getLiveWakeSinkOwnerSessionId();
			const liveOwnerMatches =
				!opts?.ownerSessionId || liveOwnerSessionId === opts.ownerSessionId;
			if (live && live !== sink && liveOwnerMatches) {
				try {
					deliverWakeMessage(live, message);
					appendCompletionUsageMetadata(live, effectiveInput, opts?.agentDir);
					logDelegateDiagnostic(
						`dispatch auto-wake redelivered via live session ctx (runId=${runId})`,
						{ agentDir: opts?.agentDir, level: "log" },
					);
					return;
				} catch (retryErr) {
					logDelegateDiagnostic(
						`dispatch auto-wake live-sink retry failed (runId=${runId}): ` +
							`${(retryErr as Error)?.message ?? retryErr}`,
						{ agentDir: opts?.agentDir, level: "warn" },
					);
				}
			}
			if (opts?.agentDir && writePendingWake(opts.agentDir, effectiveInput, { ownerSessionId: opts.ownerSessionId })) {
				logDelegateDiagnostic(
					`dispatch auto-wake deferred: parent ctx stale (runId=${runId}); ` +
						`pending wake persisted, redelivers on next session_start`,
					{ agentDir: opts?.agentDir, level: "warn" },
				);
			} else {
				logDelegateDiagnostic(
					`dispatch auto-wake skipped: parent ctx stale (runId=${runId}); ` +
						`result persisted, retrievable via delegate_control(action="result", runId)`,
					{ agentDir: opts?.agentDir, level: "warn" },
				);
			}
			return;
		}
		if (isProcessingRace(err)) {
			// A late SDK race can still throw after its processing-state check.
			// Preserve the completed run and let startup/maintenance retry from the
			// durable queue instead of turning report delivery into run-entry failure.
			if (opts?.agentDir && writePendingWake(opts.agentDir, effectiveInput, { ownerSessionId: opts.ownerSessionId })) {
				logDelegateDiagnostic(
					`dispatch auto-wake queued after recipient processing race (runId=${runId})`,
					{ agentDir: opts?.agentDir, level: "warn" },
				);
				return;
			}
		}
		throw err;
	}
	logDelegateDiagnostic(
		`dispatch complete runId=${runId} strategy=${effectiveInput.completionNotifyStrategy}`,
		{ agentDir: opts?.agentDir, level: "log" },
	);
}

const FORK_FAILURE_WAKE_KEYS = Symbol.for("pi-delegate.forkFailureWakeKeys");
const MAX_FORK_FAILURE_WAKE_KEYS = 2_048;

function runFailureWakeKeys(): Set<string> {
	const g = globalThis as Record<symbol, unknown>;
	if (!(g[FORK_FAILURE_WAKE_KEYS] instanceof Set)) g[FORK_FAILURE_WAKE_KEYS] = new Set<string>();
	return g[FORK_FAILURE_WAKE_KEYS] as Set<string>;
}

/**
 * Clear the process-global run-entry-failure deduplication keys.
 *
 * Production callers should never need this; it is exported so isolated test
 * cases (including watch-mode re-runs) can reset the global state they share.
 */
export function __resetForkFailureWakeKeysForTests(): void {
	runFailureWakeKeys().clear();
}

export type RunFailureWakeDisposition =
	| "live"
	| "duplicate"
	| "cross-boundary"
	| "dropped";

function rememberRunFailureWakeKey(keys: Set<string>, key: string): void {
	keys.add(key);
	while (keys.size > MAX_FORK_FAILURE_WAKE_KEYS) {
		const oldest = keys.values().next().value as string | undefined;
		if (oldest === undefined) break;
		keys.delete(oldest);
	}
}

/**
 * Deliver the first failed transition for one run entry. This is deliberately
 * separate from `notifyCompletion`: an early failure wakes the originator
 * without consuming or replacing the one terminal batch-completion wake.
 */
export function notifyForkFailed(
	sink: NotifyCompletionSink,
	input: NotifyRunFailedInput,
	opts?: { agentDir?: string; ownerSessionId?: string },
): RunFailureWakeDisposition {
	const key = crypto.createHash("sha256")
		.update(String(input.runId))
		.update("\0")
		.update(String(input.forkName))
		.digest("hex");
	const keys = runFailureWakeKeys();
	if (keys.has(key)) return "duplicate";
	const message = buildForkFailedMessage(input);
	const entryNoun = getDelegatePresentationTerminology(input.mode).singular;
	try {
		deliverWakeMessage(sink, message);
		rememberRunFailureWakeKey(keys, key);
		logDelegateDiagnostic(`dispatch ${entryNoun} failure runId=${boundFailureId(input.runId)} ${entryNoun}=${boundFailureId(input.forkName)}`, {
			agentDir: opts?.agentDir,
			level: "log",
		});
		return "live";
	} catch (err) {
		const stale = String((err as Error)?.message ?? "").includes("stale after session replacement");
		const processingRace = isProcessingRace(err);
		const live = getLiveWakeSink();
		const liveOwnerSessionId = getLiveWakeSinkOwnerSessionId();
		const liveOwnerMatches = !opts?.ownerSessionId || liveOwnerSessionId === opts.ownerSessionId;
		if (stale && live && live !== sink && liveOwnerMatches) {
			try {
				// A replacement module cannot access this module instance's descriptor.
				deliverWakeMessage(live, buildForkFailedMessage(withoutLiveRecovery(input)));
				rememberRunFailureWakeKey(keys, key);
				return "cross-boundary";
			} catch {
				logDelegateDiagnostic(
					`${entryNoun} failure live-sink retry failed (runId=${boundFailureId(input.runId)}, ${entryNoun}=${boundFailureId(input.forkName)}); diagnostic omitted`,
					{ agentDir: opts?.agentDir, level: "warn" },
				);
			}
		}
		if (
			opts?.agentDir &&
			writePendingRunFailedWake(opts.agentDir, input, { ownerSessionId: opts.ownerSessionId })
		) {
			rememberRunFailureWakeKey(keys, key);
			return "cross-boundary";
		}
		if (!stale && !processingRace) throw err;
		logDelegateDiagnostic(
			`${entryNoun} failure wake dropped after delivery failure (runId=${boundFailureId(input.runId)}, ${entryNoun}=${boundFailureId(input.forkName)})`,
			{ agentDir: opts?.agentDir, level: "warn" },
		);
		return "dropped";
	}
}

// ── Live-sink registry (same-process replacement) ─────────────────────────
//
// pi's extension loader imports with `moduleCache: false`, so a session
// replacement re-imports this module FRESH — a module-level variable written
// by the new instance is invisible to the old instance still running the
// detached dispatch promise. `globalThis` is shared by every module instance
// in the process, so a Symbol.for-keyed slot is the one place the OLD
// instance's stale-wake path can find the NEW instance's live ctx.

const LIVE_WAKE_SINK_KEY = Symbol.for("pi-delegate.liveWakeSink");
const LIVE_WAKE_SINK_OWNER_SESSION_KEY = Symbol.for("pi-delegate.liveWakeSink.ownerSessionId");
const LIVE_WAKE_SINK_CONTEXT_KEY = Symbol.for("pi-delegate.liveWakeSink.asyncContext");

/** Register the current foreground session's ctx as the live wake sink. */
export function setLiveWakeSink(sink: NotifyCompletionSink, ownerSessionId?: string): void {
	const g = globalThis as Record<symbol, unknown>;
	g[LIVE_WAKE_SINK_KEY] = sink;
	// Capture the replacement recipient too: a stale child callback that retries
	// through this global sink must not carry the child's ALS frame into the new
	// foreground session.
	g[LIVE_WAKE_SINK_CONTEXT_KEY] = captureCurrentAsyncContext();
	if (ownerSessionId) g[LIVE_WAKE_SINK_OWNER_SESSION_KEY] = ownerSessionId;
	else delete g[LIVE_WAKE_SINK_OWNER_SESSION_KEY];
}

/** The most recently registered live wake sink in this process, if any. */
export function getLiveWakeSink(): NotifyCompletionSink | undefined {
	const v = (globalThis as Record<symbol, unknown>)[LIVE_WAKE_SINK_KEY];
	return v && typeof (v as NotifyCompletionSink).sendMessage === "function"
		? (v as NotifyCompletionSink)
		: undefined;
}

/** Owning foreground session id for the live wake sink, when the foreground exposed one. */
export function getLiveWakeSinkOwnerSessionId(): string | undefined {
	const v = (globalThis as Record<symbol, unknown>)[LIVE_WAKE_SINK_OWNER_SESSION_KEY];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Clear the live wake sink — but only if it is still `sink` (a session going
 * down must not clobber a successor's already-registered fresh sink). Called
 * from `session_shutdown` so the stale-wake path never retries through a ctx
 * known to be on its way out.
 */
export function clearLiveWakeSink(sink: NotifyCompletionSink): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[LIVE_WAKE_SINK_KEY] === sink) {
		delete g[LIVE_WAKE_SINK_KEY];
		delete g[LIVE_WAKE_SINK_OWNER_SESSION_KEY];
		delete g[LIVE_WAKE_SINK_CONTEXT_KEY];
	}
}

// ── Pending-wake files ─────────────────────────────────────────────────────

interface PendingWakeRecordBase {
	version: 1;
	/** Missing/absent kind is the legacy completion wake format. */
	kind?: PendingWakeKind;
	runId: string;
	/** Epoch ms when the wake was dropped. */
	droppedAt: number;
	/** Pid of the process that dropped the wake (owner-scoping, issue #2 item 4). */
	owningPid: number;
	/** Process nonce of the dropping process — guards `owningPid` against OS pid reuse. */
	owningNonce: string;
	/** Owning foreground session id. Missing means legacy/unscoped wake. */
	ownerSessionId?: string;
	/** Run generation stamp; absent only on legacy records. */
	generationCreatedAt?: number;
}

/** On-disk record for a dropped completion wake. `input.finalResults` is bounded (see `boundInput`). */
export interface PendingCompletionWakeRecord extends PendingWakeRecordBase {
	kind?: "completion";
	input: NotifyCompletionInput;
	/** Exact prior-carrier references whose pins must be released before delivery. */
	supersededArtifactRefs?: WorkerArtifactReference[];
}

export interface PendingRunFailedWakeRecord extends PendingWakeRecordBase {
	kind: "fork-failed";
	forkName: string;
	input: NotifyRunFailedInput;
}

/** On-disk owner-scoped hint for a canonical pending escalation. */
export interface PendingEscalationWakeRecord extends PendingWakeRecordBase {
	kind: "escalation-pending";
	payload: EscalationPendingWakePayload;
}

export type PendingWakeRecord =
	| PendingCompletionWakeRecord
	| PendingRunFailedWakeRecord
	| PendingEscalationWakeRecord;

export function resolvePendingWakesDir(agentDir: string): string {
	return path.join(agentDir, "extensions", "pi-delegate", "pending-wakes");
}

function resolvePendingRunFailureWakeFile(agentDir: string, runId: string, forkName: string): string {
	const suffix = crypto.createHash("sha256").update(forkName).digest("hex").slice(0, 16);
	return path.join(resolvePendingWakesDir(agentDir), `${runId}.fork-failed-${suffix}.json`);
}

/** Stable request-scoped wake path; avoids colliding with completion wakes. */
export function resolvePendingEscalationWakeFile(
	agentDir: string,
	rootRunId: string,
	requestId: string,
): string {
	if (!isSafeRunId(rootRunId) || !isSafeRunId(requestId)) {
		throw new Error("unsafe escalation wake identity");
	}
	const suffix = crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 16);
	return path.join(resolvePendingWakesDir(agentDir), `${rootRunId}.escalation-${suffix}.json`);
}

/**
 * Bound the persisted payload: drop per-run-entry transcripts. Retired worker
 * session records remain part of the wake details because they carry the
 * provider-error history needed to explain a failed replacement. They are
 * already projected at the result boundary, while the LLM-visible `content`
 * remains rebuilt from the EXACTLY-preserved `combinedContent`.
 */
function boundInput(input: NotifyCompletionInput): NotifyCompletionInput {
	return {
		runId: input.runId,
		...(input.mode !== undefined ? { mode: input.mode === "orchestrate" ? "driver" : input.mode } : {}),
		completionNotifyStrategy: resolveCompletionNotifyStrategy(input.completionNotifyStrategy),
		...(input.retry ? { retry: sanitizeWakeRetryProjection(input.retry) } : {}),
		...(input.retryMetadataIncomplete ? { retryMetadataIncomplete: true } : {}),
		...(input.retryMetadataTruncated ? { retryMetadataTruncated: true } : {}),
		finalResults: projectRunResults(input.finalResults, { includeDetailExtensions: true }).map((result) => {
			result.transcript = [];
			return result;
		}),
		combinedContent: capDelegateOnlyResult(input.combinedContent, input.runId, { claimAdvisory: false }).text,
		...(input.error !== undefined ? { error: input.error } : {}),
	};
}

// A wake owns its pin until the exact wake/claim is consumed or removed.
const DURABLE_WAKE_ARTIFACT_PIN_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
const PROVISIONAL_WAKE_ARTIFACT_PIN_RETENTION_MS = (7 * 24 - 1) * 60 * 60 * 1000;

type WakeArtifactPin = { ref: WorkerArtifactReference; pinId: string };

function wakeArtifactPin(runId: string, ref: WorkerArtifactReference): WakeArtifactPin {
	const digest = crypto.createHash("sha256")
		.update(`${runId}\0${ref.artifactId}`, "utf8")
		.digest("hex").slice(0, 48);
	return { ref, pinId: `wake-${digest}` };
}

function pendingWakeArtifactPins(record: PendingCompletionWakeRecord): WakeArtifactPin[] {
	const pins: WakeArtifactPin[] = [];
	for (const result of record.input.finalResults) {
		const candidate = (result as unknown as Record<string, unknown>).artifactRef;
		if (candidate === undefined) continue;
		try {
			pins.push(wakeArtifactPin(record.runId, validateWorkerArtifactReference(candidate)));
		} catch { /* the result projection boundary removes malformed references */ }
	}
	return pins;
}

function pinPendingWakeArtifacts(
	record: PendingCompletionWakeRecord,
	options: { expiresAt?: string; skipPinIds?: ReadonlySet<string> } = {},
): WakeArtifactPin[] {
	const pinned: WakeArtifactPin[] = [];
	try {
		for (const entry of pendingWakeArtifactPins(record)) {
			if (options.skipPinIds?.has(entry.pinId)) continue;
			pinWorkerArtifactSync(entry.ref, entry.pinId, {
				expiresAt: options.expiresAt ?? DURABLE_WAKE_ARTIFACT_PIN_EXPIRES_AT,
				timeoutMs: 0,
			});
			pinned.push(entry);
		}
		return pinned;
	} catch (error) {
		unpinWakeArtifactPins(pinned);
		throw error;
	}
}

function unpinWakeArtifactPins(pins: readonly WakeArtifactPin[], strict = false): void {
	for (const entry of pins) {
		try { unpinWorkerArtifactSync(entry.ref, entry.pinId, { timeoutMs: 0 }); }
		catch (error) { if (strict) throw error; }
	}
}

function supersededWakeArtifactRefs(record: PendingCompletionWakeRecord): WorkerArtifactReference[] {
	if (!Array.isArray(record.supersededArtifactRefs)) return [];
	return record.supersededArtifactRefs.flatMap((value) => {
		try { return [validateWorkerArtifactReference(value)]; } catch { return []; }
	});
}

function releaseSupersededWakePins(record: PendingCompletionWakeRecord): void {
	for (const ref of supersededWakeArtifactRefs(record)) {
		const pin = wakeArtifactPin(record.runId, ref);
		unpinWorkerArtifactSync(ref, pin.pinId, { timeoutMs: 0 });
	}
}

function releasePendingWakeArtifacts(record: PendingCompletionWakeRecord, now = Date.now()): void {
	const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
	for (const entry of pendingWakeArtifactPins(record)) {
		pinWorkerArtifactSync(entry.ref, entry.pinId, { expiresAt, timeoutMs: 0 });
	}
}

function renewPendingWakeArtifacts(record: PendingCompletionWakeRecord): void {
	for (const result of record.input.finalResults) {
		const projected = result as unknown as Record<string, unknown>;
		if (projected.artifactRef === undefined) continue;
		try {
			const ref = validateWorkerArtifactReference(projected.artifactRef);
			const pin = pendingWakeArtifactPins({ ...record, input: { ...record.input, finalResults: [result] } })[0];
			if (!pin) throw new Error("artifact reference is invalid");
			pinWorkerArtifactSync(ref, pin.pinId, { expiresAt: DURABLE_WAKE_ARTIFACT_PIN_EXPIRES_AT, timeoutMs: 0 });
		} catch (error) {
			// Metadata contention is retryable. Leave the durable wake and its exact
			// reference untouched so a later scan can renew and deliver it.
			if (error instanceof WorkerArtifactStorageBusyError) throw error;
			delete projected.artifactRef;
			projected.artifactError = {
				kind: "artifact-unavailable", message: error instanceof Error ? error.message : String(error), retryable: false,
			};
		}
	}
}

function writePendingWakeTemp(tmp: string, serialized: string): void {
	try {
		fs.writeFileSync(tmp, serialized, { mode: STATE_FILE_MODE, flag: "wx" });
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
		// A stale deterministic temp path must never be opened for writing: its
		// existing inode may still be readable by another process.
		fs.rmSync(tmp, { force: true });
		fs.writeFileSync(tmp, serialized, { mode: STATE_FILE_MODE, flag: "wx" });
	}
	ensureOwnerOnlyFile(tmp);
}


/** Re-validate retry facts at the durable boundary. The wake is not a trusted
 * runtime snapshot, so unknown keys, names, text, and malformed numbers never
 * cross redelivery even when an attacker edits the JSON file. */
function sanitizeWakeRetryProjection(value: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
	return value.slice(0, MAX_WAKE_RETRY_PROJECTION).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const ordinal = entry.ordinal;
		const attempt = entry.attempt;
		if (!Number.isSafeInteger(ordinal) || !Number.isSafeInteger(attempt) ||
			typeof entry.isRetry !== "boolean") return [];
		const safeOrdinal = ordinal as number;
		const safeAttempt = attempt as number;
		if (safeOrdinal < 0 || safeOrdinal >= MAX_WAKE_RETRY_PROJECTION || safeAttempt < 1 || safeAttempt > 100) return [];
		const out: Record<string, unknown> = { ordinal: safeOrdinal, attempt: safeAttempt, isRetry: entry.isRetry };
		if (typeof entry.predecessorRunId === "string" && isSafeRunId(entry.predecessorRunId)) out.predecessorRunId = entry.predecessorRunId;
		if (entry.incomplete === true) out.incomplete = true;
		if (entry.cumulativeUsage && typeof entry.cumulativeUsage === "object" && !Array.isArray(entry.cumulativeUsage)) {
			const usage: Record<string, unknown> = {};
			for (const key of RETRY_PROJECTION_USAGE_KEYS) {
				const number = (entry.cumulativeUsage as Record<string, unknown>)[key];
				if (typeof number === "number" && Number.isFinite(number) && number >= 0) usage[key] = number;
			}
			out.cumulativeUsage = usage;
		}
		return [out];
	});
}

const MAX_WAKE_RETRY_PROJECTION = MAX_RETRY_PROJECTION_ENTRIES;
function retryProjectionForWake(runId: string, results: readonly RunResult[]): {
	projection?: Array<Record<string, unknown>>;
	incomplete?: boolean;
	truncated?: boolean;
} {
	const run = getRun(runId);
	// `detached` is the ordinary async-dispatch marker, not the detached
	// orchestrate transport. Direct and supervised background runs still expose
	// bounded retry facts; chain/orchestrate paths do not support retry.
	if (!run || run.shape === "chain") return {};
	const allRuns = listRuns();
	const lookup = (candidateRunId: string, forkName: string): RetryProjectionFork | undefined => {
		const fork = allRuns.find((entry) => entry.runId === candidateRunId)?.forks[forkName];
		return fork ? ({ ...fork, runId: candidateRunId, usage: fork.completedResult?.usage ?? fork.usage } as unknown as RetryProjectionFork) : undefined;
	};
	const ordered = results.flatMap((result) => {
		const fork = run.forks[result.name];
		return fork ? [({ ...fork, runId, usage: fork.completedResult?.usage ?? fork.usage } as unknown as RetryProjectionFork)] : [];
	});
	const projection = buildRetryProjection(ordered, lookup);
	return { projection: projection.entries.map((entry) => ({ ...entry })), incomplete: projection.retryMetadataIncomplete, truncated: projection.retryMetadataTruncated };
}

/**
 * Persist a dropped wake for redelivery on the next `session_start`.
 */
export function writePendingWake(
	agentDir: string,
	input: NotifyCompletionInput,
	opts?: { ownerSessionId?: string },
): boolean {
	if (!isSafeRunId(input.runId)) {
		logDelegateDiagnostic(
			`pending-wake refused: unsafe runId ${JSON.stringify(String(input.runId)).slice(0, 160)}`,
			{ agentDir, level: "warn" },
		);
		return false;
	}
	const droppedAt = Date.now();
	const record: PendingCompletionWakeRecord = {
		version: 1,
		runId: input.runId,
		droppedAt,
		generationCreatedAt: getRun(input.runId)?.createdAt ?? droppedAt,
		owningPid: process.pid,
		owningNonce: getProcessNonce(),
		...(opts?.ownerSessionId ? { ownerSessionId: opts.ownerSessionId } : {}),
		input: boundInput(input),
	};
	const dir = resolvePendingWakesDir(agentDir);
	const file = path.join(dir, `${input.runId}.json`);
	const tmp = `${file}.tmp-${process.pid}`;
	let pinned: WakeArtifactPin[] | undefined;
	try {
		ensureOwnerOnlyDirectory(dir);
		return withStateFileLock(file, () => {
			let prior: PendingWakeRecord | undefined;
			try { prior = JSON.parse(fs.readFileSync(file, "utf8")) as PendingWakeRecord; } catch { /* absent or malformed predecessor */ }
			const priorCompletion = prior && (prior.kind ?? "completion") === "completion"
				? prior as PendingCompletionWakeRecord
				: undefined;
			if (priorCompletion) {
				const priorGeneration = priorCompletion.generationCreatedAt ?? priorCompletion.droppedAt;
				if (priorGeneration > record.generationCreatedAt! ||
					(priorGeneration === record.generationCreatedAt && priorCompletion.droppedAt > record.droppedAt)) return false;
				const currentPins = new Set(pendingWakeArtifactPins(record).map((entry) => entry.pinId));
				const carried = [
					...pendingWakeArtifactPins(priorCompletion).map((entry) => entry.ref),
					...supersededWakeArtifactRefs(priorCompletion),
				];
				const seen = new Set<string>();
				record.supersededArtifactRefs = carried.filter((ref) => {
					const pinId = wakeArtifactPin(record.runId, ref).pinId;
					if (currentPins.has(pinId) || seen.has(pinId)) return false;
					seen.add(pinId);
					return true;
				});
				if (record.supersededArtifactRefs.length === 0) delete record.supersededArtifactRefs;
			}
			const existingPinIds = new Set(priorCompletion ? pendingWakeArtifactPins(priorCompletion).map((entry) => entry.pinId) : []);
			pinned = pinPendingWakeArtifacts(record, {
				expiresAt: new Date(Date.now() + PROVISIONAL_WAKE_ARTIFACT_PIN_RETENTION_MS).toISOString(),
				skipPinIds: existingPinIds,
			});
			writePendingWakeTemp(tmp, JSON.stringify(record));
			fs.renameSync(tmp, file);
			try {
				renewPendingWakeArtifacts(record);
			} catch (error) {
				// Publication already committed with bounded provisional pins. Restart
				// scan repairs them; returning false could create a competing carrier.
				logDelegateDiagnostic(
					`pending-wake durable pin repair deferred runId=${input.runId}: ${(error as Error).message}`,
					{ agentDir, level: "warn" },
				);
			}
			return true;
		});
	} catch (err) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort tmp cleanup */ }
		if (pinned) unpinWakeArtifactPins(pinned);
		logDelegateDiagnostic(
			`failed to persist pending wake for runId=${input.runId}: ${(err as Error)?.message ?? err}`,
			{ agentDir, level: "warn" },
		);
		return false;
	}
}

/** Persist one early run-entry-failure wake without colliding with completion wake data. */
export function writePendingRunFailedWake(
	agentDir: string,
	input: NotifyRunFailedInput,
	opts?: { ownerSessionId?: string },
): boolean {
	const ownerSessionId = opts?.ownerSessionId;
	if (
		!isSafeRunId(input.runId) ||
		input.forkName.length === 0 ||
		!isBoundedWakeOwnerId(ownerSessionId)
	) return false;
	// Pending delivery necessarily crosses the live module boundary. Recovery
	// descriptors are intentionally in-memory only, so fail closed in the record.
	const boundedInput = boundFailureInput(withoutLiveRecovery(input));
	// If redaction/truncation makes the run id non-addressable, do not create a
	// durable record that the integrity scanner must reject later.
	if (!isSafeRunId(boundedInput.runId)) return false;
	const record: PendingRunFailedWakeRecord = {
		version: 1,
		kind: "fork-failed",
		runId: boundedInput.runId,
		droppedAt: Date.now(),
		owningPid: process.pid,
		owningNonce: getProcessNonce(),
		ownerSessionId,
		forkName: boundedInput.forkName,
		input: boundedInput,
	};
	const file = resolvePendingRunFailureWakeFile(agentDir, input.runId, input.forkName);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		const serialized = JSON.stringify(record);
		if (Buffer.byteLength(serialized, "utf8") > MAX_PENDING_FAILURE_WAKE_FILE_BYTES) return false;
		ensureOwnerOnlyDirectory(resolvePendingWakesDir(agentDir));
		writePendingWakeTemp(tmp, serialized);
		fs.renameSync(tmp, file);
		return true;
	} catch {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort tmp cleanup */ }
		const entryNoun = getDelegatePresentationTerminology(input.mode).singular;
		logDelegateDiagnostic(
			`failed to persist ${entryNoun} failure wake for runId=${boundFailureId(input.runId)} ${entryNoun}=${boundFailureId(input.forkName)}; diagnostic omitted`,
			{ agentDir, level: "warn" },
		);
		return false;
	}
}

/** @deprecated Use {@link writePendingRunFailedWake}; retained for compatibility. */
export const writePendingForkFailedWake = writePendingRunFailedWake;

/**
 * Persist an escalation hint only after its canonical request exists.
 * The caller owns that ordering (invariant 1); this function mirrors the
 * established owner/nonce and 0700/0600 pending-wake discipline.
 */
export function writePendingEscalationWake(
	agentDir: string,
	input: WritePendingEscalationWakeInput,
): boolean {
	if (
		!isSafeRunId(input.rootRunId) ||
		!isSafeRunId(input.requestId) ||
		input.holderId.trim() === "" ||
		input.ownerSessionId.trim() === "" ||
		!["decision", "blocker", "amendment"].includes(input.kind)
	) return false;
	const record: PendingEscalationWakeRecord = {
		version: 1,
		kind: "escalation-pending",
		runId: input.rootRunId,
		droppedAt: Date.now(),
		owningPid: process.pid,
		owningNonce: getProcessNonce(),
		ownerSessionId: input.ownerSessionId,
		payload: {
			rootRunId: input.rootRunId,
			requestId: input.requestId,
			holderId: input.holderId,
			kind: input.kind,
		},
	};
	const file = resolvePendingEscalationWakeFile(agentDir, input.rootRunId, input.requestId);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		ensureOwnerOnlyDirectory(resolvePendingWakesDir(agentDir));
		writePendingWakeTemp(tmp, JSON.stringify(record));
		fs.renameSync(tmp, file);
		return true;
	} catch (err) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort tmp cleanup */ }
		logDelegateDiagnostic(
			`failed to persist escalation wake requestId=${input.requestId}: ${(err as Error)?.message ?? err}`,
			{ agentDir, level: "warn" },
		);
		return false;
	}
}

/** Update the holder hint after a durable forward, retaining ownership. */
export function updatePendingEscalationWakeHolder(
	agentDir: string,
	rootRunId: string,
	requestId: string,
	holderId: string,
): boolean {
	let file: string;
	try {
		file = resolvePendingEscalationWakeFile(agentDir, rootRunId, requestId);
	} catch {
		return false;
	}
	for (const candidate of [file, `${file}.delivered`]) {
		try {
			const record = JSON.parse(fs.readFileSync(candidate, "utf8")) as PendingWakeRecord;
			if (record.kind !== "escalation-pending") continue;
			fs.writeFileSync(candidate, JSON.stringify({
				...record,
				payload: { ...record.payload, holderId },
			}), { mode: 0o600 });
			fs.chmodSync(candidate, 0o600);
			return true;
		} catch {
			/* missing/malformed hints are non-canonical */
		}
	}
	return false;
}

/** Remove one request-scoped escalation hint (including an in-flight claim). */
export function removePendingEscalationWake(
	agentDir: string,
	rootRunId: string,
	requestId: string,
): void {
	try {
		const file = resolvePendingEscalationWakeFile(agentDir, rootRunId, requestId);
		fs.rmSync(file, { force: true });
		fs.rmSync(`${file}.delivered`, { force: true });
	} catch {
		/* best-effort hint cleanup */
	}
}

/** Remove all escalation hints belonging to one terminal root run. */
export function removePendingEscalationWakesForRoot(agentDir: string, rootRunId: string): void {
	const dir = resolvePendingWakesDir(agentDir);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json") || name.endsWith(".json.delivered"));
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf8")) as PendingWakeRecord;
			if (record.kind !== "escalation-pending" || record.payload.rootRunId !== rootRunId) continue;
			fs.rmSync(file, { force: true });
		} catch {
			/* malformed or concurrently consumed hints are non-canonical */
		}
	}
}

/** Remove a pending wake file for a run, plus any in-flight claim file. Best-effort. */
export function removePendingWake(agentDir: string, runId: string): void {
	if (!isSafeRunId(runId)) return;
	const file = path.join(resolvePendingWakesDir(agentDir), `${runId}.json`);
	tryWithStateFileLock(file, () => {
		for (const candidate of [file, `${file}.delivered`]) {
			try {
				const before = fs.lstatSync(candidate);
				if (!before.isFile() || before.isSymbolicLink()) continue;
				const serialized = fs.readFileSync(candidate, "utf8");
				let record: PendingWakeRecord | undefined;
				try { record = JSON.parse(serialized) as PendingWakeRecord; } catch { /* malformed carrier has no trusted pins */ }
				if (record && (record.kind ?? "completion") === "completion") {
					const completion = record as PendingCompletionWakeRecord;
					releaseSupersededWakePins(completion);
					releasePendingWakeArtifacts(completion);
				}
				const current = fs.lstatSync(candidate);
				if (current.dev !== before.dev || current.ino !== before.ino || fs.readFileSync(candidate, "utf8") !== serialized) continue;
				const tombstone = `${candidate}.removed-${crypto.randomUUID()}`;
				fs.renameSync(candidate, tombstone);
				const moved = fs.lstatSync(tombstone);
				if (moved.dev !== before.dev || moved.ino !== before.ino) {
					try { if (!fs.existsSync(candidate)) fs.renameSync(tombstone, candidate); } catch { /* preserve unknown identity */ }
					continue;
				}
				// Pins are now bounded and only the exact captured carrier is removed.
				fs.rmSync(tombstone, { force: true });
			} catch {
				/* best-effort cleanup leaves this exact carrier retryable */
			}
		}
	});
}

/** A pending (dropped-but-undelivered) wake + its source file revision. */
export interface PendingWake {
	file: string;
	record: PendingWakeRecord;
	fileDev: number;
	fileIno: number;
	revision: string;
}

/**
 * Scan the pending-wakes dir for dropped wakes, recovering stale claims first
 * (same discipline as the orchestrate pending-results scan). Malformed /
 * unreadable entries are skipped (best-effort). Missing dir → `[]`.
 */
export function scanPendingWakes(agentDir: string): PendingWake[] {
	const dir = resolvePendingWakesDir(agentDir);
	let entries: string[];
	try {
		sweepStaleClaims(dir);
		entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: PendingWake[] = [];
	for (const name of entries) {
		const file = path.join(dir, name);
		try {
			const stat = fs.lstatSync(file);
			if (
				!stat.isFile() || stat.isSymbolicLink() ||
				stat.size > MAX_PENDING_WAKE_FILE_BYTES ||
				(name.includes(".fork-failed-") && stat.size > MAX_PENDING_FAILURE_WAKE_FILE_BYTES)
			) continue;
			const serialized = fs.readFileSync(file, "utf8");
			const revision = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
			const record = JSON.parse(serialized) as PendingWakeRecord;
			const kind = record.kind ?? "completion";
			if (
				record?.version !== 1 ||
				(kind !== "completion" && kind !== "fork-failed" && kind !== "escalation-pending") ||
				!isSafeRunId(record.runId) ||
				!Number.isFinite(record.droppedAt) || record.droppedAt <= 0 ||
				!Number.isInteger(record.owningPid) || record.owningPid <= 0 ||
				typeof record.owningNonce !== "string" ||
				Buffer.byteLength(record.owningNonce, "utf8") === 0 ||
				Buffer.byteLength(record.owningNonce, "utf8") > 256 ||
				(record.generationCreatedAt !== undefined && (!Number.isFinite(record.generationCreatedAt) || record.generationCreatedAt <= 0)) ||
				(record.ownerSessionId !== undefined && (
					typeof record.ownerSessionId !== "string" ||
					Buffer.byteLength(record.ownerSessionId, "utf8") === 0 ||
					Buffer.byteLength(record.ownerSessionId, "utf8") > 512 ||
					/\p{Cc}/u.test(record.ownerSessionId)
				))
			) {
				continue;
			}
			if (kind === "completion") {
				const completionRecord = record as PendingCompletionWakeRecord;
				if (
					completionRecord.input?.runId !== completionRecord.runId ||
					typeof completionRecord.input?.combinedContent !== "string" ||
					!Array.isArray(completionRecord.input?.finalResults) ||
					completionRecord.input?.runId !== completionRecord.runId
				) {
					continue;
				}
				const boundedInput = boundInput(completionRecord.input);
				if (boundedInput.runId !== completionRecord.runId) continue;
				completionRecord.input = boundedInput;
				completionRecord.supersededArtifactRefs = supersededWakeArtifactRefs(completionRecord);
				const repaired = tryWithStateFileLock(file, () => {
					try {
						const currentStat = fs.lstatSync(file);
						const currentSerialized = fs.readFileSync(file, "utf8");
						const currentRevision = crypto.createHash("sha256").update(currentSerialized, "utf8").digest("hex");
						if (!currentStat.isFile() || currentStat.isSymbolicLink() ||
							currentStat.dev !== stat.dev || currentStat.ino !== stat.ino || currentRevision !== revision) return false;
						releaseSupersededWakePins(completionRecord);
						renewPendingWakeArtifacts(completionRecord);
						return true;
					} catch {
						return false;
					}
				});
				if (repaired.acquired && repaired.value) {
					out.push({ file, record: completionRecord, fileDev: stat.dev, fileIno: stat.ino, revision });
				}
				continue;
			}
			if (kind === "fork-failed") {
				const failureRecord = record as PendingRunFailedWakeRecord;
				if (
					!isSafeRunId(failureRecord.runId) ||
					failureRecord.input?.runId !== failureRecord.runId ||
					typeof failureRecord.forkName !== "string" ||
					failureRecord.input?.forkName !== failureRecord.forkName ||
					typeof failureRecord.input?.runId !== "string" ||
					!(["direct", "supervised", "chain"] as const).includes(
						failureRecord.input?.mode as "direct" | "supervised" | "chain",
					) ||
					typeof failureRecord.input?.forkName !== "string" ||
					failureRecord.input?.status !== "failed" ||
					!isBoundedWakeOwnerId(failureRecord.ownerSessionId)
				) {
					continue;
				}
				// Re-bound and force recovery unavailable at the durable read boundary.
				// This also prevents a tampered 0600 record from reintroducing raw
				// diagnostics or falsely advertising in-memory authority.
				const boundedInput = boundFailureInput(withoutLiveRecovery(failureRecord.input));
				if (
					!isSafeRunId(boundedInput.runId) ||
					boundedInput.runId !== failureRecord.runId ||
					boundedInput.forkName !== failureRecord.forkName
				) {
					continue;
				}
				failureRecord.input = boundedInput;
				out.push({ file, record: failureRecord, fileDev: stat.dev, fileIno: stat.ino, revision });
				continue;
			}
			if (kind === "escalation-pending") {
				const escalationRecord = record as PendingEscalationWakeRecord;
				const payload = escalationRecord.payload;
				if (
					typeof payload?.rootRunId !== "string" ||
					typeof payload?.requestId !== "string" ||
					typeof payload?.holderId !== "string" ||
					!["decision", "blocker", "amendment"].includes(payload?.kind) ||
					typeof escalationRecord.ownerSessionId !== "string" ||
					escalationRecord.ownerSessionId.length === 0
				) continue;
				out.push({ file, record: escalationRecord, fileDev: stat.dev, fileIno: stat.ino, revision });
				continue;
			}
		} catch {
			/* malformed / mid-write; skipped, retried next scan */
		}
	}
	return out;
}

/**
 * Redeliver dropped dispatch wakes on `session_start` (issue #2). Runs
 * alongside `deliverPendingOrchestrateResults` with the SAME at-least-once
 * semantics: atomically CLAIM before sending (two sessions sharing an
 * agentDir can't double-deliver), CONSUME on success, UNCLAIM on failure
 * (retried next start), stale claims recovered by the sweep in
 * `scanPendingWakes`.
 *
 * OWNER SCOPING: a record with `ownerSessionId` is delivered only when the
 * current foreground presents the SAME session id. A same-process legacy
 * record with no session id may still deliver via pid+nonce (the replacement
 * window this module was originally built for), but a legacy dead-owner record
 * is deliberately skipped rather than broadcast to the next arbitrary session.
 * A record owned by a DIFFERENT LIVE pid remains skipped untouched. The
 * pid-reuse squatter case (live foreign process holding the record's pid) is
 * therefore DELAYED, never misdelivered.
 *
 * Returns the count delivered (for tests / diagnostics).
 */
let afterPendingWakeScanForTests: (() => void) | undefined;

export function __setPendingWakeAfterScanHookForTests(hook: (() => void) | undefined): () => void {
	const previous = afterPendingWakeScanForTests;
	afterPendingWakeScanForTests = hook;
	return () => { afterPendingWakeScanForTests = previous; };
}

export function deliverPendingDispatchWakes(
	sink: NotifyCompletionSink,
	agentDir: string,
	opts?: { currentSessionId?: string },
): number {
	const pending = scanPendingWakes(agentDir);
	afterPendingWakeScanForTests?.();
	let delivered = 0;
	for (const { file, record, fileDev, fileIno, revision } of pending) {
		const ours = record.owningPid === process.pid && record.owningNonce === getProcessNonce();
		const ownerAlive = pidAlive(record.owningPid);
		const hasSessionOwner = typeof record.ownerSessionId === "string" && record.ownerSessionId.length > 0;
		if (hasSessionOwner && opts?.currentSessionId !== record.ownerSessionId) {
			const canAdoptStaleEscalationOwner =
				record.kind === "escalation-pending" &&
				typeof opts?.currentSessionId === "string" &&
				opts.currentSessionId.length > 0 &&
				(ours || !ownerAlive);
			if (!canAdoptStaleEscalationOwner) {
				logDelegateDiagnostic(
					`pending wake skipped: owner mismatch run=${record.ownerSessionId} current=${opts?.currentSessionId ?? "(none)"} kind=${record.kind} (runId=${record.runId})`,
					{ agentDir, level: "warn", throttleKey: `pending-wake-owner:${record.runId}` },
				);
				continue; // Session-scoped wake for a different/unknown foreground — fail closed.
			}
			logDelegateDiagnostic(
				`pending escalation wake adopted stale owner run=${record.ownerSessionId} current=${opts.currentSessionId} ownerAlive=${ownerAlive} ours=${ours} (runId=${record.runId})`,
				{ agentDir, level: "warn", throttleKey: `pending-wake-adopt:${record.runId}` },
			);
		}
		if (!ours && ownerAlive) {
			logDelegateDiagnostic(
				`pending wake skipped: foreign live owner pid=${record.owningPid} kind=${record.kind} (runId=${record.runId})`,
				{ agentDir, level: "log", throttleKey: `pending-wake-foreign-live:${record.runId}` },
			);
			continue; // foreign LIVE owner (or pid-reuse squatter) — not ours to deliver.
		}
		if (!ours && !ownerAlive && !hasSessionOwner) {
			// Legacy dead-owner wake lacks a session id, so delivering it would wake
			// whichever foreground happened to start next in this agentDir (#18).
			logDelegateDiagnostic(
				`pending wake skipped: dead owner without session id kind=${record.kind} (runId=${record.runId})`,
				{ agentDir, level: "warn", throttleKey: `pending-wake-dead-legacy:${record.runId}` },
			);
			continue;
		}
		const claimOutcome = tryWithStateFileLock(file, () => {
			try {
				const currentStat = fs.lstatSync(file);
				const currentSerialized = fs.readFileSync(file, "utf8");
				const currentRevision = crypto.createHash("sha256").update(currentSerialized, "utf8").digest("hex");
				if (
					!currentStat.isFile() || currentStat.isSymbolicLink() ||
					currentStat.dev !== fileDev || currentStat.ino !== fileIno || currentRevision !== revision
				) return undefined;
				return claimPendingResult(file);
			} catch {
				return undefined;
			}
		});
		const claimed = claimOutcome.acquired ? claimOutcome.value : undefined;
		if (!claimed) continue; // stale scan, lock contention, or another session won delivery.
		try {
			const claimedStat = fs.lstatSync(claimed);
			const claimedSerialized = fs.readFileSync(claimed, "utf8");
			const claimedRevision = crypto.createHash("sha256").update(claimedSerialized, "utf8").digest("hex");
			if (
				!claimedStat.isFile() || claimedStat.isSymbolicLink() ||
				claimedStat.dev !== fileDev || claimedStat.ino !== fileIno || claimedRevision !== revision
			) {
				unclaimPendingResult(claimed);
				continue;
			}
			if (record.kind === "escalation-pending") {
				deliverWakeMessage(sink, buildEscalationPendingMessage(record.payload));
			} else if (record.kind === "fork-failed") {
				deliverWakeMessage(sink, buildForkFailedMessage(record.input));
			} else {
				const effectiveInput: NotifyCompletionInput = {
					...record.input,
					completionNotifyStrategy: resolveCompletionNotifyStrategy(record.input.completionNotifyStrategy),
				};
				deliverWakeMessage(sink, buildCompletionMessage(effectiveInput));
				appendCompletionUsageMetadata(sink, effectiveInput, agentDir);
			}
			// Transfer retention only after the receiver accepted the wake, while the
			// claimed carrier still owns the durable pin. If either transfer or
			// consumption fails, the carrier remains retryable and the next scan can
			// renew its pin before another delivery attempt.
			if (record.kind !== "escalation-pending" && record.kind !== "fork-failed") releasePendingWakeArtifacts(record);
			if (!consumePendingResult(claimed)) {
				if (record.kind !== "escalation-pending" && record.kind !== "fork-failed") {
					try { renewPendingWakeArtifacts(record); }
					catch (renewError) {
						logDelegateDiagnostic(
							`pending wake claim removal unconfirmed and pin renewal deferred (runId=${record.runId}): ${(renewError as Error)?.message ?? renewError}`,
							{ agentDir, level: "warn", throttleKey: `pending-wake-consume-unconfirmed:${record.runId}` },
						);
					}
				}
				unclaimPendingResult(claimed);
				logDelegateDiagnostic(
					`pending wake sent but claim removal is unconfirmed; retaining carrier (runId=${record.runId})`,
					{ agentDir, level: "warn", throttleKey: `pending-wake-consume-unconfirmed:${record.runId}` },
					);
				continue;
			}
			delivered++;
		} catch (err) {
			unclaimPendingResult(claimed);
			logDelegateDiagnostic(
				`failed to redeliver pending dispatch wake ${file}: ${(err as Error)?.message ?? err}`,
				{ agentDir, level: "warn" },
			);
		}
	}
	if (delivered > 0) {
		logDelegateDiagnostic(
			`hydrate-and-deliver: redelivered ${delivered} pending dispatch wake(s)`,
			{ agentDir, level: "log" },
		);
	}
	return delivered;
}

/** @deprecated Use {@link RunFailureSiblingState}; retained for failure-wake payloads. */
export type ForkFailureSiblingState = RunFailureSiblingState;

/** @deprecated Use {@link RunFailureReason}; retained for failure-wake payloads. */
export type ForkFailureReason = RunFailureReason;

/** @deprecated Use {@link RunFailureRecovery}; retained for failure-wake payloads. */
export type ForkFailureRecovery = RunFailureRecovery;

/** @deprecated Use {@link NotifyRunFailedInput}; retained for failure-wake callers. */
export type NotifyForkFailedInput = NotifyRunFailedInput;

/** @deprecated Use {@link RunFailedMessage}; retained for failure-wake callers. */
export type ForkFailedMessage = RunFailedMessage;

/** @deprecated Use {@link PendingRunFailedWakeRecord}; retained for persisted wake records. */
export type PendingForkFailedWakeRecord = PendingRunFailedWakeRecord;

/** @deprecated Use {@link RunFailureWakeDisposition}; retained for failure-wake callers. */
export type ForkFailureWakeDisposition = RunFailureWakeDisposition;
