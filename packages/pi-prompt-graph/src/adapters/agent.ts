import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledNode, NodeOutcome } from "../model.js";
import type { NodeExecutionContext } from "./index.js";
import { interpolate } from "./interpolate.js";

/**
 * What the adapter asks a worker to do. The adapter never names a `pi-delegate`
 * symbol: the runner supplies whatever can reach the `delegate` tool in the live
 * session (§11.4, D-054).
 */
export interface DelegateDispatch {
	readonly nodeId: string;
	readonly agent: string;
	readonly task: string;
	readonly cwd: string;
	/** Exactly the worker's cwd and its own `nodes/<node>/`. Never a parent, never a sibling. */
	readonly writableRoots: readonly string[];
	readonly escalation: "off" | "local";
	/** The node's `tools.allow`, which the worker's surface is narrowed to at dispatch (§3.3.1). */
	readonly tools?: readonly string[];
	readonly thinking?: string;
	/** Where the worker must write its contract result. */
	readonly resultPath: string;
	readonly timeoutMs?: number | null;
	readonly signal?: globalThis.AbortSignal;
}

/**
 * How a dispatch ended, as the dispatcher observed it. `finished` is a claim about
 * the worker stopping, not evidence it did the work: the adapter still requires the
 * result artifact (D-051).
 */
export interface DelegateOutcome {
	readonly state: "finished" | "escalated" | "cancelled" | "failed" | "timeout";
	/** Present when `state` is `escalated`. */
	readonly requestId?: string;
	readonly diagnostics?: readonly string[];
}

export interface DelegateDispatcher {
	dispatch(request: DelegateDispatch): Promise<DelegateOutcome>;
	/** Terminate a live fork. Called by the adapter's cancellation sweep. */
	cancel(nodeId: string): Promise<void>;
}

/** Hands a node a directory to work in. Fan-out isolation is this, not `writableRoots` (D-052). */
export interface WorktreeAllocator {
	acquire(nodeId: string): Promise<string>;
	release(nodeId: string): Promise<void>;
}

export interface AgentAdapterConfig {
	/** The run directory. Node results live under `<runDir>/nodes/<node>/`. */
	readonly runDir: string;
	readonly dispatcher: DelegateDispatcher;
	readonly worktrees?: WorktreeAllocator;
	/** Used when a node declares neither `worktree` nor `cwd`. */
	readonly defaultCwd?: string;
}

/**
 * Runs an `agent` node by delegating it to a worker.
 *
 * The adapter reports. It never resolves a verdict, reads prose, or decides what
 * runs next. Its outcome comes from the worker's contract result and from what the
 * orchestrator watched happen — nothing else (§11.4.1).
 */
export class AgentAdapter {
	readonly config: AgentAdapterConfig;
	/** Live forks, for the cancellation sweep (§11.4.4). */
	private readonly live = new Map<string, string>();

	constructor(config: AgentAdapterConfig) {
		this.config = config;
	}

	/** Node ids with a fork still running. */
	liveForks(): string[] {
		return [...this.live.keys()];
	}

	nodeDir(nodeId: string): string {
		return join(this.config.runDir, "nodes", nodeId);
	}

	/**
	 * Where the worker for one **activation** writes its contract result.
	 *
	 * Scoped to the visit and attempt, not just the node, because this file is the
	 * evidence a resume reads to tell a node that finished from one that did not
	 * (#17, D-063). A single shared path cannot carry that meaning: a cycle's second
	 * visit would find the first visit's result sitting there, and a crash between
	 * `node-started` and the adapter clearing it would let a resume adopt an older
	 * visit's result as this one's. Naming the activation removes that case by
	 * construction, rather than trying to date the file and guess.
	 *
	 * `.spec/0006` §4 always called this directory per-visit scratch; the
	 * implementation had made it per-node, and the two disagreeing is the defect
	 * (D-063).
	 */
	resultPath(nodeId: string, activation?: { visit: number; attempt: number }): string {
		if (!activation) return join(this.nodeDir(nodeId), "result.json");
		return join(this.nodeDir(nodeId), `v${activation.visit}-a${activation.attempt}.json`);
	}

