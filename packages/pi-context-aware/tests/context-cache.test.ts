import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsMutable from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	boundCacheDocuments,
	boundCacheListing,
	contextCacheDirectory,
	legacySessionDirectoryName,
	migrateCachePool,
	migrationLedgerHas,
	readMigrationLedger,
	recordMigrationInLedger,
	writeMigrationLedger,
	parseCachePlan,
	stripCachePlan,
	buildCacheSummarySection,
	readManifest,
	writeManifest,
	writeCacheFile,
	promoteCacheFile,
	deleteCacheFile,
	runCleanup,
	formatFileSize,
	formatAge,
	type CacheManifest,
} from "../context-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `context-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function cacheEntry(updated: string, description = "Reference"): CacheManifest["files"][string] {
	return {
		description,
		createdBy: "test-session",
		updatedBy: "test-session",
		created: updated,
		updated,
		sizeBytes: 10,
	};
}

// ---------------------------------------------------------------------------
// Scope and listing bounds
// ---------------------------------------------------------------------------

test("context cache directory hashes the absolute scope path", () => {
	const agentDir = "/tmp/context-cache-agent";
	const first = contextCacheDirectory(agentDir, "/tmp/project-a");
	const second = contextCacheDirectory(agentDir, "/tmp/project-b");
	assert.notEqual(first, second);
	assert.match(first, /context-cache[\\/][a-f0-9]{32}$/);
	assert.equal(legacySessionDirectoryName("/tmp/project-a"), "--tmp-project-a--");
});

test("read-through listings keep narrow documents ahead of repository documents and expose origin", () => {
	const root = tmpDir();
	const worktree = path.join(root, "worktree");
	const repo = path.join(root, "repo");
	const sibling = path.join(root, "sibling");
	try {
		writeManifest(worktree, { version: 1, files: { "lane.md": cacheEntry("2026-01-03T00:00:00.000Z", "Lane scratch") } });
		writeManifest(repo, { version: 1, files: { "durable.md": cacheEntry("2026-01-02T00:00:00.000Z", "Repository note"), "lane.md": cacheEntry("2026-01-04T00:00:00.000Z", "Repository collision") } });
		writeManifest(sibling, { version: 1, files: { "sibling.md": cacheEntry("2026-01-05T00:00:00.000Z", "Sibling scratch") } });

		const listing = boundCacheDocuments([
			{ cacheDir: worktree, originScope: "worktree" },
			{ cacheDir: repo, originScope: "repo" },
		], 12);
		assert.deepEqual(listing.entries.map((document) => document.file), ["lane.md", "durable.md"]);
		assert.equal(listing.entries.find((document) => document.file === "lane.md")?.originScope, "worktree");
		assert.equal(listing.entries.some((document) => document.file === "sibling.md"), false);
	} finally {
		cleanup(root);
	}
});

