import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../src/verify/command.ts";
import { ExecutableResolutionError, pathShadowsExecutable, resolveVerifierExecutable } from "../../src/verify/executable.ts";
import { evidenceKind } from "../../src/verify/results.ts";
import type { TreeIdentity } from "../../src/verify/results.ts";
import { deterministicCommandOptions, systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

const tree: TreeIdentity = { kind: "git", worktreePath: process.cwd(), resolvedCommit: "test-commit" };
const systemdPrerequisite = await systemdContainmentPrerequisite();

// A `systemd-run --user --scope` does not start the authored command
// instantly. Measured on the development host: median 108ms, p90 308ms from
// spawn to the command running. A timeout below that kills the descendant
// inside its own startup, before it can write the PID this suite observes it
// by — which is what made the host-integration tests flaky (#22).
//
// Containment assertions therefore use a budget above the observed p90. The
// prerequisite probe measures whether this host can start the observed
// descendant within the separate PID-observation budget before these tests run.
const CONTAINMENT_TIMEOUT_MS = 750;
const DESCENDANT_START_BUDGET_MS = 2_000;

function evidence(run: string, output = "ok", exit = 0) {
	return { kind: "command" as const, run, expect: { exit, output_includes: output } };
}

// The process-group branch is POSIX; exercise it on Linux without requiring
// a systemd user bus. Node tests in this file run sequentially.
async function runProcessGroupCommand(input: Parameters<typeof runCommand>[0], options?: Parameters<typeof runCommand>[1]): Promise<Awaited<ReturnType<typeof runCommand>>> {
	if (process.platform !== "linux") return runCommand(input, options);
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(descriptor);
	Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
	try { return await runCommand(input, options); }
	finally { Object.defineProperty(process, "platform", descriptor); }
}

function finalDescendantCommand(pidFile: string): string {
	return `setsid sh -c 'trap "" TERM; sh -c '"'"'trap "" TERM; read pid _ < /proc/self/stat; echo "$pid" > "$1"; while :; do sleep 1; done'"'"' sh "$1" & exit 0' sh ${JSON.stringify(pidFile)}; sleep 10`;
}

function ordinaryDescendantCommand(pidFile: string): string {
	return `sh -c 'echo "$$" > "$1"; while :; do sleep 1; done' sh ${JSON.stringify(pidFile)} & while :; do sleep 1; done`;
}

async function waitForPid(pidFile: string, timeoutMs = 1_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const pid = Number((await readFile(pidFile, "utf8")).trim());
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			// The authored descendant has not written its PID yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`descendant PID was not captured within ${timeoutMs}ms`);
}

async function waitForPidGone(pid: number, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`descendant PID ${pid} remained alive after ${timeoutMs}ms`);
}

async function cleanupPid(pid: number): Promise<void> {
	try {
		await waitForPidGone(pid);
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* The process may have exited between probes. */ }
		await waitForPidGone(pid).catch(() => undefined);
	}
}

