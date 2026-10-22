import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { isatty } from "node:tty";
import { isColor } from "../core/color.ts";
import { doctor, type Finding } from "../core/doctor.ts";
import { isEnvKey } from "../core/env.ts";
import { applyPlan, currentProfile, profileEnv } from "../core/launch.ts";
import { isAuthMode, isGroupName, type AuthMode, type Manifest } from "../core/manifest.ts";
import { addStore, removeStore, useProfileSessions, useStore } from "../core/sessions.ts";
import { DEFAULT_HUB, loadConfig } from "../core/config.ts";
import { migrateSessions, resolveEndpoint, type MigrateResult, type OutcomeKind } from "../core/migrate.ts";
import type { ArchiveKind, ArchiveResult } from "../core/archive.ts";
import { archiveFolders, archiveRun, homeOf, installSchedule, resolveRestoreTarget, restoreOne, sessionFolders } from "../core/archivecli.ts";
import { DEFAULT_PROFILE } from "../core/names.ts";
import { pullSessions } from "../core/pull.ts";
import { exportAuth, parsePayload, payloadText, processSshRunner, pullAuth, pushAuth, readStdinPayload, receiveAuth, type Outcome, type SshRunner } from "../core/authsync.ts";
import { authSyncStatus, syncPooled } from "../core/authpool.ts";
import { advertise, discover, loadAdvertised, localHost, printable, processDiscoverRunner, type DiscoverRunner } from "../core/repo.ts";
import { addReplica, describeReplica, loadReplicaState, removeReplica, runBackup, type BackupResult, type ToolRunner } from "../core/backup.ts";
import { runAutoBackup } from "../core/autobackup.ts";
import { LockBusy } from "../core/lock.ts";
import { layoutFromEnv, type Env, type Layout } from "../core/paths.ts";
import {
	adoptProfile,
	createProfile,
	deleteProfile,
	getGlobalDefault,
	listProfiles,
	loadProfile,
	updateManifest,
	setGlobalDefault,
	type CreateOptions,
} from "../core/profiles.ts";
import { Refusal } from "../core/result.ts";
import { allowEntries, PATH_CLASSES, profileSyncRules, syncStatus, type PathClass } from "../core/syncmanifest.ts";
import { initHub, pushHubs } from "../core/hub.ts";
import { conflictHint, pinConflictLine, pullHubs, type PullReport } from "../core/hubpull.ts";
import { ENROL_SSH_TIMEOUT_MS, enrolHere, enrolPeer, peerShell, type EnrolResult } from "../core/enrol.ts";
import type { PackageRunner } from "../core/packages.ts";
import { installPlan, piVersionCache, processCommandRunner, runWarning, commandLine, matches, type CommandRunner } from "../core/pin.ts";
import { pinPending, readPinState, shownPin, writePinState } from "../core/pinstate.ts";
import { findPi, isPin } from "../core/piversion.ts";
import { hubsDir } from "../core/hub.ts";
import { withProfileLock } from "../core/lock.ts";
import { mkdirSync } from "node:fs";
import { envCode, isShell, shellInit, SHELLS, type Shell } from "./shell.ts";

export interface Io {
	readonly env: Env;
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
	/** Run Pi with this environment; returns its exit code. */
	readonly runPi: (args: readonly string[], env: Record<string, string>) => number;
	/** Tailscale and SSH for `repo discover`; the real processes when absent. */
	readonly discover?: DiscoverRunner;
	/** rsync, ssh, age, aws and rclone for `backup run` and `sessions pull`; the real processes when absent. */
	readonly tools?: ToolRunner;
	/** ssh for `auth push`, `auth pull` and `auth sync`; the real ssh when absent. */
	readonly ssh?: SshRunner;
	/** The payload `auth receive` reads; this process's stdin when absent. */
	readonly readStdin?: () => string;
	/** `pi install` for `sync pull --install-packages`; the real pi when absent. */
	readonly packages?: PackageRunner;
	/** The install `pin --install` runs (npm); the real process when absent. */
	readonly installPi?: CommandRunner;
	/** Whether stdout is a terminal; `auth export` refuses one. False when absent. */
	readonly stdoutIsTty?: () => boolean;
}

export const HELP = `Usage: pi-profile <command>

  (no command), current        Show the active profile
  status [--json]              Show the active profile, this host and each
                               replica's last backup
  list [--json]                List profiles
  show [NAME]                  Show a profile's settings
  create NAME [--from P] [--auth shared|separate|pooled] [--copy-auth]
              [--color C] [--group G] [--description TEXT]
  edit NAME --set KEY=VALUE... [--copy-auth]
                               Keys: description, color, auth.mode,
                               multiAccount.group, sessions.store, env.NAME
                               (an empty value removes the key)
  delete NAME --yes            Move a profile to ~/.pi/profiles/.trash
  run NAME [-- PI_ARGS...]     Run pi in a profile
  use NAME|default             Switch this shell (needs shell-init)
  default [show|set NAME|clear]
                               The profile new shells start in
  adopt [NAME|--all]           Write profile.json for existing profiles
  doctor [--json]              Check every profile
  pin [VERSION|--clear] [--hub NAME] [--install]
                               Show each hub's Pi version pin, or set it for
                               hub NAME (default: default): 1.1.0, ^1.1.0,
                               ~1.1.0 or >=1.1.0. The next sync push records
                               it in the hub (a hub no profile here follows
                               too); run and doctor warn when the Pi
                               here does not match. --install installs it
                               (npm installs of Pi only), printing the
                               command first
  sync init REMOTE [--hub NAME]
                               Use a bare git repository on a tailnet machine
                               (HOST:PATH, ssh://HOST/PATH or a local path)
                               as config hub NAME (default: default)
  sync push [NAME...]          Commit each profile's config to its hub
                               (sync.hub in profile.json, else default) and
                               push; files that may not sync are listed;
                               refused when the hub moved: sync pull first
  sync pull [NAME...] [--dry-run] [--theirs|--keep-local] [--install-packages]
                               Fetch each hub and write its config into the
                               profiles here (path tokens and sessionDir for
                               this host; missing profiles are created).
                               Refuses when a file, or a hub's Pi version pin,
                               changed here and in the hub since the last
                               pull, unless --theirs (take the hub's copy or
                               pin) or --keep-local (keep this host's);
                               --dry-run only prints the plan.
                               Lists packages missing here;
                               --install-packages installs npm: and git: ones
  sync status [NAME] [--json]  Class each path in a profile as config, state,
                               secret, sessions or unknown, and list the
                               config files sync would skip
  sync status [NAME] --allow-line PATH:LINE
                               Print the sync.allowFindings entry that allows
                               a checked finding (never the line itself)
  sessions store add ID PATH   Define a session store
  sessions store list          List session stores
  sessions store remove ID     Remove an unused session store
  sessions use ID [--profile P | --all]
                               Use a store (or ID profile to isolate)
  sessions migrate FROM TO [--apply]
                               Move session files (store IDs or absolute
                               paths); a dry run unless --apply
  sessions archive [--older-than 30d] [--profile P | --all] [--apply] [--quiet]
                               Compress old sessions into the archive store
                               and leave a stub Pi still lists; a dry run
                               unless --apply
  sessions archive --install-schedule
                               Write a daily systemd user timer (Linux) or
                               launchd agent (macOS); does not start it
  sessions restore ID|PATH     Bring an archived session back from the archive
  sessions pull REPLICA [--host H] [--identity FILE]
                               Copy other hosts' sessions from a replica to
                               ~/.pi/pi-profile/remote (read-only; fork to continue);
                               an encrypted replica needs an age identity file
  repo advertise ID PATH       Offer a directory to peers as a session repository
  repo list                    List repositories this host advertises
  repo discover                List repositories advertised on the tailnet
  backup add ID local PATH     Back up to a directory on this machine
  backup add ID ssh HOST REPO  Back up to a repository a device advertises
  backup add ID s3 s3://BUCKET[/PREFIX] [--tool aws|rclone] [--remote R]
                               Back up to S3 (encrypted: needs --encrypt-to);
                               rclone uses the remote named s3 unless --remote
              [--encrypt-to AGE_RECIPIENT]... | [--no-encrypt]
                               Encryption; s3 encrypts by default, others not
  backup list                  List replicas and their last run
  backup remove ID             Forget a replica (its copies are kept)
  backup run [--replica ID] [--store ID] [--full] [--quiet|--json] [--auto [--wait-first]]
                               Copy this host's sessions to its replicas;
                               --full resends everything to staged replicas;
                               --auto (used by auto-backup) runs again after
                               the interval if a session ended meanwhile;
                               --wait-first waits for the interval first
  auth push HOST [--provider P]... [--profile NAME] [--force] [--allow-command-keys]
                               Send credentials to the same profile on HOST
  auth pull HOST [--provider P]... [--profile NAME] [--force] [--allow-command-keys]
                               Fetch credentials from HOST and merge them here
  auth receive [--profile NAME] [--force] [--allow-command-keys]
                               Merge a JSON payload from stdin (used by push)
  auth export [--provider P]... [--profile NAME]
                               Print credentials as a payload (used by pull);
                               refuses a terminal
  auth sync [--profile NAME] [--quiet]
                               Push changed OAuth logins of a pooled profile
                               to authSync.peers (run after each session)
  auth status [--profile NAME] Show pooled peers that wait for entries and
                               their last error
  enrol HOST [--hub NAME] [--remote REMOTE] [--host-id ID]
             [--session-store PATH] [--auth pull] [--dry-run]
                               Set up another of your hosts over ssh: check
                               Node 24, Pi and pi-profile there (it never
                               installs them), write its machine config, run
                               sync init and sync pull there, and print its
                               shell-init line; --auth pull then fetches each
                               pulled profile's credentials from this host.
                               (enrol --local is the half run on HOST)
  shell-init fish|bash|zsh     Print shell integration to source

Shell setup:
  fish:  pi-profile shell-init fish | source     (in config.fish)
  bash:  eval "$(pi-profile shell-init bash)"    (in ~/.bashrc)
  zsh:   eval "$(pi-profile shell-init zsh)"     (in ~/.zshrc)
`;

