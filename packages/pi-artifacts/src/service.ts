// Platform-specific user service lifecycle. No shell interprets generated paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.ts";

export const NODE_TS_FLAGS = ["--experimental-strip-types", "--experimental-sqlite"];
export const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
const LABEL = "com.pi.artifacts";
const UNIT = "pi-artifacts.service";

export interface ServiceCommandResult {
  status: number | null;
  error?: Error;
  stderr?: string;
}
export type ServiceRunner = (command: string, args: string[]) => ServiceCommandResult;
export interface ServiceOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
  configHome?: string;
  artifactsHome?: string;
  node?: string;
  server?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  run?: ServiceRunner;
}
export interface UserService {
  kind: "systemd" | "launchd";
  file: string;
  logs: string;
}

const defaultRunner: ServiceRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  return { status: result.status, error: result.error, stderr: result.stderr || undefined };
};

function settings(options: ServiceOptions) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") throw new Error(`Service installation is unsupported on ${platform}; run \`pi-artifacts serve\` instead.`);
  const userHome = options.userHome ?? os.homedir();
  const env = options.env ?? process.env;
  const configHome = options.configHome ?? env.XDG_CONFIG_HOME ?? path.join(userHome, ".config");
  if (!path.isAbsolute(configHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path");
  const artifactsHome = options.artifactsHome ?? HOME;
  const file = platform === "linux" ? path.join(configHome, "systemd", "user", UNIT) : path.join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
  const service: UserService = { kind: platform === "linux" ? "systemd" : "launchd", file, logs: platform === "linux" ? `journalctl --user -u ${UNIT} -n 50` : path.join(artifactsHome, "daemon.log") };
  // Copy only the runtime settings this service understands. Never emit arbitrary
  // environment keys (including unrelated credentials) into a service file.
  const environment: Record<string, string> = { PI_ARTIFACTS_HOME: artifactsHome };
  for (const key of ["PATH", "PI_ARTIFACTS_PORT", "PI_ARTIFACTS_HOST", "PI_ARTIFACTS_PUBLIC_URL", "PI_ARTIFACTS_PUBLIC_HOST", "PI_ARTIFACTS_MAX_UPLOAD_BYTES"]) {
    if (env[key] !== undefined) environment[key] = env[key];
  }
  return { service, environment, node: options.node ?? process.execPath, server: options.server ?? SERVER, uid: options.uid ?? process.getuid?.() ?? 0, run: options.run ?? defaultRunner };
}

function checked(run: ServiceRunner, command: string, args: string[]): void {
  const result = run(command, args);
  if (result.status !== 0 || result.error) {
    const reason = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}. Run \`pi-artifacts serve\` for foreground startup.`);
  }
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

// systemd parses quoting, specifiers (%) and ExecStart environment references ($).
// A path or setting must not become an extra argument, directive, or expansion.
function systemdQuote(value: string, exec = false): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/%/g, "%%");
  return `"${exec ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function installUserService(options: ServiceOptions = {}): UserService {
  const { service, environment, node, server, uid, run } = settings(options);
  if (service.kind === "systemd" && (!path.isAbsolute(node) || node.includes("$") || [...node].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) {
    throw new Error("Node executable path is not supported by systemd; use an absolute path without dollar signs or control characters");
  }
  if (service.kind === "systemd") checked(run, "systemctl", ["--user", "show-environment"]);
  fs.mkdirSync(environment.PI_ARTIFACTS_HOME, { recursive: true });
  fs.mkdirSync(path.dirname(service.file), { recursive: true });
  const args = [node, ...NODE_TS_FLAGS, server];
  const content = service.kind === "systemd" ? `[Unit]
Description=Pi artifacts daemon
After=network.target

[Service]
Type=simple
ExecStart=${args.map((value) => systemdQuote(value, true)).join(" ")}
${Object.entries(environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
` : `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(service.logs)}</string>
<key>StandardErrorPath</key><string>${xml(service.logs)}</string>
</dict></plist>
`;
  fs.writeFileSync(service.file, content, { mode: 0o600 });
  if (service.kind === "systemd") {
    checked(run, "systemctl", ["--user", "daemon-reload"]);
    checked(run, "systemctl", ["--user", "enable", UNIT]);
    checked(run, "systemctl", ["--user", "restart", UNIT]);
  } else {
    run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]); // absent service is normal on first install
    const result = run("launchctl", ["bootstrap", `gui/${uid}`, service.file]);
    if (result.status !== 0 || result.error) checked(run, "launchctl", ["load", "-w", service.file]);
  }
  return service;
}

export function uninstallUserService(options: ServiceOptions = {}): UserService {
  const { service, run, uid } = settings(options);
  if (!fs.existsSync(service.file)) return service;
  if (service.kind === "systemd") {
    checked(run, "systemctl", ["--user", "disable", "--now", UNIT]);
  } else {
    const result = run("launchctl", ["bootout", `gui/${uid}`, service.file]);
    if (result.status !== 0 || result.error) checked(run, "launchctl", ["unload", service.file]);
  }
  fs.unlinkSync(service.file);
  if (service.kind === "systemd") checked(run, "systemctl", ["--user", "daemon-reload"]);
  return service;
}

export async function waitForDaemon(isUp: () => Promise<boolean>, pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await isUp()) return true;
    if (attempt < 19) await pause(250);
  }
  return false;
}