test("the finite prerequisite probe settles when both cleanup signals fail", { skip: process.platform === "linux" ? false : "Linux only" }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-prerequisite-failure-"));
	const launcherPidFile = path.join(directory, "launcher-pid");
	const cleanupLog = path.join(directory, "cleanup-log");
	const fakeSystemdRun = path.join(directory, "systemd-run");
	const failingSystemctl = path.join(directory, "systemctl");
	await writeFile(fakeSystemdRun, `#!/bin/sh
printf '%s\\n' "$$" > ${JSON.stringify(launcherPidFile)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-c" ]; then
    shift
    break
  fi
  shift
done
if [ "$1" = "exit 0" ]; then
  exec /bin/sh -c "$1"
fi
/bin/sh -c "$1"
trap '' TERM
sleep 10 &
wait $!
`);
	await writeFile(failingSystemctl, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(cleanupLog)}
exit 1
`);
	await chmod(fakeSystemdRun, 0o755);
	await chmod(failingSystemctl, 0o755);
	try {
		const started = Date.now();
		const prerequisite = await systemdContainmentPrerequisite({
			shell: "/bin/sh",
			systemdRun: fakeSystemdRun,
			systemctl: failingSystemctl,
		});
		const elapsed = Date.now() - started;
		assert.equal(prerequisite.available, false);
		assert.match(prerequisite.reason ?? "", /probe did not exit/);
		assert.ok(elapsed < 5_000, `probe cleanup exceeded bounded budget: ${elapsed}ms`);
		const launcherPid = Number((await readFile(launcherPidFile, "utf8")).trim());
		assert.ok(Number.isInteger(launcherPid) && launcherPid > 0);
		await waitForPidGone(launcherPid);
		const cleanupAttempts = (await readFile(cleanupLog, "utf8")).trim().split("\n");
		assert.equal(cleanupAttempts.length, 2);
		assert.match(cleanupAttempts[0] ?? "", /SIGTERM/);
		assert.match(cleanupAttempts[1] ?? "", /SIGKILL/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the prerequisite probe settles when cleanup itself ignores its signal", { skip: process.platform === "linux" ? false : "Linux only" }, async () => {
	// The double failure #26 describes: systemd-run's descendant ignores TERM, and
	// the systemctl invoked to kill it also ignores TERM and never exits. execFile's
	// `timeout` option only sends a signal -- the promisified call still waits for
	// the child -- so an unbounded await here would never reach the SIGKILL step or
	// the process-group fallback, and `npm run check` would hang rather than fail.
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-prerequisite-hang-"));
	const launcherPidFile = path.join(directory, "launcher-pid");
	const cleanupLog = path.join(directory, "cleanup-log");
	const cleanupPidFile = path.join(directory, "cleanup-pids");
	const fakeSystemdRun = path.join(directory, "systemd-run");
	const hangingSystemctl = path.join(directory, "systemctl");
	await writeFile(fakeSystemdRun, `#!/bin/sh
printf '%s\\n' "$$" > ${JSON.stringify(launcherPidFile)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-c" ]; then
    shift
    break
  fi
  shift
done
if [ "$1" = "exit 0" ]; then
  exec /bin/sh -c "$1"
fi
trap '' TERM
sleep 10 &
wait $!
`);
	// Records its own pid, ignores TERM, and never exits on its own.
	await writeFile(hangingSystemctl, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(cleanupLog)}
printf '%s\\n' "$$" >> ${JSON.stringify(cleanupPidFile)}
trap '' TERM
while :; do sleep 1; done
`);
	await chmod(fakeSystemdRun, 0o755);
	await chmod(hangingSystemctl, 0o755);
	try {
		const started = Date.now();
		const prerequisite = await systemdContainmentPrerequisite({
			shell: "/bin/sh",
			systemdRun: fakeSystemdRun,
			systemctl: hangingSystemctl,
		});
		const elapsed = Date.now() - started;
		assert.equal(prerequisite.available, false);
		assert.ok(elapsed < 15_000, `hanging cleanup was not hard-bounded: ${elapsed}ms`);

		// Both rungs must still be attempted: an unbounded first call would log one.
		const cleanupAttempts = (await readFile(cleanupLog, "utf8")).trim().split("\n");
		assert.equal(cleanupAttempts.length, 2, `expected SIGTERM then SIGKILL, got ${JSON.stringify(cleanupAttempts)}`);
		assert.match(cleanupAttempts[0] ?? "", /SIGTERM/);
		assert.match(cleanupAttempts[1] ?? "", /SIGKILL/);

		// The launcher is reaped by the process-group fallback the hang used to block.
		const launcherPid = Number((await readFile(launcherPidFile, "utf8")).trim());
		assert.ok(Number.isInteger(launcherPid) && launcherPid > 0);
		await waitForPidGone(launcherPid);

		// A cleanup child that ignored TERM must not be left running.
		const cleanupPids = (await readFile(cleanupPidFile, "utf8")).trim().split("\n").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
		assert.ok(cleanupPids.length > 0, "the hanging cleanup child never recorded a pid");
		for (const pid of cleanupPids) await waitForPidGone(pid);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the capable prerequisite probe exits without invoking cleanup", { skip: systemdPrerequisite.userScopeAvailable ? false : systemdPrerequisite.reason }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-prerequisite-finite-"));
	const cleanupLog = path.join(directory, "cleanup-log");
	const loggingSystemctl = path.join(directory, "systemctl");
	await writeFile(loggingSystemctl, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(cleanupLog)}
