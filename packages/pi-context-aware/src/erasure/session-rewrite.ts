import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionDatabase, sessionDatabaseFile, validateSessionId } from "./database.js";
import { readStoreFileWithIdentity, withStoreDirectory, type StoreFileRead } from "./files.js";
import { endpointResolver, parseRangeSelector } from "./range-refs.js";
import { registryIsOpen } from "./session-erasure.js";
import { derivedEntryIds } from "./coverage.js";
import { alreadyErased, contentHash, erasableStrings, erasedMarker, isObject, structureOf, tombstoneEntry, type JsonObject } from "./tombstone.js";

/**
 * Offline tombstone rewrite of one closed session file.
 * Erased entries keep their id, parent link, role, type and tool-call ids; only message text,
 * tool-call arguments and tool output become `[erased <date>]`. No command is wired to this yet.
 */

export type RewriteSelector =
	| { readonly kind: "range"; readonly range: string }
	| { readonly kind: "match"; readonly text: string }
	/** Entry ids copied from another session (a fork of the one erased). Ids only, never text. */
	| { readonly kind: "entries"; readonly ids: readonly string[] };

export interface RewriteOptions {
	readonly agentDir: string;
	/** Absolute path of a `.jsonl` session file below `<agentDir>/sessions`. */
	readonly sessionFile: string;
	readonly selector: RewriteSelector;
	/** The session this process has open, if any. Refused even when the ledger has no lease for it. */
	readonly currentSessionId?: string;
	/** Keep a copy of the original beside the session. It holds the erased text; off unless asked. */
	readonly backup?: boolean;
	readonly now?: () => Date;
	/** Receives the text of every erased entry, in memory only, so derived stores can be cleaned of it. Never stored. */
	readonly collectErasedText?: (strings: readonly string[]) => void;
	/** Preview: run every check and plan the erasure, then return before anything is written. */
	readonly dryRun?: boolean;
	/** Test seam: runs after the replacement file is written and before it is renamed into place. */
	readonly beforeRename?: () => void;
}

export interface ErasedEntry { readonly entryId: string; readonly hash: string }

export type RewriteResult =
	| { readonly status: "erased"; readonly sessionId: string; readonly entries: readonly ErasedEntry[]; readonly unreached: readonly string[]; readonly backup?: string }
	| { readonly status: "nothing-to-erase"; readonly sessionId: string; readonly unreached: readonly string[] }
	| { readonly status: "refused" | "failed"; readonly reason: string };

class RewriteRefusal extends Error {}

interface Line { readonly raw: string; readonly entry?: JsonObject; readonly cr: boolean }

const fileName = (target: string) => path.basename(target);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Only a `.jsonl` file below the sessions directory, named without traversal. */
function confine(agentDir: string, sessionFile: string): string {
	if (!sessionFile || sessionFile.includes("\0") || sessionFile.split(/[\\/]/u).includes("..")) throw new RewriteRefusal("Session path must not contain traversal");
	const sessions = path.join(path.resolve(agentDir), "sessions");
	const target = path.resolve(sessionFile);
	const relative = path.relative(sessions, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new RewriteRefusal("Session file is outside the profile's sessions directory");
	if (!target.endsWith(".jsonl")) throw new RewriteRefusal("Not a session file");
	return target;
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One rewrite per session file. A live or unreadable lock refuses; a dead owner's lock is cleared once. */
function acquireLock(held: string, name: string): () => void {
	const lock = path.join(held, `.${name}.rewrite-lock`);
	const token = randomUUID();
	const create = (): boolean => {
		try {
			const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			return true;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
	};
	if (!create()) {
		let owner: { pid?: unknown } | undefined;
		try { owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: unknown }; } catch { /* unreadable: unsure */ }
		if (!owner || !Number.isInteger(owner.pid) || processAlive(owner.pid as number)) throw new RewriteRefusal("Another rewrite of this session is in progress");
		fs.unlinkSync(lock);
		if (!create()) throw new RewriteRefusal("Another rewrite of this session is in progress");
	}
	return () => {
		try {
			const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: unknown };
			if (owner.token === token) fs.unlinkSync(lock);
		} catch { /* already gone */ }
	};
}

function parseLines(text: string): Line[] {
	return text.split("\n").map((raw) => {
		const cr = raw.endsWith("\r");
		try {
			const parsed: unknown = JSON.parse(cr ? raw.slice(0, -1) : raw);
			return isObject(parsed) ? { raw, entry: parsed, cr } : { raw, cr };
		} catch { return { raw, cr }; }
	});
}

/** Refuse when the session might be live. Any doubt counts as live. */
function assertClosed(options: RewriteOptions, db: SessionDatabase | undefined, sessionId: string): void {
	let open: boolean;
	try { open = sessionId === options.currentSessionId || db?.isOpen(sessionId) || registryIsOpen(options.agentDir, new Set([sessionId])); }
	catch { throw new RewriteRefusal("Cannot establish that the session is closed"); }
	if (open) throw new RewriteRefusal("Session is open; close it before erasure");
}

/** Entries on the tree path from `from` down to `to`. Both must lie on one path. */
function rangeIds(entries: readonly JsonObject[], range: string): Set<string> {
	const parsed = parseRangeSelector(range);
	if (!parsed) throw new RewriteRefusal("Range must be <ref>..<ref>");
	const resolve = endpointResolver(entries as unknown as readonly SessionEntry[]);
	const from = resolve(parsed.from);
	const to = resolve(parsed.to);
	if (!from.ok) throw new RewriteRefusal(from.reason);
	if (!to.ok) throw new RewriteRefusal(to.reason);
	const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
	const selected = new Set<string>();
	for (let id: string | null = to.entryId; id !== null && !selected.has(id);) {
		selected.add(id);
		if (id === from.entryId) return selected;
		const parent: unknown = byId.get(id)?.parentId;
		id = typeof parent === "string" ? parent : null;
	}
	throw new RewriteRefusal("Range endpoints are not on one path of the session tree, or are in reverse order");
}

/** The temporary replacement is never visible under the session's name until the rename. */
function writeReplacement(held: string, name: string, text: string, mode: number): { path: string; discard: () => void } {
	const temporary = path.join(held, `.${name}.rewrite-${randomUUID()}.tmp`);
	const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
	try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } catch (error) { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); throw error; }
	fs.closeSync(fd);
	return { path: temporary, discard: () => fs.rmSync(temporary, { force: true }) };
}

