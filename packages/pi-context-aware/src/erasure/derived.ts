import fs from "node:fs";
import path from "node:path";
import { CACHE_MANIFEST_FILE_NAME, isSafeCacheFileName, mutateManifest } from "../cache/context-cache.js";
import { metricsSessionFile } from "../metrics/records.js";
import { paritySessionFile } from "../parity/records.js";
import { readStoreFile, removeStoreFile, withStoreDirectory } from "./files.js";
import { cachePoolDirectories, removeCacheTarget } from "./session-erasure.js";

/**
 * Clears erased text from the stores derived from a session: its fold side file, its parity and metrics
 * records, and the context-cache documents and manifest descriptions. A store file that holds the text is
 * removed whole (it is a derived copy); a manifest description is blanked. Every path stays inside the
 * profile: the held-directory helpers refuse anything else, and a cache file name must be a plain name.
 */

export interface DerivedCleanOptions {
	readonly agentDir: string;
	readonly sessionId: string;
	/** Absolute path of the erased session's `.jsonl` file; its `.acp.json` side file is a derived store. */
	readonly sessionFile: string;
	/** Exact strings that were erased. Held in memory for this call only. */
	readonly texts: readonly string[];
}

export interface DerivedCleanResult {
	readonly removed: readonly string[];
	readonly redacted: readonly string[];
	/** Stores that could not be read or cleaned, with the reason. Never silent. */
	readonly failed: readonly string[];
}

export const REDACTED_DESCRIPTION = "[erased]";

export function holdsText(raw: string, texts: readonly string[]): boolean {
	return texts.some((text) => text.length > 0 && (raw.includes(text) || raw.includes(JSON.stringify(text).slice(1, -1))));
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function readIfPresent(agentDir: string, file: string): string | undefined {
	try { return withStoreDirectory(agentDir, path.dirname(file), (held) => readStoreFile(path.join(held, path.basename(file)))); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function cleanFileStore(options: DerivedCleanOptions, file: string, result: { removed: string[]; failed: string[] }): void {
	try {
		const raw = readIfPresent(options.agentDir, file);
		if (raw === undefined || !holdsText(raw, options.texts)) return;
		removeStoreFile(options.agentDir, file);
		result.removed.push(file);
	} catch (error) { result.failed.push(`${file}: ${errorText(error)}`); }
}

function cleanPool(options: DerivedCleanOptions, directory: string, result: { removed: string[]; redacted: string[]; failed: string[] }): void {
	const manifestFile = path.join(directory, CACHE_MANIFEST_FILE_NAME);
	let raw: string | undefined;
	try { raw = readIfPresent(options.agentDir, manifestFile); } catch (error) { result.failed.push(`${manifestFile}: ${errorText(error)}`); return; }
	if (raw === undefined) return;
	// The manifest's own keys are untrusted: a name that is not a plain cache file name never reaches a path.
	let files: Record<string, { description?: unknown }>;
	try {
		const parsed = JSON.parse(raw) as { files?: Record<string, { description?: unknown }> };
		files = parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : {};
	} catch (error) { result.failed.push(`${manifestFile}: ${errorText(error)}`); return; }
	for (const name of Object.keys(files)) {
		if (!isSafeCacheFileName(name)) { if (holdsText(name, options.texts)) result.failed.push(`${manifestFile}: unsafe entry name not cleaned`); continue; }
		const document = path.join(directory, name);
		try {
			const text = readIfPresent(options.agentDir, document);
			if (text !== undefined && holdsText(text, options.texts)) {
				removeCacheTarget(options.agentDir, { directory, file: name });
				result.removed.push(document);
				continue;
			}
			const description = files[name]?.description;
			if (typeof description === "string" && holdsText(description, options.texts)) {
				withStoreDirectory(options.agentDir, directory, (held) => mutateManifest(held, (manifest) => {
					const entry = manifest.files[name];
					if (entry) entry.description = REDACTED_DESCRIPTION;
					return { manifest, result: undefined };
				}));
				result.redacted.push(`${document} (description)`);
			}
		} catch (error) { result.failed.push(`${document}: ${errorText(error)}`); }
	}
}

export function cleanDerivedStores(options: DerivedCleanOptions): DerivedCleanResult {
	const result = { removed: [] as string[], redacted: [] as string[], failed: [] as string[] };
	if (options.texts.length === 0) return result;
	for (const file of [`${options.sessionFile}.acp.json`, paritySessionFile(options.agentDir, options.sessionId), metricsSessionFile(options.agentDir, options.sessionId)]) cleanFileStore(options, file, result);
	try { for (const directory of cachePoolDirectories(options.agentDir)) cleanPool(options, directory, result); }
	catch (error) { result.failed.push(`context-cache: ${errorText(error)}`); }
	return result;
}

/** Every regular file under the profile's derived stores that still holds the text. Used to prove a clean. */
export function derivedStoresHolding(agentDir: string, sessionId: string, sessionFile: string, texts: readonly string[]): string[] {
	const found: string[] = [];
	for (const file of [`${sessionFile}.acp.json`, paritySessionFile(agentDir, sessionId), metricsSessionFile(agentDir, sessionId)]) {
		try { const raw = readIfPresent(agentDir, file); if (raw !== undefined && holdsText(raw, texts)) found.push(file); } catch { found.push(file); }
	}
	for (const directory of cachePoolDirectories(agentDir)) {
		let names: string[];
		try { names = withStoreDirectory(agentDir, directory, (held) => fs.readdirSync(held)); } catch { continue; }
		for (const name of names) {
			const file = path.join(directory, name);
			try { const raw = readIfPresent(agentDir, file); if (raw !== undefined && holdsText(raw, texts)) found.push(file); } catch { found.push(file); }
		}
	}
	return found;
}
