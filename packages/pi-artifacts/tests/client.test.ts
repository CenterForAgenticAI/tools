import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PreviewShipDeploy } from "../src/previewship.ts";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-client-test-"));
process.env.PI_ARTIFACTS_HOST = "127.0.0.1";
process.env.PI_ARTIFACTS_PUBLIC_URL = "https://client.example.test";

const { ArtifactsClient, asArtifactComment } = await import("../src/client.ts");
const { isInlineSnapshot } = await import("../src/retrieval.ts");
const config = await import("../src/config.ts");
const serverMod = await import("../src/server.ts");

async function listen(options: { previewShipDeploy?: PreviewShipDeploy } = {}): Promise<{ client: InstanceType<typeof ArtifactsClient>; base: string; close: () => Promise<void> }> {
  const server = serverMod.createServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
      process.env.PI_ARTIFACTS_PORT = String(addr.port);
      resolve({
        client: new ArtifactsClient(),
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("inline eligibility requires a kind-compatible text MIME", () => {
  assert.equal(isInlineSnapshot({ kind: "markdown", mime: "text/markdown" }), true);
  assert.equal(isInlineSnapshot({ kind: "markdown", mime: "text/html" }), false);
  assert.equal(isInlineSnapshot({ kind: "html", mime: "text/plain" }), false);
  assert.equal(isInlineSnapshot({ kind: "code", mime: "application/json; charset=utf-8" }), true);
  assert.equal(isInlineSnapshot({ kind: "code", mime: "application/octet-stream" }), false);
  assert.equal(isInlineSnapshot({ kind: "code", mime: "text/html" }), false);
});

test("client registers files/content and drives artifact actions through the daemon", async () => {
  const srv = await listen();
  try {
    assert.equal(await srv.client.isUp(), true);
    assert.equal((await srv.client.health())?.ok, true);

    const source = path.join(config.HOME, "client-source.md");
    fs.writeFileSync(source, "# Client File\n\nclient file body\n");
    const file = await srv.client.addFile(source, {
      project: "client-tests",
      projectPath: "/tmp/client-tests",
      title: "Client File",
      tags: ["file"],
    });
    assert.equal(file.ok, true);
    assert.equal(file.created, true);
    assert.match(file.url, new RegExp(`/view/${file.id}$`));

    const mediaSource = path.join(config.HOME, "client-audio.mp3");
    const mediaBytes = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(1024, 0x2a)]);
    fs.writeFileSync(mediaSource, mediaBytes);
    const media = await srv.client.addFile(mediaSource, {
      project: "client-tests",
      projectPath: "/tmp/client-tests",
      title: "Client Audio",
      mode: "stored",
    });
    const mediaMetadata = await srv.client.get(media.id);
    assert.equal((mediaMetadata?.artifact as { kind?: string } | undefined)?.kind, "audio");
    assert.equal((mediaMetadata?.artifact as { mime?: string } | undefined)?.mime, "audio/mpeg");

    const inline = await srv.client.addContent("# Inline\n\ninline body\n", {
      project: "client-tests",
      projectPath: "/tmp/client-tests",
      title: "Inline",
      filename: "inline.md",
      slug: "inline",
      tags: ["inline"],
    });
    assert.equal(inline.ok, true);
    assert.notEqual(inline.id, file.id);

    const listed = await srv.client.list({ project: "client-tests", q: "inline" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, inline.id);
    assert.equal(listed[0].kind, "markdown");
    assert.equal(listed[0].version_count, 1);

    const projects = await srv.client.projects();
    assert.equal(projects.some((project) => project.project === "client-tests"), true);

    const got = await srv.client.get(inline.id);
    assert.equal(got?.artifact && typeof got.artifact === "object", true);

    assert.equal(await srv.client.tag(inline.id, ["retagged"]), true);
    assert.equal(await srv.client.action(inline.id, "archive"), true);
    assert.equal(await srv.client.action(inline.id, "restore"), true);
    assert.equal(await srv.client.action(inline.id, "delete"), true);
  } finally {
    await srv.close();
  }
});

test("client retrieves immutable text boundaries, historical versions, binary bytes, and atomically materializes output", async () => {
  const srv = await listen();
  try {
    const exactBytes = Buffer.alloc(64 * 1024, 0x61);
    const exact = await srv.client.addContent(exactBytes, { project: "retrieval", title: "exact", filename: "exact.md", slug: "retrieval-exact" });
    const inline = await srv.client.getSnapshot(exact.id);
    assert.equal(inline.disposition, "inline");
    if (inline.disposition === "inline") assert.deepEqual(Buffer.from(inline.content), exactBytes);

    const largeBytes = Buffer.alloc(64 * 1024 + 1, 0x62);
    const large = await srv.client.addContent(largeBytes, { project: "retrieval", title: "large", filename: "large.md", slug: "retrieval-large" });
    const largeResult = await srv.client.getSnapshot(large.id);
    assert.equal(largeResult.disposition, "materialized");
    if (largeResult.disposition === "materialized") assert.deepEqual(fs.readFileSync(largeResult.path), largeBytes);

    const old = await srv.client.addContent("old", { project: "retrieval", title: "history", filename: "history.md", slug: "retrieval-history" });
    const newer = await srv.client.addContent("new", { project: "retrieval", title: "history", filename: "history.md", slug: "retrieval-history" });
    const historical = await srv.client.getSnapshot(newer.id, { version: old.version });
    assert.equal(historical.disposition, "inline");
    if (historical.disposition === "inline") assert.equal(historical.content, "old");

    const historicalBinary = Buffer.from([0, 255, 1, 2]);
    const binaryHistory = await srv.client.addContent(historicalBinary, {
      project: "retrieval", title: "changing-kind", filename: "changing.bin", kind: "other", slug: "retrieval-changing-kind",
    });
    await srv.client.addContent("# now text\n", {
      project: "retrieval", title: "changing-kind", filename: "changing.md", slug: "retrieval-changing-kind",
    });
    const historicalBinaryResult = await srv.client.getSnapshot(binaryHistory.id, { version: binaryHistory.version });
    assert.equal(historicalBinaryResult.disposition, "materialized");
    if (historicalBinaryResult.disposition === "materialized") {
      assert.equal(historicalBinaryResult.reason, "non-text");
      assert.deepEqual(fs.readFileSync(historicalBinaryResult.path), historicalBinary);
      fs.rmSync(path.dirname(historicalBinaryResult.path), { recursive: true, force: true });
    }

    const source = path.join(config.HOME, "immutable-reference.txt");
    fs.writeFileSync(source, "stored before live change\n");
    const referenced = await srv.client.addFile(source, {
      project: "retrieval", title: "immutable-reference", filename: "immutable-reference.txt", slug: "retrieval-reference", mode: "referenced",
    });
    fs.writeFileSync(source, "live replacement\n");
    const referencedSnapshot = await srv.client.getSnapshot(referenced.id);
    assert.equal(referencedSnapshot.disposition, "inline");
    if (referencedSnapshot.disposition === "inline") assert.equal(referencedSnapshot.content, "stored before live change\n");
    fs.rmSync(source, { force: true });

    const binary = Buffer.from([0, 255, 1, 2]);
    const binaryArtifact = await srv.client.addContent(binary, { project: "retrieval", title: "binary", filename: "binary.bin", kind: "other", slug: "retrieval-binary" });
    const destination = path.join(os.tmpdir(), `pi-artifact-retrieval-${process.pid}.bin`);
    fs.writeFileSync(destination, "keep until verified");
    const materialized = await srv.client.getSnapshot(binaryArtifact.id, { output: destination });
    assert.equal(materialized.disposition, "materialized");
    assert.deepEqual(fs.readFileSync(destination), binary);
  } finally { await srv.close(); }
});

test("client materializes invalid UTF-8 and unsafe kind/MIME snapshots as exact bytes", async () => {
  const cases = new Map<string, { title: string; kind: string; mime: string; bytes: Buffer; reason: string }>([
    ["111111111111", { title: "Invalid UTF-8", kind: "code", mime: "text/plain", bytes: Buffer.from([0xc3, 0x28]), reason: "invalid-utf8" }],
    ["222222222222", { title: "Unsafe Markdown", kind: "markdown", mime: "application/octet-stream", bytes: Buffer.from("not rendered", "utf8"), reason: "non-text" }],
    ["333333333333", { title: "Unsupported Kind", kind: "other", mime: "text/plain", bytes: Buffer.from([0, 255, 1]), reason: "unsupported-kind" }],
  ]);
  const server = http.createServer((req, res) => {
    const metadataId = req.url?.match(/^\/api\/artifact\/([^/]+)\/snapshot/)?.[1];
    const rawId = req.url?.match(/^\/raw\/([^/]+)\/v\/1$/)?.[1];
    const id = metadataId || rawId;
    const item = id ? cases.get(id) : undefined;
    if (metadataId && item && req.url === `/api/artifact/${metadataId}/snapshot`) {
      const sha256 = crypto.createHash("sha256").update(item.bytes).digest("hex");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: metadataId, version: 1, title: item.title, kind: item.kind, mime: item.mime, byteLength: item.bytes.length, sha256 } }));
      return;
    }
    if (rawId && item) {
      res.writeHead(200, { "content-length": String(item.bytes.length) });
      res.end(item.bytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ArtifactsClient();
  client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [id, item] of cases) {
      const result = await client.getSnapshot(id);
      assert.equal(result.disposition, "materialized");
      if (result.disposition === "materialized") {
        assert.equal(result.reason, item.reason);
        assert.equal(result.artifactId, id);
        assert.equal(result.byteLength, item.bytes.length);
        assert.equal(result.sha256, crypto.createHash("sha256").update(item.bytes).digest("hex"));
        assert.deepEqual(fs.readFileSync(result.path), item.bytes);
        fs.rmSync(path.dirname(result.path), { recursive: true, force: true });
      }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("client rejects invalid ids and versions before contacting the daemon", async () => {
  const client = new ArtifactsClient();
  await assert.rejects(client.getSnapshot("not-an-id"), (error: { code?: string }) => error.code === "INVALID_ARTIFACT_ID");
  await assert.rejects(client.getSnapshot("aaaaaaaaaaaa", { version: 0 }), (error: { code?: string }) => error.code === "INVALID_VERSION");
  await assert.rejects(client.getSnapshot("aaaaaaaaaaaa", { version: Number.MAX_SAFE_INTEGER + 1 }), (error: { code?: string }) => error.code === "INVALID_VERSION");
});

test("client rejects corrupt or interrupted snapshots without replacing output", async () => {
  const payload = Buffer.from("verified", "utf8");
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/artifact/aaaaaaaaaaaa/snapshot")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: "aaaaaaaaaaaa", version: 1, title: "Corrupt", kind: "code", mime: "text/plain", byteLength: payload.length, sha256: "0".repeat(64) } }));
      return;
    }
    if (req.url === "/raw/aaaaaaaaaaaa/v/1") {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
      return;
    }
    if (req.url?.startsWith("/api/artifact/bbbbbbbbbbbb/snapshot")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: "bbbbbbbbbbbb", version: 1, title: "Pre-response reset", kind: "code", mime: "text/plain", byteLength: 100, sha256: crypto.createHash("sha256").update(payload).digest("hex") } }));
      return;
    }
    if (req.url === "/raw/bbbbbbbbbbbb/v/1") {
      res.writeHead(200, { "content-length": "100" });
      res.write(payload);
      res.destroy();
      return;
    }
    if (req.url?.startsWith("/api/artifact/cccccccccccc/snapshot")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: "cccccccccccc", version: 1, title: "Interrupted", kind: "code", mime: "text/plain", byteLength: 100, sha256: crypto.createHash("sha256").update(payload).digest("hex") } }));
      return;
    }
    if (req.url === "/raw/cccccccccccc/v/1") {
      res.writeHead(200, { "content-length": "100" });
      res.flushHeaders();
      setTimeout(() => { res.write(payload); res.destroy(); }, 10);
      return;
    }
    if (req.url?.startsWith("/api/artifact/dddddddddddd/snapshot")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write('{"ok":true,"metadata":');
      setTimeout(() => res.destroy(), 10);
      return;
    }
    if (req.url?.startsWith("/api/artifact/eeeeeeeeeeee/snapshot")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: "eeeeeeeeeeee", version: 1, title: "Oversized", kind: "code", mime: "text/plain", byteLength: payload.length - 1, sha256: crypto.createHash("sha256").update(payload).digest("hex") } }));
      return;
    }
    if (req.url === "/raw/eeeeeeeeeeee/v/1") {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
      return;
    }
    if (req.url === "/api/artifact/abababababab/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: "abababababab", version: 1, title: "Missing bytes", kind: "code", mime: "text/plain", byteLength: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex") } }));
      return;
    }
    if (req.url === "/raw/abababababab/v/1") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const client = new ArtifactsClient();
  client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-corrupt-"));
  const output = path.join(outputDir, "snapshot.txt");
  fs.writeFileSync(output, "original");
  try {
    await assert.rejects(client.getSnapshot("aaaaaaaaaaaa", { output }), (error: { code?: string }) => error.code === "HASH_MISMATCH");
    assert.equal(fs.readFileSync(output, "utf8"), "original");
    await assert.rejects(client.getSnapshot("bbbbbbbbbbbb", { output }), (error: { code?: string }) => error.code === "TRANSPORT_ERROR");
    assert.equal(fs.readFileSync(output, "utf8"), "original");
    await assert.rejects(client.getSnapshot("cccccccccccc", { output }), (error: { code?: string }) => error.code === "INTERRUPTED");
    assert.equal(fs.readFileSync(output, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(outputDir), ["snapshot.txt"], "failed transfers leave no staging files");
    await assert.rejects(client.getSnapshot("dddddddddddd"), (error: { code?: string }) => error.code === "INTERRUPTED");
    await assert.rejects(client.getSnapshot("eeeeeeeeeeee"), (error: { code?: string }) => error.code === "LENGTH_MISMATCH");
    await assert.rejects(client.getSnapshot("abababababab"), (error: { code?: string }) => error.code === "SNAPSHOT_UNAVAILABLE");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test("client rejects malformed completed metadata responses before requesting bytes", async () => {
  const rawRequests: string[] = [];
  const server = http.createServer((req, res) => {
    const metadataId = req.url?.match(/^\/api\/artifact\/([^/]+)\/snapshot/)?.[1];
    const rawId = req.url?.match(/^\/raw\/([^/]+)\/v\/1$/)?.[1];
    if (rawId) {
      rawRequests.push(rawId);
      res.writeHead(200, { "content-length": "0" }).end();
      return;
    }
    if (!metadataId) { res.writeHead(404).end(); return; }
    const metadata: Record<string, unknown> = {
      artifactId: metadataId, version: 1, title: "Malformed", kind: "code", mime: "text/plain", byteLength: 1, sha256: "0".repeat(64),
    };
    const bodies: Record<string, string> = {
      "121212121212": "not json",
      "232323232323": JSON.stringify([]),
      "343434343434": JSON.stringify("primitive"),
      "454545454545": JSON.stringify({ metadata }),
      "565656565656": JSON.stringify({ ok: false, code: "ARTIFACT_NOT_FOUND" }),
      "676767676767": JSON.stringify({ ok: true }),
    };
    if (metadataId === "dddddddddddd") metadata.kind = "unknown";
    if (metadataId === "eeeeeeeeeeee") delete metadata.mime;
    if (metadataId === "ffffffffffff") metadata.mime = "not-a-mime";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(bodies[metadataId] ?? JSON.stringify({ ok: true, metadata }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ArtifactsClient();
  client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const id of [
      "121212121212", "232323232323", "343434343434", "454545454545", "565656565656", "676767676767",
      "dddddddddddd", "eeeeeeeeeeee", "ffffffffffff",
    ]) {
      await assert.rejects(client.getSnapshot(id), (error: { code?: string }) => error.code === "INVALID_DAEMON_RESPONSE");
    }
    assert.deepEqual(rawRequests, [], "malformed metadata never starts a raw transfer");

    const codedFailure = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "ARTIFACT_NOT_FOUND", error: "missing" }));
    });
    await new Promise<void>((resolve) => codedFailure.listen(0, "127.0.0.1", resolve));
    try {
      client.base = `http://127.0.0.1:${(codedFailure.address() as AddressInfo).port}`;
      await assert.rejects(client.getSnapshot("787878787878"), (error: { code?: string }) => error.code === "ARTIFACT_NOT_FOUND");
    } finally {
      await new Promise<void>((resolve) => codedFailure.close(() => resolve()));
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("client cancellation interrupts retrieval without replacing output or leaving partial data", async () => {
  const alreadyAbortedOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-aborted-output-"));
  const alreadyAbortedOutput = path.join(alreadyAbortedOutputDir, "snapshot.bin");
  fs.writeFileSync(alreadyAbortedOutput, "preserve");
  let alreadyAbortedRequests = 0;
  const alreadyAbortedServer = http.createServer((_req, res) => {
    alreadyAbortedRequests++;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => alreadyAbortedServer.listen(0, "127.0.0.1", resolve));
  const alreadyAbortedClient = new ArtifactsClient();
  alreadyAbortedClient.base = `http://127.0.0.1:${(alreadyAbortedServer.address() as AddressInfo).port}`;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  try {
    await assert.rejects(
      alreadyAbortedClient.getSnapshot("121212121212", { output: alreadyAbortedOutput, signal: alreadyAborted.signal }),
      (error: { code?: string }) => error.code === "INTERRUPTED",
    );
    assert.equal(alreadyAbortedRequests, 0);
    assert.equal(fs.readFileSync(alreadyAbortedOutput, "utf8"), "preserve");
    assert.deepEqual(fs.readdirSync(alreadyAbortedOutputDir), ["snapshot.bin"]);
  } finally {
    await new Promise<void>((resolve) => alreadyAbortedServer.close(() => resolve()));
    fs.rmSync(alreadyAbortedOutputDir, { recursive: true, force: true });
  }

  const bytes = Buffer.alloc(128 * 1024, 0x63);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let rawSeenResolve: (() => void) | null = null;
  const transferServer = http.createServer((req, res) => {
    if (req.url === "/api/artifact/898989898989/snapshot" || req.url === "/api/artifact/909090909090/snapshot") {
      const id = req.url.includes("8989") ? "898989898989" : "909090909090";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: id, version: 1, title: "Cancelled", kind: "other", mime: "application/octet-stream", byteLength: bytes.length, sha256 } }));
      return;
    }
    if (req.url === "/raw/898989898989/v/1" || req.url === "/raw/909090909090/v/1") {
      res.writeHead(200, { "content-length": String(bytes.length) });
      res.write(bytes.subarray(0, 1024));
      rawSeenResolve?.();
      res.on("close", () => { if (!res.writableEnded) res.destroy(); });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => transferServer.listen(0, "127.0.0.1", resolve));
  const transferClient = new ArtifactsClient();
  transferClient.base = `http://127.0.0.1:${(transferServer.address() as AddressInfo).port}`;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-cancel-output-"));
  const output = path.join(outputDir, "snapshot.bin");
  fs.writeFileSync(output, "preserve");
  const controller = new AbortController();
  const firstRawSeen = new Promise<void>((resolve) => { rawSeenResolve = resolve; });
  const transfer = transferClient.getSnapshot("898989898989", { output, signal: controller.signal });
  try {
    await firstRawSeen;
    controller.abort();
    await assert.rejects(transfer, (error: { code?: string }) => error.code === "INTERRUPTED");
    assert.equal(fs.readFileSync(output, "utf8"), "preserve");
    assert.deepEqual(fs.readdirSync(outputDir), ["snapshot.bin"]);

    const before = new Set(fs.readdirSync(os.tmpdir()));
    const generatedController = new AbortController();
    const secondRawSeen = new Promise<void>((resolve) => { rawSeenResolve = resolve; });
    const generated = transferClient.getSnapshot("909090909090", { signal: generatedController.signal });
    await secondRawSeen;
    generatedController.abort();
    await assert.rejects(generated, (error: { code?: string }) => error.code === "INTERRUPTED");
    const remaining = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-artifact-") && !before.has(entry));
    assert.deepEqual(remaining, [], "cancelled generated materialization directories are removed");
  } finally {
    await new Promise<void>((resolve) => transferServer.close(() => resolve()));
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("client materializes long titles and explicit output basenames", async () => {
  const id = "999999999999";
  const bytes = Buffer.from([0, 255, 1, 2]);
  const title = "x".repeat(230);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const server = http.createServer((req, res) => {
    if (req.url === `/api/artifact/${id}/snapshot`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, metadata: { artifactId: id, version: 1, title, kind: "other", mime: "application/octet-stream", byteLength: bytes.length, sha256 } }));
      return;
    }
    if (req.url === `/raw/${id}/v/1`) {
      res.writeHead(200, { "content-length": String(bytes.length) });
      res.end(bytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ArtifactsClient();
  client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-long-output-"));
  const explicit = path.join(parent, `${"y".repeat(230)}.bin`);
  try {
    const automatic = await client.getSnapshot(id);
    assert.equal(automatic.disposition, "materialized");
    if (automatic.disposition === "materialized") {
      assert.deepEqual(fs.readFileSync(automatic.path), bytes);
      fs.rmSync(path.dirname(automatic.path), { recursive: true, force: true });
    }
    const requested = await client.getSnapshot(id, { output: explicit });
    assert.equal(requested.disposition, "materialized");
    assert.deepEqual(fs.readFileSync(explicit), bytes);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("client classifies metadata and raw-transfer timeouts as transport errors", async () => {
  const originalSetTimeout = http.ClientRequest.prototype.setTimeout;
  http.ClientRequest.prototype.setTimeout = function (_timeout: number, callback: () => void) {
    setTimeout(callback, 10);
    return this;
  };
  const content = Buffer.from("timeout body");
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  let metadataRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/artifact/ffffffffffff/snapshot") {
      metadataRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const body = JSON.stringify({ ok: true, metadata: { artifactId: "ffffffffffff", version: 1, title: "Timeout", kind: "code", mime: "text/plain", byteLength: content.length, sha256 } });
      if (metadataRequests === 1) setTimeout(() => res.end(body), 30); else res.end(body);
      return;
    }
    if (req.url === "/raw/ffffffffffff/v/1") {
      res.writeHead(200, { "content-length": String(content.length) });
      res.flushHeaders();
      setTimeout(() => res.end(content), 30);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ArtifactsClient();
  client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output = path.join(os.tmpdir(), `pi-artifact-timeout-${process.pid}.txt`);
  fs.writeFileSync(output, "preserve");
  try {
    await assert.rejects(client.getSnapshot("ffffffffffff"), (error: { code?: string }) => error.code === "TRANSPORT_ERROR");
    await assert.rejects(client.getSnapshot("ffffffffffff", { output }), (error: { code?: string }) => error.code === "TRANSPORT_ERROR");
    assert.equal(fs.readFileSync(output, "utf8"), "preserve");
  } finally {
    http.ClientRequest.prototype.setTimeout = originalSetTimeout;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(output, { force: true });
  }
});

test("client falls back to legacy JSON registration for small files and rejects large fallback buffering", async () => {
  let legacyPayload: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: 1 }));
      return;
    }
    if (req.url === "/api/register-file") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.url === "/api/register" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        legacyPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "abcdefabcdef", created: true, newVersion: true, version: 1, url: "https://legacy.example.test/view/abcdefabcdef" }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PI_ARTIFACTS_PORT = String((server.address() as AddressInfo).port);
  const client = new ArtifactsClient();
  const source = path.join(config.HOME, "legacy-compatible.bin");
  const large = path.join(config.HOME, "legacy-too-large.bin");
  fs.writeFileSync(source, "legacy bytes");
  fs.writeFileSync(large, "");
  fs.truncateSync(large, 49 * 1024 * 1024);
  try {
    const registered = await client.addFile(source, {
      project: "client-tests",
      title: "Legacy Compatible",
      mime: "application/x-browser-native",
    });
    assert.equal(registered.id, "abcdefabcdef");
    assert.ok(legacyPayload);
    const payload = legacyPayload as Record<string, unknown>;
    assert.equal(payload.mime, "application/x-browser-native");
    assert.equal(Buffer.from(String(payload.contentBase64), "base64").toString("utf8"), "legacy bytes");

    await assert.rejects(
      () => client.addFile(large, { project: "client-tests", title: "Legacy Too Large" }),
      /restart or upgrade the artifact daemon/i,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(source, { force: true });
    fs.rmSync(large, { force: true });
  }
});

test("client publishes a registered artifact through PreviewShip", async () => {
  const srv = await listen({
    previewShipDeploy: async (options = {}) => ({
      success: true,
      deploymentId: 2718,
      projectName: options.projectName,
      previewUrl: "https://client-preview.previewship.test",
      status: "READY",
      visibility: "PUBLIC",
    }),
  });


  try {
    const artifact = await srv.client.addContent("<!doctype html><p>client publish</p>", {
      project: "client-tests",
      title: "Client Publish",
      filename: "client-publish.html",
    });
    const published = await srv.client.publishToPreviewShip(artifact.id, { projectName: "client-publish" });
    assert.equal(published.ok, true);
    assert.equal(published.artifactId, artifact.id);
    assert.equal(published.projectName, "client-publish");
    assert.equal(published.deploymentId, 2718);
    assert.equal(published.previewUrl, "https://client-preview.previewship.test");
  } finally {
    await srv.close();
  }
});

test("client rejects malformed nested annotation records", () => {
  const base = { id: "a".repeat(32), body: "ok", createdAt: 1, updatedAt: 1, status: "open", placementStatus: "anchored", origin: { versionId: 1, blob: "b".repeat(64), representationVersion: 1, target: { type: "text", start: 0, end: 1, quote: "x", prefix: "", suffix: "" } }, placements: [{ versionId: 1, state: "anchored", target: { type: "text", start: 0, end: 1, quote: "x", prefix: "", suffix: "" }, provenance: { representationVersion: 1, sourceVersionId: 1, sourceBlob: "b".repeat(64), method: "exact-position", confidence: "high", placedAt: 1 } }] };
  assert.ok(asArtifactComment(base));
  assert.equal(asArtifactComment({ ...base, origin: { ...base.origin, target: { ...base.origin.target, end: 0 } } }), null);
  assert.equal(asArtifactComment({ ...base, placements: [{ ...base.placements[0], provenance: { ...base.placements[0].provenance, sourceBlob: "bad" } }] }), null);
  assert.equal(asArtifactComment({ ...base, placements: [base.placements[0], base.placements[0]] }), null);
  assert.equal(asArtifactComment({ ...base, placements: [{ ...base.placements[0], target: { ...base.placements[0].target, quote: "different" } }] }), null);
  assert.equal(asArtifactComment({ ...base, placements: [{ ...base.placements[0], state: "migrated" }] }), null);
  assert.equal(asArtifactComment({ ...base, replies: [{ id: "c".repeat(32), body: "reply", author: "robot", createdAt: 1 }] }), null);
  assert.equal(asArtifactComment({ ...base, replies: [{ id: "c".repeat(32), body: "reply", author: "agent", createdAt: 2 }] }), null, "reply timestamps cannot exceed the thread update timestamp");
});

test("client reads immutable annotation comments with placement status", async () => {
  const srv = await listen();
  try {
    const artifact = await srv.client.addContent("# Commented\n", { project: "client-tests", title: "Commented", filename: "commented.md" });
    const initial = await fetch(`${srv.client.base}/api/artifact/${artifact.id}/annotations`);
    const created = await fetch(`${srv.client.base}/api/artifact/${artifact.id}/annotations`, {
      method: "POST", headers: { "content-type": "application/json", "if-match": initial.headers.get("etag")! },
      body: JSON.stringify({ versionId: artifact.version, target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, body: "A durable comment" }),
    });
    assert.equal(created.status, 201);
    const comments = await srv.client.comments(artifact.id);
    assert.equal(comments.comments.length, 1);
    assert.equal(comments.versionId, artifact.version);
    assert.equal(comments.comments[0].status, "open");
    assert.equal(comments.comments[0].placementStatus, "anchored");
    assert.equal(comments.comments[0].body, "A durable comment");
    const open = await srv.client.comments(artifact.id, artifact.version, "open");
    assert.equal(open.comments.length, 1);
    await assert.rejects(() => srv.client.comments("not/an/id"), /invalid artifact id/);
    await assert.rejects(() => srv.client.comments(artifact.id, 0), /invalid version id/);
  } finally { await srv.close(); }
});

test("client creates agent-authored comments and replies only through explicit methods", async () => {
  const srv = await listen();
  try {
    const artifact = await srv.client.addContent("Review target\n", { project: "client-tests", title: "Agent review", filename: "review.txt" });
    const target = { type: "text" as const, start: 0, end: 6, quote: "Review", prefix: "", suffix: " target\n" };
    const created = await srv.client.createComment(artifact.id, { versionId: artifact.version, target, body: "Agent finding" });
    assert.equal(created.artifactId, artifact.id);
    assert.equal(created.comment.author, "agent");
    assert.equal(created.comment.body, "Agent finding");
    assert.deepEqual(created.comment.replies, []);

    const replied = await srv.client.replyToComment(artifact.id, { annotationId: created.comment.id, versionId: artifact.version, body: "Agent follow-up" });
    assert.equal(replied.annotationId, created.comment.id);
    assert.equal(replied.reply.author, "agent");
    assert.equal(replied.reply.body, "Agent follow-up");
    assert.equal(replied.status, "open");

    const comments = await srv.client.comments(artifact.id, artifact.version);
    assert.equal(comments.comments[0].author, "agent");
    assert.deepEqual(comments.comments[0].replies.map((reply) => [reply.author, reply.body]), [["agent", "Agent follow-up"]]);
    await assert.rejects(() => srv.client.replyToComment(artifact.id, { annotationId: "f".repeat(32), versionId: artifact.version, body: "missing" }), /comment not found/);

    // Re-issuing the same logical create/reply (e.g. a re-executed tool call after a lost
    // response) is idempotent: the deterministic content-derived operation id resolves to the
    // same record instead of creating a duplicate.
    const recreated = await srv.client.createComment(artifact.id, { versionId: artifact.version, target, body: "Agent finding" });
    assert.equal(recreated.comment.id, created.comment.id, "identical create dedups to the same comment");
    const rereplied = await srv.client.replyToComment(artifact.id, { annotationId: created.comment.id, versionId: artifact.version, body: "Agent follow-up" });
    assert.equal(rereplied.reply.id, replied.reply.id, "identical reply dedups to the same reply");
    const afterReplay = await srv.client.comments(artifact.id, artifact.version);
    assert.equal(afterReplay.comments.length, 1, "no duplicate comment after replay");
    assert.equal(afterReplay.comments[0].replies.length, 1, "no duplicate reply after replay");

    // An already-aborted signal stops an explicit write before it reaches the daemon.
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => srv.client.createComment(artifact.id, { versionId: artifact.version, target, body: "should not persist" }, aborted.signal), /aborted/);
    await assert.rejects(() => srv.client.replyToComment(artifact.id, { annotationId: created.comment.id, versionId: artifact.version, body: "should not persist" }, aborted.signal), /aborted/);
    const afterAbort = await srv.client.comments(artifact.id, artifact.version);
    assert.equal(afterAbort.comments.length, 1, "aborted writes did not persist");
    assert.equal(afterAbort.comments[0].replies.length, 1, "aborted reply did not persist");
  } finally { await srv.close(); }
});

test("agent comment create rejects a foreign record occupying its deterministic operation id", async () => {
  const srv = await listen();
  try {
    const artifact = await srv.client.addContent("Squat target\n", { project: "client-tests", title: "Squat", filename: "squat.txt" });
    const target = { type: "text" as const, start: 0, end: 5, quote: "Squat", prefix: "", suffix: " target\n" };
    // Replicate the client's deterministic id derivation, then have a *user* comment occupy it.
    const parts = ["create-comment", artifact.id, artifact.version, "text", target.start, target.end, target.quote, target.prefix, target.suffix, "Agent finding"];
    const opId = crypto.createHash("sha256").update(parts.map((p) => JSON.stringify(p)).join("\u0000")).digest("hex").slice(0, 32);
    const initial = await fetch(`${srv.base}/api/artifact/${artifact.id}/annotations?version=${artifact.version}`);
    const seed = await fetch(`${srv.base}/api/artifact/${artifact.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": initial.headers.get("etag")!, "x-pi-artifacts-operation-id": opId }, body: JSON.stringify({ versionId: artifact.version, target, body: "user squatting" }) });
    assert.equal(seed.status, 201);
    // The agent create must NOT treat the foreign user record as its own idempotent replay.
    await assert.rejects(() => srv.client.createComment(artifact.id, { versionId: artifact.version, target, body: "Agent finding" }), /already used for different content/);
  } finally { await srv.close(); }
});

test("client lists applets and reports repair-type results with typed fields", async () => {
  const appDir = path.join(config.APPLETS_DIR, "clientapp");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "applet.json"), JSON.stringify({ id: "clientapp", title: "Client App", entry: "index.html" }));
  fs.writeFileSync(path.join(appDir, "index.html"), "<!doctype html><p>client app</p>");

  const srv = await listen();
  try {
    const applets = await srv.client.applets();
    assert.equal(applets.some((app) => app.id === "clientapp" && app.url === "https://client.example.test/applets/clientapp/" && app.apiUrl === "https://client.example.test/api/applets/clientapp/"), true);

    const legacy = await srv.client.addContent("<!doctype html><html><body>legacy</body></html>", {
      project: "client-tests",
      title: "Legacy",
      slug: "legacy",
    });
    const d = (await import("../src/store.ts")).db();
    d.prepare("UPDATE artifacts SET kind = 'other', mime = 'application/octet-stream' WHERE id = ?").run(legacy.id);
    d.prepare("UPDATE versions SET mime = 'application/octet-stream' WHERE artifact_id = ?").run(legacy.id);

    const dryRun = await srv.client.repairTypes({ ids: [legacy.id] });
    assert.equal(dryRun.length, 1);
    assert.equal(dryRun[0].changed, true);
    assert.equal(dryRun[0].before.kind, "other");
    assert.equal(dryRun[0].after.kind, "html");
  } finally {
    await srv.close();
  }
});
