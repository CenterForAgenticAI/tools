#!/usr/bin/env node
// Summarise per-turn context metrics (pi-context-aware#286).
// Usage: node scripts/context-metrics-summary.mjs [--json] <metrics-dir | file.jsonl>...
// A directory is read for its *.jsonl files. A truncated last line and records of an unknown version are skipped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseMetrics(text) {
	const records = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		let record;
		try { record = JSON.parse(line); } catch { continue; }
		if (record && record.v === 1 && typeof record.sessionId === "string") records.push(record);
	}
	return records;
}

const add = (into, key, n) => { into[key] = (into[key] ?? 0) + n; };

export function summarise(records) {
	const sessions = new Map();
	for (const record of records) {
		let s = sessions.get(record.sessionId);
		if (!s) sessions.set(record.sessionId, s = { sessionId: record.sessionId, requests: 0, folds: 0, requested: 0, refused: {}, dropped: {}, compactions: 0, foldPressures: [], input: 0, cacheRead: 0, cacheWrite: 0 });
		s.requests += 1;
		const folds = record.folds ?? {};
		s.requested += folds.requested ?? 0;
		s.folds += folds.accepted ?? 0;
		for (const [code, n] of Object.entries(folds.refused ?? {})) add(s.refused, code, n);
		for (const [code, n] of Object.entries(folds.dropped ?? {})) add(s.dropped, code, n);
		if ((folds.accepted ?? 0) > 0 && typeof record.pressure === "number") s.foldPressures.push(record.pressure);
		if (record.compaction) s.compactions += 1;
		if (record.usage) {
			s.input += record.usage.input ?? 0;
			s.cacheRead += record.usage.cacheRead ?? 0;
			s.cacheWrite += record.usage.cacheWrite ?? 0;
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
	return { sessions: list, total: { ...total, cacheReadShare: prompt > 0 ? total.cacheRead / prompt : null } };
}

export function filesOf(target) {
	return statSync(target).isDirectory()
		? readdirSync(target).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(target, name))
		: [target];
}

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const codes = (counts) => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => `${code}=${n}`).join(" ") || "none";

export function format(summary) {
	const out = [];
	for (const s of summary.sessions) {
		out.push(`${s.sessionId}: ${s.requests} requests, ${s.folds} folds accepted of ${s.requested} requested, ${s.compactions} compactions, cache-read ${pct(s.cacheReadShare)}`);
		out.push(`  refusals: ${codes(s.refused)}; dropped at turn end: ${codes(s.dropped)}`);
		out.push(`  pressure at each fold: ${s.foldPressures.map((p) => p.toFixed(2)).join(" ") || "none"}`);
	}
	const t = summary.total;
	out.push(`total: ${t.sessions} sessions, ${t.requests} requests, ${t.folds} folds accepted of ${t.requested} requested, ${t.compactions} compactions, cache-read ${pct(t.cacheReadShare)}`);
	out.push(`  refusals: ${codes(t.refused)}; dropped at turn end: ${codes(t.dropped)}`);
	return out.join("\n");
}

function main(argv) {
	const json = argv.includes("--json");
	const targets = argv.filter((arg) => arg !== "--json");
	if (targets.length === 0) {
		process.stderr.write("Usage: context-metrics-summary.mjs [--json] <metrics-dir | file.jsonl>...\n");
		return 2;
	}
	const records = targets.flatMap(filesOf).flatMap((file) => parseMetrics(readFileSync(file, "utf8")));
	const summary = summarise(records);
	process.stdout.write(`${json ? JSON.stringify(summary, null, 2) : format(summary)}\n`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
