/**
 * pi-context-aware#569: session_start must not block Pi's startup.
 *
 * Pi awaits every session_start handler before the session is interactive. These tests run every handler this
 * extension registers, in order, as Pi does, and check what happened by the moment they resolve:
 * - no git or ps process was started (a PATH shim logs each one);
 * - registry cleanup and sync, the worktree index write, cache cleanup and the compaction-ownership warning
 *   have not run yet, and each has run once the background housekeeping drains.
 *
 * Test seam: src/index.ts exports `drainSessionHousekeeping(): Promise<void>`, which resolves once every
 * housekeeping task that this module instance scheduled, including one scheduled but not yet started, has settled.
 * Expected values are literals or fixture paths, never read from the code under test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { contextCacheDirectory, writeManifest } from "../src/cache/context-cache.js";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";
import { strategySettingsFor } from "../src/folds/fold-engine.js";
import { createRegistryProjection, createSessionRegistry, type RegistryProjection } from "../src/session/session-registry.js";
import { removeFixtureDir } from "./fixture-cleanup.js";
import { createWorkstreamSnapshot, workstreamEntry } from "./workstream-fixture.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
type ExtensionModule = { default: (pi: ExtensionAPI) => void; drainSessionHousekeeping?: () => Promise<void> };

const SKIP = process.platform === "win32";
const REAL_GIT = SKIP ? "" : execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const REAL_PS = SKIP ? "" : execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
const SESSION_ID = "nonblocking-session";
const COMPETING = /^Automatic compaction has competing owners/u;

/** Git for fixture setup: the real binary, with no inherited repository variables. */
function realGit(args: readonly string[]): string {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return execFileSync(REAL_GIT, [...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

interface Fixture {
	readonly root: string;
	readonly agentDir: string;
	readonly log: string;
	readonly entries: unknown[];
	readonly notifications: string[];
	readonly unhandled: unknown[];
	readonly commands: Map<string, Command>;
	readonly events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
	module?: ExtensionModule;
	ctx?: ExtensionContext;
	handlers?: Map<string, Handler[]>;
	/** The git and ps commands the shims logged so far. */
	processes(): string[];
	clearProcesses(): void;
	/** Load a fresh module instance and run every session_start handler in order; returns the elapsed ms. */
	start(cwd: string): Promise<number>;
	shutdown(): Promise<void>;
	drain(): Promise<void>;
	dispose(): Promise<void>;
}

async function fixture(label: string, options: { readonly config: Record<string, unknown>; readonly gitDelaySeconds?: number }): Promise<Fixture> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `context-aware-start-${label}-`)));
	const agentDir = path.join(root, "agent");
	const bin = path.join(root, "bin");
	const log = path.join(root, "processes.log");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), `${JSON.stringify(options.config)}\n`);
	// Pi's own setting: native auto-compaction on.
	fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ compaction: { enabled: true } })}\n`);
	const delay = options.gitDelaySeconds ? `sleep ${options.gitDelaySeconds}\n` : "";
	fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> '${log}'\n${delay}exec '${REAL_GIT}' "$@"\n`);
	fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nprintf 'ps %s\\n' "$*" >> '${log}'\nexec '${REAL_PS}' "$@"\n`);
	fs.chmodSync(path.join(bin, "git"), 0o755);
	fs.chmodSync(path.join(bin, "ps"), 0o755);

	const prior = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };
	const gitEnv = new Map<string, string>();
	for (const [key, value] of Object.entries(process.env)) if (key.startsWith("GIT_") && value !== undefined) gitEnv.set(key, value);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		emit(channel: string, data: unknown) { for (const handler of listeners.get(channel) ?? []) handler(data); },
		on(channel: string, handler: (data: unknown) => void) {
			const set = listeners.get(channel) ?? new Set();
			set.add(handler);
			listeners.set(channel, set);
			return () => { set.delete(handler); };
		},
	};
	const entries: unknown[] = [];
	const notifications: string[] = [];
	const commands = new Map<string, Command>();

	const self: Fixture = {
		root, agentDir, log, entries, notifications, unhandled, commands, events,
		processes: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		clearProcesses: () => { fs.rmSync(log, { force: true }); },
		async start(cwd) {
			process.env.HOME = root;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.PATH = `${bin}${path.delimiter}${prior.path ?? ""}`;
			for (const key of gitEnv.keys()) delete process.env[key];
			process.on("unhandledRejection", onUnhandled);
			const handlers = new Map<string, Handler[]>();
			const api = {
				events,
				registerFlag() {},
				getFlag() { return undefined; },
				on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerCommand(name: string, definition: Command) { commands.set(name, definition); },
				registerTool() {},
				sendMessage() {},
				sendUserMessage() {},
				getActiveTools() { return ["read"]; },
				getAllTools() { return []; },
				setActiveTools() {},
				getSessionName() { return undefined; },
				appendEntry(customType: string, data: unknown) {
					entries.push({ type: "custom", id: `entry-${entries.length + 1}`, parentId: null, timestamp: new Date().toISOString(), customType, data });
				},
			} as unknown as ExtensionAPI;
			const sessionDir = path.join(root, "session");
			fs.mkdirSync(sessionDir, { recursive: true });
			const ctx = {
				hasUI: true,
				cwd,
				model: undefined,
				isIdle: () => true,
				hasPendingMessages: () => false,
				isProjectTrusted: () => true,
				getContextUsage: () => ({ tokens: 1_000 }),
				sessionManager: {
					getLeafId: () => null,
					getEntries: () => entries,
					getBranch: () => entries,
					getSessionId: () => SESSION_ID,
					getSessionDir: () => sessionDir,
					getSessionFile: () => path.join(sessionDir, `${SESSION_ID}.jsonl`),
				},
				ui: {
					notify: (message: string) => { notifications.push(message); },
					setStatus() {},
					setWidget() {},
					getToolsExpanded: () => false,
					setWorkingMessage() {},
					setWorkingVisible() {},
					setWorkingIndicator() {},
				},
			} as unknown as ExtensionContext;
			const module = await import(`../src/index.js?session-start-nonblocking=${label}-${Date.now()}`) as ExtensionModule;
			module.default(api);
			// Extension load may still use git (a non-goal of #569); only session_start is measured.
			self.clearProcesses();
			self.module = module;
			self.ctx = ctx;
			self.handlers = handlers;
			const startHandlers = handlers.get("session_start") ?? [];
			assert.ok(startHandlers.length > 0, "the extension registers session_start handlers");
			const begun = performance.now();
			for (const handler of startHandlers) await handler({ type: "session_start", reason: "startup" }, ctx);
			return performance.now() - begun;
		},
		async shutdown() {
			assert.ok(self.ctx && self.handlers);
			for (const handler of self.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, self.ctx);
		},
		async drain() {
			const drain = self.module?.drainSessionHousekeeping;
			assert.equal(typeof drain, "function", "src/index.ts exports drainSessionHousekeeping, the seam that awaits session_start housekeeping");
			await drain!();
			// A rejection left unhandled is reported after the microtask queue drains.
			await new Promise((resolve) => setImmediate(resolve));
		},
		async dispose() {
			try {
				if (typeof self.module?.drainSessionHousekeeping === "function") await self.module.drainSessionHousekeeping();
			} finally {
				process.off("unhandledRejection", onUnhandled);
				if (prior.home === undefined) delete process.env.HOME;
				else process.env.HOME = prior.home;
				if (prior.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = prior.agentDir;
				process.env.PATH = prior.path;
				for (const [key, value] of gitEnv) process.env[key] = value;
				await removeFixtureDir(root);
			}
		},
	};
	return self;
}

/** A git repository with a nested working directory. */
function gitProject(root: string): { readonly repo: string; readonly nested: string; readonly commonDir: string } {
	const repo = path.join(root, "repo");
	const nested = path.join(repo, "packages", "app");
	fs.mkdirSync(nested, { recursive: true });
	realGit(["init", "-q", repo]);
	return { repo, nested, commonDir: fs.realpathSync(path.join(repo, ".git")) };
}

/** The session's focus record, so the registry has a projection to write. */
function addWorkstream(entries: unknown[]): void {
	const snapshot = createWorkstreamSnapshot({
		workstreamId: "ws-nonblocking",
		piSessionId: SESSION_ID,
		objective: "Start without blocking",
		now: new Date("2026-11-20T10:00:00.000Z"),
		idFactory: () => "snapshot-1",
	});
	entries.push(workstreamEntry(snapshot, { entryId: "snapshot-entry", timestamp: "2026-11-20T10:00:00.000Z" }));
}

function registryDirectory(agentDir: string): string {
	return path.join(fs.realpathSync(agentDir), "session-registry", "v1");
}

/** An expired, closed projection of another session, which registry cleanup removes. */
function seedExpiredProjection(agentDir: string, commonDir: string): string {
	const past = Date.parse("2026-01-01T00:00:00.000Z");
	const at = new Date(past).toISOString();
	const registry = createSessionRegistry({
		registryRoot: registryDirectory(agentDir),
		gitCommonDirectory: commonDir,
		now: () => past,
		retentionMs: 1_000,
		pid: 4242,
		pidStart: at,
		incarnation: "seed-incarnation",
	});
	const written = registry.write(createRegistryProjection({
		projectKey: registry.projectKey,
		incarnation: "seed-incarnation",
		pid: 4242,
		pidStart: at,
		piSessionId: "expired-session",
		workstreamId: "ws-expired",
		sequence: 1,
		state: "active",
		objective: "Expired",
		status: "active",
		refs: [],
		heartbeatAt: at,
		updatedAt: at,
	} as unknown as Omit<RegistryProjection, "schemaVersion">));
	assert.equal(written.ok, true, `seed write: ${written.reason ?? ""}`);
	assert.equal(registry.close("expired-session").ok, true);
	return registry.filePath("expired-session");
}

/** A cache manifest with one entry a week past the default stale limit, so cleanup removes it under the manifest lock. */
function seedStaleCache(agentDir: string, repo: string): string {
	const cacheDir = contextCacheDirectory(agentDir, fs.realpathSync(repo));
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(path.join(cacheDir, "stale.md"), "old");
	writeManifest(cacheDir, { version: 1, files: {
		"stale.md": { description: "Stale", createdBy: "t", updatedBy: "t", created: "2020-01-01T00:00:00.000Z", updated: "2020-01-01T00:00:00.000Z", sizeBytes: 3 },
	} });
	return cacheDir;
}

function manifestFiles(cacheDir: string): string[] {
	const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "_manifest.json"), "utf8")) as { files: Record<string, unknown> };
	return Object.keys(manifest.files);
}

function projectionsOf(agentDir: string, sessionId: string): Array<{ state: string }> {
	const root = path.join(agentDir, "session-registry", "v1");
	if (!fs.existsSync(root)) return [];
	const out: Array<{ state: string }> = [];
	for (const project of fs.readdirSync(root)) {
		const file = path.join(root, project, `${sessionId}.json`);
		if (fs.existsSync(file)) out.push(JSON.parse(fs.readFileSync(file, "utf8")) as { state: string });
	}
	return out;
}

const ALL_ON = { sessionNaming: { scope: "off" } };
const HOUSEKEEPING_OFF = { sessionNaming: { scope: "off" }, workstream: { enabled: false }, contextCache: { enabled: false } };

test("S1: no git or ps process starts before the session_start handlers resolve", { skip: SKIP }, async () => {
	const f = await fixture("s1", { config: ALL_ON });
	try {
		const { repo, nested, commonDir } = gitProject(f.root);
		seedStaleCache(f.agentDir, repo);
		seedExpiredProjection(f.agentDir, commonDir);
		addWorkstream(f.entries);
		await f.start(nested);
		assert.deepEqual(f.processes(), [], "git and ps started while session_start was pending");
		await f.drain();
		// The shim does see the housekeeping's git calls, so the empty log above is evidence.
		assert.ok(f.processes().some((line) => line.startsWith("git ")), "the background housekeeping runs git through the shim");
	} finally {
		await f.dispose();
	}
});

test("S2: registry, worktree index and cache cleanup run after session_start resolves", { skip: SKIP }, async () => {
	const f = await fixture("s2", { config: ALL_ON });
	try {
		const { repo, nested, commonDir } = gitProject(f.root);
		const cacheDir = seedStaleCache(f.agentDir, repo);
		const expired = seedExpiredProjection(f.agentDir, commonDir);
		const projection = path.join(path.dirname(expired), `${SESSION_ID}.json`);
		const worktreeIndex = path.join(f.agentDir, "context-aware-worktrees.json");
		addWorkstream(f.entries);
		await f.start(nested);

		assert.equal(fs.existsSync(expired), true, "registry cleanup ran before session_start resolved");
		assert.equal(fs.existsSync(projection), false, "registry sync ran before session_start resolved");
		assert.equal(fs.existsSync(worktreeIndex), false, "the worktree index was written before session_start resolved");
		assert.deepEqual(manifestFiles(cacheDir), ["stale.md"], "cache cleanup ran before session_start resolved");

		await f.drain();
		assert.equal(fs.existsSync(expired), false, "registry cleanup removes the expired projection");
		assert.equal((JSON.parse(fs.readFileSync(projection, "utf8")) as { state: string }).state, "active");
		const index = JSON.parse(fs.readFileSync(worktreeIndex, "utf8")) as { projects: Record<string, unknown> };
		assert.deepEqual(Object.keys(index.projects), [commonDir]);
		assert.deepEqual(manifestFiles(cacheDir), [], "cache cleanup removes the stale entry");
		assert.deepEqual(f.unhandled, []);
	} finally {
		await f.dispose();
	}
});

test("S3: a slow git does not delay session_start, and shutdown during it leaves the registry closed", { skip: SKIP, timeout: 120_000 }, async () => {
	const f = await fixture("s3", { config: ALL_ON, gitDelaySeconds: 2 });
	try {
		const { nested } = gitProject(f.root);
		addWorkstream(f.entries);
		const elapsed = await f.start(nested);
		assert.ok(elapsed < 500, `session_start took ${Math.round(elapsed)} ms with a 2 s git`);
		// Shut down while the housekeeping's git is still sleeping.
		await f.shutdown();
		await f.drain();
		assert.deepEqual(projectionsOf(f.agentDir, SESSION_ID).filter((projection) => projection.state !== "closed"), [], "a superseded housekeeping task wrote an open registry entry after shutdown");
		assert.deepEqual(f.unhandled, [], "the housekeeping task left an unhandled rejection");
	} finally {
		await f.dispose();
	}
});

test("S4: a linked worktree's project config is found at session_start without git", { skip: SKIP }, async () => {
	const f = await fixture("s4", { config: HOUSEKEEPING_OFF });
	try {
		const { repo } = gitProject(f.root);
		realGit(["-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		const worktree = path.join(f.root, "linked");
		realGit(["-C", repo, "worktree", "add", "-q", worktree]);
		assert.match(fs.readFileSync(path.join(worktree, ".git"), "utf8"), /^gitdir: /u, "a linked worktree's .git is a file");
		fs.mkdirSync(path.join(worktree, ".pi"));
		fs.writeFileSync(path.join(worktree, ".pi", "context-aware.json"), JSON.stringify({ seedMode: "user-approve", strategy: { methods: ["fold"] } }));
		const nested = path.join(worktree, "src", "deep");
		fs.mkdirSync(nested, { recursive: true });

		await f.start(nested);
		assert.deepEqual(f.processes(), [], "reading the config and fold-strategy settings at session_start started git");
		await f.drain();

		f.clearProcesses();
		assert.deepEqual(strategySettingsFor(f.ctx!, f.agentDir).methods, ["fold"], "the fold engine reads the linked worktree's project file");
		const layers = f.commands.get("context-status");
		assert.ok(layers, "the extension registers /context-status");
		await layers.handler("layers", f.ctx!);
		assert.match(f.notifications.at(-1) ?? "", /seedMode\s+user-approve/u, "readConfig reads the linked worktree's project file");
		assert.deepEqual(f.processes(), [], "resolving the project file started git");
	} finally {
		await f.dispose();
	}
});

test("S5: the compaction-ownership warning is shown after session_start resolves, once", { skip: SKIP }, async () => {
	const f = await fixture("s5", { config: HOUSEKEEPING_OFF });
	try {
		const { nested } = gitProject(f.root);
		await f.start(nested);
		assert.deepEqual(f.notifications.filter((message) => COMPETING.test(message)), [], "the ownership warning was shown before session_start resolved");
		await f.drain();
		assert.equal(f.notifications.filter((message) => COMPETING.test(message)).length, 1);
	} finally {
		await f.dispose();
	}
});

test("context-aware service v1 is available as soon as session_start resolves", { skip: SKIP }, async () => {
	const f = await fixture("service", { config: HOUSEKEEPING_OFF });
	try {
		const { nested } = gitProject(f.root);
		await f.start(nested);
		assert.notEqual(discoverContextAwareServiceV1(f.events, "nonblocking-test"), undefined);
	} finally {
		await f.dispose();
	}
});
