import { homedir } from "node:os";
import path from "node:path";
import type { CanonicalDelegateRun } from "../../plan/types.js";
import { runFabricProgram, type FabricProgramEventBus, type FabricProgramInput, type FabricTransportResult } from "./transport.js";

export type FabricRunInvocation = Pick<CanonicalDelegateRun, "name" | "task" | "cwd" | "worktree" | "writableRoots" | "model"> & { readonly confineWrites: boolean };

export interface FabricRunOptions {
	readonly ref: string;
	readonly invocation: FabricRunInvocation;
	readonly projectRoot: string;
	readonly trustedProject: boolean;
	readonly globalConfigPath?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly thinking?: string;
	readonly schema?: unknown;
	readonly systemPrompt?: string;
}

export interface FabricRunDependencies {
	readonly events: FabricProgramEventBus | undefined;
	/** Return undefined for a missing file; reject unreadable or malformed JSON. */
	readConfig(path: string): Promise<unknown>;
}

export interface FabricRunReceipt {
	readonly runId: string;
	readonly worktreeResult?: { readonly path: string; readonly branch?: string; readonly baseRef?: string };
}

export type FabricRunResult = { readonly status: "dispatched"; readonly result: Extract<FabricTransportResult, { ok: true }>; readonly receipt: FabricRunReceipt }
	| { readonly status: "rejected"; readonly dispatchState: "not-dispatched"; readonly finding: { readonly code: "fabric-escalation-enabled" | "fabric-config-invalid"; readonly message: string } }
	| { readonly status: "indeterminate"; readonly dispatchState: "unknown"; readonly finding: { readonly code: "fabric-receipt-invalid"; readonly message: string } }
	| Extract<FabricTransportResult, { ok: false }>;

export function buildFabricRunRequest(options: FabricRunOptions): FabricProgramInput {
	const invocation = options.invocation;
	const roots = invocation.confineWrites ? [...(invocation.writableRoots ?? [])] : undefined;
	return {
		task: invocation.task, name: invocation.name, cwd: invocation.cwd ?? options.projectRoot,
		worktree: invocation.worktree, model: invocation.model, thinking: options.thinking,
		writableRoots: roots, shell: roots !== undefined && roots.length > 0 ? "unconfined" : undefined,
		schema: options.schema, systemPrompt: options.systemPrompt,
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childQuestions(config: unknown): "cancel" | "route" | undefined {
	if (config === undefined) return undefined;
	if (!record(config)) throw new Error("Fabric configuration must be an object");
	if (config.agents === undefined) return undefined;
	if (!record(config.agents)) throw new Error("Fabric agents configuration must be an object");
	const value = config.agents.childQuestions;
	if (value === undefined || value === "cancel" || value === "route") return value;
	throw new Error("Fabric agents.childQuestions must be cancel or route");
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export async function dispatchFabricRun(options: FabricRunOptions, dependencies: FabricRunDependencies): Promise<FabricRunResult> {
	let questions: "cancel" | "route";
	try {
		const global = childQuestions(await dependencies.readConfig(options.globalConfigPath ?? path.join(homedir(), ".pi", "agent", "fabric.json")));
		// Fail closed even for untrusted projects: routing in either file violates escalation off.
		const project = childQuestions(await dependencies.readConfig(path.join(options.projectRoot, ".pi", "fabric.json")));
		questions = project === "route" || global === "route" ? "route" : "cancel";
	} catch (error) {
		return { status: "rejected", dispatchState: "not-dispatched", finding: { code: "fabric-config-invalid", message: String(error) } };
	}
	if (questions === "route") {
		return { status: "rejected", dispatchState: "not-dispatched", finding: { code: "fabric-escalation-enabled", message: "Fabric agents.childQuestions is route; escalation off requires cancel" } };
	}
	const result = await runFabricProgram(dependencies.events, {
		ref: options.ref, input: buildFabricRunRequest(options),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
	if (!result.ok) return result;
	const value = result.value;
	const worktree = record(value) ? value.worktreeResult : undefined;
	if (!record(value) || !nonEmpty(value.id) || (options.invocation.worktree &&
		(!record(worktree) || !nonEmpty(worktree.path) || !nonEmpty(worktree.branch) || !nonEmpty(worktree.baseRef)))) {
		return { status: "indeterminate", dispatchState: "unknown", finding: { code: "fabric-receipt-invalid", message: "Fabric completed without a valid run/worktree receipt; do not redispatch automatically" } };
	}
	const receipt: FabricRunReceipt = {
		runId: value.id,
		...(record(worktree) && nonEmpty(worktree.path) ? { worktreeResult: {
			path: worktree.path,
			...(nonEmpty(worktree.branch) ? { branch: worktree.branch } : {}),
			...(nonEmpty(worktree.baseRef) ? { baseRef: worktree.baseRef } : {}),
		} } : {}),
	};
	return { status: "dispatched", result, receipt };
}
