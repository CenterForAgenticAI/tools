import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { SUMMARY_HEADER } from "../src/folds/kernel/prune.js";
import type { FoldsConfig } from "../src/platform/config-layers.js";
import {
	CONDENSED_SKILL_ENTRY_TYPE,
	condensedSkillsOnBranch,
	createCondensedSkills,
	createSkillCondenser,
} from "../src/skills/condensed.js";
import { registerLoadSkillTool, type LoadSkillContext, type LoadSkillParams } from "../src/skills/load-skill.js";
import { supportsContextAwareCondensedSkillsV1, type ContextAwareServiceV1 } from "../src/context-service.js";

// Seams: the condensed-skills factory (capture, register, endOwner, resendText),
// planFold with a condenser, and the session context Pi builds from the drafts.

const CONDENSED_MARKER = "CONDENSED-MARKER-7f3";
const FULL_MARKER = "FULL-BODY-MARKER-91c";
const DIGEST = `sha256-tree/1:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256-tree/1:${"b".repeat(64)}`;
const engineConfig = { compress: { minCompressRange: 0, minSummaryLength: 10, maxSummaryLength: 20_000 }, preserveRecentMessages: 0, preserveRecentTokens: 0 };
const FOLD_OPENING: FoldsConfig = { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 };
const SUMMARY = "The verb run started and the first answer settled the plan.";

function skillDir(withCondensed = true): { dir: string; skillFile: string; condensedFile: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "condensed-skill-"));
	const skillFile = path.join(dir, "SKILL.md");
	const condensedFile = path.join(dir, "condensed.md");
	fs.writeFileSync(skillFile, `---\nname: delivering-work\n---\n# Delivering work\n${FULL_MARKER}\n`);
	if (withCondensed) fs.writeFileSync(condensedFile, `Rules: push a branch, open one MR. ${CONDENSED_MARKER}\n`);
	return { dir, skillFile, condensedFile };
}

const PREFIX = "<stack-verb verb=\"/deliver\">\n<script>\nStep 1. Do the thing.\n</script>\n<pinned-skills>\n";
const SUFFIX = "\n</pinned-skills>\n<args>group/project#12</args>\n</stack-verb>";
function verbMessage(location: string, digest: string | undefined = DIGEST): string {
	const digestAttribute = digest ? ` digest="${digest}"` : "";
	return `${PREFIX}<skill name="delivering-work" location="${location}"${digestAttribute}>\nReferences are relative to here.\n\n# Delivering work\n${FULL_MARKER}\n</skill>${SUFFIX}`;
}

function session(first: string) {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: first, timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("ANSWER-ONE"));
	manager.appendMessage({ role: "user", content: "next question", timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("ANSWER-TWO"));
	return manager;
}

function condensed(manager: SessionManager, readFile?: (file: string) => string) {
	return createCondensedSkills({ append: (customType, data) => { manager.appendCustomEntry(customType, data); }, ...(readFile ? { readFile } : {}) });
}

function contextText(manager: SessionManager): string {
	return JSON.stringify(manager.buildSessionContext().messages);
}

function fold(manager: SessionManager, endRef = "m00002", folds: FoldsConfig = FOLD_OPENING, withCondenser = true) {
	const branch = manager.getBranch();
	const condenser = withCondenser ? createSkillCondenser(branch) : undefined;
	const plan = planFold({ branch, startRef: "m00001", endRef, summary: SUMMARY, modelContextLimit: 64_000, config: engineConfig, folds, ...(condenser ? { condenser } : {}) });
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
	return plan;
}

/** The model-visible content of the first user message. */
function firstUserText(manager: SessionManager): string {
	const message = manager.buildSessionContext().messages.find((item) => item.role === "user");
	const content = (message as { content?: unknown } | undefined)?.content;
	return typeof content === "string" ? content : JSON.stringify(content);
}

test("a verb message's skill is captured, but no request carries the condensed text while the full body is shown", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	const captured = condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	assert.deepEqual(captured, [skillFile]);
	assert.equal(condensedSkillsOnBranch(manager.getBranch()).get(skillFile)?.record.source, "skill-message");
	const text = contextText(manager);
	assert.match(text, new RegExp(FULL_MARKER, "u"));
	assert.doesNotMatch(text, new RegExp(CONDENSED_MARKER, "u"));
});

