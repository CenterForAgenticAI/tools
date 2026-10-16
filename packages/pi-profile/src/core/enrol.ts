import { existsSync } from "node:fs";
import { basename, posix } from "node:path";
import { checkHost, failure, type SshResult, type SshRunner } from "./authsync.ts";
import { configPath, DEFAULT_HUB, hostId, hubRemoteProblem, loadConfig, parseConfig, updateConfig, type MachineConfig } from "./config.ts";
import { readJson } from "./fsutil.ts";
import { hubMirror, initHub, openMirror } from "./hub.ts";
import { pinConflictLine, pullHubs, type PullReport } from "./hubpull.ts";
import { readSyncState } from "./hubstate.ts";
import { isHubName } from "./manifest.ts";
import { isSelectableName } from "./names.ts";
import { overlapsPulled, type Env, type Layout } from "./paths.ts";
import { commandLine, matches, npmInstall, piVersionCache } from "./pin.ts";
import { readPinState, shownPin } from "./pinstate.ts";
import { findPi, PI_PACKAGE } from "./piversion.ts";
import { HOST_LABEL } from "./replica.ts";
import { localHost, printable } from "./repo.ts";
import { Refusal } from "./result.ts";

/**
 * `pi-profile enrol HOST` (issue 33): set up another of your hosts
 * over ssh. It has two halves.
 *
 * - The caller (`enrolPeer`) checks the peer with a fixed, read-only probe
 *   (Node 24, Pi, pi-profile and the login shell, on the PATH that `ssh HOST`
 *   runs), then runs the peer half there through the same fixed-word ssh path
 *   as `auth push` and `auth pull`, and reads its JSON report as untrusted
 *   input. It never installs anything on the peer: a missing tool stops
 *   enrolment before anything is written, with the command to run there
 *   (issue 34).
 * - The peer half (`enrolHere`, `enrol --local`) runs on the peer: it writes or
 *   confirms machine config, runs `sync init` and `sync pull` through the
 *   same code as those commands, then checks the Pi there against the hub's
 *   Pi version pin, which arrives with the pull. It prints one report.
 *
 * Enrol never copies a secret. Credentials move only through `auth pull`,
 * which the caller runs on the peer afterwards when asked (`--auth pull`).
 */

/** The steps of the peer half, in order. */
export const ENROL_STEPS = ["config", "hub", "pull", "pi"] as const;
export type EnrolStep = (typeof ENROL_STEPS)[number];
/**
 * `done`: enrol changed it (with `dryRun`, would change it). `already`: it
 * was in place. `skipped`: not checked, and why. `warning`: in place, with a
 * problem that does not stop enrolment (the Pi version pin). `failed`:
 * enrolment stopped here.
 */
export const STEP_STATUSES = ["done", "already", "skipped", "warning", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepReport {
	readonly step: EnrolStep;
	readonly status: StepStatus;
	/** Plain text, one or more lines. It never holds a credential. */
	readonly message: string;
}

/** What the peer half prints on stdout: one JSON object. */
export interface EnrolReport {
	readonly schemaVersion: 1;
	readonly dryRun: boolean;
	/** The peer's host ID, as its machine config holds it (or would). */
	readonly host: string;
	readonly hub: string;
	readonly steps: readonly StepReport[];
	/** The profiles sync pull brought to the peer (or would), aliases left out. */
	readonly profiles: readonly string[];
}

/** The ID enrol gives the session store it adds. */
export const ENROL_STORE_ID = "main";
/** The largest report the caller reads. */
export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 16 * 1024;
const MAX_MESSAGE = 16 * 1024;
const MAX_PROFILES = 1024;
/** The Node major version pi-profile needs (package.json engines). */
export const NODE_MAJOR = 24;
/** The longest a whole enrol run on the peer may take: three fetches and a pull. */
export const ENROL_SSH_TIMEOUT_MS = 10 * 60_000;

/**
 * One word of a remote command that is a value: a remote, a path or a name.
 * No character a POSIX shell, zsh or fish gives a meaning to (no quotes,
 * spaces, `$`, `;`, `~`, `=`, `%`, globs or braces), and never a leading
 * `-`, so a value can neither run code nor read as an option.
 */
const VALUE_WORD = /^[A-Za-z0-9_@+:,./][A-Za-z0-9_@+:,./-]*$/;
const FLAG_WORD = /^--[a-z]+(-[a-z]+)*$/;
const HOST_ID = /^[a-z0-9-]{1,63}$/;

/** `ssh` arguments for `pi-profile WORDS...` on `host`, as `auth push` builds them. */
export function peerSshArgs(host: string, words: readonly string[]): string[] {
	checkHost(host);
	for (const w of words) if (!FLAG_WORD.test(w) && !VALUE_WORD.test(w)) throw new Refusal("refusing to pass an unsafe word to a remote shell");
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "--", host, "pi-profile", ...words];
}

