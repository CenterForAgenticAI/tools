import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { armDecision, compareArms, format, formatArms, parseMetrics, rateBreached, summarise } from "../scripts/context-metrics-summary.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/context-metrics/", import.meta.url));
const v2 = fileURLToPath(new URL("./fixtures/context-metrics-v2/", import.meta.url));
const hostileDir = fileURLToPath(new URL("./fixtures/context-metrics-hostile/", import.meta.url));
const script = fileURLToPath(new URL("../scripts/context-metrics-summary.mjs", import.meta.url));
/**
 * The command's environment without NODE_V8_COVERAGE: scripts/ is outside c8's include list, so a CLI run adds no
 * measured coverage, only a large V8 coverage file (it loads the pi-ai model registry) for c8's report to merge.
 */
const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_V8_COVERAGE"));

// Hand-computed from the fixtures: alpha has 3 whole records and a torn fourth line; beta has 2 v1 records and one record of an unknown version (99; 3 became known in pi-context-aware#526).
test("the reader summarises the fixture sessions and tolerates a torn last line and an unknown version", () => {
	const summary = summarise(["alpha", "beta"].flatMap((name) => parseMetrics(readFileSync(`${fixtures}${name}.jsonl`, "utf8"))));
	const [alpha, beta] = summary.sessions;
	assert.equal(alpha.requests, 3);
	assert.equal(alpha.folds, 2);
	assert.equal(alpha.requested, 3);
	assert.deepEqual(alpha.refused, { "summary-short": 1 });
	assert.deepEqual(alpha.dropped, { "branch-changed": 1 });
	assert.deepEqual(alpha.foldPressures, [0.5, 0.75]);
	assert.equal(alpha.compactions, 1);
	assert.equal(alpha.cacheReadShare, 350 / 600);
	assert.equal(beta.requests, 2);
	assert.deepEqual(beta.refused, { "unknown-ref": 2 });
	assert.deepEqual(beta.foldPressures, [0.6]);
	assert.equal(beta.cacheReadShare, 0.5);
	assert.equal(summary.total.requests, 5);
	assert.equal(summary.total.folds, 3);
	assert.equal(summary.total.cacheReadShare, 450 / 800);
});

test("pressure at each fold is the pressure of the request that made the fold", async () => {
	const { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS } = await import("../dist/metrics/recorder.js");
	const { requestPressure } = await import("../dist/folds/request-pressure.js");
	const { metricsSessionFile } = await import("../dist/metrics/records.js");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "metrics-sum-"));
	try {
		const recorder = registerMetricsRecorder({
			agentDir: () => root, settings: () => DEFAULT_METRICS_SETTINGS,
		});
		const ctx = { sessionManager: { getSessionId: () => "s", getLeafId: () => "l", getBranch: () => [] }, model: { id: "m", contextWindow: 1000 } };
		const turn = (before) => ({ messages: [], sources: [], dropped: [], tokens: { before, after: before } });
		// The fold engine reports each request's pressure with its pass result (pi-context-aware#461).
		const pressure = (tokens) => requestPressure({ tokens, window: 1000, measured: true, source: "fold-pass" });
		recorder.observers.onTurn(ctx, turn(200), pressure(200), false);
		recorder.observers.onRequest(ctx, { ok: true, mode: "live", queued: true, blockIds: ["b"], warnings: [] });
		recorder.observers.onTurn(ctx, turn(800), pressure(800), false);
		recorder.close(ctx);
		await recorder.flush();
		const summary = summarise(parseMetrics(readFileSync(metricsSessionFile(root, "s"), "utf8")));
		assert.deepEqual(summary.sessions[0].foldPressures, [0.2]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the command prints a summary for a directory and fails without arguments", () => {
	const ok = spawnSync(process.execPath, [script, fixtures], { encoding: "utf8", env: cliEnv });
	assert.equal(ok.status, 0);
	assert.match(ok.stdout, /alpha: 3 requests, 2 folds accepted of 3 requested, 1 compactions, cache-read 58\.3%/u);
	assert.match(ok.stdout, /pressure at each fold: 0\.50 0\.75/u);
	assert.match(ok.stdout, /total: 2 sessions, 5 requests/u);
	assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8", env: cliEnv }).status, 2);
});
// pi-context-aware#473: the summary per strategy. Expected values are hand-computed from the fixtures.
// A fake price book, dollars per token: input 1, output 2, cache read 0.1, cache write 1.25, for model m1 only.
const price = (modelId, usage) => (modelId === "m1" ? usage.input * 1 + usage.output * 2 + usage.cacheRead * 0.1 + usage.cacheWrite * 1.25 : null);
const readDir = (dir, names) => names.flatMap((name) => parseMetrics(readFileSync(`${dir}${name}.jsonl`, "utf8")));
const byId = (summary) => Object.fromEntries(summary.strategies.map((row) => [row.strategy, row]));

test("#473: version 1 records, which carry no strategy, summarise as fold+compact from the legacy source", () => {
	const rows = summarise(readDir(fixtures, ["alpha", "beta"])).strategies;
	assert.equal(rows.length, 1);
	const [row] = rows;
	assert.equal(row.strategy, "fold+compact");
	assert.deepEqual(row.sources, { legacy: 2 });
	assert.equal(row.sessions, 2);
	assert.equal(row.requests, 5);
	assert.equal(row.folds, 3);
	assert.equal(row.requested, 6);
	assert.equal(row.compactions, 1);
	assert.deepEqual(row.foldRefusals, { "summary-short": 1, "unknown-ref": 2 });
	assert.equal(row.cacheHitRatio, 450 / 800);
	assert.equal(row.recalls.records, 0, "version 1 records carry no recalls");
});

test("#473: version 2 records split by the methods their recipe ran: cost per turn, cache hit ratio, folds, compactions, refusals by code, recall after hide", () => {
	const rows = byId(summarise(readDir(v2, ["g1", "g2"]), { price }));
	assert.deepEqual(Object.keys(rows).sort(), ["compact", "fold+compact"]);
	const compaction = rows["compact"];
	assert.deepEqual(compaction.sources, { "strategy.assign": 1 });
	assert.equal(compaction.requests, 2);
	assert.equal(compaction.costPerTurn, (40.5 + 20) / 2);
	assert.equal(compaction.cacheHitRatio, 180 / 200);
	assert.equal(compaction.folds, 0);
	assert.equal(compaction.compactions, 1);
	assert.deepEqual(compaction.planRefusals, {}, "a shadow recipe's refusal is not the active recipe's");
	assert.deepEqual(compaction.shadowRefusals, { "unreachable-tool": 1 });
	assert.deepEqual(compaction.stages, {
		"active compact/pressure-note applied": 1,
		"active compact/seeded-compaction applied": 1,
		"shadow fold+compact/growth-nudge shadowed": 1,
		"shadow fold+compact/pressure-note refused": 1,
	});
	assert.deepEqual(compaction.recalls, { folds: 0, hides: 1, records: 2 });
	const folds = rows["fold+compact"];
	assert.equal(folds.requests, 2);
	assert.equal(folds.costPerTurn, 140, "the turn whose model has no price is left out of the average");
	assert.equal(folds.unpricedTurns, 1);
	assert.equal(folds.cacheHitRatio, 90 / 200);
	assert.deepEqual([folds.folds, folds.requested], [1, 2]);
	assert.deepEqual(folds.foldRefusals, { "summary-short": 1 });
	assert.deepEqual(folds.planRefusals, { "owner-claimed": 1, "unreachable-tool": 1 });
	assert.deepEqual(folds.recalls, { folds: 1, hides: 0, records: 2 });
	assert.equal(folds.recallAfterFold, 1);
});

test("#473: --source keeps only the records of one source, so a comparison can leave legacy records out", () => {
	const records = [...readDir(fixtures, ["alpha", "beta"]), ...readDir(v2, ["g2"])];
	assert.deepEqual(byId(summarise(records))["fold+compact"].sources, { legacy: 2, "strategy.assign": 1 });
	const assigned = byId(summarise(records, { sources: ["strategy.assign"] }))["fold+compact"];
	assert.deepEqual([assigned.sessions, assigned.requests], [1, 2]);
	const cli = spawnSync(process.execPath, [script, "--source", "strategy.assign", fixtures, v2], { encoding: "utf8", env: cliEnv });
	assert.equal(cli.status, 0, cli.stderr);
	assert.match(cli.stdout, /^fold\+compact: 1 sessions \(strategy\.assign 1\), 2 turns/mu);
	assert.doesNotMatch(cli.stdout, /legacy/u);
	assert.equal(spawnSync(process.execPath, [script, "--source", "bogus", v2], { encoding: "utf8", env: cliEnv }).status, 2, "an unknown source is an error");
});

test("#473: the command prints one row per strategy", () => {
	const out = format(summarise(readDir(v2, ["g1", "g2"]), { price }));
	assert.match(out, /^by strategy:$/mu);
	assert.match(out, /^compact: 1 sessions \(strategy\.assign 1\), 2 turns, \$30\.2500 per turn \(2 priced\), 105\.0 tokens per turn, cache hit 90\.0%, 0 folds accepted of 0 requested, 1 compactions, 0 emergency truncations$/mu);
	assert.match(out, /^ {2}refusals: folds none; plans none; shadow plans unreachable-tool=1$/mu);
	assert.match(out, /^ {2}recall after hide: 0 fold recalls after 0 folds \(n\/a\), 1 hide recalls, in 2 turns that record recalls$/mu);
	assert.match(out, /^fold\+compact: 1 sessions \(strategy\.assign 1\), 2 turns, \$140\.0000 per turn \(1 priced, 1 unpriced\), .*, 0 compactions, 1 emergency truncations$/mu);
	assert.match(out, /^ {2}recall after hide: 1 fold recalls after 1 folds \(100\.0%\)/mu);
});

