import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import extension from "../src/index.js";
import { discoverContextAwareServiceV1, supportsContextAwareCondensedSkillsV1, supportsContextAwareLoadedSkillsV1 } from "../src/context-service.js";
import { CONDENSED_RESEND_MESSAGE_TYPE, CONDENSED_SKILL_ENTRY_TYPE, SKILL_OWNER_ENDED_ENTRY_TYPE } from "../src/skills/condensed.js";
import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { coveredEntryIds } from "../src/folds/fold-entries.js";
import { createHostPi, createSession } from "./compaction-owner-harness.js";
import { SAFETY_CONFIG } from "./fixtures/safety/session.js";

// Seam: the tools the extension's default export registers on a host, and what the
// registered load_skill returns for a skill Pi discovered (pi-context-aware#181).

let exitCodeBefore: typeof process.exitCode;
beforeEach(() => { exitCodeBefore = process.exitCode; });
afterEach(() => { process.exitCode = exitCodeBefore; });

interface LoadSkillTool {
	name: string;
	execute(id: string, params: { name: string }, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

test("the extension registers load_skill, which loads a discovered skill by name", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-load-skill-")));
	try {
		const skillPath = path.join(root, "skills", "glab", "SKILL.md");
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, "---\nname: glab\n---\nREGISTERED-SKILL-BODY\n");
		const host = createHostPi();
		extension(host.api);
		const tool = host.tools.get("load_skill") as LoadSkillTool | undefined;
		assert.ok(tool, "pi-context-aware must register load_skill");

		const session = createSession(root, "load-skill");
		await host.handler("before_agent_start")({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: "",
			systemPromptOptions: { skills: [{ name: "glab", description: "GitLab CLI", filePath: skillPath }] },
		}, session.ctx);
		const result = await tool.execute("call-1", { name: "glab" }, undefined, undefined, session.ctx);
		const text = result.content.map((part) => part.text).join("\n");
		assert.match(text, /REGISTERED-SKILL-BODY/u);
		assert.equal(result.details.path, skillPath);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("/context-status and the context service report a loaded skill with its state and size", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-loaded-skills-")));
	try {
		const skillPath = path.join(root, "skills", "glab", "SKILL.md");
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		// 31 bytes (4 + 11 + 4 + 12), counted by hand, not by the code under test.
		fs.writeFileSync(skillPath, "---\nname: glab\n---\nSTATUS-BODY\n");
		const host = createHostPi();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		Object.assign(host.api, { registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command); } });
		extension(host.api);
		const tool = host.tools.get("load_skill") as LoadSkillTool;

		const manager = SessionManager.inMemory(root);
		const notifications: string[] = [];
		const ctx = Object.assign({}, createSession(root, "loaded-skills").ctx, {
			sessionManager: manager,
			hasUI: true,
			ui: { notify: (message: string) => { notifications.push(message); }, setWidget: () => {}, setStatus: () => {}, theme: { fg: (_color: string, text: string) => text } },
		}) as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await host.handler("before_agent_start")({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: "",
			systemPromptOptions: { skills: [{ name: "glab", description: "GitLab CLI", filePath: skillPath }] },
		}, ctx);

		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", { name: "glab" }, { id: "call-1" })], { stopReason: "toolUse", timestamp: 1 }));
		const result = await tool.execute("call-1", { name: "glab" }, undefined, undefined, ctx);
		manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "load_skill", content: result.content as never, isError: false, timestamp: 1 });
		// The host appends the registry's custom entry through pi.appendEntry.
		for (const entry of host.entries) manager.appendCustomEntry(entry.customType, entry.data);

		await commands.get("context-status")!.handler("", ctx);
		assert.match(notifications.at(-1) ?? "", /Loaded skills \(1\):\n {2}glab: visible at m00003, 31 bytes/u);

