import { execFile } from "node:child_process";
import net from "node:net";

export type PublicUrlUnavailableCode =
  | "MISSING_CONFIG"
  | "MISSING_MAPPING"
  | "MALFORMED_MAPPING"
  | "LOCAL_ONLY_MAPPING"
  | "AMBIGUOUS_MAPPING"
  | "RUNNER_UNAVAILABLE";

export type PublicUrlResolution =
  | { ok: true; publicBaseUrl: string }
  | { ok: false; code: PublicUrlUnavailableCode; message: string };

export interface TailscaleServeRunner {
  (executable: string, args: readonly string[], options: { timeout: number; maxBuffer: number }): Promise<string>;
}

export type PublicUrlProvider = { resolve(): Promise<PublicUrlResolution> } | (() => Promise<PublicUrlResolution> | PublicUrlResolution);

const RUNNER_TIMEOUT_MS = 2500;
const RUNNER_STDOUT_CAP = 512 * 1024;
export const TAILSCALE_EXECUTABLES = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"] as const;
const unavailable = (code: PublicUrlUnavailableCode, message: string): PublicUrlResolution => ({ ok: false, code, message });

function validHostname(hostname: string, allowTsNet = false): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("..") || host.length > 253 || host === "localhost" || host.endsWith(".local")) return false;
  if (net.isIP(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  if (allowTsNet && !host.endsWith(".ts.net")) return false;
  return true;
}

function rejectedAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    // Public IPs are accepted as explicit configuration, but all special/private
    // ranges and raw Tailscale addresses are rejected.
    if (net.isIPv4(host)) {
      const n = host.split(".").map(Number);
      return n[0] === 0 || n[0] === 10 || n[0] === 127 || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) || (n[0] === 169 && n[1] === 254) || n[0] >= 224 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && (n[1] === 0 || n[1] === 168)) || (n[0] === 198 && (n[1] === 18 || n[1] === 51)) || (n[0] === 203 && n[1] === 0);
    }
    return true;
  }
  return !validHostname(hostname) || /\.(?:lan|internal|home|corp)$/i.test(hostname);
}

export function unavailablePublicUrl(code: PublicUrlUnavailableCode, message: string): PublicUrlResolution {
  return unavailable(code, message);
}