test("#473: ids and codes read from a record reach the terminal as one plain line each; a forged one is shown as other", () => {
	const cli = spawnSync(process.execPath, [script, hostileDir], { encoding: "utf8", env: cliEnv });
	assert.equal(cli.status, 0, cli.stderr);
	const out = cli.stdout;
	for (const forbidden of ["\u001b", "\u0007", "\r"]) assert.equal(out.includes(forbidden), false, `no ${JSON.stringify(forbidden)} survives`);
	assert.doesNotMatch(out, /999 sessions|forged/u, "no forged row or line");
	assert.match(out, /^other: 1 sessions \(other 1\), 1 turns/mu, "a recipe id outside the pattern is other");
	assert.match(out, /refusals: folds other=2; plans code-0=1 code-1=1 .*… 26 more codes/mu, "codes are listed up to a cap with a visible marker");
	for (const line of out.split("\n")) assert.ok(line.length <= 600, `bounded line: ${line.length}`);
	const json = spawnSync(process.execPath, [script, "--json", hostileDir], { encoding: "utf8", env: cliEnv });
	assert.equal(json.stdout.includes("\\u001b"), false, "the JSON holds no escape either");
});

test("#473: the record the recorder writes now summarises under its strategy", async () => {
	const { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS } = await import("../dist/metrics/recorder.js");
	const { metricsSessionFile } = await import("../dist/metrics/records.js");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "metrics-sum-"));
	try {
		const recorder = registerMetricsRecorder({ agentDir: () => root, settings: () => DEFAULT_METRICS_SETTINGS });
		const ctx = { sessionManager: { getSessionId: () => "s", getLeafId: () => "l", getBranch: () => [] }, model: { id: "m", contextWindow: 1000 } };
		recorder.observers.onTurn(ctx, undefined, null, false, { strategy: { methods: ["compact"], source: "strategy.methods", shadow: [["fold", "compact"]], guidance: "default" }, stages: [{ trigger: "request", recipe: "compact", role: "active", stage: "pressure-note", outcome: "applied", codes: [] }] });
		recorder.close(ctx);
		await recorder.flush();
		const rows = summarise(parseMetrics(readFileSync(metricsSessionFile(root, "s"), "utf8"))).strategies;
		assert.deepEqual(rows.map((row) => [row.strategy, row.sources, row.guidance, row.stages]), [["compact", { "strategy.methods": 1 }, { default: 1 }, { "active compact/pressure-note applied": 1 }]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
// pi-context-aware#473 review (CR-SUMMARY-ROWS-UNCAPPED): one forged file must not flood the terminal.
const forgedBase = { v: 3, at: "2026-01-01T00:00:00.000Z", leafId: "l", modelId: "m", window: 1000, tokensBefore: 0, tokensAfter: 0, pressure: 0.3, band: "ok", nudge: null, emergency: null, passFailed: false, folds: { requested: 0, accepted: 0, refused: {}, dropped: {}, tiers: null }, compaction: null, usage: null, stages: [], stagesOmitted: 0, recalls: { folds: 0, hides: 0 } };

test("#473: 5000 distinct recipe ids give a bounded summary: 64 rows, the rest under other, 8 blocks printed and a count of the rest", () => {
	const records = [];
	for (let i = 0; i < 5000; i++) records.push({ ...forgedBase, sessionId: "h", seq: i, strategy: { methods: [`forged-method-${String(i).padStart(4, "0")}`], source: "auto", shadow: [], guidance: "default" } });
	const summary = summarise(parseMetrics(records.map((record) => JSON.stringify(record)).join("\n")));
	assert.equal(summary.strategies.length, 65, "64 named rows and other");
	assert.equal(summary.strategiesFolded, 4936, "the method sets past the first 64 are counted, under other");
	assert.equal(summary.strategies[0].strategy, "other", "rows are ordered by turns");
	assert.equal(summary.strategies[0].requests, 4936);
	const out = format(summary);
	const blocks = out.split("\n").filter((line) => /^(forged-method-\d{4}|other): /u.test(line));
	assert.deepEqual(blocks.map((line) => line.split(":")[0]), ["other", "forged-method-0000", "forged-method-0001", "forged-method-0002", "forged-method-0003", "forged-method-0004", "forged-method-0005", "forged-method-0006"]);
	assert.match(out, /^… 4993 more strategies not listed \(use --json\)$/mu, "5000 ids less the 7 listed by name");
	assert.ok(out.split("\n").length < 60, `bounded lines: ${out.split("\n").length}`);
});

test("#473: the whole summary is cut at a fixed size with a visible marker", () => {
	const codes = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`code-${String(i).padStart(2, "0")}-${"x".repeat(56)}`, 1]));
	const records = [];
	for (let i = 0; i < 200; i++) records.push({ ...forgedBase, sessionId: `s${String(i).padStart(3, "0")}`, seq: i, folds: { ...forgedBase.folds, refused: codes, dropped: codes }, strategy: { methods: ["fold", "compact"], source: "auto", shadow: [], guidance: "default" } });
	const out = format(summarise(parseMetrics(records.map((record) => JSON.stringify(record)).join("\n"))));
	assert.ok(out.length <= 131072 + 80, `bounded output: ${out.length}`);
	assert.match(out, /\n… output cut at 131072 characters \(use --json\)$/u);
});

// pi-context-aware#526: version 3 records name the methods; a row is a method set, and records of every version that ran it share it.
const v3 = (sessionId, strategy, stages = []) => ({ ...forgedBase, sessionId, seq: 1, strategy, stages });

