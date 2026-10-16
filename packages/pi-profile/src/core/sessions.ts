import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { readJson } from "./fsutil.ts";
import { readSnapshot, replaceIfUnchanged } from "./swap.ts";
import { withProfileLock } from "./lock.ts";
import { overlapsPulled, remoteDir, type Layout } from "./paths.ts";
import { listProfiles, loadProfile, requireProfile, updateManifest } from "./profiles.ts";
import { Refusal } from "./result.ts";
import { loadConfig, updateConfig, type MachineConfig } from "./config.ts";

function settingsPath(dir: string): string {
	const path = join(dir, "settings.json");
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (st?.isSymbolicLink()) {
		const target = realpathSync(path);
		const root = realpathSync(dir);
		if (!target.startsWith(`${root}/`)) throw new Refusal(`settings.json links outside the profile: ${target}`);
		return target;
	}
	return path;
}
function settings(dir: string): Record<string, unknown> {
	const raw = readJson(settingsPath(dir));
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Refusal(`${dir}/settings.json must be a JSON object`);
	return raw as Record<string, unknown>;
}
export interface UseHooks {
	/** Test seam: runs after settings.json is read and before it is replaced. */
	readonly afterSettingsRead?: () => void;
}
function setSessionDir(dir: string, value: string | undefined, hooks: UseHooks): () => void {
	return withProfileLock(dir, () => {
		const path = settingsPath(dir);
		const snapshot = readSnapshot(path);
		const next = settings(dir);
		hooks.afterSettingsRead?.();
		if (value === undefined) delete next.sessionDir;
		else next.sessionDir = value;
		const mode = snapshot.id === undefined ? 0o600 : statSync(path).mode & 0o777;
		const text = `${JSON.stringify(next, null, "\t")}\n`;
		replaceIfUnchanged(path, snapshot, text, "saving settings", { mode });
		const changed = readSnapshot(path);
		return () => replaceIfUnchanged(path, changed, snapshot.text, "undoing settings", { mode });
	});
}
function validateStorePath(path: string): void {
	if (!isAbsolute(path)) throw new Refusal(`session store path must be absolute: ${path}`);
	if (/[\0\r\n]/.test(path)) throw new Refusal("session store path must not contain NUL or newline");
}
export function addStore(l: Layout, id: string, path: string, env?: Readonly<Record<string, string | undefined>>, runner?: () => string): MachineConfig {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Refusal(`invalid session store ID: ${id}`);
	if (id === "profile") throw new Refusal("session store ID is reserved: profile");
	validateStorePath(path);
	if (overlapsPulled(l, path)) throw new Refusal(`session store ${id} overlaps the pulled sessions in ${remoteDir(l)}; fork a pulled session instead`);
	return updateConfig(l, (c) => {
		if (c.sessionStores[id]) throw new Refusal(`session store already exists: ${id}`);
		return { ...c, sessionStores: { ...c.sessionStores, [id]: { path } } };
	}, env, runner);
}
export function removeStore(l: Layout, id: string, env?: Readonly<Record<string, string | undefined>>): MachineConfig {
	return updateConfig(l, (c) => {
		if (!c.sessionStores[id]) throw new Refusal(`session store does not exist: ${id}`);
		for (const name of listProfiles(l)) {
			if (loadProfile(l, name).manifest.sessions?.store === id) throw new Refusal(`session store ${id} is used by profile ${name}`);
		}
		const stores = { ...c.sessionStores };
		delete stores[id];
		const next: MachineConfig = { ...c, sessionStores: stores };
		if (c.defaultSessionStore === id) {
			const copy = { ...next };
			delete copy.defaultSessionStore;
			return copy;
		}
		return next;
	}, env);
}
function useOne(l: Layout, id: string, name: string, value: string | undefined, hooks: UseHooks): void {
	const dir = requireProfile(l, name);
	updateManifest(l, name, (m) => ({ ...m, sessions: { store: id } }), {}, {
		beforeManifest: () => setSessionDir(dir, value, hooks),
	});
}
export function useStore(l: Layout, id: string, profiles: readonly string[], env?: Readonly<Record<string, string | undefined>>, hooks: UseHooks = {}): string[] {
	const store = loadConfig(l, env).sessionStores[id];
	if (!store) throw new Refusal(`session store does not exist: ${id}`);
	const failed: string[] = [];
	for (const name of profiles) {
		try {
			useOne(l, id, name, store.path, hooks);
		} catch (error) {
			failed.push(`${name}: ${(error as Error).message}`);
		}
	}
	return failed;
}
export function useProfileSessions(l: Layout, profiles: readonly string[], hooks: UseHooks = {}): string[] {
	const failed: string[] = [];
	for (const name of profiles) {
		try {
			useOne(l, "profile", name, undefined, hooks);
		} catch (error) {
			failed.push(`${name}: ${(error as Error).message}`);
		}
	}
	return failed;
}
export function checkStore(path: string): string | undefined {
	if (!existsSync(path)) return "does not exist";
	try {
		accessSync(path, constants.W_OK);
	} catch {
		return "is not writable";
	}
	return undefined;
}
export function settingsSessionDir(l: Layout, name: string): string | undefined {
	const raw = readJson(join(requireProfile(l, name), "settings.json"));
	if (raw === undefined) return undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Refusal(`${requireProfile(l, name)}/settings.json must be a JSON object`);
	return typeof (raw as Record<string, unknown>).sessionDir === "string" ? (raw as Record<string, string>).sessionDir : undefined;
}
