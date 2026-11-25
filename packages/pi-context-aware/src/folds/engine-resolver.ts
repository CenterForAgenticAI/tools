/**
 * The one place that names the context engine in use (pi-context-aware#309) and the context methods a session runs
 * (pi-context-aware#526).
 *
 * Internal: no package entry point re-exports it. The fold engine, the context tool
 * surface and the recall surface read the answer here instead of each asking
 * whether billion-context-pi is loaded.
 *
 * Order: an explicit override (`folds.engine`: `folds` or `compaction-only`) first; then
 * billion-context-pi presence, which gives `compaction-only` with the native folds in
 * shadow; otherwise `folds`. `detectCompactionBlocker` is a different question (is a
 * loaded extension cancelling compaction) and does not read this.
 */

import { isBillionContextPiLoaded, type RegisteredToolView } from "../compaction/compaction-blocker.js";
import { oneLine } from "./fold-hints.js";
import { DEFAULT_GUIDANCE, GUIDANCE_VARIANTS, isGuidanceVariant, type GuidanceVariant } from "../strategy/guidance.js";
import { CONTEXT_METHODS, DEFAULT_METHODS, hasMethod, isContextMethod, methodSetId, toMethodSet, type ContextMethod, type MethodSet } from "../strategy/methods.js";
import { ASSIGNMENT_SEED, drawFrom, isAssignableSessionId, MAX_ASSIGNMENT_VARIANTS, RETIRED_ASSIGNMENT_ENTRY_TYPES, type RecordedAssignment } from "../strategy-runtime/live/assignment.js";

export type ContextEngine = "folds" | "compaction-only";
export type ContextEngineOverride = "auto" | "folds" | "compaction-only";

export const CONTEXT_ENGINE_OVERRIDES: readonly ContextEngineOverride[] = ["auto", "folds", "compaction-only"];

export interface ContextEngineInput {
	readonly tools: readonly RegisteredToolView[];
	readonly override?: ContextEngineOverride;
}

export function resolveContextEngine({ tools, override = "auto" }: ContextEngineInput): ContextEngine {
	if (override !== "auto") return override;
	return isBillionContextPiLoaded(tools) ? "compaction-only" : "folds";
}

/** True when an override forces `folds` although billion-context-pi is loaded. */
export function engineOverrideContradictsPresence({ tools, override = "auto" }: ContextEngineInput): boolean {
	return override === "folds" && isBillionContextPiLoaded(tools);
}

/**
 * Where the session's methods came from: `strategy.methods`, `folds.engine`, or the auto rule (billion-context-pi
 * presence, else the default). An assignment (`strategy.assign`) is never a source: it draws guidance, not methods.
 */
export type MethodsSource = "strategy.methods" | "folds.engine" | "auto";
export const METHODS_SOURCES: readonly MethodsSource[] = ["strategy.methods", "folds.engine", "auto"];

/** The removed settings the resolver names (pi-context-aware#526); see `REMOVED_CONFIG_PATHS`. */
export type RemovedStrategySetting = "strategy.recipe" | "strategy.assign.recipes";
const REMOVED_SETTINGS: readonly RemovedStrategySetting[] = ["strategy.recipe", "strategy.assign.recipes"];

/** The strategy settings as the config layers resolve them, and the session they are for. */
export interface StrategySettings {
	/** `strategy.methods` as written: `auto`, unset, or a list of names; unknown names are reported. */
	readonly methods?: "auto" | readonly string[];
	/** `strategy.shadow`: method lists that run beside the session's methods, checked and recorded, never applied. */
	readonly shadow?: readonly (readonly string[])[];
	/** `folds.engine`, read only while `strategy.methods` is unset or `auto`. */
	readonly engine?: ContextEngineOverride;
	/** `strategy.assign`: the guidance variants a new session's guidance is drawn from, and the seed. */
	readonly assign?: { readonly guidance: readonly string[]; readonly seed: string };
	/** Paths a config layer rejected or that were removed (`REMOVED_CONFIG_PATHS`); the strategy ones are reported. */
	readonly rejected?: readonly string[];
	/**
	 * The session: its id, whether it is new (no message on its branch yet, so a draw may choose its guidance), the
	 * assignment recorded on its branch, if any, and how many retired assignment entries the branch holds.
	 */
	readonly session?: { readonly id: string; readonly fresh: boolean; readonly recorded: RecordedAssignment | null; readonly retired?: number };
}

/** What is wrong with a method list: a name no method has, a method listed twice, or no method. */
export type MethodListProblem = { readonly problem: "unknown"; readonly id: string } | { readonly problem: "repeated"; readonly id: string } | { readonly problem: "empty" };

