import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inspectAuth, setAuthMode } from "../src/core/auth.ts";
import { validateEnv } from "../src/core/env.ts";
import { withProfileLock, LockBusy, LOCK_FILE } from "../src/core/lock.ts";
import { applyGroup, multiAccountConfigPath, readMultiAccount } from "../src/core/multi-account.ts";
import { createProfile, loadProfile, updateManifest } from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { shellInit } from "../src/cli/shell.ts";
import { placeNoClobber, readSnapshot, replaceIfUnchanged } from "../src/core/swap.ts";
import { sandbox, saveManifest, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const shared = (): string => join(s.home, "agent", "auth.json");
const backups = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith("auth.json.bak-")).sort();
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe("CR-AUTH-BACKUP-COLLISION: backups never overwrite each other", () => {
	it("two switches to shared in the same second keep both credentials", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		writeFileSync(p, '{"cred":"A"}\n');
		setAuthMode(info.dir, shared(), "shared");
		setAuthMode(info.dir, shared(), "separate");
		writeFileSync(p, '{"cred":"B"}\n');
		setAuthMode(info.dir, shared(), "shared");
		const found = backups(info.dir).map((n) => readFileSync(join(info.dir, n), "utf8")).sort();
		assert.deepEqual(found, ['{"cred":"A"}\n', '{"cred":"B"}\n']);
	});
});

describe("CR-AUTH-PERMISSIONS: private auth files end at 0600", () => {
	it("a 0644 separate file is made 0600 when the mode is saved", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		chmodSync(p, 0o644);
		setAuthMode(info.dir, shared(), "pooled");
		assert.equal(modeOf(p), 0o600);
	});
	it("a 0644 file is backed up as 0600 when switching to shared", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		chmodSync(join(info.dir, "auth.json"), 0o644);
		setAuthMode(info.dir, shared(), "shared");
		const [b] = backups(info.dir);
		assert.ok(b !== undefined);
		assert.equal(modeOf(join(info.dir, b)), 0o600);
	});
	it("never changes the mode of the shared file through the link", () => {
		chmodSync(shared(), 0o640);
		const info = createProfile(s.l, "p");
		setAuthMode(info.dir, shared(), "shared");
		assert.equal(modeOf(shared()), 0o640);
	});
});

describe("CR-AUTH-TOCTOU: a concurrent change is refused, not destroyed", () => {
	it("a private file that replaces the link after inspection survives", () => {
		const info = createProfile(s.l, "p");
		const p = join(info.dir, "auth.json");
		assert.equal(inspectAuth(info.dir).kind, "link");
		const swap = (): void => {
			unlinkSync(p);
			writeFileSync(p, '{"other":"process"}\n', { mode: 0o600 });
		};
		assert.throws(() => setAuthMode(info.dir, shared(), "separate", false, { afterInspect: swap }), /changed while pi-profile/);
		assert.equal(readFileSync(p, "utf8"), '{"other":"process"}\n');
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.endsWith(".tmp")), []);
	});
	it("a file swapped for another file before backup is not replaced", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		const swap = (): void => {
			writeFileSync(`${p}.new`, '{"other":1}\n', { mode: 0o600 });
			renameSync(`${p}.new`, p);
		};
		assert.throws(() => setAuthMode(info.dir, shared(), "shared", false, { afterInspect: swap }), /changed while pi-profile/);
		assert.equal(readFileSync(p, "utf8"), '{"other":1}\n');
		assert.deepEqual(backups(info.dir), []);
	});
	it("a file that appears where none was is not overwritten", () => {
		const dir = join(s.home, "profiles", "bare");
		mkdirSync(dir, { recursive: true });
		const p = join(dir, "auth.json");
		const appear = (): void => writeFileSync(p, '{"new":1}\n', { mode: 0o600 });
		assert.throws(() => setAuthMode(dir, shared(), "separate", false, { afterInspect: appear }), /changed while pi-profile/);
		assert.equal(readFileSync(p, "utf8"), '{"new":1}\n');
	});
	it("a second process is refused while the profile lock is held", () => {
		const info = createProfile(s.l, "p");
		// A live PID that is not ours: the test runner's parent.
		writeFileSync(join(info.dir, LOCK_FILE), `${process.ppid}\n`);
		assert.throws(() => setAuthMode(info.dir, shared(), "separate"), Refusal);
		assert.equal(inspectAuth(info.dir).kind, "link");
	});
	it("a stale lock from a dead process is cleared", () => {
		const info = createProfile(s.l, "p");
		writeFileSync(join(info.dir, LOCK_FILE), "2147483646\n");
		setAuthMode(info.dir, shared(), "separate");
		assert.equal(inspectAuth(info.dir).kind, "file");
		assert.equal(existsSync(join(info.dir, LOCK_FILE)), false);
	});
	it("the lock is re-entrant and released after an error", () => {
		const info = createProfile(s.l, "p");
		assert.throws(() => withProfileLock(info.dir, () => withProfileLock(info.dir, () => {
			throw new Error("boom");
		})), /boom/);
		assert.equal(existsSync(join(info.dir, LOCK_FILE)), false);
	});
});

