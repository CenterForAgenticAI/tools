import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pruneCoverageDirectory, pruneProcessCoverage } from "../scripts/prune-v8-coverage.mjs";

const repoFile = "file:///work/repo/.test-dist/src/a.js";
const otherRepoFile = "file:///work/repo/dist/b.js";
const dependency = "file:///work/repo/node_modules/pkg/index.js";

function script(url) {
	return { scriptId: "1", url, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }], isBlockCoverage: true }] };
}

test("pruning drops Node's own modules, evals, empty URLs and node_modules, and keeps repository files", () => {
	const pruned = pruneProcessCoverage({
		result: [script("node:fs"), script(""), script("[eval1]"), script(dependency), script(repoFile), script(otherRepoFile)],
		timestamp: 1,
	});
	assert.deepEqual(pruned.result.map((entry) => entry.url), [repoFile, otherRepoFile]);
	assert.deepEqual(pruned.result[0].functions, script(repoFile).functions);
});

test("pruning drops the source maps of removed scripts", () => {
	const pruned = pruneProcessCoverage({
		result: [script(repoFile), script(dependency)],
		"source-map-cache": { [repoFile]: { data: "repo" }, [dependency]: { data: "dependency" } },
	});
	assert.deepEqual(pruned["source-map-cache"], { [repoFile]: { data: "repo" } });
});

test("a directory keeps each source map only in the last file c8 reads it from, and leaves other files alone", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prune-v8-coverage-"));
	try {
		const names = ["coverage-1.json", "coverage-2.json", "coverage-3.json"];
		// Different contents per file: c8 merges the caches with Object.assign,
		// so the copy in the last file read is the one it uses.
		for (const [index, name] of names.entries()) {
			const sourceMaps = { [repoFile]: { data: `map-${index}` }, [dependency]: { data: "dependency" } };
			if (index === 0) sourceMaps[otherRepoFile] = { data: "only-first" };
			fs.writeFileSync(path.join(directory, name), JSON.stringify({ result: [script(repoFile), script("node:fs")], "source-map-cache": sourceMaps }));
		}
		fs.writeFileSync(path.join(directory, "notes.txt"), "not coverage");
		fs.writeFileSync(path.join(directory, "broken.json"), "{ not json");

		const { before, after } = pruneCoverageDirectory(directory);

		const order = fs.readdirSync(directory).filter((name) => names.includes(name));
		const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
		const merged = {};
		for (const name of order) Object.assign(merged, read(name)["source-map-cache"]);
		const last = order.at(-1);
		assert.deepEqual(merged, { [repoFile]: { data: `map-${names.indexOf(last)}` }, [otherRepoFile]: { data: "only-first" } });
		for (const name of order.slice(0, -1)) assert.equal(read(name)["source-map-cache"][repoFile], undefined, name);
		for (const name of order) assert.deepEqual(read(name).result.map((entry) => entry.url), [repoFile], name);
		assert.equal(fs.readFileSync(path.join(directory, "notes.txt"), "utf8"), "not coverage");
		assert.equal(fs.readFileSync(path.join(directory, "broken.json"), "utf8"), "{ not json");
		assert.ok(after < before, `${after} < ${before}`);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
