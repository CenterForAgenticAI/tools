/**
 * The `compact.*` actions this extension offers while it holds the compaction
 * owner claim.
 *
 * Fabric validates a program's call first and passes only the fields the claim
 * declared. The handlers are published on the shared event bus, though, so any
 * listener can call them directly: each one decodes its own input with Fabric's
 * limits (see owner-input.ts) before it allocates or queues anything. A call
 * refused for its input throws `OwnerCallRefused`; anything else that throws is a
 * fault, and the claim is withdrawn (see owner-claim.ts). Everything that touches
 * the session is injected, which keeps the rules here testable without a Pi
 * session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import { applyCarryUpdate, isCarryUpdate, sameItems } from "./owner-carry.js";
import { decodeOwnerCall, decodeOwnerCarryUpdate, decodeOwnerRequest, OwnerCallRefused } from "./owner-input.js";
import { MAX_OWNER_RESULT_BYTES, ownerResultBytes } from "./owner-result.js";
import {
	COMPACTION_OWNER_CARRY_FIELDS,
	COMPACTION_OWNER_REQUEST_FIELDS,
	type CompactionOwnerActions,
	type CompactionOwnerCall,
	type CompactionOwnerCarryUpdate,
	type CompactionOwnerPressure,
	type CompactionOwnerRequest,
} from "./owner-claim.js";

/** The focus an owner request adds to the summary instructions. */
export interface OwnerRequestFocus {
	readonly summaryFocus: string | null;
	readonly hints: readonly string[];
}

/**
 * A request's instructions and preserve list become focus text for the summary.
 * `instructions` and `reason` lead the focus; each `preserve` item is its own hint.
 */