describe("CR-ENV-SYMLINK-ESCAPE: path values cannot leave the profile through a link", () => {
	for (const key of ["PI_MEMORY_DIR", "ACP_LOG_FILE", "ACP_UPDATE_THROTTLE_FILE"]) {
		it(`${key} through an in-profile symlink to outside is refused`, () => {
			const info = createProfile(s.l, "p");
			const outside = mkdtempSync(join(tmpdir(), "pi-profile-outside-"));
			try {
				symlinkSync(outside, join(info.dir, "memory"));
				const direct = validateEnv({ [key]: join(info.dir, "memory") }, info.dir);
				const nested = validateEnv({ [key]: join(info.dir, "memory", "x", "log") }, info.dir);
				assert.equal(direct.ok, false);
				assert.equal(nested.ok, false);
				assert.throws(() => saveManifest(s.l, "p", { ...info.manifest, env: { [key]: join(info.dir, "memory") } }), Refusal);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	}
	it("a real directory and a not-yet-created path are still allowed", () => {
		const info = createProfile(s.l, "p");
		mkdirSync(join(info.dir, "memory"));
		assert.equal(validateEnv({ PI_MEMORY_DIR: join(info.dir, "memory"), ACP_LOG_FILE: join(info.dir, "logs", "acp.log") }, info.dir).ok, true);
	});
	it("a profile directory that is itself a link may still be used", () => {
		const real = createProfile(s.l, "real");
		const alias = join(s.home, "profiles", "alias");
		symlinkSync(real.dir, alias);
		assert.equal(validateEnv({ PI_MEMORY_DIR: join(alias, "memory") }, alias).ok, true);
	});
});

describe("CR-EDIT-PARTIAL-APPLY: a failed save changes nothing", () => {
	function withGroups(): ReturnType<typeof createProfile> {
		const info = createProfile(s.l, "p");
		mkdirSync(join(info.dir, "pi-multi-account"));
		writeFileSync(
			join(info.dir, "pi-multi-account", "config.json"),
			JSON.stringify({ accountGroups: { a: ["1"], b: ["2"] }, defaultAccountGroup: "a" }),
		);
		return saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "a" } });
	}
	it("a failing auth step restores the group (reviewer's case)", () => {
		const info = withGroups();
		const cfg = readFileSync(join(info.dir, "pi-multi-account", "config.json"), "utf8");
		rmSync(shared());
		assert.throws(
			() => saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "b" }, auth: { mode: "separate" } }, { copyAuth: true }),
			/cannot copy credentials/,
		);
		assert.equal(readFileSync(join(info.dir, "pi-multi-account", "config.json"), "utf8"), cfg);
		assert.equal(readMultiAccount(info.dir).defaultGroup, "a");
		assert.equal(loadProfile(s.l, "p").manifest.multiAccount?.group, "a");
	});
	it("a failure before profile.json restores both the group and the auth link", () => {
		const info = withGroups();
		const manifestBefore = readFileSync(join(info.dir, "profile.json"), "utf8");
		assert.throws(
			() =>
				saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "b" }, auth: { mode: "separate" } }, {}, {
					beforeManifest: () => {
						throw new Error("disk full");
					},
				}),
			/disk full/,
		);
		assert.equal(readMultiAccount(info.dir).defaultGroup, "a");
		const auth = inspectAuth(info.dir);
		assert.equal(auth.kind === "link" ? auth.target : auth.kind, shared());
		assert.equal(readFileSync(join(info.dir, "profile.json"), "utf8"), manifestBefore);
	});
	it("a failure after switching to shared puts the private file back", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		writeFileSync(join(info.dir, "auth.json"), '{"mine":1}\n');
		assert.throws(
			() =>
				saveManifest(s.l, "p", { ...info.manifest, auth: { mode: "shared" } }, {}, {
					beforeManifest: () => {
						throw new Error("disk full");
					},
				}),
			/disk full/,
		);
		assert.equal(inspectAuth(info.dir).kind, "file");
		assert.equal(readFileSync(join(info.dir, "auth.json"), "utf8"), '{"mine":1}\n');
		assert.deepEqual(backups(info.dir), []);
	});
	it("a new multi-account config is removed again on failure", () => {
		const info = createProfile(s.l, "p");
		assert.throws(
			() =>
				saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "g", members: ["1"] } }, {}, {
					beforeManifest: () => {
						throw new Error("disk full");
					},
				}),
			/disk full/,
		);
		assert.equal(readMultiAccount(info.dir).exists, false);
	});
});

