// Zero-dependency HTTP daemon: explorer UI, viewers, and the register API.
// Run directly with Node 23+ (TS type-stripping): `node src/server.ts`
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  ensureHome,
  STAGING_DIR,
  REGISTER_HEADER,
  REGISTER_HEADER_VALUE,
  COMMENT_AGENT_HEADER,
  COMMENT_AGENT_HEADER_VALUE,
  PREVIEWSHIP_PUBLISH_HEADER,
  PREVIEWSHIP_PUBLISH_HEADER_VALUE,
} from "./config.ts";
import * as store from "./store.ts";
import * as annotations from "./annotations.ts";
import { appletDataDir, appletDb, getApplet, listApplets, loadBackend, resolveAppletFile } from "./applets.ts";
import {
  PreviewShipPublishError,
  publishArtifactToPreviewShip,
  type PreviewShipDeploy,
} from "./previewship.ts";
import { snapshotKindForMime } from "./retrieval.ts";
import { createTailscalePublicUrlProvider, explicitPublicUrlProvider, joinPublicUrl, unavailablePublicUrl, validatePublicBaseUrl, type PublicUrlProvider, type PublicUrlResolution } from "./public-url.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8", ...headers });
}

function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(res: http.ServerResponse, rel: string): void {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(WEB_DIR, safe);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, "Not found");
    return;
  }
  serveFile(res, file);
}

function serveFile(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  send(res, 200, buf, {
    "content-type": STATIC_MIME[ext] || "application/octet-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
}

function artifactJson(a: store.ArtifactRow & { size?: number | null; version_count?: number }) {
  return {
    ...a,
    tags: a.tags ? JSON.parse(a.tags) : [],
  };
}

function parseSort(value: string | null): store.ListOptions["sort"] {
  return value === "created" || value === "project" || value === "title" ? value : "modified";
}

async function readJsonObject(req: http.IncomingMessage, limitBytes = 256 * 1024): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "application/json content type is required");
  }
  try {
    const value: unknown = JSON.parse((await readBody(req, limitBytes)).toString("utf8") || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "payload too large") throw new HttpError(413, "annotation JSON payload too large", "ANNOTATION_INVALID");
    throw new HttpError(400, "invalid JSON");
  }
}

function expectedAnnotationRevision(req: http.IncomingMessage, artifactId: string): number {
  const match = new RegExp(`^W/"annotations-${artifactId}-(\\d+)"$`).exec(String(req.headers["if-match"] || ""));
  if (!match) throw new HttpError(428, "If-Match annotation ETag is required", "ANNOTATION_PRECONDITION_REQUIRED");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new HttpError(400, "invalid annotation ETag", "ANNOTATION_INVALID");
  return revision;
}

function assertAnnotationBodyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new HttpError(400, "unexpected annotation request field", "ANNOTATION_INVALID");
}

function annotationError(res: http.ServerResponse, error: unknown, artifactId?: string): void {
  const conflict = error instanceof annotations.AnnotationConflictError;
  const busy = error instanceof annotations.AnnotationBusyError;
  const operationCollision = error instanceof annotations.AnnotationOperationCollisionError;
  const itemConflict = error instanceof annotations.AnnotationItemConflictError;
  const forbidden = error instanceof annotations.AnnotationForbiddenError;
  const notFound = error instanceof Error && /artifact not found|annotation not found|snapshot version does not belong/.test(error.message);
  const status = conflict ? 412 : busy || operationCollision || itemConflict ? 409 : forbidden ? 403 : notFound ? 404 : error instanceof HttpError ? error.status : 400;
  const code = conflict ? "ANNOTATION_CONFLICT" : busy ? "ANNOTATION_BUSY" : operationCollision ? "ANNOTATION_OPERATION_COLLISION" : itemConflict ? "ANNOTATION_ITEM_CONFLICT" : forbidden ? "ANNOTATION_FORBIDDEN" : notFound ? "ANNOTATION_NOT_FOUND" : error instanceof annotations.AnnotationCorruptionError ? "ANNOTATION_INVALID" : error instanceof HttpError && error.code ? error.code : "ANNOTATION_INVALID";
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if ((conflict || itemConflict) && artifactId) headers.etag = annotations.annotationEtag(artifactId, error.currentRevision);
  if (busy) headers["retry-after"] = "1";
  json(res, status, {
    error: error instanceof Error ? error.message : "invalid annotation",
    code,
  }, headers);
}

function annotationFrameShell(nonce: string): string {
  // The bridge source is repository-controlled and injected before any authored markup (and
  // therefore before an authored meta CSP). Artifact bytes themselves are never interpolated
  // into the bridge script.
  return `<script nonce="${nonce}">${fs.readFileSync(path.join(WEB_DIR, "annotation-frame.js"), "utf8")}</script>`;
}

function annotationFrameDocument(authored: Buffer, nonce: string): Buffer {
  const html = authored.toString("utf8");
  const doctype = /^(?:\uFEFF?\s*)<!doctype[^>]*>/i.exec(html);
  const offset = doctype?.[0].length || 0;
  // Keep an authored doctype first so standards-mode layout is unchanged. A script token
  // between the doctype and `<html>` is parsed into the document head before any authored
  // meta CSP or script; documents without a doctype were already in quirks mode.
  return Buffer.from(`${html.slice(0, offset)}${annotationFrameShell(nonce)}${html.slice(offset)}`, "utf8");
}

