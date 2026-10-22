/**
 * #43: preflightCompaction() answers "Pi would refuse this compaction" before
 * anything is queued. These tests hold that answer to Pi's own decision: a
 * differential against Pi's private prepareCompaction() on generated sessions
 * (and, opt-in, on a directory of real sessions), checks for the tool-call
 * tail estimate and fail-closed guards, and drift pins that fail when Pi's code
 * changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
	estimateTokens,
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
	VERSION,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

import {
	predictCompaction,
	preflightCompaction,
	TOOL_CALL_TAIL_MARGIN_TOKENS,
	VERIFIED_PI_VERSIONS,
	type CompactionPrediction,
	type CompactionPreflightBoundary,
	type CompactionPreflightInput,
	type CompactionPreflightResult,
} from "../src/compaction/compaction-preflight.js";
import { ALREADY_COMPACTED_TOOL_MESSAGE, NOTHING_TO_COMPACT_TOOL_MESSAGE } from "../src/compaction/compaction-outcome.js";

const PI_DIST = path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist");
const PI_COMPACTION_JS = path.join(PI_DIST, "core/compaction/compaction.js");
const PI_AGENT_SESSION_JS = path.join(PI_DIST, "core/agent-session.js");

// Pi does not export prepareCompaction(); the oracle is the private module itself.
const piCompaction = await import(pathToFileURL(PI_COMPACTION_JS).href) as {
	prepareCompaction(
		entries: SessionEntry[],
		settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
	): { firstKeptEntryId: string; isSplitTurn: boolean } | undefined;
};

/** What Pi's AgentSession.compact() decides for `branch`; its refusal order is pinned below. */
function piDecision(branch: readonly SessionEntry[], keepRecentTokens: number): CompactionPrediction {
	const preparation = piCompaction.prepareCompaction([...branch], { enabled: true, reserveTokens: 16_384, keepRecentTokens });
	if (preparation) {
		return { kind: "compactable", firstKeptEntryId: preparation.firstKeptEntryId, isSplitTurn: preparation.isSplitTurn };
	}
	return branch.at(-1)?.type === "compaction" ? { kind: "already-compacted" } : { kind: "nothing-to-compact" };
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Drift pins
// ---------------------------------------------------------------------------

// Add a release to both after verifying the port against it. The file hash is
// per release: 1.4.0 changed summary generation in compaction.js, not the code
// the port copies.
const PRE_1_4_COMPACTION_SHA256 = "573f0321e9a93a4e8dca8c327f6459082ac438d1bc8b6c3c171d90894dd1543c";
const PORTED_COMPACTION_SHA256: Readonly<Record<string, string>> = {
	"1.0.3": PRE_1_4_COMPACTION_SHA256,
	"1.0.4": PRE_1_4_COMPACTION_SHA256,
	"1.1.0": PRE_1_4_COMPACTION_SHA256,
	"1.2.0": PRE_1_4_COMPACTION_SHA256,
	"1.3.0": PRE_1_4_COMPACTION_SHA256,
	"1.4.0": "f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6",
};
const COMPACT_REFUSAL_SHA256 = "45cf1517a80f20070a3093814328135d3f25c82d7dda46e82b53f45718f09016";
const REVERIFY = "Diff it against the copy in src/compaction/compaction-preflight.ts, update the port, then update this pin and VERIFIED_PI_VERSIONS.";

test("drift: the installed Pi is a release the port was verified against", () => {
	assert.ok(VERIFIED_PI_VERSIONS.has(VERSION), `Pi ${VERSION} is not in VERIFIED_PI_VERSIONS, so the preflight never refuses on it. ${REVERIFY}`);
});

test("drift: every verified release has a pinned compaction module, and only those", () => {
	assert.deepEqual(Object.keys(PORTED_COMPACTION_SHA256).sort(), [...VERIFIED_PI_VERSIONS].sort());
});

test("drift: Pi's private compaction module is the code the port copies", () => {
	assert.equal(sha256(fs.readFileSync(PI_COMPACTION_JS)), PORTED_COMPACTION_SHA256[VERSION], `dist/core/compaction/compaction.js changed. ${REVERIFY}`);
});

test("drift: AgentSession.compact() reads settings and refuses in the order the port assumes", () => {
	const source = fs.readFileSync(PI_AGENT_SESSION_JS, "utf8");
	const start = source.indexOf("    async compact(customInstructions) {");
	const end = source.indexOf("let extensionCompaction;", start);
	assert.ok(start >= 0 && end > start, `AgentSession.compact() no longer has the expected shape. ${REVERIFY}`);
	assert.equal(sha256(source.slice(start, end)), COMPACT_REFUSAL_SHA256, `AgentSession.compact() changed before its session_before_compact hook. ${REVERIFY}`);
});

// ---------------------------------------------------------------------------
// Session generator
// ---------------------------------------------------------------------------

interface Rng {
	int(bound: number): number;
	chance(probability: number): boolean;
	pick<T>(items: readonly T[]): T;
}

/** mulberry32: a fixed seed reproduces a failing session exactly. */
function createRng(seed: number): Rng {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	return {
		int: (bound) => Math.floor(next() * bound),
		chance: (probability) => next() < probability,
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
	};
}

const TEXT_SIZES = [0, 1, 7, 40, 400, 4_000, 20_000] as const;
const IMAGE = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const STATE_ENTRY_TYPES: ReadonlySet<string> = new Set(["thinking_level_change", "model_change", "custom", "label", "session_info", "usage"]);

function sizedText(rng: Rng, label: string): string {
	const size = rng.pick(TEXT_SIZES);
	return `${label} `.repeat(Math.ceil(size / (label.length + 1))).slice(0, size);
}

function editableEntries(branch: readonly SessionEntry[]): SessionEntry[] {
	return branch.filter((entry) =>
		entry.type === "custom_message" ||
		(entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")));
}

/** Pi rejects some generated shapes (a context edit of a missing target, say); the corpus skips them. */
function attempt(operation: () => unknown): void {
	try {
		operation();
	} catch {
		// Not a session Pi can produce.
	}
}

/** Append one random entry, or move the leaf, the way Pi sessions grow. */
function grow(session: SessionManager, rng: Rng, step: number): void {
	const label = `e${step}`;
	const branch = session.getBranch();
	const roll = rng.int(30);
	if (roll < 6) {
		const text = sizedText(rng, label);
		session.appendMessage({ role: "user", content: rng.chance(0.1) ? [{ type: "text", text }, IMAGE] : text, timestamp: step });
	} else if (roll < 11) {
		session.appendMessage(fauxAssistantMessage(rng.chance(0.2)
			? [fauxThinking(sizedText(rng, label)), fauxText(sizedText(rng, label))]
			: sizedText(rng, label)));
	} else if (roll < 17) {
		const id = `call-${label}`;
		session.appendMessage(fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id })], { stopReason: "toolUse" }));
		// One in six calls never gets a result, as after a crash.
		if (roll !== 16) {
			session.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: sizedText(rng, label) }],
				isError: false,
				timestamp: step,
			});
		}
	} else if (roll < 19) {
		// A failed recovery attempt that is then omitted from context.
		attempt(() => {
			const id = session.appendMessage(fauxAssistantMessage(sizedText(rng, label), { stopReason: "error", errorMessage: "overloaded" }));
			session.appendContextEdit(id, null);
		});
	} else if (roll < 21) {
		session.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: sizedText(rng, label),
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: step,
			excludeFromContext: rng.chance(0.3),
		});
	} else if (roll < 23) {
		session.appendCustomMessageEntry("note", sizedText(rng, label), rng.chance(0.5));
	} else if (roll < 25) {
		const kind = rng.int(5);
		if (kind === 0) session.appendCustomEntry("state", { step });
		else if (kind === 1) session.appendThinkingLevelChange("high");
		else if (kind === 2) session.appendModelChange("test", "model");
		else if (kind === 3 && branch.length > 0) attempt(() => session.appendLabelChange(rng.pick(branch).id, label));
		else session.appendSessionInfo(label);
	} else if (roll < 27) {
		const targets = editableEntries(branch);
		if (targets.length === 0) return;
		const target = rng.pick(targets);
		attempt(() => session.appendContextEdit(target.id, rng.chance(0.5) ? null : { content: [{ type: "text", text: sizedText(rng, label) }] }));
	} else if (roll < 28) {
		attempt(() => session.appendCompaction(`summary ${label}`, branch.length === 0 || rng.chance(0.2) ? null : rng.pick(branch).id, 1_000));
	} else if (roll < 29) {
		attempt(() => session.branchWithSummary(branch.length === 0 || rng.chance(0.2) ? null : rng.pick(branch).id, `branch summary ${label}`));
	} else if (branch.length > 1) {
		attempt(() => session.branch(rng.pick(branch).id));
	}
}