describe("round 2: CR-ENV-SYMLINK-ESCAPE through link/..", () => {
	for (const key of ["PI_MEMORY_DIR", "ACP_LOG_FILE", "ACP_UPDATE_THROTTLE_FILE"]) {
		it(`${key}: <profile>/link/../x is refused, though its text stays inside`, () => {
			const info = createProfile(s.l, "p");
			const outside = mkdtempSync(join(tmpdir(), "pi-profile-outside-"));
			try {
				mkdirSync(join(outside, "child"));
				mkdirSync(join(outside, "escape"));
				symlinkSync(join(outside, "child"), join(info.dir, "link"));
				const value = `${info.dir}/link/../escape/proof`;
				assert.equal(validateEnv({ [key]: value }, info.dir).ok, false);
				assert.equal(validateEnv({ [key]: `${info.dir}/./memory` }, info.dir).ok, false);
				assert.equal(validateEnv({ [key]: `${info.dir}//memory` }, info.dir).ok, false);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	}
});

describe("round 2: CR-ROLLBACK-CONCURRENT-CLOBBER", () => {
	const fail = (): never => {
		throw new Error("disk full");
	};
	it("undo of shared does not erase a credential written meanwhile, and keeps the old one", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		writeFileSync(p, '{"old":1}\n');
		const concurrent = (): void => {
			unlinkSync(p);
			writeFileSync(p, '{"concurrent":1}\n', { mode: 0o600 });
			fail();
		};
		assert.throws(() => saveManifest(s.l, "p", { ...info.manifest, auth: { mode: "shared" } }, {}, { beforeManifest: concurrent }));
		assert.equal(readFileSync(p, "utf8"), '{"concurrent":1}\n');
		const kept = backups(info.dir).map((n) => readFileSync(join(info.dir, n), "utf8"));
		assert.deepEqual(kept, ['{"old":1}\n']);
	});
	it("undo of separate does not erase a credential written meanwhile", () => {
		const info = createProfile(s.l, "p");
		const p = join(info.dir, "auth.json");
		const concurrent = (): void => {
			writeFileSync(p, '{"logged-in":1}\n');
			fail();
		};
		assert.throws(() => saveManifest(s.l, "p", { ...info.manifest, auth: { mode: "separate" } }, {}, { beforeManifest: concurrent }));
		const kept = [p, ...backups(info.dir).map((n) => join(info.dir, n))].filter((x) => statSync(x, { throwIfNoEntry: false })?.isFile());
		assert.ok(kept.some((x) => readFileSync(x, "utf8") === '{"logged-in":1}\n'), kept.join("|"));
		assert.match(readFileSync(shared(), "utf8"), /shared/);
	});
	it("undo of a group does not overwrite a config written meanwhile", () => {
		const info = createProfile(s.l, "p");
		const cfg = join(info.dir, "pi-multi-account", "config.json");
		mkdirSync(join(info.dir, "pi-multi-account"));
		writeFileSync(cfg, JSON.stringify({ accountGroups: { a: ["1"], b: ["2"] }, defaultAccountGroup: "a" }));
		const concurrent = (): void => {
			writeFileSync(`${cfg}.x`, '{"accountGroups":{"c":["3"]},"defaultAccountGroup":"c"}');
			renameSync(`${cfg}.x`, cfg);
			fail();
		};
		assert.throws(() => saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "b" } }, {}, { beforeManifest: concurrent }));
		assert.equal(readMultiAccount(info.dir).defaultGroup, "c");
	});
});

