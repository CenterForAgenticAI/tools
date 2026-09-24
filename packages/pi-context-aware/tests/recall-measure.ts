/**
 * Reproducible cost/latency measurement core for the `recall` tool
 * (REQ-RECALL-007). Importable so a test can execute it and pin its invariants
 * (see tests/recall.test.ts); the CLI wrapper is tests/bench-recall.mjs.
 *
 * Design decisions, forced by three review rounds:
 *
 * - The direct-read baseline is Pi's **real** read tool
 *   (`createReadToolDefinition`), invoked, not a hand-rolled truncation. So the
 *   baseline is exactly the characters a caller receives, truncation notice and
 *   all.
 * - Latency is symmetric: both paths get the same warm-up and repeat count, each
 *   timed after its own warm-up.
 * - The corpus fingerprint hashes every file's **content** — cache documents and
 *   transcripts alike — so it detects any drift, and so a run over a committed
 *   immutable fixture reproduces exactly (the digest is content-addressed, not
 *   mtime- or path-based).
 * - Reproducibility over the live `~/.pi/agent` stores is impossible by
 *   construction: they mutate under the benchmark. The fixture run carries the
 *   reproducible figure; a live run is a point-in-time observation.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	createReadToolDefinition,
	truncateHead,
	DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import {
	answerRecall,
	compareRecallCost,
	recallOutputCharacters,
	citedSourcePaths,
	type RecallCachePool,
	type RecallSession,
} from "../recall.js";

export interface RecallMeasureOptions {
	readonly question: string;
	readonly cacheRoot: string;
	readonly sessionsRoot: string;
	/** Path substring marking the project; empty/undefined includes everything (fixture mode). */
	readonly project?: string;
	readonly allProjects?: boolean;
	readonly warmups: number;
	readonly repeats: number;
	readonly maxSessions?: number;
}

export interface LatencyStat {
	readonly median: number;
	readonly min: number;
	readonly max: number;
	readonly samples: readonly number[];
}

export interface CitedFileMeasure {
	readonly pathHash: string;
	readonly store: "context-cache" | "prior-session" | undefined;
	readonly readable: boolean;
	readonly bytes?: number;
	readonly chars?: number;
	readonly contentSha256?: string;
	readonly boundedChars?: number;
	readonly boundedTruncated?: boolean;
	readonly wholeFileReads?: number;
	readonly excerptReachable?: "first-page" | "beyond-first-page" | "unknown";
}

export interface CorpusFingerprint {
	readonly cacheDocuments: number;
	readonly transcripts: number;
	readonly candidateFiles: number;
	readonly candidateBytes: number;
	/** Content-addressed digest: sha256 over sorted `sha256(content):bytes`. */
	readonly digest: string;
}

export interface RecallMeasureResult {
	readonly question: string;
	readonly found: boolean;
	readonly citations: number;
	readonly citedFiles: readonly CitedFileMeasure[];
	readonly distinctOutputs: number;
	readonly repeatIdentical: boolean;
	readonly scannedCacheDocuments: number;
	readonly scannedSessions: number;
	readonly recallChars: number;
	readonly recallTokens: number;
	/** Primary baseline: one real read-tool call per distinct cited file. */
	readonly baselineBoundedChars: number;
	/** Upper-bound baseline: every character of the cited file(s). */
	readonly baselineFullChars: number;
	/** The headline denominator. Always equals baselineBoundedChars; the guard test pins this. */
	readonly primaryBaselineChars: number;
	readonly wholeFileReads: number;
	readonly boundedRatio: number;
	readonly boundedSaves: boolean;
	readonly fullRatio: number;
	readonly degenerateBaseline: boolean;
	readonly recallLatency: LatencyStat;
	readonly directLatency: LatencyStat;
	readonly corpus: CorpusFingerprint;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stat(samples: number[]): LatencyStat {
	return { median: median(samples), min: samples.length ? Math.min(...samples) : 0, max: samples.length ? Math.max(...samples) : 0, samples };
}

/** Pools under cacheRoot with a manifest; project-filtered unless project is empty. */
function discoverCachePools(cacheRoot: string, project: string | undefined): RecallCachePool[] {
	if (!fs.existsSync(cacheRoot)) return [];
	const pools: RecallCachePool[] = [];
	for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const cacheDir = path.join(cacheRoot, entry.name);
		const manifest = path.join(cacheDir, "_manifest.json");
		if (!fs.existsSync(manifest)) continue;
		if (project) {
			try {
				if (!fs.readFileSync(manifest, "utf8").toLowerCase().includes(project.toLowerCase())) continue;
			} catch {
				continue;
			}
		}
		pools.push({ cacheDir, originScope: "worktree" });
	}
	return pools;
}

