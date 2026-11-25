/**
 * The plan checker (pi-context-aware#468, REQ-STRAT-002): the one rule set a context plan must pass, with a
 * stable code for every refusal.
 *
 * Two callers share it. `checkPlan` checks a strategy's plan against the strategy's frozen view.
 * `planFold` (src/folds/fold-adapter.ts), which plans every `context_fold` request, takes each refusal
 * from `foldRules` here: it works out what the fold engine did with the request, and the rule here decides
 * whether that refuses the fold, with which code and which message. A `summarize` operation is planned
 * by `planFold`, so a strategy's fold and the model's fold are refused by the same rules.
 *
 * The vendored engine (src/folds/kernel) still raises its own refusals while it plans: a range wholly in
 * the protected zone, a tool pair or turn split at the zone's boundary, a summary out of bounds, a range
 * already folded or too small. Their text stays the engine's, and `refusalCodeOf` gives each one its
 * code from the sentence the engine raises it with (`ENGINE_REFUSALS`).
 *
 * This module value-imports only the contract, the cut-off summary check, the forged role turn detector
 * and the engine's boundary error. It stays outside the import closure of the runtime modules that are handed a session writer
 * (tests/strategy-guard.test.ts asserts it).
 */

import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import { findForgedRoleTurns, ROLE_LABEL_ESCAPE_PREFIX } from "../compaction/role-label-escape.js";
import type { FoldRecord } from "../folds/fold-entries.js";
import { BoundaryNotFoundError } from "../folds/kernel/boundaries.js";
import { STUB_SUMMARY_CODE, stubSummaryError } from "../folds/stub-summary.js";
import {
	REFUSAL_RULES,
	type ContextPlan,
	type ContextView,
	type PlanRefusal,
	type RefusalCode,
	type SayOp,
	type StubOp,
	type SummarizeOp,
	type ViewEntry,
} from "../strategy/contract.js";

/** A refusal before it is tied to an operation of a plan. */
export type Refusal = Omit<PlanRefusal, "op">;

export function refusal(code: RefusalCode, message: string): Refusal {
	return { rule: REFUSAL_RULES[code], code, message };
}

/**
 * The fold engine's refusals and `planFold`'s own, by the sentence each is raised with, in the order they
 * are tried. The engine's text is vendored verbatim (src/folds/kernel/compress.ts and boundaries.ts) and
 * `nativeRefusal` (src/folds/fold-refusal.ts) keeps these sentences when it rewrites a refusal's advice.
 * tests/strategy-refusal-sources.test.ts reads the sentences where they are raised: each pattern here
 * must match one, and each one must get a code.
 */
export const ENGINE_REFUSALS: readonly (readonly [RefusalCode, RegExp])[] = [
	["summary-stub", new RegExp(`\\[${STUB_SUMMARY_CODE}\\]`, "u")],
	["summary-empty", /Summary is empty/u],
	["forged-role-turn", /carries a forged role turn/u],
	["summary-short", /Summary too short/u],
	["summary-long", /Summary too long/u],
	["dangling-ref", /cannot be anchored/u],
	["unknown-ref", /does not exist in this session|every ref is unknown|Invalid boundary ref|is not in the request/u],
	["kept-verbatim", /kept word for word by a fold hint/u],
	["condenses-instead", /carries skill text that condenses/u],
	["first-user-kept", /^Keeping the first user message leaves nothing else to fold/u],
	// Before the protected zone: a split at the zone's boundary says to wait until the turn "ages out of the protected zone".
	["split-pair", /would split/u],
	["protected-zone", /protected zone/u],
	["already-folded", /already compressed|not found in visible context|contains no new compressible messages|already covered by active blocks|hidden orphan compress call|none of its content/u],
	["too-small", /compressible content too small/u],
	["too-large", /^too-large: /u],
	["no-fold", /created no fold|covers no session entry/u],
	// The session could not be read: no header to plan against, or no view to check a plan on (pi-context-aware#472).
	["header-missing", /Session header is unavailable|could not be read for the plan check/u],
];

/** Longest text a code is read from: a refusal longer than this is classified on its start. */
const MAX_CLASSIFIED_CHARS = 64 * 1024;

