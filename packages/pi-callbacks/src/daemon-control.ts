import { spawn } from "node:child_process";
import fs from "node:fs";
import { DEFAULT_HOST, DEFAULT_PORT, serverFile } from "./paths.ts";
import type { DaemonHealth, ServerInfo } from "./types.ts";

export type DaemonStatus = "running" | "degraded" | "down";

export function defaultEndpoint(): string {
  const info = readServerInfo();
  return `http://${info.host}:${info.port}/callback`;
}

export function readServerInfo(): ServerInfo {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverFile(), "utf8")) as ServerInfo;
    if (parsed?.version === 1 && parsed.host && parsed.port) return parsed;
  } catch {
    // Ignore missing or malformed daemon state and fall back to defaults.
  }
  return { version: 1, pid: 0, host: DEFAULT_HOST, port: DEFAULT_PORT, startedAt: 0 };
}

export async function getDaemonHealth(): Promise<DaemonHealth | undefined> {
  try {
    const response = await fetch(defaultEndpoint().replace(/\/callback$/, "/health"), { signal: AbortSignal.timeout(750) });
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
  let health = await getDaemonHealth();
  if (health?.daemon === "pi-callbacks") return daemonStatusFromHealth(health);
  const child = spawn(process.execPath, [binPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    health = await getDaemonHealth();
    if (health?.daemon === "pi-callbacks") return daemonStatusFromHealth(health);
  }
  return "down";
}
