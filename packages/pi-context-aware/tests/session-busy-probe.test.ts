import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_UNATTRIBUTABLE_STALE_MS,
	MAX_BUSY_PROBE_BYTES,
	probeSessionBusy,
	readBusyProbeOverride,
	readDelegateRunState,
	resolveAgentDir,
	unattributableStaleMs,
} from "../session-busy-probe.js";

const SESSION = "01a02aac-a506-77ee-9944-dfb048b964d1";
const OTHER = "01a0275b-2dcb-7ff4-b371-c6e8624834e8";

/**
 * Temp directories created here, removed when this file finishes.
 *
 * A test that leaks one per run fills /tmp on a machine that runs the suite
 * often, and the failure lands on whatever runs next as ENOSPC.
 */
const created: string[] = [];

function agentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-aware-busy-"));
	created.push(dir);
	return dir;
}

test.after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDelegate(dir: string, value: unknown): void {
	const target = path.join(dir, "extensions", "pi-delegate");
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(
		path.join(target, "run-state.json"),
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

function writeOrchestrateMarker(
	dir: string,
	sessionId: string,
	runId: string,
	value: Record<string, unknown> | string,
): void {
	const ownerKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	const target = path.join(dir, "extensions", "pi-delegate", "orchestrate", "active", ownerKey);
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(
		path.join(target, `${runId}.json`),
		typeof value === "string" ? value : JSON.stringify({ runId, ownerSessionId: sessionId, ...value }),
	);
}

function orchestrateMarker(over: Record<string, unknown> = {}): Record<string, unknown> {
	const slot = String(process.pid).padStart(10, "0");
	return {
		runnerPid: slot,
		runnerPidCopy: slot,
		parentPid: slot,
		parentPidCopy: slot,
		...over,
	};
}

async function exitedChildPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
	assert.ok(pid !== undefined);
	return pid;
}

function liveRun(
	owner?: string,
	runId = "r1",
	rootRunId?: string,
	status = "running",
): Record<string, unknown> {
	return {
		runId,
		...(owner === undefined ? {} : { ownerSessionId: owner }),
		...(rootRunId === undefined ? {} : { rootRunId }),
		forks: { lane: { status } },
	};
}

test("a running delegate run dispatched by this session is busy", () => {
	// The measured case: the reminder fired nine seconds after a dispatch while
	// the worker ran for another thirteen minutes (#45).
	const reading = readDelegateRunState({ runs: [liveRun(SESSION)] }, SESSION);
	assert.equal(reading.kind, "busy");
});

test("canonical live and terminal fork statuses determine run liveness", () => {
	const liveStatuses = ["pending", "constructing", "running", "awaiting-escalation"];
	for (const status of liveStatuses) {
		assert.equal(readDelegateRunState({ runs: [liveRun(SESSION, "live", undefined, status)] }, SESSION).kind, "busy", status);
		assert.equal(readDelegateRunState({ runs: [liveRun(OTHER, "foreign-live", undefined, status)] }, SESSION).kind, "clear", status);
	}
	for (const status of ["completed", "failed", "aborted", "paused"]) {
		assert.equal(readDelegateRunState({ runs: [liveRun(SESSION, "terminal", undefined, status)] }, SESSION).kind, "clear", status);
	}
	assert.equal(readDelegateRunState({ runs: [{ ...liveRun(SESSION), completedAt: null }] }, SESSION).kind, "busy");
});

test("each canonical live status attributes an ownerless child through root state", () => {
	for (const status of ["pending", "constructing", "running", "awaiting-escalation"]) {
		const child = liveRun(undefined, "child", "root", status);
		const ownRoot = { ...liveRun(SESSION, "root", "root"), completedAt: 1, forks: { lane: { status: "completed" } } };
		const foreignRoot = { ...liveRun(OTHER, "root", "root"), completedAt: 1, forks: { lane: { status: "completed" } } };
		assert.equal(readDelegateRunState({ runs: [child, ownRoot] }, SESSION).kind, "busy", `${status}: own root`);
		assert.equal(readDelegateRunState({ runs: [child, foreignRoot] }, SESSION).kind, "clear", `${status}: foreign root`);
		assert.equal(readDelegateRunState({ runs: [child] }, SESSION).kind, "unknown", `${status}: missing root`);
	}
});

test("an unknown future fork status is live and has all ownership outcomes", () => {
	const future = "future-runtime-status";
	assert.equal(readDelegateRunState({ runs: [liveRun(SESSION, "future", undefined, future)] }, SESSION).kind, "busy");
	assert.equal(readDelegateRunState({ runs: [liveRun(OTHER, "future", undefined, future)] }, SESSION).kind, "clear");
	assert.equal(
		readDelegateRunState(
			{ runs: [liveRun(undefined, "child", "foreign-root", future), liveRun(OTHER, "foreign-root")] },
			SESSION,
		).kind,
		"clear",
	);
	assert.equal(
		readDelegateRunState(
			{ runs: [liveRun(undefined, "child", "owned-root", future), liveRun(SESSION, "owned-root")] },
			SESSION,
		).kind,
		"busy",
	);
	assert.equal(readDelegateRunState({ runs: [liveRun(undefined, "child", "missing-root", future)] }, SESSION).kind, "unknown");
});

test("a live run with missing forks is unknown rather than clear", () => {
	const reading = readDelegateRunState({ runs: [{ runId: "r1", ownerSessionId: SESSION }] }, SESSION);
	assert.equal(reading.kind, "unknown");
	assert.equal(reading.reason, "delegate run-state has a live run with no recognisable worker-session records");
});

test("a live run with malformed forks is unknown rather than clear", () => {
	const reading = readDelegateRunState({ runs: [{ runId: "r1", ownerSessionId: SESSION, forks: null }] }, SESSION);
	assert.equal(reading.kind, "unknown");
	assert.equal(reading.reason, "delegate run-state has a live run with no recognisable worker-session records");
});

test("malformed fork entries and statuses are unknown, while extra fields are tolerated", () => {
	const malformedForks = [
		{ lane: null },
		{ lane: {} },
		{ lane: { status: 7 } },
	];
	for (const forks of malformedForks) {
		const reading = readDelegateRunState({ runs: [{ runId: "r1", ownerSessionId: SESSION, forks }] }, SESSION);
		assert.equal(reading.kind, "unknown");
		assert.equal(reading.reason, "delegate run-state has an unrecognisable worker-session record");
	}
	assert.equal(
		readDelegateRunState(
			{ runs: [{ runId: "r1", ownerSessionId: SESSION, forks: { lane: { status: "running", extra: true } } }] },
			SESSION,
		).kind,
		"busy",
	);
});

test("another session's running work does not silence this session", () => {
	const reading = readDelegateRunState({ runs: [liveRun(OTHER)] }, SESSION);
	assert.equal(reading.kind, "clear", "only this session's own work may suppress it");
});

test("a finished run is not busy", () => {
	const completed = { ...liveRun(SESSION), completedAt: 1, forks: { lane: { status: "completed" } } };
	assert.equal(readDelegateRunState({ runs: [completed] }, SESSION).kind, "clear");
	// completedAt alone settles it, whatever a stale fork status says.
	const stale = { ...liveRun(SESSION), completedAt: 1 };
	assert.equal(readDelegateRunState({ runs: [stale] }, SESSION).kind, "clear");
});

test("a running run with no owner is unknown, never clear", () => {
	// Detached and chain runs carry no ownerSessionId. One of five live runs in a
	// real sample had none, and it may belong to this session.
	const reading = readDelegateRunState({ runs: [liveRun()] }, SESSION);
	assert.equal(reading.kind, "unknown");
	assert.match(reading.reason ?? "", /ownerSessionId/u);
});

test("an unrecognisable shape is unknown, never clear", () => {
	assert.equal(readDelegateRunState({ notRuns: [] }, SESSION).kind, "unknown");
	assert.equal(readDelegateRunState([], SESSION).kind, "unknown");
	assert.equal(readDelegateRunState("nonsense", SESSION).kind, "unknown");
	// Entries that are not records are malformed state, not proof of idleness.
	assert.equal(readDelegateRunState({ runs: [null, 7, "x"] }, SESSION).kind, "unknown");
});

test("this session's own busy run wins over an unattributable one in either order", () => {
	const uncertain = liveRun();
	const own = liveRun(SESSION);
	for (const runs of [[uncertain, own], [own, uncertain]] as const) {
		assert.equal(readDelegateRunState({ runs }, SESSION).kind, "busy", "a definite answer beats a doubt");
	}
});

test("an owner-labelled non-root run cannot establish root ownership", () => {
	const claimedRoot = { ...liveRun(OTHER, "root"), rootRunId: "different-root" };
	const child = liveRun(undefined, "child", "root");
	const reading = readDelegateRunState({ runs: [child, claimedRoot] }, SESSION);
	assert.equal(reading.kind, "unknown");
	assert.match(reading.reason, /ownerSessionId/u);
});

test("a present child owner is authoritative over its root owner", () => {
	const child = liveRun(OTHER, "child", "root");
	const root = { ...liveRun(SESSION, "root"), completedAt: 1, forks: { lane: { status: "completed" } } };
	assert.equal(readDelegateRunState({ runs: [child, root] }, SESSION).kind, "clear");
});

test("an owner-less live child referencing a malformed root is unknown", () => {
	const malformedRoot = { ...liveRun(OTHER, "root"), rootRunId: 7 };
	const child = liveRun(undefined, "child", "root");
	const reading = readDelegateRunState({ runs: [child, malformedRoot] }, SESSION);
	assert.equal(reading.kind, "unknown");
});

test("a present child owner remains authoritative over non-root evidence", () => {
	const child = liveRun(OTHER, "child", "root");
	const nonRootCandidate = {
		...liveRun(SESSION, "root"),
		rootRunId: "different-root",
		completedAt: 1,
		forks: { lane: { status: "completed" } },
	};
	assert.equal(readDelegateRunState({ runs: [child, nonRootCandidate] }, SESSION).kind, "clear");
});

test("a malformed foreign root candidate is unknown in either record order", () => {
	const child = { runId: "child", rootRunId: "root", forks: { lane: { status: "running" } } };
	const candidate = { runId: "root", ownerSessionId: OTHER };
	for (const runs of [[child, candidate], [candidate, child]] as const) {
		assert.equal(readDelegateRunState({ runs }, SESSION).kind, "unknown");
	}
});

test("duplicate root records do not establish ownership", () => {
	const firstRoot = liveRun(OTHER, "root");
	const secondRoot = liveRun("01a02f5d-79cc-7f7c-a2f2-5ad3adcd17d1", "root");
	const child = liveRun(undefined, "child", "root");
	const reading = readDelegateRunState({ runs: [child, firstRoot, secondRoot] }, SESSION);
	assert.equal(reading.kind, "unknown");
});

test("duplicate root records are ambiguous in either order", () => {
	const roots = [
		liveRun(OTHER, "root", "root"),
		liveRun("01a02f5d-79cc-7f7c-a2f2-5ad3adcd17d1", "root", "root"),
	] as const;
	const child = liveRun(undefined, "child", "root");
	for (const orderedRoots of [roots, [roots[1], roots[0]] as const]) {
		assert.equal(readDelegateRunState({ runs: [child, ...orderedRoots] }, SESSION).kind, "unknown");
	}
});

test("an owner-less live child rooted in another session is ruled out", () => {
	const root = liveRun(OTHER, "root");
	const child = liveRun(undefined, "child", "root");
	assert.equal(readDelegateRunState({ runs: [child, root] }, SESSION).kind, "clear");
});

test("an owner-less live child rooted in this session is busy", () => {
	const root = liveRun(SESSION, "root");
	const child = liveRun(undefined, "child", "root");
	const reading = readDelegateRunState({ runs: [child, root] }, SESSION);
	assert.equal(reading.kind, "busy");
	assert.equal(reading.reason, "a worker session without a direct owner belongs to this session's root run");
});

test("a completed root owned by this session makes its owner-less child busy", () => {
	const child = liveRun(undefined, "child", "root");
	const completedRoot = {
		...liveRun(SESSION, "root", "root"),
		completedAt: 1,
		forks: { lane: { status: "completed" } },
	};
	assert.equal(readDelegateRunState({ runs: [child, completedRoot] }, SESSION).kind, "busy");
});

test("completed legacy roots remain usable for ownerless child attribution", () => {
	const child = liveRun(undefined, "child", "root");
	for (const [owner, expected] of [[SESSION, "busy"], [OTHER, "clear"]] as const) {
		const completedLegacyRoot = {
			...liveRun(owner, "root"),
			completedAt: 1,
			forks: { lane: { status: "completed" } },
		};
		assert.equal(readDelegateRunState({ runs: [child, completedLegacyRoot] }, SESSION).kind, expected, owner);
	}
});

test("a completed root owned by another session rules out its owner-less child", () => {
	const child = liveRun(undefined, "child", "root");
	const completedRoot = {
		...liveRun(OTHER, "root", "root"),
		completedAt: 1,
		forks: { lane: { status: "completed" } },
	};
	assert.equal(readDelegateRunState({ runs: [child, completedRoot] }, SESSION).kind, "clear");
});

test("completed malformed foreign roots are unknown in either record order", () => {
	const child = liveRun(undefined, "child", "root");
	const malformedRoots = [
		{ ...liveRun(OTHER, "root", "root"), completedAt: 1, forks: null },
		{ ...liveRun(OTHER, "root", "root"), completedAt: 1, forks: { lane: { status: 7 } } },
	] as const;
	for (const malformedRoot of malformedRoots) {
		for (const runs of [[child, malformedRoot], [malformedRoot, child]] as const) {
			assert.equal(readDelegateRunState({ runs }, SESSION).kind, "unknown");
		}
	}
});

test("a malformed completed root invalidates prior ownership in either root order", () => {
	const child = liveRun(undefined, "child", "root");
	const validRoot = {
		...liveRun(OTHER, "root", "root"),
		completedAt: 1,
		forks: { lane: { status: "completed" } },
	};
	const malformedRoots = [
		{ ...validRoot, forks: null },
		{ ...validRoot, forks: { lane: { status: 7 } } },
	] as const;
	for (const malformedRoot of malformedRoots) {
		for (const roots of [[validRoot, malformedRoot], [malformedRoot, validRoot]] as const) {
			assert.equal(readDelegateRunState({ runs: [child, ...roots] }, SESSION).kind, "unknown");
		}
	}
});

test("an owner-less live child with no attributable root is unknown", () => {
	const missingRoot = liveRun(undefined, "child", "missing-root");
	const ownerLessRoot = liveRun(undefined, "child", "root");
	assert.equal(readDelegateRunState({ runs: [missingRoot] }, SESSION).kind, "unknown");
	assert.equal(readDelegateRunState({ runs: [ownerLessRoot, { ...liveRun(undefined, "root") }] }, SESSION).kind, "unknown");
});

test("malformed root completion, owner, and identity fields fail closed", () => {
	const child = liveRun(undefined, "child", "root");
	const malformedRoots = [
		{ ...liveRun(OTHER, "root", "root"), completedAt: "not-a-timestamp" },
		{ ...liveRun(OTHER, "root", "root"), ownerSessionId: 7 },
		{ ...liveRun(OTHER, "root", "root"), rootRunId: 7 },
	] as const;
	for (const malformedRoot of malformedRoots) {
		for (const runs of [[child, malformedRoot], [malformedRoot, child]] as const) {
			assert.equal(readDelegateRunState({ runs }, SESSION).kind, "unknown");
		}
	}
});

test("malformed completedAt and an empty root owner never establish idle", () => {
	const child = liveRun(undefined, "child", "root");
	const malformedCompletion = { ...liveRun(OTHER, "root", "root"), completedAt: "not-a-timestamp" };
	const emptyOwnerRoot = { ...liveRun("", "root", "root"), completedAt: 1, forks: { lane: { status: "completed" } } };
	for (const root of [malformedCompletion, emptyOwnerRoot]) {
		for (const runs of [[child, root], [root, child]] as const) {
			assert.equal(readDelegateRunState({ runs }, SESSION).kind, "unknown");
		}
	}
});

test("string root and owner fields remain structurally valid", () => {
	assert.equal(readDelegateRunState({ runs: [{ ...liveRun(OTHER, "empty-root", "") }] }, SESSION).kind, "clear");
	for (const owner of ["", `${String.fromCharCode(0)}foreign-owner`, "x".repeat(513)]) {
		assert.equal(readDelegateRunState({ runs: [liveRun(owner, "foreign-owner")] }, SESSION).kind, "clear", owner);
	}
});

test("malformed run entries do not outrank a definite busy run in either order", () => {
	const own = liveRun(SESSION, "own");
	for (const runs of [[null, own], [own, null]] as const) {
		assert.equal(readDelegateRunState({ runs }, SESSION).kind, "busy");
	}
});

test("nothing running is the only way to reach idle", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "idle");
});

