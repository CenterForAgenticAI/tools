// Tiny HTTP client used by both the pi extension and the CLI to talk to the daemon.
// node builtins only (so it loads cleanly under jiti inside pi).
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  localBaseUrl,
  COMMENT_AGENT_HEADER,
  COMMENT_AGENT_HEADER_VALUE,
  PREVIEWSHIP_PUBLISH_HEADER,
  PREVIEWSHIP_PUBLISH_HEADER_VALUE,
  REGISTER_HEADER,
  REGISTER_HEADER_VALUE,
  type ArtifactsConfig,
} from "./config.ts";
import { joinPublicUrl, validatePublicBaseUrl } from "./public-url.ts";
import type { PublishArtifactOptions, PreviewShipPublication } from "./previewship.ts";
import {
  ArtifactRetrievalError,
  INLINE_ARTIFACT_TEXT_MAX_BYTES,
  isInlineSnapshot,
  isArtifactKind,
  isArtifactMime,
  type ArtifactMaterializationReason,
  type ArtifactSnapshotMetadata,
  type ArtifactSnapshotSuccess,
} from "./retrieval.ts";

export interface RegisterPayload {
  project: string;
  projectPath?: string | null;
  session?: string | null;
  title: string;
  filename?: string | null;
  kind?: string;
  mode: "stored" | "referenced";
  sourcePath?: string | null;
  sourceMachine?: string | null;
  mime?: string | null;
  tags?: string[];
  contentBase64?: string;
  note?: string | null;
  sourceMtime?: number | null;
  slug?: string | null;
}

export type JsonRecord = Record<string, unknown>;

export interface RegisterResponse extends JsonRecord {
  ok: boolean;
  id: string;
  created: boolean;
  newVersion: boolean;
  version: number;
  url: string;
}

export interface ArtifactListItem extends JsonRecord {
  id: string;
  kind: string;
  project: string;
  title: string;
  version_count: number;
}

export interface AppletListItem extends JsonRecord {
  id: string;
  title: string;
  url: string;
  apiUrl: string;
  description?: string;
}

export interface ArtifactTextSelector extends JsonRecord {
  type: "text";
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}
export interface ArtifactHtmlSelector extends Omit<ArtifactTextSelector, "type"> {
  type: "html";
  selector: string;
}
export type ArtifactAnnotationSelector = ArtifactTextSelector | ArtifactHtmlSelector;
export interface ArtifactAnnotationOrigin extends JsonRecord {
  versionId: number;
  blob: string;
  representationVersion: 1;
  target: ArtifactAnnotationSelector;
}
export interface ArtifactPlacementProvenance extends JsonRecord {
  representationVersion: 1;
  sourceVersionId: number;
  sourceBlob: string;
  method: "exact-position" | "unique-context" | "ambiguous" | "not-found";
  confidence: "high" | "none";
  placedAt: number;
}
export type ArtifactAnnotationPlacement =
  | { versionId: number; state: "anchored" | "migrated"; target: ArtifactAnnotationSelector; provenance: ArtifactPlacementProvenance }
  | { versionId: number; state: "ambiguous" | "orphaned"; reason: "ambiguous" | "not-found"; provenance: ArtifactPlacementProvenance };
export type ArtifactCommentAuthor = "user" | "agent";
export interface ArtifactCommentReply extends JsonRecord {
  id: string;
  body: string;
  author: ArtifactCommentAuthor;
  createdAt: number;
}
export interface ArtifactComment extends JsonRecord {
  id: string;
  body: string;
  author: ArtifactCommentAuthor;
  createdAt: number;
  updatedAt: number;
  origin: ArtifactAnnotationOrigin;
  placements: ArtifactAnnotationPlacement[];
  replies: ArtifactCommentReply[];
  status: "open" | "resolved";
  placementStatus: "anchored" | "migrated" | "ambiguous" | "orphaned" | "unplaced";
}

export interface ArtifactCommentsResponse extends JsonRecord {
  artifactId: string;
  title: string;
  currentVersion: number;
  viewerUrl: string;
  versionId: number;
  revision: number;
  comments: ArtifactComment[];
}
export type AnnotationStatus = ArtifactComment["status"];
export interface ArtifactCommentCreateResult extends JsonRecord {
  artifactId: string;
  revision: number;
  comment: ArtifactComment;
}
export interface ArtifactCommentReplyResult extends JsonRecord {
  artifactId: string;
  annotationId: string;
  revision: number;
  status: AnnotationStatus;
  reply: ArtifactCommentReply;
}

export interface RepairTypesResult extends JsonRecord {
  id: string;
  title: string;
  changed: boolean;
  before: {
    kind: string;
    mime: string | null;
    versionMime: string | null;
  };
  after: {
    kind: string;
    mime: string;
    versionMime: string;
  };
}

const LEGACY_FALLBACK_MAX_FILE_BYTES = 45 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function hasPublicRoutePath(pathname: string, route: string): boolean {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized === route || (normalized.endsWith(route) && normalized[normalized.length - route.length - 1] === "/");
}

function asArtifactListItem(value: unknown): ArtifactListItem | null {
  if (!isRecord(value)) return null;
  return {
    ...value,
    id: asString(value.id),
    kind: asString(value.kind),
    project: asString(value.project),
    title: asString(value.title),
    version_count: asNumber(value.version_count),
  };
}

function asRegisterResponse(value: unknown): RegisterResponse {
  if (!isRecord(value)) throw new Error("register failed: invalid daemon response");
  const id = asString(value.id);
  const url = typeof value.url === "string" ? validatePublicBaseUrl(value.url) : null;
  let path = "";
  try { path = url ? new URL(url).pathname : ""; } catch { /* validated URL cannot fail */ }
  if (value.ok !== true || !/^[a-f0-9]{12}$/.test(id) || !url || !hasPublicRoutePath(path, `/view/${id}`) || !Number.isSafeInteger(value.version) || Number(value.version) <= 0) throw new Error("register failed: invalid daemon response");
  return { ok: true, id, created: value.created === true, newVersion: value.newVersion === true, version: value.version as number, url };
}

function asPreviewShipPublication(value: unknown): PreviewShipPublication {
  if (!isRecord(value) || value.ok !== true) throw new Error("PreviewShip publish failed: invalid daemon response");
  const artifactId = asString(value.artifactId);
  const projectName = asString(value.projectName);
  const previewUrl = asString(value.previewUrl);
  const artifactVersion = asNumber(value.artifactVersion);
  const deploymentId = asNumber(value.deploymentId);
  const publishedAt = asNumber(value.publishedAt);
  if (!artifactId || !projectName || !previewUrl || artifactVersion <= 0 || deploymentId <= 0 || publishedAt <= 0) {
    throw new Error("PreviewShip publish failed: invalid daemon response");
  }
  const visibility = value.visibility === "PUBLIC" || value.visibility === "PASSWORD" || value.visibility === "PRIVATE"
    ? value.visibility
    : null;
  return {
    ok: true,
    artifactId,
    artifactVersion,
    projectName,
    deploymentId,
    previewUrl,
    visibility,
    publishedAt,
  };
}

function asAppletListItem(value: unknown): AppletListItem | null {
  if (!isRecord(value)) return null;
  const url = typeof value.url === "string" ? validatePublicBaseUrl(value.url) : null;
  const apiUrl = typeof value.apiUrl === "string" ? validatePublicBaseUrl(value.apiUrl) : null;
  const id = asString(value.id);
  let urlPath = "", apiPath = "";
  try { urlPath = url ? new URL(url).pathname : ""; apiPath = apiUrl ? new URL(apiUrl).pathname : ""; } catch { /* validated URLs cannot fail */ }
  if (!url || !apiUrl || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || !asString(value.title) || !hasPublicRoutePath(urlPath, `/applets/${id}`) || !hasPublicRoutePath(apiPath, `/api/applets/${id}`)) return null;
  return { id, title: value.title as string, url, apiUrl, ...(typeof value.description === "string" ? { description: value.description } : {}) };
}

function asRepairTypesResult(value: unknown): RepairTypesResult | null {
  if (!isRecord(value) || !isRecord(value.before) || !isRecord(value.after)) return null;
  return {
    ...value,
    id: asString(value.id),
    title: asString(value.title),
    changed: value.changed === true,
    before: {
      kind: asString(value.before.kind),
      mime: typeof value.before.mime === "string" ? value.before.mime : null,
      versionMime: typeof value.before.versionMime === "string" ? value.before.versionMime : null,
    },
    after: {
      kind: asString(value.after.kind),
      mime: asString(value.after.mime),
      versionMime: asString(value.after.versionMime),
    },
  };
}

export function asArtifactComment(value: unknown): ArtifactComment | null {
  if (!isRecord(value) || !isRecord(value.origin)) return null;
  const status = value.status;
  if (status !== "open" && status !== "resolved") return null;
  const author = value.author === undefined ? "user" : value.author;
  if (author !== "user" && author !== "agent") return null;
  const placementStatus = value.placementStatus;
  if (placementStatus !== "anchored" && placementStatus !== "migrated" && placementStatus !== "ambiguous" && placementStatus !== "orphaned" && placementStatus !== "unplaced") return null;
  const id = asString(value.id), body = asString(value.body), versionId = asNumber(value.origin.versionId), blob = asString(value.origin.blob);
  const target = value.origin.target;
  const createdAt = asNumber(value.createdAt), updatedAt = asNumber(value.updatedAt);
  if (!/^[a-f0-9]{32}$/.test(id) || !body.trim() || Buffer.byteLength(body, "utf8") > 20_000 ||
      !Number.isSafeInteger(versionId) || versionId <= 0 || !/^[a-f0-9]{64}$/.test(blob) || value.origin.representationVersion !== 1 ||
      !validAnnotationTarget(target) || !Number.isSafeInteger(createdAt) || createdAt <= 0 || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) return null;
  if (!Array.isArray(value.placements) || !value.placements.length || value.placements.length > 10_000 || !value.placements.every(validPlacement)) return null;
  const placements = value.placements as ArtifactAnnotationPlacement[];
  if (new Set(placements.map((placement) => placement.versionId)).size !== placements.length) return null;
  const originPlacement = placements.find((placement) => placement.versionId === versionId);
  if (!originPlacement || originPlacement.state !== "anchored" || !sameAnnotationTarget(originPlacement.target, target) ||
      originPlacement.provenance.sourceVersionId !== versionId || originPlacement.provenance.sourceBlob !== blob) return null;
  const rawReplies = value.replies === undefined ? [] : value.replies;
  if (!Array.isArray(rawReplies) || rawReplies.length > 100) return null;
  const parsedReplies = rawReplies.map(asArtifactCommentReply);
  if (parsedReplies.some((reply) => reply === null)) return null;
  const replies = parsedReplies as ArtifactCommentReply[];
  if (new Set(replies.map((reply) => reply.id)).size !== replies.length || replies.some((reply) => reply.id === id) ||
      replies.some((reply, index) => reply.createdAt < createdAt || reply.createdAt > updatedAt || (index > 0 && reply.createdAt <= replies[index - 1].createdAt))) return null;
  return {
    ...value,
    id,
    body,
    author,
    createdAt,
    updatedAt,
    origin: { ...value.origin, versionId, blob, representationVersion: 1, target },
    placements,
    replies,
    status,
    placementStatus,
  };
}
function asArtifactCommentReply(value: unknown): ArtifactCommentReply | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id), body = asString(value.body), createdAt = asNumber(value.createdAt);
  if (!/^[a-f0-9]{32}$/.test(id) || !body.trim() || Buffer.byteLength(body, "utf8") > 20_000 ||
      (value.author !== "user" && value.author !== "agent") || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  return { ...value, id, body, author: value.author, createdAt };
}
function sameAnnotationTarget(left: ArtifactAnnotationSelector, right: ArtifactAnnotationSelector): boolean {
  return left.type === right.type && left.start === right.start && left.end === right.end && left.quote === right.quote &&
    left.prefix === right.prefix && left.suffix === right.suffix &&
    (left.type !== "html" || (right.type === "html" && left.selector === right.selector));
}
function validAnnotationTarget(value: unknown): value is ArtifactAnnotationSelector {
  if (!isRecord(value) || (value.type !== "text" && value.type !== "html")) return false;
  const start = value.start, end = value.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 1_000_000 || typeof value.quote !== "string" || end - start !== value.quote.length || !value.quote.trim() || Buffer.byteLength(value.quote, "utf8") > 10_000 || typeof value.prefix !== "string" || Buffer.byteLength(value.prefix, "utf8") > 512 || typeof value.suffix !== "string" || Buffer.byteLength(value.suffix, "utf8") > 512) return false;
  return value.type !== "html" || (typeof value.selector === "string" && value.selector.length > 0 && Buffer.byteLength(value.selector, "utf8") <= 2_000);
}
function validPlacement(value: unknown): value is ArtifactAnnotationPlacement {
  if (!isRecord(value) || !Number.isSafeInteger(value.versionId) || (value.versionId as number) <= 0 || !isRecord(value.provenance)) return false;
  const provenance = value.provenance;
  if (provenance.representationVersion !== 1 || !Number.isSafeInteger(provenance.sourceVersionId) || (provenance.sourceVersionId as number) <= 0 || typeof provenance.sourceBlob !== "string" || !/^[a-f0-9]{64}$/.test(provenance.sourceBlob) || !Number.isSafeInteger(provenance.placedAt) || (provenance.placedAt as number) <= 0) return false;
  if (value.state === "anchored") return provenance.method === "exact-position" && provenance.confidence === "high" && validAnnotationTarget(value.target);
  if (value.state === "migrated") return provenance.method === "unique-context" && provenance.confidence === "high" && validAnnotationTarget(value.target);
  if (value.state === "ambiguous") return value.reason === "ambiguous" && provenance.method === "ambiguous" && provenance.confidence === "none";
  return value.state === "orphaned" && value.reason === "not-found" && provenance.method === "not-found" && provenance.confidence === "none";
}

function errorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : fallback;
}

function request(
  method: string,
  urlStr: string,
  body?: unknown,
  timeoutMs = 8000,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
  snapshotResponse = false,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Operation aborted")); return; }
    let settled = false;
    let responseStarted = false;
    let responseEnded = false;
    let removeAbortListener: () => void = () => {};
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const u = new URL(urlStr);
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body));
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          responseEnded = true;
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed: unknown = (() => {
            try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
          })();
          if (settled) return;
          settled = true;
          removeAbortListener();
          resolve({ status: res.statusCode || 0, json: parsed });
        });
        const responseFailure = (error: Error) => {
          if (snapshotResponse) {
            settleReject(new ArtifactRetrievalError(
              responseStarted ? "INTERRUPTED" : "TRANSPORT_ERROR",
              responseStarted ? "artifact snapshot metadata response was interrupted" : "artifact snapshot metadata response failed",
              { cause: error },
            ));
          } else {
            settleReject(error);
          }
        };
        res.on("aborted", () => responseFailure(new Error("daemon response was interrupted")));
        res.on("error", (error) => responseFailure(error));
        res.on("close", () => {
          if (!responseEnded) responseFailure(new Error("daemon response closed before completion"));
        });
      },
    );
    const onAbort = () => { req.destroy(new Error("Operation aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
    req.on("error", (error) => {
      if (settled) return;
      if (snapshotResponse && responseStarted) settleReject(new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot metadata response was interrupted", { cause: error }));
      else settleReject(error);
    });
    req.on("close", () => {
      if (snapshotResponse && responseStarted && !responseEnded) settleReject(new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot metadata response was interrupted"));
    });
    req.setTimeout(timeoutMs, () => {
      settleReject(snapshotResponse
        ? new ArtifactRetrievalError("TRANSPORT_ERROR", "artifact snapshot metadata request timed out")
        : new Error("daemon request timed out"));
      req.destroy(new Error("daemon request timed out"));
    });
    if (data) req.write(data);
    req.end();
  });
}
/** Deterministic 32-hex operation id: identical logical writes (same content) share an id so a
 * lost HTTP response replayed as the same tool call dedups on the daemon instead of duplicating. */
function commentOperationId(parts: unknown[]): string {
  return crypto.createHash("sha256").update(parts.map((part) => JSON.stringify(part)).join("\u0000")).digest("hex").slice(0, 32);
}

function requestFile(
  urlStr: string,
  filePath: string,
  payload: RegisterPayload,
  timeoutMs = 60_000,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const size = fs.statSync(filePath).size;
    const metadata = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": payload.mime || "application/octet-stream",
          "content-length": size,
          "x-artifact-metadata": metadata,
          [REGISTER_HEADER]: REGISTER_HEADER_VALUE,
        },
      },
      (res) => {
        if ((res.statusCode || 0) >= 400) stream.destroy();
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : null; }
          catch { parsed = { raw: text }; }
          resolve({ status: res.statusCode || 0, json: parsed });
        });
      },
    );
    req.on("error", (error) => { stream.destroy(); reject(error); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("daemon file upload timed out")));
    const stream = fs.createReadStream(filePath, size > 0 ? { end: size - 1 } : undefined);
    stream.on("error", (error) => req.destroy(error));
    stream.pipe(req);
  });
}

function snapshotMetadata(value: unknown): ArtifactSnapshotMetadata {
  if (!isRecord(value)) throw new ArtifactRetrievalError("INVALID_DAEMON_RESPONSE", "artifact snapshot failed: invalid metadata");
  const artifactId = value.artifactId;
  const version = value.version;
  const title = value.title;
  const kind = value.kind;
  const mime = value.mime;
  const byteLength = value.byteLength;
  const sha256 = value.sha256;
  if (typeof artifactId !== "string" || !/^[a-f0-9]{12}$/.test(artifactId) ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0 ||
      typeof title !== "string" || title.length === 0 ||
      !isArtifactKind(kind) ||
      !isArtifactMime(mime) ||
      typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0 ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ArtifactRetrievalError("INVALID_DAEMON_RESPONSE", "artifact snapshot failed: invalid metadata");
  }
  return { artifactId, version, title, kind, mime, byteLength, sha256 };
}

