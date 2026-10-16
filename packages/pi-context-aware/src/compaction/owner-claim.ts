/**
 * The claiming side of the compaction-owner protocol.
 *
 * Fabric's compaction engine writes a deterministic summary unless another
 * extension claims compaction. The claim is a versioned event on the shared
 * Pi event bus, `pi-fabric:compaction-owner:v1`. This module speaks that
 * protocol and nothing else: it does not import Fabric, so without Fabric
 * loaded nobody answers the claim and nothing changes.
 *
 * The message shapes below mirror the protocol Fabric publishes
 * (`FabricCompactionOwnerClaimV1` and its handle). A claim lasts until the
 * owner withdraws it, its lifetime signal aborts, or Fabric shuts down.
 */

import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { OwnerCallRefused } from "./owner-input.js";
import { OWNER_HANDLER_TIMEOUT_MS, ownerResultError } from "./owner-result.js";

export const COMPACTION_OWNER_EVENT = "pi-fabric:compaction-owner:v1" as const;

export const COMPACTION_OWNER_REQUEST_FIELDS = ["reason", "instructions", "preserve", "requestedBy", "seed"] as const;
export const COMPACTION_OWNER_CARRY_FIELDS = ["items", "add", "remove", "clear"] as const;

export type CompactionOwnerRequestField = typeof COMPACTION_OWNER_REQUEST_FIELDS[number];
export type CompactionOwnerCarryField = typeof COMPACTION_OWNER_CARRY_FIELDS[number];

export interface CompactionOwnerIdentity {
	/** 1-128 printable characters. */
	name: string;
	/** 1-64 printable characters. */
	version: string;
}

/** Arguments of `compact.request`; only declared fields ever arrive. */
export interface CompactionOwnerRequest {
	reason?: string;
	instructions?: string;
	preserve?: string[];
	requestedBy?: string;
	/** Text to send after the compaction commits, as a labelled message that starts a turn. */
	seed?: string;
}

/** Arguments of `compact.carry`; an empty object reads the list. */
export interface CompactionOwnerCarryUpdate {
	items?: string[];
	add?: string[];
	remove?: string[];
	clear?: boolean;
}

export interface CompactionOwnerPressure {
	/** 1-64 characters. */
	stage: string;
	/** At most 16 named finite numbers. */
	thresholds?: Record<string, number>;
}

export interface CompactionOwnerCall {
	/** The invoking session's context, when Fabric has one. */
	context: ExtensionContext | undefined;
	/** Aborts when the calling program is cancelled or Fabric's 30 s bound passes. */
	signal: AbortSignal;
}

type MaybePromise<T> = T | Promise<T>;

export interface CompactionOwnerActions {
	request?: {
		fields: readonly CompactionOwnerRequestField[];
		handler: (request: CompactionOwnerRequest, call: CompactionOwnerCall) => MaybePromise<unknown>;
	};
	status?: { handler: (call: CompactionOwnerCall) => MaybePromise<unknown> };
	pressure?: { handler: (call: CompactionOwnerCall) => MaybePromise<CompactionOwnerPressure> };
	carry?: {
		fields: readonly CompactionOwnerCarryField[];
		handler: (update: CompactionOwnerCarryUpdate, call: CompactionOwnerCall) => MaybePromise<{ items: string[] }>;
	};
	cancel?: { handler: (call: CompactionOwnerCall) => MaybePromise<unknown> };
}

export type CompactionOwnerFallbackResult =
	| { ok: true; compaction: CompactionResult }
	| { ok: false; reason: string };

export interface CompactionOwnerHandle {
	readonly token: string;
	/** False once the claim is withdrawn or cleared. */
	readonly active: boolean;
	withdraw(): boolean;
	/** Fabric's deterministic summary for a `session_before_compact` event. */
	fallback(
		event: SessionBeforeCompactEvent,
		context?: ExtensionContext,
		options?: { carry?: readonly string[] },
	): CompactionOwnerFallbackResult;
}

export type CompactionOwnerClaimReply =
	| { ok: true; handle: CompactionOwnerHandle; carry?: readonly string[] }
	| { ok: false; error: string; holder?: CompactionOwnerIdentity };

export interface CompactionOwnerClaimMessage {
	version: 1;
	type: "claim";
	owner: CompactionOwnerIdentity;
	actions: CompactionOwnerActions;
	signal: AbortSignal;
	reply: (result: CompactionOwnerClaimReply) => void;
}

