#!/usr/bin/env node
/**
 * Time and peak-heap measurement for task and focus replay.
 * Not part of `npm test`.
 *
 * Each case runs in its own child process with `--expose-gc`, on generated
 * histories from tests/replay-history.ts, so results do not depend on a live
 * transcript and do not share heap state.
 *
 * Implementations:
 *   replay      the shipped `replayWorkstreamEntries` or `replayTasksEntries`
 *               over the whole generated branch, parsing included.
 *   reference   the pre-#148 focus replay (tests/replay-reference.ts) without
 *               its entry limit, also end to end. It copies a predecessor path
 *               for every reachable snapshot, so it shows the quadratic shape
 *               the change removed.
 *
 * Peak heap is the largest V8 used-heap size observed at any garbage
 * collection during the run or at its end, minus the size after a forced
 * collection just before it. It counts garbage not yet collected, so it
 * measures memory pressure, and it is a lower bound on the true peak.
 *
 * Usage:
 *   npm run bench:replay
 *   npm run bench:replay -- --quick          # smaller sizes
 *   npm run bench:replay -- --json out.json
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

const SELF = fileURLToPath(import.meta.url);
const DIST = new URL("../.test-dist/", import.meta.url);

const FULL_CASES = [
	...["200000", "1000000"].map((size) => ({ fixture: "sparse", size, impls: ["replay", "tasks"] })),
	{ fixture: "sparse", size: "200000", impls: ["reference"] },
	...["2500", "5000", "10000"].map((size) => ({ fixture: "linked-chain", size, impls: ["replay", "reference"] })),
	...["20000", "100000"].map((size) => ({ fixture: "linked-chain", size, impls: ["replay"] })),
	...["2500", "5000", "10000"].map((size) => ({ fixture: "legacy-chain", size, impls: ["replay", "reference"] })),
	...["20000", "100000"].map((size) => ({ fixture: "legacy-chain", size, impls: ["replay"] })),
	...["1000x8", "2000x8", "4000x8"].map((size) => ({ fixture: "competing-legacy", size, impls: ["replay", "reference"] })),
	{ fixture: "competing-legacy", size: "12500x8", impls: ["replay"] },
	...["10000", "100000"].map((size) => ({ fixture: "task-history", size, impls: ["tasks"] })),
];

const QUICK_CASES = [
	{ fixture: "sparse", size: "20000", impls: ["replay", "tasks", "reference"] },
	{ fixture: "linked-chain", size: "2000", impls: ["replay", "reference"] },
	{ fixture: "legacy-chain", size: "2000", impls: ["replay", "reference"] },
	{ fixture: "competing-legacy", size: "250x8", impls: ["replay", "reference"] },
	{ fixture: "task-history", size: "2000", impls: ["tasks"] },
];

async function load() {
	const [history, focus, tasks, reference] = await Promise.all([
		import(new URL("tests/replay-history.js", DIST)),
		import(new URL("src/workstream/workstream-replay.js", DIST)),
		import(new URL("src/session-tasks/session-tasks.js", DIST)),
		import(new URL("tests/replay-reference.js", DIST)),
	]);
	return { history, focus, tasks, reference };
}

function taskList(tasks) {
	const planned = tasks.planTasks([
		{ title: "Read the selected branch" },
		{ title: "Keep the newest snapshot" },
		{ title: "Record the measurement" },
	], "agent");
	if (!planned.ok) throw new Error(planned.reason);
	return planned.value;
}

function fixture(modules, name, size) {
	const { history } = modules;
	if (name === "sparse") return history.sparseHistory(Number(size), 20, taskList(modules.tasks));
	if (name === "linked-chain") return history.focusChain(Number(size));
	if (name === "legacy-chain") return history.focusChain(Number(size), { linked: false });
	if (name === "competing-legacy") {
		const [levels, width] = size.split("x").map(Number);
		return history.competingLegacyHistory(levels, width);
	}
	if (name === "task-history") {
		const list = taskList(modules.tasks);
		return history.tasksHistory(Number(size), () => list);
	}
	throw new Error(`unknown fixture ${name}`);
}

/** The measured call and a short description of what it established. */
function runner(modules, impl, entries) {
	if (impl === "replay") {
		return () => {
			const result = modules.focus.replayWorkstreamEntries(entries);
			return `focus ${result.snapshot?.eventId ?? "none"}`;
		};
	}
	if (impl === "tasks") {
		return () => {
			const result = modules.tasks.replayTasksEntries(entries);
			return `tasks revision ${result.snapshot?.revision ?? "none"}`;
		};
	}
	if (impl === "reference") {
		return () => {
			const selected = modules.reference.referenceReplay(entries);
			return `focus ${selected.eventId ?? "none"}`;
		};
	}
	throw new Error(`unknown implementation ${impl}`);
}

