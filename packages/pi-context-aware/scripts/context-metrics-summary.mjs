#!/usr/bin/env node
// Summarise per-turn context metrics (pi-context-aware#286), per session and per strategy (pi-context-aware#473): a
// strategy is the set of methods a session ran (pi-context-aware#526), such as `fold+compact`.
// Usage: node scripts/context-metrics-summary.mjs [--json] [--guardrails-only] [--source <source>]... [--min-turns <n>]
//   [--iterations <n>] [--seed <n>] [--store <host>=<metrics-dir | file.jsonl>]... [<metrics-dir | file.jsonl>]...
// A path given without --store is labelled with the host `local`.
// A directory is read for its *.jsonl files. A truncated last line, records of an unknown version and records
// whose session id is not a session id are skipped. Version 1 records carry no strategy: they count as
// fold+compact from the source `legacy`. Version 2 records name a recipe: `folds-v1` counts as fold+compact and
// `compaction-only-v1` as compact. `--source` keeps only the records of the sources it names.
// Every id and code read from a record is untrusted: one that does not match its pattern is shown as `other`,
// and lists are cut at a fixed length with a visible marker, so a record cannot forge or flood a line. Method sets
// past the first 64 count under `other`, 8 strategy blocks are printed, and the printed text is cut at a fixed size.
// The arms (pi-context-aware#459): each session, per host, is one unit, grouped by its guidance and its majority model.
// `--guardrails-only` prints the guardrails alone, so a weekly check sees no other difference between the arms.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCES = ["strategy.methods", "folds.engine", "auto", "strategy.recipe", "strategy.assign", "legacy", "other"];
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u;
/** Recipe ids, codes and stage names: lower-case words joined by `-`, `.` or `/`; anything else is `other`. */
const NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
/** A method name: a lower-case word, `-` joined; a method set is up to 8 of them, none twice, joined with `+`. */
const METHOD = /^[a-z][a-z0-9-]{0,31}$/u;
const MAX_METHODS = 8;
/** The recipes version 2 records name, as the method sets they ran. */
const V2_RECIPES = new Map([["folds-v1", "fold+compact"], ["compaction-only-v1", "compact"]]);
/** Distinct keys one count map holds; the rest go under `other`. */
const MAX_KEYS = 64;
/** Codes and stage outcomes listed per line; the rest are counted behind a marker. */
const MAX_LISTED = 16;
/** Sessions listed one by one; the rest are counted behind a marker. */
const MAX_LISTED_SESSIONS = 100;
/** Method sets that get a row of their own; later sets are counted under `other`. */
const MAX_STRATEGY_ROWS = 64;
/** Strategy blocks printed, most turns first; the rest are counted behind a marker. */
const MAX_LISTED_STRATEGIES = 8;
/** Characters the printed summary holds; the rest is cut at a line end behind a marker. */
const MAX_OUTPUT_CHARS = 131072;

const name = (value) => (typeof value === "string" && NAME.test(value) ? value : "other");
const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function parseMetrics(text) {
	const records = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		let record;
		try { record = JSON.parse(line); } catch { continue; }
		if (record && (record.v === 1 || record.v === 2 || record.v === 3 || record.v === 4) && typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId)) records.push(record);
	}
	return records;
}

/** A list of method names as a set id, or `other` when it is not a set: empty, too long, a bad name, a name twice. */
function methodSet(list) {
	if (!Array.isArray(list) || list.length === 0 || list.length > MAX_METHODS) return "other";
	if (!list.every((method) => typeof method === "string" && METHOD.test(method)) || new Set(list).size !== list.length) return "other";
	return list.join("+");
}

/** The method set a recipe id names: a version 2 recipe id, or a version 3 set id such as `fold+compact`. */
function recipeSet(record, recipe) {
	if (record.v === 2) return V2_RECIPES.get(recipe) ?? name(recipe);
	return typeof recipe === "string" ? methodSet(recipe.split("+")) : "other";
}

/**
 * The strategy a record names (pi-context-aware#473, pi-context-aware#526): its method set, source and guidance.
 * Version 1 records are fold+compact from `legacy`; versions 1 and 2 ran the default guidance.
 */
export function strategyOf(record) {
	if (record.v === 1) return { methods: "fold+compact", source: "legacy", guidance: "default" };
	const strategy = record.strategy && typeof record.strategy === "object" ? record.strategy : null;
	if (!strategy) return { methods: "unknown", source: "other", guidance: "other" };
	const source = SOURCES.includes(strategy.source) && strategy.source !== "legacy" ? strategy.source : "other";
	if (record.v === 2) return { methods: recipeSet(record, strategy.recipe), source, guidance: "default" };
	return { methods: methodSet(strategy.methods), source, guidance: name(strategy.guidance) };
}

const add = (into, key, n) => {
	const slot = key in into || Object.keys(into).length < MAX_KEYS ? key : "other";
	into[slot] = (into[slot] ?? 0) + n;
};
const counts = (source) => (source && typeof source === "object" && !Array.isArray(source) ? Object.entries(source) : []);

