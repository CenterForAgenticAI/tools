import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { planFold } from "../src/folds/fold-adapter.js";
import { previewShadowCalls } from "../src/parity/compare.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";

// Seam: previewShadowCalls, the parity preview. It must plan with billion-context-pi's all-user-role
// protected-zone rule (pi-context-aware#318); the native "typed" rule would fold the range below.

const SUMMARY = "The early conversation is now settled. Preserve the agreed decisions and implementation details.";
const filler = (label: string) => label + ": " + "message history ".repeat(2500);

function fixture() {
	const manager = SessionManager.inMemory("/tmp");
	const ids: string[] = [];
	ids.push(manager.appendMessage({ role: "user", content: filler("U1 the request of this turn"), timestamp: 1 }));
	const assistant = (label: string) => ids.push(manager.appendMessage(fauxAssistantMessage(filler(label)) as never));
	for (const label of ["A1", "A2", "A3"]) assistant(label);
	ids.push(manager.appendCustomMessageEntry("fabric.peers", "<fabric-peers>" + filler("peers") + "</fabric-peers>", true));
	for (const label of ["A4", "A5", "A6", "A7", "A8", "A9"]) assistant(label);
	const byRef = Object.fromEntries(ids.map((id, i) => ["m" + String(i + 1).padStart(5, "0"), id]));
	return { manager, byRef };
}

test("#318: the parity preview refuses the injected message the native rule folds, because it is the latest user message", () => {
	const { manager, byRef } = fixture();
	const range = { startRef: "m00005", endRef: "m00005", summary: SUMMARY };
	const base = { ...range, branch: manager.getBranch(), modelContextLimit: 1_000_000 };
	// Control: the fixture separates the two rules, so a pass below cannot be a range both refuse.
	const native = planFold(base);
	assert.ok(native.ok, "under the native rule the range can be folded: " + JSON.stringify(native));
	const parity = planFold({ ...base, protectedZone: "all-user-role" });
	assert.equal(parity.ok, false, "under the parity rule the range is protected");
	assert.match(parity.ok ? "" : parity.errors.join(" "), /protected zone/u);

	const before = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef } }));
	const call = { toolCallId: "call", input: { content: [{ startId: "m00005", endId: "m00005", summary: SUMMARY }] }, before };
	const preview = previewShadowCalls({ sessionId: manager.getSessionId(), cwd: "/tmp", header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 1_000_000 }, [call]);
	assert.equal(preview.dropped, 1, "the preview drops the protected range");
	assert.equal(preview.records.length, 0, "the preview writes no fold");
});
