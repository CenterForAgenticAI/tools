import assert from "node:assert/strict";
import fs from "node:fs";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parsePayload, receiveAuth } from "../src/core/authsync.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

// Review round 3 of issue 9, filed as issue 27.
const payload = JSON.stringify({ schemaVersion: 1, entries: { openai: { type: "api_key", key: "sk-remote-API-SECRET" } } });
const ago = (path: string, ms: number): void => {
	const t = new Date(Date.now() - ms);
	utimesSync(path, t, t);
};

let s: Sandbox;
let shared: string;
let lock: string;
let breaker: string;
beforeEach(() => {
	s = sandbox();
	shared = join(s.home, "agent", "auth.json");
	lock = `${shared}.lock`;
	breaker = `${lock}.break`;
	// A stale Pi lock and a breaker left by a crashed taker.
	mkdirSync(lock);
	ago(lock, 10 * 60_000);
	writeFileSync(breaker, "");
	ago(breaker, 2 * 60_000);
});
afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	s.cleanup();
});

/** One taker: true when it wrote, false when it was refused because the lock is held. */
const attempt = (): boolean => {
	try {
		receiveAuth(s.l, "default", parsePayload(payload), { lockWaitMs: 150 });
		return true;
	} catch (error) {
		if (error instanceof Error && /locked by a running Pi/.test(error.message)) return false;
		throw error;
	}
};
const written = (): boolean => (JSON.parse(readFileSync(shared, "utf8")) as Record<string, unknown>).openai !== undefined;
const agent = (): string[] => readdirSync(join(s.home, "agent")).sort();
/** Run the code under test as if `ms` later, so files made now look that old. */
const later = (ms: number): void => {
	const now = Date.now.bind(Date);
	mock.method(Date, "now", () => now() + ms);
};

