import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTempRoot } from "../scripts/temp-root.mjs";

/** Restore TMPDIR exactly, including having been unset. */
function withTmpdir(value, run) {
	const had = Object.hasOwn(process.env, "TMPDIR");
	const previous = process.env.TMPDIR;
	if (value === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = value;
	try {
		return run();
	} finally {
		if (had) process.env.TMPDIR = previous;
		else delete process.env.TMPDIR;
	}
}

/**
 * What the fallback should return once TMPDIR has been rejected.
 *
 * Mirrors the contract: only the rejected variable is removed, so TMP and TEMP
 * keep the meaning os.tmpdir() gives them. Asserting against a bare os.tmpdir()
 * is not a test at all -- os.tmpdir() reads TMPDIR, so inside
 * withTmpdir(missing, ...) both sides returned the missing path and the
 * assertion held while the fallback was in fact broken.
 */
function expectedFallback() {
	const had = Object.hasOwn(process.env, "TMPDIR");
	const previous = process.env.TMPDIR;
	delete process.env.TMPDIR;
	try {
		return os.tmpdir();
	} finally {
		if (had) process.env.TMPDIR = previous;
	}
}

test("an unset TMPDIR leaves the platform default in force", () => {
	withTmpdir(undefined, () => {
		assert.equal(resolveTempRoot(), os.tmpdir());
	});
});

test("an empty TMPDIR falls back rather than resolving to the process directory", () => {
	withTmpdir("", () => {
		assert.equal(resolveTempRoot(), os.tmpdir());
	});
});

test("a writable TMPDIR directory is used", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "temp-root-writable-"));
	try {
		withTmpdir(dir, () => {
			assert.equal(resolveTempRoot(), dir);
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a TMPDIR that does not exist degrades to the platform default", () => {
	const missing = path.join(os.tmpdir(), `temp-root-missing-${process.pid}-${Date.now()}`);
	assert.equal(fs.existsSync(missing), false);
	withTmpdir(missing, () => {
		const resolved = resolveTempRoot();
		assert.equal(resolved, expectedFallback());
		assert.notEqual(resolved, missing, "a rejected TMPDIR must not come back as the answer");
		assert.equal(fs.existsSync(resolved), true, "the fallback must name a directory that exists");
	});
});

test("a TMPDIR naming a file rather than a directory degrades to the platform default", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "temp-root-file-"));
	const file = path.join(dir, "not-a-directory");
	fs.writeFileSync(file, "");
	try {
		withTmpdir(file, () => {
			const resolved = resolveTempRoot();
			assert.equal(resolved, expectedFallback());
			assert.notEqual(resolved, file, "a TMPDIR naming a file must not come back as the answer");
			assert.equal(fs.statSync(resolved).isDirectory(), true);
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
