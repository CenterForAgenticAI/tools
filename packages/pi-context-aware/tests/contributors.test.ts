import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { removeFixtureDir } from "./fixture-cleanup.js";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { complete as compatComplete } from "@earendil-works/pi-ai/compat";

import contextAware from "../src/index.js";
import * as contextService from "../src/context-service.js";
import { discoverContextAwareServiceV1, type ContextAwareServiceV1 } from "../src/context-service.js";
import { foldDrafts, type FoldRecord } from "../src/folds/fold-entries.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";

// pi-context-aware#300: contributors on the context-aware service.
// Seams: the discovered service (contributors.register / endOwner, the guard), the per-turn message
// a real Pi session persists, the session entries it records, and the compaction summary. The
// shapes below are written from the documented contract, not imported, so a consumer's view is
// what the test checks. Expected texts are literals the test owns.

interface Budget { readonly maxChars: number }
interface Contribution { readonly id: string; readonly text: string }
type Result = { readonly ok: true } | { readonly ok: false; readonly error: string };
interface ContributorsShape {
	readonly v1: true;
	register(registration: unknown): Result;
	endOwner(ownerKey: string): boolean;
}

const PER_TURN_TYPES = new Set(["context-aware-task-state", "context-aware-restart-notice", "context-aware-usage-marker"]);
const SHOWN_TYPE = "context-aware.contributor-shown.v1";
const BRIEF = "WORKSTREAM-BRIEF-41c: keep the numbered order; the parser change is next.";
const TASKS = "WORKSTREAM-TASKS-77e: 1. parser [in progress] 2. docs [pending]";

function contributorsOf(service: ContextAwareServiceV1 | undefined): ContributorsShape {
	const contributors = (service as { contributors?: ContributorsShape } | undefined)?.contributors;
	assert.ok(contributors, "the service offers contributors");
	return contributors;
}

function seedWindow(name: string, extra: Record<string, unknown> = {}): { dir: string; restore: () => Promise<void> } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-contributors-" + name + "-")));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({
		summarizer: { enabled: false }, proactiveCompaction: { enabled: false, commitDrainTimeoutMs: 0 }, contextCache: { enabled: false },
		restartNotice: { enabled: false }, seedRewrite: false, sessionNaming: { scope: "off" }, workstream: { enabled: false },
		...extra,
	}));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return {
		dir,
		async restore() {
			if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
			if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
			await removeFixtureDir(dir);
		},
	};
}

// ---- a real Pi session -----------------------------------------------------------------------------

interface Live {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly requests: Context["messages"][];
	service(): ContextAwareServiceV1 | undefined;
	/** Run one user turn; returns the per-turn message context-aware added to it, or undefined. */
	turn(text: string): Promise<string | undefined>;
	dispose(): void;
}

