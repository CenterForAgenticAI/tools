/**
 * The strategy conformance suite (pi-context-aware#470, REQ-STRAT-001, REQ-STRAT-005): fixed views and the
 * properties every strategy's plans must have, in-process or out-of-process alike.
 *
 * - shape: every plan is an array of operations, each `summarize`, `stub` or `say` with exactly the
 *   contract's fields and types;
 * - ids: a `stub` names an entry of the view, a `summarize` an entry or an active fold's block id;
 * - tools: a `say` names no registered tool the session cannot call (`toolsNamedIn`, the reachable-tools rule);
 * - deterministic: a fresh instance given the same views gives the same plans;
 * - reply: the adapter refused none of the strategy's replies (an external strategy's timeouts, crashes
 *   and malformed replies).
 *
 * The suite asks each stage as the bench does (`wants`, then the nudge and plans until the stage plans
 * nothing or repeats itself) but applies nothing: each view is fixed. It does not run `checkPlan`; the
 * runtime's rules apply in the bench and live, whatever the strategy.
 */

import type { ContextPlan, ContextView, ViewEntry, ViewFold, ViewHide } from "../../strategy/contract.js";
import { toolsNamedIn } from "../check-plan.js";
import type { BenchRecipe, SessionFacts, StrategySpec } from "./recipes.js";

/** The tools a main session registers and can call in the views below. */
const MAIN_TOOLS = ["context_compact", "context_fold", "context_recall", "read"] as const;

export interface SyntheticViewSpec {
	/** Assistant tool calls, each answered by one `read` tool result: `a1`/`t1` to `aN`/`tN`. */
	readonly toolResults: number;
	/** Tokens of each tool result. */
	readonly resultTokens: number;
	readonly pressure: number;
	readonly contextWindow?: number;
	readonly modelId?: string;
	/** Tools the session can call now; every main tool by default. */
	readonly tools?: readonly string[];
	/** An active fold `b1` over entries before the tool calls, shown by carrier `c0`. */
	readonly fold?: boolean;
	/** The first this many tool results are already stubbed (hides `h1`, ...). */
	readonly hiddenResults?: number;
	/** Entries at the end the protected zone keeps; 4 by default. */
	readonly protectedTail?: number;
}

/**
 * A deep-frozen view of a session: the opening user message `u0`, an optional fold carrier `c0`, the tool
 * calls and results, and a closing `a-end`/`u-end` exchange. The opening message and the last
 * `protectedTail` entries are protected.
 */
export function syntheticView(spec: SyntheticViewSpec): ContextView {
	const window = spec.contextWindow ?? 200_000;
	const hidden = spec.hiddenResults ?? 0;
	const entries: ViewEntry[] = [{ id: "u0", role: "user", tokens: 50, hint: null }];
	const folds: ViewFold[] = [];
	if (spec.fold) {
		entries.push({ id: "c0", role: "assistant", tokens: 400, hint: null });
		folds.push({ blockId: "b1", tier: 1, topic: "setup", carrierId: "c0", hiddenIds: ["x1", "x2"], startId: "c0", endId: "x2", compressedTokens: 400 });
	}
	const hides: ViewHide[] = [];
	for (let i = 1; i <= spec.toolResults; i++) {
		entries.push({ id: `a${i}`, role: "assistant", tokens: 100, hint: null, toolCallIds: [`call-${i}`] });
		entries.push({ id: `t${i}`, role: "toolResult", tokens: i <= hidden ? 30 : spec.resultTokens, hint: null, toolName: "read", toolCallId: `call-${i}` });
		if (i <= hidden) hides.push({ hideId: `h${i}`, targetId: `t${i}`, originalTokens: spec.resultTokens });
	}
	entries.push({ id: "a-end", role: "assistant", tokens: 200, hint: null }, { id: "u-end", role: "user", tokens: 50, hint: null });
	const tail = new Set(entries.slice(Math.max(0, entries.length - (spec.protectedTail ?? 4))).map((entry) => entry.id));
	const total = Math.round(spec.pressure * window);
	return deepFreeze({
		entries,
		pressure: spec.pressure,
		unownedTokens: total - entries.reduce((sum, entry) => sum + entry.tokens, 0),
		cacheAgeMs: 60_000,
		model: { id: spec.modelId ?? "conformance-model", contextWindow: window },
		tools: [...(spec.tools ?? MAIN_TOOLS)].sort(),
		registeredTools: [...new Set([...MAIN_TOOLS, ...(spec.tools ?? [])])].sort(),
		folds,
		hides,
		protectedEntryIds: entries.filter((entry) => entry.id === "u0" || tail.has(entry.id)).map((entry) => entry.id),
		compactionOwner: "none",
	});
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
	return value;
}

