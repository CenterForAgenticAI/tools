/**
 * Context cache: pure utility functions for manifest I/O, cache plan parsing,
 * cleanup logic, and prompt constants. Extracted from index.ts for testability.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheFileEntry {
	/** Stable opaque reference ID. Legacy manifests are deterministically backfilled on read. */
	artifactId?: string;
	description: string;
	createdBy: string;
	updatedBy: string;
	created: string;
	updated: string;
	sizeBytes: number;
}

export interface CacheManifest {
	version: 1;
	files: Record<string, CacheFileEntry>;
}

export interface CachePlanArtifact {
	file: string;
	description: string;
	brief: string;
}

export interface BoundedCacheListing {
	entries: Array<[string, CacheFileEntry]>;
	omittedCount: number;
}

/** One cache pool considered by a read-through listing. */
export interface CacheReadPool {
	readonly cacheDir: string;
	/** Human-visible scope of the pool, for example `worktree` or `repo`. */
	readonly originScope: string;
}

export interface CacheDocument {
	readonly file: string;
	readonly entry: CacheFileEntry;
	readonly cacheDir: string;
	readonly originScope: string;
}

export interface BoundedCacheDocuments {
	readonly entries: CacheDocument[];
	readonly omittedCount: number;
}

export interface CacheMigrationResult {
	changed: boolean;
	migratedFiles: string[];
	/** Entries that could not be copied. A non-empty list means the migration is incomplete. */
	failedFiles: string[];
}

export interface CacheMigrationLedgerEntry {
	destination: string;
	migratedAt: string;
	fileCount: number;
}

export interface CacheMigrationLedger {
	version: 1;
	/** Keyed by resolved legacy source directory. */
	sources: Record<string, CacheMigrationLedgerEntry>;
}

/** Return the stable directory name used by Pi's legacy per-cwd sessions. */
export function legacySessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Resolve the scoped cache pool under the agent directory. */
export function contextCacheDirectory(agentDir: string, scopePath: string): string {
	const scopeHash = createHash("sha256").update(path.resolve(scopePath)).digest("hex").slice(0, 32);
	return path.join(agentDir, "context-cache", scopeHash);
}

/**
 * Sort manifest entries newest-first and bound the number rendered into a
 * prompt. Invalid dates sort after valid dates rather than making ordering
 * dependent on the platform's sort implementation.
 */
export function boundCacheListing(manifest: CacheManifest, maxListedFiles: number): BoundedCacheListing {
	const sorted = Object.entries(manifest.files).sort(([a, left], [b, right]) => {
		const leftTime = Date.parse(left.updated);
		const rightTime = Date.parse(right.updated);
		const leftSortable = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
		const rightSortable = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
		return rightSortable - leftSortable || a.localeCompare(b);
	});
	const limit = Number.isSafeInteger(maxListedFiles) && maxListedFiles >= 0 ? maxListedFiles : 0;
	return {
		entries: sorted.slice(0, limit),
		omittedCount: Math.max(0, sorted.length - limit),
	};
}

/**
 * Read multiple pools as one listing. Earlier pools are narrower and win a
 * filename collision, so a worktree document cannot be shadowed by a repo
 * document. The source pool remains attached to each document for rendering.
 */
export function boundCacheDocuments(pools: readonly CacheReadPool[], maxListedFiles: number): BoundedCacheDocuments {
	const documents = new Map<string, CacheDocument>();
	for (const pool of pools) {
		for (const [file, entry] of Object.entries(readManifest(pool.cacheDir).files)) {
			if (!documents.has(file)) documents.set(file, { file, entry, cacheDir: pool.cacheDir, originScope: pool.originScope });
		}
	}
	const sorted = [...documents.values()].sort((left, right) => {
		const leftTime = Date.parse(left.entry.updated);
		const rightTime = Date.parse(right.entry.updated);
		const leftSortable = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
		const rightSortable = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
		return rightSortable - leftSortable || left.file.localeCompare(right.file);
	});
	const limit = Number.isSafeInteger(maxListedFiles) && maxListedFiles >= 0 ? maxListedFiles : 0;
	return { entries: sorted.slice(0, limit), omittedCount: Math.max(0, sorted.length - limit) };
}

