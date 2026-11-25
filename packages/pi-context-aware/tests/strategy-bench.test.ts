/**
 * The strategy bench (pi-context-aware#469): replay fidelity on a recorded fixture, byte-identical reports
 * (REQ-STRAT-006), both baselines end to end (REQ-STRAT-004), per-provider cache pricing from the model
 * registry, recall-after-hide, and the report saying what it does not measure.
 *
 * Expected token counts are read from the fixture files with JSON.parse here, never from the bench. The
 * fold fixture is one real session with its text redacted to same-length filler (tests/fixtures/strategy-bench/README.md).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildContextEntries, buildSessionContext, buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import { createFoldTurnMemory, prepareFoldTurn } from "../src/folds/fold-turn.js";
import type { ContextView, ViewEntry } from "../src/strategy/contract.js";

import {
	benchStrategies,
	listCorpus,
	NOT_MEASURED,
	priceRequest,
	readRecording,
	registryPriceBook,
	replaySession,
	reportJson,
	reportMarkdown,
	runBench,
	runCli,
	standInFoldsRecipe,
	type Report,
	type ReplayOptions,
	type TraceStep,
} from "../src/strategy-runtime/bench/index.js";

const FIXTURES = path.resolve("tests/fixtures/strategy-bench");
const CORPUS = path.join(FIXTURES, "corpus");
const FOLD_SESSION = path.join(CORPUS, "fold-session", "session.jsonl");
const UNPRICED_SESSION = path.join(CORPUS, "unpriced-session", "session.jsonl");

interface FileLine {
	readonly type: string;
	readonly timestamp?: string;
	readonly message?: { readonly role?: string; readonly usage?: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number } };
}

const linesOf = (file: string): FileLine[] => fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as FileLine);
/** The fixture holds one branch in file order, so its assistant messages are its requests. */
const assistantLines = (file: string): FileLine[] => linesOf(file).filter((line) => line.type === "message" && line.message?.role === "assistant");
const recordedSizes = (file: string): number[] => assistantLines(file).map((line) => line.message!.usage!.input + line.message!.usage!.cacheRead + line.message!.usage!.cacheWrite);

function options(overrides: Partial<ReplayOptions> = {}): ReplayOptions {
	return { child: false, prices: registryPriceBook(), recallWindow: 20, coldCacheMs: 300_000, fallbackFoldSummaryChars: 2_000, fallbackCompactionSummaryChars: 8_000, ...overrides };
}

const strategy = (id: string) => {
	const found = benchStrategies().find((candidate) => candidate.id === id);
	assert.ok(found, id);
	return found;
};

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "strategy-bench-"));
}

test("fidelity: folds-v1 replayed as recorded reproduces every recorded request size within 0.5%, and the bench's own estimate within 5%", () => {
	const recorded = recordedSizes(FOLD_SESSION);
	assert.equal(recorded.length, 32, "the fixture records 32 requests");
	const steps: TraceStep[] = [];
	const recording = readRecording(fs.readFileSync(FOLD_SESSION, "utf8"))!;
	const result = replaySession(recording, [strategy("folds-v1/recorded")], options({ trace: (id, request, step) => {
		if (id === "folds-v1/recorded") steps[request] = step;
	} }));
	assert.equal(result.strategies[0]!.folds, 1, "the recorded fold is re-issued and accepted");
	assert.deepEqual(result.strategies[0]!.refusals, {});
	assert.equal(steps.length, recorded.length);
	let checked = 0;
	recorded.forEach((size, request) => {
		if (size === 0) return; // a failed request the provider never counted
		checked++;
		const step = steps[request]!;
		assert.ok(Math.abs(step.size - size) / size <= 0.005, `request ${request}: modeled ${step.size}, recorded ${size}`);
		assert.ok(Math.abs(step.estimate - size) / size <= 0.05, `request ${request}: estimated ${step.estimate}, recorded ${size}`);
	});
	assert.equal(checked, 29);
	// The fold took the context from 158859 to 72804 tokens: the check above holds across it.
	assert.ok(recorded[14]! - recorded[15]! > 80_000);
});

test("REQ-STRAT-004: both baselines and the pi-context-aware#456 variants run end to end on the fixture", () => {
	const recording = readRecording(fs.readFileSync(FOLD_SESSION, "utf8"))!;
	const strategies = benchStrategies();
	const result = replaySession(recording, strategies, options());
	const byId = new Map(strategies.map((spec, index) => [spec.id, result.strategies[index]!]));
	assert.deepEqual(strategies.map((spec) => spec.id), [
		"folds-v1/recorded", "folds-v1/growth-50k", "folds-v1/growth-100k", "folds-v1/floor-30", "folds-v1/floor-45",
		"folds-v1/floor-30+growth-100k", "folds-v1/floor-45+growth-100k", "compaction-only-v1", "mask-then-fold", "trim-then-fold",
	]);
	for (const one of result.strategies) assert.equal(one.requests, 32);
	// The session peaks at 158859 tokens of a 1M window, under both usage floors and the compaction threshold.
	assert.ok(Math.max(...recordedSizes(FOLD_SESSION)) < 0.3 * 1_000_000);
	assert.ok(byId.get("folds-v1/growth-50k")!.nudges >= 1, "the 50k growth nudge fires");
	assert.ok(byId.get("folds-v1/growth-50k")!.folds >= 1, "the stand-in model folds after it");
	for (const id of ["folds-v1/floor-30", "folds-v1/floor-45", "folds-v1/floor-30+growth-100k", "folds-v1/floor-45+growth-100k"]) {
		assert.equal(byId.get(id)!.nudges, 0, `${id} never nudges below its floor`);
		assert.equal(byId.get(id)!.folds, 0, id);
	}
	assert.equal(byId.get("compaction-only-v1")!.compactions, 0);
	assert.equal(byId.get("compaction-only-v1")!.folds, 0);
	// With no fold at all, compaction-only sends more than the recording, which folded once.
	assert.ok(byId.get("compaction-only-v1")!.tokensSent > recordedSizes(FOLD_SESSION).reduce((sum, size) => sum + size, 0));
});

