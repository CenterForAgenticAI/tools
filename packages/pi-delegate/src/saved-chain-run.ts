import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EnvOverrides } from "./env-overrides.js";
import { materializeEnv, normalizeEnvOverrides } from "./env-overrides.js";
import { MAX_TIMEOUT_MS } from "./fork-timeout.js";
import { enumerateForkDescendants, sweepKill } from "./process-sweep.js";

export const DEFAULT_SAVED_CHAIN_RUN_TIMEOUT_MS = 60_000;
export const MAX_SAVED_CHAIN_RUN_OUTPUT_BYTES = 8_192;
const RUN_STOP_GRACE_MS = 500;
const RUN_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ESCAPE_CHARACTER = "\u001b";
const BELL_CHARACTER = "\u0007";
const ANSI_ESCAPE_PATTERN = new RegExp(
	`${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\))`,
	"gu",
);
const UNSAFE_CONTROL_PATTERN = new RegExp(
	String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
	"gu",
);
const ERROR_CONTROL_PATTERN = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`, "gu");

export interface SavedChainRunStepLike {
	run: string;
	command: string;
	cwd?: string;
	env?: EnvOverrides;
	timeoutMs?: number;
}

export interface PreparedSavedChainRunStep {
	label: string;
	command: string;
	cwd: string;
	env?: EnvOverrides;
	timeoutMs: number;
}

export interface SavedChainRunResult {
	status: "completed" | "failed" | "aborted";
	diagnostic: string;
	/** Bounded, sanitized output in the order stdout/stderr chunks were observed. */
	output?: string;
	/** Bounded, sanitized stdout captured before the process settled. */
	stdout?: string;
	/** Bounded, sanitized stderr captured before the process settled. */
	stderr?: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
}

export function validateSavedChainRunLabel(value: unknown, field = "run stage label"): string {
	if (typeof value !== "string" || !RUN_LABEL_PATTERN.test(value)) {
		throw new TypeError(`${field} must match ${RUN_LABEL_PATTERN.source}`);
	}
	return value;
}

export function validateSavedChainRunCommand(value: unknown, field = "run stage command"): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	if (value.includes("\n") || value.includes("\r") || value.includes("\u0000")) {
		throw new TypeError(`${field} must be one line without NUL bytes`);
	}
	return value;
}

export function validateSavedChainRunCwd(value: unknown, field = "run stage cwd"): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.includes("\n") ||
		value.includes("\r") ||
		value.includes("\u0000")
	) {
		throw new TypeError(`${field} must be a non-empty single-line path`);
	}
	return value;
}

export function validateSavedChainRunTimeoutMs(
	value: unknown,
	field = "run stage timeoutMs",
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_TIMEOUT_MS
	) {
		throw new TypeError(`${field} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
	}
	return value;
}

export function prepareSavedChainRunStep(
	step: SavedChainRunStepLike,
	baseCwd: string,
): PreparedSavedChainRunStep {
	const label = validateSavedChainRunLabel(step.run);
	const command = validateSavedChainRunCommand(step.command);
	const env = step.env === undefined ? undefined : normalizeEnvOverrides(step.env);
	const configuredCwd = validateSavedChainRunCwd(step.cwd);
	const cwd = configuredCwd
		? path.isAbsolute(configuredCwd) ? configuredCwd : path.resolve(baseCwd, configuredCwd)
		: baseCwd;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(cwd);
		fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
	} catch {
		throw new Error(`run stage '${label}' cwd does not exist or is not readable: ${cwd}`);
	}
	if (!stat.isDirectory()) throw new Error(`run stage '${label}' cwd is not a directory: ${cwd}`);
	return {
		label,
		command,
		cwd,
		...(env === undefined ? {} : { env }),
		timeoutMs: validateSavedChainRunTimeoutMs(step.timeoutMs) ?? DEFAULT_SAVED_CHAIN_RUN_TIMEOUT_MS,
	};
}

interface BoundedCapture {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
}

function captureChunk(capture: BoundedCapture, chunk: Buffer | string): void {
	if (capture.truncated) return;
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	const remaining = MAX_SAVED_CHAIN_RUN_OUTPUT_BYTES - capture.bytes;
	if (remaining <= 0) {
		capture.truncated = true;
		return;
	}
	if (buffer.length > remaining) {
		capture.chunks.push(buffer.subarray(0, remaining));
		capture.bytes += remaining;
		capture.truncated = true;
		return;
	}
	capture.chunks.push(buffer);
	capture.bytes += buffer.length;
}
function completeUtf8Prefix(buffer: Buffer): Buffer {
	if (buffer.length === 0) return buffer;
	let sequenceStart = buffer.length - 1;
	while (sequenceStart >= 0 && (buffer[sequenceStart]! & 0xc0) === 0x80) sequenceStart -= 1;
	if (sequenceStart < 0) return Buffer.alloc(0);
	const lead = buffer[sequenceStart]!;
	const expectedLength = lead < 0x80
		? 1
		: (lead & 0xe0) === 0xc0 ? 2
			: (lead & 0xf0) === 0xe0 ? 3
				: (lead & 0xf8) === 0xf0 ? 4 : 1;
	return buffer.length - sequenceStart < expectedLength ? buffer.subarray(0, sequenceStart) : buffer;
}

function safeCapturedText(capture: BoundedCapture): string {
	const buffer = Buffer.concat(capture.chunks, capture.bytes);
	let text = (capture.truncated ? completeUtf8Prefix(buffer) : buffer).toString("utf8");
	text = text
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(/\r\n?/gu, "\n")
		.replace(UNSAFE_CONTROL_PATTERN, "�")
		.trimEnd();
	if (capture.truncated) {
		text += `${text ? "\n" : ""}[output truncated at ${MAX_SAVED_CHAIN_RUN_OUTPUT_BYTES} bytes]`;
	}
	return text;
}

