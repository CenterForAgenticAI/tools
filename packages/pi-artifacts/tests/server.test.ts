import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PreviewShipDeploy } from "../src/previewship.ts";
import type { ServerOptions } from "../src/server.ts";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-server-test-"));
process.env.PI_ARTIFACTS_PUBLIC_HOST = "artifacts.example.test";

const config = await import("../src/config.ts");
const store = await import("../src/store.ts");
const serverMod = await import("../src/server.ts");
const previewShipHeaders = {
  "content-type": "application/json",
  [config.PREVIEWSHIP_PUBLISH_HEADER]: config.PREVIEWSHIP_PUBLISH_HEADER_VALUE,
};

async function listen(options: ServerOptions = {}): Promise<{ base: string; close: () => Promise<void> }> {
  const server = serverMod.createServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T;
}

test("register/list/raw/tag/archive/restore/delete use isolated artifact state", async () => {
  const srv = await listen();
  try {
    const content = Buffer.from("# Server Report\n\nsearchable registry text\n", "utf8");
    const registerRes = await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        projectPath: "/tmp/server-tests",
        title: "Server Report",
        filename: "report.md",
        mode: "stored",
        tags: ["ci", "server"],
        contentBase64: content.toString("base64"),
      }),
    });
    assert.equal(registerRes.status, 200);
    const registered = await json<{ ok: boolean; id: string; created: boolean; newVersion: boolean; url: string }>(registerRes);
    assert.equal(registered.ok, true);
    assert.equal(registered.created, true);
    assert.equal(registered.newVersion, true);
    assert.match(registered.url, new RegExp(`/view/${registered.id}$`));

    const listed = await json<{ items: Array<{ id: string; title: string; tags: string[]; version_count: number }> }>(
      await fetch(`${srv.base}/api/list?project=server-tests&q=searchable&sort=title`),
    );
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, registered.id);
    assert.deepEqual(listed.items[0].tags, ["ci", "server"]);
    assert.equal(listed.items[0].version_count, 1);

    const raw = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "text/markdown");
    assert.equal(raw.headers.get("x-artifact-live"), "false");
    assert.match(raw.headers.get("content-disposition") || "", /filename="report\.md"/);
    assert.equal(await raw.text(), content.toString("utf8"));

    const tagResult = await json<{ ok: boolean }>(await fetch(`${srv.base}/api/artifact/${registered.id}/tag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["updated"] }),
    }));
    assert.equal(tagResult.ok, true);

    assert.equal((await json<{ ok: boolean }>(await fetch(`${srv.base}/api/artifact/${registered.id}/archive`, { method: "POST" }))).ok, true);
    assert.deepEqual((await json<{ items: unknown[] }>(await fetch(`${srv.base}/api/list?project=server-tests`))).items, []);
    assert.equal((await json<{ ok: boolean }>(await fetch(`${srv.base}/api/artifact/${registered.id}/restore`, { method: "POST" }))).ok, true);
    assert.equal((await json<{ items: unknown[] }>(await fetch(`${srv.base}/api/list?project=server-tests`))).items.length, 1);
    assert.equal((await json<{ ok: boolean }>(await fetch(`${srv.base}/api/artifact/${registered.id}/delete`, { method: "POST" }))).ok, true);
    assert.equal((await fetch(`${srv.base}/raw/${registered.id}`)).status, 404);
  } finally {
    await srv.close();
  }
});

test("snapshot metadata selects immutable current and historical versions with stable errors", async () => {
  const srv = await listen();
  try {
    const first = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Snapshot", filename: "snapshot.md", mode: "stored", slug: "snapshot-test", contentBase64: Buffer.from("first", "utf8").toString("base64") }),
    }));
    const second = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Snapshot", filename: "snapshot.md", mode: "stored", slug: "snapshot-test", contentBase64: Buffer.from("second", "utf8").toString("base64") }),
    }));
    const current = await json<{ ok: boolean; metadata: { artifactId: string; version: number; title: string; kind: string; mime: string; byteLength: number; sha256: string } }>(await fetch(`${srv.base}/api/artifact/${first.id}/snapshot`));
    assert.equal(current.ok, true);
    assert.deepEqual(Object.keys(current.metadata).sort(), ["artifactId", "byteLength", "kind", "mime", "sha256", "title", "version"]);
    assert.equal(current.metadata.artifactId, first.id);
    assert.equal(current.metadata.version, second.version);
    assert.equal(current.metadata.title, "Snapshot");
    assert.equal(current.metadata.kind, "markdown");
    assert.equal(current.metadata.mime, "text/markdown");
    assert.equal(current.metadata.byteLength, 6);
    assert.match(current.metadata.sha256, /^[a-f0-9]{64}$/);
    const historical = await json<{ metadata: { artifactId: string; version: number; title: string; kind: string; mime: string; byteLength: number; sha256: string } }>(await fetch(`${srv.base}/api/artifact/${first.id}/snapshot?version=${first.version}`));
    assert.equal(historical.metadata.artifactId, first.id);
    assert.equal(historical.metadata.version, first.version);
    assert.equal(historical.metadata.title, "Snapshot");
    assert.equal(historical.metadata.kind, "markdown");
    assert.equal(historical.metadata.mime, "text/markdown");
    assert.equal(historical.metadata.byteLength, 5);
    assert.match(historical.metadata.sha256, /^[a-f0-9]{64}$/);

    const transitionOld = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Kind transition", filename: "transition.md", mode: "stored", slug: "kind-transition", contentBase64: Buffer.from("# old snapshot\n", "utf8").toString("base64") }),
    }));
    const transitionBytes = Buffer.from([0, 1, 2, 255]);
    const transitionCurrent = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Kind transition", filename: "transition.bin", mode: "stored", slug: "kind-transition", contentBase64: transitionBytes.toString("base64") }),
    }));
    const transitionCurrentMetadata = await json<{ metadata: { kind: string; mime: string } }>(await fetch(`${srv.base}/api/artifact/${transitionCurrent.id}/snapshot`));
    assert.equal(transitionCurrentMetadata.metadata.kind, "other");
    assert.equal(transitionCurrentMetadata.metadata.mime, "application/octet-stream");
    const transitionHistoricalMetadata = await json<{ metadata: { kind: string; mime: string } }>(await fetch(`${srv.base}/api/artifact/${transitionOld.id}/snapshot?version=${transitionOld.version}`));
    assert.equal(transitionHistoricalMetadata.metadata.kind, "markdown");
    assert.equal(transitionHistoricalMetadata.metadata.mime, "text/markdown");

    const unknownMimeOld = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Unknown MIME history", filename: "history.txt", mime: "application/x-synthetic-history", mode: "stored", slug: "unknown-mime-history", contentBase64: Buffer.from("legacy bytes", "utf8").toString("base64") }),
    }));
    const unknownMimeCurrent = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Unknown MIME history", filename: "history.md", mode: "stored", slug: "unknown-mime-history", contentBase64: Buffer.from("# current snapshot\n", "utf8").toString("base64") }),
    }));
    const unknownMimeCurrentMetadata = await json<{ metadata: { kind: string; mime: string } }>(await fetch(`${srv.base}/api/artifact/${unknownMimeCurrent.id}/snapshot`));
    assert.equal(unknownMimeCurrentMetadata.metadata.kind, "markdown");
    assert.equal(unknownMimeCurrentMetadata.metadata.mime, "text/markdown");
    const unknownMimeHistoricalMetadata = await json<{ metadata: { kind: string; mime: string } }>(await fetch(`${srv.base}/api/artifact/${unknownMimeOld.id}/snapshot?version=${unknownMimeOld.version}`));
    assert.equal(unknownMimeHistoricalMetadata.metadata.kind, "other");
    assert.equal(unknownMimeHistoricalMetadata.metadata.mime, "application/x-synthetic-history");

    const foreign = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Foreign", filename: "foreign.md", mode: "stored", slug: "foreign-snapshot-test", contentBase64: Buffer.from("foreign", "utf8").toString("base64") }),
    }));
    const malformedId = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/not-an-artifact/snapshot`));
    assert.equal(malformedId.code, "INVALID_ARTIFACT_ID");
    const malformed = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/${first.id}/snapshot?version=nope`));
    assert.equal(malformed.code, "INVALID_VERSION");
    const missing = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/deadbeefdead/snapshot`));
    assert.equal(missing.code, "ARTIFACT_NOT_FOUND");
    const unknownVersion = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/${first.id}/snapshot?version=999999999`));
    assert.equal(unknownVersion.code, "VERSION_NOT_FOUND");
    const foreignVersion = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/${first.id}/snapshot?version=${foreign.version}`));
    assert.equal(foreignVersion.code, "VERSION_NOT_FOUND");
    const unavailable = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "snapshot-tests", title: "Unavailable", filename: "unavailable.bin", mode: "stored", slug: "unavailable-snapshot-test", contentBase64: Buffer.from("gone", "utf8").toString("base64") }),
    }));
    const unavailableVersion = store.getVersion(unavailable.version);
    assert.ok(unavailableVersion);
    fs.rmSync(store.blobFile(unavailableVersion.blob), { force: true });
    const unavailableResponse = await fetch(`${srv.base}/api/artifact/${unavailable.id}/snapshot`);
    assert.equal(unavailableResponse.status, 500);
    assert.equal((await json<{ code: string }>(unavailableResponse)).code, "SNAPSHOT_UNAVAILABLE");
  } finally { await srv.close(); }
});