/** Which of the issue's named cases a comparison exercised. */
function caseTags(branch: readonly SessionEntry[], decision: CompactionPrediction): string[] {
	const tags: string[] = [decision.kind];
	if (branch.slice(0, -1).some((entry) => entry.type === "compaction")) tags.push("after-compaction");
	if (decision.kind !== "compactable") return tags;
	if (decision.isSplitTurn) tags.push("split-turn");
	const kept = branch.find((entry) => entry.id === decision.firstKeptEntryId);
	if (kept && STATE_ENTRY_TYPES.has(kept.type)) tags.push("cut-moved-back-over-state");
	if (
		kept?.type === "message" &&
		kept.message.role === "assistant" &&
		branch.some((entry) => entry.type === "context_edit" && entry.targetId === kept.id && entry.replacement === null)
	) {
		tags.push("cut-past-omitted-recovery");
	}
	return tags;
}

function count(tally: Map<string, number>, tags: readonly string[]): void {
	for (const tag of tags) tally.set(tag, (tally.get(tag) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Differential: the port against Pi
// ---------------------------------------------------------------------------

const KEEP_RECENT_VALUES = [0, 1, 20, 200, 2_000, 20_000] as const;
const SEED = 43;

test("predictCompaction() returns Pi's decision, cut point and split flag on every generated branch", () => {
	const tally = new Map<string, number>();
	const mismatches: unknown[] = [];
	let comparisons = 0;
	const compare = (branch: readonly SessionEntry[], keepRecentTokens: number, where: string): void => {
		const expected = piDecision(branch, keepRecentTokens);
		const actual = predictCompaction(branch, keepRecentTokens);
		comparisons++;
		count(tally, caseTags(branch, expected));
		if (!isDeepStrictEqual(actual, expected) && mismatches.length < 3) {
			mismatches.push({ where, keepRecentTokens, expected, actual, branch: JSON.stringify(branch).slice(0, 4_000) });
		}
	};
	for (const keep of KEEP_RECENT_VALUES) compare([], keep, "empty branch");
	for (let sessionIndex = 0; sessionIndex < 300; sessionIndex++) {
		const rng = createRng(SEED * 1_000 + sessionIndex);
		const session = SessionManager.inMemory("/preflight-corpus");
		for (let step = 0; step < 40; step++) {
			grow(session, rng, step);
			const branch = session.getBranch();
			compare(branch, rng.pick(KEEP_RECENT_VALUES), `seed ${SEED} session ${sessionIndex} step ${step}`);
			compare(branch, rng.pick(KEEP_RECENT_VALUES), `seed ${SEED} session ${sessionIndex} step ${step}`);
		}
	}
	assert.deepEqual(mismatches, [], `the port disagreed with Pi on ${mismatches.length} of ${comparisons} branches`);
	// The corpus must reach each case the issue names, or agreement proves nothing about it.
	for (const tag of [
		"nothing-to-compact",
		"already-compacted",
		"compactable",
		"split-turn",
		"after-compaction",
		"cut-moved-back-over-state",
		"cut-past-omitted-recovery",
	]) {
		assert.ok((tally.get(tag) ?? 0) >= 20, `the generated corpus reached "${tag}" only ${tally.get(tag) ?? 0} times: ${JSON.stringify([...tally])}`);
	}
});

// Opt-in: CONTEXT_AWARE_PREFLIGHT_CORPUS=~/.pi/agent/sessions npm run test:compile && node --test .test-dist/tests/compaction-preflight.test.js
const corpusDirectory = process.env.CONTEXT_AWARE_PREFLIGHT_CORPUS;

function sessionFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

function branchTo(leaf: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	for (let entry: SessionEntry | undefined = leaf; entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		seen.add(entry.id);
		branch.push(entry);
	}
	return branch.reverse();
}

test("predictCompaction() returns Pi's decision on a directory of real sessions", {
	skip: corpusDirectory ? false : "set CONTEXT_AWARE_PREFLIGHT_CORPUS to a Pi sessions directory",
}, (t) => {
	const maxBytes = Number(process.env.CONTEXT_AWARE_PREFLIGHT_CORPUS_MAX_BYTES ?? 20_000_000);
	const samplesPerSession = Number(process.env.CONTEXT_AWARE_PREFLIGHT_CORPUS_SAMPLES ?? 24);
	const tally = new Map<string, number>();
	const mismatches: unknown[] = [];
	let sessions = 0;
	let comparisons = 0;
	let skippedLarge = 0;
	let unreadable = 0;
	for (const file of sessionFiles(corpusDirectory!)) {
		if (fs.statSync(file).size > maxBytes) {
			skippedLarge++;
			continue;
		}
		let entries: SessionEntry[];
		try {
			const fileEntries = parseSessionEntries(fs.readFileSync(file, "utf8"));
			migrateSessionEntries(fileEntries);
			entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
		} catch {
			unreadable++;
			continue;
		}
		if (entries.length === 0) continue;
		sessions++;
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const leaves = new Set<SessionEntry>([entries.at(-1)!]);
		const stride = Math.max(1, Math.floor(entries.length / samplesPerSession));
		for (let index = 0; index < entries.length; index += stride) leaves.add(entries[index]!);
		entries.forEach((entry, index) => {
			if (entry.type !== "compaction") return;
			leaves.add(entry);
			const next = entries[index + 1];
			if (next) leaves.add(next);
		});
		for (const leaf of leaves) {
			const branch = branchTo(leaf, byId);
			for (const keepRecentTokens of [2_000, 20_000, 60_000]) {
				const expected = piDecision(branch, keepRecentTokens);
				const actual = predictCompaction(branch, keepRecentTokens);
				comparisons++;
				count(tally, caseTags(branch, expected));
				if (!isDeepStrictEqual(actual, expected) && mismatches.length < 5) {
					mismatches.push({ file, leaf: leaf.id, keepRecentTokens, expected, actual });
				}
			}
		}
	}
	t.diagnostic(JSON.stringify({ sessions, comparisons, skippedLarge, unreadable, cases: Object.fromEntries(tally) }));
	assert.deepEqual(mismatches, []);
	assert.ok(comparisons > 0, "the corpus directory held no readable sessions");
});

// ---------------------------------------------------------------------------
// preflightCompaction(): refusals and fail-closed guards
// ---------------------------------------------------------------------------

const MODEL = { provider: "test", id: "model", contextWindow: 200_000 };
const TIMESTAMP = new Date(0).toISOString();

type Settings = ReturnType<NonNullable<CompactionPreflightInput["getSettings"]>>;

function settingsReturning(settings: Record<string, unknown>): CompactionPreflightInput["getSettings"] {
	return () => settings as Settings;
}

function contextFor(branch: readonly SessionEntry[], overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		model: MODEL,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [...branch] },
		...overrides,
	} as unknown as ExtensionContext;
}

function preflight(
	ctx: ExtensionContext,
	boundary: CompactionPreflightBoundary,
	options: Partial<Omit<CompactionPreflightInput, "ctx" | "boundary">> = {},
): CompactionPreflightResult {
	return preflightCompaction({ getSettings: settingsReturning({}), pendingFolds: () => 0, ...options, ctx, boundary });
}

function messageEntry(id: string, parentId: string | null, message: Extract<SessionEntry, { type: "message" }>["message"]): SessionEntry {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message };
}

