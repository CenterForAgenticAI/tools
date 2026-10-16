import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setAuthMode, detectAuthMode } from "./auth.ts";
import { resolveColor } from "./color.ts";
import { validateEnv } from "./env.ts";
import { lstatOrUndefined, readJson, stamp, writeFileAtomic } from "./fsutil.ts";
import { readSnapshot, replaceIfUnchanged } from "./swap.ts";
import { withProfileLock } from "./lock.ts";
import { parseManifest, serializeManifest, type AuthMode, type Manifest } from "./manifest.ts";
import { applyGroup } from "./multi-account.ts";
import { DEFAULT_PROFILE, isProfileName, isSelectableName } from "./names.ts";
import { globalDefaultFile, profileDir, profilesRoot, sharedAuthPath, trashDir, type Layout } from "./paths.ts";
import { Refusal } from "./result.ts";

export const MANIFEST = "profile.json";

export interface ProfileInfo {
	readonly name: string;
	readonly dir: string;
	/** Parsed manifest, or a synthesised one when the profile has no `profile.json` yet. */
	readonly manifest: Manifest;
	readonly hasManifest: boolean;
	readonly manifestErrors: readonly string[];
	readonly color: string;
}

function ensureRoot(l: Layout): string {
	const root = profilesRoot(l);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const st = lstatOrUndefined(root);
	if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) throw new Refusal(`profiles root is not a real directory: ${root}`);
	return root;
}

/** Resolve a profile directory, refusing names and paths that could escape the profiles root. */
export function requireProfile(l: Layout, name: string): string {
	if (!isSelectableName(name)) throw new Refusal(`invalid profile name: ${name}`);
	const dir = profileDir(l, name);
	const st = lstatOrUndefined(dir);
	if (st === undefined) throw new Refusal(`profile does not exist: ${name}`);
	if (name !== DEFAULT_PROFILE && st.isSymbolicLink()) {
		const target = realpathSync(dir);
		const root = realpathSync(profilesRoot(l));
		if (!target.startsWith(`${root}/`)) throw new Refusal(`profile ${name} links outside the profiles root`);
		return dir;
	}
	if (!st.isDirectory() && !st.isSymbolicLink()) throw new Refusal(`profile is not a directory: ${name}`);
	return dir;
}

export function listProfiles(l: Layout): string[] {
	const names = [DEFAULT_PROFILE];
	const root = profilesRoot(l);
	if (!existsSync(root)) return names;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!isProfileName(entry.name)) continue;
		if (entry.isDirectory()) names.push(entry.name);
		else if (entry.isSymbolicLink()) {
			try {
				requireProfile(l, entry.name);
				names.push(entry.name);
			} catch {
				// A link that escapes the root is reported by doctor, not listed.
			}
		}
	}
	return names.sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : a.localeCompare(b, "en")));
}

/** Read `profile-env.json` from the fish utility, if present. */
function legacyEnv(dir: string): Record<string, string> | undefined {
	const raw = readJson(join(dir, "profile-env.json"));
	if (raw === undefined) return undefined;
	const checked = validateEnv(raw, dir);
	return checked.ok ? checked.value : undefined;
}

export function loadProfile(l: Layout, name: string): ProfileInfo {
	const dir = requireProfile(l, name);
	const raw = readJson(join(dir, MANIFEST));
	if (raw === undefined) {
		const mode = detectAuthMode(dir, sharedAuthPath(l)) ?? "shared";
		const env = legacyEnv(dir);
		const manifest: Manifest = { schemaVersion: 1, name, auth: { mode }, ...(env ? { env } : {}) };
		return { name, dir, manifest, hasManifest: false, manifestErrors: [], color: resolveColor(name, undefined) };
	}
	const parsed = parseManifest(raw, dir);
	if (!parsed.ok) {
		const manifest: Manifest = { schemaVersion: 1, name, auth: { mode: "shared" } };
		return { name, dir, manifest, hasManifest: true, manifestErrors: parsed.errors, color: resolveColor(name, undefined) };
	}
	return { name, dir, manifest: parsed.value, hasManifest: true, manifestErrors: [], color: resolveColor(name, parsed.value.color) };
}

export interface CreateOptions {
	readonly from?: string;
	readonly auth?: AuthMode;
	readonly copyAuth?: boolean;
	readonly color?: string;
	readonly group?: string;
	readonly description?: string;
}

