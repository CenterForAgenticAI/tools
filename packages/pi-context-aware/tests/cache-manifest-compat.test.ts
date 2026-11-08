import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { migrateCachePool, readManifest, stableLegacyArtifactId, writeManifest } from "../src/cache/context-cache.js";

const REQUIRED_FIELDS = ["description", "createdBy", "updatedBy", "created", "updated", "sizeBytes"] as const;
const PROJECTED_KEYS = ["artifactId", ...REQUIRED_FIELDS].sort();

function oldestShapeEntry(): Record<string, unknown> {
	return {
		description: "Oldest shape",
		createdBy: "session-a",
		updatedBy: "session-b",
		created: "2026-05-07T00:00:00.000Z",
		updated: "2026-05-08T00:00:00.000Z",
		sizeBytes: 12,
	};
}

function withTempDir(run: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-manifest-compat-")));
	try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeRawManifest(dir: string, files: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "_manifest.json"), JSON.stringify({ version: 1, files, ...extra }));
}

test("the oldest shape, without artifactId, reads with a deterministic backfilled artifactId", () => {
	withTempDir((dir) => {
		writeRawManifest(dir, { "old.md": oldestShapeEntry() });
		const first = readManifest(dir).files["old.md"];
		const second = readManifest(dir).files["old.md"];
		assert.ok(first);
		assert.equal(first.artifactId, stableLegacyArtifactId(dir, "old.md"));
		assert.match(first.artifactId, /^artifact-legacy-[0-9a-f]{24}$/);
		assert.equal(second?.artifactId, first.artifactId);
		const { artifactId: _ignored, ...rest } = first;
		assert.deepEqual(rest, oldestShapeEntry());
	});
});

test("duplicate and empty artifactIds are backfilled with collision suffixes", () => {
	withTempDir((dir) => {
		writeRawManifest(dir, {
			"a.md": { ...oldestShapeEntry(), artifactId: "same" },
			"b.md": { ...oldestShapeEntry(), artifactId: "same" },
			"c.md": { ...oldestShapeEntry(), artifactId: "" },
		});
		const files = readManifest(dir).files;
		assert.equal(files["a.md"]?.artifactId, "same");
		assert.equal(files["b.md"]?.artifactId, stableLegacyArtifactId(dir, "b.md"));
		assert.equal(files["c.md"]?.artifactId, stableLegacyArtifactId(dir, "c.md"));
	});
});

test("a backfilled id that collides with an earlier explicit id gets the -2 suffix", () => {
	withTempDir((dir) => {
		const legacyB = stableLegacyArtifactId(dir, "b.md");
		writeRawManifest(dir, {
			"a.md": { ...oldestShapeEntry(), artifactId: legacyB },
			"b.md": oldestShapeEntry(),
		});
		const files = readManifest(dir).files;
		assert.equal(files["a.md"]?.artifactId, legacyB);
		assert.equal(files["b.md"]?.artifactId, `${legacyB}-2`);
		const ids = Object.values(files).map((entry) => entry.artifactId);
		assert.equal(new Set(ids).size, ids.length);
	});
});

test("a second collision increments the suffix to -3", () => {
	withTempDir((dir) => {
		const legacyC = stableLegacyArtifactId(dir, "c.md");
		writeRawManifest(dir, {
			"x.md": { ...oldestShapeEntry(), artifactId: legacyC },
			"y.md": { ...oldestShapeEntry(), artifactId: `${legacyC}-2` },
			"c.md": oldestShapeEntry(),
		});
		const files = readManifest(dir).files;
		assert.equal(files["x.md"]?.artifactId, legacyC);
		assert.equal(files["y.md"]?.artifactId, `${legacyC}-2`);
		assert.equal(files["c.md"]?.artifactId, `${legacyC}-3`);
		const ids = Object.values(files).map((entry) => entry.artifactId);
		assert.equal(new Set(ids).size, ids.length);
	});
});

for (const field of REQUIRED_FIELDS) {
	test(`an entry missing ${field} is malformed: dropped from the view, file kept, sibling survives`, () => {
		withTempDir((dir) => {
			const partial = oldestShapeEntry();
			delete partial[field];
			writeRawManifest(dir, { "partial.md": partial, "good.md": oldestShapeEntry() });
			fs.writeFileSync(path.join(dir, "partial.md"), "partial content");
			fs.writeFileSync(path.join(dir, "good.md"), "good content");
			const manifest = readManifest(dir);
			assert.equal(manifest.files["partial.md"], undefined);
			assert.ok(manifest.files["good.md"]);
			assert.equal(fs.readFileSync(path.join(dir, "partial.md"), "utf8"), "partial content");
		});
	});
}

test("wrong types, bad sizes, non-objects and unsafe names are dropped", () => {
	withTempDir((dir) => {
		writeRawManifest(dir, {
			"num-description.md": { ...oldestShapeEntry(), description: 5 },
			"string-size.md": { ...oldestShapeEntry(), sizeBytes: "12" },
			"negative-size.md": { ...oldestShapeEntry(), sizeBytes: -1 },
			"fractional-size.md": { ...oldestShapeEntry(), sizeBytes: 1.5 },
			"not-object.md": "text",
			"../escape.md": oldestShapeEntry(),
			"good.md": oldestShapeEntry(),
		});
		assert.deepEqual(Object.keys(readManifest(dir).files), ["good.md"]);
	});
});

test("unknown properties never survive read, write or migration", () => {
	withTempDir((root) => {
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		const hostileEntry = (): Record<string, unknown> => JSON.parse(
			JSON.stringify({ ...oldestShapeEntry(), injected: "x", constructor: "y" }).replace(/}$/, ',"__proto__":{"polluted":true}}'),
		);
		writeRawManifest(source, { "doc.md": hostileEntry() }, { topLevelExtra: "z", __proto__x: 1 });
		fs.writeFileSync(path.join(source, "doc.md"), "document");

		const read = readManifest(source);
		assert.deepEqual(Object.keys(read).sort(), ["files", "version"]);
		assert.deepEqual(Object.keys(read.files["doc.md"] ?? {}).sort(), PROJECTED_KEYS);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);

		writeManifest(source, read);
		const rewritten = JSON.parse(fs.readFileSync(path.join(source, "_manifest.json"), "utf8")) as { files: Record<string, object> };
		assert.deepEqual(Object.keys(rewritten).sort(), ["files", "version"]);
		assert.deepEqual(Object.keys(rewritten.files["doc.md"] ?? {}).sort(), PROJECTED_KEYS);

		// Re-pollute the source, then migrate; the destination must hold only projected keys.
		writeRawManifest(source, { "doc.md": hostileEntry() }, { topLevelExtra: "z" });
		const result = migrateCachePool(source, destination);
		assert.deepEqual(result.migratedFiles, ["doc.md"]);
		const migrated = JSON.parse(fs.readFileSync(path.join(destination, "_manifest.json"), "utf8")) as { files: Record<string, object> };
		assert.deepEqual(Object.keys(migrated).sort(), ["files", "version"]);
		assert.deepEqual(Object.keys(migrated.files["doc.md"] ?? {}).sort(), PROJECTED_KEYS);
	});
});
