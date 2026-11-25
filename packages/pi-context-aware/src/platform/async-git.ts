import { execFile } from "node:child_process";

/** Bounded, cancellable Git lookup for session housekeeping. */
export function runGitAsync(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, signal }, (error, stdout) => {
			resolve(error ? null : stdout.trim());
		});
	});
}
