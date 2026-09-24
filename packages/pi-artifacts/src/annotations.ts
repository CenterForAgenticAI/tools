// Durable annotation sidecars. These are deliberately independent of SQLite so notes remain
// inspectable/recoverable if the registry index is rebuilt.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ANNOTATIONS_DIR, ensureHome } from "./config.ts";
import { blobFile, getArtifact, getVersion } from "./store.ts";

// v2 adds top-level `author` and the append-only `replies[]` to each annotation. v1 sidecars
// (no author/replies on items) are still read and transparently upgraded in memory; every write
// emits v2. A pre-v2 reader will explicitly reject v2 as an unsupported version rather than
// silently mis-parsing it, which is the intended migration boundary.
export const ANNOTATION_SCHEMA_VERSION = 2;
export const ANNOTATION_SCHEMA_MIN_READ_VERSION = 1;
export const MAX_ANNOTATIONS_PER_ARTIFACT = 1_000;
export const MAX_ANNOTATION_BODY_BYTES = 20_000;
export const MAX_REPLIES_PER_ANNOTATION = 100;
export const MAX_ANNOTATION_QUOTE_BYTES = 10_000;
export const MAX_ANNOTATION_SELECTOR_BYTES = 2_000;
export const MAX_ANNOTATION_SIDECAR_BYTES = 10 * 1024 * 1024;

export interface TextSelector { type: "text"; start: number; end: number; quote: string; prefix: string; suffix: string }
export interface HtmlSelector { type: "html"; selector: string; start: number; end: number; quote: string; prefix: string; suffix: string }
export type AnnotationSelector = TextSelector | HtmlSelector;
export type AnnotationStatus = "open" | "resolved";
export type PlacementMethod = "exact-position" | "unique-context" | "ambiguous" | "not-found";
export type PlacementConfidence = "high" | "none";
export interface PlacementProvenance { representationVersion: 1; sourceVersionId: number; sourceBlob: string; method: PlacementMethod; confidence: PlacementConfidence; placedAt: number }
export interface AnnotationPlacement { versionId: number; state: "anchored" | "migrated"; target: AnnotationSelector; provenance: PlacementProvenance }
export interface OrphanedPlacement { versionId: number; state: "ambiguous" | "orphaned"; reason: "not-found" | "ambiguous"; provenance: PlacementProvenance }
export type Placement = AnnotationPlacement | OrphanedPlacement;
export interface AnnotationOrigin {
  /** Immutable content-addressed blob digest for the version where the note was made. */
  versionId: number;
  blob: string;
  representationVersion: 1;
  target: AnnotationSelector;
}
export type AnnotationAuthor = "user" | "agent";
export interface AnnotationReply {
  id: string;
  body: string;
  author: AnnotationAuthor;
  createdAt: number;
}
export interface ArtifactAnnotation {
  id: string;
  body: string;
  author: AnnotationAuthor;
  status: AnnotationStatus;
  origin: AnnotationOrigin;
  placements: Placement[];
  replies: AnnotationReply[];
  createdAt: number;
  updatedAt: number;
}
export interface AnnotationSidecar {
  schemaVersion: 2;
  artifactId: string;
  revision: number;
  updatedAt: number;
  annotations: ArtifactAnnotation[];
  /** Recent client operation ids make comment, reply, and placement mutations idempotent. */
  operations: AnnotationOperationReceipt[];
}
export interface AnnotationOperationReceipt { id: string; fingerprint: string; kind: "create" | "update" | "delete" | "placement" | "reply" }

export class AnnotationConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) { super("annotation sidecar changed; refresh before retrying"); this.currentRevision = currentRevision; }
}
export class AnnotationCorruptionError extends Error {}
export class AnnotationBusyError extends Error { constructor() { super("annotation sidecar is busy; retry"); } }
export class AnnotationOperationCollisionError extends Error { constructor() { super("annotation operation id was already used for different content"); } }
export class AnnotationItemConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) { super("annotation changed since this edit was based on it"); this.currentRevision = currentRevision; }
}
/** Raised when a mutation is structurally valid but not permitted (e.g. editing/deleting an
 * agent-authored comment). Enforced in the domain layer so no request path can bypass it. */