test("boundCacheListing keeps newest entries first and reports the omitted count", () => {
	const manifest: CacheManifest = {
		version: 1,
		files: {
			"old.md": cacheEntry("2026-01-01T00:00:00.000Z"),
			"new.md": cacheEntry("2026-01-03T00:00:00.000Z"),
			"middle.md": cacheEntry("2026-01-02T00:00:00.000Z"),
		},
	};
	const listing = boundCacheListing(manifest, 2);
	assert.deepEqual(listing.entries.map(([file]) => file), ["new.md", "middle.md"]);
	assert.equal(listing.omittedCount, 1);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("migrateCachePool merges legacy entries without deleting the source", () => {
	const root = tmpDir();
	const source = path.join(root, "sessions", "--tmp-project--", "context");
	const destination = path.join(root, "context-cache", "scoped");
	try {
		const updated = "2026-07-20T00:00:00.000Z";
		writeManifest(source, {
			version: 1,
			files: { "legacy.md": cacheEntry(updated, "Migrated reference") },
		});
		fs.writeFileSync(path.join(source, "legacy.md"), "legacy content");

		const result = migrateCachePool(source, destination);
		assert.deepEqual(result.migratedFiles, ["legacy.md"]);
		assert.deepEqual(result.failedFiles, []);
		assert.equal(readManifest(destination).files["legacy.md"].description, "Migrated reference");
		assert.equal(fs.readFileSync(path.join(destination, "legacy.md"), "utf8"), "legacy content");
		assert.equal(fs.readFileSync(path.join(source, "legacy.md"), "utf8"), "legacy content");

		const repeat = migrateCachePool(source, destination);
		assert.deepEqual(repeat.migratedFiles, []);
	} finally {
		cleanup(root);
	}
});

test("migrateCachePool reports failure instead of throwing when the destination cannot be written", () => {
	const root = tmpDir();
	const source = path.join(root, "source");
	// A file where the destination's parent directory must go, so creating the
	// pool fails. Migration is best-effort housekeeping on the per-turn prompt
	// path and must never throw out of it.
	const blocker = path.join(root, "blocked");
	const destination = path.join(blocker, "pool");
	try {
		writeManifest(source, { version: 1, files: { "legacy.md": cacheEntry("2026-07-20T00:00:00.000Z") } });
		fs.writeFileSync(path.join(source, "legacy.md"), "legacy content");
		fs.writeFileSync(blocker, "not a directory");

		const result = migrateCachePool(source, destination);
		assert.equal(result.changed, false);
		assert.deepEqual(result.migratedFiles, []);
		assert.deepEqual(result.failedFiles, ["legacy.md"]);
		assert.equal(fs.readFileSync(path.join(source, "legacy.md"), "utf8"), "legacy content");
	} finally {
		cleanup(root);
	}
});

test("the migration ledger records a source durably so it is never re-imported", () => {
	const root = tmpDir();
	const ledgerFile = path.join(root, "context-cache", "_migrations.json");
	const source = path.join(root, "sessions", "--tmp-project--", "context");
	try {
		assert.equal(migrationLedgerHas(readMigrationLedger(ledgerFile), source), false);
		const ledger = recordMigrationInLedger(readMigrationLedger(ledgerFile), source, {
			destination: path.join(root, "context-cache", "abc"),
			migratedAt: "2026-07-20T00:00:00.000Z",
			fileCount: 1,
		});
		writeMigrationLedger(ledgerFile, ledger);

		// Re-read from disk: a later process must see the same decision.
		assert.equal(migrationLedgerHas(readMigrationLedger(ledgerFile), source), true);
		assert.equal(migrationLedgerHas(readMigrationLedger(ledgerFile), `${source}/`), true);
		assert.equal(migrationLedgerHas(readMigrationLedger(ledgerFile), path.join(root, "other")), false);
	} finally {
		cleanup(root);
	}
});

test("a corrupt migration ledger is treated as empty rather than throwing", () => {
	const root = tmpDir();
	const ledgerFile = path.join(root, "_migrations.json");
	try {
		fs.writeFileSync(ledgerFile, "{ not json");
		assert.deepEqual(readMigrationLedger(ledgerFile), { version: 1, sources: {} });
	} finally {
		cleanup(root);
	}
});

test("migrateCachePool does not clobber a newer destination entry", () => {
	const root = tmpDir();
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	try {
		writeManifest(source, { version: 1, files: { "shared.md": cacheEntry("2026-07-20T00:00:00.000Z", "Old source") } });
		fs.writeFileSync(path.join(source, "shared.md"), "source content");
		writeManifest(destination, { version: 1, files: { "shared.md": cacheEntry("2026-07-21T00:00:00.000Z", "New destination") } });
		fs.writeFileSync(path.join(destination, "shared.md"), "destination content");

		assert.deepEqual(migrateCachePool(source, destination).migratedFiles, []);
		assert.equal(fs.readFileSync(path.join(destination, "shared.md"), "utf8"), "destination content");
	} finally {
		cleanup(root);
	}
});

test("migrateCachePool skips missing, unsafe, non-file, and untracked destination entries", () => {
	const root = tmpDir();
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	try {
		writeManifest(source, {
			version: 1,
			files: {
				"missing.md": cacheEntry("2026-07-20T00:00:00.000Z"),
				"unsafe/name.md": cacheEntry("2026-07-20T00:00:00.000Z"),
				"_manifest.json": cacheEntry("2026-07-20T00:00:00.000Z"),
				"untracked.md": cacheEntry("2026-07-20T00:00:00.000Z"),
				"directory.md": cacheEntry("2026-07-20T00:00:00.000Z"),
			},
		});
		fs.writeFileSync(path.join(source, "untracked.md"), "source content");
		fs.writeFileSync(path.join(source, "directory.md"), "source content");
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(destination, "untracked.md"), "keep this untracked file");
		fs.mkdirSync(path.join(destination, "directory.md"));

		assert.deepEqual(migrateCachePool(source, destination).migratedFiles, []);
		assert.equal(fs.readFileSync(path.join(destination, "untracked.md"), "utf8"), "keep this untracked file");
	} finally {
		cleanup(root);
	}
});

test("migrateCachePool replaces an older destination entry with a newer source", () => {
	const root = tmpDir();
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	try {
		writeManifest(source, { version: 1, files: { "shared.md": cacheEntry("2026-07-22T00:00:00.000Z", "New source") } });
		fs.writeFileSync(path.join(source, "shared.md"), "new source content");
		writeManifest(destination, { version: 1, files: { "shared.md": cacheEntry("2026-07-21T00:00:00.000Z", "Old destination") } });
		fs.writeFileSync(path.join(destination, "shared.md"), "old destination content");

		assert.deepEqual(migrateCachePool(source, destination).migratedFiles, ["shared.md"]);
		assert.equal(fs.readFileSync(path.join(destination, "shared.md"), "utf8"), "new source content");
		assert.equal(readManifest(destination).files["shared.md"].description, "New source");
	} finally {
		cleanup(root);
	}
});

// ---------------------------------------------------------------------------
// parseCachePlan
// ---------------------------------------------------------------------------

test("parseCachePlan extracts artifacts from valid cache-plan", () => {
	const input = `## Summary
Some summary content here.

<cache-plan>
<artifact file="plan.md" description="Completion plan with fix sequence">
Cover the 4-part fix, the SSE streaming gap, verification steps.
</artifact>
<artifact file="config.md" description="Dev environment configuration">
Ports, UUIDs, workspace names, rebuild steps.
</artifact>
</cache-plan>`;

	const artifacts = parseCachePlan(input);
	assert.equal(artifacts.length, 2);
	assert.equal(artifacts[0].file, "plan.md");
	assert.equal(artifacts[0].description, "Completion plan with fix sequence");
	assert.match(artifacts[0].brief, /4-part fix/);
	assert.equal(artifacts[1].file, "config.md");
	assert.equal(artifacts[1].description, "Dev environment configuration");
});

test("parseCachePlan returns empty array when no cache-plan section", () => {
	const input = "## Summary\nJust a regular summary without cache plan.";
	assert.deepEqual(parseCachePlan(input), []);
});

test("parseCachePlan rejects invalid filenames", () => {
	const input = `<cache-plan>
<artifact file="../escape.md" description="Bad path">Brief</artifact>
<artifact file="good-file.md" description="Good file">Brief</artifact>
<artifact file="has/slash.md" description="Bad slash">Brief</artifact>
</cache-plan>`;

	const artifacts = parseCachePlan(input);
	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].file, "good-file.md");
});