		const service = discoverContextAwareServiceV1(host.bus, "loaded-skills-consumer");
		assert.ok(supportsContextAwareLoadedSkillsV1(service), "the service must expose the loaded-skills capability");
		const [loaded, ...rest] = service.skills.loaded();
		assert.equal(rest.length, 0);
		assert.deepEqual({ name: loaded!.name, path: loaded!.path, bytes: loaded!.bytes, state: loaded!.state, ref: loaded!.ref },
			{ name: "glab", path: skillPath, bytes: 31, state: "visible", ref: "m00003" });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function condensedHarness(on: boolean) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-condensed-")));
	const skillPath = path.join(root, "skills", "delivering-work", "SKILL.md");
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(skillPath, "---\nname: delivering-work\n---\nFULL-RULES\n");
	fs.writeFileSync(path.join(path.dirname(skillPath), "condensed.md"), "CONDENSED-RULES-MARKER\n");
	if (on) {
		fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify({ folds: { condensedSkills: true } }));
	}
	const host = createHostPi();
	extension(host.api);
	const manager = SessionManager.inMemory(root);
	const ctx = Object.assign({}, createSession(root, "condensed").ctx, { cwd: root, sessionManager: manager }) as unknown as ExtensionContext;
	await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const prompt = `<stack-verb>\n<pinned-skills>\n<skill name="delivering-work" location="${skillPath}">\nFULL-RULES\n</skill>\n</pinned-skills>\n</stack-verb>`;
	await host.handler("before_agent_start")({
		type: "before_agent_start",
		prompt,
		systemPrompt: "",
		systemPromptOptions: { skills: [{ name: "delivering-work", description: "Delivery", filePath: skillPath }] },
	}, ctx);
	const sync = () => { for (const entry of host.entries.splice(0)) manager.appendCustomEntry(entry.customType, entry.data); };
	sync();
	return { root, skillPath, host, manager, ctx, sync };
}