function isLoopback(address?: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function mayUseLiveSource(req: http.IncomingMessage): boolean {
  return req.headers[REGISTER_HEADER] === REGISTER_HEADER_VALUE && isLoopback(req.socket.remoteAddress);
}

function validMime(value: string): boolean {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

function registerMetadata(
  payload: Record<string, unknown>,
  req: http.IncomingMessage,
  requestMime?: string | null,
): store.RegisterMetadataInput {
  if (typeof payload.title !== "string" || !payload.title.trim() ||
      typeof payload.project !== "string" || !payload.project.trim() ||
      (payload.mode !== "stored" && payload.mode !== "referenced")) {
    throw new HttpError(400, "title, project, and mode are required");
  }
  if (payload.kind !== undefined && !store.isArtifactKind(payload.kind)) {
    throw new HttpError(400, "invalid artifact kind");
  }
  const suppliedMime = typeof payload.mime === "string" ? payload.mime : requestMime?.split(";", 1)[0].trim() || null;
  if (suppliedMime && !validMime(suppliedMime)) throw new HttpError(400, "invalid MIME type");
  const liveTrusted = mayUseLiveSource(req);
  return {
    project: payload.project,
    projectPath: typeof payload.projectPath === "string" ? payload.projectPath : null,
    session: typeof payload.session === "string" ? payload.session : null,
    title: payload.title,
    filename: typeof payload.filename === "string" ? payload.filename : null,
    kind: store.isArtifactKind(payload.kind) ? payload.kind : undefined,
    mode: payload.mode,
    sourcePath: typeof payload.sourcePath === "string" ? payload.sourcePath : null,
    // This field is security-relevant when resolving live files, so never accept the
    // client's claim. Remote referenced paths remain useful metadata but are snapshot-only.
    sourceMachine: liveTrusted ? os.hostname() : `remote:${req.socket.remoteAddress || "unknown"}`,
    mime: suppliedMime,
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined,
    note: typeof payload.note === "string" ? payload.note : null,
    sourceMtime: typeof payload.sourceMtime === "number" ? payload.sourceMtime : null,
    slug: typeof payload.slug === "string" ? payload.slug : null,
  };
}

function parseMetadataHeader(req: http.IncomingMessage): Record<string, unknown> {
  const encoded = req.headers["x-artifact-metadata"];
  if (typeof encoded !== "string" || !encoded || encoded.length > MAX_METADATA_HEADER_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new HttpError(400, "x-artifact-metadata must be bounded base64url JSON");
  }
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.length > MAX_METADATA_HEADER_BYTES) throw new Error("metadata too large");
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("metadata must be an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid x-artifact-metadata JSON");
  }
}

function maxUploadBytes(options: ServerOptions): number {
  const configured = options.maxUploadBytes ?? Number(process.env.PI_ARTIFACTS_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

async function writeAll(file: fs.promises.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) throw new Error("failed to write staged artifact bytes");
    offset += bytesWritten;
  }
}

async function stageUpload(
  req: http.IncomingMessage,
  options: ServerOptions,
  activeStagingPaths: Set<string>,
): Promise<store.StagedArtifactContent> {
  ensureHome();
  const limit = maxUploadBytes(options);
  const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) throw new HttpError(400, "invalid Content-Length");
  if (declared !== null && declared > limit) throw new HttpError(413, `artifact exceeds ${limit} byte upload limit`);

  const stagedPath = path.join(STAGING_DIR, `upload-${crypto.randomUUID()}`);
  const file = await fs.promises.open(stagedPath, "wx", 0o600);
  activeStagingPaths.add(stagedPath);
  const hash = crypto.createHash("sha256");
  const sampleChunks: Buffer[] = [];
  let sampleSize = 0;
  let size = 0;
  req.setTimeout(options.uploadTimeoutMs ?? 60_000, () => req.destroy(new Error("artifact upload timed out")));
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > limit) throw new HttpError(413, `artifact exceeds ${limit} byte upload limit`);
      hash.update(chunk);
      if (sampleSize < SEARCH_SAMPLE_BYTES) {
        const prefix = chunk.subarray(0, SEARCH_SAMPLE_BYTES - sampleSize);
        sampleChunks.push(Buffer.from(prefix));
        sampleSize += prefix.length;
      }
      await writeAll(file, chunk);
    }
    if (declared !== null && size !== declared) throw new HttpError(400, "request body size does not match Content-Length");
    await file.sync();
    if ((await file.stat()).size !== size) throw new Error("staged artifact size mismatch");
    return { path: stagedPath, sha: hash.digest("hex"), size, sample: Buffer.concat(sampleChunks, sampleSize) };
  } catch (error) {
    activeStagingPaths.delete(stagedPath);
    await file.close().catch(() => undefined);
    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    try { req.setTimeout(0); } catch { /* socket may already be detached after an aborted upload */ }
    await file.close().catch(() => undefined);
  }
}

