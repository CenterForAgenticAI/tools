import { execFileSync, spawn } from "node:child_process";

export interface GitCommandOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly onStdout?: (chunk: string) => void;
}

export interface GitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_OUTPUT_BYTES = 256 * 1024;
export const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "diff.external=", "-c", "core.pager=cat"];

/** Run Git from the selected worktree, optionally consuming stdout as it arrives. */
export function runGit(gitPath: string, worktreePath: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
	return new Promise((resolve, reject) => {
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		let outputError: Error | undefined;
		let timedOut = false;
		let settled = false;
		let bufferedBytes = 0;
		const child = spawn(gitPath, [...SAFE_GIT_CONFIG, ...args], {
			cwd: worktreePath,
			env: { ...options.environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: options.environment?.GIT_CONFIG_GLOBAL ?? "/dev/null", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		// Bound only data retained in memory. Streamed stdout is delivered directly
		// to its consumer and is intentionally uncapped.
		const bufferBounded = (chunks: string[], chunk: string): void => {
			bufferedBytes += Buffer.byteLength(chunk, "utf8");
			if (bufferedBytes > MAX_BUFFERED_OUTPUT_BYTES) {
				if (outputError === undefined) {
					outputError = new Error(`git ${args[0] ?? "command"} exceeded the ${MAX_BUFFERED_OUTPUT_BYTES}-byte in-memory output limit`);
				}
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (options.onStdout === undefined) {
				bufferBounded(stdoutChunks, chunk);
				return;
			}
			try {
				options.onStdout(chunk);
			} catch (error) {
				outputError = error instanceof Error ? error : new Error(String(error));
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: string) => { bufferBounded(stderrChunks, chunk); });

		const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const finish = (outcome: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			outcome();
		};
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code, signal) => finish(() => {
			const stderr = stderrChunks.join("");
			if (outputError !== undefined) {
				reject(outputError);
				return;
			}
			if (timedOut) {
				reject(new Error(`git ${args[0] ?? "command"} timed out after ${timeoutMs}ms`));
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim();
				reject(new Error(`git ${args[0] ?? "command"} exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}${detail.length === 0 ? "" : `: ${detail}`}`));
				return;
			}
			resolve({ stdout: stdoutChunks.join(""), stderr });
		}));
	});
}

/** Synchronous Git query for schema validation, with no caller-supplied Git configuration. */
export function runGitSync(worktreePath: string, args: readonly string[]): string {
	return execFileSync("git", [...SAFE_GIT_CONFIG, ...args], {
		cwd: worktreePath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: DEFAULT_GIT_TIMEOUT_MS,
		env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0" },
	});
}