function emptyRow(strategy) {
	return {
		strategy, sessions: 0, sources: {}, guidance: {}, requests: 0, pricedTurns: 0, unpricedTurns: 0, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		folds: 0, requested: 0, compactions: 0, emergencies: 0, foldRefusals: {}, planRefusals: {}, shadowRefusals: {}, stages: {}, stagesOmitted: 0, recalls: { folds: 0, hides: 0, records: 0 },
	};
}

/**
 * Per session (the original summary) and per strategy. `price(modelId, usage)` gives a request's dollars, or null
 * when the model has no price; without it nothing is priced. `sources` keeps only those sources' records.
 */
export function summarise(records, { price, sources } = {}) {
	const kept = sources ? records.filter((record) => sources.includes(strategyOf(record).source)) : records;
	const sessions = new Map();
	const rows = new Map();
	const seen = new Map();
	/** Method sets past MAX_STRATEGY_ROWS, counted under `other`. */
	const folded = new Set();
	for (const record of kept) {
		let s = sessions.get(record.sessionId);
		if (!s) sessions.set(record.sessionId, s = { sessionId: record.sessionId, requests: 0, folds: 0, requested: 0, refused: {}, dropped: {}, compactions: 0, foldPressures: [], input: 0, cacheRead: 0, cacheWrite: 0 });
		s.requests += 1;
		const folds = record.folds ?? {};
		s.requested += num(folds.requested);
		s.folds += num(folds.accepted);
		for (const [code, n] of counts(folds.refused)) add(s.refused, name(code), num(n));
		for (const [code, n] of counts(folds.dropped)) add(s.dropped, name(code), num(n));
		if (num(folds.accepted) > 0 && typeof record.pressure === "number") s.foldPressures.push(record.pressure);
		if (record.compaction) s.compactions += 1;
		const usage = record.usage && typeof record.usage === "object" ? record.usage : null;
		if (usage) {
			s.input += num(usage.input);
			s.cacheRead += num(usage.cacheRead);
			s.cacheWrite += num(usage.cacheWrite);
		}

		const { methods: named, source, guidance } = strategyOf(record);
		const methods = rows.has(named) || rows.size < MAX_STRATEGY_ROWS ? named : "other";
		if (methods !== named) folded.add(named);
		let row = rows.get(methods);
		if (!row) rows.set(methods, row = emptyRow(methods));
		const sessionKey = `${methods}\n${record.sessionId}`;
		if (!seen.has(sessionKey)) {
			seen.set(sessionKey, true);
			row.sessions += 1;
			add(row.sources, source, 1);
			add(row.guidance, guidance, 1);
		}
		row.requests += 1;
		row.folds += num(folds.accepted);
		row.requested += num(folds.requested);
		if (record.compaction) row.compactions += 1;
		if (record.emergency) row.emergencies += 1;
		for (const [code, n] of counts(folds.refused)) add(row.foldRefusals, name(code), num(n));
		if (usage) {
			const tokens = { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite) };
			for (const key of Object.keys(tokens)) row.tokens[key] += tokens[key];
			const dollars = price ? price(typeof record.modelId === "string" ? record.modelId : "", tokens) : null;
			if (typeof dollars === "number" && Number.isFinite(dollars)) { row.cost += dollars; row.pricedTurns += 1; } else row.unpricedTurns += 1;
		}
		for (const stage of Array.isArray(record.stages) ? record.stages : []) {
			if (!stage || typeof stage !== "object") continue;
			const role = stage.role === "shadow" ? "shadow" : stage.role === "active" ? "active" : "other";
			const outcome = name(stage.outcome);
			add(row.stages, `${role} ${recipeSet(record, stage.recipe)}/${name(stage.stage)} ${outcome}`, 1);
			if (outcome !== "refused") continue;
			for (const code of Array.isArray(stage.codes) ? stage.codes : []) add(role === "shadow" ? row.shadowRefusals : row.planRefusals, name(code), 1);
		}
		row.stagesOmitted += num(record.stagesOmitted);
		if (record.recalls && typeof record.recalls === "object") {
			row.recalls.folds += num(record.recalls.folds);
			row.recalls.hides += num(record.recalls.hides);
			row.recalls.records += 1;
		}
	}
	const list = [...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((s) => {
		const prompt = s.input + s.cacheRead + s.cacheWrite;
		return { ...s, cacheReadShare: prompt > 0 ? s.cacheRead / prompt : null };
	});
	const total = { sessions: list.length, requests: 0, folds: 0, requested: 0, refused: {}, dropped: {}, compactions: 0, foldPressures: [], input: 0, cacheRead: 0, cacheWrite: 0 };
	for (const s of list) {
		total.requests += s.requests; total.folds += s.folds; total.requested += s.requested; total.compactions += s.compactions;
		total.input += s.input; total.cacheRead += s.cacheRead; total.cacheWrite += s.cacheWrite;
		for (const [code, n] of Object.entries(s.refused)) add(total.refused, code, n);
		for (const [code, n] of Object.entries(s.dropped)) add(total.dropped, code, n);
		total.foldPressures.push(...s.foldPressures);
	}
	const prompt = total.input + total.cacheRead + total.cacheWrite;
	const strategies = [...rows.values()].sort((a, b) => b.requests - a.requests || a.strategy.localeCompare(b.strategy)).map((row) => {
		const sent = row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite;
		const turns = row.pricedTurns + row.unpricedTurns;
		return {
			...row,
			costPerTurn: row.pricedTurns > 0 ? row.cost / row.pricedTurns : null,
			tokensPerTurn: turns > 0 ? (sent + row.tokens.output) / turns : null,
			cacheHitRatio: sent > 0 ? row.tokens.cacheRead / sent : null,
			recallAfterFold: row.folds > 0 && row.recalls.records > 0 ? row.recalls.folds / row.folds : null,
		};
	});
	return { sessions: list, total: { ...total, cacheReadShare: prompt > 0 ? total.cacheRead / prompt : null }, strategies, strategiesFolded: folded.size };
}

