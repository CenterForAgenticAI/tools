/**
 * Differential for the live runtime on the strategy contract (pi-context-aware#472, REQ-STRAT-003): `folds-v1` on
 * the contract makes the same decisions and writes the same records as the legacy path.
 *
 * The same session runs through two fold engines, one per runtime, and everything they decide is compared:
 *
 * - every `context_fold` request of the differential cases (tests/fixtures/strategy-differential and the parity
 *   corpus): the answer, and the entries each turn boundary writes;
 * - every request of a recorded session (tests/fixtures/strategy-bench/corpus/fold-session, 32 requests with a
 *   fold) and of synthetic growing sessions: the messages sent, the injected text, the pressure, the nudge kind
 *   and the hides the boundary writes, for a main session, a Fabric child that can call neither context tool,
 *   a session that can only compact, and the band and off telemetry modes;
 * - a session with screenshots for a model that reads images and one that does not, 64k and 128k windows, and the
 *   compaction-only recipe chosen by `folds.engine` or `strategy.methods` (CR-COMPACTION-UNDIFFERENCED).
 *
 * The compaction hook is compared with literal expectations in tests/compaction-claim-refusal.test.ts.
 *
 * Entry ids are random per session, so each is compared by its position in the session file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { buildContextEntries, buildSessionContext, buildSessionProjection, SessionManager, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { applyFoldDrafts, type FoldEngineOptions } from "../src/folds/fold-engine.js";
import type { FoldTurnResult } from "../src/folds/fold-turn.js";
import type { RequestPressure } from "../src/folds/request-pressure.js";
import type { ViewCompactionOwner } from "../src/strategy/index.js";
import { readRecording } from "../src/strategy-runtime/bench/recording.js";
import { differentialCases, FIXTURES, seedCase, type DifferentialCase, type Seeded } from "./strategy-differential-cases.js";
import { engineOver, isolatedRoot } from "./strategy-live-harness.js";

type Drafts = Parameters<typeof applyFoldDrafts>[1];

/** `value` as JSON with clock stamps zeroed and every id of `entries` named by its position. */
function normalized(value: unknown, entries: readonly SessionEntry[]): string {
	const names = new Map(entries.map((entry, index) => [entry.id, `#${index}`]));
	const text = JSON.stringify(value, (key, field: unknown) => (key === "timestamp" || key === "createdAt" || key === "at" ? 0 : field)) ?? "undefined";
	const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
	return ids.length === 0 ? text : text.replace(new RegExp(ids.join("|"), "gu"), (id) => names.get(id)!);
}

/**
 * The legacy path's decisions, recorded as a SHA-256 digest per decision (tests/fixtures/strategy-live-differential/
 * expected.json): the legacy path is gone, so the contract runtime is compared with its record. The record was
 * made at 7e692d0, the last commit with the legacy runtime
 * (`FoldEngineOptions.runtime: "legacy"`); it cannot be made again from this tree.
 */
const EXPECTED = path.join(FIXTURES, "strategy-live-differential/expected.json");
const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8")) as Record<string, string[]>;
const digest = (decision: string): string => createHash("sha256").update(decision).digest("hex");

/** The contract runtime's decisions against the legacy path's record. */
function compareWithRecord(label: string, run: () => string[]): void {
	const old = expected[label];
	assert.ok(old, `expected.json records ${label}`);
	const now = run().map(digest);
	assert.equal(now.length, old.length, `${label}: as many decisions`);
	now.forEach((hash, i) => assert.equal(hash, old[i], `${label}: decision ${i} differs from the legacy path's`));
}

/** Write what a turn boundary returns, as Pi does. */
function drain(fire: (name: string, event?: unknown) => unknown[], manager: Pick<SessionManager, "appendContextEdit" | "appendCustomEntry" | "appendCustomMessageEntry">): Drafts {
	const written: Drafts[number][] = [];
	for (const out of fire("turn_end", { entries: [] }) as ({ entries?: Drafts } | undefined)[]) {
		if (!out?.entries) continue;
		applyFoldDrafts(manager, out.entries);
		written.push(...out.entries);
	}
	return written;
}

