/**
 * Escalation-plane scheduling and raiser-side hold-open composition.
 *
 * The plane alone writes timeout defaults (invariant 3 / Lean DE-8), walks
 * expired intermediary hops (Q2 / DE-4a), and restores only the raiser's
 * WorkerChannel after a canonical outcome appears (invariant 9 / DE-7).
 * Durable requests precede owner-scoped wake hints; no pending execution is
 * retained above the raiser.
 *
 * [spec §2.2–2.4, §3 invariants 3/5/6/9]
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	DEFAULT_ESCALATION_CONFIG,
	type ResolvedEscalationConfig,
} from "./config.js";
import {
	computeEscalationChain,
	defaultTimeoutSpecFor,
	hopDeadlineFor,
	type EscalationChainParticipant,
} from "./escalation-chain.js";
import {
	awaitOutcome,
	cancelEscalation,
	forwardEscalation,
	listEscalationRequests,
	raiseEscalation,
	repairEscalationPublication,
	readOutcome,
	writeTerminalOutcome,
	EscalationMailboxPublicationError,
	EscalationRequestCollisionError,
	type EscalationCategory,
	type EscalationOrigin,
	type EscalationKind,
	type EscalationOutcome,
	type EscalationPayloadByKind,
	type EscalationRaiser,
	type EscalationReplyEndpoint,
	type EscalationRequest,
	type EscalationCredential,
	type DecisionEscalationPayload,
} from "./escalation-store.js";
import { resolveEventSinkDir } from "./event-bus.js";
import {
	removePendingEscalationWake,
	removePendingEscalationWakesForRoot,
	updatePendingEscalationWakeHolder,
	writePendingEscalationWake,
} from "./pending-wakes.js";
import type { WorkerChannel } from "./worker-channel.js";
import type { TaskProgressRow } from "./task-seam.js";

/**
 * Resolve the optional task binding carried by an amendment target. The
 * escalation store deliberately keeps `target` opaque; a task reference is
 * therefore a small, tolerant convention at the runtime boundary rather than
 * a new escalation kind or a peer-package import.
 */
export function taskIdFromAmendmentTarget(target: unknown): string | undefined {
	if (typeof target !== "string") return undefined;
	const trimmed = target.trim();
	const candidate = trimmed.replace(/^(?:task|task_id|task-id)[:/]/u, "");
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(candidate) ? candidate : undefined;
}

/** Convert a task-bound amendment into the row the owner runtime can apply. */
export function taskProgressRowFromAmendment(request: {
	readonly kind: string;
	readonly payload?: { readonly target?: unknown; readonly change?: unknown; readonly rationale?: unknown };
}): TaskProgressRow | undefined {
	if (request.kind !== "amendment") return undefined;
	const ownerTaskId = taskIdFromAmendmentTarget(request.payload?.target);
	if (ownerTaskId === undefined) return undefined;
	const change = typeof request.payload?.change === "string" ? request.payload.change.trim() : "";
	const rationale = typeof request.payload?.rationale === "string" ? request.payload.rationale.trim() : "";
	const reason = `${change}${change && rationale ? ": " : ""}${rationale}`.slice(0, 240);
	return { ownerTaskId, status: "blocked", ...(reason ? { reason } : {}) };
}

export interface EscalationSweepReport {
	timedOut: string[];
	autoPassed: string[];
	/** A competing terminal writer won the exclusive-create race. */
	duplicates: string[];
	errors: Array<{ requestId: string; message: string }>;
}

type DeadlineSchedulerTimer = ReturnType<typeof setTimeout> | number | undefined;

/** Ordering/race observation seam; production callers must not set it. */
export const __runtimeTestHooks: {
	beforePendingWakeWrite?: () => void;
	deadlineSchedulerStarted?: () => void;
	deadlineSchedulerStopped?: () => void;
	deadlineSchedulerNow?: () => number;
	deadlineSchedulerSetTimeout?: (
		callback: () => void,
		delayMs: number,
	) => DeadlineSchedulerTimer;
	deadlineSchedulerClearTimeout?: (timer: DeadlineSchedulerTimer) => void;
} = {};

interface EscalationDeadlineScheduler {
	agentDir: string;
	rootRunId: string;
	registrations: number;
	timer?: DeadlineSchedulerTimer;
	timerScheduled: boolean;
}