test("#526: version 3 records split by method set, and a version 2 recipe joins the row of the methods it ran", () => {
	const lines = [
		v3("m1", { methods: ["fold", "compact"], source: "strategy.methods", shadow: [], guidance: "default" }, [{ trigger: "request", recipe: "fold+compact", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] }]),
		v3("m2", { methods: ["compact"], source: "folds.engine", shadow: [["fold", "compact"]], guidance: "default" }, [{ trigger: "request", recipe: "fold+compact", role: "shadow", stage: "growth-nudge", outcome: "shadowed", codes: [] }]),
		v3("m3", { methods: ["fold"], source: "strategy.methods", shadow: [], guidance: "default" }),
		{ ...forgedBase, v: 2, sessionId: "m4", seq: 1, strategy: { recipe: "folds-v1", source: "auto", shadow: [] }, stages: [{ trigger: "request", recipe: "folds-v1", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] }] },
	];
	const rows = byId(summarise(parseMetrics(lines.map((line) => JSON.stringify(line)).join("\n"))));
	assert.deepEqual(Object.keys(rows).sort(), ["compact", "fold", "fold+compact"]);
	assert.deepEqual([rows["fold+compact"].sessions, rows["fold+compact"].sources], [2, { auto: 1, "strategy.methods": 1 }]);
	assert.deepEqual(rows["fold+compact"].stages, { "active fold+compact/growth-nudge applied": 2 });
	assert.deepEqual(rows["fold+compact"].guidance, { default: 2 }, "a version 2 record ran the default guidance");
	assert.deepEqual(rows.compact.stages, { "shadow fold+compact/growth-nudge shadowed": 1 });
	assert.deepEqual(rows.compact.sources, { "folds.engine": 1 });
	const cli = spawnSync(process.execPath, [script, "--source", "strategy.methods", "--json", "/dev/null"], { encoding: "utf8", env: cliEnv });
	assert.equal(cli.status, 0, "strategy.methods is a source --source takes");
});

test("#526: a forged method set is other: a name outside the pattern, a method twice, an empty list, too many methods", () => {
	const forged = [["Fold"], ["fold", "fold"], [], Array.from({ length: 9 }, (_, i) => `m${i}`), ["fold\u001b[2J"], "fold", [3]];
	const lines = forged.map((methods, i) => v3(`f${i}`, { methods, source: "strategy.methods", shadow: [], guidance: "x\ny" }, [{ trigger: "request", recipe: "fold+fold", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] }]));
	const rows = byId(summarise(parseMetrics(lines.map((line) => JSON.stringify(line)).join("\n"))));
	assert.deepEqual(Object.keys(rows), ["other"]);
	assert.equal(rows.other.sessions, forged.length);
	assert.deepEqual(rows.other.guidance, { other: forged.length });
	assert.deepEqual(rows.other.stages, { "active other/growth-nudge applied": forged.length });
});
// pi-context-aware#459: the comparison of guidance arms. Each session is one unit, grouped by its guidance and its
// majority model, read from several stores labelled by host. Expected values are hand-computed from the records
// below with this fake price book (dollars per token), not read from the script.
const OPUS = "claude-opus-5-5";
const GPT = "gpt-6.1-sol";
const PRICES = { [OPUS]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, [GPT]: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0 } };
const fakePrice = (modelId, u) => { const p = PRICES[modelId]; return p ? u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite : null; };
/** One request. `cost` is the input tokens, so on Opus it is the turn's dollars. */
const turn4 = (sessionId, seq, o = {}) => ({
	...forgedBase, v: 4, sessionId, seq, modelId: o.model ?? OPUS,
	strategy: { methods: ["fold", "compact"], source: "strategy.methods", shadow: [], guidance: o.guidance ?? "default" },
	usage: { input: o.cost ?? 1, output: 0, cacheRead: 0, cacheWrite: 0 }, nudge: o.nudge ?? null,
	folds: { ...forgedBase.folds, accepted: o.folds ?? 0, freedTokens: o.freed ?? 0 }, compaction: o.compaction ?? null,
	recalls: { folds: o.recalls ?? 0, hides: 0 }, emergency: o.emergency ?? null, stages: o.stages ?? [], steer: o.steer ?? "default",
});
/** `n` requests of one session; `at` overrides single requests by their 1-based number. */
const session4 = (sessionId, n, o = {}, at = {}) => Array.from({ length: n }, (_, i) => turn4(sessionId, i + 1, { ...o, ...(at[i + 1] ?? {}) }));
const armOf = (result, guidance, model) => result.arms.find((arm) => arm.guidance === guidance && arm.model === model);