test("an absent file is a real answer: nothing has been recorded", async () => {
	const dir = agentDir();
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "idle", "a package that never ran is not a reason to stay silent");
});

test("a JSON null run-state is not a missing file", async () => {
	const dir = agentDir();
	writeDelegate(dir, "null");
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown");
});

test("a half-written file suppresses rather than guessing idle", async () => {
	// A concurrent writer can be caught mid-write.
	const dir = agentDir();
	writeDelegate(dir, "{ half-written");
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown");
	assert.match(result.reason, /malformed json/u);
});

test("a valid live idle response bypasses malformed and oversized historical run-state", async () => {
	for (const historical of [
		"{ half-written",
		`{"runs":[],"pad":"${"x".repeat(MAX_BUSY_PROBE_BYTES + 1)}"}`,
	]) {
		const dir = agentDir();
		writeDelegate(dir, historical);
		const events = {
			emit(channel: string, data: unknown) {
				assert.equal(channel, "pi-delegate:session-active-work-query:v1");
				const request = data as { version: number; ownerSessionId: string; response?: unknown };
				assert.deepEqual(request, { version: 1, ownerSessionId: SESSION });
				request.response = { version: 1, status: "idle", producer: "test" };
			},
		};
		const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, {}, events);
		assert.equal(result.verdict, "idle");
	}
});