// --- Fold requests -------------------------------------------------------------------------------------------

/** Every request of a case through one runtime: each answer, then what each step's boundary writes. */
function foldRun(t: { after(fn: () => void | Promise<void>): void }, item: DifferentialCase, owner: ViewCompactionOwner = "none"): string[] {
	const root = isolatedRoot(t);
	const seeded: Seeded = seedCase(item);
	const { engine, ctx, fire } = engineOver(root, seeded, { compactionOwner: () => owner });
	const out: string[] = [];
	for (const step of item.steps) {
		for (const request of step) {
			const result = engine.request(ctx, {
				startRef: request.startId,
				endRef: request.endId,
				summary: request.summary,
				...(request.topic ? { topic: request.topic } : {}),
				...(request.summaryMaxChars !== undefined ? { summaryMaxChars: request.summaryMaxChars } : {}),
			});
			out.push(normalized(result, seeded.manager.getEntries()));
		}
		const written = drain(fire, seeded.manager);
		out.push(normalized({ written, dropped: engine.dropped(ctx) }, seeded.manager.getEntries()));
	}
	return out;
}

const cases = differentialCases();

test("REQ-STRAT-003 live differential: the cases accept, refuse and write folds", () => {
	const outcomes = new Set<string>();
	for (const item of cases) for (const step of item.steps) if (step.length > 0) outcomes.add(item.id);
	assert.ok(cases.length >= 30, `the differential runs every case: ${cases.length}`);
	assert.ok(outcomes.size === cases.length, "every case asks for at least one fold");
});

for (const item of cases) {
	test(`REQ-STRAT-003 live differential: ${item.id}: every context_fold answer and every boundary write is the legacy path's`, (t) => {
		compareWithRecord(item.id, () => foldRun(t, item));
	});
}

// CR-ONE-WRITER-DECISION: the one-writer rule is for compaction only, so another owner holding the compaction claim
// changes no fold decision: every case answers and writes what the legacy path did, which had no such rule.
test("REQ-STRAT-003 live differential, CR-ONE-WRITER-DECISION: with another owner holding the compaction claim, every context_fold answer and boundary write is still the legacy path's", (t) => {
	for (const item of cases) compareWithRecord(item.id, () => foldRun(t, item, "other"));
});

// --- Requests ------------------------------------------------------------------------------------------------