test("a Fabric worker session, which cannot call context_fold, gets no nudge naming it, as live, and nothing folds", () => {
	const recording = readRecording(fs.readFileSync(FOLD_SESSION, "utf8"))!;
	const worker = replaySession(recording, [strategy("folds-v1/growth-50k")], options({ child: true })).strategies[0]!;
	assert.deepEqual(worker.refusals, {}, "no nudge was planned for the plan check to refuse as unreachable-tool");
	assert.equal(worker.nudges, 0);
	assert.equal(worker.folds, 0);
	// The same session as a main session is nudged, so the worker's silence is the reachability rule.
	assert.ok(replaySession(recording, [strategy("folds-v1/growth-50k")], options()).strategies[0]!.nudges >= 1);
});

test("REQ-STRAT-006: the same corpus gives byte-identical JSON and Markdown on two runs, in one thread or several", async () => {
	const run = { roots: [{ label: "fixture", dir: CORPUS }] };
	const first = await runBench(run);
	const second = await runBench(run);
	const parallel = await runBench({ ...run, jobs: 2 });
	assert.equal(reportJson(second), reportJson(first));
	assert.equal(reportJson(parallel), reportJson(first));
	// Every file split into one task per strategy, in one thread and in several, gives the same report.
	assert.equal(reportJson(await runBench({ ...run, heavyBytes: 1 })), reportJson(first));
	assert.equal(reportJson(await runBench({ ...run, heavyBytes: 1, jobs: 3 })), reportJson(first));
	assert.equal(reportMarkdown(second), reportMarkdown(first));
	assert.equal(first.corpus.hosts[0]!.sessions, 2);
	assert.equal(first.corpus.hosts[0]!.requests, 33);
});

test("cache reads, cache writes and input are priced at the registry's own rates, never flat", () => {
	const opus = getBuiltinModels("anthropic").find((model) => model.id === "claude-opus-5-5")!;
	const rates = opus.cost;
	assert.ok(rates.cacheRead < rates.input && rates.input < rates.cacheWrite, "the registry prices the three differently");
	// `unified` is a proxy the registry does not list: the model's own vendor prices it.
	const priced = registryPriceBook().lookup("unified", "claude-opus-5-5")!;
	assert.equal(priced.pricedAs, "anthropic/claude-opus-5-5");
	const million = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	assert.equal(priceRequest(priced, { ...million, cacheRead: 1e6 }, "cache-write").cacheRead, rates.cacheRead);
	assert.equal(priceRequest(priced, { ...million, cacheWrite: 1e6 }, "cache-write").cacheWrite, rates.cacheWrite);
	assert.equal(priceRequest(priced, { ...million, cacheWrite: 1e6 }, "input").cacheWrite, rates.input);
	assert.equal(priceRequest(priced, { ...million, cacheWrite: 1e6, cacheWrite1h: 1e6 }, "cache-write").cacheWrite, rates.input * 2);
	assert.equal(priceRequest(priced, { ...million, input: 1e6 }, "cache-write").input, rates.input);
	// A long-context tier applies by request size.
	const sol = getBuiltinModels("openai").find((model) => model.id === "gpt-6.1-sol")!;
	const tier = sol.cost.tiers![0]!;
	const solPriced = registryPriceBook().lookup("openai", "gpt-6.1-sol")!;
	assert.equal(priceRequest(solPriced, { ...million, cacheRead: tier.inputTokensAbove }, "input").cacheRead, (tier.inputTokensAbove * sol.cost.cacheRead) / 1e6);
	assert.equal(priceRequest(solPriced, { ...million, cacheRead: tier.inputTokensAbove + 1 }, "input").cacheRead, ((tier.inputTokensAbove + 1) * tier.cacheRead) / 1e6);
});

test("a model the registry does not price is listed as unpriced and costs nothing, rather than guessed", async () => {
	assert.equal(registryPriceBook().lookup("bench-test", "unlisted-model"), undefined);
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, "s"));
	fs.copyFileSync(UNPRICED_SESSION, path.join(dir, "s", "session.jsonl"));
	const report = await runBench({ roots: [{ label: "t", dir }] });
	assert.deepEqual(report.pricing.unpriced, [{ model: "bench-test/unlisted-model", requests: 1 }]);
	assert.deepEqual(report.pricing.priced, []);
	assert.equal(report.recorded.all.cost.total, 0);
	for (const one of report.strategies) {
		assert.equal(one.all.cost.total, 0);
		assert.equal(one.all.unpricedRequests, 1);
	}
	assert.match(reportMarkdown(report), /Models the registry does not price[\s\S]*`bench-test\/unlisted-model`: 1 requests/u);
});

