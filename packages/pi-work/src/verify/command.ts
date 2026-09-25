import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

import type { CommandEvidence } from "../schema/workspec.js";
import { captureAuthoredPath, captureSystemdEnvironment, isAbsoluteExecutable, pathShadowsExecutable, resolveVerifierExecutable, type VerifierExecutable } from "./executable.js";
import type { CommandExecutionProof, CriterionAttempt, TreeIdentity, TreeMonitoringProof, VerificationFailure } from "./results.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TERM_GRACE_MS = 150;
const KILL_GRACE_MS = 150;
const SYSTEMD_COMMAND_TIMEOUT_MS = 100;
const execFileAsync = promisify(execFile);
let containmentCounter = 0;

type Launcher = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type ExecutableResolver = (executable: VerifierExecutable) => Promise<string | undefined>;

export interface CommandRunnerOptions {
	timeoutMs?: number | undefined;
	maxOutputBytes?: number | undefined;
	launcher?: Launcher | undefined;
	/** Observation-only test seam; the authority always uses fixed-path resolution. */
	resolveExecutable?: ExecutableResolver | undefined;
}

export interface CommandRunInput {
	evidence: CommandEvidence;
	tree: TreeIdentity;
	signal?: AbortSignal | undefined;
	untrackedPaths?: () => readonly string[];
	drainObservation?: () => Promise<void>;
	monitoring?: () => TreeMonitoringProof;
	gitPath?: string;
}

export type CommandRunOutcome =
	| { outcome: "passed"; proof: CommandExecutionProof }
	| { outcome: "observed"; proof: CommandExecutionProof }
	| { outcome: "failed"; attempt: CriterionAttempt; failures: VerificationFailure[] };

function now(): string { return new Date().toISOString(); }

const inferredSignals: Readonly<Record<number, NodeJS.Signals>> = {
	129: "SIGHUP", 130: "SIGINT", 131: "SIGQUIT", 134: "SIGABRT", 137: "SIGKILL", 141: "SIGPIPE", 143: "SIGTERM",
};

function inferredSignal(code: number | null): NodeJS.Signals | null {
	return code === null ? null : inferredSignals[code] ?? null;
}

interface FailureExtras {
	expected?: number | string;
	actual?: number | null;
	errorCode?: string;
	signal?: NodeJS.Signals;
	exitCode?: number;
	executable?: string;
}

function failure(code: VerificationFailure["code"], message: string, extra: FailureExtras = {}): VerificationFailure {
	if (code === "positive-floor-missing") return { code, message };
	if (code === "timeout") return { code, message, timedOut: true };
	if (code === "aborted") return { code, message };
	if (code === "output-limit") return { code, message };
	if (code === "shell-unavailable") return { code, message, exitCode: extra.exitCode === 126 ? 126 : 127 };
	if (code === "signaled") return { code, message, signal: extra.signal ?? "SIGTERM" };
	if (code === "exit-mismatch") return { code, message, expected: typeof extra.expected === "number" ? extra.expected : 0, actual: extra.actual ?? null };
	if (code === "output-mismatch") return { code, message, expected: typeof extra.expected === "string" ? extra.expected : "" };
	if (code === "spawn-error") return { code, message, ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }) };
	if (code === "executable-unavailable") return { code, message, executable: extra.executable ?? "unknown" };
	if (code === "cleanup-unavailable" || code === "cleanup-failed") return { code, message };
	return { code: "spawn-error", message };
}

function outputText(chunks: Buffer[]): string { return Buffer.concat(chunks).toString("utf8"); }

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function systemdUnavailable(stderr: string): boolean {
	return /Failed to connect to (?:the )?(?:user )?scope bus|Failed to connect to bus|Failed to create bus connection|Failed to start transient scope unit|Connection refused/i.test(stderr);
}

async function signalSystemdUnit(unit: string, signal: NodeJS.Signals, resolveExecutable: ExecutableResolver, environment: NodeJS.ProcessEnv): Promise<boolean> {
	try {
		const systemctl = await resolveExecutable("systemctl");
		if (!systemctl || !isAbsoluteExecutable(systemctl)) return false;
		await execFileAsync(systemctl, ["--user", "kill", "--kill-who=all", `--signal=${signal}`, unit], {
			encoding: "utf8",
			timeout: SYSTEMD_COMMAND_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
			windowsHide: true,
			env: environment,
		});
		return true;
	} catch {
		return false;
	}
}

