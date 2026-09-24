/** Shared immutable artifact snapshot retrieval contract used by the daemon clients. */
export type ArtifactKind = "markdown" | "html" | "pdf" | "code" | "image" | "video" | "audio" | "other";

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ["markdown", "html", "pdf", "code", "image", "video", "audio", "other"].includes(value);
}

export const INLINE_ARTIFACT_TEXT_MAX_BYTES = 64 * 1024;

export type ArtifactRetrievalErrorCode =
  | "INVALID_ARTIFACT_ID"
  | "INVALID_VERSION"
  | "ARTIFACT_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "SNAPSHOT_UNAVAILABLE"
  | "INVALID_DAEMON_RESPONSE"
  | "LENGTH_MISMATCH"
  | "HASH_MISMATCH"
  | "INTERRUPTED"
  | "TRANSPORT_ERROR"
  | "OUTPUT_ERROR";

export interface ArtifactSnapshotMetadata {
  artifactId: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  mime: string;
  byteLength: number;
  sha256: string;
}

export type ArtifactMaterializationReason =
  | "requested-output"
  | "size-limit"
  | "non-text"
  | "unsupported-kind"
  | "invalid-utf8";

export interface ArtifactSnapshotInline extends ArtifactSnapshotMetadata {
  ok: true;
  disposition: "inline";
  metadata: ArtifactSnapshotMetadata;
  content: string;
}

export interface ArtifactSnapshotMaterialized extends ArtifactSnapshotMetadata {
  ok: true;
  disposition: "materialized";
  metadata: ArtifactSnapshotMetadata;
  path: string;
  reason: ArtifactMaterializationReason;
}

export type ArtifactSnapshotSuccess = ArtifactSnapshotInline | ArtifactSnapshotMaterialized;

export interface ArtifactRetrievalFailure {
  ok: false;
  error: { code: ArtifactRetrievalErrorCode; message: string };
}

export class ArtifactRetrievalError extends Error {
  readonly code: ArtifactRetrievalErrorCode;
  constructor(code: ArtifactRetrievalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactRetrievalError";
    this.code = code;
  }
}

export function retrievalFailure(error: unknown): ArtifactRetrievalFailure {
  if (error instanceof ArtifactRetrievalError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: "TRANSPORT_ERROR", message: error instanceof Error ? error.message : String(error) } };
}

const INLINE_CODE_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
]);

function mediaType(mime: string): string {
  return mime.split(";", 1)[0]!.trim().toLowerCase();
}

/** Validate the MIME type shape before it influences rendering or output policy. */
export function isArtifactMime(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || value.includes("\u0000") || value.includes("\r") || value.includes("\n")) return false;
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType(value));
}

export function snapshotKindForMime(mimeValue: string, fallback: ArtifactKind): ArtifactKind {
  const mime = mediaType(mimeValue);
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/html") return "html";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || INLINE_CODE_MIMES.has(mime)) return "code";
  if (mime === "application/octet-stream") return "other";
  return fallback;
}

export function isInlineSnapshot(metadata: Pick<ArtifactSnapshotMetadata, "kind" | "mime">): boolean {
  const mime = mediaType(metadata.mime);
  if (metadata.kind === "markdown") return mime === "text/markdown";
  if (metadata.kind === "html") return mime === "text/html";
  return metadata.kind === "code" && mime !== "text/html" && mime !== "text/markdown" &&
    (mime.startsWith("text/") || INLINE_CODE_MIMES.has(mime));
}
