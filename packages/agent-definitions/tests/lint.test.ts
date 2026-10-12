import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lintSource } from "../src/lint.ts";

function definition(extra = "", name = "reviewer"): string {
	return `---\nname: ${name}\ndescription: Review one bounded change.${extra ? `\n${extra}` : ""}\n---\nFollow the task.\n`;
}

function shapes(source: string, options: Parameters<typeof lintSource>[1]) {
	return lintSource(source, options).diagnostics.map(({ severity, code, path, line }) => ({
		severity,
		code,
		path,
		...(line === undefined ? {} : { line }),
	}));
}

describe("lintSource", () => {
	it("keeps every parser diagnostic, including its line, and derives ok only from errors", () => {
		const invalid = lintSource("---\nname: reviewer\n---\n", {});
		assert.equal(invalid.ok, false);
		assert.deepEqual(invalid.diagnostics, [
			{
				severity: "error",
				code: "invalid-field",
				path: "description",
				message: "description must be a non-empty string.",
			},
			{
				severity: "error",
				code: "missing-instructions",
				path: "instructions",
				message: "The Markdown body must contain instructions.",
				line: 4,
			},
		]);

		const warning = lintSource(definition("maxTurns: 10"), {});
		assert.equal(warning.ok, true);
		assert.deepEqual(
			warning.diagnostics.map(({ severity, code, path, line }) => ({ severity, code, path, line })),
			[
				{ severity: "warning", code: "legacy-spelling", path: "maxTurns", line: 4 },
				{ severity: "hint", code: "foreign-spelling", path: "maxTurns", line: 4 },
			],
		);
	});

	it("suggests the canonical field for every supported foreign spelling", () => {
		const mappings = [
			["max_turns", "limits.maxTurns"],
			["maxTurns", "limits.maxTurns"],
			["timeout_mins", "limits.timeoutMinutes"],
			["mcp-servers", "services"],
			["disable-model-invocation", "invocation"],
			["user-invocable", "invocation"],
			["model_reasoning_effort", "effort"],
		] as const;

		for (const [foreign, canonical] of mappings) {
			const result = lintSource(definition(`${foreign}: 1`), {});
			const hint = result.diagnostics.find(({ code }) => code === "foreign-spelling");
			assert.deepEqual(hint && { severity: hint.severity, code: hint.code, path: hint.path, line: hint.line }, {
				severity: "hint",
				code: "foreign-spelling",
				path: foreign,
				line: 4,
			});
			assert.match(hint?.message ?? "", new RegExp(canonical.replace(".", "\\.")));
			assert.ok(result.diagnostics.some(({ path, code }) => path === foreign && code !== "foreign-spelling"));
		}

		const duplicate = lintSource(definition("maxTurns: 1\nmaxTurns: 2"), {});
		assert.equal(duplicate.diagnostics.filter(({ code }) => code === "foreign-spelling").length, 1);
	});

	it("checks written model entries only when an available-model list is supplied", () => {
		assert.deepEqual(shapes(definition("model: missing"), { availableModels: ["known"] }), [
			{ severity: "error", code: "model-unavailable", path: "model[0]" },
		]);
		assert.deepEqual(shapes(definition("model: [inherit, known, missing]"), { availableModels: ["known"] }), [
			{ severity: "error", code: "model-unavailable", path: "model[2]" },
		]);
		assert.deepEqual(shapes(definition("model: missing"), {}), []);
	});

	it("matches short and long skill references by name in every configured directory", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "agent-definition-lint-skills-"));
		t.after(async () => rm(root, { recursive: true, force: true }));
		const first = join(root, "first");
		const second = join(root, "second");
		await Promise.all([
			mkdir(join(second, "review"), { recursive: true }),
			mkdir(join(first, "secure"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(second, "review", "SKILL.md"), "# Review\n"),
			writeFile(join(first, "secure", "SKILL.md"), "# Secure\n"),
		]);

		const source = definition(
			"skills: [review, { name: secure, source: npm, version: '1', required: false }, missing]",
		);
		assert.deepEqual(shapes(source, { skillDirectories: [first, second] }), [
			{ severity: "error", code: "skill-missing", path: "skills[2]" },
		]);
		assert.deepEqual(shapes(source, {}), []);
	});

	it("does not let a skill name escape a configured directory", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "agent-definition-lint-traversal-"));
		t.after(async () => rm(root, { recursive: true, force: true }));
		const skills = join(root, "skills");
		await mkdir(skills);
		await writeFile(join(root, "SKILL.md"), "# Outside\n");

		assert.deepEqual(shapes(definition("skills: ['..']"), { skillDirectories: [skills] }), [
			{ severity: "error", code: "skill-missing", path: "skills[0]" },
		]);
	});

	it("checks only non-portable parsed tools and does not duplicate parser rejections", () => {
		const source = definition("tools: [read, bash, mcp:github/read, mcp:github/write]");
		assert.deepEqual(shapes(source, { availableTools: ["mcp:github/read"] }), [
			{ severity: "error", code: "tool-unknown", path: "tools[3]" },
		]);
		assert.deepEqual(shapes(source, {}), []);

		const rejected = lintSource(definition("tools: [not-a-tool]"), { availableTools: [] });
		assert.deepEqual(
			rejected.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "unknown-tool", path: "tools[0]" }],
		);
	});
});
