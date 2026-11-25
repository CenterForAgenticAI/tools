import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ParityBudget, registerFoldParityRecorder, type FoldParityLimits } from "../src/parity/recorder.js";
import { readParityRecords, type CompressRecord } from "../src/parity/records.js";
import { estimateBytes } from "../src/parity/budget.js";

const MiB = 1024 * 1024;
const BUDGET_REASON = /shadow recorder budget/u;

/** A real session file with a valid legacy side file, so calls take the full comparison path. */
/** Each harness gets a private budget unless `processBudget` asks for the one shared across the process. */
function harness(dir: string, options: { messageBytes?: number; sideFile?: boolean; limits?: FoldParityLimits; data?: unknown; processBudget?: boolean } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	const ids = [manager.appendMessage({ role: "user", content: `first ${"x".repeat(options.messageBytes ?? 16)}`, timestamp: 1 })];
	for (let i = 0; i < 3; i++) ids.push(manager.appendMessage({ role: "user", content: `tail ${i}`, timestamp: 1 }));
	if (options.data !== undefined) manager.appendCustomEntry("bounds-probe", options.data);
	if (options.sideFile !== false) {
		const sideFile = `${manager.getSessionFile()}.acp.json`;
		fs.mkdirSync(path.dirname(sideFile), { recursive: true });
		fs.writeFileSync(sideFile, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id])) } }));
	}
	const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 1_000_000 } } as unknown as ExtensionContext;
	const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir: path.join(dir, "agent"), fingerprint: "bounds", ...(options.processBudget ? {} : { limits: options.limits ?? {} }) });
	const emit = (name: string, event: unknown) => handlers.get(name)!(event, ctx);
	const nestedCall = (i: number) => {
		const toolCallId = `outer/${i}`;
		emit("tool_call", { type: "tool_call", toolName: "compress", toolCallId, parentToolCallId: "outer", input: { content: [] } });
		emit("tool_result", { type: "tool_result", toolName: "compress", toolCallId, parentToolCallId: "outer", content: [{ type: "text", text: "nothing to fold" }], isError: false });
	};
	const call = (toolCallId: string, input: unknown = { content: [] }) => {
		emit("tool_call", { type: "tool_call", toolName: "compress", toolCallId, parentToolCallId: "outer", input });
		emit("tool_result", { type: "tool_result", toolName: "compress", toolCallId, parentToolCallId: "outer", content: [{ type: "text", text: "rejected" }], isError: true });
	};
	/** A second registration on the same session, as after a Pi runtime replacement. */
	const replace = (budget?: ParityBudget) => {
		handlers.clear();
		return registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir: path.join(dir, "agent"), fingerprint: "bounds", ...(budget ? { budget } : {}) });
	};
	return { recorder, emit, nestedCall, call, replace, manager, handlers, ctx, agentDir: path.join(dir, "agent") };
}
/** How long a test waits for an expected append before it fails; only a hang reaches it. */
const APPEND_DEADLINE_MS = 10_000;
/** Holds every diagnostics append under `dir` at the filesystem until released, counting appends started and in progress. */
function latchAppends(dir: string) {
	const original = fs.promises.appendFile;
	const held: (() => void)[] = [];
	let waiters: { count: number; resolve: () => void }[] = [];
	const state = { started: 0, active: 0, peak: 0, open: false };
	// The store appends through a verified descriptor; resolve it to the file it names.
	const target = (file: unknown) => typeof file === "object" && file !== null && "fd" in file ? fs.readlinkSync(`/proc/self/fd/${String(file.fd)}`) : String(file);
	const latched = async (...args: Parameters<typeof original>) => {
		if (!target(args[0]).startsWith(dir)) return await original(...args);
		state.started++;
		state.active++;
		state.peak = Math.max(state.peak, state.active);
		const ready = waiters.filter((waiter) => state.started >= waiter.count);
		waiters = waiters.filter((waiter) => state.started < waiter.count);
		ready.forEach((waiter) => waiter.resolve());
		try {
			if (!state.open) await new Promise<void>((resolve) => held.push(resolve));
			return await original(...args);
		} finally { state.active--; }
	};
	Reflect.set(fs.promises, "appendFile", latched);
	syncBuiltinESMExports();
	return {
		state,
		/**
		 * Resolves once `count` appends have started in total. The writer creates the directory on the
		 * libuv thread pool before it appends, so under load an append can start many event-loop turns
		 * later; this waits for the append itself and fails with a clear message only after the deadline.
		 */
		async started(count = 1) {
			if (state.started >= count) return;
			let timer: NodeJS.Timeout | undefined;
			const waiter = { count, resolve: () => {} };
			try {
				await new Promise<void>((resolve, reject) => {
					waiter.resolve = resolve;
					waiters.push(waiter);
					timer = setTimeout(() => reject(new Error(`append ${count} did not start within ${APPEND_DEADLINE_MS} ms; ${state.started} started`)), APPEND_DEADLINE_MS);
				});
			} finally {
				clearTimeout(timer);
				waiters = waiters.filter((other) => other !== waiter);
			}
		},
		release() { state.open = true; held.splice(0).forEach((resolve) => resolve()); },
		restore() { this.release(); Reflect.set(fs.promises, "appendFile", original); syncBuiltinESMExports(); },
	};
}
/** Counts structuredClone calls; the recorder must not copy anything it then rejects. */
function spyClones() {
	const original = globalThis.structuredClone;
	const seen: unknown[] = [];
	globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { seen.push(value); return original(value, options); }) as typeof structuredClone;
	return { seen, restore() { globalThis.structuredClone = original; } };
}
function heapMeter() {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc") as () => void;
	gc();
	const heap = process.memoryUsage().heapUsed;
	const buffers = process.memoryUsage().arrayBuffers;
	return {
		heapMiB() { gc(); return (process.memoryUsage().heapUsed - heap) / MiB; },
		buffersMiB() { gc(); return (process.memoryUsage().arrayBuffers - buffers) / MiB; },
	};
}
const compressInput = (summaryChars: number) => ({ content: [{ startId: "m00001", endId: "m00001", summary: "y".repeat(summaryChars) }] });
const budgetDiffs = (record: { diffs: readonly { reason?: string }[] }) => record.diffs.filter((diff) => BUDGET_REASON.test(diff.reason ?? ""));
function tempDir(prefix: string) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

