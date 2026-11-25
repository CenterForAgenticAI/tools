import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS, pendingMetricsWrites, overrideMetricsWriter } from "../src/metrics/recorder.js";
import { requestPressure } from "../src/folds/request-pressure.js";
import { focusFixture } from "./extension-harness.js";

// pi-context-aware#360: session_shutdown must wait for queued metrics writes.
// The focus fixture's real extension flushes its recorder at shutdown, so a
// directory removed right after shutdown has no write left to race.

// session_shutdown reaches the recorder through the erasure handler's flushParity.
test("session_shutdown waits for a metrics write that is still in flight", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let landed = false;
	const undo = overrideMetricsWriter(async () => { await gate; landed = true; });
	try {
		const fixture = await focusFixture([]);
		try {
			await fixture.turn();
			assert.equal(pendingMetricsWrites(), 1, "the delayed write must still be queued after the turn");
			let shutDown = false;
			const shutting = fixture.shutdown().then(() => { shutDown = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(shutDown, false, "shutdown must not finish while a write is pending");
			release();
			await shutting;
			assert.equal(landed, true);
			assert.equal(pendingMetricsWrites(), 0);
		} finally {
			release();
			await fixture.cleanup();
		}
	} finally {
		undo();
	}
});

test("a recorder's flush resolves only after a delayed write has landed", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-shutdown-"));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const file = path.join(root, "late.txt");
	const recorder = registerMetricsRecorder({
		agentDir: () => root,
		settings: () => DEFAULT_METRICS_SETTINGS,
		write: async () => { await gate; fs.writeFileSync(file, "x"); },
	});
	const ctx = { sessionManager: { getSessionId: () => "s", getLeafId: () => "l", getBranch: () => [] }, model: { id: "m", contextWindow: 1000 } } as never;
	recorder.observers.onTurn?.(ctx, undefined, requestPressure({ tokens: 0, window: 1000, measured: false, source: "host" }), true);
	let flushed = false;
	const flushing = recorder.flush().then(() => { flushed = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(flushed, false);
	release();
	await flushing;
	assert.equal(fs.existsSync(file), true);
	fs.rmSync(root, { recursive: true, force: true });
});