/**
 * A strategy setting the session cannot use. `id` is a raw value; `strategyErrorLines` makes it safe to show.
 * `invalid` is a value a config layer rejected; `removed` a setting that no longer exists.
 */
export type StrategySettingError =
	| ({ readonly setting: "strategy.methods" } & MethodListProblem)
	| ({ readonly setting: "strategy.shadow"; readonly entry: number } & MethodListProblem)
	| { readonly setting: "strategy.methods" | "strategy.shadow" | "strategy.assign.guidance"; readonly problem: "invalid" }
	| { readonly setting: RemovedStrategySetting; readonly problem: "removed" }
	| { readonly setting: "strategy.assign.guidance"; readonly problem: "unknown"; readonly id: string }
	| { readonly setting: "strategy.assign.guidance"; readonly problem: "too-many"; readonly count: number }
	| { readonly setting: "strategy.assign.seed"; readonly problem: "missing" };

/** A session's assignment: the draw that chose its guidance, and whether the session records it. */
export interface SessionAssignment {
	readonly seed: string;
	readonly variants: readonly GuidanceVariant[];
	readonly drawnFor: string;
	/** True when read from the session's entry; false for a draw the session has not recorded yet. */
	readonly recorded: boolean;
}

/** What a session runs (REQ-STRAT-007): its methods, composed into one recipe, the lists beside them in shadow, and its guidance. */
export interface SessionStrategy {
	readonly methods: MethodSet;
	readonly source: MethodsSource;
	/** Valid method lists, once each, never the session's own. */
	readonly shadow: readonly MethodSet[];
	readonly guidance: GuidanceVariant;
	/** A setting lists `fold` while billion-context-pi is loaded. */
	readonly contradictsPresence: boolean;
	readonly errors: readonly StrategySettingError[];
	/** Set only when `strategy.assign` drew the session's guidance. */
	readonly assignment?: SessionAssignment;
	/** Retired assignment entries on the branch, each ignored; set only when there is one. */
	readonly retiredAssignments?: number;
}

/** `folds.engine` values as method sets: the released setting keeps working while `strategy.methods` is unset. */
const ENGINE_METHODS: Readonly<Record<ContextEngine, MethodSet>> = { "folds": DEFAULT_METHODS, "compaction-only": toMethodSet(["compact"])! };

/** The list as a method set, or every problem it has. */
function checkMethodList(list: readonly string[]): { readonly set: MethodSet } | { readonly problems: readonly MethodListProblem[] } {
	if (list.length === 0) return { problems: [{ problem: "empty" }] };
	const problems: MethodListProblem[] = [];
	const known: ContextMethod[] = [];
	const reported = new Set<string>();
	for (const name of list) {
		if (!isContextMethod(name)) problems.push({ problem: "unknown", id: name });
		else if (known.includes(name)) {
			if (!reported.has(name)) problems.push({ problem: "repeated", id: name });
			reported.add(name);
		} else known.push(name);
	}
	const set = problems.length === 0 ? toMethodSet(known) : null;
	return set ? { set } : { problems };
}

/**
 * The session's strategy. Methods: `strategy.methods` when it is a valid list; else `folds.engine` when it is not
 * `auto`; else `compact` alone while billion-context-pi is loaded, and both methods otherwise. A `strategy.methods`
 * that is not a valid list is an error, and the session runs what the rest of the order chooses. Shadow lists that
 * are not valid are errors and are skipped. A value one config layer rejects is an error and is skipped; a valid
 * value another layer supplies still applies (CR-REJECTED-ANY-LAYER).
 *
 * Guidance: the assignment recorded on the session's branch; else, for a new session, the variant `strategy.assign`
 * draws; else the default. An assignment never changes the methods.
 */