test("annotation routes use JSON sidecars, ETag CAS, ownership checks, and deletion cleanup", async () => {
  const srv = await listen();
  try {
    const registered = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "server-tests", title: "Annotated", filename: "annotated.md", mode: "stored", contentBase64: Buffer.from("# Title\n").toString("base64") }),
    }));
    const viewer = await fetch(`${srv.base}/view/${registered.id}`);
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /id="annotations-btn"/);
    assert.equal((await fetch(`${srv.base}/annotations.js`)).status, 200);
    assert.equal((await fetch(`${srv.base}/annotation-frame.js`)).status, 200);
    const initial = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`);
    assert.equal(initial.status, 200);
    const etag = initial.headers.get("etag");
    assert.equal(etag, `W/"annotations-${registered.id}-0"`);
    const create = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, {
      method: "POST", headers: { "content-type": "application/json", "if-match": etag! },
      body: JSON.stringify({ versionId: registered.version, target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, body: "Heading" }),
    });
    assert.equal(create.status, 201);
    const created = await json<{ revision: number; annotations: Array<{ id: string; origin: { versionId: number; blob: string } }> }>(create);
    assert.equal(created.revision, 1); assert.equal(created.annotations[0].origin.versionId, registered.version); assert.match(created.annotations[0].origin.blob, /^[a-f0-9]{64}$/);
    const reopened = await json<{ revision: number; title: string; currentVersion: number; viewerUrl: string; annotations: Array<{ body: string; status: string; placementStatus: string; updatedAt: number; placements: Array<{ provenance: { sourceVersionId: number; method: string; confidence: string; placedAt: number } }> }>; comments: Array<{ status: string }> }>(await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${registered.version}`));
    assert.equal(reopened.revision, 1); assert.equal(reopened.title, "Annotated"); assert.equal(reopened.currentVersion, registered.version); assert.match(reopened.viewerUrl, new RegExp(`/view/${registered.id}$`)); assert.equal(reopened.annotations[0].body, "Heading"); assert.equal(reopened.annotations[0].status, "open"); assert.equal(reopened.annotations[0].placementStatus, "anchored"); assert.equal(reopened.comments[0].status, "open"); assert.equal(reopened.annotations[0].placements[0].provenance.sourceVersionId, registered.version); assert.equal(reopened.annotations[0].placements[0].provenance.method, "exact-position"); assert.equal(reopened.annotations[0].placements[0].provenance.confidence, "high"); assert.ok(reopened.annotations[0].placements[0].provenance.placedAt > 0);
    const filtered = await json<{ comments: Array<{ status: string }> }>(await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${registered.version}&status=open`));
    assert.equal(filtered.comments.length, 1);
    const invalidBody = await json<{ code: string }>(await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": `W/"annotations-${registered.id}-1"` }, body: JSON.stringify({ versionId: registered.version, target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, body: "bad", extra: true }) }));
    assert.equal(invalidBody.code, "ANNOTATION_INVALID");
    const newer = await json<{ version: number }>(await fetch(`${srv.base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "server-tests", title: "Annotated", filename: "annotated.md", mode: "stored", contentBase64: Buffer.from("# Revised\\n").toString("base64") }) }));
    const migrated = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations/placements`, { method: "POST", headers: { "content-type": "application/json", "if-match": `W/"annotations-${registered.id}-1"` }, body: JSON.stringify({ versionId: newer.version, placements: [{ annotationId: created.annotations[0].id, placement: { versionId: newer.version, state: "migrated", target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, provenance: { representationVersion: 1, sourceVersionId: registered.version, sourceBlob: created.annotations[0].origin.blob, method: "unique-context", confidence: "high", placedAt: 1 } } }] }) });
    assert.equal(migrated.status, 200);
    const migratedBody = await json<{ revision: number; annotations: Array<{ placements: Array<{ versionId: number; state: string }> }> }>(migrated);
    assert.equal(migratedBody.annotations[0].placements.at(-1)?.state, "migrated");
    const stale = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${created.annotations[0].id}`, {
      method: "PATCH", headers: { "content-type": "application/json", "if-match": etag! }, body: JSON.stringify({ body: "stale", expectedUpdatedAt: reopened.annotations[0].updatedAt }),
    });
    assert.equal(stale.status, 412);
    assert.equal((await json<{ code: string }>(stale)).code, "ANNOTATION_CONFLICT");
    const edited = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${created.annotations[0].id}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": `W/"annotations-${registered.id}-${migratedBody.revision}"` }, body: JSON.stringify({ body: "Edited heading", status: "resolved", expectedUpdatedAt: reopened.annotations[0].updatedAt }) });
    assert.equal(edited.status, 200);
    const itemConflict = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${created.annotations[0].id}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": edited.headers.get("etag")! }, body: JSON.stringify({ body: "overwrite newer edit", expectedUpdatedAt: reopened.annotations[0].updatedAt }) });
    assert.equal(itemConflict.status, 409);
    assert.equal(itemConflict.headers.get("etag"), edited.headers.get("etag"));
    assert.equal((await json<{ code: string }>(itemConflict)).code, "ANNOTATION_ITEM_CONFLICT");
    const afterEdit = await json<{ annotations: Array<{ body: string; status: string; placements: Array<{ versionId: number }> }> }>(await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${newer.version}&status=resolved`));
    assert.equal(afterEdit.annotations[0].body, "Edited heading");
    assert.equal(afterEdit.annotations[0].status, "resolved");
    assert.equal(afterEdit.annotations[0].placements.at(-1)?.versionId, newer.version);
    const editedBody = await json<{ annotations: Array<{ updatedAt: number }> }>(edited.clone());
    const deletedNote = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${created.annotations[0].id}`, { method: "DELETE", headers: { "content-type": "application/json", "if-match": `W/"annotations-${registered.id}-${migratedBody.revision + 1}"` }, body: JSON.stringify({ expectedUpdatedAt: editedBody.annotations[0].updatedAt }) });
    assert.equal(deletedNote.status, 200);
    assert.equal((await json<{ annotations: unknown[] }>(deletedNote)).annotations.length, 0);
    const formPost = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", body: "versionId=1" });
    assert.equal(formPost.status, 415);
    const missingCas = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: registered.version, target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, body: "missing CAS" }) });
    assert.equal(missingCas.status, 428);
    assert.equal((await json<{ ok: boolean }>(await fetch(`${srv.base}/api/artifact/${registered.id}/delete`, { method: "POST" }))).ok, true);
    assert.equal((await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`)).status, 404);
  } finally { await srv.close(); }
});

test("agent-authored comments and two-way replies preserve CAS, authorship, and idempotency", async () => {
  const srv = await listen();
  try {
    const registered = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "server-tests", title: "Review thread", filename: "thread.md", mode: "stored", contentBase64: Buffer.from("# Review thread\n").toString("base64") }) }));
    const initial = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${registered.version}`);
    const createOperation = "6".repeat(32);
    const target = { type: "text", start: 0, end: 6, quote: "Review", prefix: "", suffix: " thread" };
    const spoofedAuthor = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": initial.headers.get("etag")! }, body: JSON.stringify({ versionId: registered.version, target, body: "spoof", author: "agent" }) });
    assert.equal(spoofedAuthor.status, 400, "request bodies cannot self-assign agent authorship");
    const createdResponse = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": initial.headers.get("etag")!, "x-pi-artifacts-operation-id": createOperation, [config.COMMENT_AGENT_HEADER]: config.COMMENT_AGENT_HEADER_VALUE },
      body: JSON.stringify({ versionId: registered.version, target, body: "Agent review finding" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await json<{ revision: number; annotations: Array<{ id: string; author: string; status: string; updatedAt: number; replies: unknown[] }> }>(createdResponse.clone());
    assert.equal(created.annotations[0].id, createOperation);
    assert.equal(created.annotations[0].author, "agent");
    assert.equal(created.annotations[0].status, "open");
    assert.deepEqual(created.annotations[0].replies, []);

    const replyUrl = `${srv.base}/api/artifact/${registered.id}/annotation/${createOperation}/replies`;
    const missingOperation = await fetch(replyUrl, { method: "POST", headers: { "content-type": "application/json", "if-match": createdResponse.headers.get("etag")! }, body: JSON.stringify({ body: "missing idempotency key", expectedUpdatedAt: created.annotations[0].updatedAt }) });
    assert.equal(missingOperation.status, 400);
    const agentReplyId = "7".repeat(32);
    const agentReplyResponse = await fetch(replyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": createdResponse.headers.get("etag")!, "x-pi-artifacts-operation-id": agentReplyId, [config.COMMENT_AGENT_HEADER]: config.COMMENT_AGENT_HEADER_VALUE },
      body: JSON.stringify({ body: "Agent follow-up", expectedUpdatedAt: created.annotations[0].updatedAt }),
    });
    assert.equal(agentReplyResponse.status, 201);
    const agentReplied = await json<{ revision: number; annotations: Array<{ status: string; updatedAt: number; replies: Array<{ id: string; body: string; author: string }> }> }>(agentReplyResponse.clone());
    assert.equal(agentReplied.annotations[0].status, "open", "agent replies preserve thread status");
    assert.deepEqual(agentReplied.annotations[0].replies, [{ id: agentReplyId, body: "Agent follow-up", author: "agent", createdAt: agentReplied.annotations[0].updatedAt }]);

    const userReplyId = "8".repeat(32);
    const userReplyResponse = await fetch(replyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": agentReplyResponse.headers.get("etag")!, "x-pi-artifacts-operation-id": userReplyId },
      body: JSON.stringify({ body: "Human response", expectedUpdatedAt: agentReplied.annotations[0].updatedAt }),
    });
    assert.equal(userReplyResponse.status, 201);
    const userReplied = await json<{ revision: number; annotations: Array<{ updatedAt: number; replies: Array<{ id: string; author: string }> }> }>(userReplyResponse.clone());
    assert.deepEqual(userReplied.annotations[0].replies.map((reply) => [reply.id, reply.author]), [[agentReplyId, "agent"], [userReplyId, "user"]]);

    const replay = await fetch(replyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": agentReplyResponse.headers.get("etag")!, "x-pi-artifacts-operation-id": userReplyId },
      body: JSON.stringify({ body: "Human response", expectedUpdatedAt: agentReplied.annotations[0].updatedAt }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await json<{ annotations: Array<{ replies: unknown[] }> }>(replay)).annotations[0].replies.length, 2, "reply replay is exactly once");

    const read = await json<{ comments: Array<{ author: string; status: string; replies: Array<{ author: string }> }> }>(await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${registered.version}`));
    assert.equal(read.comments[0].author, "agent");
    assert.equal(read.comments[0].status, "open");
    assert.deepEqual(read.comments[0].replies.map((reply) => reply.author), ["agent", "user"]);

    // A same-origin viewer script cannot rewrite or delete an agent-authored comment even with a
    // valid ETag/If-Match: the daemon forbids it at the domain layer (403), while a status-only
    // change (resolve/reopen) is still permitted.
    const beforeAttack = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations?version=${registered.version}`);
    const attackEtag = beforeAttack.headers.get("etag")!;
    const agentUpdatedAt = (await json<{ annotations: Array<{ updatedAt: number }> }>(beforeAttack)).annotations[0].updatedAt;
    const spoofEdit = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${createOperation}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": attackEtag }, body: JSON.stringify({ body: "forged agent text", expectedUpdatedAt: agentUpdatedAt }) });
    assert.equal(spoofEdit.status, 403, "viewer cannot rewrite an agent comment body");
    assert.equal((await json<{ code: string }>(spoofEdit)).code, "ANNOTATION_FORBIDDEN");
    const spoofDelete = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${createOperation}`, { method: "DELETE", headers: { "content-type": "application/json", "if-match": attackEtag }, body: JSON.stringify({ expectedUpdatedAt: agentUpdatedAt }) });
    assert.equal(spoofDelete.status, 403, "viewer cannot delete an agent comment");
    const resolveAgent = await fetch(`${srv.base}/api/artifact/${registered.id}/annotation/${createOperation}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": attackEtag }, body: JSON.stringify({ status: "resolved", expectedUpdatedAt: agentUpdatedAt }) });
    assert.equal(resolveAgent.status, 200, "status-only changes to an agent comment remain allowed");
    const afterResolve = await json<{ annotations: Array<{ body: string; status: string }> }>(resolveAgent);
    assert.equal(afterResolve.annotations[0].status, "resolved");
    assert.equal(afterResolve.annotations[0].body, "Agent review finding", "the agent body is preserved through a status change");
  } finally { await srv.close(); }
});

