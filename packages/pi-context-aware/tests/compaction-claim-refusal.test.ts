import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { FakeFabric, compactionEvent, createHostPi, createSession, type FakeHostPi, type FakeSession } from "./compaction-owner-harness.js";

// CR-CLAIM-REFUSAL-NOT-RIVAL (caair/pi/pi-context-aware!418): only a refusal that names the rival holding the
// compaction-owner claim makes "another owner" for the session. Fabric also refuses with no rival (its signal
// was already aborted, Fabric is shutting down, its owner code failed to load, an unknown reason); each of those
// is no claim, as before the strategy contract, so this package keeps folding and compacting.
// The refusal texts are pi-fabric's own (src/compaction/claim.ts, src/compaction/claim-events.ts).

const OWNER_EVENT = "pi-fabric:compaction-owner:v1";
const SUMMARY = "## Goal\nFinish the migration.\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Started";
const FOLD_SUMMARY = "TASK AS OF THIS BLOCK: the opening exchange settled the archive plan. Decisions: keep the numbered order.";

type Responder = { kind: "rival" } | { kind: "grant" } | { kind: "off" } | { kind: "refuse"; reply: Record<string, unknown> };

interface ClaimFixture {
	readonly host: FakeHostPi;
	readonly session: FakeSession;
	readonly ctx: ExtensionContext;
	readonly claims: unknown[];
	fold(): Promise<{ isError?: boolean; text: string }>;
	compact(): Promise<{ terminate?: boolean } | Error>;
	beforeCompact(reason?: "manual" | "threshold" | "overflow"): Promise<{ compaction?: { summary: string; firstKeptEntryId?: string }; cancel?: boolean } | undefined>;
	readonly keptId: string;
	readonly manager: SessionManager;
}

type Compat = typeof import("@earendil-works/pi-ai/compat");
let loadCounter = 0;

/**
 * `settings` go into the agent's context-aware.json. `summaryModel` names the faux model as `compactionModel`, so the
 * context-aware summary is written on every compaction, not only on a queued handoff.
 */
