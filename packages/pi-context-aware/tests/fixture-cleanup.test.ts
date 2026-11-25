import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS, pendingMetricsWrites } from "../src/metrics/recorder.js";
import { removeFixtureDir, removeFixtureDirNow } from "./fixture-cleanup.js";

// pi-context-aware#360: a fixture deleted its agent directory while the metrics
// recorder's queued write was still landing, and rmSync failed with ENOTEMPTY.

const ladder = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
const ctx = { sessionManager: { getSessionId: () => "s", getLeafId: () => "l", getBranch: () => [] }, model: { id: "m", contextWindow: 1000 } } as unknown as ExtensionContext;

function delayedRecorder(root: string) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let landed = false;
	const recorder = registerMetricsRecorder({
		agentDir: () => root,
		settings: () => DEFAULT_METRICS_SETTINGS,
		ladder: () => ladder,
		write: async (dir) => {
			await gate;
			fs.mkdirSync(path.join(dir, "context-aware", "metrics", "v1"), { recursive: true });
			fs.writeFileSync(path.join(dir, "context-aware", "metrics", "v1", "s.jsonl"), "{}\n");
			landed = true;
		},
	});
	recorder.observers.onTurn?.(ctx, undefined);
	return { recorder, release, landed: () => landed };
}

test("removeFixtureDir waits for a metrics write that is still pending", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-cleanup-"));
	const t = delayedRecorder(root);
	assert.equal(pendingMetricsWrites(), 1);
	const removal = removeFixtureDir(root);
	assert.equal(fs.existsSync(root), true, "directory must still exist while the write is pending");
	t.release();
	await removal;
	assert.equal(t.landed(), true);
	assert.equal(fs.existsSync(root), false);
	assert.equal(pendingMetricsWrites(), 0);
});

test("removeFixtureDirNow refuses to delete a directory while a metrics write is pending", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-cleanup-"));
	const t = delayedRecorder(root);
	try {
		assert.throws(() => removeFixtureDirNow(root), /metrics write\(s\) pending/u);
		assert.equal(fs.existsSync(root), true);
	} finally {
		t.release();
		await t.recorder.flush();
		await removeFixtureDir(root);
	}
});