export function filesOf(target) {
	return statSync(target).isDirectory()
		? readdirSync(target).filter((file) => file.endsWith(".jsonl")).sort().map((file) => path.join(target, file))
		: [target];
}

/**
 * A price for each request from the model registry Pi installs (`@earendil-works/pi-ai`), through the strategy
 * bench's price book. Null when the registry cannot be loaded: nothing is priced then.
 */
export async function registryPrice() {
	try {
		const { priceRequest, registryPriceBook } = await import(new URL("../dist/strategy-runtime/bench/pricing.js", import.meta.url).href);
		const book = registryPriceBook();
		return (modelId, tokens) => {
			const model = book.lookup("", modelId);
			if (!model) return null;
			const cost = priceRequest(model, tokens, "cache-write");
			return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
		};
	} catch { return null; }
}

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const listed = (map, unit) => {
	const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "none";
	const shown = entries.slice(0, MAX_LISTED).map(([key, n]) => `${key}=${n}`).join(" ");
	return entries.length > MAX_LISTED ? `${shown} … ${entries.length - MAX_LISTED} more ${unit}` : shown;
};
const codes = (map) => listed(map, "codes");

export function format(summary) {
	const out = [];
	for (const s of summary.sessions.slice(0, MAX_LISTED_SESSIONS)) {
		out.push(`${s.sessionId}: ${s.requests} requests, ${s.folds} folds accepted of ${s.requested} requested, ${s.compactions} compactions, cache-read ${pct(s.cacheReadShare)}`);
		out.push(`  refusals: ${codes(s.refused)}; dropped at turn end: ${codes(s.dropped)}`);
		out.push(`  pressure at each fold: ${s.foldPressures.slice(0, MAX_LISTED).map((p) => p.toFixed(2)).join(" ") || "none"}${s.foldPressures.length > MAX_LISTED ? ` … ${s.foldPressures.length - MAX_LISTED} more` : ""}`);
	}
	if (summary.sessions.length > MAX_LISTED_SESSIONS) out.push(`… ${summary.sessions.length - MAX_LISTED_SESSIONS} more sessions not listed (use --json)`);
	const t = summary.total;
	out.push(`total: ${t.sessions} sessions, ${t.requests} requests, ${t.folds} folds accepted of ${t.requested} requested, ${t.compactions} compactions, cache-read ${pct(t.cacheReadShare)}`);
	out.push(`  refusals: ${codes(t.refused)}; dropped at turn end: ${codes(t.dropped)}`);
	out.push("by strategy:");
	const rows = summary.strategies ?? [];
	for (const row of rows.slice(0, MAX_LISTED_STRATEGIES)) {
		const sources = Object.entries(row.sources).sort(([a], [b]) => a.localeCompare(b)).map(([source, n]) => `${source} ${n}`).join(", ");
		const priced = row.unpricedTurns > 0 ? `${row.pricedTurns} priced, ${row.unpricedTurns} unpriced` : `${row.pricedTurns} priced`;
		const cost = row.costPerTurn === null ? "unpriced" : `$${row.costPerTurn.toFixed(4)} per turn`;
		const tokens = row.tokensPerTurn === null ? "n/a" : row.tokensPerTurn.toFixed(1);
		out.push(`${row.strategy}: ${row.sessions} sessions (${sources}), ${row.requests} turns, ${cost} (${priced}), ${tokens} tokens per turn, cache hit ${pct(row.cacheHitRatio)}, ${row.folds} folds accepted of ${row.requested} requested, ${row.compactions} compactions, ${row.emergencies} emergency truncations`);
		out.push(`  refusals: folds ${codes(row.foldRefusals)}; plans ${codes(row.planRefusals)}; shadow plans ${codes(row.shadowRefusals)}`);
		out.push(`  stages: ${listed(row.stages, "outcomes")}${row.stagesOmitted > 0 ? ` (${row.stagesOmitted} not recorded)` : ""}`);
		out.push(`  guidance: ${listed(row.guidance, "variants")}`);
		out.push(row.recalls.records > 0
			? `  recall after hide: ${row.recalls.folds} fold recalls after ${row.folds} folds (${pct(row.recallAfterFold)}), ${row.recalls.hides} hide recalls, in ${row.recalls.records} turns that record recalls`
			: "  recall after hide: n/a (no record of this strategy counts recalls)");
	}
	// Ids not listed by name: the named rows not printed, and the ids counted under `other`.
	const named = (list) => list.filter((row) => row.strategy !== "other").length;
	const notListed = Math.max(named(rows) + (summary.strategiesFolded ?? 0) - named(rows.slice(0, MAX_LISTED_STRATEGIES)), rows.length - MAX_LISTED_STRATEGIES);
	if (notListed > 0) out.push(`… ${notListed} more strategies not listed (use --json)`);
	return bounded(out.join("\n"));
}

