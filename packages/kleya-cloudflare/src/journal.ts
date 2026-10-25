// The journal decorator (contract C.2 v1.2) over pi-durable's SqliteDatabase facade, for one Durable Object: a writer
// fence, a payload-free change index written inside each commit transaction, cursor reads with a stored retention floor,
// a per-commit power-loss request (which a Durable Object refuses with SQLITE_AUTH), and a chained commit digest.
// Ported from research/kernel/src/journal.ts as research/kernel-workerd Experiment 7 ran it. Dropped from the port: the
// separate read connection (`feed`) and the Reader, which need a second connection a Durable Object does not have; a
// page therefore runs as one slot of the object's operation queue. Internal to this package: not exported (MIN-04).
import { type Context, createContextKey, withContextValue } from "@earendil-works/chord/context";
import type { Seq as PiSeq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { type SqliteDatabase, type SqliteExecutor, SqliteStorage, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

/** Position in one store's commit order. Increases with each successful commit; may have gaps. */
export type Seq = number;

declare const STORE_ID: unique symbol;
/**
 * A journal store's identity: a random id that openJournal writes once into the store's host_store table and reads back
 * at every open. Pi's ids (seqs, task ids) are unique only within one store; this names the store. Only openJournal makes one.
 */
export type StoreId = string & { readonly [STORE_ID]: true };

/** What one commit changed in one record. No payload. */
export interface Change {
	readonly seq: Seq;
	readonly kind: "conversation" | "entry" | "task" | "submission" | "document";
	readonly id: string;
	/** insert, a task or submission status, create, copy, base, delta, retire */
	readonly op: string;
}

/**
 * A consumer's position: a seq and the commit digest at it, so a position reused by another history is not mistaken
 * for this one (after a power cut, Pi takes the same seqs again). At seq 0 there is no commit and digest is null.
 */
export interface Cursor {
	readonly seq: Seq;
	readonly digest: string | null;
}

/** head: the highest committed position in the read transaction that served the page. */
type Served = { readonly changes: readonly Change[]; readonly next: Seq; readonly head: Seq };

/**
 * A page of changes after `After`, or expired. Only a page read from a Cursor, which was checked, carries `digest`: the
 * commit digest at next (null when there is no commit at next), so { seq: next, digest } is the cursor to store. A page
 * read from a bare Seq carries none, so an unchecked seq, perhaps from another history, cannot become a valid Cursor.
 */
export type ChangePage<After extends Seq | Cursor = Cursor> =
	| (After extends Cursor ? Served & { readonly digest: string | null } : Served)
	| { readonly expired: true; readonly oldest: Seq; readonly head: Seq };

export interface CommitOptions {
	/** "power": resolve only when this commit, and every commit before it, survives a power loss. Default "store". */
	readonly durability?: "store" | "power";
}

export interface Journal {
	/** pi-durable's commit plus an optional durability request. Fails with FencedError, writing nothing, once a newer epoch exists. */
	commit(writes: readonly StorageWrite[], context: Context, options?: CommitOptions): Promise<Seq>;
	/**
	 * Changes with seq > after in seq order, in whole commits: `limit` counts commits. Never skips a retained change. A
	 * Cursor is also checked: expired unless this store has a commit at its seq with its digest. A bare Seq is not, and
	 * its page has no digest.
	 */
	changes<After extends Seq | Cursor>(after: After, limit: number, context: Context): Promise<ChangePage<After>>;
}

/** Held by the store's owner only. */
export interface JournalOwner extends Journal {
	/** Drop index rows with seq <= through, and digests below it, and raise the floor to through (at most the head). Fenced. The floor never moves down. */
	prune(through: Seq, context: Context): Promise<{ readonly floor: Seq; readonly deleted: number }>;
}

/** A commit or prune by a writer whose epoch was superseded. */
export class FencedError extends Error {
	name = "FencedError";
}

const DURABILITY = createContextKey<"store" | "power">("kleya.journal.durability");

/** A context under which every Storage.commit asks for `durability`; for rt.commit and rt.memo, which take no options. */
export function withDurability(context: Context, durability: "store" | "power"): Context {
	return withContextValue(DURABILITY, durability, context);
}

/** The durability a context asks for: "store" unless withDurability set it. */
export function durabilityOf(context: Context): "store" | "power" {
	return context.value(DURABILITY) ?? "store";
}

const FULL = "PRAGMA synchronous = FULL";
const NORMAL = "PRAGMA synchronous = NORMAL";
const METADATA_UPDATE = /^\s*UPDATE\s+durable_metadata\b/i;
const HOST_DDL = `
CREATE TABLE IF NOT EXISTS host_fence (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL) STRICT;
INSERT OR IGNORE INTO host_fence (id, epoch) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS host_changes (
  seq INTEGER NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT NOT NULL,
  PRIMARY KEY (seq, record_type, record_id)) STRICT;
CREATE TABLE IF NOT EXISTS host_commits (seq INTEGER PRIMARY KEY, digest TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS host_retention (id INTEGER PRIMARY KEY CHECK (id = 1), pruned_through INTEGER NOT NULL) STRICT;
INSERT OR IGNORE INTO host_retention (id, pruned_through) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS host_store (id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT NOT NULL) STRICT;
`;

/** Record kind, record ID and operation label of one StorageWrite (rule 4). No payload is copied. */
function changeOf(w: StorageWrite): [Change["kind"], string, string] {
	switch (w.type) {
		case "conversation":
		case "entry":
			return [w.type, String(w.value.id), "insert"];
		case "task":
			return ["task", String(w.value.id), w.value.state.status];
		case "submission":
			return ["submission", String(w.value.id), w.value.status];
		case "document.create":
		case "document.copy":
			return ["document", String(w.record.id), w.type.slice(9)];
		case "document.change":
			return ["document", String(w.id), w.content.kind];
		case "document.retire":
			return ["document", String(w.id), "retire"];
	}
}

const one = async <T extends object>(x: SqliteExecutor, sql: string, ...p: SqliteValue[]): Promise<T> => {
	const row = await x.get<T>(sql, ...p);
	if (row === undefined) throw new Error(`journal metadata row missing: ${sql}`);
	return row;
};
const headOf = async (x: SqliteExecutor): Promise<Seq> =>
	Number((await one<{ n: number }>(x, "SELECT next_seq AS n FROM durable_metadata WHERE singleton = 1")).n) - 1;
const floorOf = async (x: SqliteExecutor): Promise<Seq> =>
	(await one<{ p: number }>(x, "SELECT pruned_through AS p FROM host_retention WHERE id = 1")).p;
/** The commit digest at `seq`; null when the store has no commit there (always at 0). */
const digestAt = async (x: SqliteExecutor, seq: Seq): Promise<string | null> =>
	(await x.get<{ d: string }>("SELECT digest AS d FROM host_commits WHERE seq = ?", seq))?.d ?? null;

/**
 * The commit digest, written inside the commit transaction: sha256 of the previous commit's digest, 16 random bytes
 * drawn for this commit, and this commit's index rows. The random bytes make it differ between two histories that
 * share a position even when their rows are equal. The chain makes a match at a seq vouch for every commit before it (I,
 * not tested: no check recomputes the chain, and under SQLite's loss of a suffix of commits the nonce alone already
 * tells the histories apart; see notes/journal.md, "The commit digest").
 */
async function sealCommit(tx: SqliteExecutor, seq: Seq): Promise<void> {
	const prev = (await tx.get<{ d: string }>("SELECT digest AS d FROM host_commits WHERE seq < ? ORDER BY seq DESC LIMIT 1", seq))?.d ?? null;
	const rows = (await tx.all<Change>("SELECT record_type AS kind, record_id AS id, op FROM host_changes WHERE seq = ? ORDER BY record_type, record_id", seq)).map((r) => [r.kind, r.id, r.op]);
	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
	const text = JSON.stringify([prev, nonce, rows]);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	await tx.run("INSERT INTO host_commits (seq, digest) VALUES (?, ?)", seq, Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(""));
}

/** Rule 5: floor, head, the cursor's digest and a page of whole commits, all read through `x` (callers run it in one read transaction). */
async function pageOf<After extends Seq | Cursor>(x: SqliteExecutor, after: After, limit: number): Promise<ChangePage<After>> {
	return (await pageAny(x, after, limit)) as ChangePage<After>;
}

async function pageAny(x: SqliteExecutor, after: Seq | Cursor, limit: number): Promise<ChangePage<Seq> | ChangePage<Cursor>> {
	const from = typeof after === "number" ? after : after.seq;
	const checked = typeof after !== "number";
	if (!Number.isInteger(from) || from < 0) throw new RangeError(`bad cursor ${from}`);
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`bad limit ${limit}`);
	const floor = await floorOf(x);
	const head = await headOf(x);
	if (from < floor) return { expired: true, oldest: floor + 1, head };
	if (checked) {
		// A cursor from another history: no commit at its seq (above the head after a power cut) or another commit there.
		if (from > head || (await digestAt(x, from)) !== after.digest) return { expired: true, oldest: floor + 1, head };
	}
	const { hi } = await one<{ hi: number | null }>(x, "SELECT max(seq) AS hi FROM (SELECT DISTINCT seq FROM host_changes WHERE seq > ? ORDER BY seq LIMIT ?)", from, limit);
	const next = hi ?? from;
	const changes = hi === null ? [] : (await x.all<Change>("SELECT seq, record_type AS kind, record_id AS id, op FROM host_changes WHERE seq > ? AND seq <= ? ORDER BY seq, record_type, record_id", from, hi)).map((r) => ({ seq: r.seq, kind: r.kind, id: r.id, op: r.op }));
	// The digest at next vouches for next only because the cursor's own commit was checked above.
	return checked ? { changes, next, head, digest: await digestAt(x, next) } : { changes, next, head };
}

/** The writer's facade: checks the epoch in every transaction and writes the index rows inside the commit transaction. */
class FencedDb implements SqliteDatabase {
	readonly #inner: SqliteDatabase;
	readonly #epoch: number;
	/** Set around the call into SqliteStorage.commit, which opens its transaction synchronously in that call. */
	pending: readonly StorageWrite[] | undefined;
	constructor(inner: SqliteDatabase, epoch: number) {
		this.#inner = inner;
		this.#epoch = epoch;
	}
	exec(sql: string) { return this.#inner.exec(sql); }
	run(sql: string, ...p: SqliteValue[]) { return this.#inner.run(sql, ...p); }
	get<T extends object>(sql: string, ...p: SqliteValue[]) { return this.#inner.get<T>(sql, ...p); }
	all<T extends object>(sql: string, ...p: SqliteValue[]) { return this.#inner.all<T>(sql, ...p); }
	close() { return this.#inner.close(); }
	transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		const writes = this.pending;
		this.pending = undefined;
		return this.#inner.transaction(async (tx) => {
			// BEGIN IMMEDIATE already holds SQLite's write lock, so this check and the commit are one atomic step (rule 3).
			const { epoch } = await one<{ epoch: number }>(tx, "SELECT epoch FROM host_fence WHERE id = 1");
			if (epoch !== this.#epoch) throw new FencedError(`writer epoch ${this.#epoch} was superseded by ${epoch}`);
			let commits = false;
			const result = await callback({
				exec: (s) => tx.exec(s),
				get: <R extends object>(s: string, ...p: SqliteValue[]) => tx.get<R>(s, ...p),
				all: <R extends object>(s: string, ...p: SqliteValue[]) => tx.all<R>(s, ...p),
				run: (s, ...p) => {
					if (METADATA_UPDATE.test(s)) commits = true; // only SqliteStorage.commit() advances the sequence
					return tx.run(s, ...p);
				},
			});
			if (commits !== (writes !== undefined)) throw new Error("journal: a commit transaction and its writes are out of step");
			for (const w of writes ?? []) {
				const [kind, id, op] = changeOf(w);
				await tx.run("INSERT OR REPLACE INTO host_changes (seq, record_type, record_id, op) VALUES (?, ?, ?, ?)", Number(result), kind, id, op);
			}
			if (writes !== undefined) await sealCommit(tx, Number(result));
			return result;
		});
	}
}

export interface JournalOptions {
	/** What a resolved commit survives by default: "crash" (Pi's synchronous = NORMAL, the default) or "power" (FULL). */
	readonly durability?: "crash" | "power";
}

/**
 * Open the store in `raw` under a new epoch, taken before SqliteStorage.open reads its ID floor. openJournal owns `raw`
 * from this call: it closes it if the open fails, and storage.close() closes it. `storage` is Pi's storage with commit()
 * routed through `journal`; give it to a Session or Harness. `storeId` is the store's identity (StoreId), the same at
 * every open of the store. A power request where the platform refuses PRAGMA synchronous fails and writes nothing.
 */
export async function openJournal(raw: SqliteDatabase, options: JournalOptions = {}): Promise<{ readonly storage: Storage; readonly journal: JournalOwner; readonly epoch: number; readonly storeId: StoreId }> {
	const storePower = options.durability === "power";
	let epoch: number;
	let storeId: StoreId;
	try {
		if (storePower) await raw.exec(FULL);
		({ epoch, storeId } = await raw.transaction(async (tx) => {
			await tx.exec(HOST_DDL);
			// The store's identity is drawn at its first open and never changes; every later open reads the same row.
			await tx.run("INSERT OR IGNORE INTO host_store (id, store_id) VALUES (1, ?)", crypto.randomUUID());
			await tx.run("UPDATE host_fence SET epoch = epoch + 1 WHERE id = 1");
			const { epoch } = await one<{ epoch: number }>(tx, "SELECT epoch FROM host_fence WHERE id = 1");
			const { id } = await one<{ id: string }>(tx, "SELECT store_id AS id FROM host_store WHERE id = 1");
			return { epoch, storeId: id as StoreId };
		}));
	} catch (error) {
		await raw.close().catch(() => {});
		throw error;
	}
	const db = new FencedDb(raw, epoch);
	const storage = await SqliteStorage.open(db);
	const piCommit = storage.commit.bind(storage);
	const commitOnce = (writes: readonly StorageWrite[], context: Context): Promise<PiSeq> => {
		db.pending = writes;
		try {
			return piCommit(writes, context);
		} finally {
			db.pending = undefined;
		}
	};
	// Rule 7. synchronous is per connection and cannot change inside a transaction. While any power commit is in flight
	// the connection stays FULL; the facade runs exec and transactions in call order, so each power commit's transaction
	// runs after the FULL it awaited and before the NORMAL that the last one queues. A FULL commit fsyncs the WAL, which
	// makes every earlier frame durable too.
	let raised = 0;
	let full = Promise.resolve();
	const commit = async (writes: readonly StorageWrite[], context: Context, opts?: CommitOptions): Promise<PiSeq> => {
		const wantsPower = opts?.durability === "power" || durabilityOf(context) === "power";
		if (!wantsPower || storePower) return commitOnce(writes, context);
		if (raised++ === 0) full = raw.exec(FULL);
		try {
			await full;
			return await commitOnce(writes, context);
		} finally {
			if (--raised === 0) await raw.exec(NORMAL);
		}
	};
	storage.commit = (writes, context) => commit(writes, context);
	const journal: JournalOwner = {
		commit,
		// Never through the fence, so a page never takes the writer epoch (C.6 step 4). The page holds one slot of raw's
		// queue, so no commit is in flight while it reads (rule 6 on one connection).
		changes: (after, limit) => raw.transaction((tx) => pageOf(tx, after, limit)),
		prune: (through) =>
			db.transaction(async (tx) => {
				const head = await headOf(tx);
				if (!Number.isInteger(through) || through < 0 || through > head) throw new RangeError(`prune through ${through} is outside 0..${head}`);
				const floor = Math.max(await floorOf(tx), through);
				const { c: deleted } = await one<{ c: number }>(tx, "SELECT count(*) AS c FROM host_changes WHERE seq <= ?", floor);
				await tx.run("DELETE FROM host_changes WHERE seq <= ?", floor);
				// The digest at the floor stays: a cursor at the floor is still served and checked, and the next commit chains from the newest digest.
				await tx.run("DELETE FROM host_commits WHERE seq < ?", floor);
				await tx.run("UPDATE host_retention SET pruned_through = ? WHERE id = 1", floor);
				return { floor, deleted };
			}),
	};
	return { storage, journal, epoch, storeId };
}