test("a /skill: message, whose block has no digest, condenses at a fold", () => {
	const { skillFile } = skillDir();
	const slash = `<skill name="delivering-work" location="${skillFile}">\nReferences are relative to here.\n\n${FULL_MARKER}\n</skill>\n\nship it`;
	const manager = session(slash);
	assert.deepEqual(condensed(manager).capturePrompt(slash, [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);
	fold(manager);
	const shown = firstUserText(manager);
	assert.match(shown, new RegExp(`<skill name="delivering-work" location="[^"]+" form="condensed">\\nRules: push a branch, open one MR\\. ${CONDENSED_MARKER}`, "u"));
	assert.ok(shown.endsWith("</skill>\n\nship it"));
});

test("a fold shows the condensed form in place of the skill block and keeps the rest of the verb message byte for byte", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	fold(manager);
	const shown = firstUserText(manager);
	assert.equal(shown, `${PREFIX}<skill name="delivering-work" location="${skillFile}" digest="${DIGEST}" form="condensed">\n`
		+ `Rules: push a branch, open one MR. ${CONDENSED_MARKER}\n\n`
		+ `This is the condensed form of the skill. For the full text, call load_skill with name "delivering-work" and force: true, or read ${skillFile}.\n`
		+ `</skill>${SUFFIX}`);
	assert.ok(!shown.includes(SUMMARY_HEADER), "the condensed form carries no fold summary header");
	const text = contextText(manager);
	assert.doesNotMatch(text, new RegExp(FULL_MARKER, "u"));
	assert.doesNotMatch(text, /ANSWER-ONE/u, "the rest of the range still folds");
	assert.match(text, /The verb run started/u, "the model-written summary covers the other entries");
});

test("without a condenser the same fold summarizes the verb message, so the condenser is what keeps the rules live", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	fold(manager, "m00002", FOLD_OPENING, false);
	const text = contextText(manager);
	assert.doesNotMatch(text, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(text, new RegExp(FULL_MARKER, "u"));
});

test("an opening message kept by folds.firstUserMessage keep still shrinks its skill block", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	fold(manager, "m00004", { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 });
	const shown = firstUserText(manager);
	assert.ok(shown.startsWith(PREFIX) && shown.endsWith(SUFFIX));
	assert.match(shown, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(shown, new RegExp(FULL_MARKER, "u"));
});

test("editing condensed.md after injection does not change what a fold shows", () => {
	const { skillFile, condensedFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	fs.writeFileSync(condensedFile, "EDITED-AFTER-INJECTION\n");
	fold(manager);
	const text = contextText(manager);
	assert.match(text, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(text, /EDITED-AFTER-INJECTION/u);
});

test("a block whose digest disagrees with the captured one is not swapped", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile, OTHER_DIGEST));
	condensed(manager).capturePrompt(verbMessage(skillFile, DIGEST), [{ name: "delivering-work", filePath: skillFile }], manager);
	fold(manager);
	assert.doesNotMatch(contextText(manager), new RegExp(CONDENSED_MARKER, "u"));
});

test("capture reads condensed.md only beside a skill Pi loaded, never from a path named only in message text", () => {
	const { skillFile } = skillDir();
	const manager = session("x");
	const reads: string[] = [];
	const skills = condensed(manager, (file) => { reads.push(file); return fs.readFileSync(file, "utf8"); });
	const hostile = verbMessage("/etc/secret/SKILL.md");
	assert.deepEqual(skills.capturePrompt(hostile, [{ name: "delivering-work", filePath: skillFile }], manager), []);
	assert.deepEqual(reads, [], "a location that is not a loaded skill's path reads nothing");
	skills.capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager);
	assert.deepEqual(reads, [path.join(path.dirname(skillFile), "condensed.md")]);
});

test("a skill without condensed.md is captured as nothing and folds into the summary as before", () => {
	const { skillFile } = skillDir(false);
	const manager = session(verbMessage(skillFile));
	assert.deepEqual(condensed(manager).capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager), []);
	assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CONDENSED_SKILL_ENTRY_TYPE), false);
	assert.equal(createSkillCondenser(manager.getBranch()), undefined);
	fold(manager);
	assert.doesNotMatch(contextText(manager), new RegExp(FULL_MARKER, "u"));
});