function take(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i < 0) return undefined;
	const v = args[i + 1];
	if (v === undefined || v.startsWith("--")) throw new Refusal(`${flag} needs a value`);
	args.splice(i, 2);
	return v;
}

function takeFlag(args: string[], flag: string): boolean {
	const i = args.indexOf(flag);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
}

function noExtra(args: readonly string[], usage: string): void {
	if (args.length > 0) throw new Refusal(`unexpected argument: ${args[0]}\nusage: ${usage}`);
}

function one(args: string[], usage: string): string {
	const v = args.shift();
	if (v === undefined || v.startsWith("--")) throw new Refusal(`usage: ${usage}`);
	return v;
}

function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MIGRATE_LABELS: Record<OutcomeKind, [string, string]> = {
	move: ["would move", "moved"],
	duplicate: ["would remove (identical copy already at destination)", "removed (identical copy already at destination)"],
	conflict: ["conflict, kept", "conflict, kept"],
	skip: ["would skip", "skipped"],
	fail: ["failed, kept", "failed, kept"],
};

function printMigration(io: Io, r: MigrateResult): number {
	io.out(`${r.applied ? "migrated" : "dry run"}: ${r.from} -> ${r.to}\n`);
	for (const kind of ["move", "duplicate", "skip", "conflict", "fail"] as const) {
		const group = r.outcomes.filter((o) => o.kind === kind);
		if (group.length === 0) continue;
		io.out(`  ${MIGRATE_LABELS[kind][r.applied ? 1 : 0]}: ${group.length} files, ${size(group.reduce((n, o) => n + o.bytes, 0))}\n`);
		if (kind === "move" || kind === "duplicate") continue;
		const reasons = new Map<string, number>();
		for (const o of group) reasons.set(o.reason ?? "", (reasons.get(o.reason ?? "") ?? 0) + 1);
		for (const [reason, count] of reasons) io.out(`    ${count} × ${reason}\n`);
		if (kind !== "skip") for (const o of group) io.err(`pi-profile: ${kind}: ${o.rel}: ${o.reason ?? ""}\n`);
	}
	if (r.outcomes.length === 0) io.out("  nothing to migrate\n");
	if (r.freeBytes !== undefined) io.out(`  free at destination: ${size(r.freeBytes)}\n`);
	if (r.tempsRemoved > 0) io.out(`  removed ${r.tempsRemoved} temporary files from an interrupted run\n`);
	if (!r.applied) io.out("repeat with --apply to move the files\n");
	return r.outcomes.some((o) => o.kind === "conflict" || o.kind === "fail") ? 1 : 0;
}

const ARCHIVE_LABELS: Record<ArchiveKind, [string, string]> = {
	archive: ["would archive", "archived, local copy kept for now"],
	stub: ["would replace by a stub", "archived and replaced by a stub"],
	skip: ["would skip", "skipped"],
	fail: ["failed, kept", "failed, kept"],
	recover: ["would tidy after an interrupted run", "tidied after an interrupted run"],
};

function printArchive(io: Io, results: readonly ArchiveResult[], quiet: boolean): number {
	let bad = false;
	for (const r of results) {
		const lines: string[] = [];
		for (const kind of ["archive", "stub", "skip", "fail", "recover"] as const) {
			const group = r.outcomes.filter((o) => o.kind === kind);
			if (group.length === 0) continue;
			const n = group.length;
			lines.push(`  ${ARCHIVE_LABELS[kind][r.applied ? 1 : 0]}: ${String(n)} ${n === 1 ? "session" : "sessions"}, ${size(group.reduce((t, o) => t + o.bytes, 0))}\n`);
			if (kind === "fail") bad = true;
			if (kind === "skip" || kind === "fail") for (const o of group) io.err(`pi-profile: ${kind}: ${printable(o.rel)}: ${o.reason ?? ""}\n`);
			else if (!quiet && !r.applied) for (const o of group) lines.push(`    ${printable(o.rel)}\n`);
		}
		if (quiet && !bad) continue;
		io.out(`${r.applied ? "archived" : "dry run"}: ${r.store} -> ${r.target}\n`);
		if (lines.length === 0) io.out("  nothing to archive\n");
		for (const line of lines) io.out(line);
		io.out(`  ${r.applied ? "freed" : "would free"}: ${size(r.freed)}\n`);
	}
	if (!quiet && results.length === 0) io.out("no session folders to archive\n");
	if (!quiet && results.some((r) => !r.applied)) io.out("repeat with --apply to archive\n");
	return bad ? 1 : 0;
}

function guessShell(env: Env): Shell {
	const s = basename(env["SHELL"] ?? "");
	return isShell(s) ? s : "bash";
}

function describe(l: Layout, name: string): string {
	const info = loadProfile(l, name);
	const m = info.manifest;
	const lines = [
		`name: ${name}`,
		`dir: ${info.dir}`,
		`color: ${info.color}${m.color === undefined ? " (from name)" : ""}`,
		`auth: ${m.auth.mode}`,
	];
	if (m.description !== undefined) lines.push(`description: ${m.description}`);
	if (m.multiAccount !== undefined) lines.push(`multi-account group: ${m.multiAccount.group}`);
	if (m.sessions !== undefined) lines.push(`session store: ${m.sessions.store}`);
	for (const [k, v] of Object.entries(m.env ?? {})) lines.push(`env ${k}=${v}`);
	if (!info.hasManifest && name !== DEFAULT_PROFILE) lines.push("profile.json: missing (values above are detected; run pi-profile adopt)");
	for (const e of info.manifestErrors) lines.push(`profile.json error: ${e}`);
	return `${lines.join("\n")}\n`;
}

/** Apply one `--set KEY=VALUE` to a manifest copy. */
export function setKey(m: Manifest, assignment: string): Manifest {
	const eq = assignment.indexOf("=");
	if (eq <= 0) throw new Refusal(`--set needs KEY=VALUE, got: ${assignment}`);
	const key = assignment.slice(0, eq);
	const value = assignment.slice(eq + 1);
	const next: Manifest = structuredClone(m);
	const clear = value.length === 0;
	if (key === "description") {
		if (clear) delete next.description;
		else next.description = value;
	} else if (key === "color") {
		if (clear) delete next.color;
		else if (!isColor(value)) throw new Refusal(`not a colour: ${value}`);
		else next.color = value;
	} else if (key === "auth.mode") {
		if (!isAuthMode(value)) throw new Refusal("auth.mode must be shared, separate or pooled");
		next.auth = { mode: value };
	} else if (key === "multiAccount.group") {
		if (clear) delete next.multiAccount;
		else if (!isGroupName(value)) throw new Refusal(`not a group name: ${value}`);
		else next.multiAccount = { group: value };
	} else if (key === "sessions.store") {
		if (clear) delete next.sessions;
		else next.sessions = { store: value };
	} else if (key.startsWith("env.")) {
		const name = key.slice(4);
		if (!isEnvKey(name)) throw new Refusal(`${name} is not an allowed profile variable`);
		const env = { ...(next.env ?? {}) };
		if (clear) delete env[name];
		else env[name] = value;
		if (Object.keys(env).length === 0) delete next.env;
		else next.env = env;
	} else throw new Refusal(`unknown key: ${key}`);
	return next;
}

