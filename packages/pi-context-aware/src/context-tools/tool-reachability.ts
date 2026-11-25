/**
 * Whether this session can call an extension tool now, and how.
 *
 * One check serves every place that names a context tool to the model: the
 * context_compact refusal, the check-in prompt, the system-prompt guidance and
 * the fold nudge (pi-context-aware#458). A tool is reachable when Pi's active set
 * holds it, or when pi-fabric's executor is active and the Fabric child
 * allowlist, if any, names it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExtensionToolReachability =
	| { readonly available: true; readonly kind: "active" | "extension-executor"; readonly invocation: string }
	| { readonly available: false; readonly kind: "unavailable" };

interface ToolSourceInfoView {
	readonly path?: string;
	readonly source?: string;
	readonly baseDir?: string;
	readonly origin?: string;
}

interface ToolInfoView {
	readonly name: string;
	readonly sourceInfo?: ToolSourceInfoView;
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** Fabric's inherited child allowlist: unset allows every tool; set but unreadable allows none. */
export function fabricChildAllowsTool(toolName: string, raw = process.env.PI_FABRIC_TOOL_ALLOWLIST): boolean {
	if (raw === undefined) return true;
	try {
		const names: unknown = JSON.parse(raw);
		return Array.isArray(names)
			&& names.every((name) => typeof name === "string")
			&& names.includes(toolName);
	} catch {
		return false;
	}
}

function localPackageNamesPiFabric(sourceInfo: ToolSourceInfoView): boolean {
	const source = sourceInfo.source?.trim();
	if (!source) return false;
	const localSource = source.startsWith("file:") ? source.slice("file:".length) : source;
	if (!path.isAbsolute(localSource)) return false;
	for (const directoryCandidate of [sourceInfo.baseDir, sourceInfo.path ? path.dirname(sourceInfo.path) : undefined]) {
		if (!directoryCandidate || !path.isAbsolute(directoryCandidate)) continue;
		let directory = directoryCandidate;
		for (let depth = 0; depth < 8; depth++) {
			const manifest = path.join(directory, "package.json");
			if (fs.existsSync(manifest)) {
				const parsed = readJsonFile(manifest);
				return typeof parsed === "object"
					&& parsed !== null
					&& !Array.isArray(parsed)
					&& (parsed as { name?: unknown }).name === "pi-fabric";
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	return false;
}

function isPiFabricExecutor(tool: ToolInfoView | undefined): boolean {
	const sourceInfo = tool?.sourceInfo;
	if (tool?.name !== "fabric_exec" || sourceInfo?.origin !== "package") return false;
	const source = sourceInfo.source?.trim() ?? "";
	return /^(?:npm:)?pi-fabric(?:@[^/:\s]+)?$/u.test(source)
		|| localPackageNamesPiFabric(sourceInfo);
}

/**
 * Every tool name this session can call now, sorted: the names `extensionToolReachability` finds available,
 * from one read of the active and registered tools (pi-context-aware#472, the strategy view's `tools`).
 * A lookup that throws reports none; `onError` hears why.
 */
export function reachableToolNames(pi: ExtensionAPI, onError?: (error: unknown) => void): string[] {
	try {
		const api = pi as ExtensionAPI & {
			getActiveTools?: () => string[];
			getAllTools?: () => ToolInfoView[];
		};
		const active = typeof api.getActiveTools === "function" ? api.getActiveTools() : [];
		const names = new Set(active.filter((name) => typeof name === "string" && name.length > 0));
		if (names.has("fabric_exec") && typeof api.getAllTools === "function") {
			const allTools = api.getAllTools();
			if (isPiFabricExecutor(allTools.find((tool) => tool.name === "fabric_exec"))) {
				for (const tool of allTools) if (typeof tool.name === "string" && tool.name.length > 0 && fabricChildAllowsTool(tool.name)) names.add(tool.name);
			}
		}
		return [...names].sort();
	} catch (err) {
		onError?.(err);
		return [];
	}
}

/**
 * Resolve how an extension tool can be called in the current tool mode.
 *
 * A code-mode host can hide registered extension tools from Pi's native active
 * set while exposing them through pi-fabric's executor. Pi's public tool
 * metadata authenticates that executor's package owner; Fabric's inherited
 * child allowlist is the separate authorization boundary for each nested tool.
 * A lookup that throws reports the tool unavailable; `onError` hears why.
 */
export function extensionToolReachability(pi: ExtensionAPI, toolName: string, onError?: (error: unknown) => void): ExtensionToolReachability {
	try {
		const api = pi as ExtensionAPI & {
			getActiveTools?: () => string[];
			getAllTools?: () => ToolInfoView[];
		};
		const activeTools = typeof api.getActiveTools === "function" ? api.getActiveTools() : [];
		if (activeTools.includes(toolName)) {
			return { available: true, kind: "active", invocation: toolName };
		}
		if (activeTools.includes("fabric_exec") && typeof api.getAllTools === "function") {
			const allTools = api.getAllTools();
			if (
				allTools.some((tool) => tool.name === toolName)
				&& isPiFabricExecutor(allTools.find((tool) => tool.name === "fabric_exec"))
				&& fabricChildAllowsTool(toolName)
			) {
				return { available: true, kind: "extension-executor", invocation: `extensions.${toolName}(...)` };
			}
		}
		return { available: false, kind: "unavailable" };
	} catch (err) {
		onError?.(err);
		return { available: false, kind: "unavailable" };
	}
}
