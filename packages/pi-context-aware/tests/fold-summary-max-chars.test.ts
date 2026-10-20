import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts, registerFoldEngine, type FoldEngine, type FoldRequest } from "../src/folds/fold-engine.js";
import { foldRecordsOnBranch } from "../src/folds/fold-entries.js";
import { FOLD_REQUEST_RECOVERY_KIND, foldRequestDetails, parseFoldRequestRecovery } from "../src/folds/fold-recovery.js";
import type { Config } from "../src/folds/kernel/index.js";
import { compareCompressCall } from "../src/parity/compare.js";
import { classifyBcpResult } from "../src/parity/outcome.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";

// pi-context-aware#183: a numeric summaryMaxChars sets the summary limit in place of the
// engine's maxSummaryLength (20,000), as in billion-context-pi (bcp) 0.1.83. The summary below is
// 22,000 characters: over the default limit, under a raised one of 30,000.
const CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 50 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};
const LONG = `${"The synthetic archive review settled every numbered item in this range; retain the decisions. ".repeat(240).slice(0, 21_999)}.`;
const TOO_LONG = /: Summary too long \(22000 chars, max 20000\)/u;

function session(manager = SessionManager.inMemory("/tmp")): SessionManager {
	for (const [i, name] of ["ALPHA", "BETA", "GAMMA"].entries()) {
		manager.appendMessage({ role: "user", content: `${name}-QUESTION ${i}`, timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(`${name}-ANSWER ${i}`));
	}
	return manager;
}

function plan(extra: Partial<FoldRequest>) {
	return planFold({ branch: session().getBranch(), startRef: "m00001", endRef: "m00004", summary: LONG, modelContextLimit: 64_000, config: CONFIG, ...extra });
}

test("a fold request's summaryMaxChars sets the summary limit", () => {
	assert.equal(LONG.length, 22_000);
	const refused = plan({});
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.errors.join("\n"), TOO_LONG, "without a limit of its own the engine's 20,000 applies");

	const raised = plan({ summaryMaxChars: 30_000 });
	assert.ok(raised.ok, JSON.stringify(raised));
	assert.equal(raised.records.length, 1);

	const lowered = plan({ summaryMaxChars: 21_000 });
	assert.equal(lowered.ok, false);
	assert.match(lowered.ok ? "" : lowered.errors.join("\n"), /: Summary too long \(22000 chars, max 21000\)/u, "the request's limit is the one reported");
});

test("zero removes the summary limit, as in the engine and bcp", () => {
	// The engine checks the limit only when it is above zero (kernel compress.ts validateSummaryLength).
	assert.equal(plan({ summaryMaxChars: 0 }).ok, true);
	assert.equal(plan({ summaryMaxChars: -1 }).ok, true);
});

test("a summaryMaxChars that is not a finite number is ignored", () => {
	// A caller outside TypeScript can pass anything. Only a finite number counts, as in the kernel's
	// parseCompressArgs; NaN or Infinity would otherwise switch the engine's check off.
	for (const value of ["30000", NaN, Infinity, null, true]) {
		const result = plan({ summaryMaxChars: value as unknown as number });
		assert.equal(result.ok, false, `${String(value)} must not raise the limit`);
		assert.match(result.ok ? "" : result.errors.join("\n"), TOO_LONG);
	}
});

// ---- through the engine: live request, drain, restart --------------------------------------------

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function boot(): { engine: FoldEngine; ctx: (manager: SessionManager) => ExtensionContext; boundary: (manager: SessionManager) => SessionBoundaryDraft[]; start: (manager: SessionManager) => void } {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), getAllTools: () => [] } as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, { config: CONFIG });
	const ctx = (manager: SessionManager) => ({ cwd: manager.getCwd(), sessionManager: manager, model: undefined }) as unknown as ExtensionContext;
	const fire = (name: string, manager: SessionManager, event: Record<string, unknown>) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = handler({ type: name, ...event }, ctx(manager)) ?? result;
		return result as { entries: SessionBoundaryDraft[] } | undefined;
	};
	return {
		engine, ctx,
		boundary(manager) { const drafts = fire("turn_end", manager, { entries: [] })?.entries ?? []; applyFoldDrafts(manager, drafts); return drafts; },
		start(manager) { fire("session_start", manager, { reason: "resume" }); },
	};
}

function withSession(body: (manager: SessionManager, file: string, sessionDir: string) => void): void {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-max-chars-")));
	try {
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		body(manager, manager.getSessionFile()!, sessionDir);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("the engine plans, queues and writes a fold with the request's summary limit", () => {
	withSession((manager) => {
		session(manager);
		const harness = boot();
		const refused = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: LONG });
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.errors.join("\n"), TOO_LONG);

		const accepted = harness.engine.request(harness.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: LONG, summaryMaxChars: 30_000 });
		assert.ok(accepted.ok && accepted.queued, JSON.stringify(accepted));
		assert.ok(harness.boundary(manager).length > 0, "the queued fold is planned again at the boundary with the same limit");
		assert.deepEqual(harness.engine.dropped(harness.ctx(manager)), []);
		const records = foldRecordsOnBranch(manager.getBranch());
		assert.equal(records.length, 1);
	});
});

