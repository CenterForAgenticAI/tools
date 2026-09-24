import fs from "node:fs";
import os from "node:os";

/**
 * Resolve the root for a gate script's throwaway working directory.
 *
 * `pack:check` and `pi:compat` each unpack a complete consumer npm install.
 * On a host where `/tmp` is `tmpfs` that install competes with memory and
 * fails with ENOSPC, which reads as a test or packaging fault rather than an
 * environment one. Honouring TMPDIR lets an operator move that work to
 * disk-backed storage without changing what runs.
 *
 * TMPDIR is used only when it names an existing writable directory, so a
 * stale or misspelled value degrades to `os.tmpdir()` instead of failing the
 * gate for an unrelated reason. When it is unset, behaviour is exactly as
 * before -- CI, where /tmp is ordinary disk, is unaffected.
 */
export function resolveTempRoot() {
	const configured = process.env.TMPDIR;
	if (typeof configured === "string" && configured.length > 0) {
		try {
			fs.accessSync(configured, fs.constants.W_OK);
			if (fs.statSync(configured).isDirectory()) return configured;
		} catch {
			// Fall through to the platform default.
		}
	}
	return fallbackTempDir();
}

/**
 * The temp directory to use once TMPDIR has been rejected.
 *
 * os.tmpdir() reads TMPDIR, TMP and TEMP in that order, so returning it after
 * rejecting TMPDIR handed back the value just rejected: the degrade above never
 * happened, and a stale TMPDIR reached mkdtempSync as an ENOENT. The test that
 * should have caught it asserted resolveTempRoot() === os.tmpdir(), which is
 * true of the rejected value too, so it passed while proving nothing.
 *
 * Only the rejected variable is removed, so TMP and TEMP keep the meaning
 * os.tmpdir() gives them. Should that answer be unusable as well, everything is
 * cleared and the platform's own default is taken.
 */
function fallbackTempDir() {
	const next = withoutEnv(["TMPDIR"], () => os.tmpdir());
	if (isUsableDirectory(next)) return next;
	return withoutEnv(["TMPDIR", "TMP", "TEMP"], () => os.tmpdir());
}

/** Run `read` with the named variables unset, restoring them afterwards. */
function withoutEnv(keys, read) {
	const saved = {};
	for (const key of keys) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		return read();
	} finally {
		for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
	}
}

/** A writable directory, or not. */
function isUsableDirectory(value) {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		fs.accessSync(value, fs.constants.W_OK);
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}