test("recall-after-hide counts a recorded context_recall of a fold within the window, and not beyond it", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8") + fs.readFileSync(path.join(FIXTURES, "recall-tail.txt"), "utf8");
	const recording = readRecording(text)!;
	// The fold applies from request 15; the recall of b1 is made in the response to request 32.
	assert.deepEqual(recording.recalls, [{ request: 32, ref: "b1" }]);
	assert.equal(recording.folds[0]!.request, 15);
	const within = replaySession(recording, [strategy("folds-v1/recorded")], options({ recallWindow: 20 })).strategies[0]!;
	assert.deepEqual([within.recalledWithinWindow, within.hides], [1, 1]);
	const beyond = replaySession(recording, [strategy("folds-v1/recorded")], options({ recallWindow: 17 })).strategies[0]!;
	assert.deepEqual([beyond.recalledWithinWindow, beyond.hides], [0, 1]);
});

test("a message recorded without content replays as empty content", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const lines = text.trimEnd().split("\n");
	const last = JSON.parse(lines[lines.length - 1]!) as { id: string; timestamp: string };
	// A failed request Pi recorded with usage and no content, as some provider errors leave it.
	const failed = { type: "message", id: "no-content", parentId: last.id, timestamp: last.timestamp, message: { role: "assistant", model: "claude-opus-5-5", provider: "anthropic", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } } };
	const recording = readRecording(`${text}${JSON.stringify(failed)}\n`)!;
	assert.deepEqual((recording.path[recording.path.length - 1]! as unknown as { message: { content: unknown } }).message.content, []);
	const result = replaySession(recording, benchStrategies(), options());
	assert.equal(result.requests, 33);
});

test("a session the bench cannot read is listed as failed with its error, and the run goes on", async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, "good"));
	fs.copyFileSync(UNPRICED_SESSION, path.join(dir, "good", "session.jsonl"));
	fs.mkdirSync(path.join(dir, "bad"));
	fs.writeFileSync(path.join(dir, "bad", "session.jsonl"), `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: null })}\n`);
	const failures: string[] = [];
	const report = await runBench({ roots: [{ label: "t", dir }], failed: (failure) => failures.push(failure) });
	assert.equal(report.corpus.hosts[0]!.sessions, 1);
	assert.equal(report.skipped.length, 1);
	assert.equal(report.skipped[0]!.file, "t/bad/session.jsonl");
	assert.match(report.skipped[0]!.reason, /^replay failed: TypeError: [\x20-\x7e]+$/u);
	assert.match(failures[0]!, /^sizes t\/bad\/session\.jsonl: TypeError: /u);
	assert.equal(reportJson(await runBench({ roots: [{ label: "t", dir }], jobs: 2 })), reportJson(report));
});

test("--until leaves out entries stamped later, so a session still being written reads the same", () => {
	const requests = assistantLines(FOLD_SESSION);
	const until = Date.parse(requests[10]!.timestamp!);
	const recording = readRecording(fs.readFileSync(FOLD_SESSION, "utf8"), { until })!;
	assert.equal(recording.requests.length, 11);
	assert.equal(recording.folds.length, 0, "the fold came later");
});

test("the corpus lists .jsonl files in a fixed order, marks Fabric and subagent sessions as children, and honours --since", () => {
	const dir = tempDir();
	for (const rel of ["b/z.jsonl", "a/.fabric/w.jsonl", "a/x.jsonl", "a/subagents/s.jsonl", "a/notes.txt"]) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "");
	}
	const old = new Date("2026-01-01T00:00:00Z");
	fs.utimesSync(path.join(dir, "b/z.jsonl"), old, old);
	const all = listCorpus([{ label: "h", dir }]);
	assert.deepEqual(all.map((file) => [file.relative, file.child]), [["a/.fabric/w.jsonl", true], ["a/subagents/s.jsonl", true], ["a/x.jsonl", false], ["b/z.jsonl", false]]);
	assert.deepEqual(listCorpus([{ label: "h", dir }], { since: Date.parse("2026-06-01") }).map((file) => file.relative), ["a/.fabric/w.jsonl", "a/subagents/s.jsonl", "a/x.jsonl"]);
});

test("the report states what it does not measure, in JSON and in Markdown", async () => {
	const report = await runBench({ roots: [{ label: "fixture", dir: CORPUS }] });
	assert.equal(report.judges, "cost, not quality");
	assert.deepEqual(report.notMeasured, NOT_MEASURED);
	assert.ok(NOT_MEASURED.some((item) => item.startsWith("Quality")));
	assert.ok(NOT_MEASURED.some((item) => item.includes("Latency")));
	assert.ok(NOT_MEASURED.some((item) => item.includes("stand-in model")));
	assert.ok(NOT_MEASURED.some((item) => item.startsWith("Provider cache rules: one cached-prefix model serves every provider")));
	assert.ok(NOT_MEASURED.some((item) => item.includes("it is a lower bound")));
	const markdown = reportMarkdown(report);
	const section = markdown.slice(markdown.indexOf("## Not measured"));
	for (const item of NOT_MEASURED) assert.ok(section.includes(`- ${item}`), item);
	assert.match(markdown, /`@earendil-works\/pi-ai` \d+\.\d+\.\d+/u, "the price source and its version are stated");
});

