import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import type { Layout } from "./paths.ts";

/**
 * When each credential entry was last written on this host.
 * The newest write wins a merge, so a fresh login replaces an older copy
 * whatever the expiry says. Hashes and times only; machine-local state that
 * never leaves the host (L10).
 */

export interface WriteRecord {
	readonly sha: string;
	readonly at: number;
}
export type WriteRecords = Readonly<Record<string, WriteRecord>>;

/** A write time may run this far ahead of the clock (skew) before it is cut back to now. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function path(l: Layout, profile: string): string {
	return join(l.piHome, "pi-profile", "state", "authwrites", `${profile}.json`);
}

/** The saved records; empty when there are none or the file is damaged. */
export function readWrites(l: Layout, profile: string): WriteRecords {
	let raw: unknown;
	try {
		raw = readJson(path(l, profile));
	} catch {
		return {};
	}
	const out: Record<string, WriteRecord> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [p, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!NAME.test(p) || typeof v !== "object" || v === null) continue;
		const { sha, at } = v as Record<string, unknown>;
		if (typeof sha === "string" && HEX.test(sha) && typeof at === "number" && Number.isFinite(at) && at >= 0) out[p] = { sha, at };
	}
	return out;
}

export function saveWrites(l: Layout, profile: string, records: WriteRecords): void {
	const file = path(l, profile);
	mkdirSync(join(l.piHome, "pi-profile", "state", "authwrites"), { recursive: true, mode: 0o700 });
	writeJsonAtomic(file, records);
}

/**
 * The write time of each entry, from its hash. An entry whose hash matches
 * its record keeps the recorded time; any other entry (Pi refreshed or logged
 * in since) is dated by the auth file's mtime. The records are saved.
 */
export function stampEntries(l: Layout, profile: string, hashes: ReadonlyMap<string, string>, mtimeMs: number): Record<string, number> {
	const old = readWrites(l, profile);
	const next: Record<string, WriteRecord> = {};
	const times: Record<string, number> = {};
	for (const [p, sha] of hashes) {
		const rec = old[p];
		const at = rec !== undefined && rec.sha === sha ? rec.at : mtimeMs;
		next[p] = { sha, at };
		times[p] = at;
	}
	try {
		saveWrites(l, profile, next);
	} catch {
		// Times are advisory: a state directory that cannot be written leaves the expiry rule.
	}
	return times;
}

/** Record that `provider` was written at `at` with hash `sha`. */
export function recordWrite(l: Layout, profile: string, provider: string, sha: string, at: number): void {
	try {
		saveWrites(l, profile, { ...readWrites(l, profile), [provider]: { sha, at } });
	} catch {
		// See stampEntries.
	}
}

/** An incoming write time, cut back to now plus the allowed skew; undefined when it is not a time. */
export function clampWriteTime(v: unknown, now: number): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, now + MAX_SKEW_MS) : undefined;
}