/** Why a hub remote cannot be sent to a peer, or undefined. */
export function enrolRemoteProblem(remote: string): string | undefined {
	const problem = hubRemoteProblem(remote);
	if (problem !== undefined) return `hub remote ${problem}`;
	if (!VALUE_WORD.test(remote)) return "hub remote must be letters, digits and _ @ + : , . / - only, so a remote shell reads it as itself";
	return undefined;
}

function sessionStoreProblem(path: string): string | undefined {
	if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === "/" || path.endsWith("/")) return "--session-store must be an absolute, normalised path, such as /srv/pi/sessions";
	if (!VALUE_WORD.test(path)) return "--session-store must be letters, digits and _ @ + : , . / - only, so a remote shell reads it as itself";
	return undefined;
}

function checkInputs(o: { readonly hub: string; readonly remote?: string; readonly hostId?: string; readonly sessionStore?: string }): void {
	if (!isHubName(o.hub)) throw new Refusal(`invalid hub name: ${printable(o.hub)} (letters, digits, '.', '_' or '-')`);
	const problem = o.remote === undefined ? undefined : enrolRemoteProblem(o.remote);
	if (problem !== undefined) throw new Refusal(problem);
	if (o.hostId !== undefined && !HOST_ID.test(o.hostId)) throw new Refusal("--host-id must be a Tailscale short name: lower-case letters, digits and -");
	const store = o.sessionStore === undefined ? undefined : sessionStoreProblem(o.sessionStore);
	if (store !== undefined) throw new Refusal(store);
}

// ---------------------------------------------------------------- the peer half

export interface EnrolHereOptions {
	readonly hub: string;
	readonly remote: string;
	readonly hostId?: string;
	readonly sessionStore?: string;
	readonly dryRun?: boolean;
	readonly env?: Env;
}

class StepFailed extends Error {
	readonly refused: boolean;
	/** The step that failed, when it is not the next one in order (a check made before the first write). */
	readonly step: EnrolStep | undefined;
	constructor(message: string, refused: boolean, step?: EnrolStep) {
		super(message);
		this.refused = refused;
		this.step = step;
	}
}

/** The machine config enrol would write from `c`, or why it must not. Pure: run again under the config lock. */
function configChange(l: Layout, c: MachineConfig, existed: boolean, want: { readonly hostId?: string; readonly sessionStore?: string }): { next: MachineConfig; changes: string[] } {
	const where = configPath(l);
	const changes: string[] = [];
	let next: MachineConfig = c;
	if (want.hostId !== undefined && c.hostId !== want.hostId) {
		if (existed) throw new Refusal(`this host's machine config has host ID ${printable(c.hostId ?? "(none)")}, not ${want.hostId}; enrol never changes it. Drop --host-id to keep ${printable(c.hostId ?? "it")}, or change hostId in ${where} by hand first`);
		next = { ...next, hostId: want.hostId };
	}
	if (!existed) changes.push(`host ID ${next.hostId ?? ""}`);
	const path = want.sessionStore;
	if (path !== undefined) {
		const def = c.defaultSessionStore;
		const defPath = def === undefined ? undefined : c.sessionStores[def]?.path;
		if (def !== undefined && defPath !== path)
			throw new Refusal(`the default session store here is ${printable(def)} (${printable(defPath ?? "")}), not ${printable(path)}; enrol never changes it. Drop --session-store to keep it, or change it by hand first (pi-profile sessions store add and defaultSessionStore in ${where})`);
		if (def === undefined) {
			const same = Object.entries(c.sessionStores).find(([, s]) => s.path === path)?.[0];
			if (same !== undefined) {
				next = { ...next, defaultSessionStore: same };
				changes.push(`session store ${same} (${path}) as the default`);
			} else {
				const taken = c.sessionStores[ENROL_STORE_ID];
				if (taken !== undefined) throw new Refusal(`a session store ${ENROL_STORE_ID} is already defined here, at ${printable(taken.path)}; enrol never changes it. Set defaultSessionStore in ${where} by hand`);
				if (overlapsPulled(l, path)) throw new Refusal(`session store ${path} overlaps the pulled sessions in ~/.pi/pi-profile/remote; choose another path`);
				next = { ...next, sessionStores: { ...next.sessionStores, [ENROL_STORE_ID]: { path } }, defaultSessionStore: ENROL_STORE_ID };
				changes.push(`session store ${ENROL_STORE_ID} (${path}) as the default`);
			}
		}
	}
	return { next, changes };
}

