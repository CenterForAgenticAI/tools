import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverDefinitionFiles, loadDefinitions, type DefinitionOrigin, type DiscoveredFile } from "../src/index.ts";

let sandbox = "";
let home = "";
let nextCase = 0;

function definition(name: string, extra = ""): string {
	return `---\nname: ${name}\ndescription: Test ${name}.${extra ? `\n${extra}` : ""}\n---\nFollow the task.\n`;
}

async function write(path: string, source: string): Promise<string> {
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, source);
	return path;
}

async function caseDirectory(label: string): Promise<string> {
	const directory = join(home, `${String(nextCase++).padStart(2, "0")}-${label}`);
	await mkdir(directory, { recursive: true });
	return directory;
}

function summary(files: DiscoveredFile[]): [string, DefinitionOrigin, string][] {
	return files.map(({ file, origin, dir }) => [basename(file), origin, dir]);
}

before(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "agent-definition-discovery-"));
	home = join(sandbox, "home");
	await mkdir(home);
});

after(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("discoverDefinitionFiles", () => {
	it("returns package, user, and project files from lowest to highest precedence", async () => {
		const root = await caseDirectory("ordered");
		const cwd = join(root, "work", "nested");
		const packageLow = join(root, "packages-low");
		const packageHigh = join(root, "packages-high");
		const userOld = join(home, ".pi", "agent", "agents");
		const userNew = join(home, ".agents");
		const projectFlat = join(root, "work", ".agents");
		const projectNested = join(projectFlat, "agents");
		const projectPreferred = join(root, "work", ".pi", "agents");

		await Promise.all([
			write(join(packageLow, "z-last.md"), definition("package-z")),
			write(join(packageLow, "a-first.md"), definition("package-a")),
			write(join(packageHigh, "package-high.md"), definition("package-high")),
			write(join(userOld, "user-old.md"), definition("user-old")),
			write(join(userNew, "user-new.md"), definition("user-new")),
			write(join(projectFlat, "project-flat.md"), definition("project-flat")),
			write(join(projectNested, "project-nested.md"), definition("project-nested")),
			write(join(projectPreferred, "project-preferred.md"), definition("project-preferred")),
			mkdir(cwd, { recursive: true }),
		]);

		assert.deepEqual(summary(await discoverDefinitionFiles({ cwd, home, packageDirs: [packageLow, packageHigh] })), [
			["a-first.md", "package", packageLow],
			["z-last.md", "package", packageLow],
			["package-high.md", "package", packageHigh],
			["user-old.md", "user", userOld],
			["user-new.md", "user", userNew],
			["project-flat.md", "project", projectFlat],
			["project-nested.md", "project", projectNested],
			["project-preferred.md", "project", projectPreferred],
		]);
	});

	it("uses the nearest project root", async () => {
		const outer = await caseDirectory("nearest");
		const inner = join(outer, "inner");
		const cwd = join(inner, "src", "feature");
		await Promise.all([
			write(join(outer, ".pi", "agents", "outer.md"), definition("outer")),
			write(join(inner, ".agents", "inner.md"), definition("inner")),
			mkdir(cwd, { recursive: true }),
		]);

		const files = await discoverDefinitionFiles({ cwd, home, userDirs: [] });
		assert.deepEqual(summary(files), [["inner.md", "project", join(inner, ".agents")]]);
	});

	it("stops before treating home as a project root", async () => {
		const isolatedHome = join(await caseDirectory("home-stop"), "fake-home");
		const cwd = join(isolatedHome, "work", "src");
		const userDir = join(isolatedHome, ".agents");
		await Promise.all([
			write(join(userDir, "home-agent.md"), definition("home-agent")),
			mkdir(cwd, { recursive: true }),
		]);

		const files = await discoverDefinitionFiles({ cwd, home: isolatedHome });
		assert.deepEqual(summary(files), [["home-agent.md", "user", userDir]]);
	});

	it("uses os.homedir when home is omitted without reading the real home", async () => {
		const defaultHome = join(await caseDirectory("default-home"), "home");
		const cwd = join(defaultHome, "work");
		const userDir = join(defaultHome, ".agents");
		await Promise.all([write(join(userDir, "default.md"), definition("default")), mkdir(cwd, { recursive: true })]);
		const previousHome = process.env.HOME;
		process.env.HOME = defaultHome;
		try {
			assert.deepEqual(summary(await discoverDefinitionFiles({ cwd })), [["default.md", "user", userDir]]);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("stops at the filesystem root when home is not an ancestor", async () => {
		const cwd = join(sandbox, "outside-home", "work");
		const unrelatedHome = join(sandbox, "unrelated-home");
		await Promise.all([mkdir(cwd, { recursive: true }), mkdir(unrelatedHome, { recursive: true })]);

		assert.deepEqual(await discoverDefinitionFiles({ cwd, home: unrelatedHome, userDirs: [], packageDirs: [] }), []);
	});

	it("loads only visible, non-chain Markdown files directly inside a directory", async () => {
		const root = await caseDirectory("filters");
		const packageDir = join(root, "package");
		await Promise.all([
			write(join(packageDir, "visible.md"), definition("visible")),
			write(join(packageDir, ".hidden.md"), definition("hidden")),
			write(join(packageDir, "workflow.chain.md"), definition("chain")),
			write(join(packageDir, "notes.txt"), definition("text")),
			write(join(packageDir, "nested", "deep.md"), definition("deep")),
			write(join(packageDir, "directory.md", "inside.md"), definition("inside")),
		]);
		await symlink(join(packageDir, "missing-target"), join(packageDir, "broken.md"));

		const files = await discoverDefinitionFiles({ cwd: root, home, userDirs: [], packageDirs: [packageDir] });
		assert.deepEqual(summary(files), [["visible.md", "package", packageDir]]);
	});

	it("deduplicates symlinks by real path and keeps the higher-precedence entry", async () => {
		const root = await caseDirectory("symlink");
		const packageDir = join(root, "package");
		const projectDir = join(root, "project", ".pi", "agents");
		const cwd = join(root, "project", "src");
		const source = await write(join(packageDir, "shared.md"), definition("shared"));
		await Promise.all([mkdir(projectDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
		await symlink(source, join(projectDir, "shared-link.md"));

		const files = await discoverDefinitionFiles({ cwd, home, userDirs: [], packageDirs: [packageDir] });
		assert.deepEqual(summary(files), [["shared-link.md", "project", projectDir]]);
		assert.equal(files[0]?.realPath, source);
	});
});

describe("loadDefinitions", () => {
	it("reports an unreadable directory and skips a missing directory", async () => {
		const root = await caseDirectory("unreadable");
		const notDirectory = await write(join(root, "not-a-directory"), "plain file");
		const missing = join(root, "missing");

		const result = await loadDefinitions({
			cwd: root,
			home,
			userDirs: [],
			packageDirs: [missing, notDirectory],
		});
		assert.deepEqual(result.definitions, []);
		assert.deepEqual(result.shadowed, []);
		assert.deepEqual(result.diagnostics, [
			{
				severity: "warning",
				code: "discovery-unreadable",
				path: "",
				message: `Cannot read definition directory "${notDirectory}".`,
				file: notDirectory,
			},
		]);
	});

	it("keeps loading after a parse failure and attaches parser diagnostics to their files", async () => {
		const root = await caseDirectory("parse-failure");
		const packageDir = join(root, "package");
		const invalid = await write(join(packageDir, "a-invalid.md"), definition("invalid", "services: [database]"));
		const warning = await write(join(packageDir, "b-warning.md"), definition("Warning_Name"));
		const valid = await write(join(packageDir, "c-valid.md"), definition("valid"));

		const result = await loadDefinitions({ cwd: root, home, userDirs: [], packageDirs: [packageDir] });
		assert.deepEqual(
			result.definitions.map(({ definition, file, origin, diagnostics }) => ({
				name: definition.name,
				file,
				origin,
				diagnostics,
			})),
			[
				{
					name: "Warning_Name",
					file: warning,
					origin: "package",
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
				{ name: "valid", file: valid, origin: "package", diagnostics: [] },
			],
		);
		assert.deepEqual(
			result.diagnostics.map(({ severity, code, path, file }) => ({ severity, code, path, file })),
			[
				{ severity: "error", code: "package-restriction", path: "services", file: invalid },
				{ severity: "warning", code: "name-spelling", path: "name", file: warning },
			],
		);
	});

	it("chooses winners for every origin pair and later directories within an origin", async () => {
		const root = await caseDirectory("shadowing");
		const cwd = join(root, "project", "src");
		const packageLow = join(root, "package-low");
		const packageHigh = join(root, "package-high");
		const userLow = join(root, "user-low");
		const userHigh = join(root, "user-high");
		const projectLow = join(root, "project", ".agents");
		const projectHigh = join(root, "project", ".pi", "agents");
		await Promise.all([
			write(join(packageLow, "package-user.md"), definition("package-user")),
			write(join(packageLow, "package-project.md"), definition("package-project")),
			write(join(packageLow, "within-package.md"), definition("within-package")),
			write(join(packageHigh, "within-package.md"), definition("within-package")),
			write(join(userLow, "package-user.md"), definition("package-user")),
			write(join(userLow, "user-project.md"), definition("user-project")),
			write(join(userLow, "within-user.md"), definition("within-user")),
			write(join(userHigh, "within-user.md"), definition("within-user")),
			write(join(projectLow, "package-project.md"), definition("package-project")),
			write(join(projectLow, "user-project.md"), definition("user-project")),
			write(join(projectLow, "within-project.md"), definition("within-project")),
			write(join(projectHigh, "within-project.md"), definition("within-project")),
			mkdir(cwd, { recursive: true }),
		]);

		const result = await loadDefinitions({
			cwd,
			home,
			packageDirs: [packageLow, packageHigh],
			userDirs: [userLow, userHigh],
		});
		assert.deepEqual(
			result.definitions.map(({ definition, origin, file }) => [definition.name, origin, file]),
			[
				["package-project", "project", join(projectLow, "package-project.md")],
				["package-user", "user", join(userLow, "package-user.md")],
				["user-project", "project", join(projectLow, "user-project.md")],
				["within-package", "package", join(packageHigh, "within-package.md")],
				["within-project", "project", join(projectHigh, "within-project.md")],
				["within-user", "user", join(userHigh, "within-user.md")],
			],
		);

		const expectedShadowed = [
			{
				name: "package-project",
				file: join(packageLow, "package-project.md"),
				by: join(projectLow, "package-project.md"),
			},
			{
				name: "package-user",
				file: join(packageLow, "package-user.md"),
				by: join(userLow, "package-user.md"),
			},
			{
				name: "within-package",
				file: join(packageLow, "within-package.md"),
				by: join(packageHigh, "within-package.md"),
			},
			{
				name: "user-project",
				file: join(userLow, "user-project.md"),
				by: join(projectLow, "user-project.md"),
			},
			{
				name: "within-user",
				file: join(userLow, "within-user.md"),
				by: join(userHigh, "within-user.md"),
			},
			{
				name: "within-project",
				file: join(projectLow, "within-project.md"),
				by: join(projectHigh, "within-project.md"),
			},
		];
		assert.deepEqual(result.shadowed, expectedShadowed);
		assert.deepEqual(
			result.diagnostics.map(({ severity, code, path, file, message }) => ({ severity, code, path, file, message })),
			expectedShadowed.map(({ name, file, by }) => ({
				severity: "hint",
				code: "definition-shadowed",
				path: name,
				file,
				message: `Definition "${name}" from "${file}" is shadowed by "${by}".`,
			})),
		);
	});
});

describe("same-folder ordering", () => {
	it("lets the file that sorts later by code point win a shared name, whatever the locale", async () => {
		const root = await caseDirectory("code-point");
		const agents = join(root, ".pi", "agents");
		await Promise.all([write(join(agents, "B.md"), definition("dup")), write(join(agents, "a.md"), definition("dup"))]);

		const result = await loadDefinitions({ cwd: root, home, userDirs: [], packageDirs: [] });

		assert.deepEqual(
			result.definitions.map(({ file }) => basename(file)),
			["a.md"],
		);
		assert.deepEqual(
			result.shadowed.map(({ file, by }) => [basename(file), basename(by)]),
			[["B.md", "a.md"]],
		);
	});
});