test("#459: the primary is cost per turn from first exposure plus modelled compaction summaries; intention to treat covers every turn", () => {
	const records = [
		// Exposed at turn 4 (a nudge); a compaction at turn 6 modelled at 100 input + 10 output tokens = $120.
		...session4("s1", 10, { cost: 2 }, { 1: { cost: 1 }, 2: { cost: 1 }, 3: { cost: 1 }, 4: { nudge: "tier1" }, 6: { compaction: { writer: "context-aware", trigger: "tool", tokensBefore: 100, tokensAfter: 10 } } }),
		// Ten priced turns, never exposed: in the intention-to-treat set only.
		...session4("s2", 10, { cost: 3 }),
		// Nine priced turns: too short for either set.
		...session4("s3", 9, { cost: 50, nudge: "tier1" }),
	];
	const arm = armOf(compareArms([{ host: "mac", records }], { price: fakePrice }), "default", OPUS);
	assert.deepEqual([arm.sessions, arm.itt.n, arm.primary.n, arm.exposed], [3, 2, 1, 1]);
	assert.equal(arm.primary.mean, (7 * 2 + 120) / 7);
	assert.equal(arm.itt.mean, ((3 + 7 * 2 + 120) / 10 + 3) / 2);
	assert.equal(arm.compactionCost, 120);
	assert.equal(arm.exposureShare, 0.5, "one of the two sessions with ten priced turns was exposed");
});

test("#459: sessions group by guidance and majority model; the same session id on two hosts is two sessions", () => {
	const mixed = session4("m", 10, { guidance: "by-model-v1" }, { 7: { model: GPT }, 8: { model: GPT }, 9: { model: GPT }, 10: { model: GPT } });
	const result = compareArms([
		{ host: "mac", records: [...session4("dup", 10), ...mixed] },
		{ host: "dev", records: [...session4("dup", 10), ...session4("g", 10, { model: GPT, guidance: "by-model-v1" })] },
	], { price: fakePrice });
	assert.deepEqual(armOf(result, "default", OPUS).hosts, { dev: 1, mac: 1 });
	assert.equal(armOf(result, "by-model-v1", OPUS).sessions, 1, "six Opus requests of ten make an Opus session");
	assert.deepEqual(armOf(result, "by-model-v1", GPT).hosts, { dev: 1 });
	assert.equal(result.arms.length, 3);
});

test("#459: freed tokens split into folds, the model's context_compact, and other compactions", () => {
	const records = session4("f", 10, {}, {
		2: { folds: 1, freed: 100 }, 3: { folds: 1, freed: 200 },
		4: { compaction: { writer: "context-aware", trigger: "tool", tokensBefore: 100, tokensAfter: 10 } },
		5: { compaction: { writer: "context-aware", trigger: "proactive", tokensBefore: 1000, tokensAfter: 400 } },
		6: { compaction: { writer: "pi", trigger: "overflow", tokensBefore: 500, tokensAfter: null } },
	});
	const arm = armOf(compareArms([{ host: "mac", records }], { price: fakePrice }), "default", OPUS);
	assert.deepEqual(arm.freed, { folds: 300, toolCompactions: 90, otherCompactions: 600 });
	assert.equal(arm.freedShares.folds, 300 / 990);
	assert.equal(arm.freedShares.toolCompactions, 90 / 990);
});

/** Two arms on Opus, hand-built so each guardrail has a known value. */
function guardrailStores() {
	const refused = [{ trigger: "request", recipe: "fold+compact", role: "active", stage: "pressure-note", outcome: "refused", codes: ["owner-claimed"] }];
	const truncated = { truncated: 2, hides: 0, skipped: false, terminal: false };
	const a = [
		...session4("a1", 10, {}, { 1: { nudge: "tier1", folds: 2, recalls: 1 }, 2: { emergency: truncated } }),
		...session4("a2", 10, {}, { 1: { nudge: "tier1", folds: 2, recalls: 1 }, 3: { stages: refused } }),
	];
	const b = [
		...session4("b1", 10, { guidance: "by-model-v1", steer: "compact-boundary" }, { 1: { nudge: "tier1", folds: 2, recalls: 2 }, 2: { emergency: truncated }, 3: { emergency: truncated }, 4: { emergency: truncated }, 5: { stages: refused } }),
		...session4("b2", 10, { guidance: "by-model-v1", steer: "compact-boundary" }),
	];
	return [{ host: "mac", records: [...a, ...b] }];
}

test("#459: guardrails per arm: recalls per accepted fold, emergency truncations and plan refusals per 100 turns, exposure share", () => {
	const result = compareArms(guardrailStores(), { price: fakePrice });
	const a = armOf(result, "default", OPUS);
	const b = armOf(result, "by-model-v1", OPUS);
	assert.deepEqual([a.guardrails.recallsPerFold, a.guardrails.emergenciesPer100, a.guardrails.planRefusalsPer100, a.exposureShare], [0.5, 5, 5, 1]);
	assert.deepEqual([b.guardrails.recallsPerFold, b.guardrails.emergenciesPer100, b.guardrails.planRefusalsPer100, b.exposureShare], [1, 15, 5, 0.5]);
	assert.deepEqual(b.steers, { "compact-boundary": 20 });
	const [comparison] = result.comparisons;
	assert.equal(comparison.model, OPUS);
	assert.deepEqual([comparison.guardrails.recallRatio, comparison.guardrails.emergencyRatio, comparison.guardrails.refusalRatio, comparison.guardrails.exposureDifference], [2, 3, 1, -0.5]);
	assert.deepEqual(comparison.breaches, ["recall-after-hide", "emergency-truncations", "exposure-share"]);
});