function readConfigHere(l: Layout): { config: MachineConfig; existed: boolean } {
	const raw = readJson(configPath(l));
	if (raw === undefined) return { config: { schemaVersion: 1, sessionStores: {} }, existed: false };
	return { config: parseConfig(raw), existed: true };
}

function configStep(l: Layout, o: EnrolHereOptions, env: Env): { step: StepReport; host: string } {
	let read: { config: MachineConfig; existed: boolean };
	try {
		read = readConfigHere(l);
	} catch (error) {
		throw new StepFailed(`${configPath(l)}: ${(error as Error).message}; fix it by hand, then run enrol again`, true);
	}
	let base = read.config;
	if (!read.existed) {
		try {
			base = { ...base, hostId: o.hostId ?? hostId(env) };
		} catch (error) {
			throw new StepFailed(`${(error as Error).message}; give one with --host-id`, error instanceof Refusal);
		}
	}
	const want = { ...(o.hostId === undefined ? {} : { hostId: o.hostId }), ...(o.sessionStore === undefined ? {} : { sessionStore: o.sessionStore }) };
	let planned: { next: MachineConfig; changes: string[] };
	try {
		planned = configChange(l, base, read.existed, want);
	} catch (error) {
		throw new StepFailed((error as Error).message, error instanceof Refusal);
	}
	const host = planned.next.hostId ?? "";
	const store = planned.next.defaultSessionStore;
	const storeText = store === undefined ? "" : `, default session store ${store} (${planned.next.sessionStores[store]?.path ?? ""})`;
	if (planned.changes.length === 0) return { host, step: { step: "config", status: "already", message: `machine config in place: host ID ${host}${storeText}` } };
	const what = planned.changes.join(", ");
	if (o.dryRun === true) return { host, step: { step: "config", status: "done", message: `would write machine config: ${what}` } };
	// The host ID planned above, the one the dry run reports, is the one written: with it in the env, updateConfig
	// never works out this host's own default again, which may be unsafe when --host-id was given to avoid it.
	const writeEnv: Env = host === "" ? env : { ...env, PI_PROFILE_HOST_ID: host };
	try {
		// Planned again under the config lock from what the file holds then, so a change made meanwhile is never overwritten.
		updateConfig(
			l,
			(c) => {
				// Under the config lock: a file made since it was read is checked as it is, never overwritten.
				const existed = read.existed || existsSync(configPath(l));
				return configChange(l, existed ? c : { ...c, hostId: host }, existed, want).next;
			},
			writeEnv,
		);
	} catch (error) {
		throw new StepFailed((error as Error).message, error instanceof Refusal);
	}
	return { host, step: { step: "config", status: "done", message: `wrote machine config: ${what}` } };
}

/** Whether hub `hub` here already follows `remote`, with a mirror sync push and pull can use. */
function hubReady(l: Layout, hub: string, remote: string, env: Env): boolean {
	if (loadConfig(l, env).hubs?.[hub]?.remote !== remote) return false;
	try {
		openMirror(l, hub, remote, env);
		return true;
	} catch {
		return false;
	}
}