function snapshotErrorFromResponse(status: number, value: unknown, explicitVersion: boolean): ArtifactRetrievalError {
  const code = isRecord(value) && typeof value.code === "string" ? value.code : undefined;
  const known = new Set(["INVALID_ARTIFACT_ID", "INVALID_VERSION", "ARTIFACT_NOT_FOUND", "VERSION_NOT_FOUND", "SNAPSHOT_UNAVAILABLE"]);
  if (code && known.has(code)) return new ArtifactRetrievalError(code as ArtifactRetrievalError["code"], errorMessage(value, "artifact snapshot failed"));
  if (status === 404) return new ArtifactRetrievalError(explicitVersion ? "VERSION_NOT_FOUND" : "ARTIFACT_NOT_FOUND", errorMessage(value, "artifact snapshot not found"));
  return new ArtifactRetrievalError("TRANSPORT_ERROR", errorMessage(value, `artifact snapshot request failed (${status})`));
}

function rawSnapshotErrorFromResponse(status: number, value: unknown): ArtifactRetrievalError {
  const code = isRecord(value) && typeof value.code === "string" ? value.code : undefined;
  if (code === "SNAPSHOT_UNAVAILABLE") return new ArtifactRetrievalError("SNAPSHOT_UNAVAILABLE", errorMessage(value, "artifact snapshot bytes are unavailable"));
  if (status === 404) return new ArtifactRetrievalError("SNAPSHOT_UNAVAILABLE", "artifact snapshot bytes are unavailable");
  return new ArtifactRetrievalError("TRANSPORT_ERROR", errorMessage(value, `artifact snapshot request failed (${status})`));
}

function materializationReason(metadata: ArtifactSnapshotMetadata, requestedOutput: boolean): ArtifactMaterializationReason {
  if (requestedOutput) return "requested-output";
  if (metadata.byteLength > INLINE_ARTIFACT_TEXT_MAX_BYTES) return "size-limit";
  if (metadata.kind === "other") return /^text\//i.test(metadata.mime.split(";", 1)[0]!.trim()) ? "unsupported-kind" : "non-text";
  return "non-text";
}

function safeOutputName(metadata: ArtifactSnapshotMetadata): string {
  const title = path.basename(metadata.title).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "") || "artifact";
  return `${title.slice(0, 96)}-v${metadata.version}`;
}

function stagingPath(parent: string): string {
  return path.join(parent, `.pi-artifact-${crypto.randomBytes(12).toString("hex")}.tmp`);
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot retrieval interrupted");
}

async function commitStagedFile(stagePath: string, destination: string, signal?: AbortSignal): Promise<void> {
  ensureNotAborted(signal);
  // Both paths are in the destination directory. A same-filesystem rename replaces the
  // destination atomically, so readers see either the old complete file or the new one.
  await fs.promises.rename(stagePath, destination);
}

interface StreamedSnapshot {
  bytes: Buffer;
  stagePath: string | null;
  count: number;
  sha256: string;
}

async function writeAll(handle: fs.promises.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new Error("file write made no progress");
    }
    offset += result.bytesWritten;
  }
}

