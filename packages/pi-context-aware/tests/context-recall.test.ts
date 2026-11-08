import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { compile, obj } from "@earendil-works/pi-schema";

import { contextCacheDirectory } from "../src/cache/context-cache.js";
import { contextRecallSchema, recallQuery, type ContextRecallHost, type ContextRecallResult } from "../src/context-tools/context-recall.js";
import { SessionDatabase } from "../src/erasure/database.js";
import { createHostPi, createSession, type FakeHostPi } from "./compaction-owner-harness.js";

// Seams: the registered tools' execute() after session_start, and a real Pi
// session's tool list. Fixture sessions are real JSONL transcripts that Pi's own
// SessionManager lists; fixture cache documents are real cache pools.

interface RecallTool {
	name: string;
	exposure?: string;
	parameters: unknown;
	promptGuidelines?: string[];
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ContextRecallResult>;
}

interface Fixture {
	root: string;
	agentDir: string;
	projectDir: string;
	otherDir: string;
	files: { current: string; prior: string; other: string };
	ctx: ExtensionContext;
	host: FakeHostPi;
	registrations: string[];
	tool(name: string): RecallTool;
	start(ctx?: ExtensionContext): Promise<void>;
	call(name: string, params: Record<string, unknown>, ctx?: ExtensionContext): Promise<ContextRecallResult>;
	restore(): void | Promise<void>;
}

