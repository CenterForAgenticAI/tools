/**
 * The fold nudge's text in this package (pi-context-aware#458, pi-context-aware#456).
 *
 * The kernel decides when to nudge and renders billion-context-pi's text (kernel/nudge-text.ts, a
 * vendored copy that is not edited). This module changes only the text the model gets:
 *
 * - it names only the context tools this session can call now (`NudgeTools`, from the shared
 *   reachability check in context-tools/tool-reachability.ts). With neither tool reachable there is no
 *   nudge; the kernel's emergency truncation still runs, because it needs no tool call;
 * - with both tools reachable it offers both, with one rule for choosing between them;
 * - it drops the kernel's "A separate, stronger alert will appear if the context is actually full."
 *   No such alert reaches the model;
 * - it no longer carries the kernel's compression philosophy and HOW TO COMPRESS rules. They live,
 *   condensed, in the context_fold tool guidelines (context-tools/context-fold.ts), which the model already
 *   has (in the system prompt, or in the fabric_exec tool description in Fabric code mode), and the nudge
 *   points there without naming a place (pi-context-aware#456). The tier-2 and tier-3 nudges keep the kernel's
 *   distillation rules, which apply only to them.
 */

import type { Steer } from "../strategy/guidance.js";
import { defaultPrompts, renderNudgeText, type NudgeDecision, type Prompts } from "./kernel/index.js";

/** Which of the two context-reducing tools this session can call now. */
export interface NudgeTools {
	readonly fold: boolean;
	readonly compact: boolean;
}

/** What a caller that does not say gets: the fold tool only, as before pi-context-aware#458. */
export const FOLD_ONLY: NudgeTools = Object.freeze({ fold: true, compact: false });

export const COMPACT_TOOL_NAME = "context_compact";

/** The kernel names its fold tool `compress`, and its retrieval tool `decompress`. */
const KERNEL_FOLD_TOOL = "compress";

/**
 * The kernel's text with the fold tool the model can call. Both forms the kernel writes are renamed: the
 * backticked name and a `compress({` call (pi-context-aware#257).
 */
export function renameFoldTool(text: string, tool: string): string {
	if (tool === KERNEL_FOLD_TOOL) return text;
	return text.replaceAll("`" + KERNEL_FOLD_TOOL + "`", "`" + tool + "`").replace(/(?<![A-Za-z])compress\(\{/gu, tool + "({");
}

/**
 * The rule for choosing between the tools, or the one tool's use when only one is reachable.
 * `undefined` when neither is. `steer` (pi-context-aware#459, the session's guidance for the request's model) words
 * the rule for both tools only: with one tool reachable there is nothing to choose, and the text is the default's.
 */
export function choosingRule(tools: NudgeTools, foldTool: string, steer: Steer = "default"): string | undefined {
	const fold = "`" + foldTool + "`";
	const compact = "`" + COMPACT_TOOL_NAME + "`";
	if (tools.fold && tools.compact) {
		if (steer === "compact-boundary") {
			return "Two tools reduce context. When a phase of the work is finished (a deliverable shipped, a question answered, an experiment concluded), compact with " + compact + " and a seed prompt for the next phase. "
				+ "That frees more than folding the phase range by range and avoids nesting folds. Inside a phase that is still running, fold a finished range with " + fold + ".";
		}
		if (steer === "fold-first") {
			return "Two tools reduce context. Fold first: fold with " + fold + " each finished range you no longer need word for word. Folding keeps the task's recent state in place and costs less than starting over. "
				+ "Compact with " + compact + " only when the work moves to a new phase and most of the context is already fold summaries.";
		}
		return "Two tools reduce context. Fold with " + fold + " a finished range you no longer need word for word while the task continues. "
			+ "Compact with " + compact + " and a seed prompt at a phase boundary, or when most of the context is already fold summaries or the next fold would only nest earlier folds.";
	}
	if (tools.fold) return "Fold with " + fold + " a finished range you no longer need word for word.";
	if (tools.compact) return "Compact with " + compact + " and a seed prompt that carries what the next phase needs, at the next phase boundary.";
	return undefined;
}

function usagePercent(decision: NudgeDecision): string {
	return Math.round((decision.contextUsage ?? 0) * 100) + "%";
}

/**
 * The nudge for `decision`, naming only the reachable tools; `undefined` when neither tool is reachable.
 * The caller appends the line on active blocks.
 */
export function reachableNudgeText(decision: NudgeDecision, tools: NudgeTools, foldTool: string, steer: Steer = "default"): string | undefined {
	const rule = choosingRule(tools, foldTool, steer);
	if (rule === undefined) return undefined;
	const emergency = !!decision.breakdown?.emergencyOverride || !!decision.breakdown?.overLimit;
	if (!tools.fold) {
		// The kernel's text is about ranges to fold; without the fold tool none of it applies.
		return emergency
			? "\u26A0\uFE0F Context limit reached: " + usagePercent(decision) + " of the window. " + rule
			: "This is an efficiency nudge to keep context lean, not an overflow warning. Context is at " + usagePercent(decision) + " of the window. " + rule;
	}
	// No location: natively the guidelines are in the system prompt, in Fabric code mode in the fabric_exec description.
	const guidelines = "the `" + foldTool + "` guidelines";
	const prompts: Prompts = { ...defaultPrompts, howToCompressRules: "Pick ranges and write each summary by " + guidelines + "." };
	const tierGuidance = (from: 1 | 2, to: 2 | 3, rules: string) =>
		"Your tier-" + from + " fold summaries have accumulated. Fold them again into one denser tier-" + to + " summary, using fold ids as boundaries (startId and endId as bN). "
		+ "Raw messages between the boundary folds join it: summarize them by " + guidelines + ", and the existing summaries by the " + rules + " below.";
	return renameFoldTool(renderNudgeText(decision, prompts, {
		efficiencyNote: "This is an efficiency nudge to keep context lean, not an overflow warning. " + rule,
		emergencyHeader: "\u26A0\uFE0F Context limit reached. Reduce context now, consumed tool outputs first. " + rule,
		t2Guidance: tierGuidance(1, 2, "TIER 2 distillation rules"),
		t3Guidance: tierGuidance(2, 3, "TIER 3 condensation rules"),
	}).text, foldTool);
}
