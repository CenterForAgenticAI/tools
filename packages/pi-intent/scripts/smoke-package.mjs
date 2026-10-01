import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTENT_DIR } from "../kit/intent-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "dist", "index.js");
const distTypes = join(repoRoot, "dist", "index.d.ts");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedCommands = ["intent-prereqs"];
const expectedSkills = ["compiled-intent", "intent-conformance", "intent-records"];
const expectedAgents = {
	"intent-lawyer": { model: "claude-opus-5-5", tools: ["read", "edit", "write"], skills: ["intent-records", "compiled-intent"] },
	"intent-prover": { model: "gpt-6.1-sol", tools: ["read", "bash", "edit", "write"], skills: ["compiled-intent", "intent-conformance"] },
	"intent-judge": { model: "gpt-6-astra", tools: ["read", "write"], skills: ["intent-records", "compiled-intent", "intent-conformance"] },
};
const expectedKit = ["gen-enums", "intent-check", "intent-conform", "intent-core", "intent-gate", "intent-receipt", "inventory"];
const expectedTemplates = ["conform.json", "records/0001-change.md", "model/LAWS.bend", "model/PROOF.bend", "model/laws.sha256", "model/neg/identity.bend", "receipts/example.json"];

if (!existsSync(distEntry) || !existsSync(distTypes)) {
	throw new Error("Build first: npm run build must create dist/index.js and dist/index.d.ts before the package smoke.");
}

