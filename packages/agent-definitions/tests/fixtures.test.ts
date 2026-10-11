import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { splitFrontmatter } from "../src/index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = resolve(repositoryRoot, "fixtures");
const manifestPath = resolve(fixturesRoot, "manifest.json");
const sha256Pattern = /^[0-9a-f]{64}$/;
const expectationKinds = new Set(["valid", "invalid", "converter"]);
const entryKeys = new Set(["file", "source", "sample", "options", "expect", "errors", "warnings", "values"]);
const sourceKeys = new Set(["url", "package", "path", "commit", "licence", "sha256"]);
const packageNamePattern = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

interface DiagnosticExpectation {
	path: string;
}

interface SourceExpectation {
	url?: string;
	package?: string;
	path: string;
	commit?: string;
	licence?: string;
	sha256: string;
}

interface FixtureEntry {
	file: string;
	source?: SourceExpectation;
	sample?: "q4";
	options?: { origin: string };
	expect: "valid" | "invalid" | "converter";
	errors?: DiagnosticExpectation[];
	warnings?: DiagnosticExpectation[];
	values?: Record<string, unknown>;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(record)) assert(allowed.has(key), `${label} has unknown key ${key}`);
}

function assertDiagnostics(value: unknown, label: string): asserts value is DiagnosticExpectation[] {
	assert(Array.isArray(value), `${label} must be an array`);
	for (const [index, diagnostic] of value.entries()) {
		assertRecord(diagnostic, `${label}[${index}]`);
		assert.deepEqual(Object.keys(diagnostic), ["path"]);
		assert.equal(typeof diagnostic.path, "string");
	}
}

function assertManifestEntry(value: unknown, index: number): asserts value is FixtureEntry {
	const label = `manifest[${index}]`;
	assertRecord(value, label);
	assertOnlyKeys(value, entryKeys, label);
	assert(typeof value.file === "string", `${label}.file must be a string`);
	assert(
		!value.file.startsWith("/") && !value.file.split("/").includes(".."),
		`${label}.file must stay under fixtures`,
	);
	assert(typeof value.expect === "string", `${label}.expect must be a string`);
	assert(expectationKinds.has(value.expect), `${label}.expect is not recognised`);

	if (value.source !== undefined) {
		assertRecord(value.source, `${label}.source`);
		assertOnlyKeys(value.source, sourceKeys, `${label}.source`);
		assert(typeof value.source.path === "string");
		assert(typeof value.source.sha256 === "string");
		assert(sha256Pattern.test(value.source.sha256));
		assert.notEqual(
			value.source.url === undefined,
			value.source.package === undefined,
			`${label}.source needs exactly one of url or package`,
		);
		if (value.source.url !== undefined) {
			assert(typeof value.source.url === "string" && value.source.url.startsWith("https://"), `${label}.source.url`);
			assert(typeof value.source.commit === "string", `${label}.source.url needs the commit it is pinned to`);
			assert(value.source.url.includes(value.source.commit), `${label}.source.url must contain its commit`);
		}
		if (value.source.package !== undefined) {
			assert(typeof value.source.package === "string", `${label}.source.package`);
			assert.match(value.source.package, packageNamePattern, `${label}.source.package`);
		}
		for (const key of ["url", "package", "commit", "licence"] as const) {
			if (value.source[key] !== undefined) assert.equal(typeof value.source[key], "string");
		}
	}
	if (value.sample !== undefined) assert.equal(value.sample, "q4");
	if (value.options !== undefined) {
		assertRecord(value.options, `${label}.options`);
		assert.deepEqual(Object.keys(value.options), ["origin"]);
		assert.equal(typeof value.options.origin, "string");
	}
	if (value.errors !== undefined) assertDiagnostics(value.errors, `${label}.errors`);
	if (value.warnings !== undefined) assertDiagnostics(value.warnings, `${label}.warnings`);
	if (value.values !== undefined) assertRecord(value.values, `${label}.values`);
	if (value.expect === "invalid") assert((value.errors?.length ?? 0) > 0, `${label} needs an error path`);
	if (value.expect !== "invalid") assert.equal(value.errors, undefined, `${label} may not declare errors`);
}

async function loadManifest(): Promise<FixtureEntry[]> {
	const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
	assert(Array.isArray(parsed), "manifest must be an array");
	for (const [index, entry] of parsed.entries()) assertManifestEntry(entry, index);
	return parsed;
}

async function fixtureFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await fixtureFiles(path)));
		else if (entry.isFile()) files.push(relative(fixturesRoot, path).split(sep).join("/"));
	}
	return files;
}

describe("fixture corpus", () => {
	it("has a well-formed expectations manifest", async () => {
		const manifest = await loadManifest();
		assert(manifest.length > 0);
		assert.equal(new Set(manifest.map(({ file }) => file)).size, manifest.length, "fixture paths must be unique");
	});

	it("has one manifest entry for every fixture file and no missing entries", async () => {
		const manifest = await loadManifest();
		const declared = manifest.map(({ file }) => file).sort();
		for (const file of declared) assert((await stat(resolve(fixturesRoot, file))).isFile(), `${file} must exist`);
		const present = (await fixtureFiles(fixturesRoot))
			.filter((file) => file !== "README.md" && file !== "manifest.json")
			.sort();
		assert.deepEqual(declared, present);
	});

	it("keeps every copied fixture byte-identical to its recorded source", async () => {
		for (const entry of await loadManifest()) {
			if (entry.source === undefined) continue;
			const contents = await readFile(resolve(fixturesRoot, entry.file));
			assert.equal(createHash("sha256").update(contents).digest("hex"), entry.source.sha256, entry.file);
		}
	});

	it("splits every fenced fixture and rejects only missing-opening-fence fixtures", async () => {
		for (const entry of await loadManifest()) {
			const source = await readFile(resolve(fixturesRoot, entry.file), "utf8");
			const expectedSplitFailure = entry.errors?.some(({ path }) => path === "") ?? false;
			assert.equal(splitFrontmatter(source).ok, !expectedSplitFailure, entry.file);
		}
	});
});
