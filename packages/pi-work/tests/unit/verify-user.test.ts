import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { confirmationLine, runUser, userChallenge, type SessionReader } from "../../src/verify/user.ts";

const input = { evidence: { kind: "user" as const, prompt: "The letter was sent." }, specPath: "spec.yaml", nodeId: "letter", criterionId: "sent", tree: { kind: "git" as const, worktreePath: "/work", resolvedCommit: "a".repeat(40) } };

function session(content: unknown, persisted = true): SessionReader {
	return { getSessionId: () => "session-1", getSessionFile: () => persisted ? "/tmp/session.jsonl" : undefined, getBranch: () => [{ id: "entry-1", type: "message", timestamp: "2026-08-08T00:00:00.000Z", message: { role: "user", content } }] };
}

function hostSession(file: string, content: unknown): SessionReader {
	return { getSessionId: () => "session-1", getSessionFile: () => file, getBranch: () => [{ id: "entry-1", type: "message", timestamp: "2026-08-08T00:00:00.000Z", message: { role: "user", content } }] };
}

test("legacy adapter requires exact persisted active-branch confirmation", async () => {
	const challenge = userChallenge(input, "session-1");
	const missing = await runUser(input, session("silence"));
	assert.equal(missing.outcome, "failed");
	if (missing.outcome === "failed") assert.equal(missing.failures[0]?.code, "user-confirmation-required");
	const echoed = await runUser(input, session(confirmationLine(challenge), false));
	assert.equal(echoed.outcome, "failed");
	const passed = await runUser(input, session(confirmationLine(challenge)));
	assert.equal(passed.outcome, "passed");
	if (passed.outcome === "passed") {
		assert.equal(passed.proof.entryId, "entry-1");
		assert.equal(passed.proof.sessionId, "session-1");
	}
});

test("host non-UI confirmation reads the real session file", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-user-"));
	const file = path.join(directory, "session.jsonl");
	const challenge = userChallenge(input, "session-1");
	await writeFile(file, `${JSON.stringify({ type: "session", id: "session-1" })}\n${JSON.stringify({ id: "entry-1", type: "message", timestamp: "2026-08-08T00:00:00.000Z", message: { role: "user", content: confirmationLine(challenge) } })}\n`);
	const passed = await runUser(input, { host: { hasUI: false, session: hostSession(file, confirmationLine(challenge)) } });
	assert.equal(passed.outcome, "passed");
	const missingFile = await runUser(input, { host: { hasUI: false, session: hostSession(path.join(directory, "missing.jsonl"), confirmationLine(challenge)) } });
	assert.equal(missingFile.outcome, "failed");
	if (missingFile.outcome === "failed") assert.equal(missingFile.failures[0]?.code, "session-unavailable");
	await rm(directory, { recursive: true, force: true });
});

test("host UI confirmation is captured by the host and cancellation fails closed", async () => {
	let calls = 0;
	const confirmed = await runUser(input, { host: { hasUI: true, session: session("silence"), confirm: async (_title, message) => { calls += 1; assert.match(message, /I confirm [a-f0-9]{32}/); return true; } } });
	assert.equal(confirmed.outcome, "passed");
	assert.equal(calls, 1);
	const declined = await runUser(input, { host: { hasUI: true, session: session("silence"), confirm: async () => false } });
	assert.equal(declined.outcome, "failed");
});

test("user evidence fails closed for unavailable and malformed session readers", async () => {
	const unavailable = await runUser(input, undefined);
	assert.equal(unavailable.outcome, "failed");
	const throwing: SessionReader = { getSessionId: () => { throw new Error("session read failed"); }, getSessionFile: () => "/tmp/session.jsonl", getBranch: () => [] };
	const thrown = await runUser(input, throwing);
	assert.equal(thrown.outcome, "failed");
	if (thrown.outcome === "failed") assert.equal(thrown.failures[0]?.code, "session-unavailable");
	const ephemeral = await runUser(input, session("", false));
	assert.equal(ephemeral.outcome, "failed");
	if (ephemeral.outcome === "failed") assert.equal(ephemeral.failures[0]?.code, "session-unavailable");
});

test("malformed session entries never become confirmation evidence", async () => {
	const challenge = userChallenge(input, "session-1");
	const malformed: SessionReader = { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session.jsonl", getBranch: () => [
		{ id: "assistant", type: "message", timestamp: "2026-08-08T00:00:00.000Z", message: { role: "assistant", content: confirmationLine(challenge) } },
		{ id: "malformed-content", type: "message", timestamp: "2026-08-08T00:00:00.000Z", message: { role: "user", content: [{ type: "image", url: "ignored" }, 42] } },
		{ id: "missing-time", type: "message", message: { role: "user", content: confirmationLine(challenge) } },
	] };
	const result = await runUser(input, malformed);
	assert.equal(result.outcome, "failed");
	if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "user-confirmation-required");
});

test("user confirmation changes with tree identity", async () => {
	const challenge = userChallenge(input, "session-1");
	const changed = { ...input, tree: { ...input.tree, resolvedCommit: "b".repeat(40) } };
	const result = await runUser(changed, session(confirmationLine(challenge)));
	assert.equal(result.outcome, "failed");
});
