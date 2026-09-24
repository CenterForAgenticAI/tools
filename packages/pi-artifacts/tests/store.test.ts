import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-test-"));

const store = await import("../src/store.ts");

function register(title: string, filename: string | null, content: string) {
  return store.registerArtifact({
    project: "test-project",
    title,
    filename,
    mode: "stored",
    content: Buffer.from(content, "utf8"),
  });
}

test("inline markdown filename drives kind and mime even when title has no extension", () => {
  const result = register("Audit Report", "audit.md", "# Audit Report\n\n- one\n- two\n");
  assert.equal(result.artifact.kind, "markdown");
  assert.equal(result.artifact.mime, "text/markdown");
  assert.equal(result.artifact.filename, "audit.md");
  assert.equal(result.version.mime, "text/markdown");
});

test("inline html filename drives kind and mime even when title has no extension", () => {
  const result = register("HTML Report", "report.html", "<!doctype html><html><body><h1>Report</h1></body></html>");
  assert.equal(result.artifact.kind, "html");
  assert.equal(result.artifact.mime, "text/html");
  assert.equal(result.artifact.filename, "report.html");
  assert.equal(result.version.mime, "text/html");
});

test("inline txt filename remains non-markdown plain/code text", () => {
  const result = register("Plain Notes", "notes.txt", "ordinary plain text\nwithout markdown structure\n");
  assert.equal(result.artifact.kind, "code");
  assert.equal(result.artifact.mime, "text/plain");
  assert.notEqual(result.artifact.kind, "markdown");
  assert.equal(result.version.mime, "text/plain");
});

test("browser media extensions and MIME types are classified as audio or video", () => {
  const cases: Array<[string, string | null, string, string]> = [
    ["demo.mp4", null, "video", "video/mp4"],
    ["demo.webm", null, "video", "video/webm"],
    ["demo.mov", null, "video", "video/quicktime"],
    ["episode.mp3", null, "audio", "audio/mpeg"],
    ["episode.m4a", null, "audio", "audio/mp4"],
    ["episode.wav", null, "audio", "audio/wav"],
    ["favicon.ico", null, "image", "image/x-icon"],
    ["extensionless", "video/mp4", "video", "video/mp4"],
    ["extensionless", "audio/ogg", "audio", "audio/ogg"],
  ];

  for (const [name, mime, expectedKind, expectedMime] of cases) {
    const inferred = store.inferArtifactMetadata(name, mime);
    assert.equal(inferred.kind, expectedKind, name);
    assert.equal(inferred.mime, expectedMime, name);
  }

  // ISO BMFF's generic `isom` brand does not reveal whether the tracks are audio-only.
  // In that ambiguous case, the dedicated .m4a extension remains the stronger signal.
  const genericMp4Header = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom", "ascii")]);
  assert.deepEqual(store.inferArtifactMetadata("episode.m4a", null, genericMp4Header), { kind: "audio", mime: "audio/mp4" });
});

test("extensionless audio content is inferred from common browser media signatures", () => {
  const wav = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WAVEfmt ", "ascii"),
  ]);
  const flac = Buffer.from("fLaC\x00\x00\x00\x22", "latin1");
  const mp3 = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1");

  assert.deepEqual(store.inferArtifactMetadata("recording", null, wav), { kind: "audio", mime: "audio/wav" });
  assert.deepEqual(store.inferArtifactMetadata("recording", null, flac), { kind: "audio", mime: "audio/flac" });
  assert.deepEqual(store.inferArtifactMetadata("recording", null, mp3), { kind: "audio", mime: "audio/mpeg" });
});

test("ambiguous generated markdown is inferred from content when filename/title lack extension", () => {
  const result = register("Generated Competitive Analysis", null, "# Graft vs Fusion\n\n## TL;DR\n\nThese projects differ.\n");
  assert.equal(result.artifact.kind, "markdown");
  assert.equal(result.artifact.mime, "text/markdown");
  assert.equal(result.version.mime, "text/markdown");
});

test("re-registering the same blob with a filename repairs artifact and version mime", () => {
  const first = register("Legacy Same Blob", null, "# Legacy Report\n\n- originally broken\n");
  const d = store.db();
  d.prepare("UPDATE artifacts SET kind = 'other', mime = 'application/octet-stream', filename = NULL WHERE id = ?").run(first.artifact.id);
  d.prepare("UPDATE versions SET mime = 'application/octet-stream' WHERE id = ?").run(first.version.id);

  const repaired = register("Legacy Same Blob", "legacy.md", "# Legacy Report\n\n- originally broken\n");
  assert.equal(repaired.newVersion, false);
  assert.equal(repaired.artifact.kind, "markdown");
  assert.equal(repaired.artifact.mime, "text/markdown");
  assert.equal(repaired.artifact.filename, "legacy.md");
  assert.equal(repaired.version.mime, "text/markdown");
});

test("ndjson and jsonl filenames are classified as code with application/x-ndjson mime", () => {
  for (const filename of ["events.ndjson", "lines.jsonl"]) {
    const result = register("Events", filename, '{"a":1}\n{"b":2}\n');
    assert.equal(result.artifact.kind, "code", filename);
    assert.equal(result.artifact.mime, "application/x-ndjson", filename);
    assert.equal(result.version.mime, "application/x-ndjson", filename);
  }

  // An extensionless registration with an explicit NDJSON mime also becomes code.
  const extensionless = store.inferArtifactMetadata("events", "application/x-ndjson");
  assert.equal(extensionless.kind, "code");
  assert.equal(extensionless.mime, "application/x-ndjson");
});

test("repairArtifactTypes dry-run and apply repair legacy mismatched metadata", () => {
  const first = register("Legacy Repair Command", null, "<!doctype html>\n<html><body><h1>Legacy</h1></body></html>\n");
  const d = store.db();
  d.prepare("UPDATE artifacts SET kind = 'other', mime = 'application/octet-stream', filename = NULL WHERE id = ?").run(first.artifact.id);
  d.prepare("UPDATE versions SET mime = 'application/octet-stream' WHERE id = ?").run(first.version.id);

  const dry = store.repairArtifactTypes({ ids: [first.artifact.id] });
  assert.equal(dry.length, 1);
  assert.equal(dry[0].changed, true);
  assert.equal(dry[0].applied, false);
  assert.equal(dry[0].after.kind, "html");
  assert.equal(dry[0].after.mime, "text/html");

  const applied = store.repairArtifactTypes({ apply: true, ids: [first.artifact.id] });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].changed, true);
  assert.equal(applied[0].applied, true);

  const art = store.getArtifact(first.artifact.id)!;
  const ver = store.getVersion(first.version.id)!;
  assert.equal(art.kind, "html");
  assert.equal(art.mime, "text/html");
  assert.equal(ver.mime, "text/html");
});