test("an absent live listener preserves the historical run-state fallback", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const events = { emit(_channel: string, _data: unknown) {} };
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, {}, events);
	assert.equal(result.verdict, "busy");
});

test("malformed live responses fail closed without historical fallback", async () => {
	for (const response of [
		undefined,
		null,
		[],
		{ version: 2, status: "busy" },
		{ version: 1, status: "settled" },
	]) {
		const dir = agentDir();
		writeDelegate(dir, { runs: [liveRun(SESSION)] });
		const events = {
			emit(_channel: string, data: unknown) {
				(data as { response?: unknown }).response = response;
			},
		};
		const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, {}, events);
		assert.equal(result.verdict, "unknown");
		assert.match(result.reason, /malformed response/u);
	}
});

test("a thrown live query fails closed without historical fallback", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const events = {
		emit() {
			throw new Error("producer failed");
		},
	};
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, {}, events);
	assert.equal(result.verdict, "unknown");
	assert.match(result.reason, /query threw/u);
});

test("a valid live unknown response bypasses historical state and remains overrideable", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const events = {
		emit(_channel: string, data: unknown) {
			(data as { response?: unknown }).response = { version: 1, status: "unknown", detail: "starting" };
		},
	};
	const normal = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, {}, events);
	assert.equal(normal.verdict, "unknown");
	const overridden = await probeSessionBusy(
		SESSION,
		{ PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" },
		{},
		events,
	);
	assert.equal(overridden.verdict, "idle");
});

