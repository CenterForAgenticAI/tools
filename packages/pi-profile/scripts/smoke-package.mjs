#!/usr/bin/env node
// Pack the package, install it into a scratch project, and check the CLI and the Pi entry point.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-profile-smoke-"));
const consumerDirectory = join(temporaryDirectory, "consumer");

function run(command, args, cwd, extraEnv = {}) {
	const result = spawnSync(command, args, {
		cwd,
		env: { PATH: process.env.PATH, HOME: temporaryDirectory, TMPDIR: temporaryDirectory, CI: "true", npm_config_userconfig: "/dev/null", ...extraEnv },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	return result.stdout;
}

try {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const [pack] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory], repoRoot));
	const packed = new Set(pack.files.map((file) => file.path));
	for (const required of ["LICENSE", "README.md", "bin/pi-profile.mjs", "dist/cli/main.js", "dist/index.js", ...packageJson.pi.extensions]) {
		assert.ok(packed.has(required.replace(/^\.\//, "")), `npm tarball is missing ${required}`);
	}
	for (const file of packed) assert.ok(!file.startsWith("tests/") && !file.startsWith("model/"), `npm tarball should not ship ${file}`);

	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	const tarball = join(temporaryDirectory, pack.filename);
	const peers = Object.entries(packageJson.peerDependencies ?? {}).map(([name, range]) => `${name}@${range}`);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, ...peers], consumerDirectory);

	// The CLI works from the built output against an empty home.
	const piHome = join(temporaryDirectory, "pi-home");
	const bin = join(consumerDirectory, "node_modules", ".bin", "pi-profile");
	const env = { PI_PROFILE_HOME: piHome, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
	run(bin, ["create", "smoke", "--auth", "separate"], consumerDirectory, env);
	assert.match(run(bin, ["list"], consumerDirectory, env), /smoke/);
	assert.match(run(bin, ["env", "--shell", "bash", "--", "smoke"], consumerDirectory, env), /export PI_PROFILE_LABEL='smoke'/);
	console.log("smoke:cli ok");

	const piConsumer = `
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
const packageRoot = fileURLToPath(new URL(".", import.meta.resolve(${JSON.stringify(`${packageJson.name}/package.json`)})));
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: ${JSON.stringify(join(temporaryDirectory, "agent"))},
  settingsManager: SettingsManager.inMemory({ packages: [] }),
  additionalExtensionPaths: [packageRoot],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
assert.deepEqual(result.errors, [], \`extension loader errors: \${JSON.stringify(result.errors)}\`);
assert.equal(result.extensions.length, 1);
assert.deepEqual([...result.extensions[0].commands.keys()], ["profile"]);
console.log("smoke:pi-entry ok");
`;
	const piScript = join(consumerDirectory, "pi-entry.mjs");
	writeFileSync(piScript, piConsumer);
	console.log(run("node", [piScript], consumerDirectory).trim());
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