const USER = messageEntry("u1", null, { role: "user", content: "Start the migration.", timestamp: 1 });
const CALL_ID = "compact-call";
const CALL = messageEntry("a1", "u1", fauxAssistantMessage([fauxToolCall("compact_session", { seed_prompt: "next" }, { id: CALL_ID })], { stopReason: "toolUse" }));
const TOO_SMALL_AT_CALL = [USER, CALL];
const IDLE: CompactionPreflightBoundary = { kind: "idle" };
const AT_CALL: CompactionPreflightBoundary = { kind: "tool-call", toolCallId: CALL_ID, resultText: "Compaction queued." };

/** History Pi compacts under the default keepRecentTokens (20,000): three turns of about 10,000 tokens. */
const LARGE: SessionEntry[] = [0, 1, 2].flatMap((turn) => [
	messageEntry(`lu${turn}`, turn === 0 ? null : `la${turn - 1}`, { role: "user", content: "u".repeat(20_000), timestamp: turn }),
	messageEntry(`la${turn}`, `lu${turn}`, fauxAssistantMessage("a".repeat(20_000))),
]);

const NOTHING: CompactionPreflightResult = {
	kind: "nothing-to-compact",
	refusal: "nothing-to-compact",
	toolMessage: NOTHING_TO_COMPACT_TOOL_MESSAGE,
	serviceStatus: "nothing-to-compact",
};