function printFindings(io: Io, findings: readonly Finding[]): number {
	let errors = 0;
	for (const f of findings) {
		if (f.level === "error") errors++;
		io.out(`${f.level.padEnd(5)} ${f.profile !== undefined ? `${f.profile}: ` : ""}${f.message}\n`);
	}
	if (findings.length === 0) io.out("ok    no problems found\n");
	return errors > 0 ? 1 : 0;
}

/** Commands whose `--json` form prints `{"refused":"..."}` on a refusal; `backup run` prints its own. */
const JSON_REFUSALS: ReadonlySet<string> = new Set(["status", "list", "doctor"]);

/** `status`: the active profile, this host, and each replica's last backup. */
function statusCommand(l: Layout, args: string[], io: Io): number {
	const json = takeFlag(args, "--json");
	noExtra(args, "pi-profile status [--json]");
	const c = currentProfile(l, io.env);
	let host: string | undefined;
	try {
		host = localHost(l, io.env);
	} catch {
		// No host ID (no Tailscale, no PI_PROFILE_HOST_ID): status still shows the rest.
		host = undefined;
	}
	const replicas = (loadConfig(l, io.env).replicas ?? []).map((r) => {
		const s = loadReplicaState(l, r.id);
		return {
			id: r.id,
			...(s.lastRunAt === undefined ? {} : { lastRunAt: s.lastRunAt }),
			...(s.lastOkAt === undefined ? {} : { lastOkAt: s.lastOkAt }),
			ok: s.lastError === undefined,
		};
	});
	if (json) {
		io.out(`${JSON.stringify({ profile: c.name, agentDir: c.agentDir, source: c.source, ...(host === undefined ? {} : { host }), replicas })}\n`);
		return 0;
	}
	io.out(`profile: ${c.name}\nagent dir: ${c.agentDir}\nselected by: ${c.source}\nhost: ${host ?? "unknown"}\n`);
	if (replicas.length === 0) io.out("backup: no replicas\n");
	for (const r of replicas) {
		const last = !r.ok ? "last run failed (see pi-profile backup list)" : r.lastOkAt !== undefined ? `last backup ${r.lastOkAt}` : "never run";
		io.out(`backup ${r.id}: ${last}\n`);
	}
	return 0;
}

