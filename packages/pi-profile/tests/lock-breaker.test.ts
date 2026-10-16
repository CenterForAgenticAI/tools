import assert from "node:assert/strict";
import fs from "node:fs";
import { linkSync, lstatSync, mkdirSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BREAKER_ASIDE_STALE_MS, BREAKER_STALE_MS, LOCK_FILE, removeStaleBreaker, withProfileLock } from "../src/core/lock.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

// issue 38: the profile lock's breaker is cleared by link-aside, so
// its name is never empty while another taker could look.

const DEAD_LOCK = "2147483646 dead\n";
const DEAD_BREAKER = "2147483645 crashed\n";

let s: Sandbox;
let dir: string;
let lock: string;
let breaker: string;
beforeEach(() => {
	s = sandbox();
	dir = join(s.home, "d");
	mkdirSync(dir, { recursive: true });
	lock = join(dir, LOCK_FILE);
	breaker = `${lock}.break`;
	// A stale profile lock and a breaker left by a crashed taker.
	writeFileSync(lock, DEAD_LOCK);
	writeFileSync(breaker, DEAD_BREAKER);
	const t = (Date.now() - BREAKER_STALE_MS - 5000) / 1000;
	utimesSync(breaker, t, t);
});
afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	s.cleanup();
});

/** Call `look` after every link, rename and unlink, as a taker running alongside would. */
function watch(look: () => void): void {
	const realLink = fs.linkSync;
	const realRename = fs.renameSync;
	const realUnlink = fs.unlinkSync;
	mock.method(fs, "linkSync", (src: fs.PathLike, dst: fs.PathLike): void => {
		realLink(src, dst);
		look();
	});
	mock.method(fs, "renameSync", (src: fs.PathLike, dst: fs.PathLike): void => {
		realRename(src, dst);
		look();
	});
	mock.method(fs, "unlinkSync", (path: fs.PathLike): void => {
		realUnlink(path);
		look();
	});
	syncBuiltinESMExports();
}

function unwatch(): void {
	mock.restoreAll();
	syncBuiltinESMExports();
}

const dirNames = (): string[] => readdirSync(dir).sort();

describe("issue 38: three takers and a stale profile-lock breaker", () => {
	it("the breaker name is never empty while a taker can look, and a fresh breaker is kept", () => {
		let cBreaker: bigint | undefined;
		let bRan = false;
		const empty: string[] = [];
		const second: string[] = [];
		// Taker A judged the old breaker stale. Before A clears it, taker C clears
		// it and takes a fresh breaker of its own.
		const afterJudged = (): void => {
			unlinkSync(breaker);
			writeFileSync(breaker, `${String(process.ppid)} c\n`, { flag: "wx" });
			cBreaker = lstatSync(breaker, { bigint: true }).ino;
			watch(bLooks);
		};
		// Taker B looks whenever A changes a name. If C's breaker name is empty,
		// B takes the breaker and breaks the stale lock under C.
		function bLooks(): void {
			if (bRan || lstatSync(breaker, { throwIfNoEntry: false }) !== undefined) return;
			bRan = true;
			empty.push("breaker name empty while C holds it");
			unwatch();
			try {
				withProfileLock(dir, () => second.push("B broke the lock while C held the breaker"));
			} catch {
				// refused: the breaker was back in place
			}
		}
		const cleared = removeStaleBreaker(dir, { afterJudged });
		unwatch();
		assert.ok(cBreaker !== undefined, "the clearing was reached");
		assert.deepEqual(empty, [], "the breaker name is never empty");
		assert.deepEqual(second, [], "at most one taker owns the breaker");
		assert.equal(cleared, false, "A did not clear C's breaker");
		assert.equal(lstatSync(breaker, { bigint: true, throwIfNoEntry: false })?.ino, cBreaker, "C's breaker is kept");
		assert.deepEqual(dirNames(), [LOCK_FILE, `${LOCK_FILE}.break`], "no aside name is left");
	});

	it("at most one of three takers that judged the same breaker clears it", () => {
		const results: string[] = [];
		let looked = false;
		// B and C judged the same breaker. They look while A is clearing it.
		const others = (): void => {
			if (looked) return;
			looked = true;
			if (lstatSync(breaker, { throwIfNoEntry: false }) === undefined) results.push("breaker name empty during clearing");
			unwatch();
			for (const taker of ["B", "C"]) if (removeStaleBreaker(dir)) results.push(`${taker} cleared it`);
		};
		watch(others);
		const aCleared = removeStaleBreaker(dir);
		unwatch();
		assert.equal(aCleared, true, "A cleared the breaker");
		assert.deepEqual(results, [], "only A cleared it, and its name was never empty");
		assert.equal(lstatSync(breaker, { throwIfNoEntry: false }), undefined);
		assert.deepEqual(dirNames(), [LOCK_FILE], "no aside name is left");
		assert.equal(withProfileLock(dir, () => "ran"), "ran");
	});

	it("a breaker another taker is clearing is left to it", () => {
		const ino = lstatSync(breaker, { bigint: true }).ino;
		const aside = `${breaker}.stale-${ino.toString(16)}`;
		linkSync(breaker, aside);
		assert.equal(removeStaleBreaker(dir), false);
		assert.equal(lstatSync(breaker, { bigint: true }).ino, ino, "breaker kept");
		assert.equal(lstatSync(aside, { bigint: true }).ino, ino, "the other taker's aside name kept");
	});

	it("leftovers of a crashed clearing older than 60 s are swept, other names kept", () => {
		const old = `${breaker}.stale-0123456789ab`;
		const others = [`${breaker}.stale-`, `${breaker}.stale-notes`, `${breaker}.aside-abc`];
		writeFileSync(old, "");
		for (const name of others) writeFileSync(name, "");
		// ctime cannot be set back: run as if a little over 60 s later.
		const now = Date.now.bind(Date);
		mock.method(Date, "now", () => now() + BREAKER_ASIDE_STALE_MS + 1000);
		assert.equal(removeStaleBreaker(dir), true);
		mock.restoreAll();
		assert.equal(lstatSync(old, { throwIfNoEntry: false }), undefined, "old leftover swept");
		for (const name of others) assert.ok(lstatSync(name, { throwIfNoEntry: false }) !== undefined, `${name} kept`);
	});

	it("a leftover put aside less than 60 s ago is kept", () => {
		const young = `${breaker}.stale-abc`;
		writeFileSync(young, "");
		assert.equal(removeStaleBreaker(dir), true);
		assert.ok(lstatSync(young, { throwIfNoEntry: false }) !== undefined, "young leftover kept");
	});
});