test("the command line prints the JSON report, renders it to Markdown, and refuses bad arguments", async () => {
	const json = await runCli(["--corpus", `fixture=${CORPUS}`, "--until", "2026-11-30T00:00:00Z", "--recall-window", "10"]);
	assert.ok(json.ok);
	const report = JSON.parse(json.text) as Report;
	assert.equal(report.corpus.slice.until, "2026-11-30T00:00:00.000Z");
	assert.equal(report.options.recallWindow, 10);
	const dir = tempDir();
	const file = path.join(dir, "report.json");
	fs.writeFileSync(file, json.text);
	const rendered = await runCli(["--render", file]);
	assert.deepEqual(rendered, { ok: true, text: reportMarkdown(report) });
	for (const bad of [[], ["--corpus"], ["--corpus", "nolabel"], ["--jobs", "0", "--corpus", `f=${CORPUS}`], ["--since", "soon", "--corpus", `f=${CORPUS}`], ["--frobnicate", "1"]]) {
		const result = await runCli(bad);
		assert.equal(result.ok, false, bad.join(" "));
	}
});

const usagesOf = (text: string) => text.trimEnd().split("\n").map((line) => JSON.parse(line) as FileLine)
	.filter((line) => line.type === "message" && line.message?.role === "assistant").map((line) => line.message!.usage!);

function traces(text: string, ids: readonly string[], overrides: Partial<ReplayOptions> = {}): Map<string, TraceStep[]> {
	const found = new Map<string, TraceStep[]>(ids.map((id) => [id, []]));
	replaySession(readRecording(text)!, ids.map(strategy), options({ ...overrides, trace: (id, request, step) => {
		found.get(id)?.splice(request, 1, step);
	} }));
	return found;
}

test("cache split: folds-v1/recorded reproduces every recorded cache read, cache write and uncached input, and every strategy's split adds up to what it sent", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const usage = usagesOf(text);
	const all = benchStrategies().map((spec) => spec.id);
	const found = traces(text, all);
	const recorded = found.get("folds-v1/recorded")!;
	usage.forEach((expected, request) => {
		assert.deepEqual([recorded[request]!.cacheRead, recorded[request]!.cacheWrite, recorded[request]!.input], [expected.cacheRead, expected.cacheWrite, expected.input], `request ${request}`);
	});
	for (const [id, steps] of found) {
		assert.equal(steps.length, usage.length, id);
		steps.forEach((step, request) => assert.equal(step.cacheRead + step.cacheWrite + step.input, step.size + step.sayTokens, `${id} request ${request}`));
	}
});

test("cache split: a strategy that kept more context reads its own previous request from the cache, not the recording's", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const usage = usagesOf(text);
	const sizes = recordedSizes(FOLD_SESSION);
	const kept = traces(text, ["compaction-only-v1"]).get("compaction-only-v1")!;
	let checked = 0;
	// The recording folded at request 15; compaction-only never folds, so from there on it sends more.
	for (let request = 16; request < usage.length; request++) {
		if (usage[request]!.cacheRead === 0 || sizes[request - 1] === 0) continue;
		const gap = kept[request - 1]!.size - sizes[request - 1]!;
		assert.ok(gap > 50_000, `request ${request - 1}: compaction-only keeps ${gap} more tokens`);
		const expected = usage[request]!.cacheRead + gap;
		assert.ok(Math.abs(kept[request]!.cacheRead - expected) <= 2, `request ${request}: read ${kept[request]!.cacheRead}, expected ${expected}`);
		checked++;
	}
	assert.ok(checked >= 5, `checked ${checked} warm requests`);
});

test("cache split: the request a stand-in fold applies to writes the new summary and everything after it to the cache", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const usage = usagesOf(text);
	const steps = traces(text, ["folds-v1/growth-50k"]).get("folds-v1/growth-50k")!;
	// The stand-in folds on the request after its nudge.
	const nudged = steps.findIndex((step) => step.sayTokens > 0);
	assert.ok(nudged > 0 && nudged + 1 < steps.length, "the nudge fires before the last request");
	const folded = steps[nudged + 1]!;
	// Its summary has the length of the recorded fold's carrier, at about four characters per token.
	const recording = readRecording(text)!;
	const summaryTokens = Math.floor(recording.folds[0]!.carrierChars / 4);
	assert.ok(summaryTokens > 500);
	assert.ok(folded.size < steps[nudged]!.size, "the fold made the request smaller");
	assert.ok(folded.cacheWrite >= summaryTokens, `wrote ${folded.cacheWrite}, the summary alone is about ${summaryTokens}`);
	assert.ok(folded.cacheWrite > 5 * usage[nudged + 1]!.cacheWrite, `wrote ${folded.cacheWrite}; the recording wrote ${usage[nudged + 1]!.cacheWrite}`);
});

test("cache split: after failed requests, a warm request reads what the strategy itself last sent (CR-BENCH-FAILED-REQUEST-PREFIX)", () => {
	const lines = fs.readFileSync(FOLD_SESSION, "utf8").trimEnd().split("\n");
	const requests = lines.flatMap((line, index) => {
		const parsed = JSON.parse(line) as FileLine;
		return parsed.type === "message" && parsed.message?.role === "assistant" ? [index] : [];
	});
	const sizes = recordedSizes(FOLD_SESSION);
	assert.deepEqual([sizes[21], sizes[22]], [0, 0], "requests 21 and 22 failed");
	// Make request 23, recorded cold, warm: the cache held what request 20 sent.
	const line = JSON.parse(lines[requests[23]!]!) as { message: { usage: { cacheRead: number; cacheWrite: number } } };
	assert.equal(line.message.usage.cacheRead, 0, "request 23 is recorded cold");
	const written = 2_016;
	line.message.usage.cacheRead = line.message.usage.cacheWrite - written;
	line.message.usage.cacheWrite = written;
	lines[requests[23]!] = JSON.stringify(line);
	const found = traces(`${lines.join("\n")}\n`, ["folds-v1/recorded", "compaction-only-v1"]);
	assert.equal(found.get("folds-v1/recorded")![23]!.cacheWrite, written);
	// compaction-only sends more than the recording, but no more than it sent at request 20 is new.
	const kept = found.get("compaction-only-v1")!;
	assert.ok(kept[23]!.size - sizes[23]! > 50_000);
	assert.ok(Math.abs(kept[23]!.cacheWrite - written) <= 2, `compaction-only wrote ${kept[23]!.cacheWrite} at request 23`);
});

