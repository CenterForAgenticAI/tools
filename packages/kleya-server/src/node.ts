// @centerforagenticai/kleya-server/node: the host on Node (K1, plan step 4). Platform subpath: the one subpath that
// may use Node APIs. One SQLite file per session, one owner process per store, a durable change index, the alarm store
// with its wake timer, and an idle sweep. Files are named by `sessionName`, never by scope.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HarnessId } from "@centerforagenticai/kleya-client/protocol";
import { openIndexedStore, type IndexedStore } from "./feed/store.ts";
import { RECOVERY_DELAY_MS, sessionName, type Fence, type Host, type HostPorts, type Scope, type SessionStore } from "./host/core.ts";

/** Another process owns the session's store. The HTTP edge answers it 503 with `Retry-After: 1`, and no text. */
export class OwnerBusy extends Error {
	constructor() {
		super("the session's store is owned by another process");
		this.name = "OwnerBusy";
	}
}

/** A write under a stale fence: a later owner in this process took the session over (K1-I2). */
class Fenced extends Error {
	constructor() {
		super("the session's writer was fenced by a newer owner");
		this.name = "Fenced";
	}
}

export type NodePortsOptions = {
	/** The directory of the session stores, their lock files and the alarm store. Created if missing. */
	readonly dir: string;
	/** How long a session has been unused before the idle sweep releases it. Default 300,000 ms. */
	readonly idleMs?: number;
};

export type NodePorts = HostPorts & {
	readonly alarm: NonNullable<HostPorts["alarm"]>;
	/**
	 * Runs the alarms and the idle sweep for `host`, which must be built on these ports: a due alarm calls `host.wake`,
	 * and a session unused for `idleMs` is offered to `host.release`, which keeps it open while it is busy. Alarms stored
	 * by an earlier process are armed now. Call once.
	 */
	start(host: Host): void;
	/** Stops the timers and closes every store and lock. Close the host first. */
	close(): Promise<void>;
};

/** Wait before a failed wake is tried again, such as one whose store another process owns. */
const RETRY_MS = 1_000;
/** A timer longer than this is armed in steps (setTimeout's limit is 2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 30;

type Lock = { readonly file: DatabaseSync; epoch: number };
type Shared = { readonly store: Promise<IndexedStore>; readonly name: string };

/** Takes the store's lock file, held by this connection until it closes or the process dies. */
function takeLock(path: string): DatabaseSync {
	const file = new DatabaseSync(path, { timeout: 0 });
	try {
		file.exec("PRAGMA locking_mode = EXCLUSIVE");
		// The first write takes the exclusive lock; EXCLUSIVE mode keeps it after the commit.
		file.exec("BEGIN EXCLUSIVE");
		file.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)");
		file.exec("COMMIT");
		return file;
	} catch (error) {
		file.close();
		// SQLITE_BUSY or SQLITE_LOCKED: another process holds it.
		const code = (error as { errcode?: number }).errcode;
		if (code === 5 || code === 6) throw new OwnerBusy();
		throw error;
	}
}

/**
 * The host's ports on Node. In one process each `acquire` raises the session's epoch and fences every earlier holder,
 * as after a crash; another process is refused with OwnerBusy while this one holds the store.
 */