test("an idle session too small to compact is refused with Pi's message", () => {
	assert.deepEqual(preflight(contextFor([USER]), IDLE), NOTHING);
	assert.deepEqual(preflight(contextFor([]), IDLE), NOTHING);
});

test("an idle session whose newest entry is a compaction is refused as already compacted", () => {
	const compaction: SessionEntry = { type: "compaction", id: "c1", parentId: "la2", timestamp: TIMESTAMP, summary: "Summary", firstKeptEntryId: "la2", tokensBefore: 30_000 };
	assert.deepEqual(preflight(contextFor([...LARGE, compaction]), IDLE), {
		kind: "nothing-to-compact",
		refusal: "already-compacted",
		toolMessage: ALREADY_COMPACTED_TOOL_MESSAGE,
		serviceStatus: "nothing-to-compact",
	});
});

test("a session Pi would compact proceeds", () => {
	assert.deepEqual(preflight(contextFor(LARGE), IDLE), { kind: "proceed", reason: "compactable" });
	assert.deepEqual(preflight(contextFor([...LARGE, { ...CALL, parentId: "la2" }]), AT_CALL), { kind: "proceed", reason: "compactable" });
});

test("keepRecentTokens resolves through Pi's settings, including a per-model override", () => {
	const override = (keepRecentTokens: number) => ({ [`${MODEL.provider}/${MODEL.id}`]: { keepRecentTokens } });
	// LARGE is compactable under the default and refused once the whole session fits the kept tail.
	assert.equal(preflight(contextFor(LARGE), IDLE, { getSettings: settingsReturning({ compaction: { keepRecentTokens: 1_000_000 } }) }).kind, "nothing-to-compact");
	assert.equal(preflight(contextFor(LARGE), IDLE, {
		getSettings: settingsReturning({ compaction: { keepRecentTokens: 1_000_000, modelOverrides: override(20_000) } }),
	}).kind, "proceed");
	assert.equal(preflight(contextFor(LARGE), IDLE, {
		getSettings: settingsReturning({ compaction: { keepRecentTokens: 20_000, modelOverrides: override(1_000_000) } }),
	}).kind, "nothing-to-compact");
});