/** Refuses before anything is written when hub `hub` here follows another remote: a hub is never repointed silently. */
function hubPrecheck(l: Layout, hub: string, remote: string, env: Env): void {
	const known = loadConfig(l, env).hubs?.[hub];
	if (known !== undefined && known.remote !== remote)
		throw new StepFailed(`hub ${hub} here already uses ${printable(known.remote)}, not ${printable(remote)}; enrol never repoints a hub. To change it, set hubs.${hub}.remote in ${configPath(l)}, remove ${hubMirror(l, hub)}, and run enrol again`, true, "hub");
}

function hubStep(l: Layout, o: EnrolHereOptions, env: Env): StepReport {
	if (hubReady(l, o.hub, o.remote, env)) return { step: "hub", status: "already", message: `hub ${o.hub} already uses ${o.remote}` };
	const command = `sync init ${o.remote}${o.hub === DEFAULT_HUB ? "" : ` --hub ${o.hub}`}`;
	if (o.dryRun === true) return { step: "hub", status: "done", message: `would run ${command}` };
	try {
		const r = initHub(l, o.remote, { hub: o.hub, env });
		return { step: "hub", status: "done", message: `ran ${command}: ${r.head === undefined ? "the hub is empty" : `hub at ${r.head.slice(0, 12)}`}` };
	} catch (error) {
		throw new StepFailed((error as Error).message, error instanceof Refusal);
	}
}

function pulledProfiles(r: PullReport): string[] {
	return [...new Set(r.profiles.filter((p) => p.alias === undefined).map((p) => p.profile))].sort();
}

/** True when a real pull would change nothing here: no file, profile, alias or pin, and every hub's commit already recorded. */
function nothingToPull(l: Layout, r: PullReport): boolean {
	const state = readSyncState(l);
	return (
		r.conflicts.length === 0 &&
		r.pinConflicts.length === 0 &&
		r.pins.length === 0 &&
		r.skippedProfiles.length === 0 &&
		r.profiles.every((p) => !p.created && p.alias === undefined && p.files.length === 0) &&
		r.hubs.every((h) => h.failed === undefined && (h.commit === undefined || state.hubs.get(h.hub)?.commit === h.commit))
	);
}

function pullNotes(r: PullReport): string[] {
	const notes: string[] = [];
	for (const w of r.warnings) notes.push(`warning: ${w}`);
	for (const s of r.skippedProfiles) notes.push(`left out ${s.profile}: ${s.reason}`);
	for (const h of r.held) notes.push(`${h.profile}: not pulled in full (${h.paths.join(", ")}): ${h.wayOut}`);
	const missing = r.packages.filter((p) => p.outcome === "missing");
	if (missing.length > 0) notes.push(`packages missing here: ${missing.map((p) => `${p.profile}: ${p.source}`).join(", ")} (pi-profile sync pull --install-packages installs npm: and git: ones)`);
	return notes;
}