export function main(argv: readonly string[], io: Io): number {
	const l = layoutFromEnv(io.env);
	const args = [...argv];
	const cmd = args.shift();
	try {
		switch (cmd) {
			case undefined:
			case "current": {
				noExtra(args, "pi-profile current");
				const c = currentProfile(l, io.env);
				io.out(`profile: ${c.name}\nagent dir: ${c.agentDir}\nselected by: ${c.source}\n`);
				const g = getGlobalDefault(l);
				if (g !== undefined) io.out(`global default: ${g}\n`);
				return 0;
			}
			case "help":
			case "-h":
			case "--help":
				io.out(HELP);
				return 0;
			case "status":
				return statusCommand(l, args, io);
			case "list": {
				const json = takeFlag(args, "--json");
				noExtra(args, "pi-profile list [--json]");
				const active = currentProfile(l, io.env).name;
				const g = getGlobalDefault(l);
				if (json) {
					const profiles = listProfiles(l).map((name) => ({ name, active: name === active, globalDefault: name === g }));
					io.out(`${JSON.stringify({ profiles })}\n`);
					return 0;
				}
				for (const name of listProfiles(l)) {
					const marks = [name === active ? "active" : "", name === g ? "global default" : ""].filter((x) => x.length > 0);
					io.out(`${name === active ? "*" : " "} ${name}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}\n`);
				}
				return 0;
			}
			case "show": {
				const name = args.shift() ?? currentProfile(l, io.env).name;
				noExtra(args, "pi-profile show [NAME]");
				io.out(describe(l, name));
				return 0;
			}
			case "create": {
				const name = one(args, "pi-profile create NAME [options]");
				const opts: { -readonly [K in keyof CreateOptions]: CreateOptions[K] } = {};
				const from = take(args, "--from");
				if (from !== undefined) opts.from = from;
				const auth = take(args, "--auth");
				if (auth !== undefined) {
					if (!isAuthMode(auth)) throw new Refusal("--auth must be shared, separate or pooled");
					opts.auth = auth satisfies AuthMode;
				}
				const color = take(args, "--color");
				if (color !== undefined) {
					if (!isColor(color)) throw new Refusal(`not a colour: ${color}`);
					opts.color = color;
				}
				const group = take(args, "--group");
				if (group !== undefined) opts.group = group;
				const description = take(args, "--description");
				if (description !== undefined) opts.description = description;
				opts.copyAuth = takeFlag(args, "--copy-auth");
				noExtra(args, "pi-profile create NAME [options]");
				const info = createProfile(l, name, opts);
				io.out(`created profile: ${name} (${info.dir})\n`);
				return 0;
			}
			case "edit": {
				const name = one(args, "pi-profile edit NAME --set KEY=VALUE...");
				const copyAuth = takeFlag(args, "--copy-auth");
				const sets: string[] = [];
				for (let v = take(args, "--set"); v !== undefined; v = take(args, "--set")) sets.push(v);
				noExtra(args, "pi-profile edit NAME --set KEY=VALUE...");
				if (sets.length === 0) throw new Refusal("usage: pi-profile edit NAME --set KEY=VALUE...");
				// Apply the changes to the manifest as it is under the lock, not to an earlier read.
				updateManifest(l, name, (current) => sets.reduce(setKey, current), { copyAuth });
				io.out(describe(l, name));
				return 0;
			}
			case "delete": {
				const name = one(args, "pi-profile delete NAME --yes");
				const yes = takeFlag(args, "--yes");
				noExtra(args, "pi-profile delete NAME --yes");
				if (!yes) throw new Refusal(`this moves ${name} (with its sessions) to the trash; repeat with --yes`);
				io.out(`moved ${name} to ${deleteProfile(l, name)}\n`);
				return 0;
			}
			case "run": {
				const name = one(args, "pi-profile run NAME [-- PI_ARGS...]");
				if (args[0] === "--") args.shift();
				const env = applyPlan(io.env, profileEnv(l, name));
				// A pin mismatch is a warning and never stops the launch (user decision on issue 34).
				let warning: string | undefined;
				try {
					warning = runWarning(l, name, env);
				} catch (error) {
					warning = `the Pi version pin was not checked: ${printable((error as Error).message)}`;
				}
				if (warning !== undefined) io.err(`pi-profile: warning: ${warning}\n`);
				return io.runPi(args, env);
			}
			case "pin":
				return pinCommand(l, args, io);
			case "env": {
				const shell = take(args, "--shell") ?? guessShell(io.env);
				const scope = take(args, "--scope") ?? "global";
				if (args[0] === "--") args.shift();
				const name = one(args, "pi-profile env [--shell S] -- NAME");
				noExtra(args, "pi-profile env [--shell S] -- NAME");
				if (!isShell(shell)) throw new Refusal("--shell must be fish, bash or zsh");
				if (scope !== "global" && scope !== "function") throw new Refusal("--scope must be global or function");
				io.out(envCode(shell, profileEnv(l, name), scope));
				return 0;
			}
			case "use": {
				const name = one(args, "pi-profile use NAME|default");
				noExtra(args, "pi-profile use NAME|default");
				profileEnv(l, name);
				io.err("pi-profile: 'use' changes the shell, so it needs the shell integration.\n");
				io.err(`Add it with: pi-profile shell-init ${guessShell(io.env)} (see pi-profile help), or run:\n`);
				io.out(`eval "$(pi-profile env -- ${name})"\n`);
				return 2;
			}
			case "startup": {
				const shell = take(args, "--shell") ?? guessShell(io.env);
				noExtra(args, "pi-profile startup [--shell S]");
				if (!isShell(shell)) throw new Refusal("--shell must be fish, bash or zsh");
				if (io.env["PI_PROFILE_NO_GLOBAL_DEFAULT"] !== undefined) return 0;
				const g = getGlobalDefault(l);
				if (g !== undefined) io.out(envCode(shell, profileEnv(l, g)));
				return 0;
			}
			case "default": {
				const sub = args.shift() ?? "show";
				if (sub === "show") {
					noExtra(args, "pi-profile default show");
					io.out(`global default profile: ${getGlobalDefault(l) ?? `${DEFAULT_PROFILE} (Pi's own ~/.pi/agent)`}\n`);
				} else if (sub === "set") {
					const name = one(args, "pi-profile default set NAME");
					noExtra(args, "pi-profile default set NAME");
					setGlobalDefault(l, name);
					io.out(`global default profile: ${name} (applies to new shells)\n`);
				} else if (sub === "clear") {
					noExtra(args, "pi-profile default clear");
					setGlobalDefault(l, undefined);
					io.out(`global default profile: ${DEFAULT_PROFILE}\n`);
				} else throw new Refusal("usage: pi-profile default [show|set NAME|clear]");
				return 0;
			}
			case "adopt": {
				const all = takeFlag(args, "--all");
				const names = all ? listProfiles(l).filter((n) => n !== DEFAULT_PROFILE) : [one(args, "pi-profile adopt NAME|--all")];
				noExtra(args, "pi-profile adopt NAME|--all");
				let failed = 0;
				for (const name of names) {
					try {
						const r = adoptProfile(l, name);
						io.out(`${r.adopted ? "adopted" : "already has profile.json"}: ${name} (auth ${r.manifest.auth.mode})\n`);
					} catch (error) {
						failed++;
						io.err(`pi-profile: ${name}: ${(error as Error).message}\n`);
					}
				}
				return failed > 0 ? 1 : 0;
			}
			case "sessions": {
				const sub = args.shift();
				if (sub === "store") {
					const op = args.shift();
					if (op === "add") {
						const id = one(args, "pi-profile sessions store add ID PATH");
						const path = one(args, "pi-profile sessions store add ID PATH");
						noExtra(args, "pi-profile sessions store add ID PATH");
						addStore(l, id, path, io.env);
						io.out(`added session store: ${id} (${path})\n`);
						return 0;
					}
					if (op === "list") {
						noExtra(args, "pi-profile sessions store list");
						const c = loadConfig(l, io.env);
						for (const [id, store] of Object.entries(c.sessionStores)) io.out(`${id}\t${store.path}\n`);
						return 0;
					}
					if (op === "remove") {
						const id = one(args, "pi-profile sessions store remove ID");
						noExtra(args, "pi-profile sessions store remove ID");
						removeStore(l, id, io.env);
						io.out(`removed session store: ${id}\n`);
						return 0;
					}
				}
				if (sub === "use") {
					const usage = "pi-profile sessions use ID [--profile P | --all]";
					const id = one(args, usage);
					const all = takeFlag(args, "--all");
					const profile = take(args, "--profile");
					if (all && profile !== undefined) throw new Refusal("use either --profile or --all, not both");
					noExtra(args, usage);
					const names = all ? listProfiles(l) : [profile ?? currentProfile(l, io.env).name];
					const failed = id === "profile" ? useProfileSessions(l, names) : useStore(l, id, names, io.env);
					for (const name of names) if (!failed.some((entry) => entry.startsWith(`${name}:`))) io.out(`updated session settings for: ${name}\n`);
					for (const entry of failed) io.err(`pi-profile: ${entry}\n`);
					return failed.length > 0 ? 1 : 0;
				}
				if (sub === "migrate") {
					const usage = "pi-profile sessions migrate FROM TO [--apply]";
					const apply = takeFlag(args, "--apply");
					const from = one(args, usage);
					const to = one(args, usage);
					noExtra(args, usage);
					const result = migrateSessions(resolveEndpoint(l, from, io.env), resolveEndpoint(l, to, io.env), { apply });
					return printMigration(io, result);
				}
				if (sub === "archive") {
					const usage = "pi-profile sessions archive [--older-than 30d] [--profile P | --all] [--apply] [--quiet] | --install-schedule";
					if (takeFlag(args, "--install-schedule")) {
						noExtra(args, usage);
						const r = installSchedule(l, io.env);
						for (const p of r.written) io.out(`wrote ${p}\n`);
						for (const p of r.unchanged) io.out(`unchanged ${p}\n`);
						io.out(`not started; start it with:\n${r.start.map((c) => `  ${c}\n`).join("")}`);
						return 0;
					}
					const apply = takeFlag(args, "--apply");
					const quiet = takeFlag(args, "--quiet");
					const all = takeFlag(args, "--all");
					const profile = take(args, "--profile");
					const olderThan = take(args, "--older-than");
					if (all && profile !== undefined) throw new Refusal("use either --profile or --all, not both");
					noExtra(args, usage);
					const run = archiveRun(l, io.env, io.tools);
					const names = all ? listProfiles(l) : [profile ?? currentProfile(l, io.env).name];
					const results = archiveFolders(l, sessionFolders(l, names, homeOf(io.env)), run, apply, olderThan);
					return printArchive(io, results, quiet);
				}
				if (sub === "restore") {
					const usage = "pi-profile sessions restore ID|PATH [--profile P | --all]";
					const all = takeFlag(args, "--all");
					const profile = take(args, "--profile");
					const target = one(args, usage);
					noExtra(args, usage);
					const names = all || profile === undefined ? listProfiles(l) : [profile];
					const path = resolveRestoreTarget(sessionFolders(l, names, homeOf(io.env)), target);
					const r = restoreOne(l, io.env, path, io.tools);
					if (r.kind === "not-archived") throw new Refusal(`${path} is not an archived session stub`);
					if (r.warning !== undefined) io.err(`pi-profile: warning: ${printable(r.warning)}\n`);
					if (r.kind === "restored") io.out(`restored ${path}\n`);
					else io.out(`kept both: ${path} has lines added after it was archived, so it stays; the full session is at ${r.full ?? "?"}\n`);
					return 0;
				}
				if (sub === "pull") {
					const usage = "pi-profile sessions pull REPLICA [--host H] [--identity FILE]";
					const host = take(args, "--host");
					const identity = take(args, "--identity");
					const replica = one(args, usage);
					noExtra(args, usage);
					const r = pullSessions(l, replica, { env: io.env, ...(host === undefined ? {} : { host }), ...(identity === undefined ? {} : { identity }), ...(io.tools === undefined ? {} : { runner: io.tools }) });
					for (const rel of r.updated) io.out(`${rel}\n`);
					io.out(`${r.replica}: ${String(r.updated.length)} ${r.updated.length === 1 ? "session" : "sessions"} new or changed in ${r.dir}\n`);
					for (const message of r.unreadable) io.err(`pi-profile: ${message}\n`);
					if (r.unreadable.length > 0) io.err(`pi-profile: ${r.replica}: ${String(r.unreadable.length)} session file(s) could not be read; the rest were pulled\n`);
					for (const message of r.skipped) io.err(`pi-profile: warning: ${message}\n`);
					for (const message of r.failed) io.err(`pi-profile: ${message}\n`);
					if (r.failed.length > 0) io.err(`pi-profile: ${r.replica}: ${String(r.failed.length)} failure(s) downloading, decrypting or saving session files; the rest were pulled\n`);
					return r.unreadable.length > 0 || r.failed.length > 0 ? 1 : 0;
				}
				throw new Refusal("usage: pi-profile sessions store add|list|remove, sessions use, sessions migrate, sessions archive, sessions restore or sessions pull");
			}
			case "repo": {
				const sub = args.shift();
				if (sub === "advertise") {
					const usage = "pi-profile repo advertise ID PATH";
					const id = one(args, usage);
					const path = one(args, usage);
					noExtra(args, usage);
					const r = advertise(l, id, path, io.env);
					io.out(`${r.created ? "created and advertised" : "advertised existing"} repository: ${id} (${path}, owner ${r.repository.ownerHost})\n`);
					return 0;
				}
				if (sub === "list") {
					noExtra(args, "pi-profile repo list");
					for (const [id, v] of Object.entries(loadAdvertised(l).repositories)) io.out(`${id}\t${v.path}\n`);
					return 0;
				}
				if (sub === "discover") {
					noExtra(args, "pi-profile repo discover");
					// A peer without SSH (a phone, say) is normal: note it and carry on.
					for (const a of discover(l, io.env, io.discover ?? processDiscoverRunner)) {
						if (!a.ok) io.err(`${a.host}: skipped: ${a.error}\n`);
						else for (const [id, v] of Object.entries(a.repositories)) io.out(`${a.host}\t${id}\t${v.path}\n`);
					}
					return 0;
				}
				throw new Refusal("usage: pi-profile repo advertise ID PATH, repo list or repo discover");
			}
			case "backup":
				return backupCommand(l, args, io);
			case "auth":
				return authCommand(l, args, io);
			case "sync":
				return syncCommand(l, args, io);
			case "enrol":
				return enrolCommand(l, args, io);
			case "doctor": {
				const json = takeFlag(args, "--json");
				noExtra(args, "pi-profile doctor [--json]");
				const findings = doctor(l, io.env);
				if (!json) return printFindings(io, findings);
				io.out(`${JSON.stringify({ findings: findings.map((x) => ({ level: x.level, ...(x.profile === undefined ? {} : { profile: x.profile }), message: x.message })) })}\n`);
				return findings.some((x) => x.level === "error") ? 1 : 0;
			}
			case "shell-init": {
				const shell = args.shift();
				noExtra(args, "pi-profile shell-init fish|bash|zsh");
				if (!isShell(shell)) throw new Refusal("usage: pi-profile shell-init fish|bash|zsh");
				io.out(shellInit(shell));
				return 0;
			}
			default:
				throw new Refusal(`unknown command: ${cmd} (try pi-profile help)`);
		}
	} catch (error) {
		// `--json` callers (the /profile command) read a refusal from stdout.
		if (error instanceof Refusal && argv.includes("--json") && JSON_REFUSALS.has(cmd ?? "")) io.out(`${JSON.stringify({ refused: error.message })}\n`);
		io.err(`pi-profile: ${(error as Error).message}\n`);
		return error instanceof Refusal ? 2 : 1;
	}
}

const CLASS_NOTE: Record<PathClass, string> = {
	config: "rides config sync",
	state: "stays on this host",
	secret: "moves only through pi-profile auth",
	sessions: "rides backups",
	unknown: "stays on this host until classified",
};

function syncCommand(l: Layout, args: string[], io: Io): number {
	const sub = args.shift();
	if (sub === "init") {
		const usage = "pi-profile sync init REMOTE [--hub NAME]";
		const hub = take(args, "--hub");
		const remote = one(args, usage);
		noExtra(args, usage);
		const r = initHub(l, remote, { ...(hub === undefined ? {} : { hub }), env: io.env });
		io.out(`hub ${r.hub}: ${printable(r.remote)}\nmirror: ${r.dir}\n${r.head === undefined ? "the hub is empty; sync push makes its first commit" : `hub at ${r.head.slice(0, 12)}`}\n`);
		return 0;
	}
	if (sub === "push") {
		const usage = "pi-profile sync push [NAME...]";
		const names = [...args];
		args.length = 0;
		if (names.some((n) => n.startsWith("-"))) throw new Refusal(`usage: ${usage}`);
		const r = pushHubs(l, names, { env: io.env });
		for (const w of r.warnings) io.err(`warning: ${printable(w)}\n`);
		for (const s of r.skippedProfiles) io.err(`skipped profile ${printable(s.profile)}: ${printable(s.reason)}\n`);
		if (r.skipped.length > 0) {
			io.out(`not pushed (${String(r.skipped.length)} file${r.skipped.length === 1 ? "" : "s"}; locations only, never values):\n`);
			for (const s of r.skipped) io.out(`  ${printable(s.profile)}/${printable(s.path)}: ${printable(s.reason)}\n`);
		}
		for (const a of r.aliases) io.out(`${printable(a.profile)}: an alias of ${printable(a.target)}\n`);
		for (const h of r.hubs) {
			if (h.failed !== undefined) io.err(`pi-profile: ${h.failed.message}\n`);
			else {
				const what = h.profiles.length === 0 ? "Pi version pin only" : h.profiles.join(", ");
				io.out(h.commit === undefined ? `hub ${h.hub}: up to date (${what})\n` : `hub ${h.hub}: pushed ${h.commit.slice(0, 12)} (${what})\n`);
			}
			if (h.pin !== undefined && h.failed === undefined) {
				// Name the pin it replaced, so a pin kept with --keep-local never replaces another host's unseen (issue 54).
				const replacing = h.pin.from === undefined ? "" : `, replacing the hub's ${shownPin(h.pin.from)}`;
				io.out(h.pin.to === undefined ? `hub ${h.hub}: Pi version pin removed${replacing}\n` : `hub ${h.hub}: Pi version pin ${shownPin(h.pin.to)} recorded${replacing}\n`);
			}
			if (h.warning !== undefined) io.err(`warning: ${printable(h.warning)}\n`);
		}
		const failed = r.hubs.flatMap((h) => (h.failed === undefined ? [] : [h.failed]));
		// A push that landed but was not recorded is not a refusal: exit 1, never 2 (issue 49).
		if (failed.some((f) => !f.refused) || r.hubs.some((h) => h.warning !== undefined)) return 1;
		return failed.length === 0 ? 0 : 2;
	}
	if (sub === "pull") return syncPull(l, args, io);
	const usage = "pi-profile sync init REMOTE [--hub NAME] | sync push [NAME...] | sync pull [NAME...] [--dry-run] [--theirs|--keep-local] [--install-packages] | sync status [NAME] [--json] [--allow-line PATH:LINE]";
	if (sub !== "status") throw new Refusal(`usage: ${usage}`);
	const json = takeFlag(args, "--json");
	const allowLine = take(args, "--allow-line");
	const name = args[0] !== undefined && !args[0].startsWith("--") ? (args.shift() as string) : currentProfile(l, io.env).name;
	noExtra(args, usage);
	if (allowLine !== undefined) {
		const m = /^(.+):([1-9][0-9]{0,8})$/.exec(allowLine);
		if (m === null) throw new Refusal(`--allow-line needs PATH:LINE, such as skills/s/x.ts:12\nusage: ${usage}`);
		const { dir, rules } = profileSyncRules(l, name, true);
		const entries = allowEntries(dir, m[1] as string, Number(m[2]), rules);
		io.out(`${entries.map((e) => JSON.stringify(e)).join(",\n")}\n`);
		if (!json) io.err(`add to "sync": { "allowFindings": [...] } in profile.json of ${name}; any edit to the line flags it again, and each finding on a line needs its own entry\n`);
		return 0;
	}
	const st = syncStatus(l, name);
	if (json) {
		io.out(`${JSON.stringify({ profile: st.profile, dir: st.dir, counts: st.counts, unknown: st.unknown, reasons: st.reasons, links: st.links, credentials: st.credentials, skipped: st.skipped, ignoredAllows: st.ignoredAllows, staleAllows: st.staleAllows }, null, "\t")}\n`);
		return 0;
	}
	io.out(`profile: ${st.profile}\ndir: ${printable(st.dir)}\n\n`);
	for (const cls of PATH_CLASSES) io.out(`${cls.padEnd(9)}${String(st.counts[cls]).padStart(5)}  ${CLASS_NOTE[cls]}\n`);
	if (st.unknown.length > 0) {
		io.out("\nunknown (add to sync.include or sync.exclude in profile.json):\n");
		for (const p of st.unknown) io.out(`  ${printable(p)}${st.reasons[p] === undefined ? "" : `  (${st.reasons[p]})`}\n`);
	}
	if (st.links.length > 0) {
		io.out("\nlinks (never followed; a link is never config):\n");
		for (const k of st.links) io.out(`  ${printable(k.path)} -> ${k.class}\n`);
	}
	if (st.skipped.length > 0) {
		io.out(`\nconfig sync would skip ${String(st.skipped.length)} config file${st.skipped.length === 1 ? "" : "s"} (locations only, never values):\n`);
		for (const k of st.skipped) io.out(`  ${printable(k.path)}: ${printable(k.reason)}\n`);
		if (st.skipped.some((k) => k.findings.some((f) => !f.shape)))
			io.out(`  (for a value you checked is not a secret: pi-profile sync status ${name} --allow-line PATH:LINE)\n`);
	}
	if (st.ignoredAllows.length > 0) {
		io.out("\nignored sync.allowFindings entries:\n");
		for (const g of st.ignoredAllows) io.out(`  ${printable(g.entry.path)}:${String(g.entry.line)} (${printable(g.entry.key)}): ${g.reason}\n`);
	}
	if (st.staleAllows.length > 0) {
		io.out("\nsync.allowFindings entries that match no finding (remove them from profile.json):\n");
		for (const a of st.staleAllows) io.out(`  stale allow entry: ${printable(a.path)}:${String(a.line)} (${printable(a.key)})\n`);
	}
	return 0;
}

function syncPull(l: Layout, args: string[], io: Io): number {
	const usage = "pi-profile sync pull [NAME...] [--dry-run] [--theirs|--keep-local] [--install-packages]";
	const dryRun = takeFlag(args, "--dry-run");
	const theirs = takeFlag(args, "--theirs");
	const keepLocal = takeFlag(args, "--keep-local");
	const installPackages = takeFlag(args, "--install-packages");
	if (theirs && keepLocal) throw new Refusal("use --theirs or --keep-local, not both");
	const names = [...args];
	args.length = 0;
	if (names.some((n) => n.startsWith("-"))) throw new Refusal(`usage: ${usage}`);
	const r = pullHubs(l, names, {
		env: io.env,
		dryRun,
		installPackages,
		...(theirs ? { resolve: "theirs" as const } : keepLocal ? { resolve: "keep-local" as const } : {}),
		...(io.packages === undefined ? {} : { runner: io.packages }),
		// Printed before each install runs, as pin --install does (law L25).
		beforeInstall: (command) => io.out(`running: ${printable(command)}\n`),
	});
	printPull(io, r);
	const failed = r.hubs.flatMap((h) => (h.failed === undefined ? [] : [h.failed]));
	if (failed.some((f) => !f.refused) || r.packages.some((p) => p.outcome === "failed")) return 1;
	return failed.length > 0 ? 2 : 0;
}

function printPull(io: Io, r: PullReport): void {
	const would = r.dryRun ? "would " : "";
	for (const w of r.warnings) io.err(`warning: ${printable(w)}\n`);
	for (const s of r.skippedProfiles) io.err(`skipped profile ${printable(s.profile)}: ${printable(s.reason)}\n`);
	for (const p of r.profiles) {
		if (p.alias !== undefined) io.out(`${printable(p.profile)}: ${would}link as an alias of ${printable(p.alias)}\n`);
		else if (p.created) io.out(`${printable(p.profile)}: ${would}create the profile\n`);
		for (const f of p.files) io.out(`  ${printable(p.profile)}/${printable(f.path)}: ${would}${f.action}\n`);
	}
	for (const c of r.conflicts) io.out(`  ${printable(c.profile)}/${printable(c.path)}: changed here and in the hub; needs pi-profile sync pull --theirs ${printable(c.profile)} or --keep-local ${printable(c.profile)}\n`);
	if (r.conflicts.length > 0) io.out(`  ${conflictHint(r.conflicts)}\n`);
	for (const c of r.resolved) io.out(`  ${printable(c.profile)}/${printable(c.path)}: changed here${c.onlyHere === true ? "" : " and in the hub"}; ${c.side === "theirs" ? "took the hub's copy" : "kept this host's"}\n`);
	if (r.skipped.length > 0) {
		io.out(`not pulled (${String(r.skipped.length)} file${r.skipped.length === 1 ? "" : "s"}):\n`);
		for (const s of r.skipped) io.out(`  ${printable(s.profile)}/${printable(s.path)}: ${printable(s.reason)}\n`);
	}
	const missing = r.packages.filter((p) => p.outcome !== "installed");
	for (const p of r.packages.filter((x) => x.outcome === "installed")) io.out(`package ${printable(p.profile)}: ${printable(p.source)}: installed\n`);
	if (missing.length > 0) {
		io.out("packages missing on this host:\n");
		for (const p of missing) io.out(`  ${printable(p.profile)}: ${printable(p.source)}${p.outcome === "failed" ? `: install failed: ${printable(p.reason ?? "")}` : p.reason === undefined ? "" : ` (${printable(p.reason)})`}\n`);
		if (missing.some((p) => p.outcome === "missing" && p.reason === undefined)) io.out("  (install them with sync pull --install-packages, or pi install SOURCE in the profile)\n");
	}
	for (const h of r.hubs) {
		if (h.failed !== undefined) io.err(`pi-profile: ${h.failed.message}\n`);
		else if (h.commit === undefined) io.out(`hub ${h.hub}: empty\n`);
		else io.out(`hub ${h.hub}: ${r.dryRun ? "would pull" : "pulled"} ${h.commit.slice(0, 12)}${h.pending === undefined ? "" : ` (not pulled in full: ${h.pending.map(printable).join(", ")})`}\n`);
	}
	for (const h of r.held) {
		io.out(`${printable(h.profile)}: not pulled in full; these hub files are not config here: ${h.paths.map(printable).join(", ")}\n`);
		io.out(`  sync push ${printable(h.profile)} is refused until they are: ${printable(h.wayOut)}\n`);
	}
	for (const p of r.pins) {
		const move = `hub ${p.hub}: Pi version pin ${r.dryRun ? "would move" : "moved"} from ${shownPin(p.from)} to ${shownPin(p.to)}`;
		if (p.kept !== undefined) io.out(`${move}; ${r.dryRun ? "would keep" : "kept"} this host's pin ${shownPin(p.kept.pin)}, so the next sync push replaces the hub's\n`);
		else if (p.took !== undefined) io.out(`${move}; ${r.dryRun ? "would take" : "took"} the hub's, instead of this host's ${shownPin(p.took.pin)}\n`);
		else io.out(`${move}\n`);
	}
	for (const c of r.pinConflicts) io.out(`  ${printable(pinConflictLine(c))}\n`);
	if (r.pinHint !== undefined) io.out(`  ${printable(r.pinHint)}\n`);
}

/**
 * `pin [VERSION|--clear] [--hub NAME] [--install]` (issue 34):
 * show each hub's Pi version pin on this host, or set the pin of one hub.
 * The pin is written to local state (`pinstate.ts`) under the `sync/`
 * lock; the next `sync push` to that hub records it in hub.json. Only
 * `--install` installs anything, and it prints the command first.
 */
function pinCommand(l: Layout, args: string[], io: Io): number {
	const usage = "pi-profile pin [VERSION|--clear] [--hub NAME] [--install]";
	const hubFlag = take(args, "--hub");
	const clear = takeFlag(args, "--clear");
	const install = takeFlag(args, "--install");
	const value = args[0] !== undefined && !args[0].startsWith("--") ? (args.shift() as string) : undefined;
	noExtra(args, usage);
	if (value !== undefined && clear) throw new Refusal("give a VERSION or --clear, not both");
	if (value !== undefined && !isPin(value)) throw new Refusal(`not a Pi version pin: use an exact version such as 1.1.0, or ^1.1.0, ~1.1.0 or >=1.1.0 (got ${printable(value)})`);
	const hubs = loadConfig(l, io.env).hubs ?? {};
	const cache = piVersionCache(l);
	if (value === undefined && !clear && !install) {
		const pins = readPinState(l);
		const names = [...new Set([...Object.keys(hubs), ...pins.keys()])].sort();
		if (hubFlag !== undefined && !names.includes(hubFlag)) throw new Refusal(`hub ${printable(hubFlag)} is not configured`);
		if (names.length === 0) {
			io.out("no config hub, so no Pi version pin (pi-profile sync init REMOTE)\n");
			return 0;
		}
		const shown = hubFlag === undefined ? names : [hubFlag];
		const found = shown.some((h) => pins.get(h)?.pin !== undefined) ? findPi(io.env, { cache }) : undefined;
		for (const hub of shown) {
			const p = pins.get(hub);
			const pending = pinPending(p) ? ", not pushed yet" : "";
			const ok = p?.pin === undefined || found === undefined ? undefined : matches(found.version, p.pin);
			const here = ok === undefined ? "" : ok ? "; Pi here matches" : "; Pi here does not match";
			io.out(p?.pin === undefined ? `hub ${hub}: no Pi version pin${pending}\n` : `hub ${hub}: Pi version pin ${shownPin(p.pin)}${pending}${here}\n`);
		}
		return 0;
	}
	const hub = hubFlag ?? "default";
	if (hubs[hub] === undefined) throw new Refusal(`hub ${printable(hub)} is not configured (pi-profile sync init REMOTE${hub === "default" ? "" : ` --hub ${printable(hub)}`})`);
	let pin: string | undefined;
	if (value !== undefined || clear) {
		const root = hubsDir(l);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		pin = withProfileLock(root, () => {
			const pins = readPinState(l);
			const was = pins.get(hub);
			const next = { ...(value === undefined ? {} : { pin: value }), ...(was?.agreed === undefined ? {} : { agreed: was.agreed }) };
			pins.set(hub, next);
			writePinState(l, pins);
			const said = value === undefined ? `Pi version pin removed (was ${shownPin(was?.pin)})` : `Pi version pin ${shownPin(value)} (was ${shownPin(was?.pin)})`;
			io.out(`hub ${hub}: ${said}; ${pinPending(next) ? "sync push records it in the hub" : "the hub already holds it"}\n`);
			return value;
		});
	} else pin = readPinState(l).get(hub)?.pin;
	if (!install) return 0;
	if (pin === undefined) throw new Refusal(`hub ${printable(hub)} has no Pi version pin, so there is nothing to install; set one with pi-profile pin VERSION`);
	const plan = installPlan(io.env, pin, hub, cache);
	if (plan.kind === "matches") {
		io.out(`Pi ${shownPin(plan.found.version)} here already matches the Pi version pin ${shownPin(pin)} of hub ${hub}; nothing to install\n`);
		return 0;
	}
	// Printed before it runs, so the user sees exactly what pi-profile does (user decision on issue 34).
	io.out(`running: ${printable(commandLine(plan.argv))}\n`);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(io.env)) if (v !== undefined) env[k] = v;
	const r = (io.installPi ?? processCommandRunner)(plan.argv, env);
	if (r.status !== 0 || r.error !== undefined) {
		io.err(`pi-profile: the install failed (${r.error === undefined ? `exit ${String(r.status)}` : printable(r.error)}); Pi here is still ${shownPin(plan.found.version)}\n`);
		return 1;
	}
	const after = findPi(io.env, { cache });
	if (after !== undefined && matches(after.version, pin) === true) {
		io.out(`Pi ${shownPin(after.version)} here now matches the Pi version pin ${shownPin(pin)} of hub ${hub}\n`);
		return 0;
	}
	io.err(`pi-profile: the install ran, but Pi on PATH (${shownPin(after?.version)}) still does not match the Pi version pin ${shownPin(pin)} of hub ${hub}; check which pi comes first on PATH\n`);
	return 1;
}

function backupCommand(l: Layout, args: string[], io: Io): number {
	const sub = args.shift();
	if (sub === "add") {
		const usage = "pi-profile backup add ID local PATH | ID ssh HOST REPO | ID s3 URI [--tool aws|rclone] [--remote R] [--encrypt-to R]... [--no-encrypt]";
		const recipients: string[] = [];
		for (let r = take(args, "--encrypt-to"); r !== undefined; r = take(args, "--encrypt-to")) recipients.push(r);
		const noEncrypt = takeFlag(args, "--no-encrypt");
		if (noEncrypt && recipients.length > 0) throw new Refusal("use --encrypt-to or --no-encrypt, not both");
		const tool = take(args, "--tool");
		const remote = take(args, "--remote");
		const id = one(args, usage);
		const kind = one(args, usage);
		const raw: Record<string, unknown> = { id, kind };
		if (kind === "local") raw.path = one(args, usage);
		else if (kind === "ssh") {
			raw.host = one(args, usage);
			raw.repository = one(args, usage);
		} else if (kind === "s3") {
			raw.uri = one(args, usage);
			raw.tool = tool ?? "aws";
			if (remote !== undefined) raw.remote = remote;
		} else throw new Refusal(`usage: ${usage}`);
		if (kind !== "s3" && (tool !== undefined || remote !== undefined)) throw new Refusal("--tool and --remote are for s3 replicas");
		noExtra(args, usage);
		if (recipients.length > 0) raw.encrypt = { recipients };
		else if (noEncrypt) raw.encrypt = false;
		const c = addReplica(l, raw, io.env);
		const added = c.replicas?.find((r) => r.id === id);
		if (added !== undefined) io.out(`added replica ${id}\t${describeReplica(added)}\n`);
		return 0;
	}
	if (sub === "list") {
		noExtra(args, "pi-profile backup list");
		for (const r of loadConfig(l, io.env).replicas ?? []) {
			const s = loadReplicaState(l, r.id);
			const last = s.lastError !== undefined ? `last run failed: ${s.lastError}` : s.lastOkAt !== undefined ? `last backup ${s.lastOkAt}` : "never run";
			io.out(`${r.id}\t${describeReplica(r)}\t${last}\n`);
		}
		return 0;
	}
	if (sub === "remove") {
		const usage = "pi-profile backup remove ID";
		const id = one(args, usage);
		noExtra(args, usage);
		removeReplica(l, id, io.env);
		io.out(`removed replica ${id}; its copies are kept\n`);
		return 0;
	}
	if (sub === "run") {
		const quiet = takeFlag(args, "--quiet");
		const json = takeFlag(args, "--json");
		const full = takeFlag(args, "--full");
		const auto = takeFlag(args, "--auto");
		const waitFirst = takeFlag(args, "--wait-first");
		const replica = take(args, "--replica");
		const store = take(args, "--store");
		noExtra(args, "pi-profile backup run [--replica ID] [--store ID] [--full] [--quiet|--json] [--auto [--wait-first]]");
		if (json && (quiet || auto)) throw new Refusal("--json cannot be used with --quiet or --auto");
		if (json) return backupRunJson(l, io, full, replica, store);
		const once = (): number => backupRunOnce(l, io, quiet, full, replica, store);
		if (waitFirst && !auto) throw new Refusal("--wait-first needs --auto");
		if (!auto) return once();
		let code = 0;
		runAutoBackup(l, io.env, () => {
			try {
				code = once();
				return code === 0 ? "done" : "failed";
			} catch (error) {
				// Another run holds the backup lock: this session end is backed up by a later run.
				if (error instanceof Refusal && error.cause instanceof LockBusy) {
					code = 2;
					return "busy";
				}
				throw error;
			}
		}, { waitFirst });
		return code;
	}
	throw new Refusal("usage: pi-profile backup add, backup list, backup remove or backup run");
}

function backupResults(l: Layout, io: Io, full: boolean, replica: string | undefined, store: string | undefined): BackupResult[] {
	return runBackup(l, {
		env: io.env,
		full,
		...(replica === undefined ? {} : { replica }),
		...(store === undefined ? {} : { store }),
		...(io.tools === undefined ? {} : { runner: io.tools }),
	});
}

/**
 * `backup run --json`, for `/profile backup`: one line on stdout, `{"results":[...]}`
 * (exit 0, or 1 when a replica failed) or `{"refused":"..."}` (exit 2).
 */
function backupRunJson(l: Layout, io: Io, full: boolean, replica: string | undefined, store: string | undefined): number {
	let results: BackupResult[];
	try {
		results = backupResults(l, io, full, replica, store);
	} catch (error) {
		if (error instanceof Refusal) io.out(`${JSON.stringify({ refused: error.message })}\n`);
		throw error;
	}
	io.out(`${JSON.stringify({ results })}\n`);
	return results.every((r) => r.ok) ? 0 : 1;
}

/** One `backup run`: report each replica's result; 1 when any failed. */
function backupRunOnce(l: Layout, io: Io, quiet: boolean, full: boolean, replica: string | undefined, store: string | undefined): number {
	const results = backupResults(l, io, full, replica, store);
	let failed = 0;
	for (const r of results) {
		if (!r.ok) {
			failed++;
			io.err(`${r.id}: failed: ${r.error}\n`);
		} else if (!quiet) {
			const what = r.mode === "rsync" ? `checked ${String(r.files)} files` : `sent ${String(r.files)} changed files, ${size(r.bytes)}`;
			io.out(`${r.id}: ${what}${r.encrypted ? ", encrypted" : ""}\n`);
		}
		if (r.ok && r.held.length > 0) {
			io.err(`${r.id}: warning: ${String(r.held.length)} sessions are smaller than their backup and were not sent: ${r.held.slice(0, 3).map(printable).join(", ")}${r.held.length > 3 ? ", ..." : ""}\n`);
		}
	}
	return failed === 0 ? 0 : 1;
}

function takeAll(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let v = take(args, flag); v !== undefined; v = take(args, flag)) out.push(v);
	return out;
}

