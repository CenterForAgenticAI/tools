import { projectActivityActorPhase } from "./activity-state.js";
import type { ActivityActorPhase } from "./activity-state.js";
import {
	boundActivityText,
	projectLocalActivity,
	safeActivityToolName,
} from "./activity-status.js";
import type { ActivityStatusDraft } from "./activity-status.js";
import {
	projectRunTranscript,
	reduceRunRounds,
	summarizeRunActivity,
	toolNameFromTranscriptEntry,
	type RunActivitySummary,
	type RunRoundProjection,
} from "./fork-activity.js";

/** Canonical activity projections re-exported from the fork-activity compatibility module. */
export type { RunActivitySummary, RunRoundProjection, RunRound, RunTranscriptProjection } from "./fork-activity.js";
export { projectRunTranscript, summarizeRunActivity, reduceRunRounds, toolNameFromTranscriptEntry };
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_MAX_CONSECUTIVE_HEARTBEATS,
} from "./heartbeat-defaults.js";
import type { RunResult } from "./fork-runner.js";
import type {
	RunLiveState,
	RunLiveStatus,
	DelegateDispatchState,
	PendingPrompt,
} from "./runtime.js";
import { runUsageTotals } from "./usage-rollup.js";
import type { DelegateUsageTotals } from "./usage-rollup.js";

export interface RunDigestInput {
	runId: string;
	runShape: DelegateDispatchState["shape"];
	runCreatedAtMs: number;

	entry: RunLiveState;
	terminalResult?: Pick<RunResult, "steered">;

	rounds?: RunRoundProjection;
	activity: RunActivitySummary;

	pendingPromptKinds: readonly PendingPrompt["kind"][];
	nowMs: number;
}

export type RunHealth =
	| { kind: "moving"; silentMs?: number }
	| { kind: "slow"; silentMs: number; thresholdMs: number }
	| { kind: "stalled"; silentMs: number; thresholdMs: number }
	| {
		kind: "blocked";
		reason: "worker-prompt" | "escalation";
		count?: number;
	}
	| { kind: "terminal" };

export type RunFriction =
	| {
		kind: "blocked";
		reason: "worker-prompt" | "escalation";
		count?: number;
	}
	| {
		kind: "model-refusal";
		fallback: boolean;
		modelCount: number;
	}
	| {
		kind: "wind-down";
		reason: "heartbeat" | "wall-clock" | "unknown";
	}
	| { kind: "paused" }
	| { kind: "tool-error-streak"; count: number }
	| {
		kind: "repeated-call";
		toolName: string;
		repetitions: number;
	}
	| { kind: "re-ask"; count: number };

export interface RunDigest {
	status: RunLiveStatus;

	health: RunHealth;

	activity: {
		actorPhase: ActivityActorPhase;
		headline: ActivityStatusDraft;
	};

	friction: readonly RunFriction[];

	consumption: {
		rounds: {
			used: number;
			limit: number;
		};

		elapsed: {
			usedMs?: number;
			limitMs?: number;
		};

		usage: DelegateUsageTotals;

		heartbeat:
			| { applicable: false }
			| {
				applicable: true;
				enabled: false;
			}
			| {
				applicable: true;
				enabled: true;
				silentMs?: number;
				slowAfterMs: number;
				stalledAfterMs: number;
			};
	};

	latestExchange?: {
		roundIndex: number;
		ask: string;
		reply?: string;
		state: "resolved" | "in-flight" | "ended-incomplete";
	};
}

const FRICTION_CAP = 5;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isTerminal(status: RunLiveStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "paused";
}

function latestSilence(input: RunDigestInput): number | undefined {
	const timestamps = [
		// Retain this descendant-liveness carrier even though main-side guidance
		// from `pushPendingGuidance` can also advance it; it is deliberately not
		// worker-pure.
		input.entry.lastActivityAt,
		input.activity.lastWorkerEventAt,
		input.entry.startedAtMs,
		input.entry.startedAt,
		input.runCreatedAtMs,
	].filter(isFiniteNumber);
	if (!isFiniteNumber(input.nowMs) || timestamps.length === 0) return undefined;
	const latest = Math.max(...timestamps);
	const silence = input.nowMs - latest;
	return Number.isFinite(silence) ? Math.max(0, silence) : undefined;
}

interface HeartbeatProjection {
	heartbeat: RunDigest["consumption"]["heartbeat"];
	slowAfterMs?: number;
	stalledAfterMs?: number;
}