async function withClaimFixture(responder: Responder, body: (f: ClaimFixture) => Promise<void>, settings: Record<string, unknown> = {}, options: { summaryModel?: boolean } = {}): Promise<void> {
	const provider = `claim-refusal-${++loadCounter}`;
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-claim-refusal-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ compactionClaim: { enabled: responder.kind !== "off" }, contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(options.summaryModel ? { compactionModel: `${provider}/summary` } : {}), ...settings }));
	const compatUrl = new URL("./compat.js", import.meta.resolve("@earendil-works/pi-ai"));
	const compat = await import(compatUrl.href) as Compat;
	const faux = compat.registerFauxProvider({
		provider,
		models: [{ id: "summary", contextWindow: 200_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	}) as unknown as { getModel(): unknown; setResponses(responses: unknown[]): void; unregister(): void };
	faux.setResponses([() => compat.fauxAssistantMessage(SUMMARY)]);
	const host = createHostPi();
	const claims: unknown[] = [];
	const fabric = responder.kind === "rival" || responder.kind === "grant" ? new FakeFabric(host.bus) : undefined;
	if (responder.kind === "rival") {
		// Another extension holds the claim already: Fabric refuses this package's claim and names that holder.
		host.bus.emit(OWNER_EVENT, { version: 1, type: "claim", owner: { name: "other-owner", version: "1.0.0" }, actions: {}, reply: () => {} });
		await fabric!.flush();
	} else if (responder.kind === "refuse") {
		host.bus.on(OWNER_EVENT, (message) => {
			claims.push(message);
			queueMicrotask(() => (message as { reply: (result: unknown) => void }).reply(responder.reply));
		});
	}
	const manager = SessionManager.inMemory(root);
	// Long exchanges: the fold engine's minimum fold size is 5,000 characters.
	for (const name of ["ALPHA", "BETA", "GAMMA", "DELTA"]) {
		manager.appendMessage({ role: "user", content: name + "-QUESTION " + "archived detail ".repeat(400), timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage(name + "-ANSWER " + "archived reply ".repeat(400)));
	}
	const session = createSession(root, "claim-refusal-session", { model: faux.getModel() });
	const modelRegistry = { ...session.ctx.modelRegistry, find: (name: string, id: string) => (name === provider && id === "summary" ? faux.getModel() : undefined) };
	const ctx = { ...session.ctx, sessionManager: manager, modelRegistry } as unknown as ExtensionContext;
	try {
		const extension = await import(`../src/index.js?claim-refusal=${Date.now()}-${loadCounter}`);
		extension.default(host.api);
		await host.handler("session_start")({ reason: "startup" }, ctx);
		const keptId = manager.getBranch()[6]!.id;
		await fabric?.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tool = (name: string) => host.tools.get(name) as { execute: (...args: unknown[]) => Promise<{ isError?: boolean; terminate?: boolean; content?: { type: string; text?: string }[] }> };
		await body({
			host,
			session,
			ctx,
			claims,
			keptId,
			manager,
			fold: async () => {
				const result = await tool("context_fold").execute("fold-1", { content: [{ startId: "m00002", endId: "m00003", summary: FOLD_SUMMARY }] }, new AbortController().signal, undefined, ctx);
				return { isError: result.isError, text: (result.content ?? []).map((part) => part.text ?? "").join("\n") };
			},
			compact: () => tool("context_compact").execute("compact-1", { seed_prompt: "Continue with the rollout checklist.", rewrite_seed: false }, new AbortController().signal, undefined, ctx).then((result) => result, (error: Error) => error),
			beforeCompact: async (reason = "manual") => {
				const ids = manager.getBranch().map((entry) => entry.id);
				const event = compactionEvent({ reason, willRetry: reason === "overflow" });
				return await host.handler("session_before_compact")({ ...event, customInstructions: session.compactions[0]?.customInstructions, branchEntries: manager.getBranch(), preparation: { ...event.preparation, firstKeptEntryId: ids[6] } }, ctx) as { compaction?: { summary: string; firstKeptEntryId?: string }; cancel?: boolean } | undefined;
			},
		});
	} finally {
		await host.handler("session_shutdown")({}, ctx).catch(() => {});
		faux.unregister();
		compat.resetApiProviders();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
}

const LABEL = "pi-context-aware@0.8.0";
/** Each refusal Fabric sends that names no rival holder, as Fabric words it, plus two that a careless sender could make. */
const NON_RIVAL: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["aborted signal", { ok: false, error: `Fabric refused the compaction owner claim from ${LABEL}: its signal is already aborted` }],
	["Fabric shutting down", { ok: false, error: "Fabric refused the compaction owner message: Fabric is shutting down and holds no compaction owner claims" }],
	["owner support failed to load", { ok: false, error: "Fabric refused the compaction owner message: the compaction owner code failed to load" }],
	["unknown reason", { ok: false, error: "no" }],
	["a holder with no name", { ok: false, error: "refused", holder: { version: "1.0.0" } }],
	["a holder that is not an object", { ok: false, error: "refused", holder: "other-owner" }],
];

for (const [reason, reply] of NON_RIVAL) {
	test(`CR-CLAIM-REFUSAL-NOT-RIVAL: a refusal for ${reason} is no claim: context_fold folds, context_compact queues, and this package writes the summary`, async () => {
		await withClaimFixture({ kind: "refuse", reply }, async (f) => {
			assert.equal(f.claims.length, 1, "the claim was sent and refused");
			const fold = await f.fold();
			assert.notEqual(fold.isError, true, fold.text);
			assert.doesNotMatch(fold.text, /compaction claim/u);
			const compact = await f.compact();
			assert.ok(!(compact instanceof Error), compact instanceof Error ? compact.message : "");
			assert.equal(compact.terminate, true, "the compaction is queued");
			await f.host.handler("agent_settled")({}, f.ctx);
			assert.equal(f.session.compactions.length, 1, "the compaction starts once the agent settles");
			const outcome = await f.beforeCompact();
			assert.equal(outcome?.compaction?.summary, SUMMARY, "this package's summarizer writes the summary");
		});
	});
}

test("CR-CLAIM-REFUSAL-NOT-RIVAL, CR-ONE-WRITER-DECISION: a refusal that names the rival holder leaves compaction to that holder; context_fold still folds, as on main", async () => {
	await withClaimFixture({ kind: "rival" }, async (f) => {
		const fold = await f.fold();
		assert.notEqual(fold.isError, true, fold.text);
		assert.doesNotMatch(fold.text, /compaction claim/u);
		const compact = await f.compact();
		assert.ok(compact instanceof Error, "context_compact is refused");
		// CR-REFUSAL-TEXT: one bounded line that says what to do instead.
		assert.equal(compact.message, "Refused: another extension holds the compaction claim, so it alone compacts this session. Do not call context_compact again; continue the task, and that extension compacts when the context fills.");
		assert.equal(await f.beforeCompact(), undefined, "no result: the holder writes the summary");
	});
});
// CR-COMPACTION-UNDIFFERENCED (caair/pi/pi-context-aware!418): the compaction hook for each recipe and each claim
// state, with literal expectations. Before the strategy contract, the hook wrote this package's summary in every
// case: a model's context_compact is queued, the agent settles, and the summary comes from the summary model with
// the kept entry Pi chose. Under the contract the same holds, except while a rival owns the claim, when the hook
// leaves the summary to that owner (the one-writer rule the operator kept for compaction).
const RECIPES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["fold, compact (auto)", {}],
	["compact by strategy.methods", { strategy: { methods: ["compact"] } }],
	["compaction-only by folds.engine", { folds: { engine: "compaction-only" } }],
];
const OWNERS: ReadonlyArray<readonly [string, Responder]> = [
	["no claim (the setting off)", { kind: "off" }],
	["this package holds the claim", { kind: "grant" }],
	["a refused claim that names no rival", { kind: "refuse", reply: { ok: false, error: "Fabric refused the compaction owner message: Fabric is shutting down and holds no compaction owner claims" } }],
];

for (const [recipe, settings] of RECIPES) {
	for (const [owner, responder] of OWNERS) {
		test(`CR-COMPACTION-UNDIFFERENCED: ${recipe}, ${owner}: context_compact queues and session_before_compact writes this package's summary, as before the contract`, async () => {
			await withClaimFixture(responder, async (f) => {
				const compact = await f.compact();
				assert.ok(!(compact instanceof Error), compact instanceof Error ? compact.message : "");
				assert.equal(compact.terminate, true);
				await f.host.handler("agent_settled")({}, f.ctx);
				assert.equal(f.session.compactions.length, 1);
				const outcome = await f.beforeCompact();
				assert.equal(outcome?.compaction?.summary, SUMMARY);
				assert.equal(outcome?.compaction?.firstKeptEntryId, f.keptId, "the kept entry Pi chose");
			}, settings);
		});
	}
	// With a summary model set, this package writes the summary of every compaction, a threshold one included.
	test(`CR-COMPACTION-UNDIFFERENCED: ${recipe}, a compaction Pi starts: this package writes the summary unless a rival owns the claim`, async () => {
		for (const [owner, responder] of OWNERS) {
			await withClaimFixture(responder, async (f) => {
				const outcome = await f.beforeCompact();
				assert.equal(outcome?.compaction?.summary, SUMMARY, owner);
			}, settings, { summaryModel: true });
		}
		await withClaimFixture({ kind: "rival" }, async (f) => {
			assert.equal(await f.beforeCompact(), undefined, "the rival writes the summary");
		}, settings, { summaryModel: true });
	});
}
/** The text this package injects into a request: the user messages the context handlers appended to Pi's messages. */
async function injectedInto(f: ClaimFixture): Promise<string> {
	const messages = f.manager.buildSessionContext().messages.filter((message) => message.role !== "system");
	const result = await f.host.handler("context")({ type: "context", messages }, f.ctx) as { messages?: typeof messages } | undefined;
	const sent = result?.messages ?? messages;
	return sent.slice(messages.length).map((message) => JSON.stringify((message as { content?: unknown }).content ?? "")).join("\n");
}

test("CR-ONE-WRITER-DECISION: while a rival owns the compaction claim, the request offers context_fold and never context_compact; with no claim it offers both", async () => {
	for (const [responder, compactOffered] of [[{ kind: "rival" }, false], [{ kind: "off" }, true]] as const) {
		await withClaimFixture(responder, async (f) => {
			f.host.api.setActiveTools([...f.host.api.getActiveTools(), "context_fold", "context_compact", "context_recall", "context_status"]);
			const injected = await injectedInto(f);
			assert.match(injected, /Context pressure WARN \(75% used/u, `${responder.kind}: the pressure note is sent`);
			assert.match(injected, /`context_fold`/u, `${responder.kind}: it offers context_fold`);
			if (compactOffered) assert.match(injected, /`context_compact`/u, "with no claim it offers context_compact");
			else assert.doesNotMatch(injected, /context_compact/u, "the rival compacts, so context_compact is not offered");
		});
	}
});

// CR-FOLD-ONLY-COMPACTION-UNTESTED (pi-context-aware#526): a session whose strategy.methods leave out compact
// refuses the model's context_compact with one bounded line, and a compaction Pi starts at the threshold or on
// overflow still runs, with Pi's own summary: this package neither writes a seeded summary nor cancels it.
const FOLD_ONLY = { strategy: { methods: ["fold"] } };
const NO_COMPACT_REFUSAL = "Refused: this session's context methods do not include compact. Do not call context_compact again; continue the task.";

for (const [owner, responder] of OWNERS) {
	test(`CR-FOLD-ONLY-COMPACTION-UNTESTED: strategy.methods ["fold"], ${owner}: context_compact is refused with one bounded line and nothing is queued`, async () => {
		await withClaimFixture(responder, async (f) => {
			const compact = await f.compact();
			assert.ok(compact instanceof Error, "context_compact is refused");
			assert.equal(compact.message, NO_COMPACT_REFUSAL);
			assert.doesNotMatch(compact.message, /[\r\n]/u, "one line");
			assert.ok(compact.message.length <= 200, `bounded: ${compact.message.length} characters`);
			await f.host.handler("agent_settled")({}, f.ctx);
			assert.equal(f.session.compactions.length, 0, "no compaction is queued");
		}, FOLD_ONLY);
	});
}

test("CR-FOLD-ONLY-COMPACTION-UNTESTED: strategy.methods [\"fold\"]: a threshold or overflow compaction goes ahead with Pi's own summary", async () => {
	for (const reason of ["threshold", "overflow"] as const) {
		await withClaimFixture({ kind: "off" }, async (f) => {
			assert.equal((await f.beforeCompact(reason))?.compaction?.summary, SUMMARY, `${reason}: with both methods this package writes the summary`);
		}, {}, { summaryModel: true });
		for (const [owner, responder] of OWNERS) {
			await withClaimFixture(responder, async (f) => {
				const outcome = await f.beforeCompact(reason);
				assert.equal(outcome, undefined, `${reason}, ${owner}: no seeded summary and no cancel, so Pi summarizes`);
			}, FOLD_ONLY, { summaryModel: true });
		}
	}
});
