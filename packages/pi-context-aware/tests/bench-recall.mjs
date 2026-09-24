#!/usr/bin/env node
/**
 * Cost/latency measurement CLI for the `recall` tool (REQ-RECALL-007). Thin
 * wrapper over the measurement core in tests/recall-measure.ts (compiled to
 * .test-dist), which a test also drives so the method's invariants are pinned in
 * CI. Not part of `npm test`.
 *
 * Two modes:
 *   --fixture <dir>   Reproducible: measure the committed immutable corpus. The
 *                     headline figure REQ-RECALL-007 rests on. Defaults to
 *                     tests/fixtures/recall-corpus.
 *   --scope <project|all>
 *                     Live: measure this machine's ~/.pi/agent stores. A
 *                     point-in-time observation, NOT reproducible — the corpus
 *                     mutates under the benchmark; the digest changes with it.
 *
 * Usage:
 *   npm run bench:recall                       # fixture, default questions
 *   npm run bench:recall -- --live --scope project
 *   npm run bench:recall -- --question "amber widget gutter measurement" --json out.json
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { measureRecall } from "../.test-dist/tests/recall-measure.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.join(HERE, "fixtures", "recall-corpus");

const FIXTURE_QUESTIONS = [
	"amber widget gutter measurement", // large transcript: recall wins big
	"seed authority guard fixture note", // representative cache doc: recall wins modestly
	"magenta toggle fixture default", // tiny cache doc: recall costs MORE than reading it
	"a fact that is absent from the fixture corpus", // no evidence
];
const LIVE_QUESTIONS = [
	"recall tool read-only guarantee",
	"accepted limits of the seed authority guard",
];

function parseArgs(argv) {
	const args = {
		mode: "fixture",
		scope: "project",
		project: "pi-context-aware",
		fixture: DEFAULT_FIXTURE,
		question: "",
		warmups: 1,
		repeats: 5,
		maxSessions: 150,
		json: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--fixture") { args.mode = "fixture"; const v = argv[i + 1]; if (v && !v.startsWith("--")) { args.fixture = argv[++i]; } }
		else if (arg === "--live") args.mode = "live";
		else if (arg === "--scope") { args.mode = "live"; args.scope = argv[++i] ?? "project"; }
		else if (arg === "--project") args.project = argv[++i] ?? "";
		else if (arg === "--question") args.question = argv[++i] ?? "";
		else if (arg === "--warmups") args.warmups = Math.max(0, Number(argv[++i] ?? "1"));
		else if (arg === "--repeats") args.repeats = Math.max(1, Number(argv[++i] ?? "5"));
		else if (arg === "--max-sessions") args.maxSessions = Math.max(1, Number(argv[++i] ?? "150"));
		else if (arg === "--json") args.json = argv[++i] ?? "";
		else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (args.scope !== "project" && args.scope !== "all") throw new Error(`--scope must be project|all`);
	return args;
}

function printHelp() {
	console.log(`recall cost/latency measurement (REQ-RECALL-007)

Modes:
  --fixture [dir]        Reproducible measurement over a committed corpus (default: tests/fixtures/recall-corpus).
  --live | --scope <s>   Point-in-time measurement over ~/.pi/agent (NOT reproducible).

Options:
  --scope <project|all>  Live scope. Default: project.
  --project <substring>  Live project marker. Default: pi-context-aware.
  --question <text>      One question instead of the built-in set.
  --warmups <n>          Discarded warm-ups per path. Default: 1.
  --repeats <n>          Timed repeats per path. Default: 5.
  --max-sessions <n>     Candidate transcripts (recall caps at 100). Default: 150.
  --json <path>          Write the full result, with fingerprint, as JSON.`);
}

function fmtRatio(r) {
	if (r === Infinity) return "inf";
	if (r === 0) return "0";
	if (r < 0.001) return r.toExponential(2);
	return r.toFixed(4);
}
function fmtSaves(r) {
	if (r === Infinity) return "n/a (empty baseline)";
	if (r === 0) return "n/a";
	if (r >= 1) return `${((r - 1) * 100).toFixed(0)}% more`;
	return `${((1 - r) * 100).toFixed(2)}% less`;
}
function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const live = args.mode === "live";
	const questions = args.question ? [args.question] : (live ? LIVE_QUESTIONS : FIXTURE_QUESTIONS);

	const roots = live
		? { cacheRoot: path.join(os.homedir(), ".pi", "agent", "context-cache"), sessionsRoot: path.join(os.homedir(), ".pi", "agent", "sessions"), project: args.project }
		: { cacheRoot: path.join(args.fixture, "cache"), sessionsRoot: path.join(args.fixture, "sessions"), project: "" };

	console.log(`\nrecall cost/latency measurement (REQ-RECALL-007)`);
	console.log(live
		? `mode=LIVE (point-in-time, NOT reproducible) scope=${args.scope} project="${args.project}"`
		: `mode=FIXTURE (reproducible) dir=${path.relative(process.cwd(), args.fixture) || args.fixture}`);
	console.log(`warmups=${args.warmups} repeats=${args.repeats}\n`);

	const rows = [];
	for (const question of questions) {
		rows.push(await measureRecall({
			question,
			cacheRoot: roots.cacheRoot,
			sessionsRoot: roots.sessionsRoot,
			project: roots.project,
			allProjects: live && args.scope === "all",
			warmups: args.warmups,
			repeats: args.repeats,
			maxSessions: args.maxSessions,
		}));
	}

	const fp = rows[0]?.corpus;
	if (fp) console.log(`corpus: ${fp.cacheDocuments} cache docs + ${fp.transcripts} transcripts, ${fp.candidateBytes} bytes; digest ${fp.digest.slice(0, 16)}\n`);

	const header = ["question".padEnd(46), "found".padEnd(6), "recall ch".padStart(9), "1-read ch".padStart(9), "ratio".padStart(9), "recall ms".padStart(10), "read ms".padStart(9)].join(" ");
	console.log(header);
	console.log("-".repeat(header.length));
	for (const r of rows) {
		console.log([
			r.question.slice(0, 46).padEnd(46),
			(r.found ? "yes" : "no").padEnd(6),
			String(r.recallChars).padStart(9),
			String(r.baselineBoundedChars).padStart(9),
			fmtRatio(r.boundedRatio).padStart(9),
			r.recallLatency.median.toFixed(2).padStart(10),
			r.directLatency.median.toFixed(2).padStart(9),
		].join(" "));
	}

	console.log(`\nPer-question detail:`);
	for (const r of rows) {
		console.log(`\n  "${r.question}"`);
		console.log(`    determinism: ${r.repeatIdentical ? "identical across all repeats" : `NOT identical (${r.distinctOutputs} distinct)`}`);
		if (!r.found) {
			console.log(`    no evidence — recall ${r.recallChars} ch, no baseline; recall median ${r.recallLatency.median.toFixed(2)} ms (scanned ${r.scannedCacheDocuments} cache docs, ${r.scannedSessions} transcripts)`);
			continue;
		}
		console.log(`    citations: ${r.citations} across ${r.citedFiles.length} file(s)`);
		console.log(`    PRIMARY — recall vs one REAL read-tool call per cited file:`);
		console.log(`      recall ${r.recallChars} ch (~${r.recallTokens} tok) vs bounded read ${r.baselineBoundedChars} ch -> ratio ${fmtRatio(r.boundedRatio)} (${fmtSaves(r.boundedRatio)}); savesContext=${r.boundedSaves}${r.degenerateBaseline ? " [DEGENERATE first-line>50KB]" : ""}`);
		console.log(`    UPPER BOUND — vs whole file(s): ${r.baselineFullChars} ch over ${r.wholeFileReads} read(s) -> ratio ${fmtRatio(r.fullRatio)} (${fmtSaves(r.fullRatio)})`);
		console.log(`    latency (warm, median of ${r.recallLatency.samples.length}): recall ${r.recallLatency.median.toFixed(2)} ms [${r.recallLatency.min.toFixed(2)}-${r.recallLatency.max.toFixed(2)}] vs bounded read ${r.directLatency.median.toFixed(2)} ms [${r.directLatency.min.toFixed(2)}-${r.directLatency.max.toFixed(2)}]${r.directLatency.median > 0 ? ` -> ${(r.recallLatency.median / r.directLatency.median).toFixed(1)}x` : ""}`);
		for (const f of r.citedFiles) {
			if (!f.readable) { console.log(`      cited ${f.store} ${f.pathHash.slice(0, 12)} — unreadable`); continue; }
			console.log(`      cited ${f.store} ${f.pathHash.slice(0, 12)} sha=${f.contentSha256.slice(0, 12)} ${f.bytes}B truncated=${f.boundedTruncated} bounded=${f.boundedChars}ch excerpt=${f.excerptReachable}`);
		}
	}

	const found = rows.filter((r) => r.found && !r.degenerateBaseline);
	if (found.length > 0) {
		const savers = found.filter((r) => r.boundedSaves).length;
		const medRatio = median(found.map((r) => (r.boundedRatio === Infinity ? Number.MAX_VALUE : r.boundedRatio)));
		const medRecall = median(found.map((r) => r.recallLatency.median));
		const medDirect = median(found.map((r) => r.directLatency.median));
		console.log(`\nSummary over ${found.length} question(s) with evidence:`);
		console.log(`  saves context vs one bounded read on ${savers}/${found.length}`);
		console.log(`  median bounded ratio ${fmtRatio(medRatio)} (${fmtSaves(medRatio)})`);
		console.log(`  median recall latency ${medRecall.toFixed(2)} ms; median bounded-read latency ${medDirect.toFixed(2)} ms; overhead ${medDirect > 0 ? (medRecall / medDirect).toFixed(1) : "inf"}x`);
		console.log(`  determinism: ${rows.every((r) => r.repeatIdentical) ? "all identical across repeats" : "SOME varied across repeats"}`);
	}

	if (args.json) {
		const payload = {
			generatedAt: new Date().toISOString(),
			mode: args.mode,
			reproducible: !live,
			scope: live ? args.scope : "fixture",
			warmups: args.warmups,
			repeats: args.repeats,
			rows: rows.map((r) => ({ ...r, boundedRatio: r.boundedRatio === Infinity ? "Infinity" : r.boundedRatio, fullRatio: r.fullRatio === Infinity ? "Infinity" : r.fullRatio })),
		};
		fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
		fs.writeFileSync(args.json, `${JSON.stringify(payload, null, 2)}\n`);
		console.log(`\nWrote ${args.json}`);
	}
}

main().catch((err) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