function heartbeatProjection(input: RunDigestInput, silentMs: number | undefined): HeartbeatProjection {
	if (input.runShape !== "supervised") return { heartbeat: { applicable: false } };

	const interval = isFiniteNumber(input.entry.heartbeatIntervalMs) && input.entry.heartbeatIntervalMs >= 0
		? input.entry.heartbeatIntervalMs
		: DEFAULT_HEARTBEAT_INTERVAL_MS;
	const maxConsecutive = isFiniteNumber(input.entry.maxConsecutiveHeartbeats) && input.entry.maxConsecutiveHeartbeats > 0
		? input.entry.maxConsecutiveHeartbeats
		: DEFAULT_MAX_CONSECUTIVE_HEARTBEATS;
	if (interval === 0) return { heartbeat: { applicable: true, enabled: false } };

	const stalledAfterMs = interval * maxConsecutive;
	if (!Number.isFinite(stalledAfterMs) || stalledAfterMs <= 0) {
		return { heartbeat: { applicable: true, enabled: false } };
	}
	const slowAfterMs = interval;
	return {
		heartbeat: {
			applicable: true,
			enabled: true,
			...(silentMs === undefined ? {} : { silentMs }),
			slowAfterMs,
			stalledAfterMs,
		},
		slowAfterMs,
		stalledAfterMs,
	};
}

function healthProjection(
	input: RunDigestInput,
	silentMs: number | undefined,
	heartbeat: HeartbeatProjection,
): RunHealth {
	if (isTerminal(input.entry.status)) return { kind: "terminal" };
	if (input.pendingPromptKinds.length > 0) {
		return { kind: "blocked", reason: "worker-prompt", count: input.pendingPromptKinds.length };
	}
	if (input.entry.status === "awaiting-escalation") return { kind: "blocked", reason: "escalation" };

	const activeWorkerToolCount = isFiniteNumber(input.activity.activeWorkerToolCount)
		? input.activity.activeWorkerToolCount
		: 0;
	if (input.activity.workerToolActive || activeWorkerToolCount > 0) {
		return silentMs === undefined ? { kind: "moving" } : { kind: "moving", silentMs };
	}
	if (input.runShape !== "supervised") {
		return silentMs === undefined ? { kind: "moving" } : { kind: "moving", silentMs };
	}
	const finalRound = input.rounds?.rounds.at(-1);
	if (!finalRound || finalRound.resolution !== "open") {
		return silentMs === undefined ? { kind: "moving" } : { kind: "moving", silentMs };
	}
	if (
		heartbeat.slowAfterMs === undefined ||
		heartbeat.stalledAfterMs === undefined ||
		silentMs === undefined
	) {
		return silentMs === undefined ? { kind: "moving" } : { kind: "moving", silentMs };
	}
	if (silentMs >= heartbeat.stalledAfterMs) {
		return { kind: "stalled", silentMs, thresholdMs: heartbeat.stalledAfterMs };
	}
	if (silentMs >= heartbeat.slowAfterMs) {
		return { kind: "slow", silentMs, thresholdMs: heartbeat.slowAfterMs };
	}
	return { kind: "moving", silentMs };
}

function refusalModelCount(refusalModels: readonly string[] | undefined): number {
	if (!Array.isArray(refusalModels)) return 0;
	const distinct = new Set<string>();
	for (const model of refusalModels) {
		if (typeof model !== "string") continue;
		const normalized = model.trim();
		if (normalized) distinct.add(normalized);
	}
	return distinct.size;
}

function windDownReason(
	input: RunDigestInput,
): "heartbeat" | "wall-clock" | "unknown" | undefined {
	if (input.entry.windDown) {
		return input.entry.windDown.reason === "heartbeat" || input.entry.windDown.reason === "wall-clock"
			? input.entry.windDown.reason
			: "unknown";
	}
	if (isTerminal(input.entry.status) && input.terminalResult?.steered === true) return "unknown";
	return undefined;
}

function positiveCount(value: unknown, minimum: number): number | undefined {
	if (!isFiniteNumber(value) || value < minimum) return undefined;
	return value;
}

function frictionProjection(input: RunDigestInput): readonly RunFriction[] {
	// This insertion order is the public priority order; the cap intentionally
	// drops lower-priority re-ask signals once five candidates exist.
	const candidates: RunFriction[] = [];
	const push = (signal: RunFriction): void => {
		if (candidates.length < FRICTION_CAP) candidates.push(signal);
	};

	if (input.pendingPromptKinds.length > 0) {
		push({ kind: "blocked", reason: "worker-prompt", count: input.pendingPromptKinds.length });
	} else if (input.entry.status === "awaiting-escalation") {
		push({ kind: "blocked", reason: "escalation" });
	}

	const modelCount = refusalModelCount(input.entry.refusalModels);
	const terminalRefusal = input.entry.status === "failed" && input.entry.errorKind === "refusal";
	if (modelCount > 0 || terminalRefusal) {
		push({
			kind: "model-refusal",
			fallback: !terminalRefusal,
			modelCount,
		});
	}

	const windDown = windDownReason(input);
	if (windDown !== undefined) push({ kind: "wind-down", reason: windDown });
	else if (input.entry.status === "paused") push({ kind: "paused" });

	const errorCount = positiveCount(input.activity.consecutiveWorkerToolErrors, 1);
	if (errorCount !== undefined) push({ kind: "tool-error-streak", count: errorCount });

	const repeated = input.activity.repeatedWorkerCall;
	const repeatedName = repeated ? safeActivityToolName(repeated.toolName) : undefined;
	const repetitions = repeated ? positiveCount(repeated.repetitions, 2) : undefined;
	if (repeatedName !== undefined && repetitions !== undefined) {
		push({ kind: "repeated-call", toolName: repeatedName, repetitions });
	}

	if (input.runShape === "supervised") {
		const reAskCount = isFiniteNumber(input.entry.currentRound)
			? Math.max(0, input.entry.currentRound - 1)
			: 0;
		if (reAskCount > 0) push({ kind: "re-ask", count: reAskCount });
	}
	return candidates;
}