export function nodePorts(options: NodePortsOptions): NodePorts {
	const { dir } = options;
	const idleMs = options.idleMs ?? 300_000;
	mkdirSync(dir, { recursive: true });
	const names = new Map<HarnessId, Promise<string>>();
	const nameOf = (id: HarnessId) => {
		let name = names.get(id);
		if (name === undefined) names.set(id, (name = sessionName(id, "store")));
		return name;
	};
	/** Epochs only rise, also across a release, so a fence from before it stays stale. */
	const epochs = new Map<HarnessId, number>();
	const locks = new Map<HarnessId, Lock>();
	const stores = new Map<HarnessId, Shared>();
	/** Last use of each session this process owns, and its scope, which the host gives with every alarm set. */
	const used = new Map<HarnessId, number>();
	const scopes = new Map<HarnessId, Scope>();
	let closed = false;

	const current = (id: HarnessId, fence: Fence) => locks.get(id)?.epoch === fence.epoch;
	const touch = (id: HarnessId) => {
		if (locks.has(id)) used.set(id, Date.now());
	};

	async function closeStore(id: HarnessId) {
		const shared = stores.get(id);
		if (shared === undefined) return;
		stores.delete(id);
		await (await shared.store.catch(() => undefined))?.close();
	}

	function shared(id: HarnessId, name: string): Shared {
		let s = stores.get(id);
		if (s === undefined) {
			s = { name, store: openNodeSqliteDatabase(join(dir, `${name}.db`)).then((db) => openIndexedStore(db)) };
			const opening = s;
			stores.set(id, opening);
			opening.store.catch(() => stores.get(id) === opening && stores.delete(id));
		}
		return s;
	}

	async function acquire(id: HarnessId): Promise<Fence> {
		if (closed) throw new Error("node ports are closed");
		const name = await nameOf(id);
		const epoch = (epochs.get(id) ?? 0) + 1;
		const held = locks.get(id);
		if (held === undefined) {
			locks.set(id, { file: takeLock(join(dir, `${name}.lock`)), epoch });
			epochs.set(id, epoch);
			used.set(id, Date.now());
			// A store this process opened without the lock may hold another process's state, such as its next ID: open it again.
			await closeStore(id);
			return { epoch };
		}
		held.epoch = epoch;
		epochs.set(id, epoch);
		used.set(id, Date.now());
		return { epoch };
	}

	async function release(id: HarnessId, fence: Fence) {
		const lock = locks.get(id);
		if (lock === undefined || lock.epoch !== fence.epoch) return;
		await closeStore(id);
		// Checked again: a newer acquire may have come while the store closed.
		if (locks.get(id) !== lock || lock.epoch !== fence.epoch) return;
		locks.delete(id);
		used.delete(id);
		scopes.delete(id);
		lock.file.close();
	}

	/** The store under `fence`: reads go through, and commits and new IDs fail once the fence is stale. Closing it closes nothing. */
	const fenced = (id: HarnessId, store: IndexedStore, fence: Fence) =>
		store.writer(() => {
			if (!current(id, fence)) throw new Fenced();
			touch(id);
		});

	// --- Alarms: one table in the directory, shared by every process that serves it. ---
	let alarms: DatabaseSync | undefined;
	const alarmDb = () => {
		if (alarms === undefined) {
			alarms = new DatabaseSync(join(dir, "alarms.db"), { timeout: 5_000 });
			alarms.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS alarm (id TEXT PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL) STRICT");
		}
		return alarms;
	};
	let host: Host | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sweeper: ReturnType<typeof setInterval> | undefined;
	/** Sessions woken or whose wake failed, and when to wake them again if the host sets no new alarm first. */
	const retry = new Map<string, number>();
	let firing = false;

	const due = (row: { id: string; at: number }) => Math.max(row.at, retry.get(row.id) ?? 0);
	function arm() {
		clearTimeout(timer);
		timer = undefined;
		if (closed || host === undefined || firing) return;
		const rows = alarmDb().prepare("SELECT id, at FROM alarm").all() as { id: string; at: number }[];
		if (rows.length === 0) return;
		const next = Math.min(...rows.map(due));
		timer = setTimeout(fire, Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now())));
		timer.unref?.();
	}

	async function fire() {
		timer = undefined;
		if (closed || host === undefined) return;
		firing = true;
		try {
			const now = Date.now();
			const rows = alarmDb().prepare("SELECT id, scope, at FROM alarm").all() as { id: string; scope: string; at: number }[];
			for (const row of rows) {
				if (closed || due(row) > now) continue;
				// Woken, the session runs its own sleeps while it is open; its alarm is for a process that dies. Until the
				// host sets it again, it is due again only after the recovery delay, as a running turn's alarm would be.
				retry.set(row.id, Date.now() + RECOVERY_DELAY_MS);
				try {
					await host.wake(JSON.parse(row.scope) as Scope, BACKGROUND_CONTEXT);
				} catch {
					// Another process owns it and runs it, or the open failed: the alarm stays, tried again later.
					retry.set(row.id, Date.now() + RETRY_MS);
				}
			}
		} finally {
			firing = false;
			arm();
		}
	}

	async function sweep() {
		if (closed || host === undefined) return;
		const before = Date.now() - idleMs;
		for (const [id, at] of [...used]) {
			const scope = scopes.get(id);
			if (at > before || scope === undefined) continue;
			// release keeps a busy session open; its next use or the next sweep tries again.
			await host.release(scope, BACKGROUND_CONTEXT).catch(() => false);
		}
	}

	return {
		owner: { acquire, release },
		storage: {
			async open(id, fence) {
				const store = await shared(id, await nameOf(id)).store;
				touch(id);
				return { storage: fenced(id, store, fence), changes: store.changes } satisfies SessionStore;
			},
			async drop(id) {
				const name = await nameOf(id);
				const fence = await acquire(id);
				try {
					await closeStore(id);
					for (const suffix of [".db", ".db-wal", ".db-shm"]) rmSync(join(dir, `${name}${suffix}`), { force: true });
				} finally {
					await release(id, fence);
				}
			},
		},
		alarm: {
			async set(id, scope, at) {
				if (closed) return;
				if (locks.has(id)) scopes.set(id, scope);
				touch(id);
				if (at === undefined) alarmDb().prepare("DELETE FROM alarm WHERE id = ?").run(id);
				else alarmDb().prepare("INSERT INTO alarm (id, scope, at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET scope = excluded.scope, at = excluded.at").run(id, JSON.stringify(scope), Math.ceil(at));
				retry.delete(id);
				arm();
			},
		},
		start(h) {
			if (host !== undefined) throw new Error("nodePorts: start was called already");
			host = h;
			sweeper = setInterval(() => void sweep(), Math.max(1, Math.min(idleMs, MAX_TIMER_MS)));
			sweeper.unref?.();
			arm();
		},
		async close() {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			clearInterval(sweeper);
			for (const id of [...stores.keys()]) await closeStore(id);
			for (const lock of locks.values()) lock.file.close();
			locks.clear();
			alarms?.close();
		},
	};
}