exit 0
`);
	await chmod(loggingSystemctl, 0o755);
	try {
		const prerequisite = await systemdContainmentPrerequisite({ systemctl: loggingSystemctl });
		assert.equal(prerequisite.available, true, prerequisite.reason);
		let cleanupAttempts = "";
		try {
			cleanupAttempts = await readFile(cleanupLog, "utf8");
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		}
		assert.equal(cleanupAttempts, "");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("command runner refuses unsupported platforms before execution", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(descriptor);
	Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
	try {
		const result = await runCommand({ evidence: evidence("printf never"), tree });
		assert.equal(result.outcome, "failed");
		if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "cleanup-unavailable");
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
});

test("POSIX process group: a passing command cleans its background process group before returning", { skip: process.platform === "darwin" || process.platform === "linux" ? false : "POSIX only" }, async () => {
	const result = await runProcessGroupCommand({ evidence: evidence('sleep 30 & printf "pid=%s\n" "$!"', "pid="), tree });
	assert.equal(result.outcome, "passed");
	if (result.outcome !== "passed") return;
	assert.equal(result.proof.containment, "process-group");
	assert.equal(result.proof.executorPath, result.proof.shellPath);
	const pid = Number(result.proof.stdout.match(/pid=(\d+)/)?.[1]);
	assert.ok(Number.isInteger(pid) && pid > 0);
	await waitForPidGone(pid);
});

test("POSIX process group: cleanup captures a descendant's TERM output before closing pipes", { skip: process.platform === "darwin" || process.platform === "linux" ? false : "POSIX only" }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-final-output-"));
	try {
		for (let iteration = 0; iteration < 50; iteration += 1) {
			const ready = path.join(directory, `ready-${iteration}`);
			const command = `sh -c 'trap "printf FINAL; exit 0" TERM; printf ready > "$1"; while :; do :; done' sh ${JSON.stringify(ready)} & while [ ! -s ${JSON.stringify(ready)} ]; do sleep 0.01; done; printf ROOT`;
			const result = await runProcessGroupCommand({ evidence: evidence(command, "FINAL"), tree });
			assert.equal(result.outcome, "passed", `iteration ${iteration}: ${JSON.stringify(result)}`);
			if (result.outcome === "passed") assert.equal(result.proof.stdout, "ROOTFINAL");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("POSIX process group: an escaped descendant holding stdout prevents a pass", { skip: process.platform === "darwin" || process.platform === "linux" ? false : "POSIX only" }, async (context) => {
	if (!existsSync("/usr/bin/perl")) { context.skip("Perl is unavailable"); return; }
	try { await access("/usr/bin/perl", constants.X_OK); }
	catch { context.skip("Perl is not executable"); return; }
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-escaped-pipe-"));
	const pidFile = path.join(directory, "pid");
	let escapedPid: number | undefined;
	let running: Promise<Awaited<ReturnType<typeof runCommand>>> | undefined;
	try {
		const command = `/usr/bin/perl -e 'use POSIX qw(setsid); setsid() or die "setsid failed"; $| = 1; open my $fh, ">", $ARGV[0] or die $!; print $fh "$$\\n"; close $fh; print "escaped=$$\\n"; sleep 30' ${JSON.stringify(pidFile)} & while [ ! -s ${JSON.stringify(pidFile)} ]; do sleep 0.01; done; printf ok`;
		const started = Date.now();
		running = runProcessGroupCommand({ evidence: evidence(command), tree }, { timeoutMs: 1_000 });
		escapedPid = await waitForPid(pidFile);
		const result = await running;
		const elapsed = Date.now() - started;
		assert.equal(result.outcome, "failed", JSON.stringify(result));
		if (result.outcome === "failed") assert.ok(result.failures.some((item) => item.code === "cleanup-failed" && /output pipes stayed open/.test(item.message)), JSON.stringify(result.failures));
		assert.ok(elapsed < 3_000, `escaped-pipe cleanup exceeded bounded budget: ${elapsed}ms`);
	} finally {
		if (running) await running.catch(() => undefined);
		if (escapedPid) {
			try { process.kill(escapedPid, "SIGKILL"); } catch { /* Already exited; no process remains to clean up. */ }
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("POSIX process group: a TERM-ignoring background child is killed via KILL", { skip: process.platform === "darwin" || process.platform === "linux" ? false : "POSIX only" }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-term-"));
	const ready = path.join(directory, "ready");
	try {
		const command = `sh -c 'trap "" TERM; printf ready > "$1"; while :; do sleep 30; done' sh ${JSON.stringify(ready)} & child=$!; while [ ! -s ${JSON.stringify(ready)} ]; do sleep 0.01; done; printf 'pid=%s\n' "$child"`;
		const result = await runProcessGroupCommand({ evidence: evidence(command, "pid="), tree });
		assert.equal(result.outcome, "passed", JSON.stringify(result));
		if (result.outcome !== "passed") return;
		const pid = Number(result.proof.stdout.match(/pid=(\d+)/)?.[1]);
		assert.ok(Number.isInteger(pid) && pid > 0);
		await waitForPidGone(pid);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("POSIX process group: timeout cleans the whole process group", { skip: process.platform === "darwin" || process.platform === "linux" ? false : "POSIX only" }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-timeout-macos-"));
	const pidFile = path.join(directory, "pid");
	let pid: number | undefined;
	let running: Promise<Awaited<ReturnType<typeof runCommand>>> | undefined;
	try {
		running = runProcessGroupCommand({ evidence: evidence(`sleep 30 & echo "$!" > ${JSON.stringify(pidFile)}; wait`, "never"), tree }, { timeoutMs: 250 });
		pid = await waitForPid(pidFile);
		const result = await running;
		assert.equal(result.outcome, "failed");
		if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "timeout");
		await waitForPidGone(pid);
	} finally {
		if (running) await running.catch(() => undefined);
		if (pid) await cleanupPid(pid);
		await rm(directory, { recursive: true, force: true });
	}
});

// Fully detached setsid/double-fork escapes on macOS are an accepted limit:
// these tests assert only containment of processes remaining in the original group.
test("both containment paths use the authored timeout when no runner override is provided", async () => {
	const slowEvidence = { ...evidence("sleep 1.2; printf ok"), timeout_ms: 3000 };
	const options = deterministicCommandOptions();
	const resolveExecutable = options.resolveExecutable!;
	for (const run of [runCommand, runProcessGroupCommand]) {
		const result = await run({ evidence: slowEvidence, tree }, {
			...options,
			// On Linux, /bin/sh is a symlink. PATH-shadow checks compare canonical paths.
			resolveExecutable: (executable) => executable === "sh" ? resolveVerifierExecutable("sh") : resolveExecutable(executable),
		});
		assert.equal(result.outcome, "observed", `${run.name}: ${JSON.stringify(result)}`);
		if (result.outcome === "observed") assert.equal(result.proof.timeout_ms, 3000);
	}
});

test("command runner requires execution plus a positive observed output", async () => {
	const passed = await runCommand({ evidence: evidence("printf ok"), tree }, deterministicCommandOptions());
	assert.equal(passed.outcome, "observed");
	if (passed.outcome === "observed") {
		assert.equal(passed.proof.stdout, "ok");
		assert.equal(passed.proof.exitCode, 0);
		assert.equal(passed.proof.gitPath, await resolveVerifierExecutable("git"));
		assert.ok(passed.proof.executorPath.startsWith("/"));
		assert.ok(passed.proof.shellPath.startsWith("/"));
		if (process.platform === "linux") assert.notEqual(passed.proof.executorPath, passed.proof.shellPath);
		assert.ok(passed.proof.startedAt <= passed.proof.finishedAt);
	}
	const missingFloorEvidence = { kind: "command" as const, run: "exit 0", expect: { exit: 0 } } as unknown as Parameters<typeof runCommand>[0]["evidence"];
	const missingFloor = await runCommand({ evidence: missingFloorEvidence, tree });
	assert.equal(missingFloor.outcome, "failed");
	if (missingFloor.outcome === "failed") assert.equal(missingFloor.failures[0]?.code, "positive-floor-missing");
	const emptyFloor = await runCommand({ evidence: { kind: "command", run: "exit 0", expect: { exit: 0, output_includes: "" } }, tree });
	assert.equal(emptyFloor.outcome, "failed");
	const malformedEvidence = { kind: "command" as const, run: "true", expect: { exit: 0 } } as unknown as Parameters<typeof evidenceKind>[0];
	assert.equal(evidenceKind(malformedEvidence), "command");
});

test("a caller-supplied launcher produces an observation, not verifier authority", async () => {
	let launchedFile = "";
	let launchedArgs: readonly string[] = [];
	let launchedEnvironment: NodeJS.ProcessEnv | undefined;
	const deterministic = deterministicCommandOptions();
	const marker = path.join(os.tmpdir(), `pi-work-authored-marker-${process.pid}`);
	await rm(marker, { force: true });
	const observed = await runCommand({ evidence: evidence(`touch ${marker}; printf AUTHORED_RAN`, "AUTHORED_RAN"), tree }, {
		resolveExecutable: deterministic.resolveExecutable,
		launcher: (file, args, options) => {
			launchedFile = file;
			launchedArgs = args;
			launchedEnvironment = options.env ? { ...options.env } : undefined;
			return deterministic.launcher!(file, args, options);
		},
	});
	assert.equal(observed.outcome, "observed");
	assert.ok(launchedFile.startsWith("/"));
	if (process.platform === "linux") assert.ok(launchedArgs.some((arg) => arg.startsWith("--setenv=PATH=")));
	else assert.deepEqual(launchedArgs, ["-c", observed.outcome === "observed" ? observed.proof.authoredCommand : ""]);
	assert.deepEqual(Object.keys(launchedEnvironment ?? {}).sort(), [...["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].filter((key) => process.env[key] !== undefined), ...(process.platform === "darwin" ? ["PATH"] : [])].sort());
	if (process.platform === "darwin") assert.equal(launchedEnvironment?.PATH, process.env.PATH);
	else assert.ok(!("PATH" in (launchedEnvironment ?? {})));
	if (observed.outcome === "observed") {
		assert.ok(observed.proof.executorPath.startsWith("/"));
		assert.ok(observed.proof.shellPath.startsWith("/"));
	}
	await rm(marker, { force: true });
});

test("launcher authority is snapshotted once and cannot toggle into trust", async () => {
	let reads = 0;
	const deterministic = deterministicCommandOptions();
	const options = {
		resolveExecutable: deterministic.resolveExecutable,
		get launcher() {
			reads += 1;
			return reads === 1 ? (_file: string, _args: readonly string[], spawnOptions: Parameters<typeof spawn>[2]) => spawn(process.execPath, ["-e", "process.stdout.write('AUTHORED_RAN')"], spawnOptions) : undefined;
		},
	};
	const result = await runCommand({ evidence: evidence("printf AUTHORED_RAN", "AUTHORED_RAN"), tree }, options);
	assert.equal(reads, 1);
	assert.equal(result.outcome, "observed");
});

test("command runner fails closed when a verifier executable cannot be resolved", async () => {
	const missingGit = await runCommand({ evidence: evidence("printf never", "never"), tree }, { resolveExecutable: async (executable) => executable === "git" ? undefined : resolveVerifierExecutable(executable) });
	assert.equal(missingGit.outcome, "failed");
	if (missingGit.outcome === "failed") assert.equal(missingGit.failures[0]?.code, "executable-unavailable");
	if (process.platform === "linux") {
		const missingExecutor = await runCommand({ evidence: evidence("printf never", "never"), tree }, { resolveExecutable: async (executable) => executable === "systemd-run" ? undefined : "/bin/sh" });
		assert.equal(missingExecutor.outcome, "failed");
		if (missingExecutor.outcome === "failed") assert.equal(missingExecutor.failures[0]?.code, "executable-unavailable");
	}
	const missingShell = await runCommand({ evidence: evidence("printf never", "never"), tree }, { resolveExecutable: async (executable) => executable === "sh" ? undefined : "/usr/bin/systemd-run" });
	assert.equal(missingShell.outcome, "failed");
	if (missingShell.outcome === "failed") assert.equal(missingShell.failures[0]?.code, "executable-unavailable");
	if (process.platform === "linux") {
		const invalidSystemctl = await runCommand({ evidence: evidence("sleep 10", "never"), tree }, { ...deterministicCommandOptions(), timeoutMs: 30, resolveExecutable: async (executable) => executable === "systemctl" ? "/bin/false" : deterministicCommandOptions().resolveExecutable!(executable) });
		assert.equal(invalidSystemctl.outcome, "failed");
		if (invalidSystemctl.outcome === "failed") assert.ok(invalidSystemctl.failures.some((failure) => failure.code === "cleanup-failed"));
	}
});

test("fixed executable resolution is independent of an empty authored PATH", async () => {
	const originalPath = process.env.PATH;
	process.env.PATH = "";
	try {
		const result = await runCommand({ evidence: evidence("printf fixed", "fixed"), tree }, deterministicCommandOptions());
		assert.equal(result.outcome, "observed");
		if (result.outcome === "observed") assert.ok(result.proof.executorPath.startsWith("/"));
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("executable resolution reports its typed unavailable error", async () => {
	const error = new ExecutableResolutionError("git");
	assert.equal(error.executable, "git");
	assert.match(error.message, /fixed absolute path/);
	assert.equal(await pathShadowsExecutable("systemd-run", "/usr/bin/systemd-run", ""), false);
});

test("command runner fails closed for missing commands and mismatched exits", async () => {
	const missing = await runCommand({ evidence: evidence("definitely_missing_pi_work_binary", "not found"), tree }, deterministicCommandOptions());
	assert.equal(missing.outcome, "failed");
	if (missing.outcome === "failed") assert.equal(missing.failures[0]?.code, "shell-unavailable");
	const mismatch = await runCommand({ evidence: evidence("printf nope; exit 7", "nope"), tree }, deterministicCommandOptions());
	assert.equal(mismatch.outcome, "failed");
	if (mismatch.outcome === "failed") {
		assert.equal(mismatch.failures[0]?.code, "exit-mismatch");
		assert.equal(mismatch.attempt.stdout, "nope");
		assert.deepEqual(mismatch.attempt.tree, tree);
	}
	const expectedNonZero = await runCommand({ evidence: evidence("printf expected; exit 7", "expected", 7), tree }, deterministicCommandOptions());
	assert.equal(expectedNonZero.outcome, "observed");
	const launchFailure = await runCommand({ evidence: evidence("printf never", "never"), tree }, { ...deterministicCommandOptions(), launcher: () => { throw new Error("sandbox denied"); } });
	assert.equal(launchFailure.outcome, "failed");
	if (launchFailure.outcome === "failed") assert.equal(launchFailure.failures[0]?.code, process.platform === "darwin" ? "spawn-error" : "cleanup-unavailable");
	const emittedFailure = await runCommand({ evidence: evidence("printf never", "never"), tree }, { ...deterministicCommandOptions(), launcher: (_file, _args, options) => spawn("/definitely-missing-pi-work-launcher", [], options) });
	assert.equal(emittedFailure.outcome, "failed");
	if (emittedFailure.outcome === "failed") assert.equal(emittedFailure.failures[0]?.code, process.platform === "darwin" ? "spawn-error" : "cleanup-unavailable");
});

test("command runner classifies abort, signals, and denied executables", async () => {
	const abortDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-abort-"));
	const pidFile = path.join(abortDirectory, "pid");
	const controller = new AbortController();
	let descendantPid: number | undefined;
	let abortPromise: Promise<Awaited<ReturnType<typeof runCommand>>> | undefined;
	try {
		abortPromise = runCommand({ evidence: evidence(ordinaryDescendantCommand(pidFile), "never"), tree, signal: controller.signal }, { ...deterministicCommandOptions(), timeoutMs: 1_000 });
		descendantPid = await waitForPid(pidFile);
		controller.abort();
		const aborted = await abortPromise;
		assert.equal(aborted.outcome, "failed");
		if (aborted.outcome === "failed") assert.equal(aborted.failures[0]?.code, "aborted");
		await waitForPidGone(descendantPid);
	} finally {
		controller.abort();
		if (abortPromise) await abortPromise.catch(() => undefined);
		if (descendantPid) await cleanupPid(descendantPid);
		await rm(abortDirectory, { recursive: true, force: true });
	}
	const signaled = await runCommand({ evidence: evidence("kill -TERM $$", "never"), tree }, deterministicCommandOptions());
	assert.equal(signaled.outcome, "failed");
	if (signaled.outcome === "failed") assert.equal(signaled.failures[0]?.code, "signaled");
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-"));
	const denied = path.join(directory, "denied");
	await writeFile(denied, "#!/bin/sh\nprintf denied\n");
	await chmod(denied, 0o644);
	const deniedResult = await runCommand({ evidence: evidence(denied, "Permission denied"), tree }, deterministicCommandOptions());
	assert.equal(deniedResult.outcome, "failed");
	if (deniedResult.outcome === "failed") assert.equal(deniedResult.failures[0]?.code, "shell-unavailable");
	await rm(directory, { recursive: true, force: true });
});

test("host integration: command runner bounds a new-session TERM-ignoring descendant", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-escape-"));
	const pidFile = path.join(directory, "pid");
	const started = Date.now();
	const escaped = await runCommand({ evidence: evidence(finalDescendantCommand(pidFile), "never"), tree }, { timeoutMs: CONTAINMENT_TIMEOUT_MS });
	const elapsed = Date.now() - started;
	assert.equal(escaped.outcome, "failed");
	if (escaped.outcome === "failed") assert.equal(escaped.failures[0]?.code, "timeout");
	assert.ok(elapsed < CONTAINMENT_TIMEOUT_MS + 1_500, `timeout cleanup took ${elapsed}ms`);
	await rm(directory, { recursive: true, force: true });
});

test("host integration: a bounded new-session descendant is observable and then killed", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-escape-pid-"));
	const pidFile = path.join(directory, "pid");
	// Observe the descendant while it is alive. Reading after the run returns
	// cannot work: containment destroys the whole cgroup, so a PID that was
	// never written before teardown is never written at all (#22).
	const pidPromise = waitForPid(pidFile, DESCENDANT_START_BUDGET_MS);
	try {
		const escaped = await runCommand({ evidence: evidence(finalDescendantCommand(pidFile), "never"), tree }, { timeoutMs: CONTAINMENT_TIMEOUT_MS });
		assert.equal(escaped.outcome, "failed");
		const pid = await pidPromise;
		assert.ok(pid > 0);
		await waitForPidGone(pid);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("host integration: injected launcher preserves systemd containment for a reparented descendant", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-launcher-"));
	const pidFile = path.join(directory, "pid");
	const injected = await runCommand({ evidence: evidence(finalDescendantCommand(pidFile), "never"), tree }, {
		timeoutMs: CONTAINMENT_TIMEOUT_MS,
		launcher: (file, args, options) => spawn(file, args, options),
	});
	assert.equal(injected.outcome, "failed");
	if (injected.outcome === "failed") assert.equal(injected.failures[0]?.code, "timeout");
	await rm(directory, { recursive: true, force: true });
});

test("host integration: an injected launcher's descendant is observable and then killed", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-launcher-pid-"));
	const pidFile = path.join(directory, "pid");
	// Same reasoning as the escape test above: observe while alive (#22).
	const pidPromise = waitForPid(pidFile, DESCENDANT_START_BUDGET_MS);
	try {
		const injected = await runCommand({ evidence: evidence(finalDescendantCommand(pidFile), "never"), tree }, {
			timeoutMs: CONTAINMENT_TIMEOUT_MS,
			launcher: (file, args, options) => spawn(file, args, options),
		});
		assert.equal(injected.outcome, "failed");
		const pid = await pidPromise;
		assert.ok(pid > 0);
		await waitForPidGone(pid);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("command runner kills timed out descendants and enforces output bound", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-timeout-"));
	const pidFile = path.join(directory, "pid");
	let descendantPid: number | undefined;
	let timeoutPromise: Promise<Awaited<ReturnType<typeof runCommand>>> | undefined;
	try {
		timeoutPromise = runCommand({ evidence: evidence(ordinaryDescendantCommand(pidFile), "never"), tree }, { ...deterministicCommandOptions(), timeoutMs: 50 });
		descendantPid = await waitForPid(pidFile);
		const timedOut = await timeoutPromise;
		assert.equal(timedOut.outcome, "failed");
		if (timedOut.outcome === "failed") assert.equal(timedOut.failures[0]?.code, "timeout");
		await waitForPidGone(descendantPid);
	} finally {
		if (timeoutPromise) await timeoutPromise.catch(() => undefined);
		if (descendantPid) await cleanupPid(descendantPid);
		await rm(directory, { recursive: true, force: true });
	}
	const tooMuch = await runCommand({ evidence: evidence("printf 123456789", "123"), tree }, { ...deterministicCommandOptions(), maxOutputBytes: 4 });
	assert.equal(tooMuch.outcome, "failed");
	if (tooMuch.outcome === "failed") assert.equal(tooMuch.failures[0]?.code, "output-limit");
});

test("command runner rejects recognized unusable-systemd stderr instead of claiming a pass", { skip: process.platform === "linux" ? false : "Linux only" }, async () => {
	const result = await runCommand({ evidence: evidence("printf never", "never"), tree }, {
		...deterministicCommandOptions(),
		launcher: (_file, _args, options) => spawn("/bin/sh", ["-c", "printf 'Failed to connect to bus\\n' >&2"], options),
	});
	assert.equal(result.outcome, "failed");
	if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "cleanup-unavailable");
});

test("command runner reports containment signalling failures instead of claiming cleanup", { skip: process.platform === "linux" ? false : "Linux only" }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-systemctl-"));
	const fakeSystemctl = path.join(directory, "systemctl");
	await writeFile(fakeSystemctl, "#!/bin/sh\n/usr/bin/systemctl \"$@\" >/dev/null 2>&1\ncase \"$*\" in *SIGTERM*) exit 1;; esac\nexit 0\n");
	await chmod(fakeSystemctl, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${directory}:${originalPath ?? ""}`;
	try {
		const result = await runCommand({ evidence: evidence("sleep 10", "never"), tree }, { ...deterministicCommandOptions(), timeoutMs: 50, resolveExecutable: async (executable) => executable === "systemctl" ? "/definitely-missing-pi-work-systemctl" : deterministicCommandOptions().resolveExecutable!(executable) });
		assert.equal(result.outcome, "failed");
		if (result.outcome === "failed") assert.ok(result.failures.some((failure) => failure.code === "cleanup-failed"));
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(directory, { recursive: true, force: true });
	}
});