async function child(name, size, impl) {
	if (typeof globalThis.gc !== "function") throw new Error("run the child with --expose-gc");
	const modules = await load();
	// Warm the code paths on a small input so the measured run is not the first.
	const warmSize = name === "competing-legacy" ? "20x8" : "200";
	runner(modules, impl, fixture(modules, name, warmSize))();
	const entries = fixture(modules, name, size);
	const run = runner(modules, impl, entries);
	globalThis.gc();
	globalThis.gc();
	const baseline = v8.getHeapStatistics().used_heap_size;
	const profiler = new v8.GCProfiler();
	profiler.start();
	const started = performance.now();
	const outcome = run();
	const firstMs = performance.now() - started;
	const endUsed = v8.getHeapStatistics().used_heap_size;
	const profile = profiler.stop();
	let peak = endUsed;
	for (const event of profile.statistics) peak = Math.max(peak, event.beforeGC.heapStatistics.usedHeapSize);
	const repeats = [];
	for (let index = 0; index < 3; index += 1) {
		globalThis.gc();
		const start = performance.now();
		run();
		repeats.push(performance.now() - start);
	}
	repeats.sort((a, b) => a - b);
	return {
		fixture: name,
		size,
		impl,
		entries: entries.length,
		outcome,
		firstMs: Math.round(firstMs),
		medianMs: Math.round(repeats[1]),
		peakHeapMiB: Math.round(((peak - baseline) / 2 ** 20) * 10) / 10,
	};
}

function measure(name, size, impl) {
	const result = spawnSync(process.execPath, ["--expose-gc", SELF, "--child", name, size, impl], {
		encoding: "utf8",
		maxBuffer: 1 << 20,
	});
	if (result.status !== 0) {
		return { fixture: name, size, impl, error: (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").slice(-3).join(" ") };
	}
	return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

function table(rows) {
	const header = "| fixture | size | entries | implementation | result | first ms | median ms | peak heap MiB |";
	const rule = "|---|---|---:|---|---|---:|---:|---:|";
	const lines = rows.map((row) => (row.error
		? `| ${row.fixture} | ${row.size} | | ${row.impl} | error: ${row.error} | | | |`
		: `| ${row.fixture} | ${row.size} | ${row.entries} | ${row.impl} | ${row.outcome} | ${row.firstMs} | ${row.medianMs} | ${row.peakHeapMiB} |`));
	return [header, rule, ...lines].join("\n");
}

async function main(argv) {
	if (argv[0] === "--child") {
		const [name, size, impl] = argv.slice(1);
		process.stdout.write(`${JSON.stringify(await child(name, size, impl))}\n`);
		return;
	}
	const jsonIndex = argv.indexOf("--json");
	const jsonPath = jsonIndex === -1 ? null : argv[jsonIndex + 1];
	const cases = argv.includes("--quick") ? QUICK_CASES : FULL_CASES;
	const rows = [];
	for (const entry of cases) {
		for (const impl of entry.impls) {
			rows.push(measure(entry.fixture, entry.size, impl));
			process.stderr.write(".");
		}
	}
	process.stderr.write("\n");
	const environment = `node ${process.version}, ${process.platform}-${process.arch}`;
	process.stdout.write(`${environment}\n\n${table(rows)}\n`);
	if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ environment, rows }, null, 2)}\n`);
	if (rows.some((row) => row.error)) process.exitCode = 1;
}

await main(process.argv.slice(2));