test("#459: the bootstrap interval resamples within each host, so host mix cannot move it", () => {
	// Every session costs the same within a host and arm; per-host counts differ between the arms. Resampling within
	// hosts keeps each arm's mean fixed, so the interval is the point ratio; pooled resampling would scatter it.
	const arm = (guidance, prefix, host, n, cost) => Array.from({ length: n }, (_, i) => session4(`${prefix}${i}`, 10, { guidance, cost, nudge: "tier1" })).flat().map((record) => ({ host, record }));
	const rows = [...arm("default", "da", "a", 1, 1), ...arm("default", "db", "b", 3, 10), ...arm("by-model-v1", "va", "a", 3, 1), ...arm("by-model-v1", "vb", "b", 1, 10)];
	const stores = ["a", "b"].map((host) => ({ host, records: rows.filter((row) => row.host === host).map((row) => row.record) }));
	const [comparison] = compareArms(stores, { price: fakePrice, iterations: 500 }).comparisons;
	const ratio = ((3 * 1 + 10) / 4) / ((1 + 3 * 10) / 4);
	assert.equal(comparison.ratio, ratio);
	assert.deepEqual(comparison.interval, [ratio, ratio]);
});

test("#459: the interval is seeded, brackets the point ratio, and is absent below two analysed sessions per arm", () => {
	const costs = { default: [3, 5, 4, 6, 2, 5], "by-model-v1": [2, 3, 2, 4, 1, 3] };
	const records = Object.entries(costs).flatMap(([guidance, list]) => list.flatMap((cost, i) => session4(`${guidance}-${i}`, 10, { guidance, cost, nudge: "tier1" })));
	const run = (seed) => compareArms([{ host: "mac", records }], { price: fakePrice, iterations: 400, seed }).comparisons[0];
	const first = run(7);
	assert.deepEqual(run(7).interval, first.interval, "same seed, same interval");
	assert.ok(first.interval[0] < first.ratio && first.ratio < first.interval[1], JSON.stringify(first));
	assert.equal(first.ratio, (15 / 6) / (25 / 6));
	const single = compareArms([{ host: "mac", records: [...session4("x", 10, { nudge: "tier1" }), ...session4("y", 10, { guidance: "by-model-v1", nudge: "tier1" })] }], { price: fakePrice }).comparisons[0];
	assert.equal(single.interval, null);
});

function writeStore(name, records) {
	const dir = mkdtempSync(join(tmpdir(), `metrics-arms-${name}-`));
	const bySession = new Map();
	for (const record of records) bySession.set(record.sessionId, [...(bySession.get(record.sessionId) ?? []), record]);
	for (const [id, list] of bySession) writeFileSync(join(dir, `${id}.jsonl`), list.map((record) => JSON.stringify(record)).join("\n") + "\n");
	return dir;
}

test("#459: the command reads stores labelled by host and prints the arms; a bad label is an error", () => {
	const mac = writeStore("mac", guardrailStores()[0].records);
	const dev = writeStore("dev", session4("d1", 10, { nudge: "tier1" }));
	try {
		const cli = spawnSync(process.execPath, [script, "--store", `mac=${mac}`, "--store", `dev=${dev}`], { encoding: "utf8", env: cliEnv });
		assert.equal(cli.status, 0, cli.stderr);
		assert.match(cli.stdout, /^default × claude-opus-5-5: 3 sessions .*hosts dev 1, mac 2$/mu);
		assert.match(cli.stdout, /^ {2}guardrails: recall after hide 0\.50 per fold \(2 of 4\), emergency truncations 3\.3 per 100 turns, plan refusals 3\.3 per 100 turns, exposure 100\.0% of 3 sessions with 10\+ priced turns$/mu);
		// The command prices from the @earendil-works/pi-ai registry, which lists claude-opus-5-5, so costs print in dollars.
		assert.match(cli.stdout, /^ {2}cost per turn from exposure \$\d+\.\d{4} \(n=3\), intention to treat \$\d+\.\d{4} \(n=3\), modelled compaction summaries \$0\.0000$/mu);
		for (const bad of ["nolabel", "Bad Host=x", "=x", "mac="]) {
			assert.equal(spawnSync(process.execPath, [script, "--store", bad], { encoding: "utf8", env: cliEnv }).status, 2, bad);
		}
	} finally { rmSync(mac, { recursive: true, force: true }); rmSync(dev, { recursive: true, force: true }); }
});

