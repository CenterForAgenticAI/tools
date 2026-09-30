import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replayJournal, readJournal, type JournalReplay } from "../journal.js";
import { effectiveCostCeiling, largestStatePaths, statusLine, type RunStatusLine, type StatePathSize } from "../pure/status.js";
import type { Condition, EdgeReason, ExecutableGraph, JsonObject, JsonValue, RunOptions } from "../model.js";

export interface ExplainEntry {
	readonly seq: number;
	readonly nodeId: string;
	readonly verdict?: string;
	readonly verdictSource?: string;
	readonly via: EdgeReason;
	readonly to: string[];
	readonly conditionInputs: Array<{ path: string; value?: JsonValue }>;
}

export interface ExplainResult {
	readonly runId: string;
	readonly graphHash: string;
	readonly status: JournalReplay["status"];
	readonly path: ExplainEntry[];
}

export interface InspectOptions {
	readonly path?: string;
	readonly full?: boolean;
	readonly maxBytes?: number;
	/** The largest committed paths, biggest first. A projection, never a dump. */
	readonly inventory?: boolean;
	readonly limit?: number;
}

export interface InspectResult {
	readonly runId: string;
	readonly status: JournalReplay["status"];
	readonly revision: number;
	readonly currentNode?: string;
	readonly result?: JsonObject;
	readonly value?: JsonValue;
	readonly state?: JsonObject;
	readonly largestPaths?: StatePathSize[];
	readonly stateBytes?: number;
}

export async function loadRunGraph(directory: string): Promise<ExecutableGraph> {
	return JSON.parse(await readFile(join(directory, "graph.json"), "utf8")) as ExecutableGraph;
}

export async function explainRun(directory: string): Promise<ExplainResult> {
	const graph = await loadRunGraph(directory);
	const records = await readJournal(directory);
	const started = records.find((record) => record.type === "run-started");
	if (!started || started.type !== "run-started") throw new Error("Journal has no run-started record.");
	const replay = await replayJournal(directory, graph, started.options);
	let state: JsonObject = { input: structuredClone(started.input) };
	const path: ExplainEntry[] = [];
	for (const record of records) {
		if (record.type === "state-committed") state = applyDelta(state, record.delta);
		if (record.type !== "edge-fired") continue;
		const node = graph.nodes[record.from];
		const conditions = node?.transitions.when.flatMap((clause) => conditionInputs(clause.condition, state)) ?? [];
		const verdictRecord = records.filter((candidate) => candidate.type === "verdict-resolved" && candidate.nodeId === record.from && candidate.seq < record.seq).at(-1);
		const verdict = verdictRecord?.type === "verdict-resolved" ? verdictRecord.verdict : undefined;
		const verdictSource = verdictRecord?.type === "verdict-resolved" ? verdictRecord.source : undefined;
		path.push({ seq: record.seq, nodeId: record.from, ...(verdict ? { verdict } : {}), ...(verdictSource ? { verdictSource } : {}), via: record.via, to: record.to, conditionInputs: conditions });
	}
	return { runId: replay.state.runId, graphHash: replay.state.graphHash, status: replay.status, path };
}

export async function inspectRun(directory: string, options: InspectOptions = {}): Promise<InspectResult> {
	const graph = await loadRunGraph(directory);
	const records = await readJournal(directory);
	const started = records.find((record) => record.type === "run-started");
	if (!started || started.type !== "run-started") throw new Error("Journal has no run-started record.");
	const replay = await replayJournal(directory, graph, started.options as RunOptions);
	const base: InspectResult = { runId: replay.state.runId, status: replay.status, revision: replay.state.revision, ...(replay.currentNode ? { currentNode: replay.currentNode } : {}), ...(replay.result ? { result: replay.result } : {}) };
	if (options.path) {
		const value = valueAt(replay.state.data, options.path);
		return value === undefined ? base : { ...base, value };
	}
	// The view that answers "which path grew" when a run halts on RUN-STATE-BYTES,
	// without dumping the state that caused it ([0006](../../.spec/0006-runtime-state-and-durability.md) §6).
	if (options.inventory) {
		return { ...base, largestPaths: largestStatePaths(replay.state.data, options.limit ?? 10), stateBytes: replay.state.bytes };
	}
	if (options.full) {
		const state = replay.state.data;
		const maxBytes = options.maxBytes ?? 64 * 1024;
		if (Buffer.byteLength(JSON.stringify(state)) > maxBytes) throw new Error(`Inspect full state exceeds the ${maxBytes}-byte cap.`);
		return { ...base, state };
	}
	return base;
}