test("load_skill captures condensed.md after delivering the body, and its result carries only the full text", async () => {
	const { skillFile } = skillDir();
	const manager = SessionManager.inMemory("/tmp");
	const skills = condensed(manager);
	let tool: { execute(id: string, params: LoadSkillParams, signal: undefined, onUpdate: undefined, ctx: LoadSkillContext): Promise<unknown> } | undefined;
	const capture = registerLoadSkillTool(
		{ registerTool: (definition) => { tool = definition as unknown as typeof tool; }, on: () => {} },
		undefined,
		async () => [],
		undefined,
		{ listen: false, onBody: (skill) => { skills.captureLoaded(skill, manager); } },
	);
	capture({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { skills: [{ name: "delivering-work", filePath: skillFile }] } } as never, { cwd: "/tmp" } as never);
	const result = await tool!.execute("call-1", { name: "delivering-work" }, undefined, undefined, {}) as { content: Array<{ text: string }> };
	assert.match(result.content[0]!.text, new RegExp(FULL_MARKER, "u"));
	assert.doesNotMatch(result.content[0]!.text, new RegExp(CONDENSED_MARKER, "u"));
	assert.equal(condensedSkillsOnBranch(manager.getBranch()).get(skillFile)?.record.source, "load_skill");
});

test("a digest-bearing verb block still condenses after repeated load_skill captures of it and another skill", () => {
	const primary = skillDir();
	const other = skillDir();
	const manager = session(verbMessage(primary.skillFile));
	const skills = condensed(manager);
	assert.deepEqual(skills.capturePrompt(verbMessage(primary.skillFile), [{ name: "delivering-work", filePath: primary.skillFile }], manager), [primary.skillFile]);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: primary.skillFile }, manager), true);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: primary.skillFile }, manager), false);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: other.skillFile }, manager), true);

	fold(manager);
	const shown = firstUserText(manager);
	assert.match(shown, new RegExp(`<skill name="delivering-work" location="[^"]+" digest="${DIGEST}" form="condensed">`, "u"));
	assert.match(shown, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(shown, new RegExp(FULL_MARKER, "u"));
});

test("a digest-less skill block still condenses after a digest-bearing capture of the same location", () => {
	const { skillFile } = skillDir();
	const withoutDigest = verbMessage(skillFile, "");
	const manager = session(withoutDigest);
	const skills = condensed(manager);
	assert.deepEqual(skills.capturePrompt(withoutDigest, [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);
	assert.deepEqual(skills.capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);

	fold(manager);
	const shown = firstUserText(manager);
	assert.match(shown, /<skill name="delivering-work" location="[^"]+" form="condensed">/u);
	assert.match(shown, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(shown, new RegExp(FULL_MARKER, "u"));
});

test("ending a registered form stubs it without ending a loaded form of the same location", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	const skills = condensed(manager);
	assert.deepEqual(skills.register({ name: "delivering-work", location: skillFile, digest: DIGEST, condensed: `Registered rules. ${CONDENSED_MARKER}`, ownerKey: "run-mixed" }, manager), { ok: true, stored: true });
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: skillFile }, manager), true);
	assert.equal(skills.endOwner("run-mixed", manager), true);

	fold(manager);
	const shown = firstUserText(manager);
	assert.match(shown, /digest="sha256-tree\/1:a{64}" form="stub">/u);
	assert.doesNotMatch(shown, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(shown, new RegExp(FULL_MARKER, "u"));

	const resend = skills.resendText(manager, () => false);
	assert.ok(resend);
	assert.deepEqual(resend.locations, [skillFile]);
	assert.match(resend.content, /form="condensed">/u);
	assert.match(resend.content, new RegExp(CONDENSED_MARKER, "u"));
});