test("a session too small at compact_session is refused, counting the call's result and the margin", () => {
	assert.deepEqual(preflight(contextFor(TOO_SMALL_AT_CALL, { isIdle: () => false }), AT_CALL), NOTHING);
	// State entries Pi or extensions write after the call add no context.
	const usage: SessionEntry = { type: "custom", id: "s1", parentId: "a1", timestamp: TIMESTAMP, customType: "state", data: {} };
	assert.deepEqual(preflight(contextFor([...TOO_SMALL_AT_CALL, usage]), AT_CALL), NOTHING);
});

function throwingBranch(): SessionEntry[] {
	return new Proxy([USER], {
		get(target, property, receiver) {
			if (property === "length") return 1;
			if (typeof property === "string" && /^\d+$/u.test(property)) throw new Error("corrupt entry");
			return Reflect.get(target, property, receiver) as unknown;
		},
	});
}

// Each case would be refused without its guard: the sessions are too small.
const PROCEED_CASES: Array<{ reason: string; result: () => CompactionPreflightResult }> = [
	{ reason: "unverified-pi", result: () => preflight(contextFor([USER]), IDLE, { piVersion: "0.99.0" }) },
	{ reason: "no-model", result: () => preflight(contextFor([USER], { model: undefined }), IDLE) },
	{ reason: "settings-unavailable", result: () => preflight(contextFor([USER]), IDLE, { getSettings: undefined }) },
	{ reason: "settings-unavailable", result: () => preflight(contextFor([USER]), IDLE, { getSettings: () => { throw new Error("not initialized"); } }) },
	{ reason: "settings-unavailable", result: () => preflight(contextFor([USER]), IDLE, { getSettings: settingsReturning({ compaction: { keepRecentTokens: -1 } }) }) },
	{ reason: "pending-input", result: () => preflight(contextFor([USER], { hasPendingMessages: () => true }), IDLE) },
	{ reason: "pending-input", result: () => preflight(contextFor([USER], { hasPendingMessages: undefined }), IDLE) },
	{ reason: "pending-input", result: () => preflight(contextFor(TOO_SMALL_AT_CALL, { hasPendingMessages: () => { throw new Error("stale"); } }), AT_CALL) },
	{ reason: "not-idle", result: () => preflight(contextFor([USER], { isIdle: () => false }), IDLE) },
	{ reason: "not-idle", result: () => preflight(contextFor([USER], { isIdle: undefined }), IDLE) },
	{ reason: "pending-folds", result: () => preflight(contextFor(TOO_SMALL_AT_CALL), AT_CALL, { pendingFolds: () => 1 }) },
	{ reason: "pending-folds", result: () => preflight(contextFor(TOO_SMALL_AT_CALL), AT_CALL, { pendingFolds: () => { throw new Error("disposed"); } }) },
	{ reason: "branch-unavailable", result: () => preflight(contextFor([USER], { sessionManager: { getBranch: () => { throw new Error("disposed"); } } }), IDLE) },
	{ reason: "branch-unavailable", result: () => preflight(contextFor([USER], { sessionManager: { getBranch: () => undefined } }), IDLE) },
	{ reason: "tool-call-not-last", result: () => preflight(contextFor([USER]), AT_CALL) },
	{ reason: "tool-call-not-last", result: () => preflight(contextFor(TOO_SMALL_AT_CALL), { ...AT_CALL, toolCallId: "another-call" }) },
	{
		reason: "tool-call-not-last",
		result: () => preflight(contextFor([USER, messageEntry("a1", "u1", fauxAssistantMessage([
			fauxToolCall("compact_session", { seed_prompt: "next" }, { id: CALL_ID }),
			fauxToolCall("read", { path: "x" }, { id: "read-call" }),
		], { stopReason: "toolUse" }))]), AT_CALL),
	},
	{
		// A context edit after the call is not a state entry: it can change what Pi keeps.
		reason: "tool-call-not-last",
		result: () => preflight(contextFor([...TOO_SMALL_AT_CALL, { type: "context_edit", id: "x1", parentId: "a1", timestamp: TIMESTAMP, targetId: "u1", replacement: null }]), AT_CALL),
	},
	{
		reason: "tail-reaches-keep-recent",
		result: () => preflight(contextFor(TOO_SMALL_AT_CALL), AT_CALL, { getSettings: settingsReturning({ compaction: { keepRecentTokens: TOOL_CALL_TAIL_MARGIN_TOKENS } }) }),
	},
	{ reason: "prediction-failed", result: () => preflight(contextFor([], { sessionManager: { getBranch: throwingBranch } }), IDLE) },
];