	async run(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
		if (node.binding.kind !== "agent") throw new TypeError(`Node ${node.id} is not an agent node.`);
		const binding = node.binding;
		const state = context.state ?? {};
		const nodeDir = this.nodeDir(node.id);
		const resultPath = this.resultPath(node.id, context.activation);

		await mkdir(nodeDir, { recursive: true });
		// A result left by an earlier attempt is not this attempt's evidence. With an
		// activation the path is already unique, so this clears nothing that exists;
		// without one it is the only thing standing between an old result and a wrong
		// verdict, so it stays.
		await rm(resultPath, { force: true });

		let cwd: string;
		if (binding.worktree) {
			if (!this.config.worktrees) return failure(`Node ${node.id} declares worktree: true but the runner installed no worktree allocator.`);
			cwd = await this.config.worktrees.acquire(node.id);
		} else {
			cwd = binding.cwd ? interpolate(binding.cwd, state) : this.config.defaultCwd ?? process.cwd();
		}

		const request: DelegateDispatch = {
			nodeId: node.id,
			agent: binding.agent,
			task: binding.task ? interpolate(binding.task, state) : "",
			cwd,
			writableRoots: [cwd, nodeDir],
			escalation: binding.escalation,
			...(node.tools?.allow ? { tools: [...node.tools.allow] } : {}),
			...(binding.thinking ? { thinking: binding.thinking } : {}),
			resultPath,
			timeoutMs: node.timeoutMs,
			...(context.signal ? { signal: context.signal } : {}),
		};

		this.live.set(node.id, cwd);
		let dispatched: DelegateOutcome;
		try {
			dispatched = await this.config.dispatcher.dispatch(request);
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		} finally {
			this.live.delete(node.id);
			// The worktree is not released here. It holds the branch's work, which a join
			// downstream still has to read; removing it when the node ends would delete the
			// node's output. The run owns its lifetime — see `releaseWorktrees`.
		}

		const diagnostics = dispatched.diagnostics ? [...dispatched.diagnostics] : undefined;
		// An escalation is not a node failure: it suspends the run and is never routed (§11.4.3).
		if (dispatched.state === "escalated") {
			if (!dispatched.requestId) return failure("The dispatcher reported an escalation with no requestId.", diagnostics);
			return { status: "aborted", changed: false, completionSignal: "reported", escalation: { requestId: dispatched.requestId }, ...(diagnostics ? { diagnostics } : {}) };
		}
		if (dispatched.state === "cancelled") return { status: "aborted", changed: false, completionSignal: "reported", ...(diagnostics ? { diagnostics } : {}) };
		if (dispatched.state === "timeout") return { status: "timeout", changed: false, completionSignal: "reported", ...(diagnostics ? { diagnostics } : {}) };
		if (dispatched.state === "failed") return failure("The delegated worker failed.", diagnostics);

		return await this.readResult(resultPath, diagnostics);
	}

	/**
	 * A reported finish is necessary, not sufficient (D-051). The result artifact is
	 * the corroboration; its absence is a node failure, never a pass.
	 */
	private async readResult(resultPath: string, diagnostics?: string[]): Promise<NodeOutcome> {
		let raw: string;
		try {
			raw = await readFile(resultPath, "utf8");
		} catch {
			return failure(`The worker reported finishing but wrote no result at ${resultPath}.`, diagnostics);
		}
		let output: unknown;
		try {
			output = JSON.parse(raw);
		} catch (error) {
			return failure(`The result at ${resultPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, diagnostics);
		}
		return { status: "completed", output, changed: true, completionSignal: "reported", ...(diagnostics ? { diagnostics } : {}) };
	}

	/**
	 * The contract result one activation left behind, if it wrote one.
	 *
	 * This is what makes a resume able to tell a node that finished its work from
	 * one that did not: the file is written by the worker, lives outside the
	 * journal, and survives the crash that stopped the runner from recording the
	 * finish. A result present under **this** activation's name is positive evidence
	 * that this activation completed, which is the standard D-053 asked for and
	 * D-051's corroboration rule already applies to a live run (#17, D-063).
	 *
	 * Returns `undefined` when there is no evidence, which is not the same as
	 * evidence of failure — the caller decides what to do with an unknown.
	 */
	async recoveredResult(nodeId: string, activation: { visit: number; attempt: number }): Promise<NodeOutcome | undefined> {
		const path = this.resultPath(nodeId, activation);
		try {
			await readFile(path, "utf8");
		} catch {
			return undefined;
		}
		const outcome = await this.readResult(path);
		// Unreadable or malformed is not evidence of a completed node. Falling back to
		// re-running is right: the alternative is routing on a result nobody can parse.
		return outcome.status === "completed" ? outcome : undefined;
	}

	/**
	 * Cancels every fork this adapter owns. An active sweep, not a request forks are
	 * trusted to observe: a wedged fork produces no error, no timeout, and no event.
	 */
	async cancelAll(): Promise<string[]> {
		const nodes = [...this.live.keys()];
		await Promise.all(nodes.map(async (nodeId) => {
			await this.config.dispatcher.cancel(nodeId).catch(() => undefined);
			this.live.delete(nodeId);
		}));
		return nodes;
	}

	/** Releases every worktree this adapter allocated. For the run's teardown, never a node's. */
	async releaseWorktrees(nodeIds: readonly string[]): Promise<void> {
		if (!this.config.worktrees) return;
		for (const nodeId of nodeIds) await this.config.worktrees.release(nodeId).catch(() => undefined);
	}
}

function failure(message: string, diagnostics?: string[]): NodeOutcome {
	return { status: "failed", changed: false, completionSignal: "reported", diagnostics: [...(diagnostics ?? []), message] };
}

/** Allocates a real git worktree per node, so two workers never share a checkout (D-052). */
export class GitWorktreeAllocator implements WorktreeAllocator {
	readonly repoRoot: string;
	readonly root: string;
	private readonly held = new Map<string, string>();

	constructor(repoRoot: string, root: string) {
		this.repoRoot = repoRoot;
		this.root = root;
	}

	async acquire(nodeId: string): Promise<string> {
		const path = join(this.root, nodeId);
		await mkdir(this.root, { recursive: true });
		await git(this.repoRoot, ["worktree", "add", "--detach", path]);
		this.held.set(nodeId, path);
		return path;
	}

	async release(nodeId: string): Promise<void> {
		const path = this.held.get(nodeId);
		if (!path) return;
		this.held.delete(nodeId);
		await git(this.repoRoot, ["worktree", "remove", "--force", path]).catch(() => undefined);
	}
}

function git(cwd: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)));
	});
}