/** The text cut at MAX_OUTPUT_CHARS, at a line end, behind a visible marker. */
function bounded(text) {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	const cut = text.lastIndexOf("\n", MAX_OUTPUT_CHARS);
	return `${text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS)}\n… output cut at ${MAX_OUTPUT_CHARS} characters (use --json)`;
}

// -- Arms: guidance × majority model (pi-context-aware#459) ------------------------------------

/** A host label: lower-case, starting with a letter or digit, at most 32 characters. */
export const HOST = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
/** A model id as records write it; anything else is `other`. */
const MODEL = /^[A-Za-z0-9._:/@+-]{1,128}$/u;
const BASELINE = "default";
const VARIANT = "by-model-v1";
const ARM_GUIDANCE = [BASELINE, VARIANT];
const ARM_STEERS = ["default", "compact-boundary", "fold-first"];
/** Models that get arms of their own, most sessions first; the rest share `other`. */
const MAX_MODELS = 8;
/** Host labels kept apart; later ones count as `other`. */
const MAX_HOSTS = 8;
/** Arms printed, most sessions first; the rest are counted behind a marker. */
const MAX_LISTED_ARMS = 18;
export const DEFAULT_MIN_TURNS = 10;
export const DEFAULT_ITERATIONS = 2000;
export const MAX_ITERATIONS = 10000;
/** Guardrail limits of the agreed design (459-guidance-design.md, section 4): variant against default. */
const RECALL_LIMIT = 1.5;
const RATE_LIMIT = 2;
/** A rate guardrail breaches only at this many per 100 turns or more, so a default of 0 is not breached by one event. */
const RATE_FLOOR = 1;
const EXPOSURE_LIMIT = 0.1;
/** The decision rule of the agreed design (459-guidance-design.md): a win at or below this ratio, a reject at or above. */
const WIN_RATIO = 0.85;
const REJECT_RATIO = 1.15;
/** Analysed sessions each arm needs before a decision, by model family (the design's sample sizes); other models need Opus's. */
export const DEFAULT_MIN_SESSIONS = Object.freeze({ opus: 150, gpt: 50, other: 150 });
const FAMILIES = Object.keys(DEFAULT_MIN_SESSIONS);
const MAX_MIN_SESSIONS = 100_000;

/** The family a model id belongs to, as by-model-v1 matches it: the last `/` segment starts with `claude-opus-` or `gpt-`. */
function familyOf(modelId) {
	const last = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
	return last.startsWith("claude-opus-") ? "opus" : last.startsWith("gpt-") ? "gpt" : "other";
}

/**
 * The design's decision for one model: `below minimum sample` while either arm has fewer than `minimum` analysed
 * sessions; `reject` at a ratio of 1.15 or more with the interval's lower bound above 1.0; `win` at a ratio of 0.85
 * or less with the interval's upper bound below 1.0, an intention-to-treat ratio below 1.0 and no guardrail breach;
 * else `no change`.
 */
export function armDecision({ ratio, interval, ittRatio, breaches }, { baselineN, variantN, minimum }) {
	if (baselineN < minimum || variantN < minimum) return "below minimum sample";
	if (ratio === null || !interval) return "no change";
	if (ratio >= REJECT_RATIO && interval[0] > 1) return "reject";
	if (ratio <= WIN_RATIO && interval[1] < 1 && ittRatio !== null && ittRatio < 1 && breaches.length === 0) return "win";
	return "no change";
}

/** The minimum per family: the defaults, with each of `opus`, `gpt` and `other` replaced by a whole number given for it. */
function minimumsOf(given) {
	const minimums = { ...DEFAULT_MIN_SESSIONS };
	for (const family of FAMILIES) {
		const n = given?.[family];
		if (Number.isInteger(n) && n >= 1 && n <= MAX_MIN_SESSIONS) minimums[family] = n;
	}
	return minimums;
}

const nullable = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const modelIdOf = (record) => (typeof record.modelId === "string" && MODEL.test(record.modelId) ? record.modelId : "other");

/** The key with the most votes; a tie goes to the first in sort order. */
function majority(votes) {
	return [...votes.entries()].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))[0]?.[0] ?? "other";
}