test("parseCachePlan limits to 5 artifacts", () => {
	const items = Array.from({ length: 8 }, (_, i) =>
		`<artifact file="file${i}.md" description="File ${i}">Brief ${i}</artifact>`
	).join("\n");
	const input = `<cache-plan>\n${items}\n</cache-plan>`;

	const artifacts = parseCachePlan(input);
	assert.equal(artifacts.length, 5);
});

// ---------------------------------------------------------------------------
// stripCachePlan
// ---------------------------------------------------------------------------

test("stripCachePlan removes cache-plan section from summary", () => {
	const input = `## Summary
Content here.

<cache-plan>
<artifact file="plan.md" description="Plan">Brief</artifact>
</cache-plan>

## Next Steps
More content.`;

	const stripped = stripCachePlan(input);
	assert.doesNotMatch(stripped, /<cache-plan>/);
	assert.doesNotMatch(stripped, /<artifact/);
	assert.match(stripped, /## Summary/);
	assert.match(stripped, /## Next Steps/);
});

test("stripCachePlan returns original text when no cache-plan", () => {
	const input = "## Summary\nJust content.";
	assert.equal(stripCachePlan(input), input);
});

// ---------------------------------------------------------------------------
// buildCacheSummarySection
// ---------------------------------------------------------------------------

test("buildCacheSummarySection lists full paths, descriptions, and sizes", () => {
	const cacheDir = "/tmp/context-cache-test/context";
	const manifest: CacheManifest = {
		version: 1,
		files: {
			"plan.md": {
				description: "Completion plan",
				createdBy: "session-1",
				updatedBy: "session-1",
				created: "2026-05-06T00:00:00Z",
				updated: "2026-05-06T00:00:00Z",
				sizeBytes: 1536,
			},
		},
	};

	const section = buildCacheSummarySection(cacheDir, manifest, ["plan.md"]);
	assert.ok(section);
	assert.match(section, /^## Context Cache/);
	assert.match(section, /\/tmp\/context-cache-test\/context\/plan\.md/);
	assert.match(section, /1\.5KB/);
	assert.match(section, /Completion plan/);
	assert.doesNotMatch(section, /<cache-plan>/);
});

test("buildCacheSummarySection skips missing manifest entries", () => {
	const section = buildCacheSummarySection("/tmp/context", { version: 1, files: {} }, ["missing.md"]);
	assert.equal(section, null);
});

// ---------------------------------------------------------------------------
// Manifest CRUD
// ---------------------------------------------------------------------------

test("readManifest returns empty manifest for missing dir", () => {
	const manifest = readManifest("/nonexistent/path");
	assert.equal(manifest.version, 1);
	assert.deepEqual(manifest.files, {});
});

test("writeManifest + readManifest round-trips", () => {
	const dir = tmpDir();
	try {
		const manifest: CacheManifest = {
			version: 1,
			files: {
				"test.md": {
					description: "Test file",
					createdBy: "session-1",
					updatedBy: "session-1",
					created: "2026-05-06T00:00:00Z",
					updated: "2026-05-06T00:00:00Z",
					sizeBytes: 42,
				},
			},
		};
		writeManifest(dir, manifest);
		const read = readManifest(dir);
		assert.equal(read.version, 1);
		assert.equal(read.files["test.md"].description, "Test file");
		assert.equal(read.files["test.md"].sizeBytes, 42);
	} finally {
		cleanup(dir);
	}
});

/**
 * Whether this process is actually stopped by a read-only directory.
 *
 * Root ignores the permission bits entirely, so `chmod 0o555` does not prevent
 * the write and the expected throw never happens. CI runs as root in the
 * `node:22.19.0` image, which is why this passed on every developer machine and
 * failed on every pipeline (#69).
 *
 * Probed rather than assumed: capabilities, containers, and unusual filesystems
 * all decide this, not the uid alone.
 */
function readOnlyDirectoryBlocksWrites(): boolean {
	const probe = tmpDir();
	try {
		fs.chmodSync(probe, 0o555);
		try {
			fs.writeFileSync(path.join(probe, "probe"), "x");
			return false;
		} catch {
			return true;
		} finally {
			fs.chmodSync(probe, 0o755);
		}
	} finally {
		cleanup(probe);
	}
}

test("writeManifest keeps the previous manifest when the temporary write is interrupted", (t) => {
	const dir = tmpDir();
	try {
		const previous: CacheManifest = {
			version: 1,
			files: { "previous.md": { ...cacheEntry("2026-05-06T00:00:00Z"), artifactId: "artifact-previous" } },
		};
		writeManifest(dir, previous);

		if (!readOnlyDirectoryBlocksWrites()) {
			// Skipping is honest here. The alternative — asserting nothing — would
			// leave a green test that proves nothing, which is worse than a visible
			// skip saying the environment cannot stage this failure.
			t.skip("a read-only directory does not block writes for this user (root ignores permission bits)");
			return;
		}

		try {
			// Keep the existing manifest writable while preventing a sibling temp file
			// from being created, simulating an interrupted write before rename.
			fs.chmodSync(dir, 0o555);
			assert.throws(() => writeManifest(dir, { version: 1, files: { "next.md": cacheEntry("2026-05-07T00:00:00Z") } }));
		} finally {
			fs.chmodSync(dir, 0o755);
		}
		assert.deepEqual(readManifest(dir), previous);
		assert.deepEqual(fs.readdirSync(dir), ["_manifest.json"]);
	} finally {
		cleanup(dir);
	}
});

test("writeManifest leaves no temporary file behind when the rename fails", () => {
	// The same invariant as above, staged so that no user — root included — can
	// bypass it: renaming onto a non-empty directory is refused by the kernel.
	// This is what actually guards the manifest, and it runs everywhere.
	const dir = tmpDir();
	try {
		const manifestPath = path.join(dir, "_manifest.json");
		fs.mkdirSync(manifestPath, { recursive: true });
		fs.writeFileSync(path.join(manifestPath, "occupied"), "x");

		assert.throws(() => writeManifest(dir, { version: 1, files: { "next.md": cacheEntry("2026-05-07T00:00:00Z") } }));

		// The failed write must not leave its scratch file lying next to the
		// manifest, where the next read would have to reason about it.
		assert.deepEqual(
			fs.readdirSync(dir),
			["_manifest.json"],
			"an interrupted write must clean up its own temporary file",
		);
	} finally {
		cleanup(dir);
	}
});

test("writeCacheFile creates file and updates manifest", () => {
	const dir = tmpDir();
	try {
		let manifest: CacheManifest = { version: 1, files: {} };
		manifest = writeCacheFile(dir, manifest, "session-1", "plan.md", "# Plan\nStep 1", "The plan");

		assert.ok(manifest.files["plan.md"]);
		assert.equal(manifest.files["plan.md"].description, "The plan");
		assert.equal(manifest.files["plan.md"].createdBy, "session-1");
		assert.equal(manifest.files["plan.md"].updatedBy, "session-1");
		assert.match(manifest.files["plan.md"].artifactId ?? "", /^artifact-/);
		assert.ok(manifest.files["plan.md"].sizeBytes > 0);

		// Verify file on disk
		const content = fs.readFileSync(path.join(dir, "plan.md"), "utf8");
		assert.equal(content, "# Plan\nStep 1");
	} finally {
		cleanup(dir);
	}
});

test("promoteCacheFile copies one workspace artifact and projects manifest metadata", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "workspace", "artifacts", "plan.md");
	const cacheDir = path.join(root, "cache");
	try {
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fs.writeFileSync(sourcePath, "# approved plan\n");
		const hostileEntry = { ...cacheEntry("2026-01-01T00:00:00.000Z"), secret: "must not persist" };
		const manifest = { version: 1 as const, files: { "existing.md": hostileEntry } } as unknown as CacheManifest;

		const promoted = promoteCacheFile(cacheDir, manifest, "trusted-session", sourcePath, "plan.md", "Approved plan");
		assert.equal(fs.readFileSync(path.join(cacheDir, "plan.md"), "utf8"), "# approved plan\n");
		assert.equal(promoted.manifest.files["plan.md"]?.description, "Approved plan");
		assert.equal(promoted.manifest.files["plan.md"]?.createdBy, "trusted-session");
		assert.equal("secret" in (promoted.manifest.files["plan.md"] as unknown as Record<string, unknown>), false);
		for (const unsafeName of ["../unsafe.md", "plan/name.md", "plan\\\\name.md", "plan∕name.md", "plan／name.md", "plan\u0000.md", "é.md"]) {
			assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", sourcePath, unsafeName, "Unsafe"), /safe cache filename/);
		}
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", "relative.md", "other.md", "Relative"), /absolute path/);
		const directoryPath = path.join(root, "workspace", "artifacts", "directory");
		fs.mkdirSync(directoryPath);
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", directoryPath, "directory.md", "Directory"), /regular file/);
		const sourceSymlink = path.join(root, "workspace", "artifacts", "source-link.md");
		fs.symlinkSync(sourcePath, sourceSymlink);
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", sourceSymlink, "source-link.md", "Symlink"), /regular file/);
		const untrackedDestination = path.join(cacheDir, "untracked.md");
		fs.writeFileSync(untrackedDestination, "must not be overwritten");
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", sourcePath, "untracked.md", "Untracked"), /untracked regular file/);
		assert.equal(fs.readFileSync(untrackedDestination, "utf8"), "must not be overwritten");
		const destinationTarget = path.join(root, "outside.md");
		const destinationSymlink = path.join(cacheDir, "destination-link.md");
		fs.symlinkSync(destinationTarget, destinationSymlink);
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", sourcePath, "destination-link.md", "Symlink"), /regular file/);
		assert.equal(fs.existsSync(destinationTarget), false, "a destination symlink must not receive the promoted content");
		assert.throws(() => promoteCacheFile(cacheDir, manifest, "trusted-session", path.join(root, "missing.md"), "missing.md", "Missing"));
	} finally {
		cleanup(root);
	}
});

test("promoteCacheFile refuses a tracked destination without changing bytes or metadata", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "source.md");
	const cacheDir = path.join(root, "cache");
	const destinationPath = path.join(cacheDir, "tracked.md");
	const oldBytes = Buffer.from([0, 255, 1, 254, 10]);
	const oldEntry = { ...cacheEntry("2026-08-01T00:00:00.000Z", "Original tracked artifact"), artifactId: "artifact-old" };
	try {
		fs.writeFileSync(sourcePath, "trusted source");
		writeManifest(cacheDir, { version: 1, files: { "tracked.md": oldEntry } });
		fs.writeFileSync(destinationPath, oldBytes);
		const beforeManifest = readManifest(cacheDir);
		assert.throws(
			() => promoteCacheFile(cacheDir, beforeManifest, "session-1", sourcePath, "tracked.md", "Replacement"),
			/destinationPath already exists/,
		);
		assert.deepEqual(fs.readFileSync(destinationPath), oldBytes);
		assert.deepEqual(readManifest(cacheDir), beforeManifest);
	} finally {
		cleanup(root);
	}
});