describe("round 2: CR-LOCK-STALE-RACE", () => {
	it("a fresh lock that replaces a stale one is not removed", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		writeFileSync(lock, "2147483646 dead\n");
		const other = `${process.ppid} other\n`;
		const steal = (): void => {
			unlinkSync(lock);
			writeFileSync(lock, other);
		};
		let ran = false;
		assert.throws(() => withProfileLock(info.dir, () => (ran = true), { afterStaleRead: steal }), Refusal);
		assert.equal(ran, false);
		assert.equal(readFileSync(lock, "utf8"), other);
	});
	it("release leaves a lock that is no longer ours", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		const other = `${process.ppid} other\n`;
		withProfileLock(info.dir, () => {
			unlinkSync(lock);
			writeFileSync(lock, other);
		});
		assert.equal(readFileSync(lock, "utf8"), other);
	});
	it("no aside or temp files are left behind", () => {
		const info = createProfile(s.l, "p");
		writeFileSync(join(info.dir, LOCK_FILE), "2147483646 dead\n");
		setAuthMode(info.dir, shared(), "separate")();
		setAuthMode(info.dir, shared(), "separate");
		assert.deepEqual(readdirSync(info.dir).filter((n) => /aside|\.new-|restore|\.tmp/.test(n)), []);
	});
});

describe("round 3: multi-account changes made meanwhile are never lost", () => {
	const seed = (dir: string): string => {
		const cfg = multiAccountConfigPath(dir);
		mkdirSync(join(dir, "pi-multi-account"), { recursive: true });
		writeFileSync(cfg, JSON.stringify({ accountGroups: { a: ["1"], b: ["2"] }, defaultAccountGroup: "a" }));
		return cfg;
	};
	const theirs = '{"accountGroups":{"c":["3"]},"defaultAccountGroup":"c"}';
	it("CR-MULTI-ACCOUNT-FORWARD-CLOBBER: a replacement after the read is refused, not overwritten", () => {
		const info = createProfile(s.l, "p");
		const cfg = seed(info.dir);
		const replace = (): void => {
			writeFileSync(`${cfg}.x`, theirs);
			renameSync(`${cfg}.x`, cfg);
		};
		assert.throws(() => applyGroup(info.dir, "b", undefined, { afterRead: replace }), /changed while pi-profile/);
		assert.equal(readFileSync(cfg, "utf8"), theirs);
	});
	it("CR-MULTI-ACCOUNT-FORWARD-CLOBBER: an in-place edit after the read is refused too", () => {
		const info = createProfile(s.l, "p");
		const cfg = seed(info.dir);
		assert.throws(() => applyGroup(info.dir, "b", undefined, { afterRead: () => writeFileSync(cfg, theirs) }), /changed while pi-profile/);
		assert.equal(readFileSync(cfg, "utf8"), theirs);
	});
	it("CR-ROLLBACK-CONCURRENT-CLOBBER: undo keeps an in-place edit made meanwhile", () => {
		const info = createProfile(s.l, "p");
		const cfg = seed(info.dir);
		const inPlace = (): never => {
			writeFileSync(cfg, theirs);
			throw new Error("disk full");
		};
		assert.throws(() => saveManifest(s.l, "p", { ...info.manifest, multiAccount: { group: "b" } }, {}, { beforeManifest: inPlace }));
		assert.equal(readFileSync(cfg, "utf8"), theirs);
		assert.deepEqual(readdirSync(join(info.dir, "pi-multi-account")).filter((n) => n !== "config.json"), []);
	});
	it("an unchanged config is still updated and undone", () => {
		const info = createProfile(s.l, "p");
		const cfg = seed(info.dir);
		const before = readFileSync(cfg, "utf8");
		const undo = applyGroup(info.dir, "b");
		assert.equal(readMultiAccount(info.dir).defaultGroup, "b");
		undo();
		assert.equal(readFileSync(cfg, "utf8"), before);
	});
});