test("a file past the byte cap suppresses", async () => {
	const dir = agentDir();
	writeDelegate(dir, `{"runs":[],"pad":"${"x".repeat(MAX_BUSY_PROBE_BYTES + 1)}"}`);
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown");
});

test("a session with no id can attribute nothing, so it is unknown", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	const result = await probeSessionBusy("", { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown", "without an identity nothing can be ruled out");
});

test("a running run for this session reaches the caller as busy", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "busy");
});

test("a live orchestrate marker for this session is busy", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	writeOrchestrateMarker(dir, SESSION, "live", orchestrateMarker());
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "busy");
});

test("detached orchestrate markers remain unioned with live delegate responses", async () => {
	const liveIdle = {
		emit(_channel: string, data: unknown) {
			(data as { response?: unknown }).response = { version: 1, status: "idle" };
		},
	};

	const busyDir = agentDir();
	writeDelegate(busyDir, "{ half-written");
	writeOrchestrateMarker(busyDir, SESSION, "live-union", orchestrateMarker());
	assert.equal(
		(await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: busyDir }, {}, liveIdle)).verdict,
		"busy",
	);

	const uncertainDir = agentDir();
	writeDelegate(uncertainDir, "{ half-written");
	writeOrchestrateMarker(uncertainDir, SESSION, "uncertain-union", "{ half-written");
	assert.equal(
		(await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: uncertainDir }, {}, liveIdle)).verdict,
		"unknown",
	);
});