const COPY_FROM = ["settings.json", "AGENTS.md", "models.json"];

/**
 * Create a profile in a private staging directory, then move it into place,
 * so a half-made profile is never visible under its real name.
 */
export function createProfile(l: Layout, name: string, opts: CreateOptions = {}): ProfileInfo {
	if (!isProfileName(name)) throw new Refusal(`invalid profile name (one safe component; "${DEFAULT_PROFILE}" is reserved): ${name}`);
	const root = ensureRoot(l);
	const dir = join(root, name);
	if (lstatOrUndefined(dir) !== undefined) throw new Refusal(`profile already exists: ${name}`);
	const source = opts.from !== undefined ? loadProfile(l, opts.from) : undefined;
	if (source?.manifest.env !== undefined) {
		throw new Refusal(`profile ${source.name} sets env paths inside its own directory; create without --from and set env by hand`);
	}

	const stage = join(root, `.stage-${name}-${stamp()}-${process.pid}`);
	mkdirSync(stage, { mode: 0o700 });
	try {
		let settings = "{}\n";
		for (const file of COPY_FROM) {
			if (source === undefined) break;
			const from = join(source.dir, file);
			if (!existsSync(from)) continue;
			if (file === "settings.json") settings = readFileSync(from, "utf8");
			else writeFileSync(join(stage, file), readFileSync(from), { mode: 0o600 });
		}
		writeFileAtomic(join(stage, "settings.json"), settings);

		const mode = opts.auth ?? source?.manifest.auth.mode ?? "shared";
		setAuthMode(stage, sharedAuthPath(l), mode, opts.copyAuth ?? false);

		const manifest: Manifest = { schemaVersion: 1, name, auth: { mode } };
		const description = opts.description ?? source?.manifest.description;
		if (description !== undefined) manifest.description = description;
		if (opts.color !== undefined) manifest.color = opts.color;
		const group = opts.group ?? source?.manifest.multiAccount?.group;
		if (group !== undefined) {
			if (source !== undefined) {
				const from = join(source.dir, "pi-multi-account", "config.json");
				if (existsSync(from)) {
					mkdirSync(join(stage, "pi-multi-account"), { mode: 0o700 });
					writeFileSync(join(stage, "pi-multi-account", "config.json"), readFileSync(from), { mode: 0o600 });
				}
			}
			applyGroup(stage, group);
			manifest.multiAccount = { group };
		}
		const checked = parseManifest(JSON.parse(serializeManifest(manifest)), dir);
		if (!checked.ok) throw new Refusal(checked.errors.join("; "));
		writeFileAtomic(join(stage, MANIFEST), serializeManifest(manifest));
		if (lstatOrUndefined(dir) !== undefined) throw new Refusal(`profile appeared during creation: ${name}`);
		renameSync(stage, dir);
	} catch (error) {
		renameSync(stage, join(root, `.failed-${name}-${stamp()}-${process.pid}`));
		throw error;
	}
	return loadProfile(l, name);
}

/** Write `profile.json` for a profile that does not have one yet (fish-utility profiles). */
export function adoptProfile(l: Layout, name: string): { adopted: boolean; manifest: Manifest } {
	if (!isProfileName(name)) throw new Refusal(`cannot adopt "${name}"`);
	const dir = requireProfile(l, name);
	// Everything is read under the lock, so the manifest describes the disk as it is now.
	return withProfileLock(dir, () => {
		const info = loadProfile(l, name);
		if (info.hasManifest) return { adopted: false, manifest: info.manifest };
		const checked = parseManifest(JSON.parse(serializeManifest(info.manifest)), dir);
		if (!checked.ok) throw new Refusal(`${name}: ${checked.errors.join("; ")}`);
		replaceIfUnchanged(join(dir, MANIFEST), { id: undefined, text: undefined }, serializeManifest(checked.value), "adopting");
		return { adopted: true, manifest: checked.value };
	});
}

export interface SaveHooks {
	/** Test seam: runs after the other files are changed and before profile.json is written. */
	readonly beforeManifest?: () => void | (() => void);
}