/** The reserved manifest filename. Never a promotable or cacheable artifact name. */
export const CACHE_MANIFEST_FILE_NAME = "_manifest.json";

/**
 * True when `file` is the reserved manifest name in any case. A case-insensitive
 * host filesystem treats `_MANIFEST.JSON` as `_manifest.json`, so a
 * case-sensitive literal check would let such an alias shadow the manifest on
 * write or be deleted as an orphan on cleanup. One rule guards every caller.
 */
export function isReservedManifestName(file: string): boolean {
	return file.toLowerCase() === CACHE_MANIFEST_FILE_NAME;
}

export function isSafeCacheFileName(file: string): boolean {
	return !isReservedManifestName(file) && /^[\w][\w.-]{0,98}\.[a-z]{1,10}$/i.test(file) && !file.includes("..") && !file.includes("/") && !file.includes("\\");
}

function copyMigratedCacheFile(sourceFile: string, destinationFile: string, destinationDir: string): void {
	const temporaryFile = path.join(destinationDir, `.${path.basename(destinationFile)}.migration-${randomUUID()}`);
	try {
		fs.copyFileSync(sourceFile, temporaryFile, fs.constants.COPYFILE_EXCL);
		fs.renameSync(temporaryFile, destinationFile);
	} finally {
		try { fs.unlinkSync(temporaryFile); } catch { /* already renamed or absent */ }
	}
}

/**
 * Merge a legacy cache pool into a scoped pool without deleting the source.
 * A source entry replaces a destination entry only when both timestamps are
 * valid and the source is newer. Ambiguous entries are skipped conservatively.
 */
export function migrateCachePool(sourceDir: string, destinationDir: string): CacheMigrationResult {
	if (path.resolve(sourceDir) === path.resolve(destinationDir)) return { changed: false, migratedFiles: [], failedFiles: [] };
	const sourceManifest = readManifest(sourceDir);
	if (Object.keys(sourceManifest.files).length === 0) return { changed: false, migratedFiles: [], failedFiles: [] };

	let destinationManifest = readManifest(destinationDir);
	const migratedFiles: string[] = [];
	const failedFiles: string[] = [];
	for (const [file, sourceEntry] of Object.entries(sourceManifest.files)) {
		if (!isSafeCacheFileName(file)) continue;
		const sourceFile = path.join(sourceDir, file);
		try {
			if (!fs.lstatSync(sourceFile).isFile()) continue;
		} catch {
			continue;
		}

		const destinationEntry = destinationManifest.files[file];
		const destinationFile = path.join(destinationDir, file);
		let destinationStat: fs.Stats | undefined;
		try { destinationStat = fs.lstatSync(destinationFile); } catch { /* absent */ }
		if (destinationStat && !destinationStat.isFile()) continue;

		if (destinationEntry) {
			const sourceUpdated = Date.parse(sourceEntry.updated);
			const destinationUpdated = Date.parse(destinationEntry.updated);
			if (!Number.isFinite(sourceUpdated) || !Number.isFinite(destinationUpdated) || sourceUpdated <= destinationUpdated) continue;
		} else if (destinationStat) {
			// An untracked destination file is ambiguous; never clobber it.
			continue;
		}

		try {
			fs.mkdirSync(destinationDir, { recursive: true });
			copyMigratedCacheFile(sourceFile, destinationFile, destinationDir);
			destinationManifest = {
				...destinationManifest,
				files: { ...destinationManifest.files, [file]: sourceEntry },
			};
			migratedFiles.push(file);
		} catch {
			// A failed copy leaves the source untouched and does not alter the manifest.
			failedFiles.push(file);
		}
	}

	if (migratedFiles.length > 0) {
		try {
			writeManifest(destinationDir, destinationManifest);
		} catch {
			// The copies landed but the index did not. Report the migration as
			// incomplete so it is not recorded as done; callers must not throw out
			// of the cache path for a failed best-effort migration.
			return { changed: false, migratedFiles: [], failedFiles: [...failedFiles, ...migratedFiles] };
		}
	}
	return { changed: migratedFiles.length > 0, migratedFiles, failedFiles };
}