export function resolveSessionStrategy({ tools, settings }: { readonly tools: readonly RegisteredToolView[]; readonly settings: StrategySettings }): SessionStrategy {
	const errors: StrategySettingError[] = [];
	const rejected = settings.rejected ?? [];
	for (const removed of REMOVED_SETTINGS) if (rejected.includes(removed)) errors.push({ setting: removed, problem: "removed" });

	let methods: MethodSet | undefined;
	let source: MethodsSource = "auto";
	const asked = settings.methods ?? "auto";
	// A value one layer rejected is reported and skipped; `asked` is then the next layer's valid value, if any (CR-REJECTED-ANY-LAYER).
	if (rejected.includes("strategy.methods")) errors.push({ setting: "strategy.methods", problem: "invalid" });
	if (asked !== "auto") {
		const checked = checkMethodList(asked);
		if ("set" in checked) [methods, source] = [checked.set, "strategy.methods"];
		else for (const problem of checked.problems) errors.push({ setting: "strategy.methods", ...problem });
	}
	if (methods === undefined) {
		const override = settings.engine ?? "auto";
		if (override !== "auto") [methods, source] = [ENGINE_METHODS[override], "folds.engine"];
		else methods = ENGINE_METHODS[resolveContextEngine({ tools })];
	}
	const active = methods;

	const shadow: MethodSet[] = [];
	if (rejected.includes("strategy.shadow")) errors.push({ setting: "strategy.shadow", problem: "invalid" });
	(settings.shadow ?? []).forEach((list, index) => {
		const checked = checkMethodList(list);
		if (!("set" in checked)) {
			for (const problem of checked.problems) errors.push({ setting: "strategy.shadow", entry: index + 1, ...problem });
			return;
		}
		const id = methodSetId(checked.set);
		if (id !== methodSetId(active) && !shadow.some((other) => methodSetId(other) === id)) shadow.push(checked.set);
	});

	const { guidance, assignment } = resolveGuidance(settings, rejected, errors);
	const retired = settings.session?.retired ?? 0;
	return {
		methods: active,
		source,
		shadow,
		guidance,
		contradictsPresence: source !== "auto" && hasMethod(active, "fold") && isBillionContextPiLoaded(tools),
		errors,
		...(assignment ? { assignment } : {}),
		...(retired > 0 ? { retiredAssignments: retired } : {}),
	};
}

/** The session's guidance and the assignment that chose it; appends the `strategy.assign` errors. */
function resolveGuidance(settings: StrategySettings, rejected: readonly string[], errors: StrategySettingError[]): { readonly guidance: GuidanceVariant; readonly assignment?: SessionAssignment } {
	if (rejected.includes("strategy.assign.guidance")) errors.push({ setting: "strategy.assign.guidance", problem: "invalid" });
	const listed = settings.assign?.guidance ?? [];
	const drawable: GuidanceVariant[] = [];
	// The cap the recorded entry is read back with: a longer list would draw an entry the session cannot read,
	// so it is an error and draws nothing.
	if (listed.length > MAX_ASSIGNMENT_VARIANTS) errors.push({ setting: "strategy.assign.guidance", problem: "too-many", count: listed.length });
	else for (const candidate of listed) {
		if (isGuidanceVariant(candidate)) drawable.push(candidate);
		else errors.push({ setting: "strategy.assign.guidance", problem: "unknown", id: candidate });
	}
	const seed = settings.assign?.seed ?? "";
	const seeded = ASSIGNMENT_SEED.test(seed);
	if (drawable.length > 0 && !seeded) errors.push({ setting: "strategy.assign.seed", problem: "missing" });
	const session = settings.session;
	const recorded = session?.recorded ?? null;
	if (recorded) return { guidance: recorded.guidance, assignment: { seed: recorded.seed, variants: recorded.variants, drawnFor: recorded.drawnFor, recorded: true } };
	// Draw only for a session id the entry can carry and read back, so a resume keeps the guidance it ran.
	if (session?.fresh && drawable.length > 0 && seeded && isAssignableSessionId(session.id)) {
		return { guidance: drawFrom(seed, drawable, session.id), assignment: { seed, variants: drawable, drawnFor: session.id, recorded: false } };
	}
	return { guidance: DEFAULT_GUIDANCE };
}

/** Characters of an unknown id an error line shows; longer ids are clipped with a visible marker. */
const MAX_SHOWN_ID_CHARS = 64;
/** Errors named one by one per setting; the rest are counted on one line. */
const MAX_LISTED_ERRORS = 3;

/** How a session's methods read in a line: `fold, compact (the default)`. */
export function describeMethods(strategy: Pick<SessionStrategy, "methods" | "source">): string {
	// The auto rule leaves fold out only while billion-context-pi is loaded.
	const why = strategy.source !== "auto" ? `from ${strategy.source}` : hasMethod(strategy.methods, "fold") ? "the default" : "billion-context-pi is loaded";
	return `${strategy.methods.join(", ")} (${why})`;
}

/**
 * One line per strategy setting error, to show an operator (`session_start`) and the model (`context_status`).
 * An id is a setting's raw value: it is made one line with control and format characters removed, and clipped, so
 * a hostile or careless value cannot forge a line, send an escape sequence or grow without bound. Each line starts
 * with its label, and each setting lists at most three errors, then counts the rest.
 */