test("folds-v1/recorded applies every recorded fold on a request, more than 64 of them and written identically, as recorded", () => {
	// Copy the fixture's one fold 70 times, each copy with its own entry ids, right after the original: one
	// request then has 71 recorded folds with the same range and summary.
	const lines = fs.readFileSync(FOLD_SESSION, "utf8").trimEnd().split("\n");
	const entries = lines.map((line) => JSON.parse(line) as { type: string; id: string; parentId: string | null });
	const meta = entries.findIndex((entry) => entry.type === "custom");
	let first = meta;
	while (entries[first - 1]!.type === "context_edit") first--;
	assert.ok(meta - first > 10, "the fold hides a range");
	const copies = 70;
	const added: string[] = [];
	let parent = entries[meta]!.id;
	for (let copy = 1; copy <= copies; copy++) {
		for (const entry of entries.slice(first, meta + 1)) {
			const id = `${entry.id}-copy${copy}`;
			added.push(JSON.stringify({ ...entry, id, parentId: parent }));
			parent = id;
		}
	}
	const after = entries.slice(meta + 1).map((entry) => JSON.stringify(entry.parentId === entries[meta]!.id ? { ...entry, parentId: parent } : entry));
	const text = `${[...lines.slice(0, meta + 1), ...added, ...after].join("\n")}\n`;
	const recording = readRecording(text)!;
	assert.equal(recording.folds.length, copies + 1);
	assert.equal(new Set(recording.folds.map((fold) => fold.request)).size, 1, "every fold is due on one request");
	const result = replaySession(recording, [strategy("folds-v1/recorded")], options());
	assert.equal(result.strategies[0]!.folds, copies + 1);
	// The copies change nothing the request carries: every request is the size the one-fold fixture gives.
	const once = traces(fs.readFileSync(FOLD_SESSION, "utf8"), ["folds-v1/recorded"]).get("folds-v1/recorded")!.map((step) => step.size);
	assert.deepEqual(traces(text, ["folds-v1/recorded"]).get("folds-v1/recorded")!.map((step) => step.size), once);
});

test("every view the bench extends without a full build equals a full build of the same branch", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8") + fs.readFileSync(path.join(FIXTURES, "recall-tail.txt"), "utf8");
	const recording = readRecording(text)!;
	for (const child of [false, true]) {
		assert.doesNotThrow(() => replaySession(recording, benchStrategies(), options({ child, checkIncremental: true })));
	}
});

test("the stand-in growth-50k nudge fires on the requests the kernel's own nudge pass fires on, until the stand-in's first fold", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const recording = readRecording(text)!;
	const steps = traces(text, ["folds-v1/growth-50k"]).get("folds-v1/growth-50k")!;
	const standIn = steps.flatMap((step, request) => (step.sayTokens > 0 ? [request] : []));
	assert.ok(standIn.length > 0);
	// The stand-in replays the branch without the recorded folds and folds on the request after its first nudge;
	// the kernel pass sees that same branch, at the stand-in's request sizes, up to that fold.
	const strip = new Set(recording.folds.flatMap((fold) => fold.entryIndexes));
	const memory = createFoldTurnMemory();
	const kernel: string[] = [];
	for (const [ordinal, request] of recording.requests.entries()) {
		if (ordinal > standIn[0]!) break;
		const kept = recording.path.slice(0, request.pathIndex).filter((_, index) => !strip.has(index));
		const entries = kept.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : kept[index - 1]!.id }) as SessionEntry);
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const leaf = entries[entries.length - 1]!.id;
		const result = prepareFoldTurn({
			messages: buildSessionContext(entries, leaf, byId).messages.filter((message) => message.role !== "system"),
			projection: buildSessionProjection(entries, leaf, byId),
			branch: entries,
			contextEntries: buildContextEntries(entries, leaf, byId),
			model: { contextWindow: 1_000_000 },
			systemPromptTokens: 0,
			hostTokens: steps[ordinal]!.size,
			memory,
		});
		assert.ok(result, `request ${ordinal} lines up with the projection`);
		if (result.nudge !== undefined) kernel.push(`${ordinal}:${String(result.nudgeKind)}`);
	}
	assert.deepEqual(kernel, [`${standIn[0]}:tier1`]);
});

/** One turn's tool steps: each result's size in characters, or the result's size and the characters of thinking before the call. */
type SyntheticTurn = readonly (number | { readonly chars: number; readonly thinking: number })[];

/**
 * A synthetic main session, written for the nudge comparison below. Each turn is a user message, one tool
 * call and result per entry of the turn (the entry is the result's size in characters), and a closing
 * answer. Its recorded sizes follow its branch: a 20,000-token system prompt plus one token per four
 * characters of what the branch holds, so the strategies and the kernel see the same growth.
 */