/** One lifecycle-owned deadline timer per active root; raisers share it. */
const deadlineSchedulers = new Map<string, EscalationDeadlineScheduler>();
const DEADLINE_RETRY_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AdvanceEscalationsArgs {
	agentDir: string;
	rootRunId: string;
	now?: Date;
	/** Optional policy seam for deterministic/manual schedulers. */
	config?: ResolvedEscalationConfig;
}

/**
 * Advance every durable request independently. Per-request failures (including
 * mutation-lock contention) are reported and never stop the rest of the sweep.
 */
export function advanceEscalations(args: AdvanceEscalationsArgs): EscalationSweepReport {
	const now = args.now ?? new Date();
	const report: EscalationSweepReport = {
		timedOut: [],
		autoPassed: [],
		duplicates: [],
		errors: [],
	};
	for (const request of listEscalationRequests(args)) {
		try {
			if (readOutcome({
				agentDir: args.agentDir,
				rootRunId: args.rootRunId,
				requestId: request.requestId,
			}) !== null) continue;

			const requestDeadline = parseDeadline(request.timeout.deadlineAt);
			if (requestDeadline !== undefined && requestDeadline <= now.getTime()) {
				const result = applyRequestTimeout(args.agentDir, request, now);
				if (result.duplicate) report.duplicates.push(request.requestId);
				else report.timedOut.push(request.requestId);
				continue;
			}

			const hopDeadline = parseDeadline(request.hopDeadlineAt);
			if (
				hopDeadline === undefined ||
				hopDeadline > now.getTime() ||
				request.holderIndex >= request.chain.length - 1
			) continue;

			const toIndex = request.holderIndex + 1;
			const nextDeadline = hopDeadlineFor(
				args.config ?? inferHopConfig(request),
				request.timeout,
				now,
			);
			const forwarded = forwardEscalation({
				agentDir: args.agentDir,
				rootRunId: args.rootRunId,
				requestId: request.requestId,
				toIndex,
				auto: true,
				...(nextDeadline !== undefined ? { hopDeadlineAt: nextDeadline } : {}),
				at: now,
			});
			updatePendingEscalationWakeHolder(
				args.agentDir,
				args.rootRunId,
				request.requestId,
				forwarded.chain[forwarded.holderIndex].id,
			);
			report.autoPassed.push(request.requestId);
		} catch (error) {
			if (error instanceof EscalationMailboxPublicationError) {
				try {
					const repaired = repairEscalationPublication({
						agentDir: args.agentDir,
						rootRunId: args.rootRunId,
						requestId: request.requestId,
					});
					if (repaired) {
						updatePendingEscalationWakeHolder(
							args.agentDir,
							args.rootRunId,
							request.requestId,
							repaired.chain[repaired.holderIndex].id,
						);
						report.autoPassed.push(request.requestId);
						continue;
					}
				} catch (repairError) {
					report.errors.push({ requestId: request.requestId, message: errorMessage(repairError) });
					continue;
				}
			}
			report.errors.push({ requestId: request.requestId, message: errorMessage(error) });
		}
	}
	return report;
}

export interface PassEscalationArgs {
	agentDir: string;
	rootRunId: string;
	requestId: string;
	config: ResolvedEscalationConfig;
	credential?: EscalationCredential;
	context?: string;
	recommendation?: string;
	now?: Date;
}

/** Manual §2.3 passthrough: move one hop and start that holder's Q2 timer. */
export function passEscalation(args: PassEscalationArgs): EscalationRequest {
	const requests = listEscalationRequests({ agentDir: args.agentDir, rootRunId: args.rootRunId });
	const request = requests.find((candidate) => candidate.requestId === args.requestId);
	if (!request) throw new Error(`escalation request not found: ${args.requestId}`);
	if (request.holderIndex >= request.chain.length - 1) {
		throw new Error("cannot pass an escalation beyond the final chain node");
	}
	const now = args.now ?? new Date();
	const hopDeadlineAt = hopDeadlineFor(args.config, request.timeout, now);
	let forwarded: EscalationRequest;
	try {
		forwarded = forwardEscalation({
			agentDir: args.agentDir,
			rootRunId: args.rootRunId,
			requestId: args.requestId,
			...(args.credential !== undefined ? { credential: args.credential } : {}),
			toIndex: request.holderIndex + 1,
			...(args.context !== undefined ? { context: args.context } : {}),
			...(args.recommendation !== undefined ? { recommendation: args.recommendation } : {}),
			...(hopDeadlineAt !== undefined ? { hopDeadlineAt } : {}),
			at: now,
		});
	} catch (error) {
		if (!(error instanceof EscalationMailboxPublicationError)) throw error;
		const repaired = repairEscalationPublication({
			agentDir: args.agentDir,
			rootRunId: args.rootRunId,
			requestId: args.requestId,
		});
		if (!repaired) throw error;
		forwarded = repaired;
	}
	updatePendingEscalationWakeHolder(
		args.agentDir,
		args.rootRunId,
		args.requestId,
		forwarded.chain[forwarded.holderIndex].id,
	);
	return forwarded;
}

