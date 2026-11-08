import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";
import { FakeFabric, createHostPi, createSession, type FakeHostPi, type FakeSession } from "./compaction-owner-harness.js";

// pi-context-aware#194 (cut-over checklist row 2 on pi-context-aware#137): context_compact is registered, takes
// the handoff arguments except ambiguity_mode, is hidden under a compaction blocker, and compacts through the
// compaction owner claim like every other compaction.

interface CompactTool {
	name: string;
	exposure?: string;
	parameters: { properties?: Record<string, unknown> };
	promptGuidelines?: string[];
	execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext): Promise<{ terminate?: boolean; details: Record<string, unknown> }>;
}

interface Fixture {
	readonly host: FakeHostPi;
	readonly session: FakeSession;
	readonly fabric: FakeFabric | undefined;
	start(): Promise<void>;
	settle(): Promise<void>;
	tool(name: string): CompactTool;
}

let loadCounter = 0;

async function withFixture(options: { config?: Record<string, unknown>; withFabric?: boolean; bcp?: boolean }, body: (f: Fixture) => Promise<void>): Promise<void> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-context-compact-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...options.config }));
	const host = createHostPi();
	const fabric = options.withFabric ? new FakeFabric(host.bus) : undefined;
	try {
		const extension = await import(`../src/index.js?context-compact=${Date.now()}-${++loadCounter}`);
		extension.default(host.api);
		// The tool pair billion-context-pi registers: it stays the only live context manager.
		if (options.bcp) for (const name of ["compress", "acp_status"]) host.api.registerTool({ name } as never);
		const session = createSession(root, "context-compact-session");
		await body({
			host,
			session,
			fabric,
			start: async () => { await host.handler("session_start")({ reason: "startup" }, session.ctx); await fabric?.flush(); },
			settle: async () => { await host.handler("agent_settled")({}, session.ctx); await fabric?.flush(); },
			tool: (name) => host.tools.get(name) as CompactTool,
		});
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
}

const CALL = { seed_prompt: "Continue with the rollout checklist.", rewrite_seed: false };

test("#194: context_compact is registered direct and has no ambiguity_mode argument", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		assert.equal(f.tool("context_compact").exposure, "direct");
		assert.deepEqual(Object.keys(f.tool("context_compact").parameters.properties ?? {}).sort(), ["rewrite_seed", "seed_prompt", "summary_focus"]);
		assert.doesNotMatch(f.tool("context_compact").promptGuidelines?.join("\n") ?? "", /ambiguity_mode/u);
	});
});

test("#194: an ambiguity_mode sent to context_compact anyway is ignored", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		const ignored = await f.tool("context_compact").execute("c1", { ...CALL, ambiguity_mode: "always-proceed" }, new AbortController().signal, undefined, f.session.ctx);
		assert.equal(ignored.terminate, true);
		assert.equal(ignored.details.ambiguityMode, "inherit", "the configured mode applies, not the argument");
	});
});

test("AC-196-1: none of the old compaction tool names registers", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		assert.equal(f.host.tools.has("compact_session"), false);
	});
});

test("#194: context_compact queues the compaction for the settled boundary", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		const result = await f.tool("context_compact").execute("c1", { ...CALL, summary_focus: "keep the rollback plan" }, new AbortController().signal, undefined, f.session.ctx);
		assert.equal(result.terminate, true);
		assert.equal(result.details.seed_prompt, CALL.seed_prompt);
		assert.equal(result.details.summary_focus, "keep the rollback plan");
		assert.equal(f.session.compactions.length, 0, "nothing compacts mid-run");
		await f.settle();
		assert.equal(f.session.compactions.length, 1, "the compaction starts once the agent settles");
		assert.match(f.session.compactions[0]!.customInstructions ?? "", /keep the rollback plan/u);
	});
});

test("#194: with the compaction owner claim held, context_compact compacts through the claim path", async () => {
	await withFixture({ config: { compactionClaim: { enabled: true } }, withFabric: true }, async (f) => {
		await f.start();
		assert.equal(f.fabric!.engineActive, false, "Fabric yields while the claim is held");
		await f.tool("context_compact").execute("c1", CALL, new AbortController().signal, undefined, f.session.ctx);
		await f.settle();
		assert.equal(f.session.compactions.length, 1);
		// Pi now asks the extension for the summary. With the claim held that goes through the owner wrapper, which
		// falls back to Fabric's deterministic summary when no model is available; without the claim it would not.
		const { compactionEvent } = await import("./compaction-owner-harness.js");
		const outcome = await f.host.handler("session_before_compact")(compactionEvent({ customInstructions: f.session.compactions[0]!.customInstructions }), f.session.ctx) as { compaction?: { summary: string } } | undefined;
		assert.equal(f.fabric!.fallbackCalls.length, 1, "the claim wrapper handled the compaction");
		assert.equal(outcome?.compaction?.summary, "Fabric deterministic summary");
	});
});

