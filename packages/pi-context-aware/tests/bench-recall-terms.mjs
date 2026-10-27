#!/usr/bin/env node
/**
 * Replay recorded prior-session searches against the old and new transcript
 * matcher added for issue 199. Not part of `npm test`.
 *
 * Source: direct `search_prior_sessions`, `session_recall` and `context_recall`
 * tool calls recorded in session files under a profile's sessions directory.
 * Calls with `regex: true` or an all-projects scope are skipped.
 *
 * For each call, the candidate sessions are the sessions of the calling
 * session's exact cwd that started before the call, minus the calling session.
 * Worktree sessions are not added, and later content of an earlier session is
 * still searched, so figures are approximate.
 *
 * - old: the whole query as one case-insensitive literal over Pi's chat text.
 * - new: `recallQuery` from .test-dist (term matching over chat text, tool
 *   output and fold and compaction summaries).
 *
 * Reports, for both: hit rate (one or more sessions found) and p50/p95 latency
 * of the match step. Pi's session listing, which both pay first, is timed once
 * per cwd and reported as listMs (it reads every session file in full);
 * and for "recovery pairs" (a miss followed within the next five searches of
 * the same session by a hit), whether the missed query finds a session the
 * later hit found.
 *
 * Usage:
 *   npm run test:compile && node tests/bench-recall-terms.mjs [--sessions DIR] [--limit N] [--json FILE]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const SESSIONS = option("--sessions", path.join(os.homedir(), ".pi/profiles/fabric/sessions"));
const LIMIT = Number(option("--limit", "100000"));
const JSON_OUT = option("--json", undefined);

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { recallQuery } = await import(new URL("../.test-dist/src/context-tools/context-recall.js", import.meta.url).href);

const RECALL_TOOLS = new Set(["search_prior_sessions", "session_recall", "context_recall"]);

function readLines(file) {
	try {
		return fs.readFileSync(file, "utf8").split("\n");
	} catch {
		return [];
	}
}

/** Recorded recall calls in one session file, in order, with their recorded outcome. */
function recordedCalls(file) {
	let cwd;
	const calls = [];
	const byId = new Map();
	for (const line of readLines(file)) {
		if (!line.includes("\"session\"") && !line.includes("recall") && !line.includes("search_prior_sessions")) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "session") cwd = entry.cwd;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type !== "toolCall" || !RECALL_TOOLS.has(part.name)) continue;
				const a = part.arguments ?? {};
				const query = typeof a.query === "string" ? a.query : typeof a.question === "string" ? a.question : undefined;
				if (!query || !query.trim() || a.regex === true || a.all_projects === true || a.scope === "all-projects" || a.scope === "session" || a.ref) continue;
				const call = { file, cwd, at: Date.parse(entry.timestamp), query, includeCurrent: a.include_current === true, recordedHit: undefined, recordedPaths: [] };
				calls.push(call);
				byId.set(part.id, call);
			}
		} else if (message?.role === "toolResult" && byId.has(message.toolCallId)) {
			const call = byId.get(message.toolCallId);
			const text = (message.content ?? []).map((p) => p?.text ?? "").join("\n");
			call.recordedPaths = [...text.matchAll(/^- path: (.+\.jsonl)$/gmu)].map((m) => m[1]);
			call.recordedHit = call.recordedPaths.length > 0;
		}
	}
	return calls.filter((call) => call.cwd && Number.isFinite(call.at));
}