test("annotation create rejects an idempotency-key collision with different content", async () => {
  const srv = await listen();
  try {
    const registered = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "server-tests", title: "Collision", filename: "collision.md", mode: "stored", contentBase64: Buffer.from("# Collision").toString("base64") }) }));
    const etag = (await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`)).headers.get("etag")!;
    const operation = "a".repeat(32);
    const payload = { versionId: registered.version, target: { type: "text", start: 0, end: 1, quote: "#", prefix: "", suffix: "" }, body: "first" };
    assert.equal((await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": etag, "x-pi-artifacts-operation-id": operation }, body: JSON.stringify(payload) })).status, 201);
    const replayWithoutPrecondition = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "x-pi-artifacts-operation-id": operation }, body: JSON.stringify(payload) });
    assert.equal(replayWithoutPrecondition.status, 428, "even an idempotent replay must carry If-Match");
    assert.equal(replayWithoutPrecondition.headers.get("cache-control"), "no-store");
    // A lost response replays against its original base ETag without a second create.
    const replay = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": etag, "x-pi-artifacts-operation-id": operation }, body: JSON.stringify(payload) });
    assert.equal(replay.status, 200);
    const replayed = await json<{ revision: number; annotations: Array<{ body: string }> }>(replay);
    assert.equal(replayed.revision, 1);
    assert.deepEqual(replayed.annotations.map((annotation) => annotation.body), ["first"]);
    const collision = await fetch(`${srv.base}/api/artifact/${registered.id}/annotations`, { method: "POST", headers: { "content-type": "application/json", "if-match": etag, "x-pi-artifacts-operation-id": operation }, body: JSON.stringify({ ...payload, body: "different" }) });
    assert.equal(collision.status, 409);
    assert.equal((await json<{ code: string }>(collision)).code, "ANNOTATION_OPERATION_COLLISION");
  } finally { await srv.close(); }
});

test("HTML annotation frames inject a bridge before actual authored HTML in an opaque sandbox", async () => {
  const srv = await listen();
  try {
    const registered = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "server-tests", title: "Annotated HTML", filename: "annotated.html", mode: "stored", contentBase64: Buffer.from("<!doctype html><head><script>window.evil=true</script></head><script src='/raw/attacker'></script><p>closing </script><script>escape</script></p>").toString("base64") }),
    }));
    const frame = await fetch(`${srv.base}/annotation-frame/${registered.id}/v/${registered.version}`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("x-pi-artifacts-csp-meta"), "inline-bridge-before-authored-markup");
    assert.match(frame.headers.get("content-security-policy") || "", /sandbox allow-scripts;.*script-src 'nonce-[A-Za-z0-9_-]+';.*connect-src 'none'; form-action 'none'/);
    const framedHtml = await frame.text();
    assert.match(framedHtml, /^<!doctype html><script nonce="[A-Za-z0-9_-]+">/i, "annotation injection preserves standards mode and nonces only the trusted bridge");
    assert.match(framedHtml, /network is disabled in annotation mode/);
    assert.match(framedHtml, /window\.evil.*attacker.*escape/s);
    assert.ok(framedHtml.indexOf("network is disabled") < framedHtml.indexOf("window.evil"), "bridge precedes authored markup and meta CSP");
    const raw = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.match(raw.headers.get("content-security-policy") || "", /sandbox allow-scripts;.*connect-src 'none'; form-action 'none'/);
    const svg = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "server-tests", title: "Unsafe SVG", filename: "unsafe.svg", mode: "stored", contentBase64: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64") }) }));
    assert.match((await fetch(`${srv.base}/raw/${svg.id}`)).headers.get("content-security-policy") || "", /^sandbox;/);
  } finally { await srv.close(); }
});

test("publishes an artifact through PreviewShip and returns tracked metadata", async () => {
  let published = "";
  const previewShipDeploy: PreviewShipDeploy = async (options = {}) => {
    published = fs.readFileSync(options.path!, "utf8");
    return {
      success: true,
      deploymentId: 314,
      projectName: options.projectName,
      previewUrl: "https://server-preview.previewship.test",
      status: "READY",
      visibility: "PUBLIC",
    };
  };
  const srv = await listen({ previewShipDeploy });
  try {
    const registered = await json<{ id: string; version: number }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Published Report",
        filename: "published.html",
        mode: "stored",
        contentBase64: Buffer.from("<!doctype html><p>published snapshot</p>").toString("base64"),
      }),
    }));

    const response = await fetch(`${srv.base}/api/artifact/${registered.id}/publish/previewship`, {
      method: "POST",
      headers: previewShipHeaders,
      body: JSON.stringify({ projectName: "server-published-report" }),
    });
    assert.equal(response.status, 200);
    const result = await json<{
      ok: boolean;
      artifactId: string;
      artifactVersion: number;
      deploymentId: number;
      previewUrl: string;
    }>(response);
    assert.equal(result.ok, true);
    assert.equal(result.artifactId, registered.id);
    assert.equal(result.artifactVersion, registered.version);
    assert.equal(result.deploymentId, 314);
    assert.equal(result.previewUrl, "https://server-preview.previewship.test");
    assert.equal(published, "<!doctype html><p>published snapshot</p>");

    const metadata = await json<{ artifact: { previewship_url: string; previewship_artifact_version: number } }>(
      await fetch(`${srv.base}/api/artifact/${registered.id}`),
    );
    assert.equal(metadata.artifact.previewship_url, result.previewUrl);
    assert.equal(metadata.artifact.previewship_artifact_version, registered.version);
  } finally {
    await srv.close();
  }
});

test("PreviewShip publish endpoint rejects browser-originated requests without an agent-only header", async () => {
  let called = false;
  const srv = await listen({
    previewShipDeploy: async () => {
      called = true;
      return { success: true, deploymentId: 1, previewUrl: "https://never.test" };
    },
  });
  try {
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Browser Boundary",
        filename: "browser-boundary.html",
        mode: "stored",
        contentBase64: Buffer.from("<!doctype html><p>browser boundary</p>").toString("base64"),
      }),
    }));
    const response = await fetch(`${srv.base}/api/artifact/${registered.id}/publish/previewship`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await json(response), {
      error: "PreviewShip publishing requires an agent client request.",
      code: "PUBLISH_FORBIDDEN",
    });
    assert.equal(called, false);
  } finally {
    await srv.close();
  }
});

test("PreviewShip publish endpoint rejects unsupported artifacts without invoking the provider", async () => {
  let called = false;
  const srv = await listen({
    previewShipDeploy: async () => {
      called = true;
      return { success: true, deploymentId: 1, previewUrl: "https://never.test" };
    },
  });
  try {
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Published PDF",
        filename: "published.pdf",
        mode: "stored",
        contentBase64: Buffer.from("%PDF-1.4\n").toString("base64"),
      }),
    }));
    const response = await fetch(`${srv.base}/api/artifact/${registered.id}/publish/previewship`, {
      method: "POST",
      headers: previewShipHeaders,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await json(response), {
      error: "PreviewShip supports registered HTML and Markdown artifacts; Published PDF is pdf.",
      code: "UNSUPPORTED_ARTIFACT",
    });
    assert.equal(called, false);
  } finally {
    await srv.close();
  }
});

test("PreviewShip publish endpoint validates request bodies before deployment", async () => {
  let called = false;
  const srv = await listen({
    previewShipDeploy: async () => {
      called = true;
      return { success: true, deploymentId: 1, previewUrl: "https://never.test" };
    },
  });
  try {
    for (const body of ["{", "[]", "null"]) {
      const response = await fetch(`${srv.base}/api/artifact/deadbeef/publish/previewship`, {
        method: "POST",
        headers: previewShipHeaders,
        body,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await json(response), { error: "invalid JSON" });
    }

    const wrongType = await fetch(`${srv.base}/api/artifact/deadbeef/publish/previewship`, {
      method: "POST",
      headers: previewShipHeaders,
      body: JSON.stringify({ projectName: 42 }),
    });
    assert.equal(wrongType.status, 400);
    assert.deepEqual(await json(wrongType), {
      error: "projectName must be a string",
      code: "INVALID_PROJECT_NAME",
    });
    assert.equal(called, false);
  } finally {
    await srv.close();
  }
});

test("referenced artifacts prefer live source and retain snapshot fallback", async () => {
  const srv = await listen();
  const source = path.join(config.HOME, "live-source.txt");
  fs.writeFileSync(source, "snapshot content\n");
  try {
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [config.REGISTER_HEADER]: config.REGISTER_HEADER_VALUE,
      },
      body: JSON.stringify({
        project: "server-tests",
        title: "Live Source",
        mode: "referenced",
        sourcePath: source,
      }),
    }));

    fs.writeFileSync(source, "live content\n");
    const live = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.equal(live.headers.get("x-artifact-live"), "true");
    assert.equal(await live.text(), "live content\n");

    const snapshot = await fetch(`${srv.base}/raw/${registered.id}?live=0`);
    assert.equal(snapshot.headers.get("x-artifact-live"), "false");
    assert.equal(await snapshot.text(), "snapshot content\n");

    fs.unlinkSync(source);
    const fallback = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.equal(fallback.headers.get("x-artifact-live"), "false");
    assert.equal(await fallback.text(), "snapshot content\n");
  } finally {
    await srv.close();
  }
});

test("media artifacts support browser playback metadata, byte ranges, and HEAD requests", async () => {
  const srv = await listen();
  try {
    const content = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypmp42", "ascii"),
      Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz", "ascii"),
    ]);
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Demo Video",
        filename: "demo.mp4",
        mode: "stored",
        contentBase64: content.toString("base64"),
      }),
    }));

    const metadata = await json<{ artifact: { kind: string; mime: string } }>(
      await fetch(`${srv.base}/api/artifact/${registered.id}`),
    );
    assert.equal(metadata.artifact.kind, "video");
    assert.equal(metadata.artifact.mime, "video/mp4");

    const range = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bytes=8-15" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("accept-ranges"), "bytes");
    assert.equal(range.headers.get("content-range"), `bytes 8-15/${content.length}`);
    assert.equal(range.headers.get("content-length"), "8");
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), content.subarray(8, 16));

    const suffix = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bytes=-5" },
    });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), content.subarray(-5));

    const openEnded = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: `bytes=${content.length - 4}-` },
    });
    assert.equal(openEnded.status, 206);
    assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), content.subarray(-4));

    const head = await fetch(`${srv.base}/raw/${registered.id}`, {
      method: "HEAD",
      headers: { range: `bytes=${content.length}-` },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(content.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const unsatisfiable = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: `bytes=${content.length}-` },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${content.length}`);

    const multiple = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bytes=0-1,4-5" },
    });
    assert.equal(multiple.status, 200);
    assert.deepEqual(Buffer.from(await multiple.arrayBuffer()), content);

    const malformed = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bananas" },
    });
    assert.equal(malformed.status, 200);
    assert.deepEqual(Buffer.from(await malformed.arrayBuffer()), content);

    const viewer = await fetch(`${srv.base}/view/${registered.id}`);
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /renderVideo/);
  } finally {
    await srv.close();
  }
});

