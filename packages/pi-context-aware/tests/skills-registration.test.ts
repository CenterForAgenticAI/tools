import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentText, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";

import extension from "../src/index.js";
import { discoverContextAwareServiceV1, supportsContextAwareCondensedSkillsV1, supportsContextAwareLoadedSkillsV1 } from "../src/context-service.js";
import { CONDENSED_RESEND_MESSAGE_TYPE, CONDENSED_SKILL_ENTRY_TYPE, SKILL_OWNER_ENDED_ENTRY_TYPE, createCondensedSkills, createSkillCondenser, condensedSkillsOnBranch, renderCondensedBlock } from "../src/skills/condensed.js";
import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { coveredEntryIds } from "../src/folds/fold-entries.js";
import { createHostPi, createSession } from "./compaction-owner-harness.js";
import { SAFETY_CONFIG, safetySession } from "./fixtures/safety/session.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";

// Seam: the tools the extension's default export registers on a host, and what the
// registered load_skill returns for a skill Pi discovered (pi-context-aware#181).

let exitCodeBefore: typeof process.exitCode;
beforeEach(() => { exitCodeBefore = process.exitCode; });
afterEach(() => { process.exitCode = exitCodeBefore; });

interface LoadSkillTool {
	name: string;
	execute(id: string, params: { name: string }, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

test("the host opt-out survives SDK session lifecycles without dropping pending tools", async (t) => {
	const previous = process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
	process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = "1";
	try {
		for (const role of ["foreground", "worker"] as const) await t.test(role, async () => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-host-skills-")));
			let session: Awaited<ReturnType<typeof safetySession>>["session"] | undefined;
			let lateApi: ExtensionAPI | undefined;
			let toolSetWrites = 0;
			const start = async (manager: SessionManager) => {
				const created = await safetySession(root, manager, [
					(pi) => extension(new Proxy(pi, {
						get(target, key, receiver) {
							if (key === "setActiveTools") return (names: string[]) => { toolSetWrites++; target.setActiveTools(names); };
							return Reflect.get(target, key, receiver);
						},
					})),
					(pi) => { lateApi = pi; },
				]);
				session = created.session;
				assert.equal(session.getAllTools().some((tool) => tool.name === "load_skill"), false);
				assert.equal(session.getActiveToolNames().includes("load_skill"), false);
				assert.equal(session.getCallableToolNames().includes("load_skill"), false);
				assert.doesNotMatch(session.systemPrompt, /load_skill/u);
				assert.equal(toolSetWrites, 0, "opting out must never replace a session's tool set");
			};
			const registerLate = (name: string) => {
				lateApi!.registerTool({
					name, label: name, description: "Deferred host tool", exposure: "deferred", parameters: obj({}, { open: true }),
					async execute() { return { content: [{ type: "text", text: "late" }], details: {} }; },
				});
				assert.ok(session!.getActiveToolNames().includes(name), "a recorded deferred tool must activate when it registers");
			};
			try {
				const fresh = SessionManager.inMemory(root);
				fresh.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("host", { sessionRole: role }));
				await start(fresh);
				session!.dispose();

				const manager = SessionManager.create(root, path.join(root, "sessions"));
				manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("host", { sessionRole: role }));
				manager.appendMessage({ role: "system", content: "", timestamp: 0,
					toolsAdded: ["read", "load_skill", "late_resume", "late_tree"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })),
				});
				const anchor = manager.appendMessage({ role: "user", content: "Root question", timestamp: 1 });
				manager.appendMessage(fauxAssistantMessage("Root answer"));
				const file = manager.getSessionFile()!;
				assert.ok(fs.existsSync(file));
				await start(SessionManager.open(file));
				registerLate("late_resume");
				await session!.navigateTree(anchor);
				registerLate("late_tree");
				assert.equal(session!.getCallableToolNames().includes("load_skill"), false);
				assert.equal(toolSetWrites, 0);
				session!.dispose();

				await start(SessionManager.forkFrom(file, root));
				registerLate("late_resume");
			} finally {
				session?.dispose();
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
		else process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = previous;
	}
});

