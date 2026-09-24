import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-annotations-test-"));
const config = await import("../src/config.ts");
const store = await import("../src/store.ts");
const annotations = await import("../src/annotations.ts");

let artifactNumber = 0;
function artifact(content = "const target = 1;\n") {
  const filename = `source-${++artifactNumber}.ts`;
  return store.registerArtifact({ project: "annotations", title: filename, filename, mode: "stored", content: Buffer.from(content) });
}
function placement(annotation: { origin: { versionId: number; blob: string; target: unknown } }, versionId: number, state: "anchored" | "migrated" | "ambiguous" | "orphaned" = "migrated") {
  const provenance = { representationVersion: 1 as const, sourceVersionId: annotation.origin.versionId, sourceBlob: annotation.origin.blob, method: state === "migrated" ? "unique-context" as const : state === "anchored" ? "exact-position" as const : state === "ambiguous" ? "ambiguous" as const : "not-found" as const, confidence: state === "anchored" || state === "migrated" ? "high" as const : "none" as const, placedAt: 1 };
  return state === "anchored" || state === "migrated" ? { versionId, state, target: annotation.origin.target, provenance } : { versionId, state, reason: state === "ambiguous" ? "ambiguous" as const : "not-found" as const, provenance };
}

test("sidecars persist strict v1 data atomically and enforce CAS", () => {
  const registered = artifact();
  const first = annotations.addAnnotation(registered.artifact.id, 0, { versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "Declaration" });
  assert.equal(first.revision, 1);
  assert.match(fs.readFileSync(path.join(config.ANNOTATIONS_DIR, `${registered.artifact.id}.json`), "utf8"), /"schemaVersion": 2/);
  assert.throws(() => annotations.addAnnotation(registered.artifact.id, 0, { versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "stale" }), annotations.AnnotationConflictError);
});

test("schema v1 sidecars are read and upgraded to v2 on the next write; unknown versions are rejected", () => {
  const registered = artifact();
  const seeded = annotations.addAnnotation(registered.artifact.id, 0, { id: "a".repeat(32), versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "legacy" });
  // Reconstruct exactly what a pre-feature v1 writer produced: schemaVersion 1, and items with
  // neither `author` nor `replies`.
  const legacy = JSON.parse(JSON.stringify({ ...seeded, schemaVersion: 1 }));
  for (const item of legacy.annotations) { delete item.author; delete item.replies; }
  const file = path.join(config.ANNOTATIONS_DIR, `${registered.artifact.id}.json`);
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + "\n");

  const read = annotations.readSidecar(registered.artifact.id);
  assert.equal(read.schemaVersion, annotations.ANNOTATION_SCHEMA_VERSION, "legacy v1 normalizes to the current version in memory");
  assert.equal(read.annotations[0].author, "user", "missing author defaults to user");
  assert.deepEqual(read.annotations[0].replies, [], "missing replies default to empty");

  // A write upgrades the on-disk representation to v2.
  annotations.addAnnotationReply(registered.artifact.id, read.revision, read.annotations[0].id, { body: "upgrade", author: "user", expectedUpdatedAt: read.annotations[0].updatedAt }, "b".repeat(32));
  assert.match(fs.readFileSync(file, "utf8"), /"schemaVersion": 2/);

  const future = JSON.parse(JSON.stringify({ ...seeded, schemaVersion: 3 }));
  assert.throws(() => annotations.parseSidecar(JSON.stringify(future), registered.artifact.id), annotations.AnnotationCorruptionError);
  // A fractional version between 1 and 2 must not slip through the range check.
  const fractional = JSON.parse(JSON.stringify({ ...seeded, schemaVersion: 1.5 }));
  assert.throws(() => annotations.parseSidecar(JSON.stringify(fractional), registered.artifact.id), annotations.AnnotationCorruptionError);
  // A v2 record missing author must be rejected, not silently defaulted to user (which would drop
  // agent-comment protection). seeded is already schemaVersion 2 with author/replies present.
  const v2MissingAuthor = JSON.parse(JSON.stringify(seeded));
  delete v2MissingAuthor.annotations[0].author;
  assert.throws(() => annotations.parseSidecar(JSON.stringify(v2MissingAuthor), registered.artifact.id), annotations.AnnotationCorruptionError);
});