test("a marker missing when opened is ignored", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	const ownerKey = createHash("sha256").update(SESSION).digest("hex").slice(0, 32);
	const markerDir = path.join(dir, "extensions", "pi-delegate", "orchestrate", "active", ownerKey);
	fs.mkdirSync(markerDir, { recursive: true });
	fs.symlinkSync("missing-marker.json", path.join(markerDir, "vanished.json"));
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "idle");
});

test("a present JSON null marker suppresses", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	writeOrchestrateMarker(dir, SESSION, "null", "null");
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown");
});

test("a stale orchestrate marker does not suppress continuation", async () => {
	const deadPid = await exitedChildPid();
	const slot = String(deadPid).padStart(10, "0");
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	writeOrchestrateMarker(dir, SESSION, "stale", orchestrateMarker({ runnerPid: slot, runnerPidCopy: slot }));
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "idle");
});

test("an unsafe orchestrate marker id suppresses even when its runner is stale", async () => {
	const deadPid = await exitedChildPid();
	const slot = String(deadPid).padStart(10, "0");
	for (const runId of ["unsafe id", "x".repeat(129)]) {
		const dir = agentDir();
		writeDelegate(dir, { runs: [] });
		writeOrchestrateMarker(dir, SESSION, runId, orchestrateMarker({ runnerPid: slot, runnerPidCopy: slot }));
		const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
		assert.equal(result.verdict, "unknown", runId);
		assert.match(result.reason, /unsafe runId/u);
	}
});

