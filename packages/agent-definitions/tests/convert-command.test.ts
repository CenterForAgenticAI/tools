import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { USAGE_EXIT, type CommandIO } from "../src/cli.ts";
import { convertCommand } from "../src/convert-command.ts";
import { findFormat, formats } from "../src/formats/index.ts";

async function sandbox(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agent-definition-convert-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	return directory;
}

function capture(cwd: string): { io: CommandIO; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { cwd, stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
}

const canonical = "---\nname: reviewer\ndescription: Review one change.\n---\nReview carefully.\n";

describe("format registry", () => {
	it("lists every format in name order and finds only exact names", () => {
		assert.deepEqual(
			formats.map(({ name }) => name),
			["claude-code", "codex", "copilot", "gemini-cli", "opencode", "pi-agents"],
		);
		assert.equal(findFormat("copilot")?.name, "copilot");
		assert.equal(findFormat("Copilot"), undefined);
		assert.equal(findFormat("constructor"), undefined);
	});
});

describe("convertCommand", () => {
	it("dry-runs a foreign import to canonical text and prints both reports", async (t) => {
		const cwd = await sandbox(t);
		await writeFile(
			join(cwd, "review.md"),
			"---\ndescription: Review one change.\ntemperature: 0.1\n---\nReview carefully.\n",
		);
		const { io, out, err } = capture(cwd);
		assert.equal(await convertCommand(["--from", "opencode", "--to", "agent-definitions", "review.md"], io), 0);
		assert.deepEqual(err, []);
		assert.equal(out.length, 3);
		assert.match(out[0]!, /^review\.md\n---\nname: review\ndescription:/);
		assert.match(out[1]!, /^import opencode: 1 change\n- temperature: unmapped\./);
		assert.equal(out[2], "export agent-definitions: nothing lost\n");
		await assert.rejects(readFile(join(cwd, "review.md.md")));
	});

	it("prints machine-readable files and reports with --json", async (t) => {
		const cwd = await sandbox(t);
		await writeFile(join(cwd, "reviewer.md"), canonical);
		const { io, out, err } = capture(cwd);
		assert.equal(
			await convertCommand(["--json", "--from", "agent-definitions", "--to", "copilot", "reviewer.md"], io),
			0,
		);
		assert.deepEqual(err, []);
		assert.equal(out.length, 1);
		const value = JSON.parse(out[0]!) as { files: { path: string; text: string }[]; reports: { target: string }[] };
		assert.equal(value.files[0]?.path, ".github/agents/reviewer.agent.md");
		assert.match(value.files[0]!.text, /description: Review one change\./);
		assert.deepEqual(
			value.reports.map(({ target }) => target),
			["agent-definitions", "copilot"],
		);
	});

	it("writes under cwd, creates parent directories, and refuses to overwrite", async (t) => {
		const cwd = await sandbox(t);
		await writeFile(join(cwd, "reviewer.md"), canonical);
		const first = capture(cwd);
		assert.equal(
			await convertCommand(["--write", "--from", "agent-definitions", "--to", "claude-code", "reviewer.md"], first.io),
			0,
		);
		assert.match(await readFile(join(cwd, ".claude/agents/reviewer.md"), "utf8"), /name: reviewer/);
		const second = capture(cwd);
		assert.equal(
			await convertCommand(["--write", "--from", "agent-definitions", "--to", "claude-code", "reviewer.md"], second.io),
			1,
		);
		assert.deepEqual(second.err, ['Refusing to overwrite existing file ".claude/agents/reviewer.md".\n']);
	});

	it("refuses an exported path that resolves outside cwd", async (t) => {
		const cwd = await sandbox(t);
		await writeFile(
			join(cwd, "unsafe.md"),
			"---\nname: ../../../../escape\ndescription: Unsafe name fixture.\n---\nDo not write.\n",
		);
		const { io, err } = capture(cwd);
		assert.equal(
			await convertCommand(["--write", "--from", "agent-definitions", "--to", "claude-code", "unsafe.md"], io),
			1,
		);
		assert.deepEqual(err, [
			'Refusing to write outside the working directory: ".claude/agents/../../../../escape.md".\n',
		]);
	});

	it("reports an unreadable input and prints a separating newline for a body without one", async (t) => {
		const cwd = await sandbox(t);
		const missing = capture(cwd);
		assert.equal(await convertCommand(["--from", "agent-definitions", "--to", "copilot", "missing.md"], missing.io), 1);
		assert.match(missing.err.join(""), /Cannot read "missing\.md"/);

		await writeFile(join(cwd, "no-newline.md"), canonical.trimEnd());
		const dry = capture(cwd);
		assert.equal(
			await convertCommand(["--from", "agent-definitions", "--to", "agent-definitions", "no-newline.md"], dry.io),
			0,
		);
		assert.match(dry.out[0]!, /Review carefully\.\n$/);
	});

	it("returns 1 and exact parser diagnostics for an import failure", async (t) => {
		const cwd = await sandbox(t);
		await writeFile(join(cwd, "bad.md"), "no frontmatter");
		const { io, out, err } = capture(cwd);
		assert.equal(await convertCommand(["--from", "agent-definitions", "--to", "copilot", "bad.md"], io), 1);
		assert.deepEqual(out, []);
		assert.deepEqual(err, [
			"error missing-opening-fence: An agent definition must start with a line that contains only ---.\n",
		]);

		await writeFile(join(cwd, "missing-description.md"), "---\nname: bad\n---\nBody\n");
		const nested = capture(cwd);
		assert.equal(
			await convertCommand(["--from", "agent-definitions", "--to", "copilot", "missing-description.md"], nested.io),
			1,
		);
		assert.match(nested.err.join(""), /invalid-field description:/);
	});

	it("returns the usage status for missing arguments, repeated flags, and unknown formats", async (t) => {
		const cwd = await sandbox(t);
		await mkdir(join(cwd, "unused"));
		for (const args of [
			[],
			["--from", "opencode", "file.md"],
			["--from"],
			["--from", "--to", "copilot", "file.md"],
			["--from", "opencode", "--to"],
			["--from", "opencode", "--from", "copilot", "--to", "claude-code", "file.md"],
			["--from", "opencode", "--to", "copilot", "--to", "claude-code", "file.md"],
			["--write", "--write", "--from", "opencode", "--to", "copilot", "file.md"],
			["--json", "--json", "--from", "opencode", "--to", "copilot", "file.md"],
			["--from", "unknown", "--to", "copilot", "file.md"],
			["--from", "opencode", "--to", "unknown", "file.md"],
			["--from", "opencode", "--to", "copilot", "one.md", "two.md"],
			["--wat", "--from", "opencode", "--to", "copilot", "file.md"],
		] as const) {
			const { io, err } = capture(cwd);
			assert.equal(await convertCommand(args, io), USAGE_EXIT, args.join(" "));
			assert.match(err.join(""), /Usage: agent-definitions convert --from <format> --to <format>/);
		}
	});
});