function pullStep(l: Layout, o: EnrolHereOptions, env: Env): { step: StepReport; profiles: string[] } {
	if (!hubReady(l, o.hub, o.remote, env)) {
		// Only a dry run gets here: the hub step set the hub up otherwise.
		return { profiles: [], step: { step: "pull", status: "skipped", message: `hub ${o.hub} is not set up here yet, so a dry run cannot read it; enrol without --dry-run runs sync pull` } };
	}
	let plan: PullReport;
	try {
		plan = pullHubs(l, [], { env, dryRun: true });
	} catch (error) {
		throw new StepFailed((error as Error).message, error instanceof Refusal);
	}
	const failedHubs = (r: PullReport): StepFailed | undefined => {
		const failed = r.hubs.flatMap((h) => (h.failed === undefined ? [] : [h.failed]));
		return failed.length === 0 ? undefined : new StepFailed(failed.map((f) => f.message).join("\n"), failed.every((f) => f.refused));
	};
	const planFailure = failedHubs(plan);
	if (planFailure !== undefined) throw planFailure;
	if (nothingToPull(l, plan)) {
		const names = pulledProfiles(plan);
		const said = names.length === 0 ? "the hub holds no profiles; nothing to pull" : `profiles already as the hub holds them: ${names.join(", ")}`;
		return { profiles: names, step: { step: "pull", status: "already", message: [said, ...pullNotes(plan)].join("\n") } };
	}
	if (o.dryRun === true) {
		const names = pulledProfiles(plan);
		if (plan.pinConflicts.length > 0) throw new StepFailed(`sync pull would be refused: the Pi version pin changed here and in the hub:\n${plan.pinConflicts.map((c) => `  ${pinConflictLine(c)}`).join("\n")}`, true);
		if (plan.conflicts.length > 0) {
			const list = plan.conflicts.map((c) => `  ${c.profile}/${c.path}`).join("\n");
			throw new StepFailed(`sync pull would be refused: these files changed here since the last pull, and the hub changed them too:
${list}`, true);
		}
		const what = plan.profiles.map((p) => (p.alias !== undefined ? `${p.profile} (an alias of ${p.alias})` : p.created ? `${p.profile} (new)` : `${p.profile} (${p.files.length} file${p.files.length === 1 ? "" : "s"})`));
		return { profiles: names, step: { step: "pull", status: "done", message: [`would pull ${what.join(", ") || "nothing"}`, ...pullNotes(plan)].join("\n") } };
	}
	let r: PullReport;
	try {
		// The normal pull: never --theirs, --keep-local or --install-packages; enrol never settles a conflict for the user.
		r = pullHubs(l, [], { env });
	} catch (error) {
		throw new StepFailed((error as Error).message, error instanceof Refusal);
	}
	const failure = failedHubs(r);
	if (failure !== undefined) throw failure;
	const names = pulledProfiles(r);
	const at = r.hubs.filter((h) => h.commit !== undefined).map((h) => `hub ${h.hub} at ${(h.commit as string).slice(0, 12)}`);
	const pins = r.pins.map((p) => `hub ${p.hub}: Pi version pin ${shownPin(p.to)}`);
	const head = names.length === 0 ? "pulled; the hub holds no profiles" : `pulled ${names.join(", ")}${at.length === 0 ? "" : ` (${at.join(", ")})`}`;
	return { profiles: names, step: { step: "pull", status: "done", message: [head, ...pins, ...pullNotes(r)].join("\n") } };
}

function piStep(l: Layout, o: EnrolHereOptions, env: Env): StepReport {
	let pin: string | undefined;
	try {
		pin = readPinState(l).get(o.hub)?.pin;
	} catch (error) {
		return { step: "pi", status: "warning", message: `the Pi version pin was not checked: ${(error as Error).message}` };
	}
	if (pin === undefined) return { step: "pi", status: "skipped", message: `hub ${o.hub} has no Pi version pin here${o.dryRun === true ? " yet" : ""}` };
	const found = findPi(env, o.dryRun === true ? {} : { cache: piVersionCache(l) });
	const which = `the Pi version pin ${shownPin(pin)} of hub ${o.hub}`;
	if (found === undefined) return { step: "pi", status: "warning", message: `no pi on PATH, so ${which} was not checked` };
	const ok = matches(found.version, pin);
	if (ok === true) return { step: "pi", status: "already", message: `Pi ${shownPin(found.version)} matches ${which}` };
	if (ok === undefined) return { step: "pi", status: "warning", message: `cannot read the version of ${found.path}, so ${which} was not checked` };
	// The pin only ever warns (issue 34): enrolment goes on.
	return { step: "pi", status: "warning", message: `Pi ${shownPin(found.version)} does not match ${which}; enrolment goes on (pi-profile pin --install here installs it for an npm install of Pi)` };
}

/**
 * The peer half: `enrol --local`. Runs each step in order and stops at the
 * first that fails. Every refusal it can know before writing (another host
 * ID, session store or hub remote) is checked before the first write.
 * Exit: 0, 2 when a step was refused, 1 when one failed otherwise.
 */
export function enrolHere(l: Layout, o: EnrolHereOptions): { report: EnrolReport; exit: 0 | 1 | 2 } {
	checkInputs(o);
	const env = o.env ?? process.env;
	const steps: StepReport[] = [];
	let host = "";
	let profiles: string[] = [];
	let exit: 0 | 1 | 2 = 0;
	try {
		hubPrecheck(l, o.hub, o.remote, env);
		const c = configStep(l, o, env);
		host = c.host;
		steps.push(c.step);
		steps.push(hubStep(l, o, env));
		const p = pullStep(l, o, env);
		profiles = p.profiles;
		steps.push(p.step);
		steps.push(piStep(l, o, env));
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const step = error.step ?? ENROL_STEPS[steps.length] ?? "pi";
		steps.push({ step, status: "failed", message: error.message });
		exit = error.refused ? 2 : 1;
	}
	if (host === "") {
		try {
			host = loadConfig(l, env).hostId ?? o.hostId ?? hostId(env);
		} catch {
			host = "unknown";
		}
	}
	return { report: { schemaVersion: 1, dryRun: o.dryRun === true, host, hub: o.hub, steps, profiles }, exit };
}