function processGroupExists(pgid: number): boolean {
	try { process.kill(-pgid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		// macOS can report EPERM for a group whose remaining members are
		// exiting; it is not proof that the group is empty.
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

async function waitForProcessGroup(pgid: number, milliseconds: number): Promise<boolean> {
	const deadline = Date.now() + milliseconds;
	while (processGroupExists(pgid)) {
		if (Date.now() >= deadline) return false;
		await delay(Math.min(10, deadline - Date.now()));
	}
	return true;
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	try { process.kill(-pgid, signal); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		// EPERM is tolerated only until the final ESRCH check below.
	}
}

async function waitForClose(closePromise: Promise<void>, milliseconds: number): Promise<boolean> {
	let timedOut = false;
	await Promise.race([closePromise, delay(milliseconds).then(() => { timedOut = true; })]);
	return !timedOut;
}

/** Narrow W4 seam: replace this executor with pi-delegate #154 while retaining this result contract. */
export async function runCommand(input: CommandRunInput, options: CommandRunnerOptions = {}): Promise<CommandRunOutcome> {
	const injectedLauncher = options.launcher;
	const resolveExecutable: ExecutableResolver = options.resolveExecutable ?? (async (executable) => {
		try { return await resolveVerifierExecutable(executable); } catch { return undefined; }
	});
	const environment = captureSystemdEnvironment();
	const authoredPath = captureAuthoredPath();
	const startedAt = now();
	const timeoutMs = Math.max(1, options.timeoutMs ?? input.evidence.timeout_ms ?? DEFAULT_TIMEOUT_MS);
	const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
	const expectation = input.evidence.expect;
	const authoredCommand = input.evidence.run;
	const attemptBase = (finishedAt: string): CriterionAttempt => ({ kind: input.evidence.kind, evidence: input.evidence, startedAt, finishedAt, tree: input.tree });
	const expectedOutput = expectation.output_includes;
	if (expectedOutput === undefined || expectedOutput.length === 0) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("positive-floor-missing", "command evidence requires a non-empty expect.output_includes")] };
	}

	if (process.platform !== "linux" && process.platform !== "darwin") {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("cleanup-unavailable", "bounded descendant containment requires Linux systemd user scopes")] };
	}
	const useSystemdContainment = process.platform === "linux";
	const gitPath = input.gitPath ?? await resolveExecutable("git");
	if (!gitPath || !isAbsoluteExecutable(gitPath)) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("executable-unavailable", "cannot resolve the verifier git executable", { executable: "git" })] };
	}
	const shellPath = await resolveExecutable("sh");
	const executorPath = useSystemdContainment ? await resolveExecutable("systemd-run") : shellPath;
	if (!executorPath || !isAbsoluteExecutable(executorPath)) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("executable-unavailable", "cannot resolve the verifier containment executable", { executable: "systemd-run" })] };
	}
	if (useSystemdContainment && await pathShadowsExecutable("systemd-run", executorPath, authoredPath)) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("executable-unavailable", "caller PATH shadows the verifier containment executable", { executable: "systemd-run" })] };
	}
	if (!shellPath || !isAbsoluteExecutable(shellPath)) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("executable-unavailable", "cannot resolve the verifier shell executable", { executable: "sh" })] };
	}
	if (!useSystemdContainment && await pathShadowsExecutable("sh", shellPath, authoredPath)) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure("executable-unavailable", "caller PATH shadows the verifier shell executable", { executable: "sh" })] };
	}
	// A careless or hostile command must not leave an in-group descendant
	// behind or claim success before cleanup. A deliberate setsid escape that
	// also closes its output pipes is outside macOS containment (accepted limit).
	const unitName = useSystemdContainment ? `pi-work-${process.pid}-${++containmentCounter}` : undefined;
	const unit = unitName === undefined ? undefined : `${unitName}.scope`;
	const launcher = injectedLauncher ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let outputBytes = 0;
	let outputOverflow = false;
	let timedOut = false;
	let aborted = false;
	let wakeTermination: (() => void) | undefined;
	let closed = false;
	let spawnError: NodeJS.ErrnoException | undefined;
	let closeCode: number | null = null;
	let closeSignal: NodeJS.Signals | null = null;
	let child: ChildProcess;
	try {
		const file = useSystemdContainment ? executorPath : shellPath;
		const args = useSystemdContainment
			? ["--user", "--scope", "--quiet", "--expand-environment=no", `--setenv=PATH=${authoredPath}`, `--unit=${unitName}`, "--property=KillMode=control-group", `--working-directory=${input.tree.worktreePath}`, shellPath, "-c", authoredCommand]
			: ["-c", authoredCommand];
		child = launcher(file, args, {
			cwd: input.tree.worktreePath,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: useSystemdContainment ? environment : { ...environment, PATH: authoredPath },
		});
	} catch (error) {
		const finishedAt = now();
		const code = useSystemdContainment ? "cleanup-unavailable" : "spawn-error";
		return { outcome: "failed", attempt: attemptBase(finishedAt), failures: [failure(code, error instanceof Error ? error.message : String(error))] };
	}

	const rootPid = child.pid;
	let rootExited = false;
	let resolveExit: () => void = () => undefined;
	const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
	const closePromise = new Promise<void>((resolve) => {
		const append = (chunks: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				outputOverflow = true;
				wakeTermination?.();
				return;
			}
			chunks.push(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => append(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		child.stderr?.on("data", (chunk: Buffer | string) => append(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; resolveExit(); });
		child.once("exit", () => { rootExited = true; resolveExit(); });
		child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
			closeCode = code;
			closeSignal = signal;
			closed = true;
			resolve();
		});
	});

	let cleanupStarted = false;
	let cleanupFailure: string | undefined;
	const cleanup = async (): Promise<void> => {
		if (cleanupStarted) return;
		cleanupStarted = true;
		if (typeof rootPid === "number") {
			if (!useSystemdContainment) {
				try {
					signalProcessGroup(rootPid, "SIGTERM");
					if (!await waitForProcessGroup(rootPid, TERM_GRACE_MS)) {
						signalProcessGroup(rootPid, "SIGKILL");
						if (!await waitForProcessGroup(rootPid, KILL_GRACE_MS)) cleanupFailure = `process group ${rootPid} remained after SIGKILL`;
					}
				} catch (error) {
					cleanupFailure = `failed to clean process group ${rootPid}: ${error instanceof Error ? error.message : String(error)}`;
				}
			} else {
				if (!await signalSystemdUnit(unit!, "SIGTERM", resolveExecutable, environment)) cleanupFailure = `failed to signal containment unit ${unit} with SIGTERM`;
				if (!await waitForClose(closePromise, TERM_GRACE_MS)) {
					if (!await signalSystemdUnit(unit!, "SIGKILL", resolveExecutable, environment)) cleanupFailure ??= `failed to signal containment unit ${unit} with SIGKILL`;
				}
				await waitForClose(closePromise, KILL_GRACE_MS);
			}
		} else if (!useSystemdContainment && !spawnError) {
			cleanupFailure = "process group id was not established";
		}
		// On macOS, let the emptied group close its inherited pipes before
		// destroying them; TERM handlers can still have output in flight.
		// A pipe still open after the group exits reveals an escaped descendant.
		// Keep the systemd stream cleanup ordering unchanged.
		if (useSystemdContainment) {
			child.stdout?.destroy();
			child.stderr?.destroy();
		} else if (!await waitForClose(closePromise, KILL_GRACE_MS)) {
			cleanupFailure ??= "command output pipes stayed open after the process group exited; a descendant escaped the process group";
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
		if (!closed) {
			try { child.kill("SIGKILL"); } catch { cleanupFailure ??= "failed to signal command launcher"; }
		}
	};

	const terminationPromise = new Promise<void>((resolve) => { wakeTermination = resolve; });
	const timeout = setTimeout(() => {
		if (!closed) {
			timedOut = true;
			wakeTermination?.();
		}
	}, timeoutMs);
	let abortListener: (() => void) | undefined;
	if (input.signal) {
		abortListener = () => {
			if (!closed) {
				aborted = true;
				wakeTermination?.();
			}
		};
		if (input.signal.aborted) abortListener();
		else input.signal.addEventListener("abort", abortListener, { once: true });
	}
	if (input.signal?.aborted) aborted = true;
	await Promise.race([useSystemdContainment ? closePromise : exitPromise, terminationPromise]);
	if (!useSystemdContainment || !closed) await cleanup();
	if (!useSystemdContainment && !closed) await waitForClose(closePromise, KILL_GRACE_MS);
	clearTimeout(timeout);
	if (abortListener && input.signal) input.signal.removeEventListener("abort", abortListener);
	await input.drainObservation?.();
	const finishedAt = now();
	const stdout = outputText(stdoutChunks);
	const stderr = outputText(stderrChunks);
	const reportedSignal = closeSignal ?? inferredSignal(closeCode);
	const attempt: CriterionAttempt = { kind: input.evidence.kind, evidence: input.evidence, startedAt, finishedAt, tree: input.tree, stdout, stderr, exitCode: closeCode, signal: reportedSignal };
	const cleanupFailures: VerificationFailure[] = cleanupFailure === undefined ? [] : [failure("cleanup-failed", cleanupFailure)];
	if (spawnError) {
		const code = useSystemdContainment ? "cleanup-unavailable" : "spawn-error";
		return { outcome: "failed", attempt, failures: [failure(code, spawnError.message, spawnError.code === undefined ? {} : { errorCode: spawnError.code }), ...cleanupFailures] };
	}
	if (useSystemdContainment && systemdUnavailable(stderr)) return { outcome: "failed", attempt, failures: [failure("cleanup-unavailable", stderr), ...cleanupFailures] };
	if (timedOut) return { outcome: "failed", attempt, failures: [failure("timeout", `command exceeded ${timeoutMs}ms`), ...cleanupFailures] };
	if (aborted) return { outcome: "failed", attempt, failures: [failure("aborted", "command was aborted"), ...cleanupFailures] };
	if (outputOverflow) return { outcome: "failed", attempt, failures: [failure("output-limit", `command output exceeded ${maxOutputBytes} bytes`), ...cleanupFailures] };
	if (cleanupFailure) return { outcome: "failed", attempt, failures: cleanupFailures };
	if (!closed || (!useSystemdContainment && !rootExited && !spawnError)) return { outcome: "failed", attempt, failures: [failure("timeout", "command did not complete before the hard cleanup deadline"), ...cleanupFailures] };
	if (reportedSignal) return { outcome: "failed", attempt, failures: [failure("signaled", `command terminated by ${reportedSignal}`, { signal: reportedSignal }), ...cleanupFailures] };
	if (closeCode === 126 || closeCode === 127) return { outcome: "failed", attempt, failures: [failure("shell-unavailable", `shell could not execute command (exit ${closeCode})`, { exitCode: closeCode }), ...cleanupFailures] };
	if (closeCode !== expectation.exit) return { outcome: "failed", attempt, failures: [failure("exit-mismatch", `expected exit ${expectation.exit}, got ${String(closeCode)}`, { expected: expectation.exit, actual: closeCode }), ...cleanupFailures] };
	if (!stdout.includes(expectedOutput) && !stderr.includes(expectedOutput)) return { outcome: "failed", attempt, failures: [failure("output-mismatch", `output did not include ${JSON.stringify(expectedOutput)}`, { expected: expectedOutput }), ...cleanupFailures] };
	const monitoring: TreeMonitoringProof = input.monitoring?.() ?? {
		method: "none",
		mode: "none",
		window: { startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) },
		residualRace: "not-monitored",
	};
	const proof: CommandExecutionProof = {
		kind: "command-proof", containment: useSystemdContainment ? "systemd-scope" : "process-group", authoredCommand, ...(input.evidence.timeout_ms === undefined ? {} : { timeout_ms: input.evidence.timeout_ms }), gitPath, executorPath, shellPath, expectation, stdout, stderr, exitCode: closeCode, signal: closeSignal,
		outputMatched: expectedOutput, untrackedPaths: [...(input.untrackedPaths?.() ?? [])], monitoring, startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), tree: input.tree,
	};
	// A caller-supplied launcher remains useful for containment tests, but its
	// claim about what ran is observational rather than verifier authority.
	return injectedLauncher === undefined ? { outcome: "passed", proof } : { outcome: "observed", proof };
}

export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS };
