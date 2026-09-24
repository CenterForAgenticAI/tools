// Content-addressed artifact store + SQLite index + versioning + FTS search.
// Single-writer: only the daemon process touches this. Zero external deps.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { BLOBS_DIR, DB_PATH, STAGING_DIR, ensureHome } from "./config.ts";

export type ArtifactKind = "markdown" | "html" | "pdf" | "code" | "image" | "video" | "audio" | "other";
export type ArtifactMode = "stored" | "referenced";
export type PreviewShipVisibility = "PUBLIC" | "PASSWORD" | "PRIVATE";

export interface ArtifactRow {
  id: string;
  project: string;
  project_path: string | null;
  session: string | null;
  title: string;
  kind: ArtifactKind;
  mode: ArtifactMode;
  source_path: string | null;
  source_machine: string | null;
  mime: string | null;
  filename: string | null;
  tags: string | null; // JSON array string
  created_at: number;
  updated_at: number;
  current_version: number | null;
  archived: number;
  previewship_url: string | null;
  previewship_deployment_id: number | null;
  previewship_project_name: string | null;
  previewship_artifact_version: number | null;
  previewship_visibility: PreviewShipVisibility | null;
  previewship_published_at: number | null;
}

export interface VersionRow {
  id: number;
  artifact_id: string;
  blob: string;
  size: number;
  mime: string | null;
  note: string | null;
  source_mtime: number | null;
  created_at: number;
}

export interface RegisterInput {
  project: string;
  projectPath?: string | null;
  session?: string | null;
  title: string;
  kind?: ArtifactKind;
  mode: ArtifactMode;
  sourcePath?: string | null;
  sourceMachine?: string | null;
  mime?: string | null;
  tags?: string[];
  content: Buffer; // raw bytes (always uploaded => guaranteed snapshot)
  note?: string | null;
  sourceMtime?: number | null;
  /** explicit identity override; otherwise derived */
  slug?: string | null;
  /** original filename (with extension) used for kind/mime detection when title has none */
  filename?: string | null;
}

export type RegisterMetadataInput = Omit<RegisterInput, "content">;