function printOutcomes(io: Io, outcomes: readonly Outcome[]): void {
	for (const o of outcomes) io.out(`${o.provider}: ${o.outcome}\n`);
}

/**
 * `auth push|pull|receive|export|sync`. Credentials travel only as stdin and
 * stdout of `ssh`; output names providers and outcomes, never a value.
 */
function authCommand(l: Layout, args: string[], io: Io): number {
	const sub = args.shift();
	const profileOf = (): string => take(args, "--profile") ?? currentProfile(l, io.env).name;
	const ssh = (): SshRunner => io.ssh ?? processSshRunner(io.env);
	if (sub === "receive") {
		const usage = "pi-profile auth receive [--profile NAME] [--force] [--allow-command-keys]";
		const profile = profileOf();
		const force = takeFlag(args, "--force");
		const allowCommandKeys = takeFlag(args, "--allow-command-keys");
		noExtra(args, usage);
		const incoming = parsePayload((io.readStdin ?? readStdinPayload)());
		const r = receiveAuth(l, profile, incoming, { force, allowCommandKeys });
		printOutcomes(io, r.outcomes);
		return 0;
	}
	if (sub === "export") {
		const usage = "pi-profile auth export [--provider P]... [--profile NAME]";
		const profile = profileOf();
		const providers = takeAll(args, "--provider");
		noExtra(args, usage);
		// Raw tokens never go to a terminal; pipe the output (auth pull does).
		if (io.stdoutIsTty?.() === true) throw new Refusal("auth export prints credentials; pipe its output instead of printing it to a terminal");
		const r = exportAuth(l, profile, providers);
		for (const p of r.skipped) io.err(`pi-profile: ${p}: skipped: pi-profile cannot read this entry\n`);
		io.out(payloadText(r.entries));
		return 0;
	}
	if (sub === "push" || sub === "pull") {
		const usage = `pi-profile auth ${sub} HOST [--provider P]... [--profile NAME] [--force] [--allow-command-keys]`;
		const profile = profileOf();
		const providers = takeAll(args, "--provider");
		const force = takeFlag(args, "--force");
		const allowCommandKeys = takeFlag(args, "--allow-command-keys");
		const host = one(args, usage);
		noExtra(args, usage);
		const opts = { profile, providers, force, allowCommandKeys, run: ssh() };
		if (sub === "push") {
			const r = pushAuth(l, host, opts);
			for (const p of r.skipped) io.err(`pi-profile: ${p}: not sent: pi-profile cannot read this entry\n`);
			for (const line of r.lines) io.out(`${host}: ${line}\n`);
		} else {
			const r = pullAuth(l, host, opts);
			for (const w of r.warnings) io.err(`${host}: ${w}\n`);
			printOutcomes(io, r.outcomes);
		}
		return 0;
	}
	if (sub === "sync") {
		const usage = "pi-profile auth sync [--profile NAME] [--quiet]";
		const profile = profileOf();
		const quiet = takeFlag(args, "--quiet");
		noExtra(args, usage);
		const r = syncPooled(l, profile, { env: io.env, run: ssh() });
		if (r.baseline && !quiet) io.out(`${profile}: recorded the current logins; later changes will be pushed\n`);
		let failed = 0;
		for (const p of r.peers) {
			if (p.retryAt !== undefined) {
				failed++;
				io.err(`${p.peer}: not tried: waiting until ${new Date(p.retryAt).toISOString()} after a failure: ${p.error ?? ""}\n`);
			} else if (p.error !== undefined) {
				failed++;
				io.err(`${p.peer}: failed: ${p.error}\n`);
			} else if (!quiet) io.out(`${p.peer}: ${p.sent.length === 0 ? "nothing to send" : `sent ${p.sent.join(", ")}`}\n`);
		}
		return failed === 0 ? 0 : 1;
	}
	if (sub === "status") {
		const usage = "pi-profile auth status [--profile NAME]";
		const profile = profileOf();
		noExtra(args, usage);
		for (const line of authSyncStatus(l, profile, io.env)) io.out(`${line}\n`);
		return 0;
	}
	throw new Refusal("usage: pi-profile auth push, auth pull, auth receive, auth export, auth sync or auth status");
}