/** Mulberry32: a small seeded generator, so an interval can be recomputed. */
function seeded(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * One session's numbers. Exposure is the first request that got a fold nudge, accepted a fold or carried a
 * compaction. A compaction's summary is modelled at the request's model price: `tokensBefore` as input and
 * `tokensAfter` as output, an upper bound of the summary.
 */
function sessionUnit(records, price) {
	const sorted = [...records].sort((a, b) => num(a.seq) - num(b.seq));
	const models = new Map();
	const guidances = new Map();
	const unit = {
		turns: sorted.length, pricedTurns: 0, cost: 0, compactionCost: 0, exposedTurns: 0, exposedCost: 0, exposedCompactionCost: 0, exposed: false,
		freed: { folds: 0, toolCompactions: 0, otherCompactions: 0 }, folds: 0, foldRecalls: 0, emergencies: 0, planRefusals: 0, steers: {},
	};
	for (const record of sorted) {
		const model = modelIdOf(record);
		models.set(model, (models.get(model) ?? 0) + 1);
		const guidance = strategyOf(record).guidance;
		const arm = ARM_GUIDANCE.includes(guidance) ? guidance : "other";
		guidances.set(arm, (guidances.get(arm) ?? 0) + 1);
		const folds = record.folds && typeof record.folds === "object" ? record.folds : {};
		const compaction = record.compaction && typeof record.compaction === "object" ? record.compaction : null;
		if (!unit.exposed && ((typeof record.nudge === "string" && record.nudge.length > 0) || num(folds.accepted) > 0 || compaction)) unit.exposed = true;
		const usage = record.usage && typeof record.usage === "object" ? record.usage : null;
		if (usage && price) {
			const dollars = price(model, { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite) });
			if (typeof dollars === "number" && Number.isFinite(dollars)) {
				unit.pricedTurns += 1;
				unit.cost += dollars;
				if (unit.exposed) { unit.exposedTurns += 1; unit.exposedCost += dollars; }
			}
		}
		if (compaction) {
			const before = nullable(compaction.tokensBefore);
			const after = nullable(compaction.tokensAfter);
			if (before !== null && after !== null && before > after) unit.freed[compaction.trigger === "tool" ? "toolCompactions" : "otherCompactions"] += before - after;
			const modelled = before !== null && price ? price(model, { input: before, output: after ?? 0, cacheRead: 0, cacheWrite: 0 }) : null;
			if (typeof modelled === "number" && Number.isFinite(modelled)) {
				unit.compactionCost += modelled;
				unit.exposedCompactionCost += modelled;
			}
		}
		unit.freed.folds += num(folds.freedTokens);
		unit.folds += num(folds.accepted);
		unit.foldRecalls += num(record.recalls?.folds);
		const emergency = record.emergency && typeof record.emergency === "object" ? record.emergency : null;
		if (emergency && (num(emergency.truncated) > 0 || num(emergency.hides) > 0)) unit.emergencies += 1;
		for (const stage of Array.isArray(record.stages) ? record.stages : []) {
			if (stage && typeof stage === "object" && stage.role === "active" && stage.outcome === "refused") unit.planRefusals += 1;
		}
		if (typeof record.steer === "string") add(unit.steers, ARM_STEERS.includes(record.steer) ? record.steer : "other", 1);
	}
	unit.model = majority(models);
	unit.guidance = majority(guidances);
	unit.primary = unit.exposed && unit.exposedTurns > 0 ? (unit.exposedCost + unit.exposedCompactionCost) / unit.exposedTurns : null;
	unit.itt = unit.pricedTurns > 0 ? (unit.cost + unit.compactionCost) / unit.pricedTurns : null;
	return unit;
}

const mean = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const share = (part, whole) => (whole > 0 ? part / whole : null);

/** The mean of one resample of `byHost`: each host's sessions drawn with replacement, as many as it has. */
function resampledMean(byHost, random) {
	let total = 0;
	let count = 0;
	for (const values of byHost) {
		for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)];
		count += values.length;
	}
	return count > 0 ? total / count : null;
}

/** A 95% percentile interval of variant mean / baseline mean, resampling sessions within each host. */
function bootstrapInterval(baseline, variant, iterations, seed) {
	const random = seeded(seed);
	const ratios = [];
	for (let i = 0; i < iterations; i++) {
		const a = resampledMean(baseline, random);
		const b = resampledMean(variant, random);
		if (a !== null && b !== null && a > 0) ratios.push(b / a);
	}
	if (ratios.length === 0) return null;
	ratios.sort((x, y) => x - y);
	return [ratios[Math.floor(0.025 * (ratios.length - 1))], ratios[Math.ceil(0.975 * (ratios.length - 1))]];
}

/** `variant / baseline`; null when either is unknown or the baseline is 0. */
const ratioOf = (variant, baseline) => (variant === null || baseline === null || baseline === 0 ? null : variant / baseline);
/**
 * A per-100-turn guardrail (emergency truncations, plan refusals) is breached when the variant's rate is above 2 times
 * the default's and at least 1 per 100 turns (the operator's floor, pi-context-aware#459); unknown rates never breach.
 */
export const rateBreached = (variant, baseline) => variant !== null && baseline !== null && variant > RATE_LIMIT * baseline && variant >= RATE_FLOOR;
/** True when `variant` is above `limit` times `baseline`; with a baseline of 0, any rise is above it. */
const above = (variant, baseline, limit) => variant !== null && baseline !== null && (baseline === 0 ? variant > 0 : variant / baseline > limit);

/**
 * The arms of a guidance experiment (pi-context-aware#459). `stores` lists `{ host, records }`. A session is one unit
 * per host; it joins the arm of its majority guidance and majority model. `price(modelId, usage)` gives dollars or
 * null. The primary is a session's cost per priced turn from its first exposure, with its modelled compaction
 * summaries; it counts only sessions with `minTurns` priced turns that were exposed. Intention to treat is the same
 * over every priced turn of every session with `minTurns` priced turns. Each model with both arms gets a comparison:
 * the ratio of the arms' primary means, a bootstrap interval stratified by host, and the guardrail checks.
 */