function syntheticSession(turns: readonly SyntheticTurn[], model: { readonly provider: string; readonly id: string } = { provider: "anthropic", id: "claude-opus-5-5" }): string {
	const start = Date.parse("2026-11-01T00:00:00.000Z");
	const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "synthetic", timestamp: new Date(start).toISOString(), cwd: "/redacted/project" })];
	let parent: string | null = null;
	let count = 0;
	let size = 20_000;
	let previous = 0;
	const filler = (chars: number) => "word ".repeat(Math.ceil(chars / 5)).slice(0, chars);
	const push = (message: Record<string, unknown>, chars: number) => {
		const id = `e${++count}`;
		const at = start + count * 1_000;
		lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } }));
		parent = id;
		size += Math.ceil(chars / 4);
	};
	const assistant = (content: unknown[], chars: number, stopReason: string) => {
		const usage = { input: 0, output: Math.ceil(chars / 4), cacheRead: previous, cacheWrite: size - previous };
		previous = size;
		push({ role: "assistant", content, provider: model.provider, model: model.id, api: "anthropic-messages", usage, stopReason }, chars);
	};
	turns.forEach((results, turn) => {
		push({ role: "user", content: [{ type: "text", text: `${filler(400)} turn ${turn}` }] }, 400);
		results.forEach((result, step) => {
			const callId = `call-${turn}-${step}`;
			const chars = typeof result === "number" ? result : result.chars;
			const thinking = typeof result === "number" ? 0 : result.thinking;
			const thought = thinking > 0 ? [{ type: "thinking", thinking: filler(thinking) }] : [];
			assistant([...thought, { type: "toolCall", id: callId, name: "bash", arguments: { command: `step ${turn} ${step}` } }], 60 + thinking, "toolUse");
			push({ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: filler(chars) }], isError: false }, chars);
		});
		assistant([{ type: "text", text: filler(600) }], 600, "stop");
	});
	return `${lines.join("\n")}\n`;
}

/**
 * Every tier-1 nudge the stand-in shows, and every nudge the kernel's own fold pass (`prepareFoldTurn`, the
 * code the live `context` hook runs) shows on the same requests: on the stand-in's simulated branch, folds
 * included, at the stand-in's request sizes.
 */
function nudgeSequences(text: string, id: string, overrides: Partial<ReplayOptions> = {}): { standIn: string[]; kernel: string[] } {
	const recording = readRecording(text)!;
	const window = registryPriceBook().lookup(recording.requests[0]!.provider, recording.requests[0]!.model)!.contextWindow;
	const memory = createFoldTurnMemory();
	const standIn: string[] = [];
	const kernel: string[] = [];
	replaySession(recording, [strategy(id)], options({ ...overrides, trace: (traced, request, step, branch) => {
		if (traced !== id) return;
		if (step.sayTokens > 0) standIn.push(`${request}`);
		const entries = [...branch];
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const leaf = entries[entries.length - 1]!.id;
		const result = prepareFoldTurn({
			messages: buildSessionContext(entries, leaf, byId).messages.filter((message) => message.role !== "system"),
			projection: buildSessionProjection(entries, leaf, byId),
			branch: entries,
			contextEntries: buildContextEntries(entries, leaf, byId),
			model: { contextWindow: window },
			systemPromptTokens: 0,
			hostTokens: step.size,
			memory,
		});
		assert.ok(result, `request ${request} lines up with the projection`);
		if (result.nudge !== undefined) kernel.push(result.nudgeKind === "tier1" ? `${request}` : `${request}:${String(result.nudgeKind)}`);
	} }));
	return { standIn, kernel };
}

const steady = (turns: number, steps: number, chars: number): SyntheticTurn[] => Array.from({ length: turns }, () => Array.from({ length: steps }, () => chars));

/** Sessions that reach the nudge's paths: steady growth over many turns, one long turn, mixed result sizes, and a 200k window. */
const NUDGE_SESSIONS: Readonly<Record<string, string>> = {
	steady: syntheticSession(steady(14, 6, 12_000)),
	longTurn: syntheticSession([...steady(2, 4, 8_000), Array.from({ length: 60 }, () => 9_000), ...steady(3, 4, 8_000)]),
	mixed: syntheticSession(Array.from({ length: 16 }, (_, turn) => Array.from({ length: 5 }, (_, step) => (turn * 7 + step * 13) % 5 === 0 ? 40_000 : 600 + ((turn * 31 + step * 17) % 9) * 1_500))),
	smallWindow: syntheticSession(steady(12, 5, 10_000), { provider: "anthropic", id: "claude-opus-4-5" }),
};


/** Stand-in fold summaries as long as the kernel allows: a fold then saves less than the growth threshold. */
const LONG_SUMMARIES: Partial<ReplayOptions> = { fallbackFoldSummaryChars: 20_000 };

