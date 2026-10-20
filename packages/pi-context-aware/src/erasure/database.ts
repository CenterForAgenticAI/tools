/** Shared per-profile database for erasure, session discovery and future fold/backfill rows. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function sessionDatabaseFile(agentDir: string): string {
	return path.join(agentDir, "context-aware.sqlite");
}

export function validateSessionId(id: string): void {
	if (id === "." || id === ".." || !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) throw new Error("Invalid session id");
}

/** Errors other than ENOENT count as present: an unreadable path is never treated as never written. */
function exists(file: string): boolean {
	try { fs.lstatSync(file); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export class SessionErasedError extends Error {
	constructor() { super("Session was erased; it cannot be reopened or indexed"); }
}

export class SessionOpenError extends Error {
	constructor(id: string) { super(`Session ${id} is open`); }
}

export class SessionDatabase {
	private readonly db: DatabaseSync;
	constructor(agentDir: string) {
		fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		const file = sessionDatabaseFile(agentDir);
		// The profile root is trusted. SQLite's database and WAL must not be redirected.
		for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
			assertSafeDatabaseFile(candidate, true);
		}
		const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
		try { fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
		this.db = new DatabaseSync(file);
		this.db.exec(`
			PRAGMA busy_timeout=5000;
			PRAGMA secure_delete=ON;
			PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS erased_sessions (session_id TEXT PRIMARY KEY) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS session_sources (session_id TEXT PRIMARY KEY, path TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS session_source_state (session_id TEXT PRIMARY KEY, written INTEGER NOT NULL, reported INTEGER NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS open_sessions (session_id TEXT NOT NULL, pid INTEGER NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(session_id, pid, owner)) WITHOUT ROWID;
		`);
	}
	close(): void { this.db.close(); }
	erasedIds(): ReadonlySet<string> {
		return new Set(this.db.prepare("SELECT session_id FROM erased_sessions ORDER BY session_id").all().map((row) => String(row.session_id)));
	}
	isErased(id: string): boolean {
		return this.db.prepare("SELECT 1 FROM erased_sessions WHERE session_id = ?").get(id) !== undefined;
	}
	remember(id: string, file: string): void {
		validateSessionId(id);
		if (this.isErased(id)) return;
		// A source recorded before write history existed has no state row. Its history is
		// unknown, so it stays written (see sourceState) when it is recorded again.
		const unknownHistory = this.db.prepare(`SELECT 1 FROM session_sources WHERE session_id = ?
			AND NOT EXISTS (SELECT 1 FROM session_source_state WHERE session_id = ?)`).get(id, id) !== undefined;
		this.db.prepare("INSERT OR REPLACE INTO session_sources VALUES (?, ?)").run(id, file);
		// Pi writes a new transcript with the session's first user or assistant message,
		// and the extension records that message just before the write (markWritten).
		// Until then, a missing file means "never written", not "moved or unmounted".
		this.db.prepare(`INSERT INTO session_source_state VALUES (?, ?, 0) ON CONFLICT(session_id) DO UPDATE SET
			written = MAX(written, excluded.written), reported = CASE WHEN excluded.written = 1 THEN 0 ELSE reported END`).run(id, unknownHistory || exists(file) ? 1 : 0);
	}
	sources(): readonly { id: string; path: string }[] {
		return this.db.prepare("SELECT session_id, path FROM session_sources").all().map((row) => ({ id: String(row.session_id), path: String(row.path) }));
	}
	/**
	 * A source without a state row was recorded before this state existed, so whether
	 * it ever had a transcript is unknown. It reads as written: reported, never forgotten.
	 */
	sourceState(id: string): { written: boolean; reported: boolean } {
		const row = this.db.prepare("SELECT written, reported FROM session_source_state WHERE session_id = ?").get(id);
		if (!row) return { written: true, reported: false };
		return { written: Number(row.written) === 1, reported: Number(row.reported) === 1 };
	}
	/**
	 * Pi is about to persist the session's first user or assistant message, which writes
	 * its transcript. Recorded before that write, a crash afterwards cannot make the source
	 * look abandoned.
	 */
	markWritten(id: string): void {
		this.db.prepare(`INSERT INTO session_source_state SELECT session_id, 1, 0 FROM session_sources WHERE session_id = ?
			ON CONFLICT(session_id) DO UPDATE SET written = 1 WHERE written != 1`).run(id);
	}
	/** A transcript seen on disk makes its later absence a move or deletion. Seeing it again re-arms the one notice. */
	observeWritten(ids: readonly string[]): void {
		if (!ids.length) return;
		const observe = this.db.prepare(`INSERT INTO session_source_state SELECT session_id, 1, 0 FROM session_sources WHERE session_id = ?
			ON CONFLICT(session_id) DO UPDATE SET written = 1, reported = 0 WHERE written != 1 OR reported != 0`);
		this.transaction(() => { for (const id of ids) observe.run(id); });
	}
	/** Atomically take the one missing-source notice. False when another session already took it. A source without history stays written. */
	claimReport(id: string): boolean {
		const claimed = this.db.prepare(`INSERT INTO session_source_state SELECT session_id, 1, 1 FROM session_sources WHERE session_id = ?
			ON CONFLICT(session_id) DO UPDATE SET reported = 1 WHERE reported = 0`).run(id);
		return Number(claimed.changes) > 0;
	}
	/** Return an undelivered notice so a later session shows it. */
	releaseReport(id: string): void {
		this.db.prepare("UPDATE session_source_state SET reported = 0 WHERE session_id = ?").run(id);
	}
	/** Drop the discovery row of a source that never wrote a transcript, unless a live process holds it or it changed. */
	forgetUnwritten(id: string, file: string): boolean {
		return this.transaction(() => {
			if (this.isOpen(id) || this.sourceState(id).written || exists(file)) return false;
			if (this.db.prepare("SELECT 1 FROM session_sources WHERE session_id = ? AND path = ?").get(id, file) === undefined) return false;
			this.forget(id);
			return true;
		});
	}
	openSession(id: string, file: string | null, owner = "default"): void {
		validateSessionId(id);
		this.transaction(() => {
			if (this.isErased(id)) throw new SessionErasedError();
			if (file) this.remember(id, file);
			this.db.prepare("INSERT OR IGNORE INTO open_sessions VALUES (?, ?, ?)").run(id, process.pid, owner);
		});
	}
	closeSession(id: string, owner = "default"): void {
		this.db.prepare("DELETE FROM open_sessions WHERE session_id = ? AND pid = ? AND owner = ?").run(id, process.pid, owner);
	}
	isOpen(id: string): boolean {
		const pids = this.db.prepare("SELECT pid FROM open_sessions WHERE session_id = ?").all(id);
		for (const row of pids) {
			const pid = Number(row.pid);
			if (alive(pid)) return true;
			this.db.prepare("DELETE FROM open_sessions WHERE session_id = ? AND pid = ?").run(id, pid);
		}
		return false;
	}
	/** Ledger first, in one transaction. A partial filesystem failure must never permit re-import. */
	erase(ids: readonly string[]): void {
		this.transaction(() => {
			for (const id of ids) {
				validateSessionId(id);
				if (this.isOpen(id)) throw new SessionOpenError(id);
			}
			for (const id of ids) {
				this.db.prepare("INSERT OR IGNORE INTO erased_sessions VALUES (?)").run(id);
				this.forget(id);
			}
		});
	}
	/** An external removal drops derived discovery rows, not a tombstone. */
	forget(id: string): void {
		this.db.prepare("DELETE FROM session_sources WHERE session_id = ?").run(id);
		this.db.prepare("DELETE FROM open_sessions WHERE session_id = ?").run(id);
		this.db.prepare("DELETE FROM session_source_state WHERE session_id = ?").run(id);
	}
	checkpoint(): void {
		const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		if (!row || Number(row.busy) !== 0) throw new Error("SQLite WAL checkpoint is busy");
	}
	private transaction<T>(action: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = action(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
}

/** Names the file and the failed check, so a refused start can say what to fix without quoting other error text. */
export class UnsafeDatabaseFileError extends Error {
	readonly code = "UNSAFE_DATABASE_FILE";
	constructor(readonly file: string, readonly reason: string) {
		super(`Unsafe session database file ${file}: ${reason}`);
		this.name = "UnsafeDatabaseFileError";
	}
}

/** lstat is taken here so a caller cannot pass stat output and lose the symlink refusal. */
function assertSafeDatabaseFile(file: string, missingOk: boolean): void {
	let info: fs.Stats;
	try { info = fs.lstatSync(file); } catch (error) {
		if (missingOk && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const reason = info.isSymbolicLink() ? "is a symbolic link" : !info.isFile() ? "is not a regular file" : info.nlink !== 1 ? "has more than one hard link" : process.getuid && info.uid !== process.getuid() ? "is owned by another user" : undefined;
	if (reason) throw new UnsafeDatabaseFileError(file, reason);
}

/** No database is created by read-only retrieval or the shadow importer. Errors fail closed. */
export function erasedSessionIds(agentDir: string): ReadonlySet<string> {
	const file = sessionDatabaseFile(agentDir);
	// lstat, not existsSync: a dangling symlink must refuse, not read as "nothing erased".
	try { fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw error; }
	assertSafeDatabaseFile(file, false);
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return new Set(db.prepare("SELECT session_id FROM erased_sessions ORDER BY session_id").all().map((row) => String(row.session_id)));
	} finally { db.close(); }
}