/**
 * Change a profile's manifest: read it, apply `change` to the current value,
 * validate, apply the parts that live in other files, and save, all while
 * holding the profile lock. `change` must derive the result from the value
 * it is given, never from an earlier read, so a concurrent edit is not lost.
 * All or nothing: when any step fails, the steps already done are undone,
 * in reverse order, before the error is reported. profile.json is replaced
 * only if it is still the file that was read (an editor that ignores the
 * lock is not overwritten).
 */
export function updateManifest(
	l: Layout,
	name: string,
	change: (current: Manifest) => Manifest,
	opts: { copyAuth?: boolean } = {},
	hooks: SaveHooks = {},
): ProfileInfo {
	const dir = requireProfile(l, name);
	withProfileLock(dir, () => {
		const path = join(dir, MANIFEST);
		const read = readSnapshot(path);
		const checked = parseManifest(JSON.parse(serializeManifest(change(loadProfile(l, name).manifest))), dir);
		if (!checked.ok) throw new Refusal(checked.errors.join("; "));
		const m = checked.value;
		if (name === DEFAULT_PROFILE && m.auth.mode !== "separate") {
			throw new Refusal("the default profile owns the shared auth.json; its auth mode is always separate");
		}
		const undo: Array<() => void> = [];
		try {
			if (m.multiAccount !== undefined) undo.push(applyGroup(dir, m.multiAccount.group, m.multiAccount.members));
			if (name !== DEFAULT_PROFILE) undo.push(setAuthMode(dir, sharedAuthPath(l), m.auth.mode, opts.copyAuth ?? false));
			const undoStep = hooks.beforeManifest?.();
			if (undoStep !== undefined) undo.push(undoStep);
			replaceIfUnchanged(path, read, serializeManifest(m), "saving");
		} catch (error) {
			const failed: unknown[] = [];
			for (const step of undo.reverse()) {
				try {
					step();
				} catch (undoError) {
					failed.push(undoError);
				}
			}
			if (failed.length > 0) {
				throw new Error(`${(error as Error).message}; undoing the partial change also failed (${failed.map((e) => (e as Error).message).join("; ")}); run "pi-profile doctor"`, { cause: error });
			}
			throw error;
		}
	});
	return loadProfile(l, name);
}

/**
 * Move a profile to `.trash/`. Sessions inside it move with it; nothing is deleted.
 * The copy is `<name>-<stamp>`, or `<name>-<stamp>-2`, `-3`, ... when a copy
 * of the same name went there in the same second (issue 53).
 */
export function deleteProfile(l: Layout, name: string): string {
	if (!isProfileName(name)) throw new Refusal(`cannot delete "${name}"`);
	const dir = requireProfile(l, name);
	if (getGlobalDefault(l) === name) throw new Refusal(`${name} is the global default; run "pi-profile default clear" first`);
	const trash = trashDir(l);
	mkdirSync(trash, { recursive: true, mode: 0o700 });
	const base = join(trash, `${name}-${stamp()}`);
	for (let n = 1; n <= TRASH_TRIES; n++) {
		const to = n === 1 ? base : `${base}-${String(n)}`;
		// rename replaces an empty folder, so a name that exists is never tried.
		if (lstatOrUndefined(to) !== undefined) continue;
		try {
			renameSync(dir, to);
			return to;
		} catch (error) {
			// Another delete took the name between the check and the rename.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") throw error;
		}
	}
	throw new Error(`no free name in ${trash} for ${name}: ${String(TRASH_TRIES)} copies of it went there this second`);
}

const TRASH_TRIES = 1000;

export function getGlobalDefault(l: Layout): string | undefined {
	const file = globalDefaultFile(l);
	const st = lstatOrUndefined(file);
	if (st === undefined) return undefined;
	if (!st.isFile()) throw new Refusal(`global default file is not a regular file: ${file}`);
	const name = readFileSync(file, "utf8").slice(0, 128).trim();
	if (name.length === 0) return undefined;
	if (!isProfileName(name)) throw new Refusal(`global default file holds an invalid name: ${name}`);
	return name;
}

export function setGlobalDefault(l: Layout, name: string | undefined): void {
	const root = ensureRoot(l);
	const file = globalDefaultFile(l);
	if (name === undefined || name === DEFAULT_PROFILE) {
		if (lstatOrUndefined(file) !== undefined) writeFileAtomic(file, "");
		return;
	}
	requireProfile(l, name);
	writeFileAtomic(file, `${name}\n`);
	chmodSync(root, 0o700);
}