test("busy wins over unknown sources and uncertain markers", async () => {
	const unknownRunState = agentDir();
	writeDelegate(unknownRunState, "{ half-written");
	writeOrchestrateMarker(unknownRunState, SESSION, "live", orchestrateMarker());
	assert.equal((await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: unknownRunState })).verdict, "busy");

	const uncertainMarker = agentDir();
	writeDelegate(uncertainMarker, { runs: [] });
	writeOrchestrateMarker(uncertainMarker, SESSION, "a-uncertain", "{ half-written");
	writeOrchestrateMarker(uncertainMarker, SESSION, "b-live", orchestrateMarker());
	assert.equal((await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: uncertainMarker })).verdict, "busy");
});

test("placeholder, torn, and malformed orchestrate markers suppress", async () => {
	const cases: Array<Record<string, unknown> | string> = [
		orchestrateMarker({ runnerPid: "0000000000", runnerPidCopy: "0000000000" }),
		orchestrateMarker({ runnerPid: "0000000001", runnerPidCopy: "0000000002" }),
		"{ half-written",
	];
	for (const [index, marker] of cases.entries()) {
		const dir = agentDir();
		writeDelegate(dir, { runs: [] });
		writeOrchestrateMarker(dir, SESSION, `uncertain-${index}`, marker);
		const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
		assert.equal(result.verdict, "unknown");
	}
});

test("identity and parent-slot tears suppress", async () => {
	const cases: Array<Record<string, unknown>> = [
		orchestrateMarker({ runId: "other-run" }),
		orchestrateMarker({ ownerSessionId: OTHER }),
		orchestrateMarker({ parentPid: "0000000001", parentPidCopy: "0000000002" }),
	];
	for (const [index, marker] of cases.entries()) {
		const dir = agentDir();
		writeDelegate(dir, { runs: [] });
		writeOrchestrateMarker(dir, SESSION, `identity-${index}`, marker);
		const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
		assert.equal(result.verdict, "unknown");
	}
});

test("an oversized orchestrate marker suppresses", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	writeOrchestrateMarker(dir, SESSION, "oversized", orchestrateMarker({ pad: "x".repeat(4097) }));
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "unknown");
});

test("the agent directory follows PI_CODING_AGENT_DIR, then HOME", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/explicit" }), "/explicit");
	assert.equal(resolveAgentDir({ HOME: "/home/someone" }), path.join("/home/someone", ".pi", "agent"));
});

// ── Staleness fallback for leaked orphan runs ─────────────────────────────

const NOW = 1_800_000_000_000;
const STALE = DEFAULT_UNATTRIBUTABLE_STALE_MS;

test("an unattributable run older than the staleness bound stops suppressing", () => {
	// A leaked orphan: no owner, no attributable root, created well past the
	// bound. It is treated as a dead session's residue, not a doubt.
	const orphan = { runId: "orphan", createdAt: NOW - STALE - 1, forks: { lane: { status: "running" } } };
	assert.equal(readDelegateRunState({ runs: [orphan] }, SESSION, { now: NOW }).kind, "clear");
});

test("an unattributable run within the staleness bound still suppresses", () => {
	const fresh = { runId: "fresh", createdAt: NOW - STALE + 60_000, forks: { lane: { status: "running" } } };
	const reading = readDelegateRunState({ runs: [fresh] }, SESSION, { now: NOW });
	assert.equal(reading.kind, "unknown");
	assert.match(reading.reason ?? "", /ownerSessionId/u);
});

