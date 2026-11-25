/**
 * The strategy bench's command line and program entry (pi-context-aware#469). It reads session files, replays
 * every strategy over them and prints the report to standard output: JSON by default, or the Markdown
 * rendering of a JSON report with `--render`. It writes no file.
 *
 *   node dist/strategy-runtime/bench/cli.js --corpus <label>=<dir> [--corpus ...] [--since <date>]
 *     [--until <time>] [--jobs <n>] [--recall-window <n>] [--metrics <dir>] [--max-session-mb <n>]
 *     [--external <label>=<program> ...] > report.json
 *   node dist/strategy-runtime/bench/cli.js --render report.json > report.md
 *   node dist/strategy-runtime/bench/cli.js --conformance <label>=<program>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

import { conformanceSubject, runConformance } from "./conformance.js";
import { listCorpus, type CorpusFile, type CorpusRoot } from "./corpus.js";
import { externalStrategy, externalStrategyId, type ExternalCommand } from "./external-strategy.js";
import { registryPriceBook, type PriceBook } from "./pricing.js";
import { benchStrategies, DEFAULT_BENCH_OPTIONS, type StrategySpec } from "./recipes.js";
import { readRecording } from "./recording.js";
import { replaySession, type SessionResult } from "./replay.js";
import { buildReport, reportJson, reportMarkdown, SessionTotals, type CorpusSummary, type Report, type SkippedSession } from "./report.js";

export interface BenchRun {
	readonly roots: readonly CorpusRoot[];
	/** Epoch milliseconds: files modified at or after this time. */
	readonly since?: number;
	/** Epoch milliseconds: entries stamped after this time are left out. */
	readonly until?: number;
	readonly recallWindow?: number;
	readonly coldCacheMs?: number;
	/** A metrics store directory (`<agent dir>/context-aware/metrics/v1`): optional; nudges it recorded are reported. */
	readonly metricsDir?: string;
	/** Override the corpus medians used for stand-in summaries. */
	readonly foldSummaryChars?: number;
	readonly compactionSummaryChars?: number;
	/** Worker threads; 1 runs in this thread. */
	readonly jobs?: number;
	/** Files at least this large replay as one task per strategy (default `HEAVY_BYTES`); the report does not depend on it. */
	readonly heavyBytes?: number;
	/** Session files larger than this many bytes are not replayed; the report lists each one. */
	readonly maxSessionBytes?: number;
	/** External strategies (external-strategy.ts), replayed after the built-in ones, in this order. */
	readonly external?: readonly ExternalCommand[];
	/** Called as files finish, with the phase; for progress output only. */
	readonly progress?: (phase: string, done: number, total: number) => void;
	/** Called with the file and stack of each session that failed; for progress output only. */
	readonly failed?: (failure: string) => void;
	/** Called with each session that took longer than `SLOW_SESSION_MS` to replay; for progress output only. */
	readonly slow?: (file: string, bytes: number, ms: number) => void;
}

/** Replays slower than this, summed over a heavy file's tasks, are reported through `BenchRun.slow`. */
export const SLOW_SESSION_MS = 60_000;
/** Files at least this large count as heavy: they replay as one task per strategy, and at most half the workers take heavy tasks at once, so their heaps fit in memory. */
const HEAVY_BYTES = 32 * 1024 * 1024;

const DEFAULT_RECALL_WINDOW = 20;
/** Anthropic's default prompt-cache lifetime. */
const DEFAULT_COLD_CACHE_MS = 5 * 60_000;
/** Used only when the corpus records no summary of a kind at all. */
const NO_RECORDED_FOLD_CHARS = 2_000;
const NO_RECORDED_COMPACTION_CHARS = 8_000;

interface Task {
	readonly phase: "sizes" | "replay";
	readonly file: CorpusFile;
	readonly until?: number;
	readonly recallWindow: number;
	readonly coldCacheMs: number;
	readonly foldSummaryChars: number;
	readonly compactionSummaryChars: number;
	readonly metricsDir?: string;
	/** Replay only this strategy (an index into `strategiesFor(external)`); a heavy file is split into one task per strategy. */
	readonly strategy?: number;
	readonly external?: readonly ExternalCommand[];
}

