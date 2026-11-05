/**
 * The `load_skill` tool card.
 *
 * A delivered skill body collapses to one summary line until the user expands
 * the card; everything else the tool returns stays fully visible. These tests
 * drive the real `execute` and then the real `renderResult` the tool
 * registers, so removing the renderer, or rendering the body while collapsed,
 * fails here.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { registerLoadSkillTool, type LoadSkillContext, type LoadSkillParams } from "../src/skills/load-skill.js";
import type { RepeatDecision, SkillLoadHooks } from "../src/skills/skill-registry.js";

const themeModule = await import(pathToFileURL(path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")).href) as {
	initTheme: (themeName?: string, enableWatcher?: boolean) => void;
	theme: Theme;
};
themeModule.initTheme(undefined, false);
const theme = themeModule.theme;

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "");

const SKILL_PATH = "/pkg/modules/glab/skills/glab/SKILL.md";
const BODY_MARKER = "GLAB-BODY-MARKER-91c2";
// Forty lines and a final newline: long enough that Pi's own fallback, which
// shows ten lines, would still put the marker on screen.
const BODY = [`# glab`, BODY_MARKER, ...Array.from({ length: 38 }, (_, i) => `step ${i + 1}`)].join("\n") + "\n";

/** An `<available_skills>` block listing `glab` once per location, in order. */
function promptListing(...locations: string[]): string {
	return [
		"<available_skills>",
		...locations.flatMap((location) => [
			"  <skill>",
			"    <name>glab</name>",
			"    <description>Operate GitLab</description>",
			`    <location>${location}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

const PROMPT = promptListing(SKILL_PATH);

type Result = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type Component = { render(width: number): string[] };
interface Tool {
	execute(id: string, params: LoadSkillParams, signal: undefined, onUpdate: undefined, ctx: LoadSkillContext): Promise<Result>;
	renderResult?: (result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: unknown) => Component;
}

function registered(registry?: SkillLoadHooks): Tool {
	let tool: Tool | undefined;
	registerLoadSkillTool(
		{ registerTool: (definition) => { tool = definition as unknown as Tool; }, on: () => {} },
		(filePath) => {
			if (filePath !== SKILL_PATH) throw new Error(`ENOENT: ${filePath}`);
			return BODY;
		},
		async () => [],
		registry,
	);
	assert.ok(tool, "registerLoadSkillTool registered no tool");
	return tool;
}

async function load(tool: Tool, name: string, prompt = PROMPT): Promise<Result> {
	return tool.execute("call-1", { name }, undefined, undefined, { getSystemPrompt: () => prompt });
}

function rendered(tool: Tool, result: Result, expanded: boolean, width = 120): string[] {
	assert.equal(typeof tool.renderResult, "function", "load_skill must register a renderResult");
	return tool.renderResult!(result, { expanded, isPartial: false }, theme, {}).render(width).map(stripAnsi);
}

test("a loaded skill collapses to one line naming the skill, its path and its size", async () => {
	const tool = registered();
	const result = await load(tool, "glab");
	const lines = rendered(tool, result, false);
	const screen = lines.join("\n");
	assert.doesNotMatch(screen, new RegExp(BODY_MARKER, "u"), "the collapsed card must not show the skill body");
	assert.equal(lines.length, 1, `expected one line at width 120, got:\n${screen}`);
	assert.match(screen, /Loaded skill "glab"/u);
	assert.ok(screen.includes(SKILL_PATH), screen);
	assert.match(screen, /40 lines/u);
	assert.match(screen, /to expand/u);
});

test("expanding the card shows the full result text", async () => {
	const tool = registered();
	const result = await load(tool, "glab");
	const screen = rendered(tool, result, true).join("\n");
	assert.match(screen, new RegExp(BODY_MARKER, "u"));
	assert.match(screen, /step 38/u, "the expanded card must show the last line of the body");
});

test("the model still receives the whole body: rendering changes only the card", async () => {
	const tool = registered();
	const result = await load(tool, "glab");
	assert.equal(result.content.length, 1);
	assert.ok(result.content[0]!.text.endsWith(BODY), "the model-visible text must end with the full skill body");
	assert.equal(result.details.lines, 40);
});

test("an unknown name is shown in full when collapsed", async () => {
	const tool = registered();
	const result = await load(tool, "gitlab");
	assert.equal(result.details.error, "unknown");
	const screen = rendered(tool, result, false).join(" ");
	assert.match(screen, /Available: glab/u);
	assert.doesNotMatch(screen, /to expand/u);
});

test("an already-loaded pointer is shown in full when collapsed", async () => {
	const pointerText = `Skill "glab" is already loaded at m00004 (unchanged). Re-read that result; do not load it again.`;
	const decision: RepeatDecision = {
		kind: "pointer",
		text: pointerText,
		details: { name: "glab", path: SKILL_PATH, pointer: "visible", toolCallId: "call-0", ref: "m00004" },
	};
	const tool = registered({ decide: () => decision, record: () => {} });
	const result = await load(tool, "glab");
	assert.equal(result.content[0]!.text, pointerText);
	const screen = rendered(tool, result, false).join(" ");
	assert.match(screen, /already loaded at m00004 \(unchanged\)/u);
	assert.match(screen, /do not load it again/u);
});

test("no rendered line is wider than the terminal, collapsed or expanded", async () => {
	const tool = registered();
	const result = await load(tool, "glab");
	for (const width of [12, 20, 29, 35, 50, 80]) {
		for (const expanded of [false, true]) {
			const lines = tool.renderResult!(result, { expanded, isPartial: false }, theme, {}).render(width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `width ${width}, expanded ${expanded}: ${JSON.stringify(stripAnsi(line))}`);
			}
		}
	}
});

test("a skill that changed since its last load says so on the collapsed line", async () => {
	const changed: RepeatDecision = { kind: "body", changed: true, reason: "changed" };
	const tool = registered({ decide: () => changed, record: () => {} });
	const result = await load(tool, "glab");
	const lines = rendered(tool, result, false, 200);
	const screen = lines.join("\n");
	assert.equal(lines.length, 1, `expected one line at width 200, got:\n${screen}`);
	assert.doesNotMatch(screen, new RegExp(BODY_MARKER, "u"));
	assert.match(screen, /changed since the last load/u);
	assert.doesNotMatch(screen, /shadows/u);
});

test("an unchanged repeat load does not claim the skill changed", async () => {
	const unchanged: RepeatDecision = { kind: "body", changed: false, reason: "force" };
	const tool = registered({ decide: () => unchanged, record: () => {} });
	const result = await load(tool, "glab");
	const screen = rendered(tool, result, false, 200).join("\n");
	assert.match(screen, /Loaded skill "glab"/u);
	assert.doesNotMatch(screen, /changed since the last load/u);
});

test("a skill that shadows one other copy says so on the collapsed line", async () => {
	const tool = registered();
	const result = await load(tool, "glab", promptListing("/user/skills/glab/SKILL.md", SKILL_PATH));
	const lines = rendered(tool, result, false, 200);
	const screen = lines.join("\n");
	assert.equal(lines.length, 1, `expected one line at width 200, got:\n${screen}`);
	assert.ok(screen.includes(SKILL_PATH), screen);
	assert.match(screen, /shadows 1 other copy(?!\w)/u);
	assert.doesNotMatch(screen, /changed since the last load/u);
});

test("a skill that shadows several copies counts them on the collapsed line", async () => {
	const tool = registered();
	const prompt = promptListing("/user/skills/glab/SKILL.md", "/project/.pi/skills/glab/SKILL.md", SKILL_PATH);
	const result = await load(tool, "glab", prompt);
	const screen = rendered(tool, result, false, 200).join("\n");
	assert.match(screen, /shadows 2 other copies/u);
});
