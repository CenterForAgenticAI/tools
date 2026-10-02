import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, serverFile } from "./paths.ts";
import type { DaemonHealth, ServerInfo } from "./types.ts";

export type DaemonStatus = "running" | "degraded" | "down";

export function defaultEndpoint(file = serverFile()): string {
  const info = readServerInfo(file);
  return `http://${info.host}:${info.port}/callback`;
}

export function readServerInfo(file = serverFile()): ServerInfo {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ServerInfo;
    if (parsed?.version === 1 && parsed.host && parsed.port) return parsed;
  } catch {
    // Ignore missing or malformed daemon state and fall back to defaults.
  }
  return { version: 1, pid: 0, host: DEFAULT_HOST, port: DEFAULT_PORT, startedAt: 0 };
}

/**
 * Path of the CLI entry the extension spawns with `node` (daemon launch and the
 * token-callback command it prints).
 *
 * Node refuses to strip types from files under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an npm-installed package
 * cannot run `bin/pi-callbacks.ts` directly and must use the compiled
 * `dist/bin/pi-callbacks.js`. A source checkout keeps the TypeScript entry so a
 * stale `dist/` never runs in development.
 */
export function daemonCliPath(packageRoot: string, exists: (file: string) => boolean = fs.existsSync): string {
  const source = path.join(packageRoot, "bin", "pi-callbacks.ts");
  const compiled = path.join(packageRoot, "dist", "bin", "pi-callbacks.js");
  const installed = path.resolve(packageRoot).split(path.sep).includes("node_modules");
  return installed && exists(compiled) ? compiled : source;
}

/**
 * Warning shown when the daemon could not be reached. An npm-installed package
 * without `dist/bin/pi-callbacks.js` can never start the daemon, so say that
 * instead of the generic message.
 */
export function daemonDownMessage(packageRoot: string, exists: (file: string) => boolean = fs.existsSync): string {
  const compiled = path.join(packageRoot, "dist", "bin", "pi-callbacks.js");
  const installed = path.resolve(packageRoot).split(path.sep).includes("node_modules");
  if (installed && !exists(compiled)) {
    return `pi-callbacks daemon cannot start: this install is missing the compiled CLI ${compiled}; reinstall the package`;
  }
  return "pi-callbacks daemon did not become reachable; callbacks may not fire";
}

export async function getDaemonHealth(file = serverFile()): Promise<DaemonHealth | undefined> {
  try {
    const response = await fetch(defaultEndpoint(file).replace(/\/callback$/, "/health"), { signal: AbortSignal.timeout(750) });
    return await response.json() as DaemonHealth;
  } catch {
    return undefined;
  }
}

export function daemonStatusFromHealth(health: DaemonHealth | undefined): DaemonStatus {
  if (health?.daemon !== "pi-callbacks") return "down";
  return health.ok ? "running" : "degraded";
}

export async function isDaemonHealthy(): Promise<boolean> {
  return daemonStatusFromHealth(await getDaemonHealth()) === "running";
}

export async function ensureDaemon(binPath: string): Promise<DaemonStatus> {
  // Capture the store location and environment before the first await. The
  // caller may change process.env (for example a test restoring
  // PI_CALLBACKS_DIR) while the health probe is in flight; the daemon must
  // still start against the store the caller asked for.
  const file = serverFile();
  const env = { ...process.env };
  let health = await getDaemonHealth(file);
  if (health?.daemon === "pi-callbacks") return daemonStatusFromHealth(health);
  const child = spawn(process.execPath, [binPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    health = await getDaemonHealth(file);
    if (health?.daemon === "pi-callbacks") return daemonStatusFromHealth(health);
  }
  return "down";
}