// ---------------------------------------------------------------- the caller

/** What the read-only probe found on the peer, each value printable. */
export interface Probe {
	readonly node?: string;
	readonly pi?: string;
	readonly piProfile?: string;
	readonly shell?: string;
}

/**
 * The probe: a fixed command, read-only, run by `/bin/sh` whatever the login
 * shell is. It reports what the PATH of `ssh HOST` finds, which is the PATH
 * `ssh HOST pi-profile` runs with, and the login shell (sshd sets SHELL).
 */
export const PROBE = "/bin/sh -c 'printf \"node=%s\\n\" \"$(node --version 2>/dev/null)\"; printf \"pi=%s\\n\" \"$(command -v pi 2>/dev/null)\"; printf \"pi-profile=%s\\n\" \"$(command -v pi-profile 2>/dev/null)\"; printf \"shell=%s\\n\" \"$SHELL\"'";

export function probeArgs(host: string): string[] {
	checkHost(host);
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "--", host, PROBE];
}

/** The probe's output, untrusted: known keys only, each value printable and bounded. */
export function parseProbe(stdout: string): Probe {
	if (Buffer.byteLength(stdout) > MAX_PROBE_BYTES) throw new Refusal("the probe's answer is too large; nothing was written there");
	const out: { node?: string; pi?: string; piProfile?: string; shell?: string } = {};
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq);
		const value = printable(line.slice(eq + 1).trim()).slice(0, 1024);
		if (value.length === 0) continue;
		if (key === "node") out.node = value;
		else if (key === "pi") out.pi = value;
		else if (key === "pi-profile") out.piProfile = value;
		else if (key === "shell") out.shell = value;
	}
	return out;
}

/** Why the peer is not ready, each with the command to run there. Empty: ready. */
export function prerequisiteProblems(host: string, p: Probe, pin: string | undefined): string[] {
	const problems: string[] = [];
	const path = `the PATH that ssh ${host} runs`;
	const nodeFix = `install Node ${String(NODE_MAJOR)} or later there, for example with nvm: nvm install ${String(NODE_MAJOR)}`;
	if (p.node === undefined) problems.push(`Node is not on ${path}; ${nodeFix}`);
	else {
		const m = /^v?(\d{1,4})\.\d+\.\d+/.exec(p.node);
		if (m === null) problems.push(`node --version on ${host} printed ${p.node}, which is not a Node version; ${nodeFix}`);
		else if (Number(m[1]) < NODE_MAJOR) problems.push(`Node ${p.node} is too old on ${host} (pi-profile needs Node ${String(NODE_MAJOR)} or later); ${nodeFix}`);
	}
	if (p.pi === undefined) problems.push(`Pi is not on ${path}; install it there: ${commandLine(pin === undefined ? ["npm", "install", "--global", PI_PACKAGE] : npmInstall(pin))}`);
	if (p.piProfile === undefined) problems.push(`pi-profile is not on ${path}; install it there: npm install -g @centerforagenticai/pi-profile`);
	return problems;
}

function bounded(text: unknown, max: number): text is string {
	return typeof text === "string" && text.length <= max;
}

/**
 * The peer's report, untrusted: size-capped, exactly the known keys, known
 * steps and statuses, and the hub and dry-run asked for. A refusal names
 * only what was wrong, never what the report held.
 */