export function ownerRequestFocus(request: CompactionOwnerRequest): OwnerRequestFocus {
	const lead: string[] = [];
	const instructions = request.instructions?.trim();
	if (instructions) lead.push(instructions);
	const reason = request.reason?.trim();
	if (reason) lead.push(`Reason for this compaction: ${reason}`);
	const requestedBy = request.requestedBy?.trim();
	if (requestedBy) lead.push(`Requested by: ${requestedBy}`);
	const hints = (request.preserve ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
	return { summaryFocus: lead.length > 0 ? lead.join("\n") : null, hints };
}

export type OwnerQueueOutcome =
	| { readonly status: "queued" | "running"; readonly runId: string }
	| { readonly status: "nothing-to-compact"; readonly message: string };

export interface OwnerActionDeps {
	/** The session a call belongs to: the call's own context, else the one the claim was made in. */
	readonly sessionFor: (call: CompactionOwnerCall) => ExtensionContext;
	/**
	 * Queue one compaction at the next safe boundary. A new request replaces one this owner
	 * queued that has not started, as Fabric's own controller does. Throws `OwnerCallRefused`
	 * when another compaction is queued or running.
	 */
	readonly queue: (ctx: ExtensionContext, focus: OwnerRequestFocus, seed: string | undefined) => OwnerQueueOutcome;
	/** Drop the compaction this owner queued, if it has not started. */
	readonly cancel: (ctx: ExtensionContext) => { readonly cancelled: boolean; readonly reason?: string };
	readonly readCarry: (ctx: ExtensionContext) => string[];
	readonly writeCarry: (ctx: ExtensionContext, items: readonly string[]) => void;
	readonly pressure: (ctx: ExtensionContext) => CompactionOwnerPressure;
	readonly status: (ctx: ExtensionContext) => Record<string, unknown>;
}

/**
 * The `compact.carry` result for a list, or `OwnerCallRefused` when Fabric could not pass
 * it on. The protocol's carry result is the whole list (`{ items }`), and Fabric rejects
 * an owner result over `MAX_OWNER_RESULT_BYTES` after the handler returns. Sixteen items
 * of up to 2048 characters each are valid arguments, but their list does not fit, so
 * this is checked before anything is written.
 */
function carryResult(items: string[], changing: boolean): { items: string[] } {
	const result = { items };
	const bytes = ownerResultBytes(result) ?? Number.POSITIVE_INFINITY;
	if (bytes <= MAX_OWNER_RESULT_BYTES) return result;
	throw new OwnerCallRefused(changing
		? `compact.carry would leave a list of ${bytes} bytes as JSON, over Fabric's ${MAX_OWNER_RESULT_BYTES}-byte bound for an owner result; nothing was changed`
		: `the carry list is ${bytes} bytes as JSON, over Fabric's ${MAX_OWNER_RESULT_BYTES}-byte bound for an owner result; replace it with items, or clear it`);
}

export function createOwnerActions(deps: OwnerActionDeps): CompactionOwnerActions {
	return {
		request: {
			fields: [...COMPACTION_OWNER_REQUEST_FIELDS],
			handler: (input, rawCall) => {
				const request = decodeOwnerRequest(input);
				const call = decodeOwnerCall(rawCall);
				const seed = request.seed?.trim();
				const outcome = deps.queue(deps.sessionFor(call), ownerRequestFocus(request), seed ? seed : undefined);
				return outcome.status === "nothing-to-compact"
					? { queued: false, reason: outcome.message }
					: { queued: true, state: outcome.status, runId: outcome.runId, seeded: seed !== undefined && seed !== "" };
			},
		},
		status: { handler: (call) => deps.status(deps.sessionFor(decodeOwnerCall(call))) },
		pressure: { handler: (call) => deps.pressure(deps.sessionFor(decodeOwnerCall(call))) },
		carry: {
			fields: [...COMPACTION_OWNER_CARRY_FIELDS],
			handler: (input: CompactionOwnerCarryUpdate, rawCall) => {
				const update = decodeOwnerCarryUpdate(input);
				const ctx = deps.sessionFor(decodeOwnerCall(rawCall));
				const current = deps.readCarry(ctx);
				if (!isCarryUpdate(update)) return carryResult(current, false);
				// Refused when the result breaks a limit: nothing is written, the list is unchanged.
				let next: string[];
				try {
					next = applyCarryUpdate(current, update);
				} catch (error) {
					throw new OwnerCallRefused(error instanceof Error ? error.message : String(error));
				}
				const result = carryResult(next, true);
				if (!sameItems(current, next)) deps.writeCarry(ctx, next);
				return result;
			},
		},
		cancel: { handler: (call) => deps.cancel(deps.sessionFor(decodeOwnerCall(call))) },
	};
}

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

export type LadderStage =
	| "unknown"
	| "below-ladder"
	| "fold-nudges"
	| "approaching-compaction"
	| "seeded-compaction"
	| "recoverable-hide";

/** Where a measured context fraction sits on the pressure ladder; `unknown` before Pi has measured. */
export function pressureLadderStage(fraction: number | null, ladder: PressureLadderConfig): LadderStage {
	if (fraction === null || !Number.isFinite(fraction)) return "unknown";
	if (fraction >= ladder.recoverableHideFraction) return "recoverable-hide";
	if (fraction >= ladder.seededCompactionFraction) return "seeded-compaction";
	if (fraction >= ladder.foldNudgeEndFraction) return "approaching-compaction";
	if (fraction >= ladder.foldNudgeStartFraction) return "fold-nudges";
	return "below-ladder";
}

/** The owner's own ladder, reported beside Fabric's pressure band. */
export function ownerPressure(fraction: number | null, ladder: PressureLadderConfig): CompactionOwnerPressure {
	return {
		stage: pressureLadderStage(fraction, ladder),
		thresholds: {
			foldNudgeStartFraction: ladder.foldNudgeStartFraction,
			foldNudgeEndFraction: ladder.foldNudgeEndFraction,
			seededCompactionFraction: ladder.seededCompactionFraction,
			recoverableHideFraction: ladder.recoverableHideFraction,
		},
	};
}

// ---------------------------------------------------------------------------
// Seed delivery
// ---------------------------------------------------------------------------

/** Pi custom-message type of the seed this extension sends after an owner-requested compaction. */
export const OWNER_SEED_MESSAGE_TYPE = "context-aware-compaction-seed" as const;

/** Delivery for a seed: a message that starts a turn, queued as a follow-up. */
export const OWNER_SEED_DELIVERY = { triggerTurn: true, deliverAs: "followUp" } as const;

const OWNER_SEED_LABEL =
	"A program requested this continuation when it compacted the context. It is not a message from the user.";

function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The seed as a labelled custom message, not a user message. A seed is
 * program-written text, and the compaction removes the context that showed who
 * wrote it. Pi hands a custom message to the model as user-role text without its
 * type, so the origin travels in the text, ahead of the escaped seed, which
 * cannot close the wrapper.
 */
export function ownerSeedMessage(seed: string): {
	customType: typeof OWNER_SEED_MESSAGE_TYPE;
	content: string;
	display: true;
	details: { version: 1 };
} {
	return {
		customType: OWNER_SEED_MESSAGE_TYPE,
		content: `${OWNER_SEED_LABEL}\n<compaction-seed>\n${escapeXmlText(seed)}\n</compaction-seed>`,
		display: true,
		details: { version: 1 },
	};
}