function sessionDirFor(agentDir: string, cwd: string): string {
	// Pi's default per-cwd session directory (session-manager getDefaultSessionDirPath).
	return path.join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`);
}

function writeSession(agentDir: string, cwd: string, id: string, texts: readonly string[], startMs: number): string {
	const dir = sessionDirFor(agentDir, cwd);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: new Date(startMs).toISOString(), cwd }];
	let parentId: string | null = null;
	texts.forEach((text, index) => {
		const entryId = `${id}-m${index + 1}`;
		entries.push({ type: "message", id: entryId, parentId, timestamp: new Date(startMs + index).toISOString(), message: { role: "user", content: text, timestamp: startMs + index } });
		parentId = entryId;
	});
	fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

function writeCacheDocument(agentDir: string, scopePath: string, file: string, content: string): void {
	const pool = contextCacheDirectory(agentDir, scopePath);
	fs.mkdirSync(pool, { recursive: true });
	fs.writeFileSync(path.join(pool, file), content);
	fs.writeFileSync(path.join(pool, "_manifest.json"), `${JSON.stringify({
		version: 1,
		files: { [file]: { description: "fixture", createdBy: "fixture-writer", updatedBy: "fixture-writer", created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", sizeBytes: content.length } },
	})}\n`);
}

let loads = 0;

async function fixture(options: { billionContextPi?: boolean } = {}): Promise<Fixture> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-")));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const otherDir = path.join(root, "other");
	for (const dir of [agentDir, projectDir, otherDir]) fs.mkdirSync(dir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), `${JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false } })}\n`);

	const files = {
		current: writeSession(agentDir, projectDir, "current", ["MARKER-CURRENT lives only in this session."], Date.parse("2026-03-03T00:00:00.000Z")),
		prior: writeSession(agentDir, projectDir, "prior", ["MARKER-PRIOR lives in an earlier session of this project."], Date.parse("2026-02-02T00:00:00.000Z")),
		other: writeSession(agentDir, otherDir, "other", ["MARKER-OTHER lives in another project."], Date.parse("2026-01-01T00:00:00.000Z")),
	};
	writeCacheDocument(agentDir, projectDir, "notes.md", "MARKER-CACHE lives in this project's cache documents.\n");
	writeCacheDocument(agentDir, otherDir, "notes.md", "MARKER-OTHERCACHE lives in another project's cache documents.\n");

	const host = createHostPi();
	const registrations: string[] = [];
	const registerTool = host.api.registerTool.bind(host.api);
	Object.assign(host.api, {
		registerTool(tool: { name: string }) {
			registrations.push(tool.name);
			// Pi keeps the first tool registered under a name. A bare { name } entry is billion-context-pi's, from another extension.
			const held = host.tools.get(tool.name) as { execute?: unknown } | undefined;
			if (held && typeof held.execute !== "function") return;
			registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
		},
	});
	const extension = await import(`../src/index.js?context-recall=${Date.now()}-${++loads}`);
	extension.default(host.api);
	if (options.billionContextPi) {
		// billion-context-pi's signature pair, from an extension other than this one.
		for (const name of ["compress", "acp_status"]) host.tools.set(name, { name });
	}
	const ctx = {
		...createSession(root, "current").ctx,
		cwd: projectDir,
		sessionManager: SessionManager.open(files.current),
		shutdown: () => {},
	} as unknown as ExtensionContext;
	const tool = (name: string): RecallTool => {
		const found = host.tools.get(name) as RecallTool | undefined;
		assert.ok(found, `expected ${name} to be registered`);
		return found;
	};
	return {
		root,
		agentDir,
		projectDir,
		otherDir,
		files,
		ctx,
		host,
		registrations,
		tool,
		start: async (startCtx = ctx) => { await host.handler("session_start")({ type: "session_start", reason: "startup" }, startCtx); },
		call: (name, params, callCtx = ctx) => tool(name).execute(`${name}-call`, params, new AbortController().signal, undefined, callCtx),
		async restore() {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await removeFixtureDir(root);
		},
	};
}

const text = (result: ContextRecallResult): string => result.content.map((part) => part.text).join("\n");
const transcriptFiles = (result: ContextRecallResult): string[] => result.details.transcripts.results.map((hit) => path.basename(hit.sessionPath)).sort();
const citedFiles = (result: ContextRecallResult): string[] => {
	const cache = result.details.cache_documents;
	return cache.searched ? cache.citations.map((citation) => citation.excerpt) : [];
};
const MARKERS = ["MARKER-CURRENT", "MARKER-PRIOR", "MARKER-OTHER ", "MARKER-CACHE", "MARKER-OTHERCACHE"];
const markersIn = (result: ContextRecallResult): string[] => MARKERS.filter((marker) => text(result).includes(marker)).map((marker) => marker.trim());

test("REQ-193-1: each scope returns the fixture hits inside it and none outside it", async () => {
	const f = await fixture();
	try {
		await f.start();
		const session = await f.call("context_recall", { query: "marker", scope: "session" });
		assert.equal(session.isError, undefined, text(session));
		assert.deepEqual(transcriptFiles(session), ["current.jsonl"]);
		assert.deepEqual(markersIn(session), ["MARKER-CURRENT"]);
		assert.equal(session.details.cache_documents.searched, false);

		const prior = await f.call("context_recall", { query: "marker" });
		assert.equal(prior.details.scope, "prior", "prior is the default scope");
		assert.deepEqual(transcriptFiles(prior), ["prior.jsonl"]);
		assert.deepEqual(markersIn(prior), ["MARKER-PRIOR", "MARKER-CACHE"]);
		assert.equal(citedFiles(prior).length, 1);

		const priorWithCurrent = await f.call("context_recall", { query: "marker", scope: "prior", include_current: true });
		assert.deepEqual(transcriptFiles(priorWithCurrent), ["current.jsonl", "prior.jsonl"]);

		const all = await f.call("context_recall", { query: "marker", scope: "all-projects" });
		assert.deepEqual(transcriptFiles(all), ["other.jsonl", "prior.jsonl"]);
		assert.deepEqual(markersIn(all), ["MARKER-PRIOR", "MARKER-OTHER", "MARKER-CACHE"]);
	} finally { await f.restore(); }
});

test("REQ-193-1: one call returns a labelled transcripts section and a labelled cache-documents section", async () => {
	const f = await fixture();
	try {
		await f.start();
		const result = await f.call("context_recall", { query: "marker" });
		const body = text(result);
		const transcripts = body.indexOf("## Transcripts");
		const cache = body.indexOf("## Cache documents");
		assert.ok(transcripts >= 0 && cache > transcripts, body);
		assert.match(body.slice(transcripts, cache), /MARKER-PRIOR/u);
		assert.doesNotMatch(body.slice(transcripts, cache), /MARKER-CACHE/u);
		assert.match(body.slice(cache), /MARKER-CACHE/u);
		assert.doesNotMatch(body.slice(cache), /MARKER-PRIOR/u, "the cache engine must not search transcripts a second time");
		assert.equal(result.details.cache_documents.searched, true);
		if (result.details.cache_documents.searched) {
			assert.deepEqual(result.details.cache_documents.stores, ["context-cache"]);
			assert.equal(result.details.cache_documents.scanned_sessions, 0);
		}
	} finally { await f.restore(); }
});

test("REQ-193-1: a regex query searches transcripts only and says the cache documents were skipped", async () => {
	const f = await fixture();
	try {
		await f.start();
		const result = await f.call("context_recall", { query: "MARKER-(PRIOR|CACHE)", regex: true, case_sensitive: true });
		assert.deepEqual(transcriptFiles(result), ["prior.jsonl"]);
		assert.deepEqual(result.details.cache_documents, { searched: false, reason: "regex" });
		assert.match(text(result), /## Cache documents\nNot searched: regex queries search transcripts only\./u);
		assert.doesNotMatch(text(result), /MARKER-CACHE/u);

		const invalid = await f.call("context_recall", { query: "(", regex: true });
		assert.equal(invalid.isError, true);
		assert.equal(invalid.details.error, "invalid regex");
	} finally { await f.restore(); }
});

test("REQ-193-1: transcript snippets are redacted like recall excerpts", async () => {
	const f = await fixture();
	try {
		// Built at run time so the public-release secret scan does not flag the fixture.
		const credential = ["glpat", "12345678901234567890abcd"].join("-");
		writeSession(f.agentDir, f.projectDir, "secret", [`MARKER-SECRET deploy with token=${credential} before noon.`], Date.parse("2026-02-03T00:00:00.000Z"));
		await f.start();
		const result = await f.call("context_recall", { query: "MARKER-SECRET" });
		assert.deepEqual(transcriptFiles(result), ["secret.jsonl"]);
		const snippet = result.details.transcripts.results[0]?.snippets.join("\n") ?? "";
		assert.match(snippet, /MARKER-SECRET/u);
		assert.match(snippet, /\[REDACTED\]/u);
		assert.ok(!snippet.includes(credential), snippet);
		assert.ok(!text(result).includes(credential), text(result));
		// The cache engine searched cache documents only, and its no-match line says so.
		assert.match(text(result), /No matching evidence found in context-cache documents\. No inference was made\./u);
	} finally { await f.restore(); }
});

test("REQ-193-7: an erased session is not returned even when the host still lists it", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-erased-")));
	try {
		const listed = (id: string, text: string) => ({ id, path: path.join(root, `${id}.jsonl`), cwd: root, modified: new Date("2026-01-01T00:00:00.000Z"), messageCount: 1, allMessagesText: text });
		// A stale listing: the erased session is still on it.
		const host: ContextRecallHost = {
			listSessions: async () => ({ sessions: [listed("kept", "ERASURE-MARKER kept"), listed("erased", "ERASURE-MARKER erased")], scannedCwds: [root], scopeLabel: "project" }),
			erasedSessionIds: () => new Set(["erased"]),
			cachePools: () => [],
			home: () => root,
		};
		const ctx = { cwd: root, sessionManager: { getSessionFile: () => path.join(root, "current.jsonl") } } as unknown as ExtensionContext;
		for (const scope of ["prior", "all-projects"] as const) {
			const result = await recallQuery({ query: "ERASURE-MARKER", scope }, ctx, host);
			assert.deepEqual(result.details.transcripts.results.map((hit) => path.basename(hit.sessionPath)), ["kept.jsonl"], scope);
			assert.doesNotMatch(text(result), /erased\.jsonl|ERASURE-MARKER erased/u, scope);
		}
	} finally { await removeFixtureDir(root); }
});

test("REQ-193-7: through the extension, an erased prior session is not returned by context_recall", async () => {
	const f = await fixture();
	try {
		const db = new SessionDatabase(f.agentDir);
		db.erase(["prior"]);
		db.close();
		await f.start();
		for (const [name, params] of [
			["context_recall", { query: "MARKER-PRIOR", scope: "all-projects" }],
		] as const) {
			const result = await f.call(name, params);
			assert.deepEqual(result.details.transcripts.results, [], name);
			assert.doesNotMatch(text(result), /MARKER-PRIOR lives/u, name);
		}
	} finally { await f.restore(); }
});

const REMOVED_ALIASES = ["search_prior_sessions", "session_recall", "session_compaction_history", "compact_session", "compress", "decompress", "search_context", "acp_status"];

test("REQ-193-3: session_start registers context_recall direct and none of the removed names", async () => {
	const f = await fixture();
	try {
		assert.equal(f.host.tools.has("context_recall"), false, "nothing registers before the surface decision");
		await f.start();
		assert.equal(f.tool("context_recall").exposure, "direct");
		for (const removed of REMOVED_ALIASES) assert.equal(f.host.tools.has(removed), false, removed);
		for (const owned of ["context_status", "context_compact", "context_fold"]) assert.equal(f.host.tools.has(owned), true, `${owned} registers beside context_recall (pi-context-aware#189, #194)`);
		assert.match(JSON.stringify(f.tool("context_recall")), /memory\.recall/u, "the description points programs to Fabric memory.recall");
	} finally { await f.restore(); }
});