/** A request body staged on the blob filesystem and hashed while it was received. */
export interface StagedArtifactContent {
  path: string;
  sha: string;
  size: number;
  /** Prefix used for signature detection and bounded FTS extraction. */
  sample: Buffer;
}

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  ensureHome();
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_path TEXT,
      session TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_path TEXT,
      source_machine TEXT,
      mime TEXT,
      filename TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      current_version INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      previewship_url TEXT,
      previewship_deployment_id INTEGER,
      previewship_project_name TEXT,
      previewship_artifact_version INTEGER,
      previewship_visibility TEXT,
      previewship_published_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      blob TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT,
      note TEXT,
      source_mtime INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_artifact ON versions(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project);
    CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON artifacts(updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS search
      USING fts5(id UNINDEXED, title, project, body);
  `);
  ensureArtifactsColumns(d);
  _db = d;
  return d;
}

function ensureArtifactsColumns(d: DatabaseSync): void {
  const cols = d.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const migrations: Array<[string, string]> = [
    ["filename", "TEXT"],
    ["previewship_url", "TEXT"],
    ["previewship_deployment_id", "INTEGER"],
    ["previewship_project_name", "TEXT"],
    ["previewship_artifact_version", "INTEGER"],
    ["previewship_visibility", "TEXT"],
    ["previewship_published_at", "INTEGER"],
  ];
  for (const [name, type] of migrations) {
    if (!names.has(name)) d.exec(`ALTER TABLE artifacts ADD COLUMN ${name} ${type}`);
  }
}

// ---------- helpers ----------

const CODE_EXTS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","py","rb","go","rs","java","kt","c","h","cpp","hpp","cc",
  "cs","php","swift","scala","sh","bash","zsh","fish","sql","json","yaml","yml","toml","ini",
  "xml","css","scss","less","lua","r","jl","pl","dart","ex","exs","elm","clj","hs","vue","svelte",
  "ndjson","jsonl",
]);
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","svg","bmp","avif","ico","tif","tiff","heic","heif"]);
const VIDEO_EXTS = new Set(["mp4","m4v","webm","mov","qt","ogv","avi","mkv","mpeg","mpg","3gp","3g2"]);
const AUDIO_EXTS = new Set(["mp3","wav","wave","ogg","oga","opus","m4a","aac","flac","weba","aif","aiff","caf","mid","midi"]);
const MP4_AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
const ARTIFACT_KINDS = new Set<ArtifactKind>(["markdown", "html", "pdf", "code", "image", "video", "audio", "other"]);

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.has(value as ArtifactKind);
}

export function detectKind(name: string, mime?: string | null): ArtifactKind {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (CODE_EXTS.has(ext) || ext === "txt" || ext === "log") return "code";
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown") return "markdown";
  if (mime === "application/x-ndjson") return "code";
  return "other";
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", mdx: "text/markdown",
  html: "text/html", htm: "text/html", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", qt: "video/quicktime", ogv: "video/ogg",
  avi: "video/x-msvideo", mkv: "video/x-matroska", mpeg: "video/mpeg",
  mpg: "video/mpeg", "3gp": "video/3gpp", "3g2": "video/3gpp2",
  mp3: "audio/mpeg", wav: "audio/wav", wave: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", weba: "audio/webm",
  aif: "audio/aiff", aiff: "audio/aiff", caf: "audio/x-caf", mid: "audio/midi", midi: "audio/midi",
  json: "application/json", txt: "text/plain", csv: "text/csv",
  js: "text/javascript", css: "text/css", xml: "application/xml",
  ndjson: "application/x-ndjson", jsonl: "application/x-ndjson",
};

export function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function isGenericMime(mime?: string | null): boolean {
  return !mime || mime === "application/octet-stream" || mime === "binary/octet-stream";
}

function mimeForKind(kind: ArtifactKind, fallback = "application/octet-stream"): string {
  if (kind === "markdown") return "text/markdown";
  if (kind === "html") return "text/html";
  if (kind === "pdf") return "application/pdf";
  if (kind === "code") return fallback === "application/octet-stream" ? "text/plain" : fallback;
  return fallback;
}

export interface InferredArtifactMetadata {
  kind: ArtifactKind;
  mime: string;
}

export function sniffContentKind(buf: Buffer): InferredArtifactMetadata | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString("latin1");
    if (sig === "GIF87a" || sig === "GIF89a") return { kind: "image", mime: "image/gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF") {
    const form = buf.subarray(8, 12).toString("latin1");
    if (form === "WEBP") return { kind: "image", mime: "image/webp" };
    if (form === "WAVE") return { kind: "audio", mime: "audio/wav" };
    if (form === "AVI ") return { kind: "video", mime: "video/x-msvideo" };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "fLaC") return { kind: "audio", mime: "audio/flac" };
  if (buf.length >= 3 && buf.subarray(0, 3).toString("latin1") === "ID3") return { kind: "audio", mime: "audio/mpeg" };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync (MP3) or ADTS AAC. Layer bits 00 are reserved in MP3 and
    // identify the common ADTS shape; otherwise prefer audio/mpeg.
    return (buf[1] & 0x06) === 0 ? { kind: "audio", mime: "audio/aac" } : { kind: "audio", mime: "audio/mpeg" };
  }
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    return MP4_AUDIO_BRANDS.has(brand) ? { kind: "audio", mime: "audio/mp4" } : { kind: "video", mime: "video/mp4" };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "OggS") {
    const header = buf.subarray(0, Math.min(buf.length, 256)).toString("latin1");
    if (/theora/i.test(header)) return { kind: "video", mime: "video/ogg" };
    if (/OpusHead|vorbis|Speex/i.test(header)) return { kind: "audio", mime: "audio/ogg" };
  }

  const sample = buf.subarray(0, Math.min(buf.length, 64_000)).toString("utf8").replace(/^\uFEFF/, "");
  // If decoding produced many replacement chars, treat this as binary and avoid text heuristics.
  const replacementCount = (sample.match(/\uFFFD/g) || []).length;
  if (replacementCount > Math.max(8, sample.length * 0.01)) return null;

  const text = sample.trimStart();
  if (/^<!doctype\s+html\b/i.test(text) || /^<html[\s>]/i.test(text)) return { kind: "html", mime: "text/html" };

  // Conservative Markdown detection for extensionless generated reports.  Avoid treating all
  // arbitrary plain text as Markdown: require a strong top-level signal or multiple weaker ones.
  const strongHeading = /^#{1,6}\s+\S/m.test(text);
  const frontMatter = /^---\s*\n[\s\S]{0,2000}?\n---\s*(\n|$)/.test(text);
  const fenced = /(^|\n)```[\s\S]*?(\n|$)/.test(text);
  const table = /(^|\n)\|[^\n]+\|\s*\n\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|/.test(text);
  const list = /(^|\n)\s*([-*+] |\d+\. )\S/.test(text);
  const emphasis = /(^|\s)(\*\*|__)[^\n]+(\*\*|__)(\s|$)/.test(text);
  const markdownSignals = [frontMatter, fenced, table, list, emphasis].filter(Boolean).length;
  if (strongHeading || (frontMatter && markdownSignals >= 1) || markdownSignals >= 2) return { kind: "markdown", mime: "text/markdown" };

  return null;
}