/** A session manager over a prefix of fixed entries: the branch grows as a recorded session did. */
function growingManager(entries: readonly SessionEntry[]) {
	let length = 0;
	const view = () => entries.slice(0, length);
	const leaf = () => view().at(-1)?.id ?? null;
	const byId = () => new Map(view().map((entry) => [entry.id, entry]));
	const manager = {
		grow: (to: number) => { length = to; },
		getBranch: view,
		getEntries: view,
		getLeafId: leaf,
		getHeader: () => ({ type: "session", version: 3, id: "fixture", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/redacted/project" }),
		getCwd: () => "/redacted/project",
		getSessionId: () => "fixture",
		buildSessionProjection: () => buildSessionProjection(view(), leaf(), byId()),
		buildContextEntries: () => buildContextEntries(view(), leaf(), byId()),
		buildSessionContext: () => buildSessionContext(view(), leaf(), byId()),
	};
	return manager;
}

interface Turn {
	readonly turn: FoldTurnResult | undefined;
	readonly pressure: RequestPressure | null;
	readonly passFailed: boolean;
}

/** The host around the session: a model that reads images, and the project's settings (a recipe). */
interface Host {
	readonly vision?: boolean;
	readonly settings?: Record<string, unknown>;
}

interface Tools {
	readonly label: string;
	readonly reachable: readonly string[];
	readonly telemetry?: "full" | "band" | "off";
}

const REGISTERED = ["bash", "read", "context_status", "context_fold", "context_compact", "context_recall"];
const TOOLS: readonly Tools[] = [
	{ label: "main session", reachable: ["bash", "read", "context_status", "context_fold", "context_compact", "context_recall"] },
	{ label: "Fabric child without context tools", reachable: ["bash", "read"] },
	{ label: "compact only", reachable: ["bash", "read", "context_compact"] },
	{ label: "band telemetry", reachable: ["bash", "read", "context_fold"], telemetry: "band" },
	{ label: "telemetry off", reachable: ["bash", "read", "context_fold", "context_compact"], telemetry: "off" },
];

/** The tools the view reads, and the telemetry mode. */
function toolOptions(tools: Tools): FoldEngineOptions {
	return {
		tools: () => ({ reachable: tools.reachable, registered: REGISTERED }),
		...(tools.telemetry ? { telemetryMode: () => tools.telemetry! } : {}),
	};
}

/**
 * A recorded branch through one runtime: before each recorded request the branch grows to it and the context
 * handler runs on Pi's messages for it, with Pi's usage as the previous request's recorded size; a turn boundary
 * follows each request. Each request gives the messages sent, the injected text, the metrics turn and the writes.
 */
function requestRun(t: { after(fn: () => void | Promise<void>): void }, entries: readonly SessionEntry[], points: readonly { readonly pathIndex: number; readonly usage?: number }[], window: number, tools: Tools, host: Host = {}): string[] {
	const root = isolatedRoot(t);
	if (host.settings) {
		fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify(host.settings));
	}
	const manager = growingManager(entries);
	let usage: number | undefined;
	const turns: Turn[] = [];
	const seeded = { manager: manager as unknown as SessionManager, ids: [], modelContextLimit: window } as Seeded;
	const { engine, ctx, fire } = engineOver(root, seeded, {
		...toolOptions(tools),
		metrics: { onTurn: (_ctx, turn, pressure, passFailed) => { turns.push({ turn, pressure, passFailed }); } },
	}, REGISTERED);
	Object.assign(ctx, { getContextUsage: () => (usage === undefined ? undefined : { tokens: usage, contextWindow: window }) });
	if (host.vision) Object.assign(ctx, { model: { id: "synthetic-vision", contextWindow: window, input: ["text", "image"] } });
	const out: string[] = [];
	for (const point of points) {
		manager.grow(point.pathIndex);
		const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system") as ContextEvent["messages"];
		const [result] = fire("context", { type: "context", messages }) as [{ messages?: ContextEvent["messages"] } | undefined];
		const turn = turns.at(-1);
		const written = fire("turn_end", { entries: [] }) as ({ entries?: Drafts } | undefined)[];
		out.push(normalized({
			sent: result?.messages ?? null,
			injection: engine.injection(ctx) ?? null,
			pressure: turn?.pressure ?? null,
			passFailed: turn?.passFailed ?? null,
			nudge: turn?.turn?.nudge ?? null,
			nudgeKind: turn?.turn?.nudgeKind ?? null,
			tokens: turn?.turn?.tokens ?? null,
			emergency: turn?.turn?.emergency ?? null,
			written: written.flatMap((item) => item?.entries ?? []),
		}, manager.getEntries()));
		if (point.usage !== undefined) usage = point.usage;
	}
	return out;
}

const FOLD_SESSION = path.join(FIXTURES, "strategy-bench/corpus/fold-session/session.jsonl");

test("REQ-STRAT-003 live differential: every request of the recorded fold session sends, injects and measures what the legacy path did", (t) => {
	const recording = readRecording(fs.readFileSync(FOLD_SESSION, "utf8"))!;
	assert.equal(recording.requests.length, 32, "the recorded session has its 32 requests");
	assert.ok(recording.folds.length >= 1, "and its fold");
	const points = recording.requests.map((request) => ({ pathIndex: request.pathIndex, usage: request.usage.input + request.usage.cacheRead + request.usage.cacheWrite }));
	for (const window of [200_000, 1_000_000]) {
		for (const tools of TOOLS) {
			const label = `fold session, ${window} window, ${tools.label}`;
			compareWithRecord(label, () => requestRun(t, recording.path, points, window, tools));
		}
	}
});

/** A synthetic session: per turn a user message, tool calls with results of the given sizes, and an answer. */
function synthetic(turns: readonly (readonly number[])[]): { entries: SessionEntry[]; points: { pathIndex: number; usage: number }[] } {
	const manager = SessionManager.inMemory("/tmp");
	const points: { pathIndex: number; usage: number }[] = [];
	let size = 20_000;
	const filler = (chars: number) => "word ".repeat(Math.ceil(chars / 5)).slice(0, chars);
	const request = () => points.push({ pathIndex: manager.getEntries().length, usage: size });
	turns.forEach((results, turn) => {
		manager.appendMessage({ role: "user", content: `${filler(400)} turn ${turn}`, timestamp: 1 });
		size += 100;
		results.forEach((chars, step) => {
			request();
			const id = `call-${turn}-${step}`;
			manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", { command: `step ${turn} ${step}` }, { id }), { stopReason: "toolUse", timestamp: 1 }));
			manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: filler(chars) }], isError: false, timestamp: 1 });
			size += 15 + Math.ceil(chars / 4);
		});
		request();
		manager.appendMessage(fauxAssistantMessage(filler(600), { timestamp: 1 }));
		size += 150;
	});
	return { entries: manager.getEntries(), points };
}

