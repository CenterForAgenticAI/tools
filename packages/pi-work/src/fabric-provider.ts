import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import { createWorkDispatchTool } from "./tools/work-dispatch.js";
import { createFabricDispatchBackend, type FabricDispatchBackendOptions } from "./dispatch/fabric/index.js";
import type { DispatchDependencies } from "./dispatch/index.js";
import { workPlanTool } from "./tools/work-plan.js";
import { workStatusTool } from "./tools/work-status.js";
import { workVerifyTool } from "./tools/work-verify.js";

// Structural subset of pi-fabric/protocol v1: Fabric is an optional host,
// not an importable dependency of the standalone pi-work package.
export interface WorkInvocationContext {
	readonly extensionContext: ExtensionContext;
	readonly signal: AbortSignal | undefined;
	readonly nestedToolCallId: string;
}

interface WorkAction {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	risk: "write" | "agent" | "execute";
}

function descriptor(name: string, risk: WorkAction["risk"], tool: { description: string; parameters: TSchema }): WorkAction {
	return { name, description: tool.description, inputSchema: { ...tool.parameters }, risk };
}

function toolContext(context: ExtensionContext): ExtensionToolContext {
	return {
		...context,
		tools: [],
		async executeTool() { throw new Error("Nested tool execution is unavailable through the work provider"); },
	};
}

export function createFabricWorkProvider(options: FabricDispatchBackendOptions = {}, dependencies?: DispatchDependencies) {
	// Host resolution stays lazy: the caller's getter may need the live host, which does not exist while extensions load.
	const fallbackHost = options.events === undefined ? undefined : createFabricDispatchBackend(options);
	const lazy: DispatchDependencies = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(dependencies ?? {})).filter(([key]) => key !== "fabricHost").map(([key, descriptor]) => [key, "value" in descriptor ? descriptor.value : descriptor.get?.call(dependencies)]));
	Object.defineProperty(lazy, "fabricHost", { enumerable: true, get: () => dependencies === undefined ? fallbackHost : dependencies.fabricHost });
	const workDispatchTool = createWorkDispatchTool(lazy);
	const actions = [
		descriptor("plan", "write", workPlanTool),
		descriptor("dispatch", "agent", workDispatchTool),
		descriptor("status", "write", workStatusTool),
		descriptor("verify", "execute", workVerifyTool),
	];
	return {
		name: "work",
		description: "Compile, dispatch, inspect and verify Workspec nodes using pi-work's canonical tools.",
		async list(request: { namespace?: string; query?: string; limit?: number }) {
			const query = request.query?.toLowerCase();
			return actions.filter((entry) => request.namespace === undefined && (query === undefined || `${entry.name} ${entry.description}`.toLowerCase().includes(query)))
				.sort((a, b) => Number(b.name === query) - Number(a.name === query))
				.slice(0, request.limit ?? actions.length);
		},
		async describe(name: string) { return actions.find((entry) => entry.name === name); },
		async invoke(name: string, args: Record<string, unknown>, context: WorkInvocationContext) {
			const ctx = toolContext(context.extensionContext);
			const id = context.nestedToolCallId;
			const signal = context.signal;
			switch (name) {
				case "plan":
					if (!Check(workPlanTool.parameters, args)) break;
					return workPlanTool.execute(id, { path: args.path, nodeAddresses: args.nodeAddresses, ...(args.responseOffset === undefined ? {} : { responseOffset: args.responseOffset }), ...(args.responseSnapshot === undefined ? {} : { responseSnapshot: args.responseSnapshot }) }, signal, undefined, ctx);
				case "dispatch":
					if (!Check(workDispatchTool.parameters, args)) break;
					return workDispatchTool.execute(id, { path: args.path, nodeAddress: args.nodeAddress, worktreePath: args.worktreePath, expectedCommit: args.expectedCommit, ...(args.backend === undefined ? {} : { backend: args.backend }), ...(args.model === undefined ? {} : { model: args.model }), ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }) }, signal, undefined, ctx);
				case "status":
					if (!Check(workStatusTool.parameters, args)) break;
					return workStatusTool.execute(id, { path: args.path, worktreePath: args.worktreePath, expectedCommit: args.expectedCommit, ...(args.refresh === undefined ? {} : { refresh: args.refresh }) }, signal, undefined, ctx);
				case "verify":
					if (!Check(workVerifyTool.parameters, args)) break;
					return workVerifyTool.execute(id, { path: args.path, nodeId: args.nodeId, worktreePath: args.worktreePath, expectedCommit: args.expectedCommit, ...(args.checklistReports === undefined ? {} : { checklistReports: args.checklistReports }) }, signal, undefined, ctx);
				default: throw new Error(`Unknown work action: ${name}`);
			}
			throw new Error(`Invalid arguments for work.${name}`);
		},
	};
}

export function registerFabricWorkProvider(pi: ExtensionAPI, dependencies: DispatchDependencies = {}): void {
	// A bus with no Fabric listener is deliberately a no-op. Tools stay registered.
	if (!pi.events) return;
	const provider = createFabricWorkProvider({ events: pi.events }, dependencies);
	pi.events.emit("pi-fabric:provider:register:v1", { version: 1, provider });
	pi.events.on("pi-fabric:provider:discover:v1", (event: unknown) => {
		if (typeof event === "object" && event !== null && "version" in event && event.version === 1 && "register" in event && typeof event.register === "function") event.register(provider);
	});
}
