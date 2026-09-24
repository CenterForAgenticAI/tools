import * as os from "node:os";
import * as path from "node:path";
import {
	truncateToVisualLines,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONTEXT_CACHE_CONFIG,
	sessionRoleBehaviour,
	type Config,
	type ContextCacheConfig,
} from "./config-layers.js";
import {
	boundCacheDocuments,
	boundCacheListingText,
	formatFileSize,
	MAX_CONTEXT_CACHE_LISTING_CHARS,
	type CacheDocument,
	type CacheReadPool,
} from "./context-cache.js";

export { findLatestCompactionCarrySelection } from "./context-cache.js";

const CONTEXT_CACHE_NOTIFICATION_ENTRY_TYPE = "context-cache-listing.v1" as const;
const registeredNotificationAPIs = new WeakSet<object>();

type CacheReadSource = string | readonly CacheReadPool[];

interface CacheNotificationData {
	schemaVersion: 1;
	reason: "compaction" | "session_start";
	content: string;
	fileCount: number;
	totalSizeBytes: number;
	omittedCount: number;
	files: Array<{ file: string; path: string; originScope: string; sizeBytes: number; description: string }>;
}

function getContextCacheConfig(config: Config): ContextCacheConfig {
	return { ...DEFAULT_CONTEXT_CACHE_CONFIG, ...config.contextCache };
}

function userRootRelativePath(filePath: string): string {
	const home = os.homedir();
	const rel = path.relative(home, filePath);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		return `~/${rel.split(path.sep).join("/")}`;
	}
	return filePath;
}

function cacheSources(source: CacheReadSource): readonly CacheReadPool[] {
	return typeof source === "string" ? [{ cacheDir: source, originScope: "active" }] : source;
}

function cacheDocuments(source: CacheReadSource, maxListedFiles: number, carrySelection?: readonly string[]): {
	all: CacheDocument[];
	candidates: CacheDocument[];
} {
	const all = boundCacheDocuments(cacheSources(source), Number.MAX_SAFE_INTEGER).entries;
	const selected = carrySelection && carrySelection.length > 0
		? all.filter((document) => carrySelection.includes(document.file))
		: all;
	const limit = Number.isSafeInteger(maxListedFiles) && maxListedFiles >= 0 ? maxListedFiles : 0;
	return { all, candidates: selected.slice(0, limit) };
}

// The always-on system-prompt block reports a count, never a per-file listing,
// so it must count every document the pool holds. This helper takes no cap: a
// caller cannot accidentally under-count by passing the bounded listing limit,
// which would silently drop entries beyond the cap — including a promoted
// artifact (epic/422). Promoted files enter the same manifest as ordinary
// entries (context-cache.ts promoteCacheFile), so boundCacheDocuments counts
// them like any other.
function countCacheDocuments(source: CacheReadSource): number {
	return boundCacheDocuments(cacheSources(source), Number.MAX_SAFE_INTEGER).entries.length;
}

function buildCacheDocumentLines(
	documents: readonly CacheDocument[],
	format: (document: CacheDocument) => string,
): string[] {
	return documents.map(format);
}

export function buildCacheSystemPromptBlock(source: CacheReadSource, config: Config): string | null {
	if (config.contextCache?.enabled === false) return null;
	// A worker session has no user who can read a listing or act on a /context-cache-*
	// command. Gated at the builder rather than each call site, so a new
	// injection path cannot reintroduce this (issue #12, criterion 2).
	if (!sessionRoleBehaviour(config.sessionRole).injectCacheListing) return null;

	// Count plus a pointer, not a per-file listing. This block is on every turn,
	// and a full listing broke the provider prompt-cache prefix on every cache write
	// while yielding roughly 2% reads (issue #78). A bare count changes only when
	// the document total changes, so a description edit, size change, new
	// timestamp, or reorder no longer invalidates the cached prefix. Every
	// document — including a promoted artifact — stays reachable through
	// /context-cache-list and the read tool.
	const total = countCacheDocuments(source);
	if (total === 0) return null;
	const noun = total === 1 ? "reference document" : "reference documents";
	const verb = total === 1 ? "is" : "are";
	const object = total === 1 ? "it" : "them";
	return `<context-cache>\n${total} ${noun} from prior sessions ${verb} available. Run /context-cache-list to view ${object}, then read the ones you need.\n</context-cache>`;
}

export function buildCacheListingForPrompt(source: CacheReadSource, config: Config, carrySelection?: readonly string[]): string | null {
	if (config.contextCache?.enabled === false) return null;
	// A worker session has no user who can read a listing or act on a /context-cache-*
	// command. Gated at the builder rather than each call site, so a new
	// injection path cannot reintroduce this (issue #12, criterion 2).
	if (!sessionRoleBehaviour(config.sessionRole).injectCacheListing) return null;

	const files = cacheDocuments(source, getContextCacheConfig(config).maxListedFiles, carrySelection);
	if (files.all.length === 0) return null;
	const lines = buildCacheDocumentLines(files.candidates, (document) =>
		`- ${document.file} [origin: ${document.originScope}] (${formatFileSize(document.entry.sizeBytes)}): ${document.entry.description}`,
	);
	return boundCacheListingText(
		"<context-cache-files>\nThe following reference documents are available in the project's context cache and will persist after compaction. Reference them in the expanded seed when relevant:\n",
		lines,
		"\n</context-cache-files>",
		files.all.length,
	).text;
}

