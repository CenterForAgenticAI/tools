import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repositoryCloneArgs } from "../scripts/acp-kernel-source.mjs";
import { relocateTest, sha256, verifyTestFile } from "../scripts/acp-kernel-tests-source.mjs";

function withVendorSandbox(run) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-provenance-check-"));
	try {
		fs.mkdirSync(path.join(temp, "scripts"));
		for (const name of ["acp-kernel-tests.mjs", "acp-kernel-tests-source.mjs", "acp-kernel-source.mjs"]) fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(temp, "scripts", name));
		fs.cpSync(new URL("./acp-kernel", import.meta.url), path.join(temp, "tests/acp-kernel"), { recursive: true });
		fs.symlinkSync(fs.realpathSync(new URL("../node_modules", import.meta.url)), path.join(temp, "node_modules"), "dir");
		run(temp, () => execFileSync(process.execPath, [path.join(temp, "scripts/acp-kernel-tests.mjs"), "--check"], { encoding: "utf8", timeout: 20_000, stdio: "pipe" }));
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

test("vendored CLI rejects a provenance commit other than the pin", () => {
	withVendorSandbox((temp, check) => {
		const file = path.join(temp, "tests/acp-kernel/provenance.json");
		const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
		manifest.commit = "0000000000000000000000000000000000000000";
		fs.writeFileSync(file, JSON.stringify(manifest));
		assert.throws(check, /test provenance is not pinned/u);
	});
});

test("vendored CLI rejects an unlisted test file", () => {
	withVendorSandbox((temp, check) => {
		fs.writeFileSync(path.join(temp, "tests/acp-kernel/unlisted.test.ts"), "// synthetic extra file\n");
		assert.throws(check, /vendored test inventory differs/u);
	});
});

// Offline: the independent online byte comparison is a separate CI step.
test("vendored kernel provenance matches the pinned inventory offline", () => {
	const output = execFileSync(process.execPath, ["scripts/acp-kernel-tests.mjs", "--check"], { encoding: "utf8", timeout: 20_000 });
	assert.match(output, /Kernel test provenance OK: 69 files, 21 exclusions, offline sha256 comparison/u);
});

const original = 'import { test } from "../src/compress.js";\nassert.equal(1, 1);\n';
const relocated = 'import { test } from "../../src/folds/kernel/compress.js";\nassert.equal(1, 1);\n';
const provenance = { file: "example.test.ts", sha256: sha256(relocated), upstreamSha256: sha256(original), changes: [{ from: "../src/compress.js", to: "../../src/folds/kernel/compress.js", count: 1 }] };

test("vendored tests permit only recorded import relocation", () => {
	assert.deepEqual(relocateTest(original), { text: relocated, changes: provenance.changes });
	assert.equal(verifyTestFile(relocated, provenance), original);
});

test("vendored tests reject an edited assertion even with an updated local checksum", () => {
	const changed = relocated.replace("assert.equal(1, 1)", "assert.equal(1, 2)");
	assert.throws(() => verifyTestFile(changed, { ...provenance, sha256: sha256(changed) }), /upstream sha256 mismatch/u);
});

test("vendored tests reject checksum drift and unrecorded imports", () => {
	assert.throws(() => verifyTestFile(`${relocated}\n`, provenance), /vendored sha256 mismatch/u);
	assert.throws(() => verifyTestFile(relocated, { ...provenance, changes: [{ ...provenance.changes[0], count: 2 }] }), /recorded import count mismatch/u);
});

test("kernel sync refuses a repository URL that could become a git option", () => {
	assert.throws(() => repositoryCloneArgs("--upload-pack=x", "checkout"), /repository must use https:\/\/github\.com\//u);
	assert.throws(() => repositoryCloneArgs("https://github.com.evil.example/repo", "checkout"), /repository must use/u);
	assert.throws(() => repositoryCloneArgs("ssh://github.com/repo", "checkout"), /repository must use/u);
});

test("kernel sync separates validated repository operands from clone options", () => {
	assert.deepEqual(repositoryCloneArgs("https://github.com/ranxianglei/acp-kernel.git", "checkout"),
		["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", "https://github.com/ranxianglei/acp-kernel.git", "checkout"]);
});