/** The line each shell's startup file needs, and the file. */
const SHELL_LINES: Record<Shell, readonly [string, string]> = {
	fish: ["pi-profile shell-init fish | source", "~/.config/fish/config.fish"],
	bash: ['eval "$(pi-profile shell-init bash)"', "~/.bashrc"],
	zsh: ['eval "$(pi-profile shell-init zsh)"', "~/.zshrc"],
};

/**
 * `enrol HOST` (issue 33), and `enrol --local`, the half it runs on
 * HOST, which prints one JSON report. Nothing is installed on HOST, and no
 * credential is copied except by `auth pull` with `--auth pull`.
 */
function enrolCommand(l: Layout, args: string[], io: Io): number {
	const local = takeFlag(args, "--local");
	const hub = take(args, "--hub");
	const remote = take(args, "--remote");
	const hostId = take(args, "--host-id");
	const sessionStore = take(args, "--session-store");
	const dryRun = takeFlag(args, "--dry-run");
	const opt = { ...(hostId === undefined ? {} : { hostId }), ...(sessionStore === undefined ? {} : { sessionStore }), dryRun };
	if (local) {
		const usage = "pi-profile enrol --local --remote REMOTE [--hub NAME] [--host-id ID] [--session-store PATH] [--dry-run]";
		noExtra(args, usage);
		if (remote === undefined) throw new Refusal(`usage: ${usage}`);
		const r = enrolHere(l, { hub: hub ?? DEFAULT_HUB, remote, ...opt, env: io.env });
		io.out(`${JSON.stringify(r.report)}\n`);
		return r.exit;
	}
	const usage = "pi-profile enrol HOST [--hub NAME] [--remote REMOTE] [--host-id ID] [--session-store PATH] [--auth pull] [--dry-run]";
	const auth = take(args, "--auth");
	if (auth !== undefined && auth !== "pull") throw new Refusal(`--auth takes only pull: the peer fetches credentials from this host\nusage: ${usage}`);
	const host = one(args, usage);
	noExtra(args, usage);
	const r = enrolPeer(l, host, {
		...(hub === undefined ? {} : { hub }),
		...(remote === undefined ? {} : { remote }),
		...opt,
		authPull: auth === "pull",
		env: io.env,
		run: io.ssh ?? processSshRunner(io.env, ENROL_SSH_TIMEOUT_MS),
	});
	return printEnrol(io, r, auth === "pull");
}