export function parseReport(stdout: string, want: { readonly hub: string; readonly dryRun: boolean }): EnrolReport {
	const bad = (why: string): Refusal => new Refusal(`the enrol report from the peer ${why}; nothing from it is shown`);
	if (Buffer.byteLength(stdout) > MAX_REPORT_BYTES) throw bad(`is larger than ${String(MAX_REPORT_BYTES / 1024)} KiB`);
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		throw bad("is not valid JSON");
	}
	const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isRecord(raw)) throw bad("is not a JSON object");
	const keys = ["schemaVersion", "dryRun", "host", "hub", "steps", "profiles"];
	if (Object.keys(raw).some((k) => !keys.includes(k)) || keys.some((k) => !(k in raw))) throw bad("does not have exactly the known keys");
	if (raw.schemaVersion !== 1) throw bad("has another schemaVersion (upgrade pi-profile on both hosts)");
	if (raw.dryRun !== want.dryRun) throw bad("does not match the dry run asked for");
	if (raw.hub !== want.hub) throw bad("names another hub");
	if (typeof raw.host !== "string" || !/^[a-z0-9-]{1,253}$/.test(raw.host)) throw bad("has a host ID that is not a safe name");
	if (!Array.isArray(raw.steps) || raw.steps.length > ENROL_STEPS.length) throw bad("has a malformed step list");
	const steps: StepReport[] = [];
	for (const s of raw.steps as unknown[]) {
		if (!isRecord(s) || Object.keys(s).length !== 3) throw bad("has a malformed step");
		if (!(ENROL_STEPS as readonly unknown[]).includes(s.step)) throw bad("has an unknown step");
		if (!(STEP_STATUSES as readonly unknown[]).includes(s.status)) throw bad("has an unknown step status");
		if (!bounded(s.message, MAX_MESSAGE)) throw bad("has a malformed step message");
		steps.push({ step: s.step as EnrolStep, status: s.status as StepStatus, message: s.message });
	}
	if (!Array.isArray(raw.profiles) || raw.profiles.length > MAX_PROFILES) throw bad("has a malformed profile list");
	const profiles: string[] = [];
	for (const p of raw.profiles as unknown[]) {
		if (typeof p !== "string" || !isSelectableName(p)) throw bad("has a profile name that is not a safe name");
		profiles.push(p);
	}
	return { schemaVersion: 1, dryRun: want.dryRun, host: raw.host, hub: want.hub, steps, profiles };
}

/** A failed ssh run: ssh's last stderr line, never stdout, with the way out for an unknown host key. */
export function sshFailure(host: string, what: string, r: SshResult): string {
	const why = failure(r) ?? `exited ${String(r.status)}`;
	const hint = r.stderr.includes("Host key verification failed") ? `; connect once with ssh ${host} to accept its host key, then run enrol again` : "";
	return `${host}: ${what} failed: ${why}${hint}`;
}

export interface EnrolOptions {
	readonly hub?: string;
	readonly remote?: string;
	readonly hostId?: string;
	readonly sessionStore?: string;
	readonly authPull?: boolean;
	readonly dryRun?: boolean;
	readonly env?: Env;
	readonly run: SshRunner;
}

export interface AuthPullOutcome {
	readonly profile: string;
	/** The peer's outcome lines (`provider: added`), printable. */
	readonly lines: readonly string[];
	readonly error?: string;
}

export interface EnrolResult {
	readonly host: string;
	/** This host's ID: the host the peer runs `auth pull` from. */
	readonly self?: string;
	readonly hub: string;
	readonly remote: string;
	readonly probe: Probe;
	readonly report: EnrolReport;
	/** 0, or the peer half's exit code when a step failed. */
	readonly exit: 0 | 1 | 2;
	/** Set when `authPull` ran (never in a dry run). */
	readonly auth?: readonly AuthPullOutcome[];
}

function selfId(l: Layout, env: Env): string | undefined {
	try {
		return localHost(l, env);
	} catch {
		return undefined;
	}
}

/** The hub remote to give the peer: `remote`, else this host's for `hub`, which must be one the peer can reach. */
function peerRemote(l: Layout, host: string, hub: string, remote: string | undefined, env: Env): string {
	if (remote !== undefined) return remote;
	const here = loadConfig(l, env).hubs?.[hub]?.remote;
	const flag = hub === DEFAULT_HUB ? "" : ` --hub ${hub}`;
	if (here === undefined) throw new Refusal(`hub ${hub} is not configured here; give the hub as ${host} reaches it with --remote HOST:PATH, or run pi-profile sync init REMOTE${flag} here first`);
	const local = posix.isAbsolute(here) ? here : here.startsWith("file://") ? here.slice("file://".length) : undefined;
	if (local !== undefined) {
		const self = selfId(l, env) ?? "THISHOST";
		throw new Refusal(`hub ${hub}'s remote here is a local path (${printable(here)}), which ${host} cannot reach; give it the hub over ssh, such as --remote ${self}:${printable(local)}`);
	}
	return here;
}

