import test from "node:test";
import assert from "node:assert/strict";

import {
	COMMIT_DRAIN_POLL_INTERVAL_MS,
	DEFAULT_COMMIT_DRAIN_TIMEOUT_MS,
	decideCompactionCommit,
	type CompactionCommitGuardHooks,
} from "../compaction-commit-guard.js";

interface Harness {
	hooks: CompactionCommitGuardHooks;
	notes: string[];
	drains: number;
	sleeps: number[];
	elapsed: () => number;
}

/**
 * A fake clock advanced only by the guard's own sleeps, so every decision is
 * deterministic and no test waits on real time.
 */
function harness(
	liveness: (poll: number) => boolean | null,
	settled: () => boolean = () => true,
): Harness {
	let clock = 1_000;
	let polls = 0;
	const state = {
		notes: [] as string[],
		drains: 0,
		sleeps: [] as number[],
	};
	const hooks: CompactionCommitGuardHooks = {
		isRunInFlight: () => liveness(polls++),
		isDrainSettled: settled,
		drainInFlightRun: () => { state.drains++; },
		sleep: async (ms) => { state.sleeps.push(ms); clock += ms; },
		now: () => clock,
		note: (message) => state.notes.push(message),
	};
	return {
		hooks,
		get notes() { return state.notes; },
		get drains() { return state.drains; },
		get sleeps() { return state.sleeps; },
		elapsed: () => clock - 1_000,
	} as Harness;
}

test("a quiet session commits immediately and nothing is ended", async () => {
	const fake = harness(() => false);
	const decision = await decideCompactionCommit(fake.hooks);
	assert.deepEqual(decision, { commit: true, path: "no-run-in-flight", waitedMs: 0 });
	assert.equal(fake.drains, 0, "a quiet session must not have its run ended");
	assert.deepEqual(fake.sleeps, [], "a quiet session must not wait");
	assert.deepEqual(fake.notes, [], "the untouched path stays silent");
});

test("an in-flight run is ended once and the commit waits for it to finish", async () => {
	// In flight for the initial check and the first two polls, then finished.
	const fake = harness((poll) => poll < 3);
	const decision = await decideCompactionCommit(fake.hooks, { drainTimeoutMs: 1_000, pollIntervalMs: 20 });
	assert.deepEqual(decision, { commit: true, path: "drained", waitedMs: 40 });
	assert.equal(fake.drains, 1, "the run is ended exactly once");
	assert.deepEqual(fake.sleeps, [20, 20]);
	assert.ok(fake.notes.some((note) => /an agent run is in flight at commit time/.test(note)));
	assert.ok(fake.notes.some((note) => /the in-flight run ended after 40ms/.test(note)));
});

test("a run that outlives the drain budget refuses the commit instead of recording a boundary", async () => {
	const fake = harness(() => true);
	const decision = await decideCompactionCommit(fake.hooks, { drainTimeoutMs: 100, pollIntervalMs: 30 });
	assert.deepEqual(decision, {
		commit: false,
		reason: "run-in-flight",
		waitedMs: 100,
		drainTimeoutMs: 100,
	});
	assert.equal(fake.drains, 1);
	// The last sleep is clamped so the wait never overshoots the budget.
	assert.deepEqual(fake.sleeps, [30, 30, 30, 10]);
	assert.equal(fake.elapsed(), 100);
	assert.ok(fake.notes.some((note) => /abandoning this commit instead of recording a boundary/.test(note)));
});

test("a zero budget refuses without waiting, after ending the run so the retry can commit", async () => {
	const fake = harness(() => true);
	const decision = await decideCompactionCommit(fake.hooks, { drainTimeoutMs: 0 });
	assert.deepEqual(decision, {
		commit: false,
		reason: "run-in-flight",
		waitedMs: 0,
		drainTimeoutMs: 0,
	});
	assert.equal(fake.drains, 1, "the run is still ended, so the re-queued attempt meets a quiet session");
	assert.deepEqual(fake.sleeps, []);
});

test("a host that does not report run liveness commits as prepared and says so", async () => {
	const fake = harness(() => null);
	const decision = await decideCompactionCommit(fake.hooks);
	assert.deepEqual(decision, { commit: true, path: "liveness-unknown", waitedMs: 0 });
	assert.equal(fake.drains, 0, "an unknown liveness state is not a reason to end a run");
	assert.ok(fake.notes.some((note) => /does not report agent run liveness/.test(note)));
});

test("liveness that becomes unreadable during the drain commits rather than stalling the boundary", async () => {
	// A disposed or replaced session runtime stops answering the liveness probe.
	const fake = harness((poll) => (poll === 0 ? true : poll < 2 ? true : null));
	const decision = await decideCompactionCommit(fake.hooks, { drainTimeoutMs: 500, pollIntervalMs: 10 });
	assert.deepEqual(decision, { commit: true, path: "liveness-unknown", waitedMs: 10 });
	assert.equal(fake.drains, 1);
	assert.ok(fake.notes.some((note) => /became unreadable after 10ms/.test(note)));
});

test("a cleared run signal does not commit until delayed settlement work finishes", async () => {
	let settlementPolls = 0;
	const fake = harness(() => false, () => settlementPolls++ >= 3);
	const decision = await decideCompactionCommit(fake.hooks, { drainTimeoutMs: 100, pollIntervalMs: 10 });
	assert.deepEqual(decision, { commit: true, path: "no-run-in-flight", waitedMs: 20 });
	assert.equal(fake.drains, 0, "a run whose signal already cleared must not be aborted again");
	assert.deepEqual(fake.sleeps, [10, 10], "the guard waits for the stable settlement barrier");
});

test("the documented defaults are the ones the guard applies", async () => {
	assert.equal(DEFAULT_COMMIT_DRAIN_TIMEOUT_MS, 10_000);
	assert.equal(COMMIT_DRAIN_POLL_INTERVAL_MS, 25);
	const fake = harness(() => true);
	const decision = await decideCompactionCommit(fake.hooks);
	assert.equal(decision.commit, false);
	assert.equal(decision.commit === false ? decision.drainTimeoutMs : -1, DEFAULT_COMMIT_DRAIN_TIMEOUT_MS);
	assert.equal(fake.elapsed(), DEFAULT_COMMIT_DRAIN_TIMEOUT_MS);
	assert.equal(
		fake.sleeps.length,
		DEFAULT_COMMIT_DRAIN_TIMEOUT_MS / COMMIT_DRAIN_POLL_INTERVAL_MS,
		"the default poll interval divides the default budget exactly",
	);
});
