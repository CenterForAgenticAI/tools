import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { USAGE_EXIT, type CommandIO } from "../src/cli.ts";
import { lintCommand } from "../src/lint-command.ts";

function definition(extra = "", name = "reviewer"): string {
	return `---\nname: ${name}\ndescription: Review one bounded change.${extra ? `\n${extra}` : ""}\n---\nFollow the task.\n`;
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agent-definition-lint-command-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	return directory;
}

function capture(cwd: string): { io: CommandIO; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { cwd, stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
}

describe("lintCommand", () => {
	it("lints sorted direct Markdown children with JSON and line-based availability files", async (t) => {
		const cwd = await temporaryDirectory(t);
		const agents = join(cwd, "agents");
		const skillOne = join(cwd, "skills-one");
		const skillTwo = join(cwd, "skills-two");
		await Promise.all([
			mkdir(join(agents, "nested"), { recursive: true }),
			mkdir(join(skillTwo, "present"), { recursive: true }),
			mkdir(skillOne, { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(agents, "b.md"), definition("model: missing\nskills: [absent]\ntools: [mcp:git/write]", "b")),
			writeFile(join(agents, "a.md"), definition("model: known\nskills: [present]\ntools: [read]", "a")),
			writeFile(join(agents, "c.md"), definition("maxTurns: 2", "c")),
			writeFile(join(agents, "skip.chain.md"), "invalid"),
			writeFile(join(agents, "notes.txt"), "invalid"),
			writeFile(join(agents, "nested", "deep.md"), "invalid"),
			writeFile(join(skillTwo, "present", "SKILL.md"), "# Present\n"),
			writeFile(join(cwd, "models.json"), '["known"]\n'),
			writeFile(join(cwd, "tools.txt"), "# available tools\n\nmcp:git/read\n"),
		]);
		const { io, out, err } = capture(cwd);

		assert.equal(
			await lintCommand(
				[
					"--models",
					"models.json",
					"--skills",
					"skills-one",
					"--skills",
					"skills-two",
					"--tools",
					"tools.txt",
					"agents",
					"agents/a.md",
				],
				io,
			),
			1,
		);
		assert.deepEqual(err, []);
		assert.deepEqual(out, [
			[
				'agents/b.md: error model-unavailable model[0]: Model "missing" is not available.',
				'agents/b.md: error skill-missing skills[0]: Skill "absent" was not found in the configured skill directories.',
				'agents/b.md: error tool-unknown tools[0]: Tool "mcp:git/write" is not available.',
				"agents/c.md:4: warning legacy-spelling maxTurns: Use the canonical 0.1 field instead.",
				'agents/c.md:4: hint foreign-spelling maxTurns: Use the canonical field "limits.maxTurns" instead of "maxTurns".',
				"3 files, 3 errors, 1 warnings, 1 hints",
				"",
			].join("\n"),
		]);
	});

	it("prints one JSON document with relative files and parser diagnostic lines", async (t) => {
		const cwd = await temporaryDirectory(t);
		await writeFile(join(cwd, "warning.md"), definition("", "Review_Agent"));
		const { io, out, err } = capture(cwd);

		assert.equal(await lintCommand(["--json", "warning.md"], io), 0);
		assert.deepEqual(err, []);
		assert.equal(out.length, 1);
		assert.deepEqual(JSON.parse(out[0]!), {
			files: [
				{
					file: "warning.md",
					ok: true,
					diagnostics: [
						{
							severity: "warning",
							code: "name-spelling",
							path: "name",
							message: "Use lowercase letters, digits and single hyphens for agent names.",
							line: 2,
						},
					],
				},
			],
			errors: 0,
			warnings: 1,
			hints: 0,
		});
	});

	it("skips chain files even when named directly", async (t) => {
		const cwd = await temporaryDirectory(t);
		await writeFile(join(cwd, "workflow.chain.md"), "invalid");
		const { io, out, err } = capture(cwd);

		assert.equal(await lintCommand(["workflow.chain.md"], io), 0);
		assert.deepEqual(out, ["0 files, 0 errors, 0 warnings, 0 hints\n"]);
		assert.deepEqual(err, []);
	});

	it("returns usage status for argument, path, and availability-file errors", async (t) => {
		const cwd = await temporaryDirectory(t);
		await Promise.all([
			mkdir(join(cwd, "list-directory")),
			writeFile(join(cwd, "wrong-shape.json"), '{"model":"one"}\n'),
			writeFile(join(cwd, "wrong-entry.json"), '["one", 2]\n'),
		]);
		const cases: readonly (readonly string[])[] = [
			[],
			["--wat"],
			["--models"],
			["--skills"],
			["--tools"],
			["missing.md"],
			["--models", "list-directory", "missing.md"],
			["--models", "wrong-shape.json", "missing.md"],
			["--tools", "wrong-entry.json", "missing.md"],
		];

		for (const args of cases) {
			const { io, out, err } = capture(cwd);
			assert.equal(await lintCommand(args, io), USAGE_EXIT, args.join(" "));
			assert.equal(USAGE_EXIT, 2);
			assert.deepEqual(out, []);
			assert.equal(err.length, 1);
			assert.match(err[0]!, /Usage: agent-definitions lint/);
		}
	});
});