export function buildCacheSeedPreamble(source: CacheReadSource, config: Config, carrySelection?: readonly string[]): string | null {
	if (config.contextCache?.enabled === false) return null;
	// A worker session has no user who can read a listing or act on a /context-cache-*
	// command. Gated at the builder rather than each call site, so a new
	// injection path cannot reintroduce this (issue #12, criterion 2).
	if (!sessionRoleBehaviour(config.sessionRole).injectCacheListing) return null;

	const files = cacheDocuments(source, getContextCacheConfig(config).maxListedFiles, carrySelection);
	if (files.all.length === 0) return null;
	const lines = buildCacheDocumentLines(files.candidates, (document) =>
		`- ${userRootRelativePath(document.cacheDir)}/${document.file} [origin: ${document.originScope}]: ${document.entry.description}`,
	);
	return boundCacheListingText(
		"Context cache files available (use the read tool to access):\n",
		lines,
		"",
		files.all.length,
	).text;
}

function notificationComponent(data: CacheNotificationData, expanded: boolean, _theme: Theme): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render(width: number): string[] {
			return truncateToVisualLines(data.content, expanded ? Number.MAX_SAFE_INTEGER : 8, Math.max(1, width), 0).visualLines;
		},
		invalidate(): void {},
	};
}

function registerNotificationRenderer(pi: ExtensionAPI): boolean {
	const runtime = pi as unknown as {
		registerEntryRenderer?: (customType: string, renderer: (entry: { data?: CacheNotificationData }, options: { expanded: boolean }, theme: Theme) => unknown) => void;
	};
	if (typeof runtime.registerEntryRenderer !== "function") return false;
	if (!registeredNotificationAPIs.has(pi as unknown as object)) {
		runtime.registerEntryRenderer(CONTEXT_CACHE_NOTIFICATION_ENTRY_TYPE, (entry, options, theme) => {
			const data = entry.data;
			if (!data || data.schemaVersion !== 1 || typeof data.content !== "string") return undefined;
			return notificationComponent(data, options.expanded, theme);
		});
		registeredNotificationAPIs.add(pi as unknown as object);
	}
	return true;
}

/**
 * Persist a visible cache notification without adding its file listing to LLM
 * context. Older runtimes use a count-only fallback so the seed remains the
 * sole compaction-produced listing in the next request.
 */
export function sendCacheNotification(
	pi: ExtensionAPI,
	source: CacheReadSource,
	config: Config,
	reason: "compaction" | "session_start",
	carrySelection?: readonly string[],
): void {
	if (config.contextCache?.enabled === false) return;
	// The fourth injection path. Same reason as the three builders above.
	if (!sessionRoleBehaviour(config.sessionRole).injectCacheListing) return;

	const files = cacheDocuments(source, getContextCacheConfig(config).maxListedFiles, carrySelection);
	if (files.all.length === 0) return;
	const totalSize = files.all.reduce((sum, document) => sum + document.entry.sizeBytes, 0);
	const header = reason === "compaction"
		? `📦 **Context Cache Updated** — ${files.all.length} file${files.all.length > 1 ? "s" : ""} (${formatFileSize(totalSize)})`
		: `📦 **Context Cache Available** — ${files.all.length} file${files.all.length > 1 ? "s" : ""} (${formatFileSize(totalSize)})`;
	const lines = buildCacheDocumentLines(files.candidates, (document) =>
		`- \`${userRootRelativePath(document.cacheDir)}/${document.file}\` [origin: ${document.originScope}] (${formatFileSize(document.entry.sizeBytes)}) — ${document.entry.description}`,
	);
	const bounded = boundCacheListingText(
		`${header}\n\n`,
		lines,
		"\n\nUse the `read` tool or `/context-cache-view <file>` to inspect these files. Manage with `/context-cache-list`, `/context-cache-open`, `/context-cache-delete`, or `/context-cache-purge`.",
		files.all.length,
	);
	const data: CacheNotificationData = {
		schemaVersion: 1,
		reason,
		content: bounded.text,
		fileCount: files.all.length,
		totalSizeBytes: totalSize,
		omittedCount: bounded.omittedCount,
		files: files.candidates.map((document) => ({
			file: document.file,
			path: path.join(document.cacheDir, document.file),
			originScope: document.originScope,
			sizeBytes: document.entry.sizeBytes,
			description: document.entry.description,
		})),
	};
	const runtime = pi as unknown as {
		appendEntry?: (customType: string, data?: CacheNotificationData) => void;
		sendMessage?: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) => void;
	};
	if (typeof runtime.appendEntry === "function" && registerNotificationRenderer(pi)) {
		runtime.appendEntry(CONTEXT_CACHE_NOTIFICATION_ENTRY_TYPE, data);
		return;
	}
	if (typeof runtime.sendMessage === "function") {
		runtime.sendMessage({
			customType: "context-cache-listing",
			content: `${header}. Use /context-cache-list to see the files.`,
			display: true,
			details: { reason, fileCount: files.all.length, totalSizeBytes: totalSize },
		}, { triggerTurn: false });
	}
}

export { MAX_CONTEXT_CACHE_LISTING_CHARS };
