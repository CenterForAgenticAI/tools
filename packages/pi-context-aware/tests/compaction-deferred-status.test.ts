import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeFabric, createHostPi, createSession } from "./compaction-owner-harness.js";
import { removeFixtureDir } from "./fixture-cleanup.js";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";

// #329: an entry point reports `running` only when runPendingCompaction started a compaction.
// Expected statuses come from the issue's acceptance criteria, not from the code under test.

let loadCounter = 0;

async function withSession(
	body: (f: {
		host: ReturnType<typeof createHostPi>;
		session: ReturnType<typeof createSession>;
		fabric: FakeFabric;
		settle: () => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-deferred-status-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(
		path.join(agentDir, "context-aware.json"),
		JSON.stringify({
			compactionClaim: { enabled: true },
			proactiveCompaction: { enabled: true, thresholdFraction: 0.5 },
			contextCache: { enabled: false },
			sessionNaming: { scope: "off" },
			workstream: { enabled: false },
		}),
	);
	const host = createHostPi();
	const fabric = new FakeFabric(host.bus, {});
	const extension = await import(`../src/index.js?compaction-deferred-status=${Date.now()}-${++loadCounter}`);
	extension.default(host.api);
	const session = createSession(root, "deferred-status-session");
	await host.handler("session_start")({ reason: "startup" }, session.ctx);
	await fabric.flush();
	try {
		await body({
			host,
			session,
			fabric,
			settle: async () => { await host.handler("agent_settled")({}, session.ctx); await fabric.flush(); },
		});
	} finally {
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
}

const HANDOFF = {
	purpose: "Verify deferred status",
	nextPhaseSeed: "Continue.",
	rewriteSeed: false,
	interactionMode: "non-interactive",
} as const;

async function armDrain(f: Parameters<Parameters<typeof withSession>[0]>[0]): Promise<void> {
	f.session.setIdle(false);
	await f.host.handler("turn_end")({ message: { stopReason: "toolUse" } }, f.session.ctx);
	assert.deepEqual(f.host.api.getActiveTools(), [], "pressure armed the provider drain");
	f.session.setIdle(true);
}

test("#329: a service request at an idle boundary with the drain marker armed reports queued, then starts at agent_settled", async () => {
	await withSession(async (f) => {
		await armDrain(f);
		const service = discoverContextAwareServiceV1(f.host.bus, "deferred-service");
		assert.ok(service);
		const result = await service.requestHandoff({ requestId: "deferred-1", ...HANDOFF });
		assert.equal(result.status, "queued");
		assert.equal(f.session.compactions.length, 0, "nothing started while the drain is armed");
		await f.settle();
		assert.equal(f.session.compactions.length, 1, "the compaction starts at the next agent_settled");
	});
});

test("#329: an owner request at an idle boundary with the drain marker armed reports queued", async () => {
	await withSession(async (f) => {
		await armDrain(f);
		const result = await f.fabric.call("request", { seed: "Continue." }, f.session.ctx) as { status: string; state?: string };
		assert.equal(result.state ?? result.status, "queued");
		assert.equal(f.session.compactions.length, 0);
		await f.settle();
		assert.equal(f.session.compactions.length, 1);
	});
});

test("#329: a service request and an owner request that start immediately still report running", async () => {
	await withSession(async (f) => {
		f.session.setIdle(true);
		const service = discoverContextAwareServiceV1(f.host.bus, "immediate-service");
		assert.ok(service);
		const result = await service.requestHandoff({ requestId: "immediate-1", ...HANDOFF });
		assert.equal(result.status, "running");
		assert.equal(f.session.compactions.length, 1);
	});
	await withSession(async (f) => {
		f.session.setIdle(true);
		const result = await f.fabric.call("request", { seed: "Continue." }, f.session.ctx) as { status: string; state?: string };
		assert.equal(result.state ?? result.status, "running");
		assert.equal(f.session.compactions.length, 1);
	});
});
// CR-DEFERRED-STATUS-TEST-GAP: the mid-flight and newer-active-run exits of runPendingCompaction cannot
// be reached from these two callers. Each caller refuses an already-active flight before it calls, and
// gates the call on the same idle check the function repeats. These tests pin both guards.
test("#329: a service request while a compaction is already queued is refused, never reported running", async () => {
	await withSession(async (f) => {
		await armDrain(f);
		const service = discoverContextAwareServiceV1(f.host.bus, "conflict-service");
		assert.ok(service);
		const first = await service.requestHandoff({ requestId: "conflict-1", ...HANDOFF });
		assert.equal(first.status, "queued");
		const second = await service.requestHandoff({ requestId: "conflict-2", ...HANDOFF });
		assert.equal(second.status, "failed");
		assert.equal((second as { code?: string }).code, "COMPACTION_CONFLICT");
		assert.equal(f.session.compactions.length, 0);
	});
});

test("#329: a service request and an owner request while a newer run is active report queued and start nothing", async () => {
	await withSession(async (f) => {
		f.session.setIdle(false);
		const service = discoverContextAwareServiceV1(f.host.bus, "busy-service");
		assert.ok(service);
		const result = await service.requestHandoff({ requestId: "busy-1", ...HANDOFF });
		assert.equal(result.status, "queued");
		assert.equal(f.session.compactions.length, 0);
	});
	await withSession(async (f) => {
		f.session.setIdle(false);
		const result = await f.fabric.call("request", { seed: "Continue." }, f.session.ctx) as { status: string; state?: string };
		assert.equal(result.state ?? result.status, "queued");
		assert.equal(f.session.compactions.length, 0);
	});
});
