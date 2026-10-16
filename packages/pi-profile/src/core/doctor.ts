import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspectAuth } from "./auth.ts";
import { readMultiAccount } from "./multi-account.ts";
import { DEFAULT_PROFILE } from "./names.ts";
import { profilesRoot, sharedAuthPath, type Layout } from "./paths.ts";
import { getGlobalDefault, listProfiles, loadProfile } from "./profiles.ts";
import { loadConfig } from "./config.ts";
import { checkStore, settingsSessionDir } from "./sessions.ts";
import { expectedSessionDir, storeChoice } from "./storechoice.ts";
import { autoBackupStateDir } from "./autobackup.ts";
import { backupStateDir } from "./backup.ts";
import { KEYED_FILES } from "./hub.ts";
import { leftoverBreaker } from "./lock.ts";
import { pinFindings } from "./pin.ts";
import { printable, shellQuote } from "./repo.ts";
import { configReport, profileSyncRules, shown, surveyProfile, UNKNOWN_REASONS } from "./syncmanifest.ts";

export type Level = "ok" | "warn" | "error";

export interface Finding {
	readonly level: Level;
	readonly profile?: string;
	readonly message: string;
}

/**
 * Config files that some extensions read from `$PI_PROFILE_HOME` rather than
 * from the profile. A copy inside a profile is ignored, and every profile
 * shares the one outside it.
 */
export const HOME_SCOPED_CONFIG: ReadonlyArray<{ file: string; pkg: string }> = [{ file: "acp.json", pkg: "billion-context-pi" }];

function checkProfile(l: Layout, name: string, out: Finding[]): void {
	const info = loadProfile(l, name);
	const add = (level: Level, message: string): void => {
		out.push({ level, profile: name, message });
	};
	if (!info.hasManifest && name !== DEFAULT_PROFILE) add("warn", "no profile.json; run: pi-profile adopt " + name);
	for (const e of info.manifestErrors) add("error", `profile.json: ${e}`);

	const shared = sharedAuthPath(l);
	const auth = inspectAuth(info.dir);
	const mode = info.manifest.auth.mode;
	if (name === DEFAULT_PROFILE) {
		if (auth.kind === "link") add("warn", "the default profile's auth.json is a symlink; other profiles link to it");
	} else if (mode === "shared") {
		if (auth.kind !== "link" || auth.target !== shared) add("error", `auth mode is shared but auth.json is not a link to ${shared}`);
		else if (!existsSync(shared)) add("warn", `shared auth file does not exist yet: ${shared}`);
	} else {
		if (auth.kind === "link") add("error", `auth mode is ${mode} but auth.json is a link to ${auth.target}`);
		if (auth.kind === "file" && (auth.mode & 0o077) !== 0) add("error", `auth.json is readable by others (mode ${auth.mode.toString(8)}); run chmod 600`);
	}
	if (auth.kind === "other") add("error", "auth.json is neither a file nor a symlink");

	const group = info.manifest.multiAccount?.group;
	if (group !== undefined) {
		try {
			const ma = readMultiAccount(info.dir);
			if (!ma.groups.includes(group)) add("error", `multi-account group "${group}" is not defined in pi-multi-account/config.json`);
			else if (ma.defaultGroup !== group) add("warn", `defaultAccountGroup is "${ma.defaultGroup ?? "unset"}", profile says "${group}"; run: pi-profile edit ${name} --set multiAccount.group=${group}`);
		} catch (error) {
			add("error", (error as Error).message);
		}
	}

	for (const { file, pkg } of HOME_SCOPED_CONFIG) {
		if (existsSync(join(info.dir, file))) add("warn", `${file} here is ignored: ${pkg} reads ${join(l.piHome, file)}, which every profile shares`);
	}
	checkSyncManifest(l, name, add);
}

const UNKNOWN_SHOWN = 10;

