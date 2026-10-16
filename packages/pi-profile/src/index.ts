import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authPoolOnSessionEnd, authPoolOnSessionStart } from "./core/authpool.ts";
import { autoBackupOnSessionEnd, currentRuntime, nodeExecPath, startBackupRun, startCliRun, type AttachedSpawn, type BackupRunOutcome, type CliRun, type Runtime } from "./core/autobackup.ts";
import type { BackupResult } from "./core/backup.ts";
import { ansiFg } from "./core/color.ts";
import { loadConfig } from "./core/config.ts";
import { currentProfile } from "./core/launch.ts";
import { layoutFromEnv, type Env } from "./core/paths.ts";
import { loadProfile } from "./core/profiles.ts";
import { localHost, printable } from "./core/repo.ts";
import { TAG_TYPE, tagFor, tagToAppend } from "./core/tag.ts";

export const STATUS_KEY = "caair.pi-profile/badge";

export interface Badge {
	readonly name: string;
	readonly text: string;
	/** This host, shown when it is not the owner of the repository it backs up to. */
	readonly host?: string;
}

/**
 * This host's ID when the badge should show it: it backs up over SSH to
 * repositories, and owns none of them. The owner of an SSH replica's
 * repository is the host that advertises it, which the replica names.
 */
function foreignHost(env: Env): string | undefined {
	try {
		const l = layoutFromEnv(env);
		const owners = new Set((loadConfig(l, env).replicas ?? []).flatMap((r) => (r.kind === "ssh" ? [r.host] : [])));
		if (owners.size === 0) return undefined;
		const host = localHost(l, env);
		return owners.has(host) ? undefined : host;
	} catch {
		// A broken config.json must not hide the badge; `pi-profile doctor` reports it.
		return undefined;
	}
}

/** The badge for the profile this process runs in; undefined for the plain default. */
export function badgeFor(env: Env): Badge | undefined {
	const l = layoutFromEnv(env);
	const c = currentProfile(l, env);
	if (c.source === "builtin-default") return undefined;
	let color = "cyan";
	try {
		color = loadProfile(l, c.name).color;
	} catch {
		// A custom PI_CODING_AGENT_DIR is not one of our profiles: keep the fallback colour.
	}
	const host = foreignHost(env);
	const label = host === undefined ? `● ${c.name}` : `● ${c.name} · ${host}`;
	return { name: c.name, text: ansiFg(color, label), ...(host === undefined ? {} : { host }) };
}

/** `π <profile> · <cwd basename>`; undefined for the plain default, whose title Pi keeps. */
export function titleFor(env: Env, cwd: string): string | undefined {
	const l = layoutFromEnv(env);
	const c = currentProfile(l, env);
	if (c.source === "builtin-default") return undefined;
	// A directory name can hold BEL or ESC, which would end the OSC title sequence early.
	return printable(`π ${c.name} · ${basename(cwd)}`);
}

function show(ctx: ExtensionContext, env: Env): void {
	if (!ctx.hasUI) return;
	const badge = badgeFor(env);
	ctx.ui.setStatus(STATUS_KEY, badge?.text);
}

function retitle(ctx: ExtensionContext, env: Env): void {
	try {
		if (!ctx.hasUI) return;
		const title = titleFor(env, ctx.cwd);
		if (title !== undefined) ctx.ui.setTitle(title);
	} catch {
		// A context replaced by a newer session throws; that session sets its own title.
	}
}

/** Record which profile and host produced this session, once (design: Session tagging). */
function tag(pi: ExtensionAPI, ctx: ExtensionContext, env: Env): void {
	try {
		const next = tagToAppend(ctx.sessionManager.getBranch(), tagFor(env));
		if (next !== undefined) pi.appendEntry(TAG_TYPE, next);
	} catch {
		// A broken config.json must not stop the session; `pi-profile doctor` reports it.
	}
}

function describeResult(r: BackupResult): string {
	const id = printable(r.id);
	// A tool's message can quote anything it read; `pi-profile backup list` shows it.
	if (!r.ok) return `${id}: failed; see pi-profile backup list`;
	const what = r.mode === "rsync" ? `checked ${String(r.files)} files` : `sent ${String(r.files)} changed files`;
	const held = r.held.length > 0 ? `, ${String(r.held.length)} sessions not sent because they are smaller than their backup` : "";
	return `${id}: ${what}${r.encrypted ? ", encrypted" : ""}${held}`;
}

/**
 * Interactive Pi's own title can land after any number of macrotasks (see
 * session_start), so the title is set again at each of these delays.
 */
const RETITLE_AFTER_MS: readonly number[] = [0, 250, 1000];