/** One session of the suite: views in request order, given to one fresh instance of the strategy. */
export interface ConformanceScenario {
	readonly name: string;
	readonly views: readonly ContextView[];
}

/**
 * The suite's fixed views: a main session growing past the nudge, a main session near full with a fold
 * and stubbed results, a Fabric worker session whose context tools are registered but not callable, and a
 * session with nothing to manage.
 */
export function conformanceScenarios(): ConformanceScenario[] {
	const growing = syntheticView({ toolResults: 10, resultTokens: 6_000, pressure: 0.5 });
	return [
		{ name: "main-growing", views: [growing, growing] },
		{ name: "main-full", views: [syntheticView({ toolResults: 12, resultTokens: 12_000, pressure: 0.93, fold: true, hiddenResults: 2 })] },
		{ name: "worker", views: [syntheticView({ toolResults: 8, resultTokens: 8_000, pressure: 0.6, tools: [] })] },
		{ name: "small", views: [syntheticView({ toolResults: 0, resultTokens: 0, pressure: 0.01 })] },
	];
}

export type ConformanceProperty = "shape" | "ids" | "tools" | "deterministic" | "reply";

export interface ConformanceFinding {
	readonly scenario: string;
	/** Index of the view in the scenario. */
	readonly request: number;
	readonly property: ConformanceProperty;
	/** One line, written by the suite; a value the strategy wrote is quoted, cut to 64 characters. */
	readonly detail: string;
}

export interface ConformanceResult {
	readonly id: string;
	readonly requests: number;
	readonly plans: number;
	readonly ops: { readonly summarize: number; readonly stub: number; readonly say: number };
	readonly findings: readonly ConformanceFinding[];
}

/** A strategy under test: a fresh instance per scenario. */
export interface ConformanceSubject {
	readonly id: string;
	readonly build: () => BenchRecipe;
}

/** What a bench strategy may know besides the view, in the suite: nothing recorded (no folds, no tool output), the corpus fallback summary sizes. */
const SUITE_FACTS: SessionFacts = Object.freeze({ recordedFolds: [], foldSummaryChars: 2_000, compactionSummaryChars: 8_000, toolOutput: () => undefined });

/** A bench strategy as a subject of the suite. */
export function conformanceSubject(spec: StrategySpec): ConformanceSubject {
	return { id: spec.id, build: () => spec.build(SUITE_FACTS) };
}

/** Plans one stage may make on one view; the bench's own cap. */
const MAX_PLANS_PER_STAGE = 64;

interface Asked {
	readonly plans: readonly ContextPlan[];
	readonly refusals: readonly string[];
}

/** Ask every stage of a fresh instance about each view of a scenario, as the bench does, applying nothing. */
function ask(subject: ConformanceSubject, scenario: ConformanceScenario): Asked[] {
	const bench = subject.build();
	return scenario.views.map((view) => {
		const plans: ContextPlan[] = [];
		for (const stage of bench.recipe.stages) {
			if (stage.wants(view) === null) continue;
			// A queued stage (an external reply) hands over every plan it holds, as the bench takes them.
			const queued = () => bench.queuedPlans?.(stage.id);
			const draining = queued() !== undefined;
			let previous = "";
			for (let round = 0; round < MAX_PLANS_PER_STAGE && (!draining || queued()! > 0); round++) {
				const nudge = round === 0 ? stage.nudge?.(view) ?? null : null;
				const plan: ContextPlan = nudge ? [...stage.plan(view), nudge] : stage.plan(view);
				const key = JSON.stringify(plan);
				if (draining && Array.isArray(plan) && plan.length === 0) continue;
				if (!Array.isArray(plan) || plan.length === 0 || (!draining && key === previous)) break;
				previous = key;
				plans.push(plan);
			}
		}
		return { plans, refusals: [...(bench.takeRefusals?.() ?? [])] };
	});
}