describe("round 3: CR-AUTH-FAILED-SWITCH", () => {
	it("a failed switch to shared leaves the private auth.json in place", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		writeFileSync(p, '{"mine":1}\n');
		const tooLong = "/x".repeat(3000);
		assert.throws(() => setAuthMode(info.dir, tooLong, "shared"), /ENAMETOOLONG/);
		assert.equal(readFileSync(p, "utf8"), '{"mine":1}\n');
		assert.deepEqual(backups(info.dir), []);
	});
});

describe("round 3: CR-LOCK-STALE-RACE (three processes)", () => {
	it("the lock name is never emptied while a live lock is checked", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		writeFileSync(lock, "2147483646 dead\n");
		const b = `${process.ppid} B\n`;
		const replaceAndProbe = (): void => {
			unlinkSync(lock);
			writeFileSync(lock, b);
		};
		assert.throws(() => withProfileLock(info.dir, () => assert.fail("must not run"), { afterStaleRead: replaceAndProbe }), /being changed/);
		assert.equal(readFileSync(lock, "utf8"), b);
		assert.equal(existsSync(`${lock}.break`), false);
	});
	it("a live breaker blocks a second takeover", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		writeFileSync(lock, "2147483646 dead\n");
		writeFileSync(`${lock}.break`, `${process.ppid} C\n`);
		assert.throws(() => withProfileLock(info.dir, () => assert.fail("must not run")), /being changed/);
		assert.equal(readFileSync(lock, "utf8"), "2147483646 dead\n");
	});
	it("the stale lock is taken over and released cleanly", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		writeFileSync(lock, "2147483646 dead\n");
		let ran = false;
		withProfileLock(info.dir, () => (ran = true));
		assert.equal(ran, true);
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.startsWith(LOCK_FILE)), []);
	});
});

describe("issue 20: a busy lock is a typed refusal that names the locked directory", () => {
	it("carries the resolved directory and the live holder's pid", () => {
		const info = createProfile(s.l, "p");
		writeFileSync(join(info.dir, LOCK_FILE), `${process.ppid} other\n`);
		assert.throws(
			() => withProfileLock(`${info.dir}/.`, () => assert.fail("must not run")),
			(e) => e instanceof LockBusy && e instanceof Refusal && e.dir === info.dir && e.pid === process.ppid && e.message === `${info.dir} is being changed by process ${process.ppid}; try again when it finishes`,
		);
	});
	it("carries no pid while another process breaks a stale lock", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		writeFileSync(lock, "2147483646 dead\n");
		writeFileSync(`${lock}.break`, `${process.ppid} C\n`);
		assert.throws(
			() => withProfileLock(info.dir, () => assert.fail("must not run")),
			(e) => e instanceof LockBusy && e.dir === info.dir && e.pid === undefined && /is being changed by another pi-profile/.test(e.message),
		);
	});
});