async function liveSession(cwd: string, manager: SessionManager): Promise<Live> {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const faux = fauxProvider({ provider: "contrib", models: [{ id: "deterministic", contextWindow: 200_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("contrib", "test-only");
	let bus: EventBus | undefined;
	const probe: ExtensionFactory = (api) => { bus = api.events; };
	const services = await createAgentSessionServices({
		cwd, agentDir, modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: [contextAware as ExtensionFactory, probe], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	await session.bindExtensions({});
	const requests: Context["messages"][] = [];
	return {
		session, manager, requests,
		service: () => (bus ? discoverContextAwareServiceV1(bus, "contributors-test") : undefined),
		async turn(text) {
			const before = manager.getBranch().length;
			faux.setResponses([(context: Context) => { requests.push(structuredClone(context.messages)); return fauxAssistantMessage("Done: " + text); }]);
			await session.prompt(text);
			await session.waitForIdle();
			return perTurnText(manager.getBranch().slice(before));
		},
		dispose() { session.dispose(); },
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("") : "";
}

function perTurnEntry(entries: readonly SessionEntry[]): (SessionEntry & { type: "custom_message" }) | undefined {
	return entries.find((entry): entry is SessionEntry & { type: "custom_message" } => entry.type === "custom_message" && PER_TURN_TYPES.has(entry.customType));
}

function perTurnText(entries: readonly SessionEntry[]): string | undefined {
	const entry = perTurnEntry(entries);
	return entry ? textOf(entry.content) : undefined;
}

function shownRecords(manager: SessionManager): unknown[] {
	return manager.getBranch().flatMap((entry) => (entry.type === "custom" && entry.customType === SHOWN_TYPE ? [entry.data] : []));
}

function seedHistory(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "OPENING request", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("OPENING answer"));
}

async function withLive(name: string, body: (live: Live, dir: string) => Promise<void>, extra: Record<string, unknown> = {}): Promise<void> {
	const window = seedWindow(name, extra);
	const manager = SessionManager.inMemory(window.dir);
	seedHistory(manager);
	const live = await liveSession(window.dir, manager);
	try { await body(live, window.dir); } finally { live.dispose(); await window.restore(); }
}

/** A contributor whose texts the test changes between turns. */
function mutable(ownerKey: string, initial: Contribution[]): { registration: Record<string, unknown>; set(next: Contribution[]): void; budgets: Budget[] } {
	let current = initial;
	const budgets: Budget[] = [];
	return {
		registration: { ownerKey, render: (budget: Budget) => { budgets.push({ ...budget }); return current; } },
		set(next) { current = next; },
		budgets,
	};
}

// ---- REQ-CONTRIB-008: the guard ---------------------------------------------------------------------

test("REQ-CONTRIB-008: the guard is true for this service and false for an older or partial one", async () => {
	const guard = (contextService as Record<string, unknown>).supportsContextAwareContributorsV1 as ((service: unknown) => boolean) | undefined;
	assert.equal(typeof guard, "function", "the context-service module exports the guard");
	await withLive("guard", async (live) => {
		assert.equal(guard!(live.service()), true, "the live service accepts contributors");
	});
	const older = { protocolVersion: 1, getSnapshot: () => ({}), requestHandoff: async () => ({}), cancelHandoff: () => ({}) };
	assert.equal(guard!(older), false, "a service without contributors");
	assert.equal(guard!(undefined), false, "no service at all");
	assert.equal(guard!({ ...older, contributors: { register() {}, endOwner() {} } }), false, "contributors without v1: true");
	assert.equal(guard!({ ...older, contributors: { v1: true, register() {} } }), false, "contributors without endOwner");
	assert.equal(guard!({ ...older, contributors: { v1: true, register() {}, endOwner() {} } }), true);
});

// ---- REQ-CONTRIB-002: placement and order -------------------------------------------------------------

test("REQ-CONTRIB-002: contributions are placed in the per-turn message in registration order, then render order", async () => {
	await withLive("order", async (live) => {
		const contributors = contributorsOf(live.service());
		assert.deepEqual(contributors.register({ ownerKey: "owner-a", render: () => [{ id: "a1", text: "ALPHA-ONE" }, { id: "a2", text: "ALPHA-TWO" }] }), { ok: true });
		assert.deepEqual(contributors.register({ ownerKey: "owner-b", render: () => [{ id: "b1", text: "BRAVO-ONE" }] }), { ok: true });
		const text = await live.turn("first");
		assert.ok(text, "the turn has a per-turn message");
		assert.ok(text.startsWith("ALPHA-ONE\n\nALPHA-TWO\n\nBRAVO-ONE"), "owners in registration order, texts in render order, before the telemetry: " + JSON.stringify(text.slice(0, 80)));
		assert.ok(text.includes("<context-telemetry"), "telemetry still follows");
		const sent = JSON.stringify(live.requests.at(-1));
		assert.ok(sent.includes("ALPHA-ONE") && sent.includes("BRAVO-ONE"), "the model received the contributions");
		const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
		assert.deepEqual(shownRecords(live.manager), [{
			version: 1,
			shown: [
				{ ownerKey: "owner-a", contributionId: "a1", textDigest: sha("ALPHA-ONE") },
				{ ownerKey: "owner-a", contributionId: "a2", textDigest: sha("ALPHA-TWO") },
				{ ownerKey: "owner-b", contributionId: "b1", textDigest: sha("BRAVO-ONE") },
			],
		}], "one record for the turn, with the documented SHA-256 digest of each text");
	});
});

test("REQ-CONTRIB-002: contributions go after the task list and the brief, before the telemetry", async () => {
	await withLive("after-brief", async (live) => {
		const contributors = contributorsOf(live.service());
		assert.deepEqual(contributors.register({ ownerKey: "owner-a", render: () => [{ id: "a1", text: "ALPHA-ONE" }] }), { ok: true });
		const text = await live.turn("first");
		assert.ok(text);
		const at = text.indexOf("ALPHA-ONE");
		assert.ok(at >= 0 && at < text.indexOf("<context-telemetry"), "before the telemetry");
	});
});

test("REQ-CONTRIB-002: with no contribution the per-turn message is byte-identical to a session without contributors", async () => {
	let plain: string | undefined;
	await withLive("plain", async (live) => { plain = await live.turn("first"); });
	let empty: string | undefined;
	await withLive("empty", async (live) => {
		assert.deepEqual(contributorsOf(live.service()).register({ ownerKey: "quiet", render: () => [] }), { ok: true });
		empty = await live.turn("first");
		assert.deepEqual(shownRecords(live.manager), [], "nothing shown, nothing recorded");
	});
	assert.ok(plain !== undefined && plain.length > 0);
	assert.equal(empty, plain);
});

// ---- REQ-CONTRIB-001: named fields and bounds ---------------------------------------------------------

test("REQ-CONTRIB-001: registration copies only own named fields; later changes to the object do nothing", async () => {
	await withLive("copy", async (live) => {
		const contributors = contributorsOf(live.service());
		const inherited = Object.create({ render: () => [{ id: "x", text: "INHERITED" }] }) as Record<string, unknown>;
		inherited.ownerKey = "inherited";
		assert.deepEqual(contributors.register(inherited), { ok: false, error: "render must be a function" }, "an inherited render is not read");
		const registration: Record<string, unknown> = { ownerKey: "copied", render: () => [{ id: "c1", text: "FIRST-RENDER" }], extra: { priority: -1 }, ownerKeyAlias: "context-aware" };
		assert.deepEqual(contributors.register(registration), { ok: true });
		registration.render = () => [{ id: "c1", text: "SWAPPED-RENDER" }];
		registration.ownerKey = "someone-else";
		const text = await live.turn("first");
		assert.ok(text?.includes("FIRST-RENDER"), "the render read at registration is used");
		assert.equal(text?.includes("SWAPPED-RENDER"), false);
		assert.equal((shownRecords(live.manager)[0] as { shown: { ownerKey: string }[] }).shown[0]!.ownerKey, "copied");
		assert.deepEqual(contributors.register({ ownerKey: "x".repeat(201), render: () => [] }), { ok: false, error: "ownerKey must be 1-200 printable characters" });
		assert.deepEqual(contributors.register({ ownerKey: "line\nbreak", render: () => [] }), { ok: false, error: "ownerKey must be 1-200 printable characters" });
		assert.deepEqual(contributors.register({ ownerKey: "bad-carry", render: () => [], carry: "text" }), { ok: false, error: "carry must be a function" });
	});
});

test("REQ-CONTRIB-001: a text over 4,000 characters is skipped, never cut, and a 4,000-character text is shown", async () => {
	await withLive("oversized", async (live) => {
		const big = "B".repeat(3_990) + "-BIG-END" + "!!!"; // 4,001
		const fits = "F".repeat(3_992) + "-FIT-END"; // 4,000
		assert.equal(big.length, 4_001);
		assert.equal(fits.length, 4_000);
		const contributors = contributorsOf(live.service());
		assert.deepEqual(contributors.register({ ownerKey: "sizes", render: () => [{ id: "big", text: big, extra: "ignored" }, { id: "fits", text: fits }] }), { ok: true });
		const text = await live.turn("first");
		assert.equal(text?.includes("BBBB"), false, "no part of the oversized text is shown");
		assert.ok(text?.includes(fits), "the text at the cap is shown whole");
		const shown = (shownRecords(live.manager)[0] as { shown: Record<string, unknown>[] }).shown;
		assert.deepEqual(shown.map((item) => Object.keys(item).sort()), [["contributionId", "ownerKey", "textDigest"]], "only the named fields are recorded");
		assert.deepEqual(shown.map((item) => item.contributionId), ["fits"], "the skipped text is not recorded, so it stays due");
	});
});

test("REQ-CONTRIB-001: each owner gets at most 8,000 characters and all owners share 8,000 per turn", async () => {
	await withLive("budget", async (live) => {
		const contributors = contributorsOf(live.service());
		const first = mutable("first-owner", [{ id: "p1", text: "P".repeat(3_000) }, { id: "p2", text: "Q".repeat(3_000) }, { id: "p3", text: "R".repeat(3_000) }]);
		const second = mutable("second-owner", [{ id: "s1", text: "S".repeat(2_500) }, { id: "s2", text: "T".repeat(1_500) }]);
		assert.deepEqual(contributors.register(first.registration), { ok: true });
		assert.deepEqual(contributors.register(second.registration), { ok: true });
		const text = await live.turn("first") ?? "";
		assert.deepEqual(first.budgets, [{ maxChars: 8_000 }], "the first owner is offered the whole turn");
		assert.deepEqual(second.budgets, [{ maxChars: 2_000 }], "the second owner is offered what is left");
		assert.ok(text.includes("P".repeat(3_000)) && text.includes("Q".repeat(3_000)));
		assert.equal(text.includes("RRRR"), false, "the third text would pass the owner's 8,000");
		assert.equal(text.includes("SSSS"), false, "2,500 is over the 2,000 left");
		assert.ok(text.includes("T".repeat(1_500)), "a later text that fits is still shown");
	});
});

test("REQ-CONTRIB-001: a render that throws, is async or returns a bad value skips that owner only", async () => {
	await withLive("faulty", async (live) => {
		const contributors = contributorsOf(live.service());
		assert.ok(contributors.register({ ownerKey: "throws", render: () => { throw new Error("render boom"); } }).ok);
		assert.ok(contributors.register({ ownerKey: "async", render: async () => [{ id: "x", text: "ASYNC-TEXT" }] }).ok);
		assert.ok(contributors.register({ ownerKey: "bad-id", render: () => [{ id: "has space", text: "BAD-ID-TEXT" }] }).ok);
		assert.ok(contributors.register({ ownerKey: "dup-id", render: () => [{ id: "d", text: "DUP-ONE" }, { id: "d", text: "DUP-TWO" }] }).ok);
		assert.ok(contributors.register({ ownerKey: "good", render: () => [{ id: "g", text: "GOOD-TEXT" }] }).ok);
		const text = await live.turn("first") ?? "";
		assert.ok(text.includes("GOOD-TEXT"));
		for (const absent of ["ASYNC-TEXT", "BAD-ID-TEXT", "DUP-ONE", "DUP-TWO"]) assert.equal(text.includes(absent), false, absent);
		const log = fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "context-aware-debug.log"), "utf8");
		assert.match(log, /contributors: throws render failed: Error: render boom/u);
	});
});

// ---- REQ-CONTRIB-005 and the default: shown once, again when changed -------------------------------

test("REQ-CONTRIB-005: an unchanged text is shown once; a changed text is due again", async () => {
	await withLive("changed", async (live) => {
		const owner = mutable("changer", [{ id: "brief", text: "BRIEF-V1" }]);
		assert.ok(contributorsOf(live.service()).register(owner.registration).ok);
		assert.ok((await live.turn("one"))?.includes("BRIEF-V1"));
		assert.equal((await live.turn("two"))?.includes("BRIEF-V1") ?? false, false, "still in context, so not shown again");
		owner.set([{ id: "brief", text: "BRIEF-V2 with a trailing clause" }]);
		assert.ok((await live.turn("three"))?.includes("BRIEF-V2 with a trailing clause"), "the changed text is shown");
		assert.equal((await live.turn("four"))?.includes("BRIEF-V2") ?? false, false);
		// A shorter text that the last showing already contains is still a change: the model must see it on its own.
		owner.set([{ id: "brief", text: "BRIEF-V2" }]);
		const shortened = await live.turn("five") ?? "";
		assert.ok(shortened.includes("BRIEF-V2") && !shortened.includes("trailing clause"), "the shortened text is shown again");
		assert.equal(shownRecords(live.manager).length, 3);
	});
});

// ---- REQ-CONTRIB-004: a fold over the last showing ----------------------------------------------------

function foldOver(manager: SessionManager, carrierId: string, summary: string): void {
	const record: FoldRecord = {
		version: 1, blockId: "b1", runId: "r1", tier: 1, carrierId, hiddenIds: [],
		range: { startId: carrierId, endId: carrierId }, refs: { start: "m00003", end: "m00003" },
		directBlockIds: [], compressedTokens: 10, createdAt: 1, origin: "fold",
	};
	applyFoldDrafts(manager, foldDrafts(record, summary));
}

test("REQ-CONTRIB-004: a fold that covers the last showing makes the text due again, even when its summary quotes it", async () => {
	await withLive("folded", async (live) => {
		assert.ok(contributorsOf(live.service()).register({ ownerKey: "folded", render: () => [{ id: "brief", text: BRIEF }] }).ok);
		const before = live.manager.getBranch().length;
		assert.ok((await live.turn("one"))?.includes(BRIEF));
		const anchor = perTurnEntry(live.manager.getBranch().slice(before));
		assert.ok(anchor);
		assert.equal((await live.turn("two"))?.includes(BRIEF) ?? false, false, "not due while its showing is in context");
		foldOver(live.manager, anchor.id, "TASK AS OF THIS BLOCK: earlier turn. It said: " + BRIEF);
		assert.ok((await live.turn("three"))?.includes(BRIEF), "due again once a fold covers the showing");
		assert.equal((await live.turn("four"))?.includes(BRIEF) ?? false, false, "the new showing is in context");
	});
});

test("REQ-CONTRIB-004: a compaction that drops the last showing, or a context edit that hides it, makes the text due again", async () => {
	await withLive("compacted", async (live) => {
		assert.ok(contributorsOf(live.service()).register({ ownerKey: "compacted", render: () => [{ id: "brief", text: BRIEF }] }).ok);
		const before = live.manager.getBranch().length;
		assert.ok((await live.turn("one"))?.includes(BRIEF));
		const anchor = perTurnEntry(live.manager.getBranch().slice(before));
		assert.ok(anchor);
		const kept = live.manager.getBranch().length;
		await live.turn("two");
		const firstKept = live.manager.getBranch()[kept]!.id;
		live.manager.appendCompaction("Earlier work, summarized without the brief.", firstKept, 1_000);
		assert.ok((await live.turn("three"))?.includes(BRIEF), "due again after the compaction dropped it");
		const shownAgain = perTurnEntry(live.manager.getBranch().slice(-4));
		assert.ok(shownAgain);
		live.manager.appendContextEdit(shownAgain.id, null);
		assert.ok((await live.turn("four"))?.includes(BRIEF), "due again after a context edit hid it");
	});
});

// ---- REQ-CONTRIB-006: replay after a reload and after /tree ----------------------------------------

test("REQ-CONTRIB-006: last-shown state replays after a reload", async () => {
	const window = seedWindow("reload");
	try {
		const sessions = path.join(window.dir, "sessions");
		const created = SessionManager.create(window.dir, sessions);
		seedHistory(created);
		const first = await liveSession(window.dir, created);
		let file: string | undefined;
		try {
			assert.ok(contributorsOf(first.service()).register({ ownerKey: "reloaded", render: () => [{ id: "brief", text: BRIEF }] }).ok);
			assert.ok((await first.turn("one"))?.includes(BRIEF));
			file = created.getSessionFile();
		} finally { first.dispose(); }
		assert.ok(file && fs.existsSync(file), "the session was written to disk");
		const reopened = SessionManager.open(file, sessions);
		const second = await liveSession(window.dir, reopened);
		try {
			const owner = mutable("reloaded", [{ id: "brief", text: BRIEF }]);
			assert.ok(contributorsOf(second.service()).register(owner.registration).ok, "a new process registers again");
			assert.equal((await second.turn("two"))?.includes(BRIEF) ?? false, false, "the showing on disk still counts");
			owner.set([{ id: "brief", text: TASKS }]);
			assert.ok((await second.turn("three"))?.includes(TASKS), "a change after the reload is shown");
		} finally { second.dispose(); }
	} finally { await window.restore(); }
});

test("REQ-CONTRIB-006: last-shown state follows the branch after /tree", async () => {
	await withLive("tree", async (live) => {
		assert.ok(contributorsOf(live.service()).register({ ownerKey: "tree", render: () => [{ id: "brief", text: BRIEF }] }).ok);
		const opening = live.manager.getBranch().find((entry) => entry.type === "message" && (entry.message as { role?: string }).role === "assistant");
		assert.ok(opening);
		assert.ok((await live.turn("one"))?.includes(BRIEF));
		assert.equal((await live.turn("two"))?.includes(BRIEF) ?? false, false);
		const leafA = live.manager.getLeafId();
		assert.ok(leafA);
		await live.session.navigateTree(opening.id, { summarize: false });
		assert.ok((await live.turn("branch b"))?.includes(BRIEF), "a branch that never showed it shows it");
		await live.session.navigateTree(leafA, { summarize: false });
		assert.equal((await live.turn("back on a"))?.includes(BRIEF) ?? false, false, "back on the first branch, its showing counts again");
	});
});

// ---- REQ-CONTRIB-007: owners --------------------------------------------------------------------------

test("REQ-CONTRIB-007: one live owner per key, context-aware is reserved, and endOwner frees the key", async () => {
	await withLive("owners", async (live) => {
		const contributors = contributorsOf(live.service());
		assert.deepEqual(contributors.register({ ownerKey: "context-aware", render: () => [] }), { ok: false, error: 'ownerKey "context-aware" is reserved' });
		assert.deepEqual(contributors.register({ ownerKey: "pi-workstream", render: () => [{ id: "one", text: "FIRST-OWNER" }] }), { ok: true });
		assert.deepEqual(contributors.register({ ownerKey: "pi-workstream", render: () => [{ id: "one", text: "IMPOSTOR" }] }), { ok: false, error: "pi-workstream is already registered in this session" });
		const text = await live.turn("one") ?? "";
		assert.ok(text.includes("FIRST-OWNER"));
		assert.equal(text.includes("IMPOSTOR"), false);
		assert.equal(contributors.endOwner("pi-workstream"), true);
		assert.equal(contributors.endOwner("pi-workstream"), false, "already ended");
		assert.equal(contributors.endOwner("context-aware"), false);
		assert.deepEqual(contributors.register({ ownerKey: "pi-workstream", render: () => [{ id: "one", text: "SECOND-LIFE" }] }), { ok: true });
		assert.ok((await live.turn("two"))?.includes("SECOND-LIFE"));
	});
});

test("REQ-CONTRIB-007: a contributor's hints register under its own ownerKey, all or none", async () => {
	await withLive("hints", async (live) => {
		const service = live.service();
		const contributors = contributorsOf(service);
		assert.deepEqual(service?.folds?.registerHint({ ownerKey: "other-extension", match: { customType: "taken-status" }, policy: "drop-after-read" }), { ok: true, replaced: false });
		const refused = contributors.register({
			ownerKey: "hinted", render: () => [],
			hints: [{ match: { customType: "hinted-status" }, policy: "drop-after-read" }, { match: { customType: "taken-status" }, policy: "drop-after-read" }],
		});
		assert.deepEqual(refused, { ok: false, error: "hints: taken-status is owned by another extension in this session" });
		assert.deepEqual(service?.folds?.registerHint({ ownerKey: "third", match: { customType: "hinted-status" }, policy: "drop-after-read" }), { ok: true, replaced: false }, "the refused batch claimed no key");
		assert.deepEqual(contributors.register({ ownerKey: "hinted", render: () => [] }), { ok: true }, "the refused registration left no owner behind");
		assert.deepEqual(contributors.register({
			ownerKey: "reserved-hint", render: () => [],
			hints: [{ match: { customType: "context-aware.anything" }, policy: "drop-after-read" }],
		}), { ok: false, error: 'hints: customType prefix "context-aware." is reserved' });
		assert.deepEqual(contributors.register({
			ownerKey: "spoof", render: () => [],
			hints: [{ ownerKey: "other-extension", match: { customType: "spoof-status" }, policy: "drop-after-read" }],
		}), { ok: true });
		assert.deepEqual(service?.folds?.registerHint({ ownerKey: "other-extension", match: { customType: "spoof-status" }, policy: "default" }),
			{ ok: false, error: "spoof-status is owned by another extension in this session" }, "a hint's own ownerKey is ignored: the key belongs to the contributor");
	});
});

// ---- REQ-CONTRIB-003: carry into a compaction summary ------------------------------------------------

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function compactionBench(): Promise<{ service: ContextAwareServiceV1; compact(): Promise<string>; dispose(): Promise<void> }> {
	const window = seedWindow("carry", { summarizer: { enabled: true } });
	const compat = await import(new URL("./compat.js", import.meta.resolve("@earendil-works/pi-ai")).href) as typeof import("@earendil-works/pi-ai/compat");
	const faux = compat.registerFauxProvider({ api: "openai-completions", provider: "contrib-carry", models: [{ id: "summary", contextWindow: 32_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	faux.setResponses(Array.from({ length: 4 }, () => () => compat.fauxAssistantMessage("Carry bench summary.")));
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBus = {
		emit(channel, data) { for (const listener of listeners.get(channel) ?? []) listener(data); },
		on(channel, listener) {
			const set = listeners.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(listener);
			listeners.set(channel, set);
			return () => { set.delete(listener); };
		},
	};
	const flags: Record<string, unknown> = { "context-aware-model": "contrib-carry/summary" };
	contextAware({
		events: bus, registerFlag() {}, getFlag: (name: string) => flags[name],
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {}, registerCommand() {}, getCommands: () => [], sendMessage() {}, sendUserMessage() {},
		getActiveTools: () => ["read"], getAllTools: () => [], setActiveTools() {}, appendEntry() {},
	} as unknown as ExtensionAPI);
	const model = faux.getModel();
	const entries: unknown[] = [];
	const ctx = {
		hasUI: false, cwd: window.dir, model, getContextUsage: () => ({ tokens: 20_000 }), isProjectTrusted: () => true, isIdle: () => true, signal: undefined,
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "contrib-carry" && id === "summary" ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			complete: compatComplete,
		},
		ui: { notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {} },
		sessionManager: {
			getEntries: () => entries, getBranch: () => entries, getSessionDir: () => window.dir, getSessionFile: () => path.join(window.dir, "carry.jsonl"),
			getSessionId: () => "carry", appendCustomEntry() {}, getHeader: () => ({ parentSession: undefined }), getLeafId: () => "carry-leaf",
		},
	} as unknown as ExtensionContext;
	const run = async (name: string, event: Record<string, unknown>): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) { const next = await handler(event, ctx); if (next !== undefined) result = next; }
		return result;
	};
	await run("session_start", {});
	const service = discoverContextAwareServiceV1(bus, "carry-test");
	assert.ok(service);
	return {
		service,
		async compact() {
			const result = await run("session_before_compact", {
				reason: "manual", willRetry: false, signal: new AbortController().signal,
				preparation: { firstKeptEntryId: "kept", messagesToSummarize: [{ role: "user", content: "old request", timestamp: 1 }], turnPrefixMessages: [], tokensBefore: 20_000 },
			}) as { compaction?: { summary?: string } } | undefined;
			return result?.compaction?.summary ?? "";
		},
		async dispose() { faux.unregister(); compat.resetApiProviders(); await window.restore(); },
	};
}

test("REQ-CONTRIB-003: carry text appears in the compaction summary context-aware writes, under its heading", async () => {
	const bench = await compactionBench();
	try {
		const contributors = contributorsOf(bench.service);
		const budgets: Budget[] = [];
		assert.ok(contributors.register({ ownerKey: "carrier", render: () => [], carry: (budget: Budget) => { budgets.push({ ...budget }); return BRIEF; } }).ok);
		assert.ok(contributors.register({ ownerKey: "silent", render: () => [], carry: () => null }).ok);
		assert.ok(contributors.register({ ownerKey: "too-long", render: () => [], carry: () => "L".repeat(4_001) }).ok);
		assert.ok(contributors.register({ ownerKey: "throws", render: () => [], carry: () => { throw new Error("carry boom"); } }).ok);
		assert.ok(contributors.register({ ownerKey: "no-carry", render: () => [] }).ok);
		const summary = await bench.compact();
		assert.match(summary, /Carry bench summary\./u, "the summary model wrote the summary");
		const at = summary.indexOf("Carried by extensions (not user intent):");
		assert.ok(at > summary.indexOf("Carry bench summary."), "the heading follows the summary");
		assert.ok(summary.slice(at).includes("[carrier]\n" + BRIEF), "the carry text, labelled with its owner");
		assert.equal(summary.includes("LLLL"), false, "an oversized carry is skipped, never cut");
		assert.equal(summary.includes("[silent]") || summary.includes("[throws]") || summary.includes("[no-carry]"), false);
		assert.deepEqual(budgets, [{ maxChars: 4_000 }]);
	} finally { await bench.dispose(); }
});

test("REQ-CONTRIB-003: with no carry text the compaction summary is unchanged", async () => {
	const bench = await compactionBench();
	try {
		assert.ok(contributorsOf(bench.service).register({ ownerKey: "render-only", render: () => [] }).ok);
		const summary = await bench.compact();
		assert.match(summary, /Carry bench summary\./u);
		assert.equal(summary.includes("Carried by extensions"), false);
	} finally { await bench.dispose(); }
});
