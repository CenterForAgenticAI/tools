import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextAware from "../src/index.js";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";
import { createCompactionOwnerClaim } from "../src/compaction/owner-claim.js";
import { COMPACTION_OWNER_NAME } from "../src/compaction/owner-identity.js";
import { CONTEXT_AWARE_COMPACTOR_VERSION, compactionWriterOf } from "../src/compaction/compaction-writer.js";
import { createHostPi, createSession, FakeFabric, OWNER_EVENT, type FakeHostPi, type FakeSession } from "./compaction-owner-harness.js";

type Json = Record<string, unknown>;
type Notice = { readonly message: string; readonly level: string };
type Command = { readonly handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown> };

interface Fixture {
	readonly host: FakeHostPi;
	readonly fabric: FakeFabric | undefined;
	readonly session: FakeSession;
	readonly notices: Notice[];
	readonly commands: Map<string, Command>;
	readonly ownerClaimSignals: readonly AbortSignal[];
	start(session?: FakeSession): Promise<void>;
	commit(entry: unknown, session?: FakeSession, eventEntry?: unknown): Promise<void>;
	dispose(): void;
}

function contextAwareClaimSignal(value: unknown): AbortSignal | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const message = value as { owner?: { name?: unknown }; signal?: unknown };
	return message.owner?.name === COMPACTION_OWNER_NAME && message.signal instanceof AbortSignal
		? message.signal
		: undefined;
}

async function flushFabricClaims(fabric: FakeFabric | undefined): Promise<void> {
	if (fabric !== undefined && "flush" in fabric && typeof fabric.flush === "function") {
		await fabric.flush();
	}
}