/** The built-in strategies, then one per external command. Throws when two external commands share a label. */
export function strategiesFor(external: readonly ExternalCommand[] = []): StrategySpec[] {
	const labels = new Set<string>();
	const externals = external.map((command) => {
		if (labels.has(command.label)) throw new Error(`two external strategies are labelled ${externalStrategyId(command.label)}`);
		labels.add(command.label);
		return externalStrategy({ label: command.label, file: command.file, ...(command.args === undefined ? {} : { args: [...command.args] }) });
	});
	return [...benchStrategies(), ...externals];
}

interface SizesResult {
	readonly requests: number;
	readonly foldChars: number[];
	readonly compactionChars: number[];
}

interface ReplayResult {
	readonly session: SessionResult | null;
	readonly nudges: Record<string, number> | null;
	readonly ms: number;
}

/** Nudges a session's metrics records hold, by kind; null when it has none. */
function metricsNudges(dir: string, sessionId: string, until: number | undefined): Record<string, number> | null {
	if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) return null;
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), "utf8");
	} catch {
		return null;
	}
	const nudges: Record<string, number> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: { at?: unknown; nudge?: unknown };
		try {
			record = JSON.parse(line) as { at?: unknown; nudge?: unknown };
		} catch {
			continue;
		}
		const at = typeof record.at === "string" ? Date.parse(record.at) : NaN;
		if (until !== undefined && !(at <= until)) continue;
		if (typeof record.nudge === "string" && /^[a-z0-9]{1,16}$/u.test(record.nudge)) nudges[record.nudge] = (nudges[record.nudge] ?? 0) + 1;
	}
	return nudges;
}

let prices: PriceBook | undefined;

function runTask(task: Task): SizesResult | ReplayResult {
	const started = Date.now();
	const recording = readRecording(fs.readFileSync(task.file.absolute, "utf8"), task.until === undefined ? {} : { until: task.until });
	if (task.phase === "sizes") {
		return {
			requests: recording?.requests.length ?? 0,
			foldChars: recording?.folds.filter((fold) => fold.record.tier === 1).map((fold) => fold.carrierChars) ?? [],
			compactionChars: recording?.compactions.map((compaction) => compaction.summaryChars) ?? [],
		};
	}
	if (!recording || recording.requests.length === 0) return { session: null, nudges: null, ms: Date.now() - started };
	prices ??= registryPriceBook();
	const all = strategiesFor(task.external);
	const session = replaySession(recording, task.strategy === undefined ? all : [all[task.strategy]!], {
		child: task.file.child,
		prices,
		recallWindow: task.recallWindow,
		coldCacheMs: task.coldCacheMs,
		fallbackFoldSummaryChars: task.foldSummaryChars,
		fallbackCompactionSummaryChars: task.compactionSummaryChars,
	});
	return { session, nudges: task.metricsDir === undefined ? null : metricsNudges(task.metricsDir, recording.sessionId, task.until), ms: Date.now() - started };
}

/**
 * Run every task and hand each result to `onResult` with the task's index, as it arrives. Several jobs
 * run in worker threads, largest files first, so a large session does not run alone at the end; at most
 * half the workers (`floor(jobs / 2)`, at least one) take heavy files at once. Worker heaps are not capped:
 * a corpus run with 24 jobs peaked at 26 GB resident.
 */
/** A task that threw: the file and the error's stack, so a failed run names the session that failed. */
interface TaskFailure {
	readonly failed: string;
}

const isFailure = (value: unknown): value is TaskFailure => typeof value === "object" && value !== null && "failed" in value;

function runTaskReporting(task: Task): SizesResult | ReplayResult | TaskFailure {
	try {
		return runTask(task);
	} catch (error) {
		return { failed: `${task.phase} ${task.file.label}/${task.file.relative}: ${error instanceof Error ? error.stack ?? error.message : String(error)}` };
	}
}