/** A value the strategy wrote, safe for one line of a terminal: printable ASCII, at most 64 characters, cut visibly. */
function shown(value: unknown): string {
	const text = String(value).replace(/[^\x20-\x7e]/gu, "?");
	return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}...(cut)` : text);
}

const KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
	summarize: new Set(["kind", "startId", "endId", "topic", "writer", "summary"]),
	stub: new Set(["kind", "entryId", "text"]),
	say: new Set(["kind", "text"]),
};
const WRITERS: ReadonlySet<unknown> = new Set(["plan", "main", "cheap", "mechanical"]);
const isId = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** What is wrong with one operation's shape; empty when nothing is. */
function shapeProblems(op: unknown): string[] {
	if (typeof op !== "object" || op === null || Array.isArray(op)) return ["an operation is not an object"];
	const fields = op as Record<string, unknown>;
	const allowed = typeof fields.kind === "string" ? KEYS[fields.kind] : undefined;
	if (allowed === undefined) return [`kind ${shown(fields.kind)} is not summarize, stub or say`];
	const problems = Object.keys(fields).filter((key) => !allowed.has(key)).map((key) => `a ${fields.kind} carries field ${shown(key)}`);
	if (fields.kind === "say" && typeof fields.text !== "string") problems.push("a say has no text");
	if (fields.kind === "stub") {
		if (!isId(fields.entryId)) problems.push("a stub has no entryId");
		if (typeof fields.text !== "string") problems.push("a stub has no text");
	}
	if (fields.kind === "summarize") {
		if (!isId(fields.startId) || !isId(fields.endId)) problems.push("a summarize lacks startId or endId");
		if (fields.topic !== undefined && typeof fields.topic !== "string") problems.push("a summarize topic is not text");
		if (!WRITERS.has(fields.writer)) problems.push(`writer ${shown(fields.writer)} is not plan, main, cheap or mechanical`);
		else if (fields.writer === "plan" ? typeof fields.summary !== "string" : fields.summary !== undefined) problems.push("a summarize carries a summary exactly when its writer is plan");
	}
	return problems;
}

/** Every finding for one view's plans. */
function viewFindings(view: ContextView, asked: Asked, scenario: string, request: number): ConformanceFinding[] {
	const findings: ConformanceFinding[] = [];
	const find = (property: ConformanceProperty, detail: string) => findings.push({ scenario, request, property, detail });
	for (const code of asked.refusals) find("reply", `the adapter refused the strategy's reply: ${shown(code)}`);
	const entryIds = new Set(view.entries.map((entry) => entry.id));
	const endIds = new Set([...entryIds, ...view.folds.map((fold) => fold.blockId)]);
	const reachable = new Set(view.tools);
	asked.plans.forEach((plan, p) => {
		if (!Array.isArray(plan)) {
			find("shape", `plan ${p} is not an array`);
			return;
		}
		plan.forEach((op: unknown, o) => {
			const at = `plan ${p} operation ${o}`;
			const problems = shapeProblems(op);
			for (const problem of problems) find("shape", `${at}: ${problem}`);
			if (problems.length > 0) return;
			const checked = op as ContextPlan[number];
			if (checked.kind === "stub" && !entryIds.has(checked.entryId)) find("ids", `${at}: stub names ${shown(checked.entryId)}, which the view does not hold`);
			if (checked.kind === "summarize") {
				for (const id of [checked.startId, checked.endId]) if (!endIds.has(id)) find("ids", `${at}: summarize names ${shown(id)}, which the view does not hold`);
			}
			if (checked.kind === "say") {
				const unreachable = toolsNamedIn(checked.text, view.registeredTools).filter((name) => !reachable.has(name));
				if (unreachable.length > 0) find("tools", `${at}: say names ${unreachable.map(shown).join(", ")}, which the session cannot call`);
			}
		});
	});
	return findings;
}

/** Run the suite against one strategy: every scenario twice, each time on a fresh instance. */
export function runConformance(subject: ConformanceSubject, scenarios: readonly ConformanceScenario[] = conformanceScenarios()): ConformanceResult {
	const findings: ConformanceFinding[] = [];
	const ops = { summarize: 0, stub: 0, say: 0 };
	let requests = 0;
	let plans = 0;
	for (const scenario of scenarios) {
		const first = ask(subject, scenario);
		const second = ask(subject, scenario);
		first.forEach((asked, request) => {
			requests++;
			plans += asked.plans.length;
			for (const plan of asked.plans) {
				if (!Array.isArray(plan)) continue;
				for (const op of plan as readonly unknown[]) {
					const kind = typeof op === "object" && op !== null ? (op as { kind?: unknown }).kind : undefined;
					if (kind === "summarize" || kind === "stub" || kind === "say") ops[kind]++;
				}
			}
			findings.push(...viewFindings(scenario.views[request]!, asked, scenario.name, request));
			if (JSON.stringify(asked) !== JSON.stringify(second[request])) findings.push({ scenario: scenario.name, request, property: "deterministic", detail: "a fresh instance given the same views planned differently" });
		});
	}
	return { id: subject.id, requests, plans, ops, findings };
}
