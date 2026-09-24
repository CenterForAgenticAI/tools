import test from "node:test";
import assert from "node:assert/strict";

type CmuxCapability = { readonly enabled: boolean; readonly available: boolean; readonly version?: string; readonly reason?: string };
type ProjectionPayload = { readonly summary: string };
type ActivityPayload = { readonly summary: string };
type CmuxProjectionAdapter = {
	readonly capabilities: () => CmuxCapability;
	readonly publishStatus: (payload: ProjectionPayload) => boolean;
	readonly publishProgress: (payload: ProjectionPayload) => boolean;
	readonly publishLog: (payload: ProjectionPayload) => boolean;
	readonly publishNotification: (payload: { readonly title: string; readonly body: string }) => boolean;
	readonly focus: (location: string) => boolean;
	readonly logActivity: (payload: ActivityPayload) => boolean;
	readonly clear: () => boolean;
};
type CmuxProjectionModule = {
	readonly createCmuxProjectionAdapter: (options: {
		readonly enabled?: boolean;
		readonly activityLogging?: boolean;
		readonly now?: () => number;
		readonly probe: { readonly executable: () => boolean; readonly version: () => string | undefined; readonly ping: (timeoutMs: number) => boolean };
		readonly execute: (operation: string, payload: unknown) => void;
	}) => CmuxProjectionAdapter;
};

async function loadTerminalProjections(): Promise<CmuxProjectionModule | undefined> {
	try {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore The implementation is intentionally absent in the semantic-red commit.
		return await import("../terminal-projections.js") as unknown as CmuxProjectionModule;
	} catch { return undefined; }
}

const now = 1_000_000;
type ProbeState = { executable: boolean; version: string; ping: boolean };

async function makeAdapter(state: ProbeState, execute: (operation: string, payload: unknown) => void = () => undefined): Promise<{ adapter: CmuxProjectionAdapter | undefined; clock: { value: number }; calls: { executable: number; version: number; ping: number; pingTimeouts: number[]; execute: number } }> {
	const module = await loadTerminalProjections();
	const clock = { value: now };
	const calls = { executable: 0, version: 0, ping: 0, pingTimeouts: [] as number[], execute: 0 };
	const adapter = module?.createCmuxProjectionAdapter({
		enabled: true,
		now: () => clock.value,
		probe: {
			executable: () => { calls.executable += 1; return state.executable; },
			version: () => { calls.version += 1; return state.version; },
			ping: (timeoutMs) => { calls.ping += 1; calls.pingTimeouts.push(timeoutMs); return state.ping; },
		},
		execute: (operation, payload) => { calls.execute += 1; execute(operation, payload); },
	});
	return { adapter, clock, calls };
}

test("cmux is unavailable when ping cannot reach it even when an executable is present", async () => {
	const { adapter, calls } = await makeAdapter({ executable: true, version: "cmux 0.1", ping: false });
	const capability = adapter?.capabilities() ?? { available: true, reason: "implementation absent" };
	assert.equal(capability.available, false);
	assert.match(capability.reason ?? "", /ping|reachable|connect/i);
	assert.equal(calls.executable, 1);
	assert.equal(calls.ping, 1);
	assert.deepEqual(calls.pingTimeouts, [1_000]);
});

test("cmux caches positive connectivity for 15 seconds and negative connectivity for 30 seconds", async () => {
	const positive = await makeAdapter({ executable: true, version: "cmux 0.1", ping: true });
	assert.equal(positive.adapter?.capabilities().available ?? false, true);
	positive.clock.value += 14_999;
	assert.equal(positive.adapter?.capabilities().available ?? false, true);
	assert.equal(positive.calls.ping, 1);
	positive.clock.value += 1;
	assert.equal(positive.adapter?.capabilities().available ?? false, true);
	assert.equal(positive.calls.ping, 2);

	const negative = await makeAdapter({ executable: true, version: "cmux 0.1", ping: false });
	assert.equal(negative.adapter?.capabilities().available ?? true, false);
	negative.clock.value += 29_999;
	assert.equal(negative.adapter?.capabilities().available ?? true, false);
	assert.equal(negative.calls.ping, 1);
	negative.clock.value += 1;
	assert.equal(negative.adapter?.capabilities().available ?? true, false);
	assert.equal(negative.calls.ping, 2);
});

test("static cmux capabilities stay cached while connectivity expires independently", async () => {
	const { adapter, clock, calls } = await makeAdapter({ executable: true, version: "cmux 0.1", ping: true });
	assert.equal(adapter?.capabilities().available ?? false, true);
	clock.value += 15_000;
	assert.equal(adapter?.capabilities().available ?? false, true);
	assert.equal(calls.executable, 1, "executable discovery is independent of connectivity TTL");
	assert.equal(calls.version, 1, "version discovery is independent of connectivity TTL");
	assert.equal(calls.ping, 2, "connectivity is revalidated after its 15-second TTL");

	assert.equal(adapter?.publishStatus({ summary: "safe status" }) ?? true, true);
	assert.equal(calls.executable, 1, "command failure/retry must not reprobe static capability");
	assert.equal(calls.version, 1, "command failure/retry must not reprobe static capability");
	assert.equal(calls.ping, 2, "a successful command keeps the refreshed connectivity cache");
});

test("backwards clock movement expires cached connectivity instead of treating it as fresh", async () => {
	const { adapter, clock, calls } = await makeAdapter({ executable: true, version: "cmux 0.1", ping: true });
	assert.equal(adapter?.capabilities().available ?? false, true);
	clock.value -= 1;
	assert.equal(adapter?.capabilities().available ?? true, false);
	assert.equal(calls.ping, 2, "a backwards clock must force a fresh connectivity probe");
});

test("projection command failures invalidate cached connectivity and independent projections stay best effort", async () => {
	let fail = true;
	const { adapter, clock, calls } = await makeAdapter(
		{ executable: true, version: "cmux 0.1", ping: true },
		(operation) => { if (operation === "status" && fail) throw new Error("synthetic cmux failure"); },
	);
	assert.equal(adapter?.publishStatus({ summary: "safe status" }) ?? true, false);
	assert.equal(adapter?.capabilities().available ?? false, true);
	assert.equal(calls.ping, 2, "failure invalidates the connectivity cache before the next check");
	fail = false;
	clock.value += 15_000;
	assert.equal(adapter?.publishProgress({ summary: "safe progress" }) ?? false, true);
	assert.equal(adapter?.publishLog({ summary: "safe log" }) ?? false, true);
	assert.equal(adapter?.publishNotification({ title: "safe", body: "safe notification" }) ?? false, true);
	assert.equal(adapter?.focus("surface-1") ?? false, true);
	assert.equal(calls.execute, 5);
});

test("activity logging is opt-in and projection payloads are bounded", async () => {
	const payloads: unknown[] = [];
	const { adapter } = await makeAdapter({ executable: true, version: "cmux 0.1", ping: true }, (_operation, payload) => payloads.push(payload));
	assert.equal(adapter?.logActivity({ summary: "activity should not be sent" }) ?? true, false);
	const module = await loadTerminalProjections();
	const enabled = module?.createCmuxProjectionAdapter({
		enabled: true,
		activityLogging: true,
		now: () => now,
		probe: { executable: () => true, version: () => "cmux 0.1", ping: () => true },
		execute: (_operation, payload) => payloads.push(payload),
	});
	assert.equal(enabled?.logActivity({ summary: "token=secret " + "x".repeat(500) }) ?? false, true);
	assert.doesNotMatch(JSON.stringify(payloads), /secret|token=/);
});
