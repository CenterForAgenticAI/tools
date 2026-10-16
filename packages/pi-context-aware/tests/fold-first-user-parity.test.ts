import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { previewShadowCalls, hashRequestMessages } from "../src/parity/compare.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";
import { configuredFoldFingerprint } from "../src/parity/fingerprint.js";
import { buildFoldParityReport } from "../src/parity/report.js";
import { PARITY_RECORD_VERSION } from "../src/parity/records.js";

function fixture(first = "OPENING") {
	const manager = SessionManager.inMemory("/tmp");
	const ids = [manager.appendMessage({ role: "user", content: first, timestamp: 1 }), manager.appendMessage(fauxAssistantMessage("ANSWER")), manager.appendMessage(fauxAssistantMessage("TAIL"))];
	return { manager, ids };
}

test("shadow preview uses the effective opening policy and marks only an actually folded opening", () => {
	const { manager, ids } = fixture("opening history ".repeat(1500));
	for (let i = 0; i < 9; i++) manager.appendMessage({ role: "user", content: "tail history ".repeat(2500), timestamp: 1 });
	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: { m00001: ids[0], m00002: ids[1] } } }));
	for (const mode of ["keep", "fold", "keep-under-tokens"] as const) {
		const preview = previewShadowCalls({ sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000,
			folds: { firstUserMessage: mode, firstUserMessageMaxTokens: 8_000 } }, [{ toolCallId: "c", before, input: { content: [{ startId: "m00001", endId: "m00002", summary: "The opening exchange settled; retain the agreed decisions and values for the next phase." }] } }]);
		assert.equal(preview.dropped, 0);
		assert.equal(preview.records[0]?.carrierId, mode === "fold" ? ids[0] : ids[1]);
		assert.equal(hashRequestMessages(preview.preview!.buildSessionContext().messages).messages[0]?.summary, mode === "fold");
		assert.equal(preview.firstUserFolded?.role, mode === "fold" ? "user" : undefined);
	}
});

test("shadow preview keeps the opening even when an imported bcp block lists it as covered", () => {
	const { manager, ids } = fixture();
	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: "b1", runId: "r1", tier: 1, active: true,
		summary: "Opening exchange settled.", effectiveMessageIds: ids.slice(0, 2), directBlockIds: [] }], messageRefs: { byRef: {} } }));
	const preview = previewShadowCalls({ sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 64_000 },
		[{ toolCallId: "c", before, input: { content: [{ startId: "b1", endId: "b1", summary: "Opening exchange settled. Keep the agreed decisions for the next phase." }] } }]);
	assert.deepEqual(preview.diffs, []);
	const messages = preview.preview!.buildSessionContext().messages;
	assert.match(JSON.stringify(messages[0]), /OPENING/u);
	assert.match(JSON.stringify(messages[1]), /Opening exchange settled/u);
	assert.equal(preview.firstUserFolded, undefined);
});

test("shadow import keeps the latest summary when absorbed blocks share the opening carrier", () => {
	const { manager, ids } = fixture();
	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [
		{ blockId: "b1", runId: "r1", tier: 1, active: false, summary: "OLD summary", effectiveMessageIds: ids.slice(0, 2), directBlockIds: [] },
		{ blockId: "b2", runId: "r2", tier: 2, active: true, summary: "LATEST summary", effectiveMessageIds: ids.slice(0, 2), directBlockIds: ["b1"] },
	], messageRefs: { byRef: {} } }));
	const preview = previewShadowCalls({ sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 64_000 },
		[{ toolCallId: "c", before, input: { content: [{ startId: "b2", endId: "b2", summary: "short" }] } }]);
	assert.match(JSON.stringify(preview.preview!.buildSessionContext().messages), /LATEST summary/u);
	assert.doesNotMatch(JSON.stringify(preview.preview!.buildSessionContext().messages), /OLD summary/u);
});

test("effective fold settings change the fingerprint and start a new parity count", () => {
	const keep = configuredFoldFingerprint("engine", { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 });
	const fold = configuredFoldFingerprint("engine", { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 });
	const limit = configuredFoldFingerprint("engine", { firstUserMessage: "keep", firstUserMessageMaxTokens: 100 });
	assert.notEqual(keep, fold);
	assert.notEqual(keep, limit);
	assert.equal(buildFoldParityReport([{ v: PARITY_RECORD_VERSION, kind: "compress", sessionId: "s", toolCallId: "c", at: "2026-01-01", fingerprint: keep, nested: false, verdict: "match", diffs: [],
		ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", createdIds: [], partialEntries: 0, tiers: [], absorbed: [] },
		bcp: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", partialEntries: 0, tiers: [], absorbed: [] },
		oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] } }], [], fold).count, 0);
});