export interface RaiseAndAwaitEscalationArgs<K extends EscalationKind> {
	agentDir: string;
	requestId: string;
	rootRunId: string;
	kind: K;
	payload: EscalationPayloadByKind[K];
	category?: EscalationCategory;
	/** Provenance recorded on the durable request (for example a translated `ask`). */
	origin?: EscalationOrigin;
	raiser: EscalationRaiser;
	participants: EscalationChainParticipant[];
	includeUser?: boolean;
	config: ResolvedEscalationConfig;
	replyEndpoint: EscalationReplyEndpoint;
	ownerSessionId: string;
	consumer?: EscalationRequest["consumer"];
	now?: Date;
	pollMs?: number;
	signal?: AbortSignal;
	workerChannel?: Pick<WorkerChannel, "enterAwaitingEscalation" | "resolveAwaitingEscalation">;
}

/**
 * Raise durably, persist the owner-scoped wake hint, then hold only the raiser
 * until the canonical result appears (invariants 1, 5, and 9 / DE-7).
 */
export async function raiseAndAwaitEscalation<K extends EscalationKind>(
	args: RaiseAndAwaitEscalationArgs<K>,
): Promise<EscalationOutcome> {
	const now = args.now ?? new Date();
	const { chain, holderIndex } = computeEscalationChain({
		raiser: args.raiser,
		participants: args.participants,
		kind: args.kind,
		...(args.category !== undefined ? { category: args.category } : {}),
		...(args.includeUser !== undefined ? { includeUser: args.includeUser } : {}),
	});
	const timeout = defaultTimeoutSpecFor(args.kind, args.config, now);
	const hopDeadlineAt = hopDeadlineFor(args.config, timeout, now);
	let request: EscalationRequest;
	try {
		request = raiseEscalation({
			agentDir: args.agentDir,
			requestId: args.requestId,
			rootRunId: args.rootRunId,
			kind: args.kind,
			ownerSessionId: args.ownerSessionId,
			...(args.consumer !== undefined ? { consumer: args.consumer } : {}),
			payload: args.payload,
			...(args.category !== undefined ? { category: args.category } : {}),
			...(args.origin !== undefined ? { origin: args.origin } : {}),
			chain,
			holderIndex,
			timeout,
			...(hopDeadlineAt !== undefined ? { hopDeadlineAt } : {}),
			holdStrategy: args.config.holdStrategy,
			replyEndpoint: args.replyEndpoint,
			raiser: args.raiser,
			raisedAt: now,
		});
	} catch (error) {
		if (error instanceof EscalationRequestCollisionError || !(error instanceof EscalationMailboxPublicationError)) {
			throw error;
		}
		const repaired = repairEscalationPublication({
			agentDir: args.agentDir,
			rootRunId: args.rootRunId,
			requestId: args.requestId,
		});
		if (!repaired) throw error;
		request = repaired;
	}
	// Durable state is authoritative. A failed hint write cannot roll it back.
	__runtimeTestHooks.beforePendingWakeWrite?.();
	writePendingEscalationWake(args.agentDir, {
		rootRunId: args.rootRunId,
		requestId: args.requestId,
		holderId: request.chain[request.holderIndex].id,
		kind: args.kind,
		ownerSessionId: args.ownerSessionId,
	});

	args.workerChannel?.enterAwaitingEscalation({
		rootRunId: args.rootRunId,
		requestIds: [args.requestId],
		holderId: request.chain[request.holderIndex].id,
	});
	const releaseDeadlineScheduler = retainDeadlineScheduler(args.agentDir, args.rootRunId);
	try {
		const outcome = await awaitOutcome({
			agentDir: args.agentDir,
			rootRunId: args.rootRunId,
			requestId: args.requestId,
			credential: args.replyEndpoint.credential,
			...(args.pollMs !== undefined ? { pollMs: args.pollMs } : {}),
			...(args.signal !== undefined ? { signal: args.signal } : {}),
		});
		removePendingEscalationWake(args.agentDir, args.rootRunId, args.requestId);
		return outcome;
	} finally {
		releaseDeadlineScheduler();
		// Abort must never strand the channel in awaiting-escalation. The durable
		// wake remains on abort because the request itself is still pending.
		args.workerChannel?.resolveAwaitingEscalation();
	}
}