async function streamSnapshot(urlStr: string, expected: ArtifactSnapshotMetadata, stagePath: string | null, signal?: AbortSignal): Promise<StreamedSnapshot> {
  const u = new URL(urlStr);
  const transport = u.protocol === "https:" ? https : http;
  let handle: fs.promises.FileHandle | null = null;
  try {
    if (stagePath) handle = await fs.promises.open(stagePath, "wx");
  } catch (error) {
    throw new ArtifactRetrievalError("OUTPUT_ERROR", `artifact snapshot output failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return await new Promise<StreamedSnapshot>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const chunks: Buffer[] = [];
    let count = 0;
    let responseStarted = false;
    let responseEnded = false;
    let pendingWrites = 0;
    let finishing = false;
    let settled = false;
    let req: http.ClientRequest | null = null;
    let res: http.IncomingMessage | null = null;
    let removeAbortListener: () => void = () => {};
    const closeHandle = async (strict: boolean): Promise<void> => {
      if (!handle) return;
      const current = handle;
      handle = null;
      try { await current.close(); }
      catch (error) { if (strict) throw error; }
    };
    const finishError = (error: ArtifactRetrievalError) => {
      if (settled) return;
      settled = true;
      void (async () => {
        removeAbortListener();
        req?.destroy();
        if (res && !res.destroyed) res.destroy();
        await closeHandle(false);
        reject(error);
      })();
    };
    const finish = () => {
      if (settled) return;
      responseEnded = true;
      if (pendingWrites > 0) return;
      finishing = true;
      void (async () => {
        if (handle) {
          try {
            await handle.sync();
            await closeHandle(true);
          } catch (error) {
            finishError(new ArtifactRetrievalError("OUTPUT_ERROR", `artifact snapshot output failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
            return;
          }
        }
        if (settled) return;
        settled = true;
        removeAbortListener();
        const digest = hash.digest("hex");
        if (count !== expected.byteLength) {
          reject(new ArtifactRetrievalError("LENGTH_MISMATCH", `artifact snapshot length mismatch: expected ${expected.byteLength}, received ${count}`));
          return;
        }
        if (digest !== expected.sha256) {
          reject(new ArtifactRetrievalError("HASH_MISMATCH", "artifact snapshot SHA-256 does not match its immutable metadata"));
          return;
        }
        resolve({ bytes: Buffer.concat(chunks), stagePath, count, sha256: digest });
      })();
    };
    const failTransfer = (message: string, cause?: Error) => {
      finishError(new ArtifactRetrievalError(
        "INTERRUPTED",
        message,
        cause ? { cause } : undefined,
      ));
    };
    const failLength = (message: string) => {
      finishError(new ArtifactRetrievalError("LENGTH_MISMATCH", message));
    };
    const failTransport = (message: string, cause?: Error) => {
      finishError(new ArtifactRetrievalError(
        "TRANSPORT_ERROR",
        message,
        cause ? { cause } : undefined,
      ));
    };
    if (signal?.aborted) {
      finishError(new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot retrieval interrupted"));
      return;
    }
    req = transport.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (response) => {
      responseStarted = true;
      res = response;
      if ((response.statusCode || 0) !== 200) {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          responseEnded = true;
          let body: unknown = null;
          try { body = JSON.parse(Buffer.concat(responseChunks).toString("utf8")); } catch { /* use status */ }
          finishError(rawSnapshotErrorFromResponse(response.statusCode || 0, body));
        });
        response.on("aborted", () => failTransport("artifact snapshot response failed"));
        response.on("error", (error) => failTransport("artifact snapshot response failed", error));
        response.on("close", () => { if (!responseEnded) failTransport("artifact snapshot response failed"); });
        return;
      }
      response.on("data", (chunk: Buffer) => {
        response.pause();
        const part = Buffer.from(chunk);
        count += part.length;
        if (count > expected.byteLength) {
          failLength(`artifact snapshot exceeds declared length ${expected.byteLength}`);
          return;
        }
        hash.update(part);
        pendingWrites++;
        const write = handle ? writeAll(handle, part) : Promise.resolve().then(() => { chunks.push(part); });
        write.then(() => {
          pendingWrites--;
          if (responseEnded && pendingWrites === 0) finish();
          if (!settled) response.resume();
        }).catch((error: unknown) => {
          finishError(new ArtifactRetrievalError("OUTPUT_ERROR", `artifact snapshot output failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        });
      });
      response.on("end", finish);
      response.on("aborted", () => failTransfer("artifact snapshot response was interrupted"));
      response.on("error", (error) => failTransfer(`artifact snapshot response failed: ${error.message}`, error));
      response.on("close", () => { if (!responseEnded) failTransfer("artifact snapshot response closed before completion"); });
    });
    const onAbort = () => {
      finishError(new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot retrieval interrupted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
    req.on("error", (error) => {
      if (settled || finishing || responseEnded) return;
      if (signal?.aborted) {
        finishError(new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot retrieval interrupted"));
      } else if (responseStarted) {
        failTransfer("artifact snapshot retrieval interrupted", error);
      } else {
        failTransport(`artifact snapshot transport failed: ${error.message}`, error);
      }
    });
    req.setTimeout(60_000, () => {
      finishError(new ArtifactRetrievalError("TRANSPORT_ERROR", "artifact snapshot request timed out"));
      req?.destroy(new Error("artifact snapshot request timed out"));
    });
    req.end();
  });
}

export class ArtifactsClient {
  base: string;
  cfg: ArtifactsConfig;
  private streamingFileUpload: boolean | null = null;
  constructor(cfg = loadConfig()) {
    this.cfg = cfg;
    this.base = localBaseUrl(cfg);
  }

  async health(): Promise<JsonRecord | null> {
    try {
      const r = await request("GET", `${this.base}/health`, undefined, 2500);
      if (r.status !== 200 || !isRecord(r.json)) return null;
      this.streamingFileUpload = isRecord(r.json.capabilities) && r.json.capabilities.streamingFileUpload === true;
      if (r.json.publicBaseUrl !== undefined && (typeof r.json.publicBaseUrl !== "string" || !validatePublicBaseUrl(r.json.publicBaseUrl))) return null;
      if (r.json.publicUrlResolution !== undefined) {
        const resolution = r.json.publicUrlResolution;
        if (!isRecord(resolution) || typeof resolution.ok !== "boolean" || (resolution.ok && (typeof resolution.publicBaseUrl !== "string" || !validatePublicBaseUrl(resolution.publicBaseUrl))) || (!resolution.ok && (typeof resolution.code !== "string" || typeof resolution.message !== "string"))) return null;
      }
      return r.json;
    } catch { return null; }
  }

  /** Canonical public URL reported by the connected serving daemon; never derived from transport. */
  async publicUrl(): Promise<string> {
    const health = await this.health();
    const value = health?.publicBaseUrl;
    if (typeof value === "string") return validatePublicBaseUrl(value)!;
    const resolution = health?.publicUrlResolution;
    if (isRecord(resolution) && resolution.ok === false && typeof resolution.message === "string") throw new Error(resolution.message);
    throw new Error("artifact daemon has no valid canonical public URL; configure publicBaseUrl or Tailscale Serve");
  }

  async viewerUrl(id: string): Promise<string> {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("invalid artifact id");
    return joinPublicUrl(await this.publicUrl(), `/view/${id}`);
  }

  async isUp(): Promise<boolean> { return (await this.health()) !== null; }

  /** Register a file from disk (streams bytes and uploads a guaranteed snapshot). */
  async addFile(filePath: string, opts: Partial<RegisterPayload> & { project: string }): Promise<RegisterResponse> {
    const abs = path.resolve(filePath);
    const stat = fs.statSync(abs);
    const mtime = Math.round(stat.mtimeMs);
    const payload: RegisterPayload = {
      mode: opts.mode || "referenced",
      project: opts.project,
      projectPath: opts.projectPath ?? null,
      session: opts.session ?? null,
      title: opts.title || path.basename(abs),
      filename: path.basename(abs),
      kind: opts.kind,
      sourcePath: (opts.mode === "stored") ? null : abs,
      sourceMachine: os.hostname(),
      mime: opts.mime ?? null,
      tags: opts.tags,
      note: opts.note ?? null,
      sourceMtime: mtime,
      slug: opts.slug ?? null,
    };
    if (this.streamingFileUpload === null) await this.health();
    if (this.streamingFileUpload === false) return this.registerLegacyFile(abs, stat.size, payload);
    const r = await requestFile(`${this.base}/api/register-file`, abs, payload);
    if (r.status === 404 || r.status === 405) {
      this.streamingFileUpload = false;
      return this.registerLegacyFile(abs, stat.size, payload);
    }
    if (r.status !== 200) throw new Error(errorMessage(r.json, `register failed (${r.status})`));
    return asRegisterResponse(r.json);
  }

  private registerLegacyFile(abs: string, size: number, payload: RegisterPayload): Promise<RegisterResponse> {
    if (size > LEGACY_FALLBACK_MAX_FILE_BYTES) {
      throw new Error(
        `The artifact daemon does not support streaming uploads and this ${size} byte file is too large for the legacy fallback. ` +
        "Restart or upgrade the artifact daemon, then try again.",
      );
    }
    return this.register({ ...payload, contentBase64: fs.readFileSync(abs).toString("base64") });
  }

  /** Register raw content (e.g. agent-generated text not yet on disk). */
  async addContent(content: string | Buffer, opts: Partial<RegisterPayload> & { project: string; title: string }): Promise<RegisterResponse> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.register({
      mode: opts.mode || "stored",
      project: opts.project,
      projectPath: opts.projectPath ?? null,
      session: opts.session ?? null,
      title: opts.title,
      filename: opts.filename ?? opts.title,
      kind: opts.kind,
      sourcePath: opts.sourcePath ?? null,
      sourceMachine: os.hostname(),
      mime: opts.mime ?? null,
      tags: opts.tags,
      contentBase64: buf.toString("base64"),
      note: opts.note ?? null,
      slug: opts.slug ?? null,
    });
  }

  async register(payload: RegisterPayload): Promise<RegisterResponse> {
    const r = await request("POST", `${this.base}/api/register`, payload, 8000, {
      [REGISTER_HEADER]: REGISTER_HEADER_VALUE,
    });
    if (r.status !== 200) throw new Error(errorMessage(r.json, `register failed (${r.status})`));
    return asRegisterResponse(r.json);
  }

  async publishToPreviewShip(id: string, options: PublishArtifactOptions = {}): Promise<PreviewShipPublication> {
    // PreviewShip can spend 60s creating a deployment before its separate 5m poll window.
    const r = await request(
      "POST",
      `${this.base}/api/artifact/${id}/publish/previewship`,
      options,
      7 * 60 * 1000,
      { [PREVIEWSHIP_PUBLISH_HEADER]: PREVIEWSHIP_PUBLISH_HEADER_VALUE },
    );
    if (r.status !== 200) throw new Error(errorMessage(r.json, `PreviewShip publish failed (${r.status})`));
    return asPreviewShipPublication(r.json);
  }

  async list(params: { project?: string; q?: string; sort?: string; limit?: number } = {}): Promise<ArtifactListItem[]> {
    const sp = new URLSearchParams();
    if (params.project) sp.set("project", params.project);
    if (params.q) sp.set("q", params.q);
    if (params.sort) sp.set("sort", params.sort);
    if (params.limit) sp.set("limit", String(params.limit));
    const r = await request("GET", `${this.base}/api/list?${sp}`);
    const items = isRecord(r.json) && Array.isArray(r.json.items) ? r.json.items : [];
    return items.map(asArtifactListItem).filter((item): item is ArtifactListItem => item !== null);
  }

  async projects(): Promise<JsonRecord[]> {
    const r = await request("GET", `${this.base}/api/projects`);
    const projects = isRecord(r.json) && Array.isArray(r.json.projects) ? r.json.projects : [];
    return projects.filter(isRecord);
  }

  async applets(): Promise<AppletListItem[]> {
    const r = await request("GET", `${this.base}/api/applets`);
    const applets = isRecord(r.json) && Array.isArray(r.json.applets) ? r.json.applets : [];
    return applets.map(asAppletListItem).filter((app): app is AppletListItem => app !== null);
  }

  async get(id: string): Promise<JsonRecord | null> {
    const r = await request("GET", `${this.base}/api/artifact/${id}`);
    return r.status === 200 && isRecord(r.json) ? r.json : null;
  }

  /** Retrieve and verify one immutable stored artifact snapshot. */
  async getSnapshot(id: string, options: { version?: number; output?: string; signal?: AbortSignal } = {}): Promise<ArtifactSnapshotSuccess> {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new ArtifactRetrievalError("INVALID_ARTIFACT_ID", "artifact snapshot failed: invalid artifact id");
    if (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version <= 0)) {
      throw new ArtifactRetrievalError("INVALID_VERSION", "artifact snapshot failed: invalid version");
    }
    if (options.output !== undefined && !options.output.trim()) throw new ArtifactRetrievalError("OUTPUT_ERROR", "artifact snapshot failed: output path is empty");
    const explicitVersion = options.version !== undefined;
    const query = explicitVersion ? `?version=${options.version}` : "";
    let metadata: ArtifactSnapshotMetadata;
    try {
      const r = await request("GET", `${this.base}/api/artifact/${id}/snapshot${query}`, undefined, 8_000, {}, options.signal, true);
      if (r.status !== 200) throw snapshotErrorFromResponse(r.status, r.json, explicitVersion);
      if (!isRecord(r.json) || r.json.ok !== true) throw new ArtifactRetrievalError("INVALID_DAEMON_RESPONSE", "artifact snapshot failed: invalid response envelope");
      metadata = snapshotMetadata(r.json.metadata);
      if (metadata.artifactId !== id || (explicitVersion && metadata.version !== options.version)) throw new ArtifactRetrievalError("INVALID_DAEMON_RESPONSE", "artifact snapshot failed: daemon selected an unexpected snapshot");
    } catch (error) {
      if (error instanceof ArtifactRetrievalError) throw error;
      throw new ArtifactRetrievalError(options.signal?.aborted ? "INTERRUPTED" : "TRANSPORT_ERROR", `artifact snapshot metadata request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (options.signal?.aborted) throw new ArtifactRetrievalError("INTERRUPTED", "artifact snapshot retrieval interrupted");

    const inlineCandidate = options.output === undefined && isInlineSnapshot(metadata) && metadata.byteLength <= INLINE_ARTIFACT_TEXT_MAX_BYTES;
    let stagePath: string | null = null;
    let generatedDir: string | null = null;
    let completed = false;
    let destination: string | null = options.output ? path.resolve(options.output) : null;
    try {
      if (!inlineCandidate) {
        if (destination) {
          try {
            if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error("output parent is not a directory");
          } catch (error) {
            throw new ArtifactRetrievalError("OUTPUT_ERROR", `artifact snapshot output failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        } else {
          generatedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-artifact-"));
          destination = path.join(generatedDir, safeOutputName(metadata));
        }
        const parent = path.dirname(destination);
        stagePath = stagingPath(parent);
      }
      const streamed = await streamSnapshot(`${this.base}/raw/${id}/v/${metadata.version}`, metadata, stagePath, options.signal);
      if (streamed.stagePath) {
        await commitStagedFile(streamed.stagePath, destination!, options.signal);
        stagePath = null;
        completed = true;
        return { ok: true, ...metadata, metadata, disposition: "materialized", path: destination!, reason: materializationReason(metadata, options.output !== undefined) };
      }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(streamed.bytes); }
      catch {
        generatedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-artifact-"));
        destination = path.join(generatedDir, safeOutputName(metadata));
        stagePath = stagingPath(generatedDir);
        const file = await fs.promises.open(stagePath, "wx");
        let closed = false;
        try {
          await file.writeFile(streamed.bytes);
          await file.sync();
          await file.close();
          closed = true;
        } finally {
          if (!closed) await file.close().catch(() => undefined);
        }
        await commitStagedFile(stagePath, destination, options.signal);
        stagePath = null;
        completed = true;
        return { ok: true, ...metadata, metadata, disposition: "materialized", path: destination, reason: "invalid-utf8" };
      }
      ensureNotAborted(options.signal);
      completed = true;
      return { ok: true, ...metadata, metadata, disposition: "inline", content };
    } catch (error) {
      if (error instanceof ArtifactRetrievalError) throw error;
      throw new ArtifactRetrievalError(options.signal?.aborted ? "INTERRUPTED" : "OUTPUT_ERROR", `artifact snapshot retrieval failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (stagePath) await fs.promises.rm(stagePath, { force: true }).catch(() => undefined);
      if (generatedDir && !completed) await fs.promises.rm(generatedDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Read durable annotation comments for one immutable artifact snapshot. */
  async comments(id: string, versionId?: number, status?: AnnotationStatus): Promise<ArtifactCommentsResponse> {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("artifact comments failed: invalid artifact id");
    if (versionId !== undefined && (!Number.isSafeInteger(versionId) || versionId <= 0)) throw new Error("artifact comments failed: invalid version id");
    const params = new URLSearchParams();
    if (versionId !== undefined) params.set("version", String(versionId));
    if (status) params.set("status", status);
    const query = params.size ? `?${params}` : "";
    const r = await request("GET", `${this.base}/api/artifact/${id}/annotations${query}`);
    if (r.status !== 200 || !isRecord(r.json) || !Array.isArray(r.json.comments)) {
      throw new Error(errorMessage(r.json, `artifact comments failed (${r.status})`));
    }
    const parsed = r.json.comments.map(asArtifactComment);
    const artifactId = asString(r.json.artifactId), title = asString(r.json.title), currentVersion = asNumber(r.json.currentVersion);
    const viewerUrl = typeof r.json.viewerUrl === "string" ? validatePublicBaseUrl(r.json.viewerUrl) : null;
    const responseVersion = asNumber(r.json.versionId), revision = asNumber(r.json.revision);
    let viewerPath = "";
    try { viewerPath = viewerUrl ? new URL(viewerUrl).pathname : ""; } catch { /* validated URL cannot fail */ }
    if (parsed.some((comment) => comment === null) || artifactId !== id || !title || !Number.isSafeInteger(currentVersion) || currentVersion <= 0 ||
        !viewerUrl || !hasPublicRoutePath(viewerPath, `/view/${id}`) || !Number.isSafeInteger(responseVersion) || responseVersion <= 0 || !Number.isSafeInteger(revision) || revision < 0 ||
        (versionId !== undefined && responseVersion !== versionId)) throw new Error("artifact comments failed: invalid daemon response");
    const comments = parsed as ArtifactComment[];
    const recordIds = comments.flatMap((comment) => [comment.id, ...comment.replies.map((reply) => reply.id)]);
    if (new Set(recordIds).size !== recordIds.length || comments.some((comment) => comment.placementStatus !== (comment.placements.find((placement) => placement.versionId === responseVersion)?.state || "unplaced"))) {
      throw new Error("artifact comments failed: invalid daemon response");
    }
    return { ...r.json, artifactId, title, currentVersion, viewerUrl, versionId: responseVersion, revision, comments };
  }

  /** Create one explicit agent-authored top-level comment against a caller-supplied rendered selector. */
  async createComment(id: string, input: { versionId: number; target: ArtifactAnnotationSelector; body: string }, signal?: AbortSignal): Promise<ArtifactCommentCreateResult> {
    if (signal?.aborted) throw new Error("artifact comment create aborted before it was sent");
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("artifact comment create failed: invalid artifact id");
    if (!Number.isSafeInteger(input.versionId) || input.versionId <= 0) throw new Error("artifact comment create failed: invalid version id");
    if (!validAnnotationTarget(input.target)) throw new Error("artifact comment create failed: invalid rendered selector");
    if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > 20_000) throw new Error("artifact comment create failed: invalid body");
    const t = input.target;
    const targetKey = t.type === "html" ? ["html", t.selector, t.start, t.end, t.quote, t.prefix, t.suffix] : ["text", t.start, t.end, t.quote, t.prefix, t.suffix];
    // Content-derived id: the annotation id equals this operation id, so a replay of the same
    // logical create resolves to the same record instead of a duplicate.
    const operationId = commentOperationId(["create-comment", id, input.versionId, ...targetKey, input.body]);
    const current = await this.comments(id, input.versionId);
    const already = current.comments.find((candidate) => candidate.id === operationId);
    if (already) {
      // Only treat a same-id record as our idempotent replay when it is actually our agent write
      // (matching authorship, body, origin version and selector). A different record sharing the
      // id is a genuine collision, not a dedup, and must not be returned as success.
      if (already.author === "agent" && already.body === input.body && already.origin.versionId === input.versionId && sameAnnotationTarget(already.origin.target, input.target)) {
        return { artifactId: id, revision: current.revision, comment: already };
      }
      throw new Error("artifact comment create failed: operation id already used for different content");
    }
    if (signal?.aborted) throw new Error("artifact comment create aborted before it was sent");
    const r = await request("POST", `${this.base}/api/artifact/${id}/annotations`, input, 8000, {
      "if-match": `W/"annotations-${id}-${current.revision}"`,
      "x-pi-artifacts-operation-id": operationId,
      [COMMENT_AGENT_HEADER]: COMMENT_AGENT_HEADER_VALUE,
    }, signal);
    if ((r.status !== 200 && r.status !== 201) || !isRecord(r.json) || !Array.isArray(r.json.annotations)) {
      throw new Error(errorMessage(r.json, `artifact comment create failed (${r.status}); read comments again before retrying`));
    }
    const raw = r.json.annotations.find((candidate) => isRecord(candidate) && candidate.id === operationId);
    const comment = isRecord(raw) ? asArtifactComment({ ...raw, placementStatus: raw.placements instanceof Array ? (raw.placements.find((placement) => isRecord(placement) && placement.versionId === input.versionId) as JsonRecord | undefined)?.state || "unplaced" : "unplaced" }) : null;
    const revision = asNumber(r.json.revision);
    // A dedup replay returns 200 at the same revision; a fresh create advances it. Both are valid.
    if (!comment || comment.author !== "agent" || !Number.isSafeInteger(revision) || revision < current.revision) throw new Error("artifact comment create failed: invalid daemon response");
    return { artifactId: id, revision, comment };
  }

  /** Append one explicit agent-authored reply without changing the parent thread status. */
  async replyToComment(id: string, input: { annotationId: string; body: string; versionId?: number }, signal?: AbortSignal): Promise<ArtifactCommentReplyResult> {
    if (signal?.aborted) throw new Error("artifact comment reply aborted before it was sent");
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("artifact comment reply failed: invalid artifact id");
    if (!/^[a-f0-9]{32}$/.test(input.annotationId)) throw new Error("artifact comment reply failed: invalid comment id");
    if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > 20_000) throw new Error("artifact comment reply failed: invalid body");
    // Content-derived reply id (excludes the volatile parent timestamp) so a replay after the
    // thread advanced still resolves to the same reply rather than appending a duplicate.
    const operationId = commentOperationId(["reply-comment", id, input.annotationId, input.body]);
    const current = await this.comments(id, input.versionId);
    const comment = current.comments.find((candidate) => candidate.id === input.annotationId);
    if (!comment) throw new Error("artifact comment reply failed: comment not found on the selected artifact");
    const priorReply = comment.replies.find((candidate) => candidate.id === operationId);
    if (priorReply) {
      if (priorReply.author === "agent" && priorReply.body === input.body) {
        return { artifactId: id, annotationId: input.annotationId, revision: current.revision, status: comment.status, reply: priorReply };
      }
      throw new Error("artifact comment reply failed: operation id already used for different content");
    }
    if (signal?.aborted) throw new Error("artifact comment reply aborted before it was sent");
    const r = await request("POST", `${this.base}/api/artifact/${id}/annotation/${input.annotationId}/replies`, { body: input.body, expectedUpdatedAt: comment.updatedAt }, 8000, {
      "if-match": `W/"annotations-${id}-${current.revision}"`,
      "x-pi-artifacts-operation-id": operationId,
      [COMMENT_AGENT_HEADER]: COMMENT_AGENT_HEADER_VALUE,
    }, signal);
    if ((r.status !== 200 && r.status !== 201) || !isRecord(r.json)) {
      throw new Error(errorMessage(r.json, `artifact comment reply failed (${r.status}); read comments again before retrying`));
    }
    const reply = asArtifactCommentReply(r.json.reply), revision = asNumber(r.json.revision), artifactId = asString(r.json.artifactId), annotationId = asString(r.json.annotationId);
    const status = r.json.status === "open" || r.json.status === "resolved" ? r.json.status : null;
    if (!reply || reply.author !== "agent" || artifactId !== id || annotationId !== input.annotationId || status === null || !Number.isSafeInteger(revision) || revision < current.revision) {
      throw new Error("artifact comment reply failed: invalid daemon response");
    }
    return { ...r.json, artifactId, annotationId, revision, status, reply };
  }

  async action(id: string, action: "archive" | "restore" | "delete"): Promise<boolean> {
    const r = await request("POST", `${this.base}/api/artifact/${id}/${action}`, {});
    return isRecord(r.json) && r.json.ok === true;
  }

  async tag(id: string, tags: string[]): Promise<boolean> {
    const r = await request("POST", `${this.base}/api/artifact/${id}/tag`, { tags });
    return isRecord(r.json) && r.json.ok === true;
  }

  async repairTypes(opts: { apply?: boolean; ids?: string[]; includeArchived?: boolean } = {}): Promise<RepairTypesResult[]> {
    const r = await request("POST", `${this.base}/api/repair-types`, opts);
    if (r.status !== 200) throw new Error(errorMessage(r.json, `repair-types failed (${r.status})`));
    const results = isRecord(r.json) && Array.isArray(r.json.results) ? r.json.results : [];
    return results.map(asRepairTypesResult).filter((result): result is RepairTypesResult => result !== null);
  }
}