export type ClaimAttempt =
	/** The claim is held. */
	| { readonly kind: "claimed"; readonly carry?: readonly string[] }
	/** The claim was already held; nothing was sent. */
	| { readonly kind: "held" }
	/** Nobody answered: Fabric is not loaded. */
	| { readonly kind: "no-fabric" }
	/** Fabric answered that another owner holds the claim. */
	| { readonly kind: "refused"; readonly error: string };

export interface CompactionOwnerClaimOptions {
	readonly events: { emit(channel: string, data: unknown): void };
	readonly owner: CompactionOwnerIdentity;
	readonly actions: CompactionOwnerActions;
	/**
	 * Called after a handler failed and the claim was withdrawn because of it. A refused call
	 * (`OwnerCallRefused`: bad input, a limit, a busy session) is not a failure, and a call
	 * made under an earlier claim reports nothing once that claim has been released.
	 */
	readonly onFault?: (action: string, error: unknown) => void;
}

export interface CompactionOwnerClaim {
	/** True while Fabric still honours the claim. */
	readonly active: boolean;
	/** Send the claim unless it is already held. */
	claim(): ClaimAttempt;
	/** Withdraw the claim and abort its lifetime signal. Returns whether one was held. */
	release(): boolean;
	/** Fabric's deterministic summary, while the claim is held. */
	fallback(
		event: SessionBeforeCompactEvent,
		context?: ExtensionContext,
		options?: { carry?: readonly string[] },
	): CompactionOwnerFallbackResult;
}

/**
 * How long after Fabric's bound a call whose signal never aborted counts as stuck. Fabric
 * aborts the signal at the bound and gives the reason, so this timer decides only for a
 * caller that is not Fabric; it never decides between a cancellation and a timeout.
 */
const BACKSTOP_GRACE_MS = 1_000;

/** The call's signal, read defensively: a direct caller may pass anything. */
function callSignal(call: unknown): AbortSignal | undefined {
	try {
		const signal: unknown = typeof call === "object" && call !== null ? (call as { signal?: unknown }).signal : undefined;
		return signal instanceof AbortSignal ? signal : undefined;
	} catch {
		return undefined;
	}
}

/** True for the error a handler throws when it stops because the call's signal aborted. */
function stoppedByAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted !== true) return false;
	return error === signal.reason || (error instanceof Error && error.name === "AbortError");
}

/**
 * True when the call's signal was aborted by Fabric's timeout rather than by the caller.
 *
 * Fabric aborts a call's signal for exactly two causes, and puts the cause on the signal:
 * `stop(why)` aborts with `ownerError(claim, \`compact.${action} ${why}\`)`, where `why` is
 * `did not finish within 30 s` (its timer) or `was cancelled by the calling program` (the
 * program's signal) (pi-fabric b67da914 `src/providers/compact-provider.ts:412-423`). The
 * reason's message is the only cause Fabric exposes, so it is read here. Any other reason
 * came from a caller that called the handler itself, not through Fabric; that is the
 * caller's own cancellation, and Fabric has failed nothing.
 */
function fabricTimedOut(action: string, reason: unknown): boolean {
	try {
		const message: unknown = typeof reason === "object" && reason !== null ? (reason as { message?: unknown }).message : undefined;
		return typeof message === "string" && message.endsWith(`compact.${action} did not finish within ${OWNER_HANDLER_TIMEOUT_MS / 1000} s`);
	} catch {
		return false;
	}
}

/** One claim Fabric accepted: its handle and the lifetime signal sent with it. */
interface ClaimGeneration {
	readonly handle: CompactionOwnerHandle;
	readonly lifetime: AbortController;
}

interface GuardScope {
	/** The claim held when a call begins, if any. */
	current(): ClaimGeneration | undefined;
	/** Withdraw `generation` because a call made under it failed; nothing if it is no longer current. */
	fail(generation: ClaimGeneration, action: string, error: unknown): void;
}

