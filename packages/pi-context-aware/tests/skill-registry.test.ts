/**
 * load_skill's session registry (pi-context-aware#181).
 *
 * Seams: the registered load_skill tool's result for a repeat load, the custom
 * entries it appends to the session, and the fold kernel's plan (`planFold`)
 * over a branch that holds a load. Fold protection and the compressed state are
 * proven against the kernel only; billion-context-pi does production
 * compression until pi-context-aware#137.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { coveredEntryIds } from "../src/folds/fold-entries.js";
import { registerLoadSkillTool, type LoadSkillToolAPI } from "../src/skills/load-skill.js";
import { createSkillRegistry, SKILL_REGISTRY_ENTRY_TYPE, type SkillRegistry } from "../src/skills/skill-registry.js";
import { SAFETY_CONFIG } from "./fixtures/safety/session.js";

const BODY_MARKER = "GLAB-SKILL-BODY-7f3a";
const SKILL_TEXT = `---\nname: glab\ndescription: GitLab CLI\n---\n# glab\n${BODY_MARKER}\n`;

interface ToolResult { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
interface Tool {
	execute(id: string, params: { name: string; force?: boolean }, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResult>;
}

interface Rig {
	readonly manager: SessionManager;
	readonly registry: SkillRegistry;
	readonly skillPath: string;
	readonly root: string;
	/** Make one top-level load_skill call the way Pi records it: call, execute, result. */
	load(id: string, options?: { force?: boolean; nested?: boolean }): Promise<{ text: string; details: Record<string, unknown>; resultId?: string }>;
	chat(text: string): void;
	dispose(): void;
}

function rig(options: { pointersEnabled?: boolean; manager?: SessionManager; root?: string } = {}): Rig {
	const root = options.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-")));
	const skillPath = path.join(root, "skills", "glab", "SKILL.md");
	if (!fs.existsSync(skillPath)) {
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, SKILL_TEXT);
	}
	const manager = options.manager ?? SessionManager.inMemory(root);
	const registry = createSkillRegistry({
		append: (customType, data) => { manager.appendCustomEntry(customType, data); },
		pointersEnabled: () => options.pointersEnabled ?? true,
		restoreInvocation: () => "decompress",
		now: () => new Date("2026-10-20T00:00:00.000Z"),
	});
	registry.reset(manager.getBranch());
	let tool: Tool | undefined;
	const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
	const api = {
		registerTool: (definition: unknown) => { tool = definition as Tool; },
		on: (_event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.push(handler); },
	} as unknown as LoadSkillToolAPI;
	registerLoadSkillTool(api, undefined, async () => [], registry.hooks);
	for (const handler of handlers) {
		handler({ systemPrompt: "", systemPromptOptions: { skills: [{ name: "glab", description: "GitLab CLI", filePath: skillPath }] } },
			{ cwd: root, isProjectTrusted: () => true });
	}
	const chat = (text: string): void => {
		manager.appendMessage({ role: "user", content: text, timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(`ok: ${text}`, { timestamp: 1 }));
	};
	return {
		manager,
		registry,
		skillPath,
		root,
		chat,
		async load(id, loadOptions = {}) {
			const params = { name: "glab", ...(loadOptions.force ? { force: true } : {}) };
			if (loadOptions.nested) {
				// A nested call is never in the transcript: the parent program gets the result.
				registry.noteToolCall({ toolCallId: id, toolName: "load_skill", parentToolCallId: "parent-call" });
				const result = await tool!.execute(id, params, undefined, undefined, { sessionManager: manager });
				return { text: result.content[0]!.text, details: result.details };
			}
			manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", params, { id })], { stopReason: "toolUse", timestamp: 1 }));
			registry.noteToolCall({ toolCallId: id, toolName: "load_skill" });
			const result = await tool!.execute(id, params, undefined, undefined, { sessionManager: manager });
			const resultId = manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "load_skill", content: result.content, isError: false, timestamp: 1 });
			return { text: result.content[0]!.text, details: result.details, resultId };
		},
		dispose() { fs.rmSync(root, { recursive: true, force: true }); },
	};
}

