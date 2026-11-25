import { refusalCodeOf } from "../strategy-runtime/check-plan.js";
import type { RefusalCode } from "../strategy/contract.js";
import type { OutcomeEvidence, OutcomeType, ParityDiff, RejectReason } from "./records.js";

/**
 * Typed compress outcomes. Raw result and error text is classified here and never leaves this
 * module: records hold only the closed categories below.
 */

/** What billion-context-pi's result text says, before side-file block counts are considered. */
export type ObservedResult =
	| { readonly kind: "terminal"; readonly type: Exclude<OutcomeType, "accepted" | "partial" | "rejected"> }
	| { readonly kind: "panel"; readonly blocks: number; readonly reasons: readonly RejectReason[] };

const MAX_CLASSIFIED_CHARS = 64 * 1024;
/**
 * The parity reason each refusal code is recorded as (pi-context-aware#468). Records name no reason for a
 * fold hint, a stub, the claim or a tool; those codes are `other`, as their text was before the codes.
 */
const REASON_BY_CODE: Readonly<Record<RefusalCode, RejectReason>> = {
	"split-pair": "split",
	"protected-zone": "protected-zone",
	"first-user-kept": "no-fold",
	"unrecoverable": "other",
	"forged-pointer": "other",
	"kept-verbatim": "other",
	"condenses-instead": "other",
	"summary-empty": "summary-empty",
	"summary-short": "summary-short",
	"summary-long": "summary-long",
	"summary-stub": "stub-summary",
	"summary-unwritten": "other",
	"already-folded": "consumed",
	"owner-claimed": "other",
	"unreachable-tool": "other",
	"forged-role-turn": "other",
	"unknown-ref": "unknown-ref",
	"dangling-ref": "dangling-ref",
	"too-small": "too-small",
	"too-large": "other",
	"no-fold": "no-fold",
	"header-missing": "header-missing",
	"unrecognized": "other",
};

/** Map kernel/adapter rejection messages to reason codes, through the plan checker's refusal code of each; unrecognized text is `other`. */
export function rejectReasons(messages: readonly string[]): RejectReason[] {
	return [...new Set(messages.map((message) => REASON_BY_CODE[refusalCodeOf(message)]))].sort();
}

/**
 * Split billion-context-pi's `Errors:` section into one group per kernel error, so each is
 * classified on its own and an unrecognized one cannot hide behind a recognized one. The
 * handler joins `range <start>..<end>: <message>` errors with "; "; a semicolon inside a
 * message does not start a group. Kernel messages are single-line, so every further line is
 * its own group too. The section ends at the compressible-ranges list a partial result adds.
 */
const ERRORS_SECTION = /\nErrors: ([\s\S]*?)(?:\nCurrent compressible ranges \(|$)/u;
const ERROR_GROUP_BOUNDARY = /; (?=range \S+?\.\.\S+?: )|\n/u;
function errorGroups(head: string): string[] | undefined {
	const section = ERRORS_SECTION.exec(head)?.[1];
	if (section === undefined) return undefined;
	const groups = section.split(ERROR_GROUP_BOUNDARY).filter((group) => group.trim());
	// An error section with no readable group is still an error nobody classified.
	return groups.length ? groups : [section];
}

const PANEL = /^\u25A3 ACP \|[^\n]*\((?:[^\n]*?, )?(?:(\d+) blocks?|blocks: ([^\n]*))\)/u;
/** Classify billion-context-pi's compress result (or the host's error result) by its text. */
export function classifyBcpResult(text: string, isError: boolean): ObservedResult {
	const head = text.slice(0, MAX_CLASSIFIED_CHARS);
	if (isError) {
		if (/^Operation aborted\s*$/u.test(head) || /^AbortError\b/u.test(head)) return { kind: "terminal", type: "aborted" };
		if (/^Invalid compress content \(/u.test(head) || /^Validation failed for tool "compress"/u.test(head)) return { kind: "terminal", type: "invalid-input" };
		if (/only re-condenses terminal tier-3 block/u.test(head)) return { kind: "terminal", type: "tier3-rewrite" };
		return { kind: "terminal", type: "unknown" };
	}
	if (/^No ranges provided\.\s*$/u.test(head)) return { kind: "terminal", type: "no-op" };
	if (/\n\[ACP\] PAUSED \u2014/u.test(head)) return { kind: "terminal", type: "capped-retry" };
	if (/\n\[ACP\] REJECTED \u2014 this exact compress call has now failed/u.test(head)) return { kind: "terminal", type: "dead-range" };
	const panel = PANEL.exec(head);
	if (!panel) return { kind: "terminal", type: "unknown" };
	const blocks = panel[1] !== undefined ? Number(panel[1]) : (panel[2]?.match(/\bb\d+(?:\(T\d+\))?=/gu)?.length ?? 0);
	const groups = errorGroups(head);
	return { kind: "panel", blocks, reasons: groups === undefined ? [] : rejectReasons(groups) };
}

/** billion-context-pi's panel names at least one ref it does not know. */
export function rejectedUnknownRef(observed: ObservedResult): boolean {
	return observed.kind === "panel" && observed.reasons.includes("unknown-ref");
}

/** Combine the observed text with the blocks the side file shows this call created. */
export function bcpOutcome(observed: ObservedResult, createdBlocks: number): OutcomeEvidence {
	if (observed.kind === "terminal") return { type: observed.type, reasons: [] };
	if (createdBlocks > 0) return { type: observed.reasons.length ? "partial" : "accepted", reasons: observed.reasons };
	// The native adapter reports "created no fold" when the kernel rejects without an error.
	return { type: "rejected", reasons: observed.reasons.length ? observed.reasons : ["no-fold"] };
}

export interface NativeCallResult {
	readonly rangeCount: number;
	readonly emptyContent: boolean;
	readonly records: number;
	readonly droppedErrors: readonly string[];
}
export function nativeOutcome(result: NativeCallResult): OutcomeEvidence {
	if (result.rangeCount === 0) return { type: result.emptyContent ? "no-op" : "invalid-input", reasons: [] };
	const reasons = rejectReasons(result.droppedErrors);
	if (result.records > 0) return { type: reasons.length ? "partial" : "accepted", reasons };
	return { type: "rejected", reasons };
}

/** Unknown categories make a comparison inconclusive rather than equal. */
export function compareOutcomes(ours: OutcomeEvidence, bcp: OutcomeEvidence): ParityDiff[] {
	const describe = (outcome: OutcomeEvidence) => outcome.reasons.join(",") || "none";
	if (ours.type === "unknown" || bcp.type === "unknown" || ours.reasons.includes("other") || bcp.reasons.includes("other")) {
		return [{ kind: "outcome-unknown", reason: `ours=${ours.type}/${describe(ours)}; bcp=${bcp.type}/${describe(bcp)}` }];
	}
	if (ours.type !== bcp.type) return [{ kind: "outcome", reason: `ours=${ours.type}; bcp=${bcp.type}` }];
	if (describe(ours) !== describe(bcp)) return [{ kind: "error-type", reason: `ours=${describe(ours)}; bcp=${describe(bcp)}` }];
	return [];
}