/**
 * The actions as published on the event bus: a frozen copy, so a listener that captures
 * them cannot replace a handler or change a field list.
 *
 * Fabric reports a failed owner call to the calling program but keeps the claim
 * (pi-fabric b67da914 `src/providers/compact-provider.ts`, `CompactProvider.#invokeOwner`),
 * so a failing owner would leave Fabric yielding with nobody compacting. Each handler
 * therefore withdraws the claim before it passes on a failure:
 * - a throw that is not `OwnerCallRefused` (bad input, a limit, a busy session) and not the
 *   handler stopping because the call's signal aborted;
 * - a result Fabric would reject after the handler returns (`ownerJson`, `ownerPressure`,
 *   `ownerCarryItems`; see owner-result.ts). The handlers keep their results inside these
 *   checks, so this is a defect, and the call fails here instead of in Fabric;
 * - Fabric's timeout: the call's signal aborts with Fabric's timeout reason (see
 *   `fabricTimedOut`), whether the handler then stops or not;
 * - a handler still running `BACKSTOP_GRACE_MS` after the bound whose signal never aborted:
 *   a direct caller, not Fabric, which would have aborted it by then.
 * A call the caller cancels is not the owner's failure, so the claim stays held, as
 * Fabric leaves it, and the call's timer stops, as Fabric's does.
 *
 * Each call belongs to the claim held when it began. Its failure, its timer and its result
 * check can withdraw only that claim: once it has been released, a later claim (after a
 * session replacement or a reload) is not touched. Its timer and signal listener end with
 * that claim, so none outlives a release or shutdown.
 */
function publishedActions(actions: CompactionOwnerActions, scope: GuardScope): CompactionOwnerActions {
	const guard = <A extends unknown[], R>(action: string, handler: (...args: A) => R) =>
		async (...args: A): Promise<Awaited<R>> => {
			const generation = scope.current();
			const signal = callSignal(args[args.length - 1]);
			let reported = false;
			const fail = (error: unknown): void => {
				if (reported || generation === undefined) return;
				reported = true;
				scope.fail(generation, action, error);
			};
			const cleanups: Array<() => void> = [];
			const stop = (): void => {
				for (const cleanup of cleanups.splice(0)) cleanup();
			};
			// Without a claim there is nothing to withdraw, so nothing to time.
			if (generation !== undefined) {
				const timer = setTimeout(() => fail(new Error(`compact.${action} did not finish within ${OWNER_HANDLER_TIMEOUT_MS / 1000} s`)), OWNER_HANDLER_TIMEOUT_MS + BACKSTOP_GRACE_MS);
				(timer as { unref?: () => void }).unref?.();
				cleanups.push(() => clearTimeout(timer));
				const lifetime = generation.lifetime.signal;
				lifetime.addEventListener("abort", stop, { once: true });
				cleanups.push(() => lifetime.removeEventListener("abort", stop));
				if (signal !== undefined) {
					const onAbort = (): void => {
						if (fabricTimedOut(action, signal.reason)) fail(signal.reason);
						stop();
					};
					signal.addEventListener("abort", onAbort, { once: true });
					cleanups.push(() => signal.removeEventListener("abort", onAbort));
				}
			}
			let result: Awaited<R>;
			try {
				result = await handler(...args);
			} catch (error) {
				// Stopping because the signal aborted is the abort's doing: its listener judged the cause.
				if (!(error instanceof OwnerCallRefused) && !stoppedByAbort(error, signal)) fail(error);
				throw error;
			} finally {
				stop();
			}
			// Too late: the failure was already reported, and Fabric has discarded the call.
			if (reported) return result;
			const problem = ownerResultError(action, result);
			if (problem !== undefined) {
				const error = new Error(`compact.${action} ${problem}`);
				fail(error);
				throw error;
			}
			return result;
		};
	const published: CompactionOwnerActions = {};
	if (actions.request) {
		published.request = Object.freeze({ fields: Object.freeze([...actions.request.fields]), handler: guard("request", actions.request.handler) });
	}
	if (actions.status) published.status = Object.freeze({ handler: guard("status", actions.status.handler) });
	if (actions.pressure) published.pressure = Object.freeze({ handler: guard("pressure", actions.pressure.handler) });
	if (actions.carry) {
		published.carry = Object.freeze({ fields: Object.freeze([...actions.carry.fields]), handler: guard("carry", actions.carry.handler) });
	}
	if (actions.cancel) published.cancel = Object.freeze({ handler: guard("cancel", actions.cancel.handler) });
	return Object.freeze(published);
}