export function compareArms(stores, { price, minTurns = DEFAULT_MIN_TURNS, iterations = DEFAULT_ITERATIONS, seed = 459, minSessions } = {}) {
	const minimums = minimumsOf(minSessions);
	const hostNames = [];
	const sessions = new Map();
	for (const store of stores) {
		let host = HOST.test(store.host) ? store.host : "other";
		if (!hostNames.includes(host)) {
			if (hostNames.length >= MAX_HOSTS) host = "other";
			if (!hostNames.includes(host)) hostNames.push(host);
		}
		for (const record of store.records) {
			const key = `${host}\n${record.sessionId}`;
			let entry = sessions.get(key);
			if (!entry) sessions.set(key, entry = { host, records: [] });
			entry.records.push(record);
		}
	}
	const units = [...sessions.values()].map(({ host, records }) => ({ host, ...sessionUnit(records, price) }));
	const modelSessions = new Map();
	for (const unit of units) if (unit.model !== "other") modelSessions.set(unit.model, (modelSessions.get(unit.model) ?? 0) + 1);
	const named = new Set([...modelSessions.entries()].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_MODELS).map(([model]) => model));
	const groups = new Map();
	for (const unit of units) {
		const model = named.has(unit.model) ? unit.model : "other";
		const key = `${unit.guidance}\n${model}`;
		let group = groups.get(key);
		if (!group) groups.set(key, group = { guidance: unit.guidance, model, units: [] });
		group.units.push(unit);
	}
	const primaryByHost = new Map();
	const arms = [...groups.values()].map(({ guidance, model, units: list }) => {
		const hosts = {};
		for (const unit of list) hosts[unit.host] = (hosts[unit.host] ?? 0) + 1;
		const itt = list.filter((unit) => unit.pricedTurns >= minTurns);
		const analysed = itt.filter((unit) => unit.exposed && unit.primary !== null);
		const byHost = new Map();
		for (const unit of analysed) byHost.set(unit.host, [...(byHost.get(unit.host) ?? []), unit.primary]);
		const sum = (pick) => list.reduce((total, unit) => total + pick(unit), 0);
		const turns = sum((unit) => unit.turns);
		const freed = { folds: sum((unit) => unit.freed.folds), toolCompactions: sum((unit) => unit.freed.toolCompactions), otherCompactions: sum((unit) => unit.freed.otherCompactions) };
		const freedTotal = freed.folds + freed.toolCompactions + freed.otherCompactions;
		const folds = sum((unit) => unit.folds);
		const foldRecalls = sum((unit) => unit.foldRecalls);
		const steers = {};
		for (const unit of list) for (const [steer, n] of Object.entries(unit.steers)) add(steers, steer, n);
		const exposed = itt.filter((unit) => unit.exposed).length;
		const arm = {
			guidance, model, sessions: list.length, hosts, exposed, exposureShare: share(exposed, itt.length),
			primary: { n: analysed.length, mean: mean(analysed.map((unit) => unit.primary)) },
			itt: { n: itt.length, mean: mean(itt.map((unit) => unit.itt).filter((value) => value !== null)) },
			compactionCost: sum((unit) => unit.compactionCost),
			freed,
			freedShares: { folds: share(freed.folds, freedTotal), toolCompactions: share(freed.toolCompactions, freedTotal), otherCompactions: share(freed.otherCompactions, freedTotal) },
			steers,
			guardrails: {
				turns, acceptedFolds: folds, foldRecalls, recallsPerFold: share(foldRecalls, folds),
				emergenciesPer100: turns > 0 ? (100 * sum((unit) => unit.emergencies)) / turns : null,
				planRefusalsPer100: turns > 0 ? (100 * sum((unit) => unit.planRefusals)) / turns : null,
			},
		};
		primaryByHost.set(arm, [...byHost.keys()].sort().map((host) => byHost.get(host)));
		return arm;
	}).sort((a, b) => b.sessions - a.sessions || a.guidance.localeCompare(b.guidance) || a.model.localeCompare(b.model));
	const comparisons = [];
	for (const model of [...new Set(arms.map((arm) => arm.model))].sort()) {
		const a = arms.find((arm) => arm.guidance === BASELINE && arm.model === model);
		const b = arms.find((arm) => arm.guidance === VARIANT && arm.model === model);
		if (!a || !b) continue;
		const ga = a.guardrails;
		const gb = b.guardrails;
		const exposureDifference = a.exposureShare === null || b.exposureShare === null ? null : b.exposureShare - a.exposureShare;
		const breaches = [];
		if (above(gb.recallsPerFold, ga.recallsPerFold, RECALL_LIMIT)) breaches.push("recall-after-hide");
		if (rateBreached(gb.emergenciesPer100, ga.emergenciesPer100)) breaches.push("emergency-truncations");
		if (rateBreached(gb.planRefusalsPer100, ga.planRefusalsPer100)) breaches.push("plan-refusals");
		if (exposureDifference !== null && Math.abs(exposureDifference) > EXPOSURE_LIMIT) breaches.push("exposure-share");
		const enough = a.primary.n >= 2 && b.primary.n >= 2;
		const ratio = ratioOf(b.primary.mean, a.primary.mean);
		const interval = enough ? bootstrapInterval(primaryByHost.get(a), primaryByHost.get(b), iterations, seed) : null;
		const ittRatio = ratioOf(b.itt.mean, a.itt.mean);
		const minimum = minimums[familyOf(model)];
		comparisons.push({
			model,
			ratio,
			interval,
			ittRatio,
			decision: { verdict: armDecision({ ratio, interval, ittRatio, breaches }, { baselineN: a.primary.n, variantN: b.primary.n, minimum }), minimum, sessions: [a.primary.n, b.primary.n] },
			guardrails: {
				recallRatio: ratioOf(gb.recallsPerFold, ga.recallsPerFold),
				emergencyRatio: ratioOf(gb.emergenciesPer100, ga.emergenciesPer100),
				refusalRatio: ratioOf(gb.planRefusalsPer100, ga.planRefusalsPer100),
				exposureDifference,
			},
			breaches,
		});
	}
	const hosts = hostNames.map((host) => ({ host, sessions: units.filter((unit) => unit.host === host).length }));
	return { hosts, arms, comparisons, settings: { minTurns, iterations, seed, minSessions: minimums } };
}

