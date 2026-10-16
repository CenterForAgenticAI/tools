import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_HUB, loadConfig, type MachineConfig } from "./config.ts";
import { lstatOrUndefined } from "./fsutil.ts";
import { commitAt, fetch, gateTree, git, hubsDir, HUB_JSON, MAIN, openMirror, ORIGIN_MAIN, parseHubJson, readBlobs, said, shownProblems, treeEntries, type Entry, type Git } from "./hub.ts";
import { renderFile } from "./hubrender.ts";
import { holdWayOut, localId, readSyncState, writeSyncState, type FileRecord, type SyncState } from "./hubstate.ts";
import { pinDiverged, readPinState, shownPin, writePinState, type HubPin } from "./pinstate.ts";
import { withProfileLock } from "./lock.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { DEFAULT_PROFILE, isProfileName } from "./names.ts";
import { checkPackages, packageSources, processPackageRunner, type PackageNote, type PackageRunner } from "./packages.ts";
import { profileDir, profilesRoot, type Env, type Layout } from "./paths.ts";
import { createProfile, requireProfile } from "./profiles.ts";
import { printable, shellQuote } from "./repo.ts";
import { Refusal } from "./result.ts";
import { classifyContent, MAX_SCAN_BYTES, profileSyncRules, syncRulesOf, UNKNOWN_REASONS, type SyncRules } from "./syncmanifest.ts";
import { isTokenRoot, sessionDirFor, tokenHost, type Json, type TokenHost } from "./tokens.ts";

/**
 * `sync pull [NAME...]` (design §Config hub, issue 32): fetch each hub and
 * render its portable layer into this host's profiles.
 *
 * The fetched tree is untrusted: it passes the commit gate (`gateTree`) before
 * anything is read from it, and each file is classed again before it is
 * written, under the sync rules of the profile.json this host will hold after
 * the pull. A file that is not `config` there is left out, and so is its
 * profile: the mirror's `main` does not move past it, so a push from this
 * host cannot drop it from the hub. A file is written by a staged write and a
 * rename, so a killed pull leaves each file whole.
 *
 * A local edit is never lost silently. `state/sync/last.json` records, for
 * each file, the copy this host and the hub last agreed on. A file the hub
 * changed while this host changed it too is a conflict, and so is a file
 * that differs from the hub with no record: the pull refuses and lists them
 * unless `--theirs` or `--keep-local` picks a side. `--theirs` also takes
 * the hub's copy of a file only this host changed, and lists it: it is an
 * explicit request, and the way out of a hold. With no names it does so
 * only in a profile that has a conflict or a hold; with names, in every
 * named profile (issue 50). A file the hub did not change
 * is written again only when its render for this host changed since the last
 * record (`FileRecord.rendered`), never because the local file is not in
 * rendered form.
 *
 * A profile pulled without a hub file is held: the hold is recorded in
 * `last.json`, and `sync push` refuses the profile until a pull takes the
 * file (`--theirs`, or this host's sync rules widened).
 *
 * Locks: the `sync/` lock for the whole pull, then one profile lock at a
 * time, the order `sync push` uses; every lock refuses at once.
 *
 * Push and pull: once every profile the hub holds is pulled, the mirror's
 * `main` moves to the pulled commit, so the next `sync push` builds on it
 * and fast-forwards.
 */

export type Resolve = "theirs" | "keep-local";

export interface PullHooks {
	/** Under the profile's lock, before its files are written. */
	readonly beforeWrite?: (profile: string) => void;
	/** After a file's staged copy is written and synced, before it is renamed into place. */
	readonly beforeRename?: (profile: string, rel: string) => void;
}

export interface PullOptions {
	readonly env?: Env;
	readonly dryRun?: boolean;
	readonly resolve?: Resolve;
	readonly installPackages?: boolean;
	readonly runner?: PackageRunner;
	/** Gets each `pi install` command line before it runs (law L25); never called on a dry run, which installs nothing. */
	readonly beforeInstall?: (command: string) => void;
	readonly hooks?: PullHooks;
}

export interface FileAction {
	readonly path: string;
	readonly action: "write" | "remove";
}

export interface ProfilePull {
	readonly profile: string;
	readonly hub: string;
	readonly created: boolean;
	/** Set for an alias: the profile it links to. */
	readonly alias?: string;
	readonly files: readonly FileAction[];
}

export interface HubPull {
	readonly hub: string;
	/** The hub commit pulled from; undefined when the hub is empty or failed. */
	readonly commit?: string;
	/** Profiles in the hub this pull left out, or pulled without a file it holds; while any is left, the mirror's main does not move. */
	readonly pending?: readonly string[];
	readonly failed?: { readonly message: string; readonly refused: boolean };
}

export interface Conflict {
	readonly profile: string;
	readonly path: string;
	/** What the hub does to the file. */
	readonly hub: "write" | "remove";
	/** Only this host changed the file; listed when `--theirs` takes the hub's copy. */
	readonly onlyHere?: true;
}

export interface PullReport {
	readonly dryRun: boolean;
	readonly hubs: readonly HubPull[];
	readonly profiles: readonly ProfilePull[];
	/** Conflicts left open: only a dry run returns any; a real pull refuses instead. */
	readonly conflicts: readonly Conflict[];
	/** Conflicts settled by `--theirs` or `--keep-local`. */
	readonly resolved: ReadonlyArray<Conflict & { readonly side: Resolve }>;
	/** Files left alone, and why. Locations only. */
	readonly skipped: ReadonlyArray<{ readonly profile: string; readonly path: string; readonly reason: string }>;
	readonly skippedProfiles: ReadonlyArray<{ readonly profile: string; readonly reason: string }>;
	/** Profiles pulled without some hub files (not config here): `sync push` refuses them until a pull takes the files. */
	readonly held: ReadonlyArray<{ readonly profile: string; readonly paths: readonly string[]; readonly wayOut: string }>;
	readonly packages: readonly PackageNote[];
	/** Each hub whose Pi version pin moved since this host last agreed with it (issue 34). */
	readonly pins: readonly PinMove[];
	/** Pins changed here and in the hub, left open: only a dry run returns any; a real pull refuses instead (issue 54). */
	readonly pinConflicts: readonly PinConflict[];
	/** With `pinConflicts`: the way out, as the refusal prints it. */
	readonly pinHint?: string;
	readonly warnings: readonly string[];
}