function registrationResponse(result: store.RegisterResult, publicBase: string) {
  return {
    ok: true,
    id: result.artifact.id,
    created: result.created,
    newVersion: result.newVersion,
    version: result.version.id,
    url: joinPublicUrl(publicBase, `/view/${result.artifact.id}`),
  };
}

interface ByteRange { start: number; end: number }
type ParsedByteRange =
  | { disposition: "partial"; range: ByteRange }
  | { disposition: "ignore" }
  | { disposition: "unsatisfiable" };

function parseByteRange(value: string, size: number): ParsedByteRange {
  const trimmed = value.trim();
  if (!/^bytes=/i.test(trimmed) || trimmed.includes(",")) return { disposition: "ignore" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match || (!match[1] && !match[2])) return { disposition: "ignore" };
  if (size <= 0) return { disposition: "unsatisfiable" };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return { disposition: "ignore" };
    if (suffix <= 0) return { disposition: "unsatisfiable" };
    return { disposition: "partial", range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return { disposition: "ignore" };
  if (requestedEnd < start || start >= size) return { disposition: "unsatisfiable" };
  return { disposition: "partial", range: { start, end: Math.min(requestedEnd, size - 1) } };
}

export interface ServerOptions {
  previewShipDeploy?: PreviewShipDeploy;
  maxUploadBytes?: number;
  maxConcurrentUploads?: number;
  uploadTimeoutMs?: number;
  stagingMaxAgeMs?: number;
  stagingSweepIntervalMs?: number;
  /** Inject deterministic daemon-side public URL resolution for tests and deployments. */
  publicUrlProvider?: PublicUrlProvider;
}

interface ServerRuntime {
  activeUploads: number;
  activeStagingPaths: Set<string>;
  publicUrl?: { expires: number; resolution: PublicUrlResolution };
}

const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_METADATA_HEADER_BYTES = 16 * 1024;
const SEARCH_SAMPLE_BYTES = 200_000;
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STAGING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanupStaleUploads(
  options: { now?: number; maxAgeMs?: number; activePaths?: ReadonlySet<string> } = {},
): number {
  ensureHome();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
  let removed = 0;
  for (const entry of fs.readdirSync(STAGING_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/^upload-[a-z0-9-]+$/i.test(entry.name)) continue;
    const file = path.join(STAGING_DIR, entry.name);
    if (options.activePaths?.has(file)) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < maxAgeMs) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch { /* raced with an active upload or another cleanup pass */ }
  }
  return removed;
}

async function resolvePublicUrl(options: ServerOptions, runtime: ServerRuntime): Promise<PublicUrlResolution> {
  const now = Date.now();
  if (runtime.publicUrl && runtime.publicUrl.expires > now && runtime.publicUrl.resolution.ok) return runtime.publicUrl.resolution;
  const cfg = loadConfig();
  const provider = options.publicUrlProvider || explicitPublicUrlProvider(cfg.publicBaseUrl || (cfg.publicHost ? `${cfg.publicScheme || "https"}://${cfg.publicHost}` : null)) || createTailscalePublicUrlProvider(cfg.port);
  let candidate: PublicUrlResolution;
  try { candidate = typeof provider === "function" ? await provider() : await provider.resolve(); }
  catch { candidate = unavailablePublicUrl("RUNNER_UNAVAILABLE", "Public URL discovery failed; configure publicBaseUrl explicitly."); }
  const providerUrl = candidate.ok ? validatePublicBaseUrl(candidate.publicBaseUrl) : null;
  const resolution = providerUrl
    ? { ok: true as const, publicBaseUrl: providerUrl }
    : candidate.ok
      ? unavailablePublicUrl("MALFORMED_MAPPING", "The public URL provider returned an unsafe URL; configure publicBaseUrl explicitly.")
      : candidate;
  if (resolution.ok) runtime.publicUrl = { expires: now + 5000, resolution };
  else runtime.publicUrl = undefined;
  return resolution;
}

function requirePublicUrl(resolution: PublicUrlResolution): string {
  if (resolution.ok) return resolution.publicBaseUrl;
  throw new HttpError(503, resolution.message, resolution.code);
}

