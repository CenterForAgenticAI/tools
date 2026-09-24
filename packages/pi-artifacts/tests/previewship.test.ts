import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-previewship-test-"));

const store = await import("../src/store.ts");
const {
  PreviewShipPublishError,
  publishArtifactToPreviewShip,
} = await import("../src/previewship.ts");
import type { PreviewShipDeploy } from "../src/previewship.ts";

function registerStored(title: string, filename: string, content: string) {
  return store.registerArtifact({
    project: "previewship-tests",
    title,
    filename,
    mode: "stored",
    content: Buffer.from(content, "utf8"),
  });
}

test("publishes the current HTML snapshot and records the fixed PreviewShip URL", async () => {
  const registered = registerStored(
    "Release Report",
    "release.html",
    "<!doctype html><html><body>release snapshot</body></html>",
  );
  let deployedPath = "";
  let deployedContent = "";
  let deployedName = "";
  const deploy: PreviewShipDeploy = async (options = {}) => {
    deployedPath = options.path || "";
    deployedName = options.projectName || "";
    deployedContent = fs.readFileSync(deployedPath, "utf8");
    return {
      success: true,
      deploymentId: 42,
      projectName: deployedName,
      previewUrl: "https://release.previewship.test",
      status: "READY",
      fileCount: 1,
      zipSizeBytes: 123,
      visibility: "PUBLIC",
    };
  };

  const publication = await publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy });

  assert.equal(deployedContent, "<!doctype html><html><body>release snapshot</body></html>");
  assert.match(deployedPath, /release\.html$/);
  assert.match(deployedName, /previewship-tests.*Release Report/i);
  assert.deepEqual(publication, {
    ok: true,
    artifactId: registered.artifact.id,
    artifactVersion: registered.version.id,
    projectName: deployedName,
    deploymentId: 42,
    previewUrl: "https://release.previewship.test",
    visibility: "PUBLIC",
    publishedAt: publication.publishedAt,
  });
  assert.equal(fs.existsSync(path.dirname(deployedPath)), false, "temporary publish directory is removed");

  const stored = store.getArtifact(registered.artifact.id)!;
  assert.equal(stored.previewship_url, publication.previewUrl);
  assert.equal(stored.previewship_deployment_id, publication.deploymentId);
  assert.equal(stored.previewship_project_name, publication.projectName);
  assert.equal(stored.previewship_artifact_version, registered.version.id);
  assert.equal(stored.previewship_visibility, "PUBLIC");
  assert.equal(stored.previewship_published_at, publication.publishedAt);
});

test("publishes the registered snapshot rather than unregistered live file changes", async () => {
  const source = path.join(process.env.PI_ARTIFACTS_HOME!, "live-report.md");
  fs.writeFileSync(source, "# Registered snapshot\n");
  const registered = store.registerArtifact({
    project: "previewship-tests",
    title: "Live Report",
    filename: "live-report.md",
    mode: "referenced",
    sourcePath: source,
    content: fs.readFileSync(source),
  });
  fs.writeFileSync(source, "# Unregistered live change\n");

  let published = "";
  const deploy: PreviewShipDeploy = async (options = {}) => {
    published = fs.readFileSync(options.path!, "utf8");
    return {
      success: true,
      deploymentId: 43,
      projectName: options.projectName,
      previewUrl: "https://markdown.previewship.test",
      status: "READY",
    };
  };

  await publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy });
  assert.equal(published, "# Registered snapshot\n");
});

