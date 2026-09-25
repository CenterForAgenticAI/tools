import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isAbsoluteExecutable, resolveVerifierExecutable, type VerifierExecutable } from "../../src/verify/executable.ts";
import type { CommandRunnerOptions } from "../../src/verify/command.ts";
import { REPO_ROOT } from "./source-under-test.ts";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 1_000;
const DESCENDANT_START_BUDGET_MS = 2_000;
const PROBE_POLL_INTERVAL_MS = 10;
const PROBE_STOP_GRACE_MS = 500;
const fallbackShell = "/bin/sh";
const fallbackSystemctl = "/bin/false";

export interface SystemdContainmentPrerequisite {
	available: boolean;
	/** The fixed-path user scope launcher passed its independent smoke test. */
	userScopeAvailable: boolean;
	reason?: string;
}

function fixedExecutable(candidates: readonly string[]): string | undefined {
	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next fixed path.
		}
	}
	return undefined;
}

function authoredCommand(args: readonly string[]): { command: string; shell: string; path?: string | undefined } {
	const commandIndex = args.indexOf("-c");
	return {
		command: commandIndex >= 0 ? args[commandIndex + 1] ?? "" : "",
		shell: commandIndex > 0 ? args[commandIndex - 1] ?? fallbackShell : fallbackShell,
		path: args.find((arg) => arg.startsWith("--setenv=PATH="))?.slice("--setenv=PATH=".length),
	};
}

function deterministicLauncher(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
	const authored = authoredCommand(args);
	const child = spawn(authored.shell, ["-c", authored.command], {
		...options,
		detached: true,
		env: { ...(options.env ?? {}), ...(authored.path === undefined ? {} : { PATH: authored.path }) },
	});
	const originalKill = child.kill.bind(child);
	child.kill = ((signal: NodeJS.Signals | number = "SIGTERM") => {
		if (typeof child.pid === "number") {
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch {
				// Fall back to the launcher PID when the process group has already gone.
			}
		}
		return originalKill(signal);
	}) as ChildProcess["kill"];
	void file;
	return child;
}

function fixedPath(executable: VerifierExecutable): string | undefined {
	if (executable === "git") return fixedExecutable(["/usr/local/bin/git", "/usr/bin/git", "/bin/git"]);
	if (executable === "sh") return fixedExecutable(["/bin/sh", "/usr/bin/sh"]);
	if (executable === "systemd-run") return fixedExecutable(["/usr/bin/systemd-run", "/bin/systemd-run"]);
	return undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProbePid(pidFile: string): Promise<boolean> {
	const deadline = Date.now() + DESCENDANT_START_BUDGET_MS;
	while (Date.now() < deadline) {
		try {
			const pid = Number((await readFile(pidFile, "utf8")).trim());
			if (Number.isInteger(pid) && pid > 0) return true;
		} catch {
			// The probe descendant has not written its PID yet.
		}
		await delay(PROBE_POLL_INTERVAL_MS);
	}
	return false;
}

async function stopProbeUnit(systemctl: string, unit: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
	// execFile's `timeout` only sends a signal; the promisified call still waits for
	// the child to exit. A systemctl that ignores that signal therefore never lets
	// this await settle, and the SIGKILL step and process-group fallback below are
	// never reached -- `npm run check` hangs instead of failing. Bound the wait
	// itself and release the child either way, so the ladder always continues.
	const child = execFile(systemctl, ["--user", "kill", "--kill-who=all", `--signal=${signal}`, unit], {
		cwd: REPO_ROOT,
		env: process.env,
		maxBuffer: 64 * 1024,
		encoding: "utf8",
	}, () => {
		// The probe may have exited before its cleanup signal was sent.
	});
	try {
		await Promise.race([
			new Promise<void>((resolve) => child.once("close", () => resolve())),
			delay(PROBE_TIMEOUT_MS),
		]);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGKILL");
			} catch { /* The cleanup child may have exited as the race settled. */ }
		}
		// Release the pipes so a cleanup child that outlives this call cannot hold
		// the run open through an inherited descriptor.
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.stdin?.destroy();
		child.unref();
	}
}

function waitForProbeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const onClose = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.removeListener("close", onClose);
			resolve(false);
		}, timeoutMs);
		child.once("close", onClose);
		if (child.exitCode !== null || child.signalCode !== null) onClose();
	});
}

