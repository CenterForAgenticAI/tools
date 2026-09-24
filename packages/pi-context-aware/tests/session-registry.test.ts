import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createSessionRegistry,
	deriveProjectKey,
	SESSION_REGISTRY_RETENTION_MS,
	type SessionRegistryOptions,
} from "../session-registry.js";
import { REGISTRY_SCHEMA_VERSION, asPiSessionId, asWorkstreamId, type RegistryProjection } from "../workstream-schema.js";

const now = "2026-07-20T00:00:00.000Z";

function projection(overrides: Partial<RegistryProjection> = {}): RegistryProjection {
	return {
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		workstreamId: asWorkstreamId("ws-1"),
		piSessionId: asPiSessionId("pi-1"),
		projectKey: "project-key",
		incarnation: "inc-1",
		pid: 41,
		pidStart: now,
		sequence: 1,
		state: "active",
		objective: "Ship registry projections",
		status: "active",
		refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
		heartbeatAt: now,
		updatedAt: now,
		...overrides,
	};
}

function options(rootDir: string, overrides: Partial<SessionRegistryOptions> = {}): SessionRegistryOptions {
	return {
		registryRoot: rootDir,
		projectKey: "project-key",
		now: () => Date.parse(now),
		...overrides,
	};
}

function chmod(file: string, mode: number): void {
	(fs as unknown as { chmodSync: (path: string, mode: number) => void }).chmodSync(file, mode);
}

function symlink(target: string, link: string, type: "file" | "dir"): void {
	(fs as unknown as { symlinkSync: (target: string, link: string, type: "file" | "dir") => void }).symlinkSync(target, link, type);
}

test("registry derives a stable project key and atomically isolates per-session records", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const registry = createSessionRegistry(options(root));
	assert.equal(deriveProjectKey("/repo/.git"), deriveProjectKey("/repo/./.git"));
	const first = registry.write(projection());
	const second = registry.write(projection({
		piSessionId: asPiSessionId("pi-2"),
		incarnation: "inc-2",
		pid: 42,
		sequence: 1,
	}));
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.deepEqual(registry.list().map((item) => item.piSessionId), ["pi-1", "pi-2"]);
	const projectDir = path.join(root, "project-key");
	assert.equal((fs.statSync(projectDir) as unknown as { mode: number }).mode & 0o777, 0o700);
	for (const sessionId of ["pi-1", "pi-2"]) {
		const file = path.join(projectDir, `${sessionId}.json`);
		assert.equal((fs.statSync(file) as unknown as { mode: number }).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(projectDir).filter((name) => name.includes(sessionId)), [`${sessionId}.json`]);
	}
	assert.equal(fs.readdirSync(projectDir).filter((name) => name.endsWith(".tmp")).length, 0);
	chmod(root, 0o755);
	chmod(projectDir, 0o755);
	chmod(path.join(projectDir, "pi-1.json"), 0o644);
	assert.equal(registry.refresh("pi-1").ok, true);
	assert.equal((fs.statSync(projectDir) as unknown as { mode: number }).mode & 0o777, 0o700);
	assert.equal((fs.statSync(path.join(projectDir, "pi-1.json")) as unknown as { mode: number }).mode & 0o777, 0o600);
});

test("registry rejects symlinked roots, project directories, records, and traversal-like IDs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-outside-"));
	symlink(outside, path.join(root, "project-key"), "dir");
	assert.equal(createSessionRegistry(options(root)).write(projection()).ok, false);
	const rootLink = path.join(root, "root-link");
	symlink(outside, rootLink, "dir");
	assert.equal(createSessionRegistry(options(rootLink)).write(projection()).ok, false);
	const nestedRoot = path.join(root, "nested-root");
	fs.mkdirSync(nestedRoot);
	const nestedLink = path.join(nestedRoot, "link");
	symlink(outside, nestedLink, "dir");
	assert.equal(createSessionRegistry(options(path.join(nestedLink, "new-registry"))).write(projection()).ok, false);

	const safeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const registry = createSessionRegistry(options(safeRoot));
	assert.equal(registry.write(projection({ piSessionId: asPiSessionId("..") })).ok, false);
	assert.equal(createSessionRegistry(options(safeRoot, { idFactory: () => "../escape" })).write(projection()).ok, false);
	assert.equal(registry.write(projection()).ok, true);
	const outsideFile = path.join(outside, "record.json");
	fs.writeFileSync(outsideFile, "not a registry record", { mode: 0o600 });
	fs.unlinkSync(path.join(safeRoot, "project-key", "pi-1.json"));
	symlink(outsideFile, path.join(safeRoot, "project-key", "pi-1.json"), "file");
	assert.equal(registry.read("pi-1"), null);
	assert.equal(registry.refresh("pi-1").ok, false);
});

