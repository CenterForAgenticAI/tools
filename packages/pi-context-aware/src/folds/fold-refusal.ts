/**
 * Rewrite the engine's fold refusals for the tools this package registers (pi-context-aware#434).
 *
 * The kernel is a verbatim copy of billion-context-pi's engine (kernel/PROVENANCE.md), so its
 * refusal text sends the model to billion-context-pi's tools: `acp_status`, `search_context`,
 * `decompress` and `compress`. None of them is registered when this package owns folds, so a model
 * told to call one retries folds instead. The adapter rewrites each refusal here, as
 * `stubSummaryError` does for cut-off summaries: the advice names `context_fold`,
 * `context_recall`, `context_status` and `context_compact` instead.
 *
 * A refusal over many earlier folds also listed every one of them ("blocked by b92 (not restored);
 * blocked by b100 ...", 40 ids in one recorded refusal). The list is capped, and the refusal says
 * how to fold those folds again: merge them by fold id, or compact.
 *
 * The sentences the plan checker gives each refusal its code by (`ENGINE_REFUSALS` in
 * src/strategy-runtime/check-plan.ts) are kept, so a rewritten refusal keeps its code.
 */

/** Fold ids a refusal names one by one; the rest are counted. */
export const MAX_LISTED_FOLDS = 8;

export interface RefusalContext {
	/** Active folds the requested range overlaps, in branch order. Read only when a refusal needs them. */
	readonly overlapping: () => readonly string[];
	/** False when the session's methods leave out compact (pi-context-aware#526): the advice then names no context_compact. */
	readonly compact?: boolean;
}

const FOLD_TOOL = "context_fold";

const REFOLD = / Refold blocked: (.*?)\. Restore the affected block\(s\) inline \(decompress with inline:true\), then recompressing the same range updates them in place/su;
const SKIPPED = /— already compressed: (.*?); nothing to compress\./su;
const RECALL = / — use search_context or decompress (b\d+) if you need details from it/u;
const CONTINUE = "Continue the task, or run acp_status and target one of the CURRENT compressible ranges it reports.";
const RETRY = "Run acp_status, then call the compress tool again using only the refs it reports.";
const CURRENT_REFS = "— run acp_status for current refs.";
const VERIFY = "— run acp_status to verify.";
const OTHERWISE = "otherwise run acp_status and compress a range it reports as compressible.";
const COMBINE = "Combine more messages into your range(s) to meet the threshold.";
const KERNEL_CALL = /(?<![A-Za-z_])compress\(\{/gu;
const ID_LIST = /\bb\d+(?:, b\d+)+/gu;

const idNumber = (id: string): number => Number(id.slice(1));

/** `items` joined with `separator`, the first MAX_LISTED_FOLDS of them, and a count of the rest. */
function capped(items: readonly string[], separator: string): string {
	if (items.length <= MAX_LISTED_FOLDS) return items.join(separator);
	return items.slice(0, MAX_LISTED_FOLDS).join(separator) + `${separator}and ${items.length - MAX_LISTED_FOLDS} more`;
}

function foldIdsIn(text: string): string[] {
	return [...new Set(text.match(/\bb\d+\b/gu) ?? [])].sort((a, b) => idNumber(a) - idNumber(b));
}

/** What to do when the range is already folded: merge the folds by id, or compact when the session can. */
function refoldAdvice(ids: readonly string[], compact: boolean): string {
	const merge = ids.length > 0
		? ` To fold them again, merge them by fold id: ${FOLD_TOOL}({ content: [{ startId: "${ids[0]}", endId: "${ids[ids.length - 1]}", summary: "..." }] }).`
		: "";
	return compact ? `${merge} When folding frees too little context, call context_compact at a clean boundary.` : merge;
}

/** One engine refusal, with this package's tools in its advice. Text that names none of the engine's tools is returned unchanged. */
export function nativeRefusal(error: string, context: RefusalContext): string {
	let text = error;
	let advise: string[] | undefined;
	const refold = REFOLD.exec(text);
	if (refold) {
		const reasons = refold[1]!.split("; ");
		text = text.replace(REFOLD, ` Refold blocked: ${capped(reasons, "; ")}`);
		advise = foldIdsIn(refold[1]!);
	}
	const skipped = SKIPPED.exec(text);
	if (skipped) {
		text = text.replace(SKIPPED, `— already compressed: ${capped(skipped[1]!.split("; "), "; ")}; nothing to compress.`);
		advise ??= foldIdsIn(skipped[1]!);
	}
	text = text
		.replace(RECALL, ` — context_recall({ ref: "$1" }) returns its original entries`)
		.replace(CONTINUE, `Continue the task, or fold a range that is offered for folding; context_status({ view: "folds" }) lists the active folds.`)
		.replace(RETRY, `Call ${FOLD_TOOL} again with refs from the current context.`)
		.replace(CURRENT_REFS, "— use a ref from the current context.")
		.replace(VERIFY, `— context_status({ view: "folds" }) lists the active folds.`)
		.replace(OTHERWISE, "otherwise fold a range that is offered for folding.")
		.replace(KERNEL_CALL, FOLD_TOOL + "({")
		.replace(ID_LIST, (list) => capped(list.split(", "), ", "));
	if (text.startsWith("Requested range(s) already compressed")) {
		advise ??= [];
		const overlapping = context.overlapping();
		if (overlapping.length > 0) advise = [...overlapping];
	}
	if (text.includes(COMBINE)) {
		const overlapping = context.overlapping();
		if (overlapping.length > 0) {
			// The range is mostly folded already: more messages of it would not help.
			text = text.replace(COMBINE, `Most of that range is already folded, in ${capped(overlapping, ", ")}.`);
			advise = [...overlapping];
		}
	}
	return advise ? text.trimEnd() + refoldAdvice(advise, context.compact !== false) : text;
}