export function createServer(options: ServerOptions = {}): http.Server {
  const runtime: ServerRuntime = { activeUploads: 0, activeStagingPaths: new Set() };
  cleanupStaleUploads({ maxAgeMs: options.stagingMaxAgeMs });
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, options, runtime);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(res, status, {
        error: String((err as Error)?.message || err),
        ...(err instanceof HttpError && err.code ? { code: err.code } : {}),
      });
      else res.destroy(err as Error);
    }
  });
  const sweep = setInterval(
    () => cleanupStaleUploads({ maxAgeMs: options.stagingMaxAgeMs, activePaths: runtime.activeStagingPaths }),
    options.stagingSweepIntervalMs ?? DEFAULT_STAGING_SWEEP_INTERVAL_MS,
  );
  sweep.unref();
  server.once("close", () => clearInterval(sweep));
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, options: ServerOptions, runtime: ServerRuntime): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;
  const method = req.method || "GET";

  // Health is deliberately available even while public URL discovery is unavailable.
  const publicResolution = await resolvePublicUrl(options, runtime);
  if (p === "/health" || p === "/api/health") {
    return json(res, 200, {
      ok: true,
      version: 2,
      capabilities: { streamingFileUpload: true, annotations: { schemaVersion: annotations.ANNOTATION_SCHEMA_VERSION, storage: "json-sidecar", etagCas: true, threadedReplies: true, agentComments: true } },
      home: process.env.PI_ARTIFACTS_HOME || "~/.pi/artifacts",
      publicUrlResolution: publicResolution,
      ...(publicResolution.ok ? { publicBaseUrl: publicResolution.publicBaseUrl } : {}),
    });
  }

  // ---- applets ----
  if (p === "/api/applets" && method === "GET") {
    const publicBase = requirePublicUrl(publicResolution);
    return json(res, 200, { applets: listApplets().map((app) => ({ ...app, url: joinPublicUrl(publicBase, app.url), apiUrl: joinPublicUrl(publicBase, app.apiUrl) })) });
  }

  const am = p.match(/^\/api\/applets\/([a-z0-9_-]+)(?:\/(.*))?$/i);
  if (am) {
    const app = getApplet(am[1]);
    if (!app) return json(res, 404, { error: "applet not found" });
    if (!am[2] && method === "GET") {
      const publicBase = requirePublicUrl(publicResolution);
      return json(res, 200, { applet: { ...app, url: joinPublicUrl(publicBase, app.url), apiUrl: joinPublicUrl(publicBase, app.apiUrl) } });
    }
    const handler = await loadBackend(app);
    if (!handler) return json(res, 404, { error: "applet has no backend" });
    const appDb = appletDb(app.id);
    try {
      const result = await handler(req, res, {
        applet: app,
        db: appDb,
        dataDir: appletDataDir(app.id),
        readJsonBody: async <T = unknown>(limitBytes?: number) => JSON.parse((await readBody(req, limitBytes)).toString("utf8") || "{}") as T,
        send: (status, body, headers = {}) => send(res, status, body, headers),
        json: (status, obj) => json(res, status, obj),
      });
      if (!res.writableEnded && result !== undefined) return json(res, 200, result);
      return;
    } finally {
      try { appDb.close(); } catch { /* ignore */ }
    }
  }

  // ---- register ----
  if (p === "/api/register-file" && method === "POST") {
    const maxConcurrent = options.maxConcurrentUploads ?? 4;
    if (runtime.activeUploads >= maxConcurrent) throw new HttpError(429, "too many concurrent artifact uploads");
    const payload = parseMetadataHeader(req);
    const metadata = registerMetadata(payload, req, req.headers["content-type"]);
    const publicBase = requirePublicUrl(publicResolution);
    runtime.activeUploads++;
    let staged: store.StagedArtifactContent | null = null;
    let stagedPath: string | null = null;
    try {
      staged = await stageUpload(req, options, runtime.activeStagingPaths);
      stagedPath = staged.path;
      const result = store.registerStagedArtifact(metadata, staged);
      staged = null; // adopted into the content-addressed blob store
      return json(res, 200, registrationResponse(result, publicBase));
    } finally {
      runtime.activeUploads--;
      if (stagedPath) runtime.activeStagingPaths.delete(stagedPath);
      if (staged) await fs.promises.rm(staged.path, { force: true }).catch(() => undefined);
    }
  }

  if (p === "/api/register" && method === "POST") {
    const raw = await readBody(req);
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("payload must be an object");
      payload = parsed as Record<string, unknown>;
    } catch { return json(res, 400, { error: "invalid JSON" }); }
    let metadata: store.RegisterMetadataInput;
    try { metadata = registerMetadata(payload, req); }
    catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      throw error;
    }
    const publicBase = requirePublicUrl(publicResolution);
    let content: Buffer;
    if (typeof payload.contentBase64 === "string") {
      content = Buffer.from(payload.contentBase64, "base64");
    } else if (mayUseLiveSource(req) && typeof payload.sourcePath === "string" && fs.existsSync(payload.sourcePath)) {
      content = fs.readFileSync(payload.sourcePath); // daemon-local fallback
    } else {
      return json(res, 400, { error: "no content: provide contentBase64 or a daemon-readable sourcePath" });
    }
    if (metadata.sourceMtime == null && mayUseLiveSource(req) && metadata.sourcePath && fs.existsSync(metadata.sourcePath)) {
      try { metadata.sourceMtime = Math.round(fs.statSync(metadata.sourcePath).mtimeMs); } catch { /* ignore */ }
    }
    const result = store.registerArtifact({ ...metadata, content });
    return json(res, 200, registrationResponse(result, publicBase));
  }

  // ---- list / projects ----
  if (p === "/api/list") {
    const items = store.listArtifacts({
      project: url.searchParams.get("project") || undefined,
      q: url.searchParams.get("q") || undefined,
      sort: parseSort(url.searchParams.get("sort")),
      includeArchived: url.searchParams.get("archived") === "1",
      limit: Number(url.searchParams.get("limit") || 500),
    });
    return json(res, 200, { items: items.map(artifactJson) });
  }
  if (p === "/api/projects") {
    return json(res, 200, { projects: store.projects() });
  }

  // ---- repair inferred type metadata ----
  if (p === "/api/repair-types" && method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const results = store.repairArtifactTypes({
      apply: body.apply === true,
      ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      includeArchived: body.includeArchived !== false,
    });
    return json(res, 200, { results });
  }

  // ---- publish to PreviewShip ----
  let m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/publish\/previewship$/);
  if (m && method === "POST") {
    if (req.headers[PREVIEWSHIP_PUBLISH_HEADER] !== PREVIEWSHIP_PUBLISH_HEADER_VALUE) {
      return json(res, 403, {
        error: "PreviewShip publishing requires an agent client request.",
        code: "PUBLISH_FORBIDDEN",
      });
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length) {
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be an object");
        body = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
    }
    if (body.projectName !== undefined && typeof body.projectName !== "string") {
      return json(res, 400, { error: "projectName must be a string", code: "INVALID_PROJECT_NAME" });
    }
    try {
      const publication = await publishArtifactToPreviewShip(
        m[1],
        { projectName: typeof body.projectName === "string" ? body.projectName : undefined },
        { deploy: options.previewShipDeploy },
      );
      return json(res, 200, publication);
    } catch (error) {
      if (error instanceof PreviewShipPublishError) {
        return json(res, error.status, { error: error.message, code: error.code });
      }
      throw error;
    }
  }

  // ---- immutable snapshot metadata ----
  m = p.match(/^\/api\/artifact\/([^/]+)\/snapshot$/);
  if (m && method === "GET") {
    const artifactId = m[1];
    if (!/^[a-f0-9]{12}$/.test(artifactId)) throw new HttpError(400, "invalid artifact id", "INVALID_ARTIFACT_ID");
    const artifact = store.getArtifact(artifactId);
    if (!artifact) throw new HttpError(404, "artifact not found", "ARTIFACT_NOT_FOUND");
    const rawVersion = url.searchParams.get("version");
    let versionId = artifact.current_version;
    if (rawVersion !== null) {
      if (!/^\d+$/.test(rawVersion)) throw new HttpError(400, "invalid snapshot version", "INVALID_VERSION");
      const parsed = Number(rawVersion);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, "invalid snapshot version", "INVALID_VERSION");
      versionId = parsed;
    }
    if (!Number.isSafeInteger(versionId) || (versionId as number) <= 0) throw new HttpError(404, "snapshot version not found", "VERSION_NOT_FOUND");
    const version = store.getVersion(versionId as number);
    if (!version || version.artifact_id !== artifactId) throw new HttpError(404, "snapshot version not found", "VERSION_NOT_FOUND");
    const resolved = store.resolveContentFile(artifactId, version.id, false);
    let available = false;
    try { available = !!resolved && fs.statSync(resolved.file).isFile(); } catch { /* report a stable snapshot error */ }
    if (!available) throw new HttpError(500, "snapshot bytes are unavailable", "SNAPSHOT_UNAVAILABLE");
    const currentVersion = artifact.current_version === version.id;
    const mime = version.mime || (currentVersion ? artifact.mime : null) || "application/octet-stream";
    return json(res, 200, {
      ok: true,
      metadata: {
        artifactId,
        version: version.id,
        title: artifact.title,
        kind: snapshotKindForMime(mime, currentVersion ? artifact.kind : "other"),
        mime,
        byteLength: version.size,
        sha256: version.blob,
      },
    }, { "cache-control": "no-store" });
  }

  // ---- single artifact metadata ----
  m = p.match(/^\/api\/artifact\/([a-f0-9]+)$/);
  if (m) {
    const a = store.getArtifact(m[1]);
    if (!a) return json(res, 404, { error: "not found" });
    const versions = store.getVersions(a.id);
    return json(res, 200, { artifact: artifactJson(a), versions });
  }

  // ---- version-pinned JSON-sidecar annotations ----
  m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/annotations$/);
  if (m) {
    res.setHeader("cache-control", "no-store");
    const artifactId = m[1];
    const artifact = store.getArtifact(artifactId);
    if (!artifact) return json(res, 404, { error: "not found" });
    if (method === "GET") {
      try {
        const sidecar = annotations.readSidecar(artifactId);
        const rawVersion = url.searchParams.get("version");
        // The comments tool's omitted version means the current immutable snapshot, never a
        // live referenced file. The viewer supplies a version explicitly while annotating.
        const version = rawVersion === null ? artifact.current_version : Number(rawVersion);
        if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) return json(res, 400, { error: "invalid snapshot version" });
        const versionId = Number(version);
        annotations.assertOwnedSnapshot(artifactId, versionId);
        const requestedStatus = url.searchParams.get("status");
        const status = requestedStatus === null ? null : requestedStatus;
        if (status !== null && status !== "open" && status !== "resolved") {
          return json(res, 400, { error: "invalid annotation status", code: "ANNOTATION_INVALID" });
        }
        // Return the collection, including records without this version's placement, so the
        // client can deterministically migrate them after it renders that snapshot.
        const withStatus = sidecar.annotations.map((annotation) => ({
          ...annotation,
          placementStatus: annotations.placementStatus(annotation, versionId),
        })).filter((annotation) => status === null || annotation.status === status);
        return json(res, 200, {
          schemaVersion: sidecar.schemaVersion,
          artifactId,
          title: artifact.title,
          currentVersion: artifact.current_version,
          viewerUrl: joinPublicUrl(requirePublicUrl(publicResolution), `/view/${artifactId}`),
          versionId,
          revision: sidecar.revision,
          annotations: withStatus,
          // `comments` is the stable agent-facing name; retain `annotations` for the viewer API.
          comments: withStatus,
        }, { etag: annotations.annotationEtag(artifactId, sidecar.revision), "cache-control": "no-store" });
      } catch (error) { return annotationError(res, error); }
    }
    if (method === "POST") {
      try {
        const body = await readJsonObject(req);
        assertAnnotationBodyKeys(body, ["versionId", "target", "body"]);
        const versionId = body.versionId;
        if (typeof versionId !== "number" || !Number.isSafeInteger(versionId) || versionId <= 0) throw new Error("invalid snapshot version");
        const target = annotations.validateSelector(body.target);
        if (typeof body.body !== "string" || !body.body.trim() || Buffer.byteLength(body.body, "utf8") > annotations.MAX_ANNOTATION_BODY_BYTES) throw new Error("invalid annotation body");
        const author = req.headers[COMMENT_AGENT_HEADER] === COMMENT_AGENT_HEADER_VALUE ? "agent" : "user";
        const revision = expectedAnnotationRevision(req, artifactId);
        const operationId = req.headers["x-pi-artifacts-operation-id"];
        if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{32}$/.test(operationId))) throw new HttpError(400, "invalid annotation operation id");
        if (typeof operationId === "string") {
          const existing = annotations.readSidecar(artifactId);
          const fingerprint = annotations.operationFingerprint("create", { versionId, target, body: body.body, ...(author === "agent" ? { author } : {}) });
          const receipt = existing.operations.find((candidate) => candidate.id === operationId);
          if (receipt) {
            if (receipt.kind !== "create" || receipt.fingerprint !== fingerprint) throw new annotations.AnnotationOperationCollisionError();
            return json(res, 200, { schemaVersion: existing.schemaVersion, revision: existing.revision, annotations: existing.annotations }, { etag: annotations.annotationEtag(artifactId, existing.revision), "cache-control": "no-store" });
          }
        }
        const sidecar = annotations.addAnnotation(artifactId, revision, { versionId, target, body: body.body, author, id: operationId });
        return json(res, 201, { schemaVersion: sidecar.schemaVersion, revision: sidecar.revision, annotations: sidecar.annotations }, { etag: annotations.annotationEtag(artifactId, sidecar.revision), "cache-control": "no-store" });
      } catch (error) { return annotationError(res, error, artifactId); }
    }
    res.setHeader("allow", "GET, POST"); return send(res, 405, "Method not allowed");
  }

  m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/annotation\/([a-f0-9]{32})\/replies$/);
  if (m) {
    const [artifactId, annotationId] = [m[1], m[2]];
    if (method !== "POST") { res.setHeader("allow", "POST"); return send(res, 405, "Method not allowed"); }
    try {
      const body = await readJsonObject(req);
      assertAnnotationBodyKeys(body, ["body", "expectedUpdatedAt"]);
      if (typeof body.body !== "string" || !body.body.trim() || Buffer.byteLength(body.body, "utf8") > annotations.MAX_ANNOTATION_BODY_BYTES) throw new annotations.AnnotationCorruptionError("invalid annotation reply body");
      const revision = expectedAnnotationRevision(req, artifactId);
      const operationId = req.headers["x-pi-artifacts-operation-id"];
      if (typeof operationId !== "string" || !/^[a-f0-9]{32}$/.test(operationId)) throw new HttpError(400, "annotation replies require an operation id", "ANNOTATION_INVALID");
      const author = req.headers[COMMENT_AGENT_HEADER] === COMMENT_AGENT_HEADER_VALUE ? "agent" : "user";
      const fingerprint = annotations.operationFingerprint("reply", { annotationId, body: body.body, author, expectedUpdatedAt: body.expectedUpdatedAt });
      const existing = annotations.readSidecar(artifactId);
      const receipt = existing.operations.find((candidate) => candidate.id === operationId);
      if (receipt) {
        if (receipt.kind !== "reply" || receipt.fingerprint !== fingerprint) throw new annotations.AnnotationOperationCollisionError();
        const annotation = existing.annotations.find((candidate) => candidate.id === annotationId);
        const reply = annotation?.replies.find((candidate) => candidate.id === operationId);
        if (!annotation || !reply) throw new annotations.AnnotationCorruptionError("annotation reply receipt is missing its reply");
        return json(res, 200, { schemaVersion: existing.schemaVersion, artifactId, revision: existing.revision, annotations: existing.annotations, annotationId, status: annotation.status, reply }, { etag: annotations.annotationEtag(artifactId, existing.revision), "cache-control": "no-store" });
      }
      const sidecar = annotations.addAnnotationReply(artifactId, revision, annotationId, { body: body.body, author, expectedUpdatedAt: body.expectedUpdatedAt }, operationId);
      const annotation = sidecar.annotations.find((candidate) => candidate.id === annotationId)!;
      const reply = annotation.replies.find((candidate) => candidate.id === operationId)!;
      return json(res, 201, { schemaVersion: sidecar.schemaVersion, artifactId, revision: sidecar.revision, annotations: sidecar.annotations, annotationId, status: annotation.status, reply }, { etag: annotations.annotationEtag(artifactId, sidecar.revision), "cache-control": "no-store" });
    } catch (error) { return annotationError(res, error, artifactId); }
  }

  m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/annotation\/([a-f0-9]{32})$/);
  if (m) {
    const [artifactId, annotationId] = [m[1], m[2]];
    if (method !== "PATCH" && method !== "DELETE") { res.setHeader("allow", "PATCH, DELETE"); return send(res, 405, "Method not allowed"); }
    try {
      const body = await readJsonObject(req);
      assertAnnotationBodyKeys(body, method === "PATCH" ? ["body", "status", "expectedUpdatedAt"] : ["expectedUpdatedAt"]);
      const revision = expectedAnnotationRevision(req, artifactId);
      const operationId = req.headers["x-pi-artifacts-operation-id"];
      if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{32}$/.test(operationId))) throw new HttpError(400, "invalid annotation operation id");
      const sidecar = method === "PATCH"
        ? annotations.updateAnnotation(artifactId, revision, annotationId, { body: body.body, status: body.status, expectedUpdatedAt: body.expectedUpdatedAt }, operationId)
        : annotations.removeAnnotation(artifactId, revision, annotationId, body.expectedUpdatedAt, operationId);
      return json(res, 200, { schemaVersion: sidecar.schemaVersion, revision: sidecar.revision, annotations: sidecar.annotations }, { etag: annotations.annotationEtag(artifactId, sidecar.revision), "cache-control": "no-store" });
    } catch (error) { return annotationError(res, error, artifactId); }
  }

  m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/annotations\/placements$/);
  if (m && method === "POST") {
    try {
      const body = await readJsonObject(req, 16 * 1024 * 1024);
      assertAnnotationBodyKeys(body, ["versionId", "placements"]);
      if (typeof body.versionId !== "number" || !Number.isSafeInteger(body.versionId) || body.versionId <= 0) throw new Error("invalid snapshot version");
      const operationId = req.headers["x-pi-artifacts-operation-id"];
      if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{32}$/.test(operationId))) throw new HttpError(400, "invalid annotation operation id");
      const sidecar = annotations.placeAnnotations(m[1], expectedAnnotationRevision(req, m[1]), body.versionId, body.placements, operationId);
      return json(res, 200, { schemaVersion: sidecar.schemaVersion, revision: sidecar.revision, annotations: sidecar.annotations }, { etag: annotations.annotationEtag(m[1], sidecar.revision), "cache-control": "no-store" });
    } catch (error) { return annotationError(res, error, m[1]); }
  }

  m = p.match(/^\/annotation-frame\/([a-f0-9]+)\/v\/(\d+)$/);
  if (m && method === "GET") {
    const resolved = store.resolveContentFile(m[1], Number(m[2]), false);
    const artifact = store.getArtifact(m[1]);
    if (!resolved || !artifact || artifact.kind !== "html") return send(res, 404, "Not found");
    let authored: Buffer; try { authored = fs.readFileSync(resolved.file); } catch { return send(res, 404, "Not found"); }
    const nonce = crypto.randomBytes(18).toString("base64url");
    return send(res, 200, annotationFrameDocument(authored, nonce), {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "x-pi-artifacts-csp-meta": "inline-bridge-before-authored-markup",
      "content-security-policy": `sandbox allow-scripts; default-src * data: blob:; script-src 'nonce-${nonce}'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
    });
  }

  // ---- mutations ----
  m = p.match(/^\/api\/artifact\/([a-f0-9]+)\/(archive|restore|delete|tag)$/);
  if (m && method === "POST") {
    const [, id, action] = m;
    if (action === "archive") return json(res, 200, { ok: store.archiveArtifact(id) });
    if (action === "restore") return json(res, 200, { ok: store.restoreArtifact(id) });
    if (action === "delete") {
      const deleted = store.deleteArtifact(id);
      if (deleted) annotations.deleteSidecar(id);
      return json(res, 200, { ok: deleted });
    }
    if (action === "tag") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      return json(res, 200, { ok: store.tagArtifact(id, body.tags || []) });
    }
  }

  // ---- raw bytes (pdf direct link, html iframe, downloads, version content) ----
  m = p.match(/^\/raw\/([a-f0-9]+)(?:\/v\/(\d+))?$/);
  if (m) {
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return send(res, 405, "Method not allowed");
    }
    const id = m[1];
    const versionId = m[2] ? Number(m[2]) : null;
    const preferLive = url.searchParams.get("live") !== "0";
    const resolved = store.resolveContentFile(id, versionId, preferLive);
    if (!resolved) return send(res, 404, "Not found");
    const a = store.getArtifact(id)!;
    const genericEmbed = a.kind === "other" && url.searchParams.get("embed") === "1";
    const dispo = url.searchParams.get("download") === "1" || (a.kind === "other" && !genericEmbed) ? "attachment" : "inline";
    const displayName = a.filename ? path.basename(a.filename) : a.title;
    const filename = displayName.replace(/[^\w.-]+/g, "_");
    let fd: number | null = null;
    let size: number;
    try {
      fd = fs.openSync(resolved.file, "r");
      size = fs.fstatSync(fd).size;
    } catch {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
      return send(res, 404, "Not found");
    }
    const headers: Record<string, string> = {
      "content-type": resolved.mime,
      "content-disposition": `${dispo}; filename="${filename}"`,
      "x-artifact-live": String(resolved.live),
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
    };
    if (genericEmbed) headers["content-security-policy"] = "sandbox";
    if (a.kind === "html") {
      // `sandbox allow-scripts` keeps executable reports opaque even when opened as raw,
      // while preserving authored CSS/JS/image assets. The unique origin plus no CORS on
      // daemon APIs prevents artifact code from reading or mutating registry state.
      headers["content-security-policy"] = "sandbox allow-scripts; default-src * data: blob:; script-src * 'unsafe-inline'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
    }
    if (resolved.mime === "image/svg+xml") headers["content-security-policy"] = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'";

    const rangeHeader = method === "GET" ? req.headers.range : undefined;
    const parsedRange = typeof rangeHeader === "string" ? parseByteRange(rangeHeader, size) : { disposition: "ignore" as const };
    if (parsedRange.disposition === "unsatisfiable") {
      fs.closeSync(fd);
      headers["content-range"] = `bytes */${size}`;
      headers["content-length"] = "0";
      return send(res, 416, "", headers);
    }
    const range = parsedRange.disposition === "partial" ? parsedRange.range : null;
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, size - 1);
    const length = range ? end - start + 1 : size;
    const status = range ? 206 : 200;
    headers["content-length"] = String(length);
    if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (method === "HEAD" || size === 0) {
      fs.closeSync(fd);
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved.file, { fd, autoClose: true, start, end });
    stream.on("error", (error) => res.destroy(error));
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return;
  }

  // ---- viewer wrapper ----
  m = p.match(/^\/view\/([a-f0-9]+)$/);
  if (m) {
    const a = store.getArtifact(m[1]);
    if (!a) return send(res, 404, "Not found");
    // PDFs: redirect straight to raw so the browser/native viewer handles it.
    if (a.kind === "pdf" && url.searchParams.get("wrap") !== "1") {
      res.writeHead(302, { location: `/raw/${a.id}` });
      res.end();
      return;
    }
    return serveStatic(res, "view.html");
  }

  // Generic viewer shell (no artifact id) so the service worker can precache the CURRENT viewer
  // shell on upgrade and serve any pinned artifact offline without falling back to the explorer.
  if (p === "/__view_shell__") return serveStatic(res, "view.html");

  // ---- applet index + frontend files ----
  if (p === "/applets" || p === "/applets/") return serveStatic(res, "applets.html");

  m = p.match(/^\/applets\/([a-z0-9_-]+)(?:\/(.*))?$/i);
  if (m) {
    const app = getApplet(m[1]);
    if (!app) return send(res, 404, "Applet not found");
    const rel = m[2] || "";
    const file = resolveAppletFile(app, rel) || (!path.extname(rel) ? resolveAppletFile(app, "") : null);
    if (!file) return send(res, 404, "Not found");
    return serveFile(res, file);
  }

  // ---- PWA: manifest + service worker + icons ----
  if (p === "/manifest.webmanifest") return serveStatic(res, "manifest.webmanifest");
  if (p === "/sw.js") {
    // Root-scoped service worker: served fresh so worker updates propagate quickly.
    const file = path.join(WEB_DIR, "sw.js");
    if (!fs.existsSync(file)) return send(res, 404, "Not found");
    return send(res, 200, fs.readFileSync(file), {
      "content-type": "text/javascript; charset=utf-8",
      "service-worker-allowed": "/",
      "cache-control": "no-cache",
    });
  }

  // ---- explorer ----
  if (p === "/" || p === "/index.html") return serveStatic(res, "index.html");

  // ---- static assets ----
  if (p.startsWith("/vendor/") || p.startsWith("/assets/") || p.startsWith("/icons/") || p.endsWith(".css") || p.endsWith(".js")) {
    return serveStatic(res, p.replace(/^\//, ""));
  }

  send(res, 404, "Not found");
}

// Boot when run directly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  ensureHome();
  const cfg = loadConfig();
  store.db(); // init schema
  const server = createServer();
  server.listen(cfg.port, cfg.host, async () => {
    const resolution = await resolvePublicUrl({}, { activeUploads: 0, activeStagingPaths: new Set() });
    console.log(resolution.ok
      ? `pi-artifacts daemon listening on http://${cfg.host}:${cfg.port}  (public: ${resolution.publicBaseUrl})`
      : `pi-artifacts daemon listening on http://${cfg.host}:${cfg.port}  (public unavailable: ${resolution.message})`);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { server.close(() => process.exit(0)); });
  }
}
