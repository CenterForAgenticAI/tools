import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CONFIG_POLICY_ENTRY_TYPE,
	configPolicyEntry,
	readConfigLayer,
	readPolicyEntryLayers,
	resolveConfigLayers,
	sessionRoleBehaviour,
	type Config,
} from "../config-layers.js";
import { contextCacheDirectory } from "../context-cache.js";

// Issue #12: in a delegated worker session the extension must stop doing
// foreground things — rewriting the task prompt with a model, auto-sending it,
// and injecting the context-cache listing. With no role declared, behaviour
// must be byte-identical to a normal session (criterion 4).

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ctx-aware-role-"));
}

function workerPolicyEntry(declaredBy = "pi-delegate/worker"): unknown {
	return {
		type: "custom",
		customType: CONFIG_POLICY_ENTRY_TYPE,
		data: configPolicyEntry("host", { sessionRole: "worker" }, { declaredBy }),
	};
}

// --- the role itself --------------------------------------------------------

test("no declared role resolves to foreground", () => {
	assert.equal(resolveConfigLayers([]).config.sessionRole, "foreground");
	assert.equal(resolveConfigLayers(readPolicyEntryLayers([])).config.sessionRole, "foreground");
});

test("a host record declares the worker role", () => {
	const layers = readPolicyEntryLayers([workerPolicyEntry()]);
	const resolved = resolveConfigLayers(layers);
	assert.equal(resolved.config.sessionRole, "worker");
	assert.equal(resolved.byPath.get("sessionRole")?.layer, "host");
	assert.equal(resolved.byPath.get("sessionRole")?.origin, "pi-delegate/worker");
});

test("a role a host did not declare is rejected, leaving the session foreground", () => {
	const entry = {
		type: "custom",
		customType: CONFIG_POLICY_ENTRY_TYPE,
		data: configPolicyEntry("host", { sessionRole: "supervisor" }),
	};
	assert.equal(resolveConfigLayers(readPolicyEntryLayers([entry])).config.sessionRole, "foreground");
});

test("the worker role withholds every foreground behaviour except the transcript reference", () => {
	assert.deepEqual(sessionRoleBehaviour("worker"), {
		allowCheckin: false,
		allowAutomaticContinuation: false,
		autoSendSeed: false,
		rewriteSeedWithModel: false,
		injectCacheListing: false,
		compactMidReply: false,
		// Worker sessions are file-backed and discoverable, so this one line is
		// the part of the handoff a worker session can actually use.
		recordTranscriptReference: true,
	});
});

test("the foreground role permits everything, so an ordinary session is unchanged", () => {
	assert.deepEqual(sessionRoleBehaviour("foreground"), {
		allowCheckin: true,
		allowAutomaticContinuation: true,
		autoSendSeed: true,
		rewriteSeedWithModel: true,
		injectCacheListing: true,
		compactMidReply: true,
		recordTranscriptReference: true,
	});
});

test("a user cannot promote their own session out of the worker role", () => {
	// The session layer sits below host policy, so a session-level override
	// loses. A worker must not be able to opt back into foreground behaviour.
	const layers = [
		readConfigLayer({ sessionRole: "foreground" }, "global"),
		...readPolicyEntryLayers([
			{ type: "custom", customType: CONFIG_POLICY_ENTRY_TYPE, data: configPolicyEntry("session", { sessionRole: "foreground" }) },
			workerPolicyEntry(),
		]),
	];
	assert.equal(resolveConfigLayers(layers).config.sessionRole, "worker");
});

// --- the four cache injection paths ----------------------------------------

async function withCacheFixture(
	entries: unknown[],
	run: (module: typeof import("../cache-render.js"), ctx: never, cacheDir: string, config: Config) => void | Promise<void>,
): Promise<void> {
	const home = tmpDir();
	const agentDir = path.join(home, "agent");
	const sessionDir = path.join(home, "session");
	fs.mkdirSync(sessionDir, { recursive: true });
	const cacheDir = contextCacheDirectory(agentDir, process.cwd());
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(path.join(cacheDir, "_manifest.json"), `${JSON.stringify({
		version: 1,
		files: {
			"baseline.md": {
				description: "Baseline decisions for the next phase",
				createdBy: "prior-session",
				updatedBy: "prior-session",
				created: "2026-05-06T00:00:00Z",
				updated: new Date().toISOString(),
				sizeBytes: 1234,
			},
		},
	})}\n`);

	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const module = await import("../cache-render.js");
		const config = resolveConfigLayers(readPolicyEntryLayers(entries)).config;
		const ctx = {
			hasUI: false,
			cwd: process.cwd(),
			model: { contextWindow: 200_000 },
			getContextUsage: () => ({ tokens: 1_000 }),
			ui: { setStatus() {}, setWidget() {}, notify() {} },
			sessionManager: {
				getEntries: () => entries,
				getBranch: () => entries,
				getSessionDir: () => sessionDir,
				getSessionFile: () => path.join(sessionDir, "session.jsonl"),
				getSessionId: () => "role-test-session",
			},
		} as never;
		await run(module, ctx, cacheDir, config);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("a foreground session still receives the cache listing on every path", async () => {
	await withCacheFixture([], (module, _ctx, cacheDir, config) => {
		// The always-on system-prompt block is now a count plus a pointer (issue #78),
		// so it names no file; a foreground session still receives it on this path.
		assert.match(module.buildCacheSystemPromptBlock(cacheDir, config) ?? "", /reference document.*\/context-cache-list/);
		assert.ok(module.buildCacheListingForPrompt(cacheDir, config)?.includes("baseline.md"));
		assert.ok(module.buildCacheSeedPreamble(cacheDir, config)?.includes("baseline.md"));
		const sent: unknown[] = [];
		module.sendCacheNotification({ sendMessage: (message: unknown) => sent.push(message) } as never, cacheDir, config, "compaction");
		assert.equal(sent.length, 1);
	});
});

test("a worker session receives no cache listing on any path", async () => {
	await withCacheFixture([workerPolicyEntry()], (module, _ctx, cacheDir, config) => {
		assert.equal(module.buildCacheSystemPromptBlock(cacheDir, config), null);
		assert.equal(module.buildCacheListingForPrompt(cacheDir, config), null);
		assert.equal(module.buildCacheSeedPreamble(cacheDir, config), null);
		const sent: unknown[] = [];
		module.sendCacheNotification({ sendMessage: (message: unknown) => sent.push(message) } as never, cacheDir, config, "compaction");
		assert.deepEqual(sent, [], "a worker session has no user who could act on a cache notification");
	});
});