test("the stand-in growth nudges match the kernel's own nudge pass over the whole sequence, folds included, on several sessions (CR-BENCH-STANDIN-NUDGE-NOT-KERNEL)", () => {
	const compared: Record<string, string[]> = {};
	const fixture = fs.readFileSync(FOLD_SESSION, "utf8");
	const runs = [
		...Object.entries(NUDGE_SESSIONS).map(([name, text]) => [name, text, {}] as const),
		["longTurn+longSummaries", NUDGE_SESSIONS.longTurn!, LONG_SUMMARIES] as const,
		["fixture", fixture, {}] as const,
		["thinking", syntheticSession(Array.from({ length: 14 }, () => Array.from({ length: 6 }, (_, step) => (step % 2 === 0 ? { chars: 400, thinking: 16_000 } : 9_000)))), {}] as const,
	];
	for (const [name, text, overrides] of runs) {
		const { standIn, kernel } = nudgeSequences(text, "folds-v1/growth-50k", overrides);
		// Tier-2 and tier-3 nudges are not modeled (NOT_MEASURED); after the kernel's first one, its stamps differ.
		const modeled = kernel.findIndex((nudge) => nudge.includes(":"));
		const last = modeled < 0 ? Infinity : Number(kernel[modeled]!.split(":")[0]);
		const expected = modeled < 0 ? kernel : kernel.slice(0, modeled);
		assert.deepEqual(standIn.filter((request) => Number(request) < last), expected, `${name}: stand-in ${standIn.join(",")}, kernel ${kernel.join(",")}`);
		compared[name] = expected;
	}
	// The sessions reach what the nudge does: several nudges with folds between, a second nudge in one turn, and the 200k window's bands.
	assert.ok(Object.entries(compared).every(([name, nudges]) => name === "fixture" || nudges.length >= 2), JSON.stringify(compared));
});

test("the stand-in's pending counts only ranges a fold can name, as the kernel offers them", () => {
	const nudge = standInFoldsRecipe({ growthTokens: null, usageFloor: 0, nudgeTokens: 1_800, compactionFraction: 0.9 }, { recordedFolds: [], foldSummaryChars: 2_000, compactionSummaryChars: 8_000, toolOutput: () => undefined }).recipe.stages.find((stage) => stage.id === "growth-nudge")!;
	const entry = (id: string, role: ViewEntry["role"], tokens: number, extra: Partial<ViewEntry> = {}): ViewEntry => ({ id, role, tokens, hint: null, ...extra });
	const view = (tokens: number, entries: readonly ViewEntry[]): ContextView => Object.freeze({ entries, pressure: tokens / 1_000_000, unownedTokens: 0, cacheAgeMs: null, model: { id: "m", contextWindow: 1_000_000 }, tools: ["context_fold"], registeredTools: ["context_fold"], folds: [], hides: [], protectedEntryIds: [entries[entries.length - 1]!.id], compactionOwner: "none" }) as ContextView;
	const latest = entry("u1", "user", 100);
	// 70k tokens of growth since the first request, in a run of assistant text and custom messages: no entry
	// in it is a message a fold can name as an end, so no fold could take it.
	const nameless = [entry("a1", "assistant", 35_000), entry("c1", "custom", 35_000), latest];
	assert.equal(nudge.wants(view(20_000, [latest])), null, "the first request sets the baseline");
	assert.equal(nudge.wants(view(90_000, nameless)), null, "a run no fold can name is not pending");
	// The same growth in a run with a tool result in it is pending, and the nudge fires.
	const named = [entry("a1", "assistant", 35_000), entry("r1", "toolResult", 35_000, { toolName: "bash", toolCallId: "t1" }), latest];
	assert.equal(nudge.wants(view(90_000, named)), "now");
});

