import { randomBytes } from "node:crypto";
import { type BigIntStats, linkSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Refusal } from "./result.ts";

/**
 * Compare-and-swap helpers for files other programs may change at any time.
 *
 * POSIX has no atomic "replace this name only if it still holds that file".
 * These helpers get the same safety from two atomic steps:
 * - moveAside: rename the name to a fresh random name. Nothing else knows
 *   that name, so the moved object can be checked at leisure.
 * - placeNoClobber: put an object at a name only if the name is free
 *   (link() for files, symlink() for links; both fail with EEXIST).
 * Nothing is ever renamed over an existing name, so a concurrent change is
 * either seen by the check or makes the final step fail. It is never lost.
 */

/**
 * An identity for the object at a name. dev:ino alone is not enough: a file
 * system may hand a just-freed inode number to the next new file (overlayfs
 * in containers does). Type, mode, write time and size tell such a file
 * apart. The change time is not used: a rename changes it.
 */
export function statId(st: BigIntStats): string {
	return `${st.dev}:${st.ino}:${st.mode}:${st.mtimeNs}:${st.size}`;
}

export function fileId(path: string): string | undefined {
	try {
		return statId(lstatSync(path, { bigint: true }));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function uniqueSibling(path: string, tag: string): string {
	return `${path}.${tag}-${randomBytes(6).toString("hex")}`;
}

/** Move whatever is at `path` to a new unique name; `undefined` when nothing is there. */
export function moveAside(path: string): string | undefined {
	const aside = uniqueSibling(path, "aside");
	try {
		renameSync(path, aside);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return aside;
}

/**
 * Put the object at `from` at `to` only when nothing is at `to`, then remove
 * the `from` name. Returns false, leaving `from` in place, when `to` is taken.
 * A symlink is re-created rather than hard-linked, because link() on a
 * symlink follows it on some systems.
 */
export function placeNoClobber(from: string, to: string): boolean {
	try {
		if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
		else linkSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	// The object is in place: this is the commit point. Failing to remove
	// the extra name must not turn a done change into a reported failure.
	tidy(from);
	return true;
}

/**
 * Remove a temporary or moved-aside name after the change it belongs to is
 * done (or abandoned). Errors are ignored: a left-over sibling is harmless,
 * while reporting a done change as failed would make callers undo it.
 */
export function tidy(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// left behind; harmless
	}
}

/** Put a moved-aside object back, or say where it was kept. */
export function putBack(aside: string, path: string, why: string): never {
	if (placeNoClobber(aside, path)) throw new Refusal(`${path} ${why}; nothing was replaced, try again`);
	throw new Refusal(`${path} ${why}, and something new is there now; the earlier one is kept at ${aside}`);
}

/**
 * Take the object at `path` for replacement, but only if it is still `expected`
 * (a `fileId`), or still absent when `expected` is undefined. Returns the
 * aside name of the taken object, or undefined when there was nothing to take.
 */
export function takeIfUnchanged(path: string, expected: string | undefined): string | undefined {
	const aside = moveAside(path);
	if (aside === undefined) {
		if (expected !== undefined) throw new Refusal(`${path} changed while pi-profile was updating it; nothing was replaced, try again`);
		return undefined;
	}
	if (fileId(aside) !== expected) putBack(aside, path, "changed while pi-profile was updating it");
	return aside;
}

/** A file's identity and text as read at one moment; both undefined if absent. */
export interface Snapshot {
	readonly id: string | undefined;
	readonly text: string | undefined;
}

function readTextOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read a file's identity and text, retrying until both belong to the same version. */
export function readSnapshot(path: string): Snapshot {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = fileId(path);
		const text = readTextOrUndefined(path);
		if (fileId(path) === id) return { id, text };
	}
	throw new Refusal(`${path} keeps changing; try again`);
}

/**
 * Replace the file at `path` with `text` (or remove it when `text` is
 * undefined), but only if it is still `expected`: the same object with the
 * same text. A change made by another program is refused and kept, never
 * overwritten. Returns the new file's id.
 */
export interface ReplaceHooks {
	/** Test seam: runs after the old file is moved aside and before the new one is placed. */
	readonly beforePlace?: () => void;
	readonly mode?: number;
}

export function replaceIfUnchanged(
	path: string,
	expected: Snapshot,
	text: string | undefined,
	doing: string,
	hooks: ReplaceHooks = {},
): string | undefined {
	const why = `changed while pi-profile was ${doing} it`;
	const changed = `${path} ${why}; nothing was changed, try again`;
	// Prepare the new file before touching the old one, so a failure here
	// (disk full, too many open files) leaves `path` as it was.
	const tmp = text === undefined ? undefined : uniqueSibling(path, "new");
	if (tmp !== undefined) {
		try {
			writeFileSync(tmp, text as string, { mode: hooks.mode ?? 0o600, flag: "wx" });
		} catch (error) {
			tidy(tmp);
			throw error;
		}
	}
	let aside: string | undefined;
	try {
		aside = takeIfUnchanged(path, expected.id);
		if (aside !== undefined && readTextOrUndefined(aside) !== expected.text) putBack(aside, path, why);
	} catch (error) {
		if (tmp !== undefined) tidy(tmp);
		throw error;
	}
	if (tmp === undefined) {
		// The file is gone from `path`, which was the change; the aside name is extra.
		if (aside !== undefined) tidy(aside);
		return undefined;
	}
	let placed: boolean;
	try {
		hooks.beforePlace?.();
		placed = placeNoClobber(tmp, path);
	} catch (error) {
		// Any other failure: put the old file back first, so `path` is as it
		// was; only then remove the prepared file.
		let restored = aside === undefined;
		if (aside !== undefined) {
			try {
				restored = placeNoClobber(aside, path);
			} catch {
				restored = false;
			}
		}
		tidy(tmp);
		if (!restored) throw new Error(`${(error as Error).message}; the version pi-profile read is kept at ${aside}`, { cause: error });
		throw error;
	}
	if (!placed) {
		tidy(tmp);
		if (aside === undefined) throw new Refusal(changed);
		let kept = uniqueSibling(path, "previous");
		try {
			renameSync(aside, kept);
		} catch {
			kept = aside;
		}
		throw new Refusal(`${changed}; the version pi-profile read is kept at ${kept}`);
	}
	// Committed: the new file is at `path`. The old one's aside name is extra.
	if (aside !== undefined) tidy(aside);
	return fileId(path);
}
