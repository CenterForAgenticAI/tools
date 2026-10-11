import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parseDefinition, resolveContextFiles, type AgentDefinition, type ContextFileReference } from "../src/index.ts";

function definition(files: ContextFileReference[]): AgentDefinition {
	const parsed = parseDefinition("---\nname: context-test\ndescription: Test context files.\n---\nFollow the task.\n");
	assert.equal(parsed.ok, true);
	return { ...parsed.definition, context: { ...parsed.definition.context, files } };
}

async function temporaryDirectory(t: TestContext, prefix = "agent-definition-context-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	return directory;
}

function diagnosticShapes(
	diagnostics: readonly { severity: string; code: string; path: string }[],
): { severity: string; code: string; path: string }[] {
	return diagnostics.map(({ severity, code, path }) => ({ severity, code, path }));
}

describe("resolveContextFiles", () => {
	it("resolves regular files in declared order without reading their contents", async (t) => {
		const cwd = await temporaryDirectory(t);
		await mkdir(join(cwd, "docs"));
		await writeFile(join(cwd, "first.md"), "first");
		await writeFile(join(cwd, "docs", "second.md"), "second");
		const result = await resolveContextFiles(
			definition([
				{ path: "first.md", required: false },
				{ path: "docs/second.md", required: true },
			]),
			{ cwd },
		);
		assert.deepEqual(result, {
			ok: true,
			files: [
				{ path: "first.md", realPath: await realpath(join(cwd, "first.md")) },
				{ path: "docs/second.md", realPath: await realpath(join(cwd, "docs", "second.md")) },
			],
			diagnostics: [],
		});
	});

	it("skips optional missing files and errors for required missing files", async (t) => {
		const cwd = await temporaryDirectory(t);
		const result = await resolveContextFiles(
			definition([
				{ path: "optional.md", required: false },
				{ path: "required.md", required: true },
			]),
			{ cwd },
		);
		assert.equal(result.ok, false);
		assert.deepEqual(result.files, []);
		assert.deepEqual(diagnosticShapes(result.diagnostics), [
			{ severity: "warning", code: "context-file-missing", path: "context.files[0]" },
			{ severity: "error", code: "context-file-required-missing", path: "context.files[1]" },
		]);
	});

	it("treats a dangling symlink as missing", async (t) => {
		const cwd = await temporaryDirectory(t);
		await symlink("absent.md", join(cwd, "dangling.md"));
		const result = await resolveContextFiles(definition([{ path: "dangling.md", required: false }]), { cwd });
		assert.equal(result.ok, true);
		assert.deepEqual(result.files, []);
		assert.deepEqual(diagnosticShapes(result.diagnostics), [
			{ severity: "warning", code: "context-file-missing", path: "context.files[0]" },
		]);
	});

	it("propagates filesystem failures that do not mean missing", async (t) => {
		const cwd = await temporaryDirectory(t);
		await symlink("loop.md", join(cwd, "loop.md"));
		await assert.rejects(resolveContextFiles(definition([{ path: "loop.md", required: false }]), { cwd }), {
			code: "ELOOP",
		});
	});

	it("rejects a directory as not a regular file", async (t) => {
		const cwd = await temporaryDirectory(t);
		await mkdir(join(cwd, "docs"));
		const result = await resolveContextFiles(definition([{ path: "docs", required: false }]), { cwd });
		assert.equal(result.ok, false);
		assert.deepEqual(result.files, []);
		assert.deepEqual(diagnosticShapes(result.diagnostics), [
			{ severity: "error", code: "context-file-not-a-file", path: "context.files[0]" },
		]);
	});

	it("rejects a symlink whose real target is outside the real workspace", async (t) => {
		const cwd = await temporaryDirectory(t);
		const outside = await temporaryDirectory(t, "agent-definition-outside-");
		await writeFile(join(outside, "secret.md"), "secret");
		await symlink(join(outside, "secret.md"), join(cwd, "escape.md"));
		const result = await resolveContextFiles(definition([{ path: "escape.md", required: false }]), { cwd });
		assert.equal(result.ok, false);
		assert.deepEqual(result.files, []);
		assert.deepEqual(diagnosticShapes(result.diagnostics), [
			{ severity: "error", code: "context-file-outside-workspace", path: "context.files[0]" },
		]);
	});

	it("resolves entries against the real path of a symlinked cwd", async (t) => {
		const parent = await temporaryDirectory(t);
		const workspace = join(parent, "workspace");
		const cwd = join(parent, "workspace-link");
		await mkdir(workspace);
		await writeFile(join(workspace, "plan.md"), "plan");
		await symlink(workspace, cwd);
		const result = await resolveContextFiles(definition([{ path: "plan.md", required: true }]), { cwd });
		assert.deepEqual(result, {
			ok: true,
			files: [{ path: "plan.md", realPath: await realpath(join(workspace, "plan.md")) }],
			diagnostics: [],
		});
	});
});