/**
 * Keep Q2 hop deadlines and request-level terminal deadlines moving while a
 * raise tool is blocked in awaitOutcome. Registrations share one adaptive
 * timer per root, preventing one polling loop/timer per pending request.
 */
function retainDeadlineScheduler(agentDir: string, rootRunId: string): () => void {
	const key = JSON.stringify([path.resolve(agentDir), rootRunId]);
	let scheduler = deadlineSchedulers.get(key);
	if (!scheduler) {
		scheduler = { agentDir, rootRunId, registrations: 0, timerScheduled: false };
		deadlineSchedulers.set(key, scheduler);
		__runtimeTestHooks.deadlineSchedulerStarted?.();
	}
	scheduler.registrations += 1;
	scheduleNextDeadline(scheduler);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = deadlineSchedulers.get(key);
		if (!current) return;
		current.registrations -= 1;
		if (current.registrations > 0) {
			scheduleNextDeadline(current);
			return;
		}
		if (current.timerScheduled) {
			(__runtimeTestHooks.deadlineSchedulerClearTimeout ?? clearTimeout)(current.timer);
			current.timerScheduled = false;
		}
		deadlineSchedulers.delete(key);
		__runtimeTestHooks.deadlineSchedulerStopped?.();
	};
}

function scheduleNextDeadline(
	scheduler: EscalationDeadlineScheduler,
	minimumDelayMs = 1,
): void {
	if (scheduler.timerScheduled) {
		(__runtimeTestHooks.deadlineSchedulerClearTimeout ?? clearTimeout)(scheduler.timer);
		scheduler.timerScheduled = false;
		delete scheduler.timer;
	}
	if (scheduler.registrations <= 0) return;
	const now = (__runtimeTestHooks.deadlineSchedulerNow ?? Date.now)();
	let earliest: number | undefined;
	try {
		for (const request of listEscalationRequests(scheduler)) {
			if (readOutcome({
				agentDir: scheduler.agentDir,
				rootRunId: scheduler.rootRunId,
				requestId: request.requestId,
			}) !== null) continue;
			const requestDeadline = parseDeadline(request.timeout.deadlineAt);
			if (requestDeadline !== undefined) earliest = minDefined(earliest, requestDeadline);
			if (request.holderIndex < request.chain.length - 1) {
				const hopDeadline = parseDeadline(request.hopDeadlineAt);
				if (hopDeadline !== undefined) earliest = minDefined(earliest, hopDeadline);
			}
		}
	} catch {
		earliest = now + DEADLINE_RETRY_MS;
	}
	if (earliest === undefined) return;
	const delay = Math.min(
		MAX_TIMER_DELAY_MS,
		Math.max(minimumDelayMs, earliest - now),
	);
	scheduler.timer = (__runtimeTestHooks.deadlineSchedulerSetTimeout ?? setTimeout)(() => {
		scheduler.timerScheduled = false;
		delete scheduler.timer;
		const report = advanceEscalations({
			agentDir: scheduler.agentDir,
			rootRunId: scheduler.rootRunId,
			now: new Date((__runtimeTestHooks.deadlineSchedulerNow ?? Date.now)()),
		});
		scheduleNextDeadline(
			scheduler,
			report.errors.length > 0 ? DEADLINE_RETRY_MS : 1,
		);
	}, delay);
	scheduler.timerScheduled = true;
	if (typeof scheduler.timer === "object" && scheduler.timer !== null) {
		scheduler.timer.unref?.();
	}
}

function minDefined(current: number | undefined, candidate: number): number {
	return current === undefined ? candidate : Math.min(current, candidate);
}

export interface EscalationCleanupReport {
	cancelled: string[];
	errors: Array<{ requestId: string; message: string }>;
}

/**
 * Terminal run cleanup: cancel pending requests, remove wakes and legacy state,
 * and retain canonical receipts until event-bus retention expires.
 */