const FOLD_SUMMARY = "FOLD-SUMMARY: the user asked for GitLab work and the agent loaded a skill.";

test("a second load of an unchanged, visible skill returns a pointer to the first result, not the body", async () => {
	const r = rig();
	try {
		r.chat("start");
		const first = await r.load("load-1");
		assert.match(first.text, new RegExp(BODY_MARKER, "u"));
		r.chat("again");
		const second = await r.load("load-2");
		assert.doesNotMatch(second.text, new RegExp(BODY_MARKER, "u"), "the pointer must not repeat the body");
		// user m00001, assistant m00002, load call m00003, load result m00004.
		assert.match(second.text, /already loaded at m00004 \(unchanged\)/u);
		assert.equal(second.details.ref, "m00004");
		assert.equal(second.details.toolCallId, "load-1");
	} finally { r.dispose(); }
});

test("a changed file returns the full new body, marked as changed", async () => {
	const r = rig();
	try {
		r.chat("start");
		await r.load("load-1");
		fs.writeFileSync(r.skillPath, SKILL_TEXT.replace(BODY_MARKER, "GLAB-SKILL-BODY-EDITED"));
		const second = await r.load("load-2");
		assert.match(second.text, /GLAB-SKILL-BODY-EDITED/u);
		assert.match(second.text, /The file changed since this skill was last loaded/u);
		assert.equal(second.details.changed, true);
	} finally { r.dispose(); }
});

test("force: true returns the full body for an unchanged, visible skill", async () => {
	const r = rig();
	try {
		r.chat("start");
		await r.load("load-1");
		const second = await r.load("load-2", { force: true });
		assert.match(second.text, new RegExp(BODY_MARKER, "u"));
		assert.equal(second.details.changed, undefined);
	} finally { r.dispose(); }
});

test("a load made by another tool is recorded as partial, so the next direct load returns the body", async () => {
	const r = rig();
	try {
		r.chat("start");
		const nested = await r.load("fabric-child-1", { nested: true });
		const records = r.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SKILL_REGISTRY_ENTRY_TYPE);
		assert.equal(records.length, 1, "the nested load must be recorded");
		const data = (records[0] as { data: Record<string, unknown> }).data;
		assert.equal(data.delivery, "partial");
		assert.equal(data.parentToolCallId, "parent-call");
		assert.equal(r.registry.isToolProtected("load_skill", nested.text), false, "a body that went to a program has no transcript copy to protect");
		const direct = await r.load("load-2");
		assert.match(direct.text, new RegExp(BODY_MARKER, "u"));
		assert.equal(r.registry.isToolProtected("load_skill", direct.text), true);
	} finally { r.dispose(); }
});

test("Pi's and Fabric's nested call ids are partial even without a tool_call event", async () => {
	for (const id of ["outer-call/1", "fabric_6c1f", "jev:p1:2"]) {
		const r = rig();
		try {
			r.chat("start");
			const params = { name: "glab" };
			void params;
			await r.load(id);
			const record = r.manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === SKILL_REGISTRY_ENTRY_TYPE) as { data: Record<string, unknown> };
			assert.equal(record.data.delivery, "partial", id);
			const again = await r.load("load-2");
			assert.match(again.text, new RegExp(BODY_MARKER, "u"), id);
		} finally { r.dispose(); }
	}
});

test("a visible copy whose text was edited after delivery is partial, so the next load returns the body", async () => {
	const r = rig();
	try {
		r.chat("start");
		const first = await r.load("load-1");
		r.manager.appendContextEdit(first.resultId!, { content: [{ type: "text", text: first.text.slice(0, 40) }] });
		const second = await r.load("load-2");
		assert.match(second.text, new RegExp(BODY_MARKER, "u"));
	} finally { r.dispose(); }
});

