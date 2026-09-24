// Shared configuration + paths for the pi-artifacts daemon, CLI, and extension.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { validatePublicBaseUrl } from "./public-url.ts";

export interface ArtifactsConfig {
  port: number;
  host: string;
  /** Transport used by clients to reach the daemon. */
  clientScheme?: "http" | "https";
  /** Explicit canonical public URL override, including an optional base path. */
  publicBaseUrl?: string;
  /** Legacy read-compatibility fields. */
  publicHost?: string;
  publicScheme?: "http" | "https";
}

export const HOME: string = process.env.PI_ARTIFACTS_HOME || path.join(os.homedir(), ".pi", "artifacts");
export const DB_PATH = path.join(HOME, "index.db");
export const BLOBS_DIR = path.join(HOME, "blobs");
export const STAGING_DIR = path.join(HOME, "staging");
export const APPLETS_DIR = path.join(HOME, "applets");
export const APPLET_DATA_DIR = path.join(HOME, "applet-data");
export const ANNOTATIONS_DIR = path.join(HOME, "annotations");
export const CONFIG_PATH = path.join(HOME, "config.json");
export const PREVIEWSHIP_PUBLISH_HEADER = "sec-pi-artifacts-publish";
export const PREVIEWSHIP_PUBLISH_HEADER_VALUE = "agent-client";
export const REGISTER_HEADER = "sec-pi-artifacts-register";
export const REGISTER_HEADER_VALUE = "agent-client";
export const COMMENT_AGENT_HEADER = "sec-pi-artifacts-comment-agent";
export const COMMENT_AGENT_HEADER_VALUE = "agent-client";

const DEFAULTS: ArtifactsConfig = { port: 8787, host: "127.0.0.1", clientScheme: "http" };

export function ensureHome(): void {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(APPLETS_DIR, { recursive: true });
  fs.mkdirSync(APPLET_DATA_DIR, { recursive: true });
  fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true, mode: 0o700 });
}

function copyConfig(raw: unknown): Partial<ArtifactsConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const result: Partial<ArtifactsConfig> = {};
  if (typeof value.port === "number" && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535) result.port = value.port;
  if (typeof value.host === "string" && value.host.trim()) result.host = value.host;
  if (value.clientScheme === "http" || value.clientScheme === "https") result.clientScheme = value.clientScheme;
  if (typeof value.publicBaseUrl === "string") result.publicBaseUrl = validatePublicBaseUrl(value.publicBaseUrl) ?? undefined;
  if (typeof value.publicHost === "string" && validatePublicBaseUrl(`https://${value.publicHost}`)) result.publicHost = value.publicHost;
  if (value.publicScheme === "http" || value.publicScheme === "https") result.publicScheme = value.publicScheme;
  return result;
}

export function loadConfig(): ArtifactsConfig {
  let rawFile: unknown = null;
  try { rawFile = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* no config file yet */ }
  const file = copyConfig(rawFile);
  // An explicitly supplied invalid preferred URL must not silently fall back to
  // legacy publicHost data or turn a bad override into a different link.
  if (rawFile && typeof rawFile === "object" && !Array.isArray(rawFile) && Object.prototype.hasOwnProperty.call(rawFile, "publicBaseUrl") && validatePublicBaseUrl((rawFile as Record<string, unknown>).publicBaseUrl) === null) {
    delete file.publicHost;
    delete file.publicScheme;
  }
  const cfg: ArtifactsConfig = { ...DEFAULTS, ...file };
  if (process.env.PI_ARTIFACTS_PORT) { const port = Number(process.env.PI_ARTIFACTS_PORT); if (Number.isSafeInteger(port) && port > 0 && port <= 65535) cfg.port = port; }
  if (process.env.PI_ARTIFACTS_HOST?.trim()) cfg.host = process.env.PI_ARTIFACTS_HOST;
  if (process.env.PI_ARTIFACTS_CLIENT_SCHEME === "http" || process.env.PI_ARTIFACTS_CLIENT_SCHEME === "https") cfg.clientScheme = process.env.PI_ARTIFACTS_CLIENT_SCHEME;
  if (process.env.PI_ARTIFACTS_PUBLIC_URL !== undefined) cfg.publicBaseUrl = validatePublicBaseUrl(process.env.PI_ARTIFACTS_PUBLIC_URL) ?? undefined;
  if (process.env.PI_ARTIFACTS_PUBLIC_HOST) {
    const host = process.env.PI_ARTIFACTS_PUBLIC_HOST;
    if (validatePublicBaseUrl(`https://${host}`)) cfg.publicHost = host;
  }
  return cfg;
}

export function saveConfig(patch: Partial<ArtifactsConfig>): ArtifactsConfig {
  if (Object.prototype.hasOwnProperty.call(patch, "publicBaseUrl") && validatePublicBaseUrl(patch.publicBaseUrl) === null) throw new Error("publicBaseUrl must be a valid non-local HTTP(S) URL");
  if (Object.prototype.hasOwnProperty.call(patch, "publicHost") && validatePublicBaseUrl(`${patch.publicScheme || "https"}://${patch.publicHost}`) === null) throw new Error("publicHost must be a valid public hostname");
  ensureHome();
  const cur = loadConfig();
  const copied = copyConfig(patch);
  const next: ArtifactsConfig = { ...cur };
  if (copied.port !== undefined) next.port = copied.port;
  if (copied.host !== undefined) next.host = copied.host;
  if (copied.clientScheme !== undefined) next.clientScheme = copied.clientScheme;
  if (copied.publicBaseUrl !== undefined) next.publicBaseUrl = copied.publicBaseUrl;
  if (copied.publicHost !== undefined) next.publicHost = copied.publicHost;
  if (copied.publicScheme !== undefined) next.publicScheme = copied.publicScheme;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function localBaseUrl(cfg = loadConfig()): string { return `${cfg.clientScheme || "http"}://${cfg.host}:${cfg.port}`; }
