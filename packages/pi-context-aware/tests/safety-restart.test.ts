/** REQ-C4 control: carrier edits, hide edits and fold records are persisted in
 * the session JSONL, and the SDK replays them when reopening the same file.
 * Mutation: drop context_edit entries during disk reload (in an isolated SDK).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldStateFromBranch } from "../src/folds/fold-adapter.js";
import { fold, OPENING_SUMMARY, requestText, safetyRoot, safetySession, seedOpening, withoutTimestamps } from "./fixtures/safety/session.js";

test("REQ-C4: disk reload rebuilds identical fold state and provider request", async () => {
	const root = safetyRoot();
	const sessions = path.join(root, "sessions");
	const manager = SessionManager.create(root, sessions);
	seedOpening(manager);
	fold(manager);
	const file = manager.getSessionFile();
	assert.ok(file && fs.existsSync(file));
	const before = structuredClone(manager.buildSessionContext().messages);
	// Open from disk, not from copied in-memory entries or a second side store.
	const reopened = SessionManager.open(file, sessions);
	assert.deepEqual(reopened.buildSessionContext().messages, before);
	assert.deepEqual(foldStateFromBranch(reopened.getBranch()).active, foldStateFromBranch(manager.getBranch()).active);
	assert.equal(fs.existsSync(`${file}.acp.json`), false, "native restart must not depend on a legacy side file");
	let original: Awaited<ReturnType<typeof safetySession>> | undefined;
	let reloaded: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		original = await safetySession(root, manager);
		await original.prompt("SAFETY-RESTART-PROBE");
		original.session.dispose();
		reloaded = await safetySession(root, reopened);
		await reloaded.prompt("SAFETY-RESTART-PROBE");
		assert.deepEqual(withoutTimestamps(reloaded.requests[0]), withoutTimestamps(original.requests[0]),
			"restart must reproduce the whole provider request, not just block metadata");
		for (const request of [original.requests[0]!, reloaded.requests[0]!]) {
			assert.ok(requestText(request).includes(OPENING_SUMMARY));
			assert.doesNotMatch(requestText(request), /SAFETY-ALPHA-ANSWER|SAFETY-BETA-ANSWER/u);
			assert.match(requestText(request), /SAFETY-TAIL-TWO/u);
		}
	} finally {
		original?.session.dispose(); reloaded?.session.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
