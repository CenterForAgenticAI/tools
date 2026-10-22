import { isAbsolute, join } from "node:path";
import { Refusal } from "./result.ts";

/**
 * Unit files that run "pi-profile sessions archive --all --apply" once a
 * day: a systemd user timer on Linux, a launchd agent on macOS. pi-profile
 * writes them; it never loads or starts them (the user does, with the
 * command it prints).
 */
export interface ScheduleEnv {
	/** Absolute path of the Node binary that runs the CLI. */
	readonly node: string;
	/** Absolute path of bin/pi-profile.mjs. */
	readonly cli: string;
	/** PI_PROFILE_HOME for the run. */
	readonly piHome: string;
	/** PATH for the run: rsync, ssh and git are found on it. */
	readonly path: string;
	/** Where launchd writes the run's output and errors; systemd sends them to the journal. */
	readonly log?: string;
}

export const ARCHIVE_ARGS: readonly string[] = ["sessions", "archive", "--all", "--apply", "--quiet"];
export const SYSTEMD_NAME = "pi-profile-archive";
export const LAUNCHD_LABEL = "io.pi-profile.archive";
/** A run that has not finished after this long is stopped; the next run finishes the job. */
const TIMEOUT_SEC = 6 * 3600;

function checked(env: ScheduleEnv): ScheduleEnv {
	for (const [k, v] of Object.entries(env)) {
		if (/[\p{Cc}\p{Cf}"\\]/u.test(v)) throw new Refusal(k + " holds a character a unit file cannot carry: " + JSON.stringify(v));
	}
	for (const [k, v] of Object.entries(env)) if (k !== "path" && v !== undefined && !isAbsolute(v)) throw new Refusal(k + " must be an absolute path: " + v);
	if (/\s/.test(env.node) || /\s/.test(env.cli)) throw new Refusal("the Node and pi-profile paths must not hold spaces; install pi-profile where its path has none");
	return env;
}

/** systemd expands % in values; %% is a literal %. */
const pct = (s: string): string => s.replace(/%/g, "%%");

export function systemdUnits(e: ScheduleEnv): { service: string; timer: string } {
	const env = checked(e);
	const service = [
		"[Unit]",
		"Description=Archive old Pi sessions (pi-profile sessions archive)",
		"",
		"[Service]",
		"Type=oneshot",
		"ExecStart=" + pct([env.node, env.cli, ...ARCHIVE_ARGS].join(" ")),
		"Environment=\"PI_PROFILE_HOME=" + pct(env.piHome) + "\"",
		"Environment=\"PATH=" + pct(env.path) + "\"",
		"Nice=10",
		"IOSchedulingClass=idle",
		"TimeoutStartSec=" + String(TIMEOUT_SEC),
		"",
	].join("\n");
	const timer = [
		"[Unit]",
		"Description=Archive old Pi sessions once a day",
		"",
		"[Timer]",
		"OnCalendar=daily",
		"RandomizedDelaySec=1h",
		"Persistent=true",
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	].join("\n");
	return { service, timer };
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(e: ScheduleEnv): string {
	const env = checked(e);
	const args = [env.node, env.cli, ...ARCHIVE_ARGS].map((a) => "\t\t<string>" + xml(a) + "</string>").join("\n");
	return [
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
		"<plist version=\"1.0\">",
		"<dict>",
		"\t<key>Label</key>",
		"\t<string>" + LAUNCHD_LABEL + "</string>",
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		args,
		"\t</array>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>PI_PROFILE_HOME</key>",
		"\t\t<string>" + xml(env.piHome) + "</string>",
		"\t\t<key>PATH</key>",
		"\t\t<string>" + xml(env.path) + "</string>",
		"\t</dict>",
		...(env.log === undefined ? [] : ["\t<key>StandardOutPath</key>", "\t<string>" + xml(env.log) + "</string>", "\t<key>StandardErrorPath</key>", "\t<string>" + xml(env.log) + "</string>"]),
		"\t<key>StartCalendarInterval</key>",
		"\t<dict>",
		"\t\t<key>Hour</key>",
		"\t\t<integer>3</integer>",
		"\t\t<key>Minute</key>",
		"\t\t<integer>17</integer>",
		"\t</dict>",
		"\t<key>LowPriorityIO</key>",
		"\t<true/>",
		"\t<key>ProcessType</key>",
		"\t<string>Background</string>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

export interface ScheduleFile {
	readonly path: string;
	readonly text: string;
}

/** The files for this platform, and the commands that start them. */
export function scheduleFiles(platform: string, home: string, env: ScheduleEnv): ScheduleFile[] {
	if (platform === "darwin") return [{ path: join(home, "Library", "LaunchAgents", LAUNCHD_LABEL + ".plist"), text: launchdPlist(env) }];
	if (platform === "linux") {
		const u = systemdUnits(env);
		const dir = join(home, ".config", "systemd", "user");
		return [{ path: join(dir, SYSTEMD_NAME + ".service"), text: u.service }, { path: join(dir, SYSTEMD_NAME + ".timer"), text: u.timer }];
	}
	throw new Refusal("no scheduler for " + platform + "; run pi-profile sessions archive --all --apply from cron or similar");
}

export function startCommands(platform: string, files: readonly ScheduleFile[]): string[] {
	if (platform === "darwin") return ["launchctl bootstrap gui/$(id -u) " + (files[0]?.path ?? "")];
	return ["systemctl --user daemon-reload", "systemctl --user enable --now " + SYSTEMD_NAME + ".timer"];
}