test("#459: --guardrails-only hides every arm difference but the guardrails, in text and in JSON", () => {
	const mac = writeStore("mac", guardrailStores()[0].records);
	try {
		const text = spawnSync(process.execPath, [script, "--guardrails-only", "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv });
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /guardrails: recall after hide/u);
		assert.match(text.stdout, /breached: recall-after-hide, emergency-truncations, exposure-share/u);
		assert.doesNotMatch(text.stdout, /\$|per turn|ratio|interval|intention|freed|cache/iu);
		const json = spawnSync(process.execPath, [script, "--guardrails-only", "--json", "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv });
		assert.equal(json.status, 0, json.stderr);
		const parsed = JSON.parse(json.stdout);
		assert.deepEqual(Object.keys(parsed).sort(), ["arms", "comparisons", "hosts"]);
		for (const arm of parsed.arms) for (const hidden of ["primary", "itt", "compactionCost", "freed", "freedShares"]) assert.ok(!(hidden in arm), hidden);
		for (const comparison of parsed.comparisons) for (const hidden of ["ratio", "interval", "ittRatio"]) assert.ok(!(hidden in comparison), hidden);
		assert.ok(!formatArms(compareArms(guardrailStores(), { price: fakePrice }), { guardrailsOnly: true }).includes("$"));
	} finally { rmSync(mac, { recursive: true, force: true }); }
});

test("#459: a forged model id is other, models past eight share one row, and records of versions 1 to 4 are all read", () => {
	const forged = session4("evil", 10, { model: "claude-opus-5-5\u001b[2J\nforged" });
	const many = Array.from({ length: 12 }, (_, i) => session4(`many${i}`, 10, { model: `model-${String(i).padStart(2, "0")}` })).flat();
	const result = compareArms([{ host: "mac", records: [...forged, ...many] }], { price: fakePrice });
	assert.ok(result.arms.every((arm) => arm.model === "other" || /^model-0[0-7]$/u.test(arm.model)), JSON.stringify(result.arms.map((arm) => arm.model)));
	assert.equal(armOf(result, "default", "other").sessions, 5, "the forged id and the four models past eight");
	const out = formatArms(result);
	assert.equal(out.includes("\u001b"), false);
	assert.doesNotMatch(out, /forged/u);
	const versions = parseMetrics([1, 2, 3, 4, 5].map((v) => JSON.stringify({ ...forgedBase, v, sessionId: "v", seq: v })).join("\n"));
	assert.deepEqual(versions.map((record) => record.v), [1, 2, 3, 4]);
});

// --- The design's decision rule per tested model (459-guidance-design.md; review finding CR-SUMMARY-DECISION-RULE-NOT-EVALUATED) ---

/** A comparison whose decision inputs are set by hand; everything else is irrelevant to the rule. */
const decided = (o) => armDecision({ ratio: 0.8, interval: [0.7, 0.95], ittRatio: 0.9, breaches: [], ...o.comparison }, { baselineN: o.n?.[0] ?? 150, variantN: o.n?.[1] ?? 150, minimum: o.minimum ?? 150 });

test("CR-SUMMARY-DECISION-RULE-NOT-EVALUATED: win needs ratio at most 0.85, interval upper bound below 1.0, intention to treat below 1.0 and no breach", () => {
	assert.equal(decided({}), "win");
	assert.equal(decided({ comparison: { ratio: 0.85, interval: [0.7, 0.99], ittRatio: 0.99 } }), "win", "0.85 itself wins");
	assert.equal(decided({ comparison: { ratio: 0.86 } }), "no change", "ratio above 0.85");
	assert.equal(decided({ comparison: { interval: [0.7, 1.0] } }), "no change", "upper bound 1.0 is not below 1.0");
	assert.equal(decided({ comparison: { ittRatio: 1.0 } }), "no change", "intention to treat not below 1.0");
	assert.equal(decided({ comparison: { breaches: ["plan-refusals"] } }), "no change", "a guardrail breach blocks a win");
	assert.equal(decided({ comparison: { interval: null } }), "no change", "no interval, no win");
	assert.equal(decided({ comparison: { ittRatio: null } }), "no change", "no intention-to-treat ratio, no win");
});

test("CR-SUMMARY-DECISION-RULE-NOT-EVALUATED: reject needs ratio at least 1.15 and interval lower bound above 1.0", () => {
	assert.equal(decided({ comparison: { ratio: 1.15, interval: [1.01, 1.3], ittRatio: 1.2 } }), "reject", "1.15 itself rejects");
	assert.equal(decided({ comparison: { ratio: 1.3, interval: [1.0, 1.6], ittRatio: 1.2 } }), "no change", "lower bound 1.0 is not above 1.0");
	assert.equal(decided({ comparison: { ratio: 1.14, interval: [1.05, 1.2], ittRatio: 1.2 } }), "no change", "ratio below 1.15");
	assert.equal(decided({ comparison: { ratio: 1.2, interval: [1.05, 1.4], ittRatio: 1.2, breaches: ["recall-after-hide"] } }), "reject", "a breach does not hide a reject");
	assert.equal(decided({ comparison: { ratio: null, interval: null, ittRatio: null } }), "no change");
});

test("CR-SUMMARY-DECISION-RULE-NOT-EVALUATED: an arm under the minimum sample is below minimum sample, whatever the numbers", () => {
	assert.equal(decided({ n: [149, 150] }), "below minimum sample");
	assert.equal(decided({ n: [150, 149] }), "below minimum sample");
	assert.equal(decided({ n: [149, 150], comparison: { ratio: 1.5, interval: [1.2, 1.8] } }), "below minimum sample");
	assert.equal(decided({ n: [50, 50], minimum: 50 }), "win");
	assert.equal(decided({ n: [49, 50], minimum: 50 }), "below minimum sample");
});

/** Two arms on one host whose sessions each cost the same, so the interval is the point ratio: 8 / 10 = 0.8. */
function decisionStores(model = OPUS) {
	const arm = (guidance, cost) => [0, 1].flatMap((i) => session4(`${guidance}-${model}-${i}`, 10, { guidance, cost, model, nudge: "tier1" }));
	return [{ host: "mac", records: [...arm("default", 10), ...arm("by-model-v1", 8)] }];
}

test("CR-SUMMARY-DECISION-RULE-NOT-EVALUATED: each tested model's comparison carries its decision, with Opus needing 150 and GPT 50 sessions per arm unless configured", () => {
	const [opus] = compareArms(decisionStores(), { price: fakePrice, iterations: 200 }).comparisons;
	assert.deepEqual([opus.ratio, opus.interval, opus.ittRatio], [0.8, [0.8, 0.8], 0.8]);
	assert.deepEqual(opus.decision, { verdict: "below minimum sample", minimum: 150, sessions: [2, 2] });
	const [gpt] = compareArms(decisionStores(GPT), { price: fakePrice, iterations: 200 }).comparisons;
	assert.equal(gpt.decision.minimum, 50);
	const [configured] = compareArms(decisionStores(), { price: fakePrice, iterations: 200, minSessions: { opus: 2 } }).comparisons;
	assert.deepEqual(configured.decision, { verdict: "win", minimum: 2, sessions: [2, 2] });
	const text = formatArms(compareArms(decisionStores(), { price: fakePrice, iterations: 200, minSessions: { opus: 2 } }));
	assert.match(text, /^ {2}decision: win \(2 and 2 analysed sessions, minimum 2 per arm\)$/mu);
	assert.doesNotMatch(formatArms(compareArms(decisionStores(), { price: fakePrice, minSessions: { opus: 2 } }), { guardrailsOnly: true }), /decision|win/u);
});

test("CR-SUMMARY-DECISION-RULE-NOT-EVALUATED: --min-sessions sets a family's minimum; --guardrails-only hides the decision; a bad value is an error", () => {
	const mac = writeStore("decision", decisionStores()[0].records);
	try {
		const cli = spawnSync(process.execPath, [script, "--min-sessions", "opus=2", "--iterations", "200", "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv });
		assert.equal(cli.status, 0, cli.stderr);
		assert.match(cli.stdout, /^ {2}decision: win \(2 and 2 analysed sessions, minimum 2 per arm\)$/mu);
		const plain = spawnSync(process.execPath, [script, "--iterations", "200", "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv });
		assert.match(plain.stdout, /^ {2}decision: below minimum sample \(2 and 2 analysed sessions, minimum 150 per arm\)$/mu);
		for (const args of [["--guardrails-only"], ["--guardrails-only", "--json"]]) {
			const hidden = spawnSync(process.execPath, [script, ...args, "--min-sessions", "opus=2", "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv });
			assert.equal(hidden.status, 0, hidden.stderr);
			assert.doesNotMatch(hidden.stdout, /decision|verdict|below minimum/u, args.join(" "));
		}
		for (const bad of ["opus", "opus=0", "sonnet=5", "opus=x", "gpt=-1"]) {
			assert.equal(spawnSync(process.execPath, [script, "--min-sessions", bad, "--store", `mac=${mac}`], { encoding: "utf8", env: cliEnv }).status, 2, bad);
		}
	} finally { rmSync(mac, { recursive: true, force: true }); }
});

test("#459 operator floor: a rate guardrail breaches only above 2 times default and at 1 or more per 100 turns", () => {
	assert.equal(rateBreached(0.5, 0), false, "default 0, variant 0.5: under the floor");
	assert.equal(rateBreached(1.2, 0), true, "default 0, variant 1.2");
	assert.equal(rateBreached(1.5, 0.8), false, "default 0.8, variant 1.5: not above 1.6");
	assert.equal(rateBreached(1.7, 0.8), true, "default 0.8, variant 1.7");
	assert.equal(rateBreached(1, 0), true, "1 per 100 turns is at the floor");
	assert.equal(rateBreached(1.6, 0.8), false, "exactly 2 times is not above it");
	assert.equal(rateBreached(null, 0), false);
	assert.equal(rateBreached(3, null), false);
});

test("#459 operator floor: through the arms, one emergency truncation in 200 turns over a default of 0 is no breach; six in 500 are", () => {
	const truncated = { truncated: 1, hides: 0, skipped: false, terminal: false };
	const refused = [{ trigger: "request", recipe: "fold+compact", role: "active", stage: "pressure-note", outcome: "refused", codes: ["owner-claimed"] }];
	const run = (events, turns) => {
		const at = Object.fromEntries(Array.from({ length: events }, (_, i) => [i + 1, { emergency: truncated, stages: refused }]));
		const records = [...session4("d", 100, { nudge: "tier1" }), ...session4("v", turns, { guidance: "by-model-v1", nudge: "tier1" }, at)];
		return compareArms([{ host: "mac", records }], { price: fakePrice, iterations: 50 }).comparisons[0];
	};
	const low = run(1, 200);
	assert.deepEqual([low.guardrails.emergencyRatio, low.breaches], [null, []], "0.5 per 100 over 0");
	const high = run(6, 500);
	assert.deepEqual(high.breaches, ["emergency-truncations", "plan-refusals"], "1.2 per 100 over 0");
});