for (const [index, { reason, result }] of PROCEED_CASES.entries()) {
	test(`any doubt proceeds and leaves the decision to Pi: ${reason} (${index + 1})`, () => {
		assert.deepEqual(result(), { kind: "proceed", reason });
	});
}

// ---------------------------------------------------------------------------
// compact_session tail margin
// ---------------------------------------------------------------------------

function toolResultEntry(id: string, parentId: string, text: string): SessionEntry {
	return messageEntry(id, parentId, { role: "toolResult", toolCallId: CALL_ID, toolName: "compact_session", content: [{ type: "text", text }], isError: false, timestamp: 0 });
}

function customMessageEntry(id: string, parentId: string, content: string): SessionEntry {
	return { type: "custom_message", id, parentId, timestamp: TIMESTAMP, customType: "turn-note", content, display: true };
}

function entryTokens(entry: SessionEntry): number {
	if (entry.type === "message") return estimateTokens(entry.message);
	if (entry.type === "custom_message") return Math.ceil((typeof entry.content === "string" ? entry.content.length : 0) / 4);
	return 0;
}

/**
 * Generated tails within the estimate used by this snapshot test: the result
 * itself, possibly lengthened by a tool_result handler, then extension messages
 * and state entries. Real tails may exceed this estimate after the check.
 */