// ---------------------------------------------------------------------------
// Migration ledger
// ---------------------------------------------------------------------------

/**
 * Records which legacy pools have already been migrated, so a pool is imported
 * at most once ever. Without this, a document removed from the destination —
 * deliberately by the user, or by stale-file cleanup, which prunes migrated
 * legacy entries almost immediately because they keep their original old
 * timestamps — would be re-imported on the next process start.
 *
 * The ledger deliberately lives beside the pools rather than inside one:
 * cleanup's orphan sweep deletes any file in a pool that the manifest does not
 * track.
 */
export function readMigrationLedger(ledgerFile: string): CacheMigrationLedger {
	try {
		const parsed = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
		if (parsed?.version === 1 && parsed.sources && typeof parsed.sources === "object") {
			return { version: 1, sources: parsed.sources as Record<string, CacheMigrationLedgerEntry> };
		}
	} catch {
		// absent or corrupt
	}
	return { version: 1, sources: {} };
}

export function migrationLedgerHas(ledger: CacheMigrationLedger, sourceDir: string): boolean {
	return Object.prototype.hasOwnProperty.call(ledger.sources, path.resolve(sourceDir));
}

export function recordMigrationInLedger(
	ledger: CacheMigrationLedger,
	sourceDir: string,
	entry: CacheMigrationLedgerEntry,
): CacheMigrationLedger {
	return { version: 1, sources: { ...ledger.sources, [path.resolve(sourceDir)]: entry } };
}