/**
 * `enrol HOST`: probe the peer, refuse before any write when it is not ready,
 * run the peer half there, read its report, and with `authPull` run
 * `auth pull THISHOST --profile P` there for each profile it pulled.
 */
export function enrolPeer(l: Layout, host: string, o: EnrolOptions): EnrolResult {
	checkHost(host);
	const env = o.env ?? process.env;
	const hub = o.hub ?? DEFAULT_HUB;
	const dryRun = o.dryRun === true;
	checkInputs({ hub, ...(o.remote === undefined ? {} : { remote: o.remote }), ...(o.hostId === undefined ? {} : { hostId: o.hostId }), ...(o.sessionStore === undefined ? {} : { sessionStore: o.sessionStore }) });
	const remote = peerRemote(l, host, hub, o.remote, env);
	const remoteProblem = enrolRemoteProblem(remote);
	if (remoteProblem !== undefined) throw new Refusal(`${remoteProblem} (hubs.${hub}.remote here); give the hub as ${host} reaches it with --remote HOST:PATH`);
	const self = selfId(l, env);
	if (o.authPull === true && (self === undefined || !HOST_LABEL.test(self)))
		throw new Refusal(`this host's ID ${printable(self ?? "(unknown)")} is not a Tailscale short name, so ${host} cannot run auth pull from it; set hostId in ${configPath(l)}, or leave out --auth pull`);
	const words = ["enrol", "--local", "--hub", hub, "--remote", remote, ...(o.hostId === undefined ? [] : ["--host-id", o.hostId]), ...(o.sessionStore === undefined ? [] : ["--session-store", o.sessionStore]), ...(dryRun ? ["--dry-run"] : [])];
	const args = peerSshArgs(host, words);

	const probed = o.run(probeArgs(host), "");
	if (failure(probed) !== undefined) throw new Error(sshFailure(host, "the probe", probed));
	const probe = parseProbe(probed.stdout);
	let pin: string | undefined;
	try {
		pin = readPinState(l).get(hub)?.pin;
	} catch {
		pin = undefined;
	}
	const problems = prerequisiteProblems(host, probe, pin);
	if (problems.length > 0) throw new Refusal(`${host} is not ready for pi-profile:\n  ${problems.join("\n  ")}\nnothing was written on ${host}; pi-profile never installs software on a peer. Run enrol again once these are installed`);

	const r = o.run(args, "");
	if (r.error !== undefined || r.stdout.trim().length === 0) {
		const why = sshFailure(host, "enrol --local", r);
		const older = r.stderr.includes("unknown command: enrol") ? `; pi-profile on ${host} is older than this one: npm install -g @centerforagenticai/pi-profile there` : "";
		if (r.status === 2 && r.error === undefined) throw new Refusal(why + older);
		throw new Error(why + older);
	}
	const report = parseReport(r.stdout, { hub, dryRun });
	const failed = report.steps.some((s) => s.status === "failed");
	const exit: 0 | 1 | 2 = failed ? (r.status === 1 ? 1 : 2) : r.status === 0 ? 0 : 1;
	const base = { host, ...(self === undefined ? {} : { self }), hub, remote, probe, report, exit };
	if (o.authPull !== true || dryRun || exit !== 0) return base;
	const auth: AuthPullOutcome[] = [];
	for (const profile of report.profiles) {
		const a = o.run(peerSshArgs(host, ["auth", "pull", self as string, "--profile", profile]), "");
		const why = failure(a);
		if (why !== undefined) auth.push({ profile, lines: [], error: why });
		else auth.push({ profile, lines: a.stdout.slice(0, MAX_REPORT_BYTES).split("\n").filter((x) => x.trim().length > 0).map(printable) });
	}
	return { ...base, auth };
}

/** The login shell's name from the probe, when it is one pi-profile has a shell-init for. */
export function peerShell(p: Probe): string | undefined {
	return p.shell === undefined ? undefined : basename(p.shell);
}
