import { spawn } from "node:child_process";

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

/** Run Git from the selected worktree, optionally consuming stdout as it arrives. */
export function runGit(gitPath: string, worktreePath: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
	return new Promise((resolve, reject) => {
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		let outputError: Error | undefined;
		let timedOut = false;
		let settled = false;
		const child = spawn(gitPath, [...args], {
			cwd: worktreePath,
			env: options.environment ?? {},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (options.onStdout === undefined) {
				stdoutChunks.push(chunk);
				return;
			}
			try {
				options.onStdout(chunk);
			} catch (error) {
				outputError = error instanceof Error ? error : new Error(String(error));
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: string) => { stderrChunks.push(chunk); });

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