test("registry refreshes only the owning incarnation and protects PID reuse", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	let current = Date.parse(now);
	const registry = createSessionRegistry(options(root, { now: () => current }));
	assert.equal(registry.write(projection()).ok, true);
	current += 1_000;
	const refreshed = registry.refresh("pi-1", { heartbeatAt: new Date(current).toISOString(), updatedAt: new Date(current).toISOString() });
	assert.equal(refreshed.ok, true);
	assert.equal(refreshed.projection?.sequence, 2);
	assert.equal(registry.write(projection({ incarnation: "replacement", pidStart: new Date(current).toISOString() })).ok, false);
	assert.equal(registry.close("pi-1").projection?.state, "closed");
	assert.equal(registry.refresh("pi-1", { incarnation: "replacement" }).ok, false);
});

test("registry refuses a write while a same-session compare-and-swap is in progress", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const registry = createSessionRegistry(options(root));
	assert.equal(registry.write(projection()).ok, true);
	const projectDir = path.join(root, "project-key");
	fs.mkdirSync(path.join(projectDir, ".pi-1.json.lock"));
	const blocked = registry.write(projection({ sequence: 2, updatedAt: "2026-07-20T00:00:01.000Z" }));
	assert.equal(blocked.ok, false);
	assert.equal(registry.read("pi-1")?.sequence, 1);
	fs.rmdirSync(path.join(projectDir, ".pi-1.json.lock"));
});

test("registry reclaims only an old lock owned by a dead PID incarnation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const current = Date.parse(now) + 10_000;
	const registry = createSessionRegistry(options(root, {
		now: () => current,
		staleAfterMs: 1_000,
		processProbe: { isAlive: (pid, pidStart) => pid === 41 && pidStart === now },
	}));
	assert.equal(registry.write(projection()).ok, true);
	const projectDir = path.join(root, "project-key");
	const lockDir = path.join(projectDir, ".pi-1.json.lock");
	fs.mkdirSync(lockDir, { mode: 0o700 });
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
		token: "dead-owner",
		pid: 99,
		pidStart: "dead-start",
		acquiredAt: now,
	}), { mode: 0o600 });
	const reclaimed = registry.write(projection({ sequence: 2, updatedAt: new Date(current).toISOString() }));
	assert.equal(reclaimed.ok, true);
	assert.equal(registry.read("pi-1")?.sequence, 2);
	assert.equal(fs.existsSync(lockDir), false);
});

test("registry marks dead records stale, retains recent closed records, and expires old records", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	let current = Date.parse(now);
	const alive = new Set([41, 42]);
	const registry = createSessionRegistry(options(root, {
		now: () => current,
		processProbe: { isAlive: (pid) => alive.has(pid) },
		staleAfterMs: 10_000,
	}));
	assert.equal(registry.write(projection({ heartbeatAt: now, updatedAt: now })).ok, true);
	assert.equal(registry.write(projection({ piSessionId: asPiSessionId("pi-2"), pid: 42 })).ok, true);
	alive.delete(41);
	current += 2_000;
	const cleanup = registry.cleanup();
	assert.equal(cleanup.stale, 1);
	assert.equal(registry.read("pi-1")?.state, "stale");
	assert.equal(registry.read("pi-2")?.state, "active");
	current += 7 * 24 * 60 * 60 * 1_000 + 1;
	assert.equal(registry.cleanup().removed, 1);
	assert.equal(registry.read("pi-1"), null);
});

test("registry tolerates malformed files without promoting projections to authority", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const registry = createSessionRegistry(options(root));
	const dir = path.join(root, "project-key");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "broken.json"), "not-json", { mode: 0o600 });
	assert.deepEqual(registry.list(), []);
});

test("registry retains a closed projection for seven days before removal", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	let current = Date.parse(now);
	const registry = createSessionRegistry(options(root, { now: () => current }));
	assert.equal(registry.write(projection()).ok, true);
	assert.equal(registry.close("pi-1").projection?.state, "closed");
	current += SESSION_REGISTRY_RETENTION_MS - 1;
	assert.equal(registry.cleanup().removed, 0);
	assert.equal(registry.read("pi-1")?.state, "closed");
	current += 2;
	assert.equal(registry.cleanup().removed, 1);
	assert.equal(registry.read("pi-1"), null);
});

