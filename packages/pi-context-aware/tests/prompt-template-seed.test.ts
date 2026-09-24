import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { resolvePromptTemplateSeed } from "../prompt-template-seed.js";

function promptCommand(name: string, templatePath: string): SlashCommandInfo {
	return {
		name,
		description: "test prompt",
		source: "prompt",
		sourceInfo: {
			path: templatePath,
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};
}

function extensionCommand(name: string): SlashCommandInfo {
	return {
		name,
		description: "test extension command",
		source: "extension",
		sourceInfo: {
			path: "/extensions/test.ts",
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};
}

test("resolves a loaded prompt body with Pi-compatible argument substitution", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-template-seed-"));
	try {
		const templatePath = path.join(dir, "handoff.md");
		fs.writeFileSync(templatePath, `---
description: ignored frontmatter
model: example/model
---
first=$1
second=$2
all=$@
literal=@$
slice=\${@:2:2}
default=\${4:-fallback}
`);

		const result = resolvePromptTemplateSeed(
			`/handoff "alpha beta" gamma delta`,
			[promptCommand("handoff", templatePath)],
		);

		assert.deepEqual(result, {
			kind: "resolved",
			seed: [
				"first=alpha beta",
				"second=gamma",
				"all=alpha beta gamma delta",
				"literal=@$",
				"slice=gamma delta",
				"default=fallback",
			].join("\n"),
			invocation: `/handoff "alpha beta" gamma delta`,
			commandName: "handoff",
			templatePath,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("does not recursively substitute placeholder text supplied as an argument", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-template-seed-"));
	try {
		const templatePath = path.join(dir, "literal.md");
		fs.writeFileSync(templatePath, "$@");
		const result = resolvePromptTemplateSeed(`/literal '$1'`, [promptCommand("literal", templatePath)]);
		assert.equal(result.kind, "resolved");
		assert.equal(result.seed, "$1");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("prefers prompt metadata when an extension command shadows the same template", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-template-seed-"));
	try {
		const templatePath = path.join(dir, "enhanced.md");
		fs.writeFileSync(templatePath, "Carry out $@.");
		const result = resolvePromptTemplateSeed("/enhanced the task", [
			extensionCommand("enhanced"),
			promptCommand("enhanced", templatePath),
		]);
		assert.equal(result.kind, "resolved");
		assert.equal(result.seed, "Carry out the task.");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects registered extension and skill commands instead of asking the model to infer them", () => {
	const extension = resolvePromptTemplateSeed("/context-status", [extensionCommand("context-status")]);
	assert.equal(extension.kind, "error");
	assert.match(extension.message, /registered extension command, not a prompt template/);

	const skillInfo = { ...extensionCommand("skill:review"), source: "skill" as const };
	const skill = resolvePromptTemplateSeed("/skill:review", [skillInfo]);
	assert.equal(skill.kind, "error");
	assert.match(skill.message, /registered skill command, not a prompt template/);
});

test("leaves ordinary seeds and unknown slash-prefixed text unchanged", () => {
	assert.deepEqual(resolvePromptTemplateSeed("continue the task", []), {
		kind: "literal",
		seed: "continue the task",
	});
	assert.deepEqual(resolvePromptTemplateSeed("/not-a-loaded-template keep going", []), {
		kind: "literal",
		seed: "/not-a-loaded-template keep going",
	});
});

test("reports unreadable and empty loaded templates", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-template-seed-"));
	try {
		const missingPath = path.join(dir, "missing.md");
		const missing = resolvePromptTemplateSeed("/missing", [promptCommand("missing", missingPath)]);
		assert.equal(missing.kind, "error");
		assert.match(missing.message, /Failed to resolve prompt template \/missing/);

		const emptyPath = path.join(dir, "empty.md");
		fs.writeFileSync(emptyPath, "---\ndescription: empty\n---\n   \n");
		const empty = resolvePromptTemplateSeed("/empty", [promptCommand("empty", emptyPath)]);
		assert.equal(empty.kind, "error");
		assert.match(empty.message, /expanded to an empty compaction seed/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
