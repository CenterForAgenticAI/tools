#!/usr/bin/env node
// Packs the package and checks what a user would install: the built entry is
// present, development files are not, the built code does not hard-code the
// package's own scope, and an install in a clean project can import and call it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function cleanNpmEnv() {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEntries = JSON.parse(fs.readFileSync(path.join(repoRoot, "fixtures", "manifest.json"), "utf8"));
const expectedParseChecks = fixtureEntries.filter(({ expect }) => expect !== "converter").length;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-definitions-package-smoke-"));

try {
	const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const parsedPack = JSON.parse(packOutput);
	const [pack] = Array.isArray(parsedPack) ? parsedPack : Object.values(parsedPack ?? {});
	if (!pack?.filename) throw new Error(`Unexpected npm pack output: ${packOutput}`);
	const tarball = path.resolve(tmp, pack.filename);

	const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	const required = [
		"package/package.json",
		"package/README.md",
		"package/dist/index.js",
		"package/dist/index.d.ts",
		"package/dist/conformance.js",
		"package/dist/conformance.d.ts",
		"package/dist/pi-durable.js",
		"package/dist/pi-durable.d.ts",
		"package/dist/bin.js",
		"package/schema/agent-definition.schema.json",
		"package/fixtures/manifest.json",
		...fixtureEntries.map(({ file }) => `package/fixtures/${file}`),
	];
	const missing = required.filter((entry) => !listed.includes(entry));
	if (missing.length > 0) throw new Error(`Packed artifact is missing: ${missing.join(", ")}`);
	const forbidden = listed.filter((entry) => /^package\/(src\/|tests\/|scripts\/|docs\/|\.)/.test(entry));
	if (forbidden.length > 0)
		throw new Error(`Packed artifact contains development-only entries: ${forbidden.join(", ")}`);

	// A fork or a rename must need no code change, so the built code may not
	// name the scope it is published under. The README and package.json may.
	const scope = `${pack.name.slice(0, pack.name.indexOf("/"))}/`;
	const extractDir = path.join(tmp, "extract");
	fs.mkdirSync(extractDir);
	execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);
	const scoped = listed.filter(
		(entry) =>
			entry.startsWith("package/dist/") && fs.readFileSync(path.join(extractDir, entry), "utf8").includes(scope),
	);
	if (scoped.length > 0) throw new Error(`Built files hard-code the ${scope} scope: ${scoped.join(", ")}`);

	const project = path.join(tmp, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(
		path.join(project, "package.json"),
		JSON.stringify({ name: "smoke", private: true, type: "module" }),
	);
	execFileSync("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], {
		// Drop npm_config_* inherited from `npm run`: they turn this into a
		// project-scoped install of this package itself, which npm refuses.
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
		env: cleanNpmEnv(),
	});

	// Import by package name, so the exports map is what resolves the entry.
	const probe = [
		`import { parseDefinition, splitFrontmatter } from ${JSON.stringify(pack.name)};`,
		`import { runConformance } from ${JSON.stringify(`${pack.name}/conformance`)};`,
		`import { lowerToPiDurable } from ${JSON.stringify(`${pack.name}/pi-durable`)};`,
		`import schema from ${JSON.stringify(`${pack.name}/schema.json`)} with { type: "json" };`,
		`const split = splitFrontmatter("---\\nname: smoke\\n---\\nBody\\n");`,
		`if (!split.ok || split.frontmatter !== "name: smoke" || split.body !== "Body\\n") {`,
		`	throw new Error("unexpected split result: " + JSON.stringify(split));`,
		`}`,
		`const parsed = parseDefinition("---\\nname: smoke\\ndescription: Smoke test.\\n---\\nBody\\n");`,
		`const report = await runConformance({ name: "package-smoke", parse: parseDefinition }, { level: "parses" });`,
		`if (!report.passed || report.checked !== ${expectedParseChecks}) {`,
		`\tthrow new Error("unexpected conformance result: " + JSON.stringify(report));`,
		`}`,
		`if (!parsed.ok || parsed.definition.name !== "smoke" || schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {`,
		`	throw new Error("unexpected package API result: " + JSON.stringify(parsed));`,
		`}`,
		`const lowered = lowerToPiDurable(parsed.definition, { parentModel: "test/model", parentTools: ["read"], enforcedBy: ["agents"] });`,
		`if (!lowered.ok || lowered.input.model.modelId !== "model") {`,
		`	throw new Error("unexpected pi-durable result: " + JSON.stringify(lowered));`,
		`}`,
	].join("\n");
	execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
	});

	// The installed command must run through npm's bin link.
	fs.writeFileSync(path.join(project, "smoke.md"), "---\nname: smoke\ndescription: Smoke test.\n---\nBody\n");
	const lintOutput = execFileSync(
		path.join(project, "node_modules", ".bin", "agent-definitions"),
		["lint", "smoke.md"],
		{
			cwd: project,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (!lintOutput.startsWith("1 files, 0 errors")) throw new Error(`unexpected lint output: ${lintOutput}`);

	console.log(`package smoke ok: ${listed.length} entries, installed and imported by name, command ran`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