test("with folds.condensedSkills on, a pinned skill's condensed.md is captured from the run's prompt, and after a compaction it is resent once", async () => {
	const { root, skillPath, host, manager, ctx } = await condensedHarness(true);
	try {
		const captured = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CONDENSED_SKILL_ENTRY_TYPE);
		assert.equal(captured.length, 1);
		assert.match(JSON.stringify(captured[0]), /CONDENSED-RULES-MARKER/u);
		assert.match(JSON.stringify(captured[0]), new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"), "u"));
		const before = host.messages.length;
		await host.handler("session_compact")({ type: "session_compact", compactionEntry: { id: "c", details: {} }, fromExtension: false }, ctx);
		const resent = host.messages.slice(before).filter((item) => (item.message as { customType?: string }).customType === CONDENSED_RESEND_MESSAGE_TYPE);
		assert.equal(resent.length, 1);
		assert.match(JSON.stringify(resent[0]!.message), /form=\\"condensed\\">\\nCONDENSED-RULES-MARKER/u);
		assert.deepEqual(resent[0]!.options, { triggerTurn: false });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("with folds.condensedSkills off, nothing is captured, nothing is resent, and registrations are refused", async () => {
	const { root, host, manager, ctx } = await condensedHarness(false);
	try {
		assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CONDENSED_SKILL_ENTRY_TYPE), false);
		const before = host.messages.length;
		await host.handler("session_compact")({ type: "session_compact", compactionEntry: { id: "c", details: {} }, fromExtension: false }, ctx);
		assert.equal(host.messages.slice(before).some((item) => (item.message as { customType?: string }).customType === CONDENSED_RESEND_MESSAGE_TYPE), false);
		const service = discoverContextAwareServiceV1(host.bus, "condensed-off");
		assert.ok(supportsContextAwareCondensedSkillsV1(service));
		const result = service!.skills!.register!({ name: "x", location: "pkg:x", digest: `sha256-tree/1:${"c".repeat(64)}`, condensed: "rules", ownerKey: "run" });
		assert.deepEqual(result, { ok: false, error: "folds.condensedSkills is off" });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the context service registers condensed text and ends an owner key when folds.condensedSkills is on", async () => {
	const { root, host, manager, sync } = await condensedHarness(true);
	try {
		const service = discoverContextAwareServiceV1(host.bus, "condensed-on");
		assert.ok(supportsContextAwareCondensedSkillsV1(service));
		const digest = `sha256-tree/1:${"d".repeat(64)}`;
		assert.deepEqual(service!.skills!.register!({ name: "glab", location: "pkg:glab", digest, condensed: "glab rules", ownerKey: "run-9" }), { ok: true, stored: true });
		sync();
		assert.equal(service!.skills!.endOwner!("run-9"), true);
		sync();
		assert.ok(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === SKILL_OWNER_ENDED_ENTRY_TYPE));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const REACHABILITY_SKILL_BODY = "REACHABILITY-SKILL-BODY-227";

type SkillRestoreRoute = "fabric-denied" | "fabric-allowed" | "direct";

async function foldedSkillRepeat(route: SkillRestoreRoute): Promise<{
	readonly blockId: string;
	readonly text: string;
	readonly guidelines: string;
}> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-skill-restore-")));
	const previousAllowlist = process.env.PI_FABRIC_TOOL_ALLOWLIST;
	try {
		const skillPath = path.join(root, "skills", "glab", "SKILL.md");
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, `---\nname: glab\n---\n${REACHABILITY_SKILL_BODY}\n`);

		const host = createHostPi();
		extension(host.api);
		const tool = host.tools.get("load_skill") as LoadSkillTool & { promptGuidelines: string[] };
		const manager = SessionManager.inMemory(root);
		const ctx = Object.assign({}, createSession(root, `skill-restore-${route}`).ctx, { cwd: root, sessionManager: manager }) as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);

		const registeredTools = host.api.getAllTools();
		if (route === "direct") {
			host.api.setActiveTools(["read", "load_skill", "decompress"]);
		} else {
			Object.assign(host.api, {
				getAllTools: () => [...registeredTools, {
					name: "fabric_exec",
					description: "Fabric executor",
					parameters: {},
					sourceInfo: {
						path: "/profile/node_modules/pi-fabric/dist/index.js",
						source: "npm:pi-fabric@0.92.42",
						scope: "user" as const,
						origin: "package" as const,
						baseDir: "/profile/node_modules/pi-fabric",
					},
				}],
			});
			host.api.setActiveTools(["read", "fabric_exec"]);
			const allowlist = ["read", "bash", "edit", "write", "grep", "find", "ls", "load_skill", "ask", "fabric_exec"];
			if (route === "fabric-allowed") allowlist.push("decompress");
			process.env.PI_FABRIC_TOOL_ALLOWLIST = JSON.stringify(allowlist);
		}
		await host.handler("before_agent_start")({
			type: "before_agent_start",
			prompt: "load the skill",
			systemPrompt: "",
			systemPromptOptions: { skills: [{ name: "glab", description: "GitLab CLI", filePath: skillPath }] },
		}, ctx);

		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", { name: "glab" }, { id: "call-1" })], { stopReason: "toolUse", timestamp: 1 }));
		const first = await tool.execute("call-1", { name: "glab" }, undefined, undefined, ctx);
		const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "load_skill", content: first.content as never, isError: false, timestamp: 1 });
		for (const entry of host.entries.splice(0)) manager.appendCustomEntry(entry.customType, entry.data);
		manager.appendMessage({ role: "user", content: "tail one", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("tail two", { timestamp: 1 }));

		const plan = planFold({
			branch: manager.getBranch(),
			startRef: "m00001",
			endRef: "m00004",
			summary: "The agent loaded the GitLab skill.",
			modelContextLimit: 64_000,
			config: SAFETY_CONFIG,
		});
		assert.ok(plan.ok, JSON.stringify(plan));
		const record = plan.records.find((candidate) => coveredEntryIds(candidate).includes(resultId));
		assert.ok(record, "the test must fold the first load_skill result");
		applyFoldDrafts(manager, plan.drafts);

		const repeated = await tool.execute("call-2", { name: "glab" }, undefined, undefined, ctx);
		return {
			blockId: record.blockId,
			text: repeated.content.map((part) => part.text).join("\n"),
			guidelines: tool.promptGuidelines.join("\n"),
		};
	} finally {
		if (previousAllowlist === undefined) delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
		else process.env.PI_FABRIC_TOOL_ALLOWLIST = previousAllowlist;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("folded load_skill pointers name only a reachable restore invocation", async (t) => {
	const denied = await foldedSkillRepeat("fabric-denied");
	await t.test("static guidance does not name a session-dependent restore tool", () => {
		assert.doesNotMatch(denied.guidelines, /\bdecompress\b/u, "registered load_skill promptGuidelines must not name decompress");
	});
	await t.test("a Fabric child denied decompress gets the skill body", () => {
		assert.match(denied.text, new RegExp(REACHABILITY_SKILL_BODY, "u"), "repeat load must return the skill body when decompress is denied");
		assert.doesNotMatch(denied.text, /\bdecompress\b/u, "repeat load must not name decompress when the Fabric child cannot call it");
	});

	const fabric = await foldedSkillRepeat("fabric-allowed");
	await t.test("a Fabric child allowed decompress gets the executor invocation", () => {
		assert.match(fabric.text, new RegExp(`extensions\\.decompress\\(\\{ blockId: "${fabric.blockId}" \\}\\)`, "u"));
	});

	const direct = await foldedSkillRepeat("direct");
	await t.test("a directly active decompress tool keeps the direct invocation", () => {
		assert.match(direct.text, new RegExp(`decompress\\(\\{ blockId: "${direct.blockId}" \\}\\)`, "u"));
		assert.doesNotMatch(direct.text, /extensions\.decompress/u);
	});
});

// The pointer switch follows the fold engine's own mode (foldModeFor), so a reload that
// puts our compress alias in front of billion-context-pi's still counts as
// billion-context-pi owning compression: Pi lists the first tool registered under a
// name (pi-context-aware#189).
async function repeatLoad(tools: ReadonlyArray<{ name: string; sourceInfo?: { path: string } }>): Promise<string> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-pointer-mode-")));
	try {
		const skillPath = path.join(root, "skills", "glab", "SKILL.md");
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, "---\nname: glab\n---\nMODE-BODY-MARKER\n");
		const host = createHostPi();
		extension(host.api);
		Object.assign(host.api, { getAllTools: () => tools.map((tool) => ({ ...tool, description: "", parameters: {} })) });
		const tool = host.tools.get("load_skill") as LoadSkillTool;
		const manager = SessionManager.inMemory(root);
		const ctx = Object.assign({}, createSession(root, "pointer-mode").ctx, { sessionManager: manager }) as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		await host.handler("before_agent_start")({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: "",
			systemPromptOptions: { skills: [{ name: "glab", description: "GitLab CLI", filePath: skillPath }] },
		}, ctx);
		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		for (const id of ["call-1", "call-2"]) {
			manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", { name: "glab" }, { id })], { stopReason: "toolUse", timestamp: 1 }));
			const result = await tool.execute(id, { name: "glab" }, undefined, undefined, ctx);
			manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "load_skill", content: result.content as never, isError: false, timestamp: 1 });
			for (const entry of host.entries.splice(0)) manager.appendCustomEntry(entry.customType, entry.data);
			if (id === "call-2") return result.content.map((part) => part.text).join("\n");
		}
		throw new Error("unreachable");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const OWN_PATH = "/profile/extensions/context-aware/dist/extension.js";
const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";

test("with the native fold engine live, a repeat load of an unchanged skill returns a pointer", async () => {
	const text = await repeatLoad([{ name: "read", sourceInfo: { path: "builtin:read" } }]);
	assert.doesNotMatch(text, /MODE-BODY-MARKER/u);
	assert.match(text, /already loaded/u);
});

test("after a reload puts our compress alias in front of billion-context-pi's, a repeat load returns the body", async () => {
	const text = await repeatLoad([
		{ name: "context_fold", sourceInfo: { path: OWN_PATH } },
		{ name: "compress", sourceInfo: { path: OWN_PATH } },
		{ name: "acp_status", sourceInfo: { path: BCP_PATH } },
	]);
	assert.match(text, /MODE-BODY-MARKER/u);
});