/** The code of a fold refusal from its text; `unrecognized` for text no rule raises. */
export function refusalCodeOf(message: string): RefusalCode {
	const text = message.slice(0, MAX_CLASSIFIED_CHARS);
	return ENGINE_REFUSALS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unrecognized";
}

/** A refusal the fold engine raised: its code from the engine's text, its message after `rewrite`. */
export function engineRefusal(error: string, rewrite: (error: string) => string = (text) => text): Refusal {
	return refusal(refusalCodeOf(error), rewrite(error));
}

/** What `planFold` found when it took coverage for one fold the engine created. */
export interface FoldCoverage {
	readonly blockId: string;
	/** The entry that would carry the summary; `undefined` when the fold would hide nothing. */
	readonly carrierId: string | undefined;
	/** Entries a `verbatim` fold hint kept out of the fold. */
	readonly verbatim: number;
	/** Entries that show condensed text instead of folding. */
	readonly condensed: number;
	/** The kept opening user message is in the fold's range. */
	readonly keptFirstInRange: boolean;
	/** Messages withdrawn to keep whole entries and tool pairs beside the protected zone. */
	readonly withdrawn: number;
}

/**
 * The rules `planFold` applies, in the order it applies them. Each takes what `planFold` worked out and
 * returns the refusals, or none when the rule lets the fold through.
 */
export const foldRules = {
	/** Summary bounds: a summary cut off like a shortened earlier summary, or a copied block pointer. */
	summary(summary: string): Refusal[] {
		const error = stubSummaryError(summary);
		return error === undefined ? [] : [refusal("summary-stub", error)];
	},
	/**
	 * Provenance (pi-context-aware#474, REQ-STRAT-010): a line of the summary that presents itself as a user,
	 * system or assistant turn would reach the session as if someone had said it. The refusal names the
	 * first such line and its role, never its text.
	 */
	provenance(summary: string): Refusal[] {
		const forged = findForgedRoleTurns(summary)[0];
		return forged === undefined ? [] : [refusal("forged-role-turn", `The summary carries a forged role turn: line ${forged.line} presents itself as a turn by the ${forged.role}. Report what was said in prose, or start the line with "${ROLE_LABEL_ESCAPE_PREFIX}".`)];
	},
	/** A range boundary the engine could not resolve. A boundary inside an active fold is left to the engine, which refuses it as already folded. */
	boundary(error: unknown, rewrite: (error: string) => string): Refusal[] {
		if (error instanceof BoundaryNotFoundError && error.kind === "consumed") return [];
		return [engineRefusal(error instanceof Error ? error.message : String(error), rewrite)];
	},
	/**
	 * Tool pairs: a range named by fold ids, widened to whole entries and tool pairs, reaches past its ends.
	 * `first` and `last` index the widened range in the prepared turn (-1 when it holds no message);
	 * `startIndex` and `endIndex` the range as named.
	 */
	blockSplit(span: { readonly first: number; readonly last: number; readonly startIndex: number; readonly endIndex: number }): Refusal[] {
		return span.first >= 0 && (span.first < span.startIndex || span.last > span.endIndex) ? [refusal("split-pair", "Block range would split an entry or tool pair; include the adjacent entries explicitly.")] : [];
	},
	/** The engine's own refusals. A fold it did not create is refused with its warnings, which hold the reason a range was skipped. */
	engine(result: { readonly errors: readonly string[]; readonly warnings: readonly string[]; readonly created: number }, rewrite: (error: string) => string): Refusal[] {
		if (result.errors.length === 0 && result.created > 0) return [];
		const errors = result.errors.length > 0 ? result.errors : result.warnings.length > 0 ? result.warnings : ["The engine created no fold for this range."];
		return errors.map((error) => engineRefusal(error, rewrite));
	},
	/**
	 * Already folded: a message range over folded entries plus the kept opening message would fold those
	 * folds again and hide nothing new. The engine counts the kept message as new, so it lets the range through.
	 */
	keptFirstOnly(facts: { readonly startRef: string; readonly endRef: string; readonly blockRange: boolean; readonly touchesKeptFirst: boolean; readonly fresh: number; readonly absorbed: readonly string[] }): Refusal[] {
		if (facts.blockRange || !facts.touchesKeptFirst || facts.fresh > 0 || facts.absorbed.length === 0) return [];
		return [refusal("already-folded", `Range ${facts.startRef}..${facts.endRef} contains no new compressible messages: the first user message is kept visible and every other message in it is already covered by active block(s) ${facts.absorbed.join(", ")}. Nothing was compressed.`)];
	},
	/** A fold that would hide no entry, with the rule that left nothing to fold. */
	coverage(coverage: FoldCoverage): Refusal[] {
		if (coverage.carrierId !== undefined) return [];
		if (coverage.verbatim > 0) return [refusal("kept-verbatim", "Every entry in this range is kept word for word by a fold hint; there is nothing to fold.")];
		if (coverage.condensed > 0) return [refusal("condenses-instead", "Every other entry in this range carries skill text that condenses instead of folding; there is nothing to fold.")];
		if (coverage.keptFirstInRange) return [refusal("first-user-kept", "Keeping the first user message leaves nothing else to fold (covers no session entry).")];
		if (coverage.withdrawn > 0) return [refusal("split-pair", "Range would split a session entry or tool pair at the protected-zone boundary; wait until the whole entry ages out of the protected zone.")];
		return [refusal("no-fold", `Fold ${coverage.blockId} covers no session entry.`)];
	},
};