/** The Pi version pin of `hub` moved from `from` to `to` (absent: no pin). */
export interface PinMove {
	readonly hub: string;
	readonly from?: string;
	readonly to?: string;
	/** `--keep-local` settled a diverged pin: this host's pin, kept to be pushed (absent: no pin). */
	readonly kept?: { readonly pin?: string };
	/** `--theirs` settled a diverged pin: this host's pin, replaced by the hub's (absent: no pin). */
	readonly took?: { readonly pin?: string };
}

/**
 * The Pi version pin of `hub` changed on both sides (issue 54):
 * this host's pin `here`, not pushed yet, and the hub's, moved from `from`
 * (the pin this host last agreed with) to `to`. Absent: no pin.
 */
export interface PinConflict {
	readonly hub: string;
	readonly here?: string;
	readonly from?: string;
	readonly to?: string;
}

/** A file of a profile as the hub has it, rendered for this host. */
interface HubFile {
	readonly rel: string;
	readonly blob: string;
	readonly mode: string;
	readonly bytes: Buffer;
}

/** What is at a profile path on this host. */
type Local = { readonly kind: "absent" } | { readonly kind: "file"; readonly id: string } | { readonly kind: "other"; readonly reason: string };

interface Step {
	readonly rel: string;
	readonly action: "write" | "remove" | "record" | "keep" | "forget";
	readonly file?: HubFile;
	/** The local state the step was planned against; checked again before it runs. */
	readonly seen: Local;
	readonly record?: FileRecord;
	readonly conflict?: Conflict;
}

interface ProfilePlan {
	readonly name: string;
	readonly hub: string;
	readonly create: boolean;
	readonly authMode: Manifest["auth"]["mode"];
	readonly steps: readonly Step[];
	/** The rendered settings.json, when the pull writes it; else the file here is what counts. */
	readonly settingsWrite?: Json;
	/** The pull removes settings.json here. */
	readonly settingsRemoved: boolean;
	/** Hub files left out (not config here): the profile is pulled, but not in full. */
	readonly held: readonly string[];
}

interface AliasPlan {
	readonly name: string;
	readonly hub: string;
	readonly target: string;
}

interface HubPlan {
	readonly hub: string;
	readonly g: Git;
	readonly commit: string;
	readonly profiles: ProfilePlan[];
	readonly aliases: AliasPlan[];
	readonly pending: Set<string>;
	/** Every name the hub holds, as files or as an alias. */
	readonly found: Set<string>;
	/** The hub's Pi version pin, checked by the gate. */
	readonly pin?: string;
	/**
	 * This pull settles the hub's pin: with no names, every hub; with names,
	 * a hub that holds one of them for this host (issue 54).
	 */
	named: boolean;
	/**
	 * Names that address this hub's pin in a printed way out, so it reads no
	 * other hub (issue 54): when the pull reads the hub, each
	 * profile and alias it planned; when it reads none, each one the hub
	 * holds for this host.
	 */
	readonly readers: string[];
}

const TEMP = /^\..+\.pi-pull-[0-9a-f]{12}\.tmp$/;

/** Why `rel`, under the profile at `dir` (a real path), cannot be written safely, or undefined. */
function parentProblem(dir: string, rel: string): string | undefined {
	let at = dir;
	for (const seg of rel.split("/").slice(0, -1)) {
		at = join(at, seg);
		const st = lstatOrUndefined(at);
		if (st === undefined) return undefined;
		if (st.isSymbolicLink()) return "a folder on its path is a link here; links are never followed";
		if (!st.isDirectory()) return "a folder on its path is not a folder here";
	}
	return undefined;
}