function formatRunDiagnostic(
	label: string,
	summary: string,
	stdout: BoundedCapture,
	stderr: BoundedCapture,
): string {
	const blocks = [`run stage '${label}' ${summary}`];
	const stdoutText = safeCapturedText(stdout);
	const stderrText = safeCapturedText(stderr);
	if (stdoutText) blocks.push(`stdout:\n${stdoutText}`);
	if (stderrText) blocks.push(`stderr:\n${stderrText}`);
	return blocks.join("\n\n");
}

function stopProcess(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		// Saved run stages rely on POSIX process groups; Windows is deliberately not supported.
		process.kill(-pid, signal);
	} catch {
		// The process may have exited between the terminal event and this signal.
	}
}

export async function runSavedChainCommand(
	step: PreparedSavedChainRunStep,
	chainDir: string,
	signal?: AbortSignal,
): Promise<SavedChainRunResult> {
	const output: BoundedCapture = { chunks: [], bytes: 0, truncated: false };
	const stdout: BoundedCapture = { chunks: [], bytes: 0, truncated: false };
	const stderr: BoundedCapture = { chunks: [], bytes: 0, truncated: false };
	if (signal?.aborted) {
		return {
			status: "aborted",
			diagnostic: formatRunDiagnostic(step.label, "was cancelled before it started.", stdout, stderr),
			output: "",
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			timedOut: false,
		};
	}

	return new Promise<SavedChainRunResult>((resolve) => {
		const env = materializeEnv(step.env);
		env.PI_DELEGATE_CHAIN_DIR = path.resolve(chainDir);
		const child = spawn(step.command, {
			cwd: step.cwd,
			env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let finished = false;
		let terminationCause: "timeout" | "aborted" | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let killBackstop: NodeJS.Timeout | undefined;

		const cleanup = (): void => {
			if (timeout) clearTimeout(timeout);
			if (killBackstop && terminationCause === undefined) clearTimeout(killBackstop);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: Omit<SavedChainRunResult, "output" | "stdout" | "stderr">): void => {
			if (finished) return;
			finished = true;
			cleanup();
			resolve({
				...result,
				output: safeCapturedText(output),
				stdout: safeCapturedText(stdout),
				stderr: safeCapturedText(stderr),
			});
		};
		const finishTermination = (
			code: number | null,
			closeSignal: NodeJS.Signals | null,
		): boolean => {
			if (terminationCause === "aborted") {
				finish({
					status: "aborted",
					diagnostic: formatRunDiagnostic(step.label, "was cancelled.", stdout, stderr),
					exitCode: code,
					signal: closeSignal,
					timedOut: false,
				});
				return true;
			}
			if (terminationCause === "timeout") {
				finish({
					status: "failed",
					diagnostic: formatRunDiagnostic(step.label, `timed out after ${step.timeoutMs}ms.`, stdout, stderr),
					exitCode: code,
					signal: closeSignal,
					timedOut: true,
				});
				return true;
			}
			return false;
		};
		const requestStop = (): void => {
			// Snapshot descendants while the shell is still their ancestor. A child
			// may start a new process group and be reparented after the shell exits.
			const descendants = child.pid === undefined
				? []
				: enumerateForkDescendants(child.pid, 0);
			if (descendants.length > 0) {
				void sweepKill(descendants, RUN_STOP_GRACE_MS).catch(() => {});
			}
			stopProcess(child.pid, "SIGTERM");
			killBackstop = setTimeout(() => {
				// Escaped descendants can keep inherited pipes open after the shell dies.
				// Close our readers and settle even when ChildProcess never emits close.
				stopProcess(child.pid, "SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
				finishTermination(null, null);
			}, RUN_STOP_GRACE_MS);
			killBackstop.unref?.();
		};
		const onAbort = (): void => {
			if (terminationCause !== undefined) return;
			terminationCause = "aborted";
			requestStop();
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			captureChunk(stdout, chunk);
			captureChunk(output, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			captureChunk(stderr, chunk);
			captureChunk(output, chunk);
		});
		child.once("error", (error) => {
			if (finishTermination(null, null)) return;
			const safeError = String(error instanceof Error ? error.message : error)
				.replace(ANSI_ESCAPE_PATTERN, "")
				.replace(ERROR_CONTROL_PATTERN, "�")
				.slice(0, 512);
			finish({
				status: "failed",
				diagnostic: formatRunDiagnostic(step.label, `could not start: ${safeError}`, stdout, stderr),
				exitCode: null,
				signal: null,
				timedOut: false,
			});
		});
		child.once("close", (code, closeSignal) => {
			if (finishTermination(code, closeSignal)) return;
			if (code === 0) {
				finish({
					status: "completed",
					diagnostic: formatRunDiagnostic(step.label, "exited with code 0.", stdout, stderr),
					exitCode: 0,
					signal: closeSignal,
					timedOut: false,
				});
				return;
			}
			const summary = code === null
				? `ended by signal ${closeSignal ?? "unknown"}.`
				: `exited with code ${code}.`;
			finish({
				status: "failed",
				diagnostic: formatRunDiagnostic(step.label, summary, stdout, stderr),
				exitCode: code,
				signal: closeSignal,
				timedOut: false,
			});
		});

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		if (terminationCause === undefined) {
			timeout = setTimeout(() => {
				if (terminationCause !== undefined) return;
				terminationCause = "timeout";
				requestStop();
			}, step.timeoutMs);
			timeout.unref?.();
		}
	});
}