function tailWithin(rng: Rng, leafId: string, resultText: string, budget: number): SessionEntry[] {
	const tail: SessionEntry[] = [toolResultEntry(`${leafId}-result`, leafId, resultText + "y".repeat(rng.int(TOOL_CALL_TAIL_MARGIN_TOKENS * 4)))];
	let remaining = budget - entryTokens(tail[0]!);
	const extras = rng.int(4);
	for (let index = 0; index < extras; index++) {
		const parentId = tail.at(-1)!.id;
		if (rng.chance(0.3)) {
			tail.push({ type: "custom", id: `${leafId}-state-${index}`, parentId, timestamp: TIMESTAMP, customType: "state", data: {} });
			continue;
		}
		const size = rng.int(Math.max(0, remaining) * 4 + 1);
		const message = customMessageEntry(`${leafId}-note-${index}`, parentId, "n".repeat(size));
		remaining -= entryTokens(message);
		tail.push(message);
	}
	return tail;
}

test("compact_session tail estimate models generated tails within its token budget", () => {
	const rng = createRng(SEED);
	const failures: unknown[] = [];
	let refusals = 0;
	let tailsWithTurnStarts = 0;
	for (let trial = 0; trial < 400; trial++) {
		const session = SessionManager.inMemory("/preflight-margin");
		const steps = rng.int(14);
		for (let step = 0; step < steps; step++) grow(session, rng, step);
		session.appendMessage(fauxAssistantMessage([fauxToolCall("compact_session", { seed_prompt: "next" }, { id: CALL_ID })], { stopReason: "toolUse" }));
		if (rng.chance(0.3)) session.appendCustomEntry("state", { trial });
		const branch = session.getBranch();
		const keepRecentTokens = rng.pick([2_100, 2_600, 4_000, 8_000, 20_000, 60_000]);
		const resultText = `Compaction queued. ${"q".repeat(rng.int(4_000))}`;
		const result = preflight(contextFor(branch, { isIdle: () => false }), { kind: "tool-call", toolCallId: CALL_ID, resultText }, {
			getSettings: settingsReturning({ compaction: { keepRecentTokens } }),
		});
		if (result.kind === "proceed") continue;
		refusals++;
		const budget = estimateTokens({
			role: "toolResult",
			toolCallId: CALL_ID,
			toolName: "compact_session",
			content: [{ type: "text", text: resultText }, { type: "text", text: " ".repeat(TOOL_CALL_TAIL_MARGIN_TOKENS * 4) }],
			isError: false,
			timestamp: 0,
		});
		for (let variant = 0; variant < 6; variant++) {
			const tail = tailWithin(rng, branch.at(-1)!.id, resultText, budget);
			const tailTokens = tail.reduce((sum, entry) => sum + entryTokens(entry), 0);
			if (tailTokens > budget) continue;
			if (tail.some((entry) => entry.type === "custom_message")) tailsWithTurnStarts++;
			const decision = piDecision([...branch, ...tail], keepRecentTokens);
			if (decision.kind === "compactable" && failures.length < 3) failures.push({ trial, variant, keepRecentTokens, tailTokens, budget, decision });
		}
	}
	assert.deepEqual(failures, [], "Pi compacted a session the preflight refused");
	assert.ok(refusals >= 50, `only ${refusals} trials were refused, too few to test the margin`);
	assert.ok(tailsWithTurnStarts >= 50, `only ${tailsWithTurnStarts} tails held extension messages`);
});

