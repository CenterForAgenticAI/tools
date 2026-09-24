/** Private, incarnation-aware registry projections for concurrent Pi sessions. */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	REGISTRY_SCHEMA_VERSION,
	parseRegistryProjection,
	type RegistryProjection,
	type WorkstreamStatus,
} from "./workstream-schema.js";

export const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_REGISTRY_STALE_AFTER_MS = 5 * 60 * 1_000;

export interface RegistryProcessProbe {
	readonly isAlive: (pid: number, pidStart: string) => boolean;
}

interface SessionLockOwner {
	readonly token: string;
	readonly pid: number;
	readonly pidStart: string;
	readonly acquiredAt: string;
}

export interface SessionRegistryOptions {
	/** Inject the v1 directory in tests; production passes ~/.pi/agent/session-registry/v1. */
	readonly registryRoot: string;
	/** A pre-derived key is useful to callers that already own project discovery. */
	readonly projectKey?: string;
	readonly gitCommonDirectory?: string;
	readonly cwd?: string;
	readonly now?: () => number;
	readonly incarnation?: string;
	readonly pid?: number;
	readonly pidStart?: string;
	readonly idFactory?: () => string;
	readonly processProbe?: RegistryProcessProbe;
	readonly staleAfterMs?: number;
	readonly retentionMs?: number;
}

export interface RegistryWriteResult {
	readonly ok: boolean;
	readonly projection?: RegistryProjection;
	readonly reason?: string;
}

export interface RegistryCleanupResult {
	readonly stale: number;
	readonly removed: number;
	readonly ignored: number;
}

export interface SessionRegistry {
	readonly projectKey: string;
	readonly filePath: (piSessionId: string) => string;
	readonly read: (piSessionId: string) => RegistryProjection | null;
	readonly list: () => readonly RegistryProjection[];
	readonly write: (projection: RegistryProjection) => RegistryWriteResult;
	readonly refresh: (piSessionId: string, patch?: Partial<RegistryProjection>) => RegistryWriteResult;
	readonly close: (piSessionId: string, expectedIncarnation?: string) => RegistryWriteResult;
	readonly cleanup: () => RegistryCleanupResult;
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		const parent = path.dirname(resolved);
		if (parent !== resolved) {
			try { return path.join(fs.realpathSync.native(parent), path.basename(resolved)); } catch { /* use resolved below */ }
		}
		return resolved;
	}
}

/** Derive an opaque, filesystem-safe key from canonical Git or cwd identity. */
export function deriveProjectKey(identity: string): string {
	return createHash("sha256").update(canonicalPath(identity)).digest("hex");
}