export function strategyErrorLines(strategy: SessionStrategy): string[] {
	const known = CONTEXT_METHODS.join(", ");
	const variants = GUIDANCE_VARIANTS.join(", ");
	const shown = (id: string) => `"${oneLine(id, MAX_SHOWN_ID_CHARS)}"`;
	const lines: string[] = [];
	const listed = (setting: StrategySettingError["setting"], line: (error: StrategySettingError) => string): number => {
		const errors = strategy.errors.filter((error) => error.setting === setting);
		for (const error of errors.slice(0, MAX_LISTED_ERRORS)) lines.push(line(error));
		if (errors.length > MAX_LISTED_ERRORS) lines.push(`Error: ${setting} has ${errors.length - MAX_LISTED_ERRORS} more problems.`);
		return errors.length;
	};
	if (strategy.errors.some((error) => error.setting === "strategy.recipe")) lines.push("Error: strategy.recipe was removed and is ignored. List the methods a session runs in strategy.methods, such as [\"fold\", \"compact\"].");
	if (strategy.errors.some((error) => error.setting === "strategy.assign.recipes")) lines.push(`Error: strategy.assign.recipes was removed and is ignored: methods are never drawn. strategy.assign.guidance lists guidance variants (known: ${variants}).`);
	const methodErrors = listed("strategy.methods", (error) =>
		error.problem === "unknown" ? `Error: strategy.methods names an unknown method, ${shown(error.id)}. Known methods: ${known}.`
		: error.problem === "repeated" ? `Error: strategy.methods lists ${shown(error.id)} more than once. Known methods: ${known}.`
		: error.problem === "empty" ? `Error: strategy.methods is empty. List at least one of: ${known}.`
		: `Error: a config layer sets strategy.methods to something that is not a list of method names, such as ["fold", "compact"]. Known methods: ${known}. That value is skipped.`);
	// A rejected layer value alone does not discard a valid list another layer supplies (CR-REJECTED-ANY-LAYER).
	if (methodErrors > 0 && strategy.source !== "strategy.methods") lines.push(`Error: strategy.methods is ignored. This session runs ${describeMethods(strategy)} instead.`);
	listed("strategy.shadow", (error) => {
		if (error.setting !== "strategy.shadow" || error.problem === "invalid") return `Error: a config layer sets strategy.shadow to something that is not a list of method lists, such as [["compact"]]. Known methods: ${known}. That value is skipped.`;
		const entry = `Error: strategy.shadow entry ${error.entry}`;
		return error.problem === "unknown" ? `${entry} names an unknown method, ${shown(error.id)}. Known methods: ${known}. It does not run in shadow.`
			: error.problem === "repeated" ? `${entry} lists ${shown(error.id)} more than once. Known methods: ${known}. It does not run in shadow.`
			: `${entry} is empty. Known methods: ${known}. It does not run in shadow.`;
	});
	listed("strategy.assign.guidance", (error) =>
		error.problem === "unknown" ? `Error: strategy.assign.guidance names an unknown guidance variant, ${shown(error.id)}. Known variants: ${variants}. It is not drawn.`
		: error.problem === "too-many" ? `Error: strategy.assign.guidance lists ${error.count} ids; at most ${MAX_ASSIGNMENT_VARIANTS} are allowed. No guidance is drawn.`
		: `Error: strategy.assign.guidance is not a list of guidance variant ids (known: ${variants}). No guidance is drawn.`);
	if (strategy.errors.some((error) => error.setting === "strategy.assign.seed")) lines.push("Error: strategy.assign.guidance is set without strategy.assign.seed. No guidance is drawn.");
	return lines;
}

/** Debug notes about the session's strategy that are not errors: retired assignment entries it ignored. */
export function strategyDebugLines(strategy: SessionStrategy): string[] {
	const retired = strategy.retiredAssignments ?? 0;
	return retired > 0 ? [`strategy: ignored ${retired} recipe assignment entries of the first version (${RETIRED_ASSIGNMENT_ENTRY_TYPES.join(", ")}); methods are never drawn.`] : [];
}

/** The engine a session's methods run: the native folds write only when `fold` is among them. */
export function engineOfMethods(methods: readonly ContextMethod[]): ContextEngine {
	return hasMethod(methods, "fold") ? "folds" : "compaction-only";
}

/** The fold engine's mode for an engine: the native folds write only when they are the engine. */
export function foldModeForEngine(engine: ContextEngine): "live" | "shadow" {
	return engine === "folds" ? "live" : "shadow";
}