/** The arms with every difference but the guardrails left out: what a weekly check may see. */
export function guardrailsView(result) {
	return {
		hosts: result.hosts,
		arms: result.arms.map(({ guidance, model, sessions, hosts, exposed, exposureShare, steers, guardrails }) => ({ guidance, model, sessions, hosts, exposed, exposureShare, steers, guardrails })),
		comparisons: result.comparisons.map(({ model, guardrails, breaches }) => ({ model, guardrails, breaches })),
	};
}

const dollars = (value) => (value === null ? "n/a" : `$${value.toFixed(4)}`);
const times = (value) => (value === null ? "n/a" : `${value.toFixed(2)}x`);
const rate = (value) => (value === null ? "n/a" : value.toFixed(1));

export function formatArms(result, { guardrailsOnly = false } = {}) {
	const minTurns = result.settings?.minTurns ?? DEFAULT_MIN_TURNS;
	const hosts = result.hosts.map((entry) => `${entry.host} ${entry.sessions}`).join(", ") || "none";
	const out = [guardrailsOnly
		? `guardrails by guidance and model (other arm differences hidden), sessions per host: ${hosts}`
		: `by guidance and model, sessions per host: ${hosts}; primary: cost per priced turn from first exposure (a fold nudge, an accepted fold or a compaction) in sessions with ${minTurns}+ priced turns, plus modelled compaction summaries (tokensBefore at the model's list input price, tokensAfter at its list output price, from the @earendil-works/pi-ai model registry)`];
	for (const arm of result.arms.slice(0, MAX_LISTED_ARMS)) {
		const armHosts = Object.entries(arm.hosts).sort(([a], [b]) => a.localeCompare(b)).map(([host, n]) => `${host} ${n}`).join(", ");
		out.push(`${arm.guidance} \u00d7 ${arm.model}: ${arm.sessions} sessions (${arm.itt.n} with ${minTurns}+ priced turns, ${arm.exposed} exposed), hosts ${armHosts}`);
		if (!guardrailsOnly) {
			out.push(`  cost per turn from exposure ${dollars(arm.primary.mean)} (n=${arm.primary.n}), intention to treat ${dollars(arm.itt.mean)} (n=${arm.itt.n}), modelled compaction summaries ${dollars(arm.compactionCost)}`);
			const total = arm.freed.folds + arm.freed.toolCompactions + arm.freed.otherCompactions;
			out.push(total > 0
				? `  freed tokens: folds ${pct(arm.freedShares.folds)}, the model's context_compact ${pct(arm.freedShares.toolCompactions)}, other compactions ${pct(arm.freedShares.otherCompactions)} of ${total}`
				: "  freed tokens: none recorded");
		}
		out.push(`  steer: ${Object.keys(arm.steers).length > 0 ? listed(arm.steers, "steers") : "not recorded"}`);
		const g = arm.guardrails;
		const recall = g.recallsPerFold === null ? "n/a (no accepted folds)" : `${g.recallsPerFold.toFixed(2)} per fold (${g.foldRecalls} of ${g.acceptedFolds})`;
		out.push(`  guardrails: recall after hide ${recall}, emergency truncations ${rate(g.emergenciesPer100)} per 100 turns, plan refusals ${rate(g.planRefusalsPer100)} per 100 turns, exposure ${pct(arm.exposureShare)} of ${arm.itt.n} sessions with ${minTurns}+ priced turns`);
	}
	if (result.arms.length > MAX_LISTED_ARMS) out.push(`… ${result.arms.length - MAX_LISTED_ARMS} more arms not listed (use --json)`);
	out.push(`${VARIANT} against ${BASELINE}, per model:`);
	if (result.comparisons.length === 0) out.push("  no model has sessions in both arms");
	for (const comparison of result.comparisons) {
		if (!guardrailsOnly) {
			const interval = comparison.interval ? `95% interval ${comparison.interval[0].toFixed(3)} to ${comparison.interval[1].toFixed(3)}, ${result.settings?.iterations ?? DEFAULT_ITERATIONS} resamples within hosts` : "no interval: fewer than 2 analysed sessions in an arm";
			out.push(`${comparison.model}: cost per turn ratio ${comparison.ratio === null ? "n/a" : comparison.ratio.toFixed(3)} (${interval}), intention to treat ${comparison.ittRatio === null ? "n/a" : comparison.ittRatio.toFixed(3)}`);
			const { verdict, minimum, sessions } = comparison.decision;
			out.push(`  decision: ${verdict} (${sessions[0]} and ${sessions[1]} analysed sessions, minimum ${minimum} per arm)`);
		}
		const g = comparison.guardrails;
		const exposure = g.exposureDifference === null ? "n/a" : `${(g.exposureDifference * 100).toFixed(1)} points`;
		out.push(`${guardrailsOnly ? `${comparison.model}: ` : "  "}guardrails: recall after hide ${times(g.recallRatio)}, emergency truncations ${times(g.emergencyRatio)}, plan refusals ${times(g.refusalRatio)}, exposure share ${exposure}; ${comparison.breaches.length > 0 ? `breached: ${comparison.breaches.join(", ")}` : "none breached"}`);
	}
	return bounded(out.join("\n"));
}

