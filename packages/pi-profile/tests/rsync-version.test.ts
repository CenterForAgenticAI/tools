import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addReplica, runBackup, unsupportedRsync, type ToolResult, type ToolRunner } from "../src/core/backup.ts";
import { pullSessions } from "../src/core/pull.ts";
import { addStore } from "../src/core/sessions.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });

/** What `rsync --version` prints on stock macOS 26 (openrsync) and on a 3.x install. */
const OPENRSYNC = "openrsync: protocol version 29\nrsync version 2.6.9 compatible\n";
const RSYNC_269 = "rsync  version 2.6.9  protocol version 29\nCopyright (C) 1996-2006 by Andrew Tridgell, Wayne Davison, and others.\n";
const RSYNC_341 = "rsync  version 3.4.1  protocol version 32\nCopyright (C) 1996-2025 by Andrew Tridgell, Wayne Davison, and others.\n";

/** The exact error openrsync gives for the first backup call. */
const CHMOD_REJECTED: ToolResult = { status: 1, stdout: "", stderr: "rsync: --chmod=D700,F600: invalid argument\n" };

/** An rsync that prints `version` and fails every transfer with `transfer`. */
function rsyncThat(version: string, transfer: ToolResult = CHMOD_REJECTED): ToolRunner {
	return (cmd, args) => {
		assert.equal(cmd, "rsync", "only rsync runs for a local replica");
		return args.length === 1 && args[0] === "--version" ? { status: 0, stdout: version, stderr: "" } : transfer;
	};
}

function localSetup(): void {
	const root = join(s.home, "store");
	mkdirSync(join(root, "--home-alice--"), { recursive: true });
	writeFileSync(join(root, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n');
	addStore(s.l, "main", root, env());
	const usb = join(s.home, "usb");
	mkdirSync(join(usb, "hosts"), { recursive: true });
	writeFileSync(join(usb, "repository.json"), "{}");
	addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
}

function backupError(run: ToolRunner): string {
	const [r] = runBackup(s.l, { env: env(), runner: run });
	assert.ok(r !== undefined && r.ok === false, "the backup fails");
	return r.error;
}

describe("#68: an rsync too old for pi-profile is named, not reported as a usage error", () => {
	it("backup run on stock macOS says the rsync is openrsync and how to install a newer one", () => {
		localSetup();
		assert.equal(backupError(rsyncThat(OPENRSYNC)), "rsync failed: the rsync on PATH is openrsync, which has no --chmod or --append-verify; install rsync 3.1 or later and put it first on PATH (macOS: brew install rsync)");
	});

	it("backup run with a real rsync older than 3.1 names its version", () => {
		localSetup();
		assert.match(backupError(rsyncThat(RSYNC_269)), /^rsync failed: the rsync on PATH is version 2\.6; install rsync 3\.1 or later/);
	});

	it("a current rsync that fails keeps rsync's own message", () => {
		localSetup();
		const denied: ToolResult = { status: 23, stdout: "", stderr: 'rsync: [Receiver] mkdir "/x" failed: Permission denied (13)\n' };
		assert.equal(backupError(rsyncThat(RSYNC_341, denied)), 'rsync failed: rsync: [Receiver] mkdir "/x" failed: Permission denied (13)');
	});

	it("sessions pull on stock macOS says the same", () => {
		localSetup();
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: rsyncThat(OPENRSYNC) }), /^Error: rsync failed: the rsync on PATH is openrsync/);
	});

	it("blames the version only when it can read one", () => {
		const answer = (r: ToolResult): ToolRunner => () => r;
		assert.equal(unsupportedRsync(answer({ status: 0, stdout: RSYNC_341, stderr: "" })), undefined);
		assert.equal(unsupportedRsync(answer({ status: 0, stdout: "rsync  version 3.1.0  protocol version 31\n", stderr: "" })), undefined);
		assert.match(unsupportedRsync(answer({ status: 0, stdout: "rsync  version 3.0.9  protocol version 30\n", stderr: "" })) ?? "", /version 3\.0;/);
		assert.equal(unsupportedRsync(answer({ status: 0, stdout: "some other tool 9\n", stderr: "" })), undefined);
		assert.equal(unsupportedRsync(answer({ status: 1, stdout: OPENRSYNC, stderr: "" })), undefined);
		assert.equal(unsupportedRsync(() => ({ status: null, stdout: "", stderr: "", error: "rsync is not installed" })), undefined);
	});
});
