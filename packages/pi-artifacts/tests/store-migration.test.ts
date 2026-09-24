import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-migration-test-"));

const config = await import("../src/config.ts");
config.ensureHome();

const legacy = new DatabaseSync(config.DB_PATH);
legacy.exec(`
  CREATE TABLE artifacts (
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
    archived INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO artifacts (
    id, project, title, kind, mode, created_at, updated_at, archived
  ) VALUES ('legacy123abc', 'legacy-project', 'Legacy artifact', 'html', 'stored', 1, 1, 0);
`);
legacy.close();

const store = await import("../src/store.ts");

test("opens a legacy artifact database and adds nullable PreviewShip tracking columns", () => {
  const database = store.db();
  const columns = database.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  for (const name of [
    "previewship_url",
    "previewship_deployment_id",
    "previewship_project_name",
    "previewship_artifact_version",
    "previewship_visibility",
    "previewship_published_at",
  ]) {
    assert.equal(names.has(name), true, `expected migrated column ${name}`);
  }

  const artifact = store.getArtifact("legacy123abc");
  assert.equal(artifact?.title, "Legacy artifact");
  assert.equal(artifact?.previewship_url, null);
  assert.equal(artifact?.previewship_deployment_id, null);
});