test("promoteCacheFile refuses a tracked manifest entry without a destination", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "source.md");
	const cacheDir = path.join(root, "cache");
	try {
		fs.writeFileSync(sourcePath, "trusted source");
		const manifest = { version: 1 as const, files: { "missing.md": cacheEntry("2026-08-01T00:00:00.000Z", "Tracked but missing") } };
		writeManifest(cacheDir, manifest);
		const manifestPath = path.join(cacheDir, "_manifest.json");
		const beforeManifestBytes = fs.readFileSync(manifestPath);
		const beforeManifest = readManifest(cacheDir);
		assert.throws(
			() => promoteCacheFile(cacheDir, beforeManifest, "session-1", sourcePath, "missing.md", "Replacement"),
			/destinationPath is tracked in the manifest but missing/,
		);
		assert.equal(fs.existsSync(path.join(cacheDir, "missing.md")), false);
		assert.equal(fs.readdirSync(cacheDir).some((entry) => entry.startsWith(".missing.md.promotion-")), false);
		assert.deepEqual(fs.readFileSync(manifestPath), beforeManifestBytes);
		assert.deepEqual(readManifest(cacheDir), beforeManifest);
	} finally {
		cleanup(root);
	}
});

test("manifest publication failure leaves an untracked destination untouched", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "source.md");
	const cacheDir = path.join(root, "cache");
	const untrackedPath = path.join(cacheDir, "untracked.md");
	const oldBytes = Buffer.from([0, 255, 2, 253, 13]);
	try {
		fs.writeFileSync(sourcePath, "trusted source");
		writeManifest(cacheDir, { version: 1, files: {} });
		fs.writeFileSync(untrackedPath, oldBytes);
		const beforeManifest = readManifest(cacheDir);
		assert.throws(
			() => promoteCacheFile(cacheDir, beforeManifest, "session-1", sourcePath, "untracked.md", "Replacement"),
			/destinationPath is an untracked regular file/,
		);
		assert.deepEqual(fs.readFileSync(untrackedPath), oldBytes);
		assert.deepEqual(readManifest(cacheDir), beforeManifest);
		const promoted = promoteCacheFile(cacheDir, beforeManifest, "session-1", sourcePath, "new.md", "New artifact");
		fs.rmSync(path.join(cacheDir, "_manifest.json"));
		fs.mkdirSync(path.join(cacheDir, "_manifest.json"));
		fs.writeFileSync(path.join(cacheDir, "_manifest.json", "occupied"), "keep manifest failure marker");
		assert.throws(() => writeManifest(cacheDir, promoted.manifest));
		promoted.rollback();
		assert.deepEqual(fs.readFileSync(untrackedPath), oldBytes);
		assert.equal(fs.readFileSync(path.join(cacheDir, "_manifest.json", "occupied"), "utf8"), "keep manifest failure marker");
		assert.equal(fs.existsSync(path.join(cacheDir, "new.md")), false);
	} finally {
		cleanup(root);
	}
});