describe("round 4: CR-LOCK-STALE-RACE (publication gap)", () => {
	it("the lock name never holds an empty file", () => {
		const info = createProfile(s.l, "p");
		const lock = join(info.dir, LOCK_FILE);
		withProfileLock(info.dir, () => {
			assert.match(readFileSync(lock, "utf8"), /^\d+ [0-9a-f]+\n$/);
		});
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.startsWith(LOCK_FILE)), []);
	});
	it("many processes never hold the lock at once, even starting from a stale lock", async () => {
		const info = createProfile(s.l, "p");
		writeFileSync(join(info.dir, LOCK_FILE), "2147483646 dead\n");
		const out = join(s.home, "stress.log");
		writeFileSync(out, "");
		const { spawn } = await import("node:child_process");
		const worker = join(import.meta.dirname, "fixtures", "lock-worker.ts");
		await Promise.all(
			Array.from({ length: 6 }, () => new Promise<void>((done, fail) => {
				const c = spawn(process.execPath, [worker, info.dir, "40", out], { stdio: "inherit" });
				c.on("exit", (code) => (code === 0 ? done() : fail(new Error(`worker exit ${code}`))));
			})),
		);
		const log = readFileSync(out, "utf8");
		assert.doesNotMatch(log, /overlap/);
		const entered = [...log.matchAll(/entered (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
		assert.ok(entered > 0, log);
	});
});

describe("round 4: CR-MANIFEST-CONCURRENT-CLOBBER", () => {
	it("updateManifest applies the change to the manifest as it is under the lock", () => {
		const info = createProfile(s.l, "p");
		const stale = info.manifest;
		updateManifest(s.l, "p", (m) => ({ ...m, description: "first writer" }));
		updateManifest(s.l, "p", (m) => ({ ...m, color: "blue" }));
		const now = loadProfile(s.l, "p").manifest;
		assert.equal(now.description, "first writer");
		assert.equal(now.color, "blue");
		assert.equal(stale.description, undefined);
	});
	it("a profile.json written meanwhile without the lock is refused and kept", () => {
		const info = createProfile(s.l, "p");
		const path = join(info.dir, "profile.json");
		const theirs = readFileSync(path, "utf8").replace('"name"', '"description": "by hand",\n  "name"');
		assert.throws(
			() => updateManifest(s.l, "p", (m) => ({ ...m, color: "blue" }), {}, { beforeManifest: () => writeFileSync(path, theirs) }),
			/changed while pi-profile/,
		);
		assert.equal(readFileSync(path, "utf8"), theirs);
	});
	it("pi-profile edit goes through updateManifest", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "src", "cli", "main.ts"), "utf8");
		assert.match(src, /updateManifest\(l, name, \(current\) =>/);
		assert.doesNotMatch(src, /saveManifest/);
	});
});

describe("round 5: CR-MANIFEST-STALE-WRITERS", () => {
	it("no production module exports a whole-manifest save", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "profiles.ts"), "utf8");
		assert.doesNotMatch(src, /export function saveManifest/);
	});
	it("adopt reads the profile under the lock", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "profiles.ts"), "utf8");
		const body = src.slice(src.indexOf("export function adoptProfile"), src.indexOf("export interface SaveHooks"));
		assert.ok(body.indexOf("withProfileLock") < body.indexOf("loadProfile("), body);
	});
});

describe("round 5: CR-MANIFEST-CAS-PREP-FAIL", () => {
	it("a failure writing the new file leaves profile.json in place", () => {
		const info = createProfile(s.l, "p");
		const path = join(info.dir, "profile.json");
		const before = readFileSync(path, "utf8");
		// Data the write rejects stands in for a disk-full or EMFILE failure.
		const unwritable = Symbol("unwritable") as unknown as string;
		assert.throws(() => replaceIfUnchanged(path, readSnapshot(path), unwritable, "saving"));
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.startsWith("profile.json.")), []);
	});
});

describe("round 6: CR-CAS-COMMIT-FAIL", () => {
	it("a failure placing the new file puts the old one back", () => {
		const info = createProfile(s.l, "p");
		const path = join(info.dir, "profile.json");
		const before = readFileSync(path, "utf8");
		const fail = (): never => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		};
		assert.throws(() => replaceIfUnchanged(path, readSnapshot(path), "{}\n", "saving", { beforePlace: fail }), /EACCES/);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.startsWith("profile.json.")), []);
	});
	it("a failure placing a new file where none was leaves nothing behind", () => {
		const info = createProfile(s.l, "p");
		const path = join(info.dir, "extra.json");
		const fail = (): never => {
			throw new Error("EIO");
		};
		assert.throws(() => replaceIfUnchanged(path, readSnapshot(path), "{}\n", "saving", { beforePlace: fail }), /EIO/);
		assert.equal(existsSync(path), false);
		assert.deepEqual(readdirSync(info.dir).filter((n) => n.startsWith("extra.json")), []);
	});
});