test("a capture cannot replace a live registered form with the same digest", () => {
	const { skillFile } = skillDir();
	const manager = session(verbMessage(skillFile));
	const skills = condensed(manager);
	assert.deepEqual(skills.register({ name: "delivering-work", location: skillFile, digest: DIGEST, condensed: "REGISTERED-LIVE-FORM", ownerKey: "run-capture" }, manager), { ok: true, stored: true });
	assert.deepEqual(skills.capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);

	const liveBranch = structuredClone(manager.getBranch());
	const liveOpening = liveBranch.find((entry) => entry.type === "message" && (entry.message as { role?: unknown }).role === "user");
	assert.ok(liveOpening);
	const liveRendered = createSkillCondenser(liveBranch)?.condense(liveOpening);
	assert.ok(typeof liveRendered === "string");

	assert.equal(skills.endOwner("run-capture", manager), true);
	assert.match(liveRendered, /form="condensed">\nREGISTERED-LIVE-FORM/u);
	assert.doesNotMatch(liveRendered, new RegExp(CONDENSED_MARKER, "u"));

	const replayBranch = structuredClone(manager.getBranch());
	const replayOpening = replayBranch.find((entry) => entry.type === "message" && (entry.message as { role?: unknown }).role === "user");
	assert.ok(replayOpening);
	const replayRendered = createSkillCondenser(replayBranch)?.condense(replayOpening);
	assert.ok(typeof replayRendered === "string");
	assert.match(replayRendered, /digest="sha256-tree\/1:a{64}" form="stub">/u);
	assert.doesNotMatch(replayRendered, /REGISTERED-LIVE-FORM/u);

	fold(manager);
	assert.equal(firstUserText(manager), replayRendered);
});

test("an identical capture is deduplicated against its form rather than the newest form at its location", () => {
	const { skillFile } = skillDir();
	const manager = session("x");
	const skills = condensed(manager);
	assert.deepEqual(skills.capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: skillFile }, manager), true);
	assert.deepEqual(skills.capturePrompt(verbMessage(skillFile), [{ name: "delivering-work", filePath: skillFile }], manager), [skillFile]);

	const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CONDENSED_SKILL_ENTRY_TYPE);
	assert.equal(entries.length, 2, "one digest-bearing and one digest-less form are stored");
});

test("the post-compaction resend uses only the newest form when a location has two captured forms", () => {
	const { skillFile, condensedFile } = skillDir();
	const manager = session("x");
	const skills = condensed(manager);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: skillFile }, manager), true);
	assert.deepEqual(skills.register({ name: "delivering-work", location: skillFile, digest: DIGEST, condensed: "REGISTERED-FORM", ownerKey: "run-resend" }, manager), { ok: true, stored: true });
	fs.writeFileSync(condensedFile, `NEWEST-CAPTURED-FORM ${CONDENSED_MARKER}\n`);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: skillFile }, manager), true);

	const resend = skills.resendText(manager, () => false);
	assert.ok(resend);
	assert.deepEqual(resend.locations, [skillFile]);
	assert.equal(resend.content.match(/<skill /gu)?.length, 1);
	assert.match(resend.content, new RegExp(`NEWEST-CAPTURED-FORM ${CONDENSED_MARKER}`, "u"));
	assert.doesNotMatch(resend.content, /REGISTERED-FORM/u);
});

test("the resend uses the newest live form when the newest form at a location is a stub", () => {
	const { skillFile } = skillDir();
	const manager = session("x");
	const skills = condensed(manager);
	assert.equal(skills.captureLoaded({ name: "delivering-work", filePath: skillFile }, manager), true);
	assert.deepEqual(skills.register({ name: "delivering-work", location: skillFile, digest: DIGEST, condensed: "ENDED-REGISTERED-FORM", ownerKey: "run-ended-resend" }, manager), { ok: true, stored: true });
	assert.equal(skills.endOwner("run-ended-resend", manager), true);

	const resend = skills.resendText(manager, () => false);
	assert.ok(resend, "a live sibling form is resent");
	assert.deepEqual(resend.locations, [skillFile]);
	assert.equal(resend.content.match(/<skill /gu)?.length, 1);
	assert.match(resend.content, /form="condensed">/u);
	assert.match(resend.content, new RegExp(CONDENSED_MARKER, "u"));
	assert.doesNotMatch(resend.content, /ENDED-REGISTERED-FORM/u);

	const replayEntries = structuredClone(manager.getBranch());
	const replaySession = { getBranch: () => replayEntries };
	assert.deepEqual(skills.resendText(replaySession, () => false), resend);
});

