#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTempRoot } from "./temp-root.mjs";

/**
 * Run a command with a temp directory of its own, then delete it.
 *
 * A test that calls `os.tmpdir()` writes into the directory the whole machine
 * shares. Nothing removes what it leaves, so every run adds more: this
 * repository's suites had left tens of thousands of directories in `/tmp`.
 * Rather than ask every call site to clean up after itself -- which only works
 * until someone writes a new one -- this gives the run its own root and takes
 * the whole root away afterwards.
 *
 * TMPDIR is what `os.tmpdir()` reads, so redirecting it moves every existing
 * and future call site at once. TMUX_TMPDIR does the same for the socket
 * directory `tmux` uses, which leaks the same way.
 *
 * Set PI_KEEP_TEST_TMP=1 to keep the directory for inspection after a failure.
 */

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
	console.error("with-temp-root: usage: with-temp-root.mjs <command> [args...]");
	process.exit(2);
}

/**
 * A writable directory, or nothing.
 */
function usableDir(value) {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		fs.accessSync(value, fs.constants.W_OK);
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The platform's own temp directory, ignoring the environment.
 *
 * os.tmpdir() reads TMPDIR, TMP and TEMP, so a caller that rejects TMPDIR and
 * then asks os.tmpdir() for a fallback is handed back the value it just
 * rejected. resolveTempRoot() has that shape, so a stale TMPDIR reached
 * mkdtemp and crashed the run rather than degrading to the default it
 * documents. Clearing all three is what makes os.tmpdir() answer with the
 * platform default rather than the environment.
 */
function platformTempDir() {
	const saved = {};
	for (const key of ["TMPDIR", "TMP", "TEMP"]) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		return os.tmpdir();
	} finally {
		for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
	}
}

// Created inside resolveTempRoot() so an operator pointing TMPDIR at
// disk-backed storage still gets that, per scripts/temp-root.mjs -- but only
// when that answer is actually usable.
const configuredRoot = resolveTempRoot();
const runRoot = fs.mkdtempSync(path.join(usableDir(configuredRoot) ? configuredRoot : platformTempDir(), "pi-ctx-test-"));
const keep = process.env.PI_KEEP_TEST_TMP === "1";

let cleaned = false;

/**
 * Remove the run root without blocking the event loop.
 *
 * Deliberately asynchronous. A synchronous rmSync holds the loop for as long as
 * the unlinking takes, and a signal arriving in that window cannot run its
 * handler until afterwards -- by which time the status has already been decided
 * and a cancelled run has been reported as a passing one.
 */
async function cleanup() {
	if (cleaned) return;
	cleaned = true;
	if (keep) {
		console.error(`with-temp-root: keeping ${runRoot} (PI_KEEP_TEST_TMP=1)`);
		return;
	}
	try {
		await fs.promises.rm(runRoot, { recursive: true, force: true });
	} catch (error) {
		// A cleanup failure must not turn a passing run red, but it must not be
		// silent either -- a leak is exactly what this script exists to stop.
		console.error(`with-temp-root: could not remove ${runRoot}: ${error.message}`);
	}
}

const child = spawn(command, args, {
	stdio: "inherit",
	env: {
		...process.env,
		TMPDIR: runRoot,
		TMP: runRoot,
		TEMP: runRoot,
		TMUX_TMPDIR: runRoot,
	},
});

/**
 * A signal aimed at this wrapper, remembered rather than acted on immediately.
 *
 * Cleanup can take a while -- a large run root is a lot of unlinking -- and a
 * signal arriving in that window used to be lost: the child had already closed
 * with status 0, so the wrapper reported success for a run somebody cancelled.
 */
let pendingSignal = null;

/** How long a child gets to honour a forwarded signal before it is killed. */
const SHUTDOWN_GRACE_MS = Number(process.env.PI_TEST_SHUTDOWN_GRACE_MS ?? 5000);

/** Still running? `child.killed` only records that we called kill(). */
function childIsAlive() {
	return child.exitCode === null && child.signalCode === null;
}

let escalation = null;

let launchFailed = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		pendingSignal = signal;
		// Forward every signal, not just the first. `child.killed` is true as
		// soon as we have called kill() once, even if the child caught the
		// signal and is still running, so using it swallowed every later
		// signal and a cancelled run could only be ended with a forced kill.
		if (!childIsAlive()) return;
		child.kill(signal);
		// A child that catches or ignores the signal must not leave the run
		// hanging: escalate once, so cancellation always terminates.
		if (escalation) return;
		escalation = setTimeout(() => {
			if (childIsAlive()) child.kill("SIGKILL");
		}, SHUTDOWN_GRACE_MS);
		escalation.unref();
	});
}

child.on("error", (error) => {
	launchFailed = true;
	void (async () => {
		console.error(`with-temp-root: failed to start ${command}: ${error.message}`);
		await cleanup();
		process.exit(127);
	})();
});

function resolveOutcome(code, signal) {
	if (escalation) clearTimeout(escalation);
	// A signal beats an exit status: a cancelled run is not a passing run,
	// whether the signal killed the child or arrived while we were cleaning up.
	const terminating = signal ?? pendingSignal;
	if (terminating) {
		// Drop our own listener first. Re-raising while it is still attached
		// means we catch our own signal, fall off the end of the program, and
		// exit 0 -- reporting a killed or cancelled run as a passing one.
		process.removeAllListeners(terminating);
		// If the default action somehow does not end this process, still exit
		// non-zero: 128+n is the conventional status for death by signal.
		const number = os.constants.signals[terminating];
		setTimeout(() => process.exit(128 + (number ?? 1)), 200);
		process.kill(process.pid, terminating);
		return;
	}
	process.exit(code ?? 1);
}

child.on("close", (code, signal) => {
	if (launchFailed) return;
	void (async () => {
		await cleanup();
		// One more turn of the loop, so a signal delivered during cleanup has
		// run its handler and been recorded before the status is decided.
		await new Promise((resolve) => setImmediate(resolve));
		resolveOutcome(code, signal);
	})();
});
