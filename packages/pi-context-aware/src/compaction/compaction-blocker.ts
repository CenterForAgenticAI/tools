/**
 * Detects an extension that cancels every compaction.
 *
 * billion-context-pi returns `{ cancel: true }` from every
 * `session_before_compact` call, and Pi stops at the first cancel, so no
 * compaction can finish while it is loaded. Pi does not let one extension read
 * another's event handlers, so detection uses the tools billion-context-pi
 * registers: `compress` and `acp_status`, from the same extension.
 *
 * billion-context-pi stops cancelling in three documented cases: when
 * `BILLION_CONTEXT_NATIVE` or `BILLION_CONTEXT_PROXY` is set, and when the model
 * base URL routes through the billion-context wire proxy (`/bili/https://...`).
 * In those cases compaction still works, so it is not reported as a blocker.
 *
 * This extension registers `compress` and `acp_status` aliases of its own while
 * billion-context-pi is absent, so tools from this package's own source path are
 * never counted.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface CompactionBlocker {
	/** Package that cancels compaction, named in status, warnings, and advice. */
	readonly extension: string;
	/** Tool that still reduces context while compaction is blocked. */
	readonly replacementTool: string;
}

export interface RegisteredToolView {
	readonly name: string;
	/** Pi's `SourceInfo`: `path` as the extension was named, `baseDir` the directory it resolved to. */
	readonly sourceInfo?: { readonly path?: string; readonly baseDir?: string };
}

export interface CompactionBlockerHost {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly modelBaseUrl?: string;
}

export const BILLION_CONTEXT_PI_BLOCKER: CompactionBlocker = Object.freeze({
	extension: "billion-context-pi",
	replacementTool: "compress",
});

const BILLION_CONTEXT_PI_SIGNATURE = ["compress", "acp_status"] as const;

export function detectCompactionBlocker(
	tools: readonly RegisteredToolView[],
	host: CompactionBlockerHost,
): CompactionBlocker | undefined {
	if (!isBillionContextPiLoaded(tools)) return undefined;
	if (billionContextPiStandsDown(host)) return undefined;
	return BILLION_CONTEXT_PI_BLOCKER;
}

/**
 * True when billion-context-pi's tool pair comes from one extension, whether or
 * not it currently cancels compaction.
 */
export function isBillionContextPiLoaded(tools: readonly RegisteredToolView[]): boolean {
	const signature = BILLION_CONTEXT_PI_SIGNATURE.map((name) => tools.find((tool) => tool.name === name && !isOwnTool(tool)));
	if (signature.some((tool) => tool === undefined)) return false;
	// Two unrelated extensions that each register one of these names are not
	// billion-context-pi.
	const sourcePaths = new Set(
		signature
			.map((tool) => tool?.sourceInfo?.path)
			.filter((sourcePath): sourcePath is string => typeof sourcePath === "string" && sourcePath.length > 0),
	);
	return sourcePaths.size <= 1;
}

/**
 * The root of the package this module belongs to: `<root>/dist/extension.js` (the
 * bundle Pi loads), `<root>/dist/compaction/` (the tsc build), `<root>/src/compaction/`
 * (the source) or `<root>/.test-dist/src/compaction/` (the test build). Undefined
 * anywhere else, and then no tool counts as this extension's own.
 */
const OWN_PACKAGE_ROOT = ((): string | undefined => {
	let directory = path.dirname(fileURLToPath(import.meta.url));
	if (path.basename(directory) === "dist") return canonical(path.dirname(directory));
	if (path.basename(directory) !== "compaction") return undefined;
	directory = path.dirname(directory);
	const top = path.basename(directory);
	if (top !== "dist" && top !== "src") return undefined;
	directory = path.dirname(directory);
	if (top === "src" && path.basename(directory) === ".test-dist") directory = path.dirname(directory);
	return canonical(directory);
})();

function canonical(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/**
 * True when Pi loaded the tool from a file of this package, outside its
 * `node_modules`. Pi keeps a relative extension path as given, with the directory
 * it resolved to in `baseDir`. Synthetic paths (`builtin:read`, `<inline:2>`) name
 * no file, so they are never this package's.
 */
function isOwnTool(tool: RegisteredToolView): boolean {
	const sourcePath = tool.sourceInfo?.path;
	if (OWN_PACKAGE_ROOT === undefined || !sourcePath || sourcePath.startsWith("<") || sourcePath.startsWith("builtin:")) return false;
	const baseDir = tool.sourceInfo?.baseDir;
	const file = path.isAbsolute(sourcePath) ? sourcePath : baseDir ? path.join(baseDir, path.basename(sourcePath)) : undefined;
	if (file === undefined) return false;
	const relative = path.relative(OWN_PACKAGE_ROOT, canonical(file));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	return relative.split(path.sep)[0] !== "node_modules";
}

function billionContextPiStandsDown(host: CompactionBlockerHost): boolean {
	if (host.env.BILLION_CONTEXT_NATIVE) return true;
	if (host.env.BILLION_CONTEXT_PROXY) return true;
	return routesThroughBillionContextProxy(host.modelBaseUrl);
}

/** Same rule as billion-context-pi's own proxy check: `http(s)://host/bili/http(s)://upstream`. */
function routesThroughBillionContextProxy(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
		if (segments[0] !== "bili") return false;
		const rest = url.pathname.slice(url.pathname.indexOf("bili") + "bili".length);
		return /^\/https?:\/\//u.test(rest);
	} catch {
		return false;
	}
}