const SYNTHETIC: Readonly<Record<string, readonly (readonly number[])[]>> = {
	// Steady growth over many turns: several tier-1 nudges, and the pressure bands.
	steady: Array.from({ length: 14 }, () => Array.from({ length: 6 }, () => 12_000)),
	// One long turn: the once-per-turn gate and its re-anchor.
	longTurn: [[8_000, 8_000], Array.from({ length: 50 }, () => 9_000), [8_000]],
	// Mixed sizes with some very large results: the last ladder step's truncation and its hides.
	mixed: Array.from({ length: 12 }, (_, turn) => Array.from({ length: 5 }, (_, step) => ((turn * 7 + step * 13) % 5 === 0 ? 60_000 : 600 + ((turn * 31 + step * 17) % 9) * 1_500))),
};

for (const [name, turns] of Object.entries(SYNTHETIC)) {
	test(`REQ-STRAT-003 live differential: every request of the ${name} session sends, injects and measures what the legacy path did`, (t) => {
		const { entries, points } = synthetic(turns);
		// Every tool set on the 200k window, where the bands and the last step are reached; the main session on a 1M window.
		for (const [window, toolSets] of [[200_000, TOOLS], [1_000_000, TOOLS.slice(0, 1)]] as const) {
			for (const tools of toolSets) {
				const label = `${name}, ${window} window, ${tools.label}`;
				compareWithRecord(label, () => requestRun(t, entries, points, window, tools));
			}
		}
	});
}

/**
 * A synthetic session whose tool results carry screenshots: per turn a user message, `shots` tool calls whose
 * results hold text and one PNG, and an answer.
 */
function screenshots(turns: number, shots: number): { entries: SessionEntry[]; points: { pathIndex: number; usage: number }[] } {
	const manager = SessionManager.inMemory("/tmp");
	const points: { pathIndex: number; usage: number }[] = [];
	let size = 20_000;
	const filler = (chars: number) => "word ".repeat(Math.ceil(chars / 5)).slice(0, chars);
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({ role: "user", content: `${filler(400)} turn ${turn}`, timestamp: 1 });
		size += 100;
		for (let step = 0; step < shots; step++) {
			points.push({ pathIndex: manager.getEntries().length, usage: size });
			const id = `shot-${turn}-${step}`;
			manager.appendMessage(fauxAssistantMessage(fauxToolCall("screenshot", { page: `${turn}/${step}` }, { id }), { stopReason: "toolUse", timestamp: 1 }));
			const data = Buffer.from(`synthetic png ${turn} ${step} `.repeat(400)).toString("base64");
			manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "screenshot", content: [{ type: "text", text: filler(3_000) }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 1 });
			size += 2_400;
		}
		points.push({ pathIndex: manager.getEntries().length, usage: size });
		manager.appendMessage(fauxAssistantMessage(filler(600), { timestamp: 1 }));
		size += 150;
	}
	return { entries: manager.getEntries(), points };
}

