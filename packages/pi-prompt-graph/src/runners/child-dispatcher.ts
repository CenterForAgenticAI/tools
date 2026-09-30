import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { DelegateDispatch, DelegateDispatcher, DelegateOutcome } from "../adapters/agent.js";
import type { AgentDefinition, AgentResolver } from "./agent-definitions.js";

export interface ChildProcessDispatcherOptions {
	/** The Pi executable. Overridable so a test can point at a stub. */
	readonly binary?: string;
	readonly model?: string;
	/** Tool allowlist passed to the worker. Omitted means the worker's default set. */
	readonly tools?: readonly string[];
	readonly extraArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Turns a node's `agent:` name into the worker's system prompt, model and tools.
	 *
	 * Omit it and the name is ignored, which is what this dispatcher did for every
	 * node until #34: `agent: writer` and `agent: reviewer` started identical
	 * anonymous workers, so the field read as configuration and behaved as a
	 * comment. Supplying a resolver is what makes it mean something.
	 */
	readonly agents?: AgentResolver;
	/** Directories the resolver searched, named in the failure when a name resolves to nothing. */
	readonly agentSearchPath?: readonly string[];
}


/**
 * Runs a delegated worker as a headless `pi -p` child process.
 *
 * This is not a call into `pi-delegate`. Pi exposes no way for one extension to
 * execute another's tool: `getAllTools()` returns `name`, `description`,
 * `parameters` and `sourceInfo` with no handler, which is the same wall D-038
 * hit for commands. A child process is the transport that remains, and it gives
 * the property that matters most — the worker starts in a directory that is
 * physically its own checkout (D-052).
 *
 * It does NOT provide `pi-delegate`'s escalation channel. A node asking for one
 * is refused rather than run with the request silently dropped.
 */
export class ChildProcessDispatcher implements DelegateDispatcher {
	readonly options: ChildProcessDispatcherOptions;
	private readonly live = new Map<string, ChildProcess>();

	constructor(options: ChildProcessDispatcherOptions = {}) {
		this.options = options;
	}

	async dispatch(request: DelegateDispatch): Promise<DelegateOutcome> {
		if (request.escalation === "local") {
			return { state: "failed", diagnostics: [`Node ${request.nodeId} declares escalation: local, which a child-process worker cannot raise. Dispatch it through a transport that carries escalations, or set escalation: off.`] };
		}
		const binary = this.options.binary ?? "pi";

		// The node's `agent:` name, honoured. Without a resolver this dispatcher
		// ignored it entirely, so every agent node was the same anonymous worker
		// (#34).
		let definition: AgentDefinition | undefined;
		if (this.options.agents) {
			definition = await this.options.agents.resolve(request.agent);
			// Refused, not run anonymously. Running the work with no role after being
			// told which role to use is the defect, not a lenient fallback.
			if (!definition) {
				const searched = this.options.agentSearchPath?.length ? ` Searched ${this.options.agentSearchPath.join(", ")}.` : "";
				return { state: "failed", diagnostics: [`Node ${request.nodeId} names agent "${request.agent}", which no definition declares.${searched}`] };
			}
		}

		const args = ["-p", brief(request), "--no-session"];
		// Pi has no flag that selects an agent by name, so the definition is applied
		// by translating it onto the command line: its body becomes the worker's
		// system prompt, replacing Pi's own or adding to it as the file declares.
		if (definition) args.push(definition.promptMode === "append" ? "--append-system-prompt" : "--system-prompt", definition.prompt);
		// The agent's own model beats a runner-wide default: the default exists for
		// workers that did not say, and this one said.
		const model = definition?.model ?? this.options.model;
		if (model) args.push("--model", model);
		// The node's own allowlist wins: it is a property of the work, not of the
		// worker and not of the runner (§3.3.1). An agent definition cannot widen
		// what the graph declared, only supply a surface where the graph declared none.
		const tools = request.tools ?? definition?.tools ?? this.options.tools;
		if (tools?.length) args.push("-t", [...tools].join(","));
		if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);


		return new Promise<DelegateOutcome>((resolve) => {
			// Its own process group, so cancellation can reach the worker's children too.
			// A killed runner otherwise orphans them (issue #16).
			const child = spawn(binary, args, {
				cwd: request.cwd,
				env: { ...process.env, ...this.options.env },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			this.live.set(request.nodeId, child);
			let stderr = "";
			let settled = false;
			const finish = (outcome: DelegateOutcome): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.live.delete(request.nodeId);
				resolve(outcome);
			};
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => { stderr += chunk.slice(0, 4096); });
			const timeoutMs = request.timeoutMs;
			const timer = timeoutMs === null || timeoutMs === undefined ? undefined : setTimeout(() => {
				killGroup(child);
				finish({ state: "timeout", diagnostics: [`The worker for ${request.nodeId} exceeded ${timeoutMs}ms.`] });
			}, timeoutMs);
			request.signal?.addEventListener("abort", () => {
				killGroup(child);
				finish({ state: "cancelled" });
			}, { once: true });
			child.once("error", (error) => finish({ state: "failed", diagnostics: [error.message] }));
			child.once("close", (code, signal) => {
				if (signal) return finish({ state: "cancelled", diagnostics: [`The worker for ${request.nodeId} was terminated by ${signal}.`] });
				// A clean exit is a claim, not evidence. The adapter still requires the artifact (D-051).
				if (code === 0) return finish({ state: "finished", ...(stderr.trim() ? { diagnostics: [stderr.trim()] } : {}) });
				finish({ state: "failed", diagnostics: [`The worker for ${request.nodeId} exited ${code}.`, ...(stderr.trim() ? [stderr.trim()] : [])] });
			});
		});
	}

	/** The worker's pid, which is also its process-group id. Exposed so a test can assert the group died. */
	pidFor(nodeId: string): number | undefined {
		return this.live.get(nodeId)?.pid;
	}

	/** Kills the worker's whole process group. An active sweep, not a polite request. */
	cancel(nodeId: string): Promise<void> {
		const child = this.live.get(nodeId);
		if (child) killGroup(child);
		return Promise.resolve();
	}
}

/**
 * The task the worker is given, including where its result must land.
 *
 * The ordering instruction is load-bearing, not politeness. Across the two real
 * `scan-consolidate.md` runs, four workers started and **two finished having
 * written nothing** — one after 178s and one after 66s — because each kept
 * investigating until it ran out of room. The adapter correctly failed both
 * nodes (D-051: a worker that reports finishing and leaves no result did not do
 * the work), so the cost was two wasted runs rather than a wrong answer.
 *
 * Telling a worker to write early and overwrite converts that failure into a
 * partial result, which is worth strictly more than nothing. It is still only an
 * instruction to a model, and a graph that wants a genuine second go must
 * declare `retry` — the runner does not add one behind the author's back.
 */
export function brief(request: DelegateDispatch): string {
	return [
		request.task,
		"",
		`Write your result as JSON to ${request.resultPath}.`,
		"That file is the only thing read from this task: nothing you say in prose is used.",
		"",
		"Write it EARLY, before you think you are finished, and overwrite it as you learn more.",
		"A worker that explores until it runs out of room and writes nothing has failed outright,",
		"and a short honest result beats a thorough one you never wrote down.",
		"If something stops you, still write the file and describe what stopped you.",
	].join("\n");
}

function killGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	// Negative pid targets the group, so the worker's own children die with it.
	try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
	try { child.kill("SIGKILL"); } catch { /* already gone */ }
}
