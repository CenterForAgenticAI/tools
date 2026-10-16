/** REQ-C5 controls: snapshotSideFile reports unreadable/unsupported input;
 * importAcpSideFile rejects unknown formats; the shadow recorder is observe-only
 * and carries these diagnostics without blocking session open or provider calls.
 * Mutations: bypass snapshot errors, or accept a newer import schema.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { importAcpSideFile } from "../src/folds/acp-import.js";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { readParityRecords } from "../src/parity/records.js";
import { snapshotSideFile } from "../src/parity/side-file.js";
import { requestText, safetyRoot, safetySession, seedOpening } from "./fixtures/safety/session.js";

for (const scenario of ["malformed", "missing", "newer-schema"] as const) {
	test(`REQ-C5: ${scenario} side file is reported without conversion and the reopened session runs`, async () => {
		const root = safetyRoot();
		const sessionDir = path.join(root, "sessions");
		const original = SessionManager.create(root, sessionDir);
		const ids = seedOpening(original);
		const file = original.getSessionFile();
		assert.ok(file);
		const sidePath = `${file}.acp.json`;
		const document = { schemaVersion: 2, messageRefs: { byRef: { m00001: ids[0], m00002: ids[1] } },
			blocks: [{ blockId: "b1", runId: "r1", tier: 1, summary: "SAFETY-CORRUPT-SUMMARY must never be imported.", active: true,
				effectiveMessageIds: ids.slice(0, 2), directBlockIds: [], compressedTokens: 10, createdAt: 1 }] };
		const text = scenario === "newer-schema" ? JSON.stringify(document) : "{SAFETY-MALFORMED-PRIVATE-BODY";
		if (scenario !== "missing") fs.writeFileSync(sidePath, text);
		const fileBefore = fs.readFileSync(file);
		const sideStat = scenario === "missing" ? undefined : fs.statSync(sidePath);
		const expectedKind = scenario === "missing" ? "side-file-missing" : "import-unsupported";
		let live: Awaited<ReturnType<typeof safetySession>> | undefined;
		let flush = async () => {};
		try {
			const manager = SessionManager.open(file, sessionDir);
			assert.deepEqual(manager.buildSessionContext().messages, original.buildSessionContext().messages);
			const snapshot = snapshotSideFile(file);
			assert.equal(snapshot.ok, false);
			assert.ok(!snapshot.ok);
			assert.equal(snapshot.diff.kind, expectedKind);
			if (scenario !== "missing") {
				assert.deepEqual(importAcpSideFile({ sideFileText: text, entries: manager.getEntries(), branch: manager.getBranch(), sessionId: manager.getSessionId() }),
					{ status: "unsupported", reason: scenario === "malformed" ? "not JSON" : "unknown schemaVersion 2" });
			}
			assert.deepEqual(fs.readFileSync(file), fileBefore, "open and unsupported import must not convert session bytes");
			const agentDir = path.join(root, "agent");
			const extension: ExtensionFactory = (pi) => {
				// This pair selects shadow mode, but neither tool writes a side file.
				for (const name of ["compress", "acp_status"]) pi.registerTool({ name, label: name, description: "Synthetic legacy owner.", parameters: Type.Object({}),
					async execute() { return { content: [{ type: "text", text: "No ranges provided." }], details: {} }; } });
				const engine = registerFoldEngine(pi);
				flush = registerFoldParityRecorder(pi, { engine, agentDir, fingerprint: "safety-corruption", now: () => new Date("2026-01-01T00:00:00Z") }).flush;
			};
			live = await safetySession(root, manager, [extension]);
			await live.prompt("SAFETY-CORRUPTION-PROBE", [
				fauxAssistantMessage(fauxToolCall("compress", {}, { id: "safety-corruption" }), { stopReason: "toolUse", timestamp: 1 }),
				fauxAssistantMessage("SAFETY-SESSION-STILL-RUNS", { timestamp: 1 }),
			]);
			await flush();
			assert.equal(live.requests.length, 2, "the corrupt side file must not stop the turn");
			const records = await readParityRecords(agentDir);
			const call = records.find((record) => record.kind === "compress");
			assert.ok(call, "the problem must be reported, not silently ignored");
			assert.equal(call.verdict, "inconclusive");
			assert.ok(call.diffs.some((diff) => diff.kind === expectedKind), JSON.stringify(call));
			assert.equal(manager.getEntries().filter((entry) => entry.type === "context_edit" || (entry.type === "custom" && entry.customType === "context-aware.fold.v1")).length, 0,
				"unusable side files must not become native folds");
			assert.match(requestText(live.requests[1]!), /SAFETY-ALPHA-ANSWER/u);
			assert.doesNotMatch(requestText(live.requests[1]!), /SAFETY-CORRUPT-SUMMARY/u);
			if (scenario === "missing") assert.equal(fs.existsSync(sidePath), false, "missing side files must not be manufactured");
			else {
				assert.equal(fs.readFileSync(sidePath, "utf8"), text);
				assert.equal(fs.statSync(sidePath).mtimeMs, sideStat!.mtimeMs, "the side file must not be rewritten");
			}
			assert.doesNotMatch(JSON.stringify(records), /SAFETY-MALFORMED-PRIVATE-BODY|SAFETY-CORRUPT-SUMMARY/u);
		} finally { live?.session.dispose(); await flush(); fs.rmSync(root, { recursive: true, force: true }); }
	});
}
