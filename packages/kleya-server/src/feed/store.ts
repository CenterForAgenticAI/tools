// The durable change index (spec 5.2 "Two cursors"): pi-durable's SQLite storage with the index rows written inside each
// commit's own transaction, so a cursor reads on after the process or the object restarts. Platform-free: the Node
// adapter opens it over a file, the Cloudflare host over Durable Object SQLite. The Change of each write is the
// in-memory index's (./change.ts).
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { CommitResult, Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { SessionPosition } from "@centerforagenticai/kleya-client/protocol";
import type { Change, ChangeCommit, ChangeIndex } from "../feed.ts";
import { changeOf } from "./change.ts";

/** Commits the index keeps; older ones fall below the floor and their cursors expire (the in-memory index's default). */
const RETAIN = 10_000;
/** pi-durable's own rule for a table prefix; checked here too, because the prefix is written into SQL text. */
const PREFIX = /^(?!sqlite_)[A-Za-z_][A-Za-z0-9_]*$/;

type Batches = readonly (readonly StorageWrite[])[];
type Receive = (index: number, seq: Seq) => void;

export type IndexedStoreOptions = {
	/** Put in front of every table name, pi-durable's and the index's, so one database holds several stores. Default none. */
	readonly prefix?: string;
};

/** One open store. */
export type IndexedStore = {
	readonly changes: ChangeIndex;
	/**
	 * The store as one writer sees it. `check` runs before a commit or a new ID, and again inside the commit's transaction
	 * before anything is written; when it throws, nothing is. Reads always go through, and closing it closes nothing.
	 */
	writer(check: () => void): Storage;
	close(): Promise<void>;
};

const one = async <T extends object>(x: SqliteExecutor, sql: string, ...p: SqliteValue[]): Promise<T> => {
	const row = await x.get<T>(sql, ...p);
	if (row === undefined) throw new Error(`indexed store: row missing: ${sql}`);
	return row;
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const OUT_OF_STEP = "indexed store: a commit transaction and its writes are out of step";

/** Opens the store in `raw`, creating its tables and its identity on first open. Closing the store closes `raw`. */
export async function openIndexedStore(raw: SqliteDatabase, options: IndexedStoreOptions = {}): Promise<IndexedStore> {
	const p = options.prefix ?? "";
	if (p !== "" && !PREFIX.test(p)) throw new Error("indexed store: a prefix is letters, digits and underscores, and does not start with sqlite_");
	const t = { store: `${p}host_store`, commits: `${p}host_commits`, submissions: `${p}host_submissions`, metadata: `${p}durable_metadata` };
	const metadataUpdate = new RegExp(`^\\s*UPDATE\\s+${t.metadata}\\b`, "i");
	const headOf = async (x: SqliteExecutor) => Number((await one<{ n: number }>(x, `SELECT next_seq AS n FROM ${t.metadata} WHERE singleton = 1`)).n) - 1;

	let storeId: string;
	try {
		storeId = await raw.transaction(async (tx) => {
			await tx.exec(`
CREATE TABLE IF NOT EXISTS ${t.store} (id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT NOT NULL, floor INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS ${t.commits} (seq INTEGER PRIMARY KEY, digest TEXT NOT NULL, changes TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS ${t.submissions} (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL) STRICT;
`);
			// Drawn at the first open and never changed: a dropped and recreated store gets another, so old cursors expire.
			await tx.run(`INSERT OR IGNORE INTO ${t.store} (id, store_id, floor) VALUES (1, ?, 0)`, crypto.randomUUID());
			return (await one<{ s: string }>(tx, `SELECT store_id AS s FROM ${t.store} WHERE id = 1`)).s;
		});
	} catch (error) {
		await raw.close().catch(() => {});
		throw error;
	}

	/** `tx`, noting in `seen` whether the callback advanced the store's sequence, which only SqliteStorage.commit does. */
	const watched = (tx: SqliteExecutor, seen: { commits: boolean }): SqliteExecutor => {
		const note = (s: string) => {
			if (metadataUpdate.test(s)) seen.commits = true;
		};
		return {
			exec: (s) => tx.exec(s),
			get: <R extends object>(s: string, ...v: SqliteValue[]) => tx.get<R>(s, ...v),
			all: <R extends object>(s: string, ...v: SqliteValue[]) => tx.all<R>(s, ...v),
			run: (s, ...v) => (note(s), tx.run(s, ...v)),
			runCounted: (s, ...v) => (note(s), tx.runCounted(s, ...v)),
		};
	};

	/** One commit's index row, with a digest drawn for it, so a cursor from a history that lost this commit expires. */
	const record = async (tx: SqliteExecutor, seq: number, batch: readonly StorageWrite[]) => {
		const changes = batch.map(changeOf);
		await tx.run(`INSERT INTO ${t.commits} (seq, digest, changes) VALUES (?, ?, ?)`, seq, hex(crypto.getRandomValues(new Uint8Array(16))), JSON.stringify(changes));
		for (const c of changes) if (c.kind === "submission") await tx.run(`INSERT OR IGNORE INTO ${t.submissions} (id, seq) VALUES (?, ?)`, c.id, seq);
	};

	/** Keeps RETAIN commits above the floor, and the floor's own row, whose digest a cursor at the floor is checked against. */
	const prune = async (tx: SqliteExecutor, head: number) => {
		const floor = head - RETAIN;
		if (floor <= (await one<{ f: number }>(tx, `SELECT floor AS f FROM ${t.store} WHERE id = 1`)).f) return;
		await tx.run(`DELETE FROM ${t.commits} WHERE seq < ?`, floor);
		await tx.run(`DELETE FROM ${t.submissions} WHERE seq <= ?`, floor);
		await tx.run(`UPDATE ${t.store} SET floor = ? WHERE id = 1`, floor);
	};

	/** Set around the call into SqliteStorage.commit, which opens its transaction synchronously in that call. */
	let pending: { readonly batches: Batches; readonly check: () => void } | undefined;
	const db: SqliteDatabase = {
		exec: (s) => raw.exec(s),
		run: (s, ...v) => raw.run(s, ...v),
		runCounted: (s, ...v) => raw.runCounted(s, ...v),
		get: <R extends object>(s: string, ...v: SqliteValue[]) => raw.get<R>(s, ...v),
		all: <R extends object>(s: string, ...v: SqliteValue[]) => raw.all<R>(s, ...v),
		close: () => raw.close(),
		transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
			const mine = pending;
			pending = undefined;
			return raw.transaction(async (tx) => {
				// The database runs one transaction at a time, so the check and the commit are one step (K1-I2).
				mine?.check();
				const first = mine === undefined ? 0 : (await headOf(tx)) + 1;
				const seen = { commits: false };
				const result = await callback(watched(tx, seen));
				if (mine === undefined) {
					if (seen.commits) throw new Error(OUT_OF_STEP);
					return result;
				}
				// pi-durable 1.5.0 stores a group of batches in one transaction, one seq each from the head on; a refused batch
				// ends the group. The stored ones are the first (next_seq moved) of them.
				const stored = (await headOf(tx)) + 1 - first;
				if (stored < 0 || stored > mine.batches.length || seen.commits !== stored > 0) throw new Error(OUT_OF_STEP);
				for (let i = 0; i < stored; i++) await record(tx, first + i, mine.batches[i]!);
				if (stored > 0) await prune(tx, first + stored - 1);
				return result;
			});
		},
	};

	const storage = await SqliteStorage.open(db, p === "" ? {} : { prefix: p }).catch(async (error: unknown) => {
		await raw.close().catch(() => {});
		throw error;
	});
	const listeners = new Set<() => void>();

	const digestAt = async (x: SqliteExecutor, seq: number) => (seq === 0 ? `${storeId}:0` : (await x.get<{ d: string }>(`SELECT digest AS d FROM ${t.commits} WHERE seq = ?`, seq))?.d);
	const at = async (x: SqliteExecutor, seq: number): Promise<SessionPosition> => ({ seq, digest: (await digestAt(x, seq)) ?? "" });
	const bounds = async (x: SqliteExecutor) => ({
		floor: (await one<{ f: number }>(x, `SELECT floor AS f FROM ${t.store} WHERE id = 1`)).f,
		head: (await one<{ h: number | null }>(x, `SELECT max(seq) AS h FROM ${t.commits}`)).h ?? 0,
	});

	/** A read in one transaction slot of its own, so it never sees part of a commit. */
	const whole = <T>(read: (x: SqliteExecutor) => Promise<T>): Promise<T> => raw.transaction(read);

	const changes: ChangeIndex = {
		store: storeId,
		head: () => whole(async (x) => at(x, (await bounds(x)).head)),
		read: (after, limit) =>
			whole(async (x) => {
				const { floor, head } = await bounds(x);
				if (after.seq < floor || after.seq > head || (await digestAt(x, after.seq)) !== after.digest) return { expired: true, oldest: await at(x, floor), head: await at(x, head) };
				const rows = await x.all<{ seq: number; digest: string; changes: string }>(`SELECT seq, digest, changes FROM ${t.commits} WHERE seq > ? ORDER BY seq LIMIT ?`, after.seq, Math.max(1, limit));
				const commits: ChangeCommit[] = rows.map((r) => ({ position: { seq: r.seq, digest: r.digest }, changes: JSON.parse(r.changes) as Change[] }));
				return { commits, head: await at(x, head) };
			}),
		before: (submission) =>
			whole(async (x) => {
				const seq = (await x.get<{ s: number }>(`SELECT seq AS s FROM ${t.submissions} WHERE id = ?`, submission))?.s;
				return seq === undefined || seq <= (await bounds(x)).floor ? undefined : at(x, seq - 1);
			}),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	async function commit(batches: Batches, receive: Receive, context: Context, check: () => void): Promise<CommitResult> {
		pending = { batches, check };
		let result: Promise<CommitResult>;
		try {
			result = storage.commit(batches, receive, context);
		} finally {
			pending = undefined;
		}
		const done = await result;
		for (const listener of [...listeners]) listener();
		return done;
	}

	return {
		changes,
		writer(check) {
			return new Proxy(storage, {
				get(target, key) {
					if (key === "commit")
						return async (batches: Batches, receive: Receive, context: Context) => {
							check();
							return commit(batches, receive, context, check);
						};
					if (key === "mintId")
						return async () => {
							check();
							return target.mintId();
						};
					if (key === "close") return async () => {};
					const value = Reflect.get(target, key, target) as unknown;
					return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
				},
			});
		},
		close: () => storage.close(BACKGROUND_CONTEXT),
	};
}