function startOf(sessionPath) {
	const match = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_/u.exec(path.basename(sessionPath));
	return match ? Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`) : Number.POSITIVE_INFINITY;
}

const listings = new Map();
const listMs = new Map();
async function listed(cwd) {
	if (!listings.has(cwd)) {
		const t = performance.now();
		listings.set(cwd, await SessionManager.list(cwd).catch(() => []));
		listMs.set(cwd, performance.now() - t);
	}
	return listings.get(cwd);
}

function oldMatch(query, sessions) {
	const needle = query.toLocaleLowerCase();
	return sessions.filter((s) => (s.allMessagesText ?? "").toLocaleLowerCase().includes(needle)).map((s) => s.path);
}

function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const files = [];
for (const dir of fs.readdirSync(SESSIONS)) {
	const full = path.join(SESSIONS, dir);
	if (!fs.statSync(full).isDirectory()) continue;
	for (const name of fs.readdirSync(full)) if (name.endsWith(".jsonl")) files.push(path.join(full, name));
}

const calls = [];
for (const file of files) {
	const text = fs.readFileSync(file, "utf8");
	if (!text.includes("search_prior_sessions") && !text.includes("session_recall") && !text.includes("context_recall")) continue;
	calls.push(...recordedCalls(file));
}
calls.sort((a, b) => a.at - b.at);
const sample = calls.slice(-LIMIT);

const results = [];
for (const call of sample) {
	const all = await listed(call.cwd);
	const sessions = all.filter((s) => s.path !== call.file && startOf(s.path) < call.at).sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const host = {
		listSessions: async () => ({ sessions, scannedCwds: [call.cwd], scopeLabel: "project" }),
		erasedSessionIds: () => new Set(),
		cachePools: () => [],
		home: () => os.homedir(),
	};
	const ctx = { cwd: call.cwd, sessionManager: { getSessionFile: () => call.file, getEntries: () => [] } };

	let t = performance.now();
	const oldPaths = oldMatch(call.query, sessions);
	const oldMs = performance.now() - t;
	t = performance.now();
	const result = await recallQuery({ query: call.query, scope: "prior", max_sessions: 20 }, ctx, host);
	const newMs = performance.now() - t;
	const newPaths = result.details.transcripts.results.map((hit) => hit.sessionPath);
	results.push({ ...call, candidates: sessions.length, oldPaths, newPaths, oldMs, newMs, listMs: listMs.get(call.cwd) ?? 0, matching: result.details.transcripts.matching });
}

// Recovery pairs: a recorded miss followed by a recorded hit within the next five searches of the same session.
const pairs = [];
const bySession = new Map();
for (const r of results) bySession.set(r.file, [...(bySession.get(r.file) ?? []), r]);
for (const list of bySession.values()) {
	list.forEach((r, i) => {
		if (r.recordedHit !== false) return;
		const later = list.slice(i + 1, i + 6).find((next) => next.recordedHit === true);
		if (!later) return;
		const targets = new Set(later.recordedPaths);
		pairs.push({ query: r.query, later: later.query, oldFound: r.oldPaths.some((p) => targets.has(p)), newFound: r.newPaths.some((p) => targets.has(p)) });
	});
}

const rate = (n, d) => (d === 0 ? "n/a" : `${n}/${d} (${Math.round((100 * n) / d)}%)`);
const groups = { all: results, "one word": results.filter((r) => r.matching === "literal"), "several words": results.filter((r) => r.matching === "terms") };
const summary = {
	sessionsDir: SESSIONS,
	calls: results.length,
	groups: Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, {
		calls: list.length,
		oldHitRate: rate(list.filter((r) => r.oldPaths.length > 0).length, list.length),
		newHitRate: rate(list.filter((r) => r.newPaths.length > 0).length, list.length),
		oldMs: { p50: +percentile(list.map((r) => r.oldMs), 50).toFixed(1), p95: +percentile(list.map((r) => r.oldMs), 95).toFixed(1) },
		newMs: { p50: +percentile(list.map((r) => r.newMs), 50).toFixed(1), p95: +percentile(list.map((r) => r.newMs), 95).toFixed(1), max: +Math.max(0, ...list.map((r) => r.newMs)).toFixed(1) },
	}])),
	recoveryPairs: { pairs: pairs.length, oldFindsTarget: rate(pairs.filter((p) => p.oldFound).length, pairs.length), newFindsTarget: rate(pairs.filter((p) => p.newFound).length, pairs.length) },
	listMs: { p50: +percentile(results.map((r) => r.listMs), 50).toFixed(1), p95: +percentile(results.map((r) => r.listMs), 95).toFixed(1) },
	lostByNew: results.filter((r) => r.oldPaths.length > 0 && !r.oldPaths.some((p) => r.newPaths.includes(p))).length,
	medianCandidates: percentile(results.map((r) => r.candidates), 50),
};
console.log(JSON.stringify(summary, null, 2));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, results: results.map(({ query, matching, candidates, oldPaths, newPaths, oldMs, newMs, recordedHit }) => ({ query, matching, candidates, old: oldPaths.length, new: newPaths.length, oldMs, newMs, recordedHit })), pairs }, null, 2));