test("registry cleanup preserves a newer future-expiry write racing with expired removal", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const current = Date.parse(now) + 10_000;
	const registry = createSessionRegistry(options(root, { now: () => current }));
	assert.equal(registry.write(projection({
		state: "closed",
		expiresAt: new Date(current - 1).toISOString(),
		updatedAt: new Date(current - 2).toISOString(),
	})).ok, true);
	const target = registry.filePath("pi-1");
	let attempted = false;
	let retryAfterCleanup = false;
	const fsWithUnlink = fs as unknown as { unlinkSync: (file: string) => void };
	const originalUnlink = fsWithUnlink.unlinkSync;
	fsWithUnlink.unlinkSync = (file: string) => {
		if (file === target && !attempted) {
			attempted = true;
			const raced = registry.write(projection({
				state: "closed",
				sequence: 2,
				expiresAt: new Date(current + SESSION_REGISTRY_RETENTION_MS).toISOString(),
				updatedAt: new Date(current).toISOString(),
			}));
			retryAfterCleanup = !raced.ok;
		}
		originalUnlink(file);
	};
	try {
		registry.cleanup();
	} finally {
		fsWithUnlink.unlinkSync = originalUnlink;
	}
	if (retryAfterCleanup) {
		assert.equal(registry.write(projection({
			state: "closed",
			sequence: 2,
			expiresAt: new Date(current + SESSION_REGISTRY_RETENTION_MS).toISOString(),
			updatedAt: new Date(current).toISOString(),
		})).ok, true);
	}
	assert.equal(registry.read("pi-1")?.sequence, 2, "newer future-expiry record survives cleanup");
});

test("cleanup does not resurrect a deleted projection after pre-lock read", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const current = Date.parse(now) + 10_000;
	const registry = createSessionRegistry(options(root, { now: () => current, staleAfterMs: 1_000 }));
	assert.equal(registry.write(projection({
		heartbeatAt: now,
		updatedAt: now,
	})).ok, true);
	const target = registry.filePath("pi-1");
	let deleted = false;
	const fsWithMkdir = fs as unknown as {
		mkdirSync: (file: string, options?: { mode?: number; recursive?: boolean }) => string | undefined;
	};
	const originalMkdir = fsWithMkdir.mkdirSync;
	fsWithMkdir.mkdirSync = (file: string, options?: { mode?: number; recursive?: boolean }) => {
		if (file.endsWith(".pi-1.json.lock") && !deleted) {
			deleted = true;
			fs.unlinkSync(target);
		}
		return originalMkdir(file, options);
	};
	try {
		const cleanup = registry.cleanup();
		assert.deepEqual(cleanup, { stale: 0, removed: 0, ignored: 1 });
	} finally {
		fsWithMkdir.mkdirSync = originalMkdir;
	}
	assert.equal(deleted, true);
	assert.equal(fs.existsSync(target), false);
	assert.equal(registry.read("pi-1"), null);
});

test("reclaimed lock release never removes a replacement owner", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-registry-"));
	const current = Date.parse(now) + 10_000;
	let ids = 0;
	const registry = createSessionRegistry(options(root, {
		now: () => current,
		pid: 41,
		pidStart: now,
		staleAfterMs: 1_000,
		idFactory: () => `lock-token-${++ids}`,
		processProbe: { isAlive: () => false },
	}));
	assert.equal(registry.write(projection()).ok, true);
	const projectDir = path.join(root, "project-key");
	const lockDir = path.join(projectDir, ".pi-1.json.lock");
	fs.mkdirSync(lockDir, { mode: 0o700 });
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
			token: "dead-owner",
			pid: 99,
			pidStart: "dead-start",
			acquiredAt: now,
		}), { mode: 0o600 });
	const ownerPath = path.join(lockDir, "owner.json");
	const fsWithChmod = fs as unknown as { chmodSync: (file: string, mode: number) => void };
	const originalChmod = fsWithChmod.chmodSync;
	let replacementInstalled = false;
	fsWithChmod.chmodSync = (file: string, mode: number) => {
		originalChmod(file, mode);
		if (path.basename(file) === "owner.json" && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).pid === 41) {
			replacementInstalled = true;
			fs.writeFileSync(file, JSON.stringify({
				token: "replacement-owner",
				pid: 77,
				pidStart: "replacement-start",
				acquiredAt: new Date(current).toISOString(),
			}) + "\n", { mode: 0o600 });
		}
	};
	try {
		const reclaimed = registry.write(projection({ sequence: 2, updatedAt: new Date(current).toISOString() }));
		assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
	} finally {
		fsWithChmod.chmodSync = originalChmod;
	}
	assert.equal(replacementInstalled, true);
	assert.equal(fs.existsSync(lockDir), true, "replacement guard remains after reclaimed owner releases");
	assert.equal(JSON.parse(fs.readFileSync(ownerPath, "utf8")).token, "replacement-owner");
});