describe("CR-9-R3-BREAKRACE: a breaker stays on disk while a stale one is cleared", () => {
	it("three takers: at most one owns the breaker, and a fresh Pi lock survives", () => {
		const realOpen = fs.openSync;
		const realLink = fs.linkSync;
		const realRename = fs.renameSync;
		const realUnlink = fs.unlinkSync;
		const realRmdir = fs.rmdirSync;
		const stale = lstatSync(lock).ino;
		let cHolds = false;
		let cDone = false;
		let bRan = false;
		let cBreaker: number | undefined;
		let fresh: number | undefined;
		const second: string[] = [];
		// Taker C judged the lock stale too. It removes the lock while it is still
		// the one judged stale; then a Pi takes a fresh lock.
		const cBreaks = (): void => {
			cDone = true;
			if (lstatSync(lock, { throwIfNoEntry: false })?.ino === stale) realRmdir(lock);
			mkdirSync(lock);
			fresh = lstatSync(lock).ino;
		};
		// Taker A (the outer call) judged the old breaker stale. Before it moves it,
		// C clears that breaker and takes a fresh one of its own.
		const cSneaksIn = (src: fs.PathLike): void => {
			if (cBreaker !== undefined || String(src) !== breaker) return;
			realUnlink(breaker);
			writeFileSync(breaker, "", { flag: "wx" });
			cBreaker = lstatSync(breaker).ino;
			cHolds = true;
		};
		// Taker B looks whenever A has just changed a name: if C's breaker name is
		// empty, B takes the breaker.
		const bLooks = (): void => {
			if (!cHolds || bRan || lstatSync(breaker, { throwIfNoEntry: false }) !== undefined) return;
			bRan = true;
			attempt();
		};
		mock.method(fs, "linkSync", (src: fs.PathLike, dst: fs.PathLike): void => {
			cSneaksIn(src);
			realLink(src, dst);
			bLooks();
		});
		mock.method(fs, "renameSync", (src: fs.PathLike, dst: fs.PathLike): void => {
			cSneaksIn(src);
			realRename(src, dst);
			bLooks();
		});
		mock.method(fs, "unlinkSync", (path: fs.PathLike): void => {
			realUnlink(path);
			bLooks();
		});
		mock.method(fs, "openSync", (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number => {
			const fd = realOpen(path, flags, mode);
			if (cHolds && String(path) === breaker && typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) second.push("took the breaker C holds");
			return fd;
		});
		// A second owner that checked the lock before C removed it removes the fresh lock.
		mock.method(fs, "rmdirSync", (path: fs.PathLike, opts?: fs.RmDirOptions): void => {
			if (cHolds && !cDone && String(path) === lock) cBreaks();
			realRmdir(path, opts);
		});
		syncBuiltinESMExports();
		attempt();
		mock.restoreAll();
		syncBuiltinESMExports();
		if (!cDone) cBreaks();
		if (lstatSync(breaker, { throwIfNoEntry: false })?.ino === cBreaker) unlinkSync(breaker);
		assert.ok(cBreaker !== undefined, "the clearing was reached");
		assert.deepEqual(second, [], "at most one taker owns the breaker");
		assert.equal(lstatSync(lock, { throwIfNoEntry: false })?.ino, fresh, "the fresh Pi lock survives");
		assert.equal(written(), false, "nothing was written under a fresh Pi lock");
	});

	it("a breaker that changed after it was linked aside is kept", () => {
		const realLink = fs.linkSync;
		let fresh: number | undefined;
		mock.method(fs, "linkSync", (src: fs.PathLike, dst: fs.PathLike): void => {
			realLink(src, dst);
			if (fresh !== undefined || String(src) !== breaker) return;
			unlinkSync(breaker);
			writeFileSync(breaker, "", { flag: "wx" });
			fresh = lstatSync(breaker).ino;
		});
		syncBuiltinESMExports();
		assert.equal(attempt(), false);
		assert.equal(lstatSync(breaker, { throwIfNoEntry: false })?.ino, fresh, "the fresh breaker is kept");
		assert.ok(agent().includes("auth.json.lock"), "lock kept");
		assert.equal(agent().filter((n) => n.includes(".stale-")).length, 0, "aside name removed");
	});

	it("a breaker another taker is clearing is left to it", () => {
		const ino = lstatSync(breaker, { bigint: true }).ino;
		linkSync(breaker, `${breaker}.stale-${ino.toString(16)}`);
		assert.equal(attempt(), false);
		assert.equal(lstatSync(breaker, { bigint: true }).ino, ino, "breaker kept");
		assert.ok(agent().includes("auth.json.lock"), "lock kept");
		assert.equal(written(), false);
	});
});

describe("CR-9-R3-STALELEFT: leftovers of clearing a breaker", () => {
	it("regular files and empty folders named <lock>.break.stale-<hex> older than 60 s are removed", () => {
		const dir = join(s.home, "agent");
		writeFileSync(join(dir, "auth.json.lock.break.stale-0123456789ab"), "");
		mkdirSync(join(dir, "auth.json.lock.break.stale-abc"));
		const others = ["auth.json.lock.break.stale-", "auth.json.lock.break.stale-notes", "auth.json.lock.break.aside-abc", "other.lock.break.stale-abc"];
		for (const n of others) writeFileSync(join(dir, n), "");
		later(2 * 60_000);
		assert.equal(attempt(), true);
		assert.equal(written(), true);
		assert.deepEqual(agent().filter((n) => n.includes(".lock")), [...others].sort());
	});

	it("a leftover put aside less than 60 s ago is kept, however old its mtime", () => {
		// A hard link keeps the breaker's old mtime; the time it was put aside is its ctime.
		const left = join(s.home, "agent", "auth.json.lock.break.stale-0123456789ab");
		writeFileSync(left, "");
		ago(left, 10 * 60_000);
		assert.equal(attempt(), true);
		assert.ok(agent().includes("auth.json.lock.break.stale-0123456789ab"));
	});

	it("a symlink matching the pattern is not followed or removed", () => {
		const target = join(s.home, "target");
		writeFileSync(target, "keep");
		const link = join(s.home, "agent", "auth.json.lock.break.stale-def");
		symlinkSync(target, link);
		later(2 * 60_000);
		assert.equal(attempt(), true);
		assert.ok(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true, "link kept");
		assert.equal(readFileSync(target, "utf8"), "keep");
	});
});
