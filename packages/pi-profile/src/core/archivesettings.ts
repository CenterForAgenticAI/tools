import { isAbsolute, posix } from "node:path";
import { HOST_LABEL } from "./replica.ts";
import { Refusal } from "./result.ts";

/**
 * Where archived sessions go, and when. Machine config key "archive". This
 * host's archive folder is <path>/<host> for a local store, and the folder an
 * ssh store's key is forced into with rrsync (see the README).
 */
export type ArchiveStore =
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "ssh"; readonly host: string; readonly identity?: string };

export interface ArchiveSettings {
	readonly store: ArchiveStore;
	/** A session whose file has not changed for this many days is archived. */
	readonly olderThanDays: number;
	/**
	 * Days the full local copy stays after the archive holds a verified copy.
	 * Unset: 60 on macOS, 0 elsewhere (see keepLocalDaysFor).
	 */
	readonly keepLocalDays?: number;
}

export const DEFAULT_OLDER_THAN_DAYS = 30;
/** How long a Mac keeps its own copy after archiving (30 + 60 = 90 days in total). */
export const MAC_KEEP_LOCAL_DAYS = 60;
const MAX_DAYS = 36500;
/** An ssh identity path: absolute, with no spaces or characters ssh or a shell would read specially. */
const IDENTITY = /^\/[A-Za-z0-9._/+@-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The days the full local copy stays after archiving, on this platform. */
export function keepLocalDaysFor(s: ArchiveSettings, platform: string): number {
	return s.keepLocalDays ?? (platform === "darwin" ? MAC_KEEP_LOCAL_DAYS : 0);
}

function wholeDays(v: unknown, key: string, errors: string[]): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_DAYS) {
		errors.push("archive." + key + " must be a whole number of days, 0 or more");
		return undefined;
	}
	return v;
}

function parseStore(s: unknown, errors: string[]): ArchiveStore | undefined {
	if (isRecord(s) && s.kind === "local" && Object.keys(s).every((k) => k === "kind" || k === "path")) {
		if (typeof s.path === "string" && isAbsolute(s.path) && posix.normalize(s.path) === s.path && !/[\p{Cc}\p{Cf}]/u.test(s.path)) return { kind: "local", path: s.path };
		errors.push("archive.store.path must be an absolute, normalised path");
		return undefined;
	}
	if (isRecord(s) && s.kind === "ssh" && Object.keys(s).every((k) => k === "kind" || k === "host" || k === "identity")) {
		if (typeof s.host !== "string" || !HOST_LABEL.test(s.host)) errors.push("archive.store.host must be a Tailscale short name");
		else if (s.identity !== undefined && (typeof s.identity !== "string" || !IDENTITY.test(s.identity))) errors.push("archive.store.identity must be an absolute path of letters, digits and ._/+@-");
		else return { kind: "ssh", host: s.host, ...(typeof s.identity === "string" ? { identity: s.identity } : {}) };
		return undefined;
	}
	errors.push("archive.store must be { kind: \"local\", path } or { kind: \"ssh\", host, identity? }");
	return undefined;
}

/** archive: { store, olderThanDays?, keepLocalDays? }, copied field by field. */
export function parseArchive(raw: unknown): ArchiveSettings {
	if (!isRecord(raw)) throw new Refusal("archive must be { store, olderThanDays?, keepLocalDays? }");
	const errors = Object.keys(raw).filter((k) => !["store", "olderThanDays", "keepLocalDays"].includes(k)).map((k) => "archive." + k + " is not a known key");
	const store = parseStore(raw.store, errors);
	const older = wholeDays(raw.olderThanDays, "olderThanDays", errors) ?? DEFAULT_OLDER_THAN_DAYS;
	if (older === 0) errors.push("archive.olderThanDays must be 1 or more");
	const keep = wholeDays(raw.keepLocalDays, "keepLocalDays", errors);
	if (errors.length > 0 || store === undefined) throw new Refusal(errors.join("; "));
	return { store, olderThanDays: older, ...(keep === undefined ? {} : { keepLocalDays: keep }) };
}

/** "30d" or "30": a number of days for --older-than. */
export function parseDays(text: string, flag: string): number {
	const m = /^(\d{1,5})d?$/.exec(text);
	if (m === null || Number(m[1]) === 0) throw new Refusal(flag + " needs a number of days, 1 or more, such as 30d");
	return Number(m[1]);
}

export function describeStore(s: ArchiveStore): string {
	return s.kind === "local" ? "local " + s.path : "ssh " + s.host;
}