test("a saved request keeps its summary limit across a restart", () => {
	withSession((manager, file, sessionDir) => {
		session(manager);
		const first = boot();
		const accepted = first.engine.request(first.ctx(manager), { startRef: "m00001", endRef: "m00004", summary: LONG, summaryMaxChars: 30_000, requestId: "call_long#0" });
		assert.ok(accepted.ok && accepted.recovery, JSON.stringify(accepted));
		assert.equal(accepted.recovery.summaryMaxChars, 30_000, "the record keeps the limit the request was accepted with");
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("context_fold", {}, { id: "call_long" }), { stopReason: "toolUse" }));
		manager.appendMessage({ role: "toolResult", toolCallId: "call_long", toolName: "context_fold", content: [{ type: "text", text: "folded" }], details: foldRequestDetails([accepted.recovery]) as never, isError: false, timestamp: 1 });

		// Restart before the drain: the queue is read back from the saved record.
		const reopened = SessionManager.open(file, sessionDir);
		const second = boot();
		second.start(reopened);
		assert.equal(second.engine.pending(second.ctx(reopened)), 1);
		assert.ok(second.boundary(reopened).length > 0);
		assert.deepEqual(second.engine.dropped(second.ctx(reopened)), [], "the recovered request is planned with its own limit, not refused");
		assert.equal(foldRecordsOnBranch(reopened.getBranch()).length, 1);
	});
});

test("a saved record with a summary limit that is not a finite number is not read", () => {
	const record = {
		kind: FOLD_REQUEST_RECOVERY_KIND, requestId: "call_x#0", startRef: "m00001", endRef: "m00004", startEntryId: "e1", endEntryId: "e1",
		coveredEntryIds: ["e1"], sourceDigest: "a".repeat(64), summary: "A saved summary of the opening exchanges.",
	};
	assert.equal(parseFoldRequestRecovery({ ...record, summaryMaxChars: 30_000 })?.summaryMaxChars, 30_000);
	assert.equal(parseFoldRequestRecovery(record)?.summaryMaxChars, undefined);
	for (const value of ["30000", null, Infinity]) assert.equal(parseFoldRequestRecovery({ ...record, summaryMaxChars: value }), undefined, String(value));
});

// ---- the parity recorder's native request ----------------------------------------------------------

function recorded(input: unknown) {
	const manager = SessionManager.inMemory("/tmp");
	const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage({ role: "user", content: `${i}: ${"message history ".repeat(2500)}`, timestamp: 1 }));
	const byRef = Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id]));
	const side = (blocks: unknown[] = []) => parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks, messageRefs: { byRef } }));
	const block = { blockId: "b1", runId: "r1", compressCallId: "call", tier: 1, active: true, summary: LONG, directBlockIds: [], effectiveMessageIds: ids.slice(0, 4) };
	return compareCompressCall({
		folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 }, sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(),
		contextWindow: 1_000_000, toolCallId: "call", input, before: side(), after: side([block]),
		observed: classifyBcpResult("\u25A3 ACP | 40.0K \u2192 1.0K tokens (~39.0K reclaimed, blocks: b1=m00001\u2013m00004)", false),
	}).oursOutcome;
}

const range = (extra: Record<string, unknown> = {}) => ({ startId: "m00001", endId: "m00004", summary: LONG, ...extra });
const rejectedLong = { type: "rejected", reasons: ["summary-long"] };

test("the recorder's native request takes a recorded call's top-level summaryMaxChars", () => {
	assert.deepEqual(recorded({ content: [range()] }), rejectedLong);
	assert.deepEqual(recorded({ content: [range()], summaryMaxChars: 30_000 }), { type: "accepted", reasons: [] });
	assert.deepEqual(recorded({ content: [range(), range({ startId: "m00005", endId: "m00008" })], summaryMaxChars: 30_000 }), { type: "accepted", reasons: [] }, "the top-level value applies to every range");
});

test("the recorder ignores a per-range summaryMaxChars, as bcp's compress tool does", () => {
	// bcp 0.1.83's normalizeRanges keeps only startId, endId, summary and topic of each parsed range,
	// then gives every range the call's top-level summaryMaxChars. A per-range value never limits.
	assert.deepEqual(recorded({ content: [range({ summaryMaxChars: 30_000 })] }), rejectedLong);
	assert.deepEqual(recorded({ content: [range({ summaryMaxChars: 21_000 })], summaryMaxChars: 30_000 }), { type: "accepted", reasons: [] }, "the top-level value wins over a range's own");
	assert.deepEqual(recorded({ content: [range({ summaryMaxChars: "30000" })] }), rejectedLong);
});

test("the recorder ignores a top-level summaryMaxChars that is not a finite number", () => {
	// Pi converts a numeric string to a number before the call is recorded, and refuses NaN and
	// Infinity, so these reach the recorder only from a caller that skipped Pi's validation.
	for (const value of ["30000", NaN, Infinity, null]) assert.deepEqual(recorded({ content: [range()], summaryMaxChars: value }), rejectedLong, String(value));
});