test("recent fork activity keeps an otherwise-old run a live doubt", () => {
	// createdAt is ancient, but the worker emitted a moment ago: the freshest
	// signal wins, so this is still live and must suppress.
	const active = {
		runId: "active",
		createdAt: NOW - STALE * 10,
		forks: { lane: { status: "running", lastActivityAt: NOW - 1_000 } },
	};
	assert.equal(readDelegateRunState({ runs: [active] }, SESSION, { now: NOW }).kind, "unknown");
});

test("stale fork activity ages a run out even when createdAt is missing", () => {
	const orphan = { runId: "orphan", forks: { lane: { status: "running", startedAt: NOW - STALE - 1 } } };
	assert.equal(readDelegateRunState({ runs: [orphan] }, SESSION, { now: NOW }).kind, "clear");
});

test("a run carrying no timestamp at all cannot be aged out", () => {
	// Nothing to measure staleness against, so it stays a doubt forever rather
	// than being guessed idle.
	const undateable = { runId: "undateable", forks: { lane: { status: "running" } } };
	assert.equal(readDelegateRunState({ runs: [undateable] }, SESSION, { now: NOW }).kind, "unknown");
});

test("this session's own old run is busy regardless of the staleness bound", () => {
	// The fallback is only ever consulted for unattributable runs; an owned run
	// returns busy before age is examined.
	const ancientOwn = { runId: "own", ownerSessionId: SESSION, createdAt: NOW - STALE * 100, forks: { lane: { status: "running" } } };
	assert.equal(readDelegateRunState({ runs: [ancientOwn] }, SESSION, { now: NOW }).kind, "busy");
});

test("an owner-less child of a stale unattributable root ages out", () => {
	const root = { runId: "root", rootRunId: "root", createdAt: NOW - STALE - 1, forks: { lane: { status: "running" } } };
	const child = { runId: "child", rootRunId: "root", createdAt: NOW - STALE - 1, forks: { lane: { status: "running" } } };
	assert.equal(readDelegateRunState({ runs: [child, root] }, SESSION, { now: NOW }).kind, "clear");
});

test("a fresh doubt still suppresses when a stale orphan is present", () => {
	const orphan = { runId: "orphan", createdAt: NOW - STALE - 1, forks: { lane: { status: "running" } } };
	const fresh = { runId: "fresh", createdAt: NOW - 1_000, forks: { lane: { status: "running" } } };
	const reading = readDelegateRunState({ runs: [orphan, fresh] }, SESSION, { now: NOW });
	assert.equal(reading.kind, "unknown");
	// Only the fresh run is counted; the stale one no longer inflates the count.
	assert.match(reading.reason ?? "", /^1 running delegate run/u);
});

test("a custom staleMs shortens the orphan window", () => {
	const run = { runId: "r", createdAt: NOW - 2_000, forks: { lane: { status: "running" } } };
	assert.equal(readDelegateRunState({ runs: [run] }, SESSION, { now: NOW, staleMs: 1_000 }).kind, "clear");
	assert.equal(readDelegateRunState({ runs: [run] }, SESSION, { now: NOW, staleMs: 10_000 }).kind, "unknown");
});

// ── unattributableStaleMs env parsing ─────────────────────────────────────

test("unattributableStaleMs defaults and rejects garbage", () => {
	assert.equal(unattributableStaleMs({}), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "" }), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "0" }), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "-5" }), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "nonsense" }), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "5000" }), 5_000);
});

// ── Manual override ───────────────────────────────────────────────────────

test("readBusyProbeOverride recognises off/idle/busy and ignores the rest", () => {
	assert.equal(readBusyProbeOverride({ PI_CONTEXT_AWARE_BUSY_PROBE: "off" }), "idle");
	assert.equal(readBusyProbeOverride({ PI_CONTEXT_AWARE_BUSY_PROBE: "idle" }), "idle");
	assert.equal(readBusyProbeOverride({ PI_CONTEXT_AWARE_BUSY_PROBE: "BUSY" }), "busy");
	assert.equal(readBusyProbeOverride({ PI_CONTEXT_AWARE_BUSY_PROBE: "  Off " }), "idle");
	assert.equal(readBusyProbeOverride({}), undefined);
	assert.equal(readBusyProbeOverride({ PI_CONTEXT_AWARE_BUSY_PROBE: "maybe" }), undefined);
});

test("the idle override clears an unattributable doubt from a poisoned run-state", async () => {
	const dir = agentDir();
	// A malformed file is normally `unknown` and suppresses; the idle override
	// collapses that residual doubt to idle.
	writeDelegate(dir, "{ half-written");
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "off" });
	assert.equal(result.verdict, "idle");
	assert.match(result.reason, /overridden to idle/u);
});