test("the fold kernel keeps a recorded load_skill result out of a fold, but folds an unrecorded one", async () => {
	const r = rig();
	try {
		r.chat("start");
		const first = await r.load("load-1");
		// Same tool name, text the registry never delivered: protection must not key on the name.
		r.manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", { name: "other" }, { id: "refused" })], { stopReason: "toolUse", timestamp: 1 }));
		const refusedId = r.manager.appendMessage({ role: "toolResult", toolCallId: "refused", toolName: "load_skill",
			content: [{ type: "text", text: "load_skill: unknown skill other" }], isError: false, timestamp: 1 });
		r.chat("tail one");
		r.chat("tail two");
		const plan = planFold({ branch: r.manager.getBranch(), startRef: "m00001", endRef: "m00006", summary: FOLD_SUMMARY, modelContextLimit: 64_000,
			config: { ...SAFETY_CONFIG, isToolProtected: (name, text) => r.registry.isToolProtected(name, text) } });
		assert.ok(plan.ok, JSON.stringify(plan));
		const covered = plan.records.flatMap((record) => coveredEntryIds(record));
		assert.ok(!covered.includes(first.resultId!), "the recorded skill result must stay out of the fold");
		assert.ok(covered.includes(refusedId), "an unrecorded load_skill result folds like any other result");
	} finally { r.dispose(); }
});

test("a folded load returns the compressor's block id and the exact decompress call", async () => {
	const r = rig();
	try {
		r.chat("start");
		const first = await r.load("load-1");
		r.chat("tail one");
		r.chat("tail two");
		// Folded anyway: a fold planned without the registry's protection.
		const plan = planFold({ branch: r.manager.getBranch(), startRef: "m00001", endRef: "m00004", summary: FOLD_SUMMARY, modelContextLimit: 64_000, config: SAFETY_CONFIG });
		assert.ok(plan.ok, JSON.stringify(plan));
		assert.ok(plan.records.some((record) => coveredEntryIds(record).includes(first.resultId!)), "the fold must cover the load result");
		applyFoldDrafts(r.manager, plan.drafts);
		const blockId = plan.records.find((record) => coveredEntryIds(record).includes(first.resultId!))!.blockId;
		const second = await r.load("load-2");
		assert.doesNotMatch(second.text, new RegExp(BODY_MARKER, "u"));
		assert.equal(second.details.blockId, blockId, "registry and compressor must agree on the block");
		assert.match(second.text, new RegExp(`decompress\\(\\{ blockId: "${blockId}" \\}\\)`, "u"));
	} finally { r.dispose(); }
});

test("registry state survives a session restart", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-restart-")));
	const sessionDir = path.join(root, "sessions");
	try {
		const before = rig({ root, manager: SessionManager.create(root, sessionDir) });
		before.chat("start");
		const first = await before.load("load-1");
		before.chat("after");
		const file = before.manager.getSessionFile();
		assert.ok(file && fs.existsSync(file), "the session must be on disk");

		const after = rig({ root, manager: SessionManager.open(file!, sessionDir) });
		assert.equal(after.registry.isToolProtected("load_skill", first.text), true, "protection must be rebuilt from the session file");
		const second = await after.load("load-2");
		assert.doesNotMatch(second.text, new RegExp(BODY_MARKER, "u"));
		assert.equal(second.details.toolCallId, "load-1");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("after a compaction drops the earlier result, the next load returns the body", async () => {
	const r = rig();
	try {
		r.chat("start");
		await r.load("load-1");
		r.manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		const keptId = r.manager.getLeafId()!;
		r.manager.appendCompaction("COMPACTION SUMMARY", keptId, 1000);
		const second = await r.load("load-2");
		assert.match(second.text, new RegExp(BODY_MARKER, "u"));
	} finally { r.dispose(); }
});

test("while billion-context-pi owns compression, a repeat load returns the body", async () => {
	const r = rig({ pointersEnabled: false });
	try {
		r.chat("start");
		await r.load("load-1");
		const second = await r.load("load-2");
		assert.match(second.text, new RegExp(BODY_MARKER, "u"));
	} finally { r.dispose(); }
});