export class AnnotationForbiddenError extends Error {}

function sidecarPath(artifactId: string): string {
  if (!/^[a-f0-9]{12}$/.test(artifactId)) throw new Error("invalid artifact id");
  return path.join(ANNOTATIONS_DIR, `${artifactId}.json`);
}
function lockPath(artifactId: string): string { return path.join(ANNOTATIONS_DIR, `.${artifactId}.lock`); }
export function annotationEtag(artifactId: string, revision: number): string {
  return `W/"annotations-${artifactId}-${revision}"`;
}

function assertString(value: unknown, label: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, "utf8") > max) throw new AnnotationCorruptionError(`invalid annotation ${label}`);
}
function assertPositive(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new AnnotationCorruptionError(`invalid ${label}`);
}
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new AnnotationCorruptionError(`unexpected ${label} field`);
}
export function validateSelector(value: unknown): AnnotationSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation selector");
  const input = value as Record<string, unknown>;
  assertExactKeys(input, input.type === "html" ? ["type", "selector", "start", "end", "quote", "prefix", "suffix"] : ["type", "start", "end", "quote", "prefix", "suffix"], "annotation selector");
  const { type, start, end, quote } = input;
  if ((type !== "text" && type !== "html") || typeof start !== "number" || typeof end !== "number" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 1_000_000) {
    throw new AnnotationCorruptionError("invalid annotation selector range");
  }
  assertString(quote, "quote", MAX_ANNOTATION_QUOTE_BYTES);
  if (end - start !== quote.length) throw new AnnotationCorruptionError("annotation selector quote length does not match range");
  assertString(input.prefix, "prefix", 512, true);
  assertString(input.suffix, "suffix", 512, true);
  if (type === "html") {
    assertString(input.selector, "selector", MAX_ANNOTATION_SELECTOR_BYTES);
    if ([...input.selector].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) throw new AnnotationCorruptionError("invalid annotation selector");
    return { type, selector: input.selector, start, end, quote, prefix: input.prefix, suffix: input.suffix };
  }
  return { type, start, end, quote, prefix: input.prefix, suffix: input.suffix };
}
function validatePlacement(value: unknown): Placement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation placement");
  const item = value as Record<string, unknown>;
  assertExactKeys(item, item.state === "anchored" || item.state === "migrated" ? ["versionId", "state", "target", "provenance"] : ["versionId", "state", "reason", "provenance"], "annotation placement");
  assertPositive(item.versionId, "placement version");
  if (!item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)) throw new AnnotationCorruptionError("invalid annotation placement provenance");
  const provenance = item.provenance as Record<string, unknown>;
  assertExactKeys(provenance, ["representationVersion", "sourceVersionId", "sourceBlob", "method", "confidence", "placedAt"], "annotation placement provenance");
  if (provenance.representationVersion !== 1) throw new AnnotationCorruptionError("invalid annotation placement representation version");
  assertPositive(provenance.sourceVersionId, "placement source version");
  if (typeof provenance.sourceBlob !== "string" || !/^[a-f0-9]{64}$/.test(provenance.sourceBlob)) throw new AnnotationCorruptionError("invalid annotation placement source blob");
  if ((provenance.method !== "exact-position" && provenance.method !== "unique-context" && provenance.method !== "ambiguous" && provenance.method !== "not-found") || (provenance.confidence !== "high" && provenance.confidence !== "none")) throw new AnnotationCorruptionError("invalid annotation placement provenance");
  assertPositive(provenance.placedAt, "placement timestamp");
  const validProvenance: PlacementProvenance = { representationVersion: 1, sourceVersionId: provenance.sourceVersionId, sourceBlob: provenance.sourceBlob, method: provenance.method, confidence: provenance.confidence, placedAt: provenance.placedAt };
  if (item.state === "ambiguous" && item.reason === "ambiguous" && provenance.method === "ambiguous" && provenance.confidence === "none") {
    return { versionId: item.versionId, state: item.state, reason: item.reason, provenance: validProvenance };
  }
  if (item.state === "orphaned" && item.reason === "not-found" && provenance.method === "not-found" && provenance.confidence === "none") {
    return { versionId: item.versionId, state: item.state, reason: item.reason, provenance: validProvenance };
  }
  if (item.state === "anchored" && provenance.method === "exact-position" && provenance.confidence === "high") {
    return { versionId: item.versionId, state: item.state, target: validateSelector(item.target), provenance: validProvenance };
  }
  if (item.state === "migrated" && provenance.method === "unique-context" && provenance.confidence === "high") {
    return { versionId: item.versionId, state: item.state, target: validateSelector(item.target), provenance: validProvenance };
  }
  throw new AnnotationCorruptionError("invalid orphaned annotation placement");
}
function validateReply(value: unknown): AnnotationReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation reply");
  const item = value as Record<string, unknown>;
  assertExactKeys(item, ["id", "body", "author", "createdAt"], "annotation reply");
  if (typeof item.id !== "string" || !/^[a-f0-9]{32}$/.test(item.id)) throw new AnnotationCorruptionError("invalid annotation reply id");
  assertString(item.body, "reply body", MAX_ANNOTATION_BODY_BYTES);
  if (item.author !== "user" && item.author !== "agent") throw new AnnotationCorruptionError("invalid annotation reply author");
  assertPositive(item.createdAt, "annotation reply timestamp");
  return { id: item.id, body: item.body, author: item.author, createdAt: item.createdAt };
}
function validateAnnotation(value: unknown, requireAuthorFields: boolean): ArtifactAnnotation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation");
  const item = value as Record<string, unknown>;
  assertExactKeys(item, ["id", "body", "author", "status", "origin", "placements", "replies", "createdAt", "updatedAt"], "annotation");
  if (typeof item.id !== "string" || !/^[a-f0-9]{32}$/.test(item.id)) throw new AnnotationCorruptionError("invalid annotation id");
  assertString(item.body, "body", MAX_ANNOTATION_BODY_BYTES);
  // Only legacy v1 records may omit author/replies (defaulted here). v2 must carry both so a
  // malformed v2 record cannot silently drop agent authorship and its domain protection.
  if (requireAuthorFields && (item.author === undefined || item.replies === undefined)) throw new AnnotationCorruptionError("v2 annotation is missing author or replies");
  const author = item.author === undefined ? "user" : item.author;
  if (author !== "user" && author !== "agent") throw new AnnotationCorruptionError("invalid annotation author");
  if (item.status !== "open" && item.status !== "resolved") throw new AnnotationCorruptionError("invalid annotation status");
  if (!item.origin || typeof item.origin !== "object" || Array.isArray(item.origin)) throw new AnnotationCorruptionError("invalid annotation origin");
  const origin = item.origin as Record<string, unknown>;
  assertExactKeys(origin, ["versionId", "blob", "representationVersion", "target"], "annotation origin");
  assertPositive(origin.versionId, "origin version");
  if (typeof origin.blob !== "string" || !/^[a-f0-9]{64}$/.test(origin.blob)) throw new AnnotationCorruptionError("invalid annotation origin blob");
  if (origin.representationVersion !== 1) throw new AnnotationCorruptionError("invalid annotation representation version");
  const placements = item.placements;
  if (!Array.isArray(placements) || !placements.length || placements.length > 10_000) throw new AnnotationCorruptionError("invalid annotation placements");
  assertPositive(item.createdAt, "annotation creation timestamp");
  assertPositive(item.updatedAt, "annotation update timestamp");
  const createdAt = item.createdAt as number, updatedAt = item.updatedAt as number;
  if (updatedAt < createdAt) throw new AnnotationCorruptionError("invalid annotation timestamps");
  const replies = item.replies === undefined ? [] : item.replies;
  if (!Array.isArray(replies) || replies.length > MAX_REPLIES_PER_ANNOTATION) throw new AnnotationCorruptionError("invalid annotation replies");
  const validReplies = replies.map(validateReply);
  if (new Set(validReplies.map((reply) => reply.id)).size !== validReplies.length ||
      validReplies.some((reply, index) => reply.createdAt < createdAt || reply.createdAt > updatedAt || (index > 0 && reply.createdAt <= validReplies[index - 1].createdAt))) {
    throw new AnnotationCorruptionError("invalid annotation replies");
  }
  const target = validateSelector(origin.target);
  const validPlacements = placements.map(validatePlacement);
  if (new Set(validPlacements.map((placement) => placement.versionId)).size !== validPlacements.length) throw new AnnotationCorruptionError("duplicate annotation placement snapshot");
  const originPlacement = validPlacements.find((placement) => placement.versionId === origin.versionId);
  if (!originPlacement || originPlacement.state !== "anchored" || !sameSelector(originPlacement.target, target)) throw new AnnotationCorruptionError("annotation origin placement mismatch");
  if (validPlacements.some((placement) => placement.provenance.sourceVersionId !== origin.versionId || placement.provenance.sourceBlob !== origin.blob)) throw new AnnotationCorruptionError("annotation placement provenance mismatch");
  return { id: item.id, body: item.body, author, status: item.status, origin: { versionId: origin.versionId, blob: origin.blob, representationVersion: 1, target }, placements: validPlacements, replies: validReplies, createdAt, updatedAt };
}
function sameSelector(left: AnnotationSelector, right: AnnotationSelector): boolean {
  return left.type === right.type && left.start === right.start && left.end === right.end && left.quote === right.quote &&
    left.prefix === right.prefix && left.suffix === right.suffix &&
    (left.type !== "html" || (right.type === "html" && left.selector === right.selector));
}
function empty(artifactId: string): AnnotationSidecar { return { schemaVersion: ANNOTATION_SCHEMA_VERSION, artifactId, revision: 0, updatedAt: 0, annotations: [], operations: [] }; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export function operationFingerprint(kind: AnnotationOperationReceipt["kind"], value: unknown): string {
  return crypto.createHash("sha256").update(`${kind}:${canonical(value)}`).digest("hex");
}
export function parseSidecar(raw: string, artifactId: string): AnnotationSidecar {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AnnotationCorruptionError("annotation sidecar is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation sidecar");
  const data = value as Record<string, unknown>;
  assertExactKeys(data, ["schemaVersion", "artifactId", "revision", "updatedAt", "annotations", "operations"], "annotation sidecar");
  if (!Number.isInteger(data.schemaVersion) || (data.schemaVersion as number) < ANNOTATION_SCHEMA_MIN_READ_VERSION || (data.schemaVersion as number) > ANNOTATION_SCHEMA_VERSION || data.artifactId !== artifactId) throw new AnnotationCorruptionError("unsupported or mismatched annotation sidecar");
  const operations = Array.isArray(data.operations) ? data.operations.map((value) => {
    // Accept early v1 receipts only for read compatibility; a replay with one is deliberately
    // rejected rather than silently accepting an unbound operation id.
    if (typeof value === "string" && /^[a-f0-9]{32}$/.test(value)) return { id: value, fingerprint: "", kind: "create" as const };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation operation receipt");
    const receipt = value as Record<string, unknown>;
    assertExactKeys(receipt, ["id", "fingerprint", "kind"], "annotation operation receipt");
    if (typeof receipt.id !== "string" || !/^[a-f0-9]{32}$/.test(receipt.id) || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || (receipt.kind !== "create" && receipt.kind !== "update" && receipt.kind !== "delete" && receipt.kind !== "placement" && receipt.kind !== "reply")) throw new AnnotationCorruptionError("invalid annotation operation receipt");
    return { id: receipt.id, fingerprint: receipt.fingerprint, kind: receipt.kind } as AnnotationOperationReceipt;
  }) : null;
  if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Number.isSafeInteger(data.updatedAt) || (data.updatedAt as number) < 0 || !Array.isArray(data.annotations) || data.annotations.length > MAX_ANNOTATIONS_PER_ARTIFACT || !operations || operations.length > 1_000 || new Set(operations.map((receipt) => receipt.id)).size !== operations.length) throw new AnnotationCorruptionError("invalid annotation sidecar metadata");
  const parsedAnnotations = data.annotations.map((annotation) => validateAnnotation(annotation, (data.schemaVersion as number) >= 2));
  const recordIds = parsedAnnotations.flatMap((annotation) => [annotation.id, ...annotation.replies.map((reply) => reply.id)]);
  if (new Set(recordIds).size !== recordIds.length ||
      ((data.revision as number) === 0 && ((data.updatedAt as number) !== 0 || parsedAnnotations.length || operations.length)) ||
      ((data.revision as number) > 0 && (data.updatedAt as number) <= 0)) throw new AnnotationCorruptionError("invalid annotation sidecar metadata");
  // Normalize to the canonical current version in memory; the next write persists it as v2.
  return { schemaVersion: ANNOTATION_SCHEMA_VERSION, artifactId, revision: data.revision as number, updatedAt: data.updatedAt as number, annotations: parsedAnnotations, operations };
}
export function readSidecar(artifactId: string): AnnotationSidecar {
  ensureHome();
  const file = sidecarPath(artifactId);
  if (!fs.existsSync(file)) return empty(artifactId);
  const sidecar = parseSidecar(readSafeFile(file, MAX_ANNOTATION_SIDECAR_BYTES, "annotation sidecar").toString("utf8"), artifactId);
  for (const annotation of sidecar.annotations) {
    assertOriginPinned(artifactId, annotation.origin);
    for (const placement of annotation.placements) {
      const version = getVersion(placement.versionId);
      if (!version || version.artifact_id !== artifactId) throw new AnnotationCorruptionError("annotation placement snapshot does not belong to artifact");
    }
  }
  return sidecar;
}
function readSafeFile(file: string, maxBytes: number, label: string): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new AnnotationCorruptionError(`unsafe ${label}`);
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof AnnotationCorruptionError) throw error;
    throw new AnnotationCorruptionError(`cannot read ${label}`);
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* no recovery action */ } }
}
function atomicWrite(sidecar: AnnotationSidecar): void {
  ensureHome();
  const destination = sidecarPath(sidecar.artifactId);
  const temporary = path.join(ANNOTATIONS_DIR, `.${sidecar.artifactId}.${crypto.randomUUID()}.tmp`);
  const text = JSON.stringify(sidecar, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_ANNOTATION_SIDECAR_BYTES) throw new AnnotationCorruptionError("annotation sidecar size limit reached");
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, destination);
    const dir = fs.openSync(ANNOTATIONS_DIR, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* preserve error */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve error */ }
    throw error;
  }
}
/** Full digest validation prevents annotations from becoming attached to a substituted blob. */
function ownedSnapshot(artifactId: string, versionId: number): { bytes: Buffer; blob: string } {
  if (!getArtifact(artifactId)) throw new Error("artifact not found");
  assertPositive(versionId, "snapshot version");
  const version = getVersion(versionId);
  if (!version || version.artifact_id !== artifactId) throw new Error("snapshot version does not belong to artifact");
  if (!/^[a-f0-9]{64}$/.test(version.blob)) throw new AnnotationCorruptionError("corrupt snapshot blob identifier");
  const bytes = readSafeFile(blobFile(version.blob), version.size, "snapshot blob");
  if (bytes.length !== version.size || crypto.createHash("sha256").update(bytes).digest("hex") !== version.blob) throw new AnnotationCorruptionError("snapshot blob is corrupt");
  return { bytes, blob: version.blob };
}
export function assertOwnedSnapshot(artifactId: string, versionId: number): void {
  ownedSnapshot(artifactId, versionId);
}
function assertOriginPinned(artifactId: string, origin: AnnotationOrigin): void {
  const version = getVersion(origin.versionId);
  if (!version || version.artifact_id !== artifactId || version.blob !== origin.blob) {
    throw new AnnotationCorruptionError("annotation origin is not pinned to its immutable snapshot blob");
  }
}
function writeWithCas(artifactId: string, expectedRevision: number, receipt: AnnotationOperationReceipt | undefined, change: (current: AnnotationSidecar) => AnnotationSidecar): AnnotationSidecar {
  ensureHome();
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath(artifactId), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A crashed writer must not permanently deny annotation edits. Never follow a lock symlink.
      try {
        const stat = fs.lstatSync(lockPath(artifactId));
        if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 5 * 60_000) {
          fs.rmSync(lockPath(artifactId));
          fd = fs.openSync(lockPath(artifactId), "wx", 0o600);
        } else throw new AnnotationBusyError();
      } catch (lockError) {
        if (lockError instanceof AnnotationBusyError) throw lockError;
        throw new AnnotationBusyError();
      }
    }
    else throw error;
  }
  try {
    const current = readSidecar(artifactId);
    if (receipt) {
      const existing = current.operations.find((candidate) => candidate.id === receipt.id);
      if (existing) {
        if (existing.fingerprint !== receipt.fingerprint || existing.kind !== receipt.kind) throw new AnnotationOperationCollisionError();
        return current;
      }
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new AnnotationConflictError(current.revision);
    const next = change(current);
    atomicWrite(next);
    return next;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } finally { fs.rmSync(lockPath(artifactId), { force: true }); }
  }
}
function operationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new AnnotationCorruptionError("invalid annotation operation id");
  return value;
}
function recordOperation(sidecar: AnnotationSidecar, receipt: AnnotationOperationReceipt | undefined): AnnotationSidecar {
  return receipt ? { ...sidecar, operations: [...sidecar.operations.slice(-999), receipt] } : sidecar;
}
function placementProvenance(origin: AnnotationOrigin, method: PlacementMethod, confidence: PlacementConfidence, placedAt: number): PlacementProvenance {
  return { representationVersion: 1, sourceVersionId: origin.versionId, sourceBlob: origin.blob, method, confidence, placedAt };
}
export function addAnnotation(artifactId: string, expectedRevision: number, input: { versionId: number; target: unknown; body: unknown; author?: unknown; id?: unknown }): AnnotationSidecar {
  const snapshot = ownedSnapshot(artifactId, input.versionId);
  const target = validateSelector(input.target);
  const body = input.body;
  assertString(body, "body", MAX_ANNOTATION_BODY_BYTES);
  const author = input.author === undefined ? "user" : input.author;
  if (author !== "user" && author !== "agent") throw new AnnotationCorruptionError("invalid annotation author");
  const id = input.id === undefined ? crypto.randomBytes(16).toString("hex") : input.id;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new AnnotationCorruptionError("invalid annotation operation id");
  // Preserve the pre-author schema-v1 user fingerprint so a response lost during an upgrade
  // still replays. Agent authorship is included because it changes the durable record.
  const createFingerprint = { versionId: input.versionId, target, body, ...(author === "agent" ? { author } : {}) };
  const receipt = input.id === undefined ? undefined : { id, kind: "create" as const, fingerprint: operationFingerprint("create", createFingerprint) };
  return writeWithCas(artifactId, expectedRevision, receipt, (current) => {
    // A replay that lost its HTTP response must not create a second note.  The client operation
    // id doubles as the immutable annotation id, so this remains recoverable without a second DB.
    const existing = current.annotations.find((annotation) => annotation.id === id);
    if (existing) {
      if (existing.body === body && existing.author === author && existing.origin.versionId === input.versionId && sameSelector(existing.origin.target, target)) return current;
      throw new AnnotationOperationCollisionError();
    }
    if (current.annotations.some((annotation) => annotation.replies.some((reply) => reply.id === id))) throw new AnnotationOperationCollisionError();
    if (current.annotations.length >= MAX_ANNOTATIONS_PER_ARTIFACT) throw new Error("annotation limit reached");
    const now = Math.max(Date.now(), current.updatedAt + 1);
    const origin: AnnotationOrigin = { versionId: input.versionId, blob: snapshot.blob, representationVersion: 1, target };
    const annotation: ArtifactAnnotation = { id, body, author, status: "open", origin, placements: [{ versionId: input.versionId, state: "anchored", target, provenance: placementProvenance(origin, "exact-position", "high", now) }], replies: [], createdAt: now, updatedAt: now };
    return recordOperation({ ...current, revision: current.revision + 1, updatedAt: now, annotations: [...current.annotations, annotation] }, receipt);
  });
}
export function addAnnotationReply(artifactId: string, expectedRevision: number, annotationId: string, input: { body: unknown; author: unknown; expectedUpdatedAt: unknown }, rawOperationId?: unknown): AnnotationSidecar {
  assertString(input.body, "reply body", MAX_ANNOTATION_BODY_BYTES);
  if (input.author !== "user" && input.author !== "agent") throw new AnnotationCorruptionError("invalid annotation reply author");
  assertPositive(input.expectedUpdatedAt, "expected annotation update timestamp");
  const body = input.body as string, author = input.author as AnnotationAuthor;
  const op = operationId(rawOperationId);
  const replyId = op || crypto.randomBytes(16).toString("hex");
  const receipt = op === undefined ? undefined : { id: op, kind: "reply" as const, fingerprint: operationFingerprint("reply", { annotationId, body, author, expectedUpdatedAt: input.expectedUpdatedAt }) };
  return writeWithCas(artifactId, expectedRevision, receipt, (current) => {
    if (current.annotations.some((annotation) => annotation.id === replyId || annotation.replies.some((reply) => reply.id === replyId))) throw new AnnotationOperationCollisionError();
    let now = Math.max(Date.now(), current.updatedAt + 1); let found = false;
    const annotations = current.annotations.map((annotation) => {
      if (annotation.id !== annotationId) return annotation;
      found = true;
      if (annotation.updatedAt !== input.expectedUpdatedAt) throw new AnnotationItemConflictError(current.revision);
      if (annotation.replies.length >= MAX_REPLIES_PER_ANNOTATION) throw new AnnotationCorruptionError("annotation reply limit reached");
      if (annotation.replies.some((reply) => reply.id === replyId)) throw new AnnotationOperationCollisionError();
      now = Math.max(now, annotation.updatedAt + 1);
      const reply: AnnotationReply = { id: replyId, body, author, createdAt: now };
      return { ...annotation, replies: [...annotation.replies, reply], updatedAt: now };
    });
    if (!found) throw new Error("annotation not found");
    return recordOperation({ ...current, revision: current.revision + 1, updatedAt: now, annotations }, receipt);
  });
}
export function updateAnnotation(artifactId: string, expectedRevision: number, id: string, input: { body?: unknown; status?: unknown; expectedUpdatedAt?: unknown }, rawOperationId?: unknown): AnnotationSidecar {
  if (input.body === undefined && input.status === undefined) throw new AnnotationCorruptionError("annotation update requires body or status");
  if (input.body !== undefined) assertString(input.body, "body", MAX_ANNOTATION_BODY_BYTES);
  if (input.status !== undefined && input.status !== "open" && input.status !== "resolved") throw new AnnotationCorruptionError("invalid annotation status");
  assertPositive(input.expectedUpdatedAt, "expected annotation update timestamp");
  const body = input.body as string | undefined;
  const status = input.status as AnnotationStatus | undefined;
  const op = operationId(rawOperationId);
  const receipt = op === undefined ? undefined : { id: op, kind: "update" as const, fingerprint: operationFingerprint("update", { id, body, status, expectedUpdatedAt: input.expectedUpdatedAt }) };
  return writeWithCas(artifactId, expectedRevision, receipt, (current) => {
    let now = Math.max(Date.now(), current.updatedAt + 1); let found = false;
    const annotations = current.annotations.map((annotation) => {
      if (annotation.id !== id) return annotation;
      found = true;
      // Agent-authored comments are immutable except for their open/resolved status: no request
      // path (including a same-origin viewer script) may rewrite their body. Replies are separate.
      if (annotation.author === "agent" && body !== undefined) throw new AnnotationForbiddenError("agent-authored comments cannot be edited");
      if (annotation.updatedAt !== input.expectedUpdatedAt) throw new AnnotationItemConflictError(current.revision);
      now = Math.max(now, annotation.updatedAt + 1);
      return { ...annotation, ...(body === undefined ? {} : { body }), ...(status === undefined ? {} : { status }), updatedAt: now };
    });
    if (!found) throw new Error("annotation not found");
    return recordOperation({ ...current, revision: current.revision + 1, updatedAt: now, annotations }, receipt);
  });
}
export function removeAnnotation(artifactId: string, expectedRevision: number, id: string, expectedUpdatedAt: unknown, rawOperationId?: unknown): AnnotationSidecar {
  assertPositive(expectedUpdatedAt, "expected annotation update timestamp");
  const op = operationId(rawOperationId);
  const receipt = op === undefined ? undefined : { id: op, kind: "delete" as const, fingerprint: operationFingerprint("delete", { id, expectedUpdatedAt }) };
  return writeWithCas(artifactId, expectedRevision, receipt, (current) => {
    const existing = current.annotations.find((annotation) => annotation.id === id);
    // Agent-authored comments cannot be deleted through the mutation API; only their author
    // context (the agent) can retract them, and the current model has no such tool.
    if (existing && existing.author === "agent") throw new AnnotationForbiddenError("agent-authored comments cannot be deleted");
    if (existing && existing.updatedAt !== expectedUpdatedAt) throw new AnnotationItemConflictError(current.revision);
    const annotations = current.annotations.filter((annotation) => annotation.id !== id);
    if (annotations.length === current.annotations.length) throw new Error("annotation not found");
    const now = Math.max(Date.now(), current.updatedAt + 1, existing!.updatedAt + 1); return recordOperation({ ...current, revision: current.revision + 1, updatedAt: now, annotations }, receipt);
  });
}
/** Persist browser-resolved placements for one immutable snapshot. The daemon never resolves
 * selectors against raw bytes: Markdown/code/HTML rendered corpora are browser representations. */