function syncDirectory(held: string): void {
	const fd = fs.openSync(held, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try { fs.fsyncSync(fd); } catch { /* not supported on this filesystem */ } finally { fs.closeSync(fd); }
}

interface LoadedSession {
	readonly original: StoreFileRead;
	readonly lines: readonly Line[];
	readonly header: JsonObject;
	readonly sessionId: string;
	/** Entries other than the header, in file order. */
	readonly entries: readonly JsonObject[];
}

function loadSession(held: string, name: string): LoadedSession {
	const original = readStoreFileWithIdentity(path.join(held, name));
	const lines = parseLines(original.text);
	const header = lines.find((line) => line.raw.trim() !== "")?.entry;
	if (header?.type !== "session" || typeof header.id !== "string") throw new RewriteRefusal("Not a session file: no session header");
	try { validateSessionId(header.id); } catch { throw new RewriteRefusal("Invalid session id in header"); }
	const entries = lines.flatMap((line) => line.entry && line.entry !== header && typeof line.entry.id === "string" ? [line.entry] : []);
	return { original, lines, header, sessionId: header.id, entries };
}

/** What a selector erases, what would still be wrong afterwards, and where its text could hide. */
interface Selection {
	readonly chooses: (entry: JsonObject) => boolean;
	/** Match only: true when the entry still holds erasable text that matches. */
	readonly leftover?: (entry: JsonObject) => boolean;
	/** Match only: true when a raw line holds the text, as written or as JSON-escaped. */
	readonly rawHolds?: (raw: string) => boolean;
}

function selectionOf(selector: RewriteSelector, entries: readonly JsonObject[]): Selection {
	if (selector.kind === "range") {
		const ids = rangeIds(entries, selector.range);
		return { chooses: (entry) => typeof entry.id === "string" && ids.has(entry.id) };
	}
	if (selector.kind === "entries") {
		const ids = new Set(selector.ids);
		return { chooses: (entry) => typeof entry.id === "string" && ids.has(entry.id) };
	}
	const needle = selector.text;
	const escaped = JSON.stringify(needle).slice(1, -1);
	const holds = (entry: JsonObject) => erasableStrings(entry).some((text) => text.includes(needle));
	return { chooses: holds, leftover: holds, rawHolds: (raw) => raw.includes(needle) || raw.includes(escaped) };
}

/** A line that cannot be parsed cannot be searched by field, so a hit there is an unsure case. */
function assertReadable(lines: readonly Line[], selection: Selection): void {
	if (selection.rawHolds && lines.some((line) => !line.entry && selection.rawHolds!(line.raw))) throw new RewriteRefusal("The match appears in a line that is not a readable session entry");
}

function planErasure(file: LoadedSession, selection: Selection, marker: string, collected: string[]): { rewritten: string[]; erased: ErasedEntry[] } {
	const erased: ErasedEntry[] = [];
	const chosen = new Set(file.entries.flatMap((entry) => typeof entry.id === "string" && selection.chooses(entry) ? [entry.id] : []));
	// Derived copies of the chosen entries (summaries, fold records) go with them.
	const all = derivedEntryIds(file.entries, chosen);
	const rewritten = file.lines.map((line) => {
		const entry = line.entry;
		const id = entry?.id;
		if (!entry || entry === file.header || typeof id !== "string" || !all.has(id) || alreadyErased(entry, marker)) return line.raw;
		collected.push(...erasableStrings(entry));
		erased.push({ entryId: id, hash: contentHash(file.sessionId, id, line.raw) });
		return JSON.stringify(tombstoneEntry(entry, marker)) + (line.cr ? "\r" : "");
	});
	return { rewritten, erased };
}

function assertSameStructure(before: Line, after: Line): void {
	if (!before.entry !== !after.entry) throw new RewriteRefusal("Rewrite would change the session structure");
	if (before.entry && after.entry && structureOf(before.entry) !== structureOf(after.entry)) throw new RewriteRefusal("Rewrite would change the session structure");
}

/**
 * Check the planned text before anything is written: same lines, same structure, nothing left to find.
 * Returns the entries where a match survives outside erasable content (an id, another extension's data).
 */
function verifyRewrite(lines: readonly Line[], rewritten: readonly string[], selection: Selection): string[] {
	const after = parseLines(rewritten.join("\n"));
	if (after.length !== lines.length) throw new RewriteRefusal("Rewrite changed the number of lines");
	const unreached: string[] = [];
	lines.forEach((line, index) => {
		const next = after[index]!;
		assertSameStructure(line, next);
		if (next.entry && selection.leftover?.(next.entry)) throw new RewriteRefusal("Rewrite would leave the match in place");
		if (selection.rawHolds?.(rewritten[index]!)) unreached.push(typeof next.entry?.id === "string" ? next.entry.id : "header");
	});
	return unreached;
}

function writeBackup(held: string, name: string, text: string): string {
	const backup = `${name}.erase-backup-${randomUUID()}`;
	const fd = fs.openSync(path.join(held, backup), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	return backup;
}

/** A concurrent writer keeps its bytes: the rename happens only if the file is the one that was read. */
function assertUnchanged(held: string, name: string, original: StoreFileRead): void {
	const current = fs.lstatSync(path.join(held, name));
	if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw new RewriteRefusal("Session file changed during the rewrite");
}

interface Commit {
	readonly options: RewriteOptions;
	readonly db: SessionDatabase;
	readonly held: string;
	readonly name: string;
	readonly file: LoadedSession;
	readonly text: string;
	readonly marker: string;
	readonly erased: readonly ErasedEntry[];
}

function commitReplacement(c: Commit): void {
	const replacement = writeReplacement(c.held, c.name, c.text, c.file.original.mode);
	try {
		c.options.beforeRename?.();
		assertClosed(c.options, c.db, c.file.sessionId);
		assertUnchanged(c.held, c.name, c.file.original);
		// The ledger comes first, so a failure after this point never leaves an unrecorded erasure.
		c.db.recordEntryErasures(c.file.sessionId, c.marker.slice("[erased ".length, -1), c.erased);
		fs.renameSync(replacement.path, path.join(c.held, c.name));
	} catch (error) { replacement.discard(); throw error; }
	syncDirectory(c.held);
}

function rewriteHeld(options: RewriteOptions, held: string, name: string): RewriteResult {
	const release = acquireLock(held, name);
	let db: SessionDatabase | undefined;
	try {
		const file = loadSession(held, name);
		// A preview must not create the database: with none on disk, nothing is erased and no session is registered open.
		if (!options.dryRun || fs.existsSync(sessionDatabaseFile(options.agentDir))) db = new SessionDatabase(options.agentDir);
		if (db?.isErased(file.sessionId)) throw new RewriteRefusal("Session was erased");
		assertClosed(options, db, file.sessionId);
		const selection = selectionOf(options.selector, file.entries);
		assertReadable(file.lines, selection);
		const collected: string[] = [];
		const marker = erasedMarker((options.now ?? (() => new Date()))());
		const { rewritten, erased } = planErasure(file, selection, marker, collected);
		const unreached = verifyRewrite(file.lines, rewritten, selection);
		if (erased.length === 0) return { status: "nothing-to-erase", sessionId: file.sessionId, unreached };
		if (options.dryRun) { options.collectErasedText?.(collected); return { status: "erased", sessionId: file.sessionId, entries: erased, unreached }; }
		db ??= new SessionDatabase(options.agentDir);
		const backup = options.backup ? writeBackup(held, name, file.original.text) : undefined;
		commitReplacement({ options, db, held, name, file, text: rewritten.join("\n"), marker, erased });
		options.collectErasedText?.(collected);
		return { status: "erased", sessionId: file.sessionId, entries: erased, unreached, ...(backup ? { backup: path.join(path.dirname(options.sessionFile), backup) } : {}) };
	} finally { db?.close(); release(); }
}

/** A redirected directory or file (ELOOP, ENOTDIR) is a refusal, not a failure to retry. */
function resultOfError(error: unknown): RewriteResult {
	if (error instanceof RewriteRefusal) return { status: "refused", reason: error.message };
	if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { status: "refused", reason: "Path is redirected by a symbolic link" };
	return { status: "failed", reason: "Rewrite failed: " + errorText(error) };
}

function checkRequest(options: RewriteOptions): string {
	if (options.selector.kind === "match" && options.selector.text.length === 0) throw new RewriteRefusal("Match text is empty");
	if (options.selector.kind === "entries" && options.selector.ids.length === 0) throw new RewriteRefusal("No entries to erase");
	return confine(options.agentDir, options.sessionFile);
}

export function rewriteSession(options: RewriteOptions): RewriteResult {
	try {
		const target = checkRequest(options);
		return withStoreDirectory(options.agentDir, path.dirname(target), (held) => rewriteHeld({ ...options, sessionFile: target }, held, fileName(target)));
	} catch (error) { return resultOfError(error); }
}