test("REQ-193-3: with billion-context-pi loaded, this extension registers none of the removed names", async () => {
	const f = await fixture({ billionContextPi: true });
	try {
		await f.start();
		assert.equal(f.tool("context_recall").exposure, "direct");
		for (const removed of REMOVED_ALIASES) assert.equal(f.registrations.includes(removed), false, removed);
	} finally { await f.restore(); }
});

test("REQ-193-3: a second session_start registers each tool once", async () => {
	const f = await fixture();
	try {
		await f.start();
		await f.start({ ...f.ctx } as ExtensionContext);
		const count = (name: string) => f.registrations.filter((registered) => registered === name).length;
		assert.equal(count("context_recall"), 1);
		for (const removed of REMOVED_ALIASES) assert.equal(count(removed), 0, removed);
	} finally { await f.restore(); }
});

// -- A real Pi session --------------------------------------------------------

const STUB_PATH_NOTE = "Stub of billion-context-pi";

async function realSession(withBillionContextPi: boolean) {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-session-")));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({ provider: "context-recall", models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("context-recall", "test-only");
	let stub: ExtensionAPI | undefined;
	const registered = new Set<string>();
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?context-recall-session=${Date.now()}-${++loads}`);
		extension.default(new Proxy(pi, {
			get: (target, key) => key === "registerTool"
				? (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => { registered.add(tool.name); target.registerTool(tool); }
				: Reflect.get(target, key),
		}));
	};
	// Stands in for billion-context-pi when it is loaded: its signature pair and its own search_context.
	const billionContextStub: ExtensionFactory = (pi) => {
		stub = pi;
		if (!withBillionContextPi) return;
		registerSignature(pi);
		pi.registerTool({ name: "search_context", label: "search_context", description: STUB_PATH_NOTE, parameters: obj({}, { open: true }), async execute() { return { content: [{ type: "text", text: "stub" }], details: {} }; } });
	};
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		// billion-context-pi loads first: Pi lists the first tool registered under a name, so its pair outranks our aliases of them.
		resourceLoaderOptions: { extensionFactories: [billionContextStub, contextAware], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: faux.getModel() });
	await session.bindExtensions({});
	return {
		session,
		stub: () => { assert.ok(stub); return stub; },
		registered,
		tool: (name: string) => session.getAllTools().find((tool) => tool.name === name),
		async cleanup() {
			session.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await removeFixtureDir(cwd);
		},
	};
}

function registerSignature(pi: ExtensionAPI): void {
	for (const name of ["compress", "acp_status"]) {
		pi.registerTool({ name, label: name, description: `${STUB_PATH_NOTE}'s ${name}.`, parameters: obj({}, { open: true }), async execute() { return { content: [{ type: "text", text: "stub" }], details: {} }; } });
	}
}