const USAGE = "Usage: context-metrics-summary.mjs [--json] [--guardrails-only] [--source <source>]... [--min-turns <n>] [--min-sessions <opus|gpt|other>=<n>]... [--iterations <n>] [--seed <n>] [--store <host>=<path>]... [<metrics-dir | file.jsonl>]...\n";

/** `--store <host>=<path>` as a store, or null when the label or the path is not usable. */
function storeArg(value) {
	if (typeof value !== "string") return null;
	const at = value.indexOf("=");
	if (at < 0) return null;
	const host = value.slice(0, at);
	const target = value.slice(at + 1);
	return HOST.test(host) && target.length > 0 ? { host, target } : null;
}

/** A whole number from `min` to `max`, or null. */
function whole(value, min, max) {
	if (typeof value !== "string" || !/^\d{1,9}$/u.test(value)) return null;
	const n = Number(value);
	return n >= min && n <= max ? n : null;
}

async function main(argv) {
	let json = false;
	let guardrailsOnly = false;
	const sources = [];
	const stores = [];
	const options = {};
	const fail = (message) => { process.stderr.write(`${message}\n${USAGE}`); return 2; };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--guardrails-only") guardrailsOnly = true;
		else if (arg === "--source") {
			const source = argv[++i];
			if (!SOURCES.includes(source)) return fail(`--source takes one of: ${SOURCES.join(", ")}`);
			sources.push(source);
		} else if (arg === "--store") {
			const store = storeArg(argv[++i]);
			if (!store) return fail("--store takes <host>=<path>, the host lower-case letters, digits, '.', '_' or '-', at most 32");
			stores.push(store);
		} else if (arg === "--min-sessions") {
			const value = argv[++i];
			const at = typeof value === "string" ? value.indexOf("=") : -1;
			const family = at > 0 ? value.slice(0, at) : "";
			const n = at > 0 ? whole(value.slice(at + 1), 1, MAX_MIN_SESSIONS) : null;
			if (!FAMILIES.includes(family) || n === null) return fail(`--min-sessions takes <family>=<n>, the family one of ${FAMILIES.join(", ")} and n a whole number from 1 to ${MAX_MIN_SESSIONS}`);
			options.minSessions = { ...options.minSessions, [family]: n };
		} else if (arg === "--min-turns" || arg === "--iterations" || arg === "--seed") {
			const [min, max] = arg === "--min-turns" ? [1, 1000] : arg === "--iterations" ? [1, MAX_ITERATIONS] : [0, 999_999_999];
			const n = whole(argv[++i], min, max);
			if (n === null) return fail(`${arg} takes a whole number from ${min} to ${max}`);
			options[arg === "--min-turns" ? "minTurns" : arg === "--iterations" ? "iterations" : "seed"] = n;
		} else stores.push({ host: "local", target: arg });
	}
	if (stores.length === 0) return fail("No metrics store given.");
	const keep = (records) => (sources.length > 0 ? records.filter((record) => sources.includes(strategyOf(record).source)) : records);
	const read = stores.map(({ host, target }) => ({ host, records: keep(filesOf(target).flatMap((file) => parseMetrics(readFileSync(file, "utf8")))) }));
	const price = await registryPrice();
	const arms = compareArms(read, { ...(price ? { price } : {}), ...options });
	if (guardrailsOnly) {
		process.stdout.write(`${json ? JSON.stringify(guardrailsView(arms), null, 2) : formatArms(arms, { guardrailsOnly: true })}\n`);
		return 0;
	}
	const summary = summarise(read.flatMap((store) => store.records), { ...(price ? { price } : {}) });
	process.stdout.write(`${json ? JSON.stringify({ ...summary, byArm: arms }, null, 2) : `${format(summary)}\n${formatArms(arms)}`}\n`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));