function elapsedProjection(input: RunDigestInput): { usedMs?: number; limitMs?: number } {
	const start = [input.entry.startedAtMs, input.entry.startedAt, input.runCreatedAtMs].find(isFiniteNumber);
	const end = isTerminal(input.entry.status)
		? input.entry.endedAt
		: input.nowMs;
	const elapsed = start !== undefined && isFiniteNumber(end)
		? Math.max(0, end - start)
		: undefined;
	const timeout = input.entry.timeoutPolicy?.maxDurationMs;
	const limitMs = isFiniteNumber(timeout) && timeout > 0 ? timeout : undefined;
	return {
		...(elapsed === undefined ? {} : { usedMs: elapsed }),
		...(limitMs === undefined ? {} : { limitMs }),
	};
}

function roundsProjection(input: RunDigestInput): { used: number; limit: number } {
	return {
		used: isFiniteNumber(input.entry.currentRound) ? input.entry.currentRound : 0,
		limit: isFiniteNumber(input.entry.maxRounds) ? input.entry.maxRounds : 0,
	};
}

function latestExchangeProjection(input: RunDigestInput): RunDigest["latestExchange"] {
	if (input.runShape !== "supervised") return undefined;
	const round = input.rounds?.rounds.at(-1);
	if (!round) return undefined;
	const reply = round.replyHeadline === undefined ? undefined : boundActivityText(round.replyHeadline);
	return {
		roundIndex: round.index,
		ask: boundActivityText(round.ask.text),
		...(reply ? { reply } : {}),
		state: round.resolution === "resolved"
			? "resolved"
			: isTerminal(input.entry.status) ? "ended-incomplete" : "in-flight",
	};
}

/** Reduce one live run entry into a bounded, read-only digest using only injected time. */
export function reduceRunDigest(input: RunDigestInput): RunDigest {
	const silentMs = latestSilence(input);
	const heartbeat = heartbeatProjection(input, silentMs);
	const latestExchange = latestExchangeProjection(input);
	return {
		status: input.entry.status,
		health: healthProjection(input, silentMs, heartbeat),
		activity: {
			actorPhase: projectActivityActorPhase({
				status: input.entry.status,
				activity: input.activity,
				pendingPromptCount: input.pendingPromptKinds.length,
				pendingGuidanceCount: Array.isArray(input.entry.pendingGuidance)
					? input.entry.pendingGuidance.length
					: 0,
			}),
			headline: projectLocalActivity({ status: input.entry.status, activity: input.activity }),
		},
		friction: frictionProjection(input),
		consumption: {
			rounds: roundsProjection(input),
			elapsed: elapsedProjection(input),
			usage: runUsageTotals(input.entry.usage),
			heartbeat: heartbeat.heartbeat,
		},
		...(latestExchange === undefined ? {} : { latestExchange }),
	};
}

/** @deprecated Use {@link RunDigestInput}; retained for callers of the fork-shaped digest API. */
export interface ForkDigestInput extends Omit<RunDigestInput, "entry"> {
	/** Canonical input field accepted additively by compatibility callers. */
	entry?: RunLiveState;
	/** Legacy compatibility field. */
	fork?: RunLiveState;
}

/** @deprecated Use {@link RunHealth}; retained for digest consumers. */
export type ForkHealth = RunHealth;

/** @deprecated Use {@link RunFriction}; retained for digest consumers. */
export type ForkFriction = RunFriction;

/** @deprecated Use {@link RunDigest}; retained for digest consumers. */
export type ForkDigest = RunDigest;

/** @deprecated Use {@link reduceRunDigest}; retained for digest consumers. */
export function reduceForkDigest(input: ForkDigestInput): ForkDigest {
	const entry = input.entry ?? input.fork;
	if (entry === undefined) throw new TypeError("reduceForkDigest requires entry");
	return reduceRunDigest({ ...input, entry });
}