export function placeAnnotations(artifactId: string, expectedRevision: number, versionId: number, rawPlacements: unknown, rawOperationId?: unknown): AnnotationSidecar {
  assertOwnedSnapshot(artifactId, versionId);
  if (!Array.isArray(rawPlacements) || rawPlacements.length > MAX_ANNOTATIONS_PER_ARTIFACT) throw new AnnotationCorruptionError("invalid annotation placements request");
  const op = operationId(rawOperationId);
  const receipt = op === undefined ? undefined : { id: op, kind: "placement" as const, fingerprint: operationFingerprint("placement", { versionId, placements: rawPlacements }) };
  return writeWithCas(artifactId, expectedRevision, receipt, (current) => {
    const supplied = new Map<string, Placement>();
    for (const value of rawPlacements) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnnotationCorruptionError("invalid annotation placement request");
      const entry = value as Record<string, unknown>;
      assertExactKeys(entry, ["annotationId", "placement"], "annotation placement request");
      if (typeof entry.annotationId !== "string" || !/^[a-f0-9]{32}$/.test(entry.annotationId) || supplied.has(entry.annotationId)) throw new AnnotationCorruptionError("invalid annotation placement id");
      const placement = validatePlacement(entry.placement);
      if (placement.versionId !== versionId) throw new AnnotationCorruptionError("annotation placement snapshot mismatch");
      supplied.set(entry.annotationId, placement);
    }
    if ([...supplied.keys()].some((annotationId) => !current.annotations.some((annotation) => annotation.id === annotationId))) {
      throw new AnnotationCorruptionError("annotation placement refers to an unknown annotation");
    }
    const now = Math.max(Date.now(), current.updatedAt + 1);
    const annotations = current.annotations.map((annotation) => {
      assertOriginPinned(artifactId, annotation.origin);
      if (!supplied.has(annotation.id)) return annotation;
      if (annotation.placements.some((placement) => placement.versionId === versionId)) return annotation;
      const placement = supplied.get(annotation.id)!;
      if ((placement.state === "anchored" || placement.state === "migrated") && placement.target.type !== annotation.origin.target.type) {
        throw new AnnotationCorruptionError("annotation placement selector type mismatch");
      }
      const provenance = placementProvenance(annotation.origin, placement.provenance.method, placement.provenance.confidence, now);
      return { ...annotation, placements: [...annotation.placements, placement.state === "anchored" || placement.state === "migrated"
        ? { ...placement, provenance }
        : { ...placement, provenance }] };
    });
    const changed = annotations.some((annotation, index) => annotation !== current.annotations[index]);
    if (!changed && !receipt) return current;
    return recordOperation({ ...current, revision: current.revision + 1, updatedAt: now, annotations }, receipt);
  });
}
/** The explicit status exposed to clients for one selected immutable snapshot. */
export function placementStatus(annotation: ArtifactAnnotation, versionId: number): Placement["state"] | "unplaced" {
  return annotation.placements.find((placement) => placement.versionId === versionId)?.state || "unplaced";
}
export function deleteSidecar(artifactId: string): void { fs.rmSync(sidecarPath(artifactId), { force: true }); }