test("the first request after opting out refreshes saved guidance without editing history or condensing full bodies", async () => {
	const previous = process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
	process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = "1";
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-host-skill-replay-")));
	let running: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		const location = path.join(root, "SKILL.md");
		const open = `<skill name="example" location="${location}"`;
		const original = `${open}>\nORIGINAL-FULL-BODY\n</skill>`;
		fs.writeFileSync(location, "ORIGINAL-FULL-BODY");
		fs.writeFileSync(path.join(root, "condensed.md"), "CAPTURED-RULES");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: original, timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("First answer"));
		manager.appendMessage({ role: "user", content: "Next question", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("Next answer"));
		const skills = createCondensedSkills({ append: (type, data) => { manager.appendCustomEntry(type, data); } });
		skills.capturePrompt(original, [{ name: "example", filePath: location }], manager);
		const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00002", summary: "The first exchange completed.",
			modelContextLimit: 64_000, config: { ...SAFETY_CONFIG, preserveRecentMessages: 0, preserveRecentTokens: 0 },
			folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000, engine: "auto" }, condenser: createSkillCondenser(manager.getBranch())! });
		assert.ok(plan.ok, JSON.stringify(plan));
		applyFoldDrafts(manager, plan.drafts);
		const oldBlock = skills.resendText(manager, () => false)!.content;
		assert.match(oldBlock, /call load_skill/u);
		manager.appendCustomMessageEntry(CONDENSED_RESEND_MESSAGE_TYPE, oldBlock, false);
		const record = condensedSkillsOnBranch(manager.getBranch()).get(location)!.record;
		manager.appendCustomMessageEntry(CONDENSED_RESEND_MESSAGE_TYPE, renderCondensedBlock(record, "stub"), false);
		fs.writeFileSync(path.join(root, "condensed.md"), "NEWER-CAPTURED-RULES");
		skills.capturePrompt(original, [{ name: "example", filePath: location }], manager);
		const full = `${open}>\nSTILL-FULL-BODY\n</skill>`;
		const foreign = `${open} form="condensed">\nUSER-AUTHORED-BODY\n</skill>`;
		manager.appendMessage({ role: "user", content: `${full}\n${foreign}`, timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("Continue"));
		const saved = manager.getEntries().map((entry) => [entry.id, JSON.stringify(entry)] as const);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		running = await safetySession(root, reopened, [extension]);
		await running.prompt("Continue using the host reader.");
		assert.equal(running.requests.length, 1);
		const text = running.requests[0]!.map((message) => contentText(message.content)).join("\n");
		assert.doesNotMatch(text, /call load_skill/u);
		assert.ok(text.includes(`For the full text, read ${location}.`));
		assert.ok(text.includes(`Read ${location} if you need it.`));
		assert.match(text, /\nCAPTURED-RULES\n/u, "saved blocks must retain their originally captured rules");
		assert.doesNotMatch(text, /NEWER-CAPTURED-RULES/u);
		assert.ok(text.includes(full), "a full body must not condense before a fold");
		assert.ok(text.includes(foreign), "user-authored lookalikes must not change");
		for (const [id, entry] of saved) assert.equal(JSON.stringify(reopened.getEntry(id)), entry);
		assert.equal(reopened.getEntries().filter((entry) => entry.type === "context_edit").length,
			manager.getEntries().filter((entry) => entry.type === "context_edit").length);
	} finally {
		running?.session.dispose();
		fs.rmSync(root, { recursive: true, force: true });
		if (previous === undefined) delete process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
		else process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = previous;
	}
});

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

for (const disabled of [false, true]) test(`condensed skills are resent once with the creation-time loader policy (disabled=${disabled})`, async () => {
	const previous = process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
	process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = disabled ? "1" : "0";
	const { root, skillPath, host, manager, ctx } = await condensedHarness(true);
	try {
		process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = disabled ? "0" : "1";
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
		const text = (resent[0]!.message as { content: string }).content;
		assert.ok(text.includes(`read ${skillPath}`));
		assert.ok(text.includes("call load_skill"), "stored guidance is independent of the host's tool policy");
		const messages: ContextEvent["messages"] = [{ role: "custom", customType: CONDENSED_RESEND_MESSAGE_TYPE, content: text, display: false, timestamp: 0 }];
		const projected = await host.handler("context")({ type: "context", messages }, ctx) as { messages: ContextEvent["messages"] } | undefined;
		const visible = (projected?.messages ?? messages).map((message) => "content" in message ? contentText(message.content) : "").join("\n");
		assert.equal(visible.includes("call load_skill"), !disabled);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		if (previous === undefined) delete process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL;
		else process.env.PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL = previous;
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
			host.api.setActiveTools(["read", "load_skill", "context_recall"]);
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
			if (route === "fabric-allowed") allowlist.push("context_recall");
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
		assert.doesNotMatch(denied.guidelines, /\bcontext_recall\b/u, "registered load_skill promptGuidelines must not name context_recall");
	});
	await t.test("a Fabric child denied context_recall gets the skill body", () => {
		assert.match(denied.text, new RegExp(REACHABILITY_SKILL_BODY, "u"), "repeat load must return the skill body when context_recall is denied");
		assert.doesNotMatch(denied.text, /\bcontext_recall\b/u, "repeat load must not name context_recall when the Fabric child cannot call it");
	});

	const fabric = await foldedSkillRepeat("fabric-allowed");
	await t.test("a Fabric child allowed context_recall gets the executor invocation", () => {
		assert.match(fabric.text, new RegExp(`extensions\\.context_recall\\(\\{ ref: "${fabric.blockId}" \\}\\)`, "u"));
	});

	const direct = await foldedSkillRepeat("direct");
	await t.test("a directly active context_recall tool keeps the direct invocation", () => {
		assert.match(direct.text, new RegExp(`context_recall\\(\\{ ref: "${direct.blockId}" \\}\\)`, "u"));
		assert.doesNotMatch(direct.text, /extensions\.context_recall/u);
	});
});

// The pointer switch follows the fold engine's own mode (foldModeFor), so a reload that
// puts our context_fold in front of billion-context-pi's still counts as
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

test("while billion-context-pi owns compression, a repeat load returns the body", async () => {
	const text = await repeatLoad([
		{ name: "context_fold", sourceInfo: { path: OWN_PATH } },
		{ name: "compress", sourceInfo: { path: BCP_PATH } },
		{ name: "acp_status", sourceInfo: { path: BCP_PATH } },
	]);
	assert.match(text, /MODE-BODY-MARKER/u);
});