test("generated project names remain unique for same-title referenced artifacts", async () => {
  const names: string[] = [];
  const deploy: PreviewShipDeploy = async (options = {}) => {
    names.push(options.projectName || "");
    return {
      success: true,
      deploymentId: 300 + names.length,
      projectName: options.projectName,
      previewUrl: `https://unique-${names.length}.previewship.test`,
      status: "READY",
    };
  };
  const registered = ["a", "b"].map((directory) => {
    const source = path.join(process.env.PI_ARTIFACTS_HOME!, directory, "index.html");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `<!doctype html><p>${directory}</p>`);
    return store.registerArtifact({
      project: "previewship-tests",
      title: "index.html",
      filename: "index.html",
      mode: "referenced",
      sourcePath: source,
      content: fs.readFileSync(source),
    });
  });

  await publishArtifactToPreviewShip(registered[0].artifact.id, {}, { deploy });
  await publishArtifactToPreviewShip(registered[1].artifact.id, {}, { deploy });

  assert.notEqual(registered[0].artifact.id, registered[1].artifact.id);
  assert.notEqual(names[0], names[1]);
  assert.match(names[0], new RegExp(`${registered[0].artifact.id}$`));
  assert.match(names[1], new RegExp(`${registered[1].artifact.id}$`));
  assert.ok(names.every((name) => name.length <= 180));
});

test("reuses the tracked project name so repeat publishes keep a fixed URL", async () => {
  const registered = registerStored("Stable Link", "stable.html", "<!doctype html><p>v1</p>");
  const names: string[] = [];
  const deploy: PreviewShipDeploy = async (options = {}) => {
    names.push(options.projectName || "");
    return {
      success: true,
      deploymentId: 50 + names.length,
      projectName: options.projectName,
      previewUrl: "https://stable.previewship.test",
      status: "READY",
    };
  };

  await publishArtifactToPreviewShip(registered.artifact.id, { projectName: "custom-stable-link" }, { deploy });
  await publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy });

  assert.deepEqual(names, ["custom-stable-link", "custom-stable-link"]);
});

test("rejects unsupported artifact kinds before calling PreviewShip", async () => {
  const registered = registerStored("PDF", "document.pdf", "%PDF-1.4\n");
  let called = false;
  const deploy: PreviewShipDeploy = async () => {
    called = true;
    return { success: true, previewUrl: "https://never.test" };
  };

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "UNSUPPORTED_ARTIFACT"
      && error.status === 400,
  );
  assert.equal(called, false);
});

test("does not change tracked publication metadata when deployment fails", async () => {
  const registered = registerStored("Failing", "failing.html", "<!doctype html><p>fail</p>");
  const deploy: PreviewShipDeploy = async () => ({
    success: false,
    deploymentId: 99,
    status: "FAILED",
    error: { code: "DAILY_QUOTA_EXCEEDED", message: "Daily quota reached" },
  });

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "DAILY_QUOTA_EXCEEDED"
      && /quota/i.test(error.message),
  );
  const stored = store.getArtifact(registered.artifact.id)!;
  assert.equal(stored.previewship_url, null);
  assert.equal(stored.previewship_deployment_id, null);
});

test("rejects unsafe provider URLs instead of persisting an executable explorer link", async () => {
  const registered = registerStored("Unsafe URL", "unsafe.html", "<!doctype html><p>unsafe</p>");
  const deploy: PreviewShipDeploy = async () => ({
    success: true,
    deploymentId: 100,
    projectName: "unsafe-url",
    previewUrl: "javascript:alert(document.domain)",
    status: "READY",
  });

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "INVALID_RESPONSE",
  );
  assert.equal(store.getArtifact(registered.artifact.id)!.previewship_url, null);
});

test("validates project names and provider responses before recording publication state", async () => {
  const registered = registerStored("Validation", "validation.html", "<!doctype html><p>validate</p>");
  let calls = 0;
  const deploy: PreviewShipDeploy = async () => {
    calls += 1;
    return calls === 1
      ? { success: true, previewUrl: "https://incomplete.previewship.test" }
      : { success: true, deploymentId: 101 };
  };

  for (const projectName of ["   ", "x".repeat(181)]) {
    await assert.rejects(
      () => publishArtifactToPreviewShip(registered.artifact.id, { projectName }, { deploy }),
      (error: unknown) => error instanceof PreviewShipPublishError
        && error.code === "INVALID_PROJECT_NAME"
        && error.status === 400,
    );
  }
  assert.equal(calls, 0, "invalid names are rejected before upload");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => publishArtifactToPreviewShip(registered.artifact.id, { projectName: "valid" }, { deploy }),
      (error: unknown) => error instanceof PreviewShipPublishError
        && error.code === "INVALID_RESPONSE",
    );
  }
  assert.equal(store.getArtifact(registered.artifact.id)!.previewship_url, null);
});

