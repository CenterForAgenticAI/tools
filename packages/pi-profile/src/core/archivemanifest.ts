import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { isArchiveRel } from "./sessionfile.ts";

/**
 * The archive list a session store keeps (`<store>/.pi-profile-archive.json`):
 * one entry per archived session. The archive writes it; a backup reads it
 * to tell an archived session's stub from a session that shrank.
 */

const MANIFEST = ".pi-profile-archive.json";

/** One archived session, as the live store's manifest records it. */
export interface ManifestEntry {
	readonly id: string;
	/** The working directory the session ran in. */
	readonly folder: string;
	readonly name?: string;
	readonly firstPrompt?: string;
	readonly lastPrompt?: string;
	readonly created: string;
	readonly modified: string;
	/** The checkout's origin remote, as host/path. */
	readonly forgeKey?: string;
	/** The session's folder relative to the top of its checkout ("." at the top). */
	readonly repoPath?: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly sha256: string;
	readonly host: string;
	/** Path of the compressed copy in this host's archive folder. */
	readonly archive: string;
	/** When the archive copy was verified. */
	readonly archivedAt: string;
	/** When the full local copy was replaced by a stub. */
	readonly stubbedAt?: string;
	/**
	 * SHA-256 of the stub the run that wrote this entry places. A run killed
	 * just after it put the full session back leaves that stub under a second
	 * name; the next run drops it only when its bytes still have this hash.
	 */
	readonly stubSha256?: string;
	readonly restoredAt?: string;
	/** Reserved for a compact summary of the session; pi-profile does not write it yet. */
	readonly summary?: string;
}

export interface Manifest {
	readonly schemaVersion: 1;
	/** By the session file's path relative to the store. */
	readonly sessions: Record<string, ManifestEntry>;
}

export function manifestPath(store: string): string {
	return join(store, MANIFEST);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parseEntry(raw: unknown): ManifestEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id), folder = str(raw.folder), created = str(raw.created), modified = str(raw.modified), sha = str(raw.sha256), host = str(raw.host), archive = str(raw.archive), archivedAt = str(raw.archivedAt);
	const size = raw.size, mtimeMs = raw.mtimeMs;
	if (id === undefined || folder === undefined || created === undefined || modified === undefined || sha === undefined || host === undefined || archivedAt === undefined || !isArchiveRel(archive)) return undefined;
	if (typeof size !== "number" || typeof mtimeMs !== "number") return undefined;
	const opt = (k: string): Record<string, string> => (typeof raw[k] === "string" ? { [k]: raw[k] as string } : {});
	return {
		id, folder, created, modified, size, mtimeMs, sha256: sha, host, archive, archivedAt,
		...opt("name"), ...opt("firstPrompt"), ...opt("lastPrompt"), ...opt("forgeKey"), ...opt("repoPath"), ...opt("stubbedAt"), ...opt("stubSha256"), ...opt("restoredAt"), ...opt("summary"),
	};
}

/** The store's manifest; an empty one when there is none. Entries that do not parse are dropped. */
export function loadManifest(store: string): Manifest {
	const raw = readJson(manifestPath(store));
	const sessions: Record<string, ManifestEntry> = {};
	if (isRecord(raw) && isRecord(raw.sessions)) {
		for (const [rel, value] of Object.entries(raw.sessions)) {
			const e = parseEntry(value);
			if (e !== undefined && isSessionRel(rel)) sessions[rel] = e;
		}
	}
	return { schemaVersion: 1, sessions };
}

export function saveManifest(store: string, m: Manifest): void {
	writeJsonAtomic(manifestPath(store), m);
}

/** A session file's path relative to its store: <name>.jsonl or <folder>/<name>.jsonl. */
function isSessionRel(rel: string): boolean {
	const parts = rel.split("/");
	return parts.length <= 2 && rel.endsWith(".jsonl") && parts.every((p) => p !== "" && !p.startsWith(".") && p !== "..");
}