/** The file at `rel` of the profile at `dir`: read with O_NOFOLLOW, never through a link. */
function readLocal(dir: string, rel: string): Local {
	const parent = parentProblem(dir, rel);
	if (parent !== undefined) return { kind: "other", reason: parent };
	const abs = join(dir, ...rel.split("/"));
	const st = lstatOrUndefined(abs);
	if (st === undefined) return { kind: "absent" };
	if (st.isSymbolicLink()) return { kind: "other", reason: "a link here; links are never followed or replaced" };
	if (!st.isFile()) return { kind: "other", reason: "not a regular file here" };
	if (st.nlink !== 1) return { kind: "other", reason: "a hard link here" };
	if (st.size > MAX_SCAN_BYTES) return { kind: "other", reason: "larger than 1 MiB here" };
	let fd: number | undefined;
	try {
		fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const f = fstatSync(fd);
		if (!f.isFile() || f.nlink !== 1 || f.size > MAX_SCAN_BYTES) return { kind: "other", reason: "changed while it was read" };
		const buf = Buffer.alloc(f.size);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (n === 0) break;
			got += n;
		}
		return { kind: "file", id: localId(buf.subarray(0, got)) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "absent" };
		return { kind: "other", reason: code === "ELOOP" ? "a link here; links are never followed or replaced" : `cannot be read here (${code ?? "error"})` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function sameLocal(a: Local, b: Local): boolean {
	return a.kind === b.kind && (a.kind !== "file" || a.id === (b as { id: string }).id);
}

/**
 * Write `bytes` to `rel` of the profile at `dir`: a staged sibling, synced,
 * then renamed over the name. The folders on the way are made as real
 * folders and never followed through a link.
 */
function writeStaged(dir: string, rel: string, bytes: Buffer, executable: boolean, beforeRename: () => void): void {
	const segs = rel.split("/");
	let at = dir;
	for (const seg of segs.slice(0, -1)) {
		at = join(at, seg);
		try {
			mkdirSync(at, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const st = lstatSync(at);
		if (st.isSymbolicLink() || !st.isDirectory()) throw new Refusal(`${rel}: a folder on its path changed while pulling`);
	}
	const abs = join(dir, ...segs);
	const tmp = join(dirname(abs), `.${basename(abs)}.pi-pull-${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, executable ? 0o700 : 0o600);
	try {
		let put = 0;
		while (put < bytes.length) put += writeSync(fd, bytes, put, bytes.length - put);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		beforeRename();
		renameSync(tmp, abs);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Remove the staged copies a killed pull left in the folders this pull writes to. */
function clearStaged(dir: string, rels: readonly string[]): void {
	const dirs = new Set(rels.map((r) => r.split("/").slice(0, -1).join("/")));
	for (const d of dirs) {
		const abs = d === "" ? dir : join(dir, ...d.split("/"));
		if (d !== "" && parentProblem(dir, `${d}/x`) !== undefined) continue;
		const st = lstatOrUndefined(abs);
		if (st === undefined || !st.isDirectory()) continue;
		for (const name of readdirSync(abs)) {
			if (!TEMP.test(name)) continue;
			const p = join(abs, name);
			if (lstatOrUndefined(p)?.isFile() === true) rmSync(p, { force: true });
		}
	}
}

/** The hub a profile belongs to: this host's `sync.hub` when it has the profile, else the hub copy's. */
function ownerHub(l: Layout, name: string, hubManifest: Manifest | undefined): string {
	if (lstatOrUndefined(profileDir(l, name)) !== undefined) {
		try {
			const dir = requireProfile(l, name);
			const raw: unknown = JSON.parse(readLocalText(join(dir, "profile.json")) ?? "{}");
			const sync = typeof raw === "object" && raw !== null ? (raw as { sync?: { hub?: unknown } }).sync : undefined;
			return typeof sync?.hub === "string" ? sync.hub : DEFAULT_HUB;
		} catch {
			return DEFAULT_HUB;
		}
	}
	return hubManifest?.sync?.hub ?? DEFAULT_HUB;
}

function readLocalText(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > MAX_SCAN_BYTES) return undefined;
		const buf = Buffer.alloc(st.size);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (n === 0) break;
			got += n;
		}
		return buf.subarray(0, got).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

interface Ctx {
	readonly l: Layout;
	readonly config: MachineConfig;
	readonly host: TokenHost;
	readonly state: SyncState;
	readonly resolve: Resolve | undefined;
	readonly warnings: string[];
	readonly skipped: Array<{ profile: string; path: string; reason: string }>;
	readonly conflicts: Conflict[];
	/**
	 * `--theirs` takes the hub's copy of a file changed only here in every
	 * profile: true when the pull names its profiles. With no names, only in a
	 * profile that has a conflict or a hold (issue 50).
	 */
	readonly theirsEverywhere: boolean;
}

/** The sync rules profile `name` has after this pull: the hub's `sync` setting when its profile.json is written, else this host's. */
function rulesAfter(dir: string, hubSync: Manifest["sync"], keepsLocal: boolean, local: SyncRules | undefined, sessionDir: string | undefined): SyncRules {
	const hub = syncRulesOf(dir, hubSync, sessionDir);
	const base = keepsLocal && local !== undefined ? local : hub;
	// Session folders under either sessionDir are never written: stricter is safe, since a file left out holds the profile.
	return { ...base, sessionDirs: [...new Set([...(local?.sessionDirs ?? []), ...hub.sessionDirs])] };
}

/** settings.json of profile `name` as it is here, parsed; undefined when absent or not readable. */
function settingsHere(ctx: Ctx, name: string): unknown {
	if (lstatOrUndefined(profileDir(ctx.l, name)) === undefined) return undefined;
	const text = readLocalText(join(realpathSync(requireProfile(ctx.l, name)), "settings.json"));
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		ctx.warnings.push(`${name}/settings.json is not valid JSON here; its packages were not checked`);
		return undefined;
	}
}

/**
 * The steps that bring profile `name` to the hub's copy `files`, judged
 * against this host's files and the record. Read under the profile's lock
 * when the profile exists.
 */
function planProfile(ctx: Ctx, hub: string, name: string, files: ReadonlyMap<string, { blob: string; mode: string; bytes: Buffer }>, takeOnlyHere: boolean): ProfilePlan {
	// The hub's profile.json, rendered, gives the sessionDir and, for a new profile, its auth mode.
	let manifest: Manifest | undefined;
	const pj = files.get("profile.json");
	if (pj !== undefined) {
		const r = renderFile("profile.json", pj.bytes, ctx.host, undefined);
		const parsed = parseManifest(r.json, profileDir(ctx.l, name));
		if (!parsed.ok) throw new Refusal(`${name}: profile.json in the hub: ${parsed.errors.join("; ")}`);
		if (parsed.value.name !== name) throw new Refusal(`${name}: profile.json in the hub names another profile (${printable(parsed.value.name)})`);
		manifest = parsed.value;
	}
	const sessionDir = sessionDirFor(manifest ?? {}, ctx.config);
	const exists = lstatOrUndefined(profileDir(ctx.l, name)) !== undefined;
	let dir: string | undefined;
	let localRules: SyncRules | undefined;
	if (exists) {
		const linkPath = requireProfile(ctx.l, name);
		if (name !== DEFAULT_PROFILE && lstatSync(linkPath).isSymbolicLink()) throw new Refusal(`${name} is a link to another profile here, and the hub holds files for it; left as it is`);
		dir = realpathSync(linkPath);
		localRules = profileSyncRules(ctx.l, name, true).rules;
	}
	const record = ctx.state.profiles.get(name);
	const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const rendered = new Map<string, { file: HubFile; json?: Json }>();
	for (const [rel, f] of sorted) {
		let out: { bytes: Buffer; json?: Json; warnings: readonly string[] };
		try {
			out = renderFile(rel, f.bytes, ctx.host, sessionDir);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			throw new Refusal(`${name}/${rel}: ${error.message}`);
		}
		ctx.warnings.push(...out.warnings.map((w) => `${name}/${rel}: ${w}`));
		rendered.set(rel, { file: { rel, blob: f.blob, mode: f.mode, bytes: out.bytes }, ...(out.json === undefined ? {} : { json: out.json }) });
	}

	/** The step for hub file `rel`, or undefined when it is a conflict left open (recorded in ctx.conflicts). */
	const decide = (rel: string): Step | undefined => {
		const file = (rendered.get(rel) as { file: HubFile }).file;
		const want = localId(file.bytes);
		const agreed: FileRecord = { local: want, hub: file.blob, rendered: want };
		if (dir === undefined) return { rel, action: "write", file, seen: { kind: "absent" }, record: agreed };
		const local = readLocal(dir, rel);
		if (local.kind === "other") throw new Refusal(`${name}/${rel}: ${local.reason}`);
		if (local.kind === "file" && local.id === want) return { rel, action: "record", seen: local, record: agreed };
		const rec = record?.files.get(rel);
		let changedHere: boolean;
		if (rec !== undefined && rec.hub === file.blob) {
			// The hub has not changed the file since this host last agreed with it. Its render here changed only when
			// it differs from the recorded render (sessions.store, a session store or the code root changed); a local
			// file that is simply not in rendered form (a hand-set sessionDir) is not a change. A record from before
			// renders were recorded counts as unchanged, and learns the render now.
			if (rec.rendered === undefined || rec.rendered === want) {
				// --theirs takes the hub's copy of a file changed only here where it may (see Ctx.theirsEverywhere), and lists it.
				if (ctx.resolve === "theirs" && takeOnlyHere) return { rel, action: "write", file, seen: local, record: agreed, conflict: { profile: name, path: rel, hub: "write", onlyHere: true } };
				return { rel, action: "keep", seen: local, record: rec.rendered === undefined ? { ...rec, rendered: want } : rec };
			}
			changedHere = local.kind !== "file" || local.id !== rec.local;
		} else changedHere = rec === undefined ? local.kind === "file" : local.kind === "absent" || local.id !== rec.local;
		if (!changedHere) return { rel, action: "write", file, seen: local, record: agreed };
		const conflict: Conflict = { profile: name, path: rel, hub: "write" };
		if (ctx.resolve === "theirs") return { rel, action: "write", file, seen: local, record: agreed, conflict };
		if (ctx.resolve === "keep-local") return { rel, action: "keep", seen: local, record: agreed, conflict };
		ctx.conflicts.push(conflict);
		return undefined;
	};

	// Each hub file is classed under the rules of the profile.json this host holds after the pull, so a
	// file the hub's own rules make config (a wider sync.include, say) is pulled, and a later push keeps it.
	const pjStep = dir !== undefined && rendered.has("profile.json") ? decide("profile.json") : undefined;
	const keepsLocal = dir !== undefined && (pjStep === undefined || pjStep.action === "keep");
	const rules = rulesAfter(dir ?? profileDir(ctx.l, name), manifest?.sync, keepsLocal, localRules, sessionDir);
	const steps: Step[] = [];
	const held: string[] = [];
	for (const [rel] of sorted) {
		const file = (rendered.get(rel) as { file: HubFile }).file;
		const cls = classifyContent(rel, rules, file.bytes);
		if (cls.cls !== "config") {
			// Left out, so the profile is held: the hold is recorded, the mirror's main stays, and a push from here is refused instead of dropping the file from the hub.
			held.push(rel);
			ctx.skipped.push({ profile: name, path: rel, reason: `class ${cls.cls} here${cls.why === undefined ? "" : `: ${UNKNOWN_REASONS[cls.why]}`}; only config is pulled, so ${name} is not pulled in full` });
			continue;
		}
		const step = rel === "profile.json" && dir !== undefined ? pjStep : decide(rel);
		if (step !== undefined) steps.push(step);
	}
	// A file the hub no longer holds leaves this host too, unless it changed here.
	if (dir !== undefined && record !== undefined) {
		for (const [rel, rec] of record.files) {
			if (files.has(rel)) continue;
			// A hub copy without profile.json is broken: an honest push of a profile that has one sends it. Its
			// profile.json and settings.json are never removed here; the profile is refused, or kept with --keep-local
			// (issue 48).
			// (`default` may have no profile.json on any host, so only a dropped one counts.)
			if (!files.has("profile.json") && record.files.has("profile.json") && (rel === "profile.json" || rel === "settings.json")) {
				if (ctx.resolve !== "keep-local")
					throw new Refusal(
						`${name}: the hub's copy has no profile.json, and this host last agreed with the hub on ${rel}; sync pull never removes profile.json or settings.json, so ${name} was not pulled. ` +
							`Keep this host's copies with pi-profile sync pull --keep-local ${name}; the next pi-profile sync push ${name} puts them back in the hub`,
					);
				steps.push({ rel, action: "forget", seen: readLocal(dir, rel) });
				continue;
			}
			// A path that is no longer config here (excluded since, say) is never touched; only its record goes.
			if (classifyContent(rel, rules, Buffer.alloc(0)).cls !== "config" && classifyContent(rel, rules, Buffer.from("#!")).cls !== "config") {
				steps.push({ rel, action: "forget", seen: readLocal(dir, rel) });
				continue;
			}
			const local = readLocal(dir, rel);
			if (local.kind === "other") {
				ctx.skipped.push({ profile: name, path: rel, reason: local.reason });
				continue;
			}
			if (local.kind === "absent") {
				steps.push({ rel, action: "forget", seen: local });
				continue;
			}
			if (local.id === rec.local) {
				steps.push({ rel, action: "remove", seen: local });
				continue;
			}
			const conflict: Conflict = { profile: name, path: rel, hub: "remove" };
			if (ctx.resolve === "theirs") steps.push({ rel, action: "remove", seen: local, conflict });
			else if (ctx.resolve === "keep-local") steps.push({ rel, action: "forget", seen: local, conflict });
			else ctx.conflicts.push(conflict);
		}
	}
	const settingsWrite = steps.some((s) => s.rel === "settings.json" && s.action === "write") ? rendered.get("settings.json")?.json : undefined;
	const settingsRemoved = steps.some((s) => s.rel === "settings.json" && s.action === "remove");
	return { name, hub, create: !exists, authMode: manifest?.auth.mode ?? "shared", steps, held, settingsRemoved, ...(settingsWrite === undefined ? {} : { settingsWrite }) };
}

/** Fetch hub `hub`, gate its tree, and plan every profile it holds that this pull takes. */
function planHub(ctx: Ctx, hub: string, remote: string, env: Env, names: ReadonlySet<string> | undefined, skippedProfiles: Array<{ profile: string; reason: string }>, all: boolean): HubPlan | { hub: string; empty: true } {
	const g = openMirror(ctx.l, hub, remote, env);
	const f = fetch(g);
	if (f.status !== 0 || f.error !== undefined) throw new Error(`cannot fetch hub ${hub}: ${said(f)}`);
	const commit = commitAt(g, ORIGIN_MAIN);
	if (commit === undefined) return { hub, empty: true };
	const problems = gateTree(g.dir, commit, env);
	if (problems.length > 0) throw new Refusal(`refused to pull from hub ${hub}; nothing was written:\n  ${shownProblems(problems)}`);
	const entries = treeEntries(g, commit);
	const hubJsonEntry = entries.get(HUB_JSON);
	const blobs = readBlobs(g, [...entries.values()].filter((e) => e.type === "blob").map((e) => e.sha));
	const hubJson = parseHubJson(hubJsonEntry === undefined ? undefined : blobs.get(hubJsonEntry.sha));
	if (typeof hubJson === "string") throw new Refusal(`refused to pull from hub ${hub}; nothing was written:\n  ${hubJson}`);
	const byProfile = new Map<string, Map<string, { blob: string; mode: string; bytes: Buffer }>>();
	for (const [path, e] of entries as Map<string, Entry>) {
		if (path === HUB_JSON) continue;
		const segs = path.split("/");
		const name = segs[1] as string;
		if (!byProfile.has(name)) byProfile.set(name, new Map());
		(byProfile.get(name) as Map<string, { blob: string; mode: string; bytes: Buffer }>).set(segs.slice(2).join("/"), { blob: e.sha, mode: e.mode, bytes: blobs.get(e.sha) ?? Buffer.alloc(0) });
	}
	const plan: HubPlan = {
		hub,
		g,
		commit,
		profiles: [],
		aliases: [],
		pending: new Set(),
		found: new Set([...byProfile.keys(), ...Object.keys(hubJson.aliases)]),
		...(hubJson.pin === undefined ? {} : { pin: hubJson.pin }),
		named: names === undefined,
		readers: [],
	};
	for (const [name, files] of [...byProfile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		let hubManifest: Manifest | undefined;
		const pj = files.get("profile.json");
		if (pj !== undefined) {
			try {
				const parsed = parseManifest(JSON.parse(pj.bytes.toString("utf8")) as unknown, profileDir(ctx.l, name));
				if (parsed.ok) hubManifest = parsed.value;
			} catch {
				// planProfile reports it.
			}
		}
		const owner = ownerHub(ctx.l, name, hubManifest);
		if (names !== undefined && !names.has(name)) {
			if (owner === hub) plan.readers.push(name);
			plan.pending.add(name);
			continue;
		}
		if (owner !== hub) {
			ctx.warnings.push(`${name}: syncs with hub ${owner}, so its copy in hub ${hub} is not pulled`);
			continue;
		}
		plan.named = true;
		const take = (): ProfilePlan => {
			const marks = [ctx.warnings.length, ctx.skipped.length, ctx.conflicts.length] as const;
			const first = planProfile(ctx, hub, name, files, ctx.theirsEverywhere);
			// --theirs with no name: a profile with a conflict or a hold takes the hub's copy of a file changed only here too, so the
			// hold clears; any other profile keeps it (issue 50). Planned again, its notes counted once.
			if (ctx.resolve !== "theirs" || ctx.theirsEverywhere || (first.held.length === 0 && !first.steps.some((s) => s.conflict !== undefined))) return first;
			ctx.warnings.length = marks[0];
			ctx.skipped.length = marks[1];
			ctx.conflicts.length = marks[2];
			return planProfile(ctx, hub, name, files, true);
		};
		try {
			const exists = lstatOrUndefined(profileDir(ctx.l, name)) !== undefined;
			const planned = exists ? withProfileLock(requireProfile(ctx.l, name), take) : take();
			plan.profiles.push(planned);
			plan.readers.push(name);
			// A hub file left out: main must not move past it, or a push from here would drop it from the hub.
			if (planned.held.length > 0) plan.pending.add(name);
		} catch (error) {
			if (!all || !(error instanceof Refusal)) throw error;
			plan.pending.add(name);
			skippedProfiles.push({ profile: name, reason: error.message });
		}
	}
	for (const [name, target] of Object.entries(hubJson.aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (names !== undefined && !names.has(name)) {
			plan.readers.push(name);
			plan.pending.add(name);
			continue;
		}
		plan.named = true;
		const here = lstatOrUndefined(join(profilesRoot(ctx.l), name));
		const targetHere = lstatOrUndefined(join(profilesRoot(ctx.l), target));
		const targetOk = (targetHere !== undefined && targetHere.isDirectory()) || plan.profiles.some((p) => p.name === target);
		let problem: string | undefined;
		if (here !== undefined && !(here.isSymbolicLink() && readlinkSync(join(profilesRoot(ctx.l), name)) === target)) problem = `${name} is an alias of ${target} in the hub, and something else here; left as it is`;
		else if (!targetOk) problem = `${name} is an alias of ${target}, which is not a profile here`;
		if (problem !== undefined) {
			if (!all) throw new Refusal(problem);
			plan.pending.add(name);
			skippedProfiles.push({ profile: name, reason: problem });
			continue;
		}
		plan.readers.push(name);
		if (here === undefined) plan.aliases.push({ name, hub, target });
	}
	return plan;
}

/** Run the steps of `p`, under its lock. Returns the files acted on. */
function applyProfile(ctx: Ctx, p: ProfilePlan, hooks: PullHooks): FileAction[] {
	if (p.create) createProfile(ctx.l, p.name, { auth: p.authMode });
	const linkPath = requireProfile(ctx.l, p.name);
	return withProfileLock(linkPath, () => {
		const dir = realpathSync(linkPath);
		hooks.beforeWrite?.(p.name);
		clearStaged(dir, p.steps.map((s) => s.rel));
		const before = ctx.state.profiles.get(p.name);
		const files = new Map<string, FileRecord>(p.create ? [] : (before?.files ?? []));
		const done: FileAction[] = [];
		for (const s of p.steps) {
			// A new profile holds what create wrote; anything else must be as it was planned.
			if (!p.create && !sameLocal(readLocal(dir, s.rel), s.seen)) throw new Refusal(`${p.name}/${s.rel} changed while pulling; nothing more was written to ${p.name}, run sync pull again`);
			if (s.action === "write") {
				writeStaged(dir, s.rel, (s.file as HubFile).bytes, (s.file as HubFile).mode === "100755", () => hooks.beforeRename?.(p.name, s.rel));
				done.push({ path: s.rel, action: "write" });
			} else if (s.action === "remove") {
				unlinkSync(join(dir, ...s.rel.split("/")));
				done.push({ path: s.rel, action: "remove" });
			}
			if (s.record !== undefined) files.set(s.rel, s.record);
			else files.delete(s.rel);
		}
		// The hold is recorded, so `sync push` refuses this profile whatever the mirror's main is (`sync init` sets it to the hub head).
		ctx.state.profiles.set(p.name, { hub: p.hub, files, ...(p.held.length === 0 ? {} : { held: p.held }) });
		writeSyncState(ctx.l, ctx.state);
		return done;
	});
}

/**
 * Record in `pins` that hub `hub` holds Pi version pin `hubPin` (absent:
 * none), and return the move when it differs from the pin this host last
 * agreed with that hub. The pin here follows the hub's. When this host's
 * pin, not pushed yet, diverged from it (`pinDiverged`), only `resolve`
 * picks a side: `keep-local` keeps this host's, so the next push sends it;
 * `theirs` takes the hub's. The caller never calls it for a diverged pin
 * without `resolve` (issue 54).
 */
function movedPin(pins: Map<string, HubPin>, hub: string, hubPin: string | undefined, resolve: Resolve | undefined): PinMove | undefined {
	const st = pins.get(hub);
	if (hubPin === st?.agreed) return undefined;
	const diverged = pinDiverged(st, hubPin);
	if (diverged && resolve === undefined) throw new Error(`hub ${hub}: a diverged Pi version pin needs a side`);
	const keep = diverged && resolve === "keep-local";
	const pin = keep ? st?.pin : hubPin;
	pins.set(hub, { ...(pin === undefined ? {} : { pin }), ...(hubPin === undefined ? {} : { agreed: hubPin }) });
	const mine = st?.pin === undefined ? {} : { pin: st.pin };
	return { hub, ...(st?.agreed === undefined ? {} : { from: st.agreed }), ...(hubPin === undefined ? {} : { to: hubPin }), ...(diverged ? (keep ? { kept: mine } : { took: mine }) : {}) };
}

/** The command that sets this host's pin of `hub` to `pin` (absent: clears it), quoted for a shell. */
export function pinCommand(hub: string, pin: string | undefined): string {
	const value = pin === undefined ? "--clear" : /^[0-9A-Za-z.-]+$/.test(pin) ? pin : shellQuote(pin);
	return `pi-profile pin ${value}${hub === DEFAULT_HUB ? "" : ` --hub ${hub}`}`;
}

/** One line for a diverged pin, without indent. */
export function pinConflictLine(c: PinConflict): string {
	const here = c.here === undefined ? "this host's removal of its pin" : `this host's pin ${shownPin(c.here)}`;
	return `hub ${c.hub}: ${here} is not pushed yet, and another host moved the hub's from ${shownPin(c.from)} to ${shownPin(c.to)}`;
}

/**
 * The ways out of diverged pins `cs`. Each one settles them, and none can
 * overwrite a file of this host (issues 54 and 50):
 * `pi-profile pin` with the hub's pin (or `--clear`) settles only the pin;
 * `sync pull --keep-local KEEP` (none: every profile) keeps this host's pin
 * and this host's copy of each file changed on both sides. `sync pull
 * --theirs` settles the pin too, but it also takes the hub's copy of files,
 * so it is never printed for a pin. `unseen`: the --keep-local pull may keep
 * file conflicts this output did not list, so the dry run comes first.
 */
export function pinConflictHint(cs: readonly PinConflict[], keep: readonly string[], unseen: boolean): string {
	const named = keep.length === 0 ? "" : ` ${keep.map(printable).join(" ")}`;
	const take = cs.map((c) => pinCommand(c.hub, c.to)).join(" and ");
	return (
		`Take the hub's pin with ${take}, which settles only the pin; or keep this host's with pi-profile sync pull --keep-local${named}, and the next sync push replaces the hub's pin.` +
		(unseen
			? ` --keep-local also keeps this host's copy of any file changed here and in the hub${keep.length === 0 ? "" : " in those profiles"}, and the next sync push sends it: run it with --dry-run first to see each one.`
			: "")
	);
}

/**
 * The way out of conflicts `cs`, named by profile, so following it touches
 * only the profiles that conflict (issue 50). `--theirs` also
 * takes the hub's copy of the other files changed only here in those
 * profiles, so the dry run comes first.
 */
export function conflictHint(cs: readonly Conflict[]): string {
	const names = [...new Set(cs.map((c) => c.profile))].sort().map(printable).join(" ");
	return (
		`Take the hub's copy with pi-profile sync pull --theirs ${names}, or keep this host's with pi-profile sync pull --keep-local ${names}. ` +
		`--theirs also takes the hub's copy of any other file changed only here in those profiles: run it with --dry-run first to see each file it overwrites.`
	);
}

/**
 * `sync pull [NAME...]`: with no names, every profile each configured hub
 * holds; with names, those only. Returns what was (or, with `dryRun`, would
 * be) written. Refuses, writing nothing, when a file changed both here and in
 * the hub and no side was picked.
 */
export function pullHubs(l: Layout, names: readonly string[], opts: PullOptions = {}): PullReport {
	const env = opts.env ?? process.env;
	const hooks = opts.hooks ?? {};
	const dryRun = opts.dryRun ?? false;
	const config = loadConfig(l, env);
	const hubs = config.hubs ?? {};
	if (Object.keys(hubs).length === 0) throw new Refusal("no config hub: run pi-profile sync init REMOTE first");
	const home = env.HOME ?? homedir();
	if (!isTokenRoot(home)) throw new Refusal("the home directory must be an absolute, normalised path");
	const setup = tokenHost(config, home);
	for (const n of names) if (n !== DEFAULT_PROFILE && !isProfileName(n)) throw new Refusal(`invalid profile name: ${printable(n)}`);
	const all = names.length === 0;
	const wanted = all ? undefined : new Set(names);
	const root = hubsDir(l);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return withProfileLock(root, () => {
		const ctx: Ctx = { l, config, host: setup.host, state: readSyncState(l), resolve: opts.resolve, warnings: [...setup.warnings], skipped: [], conflicts: [], theirsEverywhere: !all };
		const pinState = readPinState(l);
		const pins: PinMove[] = [];
		const skippedProfiles: Array<{ profile: string; reason: string }> = [];
		const results = new Map<string, HubPull>();
		const plans: HubPlan[] = [];
		for (const [hub, h] of Object.entries(hubs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			try {
				const p = planHub(ctx, hub, h.remote, env, wanted, skippedProfiles, all);
				if ("empty" in p) results.set(hub, { hub });
				else plans.push(p);
			} catch (error) {
				// Each hub on its own, as push: a hub that fails is reported and the others still pull.
				if (!(error instanceof Error)) throw error;
				results.set(hub, { hub, failed: { message: error.message, refused: error instanceof Refusal } });
			}
		}
		if (wanted !== undefined && [...results.values()].every((h) => h.failed === undefined)) {
			const absent = [...wanted].filter((n) => !plans.some((p) => p.found.has(n)));
			if (absent.length > 0) throw new Refusal(`not in any hub: ${absent.map(printable).join(", ")}`);
		}
		// A pin changed here and in the hub is refused like a file changed on both sides, unless a flag picks a side (issue 54).
		const pinConflicts: PinConflict[] = [];
		for (const plan of plans) {
			const st = pinState.get(plan.hub);
			if (plan.named && opts.resolve === undefined && pinDiverged(st, plan.pin))
				pinConflicts.push({ hub: plan.hub, ...(st?.pin === undefined ? {} : { here: st.pin }), ...(st?.agreed === undefined ? {} : { from: st.agreed }), ...(plan.pin === undefined ? {} : { to: plan.pin }) });
		}
		// The refusal lists every file conflict of the profiles the pull read, so a --keep-local scoped to them keeps none unseen.
		// With no names, it names the profiles planned in the hubs whose pin diverged; when one of those hubs has none (a hub
		// that holds only its pin), it names none, which reads every hub, as the refused pull did.
		const conflicted = plans.filter((p) => pinConflicts.some((c) => c.hub === p.hub));
		const keep = !all ? names : conflicted.some((p) => p.readers.length === 0) ? [] : [...new Set(conflicted.flatMap((p) => p.readers))].sort();
		const pinHint = pinConflicts.length === 0 ? undefined : pinConflictHint(pinConflicts, keep, false);
		if ((ctx.conflicts.length > 0 || pinHint !== undefined) && !dryRun) {
			const parts: string[] = [];
			if (ctx.conflicts.length > 0) {
				const list = ctx.conflicts.map((c) => `  ${printable(c.profile)}/${printable(c.path)}${c.hub === "remove" ? " (the hub removed it)" : ""}`).join("\n");
				parts.push(`these files changed here since the last pull, and the hub changed them too:\n${list}`);
			}
			if (pinHint !== undefined) parts.push(`the Pi version pin changed here and in the hub:\n${pinConflicts.map((c) => `  ${pinConflictLine(c)}`).join("\n")}`);
			const hints = [...(ctx.conflicts.length > 0 ? [conflictHint(ctx.conflicts)] : []), ...(pinHint === undefined ? [] : [pinHint])];
			throw new Refusal(`${parts.join("\n")}\nnothing was written. ${hints.join(" ")}`);
		}
		const profiles: ProfilePull[] = [];
		const applied: ProfilePlan[] = [];
		const resolved: Array<Conflict & { side: Resolve }> = [];
		for (const plan of plans) {
			for (const p of plan.profiles) {
				for (const s of p.steps) if (s.conflict !== undefined && opts.resolve !== undefined) resolved.push({ ...s.conflict, side: opts.resolve });
				const would = p.steps.filter((s) => s.action === "write" || s.action === "remove").map((s) => ({ path: s.rel, action: s.action as "write" | "remove" }));
				if (dryRun) {
					profiles.push({ profile: p.name, hub: plan.hub, created: p.create, files: would });
					applied.push(p);
					continue;
				}
				try {
					profiles.push({ profile: p.name, hub: plan.hub, created: p.create, files: applyProfile(ctx, p, hooks) });
					applied.push(p);
				} catch (error) {
					if (!(error instanceof Refusal)) throw error;
					plan.pending.add(p.name);
					skippedProfiles.push({ profile: p.name, reason: error.message });
				}
			}
			for (const a of plan.aliases) {
				if (!dryRun) {
					try {
						symlinkSync(a.target, join(profilesRoot(l), a.name));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						plan.pending.add(a.name);
						skippedProfiles.push({ profile: a.name, reason: `${a.name} appeared here while pulling; left as it is` });
						continue;
					}
					ctx.state.profiles.delete(a.name);
				}
				profiles.push({ profile: a.name, hub: plan.hub, created: true, alias: a.target, files: [] });
			}
			const pending = [...plan.pending].sort();
			if (!dryRun && pending.length === 0) {
				// Every profile the hub holds is pulled: the next push builds on this commit and fast-forwards.
				git(plan.g, ["update-ref", MAIN, plan.commit]);
				ctx.state.hubs.set(plan.hub, { commit: plan.commit, at: new Date().toISOString() });
			}
			if (!dryRun) writeSyncState(l, ctx.state);
			if (pinDiverged(pinState.get(plan.hub), plan.pin) && (!plan.named || opts.resolve === undefined)) {
				// Named: only a dry run gets here, and it lists the conflict. Not named: the pull leaves the pin as it is, and says so.
				if (!plan.named) {
					const st = pinState.get(plan.hub);
					const c: PinConflict = { hub: plan.hub, ...(st?.pin === undefined ? {} : { here: st.pin }), ...(st?.agreed === undefined ? {} : { from: st.agreed }), ...(plan.pin === undefined ? {} : { to: plan.pin }) };
					ctx.warnings.push(`${pinConflictLine(c)}; this pull names no profile of hub ${plan.hub}, so its pin is left as it is. ${pinConflictHint([c], plan.readers, true)}`);
				}
			} else {
				const pin = movedPin(pinState, plan.hub, plan.pin, opts.resolve);
				if (pin !== undefined) {
					pins.push(pin);
					if (!dryRun) writePinState(l, pinState);
				}
			}
			results.set(plan.hub, { hub: plan.hub, commit: plan.commit, ...(pending.length === 0 ? {} : { pending }) });
		}
		// Packages come from settings.json as this host holds it after the pull: a file kept here (an edit, or --keep-local) is what counts, never the hub's copy.
		const packages: PackageNote[] = [];
		for (const p of applied) {
			// A dry run reports what the real run would: the settings.json it writes, none when it removes it, else the file here.
			const settings = dryRun ? (p.settingsWrite ?? (p.settingsRemoved ? undefined : settingsHere(ctx, p.name))) : settingsHere(ctx, p.name);
			if (settings === undefined) continue;
			const dir = p.name === DEFAULT_PROFILE ? profileDir(l, p.name) : join(profilesRoot(l), p.name);
			packages.push(
				...checkPackages(p.name, dir, packageSources(settings), {
					install: (opts.installPackages ?? false) && !dryRun,
					runner: opts.runner ?? processPackageRunner,
					env,
					...(opts.beforeInstall === undefined ? {} : { beforeInstall: opts.beforeInstall }),
				}),
			);
		}
		const hubOrder = [...results.values()].sort((a, b) => (a.hub < b.hub ? -1 : a.hub > b.hub ? 1 : 0));
		const held = applied.filter((p) => p.held.length > 0).map((p) => ({ profile: p.name, paths: p.held, wayOut: holdWayOut(p.name) }));
		return {
			dryRun,
			hubs: hubOrder,
			profiles,
			conflicts: dryRun ? ctx.conflicts : [],
			resolved,
			skipped: ctx.skipped,
			skippedProfiles,
			held,
			packages,
			pins,
			pinConflicts,
			...(pinHint === undefined ? {} : { pinHint }),
			warnings: ctx.warnings,
		};
	});
}
