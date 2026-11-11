// @centerforagenticai/kleya-server/feed: the change index (spec 5.2 "Two cursors"). Session follow reads it, and a
// SessionCursor names one of its commits. Platform-free (MIN-11). indexChanges keeps it in memory, for stores that live
// in memory; openIndexedStore writes it in each commit's SQLite transaction, for the Node and Cloudflare hosts.
import type { Context } from "@earendil-works/chord/context";
import type { Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { SessionPosition } from "@centerforagenticai/kleya-client/protocol";
import { changeOf } from "./feed/change.ts";

export { openIndexedStore, type IndexedStore, type IndexedStoreOptions } from "./feed/store.ts";

/** One stored write as the change index records it. Submissions carry what session follow lists. */
export type Change = {
	kind: "conversation" | "entry" | "task" | "submission" | "document";
	id: number;
	op: string;
	conversation?: number;
	requestId?: string;
	/** A submission's type: inputs and continues are turns, writes are not. */
	type?: "input" | "write" | "continue";
};
export type ChangeCommit = { position: SessionPosition; changes: Change[] };
/** Commits after a position, oldest first; `expired` when the position is below the floor, past the head, or from another store. */
export type ChangeRead = { commits: ChangeCommit[]; head: SessionPosition } | { expired: true; oldest: SessionPosition; head: SessionPosition };

/** The store's change index: one row set per stored commit, written in the commit's own transaction. */
export interface ChangeIndex {
	/** Names this store; a dropped and recreated store gets a new name, so cursors into the old one expire. */
	readonly store: string;
	head(context: Context): Promise<SessionPosition>;
	read(after: SessionPosition, limit: number, context: Context): Promise<ChangeRead>;
	/** The position just before the commit that first stored a submission, so a read after it lists that commit; undefined once that commit is below the floor. */
	before(submission: number, context: Context): Promise<SessionPosition | undefined>;
	/** Called after each stored commit; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

export type IndexOptions = {
	/** Commits kept; older ones fall below the floor and their cursors expire. Default 10,000. */
	readonly retain?: number;
	/** Names this store in every digest, so a cursor from a dropped and recreated store expires. Default random. */
	readonly nonce?: string;
};

/**
 * An in-memory change index over a Storage, for stores that live in memory (the testing adapter). The returned
 * Storage records each batch in `receive`, which runs inside the commit before the next one starts, and forwards every
 * other method, `publishing` included (K1-I2). A durable store writes the same rows in its own commit transaction.
 */
export function indexChanges(storage: Storage, options: IndexOptions = {}): { storage: Storage; changes: ChangeIndex } {
	const retain = options.retain ?? 10_000;
	const nonce = options.nonce ?? crypto.randomUUID();
	const at = (seq: number): SessionPosition => ({ seq, digest: `${nonce}:${seq}` });
	const commits: ChangeCommit[] = [];
	const firstSeen = new Map<number, number>();
	const listeners = new Set<() => void>();
	let head = 0;
	let floor = 0;

	const record = (batch: readonly StorageWrite[], seq: Seq) => {
		const changes = batch.map(changeOf);
		for (const c of changes) if (c.kind === "submission" && !firstSeen.has(c.id)) firstSeen.set(c.id, seq);
		commits.push({ position: at(seq), changes });
		head = seq;
		while (commits.length > retain) {
			const dropped = commits.shift()!;
			floor = dropped.position.seq;
			for (const c of dropped.changes) if (c.kind === "submission" && firstSeen.get(c.id) === floor) firstSeen.delete(c.id);
		}
	};
	const indexed = new Proxy(storage, {
		get(target, key) {
			if (key === "commit") {
				return async (batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context) => {
					const result = await target.commit(batches, (index, seq) => {
						record(batches[index]!, seq);
						receive(index, seq);
					}, context);
					for (const listener of [...listeners]) listener();
					return result;
				};
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	const changes: ChangeIndex = {
		store: nonce,
		head: async () => at(head),
		async read(after, limit) {
			if (after.seq < floor || after.seq > head || after.digest !== at(after.seq).digest) return { expired: true, oldest: at(floor), head: at(head) };
			let lo = 0;
			while (lo < commits.length && commits[lo]!.position.seq <= after.seq) lo++;
			return { commits: commits.slice(lo, lo + Math.max(1, limit)), head: at(head) };
		},
		before: async (submission) => {
			const seq = firstSeen.get(submission);
			return seq === undefined ? undefined : at(seq - 1);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { storage: indexed, changes };
}