/** One notice for how a `/profile backup` run ended. */
function report(ctx: ExtensionContext, outcome: BackupRunOutcome): void {
	let text: string;
	let level: "info" | "warning" | "error";
	if (outcome.kind === "results") {
		const results = outcome.results;
		level = results.some((r) => !r.ok) ? "error" : results.some((r) => r.ok && r.held.length > 0) ? "warning" : "info";
		text = results.map(describeResult).join("; ");
	} else {
		level = "error";
		// Refusals are pi-profile's own words; anything else may quote a file or a tool.
		text = outcome.kind === "refused" ? printable(outcome.message) : "failed; run pi-profile backup run for details";
	}
	try {
		ctx.ui.notify(`backup: ${text}`, level);
	} catch {
		// The session ended while the backup ran; `pi-profile backup list` shows the result.
	}
}

type Level = "info" | "warning" | "error";
type Note = readonly [text: string, level: Level];

export const USAGE = "usage: /profile [status|list|doctor|backup|switch NAME]";

const isNote = (v: unknown): v is Note => Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The last stdout line of a `--json` run as an object, or the note for a
 * refusal or a failure. Refusals are pi-profile's own words; anything else may
 * quote a file or a tool, so it is not shown.
 */
function jsonDoc(cmd: string, run: CliRun | undefined): Record<string, unknown> | Note {
	const failed: Note = [`${cmd}: failed; run pi-profile ${cmd} for details`, "error"];
	if (run === undefined) return failed;
	let doc: unknown;
	try {
		doc = JSON.parse(run.stdout.trim().split("\n").pop() ?? "");
	} catch {
		return failed;
	}
	if (!isRecord(doc)) return failed;
	if (run.code === 2 && typeof doc.refused === "string") return [`${cmd}: ${printable(doc.refused)}`, "error"];
	return run.code === 0 || run.code === 1 ? doc : failed;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One line for `status --json`: profile, host and each replica's last backup. */
export function describeStatus(run: CliRun | undefined): Note {
	const doc = jsonDoc("status", run);
	if (isNote(doc)) return doc;
	const d = doc;
	const profile = str(d.profile);
	if (profile === undefined || !Array.isArray(d.replicas)) return ["status: failed; run pi-profile status for details", "error"];
	const parts = [`profile ${printable(profile)} (selected by ${printable(str(d.source) ?? "?")})`, `host ${printable(str(d.host) ?? "unknown")}`];
	let level: Level = "info";
	const replicas = d.replicas.filter(isRecord);
	if (replicas.length === 0) parts.push("backup: no replicas");
	for (const r of replicas) {
		const id = printable(str(r.id) ?? "?");
		const lastOk = str(r.lastOkAt);
		if (r.ok !== true) level = "warning";
		parts.push(`backup ${id}: ${r.ok !== true ? "last run failed; see pi-profile backup list" : lastOk !== undefined ? `last backup ${printable(lastOk)}` : "never run"}`);
	}
	return [`status: ${parts.join("; ")}`, level];
}

/** The profiles a `list --json` run printed, or the note for why there are none. */
function profilesOf(run: CliRun | undefined): Array<{ name: string; active: boolean }> | Note {
	const doc = jsonDoc("list", run);
	if (isNote(doc)) return doc;
	const raw = doc.profiles;
	if (!Array.isArray(raw)) return ["list: failed; run pi-profile list for details", "error"];
	return raw.filter(isRecord).flatMap((p) => (typeof p.name === "string" ? [{ name: p.name, active: p.active === true }] : []));
}


/** One line for `list --json`, the active profile marked with `*`. */
export function describeList(run: CliRun | undefined): Note {
	const p = profilesOf(run);
	if (isNote(p)) return p;
	return [`profiles: ${p.map((x) => `${x.active ? "*" : ""}${printable(x.name)}`).join(", ")}`, "info"];
}

/** `doctor --json` findings, one per line; the level is the worst finding's. */
export function describeDoctor(run: CliRun | undefined): Note {
	const doc = jsonDoc("doctor", run);
	if (isNote(doc)) return doc;
	const raw = doc.findings;
	if (!Array.isArray(raw)) return ["doctor: failed; run pi-profile doctor for details", "error"];
	const findings = raw.filter(isRecord);
	if (findings.length === 0) return ["doctor: no problems found", "info"];
	const level: Level = findings.some((x) => x.level === "error") ? "error" : findings.some((x) => x.level === "warn") ? "warning" : "info";
	const lines = findings.map((x) => `${printable(str(x.level) ?? "?")} ${str(x.profile) !== undefined ? `${printable(str(x.profile) ?? "")}: ` : ""}${printable(str(x.message) ?? "")}`);
	return [`doctor:\n${lines.join("\n")}`, level];
}

/**
 * What `/profile switch NAME` says, given a `list --json` run. A running Pi
 * cannot change its agent directory, so it names the command that starts Pi
 * in that profile.
 */
export function describeSwitch(name: string, run: CliRun | undefined): Note {
	const p = profilesOf(run);
	if (isNote(p)) return [p[0].replace(/^list:/, "switch:"), p[1]];
	const found = p.find((x) => x.name === name);
	if (found === undefined) return [`switch: no profile named ${printable(name)}; /profile list shows them`, "error"];
	if (found.active) return [`switch: Pi already runs in profile ${found.name}`, "info"];
	return [`switch: Pi cannot change profile while it runs. Quit, then start it with: pi-profile run ${found.name} (or pi --profile ${found.name} with the shell integration)`, "info"];
}

function notify(ctx: ExtensionContext, note: Note): void {
	try {
		ctx.ui.notify(note[0], note[1]);
	} catch {
		// The session ended while the command ran.
	}
}

/** Test seams: the environment, the process spawner and the runtime. Pi passes none. */
export interface Deps {
	readonly env?: Env;
	readonly spawn?: AttachedSpawn;
	readonly runtime?: Runtime;
}

export default function piProfile(pi: ExtensionAPI, deps: Deps = {}): void {
	const env = (): Env => deps.env ?? process.env;
	let session = 0;
	let backupRunning = false;
	pi.on("session_start", (_event, ctx) => {
		show(ctx, env());
		// Interactive Pi writes its own title once session_start and every
		// resources_discover handler have finished (rebindCurrentSession ends in
		// updateTerminalTitle), and no extension event follows that. Set ours now
		// and again a few times over the next second; a newer session stops them.
		const current = ++session;
		retitle(ctx, env());
		for (const ms of RETITLE_AFTER_MS) {
			setTimeout(() => {
				if (current === session) retitle(ctx, env());
			}, ms).unref();
		}
		tag(pi, ctx, env());
		// Pooled auth: note the logins as the session starts, so the end can tell what changed. Never throws.
		authPoolOnSessionStart(env());
	});
	// A session rename makes Pi rewrite the title before extensions hear of it.
	pi.on("session_info_changed", (_event, ctx) => {
		retitle(ctx, env());
	});
	pi.on("session_shutdown", (event) => {
		// A reload keeps the session; every other reason ends it. Never throws.
		if (event.reason !== "reload") {
			autoBackupOnSessionEnd(env());
			authPoolOnSessionEnd(env());
		}
	});
	/** Run `pi-profile ARGS` off the UI thread and show `describe` of its result. */
	const query = (ctx: ExtensionContext, cmd: string, args: readonly string[], describe: (run: CliRun | undefined) => Note): void => {
		const node = nodeExecPath(deps.runtime ?? currentRuntime());
		if (node === undefined) {
			ctx.ui.notify(`${cmd}: this Pi does not run on Node; run pi-profile ${cmd} in a shell`, "error");
			return;
		}
		const e = env();
		const done = (run: CliRun | undefined): void => notify(ctx, describe(run));
		try {
			startCliRun(layoutFromEnv(e), e, node, args, done, deps.spawn);
		} catch {
			done(undefined);
		}
	};
	pi.registerCommand("profile", {
		description: "Show the active pi-profile; /profile status, list, doctor, backup or switch NAME",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter((w) => w.length > 0);
			const [sub, ...rest] = words;
			if (sub === "status" && rest.length === 0) return query(ctx, "status", ["status", "--json"], describeStatus);
			if (sub === "list" && rest.length === 0) return query(ctx, "list", ["list", "--json"], describeList);
			if (sub === "doctor" && rest.length === 0) return query(ctx, "doctor", ["doctor", "--json"], describeDoctor);
			if (sub === "switch" && rest.length === 1 && rest[0] !== undefined) {
				const name = rest[0];
				return query(ctx, "switch", ["list", "--json"], (run) => describeSwitch(name, run));
			}
			if (sub !== undefined && !(sub === "backup" && rest.length === 0)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (sub === "backup") {
				if (backupRunning) {
					ctx.ui.notify("backup: one is already running; wait for its result", "warning");
					return;
				}
				const node = nodeExecPath(deps.runtime ?? currentRuntime());
				if (node === undefined) {
					ctx.ui.notify("backup: this Pi does not run on Node; run pi-profile backup run in a shell", "error");
					return;
				}
				backupRunning = true;
				ctx.ui.notify("backup: started", "info");
				const e = env();
				const done = (outcome: BackupRunOutcome): void => {
					backupRunning = false;
					report(ctx, outcome);
				};
				try {
					startBackupRun(layoutFromEnv(e), e, node, done, deps.spawn);
				} catch {
					done({ kind: "failed" });
				}
				return;
			}
			const l = layoutFromEnv(env());
			const c = currentProfile(l, env());
			ctx.ui.notify(`profile: ${c.name} (${c.agentDir}, selected by ${c.source}). Switch with: pi --profile NAME`, "info");
		},
	});
}