export function writeMigrationLedger(ledgerFile: string, ledger: CacheMigrationLedger): void {
	fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
	fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

export function stableLegacyArtifactId(cacheDir: string, file: string): string {
	const digest = createHash("sha256")
		.update(path.resolve(cacheDir, file))
		.digest("hex")
		.slice(0, 24);
	return `artifact-legacy-${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectCacheManifest(cacheDir: string, manifest: unknown): CacheManifest {
	if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.files)) return { version: 1, files: {} };
	const files: Record<string, CacheFileEntry> = {};
	const usedArtifactIds = new Set<string>();
	for (const [file, value] of Object.entries(manifest.files)) {
		if (!isSafeCacheFileName(file) || !isRecord(value)) continue;
		const description = value.description;
		const createdBy = value.createdBy;
		const updatedBy = value.updatedBy;
		const created = value.created;
		const updated = value.updated;
		const sizeBytes = value.sizeBytes;
		if (
			typeof description !== "string" ||
			typeof createdBy !== "string" ||
			typeof updatedBy !== "string" ||
			typeof created !== "string" ||
			typeof updated !== "string" ||
			typeof sizeBytes !== "number" ||
			!Number.isSafeInteger(sizeBytes) ||
			sizeBytes < 0
		) continue;
		let artifactId = typeof value.artifactId === "string" && value.artifactId.length > 0 ? value.artifactId : undefined;
		if (!artifactId || usedArtifactIds.has(artifactId)) {
			const legacyId = stableLegacyArtifactId(cacheDir, file);
			artifactId = legacyId;
			let suffix = 2;
			while (usedArtifactIds.has(artifactId)) artifactId = `${legacyId}-${suffix++}`;
		}
		usedArtifactIds.add(artifactId);
		files[file] = { artifactId, description, createdBy, updatedBy, created, updated, sizeBytes };
	}
	return { version: 1, files };
}

export function readManifest(cacheDir: string): CacheManifest {
	try {
		const raw = fs.readFileSync(path.join(cacheDir, CACHE_MANIFEST_FILE_NAME), "utf8");
		return projectCacheManifest(cacheDir, JSON.parse(raw));
	} catch {
		// absent or corrupt
	}
	return { version: 1, files: {} };
}

export function writeManifest(cacheDir: string, manifest: CacheManifest): void {
	fs.mkdirSync(cacheDir, { recursive: true });
	const manifestFile = path.join(cacheDir, CACHE_MANIFEST_FILE_NAME);
	const temporaryFile = path.join(cacheDir, `.${path.basename(manifestFile)}.manifest-${randomUUID()}`);
	try {
		fs.writeFileSync(temporaryFile, `${JSON.stringify(projectCacheManifest(cacheDir, manifest), null, 2)}\n`);
		fs.renameSync(temporaryFile, manifestFile);
	} finally {
		try { fs.unlinkSync(temporaryFile); } catch { /* already renamed or absent */ }
	}
}

function cacheManifestAfterWrite(
	manifest: CacheManifest,
	sessionId: string,
	file: string,
	content: string,
	description: string,
): CacheManifest {
	const now = new Date().toISOString();
	const existing = manifest.files[file];
	return {
		...manifest,
		files: {
			...manifest.files,
			[file]: {
				artifactId: existing?.artifactId ?? `artifact-${randomUUID()}`,
				description,
				createdBy: existing?.createdBy ?? sessionId,
				updatedBy: sessionId,
				created: existing?.created ?? now,
				updated: now,
				sizeBytes: new TextEncoder().encode(content).length,
			},
		},
	};
}

function writeCacheContent(cacheDir: string, file: string, content: string | Uint8Array, noFollow: boolean): void {
	fs.mkdirSync(cacheDir, { recursive: true });
	const destinationPath = path.join(cacheDir, file);
	if (!noFollow) {
		fs.writeFileSync(destinationPath, content);
		return;
	}
	const descriptor = fs.openSync(destinationPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
	try {
		fs.writeFileSync(descriptor, content);
	} finally {
		fs.closeSync(descriptor);
	}
}

function stageAndPublishCacheContent(cacheDir: string, file: string, content: string): void {
	fs.mkdirSync(cacheDir, { recursive: true });
	const destinationPath = path.join(cacheDir, file);
	const temporaryPath = path.join(cacheDir, `.${path.basename(file)}.promotion-${randomUUID()}`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		fs.writeFileSync(descriptor, content);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		// Hard-link publication is atomic and refuses an existing destination.
		fs.linkSync(temporaryPath, destinationPath);
	} finally {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
		}
		try { fs.unlinkSync(temporaryPath); } catch { /* already published or absent */ }
	}
}

function isSubpath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function writeCacheFile(
	cacheDir: string,
	manifest: CacheManifest,
	sessionId: string,
	file: string,
	content: string,
	description: string,
): CacheManifest {
	writeCacheContent(cacheDir, file, content, false);
	return cacheManifestAfterWrite(manifest, sessionId, file, content, description);
}

/**
 * Copy one explicitly selected workspace artifact into the durable cache.
 *
 * The context cache is a UTF-8 text store: entries are read and rendered as
 * UTF-8 text throughout. Promotion therefore refuses a source that is not valid
 * UTF-8 rather than decoding it lossily with replacement characters, and the
 * refusal happens before any destination, temporary, or manifest state is
 * created. Valid UTF-8 (including a leading byte-order mark) is preserved
 * byte-for-byte.
 */
export function promoteCacheFile(
	cacheDir: string,
	manifest: CacheManifest,
	sessionId: string,
	sourcePath: string,
	file: string,
	description: string,
	trustedSourceRoots?: readonly string[],
): { manifest: CacheManifest; entry: CacheFileEntry; rollback: () => void } {
	if (!isSafeCacheFileName(file)) throw new Error("file must be a safe cache filename with an extension");
	if (!path.isAbsolute(sourcePath)) throw new Error("sourcePath must be an absolute path");
	let sourceDescriptor: number;
	try {
		sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		throw new Error("sourcePath must name a regular file");
	}
	let content: string;
	try {
		const openedSource = fs.fstatSync(sourceDescriptor);
		if (!openedSource.isFile()) throw new Error("sourcePath must name a regular file");
		if (trustedSourceRoots !== undefined) {
			try {
				// Resolve the roots before the named source. This ordering makes a
				// parent swap during the check visible to the source resolution below.
				const resolvedRoots = trustedSourceRoots.flatMap((root) => {
					try {
						const resolvedRoot = fs.realpathSync.native(root);
						// Callers pass canonical roots. A different answer means a root or
						// one of its ancestors was redirected after authority was derived.
						return resolvedRoot === path.resolve(root) ? [resolvedRoot] : [];
					} catch {
						return [];
					}
				});
				const resolvedSource = fs.realpathSync.native(sourcePath);
				const namedSource = fs.statSync(sourcePath) as unknown as { dev: number; ino: number };
				if (!resolvedRoots.some((root) => isSubpath(root, resolvedSource)) || !sameFile(openedSource, namedSource)) {
					throw new Error("sourcePath must be within the session workspace.");
				}
			} catch (err) {
				if (err instanceof Error && err.message === "sourcePath must be within the session workspace.") throw err;
				throw new Error("sourcePath must be within the session workspace.", { cause: err });
			}
		}
		const sourceBytes = fs.readFileSync(sourceDescriptor);
		try {
			// Fatal decoding rejects malformed UTF-8 instead of substituting U+FFFD;
			// ignoreBOM keeps a leading byte-order mark so valid text round-trips exactly.
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sourceBytes);
		} catch {
			throw new Error("sourcePath must name a valid UTF-8 text file");
		}
	} finally {
		fs.closeSync(sourceDescriptor);
	}

	const destinationPath = path.join(cacheDir, file);
	try {
		const destinationStat = fs.lstatSync(destinationPath);
		if (!destinationStat.isFile()) throw new Error("destinationPath must name a regular file");
		if (!manifest.files[file]) throw new Error("destinationPath is an untracked regular file");
		throw new Error("destinationPath already exists");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		if (manifest.files[file]) throw new Error("destinationPath is tracked in the manifest but missing", { cause: err });
	}
	stageAndPublishCacheContent(cacheDir, file, content);
	const nextManifest = cacheManifestAfterWrite(manifest, sessionId, file, content, description);
	return {
		manifest: nextManifest,
		entry: nextManifest.files[file]!,
		rollback: () => {
			try {
				fs.unlinkSync(destinationPath);
			} catch {
				// The service must still return the manifest failure rather than throw during cleanup.
			}
		},
	};
}

export function deleteCacheFile(cacheDir: string, manifest: CacheManifest, file: string): CacheManifest {
	try {
		fs.unlinkSync(path.join(cacheDir, file));
	} catch {
		// already gone
	}
	const { [file]: _, ...rest } = manifest.files;
	return { ...manifest, files: rest };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatAge(isoDate: string): string {
	const ms = Date.now() - new Date(isoDate).getTime();
	if (ms < 60_000) return "just now";
	if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
	return `${Math.floor(ms / 86400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Cache plan parsing
// ---------------------------------------------------------------------------

export const MAX_CONTEXT_CACHE_LISTING_CHARS = 4_000;
const CACHE_CARRY_MARKER = "context-cache-carry-v1";
const CACHE_CARRY_MARKER_PATTERN = new RegExp(`<${CACHE_CARRY_MARKER}>([\\s\\S]*?)</${CACHE_CARRY_MARKER}>`, "g");

export function parseCachePlan(text: string): CachePlanArtifact[] {
	const planMatch = text.match(/<cache-plan>([\s\S]*?)<\/cache-plan>/);
	if (!planMatch) return [];

	const artifacts: CachePlanArtifact[] = [];
	const seen = new Set<string>();
	const artifactRegex = /<artifact\s+file="([^"]+)"\s+description="([^"]+)">([\s\S]*?)<\/artifact>/g;
	let m: RegExpExecArray | null;
	while ((m = artifactRegex.exec(planMatch[1])) !== null) {
		const file = m[1].trim();
		const description = m[2].trim();
		const brief = m[3].trim();
		if (isSafeCacheFileName(file) && !seen.has(file)) {
			seen.add(file);
			artifacts.push({ file, description, brief });
		}
	}
	return artifacts.slice(0, 5);
}

/** Parse the extension-owned carry marker, rejecting malformed or unsafe names. */
export function parseCacheCarryMarker(text: string): string[] {
	const openingTag = `<${CACHE_CARRY_MARKER}>`;
	const closingTag = `</${CACHE_CARRY_MARKER}>`;
	const openingTags = text.split(openingTag).length - 1;
	const closingTags = text.split(closingTag).length - 1;
	const matches = [...text.matchAll(CACHE_CARRY_MARKER_PATTERN)];
	// A complete pair is not enough: stray tags must not turn a malformed
	// model-authored summary into a trusted carry selection.
	if (openingTags !== 1 || closingTags !== 1 || matches.length !== 1) return [];
	const names = matches[0][1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const seen = new Set<string>();
	if (names.length === 0) return [];
	for (const name of names) {
		if (!isSafeCacheFileName(name) || seen.has(name)) return [];
		seen.add(name);
	}
	return names;
}

/**
 * Return the carry selection from the newest extension-owned compaction
 * summary in a branch. The caller must establish extension provenance from
 * the compaction event; summaries alone are model-authored and untrusted.
 */
export function findLatestCompactionCarrySelection(branch: readonly unknown[], fromExtension = false): string[] {
	if (!fromExtension) return [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "compaction") continue;
		// The newest compaction decides the outcome. Never fall through to an
		// older phase when this boundary is malformed or has no summary.
		if (typeof record.summary !== "string") return [];
		return parseCacheCarryMarker(record.summary);
	}
	return [];
}

export function stripCachePlan(text: string): string {
	const artifacts = parseCachePlan(text);
	const withoutCarry = text.replace(CACHE_CARRY_MARKER_PATTERN, "");
	const stripped = withoutCarry.replace(/<cache-plan>[\s\S]*?<\/cache-plan>\s*/g, "").trim();
	if (artifacts.length === 0) return stripped;
	return `${stripped}\n\n<${CACHE_CARRY_MARKER}>\n${artifacts.map((artifact) => artifact.file).join("\n")}\n</${CACHE_CARRY_MARKER}>`;
}

export interface BoundedCacheListingText {
	readonly text: string;
	readonly omittedCount: number;
}

/** Admit complete cache entries while reserving room for one remainder line. */
export function boundCacheListingText(prefix: string, lines: readonly string[], suffix = "", totalCount = lines.length): BoundedCacheListingText {
	const remainder = (omittedCount: number): string => omittedCount > 0
		? `- …and ${omittedCount} more; use /context-cache-list to see the rest.`
		: "";
	const admitted: string[] = [];
	for (const line of lines) {
		const projected = admitted.length + 1;
		const projectedRemainder = remainder(Math.max(0, totalCount - projected));
		const body = [...admitted, line, ...(projectedRemainder ? [projectedRemainder] : [])].join("\n");
		if ((prefix + body + suffix).length <= MAX_CONTEXT_CACHE_LISTING_CHARS) admitted.push(line);
	}
	let omittedCount = Math.max(0, totalCount - admitted.length);
	while ((prefix + [...admitted, ...(omittedCount > 0 ? [remainder(omittedCount)] : [])].join("\n") + suffix).length > MAX_CONTEXT_CACHE_LISTING_CHARS && admitted.length > 0) {
		admitted.pop();
		omittedCount = Math.max(0, totalCount - admitted.length);
	}
	const body = [...admitted, ...(omittedCount > 0 ? [remainder(omittedCount)] : [])].join("\n");
	return { text: prefix + body + suffix, omittedCount };
}

export function buildCacheSummarySection(cacheDir: string, manifest: CacheManifest, files: string[], originScope = "active"): string | null {
	const lines = files
		.map((file) => {
			const entry = manifest.files[file];
			if (!entry) return null;
			const description = entry.description ? ` — ${entry.description}` : "";
			return `- ${path.join(cacheDir, file)} [origin: ${originScope}] (${formatFileSize(entry.sizeBytes)})${description}`;
		})
		.filter((line): line is string => line !== null);

	if (lines.length === 0) return null;
	return boundCacheListingText("## Context Cache\n\nGenerated project context cache files:\n", lines, "", lines.length).text;
}

// ---------------------------------------------------------------------------
// Prompt constants (exported for benchmarks)
// ---------------------------------------------------------------------------

export const COMPACTION_SYSTEM_PROMPT = `You are a compaction summarizer. Produce a structured handoff summary that another LLM can use to continue the work without re-deriving prior context.

Use this format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Requirements / preferences mentioned, or "(none)"]

## Progress
### Done
- [x] [Completed items]
### In Progress
- [ ] [Current work]
### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Data needed to continue, exact identifiers preserved]

Preserve exact file paths, function names, and error messages. Be thorough but concise.`;

export const CACHE_PLAN_INSTRUCTIONS = `## Context Cache (Optional)

If there is important context in this conversation that is too detailed or large for the summary but would be valuable for future work sessions, include a <cache-plan> section at the END of your output listing artifacts to cache as standalone reference documents. Valid artifact filenames are also the documents carried into the next phase, so name only the useful documents to carry forward; omitting <cache-plan> invokes the safe newest-first fallback.

Only suggest artifacts when there is genuinely valuable context that doesn't fit in the summary — detailed plans, architectural understanding, decision rationale, configuration state, step-by-step procedures, etc. Do NOT cache raw source file contents (those already exist on disk).

Format (include at the very end, after the summary):

<cache-plan>
<artifact file="descriptive-name.md" description="Brief one-line description">
Outline of what this document should contain, referencing specific topics from the conversation.
</artifact>
</cache-plan>

Guidelines:
- Maximum 3 artifacts
- Use descriptive filenames with .md extension
- Keep the outline concise (2-5 sentences)
- If nothing needs caching beyond what the summary captures, omit <cache-plan> entirely. A plan with no useful artifacts is equivalent to omitting it.`;

export const ARTIFACT_GENERATION_SYSTEM = `You are a technical documentation writer. Write a standalone reference document based on the conversation context provided. This document will be read by future AI agents who do not have access to the original conversation. Make it self-contained, clearly organized, and include all relevant details.

Output ONLY the document content in markdown format. No preamble, no meta-commentary, no wrapping code fences.`;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export interface CleanupConfig {
	staleHours: number;
	maxBytes: number;
}

export function runCleanup(
	cacheDir: string,
	manifest: CacheManifest,
	config: CleanupConfig,
	log?: (msg: string) => void,
): { manifest: CacheManifest; changed: boolean } {
	const cutoff = Date.now() - config.staleHours * 3600_000;
	let m = manifest;
	let changed = false;

	// 1. Prune stale files
	for (const [file, entry] of Object.entries(m.files)) {
		if (new Date(entry.updated).getTime() < cutoff) {
			log?.(`removing stale file ${file} (updated ${entry.updated})`);
			m = deleteCacheFile(cacheDir, m, file);
			changed = true;
		}
	}

	// 2. Enforce size cap (remove oldest first)
	let totalSize = Object.values(m.files).reduce((sum, e) => sum + e.sizeBytes, 0);
	if (totalSize > config.maxBytes) {
		const sorted = Object.entries(m.files).sort(
			(a, b) => new Date(a[1].updated).getTime() - new Date(b[1].updated).getTime(),
		);
		for (const [file, entry] of sorted) {
			if (totalSize <= config.maxBytes * 0.8) break;
			log?.(`removing ${file} for size cap (${formatFileSize(totalSize)} > ${formatFileSize(config.maxBytes)})`);
			m = deleteCacheFile(cacheDir, m, file);
			totalSize -= entry.sizeBytes;
			changed = true;
		}
	}

	// 3. Remove orphan files
	try {
		const filesOnDisk = fs.readdirSync(cacheDir).filter((f: string) => !isReservedManifestName(f));
		for (const file of filesOnDisk) {
			if (!m.files[file]) {
				log?.(`removing orphan file ${file}`);
				try { fs.unlinkSync(path.join(cacheDir, file)); } catch { /* best-effort */ }
				changed = true;
			}
		}
	} catch {
		// cacheDir might not exist
	}

	return { manifest: m, changed };
}