test("compact_session margin is load-bearing: without it a small extension message would flip Pi's decision", () => {
	// A 3,000-token request, then the call: under a 1,500-token kept tail.
	const user = messageEntry("u1", null, { role: "user", content: "u".repeat(12_000), timestamp: 1 });
	const branch = [user, CALL];
	const keepRecentTokens = 1_500;
	const bareResult = toolResultEntry("r1", "a1", AT_CALL.resultText);
	// Counting only the bare result, Pi would refuse.
	assert.equal(predictCompaction([...branch, bareResult], keepRecentTokens).kind, "nothing-to-compact");
	// A 1,500-token turn_end message, well inside the margin, makes Pi compact.
	assert.equal(piDecision([...branch, bareResult, customMessageEntry("n1", "r1", "n".repeat(6_000))], keepRecentTokens).kind, "compactable");
	// The preflight therefore leaves this session to Pi.
	assert.deepEqual(
		preflight(contextFor(branch), AT_CALL, { getSettings: settingsReturning({ compaction: { keepRecentTokens } }) }),
		{ kind: "proceed", reason: "tail-reaches-keep-recent" },
	);
});

test("compact_session proceeds when the estimated result alone fills keepRecentTokens, where Pi can cut past the call", () => {
	// With no user turn before the call, Pi has nowhere to cut until the tail
	// alone reaches keepRecentTokens; then it cuts past the call and compacts.
	const call = messageEntry("a1", null, fauxAssistantMessage([fauxToolCall("compact_session", { seed_prompt: "next" }, { id: CALL_ID })], { stopReason: "toolUse" }));
	const padded = estimateTokens({
		role: "toolResult",
		toolCallId: CALL_ID,
		toolName: "compact_session",
		content: [{ type: "text", text: AT_CALL.resultText }, { type: "text", text: " ".repeat(TOOL_CALL_TAIL_MARGIN_TOKENS * 4) }],
		isError: false,
		timestamp: 0,
	});
	const bareResult = toolResultEntry("r1", "a1", AT_CALL.resultText);
	const note = customMessageEntry("n1", "r1", "n".repeat((padded - entryTokens(bareResult)) * 4));
	// A modeled tail with the same token estimate: Pi compacts.
	assert.equal(entryTokens(bareResult) + entryTokens(note), padded);
	assert.equal(piDecision([call, bareResult, note], padded).kind, "compactable");
	assert.deepEqual(
		preflight(contextFor([call]), AT_CALL, { getSettings: settingsReturning({ compaction: { keepRecentTokens: padded } }) }),
		{ kind: "proceed", reason: "tail-reaches-keep-recent" },
	);
	// One token more of keepRecentTokens, and the modeled result estimate no longer reaches it.
	assert.deepEqual(
		preflight(contextFor([call]), AT_CALL, { getSettings: settingsReturning({ compaction: { keepRecentTokens: padded + 1 } }) }),
		NOTHING,
	);
});