test("agent-authored comments cannot be edited or deleted through the mutation API", () => {
  const registered = artifact();
  const created = annotations.addAnnotation(registered.artifact.id, 0, { id: "c".repeat(32), versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "agent finding", author: "agent" });
  assert.equal(created.annotations[0].author, "agent");
  // Body edit is forbidden; a status-only change (resolve/reopen) is still allowed.
  assert.throws(() => annotations.updateAnnotation(registered.artifact.id, created.revision, created.annotations[0].id, { body: "spoofed", expectedUpdatedAt: created.annotations[0].updatedAt }, "d".repeat(32)), annotations.AnnotationForbiddenError);
  const resolved = annotations.updateAnnotation(registered.artifact.id, created.revision, created.annotations[0].id, { status: "resolved", expectedUpdatedAt: created.annotations[0].updatedAt }, "e".repeat(32));
  assert.equal(resolved.annotations[0].status, "resolved");
  assert.equal(resolved.annotations[0].body, "agent finding", "the agent body is unchanged");
  assert.throws(() => annotations.removeAnnotation(registered.artifact.id, resolved.revision, resolved.annotations[0].id, resolved.annotations[0].updatedAt, "f".repeat(32)), annotations.AnnotationForbiddenError);
});

test("agent replies are bounded, append-only, CAS-protected, and idempotent", () => {
  const registered = artifact();
  const created = annotations.addAnnotation(registered.artifact.id, 0, { id: "1".repeat(32), versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "review this" });
  assert.equal(created.annotations[0].author, "user");
  const legacy = JSON.parse(JSON.stringify({ ...created, schemaVersion: 1 })); delete legacy.annotations[0].replies; delete legacy.annotations[0].author;
  assert.deepEqual(annotations.parseSidecar(JSON.stringify(legacy), registered.artifact.id).annotations[0].replies, [], "early schema-v1 sidecars load with no replies");

  const operationId = "2".repeat(32);
  const replied = annotations.addAnnotationReply(registered.artifact.id, created.revision, created.annotations[0].id, { body: "Agent response", author: "agent", expectedUpdatedAt: created.annotations[0].updatedAt }, operationId);
  assert.equal(replied.revision, created.revision + 1);
  assert.equal(replied.annotations[0].status, "open", "replying does not reopen or resolve a thread");
  assert.deepEqual(replied.annotations[0].replies, [{ id: operationId, body: "Agent response", author: "agent", createdAt: replied.annotations[0].updatedAt }]);
  assert.deepEqual(replied.operations.at(-1), { id: operationId, kind: "reply", fingerprint: annotations.operationFingerprint("reply", { annotationId: created.annotations[0].id, body: "Agent response", author: "agent", expectedUpdatedAt: created.annotations[0].updatedAt }) });
  assert.equal(annotations.addAnnotationReply(registered.artifact.id, created.revision, created.annotations[0].id, { body: "Agent response", author: "agent", expectedUpdatedAt: created.annotations[0].updatedAt }, operationId).revision, replied.revision, "a lost reply response replays exactly once");
  assert.throws(() => annotations.addAnnotationReply(registered.artifact.id, replied.revision, created.annotations[0].id, { body: "different", author: "agent", expectedUpdatedAt: replied.annotations[0].updatedAt }, operationId), annotations.AnnotationOperationCollisionError);
  assert.throws(() => annotations.addAnnotationReply(registered.artifact.id, replied.revision, created.annotations[0].id, { body: "stale", author: "user", expectedUpdatedAt: created.annotations[0].updatedAt }, "3".repeat(32)), annotations.AnnotationItemConflictError);
  const resolved = annotations.updateAnnotation(registered.artifact.id, replied.revision, created.annotations[0].id, { status: "resolved", expectedUpdatedAt: replied.annotations[0].updatedAt }, "4".repeat(32));
  const resolvedReply = annotations.addAnnotationReply(registered.artifact.id, resolved.revision, created.annotations[0].id, { body: "Reply without reopening", author: "agent", expectedUpdatedAt: resolved.annotations[0].updatedAt }, "5".repeat(32));
  assert.equal(resolvedReply.annotations[0].status, "resolved", "replies preserve a resolved thread's status");

  const file = path.join(config.ANNOTATIONS_DIR, `${registered.artifact.id}.json`);
  const corrupt = JSON.parse(fs.readFileSync(file, "utf8")); corrupt.annotations[0].replies[0].author = "robot";
  fs.writeFileSync(file, JSON.stringify(corrupt));
  assert.throws(() => annotations.readSidecar(registered.artifact.id), /reply/);
});