test("exclusive publication stages complete owner-only bytes before refusing a raced destination", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "source.md");
	const cacheDir = path.join(root, "cache");
	const destinationPath = path.join(cacheDir, "raced.md");
	const content = "trusted source";
	const stagedBytes = Buffer.from(content);
	const oldBytes = Buffer.from([0, 255, 3, 252, 14]);
	const originalLinkSync = fsMutable.linkSync;
	let stagingObserved = false;
	try {
		fs.writeFileSync(sourcePath, content);
		fs.mkdirSync(cacheDir, { recursive: true });
		fsMutable.linkSync = ((stagedPath: fs.PathLike, finalPath: fs.PathLike) => {
			assert.equal(String(finalPath), destinationPath);
			assert.match(path.basename(String(stagedPath)), /^\.raced\.md\.promotion-[0-9a-f-]{36}$/u);
			assert.deepEqual(fs.readFileSync(stagedPath), stagedBytes);
			assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o600);
			assert.equal(fs.existsSync(destinationPath), false);
			stagingObserved = true;
			fs.writeFileSync(destinationPath, oldBytes);
			return originalLinkSync(stagedPath, finalPath);
		}) as typeof fsMutable.linkSync;
		assert.throws(
			() => promoteCacheFile(cacheDir, { version: 1, files: {} }, "session-1", sourcePath, "raced.md", "Race"),
		);
		assert.equal(stagingObserved, true);
		assert.deepEqual(fs.readFileSync(destinationPath), oldBytes);
		assert.equal(fs.readdirSync(cacheDir).some((entry) => entry.startsWith(".raced.md.promotion-")), false);
	} finally {
		fsMutable.linkSync = originalLinkSync;
		cleanup(root);
	}
});

test("read-through writes stay in the narrow pool", () => {
	const root = tmpDir();
	const worktree = path.join(root, "worktree");
	const repo = path.join(root, "repo");
	try {
		writeManifest(repo, { version: 1, files: { "durable.md": cacheEntry("2026-01-01T00:00:00.000Z") } });
		const updated = writeCacheFile(worktree, { version: 1, files: {} }, "session-1", "lane.md", "lane content", "Lane scratch");
		writeManifest(worktree, updated);
		assert.equal(fs.readFileSync(path.join(worktree, "lane.md"), "utf8"), "lane content");
		assert.equal(fs.existsSync(path.join(repo, "lane.md")), false);
		assert.ok(readManifest(repo).files["durable.md"]);
	} finally {
		cleanup(root);
	}
});

test("writeCacheFile preserves createdBy on update", () => {
	const dir = tmpDir();
	try {
		let manifest: CacheManifest = { version: 1, files: {} };
		manifest = writeCacheFile(dir, manifest, "session-1", "plan.md", "v1", "Plan");
		const artifactId = manifest.files["plan.md"].artifactId;
		manifest = writeCacheFile(dir, manifest, "session-2", "plan.md", "v2", "Updated plan");

		assert.equal(manifest.files["plan.md"].artifactId, artifactId);
		assert.equal(manifest.files["plan.md"].createdBy, "session-1");
		assert.equal(manifest.files["plan.md"].updatedBy, "session-2");
		assert.equal(manifest.files["plan.md"].description, "Updated plan");
	} finally {
		cleanup(dir);
	}
});