async function runTasks<T>(tasks: readonly Task[], jobs: number, heavyBytes: number, onResult: (index: number, result: T | TaskFailure) => void, progress?: (done: number, total: number) => void): Promise<void> {
	if (jobs <= 1) {
		tasks.forEach((task, index) => {
			onResult(index, runTaskReporting(task) as T | TaskFailure);
			progress?.(index + 1, tasks.length);
		});
		return;
	}
	const pending = tasks.map((_, index) => index).sort((a, b) => tasks[b]!.file.bytes - tasks[a]!.file.bytes || a - b);
	const heavy = (index: number): boolean => tasks[index]!.file.bytes >= heavyBytes;
	const maxHeavy = Math.max(1, Math.floor(jobs / 2));
	let heavyRunning = 0;
	let done = 0;
	const workers = Array.from({ length: Math.min(jobs, tasks.length) }, () => new Worker(fileURLToPath(import.meta.url)));
	const idle: Worker[] = [];
	const current = new Map<Worker, number>();
	try {
		await new Promise<void>((resolve, reject) => {
			const dispatch = () => {
				while (idle.length > 0) {
					const at = pending.findIndex((index) => !heavy(index) || heavyRunning < maxHeavy);
					if (at < 0) break;
					const index = pending.splice(at, 1)[0]!;
					if (heavy(index)) heavyRunning++;
					const worker = idle.pop()!;
					current.set(worker, index);
					worker.postMessage(tasks[index]);
				}
				if (done === tasks.length) resolve();
			};
			for (const worker of workers) {
				worker.on("message", (result: T | TaskFailure) => {
					const index = current.get(worker)!;
					current.delete(worker);
					if (heavy(index)) heavyRunning--;
					try {
						onResult(index, result);
					} catch (error) {
						reject(error);
						return;
					}
					progress?.(++done, tasks.length);
					idle.push(worker);
					dispatch();
				});
				worker.on("error", reject);
				idle.push(worker);
			}
			dispatch();
		});
	} finally {
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}

function median(values: readonly number[], fallback: number): number {
	if (values.length === 0) return fallback;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

const isoOrNull = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** Replay the corpus and build the report. The same corpus and options give the same report. */
export async function runBench(run: BenchRun): Promise<Report> {
	const files = listCorpus(run.roots, run.since === undefined ? {} : { since: run.since });
	const jobs = Math.max(1, Math.floor(run.jobs ?? 1));
	const base = {
		...(run.until === undefined ? {} : { until: run.until }),
		recallWindow: run.recallWindow ?? DEFAULT_RECALL_WINDOW,
		coldCacheMs: run.coldCacheMs ?? DEFAULT_COLD_CACHE_MS,
		...(run.metricsDir === undefined ? {} : { metricsDir: run.metricsDir }),
		...(run.external === undefined ? {} : { external: run.external }),
	};
	// Every strategy is built once here, so a bad external command fails before any session is read.
	const strategies = strategiesFor(run.external);
	// Files over the cap are not read at all; the report lists each one.
	const cap = run.maxSessionBytes;
	const skipped: SkippedSession[] = cap === undefined ? [] : files.filter((file) => file.bytes > cap).map((file) => ({ file: `${file.label}/${file.relative}`, bytes: file.bytes, reason: `larger than the per-session cap of ${cap} bytes` }));
	const kept = cap === undefined ? files : files.filter((file) => file.bytes <= cap);
	const sizes = new Array<SizesResult>(kept.length);
	// A session the bench cannot read or replay is listed with the error's first line, and the run goes on.
	const failed = (file: CorpusFile, failure: TaskFailure) => {
		run.failed?.(failure.failed);
		const first = failure.failed.split("\n")[0]!;
		const line = first.slice(first.indexOf(": ") + 2).replace(/[^\x20-\x7e]/gu, "?");
		skipped.push({ file: `${file.label}/${file.relative}`, bytes: file.bytes, reason: `replay failed: ${line.length > 200 ? `${line.slice(0, 200)}...` : line}` });
	};
	const heavyBytes = run.heavyBytes ?? HEAVY_BYTES;
	await runTasks<SizesResult>(kept.map((file) => ({ ...base, phase: "sizes", file, foldSummaryChars: 0, compactionSummaryChars: 0 })), jobs, heavyBytes, (index, result) => {
		if (isFailure(result)) {
			failed(kept[index]!, result);
			sizes[index] = { requests: 0, foldChars: [], compactionChars: [] };
		} else sizes[index] = result;
	}, (done, total) => run.progress?.("sizes", done, total));
	const foldSummaryChars = run.foldSummaryChars ?? median(sizes.flatMap((size) => size.foldChars), NO_RECORDED_FOLD_CHARS);
	const compactionSummaryChars = run.compactionSummaryChars ?? median(sizes.flatMap((size) => size.compactionChars), NO_RECORDED_COMPACTION_CHARS);
	const replayFiles = kept.filter((_, index) => sizes[index]!.requests > 0);

	// Each session's results are added to the totals as they arrive and then dropped.
	const totals = new SessionTotals(strategies.length);
	const corpus = new Map<string, { sessions: number; mainSessions: number; childSessions: number; requests: number }>();
	for (const root of run.roots) corpus.set(root.label, { sessions: 0, mainSessions: 0, childSessions: 0, requests: 0 });
	let metricsSessions = 0;
	const nudges: Record<string, number> = {};
	// A heavy file replays as one task per strategy, so its strategies run side by side; each task replays the
	// baseline again. Its parts are put back together, in strategy order, before the session is added.
	const tasks: Task[] = replayFiles.flatMap((file, fileIndex) => (file.bytes >= heavyBytes
		? strategies.map((_, strategy): Task & { fileIndex: number } => ({ ...base, phase: "replay", file, foldSummaryChars, compactionSummaryChars, strategy, fileIndex }))
		: [{ ...base, phase: "replay" as const, file, foldSummaryChars, compactionSummaryChars, fileIndex }]));
	const parts = new Map<number, { results: (ReplayResult | undefined)[]; arrived: number; ms: number }>();
	const failedFiles = new Set<number>();
	await runTasks<ReplayResult>(tasks, jobs, heavyBytes, (taskIndex, part) => {
		const task = tasks[taskIndex]! as Task & { fileIndex: number };
		const file = task.file;
		if (failedFiles.has(task.fileIndex)) return;
		if (isFailure(part)) {
			failedFiles.add(task.fileIndex);
			parts.delete(task.fileIndex);
			failed(file, part);
			return;
		}
		let replay: ReplayResult = part;
		if (task.strategy !== undefined) {
			const held = parts.get(task.fileIndex) ?? { results: new Array<ReplayResult | undefined>(strategies.length), arrived: 0, ms: 0 };
			held.results[task.strategy] = part;
			held.arrived++;
			held.ms += part.ms;
			parts.set(task.fileIndex, held);
			if (held.arrived < strategies.length) return;
			parts.delete(task.fileIndex);
			const first = held.results[0]!;
			replay = { nudges: first.nudges, ms: held.ms, session: first.session && { ...first.session, strategies: held.results.map((result) => result!.session!.strategies[0]!) } };
		}
		if (replay.ms > SLOW_SESSION_MS) run.slow?.(`${file.label}/${file.relative}`, file.bytes, replay.ms);
		if (!replay.session) return;
		const host = corpus.get(file.label)!;
		host.sessions++;
		if (replay.session.child) host.childSessions++;
		else host.mainSessions++;
		host.requests += replay.session.requests;
		totals.add(replay.session);
		if (replay.nudges) {
			metricsSessions++;
			for (const [kind, n] of Object.entries(replay.nudges)) nudges[kind] = (nudges[kind] ?? 0) + n;
		}
	}, (done, total) => run.progress?.("replay", done, total));
	// Failures arrive in the order workers finish: list them in file order.
	skipped.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	const sortedNudges: Record<string, number> = {};
	for (const kind of Object.keys(nudges).sort()) sortedNudges[kind] = nudges[kind]!;
	return buildReport({
		corpus: [...corpus.entries()].map(([label, host]): CorpusSummary => ({ label, ...host })),
		slice: { since: isoOrNull(run.since), until: isoOrNull(run.until) },
		price: (prices ??= registryPriceBook()).source,
		options: { ...DEFAULT_BENCH_OPTIONS, recallWindow: base.recallWindow, coldCacheMs: base.coldCacheMs },
		summarySizes: { foldSummaryChars, compactionSummaryChars },
		strategies,
		totals,
		skipped,
		...(run.metricsDir === undefined ? {} : { metrics: { sessions: metricsSessions, nudges: sortedNudges } }),
	});
}

export type CliResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

const USAGE = "usage: cli.js --corpus <label>=<dir> [--corpus ...] [--since <date>] [--until <time>] [--jobs <n>] [--recall-window <n>] [--metrics <dir>] [--max-session-mb <n>] [--external <label>=<program> ...] | --render <report.json> | --conformance <label>=<program>";

/** `<label>=<value>`, both non-empty. */
function labelled(value: string, flag: string, what: string): { label: string; value: string } {
	const at = value.indexOf("=");
	if (at <= 0 || at === value.length - 1) throw new Error(`${flag} takes <label>=<${what}>, got ${value.slice(0, 80).replace(/[^\x20-\x7e]/gu, "?")}`);
	return { label: value.slice(0, at), value: value.slice(at + 1) };
}

/** An external program the operator named: the label checked, the path made absolute. */
function externalArg(value: string, flag: string): ExternalCommand {
	const { label, value: file } = labelled(value, flag, "program");
	externalStrategyId(label);
	return { label, file: path.resolve(file) };
}

function timeArg(value: string, name: string): number {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new Error(`${name} must be a date or time, got ${value.slice(0, 40)}`);
	return ms;
}

function countArg(value: string, name: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1, got ${value.slice(0, 40)}`);
	return n;
}

/** Run the command line: the text to print, or an error. */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
	try {
		const roots: CorpusRoot[] = [];
		const run: { -readonly [K in keyof BenchRun]?: BenchRun[K] } = {};
		for (let i = 0; i < argv.length; i++) {
			const flag = argv[i]!;
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			i++;
			if (flag === "--render") return { ok: true, text: reportMarkdown(JSON.parse(fs.readFileSync(value, "utf8")) as Report) };
			if (flag === "--conformance") {
				// The suite's result, as JSON; any finding fails the command.
				const result = runConformance(conformanceSubject(externalStrategy(externalArg(value, flag))));
				const text = `${JSON.stringify(result, null, 2)}\n`;
				return result.findings.length === 0 ? { ok: true, text } : { ok: false, error: text };
			}
			if (flag === "--corpus") {
				const { label, value: dir } = labelled(value, flag, "dir");
				roots.push({ label, dir });
			} else if (flag === "--external") run.external = [...(run.external ?? []), externalArg(value, flag)];
			else if (flag === "--since") run.since = timeArg(value, flag);
			else if (flag === "--until") run.until = timeArg(value, flag);
			else if (flag === "--jobs") run.jobs = countArg(value, flag);
			else if (flag === "--recall-window") run.recallWindow = countArg(value, flag);
			else if (flag === "--metrics") run.metricsDir = value;
			else if (flag === "--max-session-mb") run.maxSessionBytes = countArg(value, flag) * 1024 * 1024;
			else throw new Error(`unknown option ${flag.slice(0, 40)}\n${USAGE}`);
		}
		if (roots.length === 0) throw new Error(USAGE);
		// Progress goes to standard error, every 250 files, so standard output holds only the report.
		const progress = (phase: string, done: number, total: number) => {
			if (done % 250 === 0 || done === total) console.error(`${phase}: ${done}/${total} files`);
		};
		const slow = (file: string, bytes: number, ms: number) => console.error(`slow session: ${file} (${(bytes / 1024 / 1024).toFixed(1)} MB) took ${(ms / 1000).toFixed(0)} s`);
		const failed = (failure: string) => console.error(`session failed: ${failure}`);
		return { ok: true, text: reportJson(await runBench({ ...run, roots, progress, slow, failed })) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

if (!isMainThread) {
	parentPort?.on("message", (task: Task) => parentPort?.postMessage(runTaskReporting(task)));
} else if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await runCli(process.argv.slice(2));
	if (result.ok) console.log(result.text.replace(/\n$/u, ""));
	else {
		console.error(result.error);
		process.exitCode = 2;
	}
}