export function inferArtifactMetadata(name: string, mime?: string | null, content?: Buffer): InferredArtifactMetadata {
  const extensionKind = detectKind(name);
  const mimeKind = detectKind("", mime);
  const sniffed = content ? sniffContentKind(content) : null;
  const sniffedBinary = sniffed && !["markdown", "html"].includes(sniffed.kind) ? sniffed : null;
  let kind = extensionKind !== "other" ? extensionKind : mimeKind !== "other" ? mimeKind : sniffed?.kind || "other";
  // Strong binary signatures override contradictory or generic client metadata. Text
  // heuristics stay conservative so a Markdown-looking .txt file remains plain text.
  // A generic ISO BMFF brand cannot distinguish audio-only M4A from video MP4, so retain
  // an explicit audio/mp4 extension or MIME signal in that one ambiguous case.
  const ambiguousAudioMp4 = sniffedBinary?.mime === "video/mp4" &&
    (extensionKind === "audio" || (mimeKind === "audio" && mime === "audio/mp4"));
  if (sniffedBinary && sniffedBinary.kind !== kind && !ambiguousAudioMp4) kind = sniffedBinary.kind;

  let finalMime = mime || guessMime(name);
  const mimeContradictsKind = mimeKind !== "other" && mimeKind !== kind;
  if (sniffed?.kind === kind && (isGenericMime(finalMime) || mimeContradictsKind || extensionKind === "other")) {
    finalMime = sniffed.mime;
  } else if (isGenericMime(finalMime) || mimeContradictsKind ||
      (kind === "markdown" && finalMime === "text/plain") || (kind === "html" && finalMime === "text/plain")) {
    const guessed = guessMime(name);
    finalMime = !isGenericMime(guessed) && detectKind(name) === kind ? guessed : mimeForKind(kind, finalMime);
  }
  return { kind, mime: finalMime };
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function blobPath(sha: string): string {
  return path.join(BLOBS_DIR, sha.slice(0, 2), sha);
}

function writeBlob(buf: Buffer): { sha: string; size: number } {
  const sha = sha256(buf);
  const p = blobPath(sha);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  return { sha, size: buf.length };
}

export function blobFile(sha: string): string {
  return blobPath(sha);
}

function identityKey(project: string, mode: ArtifactMode, sourcePath?: string | null, title?: string, slug?: string | null): string {
  if (slug) return `${project}|slug:${slug}`;
  if (mode === "referenced" && sourcePath) return `${project}|ref:${sourcePath}`;
  return `${project}|title:${title}`;
}

function idFor(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function extractText(kind: ArtifactKind, buf: Buffer): string {
  if (kind === "markdown" || kind === "code") return buf.toString("utf8").slice(0, 200_000);
  if (kind === "html") {
    return buf
      .toString("utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 200_000);
  }
  return "";
}

// ---------- core operations ----------

export interface RegisterResult {
  artifact: ArtifactRow;
  version: VersionRow;
  created: boolean;       // new artifact?
  newVersion: boolean;    // content changed => new version row?
}

export function registerArtifact(input: RegisterInput): RegisterResult {
  const blob = writeBlob(input.content);
  return registerPreparedArtifact(input, blob.sha, blob.size, input.content);
}

/** Adopt a body staged by the HTTP server without loading the complete file into memory. */
export function registerStagedArtifact(input: RegisterMetadataInput, staged: StagedArtifactContent): RegisterResult {
  if (!/^[a-f0-9]{64}$/.test(staged.sha) || !Number.isSafeInteger(staged.size) || staged.size < 0) {
    throw new Error("invalid staged artifact metadata");
  }
  const stagedPath = path.resolve(staged.path);
  if (!stagedPath.startsWith(path.resolve(STAGING_DIR) + path.sep)) throw new Error("staged artifact is outside the staging directory");
  const destination = blobPath(staged.sha);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    fs.rmSync(stagedPath, { force: true });
  } else {
    try {
      fs.renameSync(stagedPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      fs.copyFileSync(stagedPath, destination, fs.constants.COPYFILE_EXCL);
      fs.rmSync(stagedPath, { force: true });
    }
  }
  return registerPreparedArtifact(input, staged.sha, staged.size, staged.sample);
}

function registerPreparedArtifact(
  input: RegisterMetadataInput,
  sha: string,
  size: number,
  sample: Buffer,
): RegisterResult {
  const d = db();
  const now = Date.now();
  const filename = input.filename || (input.sourcePath ? path.basename(input.sourcePath) : null) || null;
  const detectName = filename || input.title;
  const inferred = inferArtifactMetadata(detectName, input.mime, sample);
  const kind = inferred.kind === "other" && isArtifactKind(input.kind) ? input.kind : inferred.kind;
  const mime = inferred.mime;
  const key = identityKey(input.project, input.mode, input.sourcePath, input.title, input.slug);
  const id = idFor(key);
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = d.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    const tagsJson = input.tags ? JSON.stringify(input.tags) : (existing?.tags ?? null);

    const created = !existing;
    if (!existing) {
      d.prepare(`INSERT INTO artifacts
        (id, project, project_path, session, title, kind, mode, source_path, source_machine, mime, filename, tags, created_at, updated_at, current_version, archived)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
        id, input.project, input.projectPath ?? null, input.session ?? null, input.title,
        kind, input.mode, input.sourcePath ?? null, input.sourceMachine ?? null, mime, filename, tagsJson,
        now, now, null,
      );
    }

    const last = d.prepare("SELECT * FROM versions WHERE artifact_id = ? ORDER BY id DESC LIMIT 1").get(id) as unknown as VersionRow | undefined;
    let version: VersionRow;
    const newVersion = !last || last.blob !== sha;
    if (!newVersion) {
      version = last;
    } else {
      d.prepare(`INSERT INTO versions (artifact_id, blob, size, mime, note, source_mtime, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, sha, size, mime, input.note ?? null, input.sourceMtime ?? null, now);
      version = d.prepare("SELECT * FROM versions WHERE artifact_id = ? ORDER BY id DESC LIMIT 1").get(id) as unknown as VersionRow;
    }
    if (version.mime !== mime) {
      d.prepare("UPDATE versions SET mime = ? WHERE id = ?").run(mime, version.id);
      version = d.prepare("SELECT * FROM versions WHERE id = ?").get(version.id) as unknown as VersionRow;
    }

    d.prepare(`UPDATE artifacts SET
        project=?, project_path=COALESCE(?, project_path), session=COALESCE(?, session),
        title=?, kind=?, mode=?, source_path=?, source_machine=COALESCE(?, source_machine),
        mime=?, filename=COALESCE(?, filename), tags=?, updated_at=?, current_version=?, archived=0
        WHERE id=?`).run(
      input.project, input.projectPath ?? null, input.session ?? null,
      input.title, kind, input.mode, input.sourcePath ?? null, input.sourceMachine ?? null,
      mime, filename, tagsJson, now, version.id, id,
    );

    const body = extractText(kind, sample);
    d.prepare("DELETE FROM search WHERE id = ?").run(id);
    d.prepare("INSERT INTO search (id, title, project, body) VALUES (?,?,?,?)")
      .run(id, input.title, input.project, body);

    const artifact = d.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as ArtifactRow;
    d.exec("COMMIT");
    return { artifact, version, created, newVersion };
  } catch (error) {
    try { d.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

export interface ListOptions {
  project?: string;
  q?: string;
  sort?: "modified" | "created" | "project" | "title";
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListItem extends ArtifactRow {
  size: number | null;
  version_count: number;
}

export function listArtifacts(opts: ListOptions = {}): ListItem[] {
  const d = db();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.includeArchived) where.push("a.archived = 0");
  if (opts.project) { where.push("a.project = ?"); params.push(opts.project); }
  let idFilter = "";
  if (opts.q && opts.q.trim()) {
    const ids = d.prepare("SELECT id FROM search WHERE search MATCH ?")
      .all(ftsQuery(opts.q)) as unknown as { id: string }[];
    if (ids.length === 0) return [];
    idFilter = ` AND a.id IN (${ids.map(() => "?").join(",")})`;
    params.push(...ids.map((r) => r.id));
  }
  const order =
    opts.sort === "created" ? "a.created_at DESC" :
    opts.sort === "project" ? "a.project ASC, a.updated_at DESC" :
    opts.sort === "title" ? "a.title ASC" :
    "a.updated_at DESC";
  const sql = `
    SELECT a.*, v.size AS size,
      (SELECT COUNT(*) FROM versions vv WHERE vv.artifact_id = a.id) AS version_count
    FROM artifacts a
    LEFT JOIN versions v ON v.id = a.current_version
    ${where.length ? "WHERE " + where.join(" AND ") : ""}${idFilter}
    ORDER BY ${order}
    LIMIT ? OFFSET ?`;
  params.push(opts.limit ?? 500, opts.offset ?? 0);
  return d.prepare(sql).all(...params) as unknown as ListItem[];
}

function ftsQuery(q: string): string {
  // Make a forgiving prefix query out of free text.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

export function getArtifact(id: string): ArtifactRow | undefined {
  return db().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as ArtifactRow | undefined;
}

export function getVersions(id: string): VersionRow[] {
  return db().prepare("SELECT * FROM versions WHERE artifact_id = ? ORDER BY id DESC").all(id) as unknown as VersionRow[];
}

export function getVersion(versionId: number): VersionRow | undefined {
  return db().prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as unknown as VersionRow | undefined;
}

export function projects(): { project: string; project_path: string | null; count: number; updated_at: number }[] {
  return db().prepare(
    `SELECT project,
            MAX(project_path) AS project_path,
            COUNT(*) AS count,
            MAX(updated_at) AS updated_at
     FROM artifacts WHERE archived = 0
     GROUP BY project ORDER BY project`,
  ).all() as unknown as { project: string; project_path: string | null; count: number; updated_at: number }[];
}

export interface ResolvedContentFile {
  file: string;
  mime: string;
  live: boolean;
  version: VersionRow;
}

/** Resolve a file to serve. Prefers live source for referenced artifacts; falls back to snapshot. */
export function resolveContentFile(
  id: string,
  versionId?: number | null,
  preferLive = true,
): ResolvedContentFile | null {
  const art = getArtifact(id);
  if (!art) return null;
  if (versionId) {
    const v = getVersion(versionId);
    if (!v || v.artifact_id !== id) return null;
    const file = blobFile(v.blob);
    return fs.existsSync(file) ? { file, mime: v.mime || art.mime || "application/octet-stream", live: false, version: v } : null;
  }
  const cur = art.current_version ? getVersion(art.current_version) : undefined;
  if (!cur) return null;
  if (preferLive && art.mode === "referenced" && art.source_path && art.source_machine === os.hostname()) {
    try {
      if (fs.statSync(art.source_path).isFile()) return { file: art.source_path, mime: art.mime || "application/octet-stream", live: true, version: cur };
    } catch { /* fall through to snapshot */ }
  }
  const file = blobFile(cur.blob);
  return fs.existsSync(file) ? { file, mime: cur.mime || art.mime || "application/octet-stream", live: false, version: cur } : null;
}

export interface RepairTypesOptions {
  apply?: boolean;
  ids?: string[];
  includeArchived?: boolean;
}

export interface RepairTypesResult {
  id: string;
  title: string;
  version: number;
  before: { kind: ArtifactKind; mime: string | null; versionMime: string | null; filename: string | null };
  after: { kind: ArtifactKind; mime: string; versionMime: string; filename: string | null };
  changed: boolean;
  applied: boolean;
  reason: string;
}

function allArtifactsForRepair(opts: RepairTypesOptions): ArtifactRow[] {
  const d = db();
  if (opts.ids?.length) {
    return d.prepare(`SELECT * FROM artifacts WHERE id IN (${opts.ids.map(() => "?").join(",")})`)
      .all(...opts.ids) as unknown as ArtifactRow[];
  }
  const where = opts.includeArchived === false ? "WHERE archived = 0" : "";
  return d.prepare(`SELECT * FROM artifacts ${where} ORDER BY updated_at DESC`).all() as unknown as ArtifactRow[];
}

export function repairArtifactTypes(opts: RepairTypesOptions = {}): RepairTypesResult[] {
  const d = db();
  const now = Date.now();
  const results: RepairTypesResult[] = [];
  for (const a of allArtifactsForRepair(opts)) {
    if (!a.current_version) continue;
    const v = getVersion(a.current_version);
    if (!v) continue;
    let buffer: Buffer;
    try { buffer = fs.readFileSync(blobFile(v.blob)); } catch { continue; }
    const filename = a.filename || (a.source_path ? path.basename(a.source_path) : null);
    const detectName = filename || a.title;
    const inferred = inferArtifactMetadata(detectName, a.mime || v.mime, buffer);

    const shouldTrustInferredKind = a.kind === "other" || isGenericMime(a.mime) || isGenericMime(v.mime) || inferred.kind === a.kind;
    const nextKind = shouldTrustInferredKind ? inferred.kind : a.kind;
    const nextMime = (isGenericMime(a.mime) || a.mime !== inferred.mime || nextKind !== a.kind)
      ? mimeForKind(nextKind, inferred.mime)
      : (a.mime || inferred.mime);
    const nextVersionMime = (isGenericMime(v.mime) || v.mime !== nextMime) ? nextMime : (v.mime || nextMime);

    const changed = nextKind !== a.kind || nextMime !== a.mime || nextVersionMime !== v.mime;
    const reason = changed
      ? `inferred ${nextKind}/${nextMime} from ${filename ? "filename/content" : "content"}`
      : "metadata already matches inferred format";
    if (changed && opts.apply) {
      d.prepare("UPDATE artifacts SET kind = ?, mime = ?, filename = COALESCE(?, filename), updated_at = ? WHERE id = ?")
        .run(nextKind, nextMime, filename, now, a.id);
      d.prepare("UPDATE versions SET mime = ? WHERE id = ?").run(nextVersionMime, v.id);
      const body = extractText(nextKind, buffer);
      d.prepare("DELETE FROM search WHERE id = ?").run(a.id);
      d.prepare("INSERT INTO search (id, title, project, body) VALUES (?,?,?,?)")
        .run(a.id, a.title, a.project, body);
    }
    results.push({
      id: a.id,
      title: a.title,
      version: v.id,
      before: { kind: a.kind, mime: a.mime, versionMime: v.mime, filename: a.filename },
      after: { kind: nextKind, mime: nextMime, versionMime: nextVersionMime, filename },
      changed,
      applied: changed && opts.apply === true,
      reason,
    });
  }
  return results;
}

export function archiveArtifact(id: string): boolean {
  const r = db().prepare("UPDATE artifacts SET archived = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  return r.changes > 0;
}

export function restoreArtifact(id: string): boolean {
  const r = db().prepare("UPDATE artifacts SET archived = 0, updated_at = ? WHERE id = ?").run(Date.now(), id);
  return r.changes > 0;
}

export function deleteArtifact(id: string): boolean {
  const d = db();
  const r = d.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  d.prepare("DELETE FROM versions WHERE artifact_id = ?").run(id);
  d.prepare("DELETE FROM search WHERE id = ?").run(id);
  return r.changes > 0;
  // Blobs are left content-addressed (shared); prune via `pi-artifacts gc`.
}

export function tagArtifact(id: string, tags: string[]): boolean {
  const r = db().prepare("UPDATE artifacts SET tags = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(tags), Date.now(), id);
  return r.changes > 0;
}

export interface PreviewShipPublicationInput {
  artifactId: string;
  artifactVersion: number;
  projectName: string;
  deploymentId: number;
  previewUrl: string;
  visibility: PreviewShipVisibility | null;
  publishedAt: number;
}

export function recordPreviewShipPublication(input: PreviewShipPublicationInput): ArtifactRow | undefined {
  const result = db().prepare(`UPDATE artifacts SET
      previewship_url = ?, previewship_deployment_id = ?, previewship_project_name = ?,
      previewship_artifact_version = ?, previewship_visibility = ?, previewship_published_at = ?,
      updated_at = ?
      WHERE id = ?`).run(
    input.previewUrl,
    input.deploymentId,
    input.projectName,
    input.artifactVersion,
    input.visibility,
    input.publishedAt,
    input.publishedAt,
    input.artifactId,
  );
  return result.changes > 0 ? getArtifact(input.artifactId) : undefined;
}