test("rejects unknown provider visibility before persisting metadata", async () => {
  const registered = registerStored("Bad Visibility", "bad-visibility.html", "<!doctype html><p>visibility</p>");
  const deploy = (async () => ({
    success: true,
    deploymentId: 102,
    projectName: "bad-visibility",
    previewUrl: "https://bad-visibility.previewship.test",
    status: "READY",
    visibility: "BOGUS",
  })) as unknown as PreviewShipDeploy;

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "INVALID_RESPONSE",
  );
  assert.equal(store.getArtifact(registered.artifact.id)!.previewship_visibility, null);
});

test("preserves a provider error code and cleans up the temporary snapshot", async () => {
  const registered = registerStored("Provider Error", "provider-error.html", "<!doctype html><p>error</p>");
  let deployedPath = "";
  const deploy: PreviewShipDeploy = async (options = {}) => {
    deployedPath = options.path || "";
    throw Object.assign(new Error("API key is invalid"), { code: "INVALID_API_KEY" });
  };

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "INVALID_API_KEY"
      && /API key/i.test(error.message),
  );
  assert.equal(fs.existsSync(path.dirname(deployedPath)), false);
  assert.equal(store.getArtifact(registered.artifact.id)!.previewship_url, null);
});

test("maps unstructured provider failures to stable publish errors", async () => {
  const registered = registerStored("Provider Fallback", "provider-fallback.html", "<!doctype html><p>fallback</p>");

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy: async () => { throw "network unavailable"; } }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "PREVIEWSHIP_ERROR"
      && error.message === "network unavailable",
  );
  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy: async () => ({ success: false }) }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "DEPLOYMENT_FAILED"
      && error.message === "PreviewShip deployment failed.",
  );
  assert.equal(store.getArtifact(registered.artifact.id)!.previewship_url, null);
});

test("reports artifacts that vanish while an external deployment is in flight", async () => {
  const registered = registerStored("Vanishing", "vanishing.html", "<!doctype html><p>gone</p>");
  const deploy: PreviewShipDeploy = async () => {
    store.db().prepare("DELETE FROM artifacts WHERE id = ?").run(registered.artifact.id);
    return {
      success: true,
      deploymentId: 303,
      projectName: "vanishing",
      previewUrl: "https://vanishing.previewship.test",
      status: "READY",
    };
  };

  await assert.rejects(
    () => publishArtifactToPreviewShip(registered.artifact.id, {}, { deploy }),
    (error: unknown) => error instanceof PreviewShipPublishError
      && error.code === "ARTIFACT_NOT_FOUND"
      && error.status === 409,
  );
});

test("marks an older publication stale after registration and refreshes it on republish", async () => {
  const first = registerStored("Versioned Preview", "versioned.html", "<!doctype html><p>v1</p>");
  let deploymentId = 200;
  const deploy: PreviewShipDeploy = async (options = {}) => ({
    success: true,
    deploymentId: deploymentId++,
    projectName: options.projectName,
    previewUrl: "https://versioned.previewship.test",
    status: "READY",
  });

  const publishedFirst = await publishArtifactToPreviewShip(first.artifact.id, {}, { deploy });
  const second = registerStored("Versioned Preview", "versioned.html", "<!doctype html><p>v2</p>");
  assert.equal(second.artifact.id, first.artifact.id);

  const stale = store.getArtifact(first.artifact.id)!;
  assert.equal(stale.previewship_artifact_version, publishedFirst.artifactVersion);
  assert.equal(stale.current_version, second.version.id);
  assert.notEqual(stale.previewship_artifact_version, stale.current_version);

  const publishedSecond = await publishArtifactToPreviewShip(first.artifact.id, {}, { deploy });
  const current = store.getArtifact(first.artifact.id)!;
  assert.equal(publishedSecond.projectName, publishedFirst.projectName);
  assert.equal(current.previewship_artifact_version, second.version.id);
  assert.equal(current.previewship_artifact_version, current.current_version);
});