test("REQ-193-3: a real Pi session declares context_recall and none of the removed names", async () => {
	const absent = await realSession(false);
	try {
		assert.equal(absent.tool("context_recall")?.exposure, "direct");
		for (const removed of REMOVED_ALIASES) assert.equal(absent.tool(removed), undefined, removed);
		assert.ok(absent.session.getActiveToolNames().includes("context_recall"));
		assert.match(absent.session.systemPrompt, /\bcontext_recall\b/u);
	} finally { await absent.cleanup(); }

	const loaded = await realSession(true);
	try {
		assert.equal(loaded.tool("context_recall")?.exposure, "direct");
		assert.equal(loaded.tool("search_context")?.description, STUB_PATH_NOTE, "billion-context-pi keeps its own search_context");
		assert.equal(loaded.tool("decompress"), undefined, "decompress is not registered while billion-context-pi is loaded");
	} finally { await loaded.cleanup(); }
});

test("recall numeric fields retain finite-number admission", () => {
	const validator = compile(contextRecallSchema);
	for (const field of ["offset", "max_sessions"] as const) {
		for (const value of [Infinity, -Infinity, NaN]) {
			assert.equal(validator.check({ [field]: value }), false);
		}
		assert.equal(validator.check({ [field]: Number.MAX_VALUE }), true);
	}
});
