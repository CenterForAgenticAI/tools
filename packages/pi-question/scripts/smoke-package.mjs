#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-question-smoke-"));
const consumerDirectory = join(temporaryDirectory, "consumer");

function run(command, args, cwd, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: temporaryDirectory,
			TMPDIR: temporaryDirectory,
			CI: "true",
			npm_config_userconfig: "/dev/null",
		},
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	return result.stdout;
}

try {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);
	const packOutput = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory], repoRoot, true);
	const [pack] = JSON.parse(packOutput);
	assert.ok(pack && typeof pack.filename === "string", "npm pack did not report one tarball");
	const packedFiles = new Set(pack.files.map((file) => file.path));
	for (const required of [
		"LICENSE",
		"dist/contract/index.d.ts",
		"dist/contract/index.js",
		"dist/contract/types.d.ts",
		"src/contract/types.ts",
		...packageJson.pi.extensions,
	]) {
		assert.ok(packedFiles.has(required.replace(/^\.\//, "")), `npm tarball is missing ${required}`);
	}

	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	const tarball = join(temporaryDirectory, pack.filename);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=peer", tarball], consumerDirectory);
	assert.equal(
		existsSync(join(consumerDirectory, "node_modules", "@earendil-works", "pi-coding-agent")),
		false,
		"pure contract proof must run without the Pi SDK installed",
	);

	const contractImport = `${packageJson.name}/contract`;
	writeFileSync(join(consumerDirectory, "contract.ts"), `
import { normalizeAskRequest, type Question } from ${JSON.stringify(contractImport)};
const question: Question = { id: "release", question: "Ship?", options: [{ label: "Yes" }] };
const result = normalizeAskRequest({ questions: [question] });
if (!result.ok || result.request.questions[0]?.id !== "release") throw new Error("contract normalization failed");
`);
	writeFileSync(join(consumerDirectory, "tsconfig.json"), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true},"include":["contract.ts"]}\n');
	run("tsc", ["-p", "tsconfig.json", "--pretty", "false"], consumerDirectory);

	const pureContractConsumer = `
import assert from "node:assert/strict";
import { normalizeAskRequest } from ${JSON.stringify(contractImport)};
const result = normalizeAskRequest({ id: "release", question: "Ship?", options: ["Yes"] });
assert.equal(result.ok, true);
assert.equal(result.ok && result.request.questions[0]?.options[0]?.label, "Yes");
console.log("smoke:contract ok");
`;
	const contractScript = join(consumerDirectory, "contract.mjs");
	writeFileSync(contractScript, pureContractConsumer);
	run("node", [contractScript], consumerDirectory);

	const peerPackages = Object.entries(packageJson.peerDependencies ?? {}).map(([name, range]) => `${name}@${range}`);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...peerPackages], consumerDirectory);

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
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
assert.deepEqual(result.errors, [], \`extension loader errors: \${JSON.stringify(result.errors)}\`);
assert.equal(result.extensions.length, 1);
assert.deepEqual([...result.extensions[0].tools.keys()], ["ask"]);
console.log("smoke:pi-entry ok");
`;
	const piScript = join(consumerDirectory, "pi-entry.mjs");
	writeFileSync(piScript, piConsumer);
	run("node", [piScript], consumerDirectory);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
