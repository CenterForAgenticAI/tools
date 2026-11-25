/**
 * The live stages (pi-context-aware#472, pi-context-aware#526): today's behaviour as ordered stages on the strategy
 * contract, composed from the session's methods (./methods.ts) into one recipe.
 *
 * - `fold`: the kernel's growth nudge and the model's folds (`context_fold`).
 * - `compact`: seeded compaction (`context_compact`).
 * - The pressure note is every method's: it always runs, between the methods' nudges and their tools.
 *
 * Each stage owns its trigger and its nudge: the runtime injects only the `say` a stage returns, after the
 * plan checker accepts it (REQ-STRAT-008). The growth nudge and the pressure note are decisions of the
 * request pass (the vendored kernel's growth trigger and its once-per-turn gate; the pressure ladder's
 * band), which read state the view does not carry. The runtime hands each recipe those decisions as
 * `RequestSignals`, each rendered for the tools the stage chooses to name; a recipe written from scratch
 * reads the view alone. A stage names a tool only when the view says the session can call it, so a Fabric
 * child without `context_fold` gets no nudge naming it (pi-context-aware#458).
 *
 * The emergency truncation of the last ladder step still runs inside the request pass; it is not a plan.
 * The proactive compaction trigger stays in the host: the seeded-compaction stage offers the tool and
 * takes the compaction a plan source asks for (the model's `context_compact`, the host's threshold, Pi's
 * overflow), and wants nothing on a request.
 */

import { STRATEGY_CONTRACT_VERSION, type ContextView, type Recipe, type SayOp, type Stage } from "./contract.js";
import { methodSetId, type ContextMethod, type MethodSet } from "./methods.js";

export const FOLD_TOOL = "context_fold";
export const COMPACT_TOOL = "context_compact";

/** Which of the two context tools a message may name: those the view says the session can call. */
export interface ContextToolsInView {
	readonly fold: boolean;
	readonly compact: boolean;
}

export function contextToolsIn(view: ContextView): ContextToolsInView {
	return { fold: view.tools.includes(FOLD_TOOL), compact: view.tools.includes(COMPACT_TOOL) };
}

/** A message the request pass prepared, rendered for the tools a stage names; `undefined` when it has nothing to say with them. */
export interface RenderedSignal {
	render(tools: ContextToolsInView): string | undefined;
	/** The parts of a rendered text that quote the session (a fold's topic, a range line), which the plan checker sets aside. */
	quoted?(text: string): readonly string[];
}

/** What the request pass decided on this request, for the live stages that are built on it. */
export interface RequestSignals {
	/** The kernel's growth nudge after its once-per-turn gate and emergency deferral; absent when none is due. */
	readonly growthNudge?: RenderedSignal;
	/** The request's pressure action line at WARN or URGENT; absent at OK, with telemetry off, or when nothing counted the request. */
	readonly pressureLine?: RenderedSignal;
}

export const STAGE_IDS = {
	growthNudge: "growth-nudge",
	pressureNote: "pressure-note",
	modelFold: "model-fold",
	seededCompaction: "seeded-compaction",
} as const;

/** Stages that want nothing on a request without a signal: a request with no signal leaves them nothing to do. */
const SIGNAL_ONLY = new WeakSet<Stage>();

/**
 * True when no stage of the recipe can want anything on a request that carries no signal, so the runtime may
 * skip building the view for that request. The fold pass runs on every request; building a view costs about
 * 40% of the pass on a long session.
 */
export function wantsOnlyOnSignals(recipe: Recipe): boolean {
	return recipe.stages.every((stage) => SIGNAL_ONLY.has(stage));
}

/** A stage that says what a signal renders, naming only the tools the view can call. */
function signalStage(id: string, signal: (signals: RequestSignals) => RenderedSignal | undefined, signals: () => RequestSignals): Stage {
	const stage: Stage = {
		id,
		wants: () => (signal(signals()) ? "now" : null),
		plan: () => [],
		nudge: (view): SayOp | null => {
			const found = signal(signals());
			const text = found?.render(contextToolsIn(view));
			if (text === undefined || text.length === 0) return null;
			const quoted = found?.quoted?.(text) ?? [];
			return quoted.length > 0 ? { kind: "say", text, quoted } : { kind: "say", text };
		},
		offers: [],
	};
	SIGNAL_ONLY.add(stage);
	return stage;
}

/** The model's folds: `context_fold` calls are plans from the model, checked like any other; the stage plans nothing itself. */
const modelFold: Stage = { id: STAGE_IDS.modelFold, wants: () => null, plan: () => [], offers: [FOLD_TOOL] };

/** Seeded compaction: takes the compaction a plan source asks for; the stage wants nothing on a request. */
const seededCompaction: Stage = { id: STAGE_IDS.seededCompaction, wants: () => null, plan: () => [], offers: [COMPACT_TOOL] };
SIGNAL_ONLY.add(modelFold);
SIGNAL_ONLY.add(seededCompaction);

/** What one method brings to a composed recipe: stages that say something before the shared pressure note, and stages that offer its tool after it. */
interface MethodStages {
	readonly nudges: readonly Stage[];
	readonly tools: readonly Stage[];
}

function stagesOf(method: ContextMethod, signals: () => RequestSignals): MethodStages {
	switch (method) {
		case "fold": return { nudges: [signalStage(STAGE_IDS.growthNudge, (found) => found.growthNudge, signals)], tools: [modelFold] };
		case "compact": return { nudges: [], tools: [seededCompaction] };
	}
}

/**
 * The one recipe a session runs (pi-context-aware#526): every method's nudge stages in list order, then the pressure
 * note every method shares, then every method's tool stages in list order. The default list, fold then compact,
 * gives the stages folds-v1 ran (growth nudge, pressure note, model fold, seeded compaction); compact alone gives
 * those of compaction-only-v1 (pressure note, seeded compaction). The recipe's id is the set's id, `fold+compact`.
 */
export function composeRecipe(methods: MethodSet, signals: () => RequestSignals): Recipe {
	const parts = methods.map((method) => stagesOf(method, signals));
	return {
		id: methodSetId(methods),
		contractVersion: STRATEGY_CONTRACT_VERSION,
		stages: [
			...parts.flatMap((part) => part.nudges),
			signalStage(STAGE_IDS.pressureNote, (found) => found.pressureLine, signals),
			...parts.flatMap((part) => part.tools),
		],
	};
}

/** The tools a recipe's stages offer the model, once each, in stage order. */
export function offeredTools(recipe: Recipe): string[] {
	return [...new Set(recipe.stages.flatMap((stage) => stage.offers))];
}
