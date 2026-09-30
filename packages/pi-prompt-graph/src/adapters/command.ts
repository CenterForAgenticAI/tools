import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { CompiledNode, NodeOutcome } from "../model.js";
import type { NodeExecutionContext } from "./index.js";
import { captureIdentity } from "../runners/process-identity.js";
import { interpolate } from "./interpolate.js";

export interface CommandAdapterOptions {
	readonly timeoutMs?: number;
}

/**
 * Runs an argv vector without invoking a shell.
 *
 * The child is spawned in **its own process group**, so terminating it reaches
 * the commands it started rather than only the immediate process. Spike S4
 * measured the alternative: in all four mid-node kills the node's command
 * survived, and a resume could start a second copy while the first still ran.
 * That is a concurrent overlap, which is a sharper hazard than the sequential
 * repetition "at-least-once" describes.
 *
 * A process group cannot cover the whole hazard on its own, because a runner
 * killed with `SIGKILL` runs no cleanup at all. `onSpawn` is the other half:
 * the group id is journalled, and resume reaps it (D-062).
 */
export class CommandAdapter {
	readonly options: CommandAdapterOptions;

	constructor(options: CommandAdapterOptions = {}) {
		this.options = options;
	}

	run(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
		if (node.binding.kind !== "command") throw new TypeError(`Node ${node.id} is not a command node.`);
		const argv = node.binding.argv.map((part) => interpolate(part, context.state ?? {}));
		if (!argv.length || !argv[0]) return Promise.resolve(failed("Command argv must not be empty."));
		const cwd = node.binding.cwd ? interpolate([{ literal: node.binding.cwd }], context.state ?? {}) : undefined;
		const environment = node.binding.env;
		return new Promise((resolve) => {
			const started = Date.now();
			const child = spawn(argv[0], argv.slice(1), {
				...(cwd === undefined ? {} : { cwd }),
				env: { ...process.env, ...environment },
				stdio: ["ignore", "pipe", "pipe"],
				// Its own process group, so terminating the node reaches whatever the
				// command started. Without it a `SIGTERM` reaches one process and
				// leaves its children running (issue #16).
				detached: true,
			});
			// Recorded before the outcome can be reported. A record written after the
			// node finished would leave a window in which a kill orphans a process
			// nothing knows about, which is the whole hazard being closed.
			const recorded: Promise<void> = child.pid !== undefined && context.onSpawn
				? captureIdentity(child.pid).then((identity) => context.onSpawn!(identity)).catch(() => undefined)
				: Promise.resolve();
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (outcome: NodeOutcome): void => {
				if (settled) return;
				settled = true;
				// Never report the node's outcome before its process is on record.
				const diagnostics = stderr ? [stderr.trim()].filter(Boolean) : outcome.diagnostics;
				void recorded.then(() => resolve({ ...outcome, ...(diagnostics === undefined ? {} : { diagnostics }), output: stdout }));
			};
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
			child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
			const timeoutMs = node.timeoutMs ?? this.options.timeoutMs;
			const timer = timeoutMs === null || timeoutMs === undefined ? undefined : setTimeout(() => {
				terminateGroup(child);
				finish({ status: "timeout", changed: false, completionSignal: "not-applicable", diagnostics: [`Command timed out after ${timeoutMs}ms.`] });
			}, timeoutMs);
			context.signal?.addEventListener("abort", () => terminateGroup(child), { once: true });
			child.once("error", (error) => {
				if (timer) clearTimeout(timer);
				finish({ status: "failed", changed: false, completionSignal: "not-applicable", diagnostics: [error.message] });
			});
			child.once("close", (exitCode) => {
				if (timer) clearTimeout(timer);
				if (settled) return;
				const diagnostics = stderr ? [stderr.trim()].filter(Boolean) : undefined;
				finish({ status: "completed", exitCode: exitCode ?? 1, changed: stdout.length > 0, completionSignal: "not-applicable", ...(diagnostics === undefined ? {} : { diagnostics }) });
			});
			void started;
		});
	}
}

export function runCommand(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
	return new CommandAdapter().run(node, context);
}

function failed(message: string): NodeOutcome {
	return { status: "failed", changed: false, completionSignal: "not-applicable", diagnostics: [message] };
}

/**
 * Terminate the child's whole process group.
 *
 * The negative pid is what makes this reach the command's own children; killing
 * `child.pid` alone leaves them orphaned, which is exactly what S4 measured.
 * `SIGTERM` first so a well-behaved command can clean up, then `SIGKILL` for
 * anything still holding on.
 */
function terminateGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
	try { child.kill("SIGTERM"); } catch { /* already gone */ }
	setTimeout(() => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
	}, 2000).unref();
}