async function waitForClaimAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("compaction owner claim did not settle within 6 s")), 6_000);
		const onAbort = (): void => {
			clearTimeout(timeout);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function assertContextAwareClaimHeld(fixture: Fixture): void {
	assert.equal(fixture.fabric?.claim?.owner.name, COMPACTION_OWNER_NAME, "context-aware claim must be held before the writer assertion");
}

async function fixture(options: {
	readonly config?: Record<string, unknown>;
	readonly piNativeCompaction?: boolean;
	readonly blocked?: boolean;
	readonly sessionId?: string;
	readonly claimMode?: "held" | "no-fabric" | "refused";
} = {}): Promise<Fixture> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-writer-warning-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), `${JSON.stringify({
		contextCache: { enabled: false },
		sessionNaming: { scope: "off" },
		workstream: { enabled: false },
		proactiveCompaction: { enabled: true },
		compactionClaim: { enabled: true },
		...options.config,
	}, null, 2)}\n`);
	fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({
		compaction: { enabled: options.piNativeCompaction ?? false },
	})}\n`);

	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const host = createHostPi();
	const fabric = options.claimMode === "no-fabric" ? undefined : new FakeFabric(host.bus);
	const ownerClaimSignals: AbortSignal[] = [];
	host.bus.on(OWNER_EVENT, (value) => {
		const signal = contextAwareClaimSignal(value);
		if (signal !== undefined) ownerClaimSignals.push(signal);
	});
	const occupyingClaim = options.claimMode === "refused"
		? createCompactionOwnerClaim({
			events: host.bus,
			owner: { name: "another-owner", version: "1.0.0" },
			actions: {},
		})
		: undefined;
	if (occupyingClaim) {
		occupyingClaim.claim();
		await flushFabricClaims(fabric);
		assert.equal(occupyingClaim.active, true, "the occupying claim must settle before context-aware starts");
	}
	if (options.blocked) {
		(host.api as unknown as { getAllTools(): unknown[] }).getAllTools = () => [
			{ name: "compress", sourceInfo: { path: "/opt/billion-context-pi/index.ts" } },
			{ name: "acp_status", sourceInfo: { path: "/opt/billion-context-pi/index.ts" } },
		];
	}
	const commands = new Map<string, Command>();
	(host.api as unknown as { registerCommand(name: string, command: Command): void }).registerCommand =
		(name, command) => commands.set(name, command);
	contextAware(host.api);
	const session = createSession(root, options.sessionId ?? "writer-session");
	const notices: Notice[] = [];

	const prepareContext = (target: FakeSession, hasUI: boolean): void => {
		const mutable = target.ctx as unknown as {
			hasUI: boolean;
			ui: { notify(message: string, level: string): void };
		};
		mutable.hasUI = hasUI;
		mutable.ui = { notify: (message, level) => notices.push({ message, level }) };
	};

	return {
		host,
		fabric,
		session,
		notices,
		commands,
		ownerClaimSignals,
		async start(target = session) {
			prepareContext(target, false);
			await host.handler("session_start")({ type: "session_start", reason: "new" }, target.ctx);
			await flushFabricClaims(fabric);
			if (fabric === undefined) {
				const signal = ownerClaimSignals.at(-1);
				if (signal !== undefined) await waitForClaimAbort(signal);
			}
			prepareContext(target, true);
			notices.length = 0;
		},
		async commit(entry, target = session, eventEntry = entry) {
			if (typeof entry === "object" && entry !== null) target.branch.push(entry as Json);
			await host.handler("session_compact")({
				type: "session_compact",
				reason: "manual",
				willRetry: false,
				fromExtension: (eventEntry as { fromHook?: unknown } | null)?.fromHook === true,
				compactionEntry: eventEntry,
			}, target.ctx);
		},
		dispose() {
			occupyingClaim?.release();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function writerWarnings(notices: readonly Notice[]): Notice[] {
	return notices.filter(({ message, level }) => level === "warning" && message.includes("committed compaction writer"));
}

function fabricDetails(claimOwner?: string): Json {
	return {
		compactor: "fabric",
		version: 2,
		sections: ["Goal"],
		coverage: {
			cumulativeSourceRange: { first: "m1", last: "m2" },
			liveCutRange: { first: "m1", last: "m2" },
		},
		counts: {
			branchEntries: 2, cumulativeSourceEntries: 2, sourceEvents: 2, liveCutEntries: 2,
			priorFabricV1: 0, priorFabricV2: 0,
		},
		omittedCounts: { goal: 0, files: 0, outstanding: 0, earlierTurns: 0, transcript: 0, preserve: 0 },
		instructionPolicy: {
			mode: "none", canonicalized: false, truncated: false, sourceBytes: 0, preserveCount: 0, omittedPreserveCount: 0,
		},
		stableAddresses: {
			firstKeptEntryId: "m2",
			cumulativeSourceRange: { first: "m1", last: "m2" },
			recall: "session-entry-id-range",
		},
		timestamp: "2026-10-13T00:00:00.000Z",
		...(claimOwner === undefined ? {} : { claimOwner }),
	};
}

function fabricV1Details(): Json {
	return {
		compactor: "fabric",
		version: 1,
		sections: ["Goal"],
		summarizedEntryRange: { first: "m1", last: "m2" },
		sourceEntryCount: 2,
		firstKeptEntryId: "m2",
		timestamp: "2026-10-13T00:00:00.000Z",
	};
}

const fabricEngineEntry = (id: string, details: Json = fabricDetails()): Json => ({
	type: "compaction",
	id,
	fromHook: true,
	summary: "Fabric summary",
	details,
});

const anotherExtensionEntry = (id: string): Json => ({
	type: "compaction",
	id,
	fromHook: true,
	summary: "Rival summary",
	details: { compactor: "rival-compactor", compactorVersion: 1 },
});

const contextAwareEntry = (id: string, summary = "Our summary"): Json => ({
	type: "compaction",
	id,
	fromHook: true,
	summary,
	details: {
		compactor: COMPACTION_OWNER_NAME,
		compactorVersion: CONTEXT_AWARE_COMPACTOR_VERSION,
	},
});

test("REQ-DUP-001: Fabric's engine warns once per session and a new session warns again", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		await f.commit(fabricEngineEntry("fabric-1", fabricV1Details()));
		await f.commit(fabricEngineEntry("fabric-2"));
		assert.deepEqual(writerWarnings(f.notices).map(({ message }) => message), [
			"Unexpected committed compaction writer: Fabric. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.",
		]);

		const second = createSession(f.session.ctx.cwd, "writer-session-2");
		await f.start(second);
		assertContextAwareClaimHeld(f);
		await f.commit(fabricEngineEntry("fabric-3"), second);
		assert.deepEqual(writerWarnings(f.notices).map(({ message }) => message), [
			"Unexpected committed compaction writer: Fabric. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.",
		]);

		await f.start(f.session);
		assertContextAwareClaimHeld(f);
		await f.commit(fabricEngineEntry("fabric-4"));
		assert.deepEqual(writerWarnings(f.notices), [], "returning to session A must not warn a second time");
	} finally {
		f.dispose();
	}
});

test("REQ-DUP-002: another extension warns once and names its compactor", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		await f.commit(anotherExtensionEntry("rival-1"));
		await f.commit(anotherExtensionEntry("rival-2"));
		assert.deepEqual(writerWarnings(f.notices).map(({ message }) => message), [
			"Unexpected committed compaction writer: rival-compactor. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.",
		]);
	} finally {
		f.dispose();
	}
});

test("REQ-DUP-002: a detail-less or opaque extension commit warns as an unnamed extension", async () => {
	for (const [label, details] of [["missing", undefined], ["non-object", "opaque"]] as const) {
		const f = await fixture();
		try {
			await f.start();
			assertContextAwareClaimHeld(f);
			await f.commit({
				type: "compaction",
				id: label,
				fromHook: true,
				summary: "Extension summary",
				...(details === undefined ? {} : { details }),
			});
			assert.deepEqual(writerWarnings(f.notices).map(({ message }) => message), [
				"Unexpected committed compaction writer: another extension. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.",
			], label);
		} finally {
			f.dispose();
		}
	}
});

test("REQ-DUP-003: context-aware, its Fabric fallback, Pi, and malformed entries stay silent", async () => {
	const f = await fixture({ config: { compactionClaim: { enabled: true, fabricFallback: false } } });
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		for (const entry of [
			contextAwareEntry("ours"),
			{ type: "compaction", id: "fallback", fromHook: true, summary: "Fallback", details: fabricDetails(COMPACTION_OWNER_NAME) },
			{ type: "compaction", id: "pi", fromHook: false, summary: "Pi fallback" },
			{ type: "compaction", id: "invalid-from-hook", fromHook: "yes", summary: "Unknown" },
			{ type: "compaction", id: "invalid-fabric-version", fromHook: true, summary: "Unknown", details: { compactor: "fabric" } },
			{ type: "compaction", id: "incomplete-fabric-v2", fromHook: true, summary: "Unknown", details: { compactor: "fabric", version: 2 } },
			{ type: "compaction", id: "invalid-claim-owner", fromHook: true, summary: "Unknown", details: { compactor: "fabric", version: 2, claimOwner: 7 } },
			null,
		] as const) await f.commit(entry);
		assert.deepEqual(writerWarnings(f.notices), []);
	} finally {
		f.dispose();
	}
});

test("a no-Fabric claim yield does not warn for Fabric's writer", async () => {
	const f = await fixture({ claimMode: "no-fabric" });
	try {
		await f.start();
		assert.equal(f.ownerClaimSignals.at(-1)?.aborted, true, "the no-Fabric claim must settle before the writer assertion");
		await f.commit(fabricEngineEntry("no-fabric"));
		assert.deepEqual(writerWarnings(f.notices), []);
	} finally {
		f.dispose();
	}
});

test("a refused claim yield does not warn for Fabric's writer", async () => {
	const f = await fixture({ claimMode: "refused" });
	try {
		await f.start();
		assert.equal(f.fabric?.claim?.owner.name, "another-owner", "the occupying claim must remain held after refusing context-aware");
		assert.equal(f.ownerClaimSignals.at(-1)?.aborted, true, "the refused context-aware claim must settle before the writer assertion");
		await f.commit(fabricEngineEntry("refused"));
		assert.deepEqual(writerWarnings(f.notices), []);
	} finally {
		f.dispose();
	}
});

test("a faulted claim yield does not warn for Fabric's writer", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		(f.host.api as unknown as { appendEntry: () => void }).appendEntry = () => { throw new Error("session file is read-only"); };
		await assert.rejects(f.fabric!.call("carry", { add: ["x"] }, f.session.ctx), /compact\.carry failed: session file is read-only/u);
		assert.equal(f.fabric!.engineActive, true, "the faulted claim must be withdrawn before the writer assertion");
		await f.commit(fabricEngineEntry("faulted"));
		assert.deepEqual(writerWarnings(f.notices), []);
	} finally {
		f.dispose();
	}
});

test("a released claim does not warn for Fabric's writer", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		f.fabric!.shutdown();
		assert.equal(f.fabric!.engineActive, true, "Fabric shutdown must release the claim before the writer assertion");
		await f.commit(fabricEngineEntry("released"));
		assert.deepEqual(writerWarnings(f.notices), []);
	} finally {
		f.dispose();
	}
});

test("expected ownership yields do not warn for a Fabric writer", async () => {
	for (const [label, options, expectedHeld] of [
		["disabled", { config: { compactionClaim: { enabled: false } }, piNativeCompaction: false }, false],
		["deferred", { config: { summarizer: { enabled: false }, compactionClaim: { enabled: true } }, piNativeCompaction: false }, false],
		["competing", { config: { compactionClaim: { enabled: true }, proactiveCompaction: { enabled: true } }, piNativeCompaction: true }, true],
		["blocked", { config: { compactionClaim: { enabled: true } }, piNativeCompaction: false, blocked: true }, false],
	] as const) {
		const f = await fixture(options);
		try {
			await f.start();
			assert.equal(f.fabric?.claim?.owner.name === COMPACTION_OWNER_NAME, expectedHeld, label);
			await f.commit(fabricEngineEntry(`expected-fabric-${label}`));
			assert.deepEqual(writerWarnings(f.notices), [], label);
		} finally {
			f.dispose();
		}
	}
});

test("the newest branch compaction wins when Pi reports an older entry with the same summary", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		const older = contextAwareEntry("older", "Repeated summary");
		await f.commit(older);
		const newest = { ...anotherExtensionEntry("newest"), summary: "Repeated summary" };
		await f.commit(newest, f.session, older);
		assert.deepEqual(writerWarnings(f.notices).map(({ message }) => message), [
			"Unexpected committed compaction writer: rival-compactor. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.",
		]);
	} finally {
		f.dispose();
	}
});

test("throwing compaction metadata accessors classify as malformed", () => {
	const malformed = { kind: "malformed", name: "unknown (malformed metadata)" };
	const throwingCompactor = Object.defineProperty({}, "compactor", {
		enumerable: true,
		get() { throw new Error("compactor getter boom"); },
	});
	const throwingFromHook = Object.defineProperty({}, "fromHook", {
		enumerable: true,
		get() { throw new Error("fromHook getter boom"); },
	});
	const throwingDetails = Object.defineProperty({ fromHook: true }, "details", {
		enumerable: true,
		get() { throw new Error("details getter boom"); },
	});
	assert.deepEqual(compactionWriterOf({ fromHook: true, details: throwingCompactor }), malformed);
	assert.deepEqual(compactionWriterOf(throwingFromHook), malformed);
	assert.deepEqual(compactionWriterOf(throwingDetails), malformed);
});

test("a writer observer failure cannot stop later session_compact bookkeeping", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		const manager = f.session.ctx.sessionManager;
		const originalGetSessionId = manager.getSessionId.bind(manager);
		let reads = 0;
		(manager as unknown as { getSessionId(): string }).getSessionId = () => {
			reads++;
			if (reads === 1) throw new Error("observer session id boom");
			return originalGetSessionId();
		};
		await f.commit(fabricEngineEntry("observer-failure"));
		assert.ok(reads >= 2, "later bookkeeping reads the session id after the observer failure");
	} finally {
		f.dispose();
	}
});

test("writer display names reject controls, format characters, surrogates, and private use", () => {
	for (const [label, name] of [
		["C1 control", `bad\u0085name`],
		["bidi override", `bad\u202ename`],
		["bidi isolate", `bad\u2066name`],
		["line separator", `bad\u2028name`],
		["zero-width format", `bad\u200bname`],
		["unpaired surrogate", `bad\ud800name`],
		["private use", `bad\ue000name`],
	] as const) {
		assert.deepEqual(
			compactionWriterOf({ fromHook: true, details: { compactor: name } }),
			{ kind: "extension", name: "another extension" },
			label,
		);
	}
	assert.deepEqual(
		compactionWriterOf({ fromHook: true, details: { compactor: "@acme/pi-compactor" } }),
		{ kind: "extension", name: "@acme/pi-compactor" },
	);
});

test("the last committed writer appears in context status and the typed snapshot", async () => {
	const f = await fixture();
	try {
		await f.start();
		assertContextAwareClaimHeld(f);
		await f.commit(fabricEngineEntry("fabric-status"));
		const service = discoverContextAwareServiceV1(f.host.bus, "writer-warning-test");
		assert.ok(service);
		const snapshot = service.getSnapshot() as ReturnType<typeof service.getSnapshot> & {
			compaction: { writer?: { kind: string; name: string } };
		};
		assert.deepEqual(snapshot.compaction.writer, { kind: "fabric", name: "Fabric" });

		f.notices.length = 0;
		const status = f.commands.get("context-status");
		assert.ok(status);
		await status.handler("", f.session.ctx);
		assert.match(f.notices.at(-1)?.message ?? "", /Last committed compaction writer: Fabric/u);
	} finally {
		f.dispose();
	}
});
