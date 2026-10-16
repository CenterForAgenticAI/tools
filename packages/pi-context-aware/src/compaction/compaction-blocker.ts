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
 */

export interface CompactionBlocker {
	/** Package that cancels compaction, named in status, warnings, and advice. */
	readonly extension: string;
	/** Tool that still reduces context while compaction is blocked. */
	readonly replacementTool: string;
}

export interface RegisteredToolView {
	readonly name: string;
	readonly sourceInfo?: { readonly path?: string };
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
	const signature = BILLION_CONTEXT_PI_SIGNATURE.map((name) => tools.find((tool) => tool.name === name));
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