export function cleanupEscalationsForRun(args: {
	agentDir: string;
	rootRunId: string;
	reason?: string;
}): EscalationCleanupReport {
	const report: EscalationCleanupReport = { cancelled: [], errors: [] };
	for (const request of listEscalationRequests(args)) {
		if (readOutcome({
			agentDir: args.agentDir,
			rootRunId: args.rootRunId,
			requestId: request.requestId,
		}) !== null) continue;
		try {
			const result = cancelEscalation({
				agentDir: args.agentDir,
				rootRunId: args.rootRunId,
				requestId: request.requestId,
				credential: request.replyEndpoint.credential,
				note: args.reason ?? "Escalation cancelled because its run terminated.",
			});
			if (!result.duplicate) report.cancelled.push(request.requestId);
		} catch (error) {
			report.errors.push({ requestId: request.requestId, message: errorMessage(error) });
		}
	}
	removePendingEscalationWakesForRoot(args.agentDir, args.rootRunId);
	// Retain canonical requests/results for replay and consumer receipt inspection.
	// The existing event-bus retention sweep owns eventual namespace deletion.
	purgeLegacyDecisionState(args.agentDir, args.rootRunId);
	return report;
}

/**
 * Remove the retired v1 `decisions/` namespace for one or every event sink.
 * This is intentionally not imported by `event-bus.ts`: doing so would create
 * a runtime cycle, and its age sweep already removes whole stale sink dirs.
 */
export function purgeLegacyDecisionState(agentDir: string, rootRunId?: string): number {
	if (rootRunId !== undefined) {
		try {
			const decisions = path.join(resolveEventSinkDir(agentDir, rootRunId), "decisions");
			if (!fs.existsSync(decisions)) return 0;
			fs.rmSync(decisions, { recursive: true, force: true });
			return 1;
		} catch {
			return 0;
		}
	}
	const busRoot = path.join(agentDir, "extensions", "pi-delegate", "event-bus");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(busRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		removed += purgeLegacyDecisionState(agentDir, entry.name);
	}
	return removed;
}

export function applyRequestTimeout(
	agentDir: string,
	request: EscalationRequest,
	now: Date,
): ReturnType<typeof writeTerminalOutcome> {
	const base = {
		agentDir,
		rootRunId: request.rootRunId,
		requestId: request.requestId,
		credential: request.replyEndpoint.credential,
		at: now,
	};
	if (request.timeout.behavior === "cancel") {
		return cancelEscalation({
			...base,
			note: "Escalation request timed out; timeout policy cancelled it.",
		});
	}
	if (request.timeout.behavior === "noDefaultError") {
		return writeTerminalOutcome({
			...base,
			status: "timeout",
			note: "Escalation timed out and no default was available by policy.",
		});
	}
	const selected = timeoutDefaultSelection(request);
	return writeTerminalOutcome({
		...base,
		status: "timeout",
		...(selected !== undefined ? { selected } : {}),
		note: selected === undefined
			? "Escalation timed out; useDefault had no available selection, so no default was applied."
			: "Escalation timed out; the configured default was applied.",
	});
}

function timeoutDefaultSelection(request: EscalationRequest): number[] | undefined {
	if (request.timeout.defaultSelection !== undefined) {
		return [...request.timeout.defaultSelection];
	}
	if (request.kind === "decision") {
		const recommended = (request.payload as DecisionEscalationPayload).recommended;
		if (recommended !== undefined) return [recommended];
	}
	// Documented no-default fallback for useDefault: timeout is still terminal,
	// but carries no selection and an explicit note rather than inventing one.
	return undefined;
}

function inferHopConfig(request: EscalationRequest): ResolvedEscalationConfig {
	const deadline = parseDeadline(request.hopDeadlineAt);
	let holderTransition = request.trace[0];
	for (let index = request.trace.length - 1; index >= 0; index -= 1) {
		const entry = request.trace[index];
		if (entry.event === "raised" || entry.event === "forwarded" || entry.event === "auto-passed") {
			holderTransition = entry;
			break;
		}
	}
	const started = parseDeadline(holderTransition?.at ?? request.raisedAt);
	const inferred = deadline !== undefined && started !== undefined
		? Math.max(1, deadline - started)
		: null;
	return {
		...DEFAULT_ESCALATION_CONFIG,
		authority: {
			...DEFAULT_ESCALATION_CONFIG.authority,
			tags: [...DEFAULT_ESCALATION_CONFIG.authority.tags],
		},
		timeoutMs: { ...DEFAULT_ESCALATION_CONFIG.timeoutMs },
		timeoutBehavior: { ...DEFAULT_ESCALATION_CONFIG.timeoutBehavior },
		hopTimeoutMs: inferred,
	};
}

function parseDeadline(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