test("text artifacts support HEAD and byte ranges for viewer preview", async () => {
  const srv = await listen();
  try {
    const content = "line\n".repeat(300_000);
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Big Log",
        filename: "big.log",
        mode: "stored",
        contentBase64: Buffer.from(content, "utf8").toString("base64"),
      }),
    }));

    const head = await fetch(`${srv.base}/raw/${registered.id}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(content)));

    const headRange = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bytes=0-65535" },
    });
    assert.equal(headRange.status, 206);
    assert.equal(headRange.headers.get("content-length"), "65536");
    assert.match(headRange.headers.get("content-range") || "", /bytes 0-65535\/\d+/);

    const tailRange = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: "bytes=-65536" },
    });
    assert.equal(tailRange.status, 206);
    assert.equal(tailRange.headers.get("content-length"), "65536");
    assert.match(tailRange.headers.get("content-range") || "", /bytes \d+-\d+\/\d+/);
    assert.ok((await tailRange.text()).endsWith("line\n"));

    const unsatisfiable = await fetch(`${srv.base}/raw/${registered.id}`, {
      headers: { range: `bytes=${Buffer.byteLength(content)}-` },
    });
    assert.equal(unsatisfiable.status, 416);
  } finally {
    await srv.close();
  }
});

test("streamed file registration accepts binary media without JSON/base64 wrapping", async () => {
  const srv = await listen();
  try {
    const content = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(256, 0x5a)]);
    const metadata = Buffer.from(JSON.stringify({
      project: "server-tests",
      title: "Streamed Audio",
      filename: "streamed.mp3",
      mode: "stored",
    })).toString("base64url");
    const response = await fetch(`${srv.base}/api/register-file`, {
      method: "POST",
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(content.length),
        "x-artifact-metadata": metadata,
      },
      body: content,
    });
    assert.equal(response.status, 200);
    const registered = await json<{ id: string }>(response);
    const result = await json<{ artifact: { kind: string; mime: string }; versions: Array<{ size: number }> }>(
      await fetch(`${srv.base}/api/artifact/${registered.id}`),
    );
    assert.equal(result.artifact.kind, "audio");
    assert.equal(result.artifact.mime, "audio/mpeg");
    assert.equal(result.versions[0].size, content.length);
    assert.deepEqual(Buffer.from(await (await fetch(`${srv.base}/raw/${registered.id}`)).arrayBuffer()), content);
  } finally {
    await srv.close();
  }
});

test("streamed uploads enforce limits for declared and chunked bodies and clean staging files", async () => {
  const srv = await listen({ maxUploadBytes: 8 });
  const metadata = Buffer.from(JSON.stringify({
    project: "server-tests",
    title: "Too Large",
    filename: "large.mp4",
    mode: "stored",
  })).toString("base64url");
  try {
    const declared = await fetch(`${srv.base}/api/register-file`, {
      method: "POST",
      headers: {
        "content-type": "video/mp4",
        "content-length": "9",
        "x-artifact-metadata": metadata,
      },
      body: Buffer.alloc(9),
    });
    assert.equal(declared.status, 413);

    const chunkedResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(`${srv.base}/api/register-file`);
      const req = http.request(target, {
        method: "POST",
        headers: { "content-type": "video/mp4", "x-artifact-metadata": metadata },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.write(Buffer.alloc(4));
      req.write(Buffer.alloc(5));
      req.end();
    });
    assert.equal(chunkedResult.status, 413, chunkedResult.body);
    assert.deepEqual(fs.readdirSync(config.STAGING_DIR), []);
  } finally {
    await srv.close();
  }
});

test("untrusted referenced registrations cannot expose daemon-local files", async () => {
  const srv = await listen();
  const source = path.join(config.HOME, "not-client-readable.txt");
  fs.writeFileSync(source, "daemon secret\n");
  try {
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Untrusted Reference",
        filename: "reference.txt",
        mode: "referenced",
        sourcePath: source,
        sourceMachine: os.hostname(),
        contentBase64: Buffer.from("uploaded snapshot\n").toString("base64"),
      }),
    }));
    const raw = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.equal(raw.headers.get("x-artifact-live"), "false");
    assert.equal(await raw.text(), "uploaded snapshot\n");
  } finally {
    fs.rmSync(source, { force: true });
    await srv.close();
  }
});

test("generic browser rendering is sandboxed while direct raw access downloads", async () => {
  const srv = await listen();
  try {
    const registered = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "Browser Native",
        filename: "sample.bin",
        mime: "application/x-example",
        mode: "stored",
        contentBase64: Buffer.from("browser-native-bytes").toString("base64"),
      }),
    }));
    const direct = await fetch(`${srv.base}/raw/${registered.id}`);
    assert.match(direct.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(direct.headers.get("x-content-type-options"), "nosniff");

    const embedded = await fetch(`${srv.base}/raw/${registered.id}?embed=1`);
    assert.match(embedded.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(embedded.headers.get("content-security-policy"), "sandbox");
  } finally {
    await srv.close();
  }
});

test("server startup reclaims stale staged uploads without touching active or unrelated files", async () => {
  fs.mkdirSync(config.STAGING_DIR, { recursive: true });
  const stale = path.join(config.STAGING_DIR, "upload-crashed");
  const active = path.join(config.STAGING_DIR, "upload-active");
  const unrelated = path.join(config.STAGING_DIR, "keep-me.txt");
  fs.writeFileSync(stale, "stale");
  fs.writeFileSync(active, "active");
  fs.writeFileSync(unrelated, "unrelated");
  const now = Date.now();
  const old = new Date(now - 10_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(unrelated, old, old);

  const srv = await listen({ stagingMaxAgeMs: 5_000 });
  try {
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    await srv.close();
    fs.rmSync(active, { force: true });
    fs.rmSync(unrelated, { force: true });
  }
});

test("periodic cleanup preserves a live upload while removing stale inactive staging files", async () => {
  const srv = await listen({
    stagingMaxAgeMs: 1,
    stagingSweepIntervalMs: 5,
    uploadTimeoutMs: 1_000,
  });
  const stale = path.join(config.STAGING_DIR, "upload-periodic-stale");
  const unrelated = path.join(config.STAGING_DIR, "periodic-keep.txt");
  fs.writeFileSync(stale, "stale");
  fs.writeFileSync(unrelated, "keep");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(unrelated, old, old);
  const metadata = Buffer.from(JSON.stringify({
    project: "server-tests",
    title: "Slow Stream",
    filename: "slow.mp4",
    mode: "stored",
  })).toString("base64url");

  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(new URL(`${srv.base}/api/register-file`), {
        method: "POST",
        headers: { "content-type": "video/mp4", "x-artifact-metadata": metadata },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.write(Buffer.from("first-half"));
      setTimeout(() => req.end(Buffer.from("second-half")), 30);
    });
    assert.equal(result.status, 200, result.body);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(stale, { force: true });
    fs.rmSync(unrelated, { force: true });
    await srv.close();
  }
});

test("server rejects malformed register requests and preserves viewer/static behavior", async () => {
  const srv = await listen();
  try {
    const invalid = await fetch(`${srv.base}/api/register`, { method: "POST", body: "not json" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await json(invalid), { error: "invalid JSON" });

    const missingContent = await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "server-tests", title: "Missing", mode: "stored" }),
    });
    assert.equal(missingContent.status, 400);
    assert.deepEqual(await json(missingContent), { error: "no content: provide contentBase64 or a daemon-readable sourcePath" });

    const pdf = await json<{ id: string }>(await fetch(`${srv.base}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "server-tests",
        title: "PDF",
        filename: "doc.pdf",
        mode: "stored",
        contentBase64: Buffer.from("%PDF-1.4\n", "utf8").toString("base64"),
      }),
    }));
    const redirect = await fetch(`${srv.base}/view/${pdf.id}`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `/raw/${pdf.id}`);

    const wrapped = await fetch(`${srv.base}/view/${pdf.id}?wrap=1`);
    assert.equal(wrapped.status, 200);
    assert.match(await wrapped.text(), /<title>artifact · pi<\/title>/);

    const explorer = await fetch(`${srv.base}/`);
    assert.equal(explorer.status, 200);
    const explorerHtml = await explorer.text();
    assert.match(explorerHtml, /pi-artifacts/);
    assert.match(explorerHtml, /PreviewShip/);

    const viewer = await fetch(`${srv.base}/view/${pdf.id}?wrap=1`);
    const viewerHtml = await viewer.text();
    assert.match(viewerHtml, /PreviewShip/);
    assert.doesNotMatch(viewerHtml, /allow-same-origin/);
  } finally {
    await srv.close();
  }
});

