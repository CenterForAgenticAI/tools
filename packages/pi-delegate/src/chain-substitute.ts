/**
 * Pure substitution of chain template variables.
 *
 * Variables (mirrors pi-subagents' chain DSL):
 *   {task}      — the original task supplied to the top-level chain call.
 *                 Same value at every step.
 *   {previous}  — collapsed output of the previous step. Empty string at
 *                 step 0. For a parallel step, this is the aggregated
 *                 output formatted by `formatParallelAggregate`.
 *   {chain_dir} — absolute path to the per-run chain artifact directory.
 *
 * Substitution is plain string-replace, NOT eval. We do not interpret
 * regex or shell metacharacters in the replacement value, and we do not
 * recursively expand variables that appear in the replacement (so a step
 * that produces `{previous}` literally will pass it through to the next
 * step verbatim).
 *
 * Unrecognised `{foo}` placeholders are left literal so users get a
 * visible signal in the next step's task body rather than a silent typo.
 */

export interface SubstitutionVars {
	task: string;
	previous: string;
	chainDir: string;
}

/**
 * Substitute the three known variables in `template`. Unknown
 * `{whatever}` placeholders pass through unchanged.
 *
 * SINGLE-PASS (issue #10): substitution is one regex walk over the TEMPLATE,
 * so substituted VALUES are never re-scanned. The previous chained
 * `replaceAll` ran in sequence ({task} → {previous} → {chain_dir}), so a
 * literal `{chain_dir}` inside `vars.previous` — which is raw worker output —
 * was expanded by the later pass (template-variable injection), corrupting
 * downstream step prompts and violating this function's own no-recursive-
 * expansion contract.
 */
export function substituteChainTemplate(template: string, vars: SubstitutionVars): string {
	if (!template) return template;
	return template.replace(/\{(task|previous|chain_dir)\}/g, (_m, key: string) =>
		key === "task" ? vars.task : key === "previous" ? vars.previous : vars.chainDir,
	);
}

/**
 * Format a fan-out step's aggregated output as the `{previous}` value for
 * the next sequential step. Mirrors pi-subagents' format byte-for-byte
 * so existing chain files written for pi-subagents that depend on the
 * separator format continue to work.
 *
 *   === Parallel Task 1 (scout) ===
 *   <task 1 collapsed output>
 *
 *   === Parallel Task 2 (worker#2) ===
 *   <task 2 collapsed output>
 */
export interface ParallelAggregateInput {
	name: string;
	agent: string;
	collapsedContent: string;
	error?: string;
	recoveredOutput?: boolean;
}

export function formatParallelAggregate(items: ParallelAggregateInput[]): string {
	return items
		.map((item, idx) => {
			const header = `=== Parallel Task ${idx + 1} (${item.agent}) ===`;
			const body = item.collapsedContent
				? item.error && item.recoveredOutput
					? `error: ${item.error}\n\n${item.collapsedContent}`
					: item.collapsedContent
				: item.error
					? `error: ${item.error}`
					: "(no output)";
			return `${header}\n${body}`;
		})
		.join("\n\n");
}