/** A fold the engine planned for a `summarize` operation, ready to write at a boundary. */
export interface SummarizeEffect {
	readonly kind: "summarize";
	readonly op: number;
	readonly records: readonly FoldRecord[];
	readonly drafts: readonly SessionBoundaryDraft[];
	readonly warnings: readonly string[];
}

/**
 * A `stub` to write as a recoverable hide. The runtime that writes it appends the `context_recall` pointer
 * for `hideId` (`hidePointerLine` in src/folds/hide-entries.ts); `text` is the plan's text alone.
 */
export interface StubEffect {
	readonly kind: "stub";
	readonly op: number;
	readonly entryId: string;
	readonly text: string;
	readonly hideId: string;
}

export interface SayEffect {
	readonly kind: "say";
	readonly op: number;
	readonly text: string;
}

export type PlanEffect = SummarizeEffect | StubEffect | SayEffect;

/** A plan's verdict: every operation's effect, or every refusal. A plan with any refusal applies nothing. */
export type PlanCheck =
	| { readonly ok: true; readonly effects: readonly PlanEffect[] }
	| { readonly ok: false; readonly refusals: readonly PlanRefusal[] };

/** A `summarize` operation that carries its summary. */
export type WrittenSummarizeOp = Extract<SummarizeOp, { writer: "plan" }>;

/**
 * Plans one written `summarize` operation on the session the view was built from: `summarizeEngine` in
 * src/folds/fold-adapter.ts, which runs `planFold`.
 */
export type SummarizeEngine = (op: WrittenSummarizeOp) =>
	| { readonly ok: true; readonly records: readonly FoldRecord[]; readonly drafts: readonly SessionBoundaryDraft[]; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly refusals: readonly Refusal[] };