export function createCompactionOwnerClaim(options: CompactionOwnerClaimOptions): CompactionOwnerClaim {
	let current: ClaimGeneration | undefined;

	/** Withdraw `generation` if it is still the claim held. */
	const releaseGeneration = (generation: ClaimGeneration | undefined): boolean => {
		if (generation === undefined || current !== generation) return false;
		try {
			generation.handle.withdraw();
		} finally {
			// Fabric withdraws on this abort too, so the claim ends even if the handle's withdraw did not.
			generation.lifetime.abort();
			if (current === generation) current = undefined;
		}
		return true;
	};

	const release = (): boolean => releaseGeneration(current);

	const actions = publishedActions(options.actions, {
		current: () => current,
		fail: (generation, action, error) => {
			// A call made under an earlier claim cannot withdraw this one, nor report a fault for it.
			let released: boolean;
			try {
				released = releaseGeneration(generation);
			} catch {
				// Only a held claim's withdraw can throw; releaseGeneration's finally already dropped it.
				released = true;
			}
			if (released) options.onFault?.(action, error);
		},
	});

	return {
		get active(): boolean {
			return current?.handle.active === true;
		},
		claim(): ClaimAttempt {
			if (current?.handle.active === true) return { kind: "held" };
			// A handle Fabric already cleared (its shutdown, a withdrawn token) is stale.
			current?.lifetime.abort();
			current = undefined;
			const controller = new AbortController();
			let answer: CompactionOwnerClaimReply | undefined;
			const message: CompactionOwnerClaimMessage = {
				version: 1,
				type: "claim",
				owner: { ...options.owner },
				actions,
				signal: controller.signal,
				reply: (result) => {
					answer ??= result;
				},
			};
			options.events.emit(COMPACTION_OWNER_EVENT, message);
			if (answer === undefined) {
				controller.abort();
				return { kind: "no-fabric" };
			}
			if (!answer.ok) {
				controller.abort();
				return { kind: "refused", error: answer.error };
			}
			current = { handle: answer.handle, lifetime: controller };
			return { kind: "claimed", ...(answer.carry === undefined ? {} : { carry: answer.carry }) };
		},
		release,
		fallback(event, context, fallbackOptions) {
			const held = current?.handle;
			if (held?.active !== true) return { ok: false, reason: "the compaction owner claim is not held" };
			try {
				return held.fallback(event, context, fallbackOptions);
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Keeping the claim in step with the setting
// ---------------------------------------------------------------------------

export interface ClaimControllerOptions extends CompactionOwnerClaimOptions {
	/** Whether this session should hold the claim: the setting is on and this extension can compact. */
	readonly wanted: (ctx: ExtensionContext) => boolean;
	readonly debug: (message: string) => void;
}

export interface ClaimController {
	readonly active: boolean;
	/** A new session: forget earlier answers, then make the claim if it is wanted. */
	start(ctx: ExtensionContext): void;
	/**
	 * Claim when wanted and not held; withdraw when no longer wanted. `wanted` lets a caller
	 * that has already resolved the configuration say so without a second read.
	 */
	sync(ctx: ExtensionContext, wanted?: boolean): void;
	/** Withdraw the claim, so Fabric's engine compacts again. */
	shutdown(): void;
	fallback: CompactionOwnerClaim["fallback"];
}

export function createClaimController(options: ClaimControllerOptions): ClaimController {
	// Fabric answers or does not, and a refusal names another holder. Neither changes
	// within a session, so ask again only after the next start. After a handler failure the
	// claim was withdrawn; Fabric's engine keeps compaction for the rest of the session.
	let settled: "no-fabric" | "refused" | "faulted" | undefined;
	const claim = createCompactionOwnerClaim({
		...options,
		onFault: (action, error) => {
			settled = "faulted";
			options.debug(`compaction owner claim withdrawn: compact.${action} failed (${error instanceof Error ? error.message : String(error)}); Fabric's engine compacts until the next session`);
			options.onFault?.(action, error);
		},
	});

	const sync = (ctx: ExtensionContext, known?: boolean): void => {
		const wanted = known ?? options.wanted(ctx);
		if (!wanted) {
			if (claim.release()) options.debug("compaction owner claim withdrawn: the setting is off or compaction is unavailable here");
			return;
		}
		if (claim.active || settled !== undefined) return;
		const attempt = claim.claim();
		if (attempt.kind === "claimed") options.debug("compaction owner claim held");
		else if (attempt.kind === "no-fabric") {
			settled = "no-fabric";
			options.debug("compaction owner claim not sent to anyone: Fabric is not loaded");
		} else if (attempt.kind === "refused") {
			settled = "refused";
			options.debug(`compaction owner claim refused: ${attempt.error}`);
		}
	};

	return {
		get active() {
			return claim.active;
		},
		start(ctx) {
			settled = undefined;
			sync(ctx);
		},
		sync,
		shutdown() {
			settled = undefined;
			claim.release();
		},
		fallback: (event, context, fallbackOptions) => claim.fallback(event, context, fallbackOptions),
	};
}