test("readManifest drops corrupt entries, projects fields, and repairs duplicate identities", () => {
	const dir = tmpDir();
	try {
		fs.writeFileSync(path.join(dir, "_manifest.json"), `${JSON.stringify({
			version: 1,
			files: {
				"good.md": { ...cacheEntry("2026-05-06T00:00:00Z"), artifactId: "same", secret: "drop" },
				"duplicate.md": { ...cacheEntry("2026-05-06T00:00:00Z"), artifactId: "same" },
				"unsafe/name.md": cacheEntry("2026-05-06T00:00:00Z"),
				"broken.md": { description: "missing fields" },
				"null.md": null,
			},
		})}\n`);
		const manifest = readManifest(dir);
		assert.deepEqual(Object.keys(manifest.files), ["good.md", "duplicate.md"]);
		assert.equal((manifest.files["good.md"] as unknown as Record<string, unknown>).secret, undefined);
		assert.notEqual(manifest.files["good.md"].artifactId, manifest.files["duplicate.md"].artifactId);
	} finally {
		cleanup(dir);
	}
});

test("readManifest assigns a deterministic stable ID to legacy entries", () => {
	const dir = tmpDir();
	try {
		fs.writeFileSync(path.join(dir, "_manifest.json"), `${JSON.stringify({
			version: 1,
			files: {
				"legacy.md": {
					description: "Legacy entry",
					createdBy: "session-1",
					updatedBy: "session-2",
					created: "2026-05-06T00:00:00Z",
					updated: "2026-05-07T00:00:00Z",
					sizeBytes: 12,
				},
			},
		})}\n`);
		const first = readManifest(dir).files["legacy.md"].artifactId;
		const second = readManifest(dir).files["legacy.md"].artifactId;
		assert.match(first ?? "", /^artifact-legacy-/);
		assert.equal(second, first);
	} finally {
		cleanup(dir);
	}
});

test("deleteCacheFile removes file and manifest entry", () => {
	const dir = tmpDir();
	try {
		let manifest: CacheManifest = { version: 1, files: {} };
		manifest = writeCacheFile(dir, manifest, "session-1", "plan.md", "content", "Plan");
		assert.ok(fs.existsSync(path.join(dir, "plan.md")));

		manifest = deleteCacheFile(dir, manifest, "plan.md");
		assert.equal(manifest.files["plan.md"], undefined);
		assert.ok(!fs.existsSync(path.join(dir, "plan.md")));
	} finally {
		cleanup(dir);
	}
});

