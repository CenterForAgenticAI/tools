// Lightweight applet discovery + per-applet storage helpers.
// Applets are intentionally simple: a directory under APPLETS_DIR with an
// applet.json manifest, static frontend files, and optionally a backend module.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { APPLET_DATA_DIR, APPLETS_DIR, ensureHome } from "./config.ts";

export interface AppletManifest {
  id: string;
  title: string;
  description?: string;
  entry?: string;
  backend?: string;
}

export interface AppletInfo extends AppletManifest {
  dir: string;
  url: string;
  apiUrl: string;
}

export interface AppletBackendContext {
  applet: AppletInfo;
  db: DatabaseSync;
  dataDir: string;
  readJsonBody<T = unknown>(limitBytes?: number): Promise<T>;
  send(status: number, body: string | Buffer, headers?: Record<string, string>): void;
  json(status: number, obj: unknown): void;
}

export type AppletBackendHandler = (req: IncomingMessage, res: ServerResponse, ctx: AppletBackendContext) => unknown | Promise<unknown>;

export function safeAppletId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);
}

export function appletsRoot(): string {
  ensureHome();
  fs.mkdirSync(APPLETS_DIR, { recursive: true });
  fs.mkdirSync(APPLET_DATA_DIR, { recursive: true });
  return APPLETS_DIR;
}

export function appletDataDir(id: string): string {
  if (!safeAppletId(id)) throw new Error("invalid applet id");
  const dir = path.join(APPLET_DATA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appletDbPath(id: string): string {
  return path.join(appletDataDir(id), "applet.db");
}

export function appletDb(id: string): DatabaseSync {
  const db = new DatabaseSync(appletDbPath(id));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

export function listApplets(): AppletInfo[] {
  const root = appletsRoot();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadApplet(entry.name))
    .filter((app): app is AppletInfo => app != null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getApplet(id: string): AppletInfo | null {
  if (!safeAppletId(id)) return null;
  return loadApplet(id);
}

function loadApplet(id: string): AppletInfo | null {
  if (!safeAppletId(id)) return null;
  const dir = path.join(appletsRoot(), id);
  const manifestPath = path.join(dir, "applet.json");
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Partial<AppletManifest>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const manifestId = String(manifest.id || id);
  if (manifestId !== id || !safeAppletId(manifestId)) return null;
  const title = String(manifest.title || id);
  const entry = cleanRelativePath(String(manifest.entry || "index.html"));
  const backend = manifest.backend ? cleanRelativePath(String(manifest.backend)) : undefined;
  return {
    id,
    title,
    description: manifest.description ? String(manifest.description) : undefined,
    entry,
    backend,
    dir,
    url: `/applets/${id}/`,
    apiUrl: `/api/applets/${id}/`,
  };
}

export function resolveAppletFile(app: AppletInfo, rel: string): string | null {
  const requested = rel === "" || rel === "/" ? app.entry || "index.html" : rel;
  const safe = cleanRelativePath(requested);
  const file = path.resolve(app.dir, safe);
  const root = path.resolve(app.dir);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

export async function loadBackend(app: AppletInfo): Promise<AppletBackendHandler | null> {
  if (!app.backend) return null;
  const file = resolveAppletFile(app, app.backend);
  if (!file) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const mod = await import(`${pathToFileURL(file).href}?mtime=${mtime}`);
  const handler = mod.handle || mod.default;
  return typeof handler === "function" ? handler as AppletBackendHandler : null;
}

function cleanRelativePath(input: string): string {
  return path.normalize(input).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
}