/** Unknown paths, which never sync, and config files whose content looks like a credential. Never prints a value. */
function checkSyncManifest(l: Layout, name: string, add: (level: Level, message: string) => void): void {
	const { dir, rules } = profileSyncRules(l, name, false);
	const entries = surveyProfile(dir, rules);
	const unknown = entries.filter((e) => e.cls === "unknown").map((e) => printable(shown(e)) + (e.why === undefined ? "" : ` (${UNKNOWN_REASONS[e.why]})`));
	if (unknown.length > 0) {
		const more = unknown.length > UNKNOWN_SHOWN ? ` and ${unknown.length - UNKNOWN_SHOWN} more` : "";
		add("warn", `${unknown.length} unknown paths stay on this host: ${unknown.slice(0, UNKNOWN_SHOWN).join(", ")}${more}; class them with sync.include or sync.exclude in profile.json (see pi-profile sync status ${name})`);
	}
	const report = configReport(dir, entries, rules);
	for (const f of report.credentials) {
		const path = printable(f.path);
		if (f.unscanned !== undefined) add("warn", `${path} is config but was not scanned for credentials: ${f.unscanned}`);
		else if (KEYED_FILES.has(f.path)) add("warn", `${path} holds a literal API key at ${f.at.map(printable).join(", ")}; sync push leaves it out of the hub until each is an environment variable reference such as "\${NAME}" (see API keys in the pi-profile README)`);
		else add("warn", `${path} is config but holds a credential-looking value at ${f.at.map(printable).join(", ")}; config sync skips it, so move the value to an environment variable or auth.json (or, for a value that is not a secret, see pi-profile sync status ${name} --allow-line)`);
	}
	for (const g of report.ignored) add("warn", `sync.allowFindings entry for ${printable(g.entry.path)}:${String(g.entry.line)} is ignored: ${g.reason}`);
	for (const a of report.stale) add("warn", `stale allow entry: ${printable(a.path)}:${String(a.line)} (${printable(a.key)}) matches no finding; remove it from sync.allowFindings in profile.json`);
}

export { shellQuote };

export function doctor(l: Layout, env: Readonly<Record<string, string | undefined>> = {}): Finding[] {
	const out: Finding[] = [];
	const root = profilesRoot(l);
	if (existsSync(root)) {
		const mode = statSync(root).mode & 0o777;
		if ((mode & 0o077) !== 0) out.push({ level: "warn", message: `${root} is open to other users (mode ${mode.toString(8)}); run chmod 700` });
		for (const entry of readdirSync(root)) {
			if (entry.startsWith(".stage-") || entry.startsWith(".failed-")) out.push({ level: "warn", message: `leftover from an interrupted create: ${join(root, entry)}` });
		}
	}
	for (const dir of [autoBackupStateDir(l), backupStateDir(l)]) {
		const breaker = leftoverBreaker(dir);
		// Auto-backup clears a provably stale one itself; an old one left here stops auto-backup and backup runs.
		if (breaker !== undefined) out.push({ level: "warn", message: `leftover lock breaker: ${breaker}; it makes backups refuse. If no pi-profile is running, remove it: rm ${shellQuote(breaker)}` });
	}
	try {
		getGlobalDefault(l);
	} catch (error) {
		out.push({ level: "error", message: (error as Error).message });
	}
	let config: ReturnType<typeof loadConfig> | undefined;
	try {
		config = loadConfig(l, env, () => "");
		for (const [id, store] of Object.entries(config.sessionStores)) {
			const problem = checkStore(store.path);
			if (problem !== undefined) out.push({ level: "error", message: `session store ${id} ${problem}: ${store.path}` });
		}
	} catch (error) { out.push({ level: "error", message: (error as Error).message }); }
	for (const name of listProfiles(l)) {
		try {
			checkProfile(l, name, out);
			const m = loadProfile(l, name).manifest;
			const actual = settingsSessionDir(l, name);
			const choice = storeChoice(m, config);
			if (choice.kind === "unknown") {
				out.push({ level: "error", profile: name, message: `profile.json references unknown session store: ${choice.id}` });
			} else {
				const expected = expectedSessionDir(choice);
				if (choice.kind === "unset" && actual !== undefined) out.push({ level: "warn", profile: name, message: `settings.json has a hand-set sessionDir without profile.json session-store selection: ${actual}` });
				else if (actual !== expected) out.push({ level: "error", profile: name, message: `settings.json sessionDir disagrees with profile.json (expected ${expected ?? "unset"}, got ${actual ?? "unset"})` });
			}
		} catch (error) {
			out.push({ level: "error", profile: name, message: (error as Error).message });
		}
	}
	// The Pi on PATH against each hub's pin (issue 34): a warning, never a refusal; doctor installs nothing.
	out.push(...pinFindings(l, env));
	return out;
}