/** *.jsonl transcripts under sessionsRoot, newest first, optionally project-filtered. */
function discoverSessions(sessionsRoot: string, project: string | undefined, limit: number): RecallSession[] {
	if (!fs.existsSync(sessionsRoot)) return [];
	const found: Array<{ path: string; mtimeMs: number }> = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { walk(full); continue; }
			if (!entry.isFile() || !full.endsWith(".jsonl")) continue;
			if (project && !full.toLowerCase().includes(project.toLowerCase())) continue;
			try { found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
		}
	};
	walk(sessionsRoot);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found.slice(0, limit).map((s) => ({ path: s.path, cwd: path.dirname(s.path) }));
}

/** Every cache document file listed in each pool's manifest that resolves to a real file. */
function cacheDocumentPaths(pools: readonly RecallCachePool[]): string[] {
	const docs: string[] = [];
	for (const pool of pools) {
		let manifest: unknown;
		try { manifest = JSON.parse(fs.readFileSync(path.join(pool.cacheDir, "_manifest.json"), "utf8")); } catch { continue; }
		const files = (manifest as { files?: unknown }).files;
		if (!files || typeof files !== "object") continue;
		for (const name of Object.keys(files as Record<string, unknown>)) {
			if (name === "_manifest.json") continue;
			const p = path.join(pool.cacheDir, name);
			if (fs.existsSync(p)) docs.push(p);
		}
	}
	return docs;
}

/** Content-addressed digest over cache documents + fed transcripts. Reproducible; detects any content drift. */
function corpusFingerprint(cacheDocs: readonly string[], sessions: readonly RecallSession[]): CorpusFingerprint {
	const entries: Array<{ sha: string; bytes: number }> = [];
	const stampFiles = (paths: readonly string[]): void => {
		for (const p of paths) {
			try {
				const buf = fs.readFileSync(p);
				entries.push({ sha: sha256(buf), bytes: buf.length });
			} catch { /* skip unreadable */ }
		}
	};
	stampFiles(cacheDocs);
	stampFiles(sessions.map((s) => s.path));
	entries.sort((a, b) => (a.sha === b.sha ? a.bytes - b.bytes : a.sha.localeCompare(b.sha)));
	return {
		cacheDocuments: cacheDocs.length,
		transcripts: sessions.length,
		candidateFiles: entries.length,
		candidateBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
		digest: sha256(entries.map((e) => `${e.sha}:${e.bytes}`).join("\n")),
	};
}

/** Distinctive alnum run from a redacted excerpt, for reachability probing. */
function excerptProbe(excerpt: string): string | undefined {
	return (excerpt.match(/[A-Za-z0-9][A-Za-z0-9 ]{24,80}[A-Za-z0-9]/u) || [])[0]?.trim();
}

/**
 * Whether the excerpt is inside the first bounded page — determined by Pi's real
 * truncation, so it honours both the byte and the 2,000-line cap, not a byte
 * boundary alone.
 */
function excerptReachability(content: string, excerpts: readonly string[]): "first-page" | "beyond-first-page" | "unknown" {
	const firstPage = truncateHead(content).content;
	let anyKnown = false;
	let anyBeyond = false;
	for (const excerpt of excerpts) {
		const probe = excerptProbe(excerpt);
		if (!probe || !content.includes(probe)) continue;
		anyKnown = true;
		if (!firstPage.includes(probe)) anyBeyond = true;
	}
	return anyKnown ? (anyBeyond ? "beyond-first-page" : "first-page") : "unknown";
}

/** One default read-tool call's output length for a file: the real bounded read a caller receives. */
async function readToolOutputChars(filePath: string, cwd: string): Promise<number> {
	const tool = createReadToolDefinition(cwd);
	const result = await tool.execute("recall-bench", { path: filePath }, undefined, undefined, {} as never);
	return (result.content as Array<{ type: string; text?: string }>).reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
}