test("a session over the size cap is listed with its size rather than replayed, and the token scale says how many sessions fell back to 1", async () => {
	const report = await runBench({ roots: [{ label: "fixture", dir: CORPUS }], maxSessionBytes: 1_000 });
	assert.deepEqual(report.skipped, [{ file: "fixture/fold-session/session.jsonl", bytes: fs.statSync(FOLD_SESSION).size, reason: "larger than the per-session cap of 1000 bytes" }]);
	assert.equal(report.corpus.hosts[0]!.sessions, 1);
	assert.equal(report.tokenScale.fitted + report.tokenScale.fellBackToOne, 1);
	assert.match(reportMarkdown(report), /## Sessions not replayed\n\n- `fixture\/fold-session\/session\.jsonl` \([\d,]+ bytes\): larger than the per-session cap/u);
	const full = await runBench({ roots: [{ label: "fixture", dir: CORPUS }] });
	assert.deepEqual(full.skipped, []);
	assert.equal(full.tokenScale.fitted, 1, "the fold session fits a scale");
	assert.equal(full.tokenScale.fellBackToOne, 1, "the one-request session cannot");
	assert.match(reportMarkdown(full), /1 sessions had too little growth to fit, or a fit outside \[0\.5, 3\], and use 1/u);
});

/**
 * The fold session with `drop` tokens taken off every recorded request from request `from` on: something
 * shrank what the requests carried and wrote nothing to the session file, as billion-context-pi's folds do
 * (it keeps its blocks in a side file). The branch still holds everything.
 */
function withUnrecordedDrop(drop: number, from: number): string {
	let ordinal = -1;
	const lines = fs.readFileSync(FOLD_SESSION, "utf8").trimEnd().split("\n").map((line) => {
		const entry = JSON.parse(line) as { type: string; message?: { role?: string; usage?: { input: number; cacheRead: number; cacheWrite: number } } };
		if (entry.type !== "message" || entry.message?.role !== "assistant") return line;
		const usage = entry.message.usage!;
		if (++ordinal < from || usage.input + usage.cacheRead + usage.cacheWrite === 0) return line;
		let left = drop;
		for (const field of ["cacheRead", "cacheWrite", "input"] as const) {
			const take = Math.min(left, usage[field]);
			usage[field] -= take;
			left -= take;
		}
		return JSON.stringify(entry);
	});
	return `${lines.join("\n")}\n`;
}

test("an unrecorded drop: the strategy tables do not credit a fold with tokens the recording never sent (CR-BENCH-UNSENT-CONTEXT-SAVINGS)", async () => {
	const dropped = withUnrecordedDrop(60_000, 15);
	const sizes = recordedSizes(FOLD_SESSION);
	// The fixture: from request 15 on, every request with usage carried 60,000 tokens less than the branch holds.
	const droppedSizes = usagesOf(dropped).map((usage) => usage.input + usage.cacheRead + usage.cacheWrite);
	sizes.forEach((size, request) => assert.equal(droppedSizes[request], request < 15 || size === 0 ? size : size - 60_000, `request ${request}`));
	// On it, growth-50k folds content that was never sent: the bias the strategy tables must not carry.
	const alone = replaySession(readRecording(dropped)!, [strategy("folds-v1/growth-50k"), strategy("folds-v1/floor-30")], options());
	assert.ok(alone.strategies[0]!.folds >= 1, "growth-50k folds on the dropped session");
	assert.equal(alone.strategies[1]!.folds, 0, "floor-30 does not");

	const clean = tempDir();
	const mixed = tempDir();
	for (const dir of [clean, mixed]) {
		fs.mkdirSync(path.join(dir, "a"));
		fs.copyFileSync(FOLD_SESSION, path.join(dir, "a", "session.jsonl"));
	}
	fs.mkdirSync(path.join(mixed, "b"));
	fs.writeFileSync(path.join(mixed, "b", "session.jsonl"), dropped);
	const cleanReport = await runBench({ roots: [{ label: "t", dir: clean }] });
	const mixedReport = await runBench({ roots: [{ label: "t", dir: mixed }] });
	// The tables the pi-context-aware#456 comparison reads hold only the session whose sizes follow its branch.
	for (const cls of ["all", "main"] as const) {
		assert.deepEqual(mixedReport.recorded[cls], cleanReport.recorded[cls], `recorded ${cls}`);
		mixedReport.strategies.forEach((one, index) => assert.deepEqual(one[cls], cleanReport.strategies[index]![cls], `${one.id} ${cls}`));
	}
	// The dropped session is accounted for apart, with the reason and its own figures.
	assert.deepEqual(mixedReport.sessionGroups.unmodelled, { sessions: 1, requests: 32, reasons: { "another-context-manager": 0, "usage-only-log": 0, "estimate-error": 1 } });
	assert.deepEqual(mixedReport.sessionGroups.modelled, { sessions: 1, requests: 32 });
	assert.equal(mixedReport.recorded.unmodelled.main.tokensSent, droppedSizes.reduce((sum, size) => sum + size, 0));
	const growth = mixedReport.strategies.find((one) => one.id === "folds-v1/growth-50k")!;
	assert.equal(growth.unmodelled.main.folds, alone.strategies[0]!.folds);
	assert.equal(growth.unmodelled.main.tokensSent, alone.strategies[0]!.tokensSent);
	const markdown = reportMarkdown(mixedReport);
	assert.match(markdown, /\| Not modelled \| 1 \| 1 \| 0 \| 32 \|/u);
	assert.match(markdown, /## Sessions the bench cannot model\n\nDo not compare strategies on these rows/u);
	assert.ok(!/Strategy figures do not use that estimate/u.test(markdown), "the report no longer says the estimate error leaves strategy figures alone");
});

test("a session in which billion-context-pi folded, and a usage log with no transcript, are not modelled; the fixture is", () => {
	const text = fs.readFileSync(FOLD_SESSION, "utf8");
	const clean = replaySession(readRecording(text)!, [], options());
	assert.deepEqual([clean.fidelity.modelled, clean.fidelity.reasons], [true, []]);
	assert.ok(clean.fidelity.estimateError < 0.05, `estimate error ${clean.fidelity.estimateError}`);
	// billion-context-pi's status line in a tool result, as its fold tool returns it.
	const lines = text.trimEnd().split("\n");
	const toolResult = lines.findIndex((line) => (JSON.parse(line) as FileLine).message?.role === "toolResult");
	const banner = (reclaimed: string) => {
		const entry = JSON.parse(lines[toolResult]!) as { message: { content: unknown } };
		entry.message.content = [{ type: "text", text: `▣ ACP | 59.7K → 7.1K tokens (~${reclaimed} reclaimed, blocks: b1=m00001–m00129)` }];
		return `${[...lines.slice(0, toolResult), JSON.stringify(entry), ...lines.slice(toolResult + 1)].join("\n")}\n`;
	};
	const folded = replaySession(readRecording(banner("52.6K"))!, [], options());
	assert.deepEqual([folded.fidelity.modelled, folded.fidelity.reasons], [false, ["another-context-manager"]]);
	assert.deepEqual(replaySession(readRecording(banner("0"))!, [], options()).fidelity.reasons, [], "a status line with nothing reclaimed is not a fold");
	// A Fabric worker's usage log: the session header and assistant messages only.
	const usageLog = lines.filter((line) => { const entry = JSON.parse(line) as FileLine; return entry.type !== "message" || entry.message?.role === "assistant"; });
	const log = replaySession(readRecording(`${usageLog.join("\n")}\n`)!, [], options({ child: true }));
	assert.equal(log.fidelity.modelled, false);
	assert.ok(log.fidelity.reasons.includes("usage-only-log"), log.fidelity.reasons.join(","));
});
