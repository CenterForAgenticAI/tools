import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CONDENSED_SKILL_ENTRY_TYPE, renderCondensedBlock, type CondensedSkillRecord } from "../src/skills/condensed.js";
import { focusFixture, type FocusFixture } from "./session-focus-harness.js";

// issue #311: the `context` handler combines host projection of skill guidance,
// history repair and brief recovery. Each of its three returns must keep both
// the projection and (when recovering) the brief block.

const LOCATION = "/skills/example/SKILL.md";
const CONDENSED = "CAPTURED-RULES";
const RECORD: CondensedSkillRecord = {
	version: 1,
	name: "example",
	location: LOCATION,
	condensed: CONDENSED,
	condensedHash: createHash("sha256").update(CONDENSED).digest("hex"),
	capturedAt: "2026-01-01T00:00:00.000Z",
	source: "load_skill",
};
const SKILL_MESSAGE = { role: "user", content: renderCondensedBlock(RECORD, "condensed"), timestamp: 1 };
const ORPHAN = { role: "toolResult", toolCallId: "call-orphan", toolName: "bash", content: [{ type: "text", text: "ORPHAN-RESULT" }], isError: false, timestamp: 2 };

async function withOptOut(body: (fixture: FocusFixture) => Promise<void>): Promise<void> {
	const previous = process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
	process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = "1";
	let fixture: FocusFixture | undefined;
	try {
		fixture = await focusFixture([{ type: "custom", id: "cond-1", parentId: null, customType: CONDENSED_SKILL_ENTRY_TYPE, data: RECORD }]);
		await body(fixture);
	} finally {
		fixture?.cleanup();
		if (previous === undefined) delete process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
		else process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = previous;
	}
}

function text(messages: ReadonlyArray<Record<string, unknown>>): string {
	return messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}
function briefCount(messages: ReadonlyArray<Record<string, unknown>>): number {
	return messages.filter((message) => message.customType === "context-aware.brief-recovery").length;
}
function assertProjected(messages: ReadonlyArray<Record<string, unknown>>): void {
	const all = text(messages);
	assert.ok(all.includes(`For the full text, read ${LOCATION}.`), "guidance is projected for the host reader");
	assert.doesNotMatch(all, /call load_skill/u);
}

async function recovering(fixture: FocusFixture): Promise<void> {
	await fixture.call("session_focus", { action: "brief", brief: "opt-out recovery state" });
	await fixture.turn();
	fixture.entries.push({ type: "compaction" });
}

test("opt-out with active brief recovery sends projected guidance and one brief block", async () => {
	await withOptOut(async (fixture) => {
		await recovering(fixture);
		const messages = await fixture.requestMessages([SKILL_MESSAGE]);
		assertProjected(messages);
		assert.equal(briefCount(messages), 1);
		assert.match(text(messages), /opt-out recovery state/);
	});
});

test("opt-out after recovery ends still sends projected guidance and no brief block", async () => {
	await withOptOut(async (fixture) => {
		await recovering(fixture);
		await fixture.requestMessages([SKILL_MESSAGE]);
		await fixture.endRun();
		const messages = await fixture.requestMessages([SKILL_MESSAGE]);
		assertProjected(messages);
		assert.equal(briefCount(messages), 0);
		assert.doesNotMatch(text(messages), /session-brief/);
	});
});

test("opt-out with recovery and a repaired history keeps projection, repair and one brief block", async () => {
	await withOptOut(async (fixture) => {
		await recovering(fixture);
		const messages = await fixture.requestMessages([SKILL_MESSAGE, ORPHAN]);
		assertProjected(messages);
		assert.doesNotMatch(text(messages), /ORPHAN-RESULT/);
		assert.equal(briefCount(messages), 1);
	});
});

test("opt-out without recovery but with a repaired history keeps projection and repair", async () => {
	await withOptOut(async (fixture) => {
		const messages = await fixture.requestMessages([SKILL_MESSAGE, ORPHAN]);
		assertProjected(messages);
		assert.doesNotMatch(text(messages), /ORPHAN-RESULT/);
		assert.equal(briefCount(messages), 0);
	});
});