function printEnrol(io: Io, r: EnrolResult, authPull: boolean): number {
	const { host, probe } = r;
	io.out(`${host}: prerequisites: ok: Node ${probe.node ?? ""}, Pi at ${probe.pi ?? ""}, pi-profile at ${probe.piProfile ?? ""}\n`);
	for (const s of r.report.steps) {
		const [first, ...rest] = s.message.split("\n").map(printable);
		io.out(`${host}: ${s.step}: ${s.status}: ${first ?? ""}\n`);
		for (const line of rest) io.out(`  ${line}\n`);
		if (s.status === "failed" && s.step === "pull")
			io.out(`  run on ${host}: pi-profile sync pull --dry-run, then settle what it lists as it says; enrol never picks a side. Then run enrol again\n`);
	}
	if (r.exit !== 0) return r.exit;
	const self = r.self ?? "THISHOST";
	let failed = false;
	if (authPull && r.report.dryRun) {
		if (r.report.profiles.length === 0) io.out(`would run on ${host}: pi-profile auth pull ${self} --profile NAME, for each profile the pull brings\n`);
		for (const p of r.report.profiles) io.out(`would run on ${host}: pi-profile auth pull ${self} --profile ${p}\n`);
	}
	for (const a of r.auth ?? []) {
		if (a.error !== undefined) {
			failed = true;
			io.out(`${host}: auth pull ${a.profile}: failed: ${a.error}\n`);
			io.out(`  run on ${host}: pi-profile auth pull ${self} --profile ${a.profile}\n  or from here: pi-profile auth push ${host} --profile ${a.profile}\n`);
		} else if (a.lines.length === 0) io.out(`${host}: auth pull ${a.profile}: nothing to pull\n`);
		else for (const line of a.lines) io.out(`${host}: auth pull ${a.profile}: ${line}\n`);
	}
	// The peer's login shell (sshd sets SHELL), not this host's: they can differ.
	const shell = peerShell(probe);
	if (shell !== undefined && isShell(shell)) {
		const [line, file] = SHELL_LINES[shell];
		io.out(`on ${host}, add this line to ${file}:\n  ${line}\n`);
	} else {
		io.out(`on ${host}, add the line for its shell (${shell === undefined ? "its login shell is unknown" : `its login shell is ${shell}`}):\n`);
		for (const s of SHELLS) io.out(`  ${s}: ${SHELL_LINES[s][0]}    (in ${SHELL_LINES[s][1]})\n`);
	}
	return failed ? 1 : 0;
}

/** The real process: Pi is found on PATH. */
export function processIo(): Io {
	return {
		env: process.env,
		out: (t) => process.stdout.write(t),
		err: (t) => process.stderr.write(t),
		stdoutIsTty: () => isatty(1),
		runPi: (args, env) => {
			const r = spawnSync("pi", [...args], { stdio: "inherit", env });
			if (r.error !== undefined) {
				process.stderr.write(`pi-profile: cannot run pi: ${r.error.message}\n`);
				return 127;
			}
			return r.status ?? 1;
		},
	};
}
