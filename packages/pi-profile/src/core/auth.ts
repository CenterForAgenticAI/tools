import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	openSync,
	readFileSync,
	readlinkSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lstatOrUndefined, stamp } from "./fsutil.ts";
import { withProfileLock } from "./lock.ts";
import type { AuthMode } from "./manifest.ts";
import { Refusal } from "./result.ts";
import { fileId, placeNoClobber, statId, tidy, takeIfUnchanged, uniqueSibling } from "./swap.ts";

export type AuthState =
	| { kind: "missing" }
	| { kind: "link"; target: string; id: string }
	| { kind: "file"; mode: number; id: string }
	| { kind: "other" };

/**
 * The secret path class (`N.SecretPath`, laws L8 and L9): `auth.json`,
 * every `auth.json.bak-*` backup of it (mode-switch `bak-<stamp>` and sync
 * `bak-sync-<stamp>`), and the `auth.json.aside-*` and `auth.json.new-*`
 * files a crash can leave. Matched without regard to case, as a
 * case-insensitive file system would. Such a file never rides a backup, a
 * migration or config sync; credentials move only through `pi-profile auth`.
 */
const SECRET_PREFIXES = ["auth.json.bak-", "auth.json.aside-", "auth.json.new-"];
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase();
	return n === "auth.json" || SECRET_PREFIXES.some((p) => n.startsWith(p));
}

export function authPath(profileDir: string): string {
	return join(profileDir, "auth.json");
}

function inspectPath(p: string): AuthState {
	const st = lstatOrUndefined(p);
	if (st === undefined) return { kind: "missing" };
	const id = fileId(p) ?? "";
	if (st.isSymbolicLink()) return { kind: "link", target: readlinkSync(p), id };
	if (st.isFile()) return { kind: "file", mode: Number(st.mode) & 0o777, id };
	return { kind: "other" };
}

export function inspectAuth(profileDir: string): AuthState {
	return inspectPath(authPath(profileDir));
}

/** The mode a profile's auth.json is in now, as far as the disk shows. */
export function detectAuthMode(profileDir: string, sharedAuth: string): AuthMode | undefined {
	const s = inspectAuth(profileDir);
	if (s.kind === "link") return s.target === sharedAuth ? "shared" : undefined;
	if (s.kind === "file" || s.kind === "missing") return "separate";
	return undefined;
}

const CHANGED = "changed while pi-profile was updating it";

/** A name for a kept credential file. Unique, so a backup never overwrites another. */
function backupName(p: string): string {
	return uniqueSibling(p, `bak-${stamp()}`);
}

/** Keep a private auth file as an owner-only backup. */
function keepAsBackup(p: string, aside: string): string {
	const name = backupName(p);
	renameSync(aside, name);
	chmodSync(name, 0o600);
	return name;
}

/** Make an existing private file 0600, refusing if it is no longer the inspected file. */
function makePrivate(p: string, id: string): void {
	const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const st = fstatSync(fd, { bigint: true });
		if (statId(st) !== id) throw new Refusal(`${p} ${CHANGED}; nothing was changed, try again`);
		fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

/** Put a symlink at `p` only if nothing is there. */
function placeLink(p: string, target: string): string {
	try {
		symlinkSync(target, p);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refusal(`${p} ${CHANGED}; try again`);
		throw error;
	}
	return fileId(p) ?? "";
}

/** Best effort: put a symlink back after a failure. False if something else is there. */
function restoreLink(p: string, target: string): boolean {
	try {
		symlinkSync(target, p);
		return true;
	} catch {
		return false;
	}
}

/** Put a new private file at `p` only if nothing is there. */
function placeFile(p: string, text: string): string {
	const tmp = uniqueSibling(p, "new");
	writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
	chmodSync(tmp, 0o600);
	if (!placeNoClobber(tmp, p)) {
		tidy(tmp);
		throw new Refusal(`${p} ${CHANGED}; try again`);
	}
	return fileId(p) ?? "";
}

/**
 * Undo step: take back the object this transaction put at `p`, refusing if
 * something else is there now. Our own file is deleted only if it still holds
 * exactly what was written; otherwise it is kept as a backup.
 */
function takeBackOurs(p: string, ourId: string, ourText?: string): void {
	const aside = takeIfUnchanged(p, ourId);
	if (aside === undefined) return;
	if (ourText === undefined || readFileSync(aside, "utf8") === ourText) tidy(aside);
	else keepAsBackup(p, aside);
}

export interface AuthHooks {
	/** Test seam: runs after auth.json is inspected and before anything changes. */
	readonly afterInspect?: () => void;
}

/**
 * Put a profile's auth.json into `mode` (laws L15, L16), holding the profile
 * lock. Returns a function that undoes the change, for callers that roll back
 * when a later step fails.
 * - shared: a symlink to the shared auth file. A private file already there is
 *   kept as `auth.json.bak-<stamp>-<random>` (mode 0600), never deleted:
 *   sync pruning matches only `auth.json.bak-sync-*`.
 * - separate / pooled: a private 0600 file. It starts as `{}` unless
 *   `copyFromShared`; credentials are never copied silently.
 * Every replacement and every undo uses the compare-and-swap steps in
 * swap.ts, so a change made by another program at the same time is refused,
 * never overwritten.
 */
export function setAuthMode(
	profileDir: string,
	sharedAuth: string,
	mode: AuthMode,
	copyFromShared = false,
	hooks: AuthHooks = {},
): () => void {
	return withProfileLock(profileDir, () => {
		const p = authPath(profileDir);
		const s = inspectPath(p);
		hooks.afterInspect?.();
		if (s.kind === "other") throw new Refusal(`${p} is neither a file nor a symlink; fix it by hand`);

		if (mode === "shared") {
			if (s.kind === "link" && s.target === sharedAuth) return () => {};
			const aside = takeIfUnchanged(p, s.kind === "missing" ? undefined : s.id);
			const backup = s.kind === "file" && aside !== undefined ? keepAsBackup(p, aside) : undefined;
			if (s.kind === "link" && aside !== undefined) tidy(aside);
			let ours: string;
			try {
				ours = placeLink(p, sharedAuth);
			} catch (error) {
				// Put back what was there, so a failed switch leaves auth.json as it was.
				const restored = backup !== undefined ? placeNoClobber(backup, p) : s.kind === "link" ? restoreLink(p, s.target) : true;
				if (!restored && backup !== undefined) throw new Refusal(`${(error as Error).message}; your private auth.json is kept at ${backup}`, { cause: error });
				throw error;
			}
			return () => {
				takeBackOurs(p, ours);
				if (backup !== undefined && !placeNoClobber(backup, p)) throw new Refusal(`${p} ${CHANGED}; your private auth.json is kept at ${backup}`);
				if (s.kind === "link") placeLink(p, s.target);
			};
		}

		if (s.kind === "file") {
			if (s.mode !== 0o600) makePrivate(p, s.id);
			return () => {};
		}
		if (copyFromShared && !existsSync(sharedAuth)) throw new Refusal(`cannot copy credentials: ${sharedAuth} does not exist`);
		const text = copyFromShared ? readFileSync(sharedAuth, "utf8") : "{}\n";
		const aside = takeIfUnchanged(p, s.kind === "link" ? s.id : undefined);
		if (aside !== undefined) tidy(aside);
		let ours: string;
		try {
			ours = placeFile(p, text);
		} catch (error) {
			if (s.kind === "link") restoreLink(p, s.target);
			throw error;
		}
		return () => {
			takeBackOurs(p, ours, text);
			if (s.kind === "link") placeLink(p, s.target);
		};
	});
}