/**
 * The bounded status line for a run, reconstructed from its journal.
 *
 * Current node, visit, the last verdict, attempts against budget, and tokens.
 * Estimated cost joins them **exactly when a cost ceiling is in force**, from
 * either the graph or the invocation (D-024, widened by D-059): against a
 * ceiling the number reads as progress towards a limit somebody chose, and on
 * its own it reads as a claim about a bill an estimate cannot support.
 */
export async function runStatus(directory: string): Promise<RunStatusLine> {
	const graph = await loadRunGraph(directory);
	const records = await readJournal(directory);
	const started = records.find((record) => record.type === "run-started");
	if (!started || started.type !== "run-started") throw new Error("Journal has no run-started record.");
	const replay = await replayJournal(directory, graph, started.options);
	const lastStarted = records.filter((record) => record.type === "node-started").at(-1);
	const lastVerdict = records.filter((record) => record.type === "verdict-resolved").at(-1);
	const finished = records.filter((record) => record.type === "run-finished").at(-1);
	const status = replay.status === "running" && finished?.type === "run-finished" ? finished.status : replay.status;
	const ceiling = costCeiling(graph, started.options);
	return statusLine({
		runId: replay.state.runId,
		graph,
		graphName: started.graphName,
		status,
		...(replay.currentNode && status === "running" || replay.waitingHuman ? { currentNode: replay.waitingHuman?.nodeId ?? replay.currentNode } : {}),
		...(lastStarted?.type === "node-started" && (status === "running" || status === "waiting-human") ? { visit: lastStarted.visit } : {}),
		...(lastVerdict?.type === "verdict-resolved" ? { lastVerdict: lastVerdict.verdict } : {}),
		attemptsUsed: replay.attemptsUsed,
		ledger: replay.ledger,
		...(ceiling === undefined ? {} : { costCeilingUsd: ceiling }),
		...(replay.waitingHuman ? { question: replay.waitingHuman.question } : {}),
		...(finished?.type === "run-finished" && finished.code ? { failure: { code: finished.code, detail: `Run finished ${finished.status}.` } } : {}),
	});
}

function costCeiling(graph: ExecutableGraph, options: RunOptions): number | undefined {
	return effectiveCostCeiling(graph.limits.maxCostUsd, options.maxCostUsd);
}

function conditionInputs(condition: Condition, state: JsonObject): Array<{ path: string; value?: JsonValue }> {
	if (condition.op === "all" || condition.op === "any") return condition.of.flatMap((item) => conditionInputs(item, state));
	if (condition.op === "not") return conditionInputs(condition.of, state);
	if (!("path" in condition)) return [];
	const value = valueAt(state, condition.path);
	return [{ path: condition.path, ...(value === undefined ? {} : { value }) }];
}

function applyDelta(data: JsonObject, delta: Array<{ path: string; op: "set" | "unset"; value?: JsonValue }>): JsonObject {
	const next = structuredClone(data);
	for (const change of delta) {
		const parts = change.path.split(".");
		let cursor = next;
		for (const part of parts.slice(0, -1)) {
			if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
			cursor = cursor[part] as JsonObject;
		}
		if (change.op === "unset") delete cursor[parts.at(-1)!];
		else cursor[parts.at(-1)!] = structuredClone(change.value ?? null);
	}
	return next;
}

function valueAt(state: JsonObject, path: string): JsonValue | undefined {
	let value: unknown = state;
	for (const part of path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value as JsonValue;
}