test("serves PWA manifest, service worker, and icons for offline install", async () => {
  const srv = await listen();
  try {
    const manifest = await fetch(`${srv.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") || "", /application\/manifest\+json/);
    const parsed = await json<{ start_url: string; icons: unknown[] }>(manifest);
    assert.equal(parsed.start_url, "/");
    assert.ok(Array.isArray(parsed.icons) && parsed.icons.length > 0);

    const sw = await fetch(`${srv.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("content-type") || "", /javascript/);
    assert.equal(sw.headers.get("service-worker-allowed"), "/");
    const swText = await sw.text();
    assert.match(swText, /addEventListener\("fetch"/);
    assert.match(swText, /annotation-frame\.js/);
    assert.match(swText, /ANNOTATION_FRAME_RE/);

    const icon = await fetch(`${srv.base}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");

    const offlineJs = await fetch(`${srv.base}/offline.js`);
    assert.equal(offlineJs.status, 200);
    assert.match(offlineJs.headers.get("content-type") || "", /javascript/);

    // The explorer + viewer shells advertise the manifest so "Add to Home Screen" works.
    const explorer = await (await fetch(`${srv.base}/`)).text();
    assert.match(explorer, /rel="manifest"/);
    assert.match(explorer, /apple-touch-icon/);
  } finally {
    await srv.close();
  }
});

test("rejects directory traversal attempts for icons", async () => {
  const srv = await listen();
  try {
    const res = await fetch(`${srv.base}/icons/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("health stays reachable while daemon-authoritative links are unavailable", async () => {
  const srv = await listen({ publicUrlProvider: async () => ({ ok: false, code: "MISSING_MAPPING", message: "configure publicBaseUrl" }) });
  try {
    const health = await json<Record<string, unknown>>(await fetch(`${srv.base}/health`));
    assert.equal((health.publicUrlResolution as Record<string, unknown>).code, "MISSING_MAPPING");
    assert.equal("publicBaseUrl" in health, false);
    const result = await fetch(`${srv.base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "unavailable-links", title: "No link", mode: "stored", contentBase64: "bm8=" }) });
    assert.equal(result.status, 503);
    assert.equal((await json<Record<string, unknown>>(result)).code, "MISSING_MAPPING");
  } finally { await srv.close(); }
});