/** At most this many names are listed in a refusal. */
const MAX_LISTED_NAMES = 12;
/** A tool name that is one ordinary word: letters only, no capital after the first. */
const ONE_WORD = /^[A-Za-z][a-z]*$/u;
/** No letter, digit, `_`, `$` or `-` before the name. */
const BEFORE = "(?<![\\w$-])";
/** No letter, digit, `_`, `$` or `-` after the name. */
const AFTER = "(?![\\w$-])";
/** The pointer `context_recall` follows; only the runtime writes one. */
const RECALL_POINTER = /context_recall\s*\(/u;
/** Roles whose entries a `context_edit` can replace (`isEditableEntry` in src/folds/fold-entries.ts), so a hide of them can be recalled. */
const RECOVERABLE_ROLES: ReadonlySet<ViewEntry["role"]> = new Set(["user", "assistant", "toolResult", "custom"]);
const HIDE_NUMBER = /^h([1-9]\d{0,8})$/u;

const listed = (names: readonly string[]): string =>
	names.length <= MAX_LISTED_NAMES ? names.join(", ") : `${names.slice(0, MAX_LISTED_NAMES).join(", ")} and ${names.length - MAX_LISTED_NAMES} more`;

/**
 * The names of `names` that `text` names as tools, sorted. Names are never guessed from their shape: only
 * a name the session registered can be named, so a word such as file_path is prose unless a tool has that
 * name. A name counts only as a whole token: no letter, digit, `_`, `$` or `-` touches either end.
 *
 * - A name that is not one ordinary word (it has `_`, `-`, a digit or a capital after the first letter,
 *   such as context_fold, mcp__github__create_issue or contextFold) counts wherever it stands as a token.
 * - A one-word name (bash, read, edit, write, find) is also an ordinary word, so it counts only where the
 *   text uses it as a tool: in backticks (`read`), written as a call (`read(`), right after use, call,
 *   run or invoke with an optional "the" ("Use bash", "call the read tool"), or right before the word
 *   tool or tools ("the edit tool"). "Read the file" and "edit it" name no tool.
 *
 * Names match with their case as registered; the verbs match with a lower- or upper-case first letter.
 */
export function toolsNamedIn(text: string, names: readonly string[]): string[] {
	return [...new Set(names)].filter((name) => name.length > 0 && namePattern(name).test(text)).sort();
}

function namePattern(name: string): RegExp {
	const quoted = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	if (!ONE_WORD.test(name)) return new RegExp(`${BEFORE}${quoted}${AFTER}`, "u");
	return new RegExp([
		`\`${quoted}\``,
		`(?<![\\w$.-])${quoted}\\(`,
		`(?<![\\w$-])(?:[Uu]se|[Cc]all|[Rr]un|[Ii]nvoke)\\s+(?:the\\s+)?${quoted}${AFTER}`,
		`${BEFORE}${quoted}\\s+tools?${AFTER}`,
	].join("|"), "u");
}

/** How a plan reached the checker. */
export interface CheckOptions {
	/**
	 * The plan is a compaction (the compaction trigger of the stage loop), so the one-writer rule applies: while
	 * another owner holds the compaction claim, its `summarize` is refused. A plan from a request or the model's
	 * `context_fold` is not a compaction.
	 */
	readonly compaction?: boolean;
}

/** At most this many quoted parts of one `say` are set aside; any more are checked as text. */
const MAX_QUOTED_PARTS = 64;

/** The say's own words: its text with each part it quotes from the session (`SayOp.quoted`) replaced by a line break. */
function ownWords(op: SayOp): string {
	let text = op.text;
	for (const part of (op.quoted ?? []).slice(0, MAX_QUOTED_PARTS)) {
		if (typeof part === "string" && part.length > 0) text = text.split(part).join("\n");
	}
	return text;
}

/**
 * Reachable tools: of the tools the session registered, a `say` may name only those it can call now (pi-context-aware#458).
 * A tool named only inside a part the say quotes from the session, such as a fold topic the model wrote, is not
 * an offer (CR-NUDGE-REFUSED-BY-TOPIC).
 */
function sayRefusals(view: ContextView, op: SayOp): Refusal[] {
	const reachable = new Set(view.tools);
	const unreachable = toolsNamedIn(ownWords(op), view.registeredTools).filter((name) => !reachable.has(name));
	if (unreachable.length === 0) return [];
	return [refusal("unreachable-tool", `The message names ${listed(unreachable)}, which the session cannot call; it may name only ${view.tools.length > 0 ? listed(view.tools) : "no tool"}.`)];
}

/** Entries an active fold or hide already takes over: a fold's carrier shows its summary, a hidden entry its stub. */
function takenEntries(view: ContextView): Map<string, string> {
	const taken = new Map<string, string>();
	for (const fold of view.folds) for (const id of [fold.carrierId, ...fold.hiddenIds]) taken.set(id, fold.blockId);
	for (const hide of view.hides) taken.set(hide.targetId, hide.hideId);
	return taken;
}

/** The rules a `stub` passes. The runtime writes the recall pointer, so the plan's text may not carry one. */
function stubRefusals(view: ContextView, op: StubOp, taken: ReadonlyMap<string, string>): Refusal[] {
	const entry = view.entries.find((candidate) => candidate.id === op.entryId);
	if (entry === undefined) return [refusal("unknown-ref", `Entry ${op.entryId.slice(0, 64)} is not in the request.`)];
	const refusals: Refusal[] = [];
	if (!RECOVERABLE_ROLES.has(entry.role)) refusals.push(refusal("unrecoverable", `Entry ${entry.id} is a ${entry.role} entry; a context edit cannot replace it, so context_recall could not return it.`));
	if (RECALL_POINTER.test(op.text)) refusals.push(refusal("forged-pointer", "The stub text carries a context_recall pointer; the runtime writes the pointer."));
	if (entry.hint === "verbatim") refusals.push(refusal("kept-verbatim", `Entry ${entry.id} is kept word for word by a fold hint.`));
	else if (view.protectedEntryIds.includes(entry.id)) refusals.push(refusal("protected-zone", `Entry ${entry.id} is in the protected zone.`));
	const by = taken.get(entry.id);
	if (by !== undefined) refusals.push(refusal("already-folded", `Entry ${entry.id} is already taken by ${by}.`));
	if ((entry.toolCallIds?.length ?? 0) > 0) refusals.push(refusal("split-pair", `Entry ${entry.id} makes tool calls; a stub would leave their results without them.`));
	if (op.text.trim().length === 0) refusals.push(refusal("summary-empty", "The stub text is empty."));
	return refusals;
}

function nextHideNumber(view: ContextView): number {
	return view.hides.reduce((highest, hide) => Math.max(highest, Number(HIDE_NUMBER.exec(hide.hideId)?.[1] ?? 0)), 0) + 1;
}

/**
 * Check a strategy's plan against the view it was planned on (REQ-STRAT-002). Every operation is checked;
 * the plan applies only when none is refused. `summarize` operations are planned by `engine` on the
 * session the view was built from. No operation may take an entry an earlier operation of the plan takes.
 */
export function checkPlan(view: ContextView, plan: ContextPlan, engine: SummarizeEngine, options: CheckOptions = {}): PlanCheck {
	const refusals: PlanRefusal[] = [];
	const effects: PlanEffect[] = [];
	const taken = takenEntries(view);
	const takenByPlan = new Map<string, number>();
	let hideNumber = nextHideNumber(view);
	plan.forEach((op, index) => {
		const refuse = (found: readonly Refusal[]): boolean => {
			for (const one of found) refusals.push({ op: index, ...one });
			return found.length > 0;
		};
		// One writer for compaction (CR-ONE-WRITER-DECISION): while another owner holds the compaction claim, it writes
		// the compaction's summary. Folds, stubs and says are not compactions; the claim does not refuse them.
		if (options.compaction === true && op.kind === "summarize" && view.compactionOwner === "other") {
			refuse([refusal("owner-claimed", "Another owner holds the compaction claim, so it writes this compaction's summary.")]);
			return;
		}
		if (op.kind === "say") {
			if (!refuse(sayRefusals(view, op))) effects.push({ kind: "say", op: index, text: op.text });
			return;
		}
		let claims: readonly string[];
		let effect: () => PlanEffect;
		if (op.kind === "stub") {
			if (refuse(stubRefusals(view, op, taken))) return;
			claims = [op.entryId];
			effect = () => ({ kind: "stub", op: index, entryId: op.entryId, text: op.text, hideId: `h${hideNumber++}` });
		} else if (op.writer !== "plan") {
			refuse([refusal("summary-unwritten", `A ${op.writer} writer writes this summary (pi-context-aware#436); check the plan again with the summary written.`)]);
			return;
		} else {
			const planned = engine(op);
			if (!planned.ok) {
				refuse(planned.refusals);
				return;
			}
			claims = planned.records.flatMap((record) => [record.carrierId, ...record.hiddenIds]);
			effect = () => ({ kind: "summarize", op: index, records: planned.records, drafts: planned.drafts, warnings: planned.warnings });
		}
		const overlap = claims.filter((id) => takenByPlan.has(id));
		if (overlap.length > 0) {
			refuse([refusal("already-folded", `Operation ${index} takes ${listed(overlap)}, which operation ${takenByPlan.get(overlap[0]!)} of this plan already takes.`)]);
			return;
		}
		for (const id of claims) takenByPlan.set(id, index);
		effects.push(effect());
	});
	return refusals.length > 0 ? { ok: false, refusals } : { ok: true, effects };
}
