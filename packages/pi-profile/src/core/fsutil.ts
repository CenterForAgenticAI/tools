import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read and parse JSON; `undefined` when the file does not exist. */
export function readJson(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${path} is not valid JSON`);
	}
}

/**
 * Replace `path` atomically: write a sibling temp file, fsync, rename over.
 * Never use this for a shared `auth.json` symlink target; renaming over a
 * symlink replaces the link itself.
 */
export function writeFileAtomic(path: string, text: string, mode = 0o600): void {
	const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(tmp, "wx", mode);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		chmodSync(tmp, mode);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`, mode);
}

/** `YYYYMMDD-HHMMSS` in UTC, for backup and trash names. */
export function stamp(now: Date = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}