export async function measureRecall(options: RecallMeasureOptions): Promise<RecallMeasureResult> {
	const { question, cacheRoot, sessionsRoot, project, warmups, repeats } = options;
	const cachePools = discoverCachePools(cacheRoot, project);
	const sessions = discoverSessions(sessionsRoot, project, options.maxSessions ?? 150);
	const cacheDocs = cacheDocumentPaths(cachePools);
	const corpus = corpusFingerprint(cacheDocs, sessions);

	const cwd = process.cwd();
	const request = { question, all_projects: options.allProjects ?? false, include_current: false, include_worktrees: true };
	const sources = { cachePools, sessions, currentSessionPath: null, home: undefined, cwd };

	// recall: determinism + latency together.
	for (let i = 0; i < warmups; i++) answerRecall(request, sources);
	const outputs: string[] = [];
	const recallSamples: number[] = [];
	let result = answerRecall(request, sources);
	for (let i = 0; i < repeats; i++) {
		const started = performance.now();
		result = answerRecall(request, sources);
		recallSamples.push(performance.now() - started);
		outputs.push(result.content.map((b) => b.text).join("\n"));
	}
	const distinctOutputs = new Set(outputs).size;

	const citations = result.details.citations;
	const cited = citedSourcePaths(result);
	const excerptsByPath = new Map<string, string[]>();
	const storeByPath = new Map<string, "context-cache" | "prior-session">();
	for (const c of citations) {
		if (!excerptsByPath.has(c.sourcePath)) excerptsByPath.set(c.sourcePath, []);
		excerptsByPath.get(c.sourcePath)!.push(c.excerpt);
		storeByPath.set(c.sourcePath, c.store);
	}

	const citedFiles: CitedFileMeasure[] = [];
	const readablePaths: string[] = [];
	for (const p of cited) {
		let content: string;
		try { content = fs.readFileSync(p, "utf8"); } catch {
			citedFiles.push({ pathHash: sha256(p), store: storeByPath.get(p), readable: false });
			continue;
		}
		readablePaths.push(p);
		const bytes = Buffer.byteLength(content, "utf-8");
		const boundedChars = await readToolOutputChars(p, cwd);
		citedFiles.push({
			pathHash: sha256(p),
			store: storeByPath.get(p),
			readable: true,
			bytes,
			chars: content.length,
			contentSha256: sha256(content),
			boundedChars,
			boundedTruncated: truncateHead(content).truncated,
			wholeFileReads: Math.max(1, Math.ceil(bytes / DEFAULT_MAX_BYTES)),
			excerptReachable: excerptReachability(content, excerptsByPath.get(p) ?? []),
		});
	}

	const readable = citedFiles.filter((f) => f.readable);
	const baselineBoundedChars = readable.reduce((s, f) => s + (f.boundedChars ?? 0), 0);
	const baselineFullChars = readable.reduce((s, f) => s + (f.chars ?? 0), 0);
	const wholeFileReads = readable.reduce((s, f) => s + (f.wholeFileReads ?? 0), 0);
	const degenerateBaseline = readable.length > 0 && baselineBoundedChars === 0;

	// direct read: latency, same warm-up + repeats, timed after its own warm-up.
	const readAllOnce = async (): Promise<void> => {
		for (const p of readablePaths) await readToolOutputChars(p, cwd);
	};
	for (let i = 0; i < warmups; i++) await readAllOnce();
	const directSamples: number[] = [];
	if (readablePaths.length > 0) {
		for (let i = 0; i < repeats; i++) {
			const started = performance.now();
			await readAllOnce();
			directSamples.push(performance.now() - started);
		}
	}

	const recallChars = recallOutputCharacters(result);
	const bounded = compareRecallCost(recallChars, baselineBoundedChars);
	const full = compareRecallCost(recallChars, baselineFullChars);

	return {
		question,
		found: citations.length > 0,
		citations: citations.length,
		citedFiles,
		distinctOutputs,
		repeatIdentical: distinctOutputs <= 1,
		scannedCacheDocuments: result.details.scanned_cache_documents,
		scannedSessions: result.details.scanned_sessions,
		recallChars,
		recallTokens: bounded.recallTokens,
		baselineBoundedChars,
		baselineFullChars,
		primaryBaselineChars: baselineBoundedChars,
		wholeFileReads,
		boundedRatio: bounded.contextRatio,
		boundedSaves: bounded.savesContext,
		fullRatio: full.contextRatio,
		degenerateBaseline,
		recallLatency: stat(recallSamples),
		directLatency: stat(directSamples),
		corpus,
	};
}