test("browser-resolved bulk placements are complete, CAS-protected, and idempotent", () => {
  const registered = artifact();
  const created = annotations.addAnnotation(registered.artifact.id, 0, { id: "1".repeat(32), versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "note" });
  const newer = store.registerArtifact({ project: "annotations", title: registered.artifact.title, filename: registered.artifact.filename, mode: "stored", content: Buffer.from("const target = 2;\n") });
  const entries = [{ annotationId: created.annotations[0].id, placement: placement(created.annotations[0], newer.version.id) }];
  const placed = annotations.placeAnnotations(registered.artifact.id, created.revision, newer.version.id, entries, "2".repeat(32));
  assert.equal(placed.annotations[0].placements.at(-1)?.state, "migrated");
  assert.equal(annotations.placeAnnotations(registered.artifact.id, created.revision, newer.version.id, entries, "2".repeat(32)).revision, placed.revision);
  assert.throws(() => annotations.placeAnnotations(registered.artifact.id, placed.revision, newer.version.id, [{ annotationId: "f".repeat(32), placement: entries[0].placement }]), /unknown annotation/);
  assert.throws(() => annotations.placeAnnotations(registered.artifact.id, created.revision, newer.version.id, entries), annotations.AnnotationConflictError);
  assert.throws(() => annotations.updateAnnotation(registered.artifact.id, placed.revision, created.annotations[0].id, { body: "cross-kind", expectedUpdatedAt: created.annotations[0].updatedAt }, "1".repeat(32)), annotations.AnnotationOperationCollisionError);
  const edited = annotations.updateAnnotation(registered.artifact.id, placed.revision, created.annotations[0].id, { body: "edited", expectedUpdatedAt: created.annotations[0].updatedAt }, "4".repeat(32));
  assert.ok(edited.annotations[0].updatedAt > created.annotations[0].updatedAt, "per-item CAS timestamp is monotonic even within one clock millisecond");
  assert.equal(annotations.updateAnnotation(registered.artifact.id, placed.revision, created.annotations[0].id, { expectedUpdatedAt: created.annotations[0].updatedAt, body: "edited" }, "4".repeat(32)).revision, edited.revision, "canonical key ordering replays update receipt");
  const deleted = annotations.removeAnnotation(registered.artifact.id, edited.revision, created.annotations[0].id, edited.annotations[0].updatedAt, "5".repeat(32));
  assert.equal(annotations.removeAnnotation(registered.artifact.id, edited.revision, created.annotations[0].id, edited.annotations[0].updatedAt, "5".repeat(32)).revision, deleted.revision, "delete receipt replays after deletion");
});

test("sidecars reject corruption, substituted blobs, and non-owned snapshots", () => {
  const registered = artifact();
  const file = path.join(config.ANNOTATIONS_DIR, `${registered.artifact.id}.json`);
  fs.mkdirSync(config.ANNOTATIONS_DIR, { recursive: true }); fs.writeFileSync(file, '{"schemaVersion":2}');
  assert.throws(() => annotations.readSidecar(registered.artifact.id), annotations.AnnotationCorruptionError);
  fs.rmSync(file);
  const other = artifact("other");
  assert.throws(() => annotations.addAnnotation(registered.artifact.id, 0, { versionId: other.version.id, target: { type: "text", start: 0, end: 1, quote: "o", prefix: "", suffix: "" }, body: "wrong" }), /does not belong/);
  fs.writeFileSync(store.blobFile(registered.version.blob), "tampered");
  assert.throws(() => annotations.addAnnotation(registered.artifact.id, 0, { versionId: registered.version.id, target: { type: "text", start: 0, end: 1, quote: "c", prefix: "", suffix: "" }, body: "bad" }), /corrupt/);
});

test("sidecar reads reject duplicate placements and mismatched immutable provenance", () => {
  const registered = artifact("const strict = 1;\n");
  annotations.addAnnotation(registered.artifact.id, 0, { versionId: registered.version.id, target: { type: "text", start: 0, end: 5, quote: "const", prefix: "", suffix: "" }, body: "strict" });
  const file = path.join(config.ANNOTATIONS_DIR, `${registered.artifact.id}.json`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.annotations[0].placements.push(data.annotations[0].placements[0]);
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => annotations.readSidecar(registered.artifact.id), /duplicate annotation placement/);
  data.annotations[0].placements.pop();
  data.annotations[0].placements[0].provenance.sourceBlob = "f".repeat(64);
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => annotations.readSidecar(registered.artifact.id), /provenance mismatch/);
});