test("a registered skill condenses, and ending its owner key turns it into a stub at the next fold", () => {
	const manager = session(verbMessage("pkg:delivering-work"));
	const reads: string[] = [];
	const skills = condensed(manager, (file) => { reads.push(file); return ""; });
	const result = skills.register({ name: "delivering-work", location: "pkg:delivering-work", digest: DIGEST, condensed: `Short rules. ${CONDENSED_MARKER}`, ownerKey: "run-1" }, manager);
	assert.deepEqual(result, { ok: true, stored: true });
	fold(manager);
	assert.match(firstUserText(manager), new RegExp(CONDENSED_MARKER, "u"));
	assert.equal(skills.endOwner("run-1", manager), true);
	assert.equal(skills.endOwner("run-1", manager), false, "an ended owner holds no condensed skill");
	const again = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00004", summary: SUMMARY, modelContextLimit: 64_000, config: engineConfig, folds: FOLD_OPENING, condenser: createSkillCondenser(manager.getBranch())! });
	assert.ok(again.ok, JSON.stringify(again));
	applyFoldDrafts(manager, again.drafts);
	const shown = firstUserText(manager);
	assert.match(shown, /form="stub">\nSkill "delivering-work" is no longer in use/u);
	assert.doesNotMatch(shown, new RegExp(CONDENSED_MARKER, "u"));
	assert.ok(shown.startsWith(PREFIX) && shown.endsWith(SUFFIX));
	assert.deepEqual(reads, [], "a registration reads no file");
});

test("a registration stores only its named fields and refuses a malformed digest or missing owner", () => {
	const manager = session("x");
	const skills = condensed(manager);
	const hostile = { name: "glab", location: "pkg:glab", digest: DIGEST, condensed: "rules", ownerKey: "run-2", source: "load_skill", injected: "SHOULD-NOT-SURVIVE" };
	assert.deepEqual(skills.register(hostile, manager), { ok: true, stored: true });
	const entry = manager.getBranch().find((item) => item.type === "custom" && item.customType === CONDENSED_SKILL_ENTRY_TYPE);
	assert.doesNotMatch(JSON.stringify(entry), /SHOULD-NOT-SURVIVE/u);
	assert.equal(condensedSkillsOnBranch(manager.getBranch()).get("pkg:glab")?.record.source, "registered");
	assert.deepEqual(skills.register({ ...hostile }, manager), { ok: true, stored: false }, "the same text again is not stored twice");
	assert.equal(skills.register({ ...hostile, digest: "sha256:abc" }, manager).ok, false);
	assert.equal(skills.register({ ...hostile, ownerKey: "" }, manager).ok, false);
	assert.equal(skills.register({ ...hostile, condensed: "x".repeat(32_001) }, manager).ok, false);
});

test("after a compaction the resend carries each skill still in use once, condensed, and skips one whose full text is shown", () => {
	const manager = session("x");
	const skills = condensed(manager);
	skills.register({ name: "glab", location: "pkg:glab", digest: DIGEST, condensed: `glab rules ${CONDENSED_MARKER}`, ownerKey: "run-3" }, manager);
	skills.register({ name: "plan-work", location: "pkg:plan-work", digest: DIGEST, condensed: "plan rules", ownerKey: "run-3" }, manager);
	skills.register({ name: "ended", location: "pkg:ended", digest: DIGEST, condensed: "ended rules", ownerKey: "run-4" }, manager);
	skills.endOwner("run-4", manager);
	const resend = skills.resendText(manager, (record) => record.location === "pkg:plan-work");
	assert.ok(resend);
	assert.deepEqual(resend.locations, ["pkg:glab"]);
	assert.equal(resend.content.split(CONDENSED_MARKER).length - 1, 1, "once");
	assert.match(resend.content, /<skill name="glab" location="pkg:glab" digest="sha256-tree\/1:a{64}" form="condensed">/u);
	assert.ok(!resend.content.includes(SUMMARY_HEADER));
	assert.equal(skills.resendText(manager, () => true), undefined);
});
test("the service reports the registration capability only when register and endOwner are present", () => {
	const base = { skills: { loaded: () => [] } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(base), false);
	const full = { skills: { loaded: () => [], condensed: true, register: () => ({ ok: true, stored: true }), endOwner: () => true } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(full), true);
	const partial = { skills: { loaded: () => [], condensed: true, register: () => ({ ok: true, stored: true }) } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(partial), false);
});