async function probeContainedDescendant(systemdRun: string, shell: string, systemctl: string): Promise<string | undefined> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-command-prerequisite-"));
	const pidFile = path.join(directory, "pid");
	const unitName = `pi-work-test-prerequisite-${process.pid}`;
	const unit = `${unitName}.scope`;
	const command = `sh -c 'printf "%s\\n" "$$" > "$1"' sh ${JSON.stringify(pidFile)}`;
	const child = spawn(systemdRun, [
		"--user", "--scope", "--quiet", "--expand-environment=no", "--setenv=PATH=/usr/bin:/bin",
		`--unit=${unitName}`, "--property=KillMode=control-group", `--working-directory=${REPO_ROOT}`,
		shell, "-c", command,
	], { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "ignore", "pipe"], detached: true });
	let stderr = "";
	const onStderr = (chunk: string) => { stderr += chunk; };
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", onStderr);
	let reason: string | undefined;
	try {
		if (!await waitForProbePid(pidFile)) {
			const detail = stderr.split("\n")[0]?.trim();
			reason = `host integration could not start a contained descendant within ${DESCENDANT_START_BUDGET_MS}ms${detail ? `: ${detail.slice(0, 240)}` : ""}`;
		} else if (!await waitForProbeExit(child, PROBE_TIMEOUT_MS)) {
			reason = `host integration probe did not exit within ${PROBE_TIMEOUT_MS}ms`;
		}
	} finally {
		// The command is finite, so a successful probe has already closed this
		// child. These bounded calls only cover a broken systemd-run as a safety net.
		if (child.exitCode === null && child.signalCode === null) {
			await stopProbeUnit(systemctl, unit, "SIGTERM");
			await waitForProbeExit(child, PROBE_STOP_GRACE_MS);
			if (child.exitCode === null && child.signalCode === null) {
				await stopProbeUnit(systemctl, unit, "SIGKILL");
				await waitForProbeExit(child, PROBE_STOP_GRACE_MS);
			}
		}
		if (child.exitCode === null && child.signalCode === null) {
			try {
				if (typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch { /* The launcher may have exited between probes. */ }
			await waitForProbeExit(child, PROBE_STOP_GRACE_MS);
		}
		if (child.exitCode === null && child.signalCode === null) {
			try {
				if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* The launcher may have exited between probes. */ }
			await waitForProbeExit(child, PROBE_STOP_GRACE_MS);
		}
		child.stderr?.removeListener("data", onStderr);
		child.stderr?.destroy();
		child.unref();
		await rm(directory, { recursive: true, force: true });
	}
	return reason;
}

/** Return fresh observation-only command options that execute authored commands directly. */
export function deterministicCommandOptions(): CommandRunnerOptions {
	return {
		launcher: deterministicLauncher,
		resolveExecutable: async (executable) => {
			if (executable === "systemctl") return fallbackSystemctl;
			// The observation-only launcher never spawns this executable. Keep its
			// claimed scope path distinct from the shell even on minimal Linux images.
			return fixedPath(executable) ?? (executable === "systemd-run" ? "/usr/bin/systemd-run" : undefined);
		},
	};
}

export interface SystemdContainmentPrerequisiteOptions {
	/** Test-only executable overrides for deterministic probe failure coverage. */
	shell?: string;
	systemdRun?: string;
	systemctl?: string;
}

let prerequisitePromise: Promise<SystemdContainmentPrerequisite> | undefined;

async function checkSystemdContainmentPrerequisite(options: SystemdContainmentPrerequisiteOptions): Promise<SystemdContainmentPrerequisite> {
	if (process.platform !== "linux") return { available: false, userScopeAvailable: false, reason: "host integration requires Linux systemd user scopes" };
	const [git, resolvedShell, resolvedSystemdRun, resolvedSystemctl] = await Promise.all([
		resolveVerifierExecutable("git").catch(() => undefined),
		options.shell ?? resolveVerifierExecutable("sh").catch(() => undefined),
		options.systemdRun ?? resolveVerifierExecutable("systemd-run").catch(() => undefined),
		options.systemctl ?? resolveVerifierExecutable("systemctl").catch(() => undefined),
	]);
	if (!git || !isAbsoluteExecutable(git)) return { available: false, userScopeAvailable: false, reason: "host integration requires a fixed-path git executable" };
	if (!resolvedShell || !isAbsoluteExecutable(resolvedShell)) return { available: false, userScopeAvailable: false, reason: "host integration requires a fixed-path sh executable" };
	if (!resolvedSystemdRun || !isAbsoluteExecutable(resolvedSystemdRun)) return { available: false, userScopeAvailable: false, reason: "host integration requires fixed-path systemd-run" };
	if (!resolvedSystemctl || !isAbsoluteExecutable(resolvedSystemctl)) return { available: false, userScopeAvailable: false, reason: "host integration requires fixed-path systemctl" };
	try {
		await execFileAsync(resolvedSystemdRun, [
			"--user", "--scope", "--quiet", "--expand-environment=no", "--setenv=PATH=/usr/bin:/bin",
			`--unit=pi-work-test-prerequisite-${process.pid}-scope`, "--property=KillMode=control-group", `--working-directory=${REPO_ROOT}`,
			resolvedShell, "-c", "exit 0",
		], { cwd: REPO_ROOT, env: process.env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8" });
	} catch (error) {
		const detail = error instanceof Error ? error.message.split("\n")[0] : String(error).split("\n")[0];
		return { available: false, userScopeAvailable: false, reason: `host integration systemd user scope unavailable: ${detail.slice(0, 240)}` };
	}
	const descendantReason = await probeContainedDescendant(resolvedSystemdRun, resolvedShell, resolvedSystemctl);
	return descendantReason === undefined
		? { available: true, userScopeAvailable: true }
		: { available: false, userScopeAvailable: true, reason: descendantReason };
}

/** Check the exact fixed-path user-scope capability required by production containment. */
export function systemdContainmentPrerequisite(options: SystemdContainmentPrerequisiteOptions = {}): Promise<SystemdContainmentPrerequisite> {
	if (Object.keys(options).length > 0) return checkSystemdContainmentPrerequisite(options);
	prerequisitePromise ??= checkSystemdContainmentPrerequisite(options);
	return prerequisitePromise;
}