test("#194: context_compact is hidden while another extension cancels every compaction", async () => {
	await withFixture({ bcp: true }, async (f) => {
		await f.start();
		assert.equal(f.tool("context_compact").exposure, "hidden");
	});
});

test("#194: context_compact is not offered while the summarizer is deferred to another compactor", async () => {
	await withFixture({ config: { summarizer: { enabled: false } } }, async (f) => {
		await f.start();
		assert.equal(f.host.tools.has("context_compact"), false);
	});
});

// The text an error or notice shows names the tool the model called, so a model that used context_compact is never told to
// retry a name it did not use (and may not be able to see).
test("#194: the refusal when the summarizer is deferred at run time names the tool that was called", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		// A session policy entry flips summarizer.enabled after the tools were registered.
		f.session.branch.push({ type: "custom", id: "p1", parentId: null, timestamp: "2026-10-13T00:00:01.000Z", customType: CONFIG_POLICY_ENTRY_TYPE, data: configPolicyEntry("session", { "summarizer.enabled": false }) });
		const refused = await f.tool("context_compact").execute("r-1", CALL, new AbortController().signal, undefined, f.session.ctx).then(() => "", (error: Error) => error.message);
		assert.match(refused, /retry context_compact or \/compact-then/u);
	});
});

test("#194: the duplicate-call notice names the tool that was called", async () => {
	await withFixture({}, async (f) => {
		await f.start();
		const notes: string[] = [];
		const ctx = { ...f.session.ctx, hasUI: true, ui: { notify: (message: string) => { notes.push(message); } } } as ExtensionContext;
		await f.tool("context_compact").execute("d1", CALL, new AbortController().signal, undefined, ctx);
		// The first call is still queued for the settled boundary, so the second is a duplicate.
		await f.tool("context_compact").execute("d2", CALL, new AbortController().signal, undefined, ctx);
		assert.ok(notes.some((note) => /ignoring duplicate context_compact call/u.test(note)), JSON.stringify(notes));
	});
});

test("#295: fold hints shape the compaction input in live mode and not in billion-context-pi shadow mode", async () => {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { questions: [] } }], stopReason: "toolUse", timestamp: Date.now() };
	const result = { role: "toolResult", toolCallId: "ask-1", toolName: "ask", content: [{ type: "text", text: "ASK-ANSWER" }], isError: false, timestamp: Date.now() };
	const { compactionEvent } = await import("./compaction-owner-harness.js");
	const event = () => compactionEvent({ preparation: { ...compactionEvent().preparation, messagesToSummarize: [call, result] } });
	// BILLION_CONTEXT_NATIVE makes billion-context-pi stand down from cancelling compaction, so a compaction runs
	// while its tool pair is still loaded: the fold mode is shadow and the claim path receives the event.
	const seen = async (bcp: boolean): Promise<string | undefined> => {
		let instructions: string | undefined;
		const previous = process.env.BILLION_CONTEXT_NATIVE;
		if (bcp) process.env.BILLION_CONTEXT_NATIVE = "1";
		try {
		await withFixture({ config: { compactionClaim: { enabled: true } }, withFabric: true, bcp }, async (f) => {
			await f.start();
			await f.host.handler("session_before_compact")(event(), f.session.ctx);
			assert.equal(f.fabric!.fallbackCalls.length, 1, "the claim path handled the compaction");
			instructions = f.fabric!.fallbackCalls[0]!.event.customInstructions;
		});
		} finally {
			if (previous === undefined) delete process.env.BILLION_CONTEXT_NATIVE; else process.env.BILLION_CONTEXT_NATIVE = previous;
		}
		return instructions;
	};
	assert.match((await seen(false)) ?? "", /Quote every call and result of these tools word for word/u, "control: live mode applies the built-in verbatim hint");
	assert.equal(await seen(true), undefined, "shadow mode leaves the compaction event unchanged");
});