test("completed nested comparisons release their branch snapshot before the next provider request", async () => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc") as () => void;
	const dir = tempDir("parity-bounds-heap-");
	try {
		const { recorder, nestedCall, agentDir } = harness(dir, { messageBytes: 8 * MiB });
		gc();
		const before = process.memoryUsage().heapUsed;
		for (let i = 1; i <= 8; i++) {
			nestedCall(i);
			await recorder.flush();
		}
		gc();
		const growth = (process.memoryUsage().heapUsed - before) / MiB;
		// The unbounded recorder kept one 8 MiB branch copy per call (about 64 MiB here).
		assert.ok(growth < 24, `retained heap grew ${growth.toFixed(1)} MiB across 8 nested calls`);
		assert.deepEqual({ snapshots: recorder.retained().snapshots, queued: recorder.retained().queued, calls: recorder.retained().calls }, { snapshots: 0, queued: 0, calls: 8 });
		const records = await readParityRecords(agentDir);
		assert.equal(records.length, 8);
		assert.deepEqual(records.flatMap(budgetDiffs), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a burst of nested calls without a context event stays inside the snapshot, byte and queue bounds", async () => {
	const dir = tempDir("parity-bounds-burst-");
	const limits = { maxSnapshots: 3, maxRetainedBytes: 4 * MiB, maxCalls: 16, maxQueued: 8 };
	try {
		const { recorder, emit, nestedCall, agentDir } = harness(dir, { limits });
		let peak = { bytes: 0, snapshots: 0, calls: 0, queued: 0 };
		for (let i = 1; i <= 40; i++) {
			nestedCall(i);
			const now = recorder.retained();
			peak = { bytes: Math.max(peak.bytes, now.bytes), snapshots: Math.max(peak.snapshots, now.snapshots), calls: Math.max(peak.calls, now.calls), queued: Math.max(peak.queued, now.queued) };
		}
		assert.ok(peak.snapshots <= limits.maxSnapshots, JSON.stringify(peak));
		assert.ok(peak.bytes <= limits.maxRetainedBytes, JSON.stringify(peak));
		assert.ok(peak.calls <= limits.maxCalls, JSON.stringify(peak));
		assert.ok(peak.queued <= limits.maxQueued, JSON.stringify(peak));
		await recorder.flush();
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		const summary = calls.map((record) => [record.toolCallId, record.verdict, budgetDiffs(record).map((diff) => diff.reason)]);
		// Three calls fit the snapshot bound and are compared; the next five are recorded as inconclusive.
		assert.deepEqual(summary.slice(0, 3).map(([id, , reasons]) => [id, reasons]), [["outer/1", []], ["outer/2", []], ["outer/3", []]]);
		assert.deepEqual(summary.slice(3, 8).map(([id, verdict]) => [id, verdict]), [4, 5, 6, 7, 8].map((i) => [`outer/${i}`, "inconclusive"]));
		assert.ok(summary.slice(3, 8).every(([, , reasons]) => (reasons as string[]).length === 1));
		// The queue is full for the remaining 32: they leave one inconclusive marker instead of vanishing.
		assert.equal(calls.length, 9, JSON.stringify(summary));
		assert.equal(calls[8]?.verdict, "inconclusive");
		assert.match(calls[8]?.diffs[0]?.reason ?? "", /budget exceeded \(queue\); 32 records dropped/u);
		emit("context", { type: "context", messages: [{ role: "user", content: "next" }] });
		assert.equal(recorder.retained().snapshots, 0, "a batch with an over-budget call must not snapshot the branch again");
		await recorder.flush();
		const next = (await readParityRecords(agentDir)).find((record) => record.kind === "next-request");
		assert.equal(next?.verdict, "inconclusive");
		assert.ok(next && budgetDiffs(next).length > 0);
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a branch larger than the byte budget is never cloned and the call is inconclusive", async () => {
	const dir = tempDir("parity-bounds-bytes-");
	try {
		const { recorder, nestedCall, agentDir } = harness(dir, { messageBytes: 2 * MiB, limits: { maxRetainedBytes: MiB } });
		const clones = spyClones();
		try { nestedCall(1); } finally { clones.restore(); }
		assert.equal(clones.seen.length, 0, "an over-budget branch must be rejected before any copy");
		assert.equal(recorder.retained().snapshots, 0);
		assert.ok(recorder.retained().bytes < 64 * 1024);
		await recorder.flush();
		const [record] = await readParityRecords(agentDir);
		assert.equal(record?.verdict, "inconclusive");
		assert.ok(record && budgetDiffs(record).length > 0, JSON.stringify(record));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unusable pre-state keeps only identities, never a branch snapshot", async () => {
	const dir = tempDir("parity-bounds-missing-");
	try {
		const { recorder, emit, nestedCall, agentDir } = harness(dir, { sideFile: false });
		const clones = spyClones();
		try {
			nestedCall(1);
			assert.equal(recorder.retained().snapshots, 0);
			emit("context", { type: "context", messages: [{ role: "user", content: "next" }] });
		} finally { clones.restore(); }
		assert.equal(clones.seen.length, 0, "an unusable pre-state must not copy the branch, input or header");
		assert.equal(recorder.retained().snapshots, 0);
		await recorder.flush();
		const records = await readParityRecords(agentDir);
		assert.deepEqual(records.map((record) => [record.kind, record.verdict, record.diffs.map((diff) => diff.kind)]), [["compress", "inconclusive", ["side-file-missing", "side-file-missing"]], ["next-request", "inconclusive", ["side-file-missing", "tags-absent"]]]);
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the next-request snapshot shares the same budget as pending calls", async () => {
	const dir = tempDir("parity-bounds-context-");
	try {
		const { recorder, emit, nestedCall, agentDir } = harness(dir, { limits: { maxSnapshots: 1 } });
		nestedCall(1);
		// The call's comparison is still queued and holds the only snapshot slot.
		emit("context", { type: "context", messages: [{ role: "user", content: "next" }] });
		assert.ok(recorder.retained().snapshots <= 1);
		await recorder.flush();
		const records = await readParityRecords(agentDir);
		const call = records.find((record) => record.kind === "compress");
		const next = records.find((record) => record.kind === "next-request");
		assert.deepEqual(call && budgetDiffs(call), []);
		assert.equal(next?.verdict, "inconclusive");
		assert.ok(next && budgetDiffs(next).length > 0, JSON.stringify(next));
		assert.deepEqual(next?.toolCallIds, ["outer/1"]);
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("session reset releases retained snapshots and identities", async () => {
	const dir = tempDir("parity-bounds-reset-");
	try {
		const { recorder, emit, agentDir } = harness(dir);
		emit("tool_call", { type: "tool_call", toolName: "compress", toolCallId: "pending", input: { content: [] } });
		assert.equal(recorder.retained().snapshots, 1);
		emit("session_shutdown", {});
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
		await recorder.flush();
		assert.deepEqual(await readParityRecords(agentDir), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a spoiled batch keeps evidence leased while its queued comparisons still hold it", async () => {
	const dir = tempDir("parity-bounds-evidence-");
	try {
		const { recorder, emit, call, agentDir } = harness(dir, { limits: { maxRetainedBytes: MiB, maxSnapshots: 8 } });
		const heap = heapMeter();
		// 400 Ki characters each: one copy fits the 1 MiB budget, three do not.
		call("full/0", compressInput(400 * 1024));
		call("slim", compressInput(2 * MiB));
		for (let i = 1; i < 8; i++) call(`full/${i}`, compressInput(400 * 1024));
		const retained = heap.heapMiB();
		assert.ok(recorder.retained().bytes <= MiB, JSON.stringify(recorder.retained()));
		// The unbounded lease release let all eight copies in (about 3.5 MiB) while reporting 10 KB.
		assert.ok(retained < 1.5, `queued comparisons retain ${retained.toFixed(2)} MiB of call input`);
		await recorder.flush();
		emit("context", { type: "context", messages: [{ role: "user", content: "next <acp>m00001</acp>" }] });
		await recorder.flush();
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		assert.deepEqual(calls.map((record) => [record.toolCallId, budgetDiffs(record).length > 0]), [["full/0", false], ["slim", true], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [`full/${i}`, true])]);
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
		assert.ok(heap.heapMiB() < 0.5, "all call input is dropped once its comparisons finish");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an array-buffer view in a custom entry is charged for its whole backing buffer", async () => {
	const dir = tempDir("parity-bounds-view-");
	try {
		const backing = new Uint8Array(8 * MiB).fill(1);
		const { recorder, nestedCall, agentDir } = harness(dir, { limits: { maxRetainedBytes: MiB }, data: { view: new Uint8Array(backing.buffer, 0, 1) } });
		const heap = heapMeter();
		const clones = spyClones();
		try { nestedCall(1); } finally { clones.restore(); }
		assert.equal(clones.seen.length, 0, "the branch must be rejected before structuredClone copies the 8 MiB buffer");
		assert.ok(heap.buffersMiB() < 1, `array-buffer storage grew ${heap.buffersMiB().toFixed(2)} MiB`);
		assert.equal(recorder.retained().snapshots, 0);
		await recorder.flush();
		const [record] = await readParityRecords(agentDir);
		assert.equal(record?.verdict, "inconclusive");
		assert.ok(record && budgetDiffs(record).length > 0, JSON.stringify(record));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("session resets during a slow append keep the work reserved, so outstanding appends stay bounded", async () => {
	const dir = tempDir("parity-bounds-slow-");
	const appends = latchAppends(dir);
	try {
		const { recorder, emit, call, agentDir } = harness(dir, { sideFile: false, limits: { maxQueued: 1, maxCalls: 1 } });
		for (let i = 0; i < 25; i++) {
			call(`slim/${i}`);
			// The first record's append must be blocked before the resets begin. Every later record is
			// admitted or dropped synchronously in `call`, so its outcome is already visible in retained().
			if (i === 0) await appends.started(1);
			emit("session_shutdown", {});
			emit("session_start", {});
			assert.ok(recorder.retained().queued <= 1, JSON.stringify(recorder.retained()));
		}
		// Before the fix 25 appends were blocked at once while retained() reported nothing queued.
		// Any admitted record would be written by the time flush resolves; the peak and the records
		// below cover the whole run, so a second append or an extra record fails them.
		assert.equal(appends.state.active, 1);
		assert.equal(recorder.retained().queued, 1, "a blocked append still holds its reservation after a reset");
		appends.release();
		await recorder.flush();
		assert.deepEqual({ started: appends.state.started, peak: appends.state.peak }, { started: 2, peak: 1 });
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		assert.deepEqual(calls.map((record) => record.toolCallId.replace(/\/\d+$/u, "")), ["slim", "recorder-dropped"]);
		assert.match(calls[1]?.diffs[0]?.reason ?? "", /budget exceeded \(queue\); 24 records dropped/u);
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { appends.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a session reset cancels a queued comparison and drops its branch copy before the write queue drains", async () => {
	const dir = tempDir("parity-bounds-cancel-");
	const appends = latchAppends(dir);
	try {
		const { recorder, emit, nestedCall, agentDir } = harness(dir, { messageBytes: 4 * MiB, limits: {} });
		const heap = heapMeter();
		nestedCall(1);
		await appends.started(1);
		nestedCall(2);
		emit("session_shutdown", {});
		// Comparison 1 has run and is only writing its small record; comparison 2 never started.
		assert.deepEqual({ bytes: recorder.retained().bytes, snapshots: recorder.retained().snapshots }, { bytes: 0, snapshots: 0 });
		const retained = heap.heapMiB();
		assert.ok(retained < 2, `a cancelled comparison still retains ${retained.toFixed(2)} MiB`);
		appends.release();
		await recorder.flush();
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		assert.deepEqual(calls.map((record) => [record.toolCallId, record.diffs.some((diff) => /session ended before/u.test(diff.reason ?? ""))]), [["outer/1", false], ["outer/2", true]]);
		assert.equal(calls[1]?.verdict, "inconclusive");
		assert.ok(calls[0]?.ours, "the comparison that had started ran to completion");
		assert.deepEqual(recorder.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { appends.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a replacement runtime shares the outgoing runtime's process-wide budget while its work is alive", async () => {
	const dir = tempDir("parity-bounds-replace-");
	const appends = latchAppends(dir);
	try {
		const { recorder, emit, call, replace } = harness(dir, { sideFile: false, processBudget: true });
		call("old/1");
		await appends.started(1);
		emit("session_shutdown", {});
		const next = replace();
		assert.equal(next.retained().queued, 1, "the outgoing runtime's blocked append is still outstanding");
		appends.release();
		await Promise.all([recorder.flush(), next.flush()]);
		assert.equal(next.retained().queued, 0);
	} finally { appends.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a replacement runtime given the same budget cannot add work while the outgoing runtime's append is alive", async () => {
	const dir = tempDir("parity-bounds-replace-shared-");
	const appends = latchAppends(dir);
	try {
		const budget = new ParityBudget({ maxQueued: 1 });
		const { emit, call, replace, agentDir } = harness(dir, { sideFile: false });
		const outgoing = replace(budget);
		call("old/1");
		await appends.started(1);
		emit("session_shutdown", {});
		const incoming = replace(budget);
		// Admission is decided synchronously in `call`: when the loop ends, each new record is either
		// queued, which retained() shows, or counted for the drop marker. Once flush resolves, every
		// admitted record has been written, so the peak and the records prove no work was added.
		for (let i = 1; i <= 10; i++) call(`new/${i}`);
		assert.equal(appends.state.active, 1);
		assert.equal(incoming.retained().queued, 1);
		appends.release();
		await Promise.all([outgoing.flush(), incoming.flush()]);
		assert.deepEqual({ started: appends.state.started, peak: appends.state.peak }, { started: 2, peak: 1 });
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		assert.deepEqual(calls.map((record) => record.toolCallId.replace(/\/\d+$/u, "")), ["old", "recorder-dropped"]);
		assert.match(calls[1]?.diffs[0]?.reason ?? "", /10 records dropped/u);
		emit("session_shutdown", {});
		assert.deepEqual(incoming.retained(), { bytes: 0, snapshots: 0, calls: 0, queued: 0 });
	} finally { appends.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("recorder failures share the work bound instead of queueing an append each", async () => {
	const dir = tempDir("parity-bounds-failure-");
	const appends = latchAppends(dir);
	try {
		const { recorder, handlers, ctx, agentDir } = harness(dir, { limits: { maxQueued: 2 } });
		const broken = { ...ctx, sessionManager: new Proxy(ctx.sessionManager, { get(target, key) {
			if (key === "getBranch") return () => { throw new Error("unavailable"); };
			const value = Reflect.get(target, key) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		} }) } as ExtensionContext;
		for (let i = 0; i < 50; i++) handlers.get("tool_call")!({ type: "tool_call", toolName: "compress", toolCallId: `broken/${i}`, input: { content: [] } }, broken);
		await appends.started(1);
		assert.ok(recorder.retained().queued <= 2, JSON.stringify(recorder.retained()));
		appends.release();
		await recorder.flush();
		assert.equal(appends.state.peak, 1);
		const calls = (await readParityRecords(agentDir)).filter((record): record is CompressRecord => record.kind === "compress");
		// Two queued failure records share one append, then one marker accounts for the other 48.
		assert.deepEqual(calls.map((record) => [record.toolCallId, record.diffs[0]?.kind]), [["broken/0", "recorder-error"], ["broken/1", "recorder-error"], ["recorder-dropped/1", "too-large"]]);
		assert.match(calls[2]?.diffs[0]?.reason ?? "", /48 records dropped/u);
	} finally { appends.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the size estimate covers what structuredClone copies, or refuses to size it", () => {
	const backing = new ArrayBuffer(8 * MiB);
	assert.ok(estimateBytes(new Uint8Array(backing, 0, 1), Infinity) >= 8 * MiB, "a view copies its whole backing buffer");
	assert.ok(estimateBytes(new DataView(backing, 8, 8), Infinity) >= 8 * MiB);
	assert.ok(estimateBytes(new Map([["key", "v".repeat(MiB)]]), Infinity) >= 2 * MiB, "map values are counted");
	assert.ok(estimateBytes(new Set(["s".repeat(MiB)]), Infinity) >= 2 * MiB, "set members are counted");
	for (const unsized of [new Error("stack text"), new (class Holder { data = "x"; })(), () => 1, Symbol("s"), /re/u, { nested: [new Error("deep")] }]) {
		assert.equal(estimateBytes(unsized, Infinity), Number.POSITIVE_INFINITY, String(unsized));
	}
	assert.ok(Number.isFinite(estimateBytes({ text: "plain", list: [1, null, true, undefined], when: new Date(0) }, Infinity)));
	// The walk stops once the limit is passed, even for a cycle.
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.ok(estimateBytes(cyclic, 1024) > 1024);
});