const scratchDirectory = join(repoRoot, ".scratch");
mkdirSync(scratchDirectory, { recursive: true });
const temporaryDirectory = mkdtempSync(join(scratchDirectory, "pi-intent-smoke-"));
try {
	const { DefaultResourceLoader, SettingsManager, parseFrontmatter } = await import("@earendil-works/pi-coding-agent");
	const load = async (cwd, agent, extensionPath) => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(temporaryDirectory, agent),
			settingsManager: SettingsManager.inMemory({ packages: [] }),
			additionalExtensionPaths: [extensionPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		return loader.getExtensions();
	};

	const result = await load(repoRoot, "agent", repoRoot);
	assert.deepEqual(result.errors, [], `pi reported extension loader errors: ${JSON.stringify(result.errors)}`);
	assert.equal(result.extensions.length, 1, "pi should load exactly one extension from the package path");
	const [extension] = result.extensions;
	assert.equal(extension.resolvedPath, distEntry, "pi must resolve the compiled manifest entry");
	assert.deepEqual([...extension.commands.keys()], expectedCommands, "pi must load exactly the commands");

	const cli = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	const cliResult = spawnSync(cli, ["--no-extensions", "-e", repoRoot, "--help"], {
		cwd: repoRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(temporaryDirectory, "cli-agent") },
		encoding: "utf8",
		timeout: 30000,
	});
	if (cliResult.error) throw cliResult.error;
	assert.equal(cliResult.status, 0, `pi CLI path load failed:\n${cliResult.stderr}`);

	const packDirectory = join(temporaryDirectory, "pack");
	mkdirSync(packDirectory);
	// npm 10/11 print an array of records; npm 12 prints an object keyed by package name.
	const packJson = JSON.parse(
		execFileSync(npmExecutable, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], { cwd: repoRoot, encoding: "utf8", timeout: 60000 }),
	);
	const packRecord = Array.isArray(packJson) ? packJson[0] : Object.values(packJson)[0];
	assert.ok(packRecord?.filename, `npm pack --json gave no filename: ${JSON.stringify(packJson).slice(0, 200)}`);
	const tarball = join(packDirectory, packRecord.filename);
	const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30000 }).trim().split("\n");
	for (const required of ["package/package.json", "package/README.md", "package/LICENSE", "package/SPEC.md", "package/dist/index.js", "package/dist/index.d.ts", "package/bin/pi-intent.mjs", "package/kit/Lib.bend", "package/skills/compiled-intent/REFERENCE.md", ...expectedSkills.map(skill => `package/skills/${skill}/SKILL.md`), ...Object.keys(expectedAgents).map(name => `package/agents/${name}.md`), ...expectedKit.map(name => `package/kit/${name}.mjs`), ...expectedTemplates.map(name => `package/templates/${name}`)]) {
		assert.ok(entries.includes(required), `packed artifact is missing ${required}`);
	}
	for (const forbidden of ["package/src/", "package/tests/", "package/.test-dist/", "package/node_modules/"]) {
		assert.equal(entries.some((entry) => entry.startsWith(forbidden)), false, `packed artifact includes ${forbidden}`);
	}
	assert.equal(entries.some(entry => entry.includes("/target/") || entry.includes("/__pycache__/")), false, "packed examples must not contain generated build/cache files");
	const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8", timeout: 30000 }));
	assert.deepEqual(manifest.pi?.skills, ["./skills"], "packed manifest must advertise skills");
	assert.deepEqual(manifest["pi-delegate"]?.agents, ["./agents"], "packed manifest must advertise agents");
	assert.ok(manifest.files.includes("agents"), "agents must be published");
	for (const [name, expected] of Object.entries(expectedAgents)) {
		const text = execFileSync("tar", ["-xOf", tarball, `package/agents/${name}.md`], { encoding: "utf8", timeout: 30000 });
		const { frontmatter, body } = parseFrontmatter(text);
		assert.equal(frontmatter.name, name);
		assert.equal(frontmatter.model, expected.model);
		assert.deepEqual(frontmatter.tools, expected.tools);
		assert.deepEqual(frontmatter.skills, expected.skills);
		assert.equal(frontmatter.systemPromptMode, "replace");
		assert.equal(frontmatter.inheritProjectContext, true);
		assert.equal(frontmatter.inheritSkills, false);
		assert.ok(frontmatter.description && body.trim());
		if (name === "intent-judge") assert.match(frontmatter.description, /Advisory.*distinct.*kit\/intent-receipt\.mjs/);
	}
	console.log("agent smoke: packed manifest and frontmatter parsed; pi-delegate is a separately installed host package");
	assert.deepEqual(manifest.bin, { "pi-intent": "./bin/pi-intent.mjs" });
	assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], "pi-intent must not bundle or depend on other packages at runtime");

	const installDirectory = join(temporaryDirectory, "install");
	mkdirSync(installDirectory);
	writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
	execFileSync(npmExecutable, ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], { cwd: installDirectory, stdio: "pipe", timeout: 120000 });
	const installedRoot = join(installDirectory, "node_modules", "@caair", "pi-intent");
	assert.equal(existsSync(join(installedRoot, "node_modules")), false, "pi-intent must not carry nested dependencies");
	const installed = await load(installDirectory, "installed-agent", installedRoot);
	assert.deepEqual(installed.errors, [], `pi reported installed extension loader errors: ${JSON.stringify(installed.errors)}`);
	assert.equal(installed.extensions.length, 1, "pi should load the installed package");

	const artifactDirectory = join(temporaryDirectory, "artifact");
	mkdirSync(artifactDirectory);
	execFileSync("tar", ["-xzf", tarball, "-C", artifactDirectory], { timeout: 30000 });
	const packedRoot = join(artifactDirectory, "package");
	const packedLoader = new DefaultResourceLoader({
		cwd: packedRoot,
		agentDir: join(temporaryDirectory, "packed-agent"),
		settingsManager: SettingsManager.inMemory({ packages: [] }),
		additionalSkillPaths: [join(packedRoot, "skills")],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await packedLoader.reload();
	const discovered = packedLoader.getSkills();
	assert.deepEqual(discovered.diagnostics, [], `pi reported packed skill errors: ${JSON.stringify(discovered.diagnostics)}`);
	assert.deepEqual(discovered.skills.map(skill => skill.name).sort(), expectedSkills);
	const initializedApp = join(temporaryDirectory, "initialized-app");
	execFileSync(process.execPath, [join(installedRoot, "bin/pi-intent.mjs"), "init", initializedApp], { timeout: 30000 });
	assert.ok(existsSync(join(initializedApp, INTENT_DIR, "model/Lib.bend")), "packed init must copy Bend library");
	assert.ok(existsSync(join(initializedApp, INTENT_DIR, "tools/intent-check.mjs")), "packed bin must vendor checks");
	assert.equal(existsSync(join(initializedApp, "intent")), false, "packed init must not create a visible intent directory");
	assert.equal(existsSync(join(initializedApp, "tools")), false, "packed init must not create a top-level tools directory");
	console.log(`package smoke passed: pi resolved ${extension.resolvedPath}; packed ${packRecord.filename}; discovered ${expectedSkills.join(", ")}`);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