test("the idle override still reports busy for a run this session provably owns", async () => {
	// The escape hatch clears an unattributable doubt; it must never mask a live
	// worker this session owns. An owned run wins over the idle override.
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" });
	assert.equal(result.verdict, "busy");
});

test("a live busy response beats the idle override", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	const events = {
		emit(_channel: string, data: unknown) {
			(data as { response?: unknown }).response = { version: 1, status: "busy" };
		},
	};
	const result = await probeSessionBusy(
		SESSION,
		{ PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" },
		{},
		events,
	);
	assert.equal(result.verdict, "busy");
});

test("the idle override still reports busy for a live orchestrate marker this session owns", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	writeOrchestrateMarker(dir, SESSION, "live", orchestrateMarker());
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" });
	assert.equal(result.verdict, "busy");
});

test("the idle override idles an unattributable live run that would otherwise suppress", async () => {
	// A fresh orphan with no owner is normally `unknown`; the idle override treats
	// that residual doubt as idle without touching the own-session guarantee above.
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun()] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" });
	assert.equal(result.verdict, "idle");
});

test("the busy override forces suppression even with nothing running", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "busy" });
	assert.equal(result.verdict, "busy");
	assert.match(result.reason, /overridden to busy/u);
});

test("the idle override wins even without a session id", async () => {
	const dir = agentDir();
	const result = await probeSessionBusy("", { PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" });
	assert.equal(result.verdict, "idle");
});

test("a stale orphan file reaches the caller as idle end-to-end", async () => {
	const dir = agentDir();
	const old = Date.now() - DEFAULT_UNATTRIBUTABLE_STALE_MS - 60_000;
	writeDelegate(dir, { runs: [{ runId: "orphan", createdAt: old, forks: { lane: { status: "constructing" } } }] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir });
	assert.equal(result.verdict, "idle");
});

// ── Durable config defaults (env still wins) ──────────────────────────────

test("a config override idles a poisoned file when no env override is set", async () => {
	const dir = agentDir();
	writeDelegate(dir, "{ half-written");
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, { override: "idle" });
	assert.equal(result.verdict, "idle");
	assert.match(result.reason, /overridden to idle/u);
});

test("an env override beats the config override", async () => {
	const dir = agentDir();
	writeDelegate(dir, { runs: [] });
	// Config says busy, env says idle: env wins.
	const result = await probeSessionBusy(
		SESSION,
		{ PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_PROBE: "idle" },
		{ override: "busy" },
	);
	assert.equal(result.verdict, "idle");
});

test("a config idle override also reports busy for an own-session run", async () => {
	// Parity with the env idle override: the config default must not mask
	// own-session work either.
	const dir = agentDir();
	writeDelegate(dir, { runs: [liveRun(SESSION)] });
	const result = await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, { override: "idle" });
	assert.equal(result.verdict, "busy");
});

test("a config staleMs shortens the window, and env staleMs beats it", async () => {
	const dir = agentDir();
	const created = Date.now() - 5_000;
	writeDelegate(dir, { runs: [{ runId: "orphan", createdAt: created, forks: { lane: { status: "running" } } }] });
	// Config bound of 2s ages the 5s-old orphan out to idle.
	assert.equal(
		(await probeSessionBusy(SESSION, { PI_CODING_AGENT_DIR: dir }, { staleMs: 2_000 })).verdict,
		"idle",
	);
	// Env bound of 1h overrides the config's 2s, so the same orphan still suppresses.
	assert.equal(
		(await probeSessionBusy(
			SESSION,
			{ PI_CODING_AGENT_DIR: dir, PI_CONTEXT_AWARE_BUSY_STALE_MS: String(60 * 60 * 1000) },
			{ staleMs: 2_000 },
		)).verdict,
		"unknown",
	);
});

test("unattributableStaleMs honours a config default and rejects a garbage one", () => {
	assert.equal(unattributableStaleMs({}, 5_000), 5_000);
	assert.equal(unattributableStaleMs({}, 0), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	assert.equal(unattributableStaleMs({}, -1), DEFAULT_UNATTRIBUTABLE_STALE_MS);
	// Env still wins over a valid config default.
	assert.equal(unattributableStaleMs({ PI_CONTEXT_AWARE_BUSY_STALE_MS: "9000" }, 5_000), 9_000);
});