describe("round 7: CR-CAS-COMMIT-FAIL with real file system failures", () => {
	// A read-only directory makes link(), rename() and unlink() in it fail
	// with EACCES, a real failure at the exact step under test. Root ignores
	// directory permissions, so these tests are skipped when run as root.
	const skip = process.getuid?.() === 0 && "root ignores directory permissions";
	it("when placing fails and the old file cannot be put back, the error names where it is", { skip }, () => {
		const info = createProfile(s.l, "p");
		const path = join(info.dir, "profile.json");
		const before = readFileSync(path, "utf8");
		let thrown: unknown;
		try {
			replaceIfUnchanged(path, readSnapshot(path), "{}\n", "saving", { beforePlace: () => chmodSync(info.dir, 0o500) });
		} catch (error) {
			thrown = error;
		} finally {
			chmodSync(info.dir, 0o700);
		}
		assert.ok(thrown instanceof Error);
		const aside = readdirSync(info.dir).find((n) => n.startsWith("profile.json.aside-"));
		assert.ok(aside !== undefined, "the old file is kept under its aside name");
		assert.equal(readFileSync(join(info.dir, aside), "utf8"), before);
		assert.ok(thrown.message.includes(aside), thrown.message);
	});
	it("a placed file is reported as placed even if its source name cannot be removed", { skip }, () => {
		const info = createProfile(s.l, "p");
		const ro = join(info.dir, "ro");
		mkdirSync(ro);
		const src = join(ro, "new");
		writeFileSync(src, "new\n");
		const to = join(info.dir, "placed.json");
		chmodSync(ro, 0o500);
		try {
			assert.equal(placeNoClobber(src, to), true);
		} finally {
			chmodSync(ro, 0o700);
		}
		assert.equal(readFileSync(to, "utf8"), "new\n");
	});
});

describe("CR-SHELL-PI-INTEROP: bash and zsh keep an existing pi", () => {
	let bin: string;
	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "pi-profile-shell-"));
		writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "real:$*:${PI_PROFILE_LABEL-none}"\n', { mode: 0o755 });
		writeFileSync(
			join(bin, "pi-profile"),
			"#!/bin/sh\nif [ \"$1\" = env ]; then echo \"export PI_PROFILE_LABEL=work\"; fi\n",
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "init.bash"), shellInit("bash"));
		writeFileSync(join(bin, "init.zsh"), shellInit("zsh"));
	});
	afterEach(() => {
		rmSync(bin, { recursive: true, force: true });
	});
	function run(shell: "bash" | "zsh", script: string): string {
		const args = shell === "bash" ? ["--noprofile", "--norc", "-c", `shopt -s expand_aliases\n${script}`] : ["-f", "-c", script];
		return execFileSync(shellPath[shell] ?? shell, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin }, encoding: "utf8" });
	}
	const shellPath: Partial<Record<"bash" | "zsh", string>> = {};
	for (const sh of ["bash", "zsh"] as const) {
		try {
			shellPath[sh] = execFileSync("sh", ["-c", `command -v ${sh}`], { encoding: "utf8" }).trim();
		} catch {
			// Not installed here; its tests are skipped.
		}
	}
	const shells = (["bash", "zsh"] as const).filter((sh) => shellPath[sh] !== undefined);
	for (const sh of shells) {
		it(`${sh}: an existing pi function still runs, with and without --profile`, () => {
			const out = run(sh, `pi() { echo "mine:$*"; command pi "$@"; }\nsource ${bin}/init.${sh}\npi hello\npi --profile work go`);
			assert.equal(out, "mine:hello\nreal:hello:none\nmine:go\nreal:go:work\n");
		});
		it(`${sh}: an existing pi alias still runs, and the script loads`, () => {
			const out = run(sh, `alias pi='pi --flag'\nsource ${bin}/init.${sh}\npi hello\npi --profile=work go\ntype pi-profile >/dev/null && echo loaded`);
			assert.equal(out, "real:--flag hello:none\nreal:--flag go:work\nloaded\n");
		});
		it(`${sh}: a function that calls pi recursively does not loop`, () => {
			const out = run(sh, `pi() { echo wrap; pi "$@"; }\nsource ${bin}/init.${sh}\npi x`);
			assert.equal(out, "wrap\nreal:x:none\n");
		});
		it(`${sh}: sourcing twice keeps the original pi`, () => {
			const out = run(sh, `pi() { echo "mine:$*"; command pi "$@"; }\nsource ${bin}/init.${sh}\nsource ${bin}/init.${sh}\npi a`);
			assert.equal(out, "mine:a\nreal:a:none\n");
		});
		it(`${sh}: with no existing pi the real command runs`, () => {
			const out = run(sh, `source ${bin}/init.${sh}\npi a\npi --profile work b`);
			assert.equal(out, "real:a:none\nreal:b:work\n");
		});
	}
});