// Host shapes beyond the main session at 200k (CR-COMPACTION-UNDIFFERENCED, caair/pi/pi-context-aware!418): a model that
// reads images, windows below 200k, and the compaction-only recipe chosen by either setting. Recorded at 7e692d0.
test("REQ-STRAT-003 live differential: a session with screenshots sends what the legacy path did, for a model that reads images and one that does not", (t) => {
	const { entries, points } = screenshots(10, 4);
	for (const vision of [true, false]) {
		const label = `screenshots, 200000 window, ${vision ? "vision model" : "text model"}`;
		compareWithRecord(label, () => requestRun(t, entries, points, 200_000, TOOLS[0]!, { vision }));
	}
});

test("REQ-STRAT-003 live differential: windows below 200k send what the legacy path did", (t) => {
	for (const name of ["steady", "mixed"] as const) {
		const { entries, points } = synthetic(SYNTHETIC[name]!);
		for (const window of [64_000, 128_000]) {
			for (const tools of [TOOLS[0]!, TOOLS[1]!]) {
				const label = `${name}, ${window} window, ${tools.label}`;
				compareWithRecord(label, () => requestRun(t, entries, points, window, tools));
			}
		}
	}
});

test("REQ-STRAT-003 live differential: a session on the compaction-only recipe sends what the legacy path did", (t) => {
	const { entries, points } = synthetic(SYNTHETIC.steady!);
	for (const [setting, settings] of [["folds.engine compaction-only", { folds: { engine: "compaction-only" } }], ["strategy.methods compact", { strategy: { methods: ["compact"] } }]] as const) {
		for (const tools of [TOOLS[0]!, TOOLS[2]!]) {
			const label = `steady, 200000 window, ${tools.label}, ${setting}`;
			compareWithRecord(label, () => requestRun(t, entries, points, 200_000, tools, { settings }));
		}
	}
});

test("REQ-STRAT-003 live differential: the sessions reach what the pass does: nudges of each kind, both pressure bands, emergency truncation and hides", (t) => {
	const seen = { nudgeKinds: new Set<string>(), bands: new Set<string>(), emergency: 0, hides: 0 };
	const runs = [...Object.values(SYNTHETIC).map((turns) => synthetic(turns))];
	for (const { entries, points } of runs) {
		for (const window of [200_000]) {
			for (const decision of requestRun(t, entries, points, window, TOOLS[0]!)) {
				const parsed = JSON.parse(decision) as { nudgeKind: string | null; pressure: { band: string } | null; emergency: unknown; written: { type: string }[] };
				if (parsed.nudgeKind) seen.nudgeKinds.add(parsed.nudgeKind);
				if (parsed.pressure) seen.bands.add(parsed.pressure.band);
				if (parsed.emergency) seen.emergency++;
				seen.hides += parsed.written.filter((draft) => draft.type === "context_edit").length;
			}
		}
	}
	assert.ok(seen.nudgeKinds.has("tier1"), `tier-1 nudges: ${[...seen.nudgeKinds].join(", ")}`);
	assert.ok(seen.bands.has("WARN") && seen.bands.has("URGENT") && seen.bands.has("OK"), `bands: ${[...seen.bands].join(", ")}`);
	assert.ok(seen.emergency > 0, "requests past the last ladder step");
	assert.ok(seen.hides > 0, "hides written at a boundary");
});