function safeKey(value: string): string | null {
	const trimmed = value.trim();
	return trimmed !== "." && trimmed !== ".." && /^[A-Za-z0-9._-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function sessionFileName(piSessionId: string): string | null {
	if (piSessionId === "." || piSessionId === ".." || !/^[A-Za-z0-9._-]{1,128}$/.test(piSessionId)) return null;
	return `${piSessionId}.json`;
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function result(reason: string): RegistryWriteResult {
	return { ok: false, reason };
}

function sameOwner(first: RegistryProjection, second: RegistryProjection): boolean {
	return first.incarnation === second.incarnation && first.pid === second.pid && first.pidStart === second.pidStart;
}

function hasSymlinkComponent(value: string): boolean {
	const parsed = path.parse(value);
	let current = parsed.root;
	for (const component of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink() && !(process.platform === "darwin" && current === "/var")) return true;
		} catch {
			break;
		}
	}
	return false;
}

function isSafeDirectory(value: string): boolean {
	try {
		const stat = fs.lstatSync(value);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function parseSessionLockOwner(value: unknown): SessionLockOwner | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const owner = value as Record<string, unknown>;
	if (typeof owner.token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.token)) return null;
	if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return null;
	if (typeof owner.pidStart !== "string" || owner.pidStart.length === 0 || owner.pidStart.length > 128) return null;
	if (typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) return null;
	return { token: owner.token, pid: owner.pid, pidStart: owner.pidStart, acquiredAt: owner.acquiredAt };
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
	const resolvedProjectKey = safeKey(options.projectKey ?? deriveProjectKey(options.gitCommonDirectory ?? options.cwd ?? process.cwd()));
	if (!resolvedProjectKey) throw new Error("registry project key must be a bounded filesystem-safe key");
	const projectKey = resolvedProjectKey;
	const rootInput = path.resolve(options.registryRoot);
	const rootInputHasSymlink = hasSymlinkComponent(rootInput);
	const root = canonicalPath(rootInput);
	const rootWasSymlink = (() => {
		try { return fs.lstatSync(rootInput).isSymbolicLink(); } catch { return false; }
	})();
	const directory = path.join(root, projectKey);
	const now = options.now ?? Date.now;
	const retentionMs = Math.max(1, options.retentionMs ?? SESSION_REGISTRY_RETENTION_MS);
	const staleAfterMs = Math.max(1, options.staleAfterMs ?? SESSION_REGISTRY_STALE_AFTER_MS);
	const makeId = options.idFactory ?? randomUUID;

	function ensurePrivateDirectory(value: string): boolean {
		const parsed = path.parse(value);
		let current = parsed.root;
		for (const component of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
			current = path.join(current, component);
			try {
				const stat = fs.lstatSync(current);
				if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
			} catch {
				try {
					fs.mkdirSync(current, { mode: 0o700 });
					const stat = fs.lstatSync(current);
					if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
				} catch {
					return false;
				}
			}
		}
		try {
			fs.chmodSync(value, 0o700);
			return isSafeDirectory(value);
		} catch {
			return false;
		}
	}

	function ensurePrivateDirectories(): boolean {
		if (rootInputHasSymlink || rootWasSymlink || hasSymlinkComponent(rootInput) || hasSymlinkComponent(root)) return false;
		return ensurePrivateDirectory(root) && ensurePrivateDirectory(directory);
	}

	function isSafeRegularFile(value: string): boolean {
		try {
			const stat = fs.lstatSync(value);
			return stat.isFile() && !stat.isSymbolicLink();
		} catch {
			return false;
		}
	}

	function filePath(piSessionId: string): string {
		const filename = sessionFileName(piSessionId);
		return filename === null ? path.join(directory, "invalid-session-id.json") : path.join(directory, filename);
	}

	function read(piSessionId: string): RegistryProjection | null {
		const filename = sessionFileName(piSessionId);
		if (!filename) return null;
		try {
			if (!isSafeDirectory(root) || !isSafeDirectory(directory)) return null;
			const target = path.join(directory, filename);
			if (!isSafeRegularFile(target)) return null;
			const raw = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
			const parsed = parseRegistryProjection(raw);
			return parsed?.projectKey === projectKey && parsed.piSessionId === piSessionId ? parsed : null;
		} catch {
			return null;
		}
	}

	function acquireSessionLock(filename: string): (() => void) | null {
		const lockPath = path.join(directory, `.${filename}.lock`);
		const lockOwnerPid = options.pid ?? process.pid;
		const lockOwnerPidStart = options.pidStart ?? `process-${process.pid}`;
		const token = makeId();
		if (typeof token !== "string" || token === "." || token === ".." || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) return null;
		const owner: SessionLockOwner = { token, pid: lockOwnerPid, pidStart: lockOwnerPidStart, acquiredAt: iso(now()) };
		const readOwner = (directoryPath: string): SessionLockOwner | null => {
			try {
				const ownerPath = path.join(directoryPath, "owner.json");
				if (!isSafeRegularFile(ownerPath)) return null;
				return parseSessionLockOwner(JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown);
			} catch {
				return null;
			}
		};
		const release = (): void => {
			try {
				const existing = readOwner(lockPath);
				const stat = fs.lstatSync(lockPath);
				if (existing?.token === owner.token && stat.isDirectory() && !stat.isSymbolicLink()) {
					fs.unlinkSync(path.join(lockPath, "owner.json"));
					fs.rmdirSync(lockPath);
				}
			} catch { /* another process already released or replaced the lock */ }
		};
		const isStale = (directoryPath: string, fallbackMtime: number): boolean => {
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(directoryPath);
				if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
			} catch {
				return false;
			}
			const existing = readOwner(directoryPath);
			const acquiredAt = existing === null ? fallbackMtime : Date.parse(existing.acquiredAt);
			if (!Number.isFinite(acquiredAt) || now() - acquiredAt < staleAfterMs) return false;
			if (existing === null) return true;
			try { return !(options.processProbe?.isAlive(existing.pid, existing.pidStart) ?? true); } catch { return true; }
		};
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			fs.chmodSync(lockPath, 0o700);
			fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			fs.chmodSync(path.join(lockPath, "owner.json"), 0o600);
			return release;
		} catch {
			try {
				const stat = fs.lstatSync(lockPath);
				if (!isStale(lockPath, stat.mtimeMs)) return null;
				const reclaimPath = path.join(directory, `.${filename}.reclaim.${token}`);
				fs.renameSync(lockPath, reclaimPath);
				try {
					if (!isStale(reclaimPath, stat.mtimeMs)) {
						fs.renameSync(reclaimPath, lockPath);
						return null;
					}
					fs.rmSync(reclaimPath, { recursive: true, force: false });
				} catch {
					try { fs.renameSync(reclaimPath, lockPath); } catch { /* leave a safely isolated reclaim directory */ }
					return null;
				}
				fs.mkdirSync(lockPath, { mode: 0o700 });
				fs.chmodSync(lockPath, 0o700);
				fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				fs.chmodSync(path.join(lockPath, "owner.json"), 0o600);
				return release;
			} catch {
				return null;
			}
		}
	}

	function atomicWriteUnlocked(parsed: RegistryProjection, filename: string): RegistryWriteResult {
		const target = path.join(directory, filename);
		try {
			if (fs.existsSync(target) && !isSafeRegularFile(target)) return result("session record is not a regular non-symlink file");
		} catch {
			return result("cannot inspect session record");
		}
		const existing = read(parsed.piSessionId);
		if (existing && !sameOwner(existing, parsed)) return result("another incarnation owns this session record");
		if (existing && parsed.sequence <= existing.sequence) return result("projection sequence must increase");
		if (options.incarnation !== undefined && parsed.incarnation !== options.incarnation) return result("projection is not owned by this incarnation");
		if (options.pid !== undefined && parsed.pid !== options.pid) return result("projection is not owned by this PID");
		if (options.pidStart !== undefined && parsed.pidStart !== options.pidStart) return result("projection has a different PID start marker");
		let temporary: string | undefined;
		try {
			const token = makeId();
			if (typeof token !== "string" || token === "." || token === ".." || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) return result("temporary registry ID is not filesystem-safe");
			temporary = path.join(directory, `.${filename}.${token}.tmp`);
			fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			fs.chmodSync(temporary, 0o600);
			fs.renameSync(temporary, target);
			fs.chmodSync(target, 0o600);
			return { ok: true, projection: parsed };
		} catch (error) {
			return result(error instanceof Error ? error.message : "registry write failed");
		} finally {
			if (temporary !== undefined) {
				try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
			}
		}
	}

	function atomicWrite(projection: RegistryProjection): RegistryWriteResult {
		const parsed = parseRegistryProjection(projection);
		if (!parsed || parsed.projectKey !== projectKey) return result("projection does not satisfy the registry schema or project key");
		const filename = sessionFileName(parsed.piSessionId);
		if (!filename) return result("Pi session ID is not filesystem-safe");
		if (!ensurePrivateDirectories()) return result("registry root or project directory is not a private real directory");
		const release = acquireSessionLock(filename);
		if (!release) return result("session record is busy");
		try { return atomicWriteUnlocked(parsed, filename); } finally { release(); }
	}

	function write(projection: RegistryProjection): RegistryWriteResult {
		return atomicWrite(projection);
	}

	function refresh(piSessionId: string, patch: Partial<RegistryProjection> = {}): RegistryWriteResult {
		const existing = read(piSessionId);
		if (!existing) return result("session record is missing or malformed");
		return atomicWrite({
			...existing,
			...patch,
			piSessionId: existing.piSessionId,
			projectKey,
			sequence: existing.sequence + 1,
		});
	}

	function close(piSessionId: string, expectedIncarnation?: string): RegistryWriteResult {
		const existing = read(piSessionId);
		if (!existing) return result("session record is missing or malformed");
		if (expectedIncarnation !== undefined && existing.incarnation !== expectedIncarnation) return result("another incarnation owns this session record");
		const closedAt = now();
		return atomicWrite({
			...existing,
			state: "closed",
			heartbeatAt: iso(closedAt),
			updatedAt: iso(closedAt),
			expiresAt: iso(closedAt + retentionMs),
			sequence: existing.sequence + 1,
		});
	}

	function list(): readonly RegistryProjection[] {
		try {
			if (!isSafeDirectory(root) || !isSafeDirectory(directory)) return [];
			return fs.readdirSync(directory, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => read(entry.name.slice(0, -5)))
				.filter((item): item is RegistryProjection => item !== null)
				.sort((a, b) => a.piSessionId.localeCompare(b.piSessionId));
		} catch {
			return [];
		}
	}

	function cleanup(): RegistryCleanupResult {
		let stale = 0;
		let removed = 0;
		let ignored = 0;
		const current = now();
		try {
			if (!ensurePrivateDirectories()) return { stale: 0, removed: 0, ignored: 1 };
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const piSessionId = entry.name.slice(0, -5);
				const existing = read(piSessionId);
				if (!existing) { ignored += 1; continue; }
				if ((existing.state === "closed" || existing.state === "stale") && existing.expiresAt !== undefined && Date.parse(existing.expiresAt) <= current) {
					const release = acquireSessionLock(entry.name);
					if (!release) { ignored += 1; continue; }
					try {
						const confirm = read(piSessionId);
						if (confirm && sameOwner(existing, confirm) && confirm.sequence === existing.sequence &&
							(confirm.state === "closed" || confirm.state === "stale") && confirm.expiresAt !== undefined && Date.parse(confirm.expiresAt) <= current) {
							try { fs.unlinkSync(filePath(piSessionId)); removed += 1; } catch { ignored += 1; }
						} else ignored += 1;
					} finally {
						release();
					}
					continue;
				}
				if (existing.state !== "active") continue;
				const tooOld = current - Date.parse(existing.heartbeatAt) >= staleAfterMs;
				let alive = true;
				try { alive = options.processProbe?.isAlive(existing.pid, existing.pidStart) ?? true; } catch { alive = false; }
				if (!tooOld && alive) continue;
				const release = acquireSessionLock(entry.name);
				if (!release) { ignored += 1; continue; }
				try {
					const confirm = read(piSessionId);
					if (!confirm || !sameOwner(existing, confirm) || confirm.sequence !== existing.sequence || confirm.state !== "active") {
						ignored += 1;
						continue;
					}
					const confirmTooOld = current - Date.parse(confirm.heartbeatAt) >= staleAfterMs;
					let confirmAlive = true;
					try { confirmAlive = options.processProbe?.isAlive(confirm.pid, confirm.pidStart) ?? true; } catch { confirmAlive = false; }
					if (!confirmTooOld && confirmAlive) {
						ignored += 1;
						continue;
					}
					const marked = atomicWriteUnlocked({
						...confirm,
						state: "stale",
						updatedAt: iso(current),
						expiresAt: iso(current + retentionMs),
						sequence: confirm.sequence + 1,
					}, entry.name);
					if (marked.ok) stale += 1; else ignored += 1;
				} finally {
					release();
				}
			}
		} catch {
			ignored += 1;
		}
		return { stale, removed, ignored };
	}

	return { projectKey, filePath, read, list, write, refresh, close, cleanup };
}

/** Build a minimal projection for callers that do not need the registry store API. */
export function createRegistryProjection(input: Omit<RegistryProjection, "schemaVersion">): RegistryProjection {
	const projection = { ...input, schemaVersion: REGISTRY_SCHEMA_VERSION };
	const parsed = parseRegistryProjection(projection);
	if (!parsed) throw new Error("registry projection does not satisfy the schema");
	return parsed;
}

export type { RegistryProjection, WorkstreamStatus };