test("deleteCacheFile tolerates already-missing files", () => {
	const dir = tmpDir();
	try {
		const manifest: CacheManifest = {
			version: 1,
			files: {
				"missing.md": {
					description: "Missing",
					createdBy: "session-1",
					updatedBy: "session-1",
					created: "2026-05-06T00:00:00Z",
					updated: "2026-05-06T00:00:00Z",
					sizeBytes: 10,
				},
			},
		};
		const updated = deleteCacheFile(dir, manifest, "missing.md");
		assert.deepEqual(updated.files, {});
	} finally {
		cleanup(dir);
	}
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("runCleanup prunes stale files", () => {
	const dir = tmpDir();
	try {
		const staleDate = new Date(Date.now() - 60 * 86400_000).toISOString(); // 60 days ago
		const freshDate = new Date().toISOString();
		let manifest: CacheManifest = { version: 1, files: {} };
		manifest = writeCacheFile(dir, manifest, "s1", "stale.md", "old", "Stale");
		manifest = writeCacheFile(dir, manifest, "s1", "fresh.md", "new", "Fresh");
		// Manually backdate the stale entry
		manifest.files["stale.md"].updated = staleDate;
		manifest.files["fresh.md"].updated = freshDate;
		writeManifest(dir, manifest);

		const result = runCleanup(dir, manifest, { staleHours: 720, maxBytes: 10 * 1024 * 1024 });
		assert.ok(result.changed);
		assert.equal(result.manifest.files["stale.md"], undefined);
		assert.ok(result.manifest.files["fresh.md"]);
	} finally {
		cleanup(dir);
	}
});

test("runCleanup enforces size cap removing oldest first", () => {
	const dir = tmpDir();
	try {
		let manifest: CacheManifest = { version: 1, files: {} };
		// Create 3 files with different sizes and ages
		manifest = writeCacheFile(dir, manifest, "s1", "old.md", "x".repeat(50), "Old");
		manifest = writeCacheFile(dir, manifest, "s1", "mid.md", "y".repeat(50), "Mid");
		manifest = writeCacheFile(dir, manifest, "s1", "new.md", "z".repeat(50), "New");
		manifest.files["old.md"].updated = new Date(Date.now() - 3 * 86400_000).toISOString();
		manifest.files["mid.md"].updated = new Date(Date.now() - 2 * 86400_000).toISOString();
		manifest.files["new.md"].updated = new Date(Date.now() - 1 * 86400_000).toISOString();

		// Total ~150 bytes, set max to 120 — target is 80% = 96 bytes
		// Should remove "old.md" (50 bytes) → 100 bytes, still > 96 → also remove "mid.md" → 50 bytes
		// OR if sizes are slightly different due to encoding, just check old is removed and new survives
		const result = runCleanup(dir, manifest, { staleHours: 8760, maxBytes: 120 });
		assert.ok(result.changed);
		assert.equal(result.manifest.files["old.md"], undefined); // oldest removed first
		assert.ok(result.manifest.files["new.md"]); // newest preserved
	} finally {
		cleanup(dir);
	}
});

test("runCleanup removes orphan files not in manifest", () => {
	const dir = tmpDir();
	try {
		// Create a file on disk that's not in the manifest
		fs.writeFileSync(path.join(dir, "orphan.md"), "orphan content");
		fs.writeFileSync(path.join(dir, "_manifest.json"), '{"version":1,"files":{}}');

		const manifest: CacheManifest = { version: 1, files: {} };
		const result = runCleanup(dir, manifest, { staleHours: 8760, maxBytes: 10 * 1024 * 1024 });
		assert.ok(result.changed);
		assert.ok(!fs.existsSync(path.join(dir, "orphan.md")));
	} finally {
		cleanup(dir);
	}
});

test("runCleanup returns changed=false when nothing to do", () => {
	const dir = tmpDir();
	try {
		let manifest: CacheManifest = { version: 1, files: {} };
		manifest = writeCacheFile(dir, manifest, "s1", "good.md", "content", "Good");
		writeManifest(dir, manifest);

		const result = runCleanup(dir, manifest, { staleHours: 8760, maxBytes: 10 * 1024 * 1024 });
		assert.ok(!result.changed);
		assert.ok(result.manifest.files["good.md"]);
	} finally {
		cleanup(dir);
	}
});

test("runCleanup tolerates a missing cache directory during orphan pruning", () => {
	const dir = path.join(os.tmpdir(), `context-cache-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const result = runCleanup(dir, { version: 1, files: {} }, { staleHours: 8760, maxBytes: 10 * 1024 * 1024 });
	assert.ok(!result.changed);
	assert.deepEqual(result.manifest.files, {});
});

// ---------------------------------------------------------------------------
// Reserved manifest name (CR-PROMO-MANIFEST-CASE-ALIAS)
// ---------------------------------------------------------------------------

test("promoteCacheFile rejects every case variant of the reserved manifest name", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "workspace", "source.md");
	const cacheDir = path.join(root, "cache");
	try {
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fs.writeFileSync(sourcePath, "trusted source\n");
		// A case-insensitive host filesystem aliases each of these onto
		// `_manifest.json`; the reserved-name check must reject them regardless.
		for (const alias of ["_manifest.json", "_MANIFEST.JSON", "_Manifest.Json", "_manifest.JSON", "_MANIFEST.json"]) {
			assert.throws(
				() => promoteCacheFile(cacheDir, { version: 1, files: {} }, "session-1", sourcePath, alias, "Alias"),
				/safe cache filename/,
				`promotion must refuse the reserved manifest alias ${alias}`,
			);
			assert.equal(fs.existsSync(path.join(cacheDir, alias)), false, `no alias file may be published for ${alias}`);
		}
	} finally {
		cleanup(root);
	}
});

test("runCleanup never sweeps a case variant of the reserved manifest as an orphan", () => {
	const dir = tmpDir();
	try {
		// A promoted-looking case alias of the reserved manifest sitting on disk.
		// On a case-insensitive host this IS the manifest; on a case-sensitive
		// host it is a distinct file. Either way cleanup must never delete it as
		// an orphan, or the alias would take the real manifest with it.
		const aliasPath = path.join(dir, "_MANIFEST.JSON");
		fs.writeFileSync(aliasPath, "reserved alias must survive cleanup");
		const result = runCleanup(dir, { version: 1, files: {} }, { staleHours: 8760, maxBytes: 10 * 1024 * 1024 });
		assert.equal(fs.existsSync(aliasPath), true, "a reserved-name alias must not be swept as an orphan");
		assert.equal(result.changed, false, "removing nothing must not report the cache as changed");
	} finally {
		cleanup(dir);
	}
});

// ---------------------------------------------------------------------------
// Promotion content contract (CR-PROMO-UTF8-BYTELOSS)
// ---------------------------------------------------------------------------

test("promoteCacheFile refuses malformed UTF-8 without leaving destination, manifest, or temp state", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "workspace", "bad.md");
	const cacheDir = path.join(root, "cache");
	try {
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		// "hi" followed by a lone 0xFF/0xFE which is not a valid UTF-8 sequence.
		fs.writeFileSync(sourcePath, Buffer.from([0x68, 0x69, 0xff, 0xfe]));
		writeManifest(cacheDir, { version: 1, files: {} });
		const beforeManifest = readManifest(cacheDir);
		const beforeManifestBytes = fs.readFileSync(path.join(cacheDir, "_manifest.json"));
		assert.throws(
			() => promoteCacheFile(cacheDir, beforeManifest, "session-1", sourcePath, "bad.md", "Bad bytes"),
			/valid UTF-8/,
		);
		assert.equal(fs.existsSync(path.join(cacheDir, "bad.md")), false, "no destination may be published for malformed UTF-8");
		assert.equal(fs.readdirSync(cacheDir).some((entry) => entry.startsWith(".bad.md.promotion-")), false, "no promotion temp file may survive");
		assert.deepEqual(fs.readFileSync(path.join(cacheDir, "_manifest.json")), beforeManifestBytes, "the manifest bytes must be untouched");
		assert.deepEqual(readManifest(cacheDir), beforeManifest);
	} finally {
		cleanup(root);
	}
});

test("promoteCacheFile preserves multi-byte UTF-8 and a byte-order mark exactly", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "workspace", "utf8.md");
	const cacheDir = path.join(root, "cache");
	const content = "\uFEFF# café — déjà vu \u{1F600}\n";
	try {
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fs.writeFileSync(sourcePath, content);
		const promoted = promoteCacheFile(cacheDir, { version: 1, files: {} }, "session-1", sourcePath, "utf8.md", "UTF-8");
		assert.deepEqual(fs.readFileSync(path.join(cacheDir, "utf8.md")), Buffer.from(content), "valid UTF-8 bytes must round-trip unchanged");
		assert.equal(promoted.entry.sizeBytes, Buffer.byteLength(content), "metadata size must reflect the original bytes");
	} finally {
		cleanup(root);
	}
});

// ---------------------------------------------------------------------------
// Descriptor-bound source identity (CR-PROMO-IDENTITY-BINDING-UNTESTED)
// ---------------------------------------------------------------------------

test("promoteCacheFile rejects a source whose named identity no longer matches the opened descriptor", () => {
	const root = tmpDir();
	const workspaceRoot = path.join(root, "workspace");
	const sourcePath = path.join(workspaceRoot, "plan.md");
	const decoyPath = path.join(workspaceRoot, "decoy.md");
	const cacheDir = path.join(root, "cache");
	const originalStatSync = fsMutable.statSync;
	try {
		fs.mkdirSync(workspaceRoot, { recursive: true });
		fs.writeFileSync(sourcePath, "opened-descriptor bytes\n");
		fs.writeFileSync(decoyPath, "a different in-workspace file\n");
		// The pathname is replaced by another in-workspace file after the
		// descriptor is opened but before its identity is bound: canonical
		// containment still passes, yet the named inode differs from the opened
		// one. Only the sameFile identity guard can reject this.
		const decoyStat = originalStatSync(decoyPath);
		fsMutable.statSync = ((target: fs.PathLike, ...rest: unknown[]) => {
			if (String(target) === sourcePath) return decoyStat;
			return (originalStatSync as (...args: unknown[]) => fs.Stats)(target, ...rest);
		}) as typeof fsMutable.statSync;
		assert.throws(
			() => promoteCacheFile(cacheDir, { version: 1, files: {} }, "session-1", sourcePath, "plan.md", "Plan", [workspaceRoot]),
			/within the session workspace/,
		);
		assert.equal(fs.existsSync(path.join(cacheDir, "plan.md")), false, "a source that fails the identity guard must never be published");
		assert.equal(readManifest(cacheDir).files["plan.md"], undefined, "a source that fails the identity guard must never reach the manifest");
	} finally {
		fsMutable.statSync = originalStatSync;
		cleanup(root);
	}
});

// ---------------------------------------------------------------------------
// Manifest write projection and fsync ordering (CR-PROMO-TEST-GAPS)
// ---------------------------------------------------------------------------

test("writeManifest persists only the projected named fields", () => {
	const dir = tmpDir();
	try {
		const hostile = {
			...cacheEntry("2026-02-02T00:00:00.000Z", "Durable"),
			artifactId: "artifact-keep",
			secret: "must not persist",
			content: "attacker-controlled",
		} as unknown as CacheManifest["files"][string];
		writeManifest(dir, { version: 1, files: { "plan.md": hostile } });
		const raw = JSON.parse(fs.readFileSync(path.join(dir, "_manifest.json"), "utf8")) as { files: Record<string, Record<string, unknown>> };
		const entry = raw.files["plan.md"]!;
		assert.deepEqual(
			Object.keys(entry).sort(),
			["artifactId", "created", "createdBy", "description", "sizeBytes", "updated", "updatedBy"],
		);
		assert.equal(entry.secret, undefined);
		assert.equal(entry.content, undefined);
		assert.equal(entry.description, "Durable");
		assert.equal(entry.artifactId, "artifact-keep");
	} finally {
		cleanup(dir);
	}
});

test("promoteCacheFile fsyncs the staged bytes before linking them into place", () => {
	const root = tmpDir();
	const sourcePath = path.join(root, "source.md");
	const cacheDir = path.join(root, "cache");
	const order: string[] = [];
	const originalFsync = fsMutable.fsyncSync;
	const originalLink = fsMutable.linkSync;
	try {
		fs.writeFileSync(sourcePath, "durable bytes\n");
		fsMutable.fsyncSync = ((fd: number) => { order.push("fsync"); return originalFsync(fd); }) as typeof fsMutable.fsyncSync;
		fsMutable.linkSync = ((from: fs.PathLike, to: fs.PathLike) => { order.push("link"); return originalLink(from, to); }) as typeof fsMutable.linkSync;
		promoteCacheFile(cacheDir, { version: 1, files: {} }, "session-1", sourcePath, "durable.md", "Durable");
		assert.deepEqual(order, ["fsync", "link"], "the staged bytes must be fsynced before the atomic link publishes them");
		assert.equal(fs.readFileSync(path.join(cacheDir, "durable.md"), "utf8"), "durable bytes\n");
	} finally {
		fsMutable.fsyncSync = originalFsync;
		fsMutable.linkSync = originalLink;
		cleanup(root);
	}
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test("formatFileSize formats bytes correctly", () => {
	assert.equal(formatFileSize(500), "500B");
	assert.equal(formatFileSize(1024), "1.0KB");
	assert.equal(formatFileSize(1536), "1.5KB");
	assert.equal(formatFileSize(1024 * 1024), "1.0MB");
	assert.equal(formatFileSize(2.5 * 1024 * 1024), "2.5MB");
});

test("formatAge formats recent, minute, hour, and day age bands", () => {
	const originalNow = Date.now;
	const now = new Date("2026-05-06T12:00:00Z").getTime();
	Date.now = () => now;
	try {
		assert.equal(formatAge(new Date(now - 30_000).toISOString()), "just now");
		assert.equal(formatAge(new Date(now - 2 * 60_000).toISOString()), "2m ago");
		assert.equal(formatAge(new Date(now - 3 * 3600_000).toISOString()), "3h ago");
		assert.equal(formatAge(new Date(now - 4 * 86400_000).toISOString()), "4d ago");
	} finally {
		Date.now = originalNow;
	}
});