export function validatePublicBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || parsed.port === "0") return null;
  if (rejectedAddress(parsed.hostname)) return null;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export function joinPublicUrl(base: string, path: string): string {
  const valid = validatePublicBaseUrl(base);
  if (!valid || typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid public URL");
  return `${valid.replace(/\/+$/, "")}${path}`;
}

function authorityUrl(authority: string): URL | null {
  try {
    const value = new URL(`https://${authority}`);
    if (value.username || value.password || value.pathname !== "/" || value.search || value.hash || !validHostname(value.hostname, true)) return null;
    return value;
  } catch { return null; }
}

/** Parse only the small, documented portion of `tailscale serve status --json`. */
export function parseTailscaleServeStatus(payload: unknown, servingPort: number): PublicUrlResolution {
  if (!Number.isSafeInteger(servingPort) || servingPort <= 0 || !payload || typeof payload !== "object" || Array.isArray(payload)) return unavailable("MALFORMED_MAPPING", "Tailscale Serve status is malformed; configure publicBaseUrl explicitly.");
  const root = payload as Record<string, unknown>;
  if (root.Web === undefined) return unavailable("MISSING_MAPPING", "No Tailscale Serve HTTPS mapping was found for the artifact daemon; run `tailscale serve` or configure publicBaseUrl.");
  if (!root.Web || typeof root.Web !== "object" || Array.isArray(root.Web)) return unavailable("MALFORMED_MAPPING", "Tailscale Serve status has an invalid Web mapping; configure publicBaseUrl explicitly.");
  const matches: string[] = [];
  let sawLocal = false;
  for (const [authority, rawWeb] of Object.entries(root.Web as Record<string, unknown>)) {
    const parsedAuthority = authorityUrl(authority);
    if (!parsedAuthority) { if (authority.includes("localhost") || net.isIP(authority.split(":")[0] || "")) sawLocal = true; continue; }
    if (!rawWeb || typeof rawWeb !== "object" || Array.isArray(rawWeb)) return unavailable("MALFORMED_MAPPING", "Tailscale Serve status has an invalid authority mapping; configure publicBaseUrl explicitly.");
    const handlers = (rawWeb as Record<string, unknown>).Handlers;
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) return unavailable("MALFORMED_MAPPING", "Tailscale Serve status has an invalid handler mapping; configure publicBaseUrl explicitly.");
    for (const [mount, rawHandler] of Object.entries(handlers as Record<string, unknown>)) {
      if (!/^\/[^?#]*$/.test(mount) || !rawHandler || typeof rawHandler !== "object" || Array.isArray(rawHandler)) return unavailable("MALFORMED_MAPPING", "Tailscale Serve status has an invalid handler mount; configure publicBaseUrl explicitly.");
      const proxy = (rawHandler as Record<string, unknown>).Proxy;
      if (typeof proxy !== "string") return unavailable("MALFORMED_MAPPING", "Tailscale Serve handler is missing its proxy; configure publicBaseUrl explicitly.");
      let target: URL;
      try { target = new URL(proxy); } catch { return unavailable("MALFORMED_MAPPING", "Tailscale Serve handler proxy is malformed; configure publicBaseUrl explicitly."); }
      const targetIp = net.isIP(target.hostname);
      const local = target.hostname === "localhost" || target.hostname === "::1" || (targetIp === 4 && target.hostname.split(".")[0] === "127") || (targetIp === 6 && target.hostname === "::1");
      if (!local || (target.protocol !== "http:" && target.protocol !== "https:")) { sawLocal = sawLocal || local; continue; }
      if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) return unavailable("MALFORMED_MAPPING", "Tailscale Serve handler proxy is malformed; configure publicBaseUrl explicitly.");
      if (Number(target.port || (target.protocol === "https:" ? 443 : 80)) !== servingPort) continue;
      const base = validatePublicBaseUrl(`https://${parsedAuthority.host}${mount === "/" ? "" : mount}`);
      if (base) matches.push(base);
    }
  }
  if (matches.length > 1) return unavailable("AMBIGUOUS_MAPPING", "Multiple Tailscale Serve HTTPS mappings target the artifact daemon; configure publicBaseUrl explicitly.");
  if (matches.length === 1) return { ok: true, publicBaseUrl: matches[0] };
  if (sawLocal) return unavailable("LOCAL_ONLY_MAPPING", "Tailscale Serve exposes only a local or non-public mapping; configure publicBaseUrl explicitly.");
  return unavailable("MISSING_MAPPING", "No valid Tailscale Serve mapping targets the artifact daemon; configure publicBaseUrl explicitly.");
}

export const defaultTailscaleRunner: TailscaleServeRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true }, (error, stdout) => {
    if (error) { reject(error); return; }
    resolve(stdout);
  });
});

export async function runTailscaleServeStatus(runner: TailscaleServeRunner = defaultTailscaleRunner): Promise<unknown> {
  for (const executable of TAILSCALE_EXECUTABLES) {
    try {
      const stdout = await runner(executable, ["serve", "status", "--json"], { timeout: RUNNER_TIMEOUT_MS, maxBuffer: RUNNER_STDOUT_CAP });
      return JSON.parse(stdout);
    } catch { /* try the next discovered executable */ }
  }
  return null;
}

export function createTailscalePublicUrlProvider(servingPort: number, runner: TailscaleServeRunner = defaultTailscaleRunner): PublicUrlProvider {
  return { async resolve() {
    const payload = await runTailscaleServeStatus(runner);
    if (payload === null) return unavailable("RUNNER_UNAVAILABLE", "Tailscale Serve status is unavailable; configure publicBaseUrl explicitly.");
    return parseTailscaleServeStatus(payload, servingPort);
  } };
}

export function explicitPublicUrlProvider(value: unknown): PublicUrlProvider | null {
  const publicBaseUrl = validatePublicBaseUrl(value);
  return publicBaseUrl ? { async resolve() { return { ok: true, publicBaseUrl }; } } : null;
}
