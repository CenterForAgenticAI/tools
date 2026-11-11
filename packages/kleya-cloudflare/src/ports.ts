// The host ports over one Durable Object (plan step 5). Internal to kleya-cloudflare: the object (./object.ts) and the
// rv1 test Worker build on it. Owner: an epoch per session id in this instance's memory, which dies with the instance.
// Storage: the shared durable change index (kleya-server/feed `openIndexedStore`) over the object's SQLite, under a table
// prefix per session. Alarm: a row per session, and the object's one platform alarm at the earliest. No `cloudflare:`
// import and no pragma: the object's SQLite is the platform's.
import { StorageRequestError, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { HarnessId } from "@centerforagenticai/kleya-client/protocol";
import { openIndexedStore, type IndexedStore } from "@centerforagenticai/kleya-server/feed";
import { RECOVERY_DELAY_MS, sessionName, type HostPorts, type Scope } from "@centerforagenticai/kleya-server/host";

/** What the host needs of a Durable Object's state: `ctx` in a Durable Object class. */
export type ObjectState = {
	readonly id: { readonly name?: string };
	readonly storage: DurableObjectSqliteStorage & {
		setAlarm(scheduledTime: number): Promise<void>;
		deleteAlarm(): Promise<void>;
		/** Resolves once earlier writes are durable. */
		sync(): Promise<void>;
	};
	/** Resets the object: the next request constructs a new instance. */
	abort(reason?: string): void;
};

/** How the object learns what its sessions' storage did. */
export type StoreWatch = {
	/** A Storage call failed, which fails the session (pi-durable `SessionFailed`); a refused read does not. */
	failed(error: unknown): void;
	/** A commit stored an answered input: a turn ended with an answer. */
	answered(): void;
};

export type ObjectPorts = HostPorts & {
	readonly alarm: NonNullable<HostPorts["alarm"]>;
	/** For the object's alarm handler: wakes every session with an alarm row, and sets the platform alarm again. */
	fire(wake: (scope: Scope) => Promise<void>): Promise<void>;
	/** Closes the stores this instance opened. */
	close(): Promise<void>;
};

/** A write under a stale fence: a later host in this instance took the session over (K1-I2). */
class Fenced extends Error {
	constructor() {
		super("the session's writer was fenced by a newer owner");
		this.name = "Fenced";
	}
}

/** After a wake that failed, the alarm comes again this much later. */
const RETRY_MS = 1_000;
const NONE: StoreWatch = { failed() {}, answered() {} };

const answered = (batches: readonly (readonly StorageWrite[])[]) =>
	batches.some((batch) => batch.some((w) => w.type === "submission" && w.value.type === "input" && w.value.status === "done" && w.value.answer !== undefined));

/** Tables of one session's store: `k`, 16 hex digits of its `sessionName`, `_`. The prefix names no scope value. */
const prefixOf = async (id: HarnessId) => `k${(await sessionName(id, "store")).slice(0, 16)}_`;

export function objectPorts(state: ObjectState, watch: StoreWatch = NONE, now: () => number = Date.now): ObjectPorts {
	// One queue for every statement on this storage, the stores' included (chord keeps one per storage object).
	const db = new DurableObjectSqliteDatabase(state.storage);
	// Epochs only rise. One entry per session id this instance opened: a production object opens only its own session, so
	// one; the map grows only in a test that opens many sessions in one object, and dies with the instance.
	const epochs = new Map<HarnessId, number>();
	const stores = new Map<HarnessId, Promise<IndexedStore>>();

	let alarmTable: Promise<void> | undefined;
	const alarms = () =>
		(alarmTable ??= db.exec("CREATE TABLE IF NOT EXISTS kleya_alarm (id TEXT PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL) STRICT").catch((error: unknown) => {
			alarmTable = undefined;
			throw error;
		}));
	const rearm = async () => {
		const row = await db.get<{ at: number | null }>("SELECT min(at) AS at FROM kleya_alarm");
		if (row?.at === null || row?.at === undefined) await state.storage.deleteAlarm();
		else await state.storage.setAlarm(row.at);
	};

	/** `storage` with each failed call told to `watch`, and each commit that answers a turn. */
	const watched = (storage: Storage): Storage =>
		new Proxy(storage, {
			get(target, key) {
				const value = Reflect.get(target, key, target) as unknown;
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const out = (value as (...a: unknown[]) => unknown).apply(target, args);
					if (!(out instanceof Promise)) return out;
					return out.then(
						(result: unknown) => {
							if (key === "commit" && answered(args[0] as readonly (readonly StorageWrite[])[])) watch.answered();
							return result;
						},
						(error: unknown) => {
							// As pi-durable: a refused read, or a read its caller aborted, fails only that read.
							const aborted = args.some((a) => (a as { abortSignal?: AbortSignal } | null)?.abortSignal?.aborted === true);
							if (!(error instanceof Fenced) && !(error instanceof StorageRequestError) && !aborted) watch.failed(error);
							throw error;
						},
					);
				};
			},
		});

	return {
		owner: {
			async acquire(id) {
				const epoch = (epochs.get(id) ?? 0) + 1;
				epochs.set(id, epoch);
				return { epoch };
			},
			async release() {},
		},
		storage: {
			async open(id, fence) {
				let store = stores.get(id);
				if (store === undefined) {
					store = prefixOf(id).then((prefix) => openIndexedStore(db, { prefix }));
					stores.set(id, store);
					store.catch(() => stores.delete(id));
				}
				// One store, and so one change index, per session for the instance's life; a stale fence still reads.
				const opened = await store;
				const writer = opened.writer(() => {
					if (epochs.get(id) !== fence.epoch) throw new Fenced();
				});
				return { storage: watched(writer), changes: opened.changes };
			},
			async drop(id) {
				const store = stores.get(id);
				stores.delete(id);
				await store?.then(
					(s) => s.close(),
					() => {},
				);
				const prefix = await prefixOf(id);
				await db.transaction(async (tx) => {
					const tables = await tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?) = ?", prefix.length, prefix);
					for (const { name } of tables) await tx.exec(`DROP TABLE "${name}"`);
				});
			},
		},
		alarm: {
			async set(id, scope, at) {
				await alarms();
				if (at === undefined) await db.run("DELETE FROM kleya_alarm WHERE id = ?", id);
				else await db.run("INSERT INTO kleya_alarm (id, scope, at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET scope = excluded.scope, at = excluded.at", id, JSON.stringify(scope), at);
				await rearm();
			},
		},
		async fire(wake) {
			await alarms();
			// Every row, due or not: the platform fires at the earliest, and a production object has one row.
			const rows = await db.all<{ id: string; scope: string }>("SELECT id, scope FROM kleya_alarm");
			for (const row of rows) {
				// Woken, the session runs its own sleeps while it is open, and the host sets its alarm again. Until it does, the
				// row is due again after the recovery delay, as a running turn's would be.
				await db.run("UPDATE kleya_alarm SET at = ? WHERE id = ?", now() + RECOVERY_DELAY_MS, row.id);
				try {
					await wake(JSON.parse(row.scope) as Scope);
				} catch {
					await db.run("UPDATE kleya_alarm SET at = ? WHERE id = ?", now() + RETRY_MS, row.id);
				}
			}
			await rearm();
		},
		async close() {
			const open = [...stores.values()];
			stores.clear();
			for (const store of open) await store.then((s) => s.close(), () => {});
		},
	};
}
