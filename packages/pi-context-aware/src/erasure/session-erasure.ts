import fs from "node:fs";
import path from "node:path";
import { readManifest, writeManifest } from "../cache/context-cache.js";
import { paritySessionFile } from "../parity/records.js";
import { SessionDatabase, SessionOpenError, sessionDatabaseFile, validateSessionId } from "./database.js";
import { readStoreFile, readStoreHeader, removeStoreDirectory, removeStoreFile, storeDirectories, withStoreDirectory } from "./files.js";
import { sessionIdFromFileName } from "./restored.js";

export interface ErasureSession {
	readonly id: string;
	readonly path: string;
	readonly parentSessionPath?: string;
}
export interface ErasureReceipt {
	readonly status: "complete" | "incomplete" | "refused" | "cancelled";
	readonly erased: string[];
	readonly failed: string[];
	readonly untouched: string[];
}
export interface ErasureOptions {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly currentSessionId: string;
	readonly sessions: readonly ErasureSession[];
	readonly confirm: (title: string, message: string) => Promise<boolean>;
}
interface CacheTarget { directory: string; file: string }
class ErasureRefusal extends Error {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const externalStores = [
	"Fabric memory index: not erased (requires Fabric deletion support).",
	"Copies outside profile stores, backups, exported task plans, and other extensions' stores: not touched; remove separately.",
	"Shared context-aware-debug.log: not erased (diagnostics are not attributable by session).",
];

interface RegistryInventory {
	files: string[];
	projections: string[];
	owners: string[];
	directories: string[];
}
function registryInventory(agentDir: string, ids: ReadonlySet<string>): RegistryInventory {
	const root = path.join(agentDir, "session-registry", "v1");
	const inventory: RegistryInventory = { files: [], projections: [], owners: [], directories: [] };
	for (const directory of storeDirectories(agentDir, root)) {
		if (path.dirname(directory) !== root) continue; // Project directories only.
		withStoreDirectory(agentDir, directory, (held) => {
			for (const entry of fs.readdirSync(held, { withFileTypes: true })) {
				for (const id of ids) {
					const file = path.join(directory, entry.name);
					const prefix = `.${id}.json.`;
					const suffix = entry.name.slice(prefix.length);
					const token = /^[A-Za-z0-9_-]{1,128}$/u;
					if (entry.name === `${id}.json`) { inventory.files.push(file); inventory.projections.push(file); }
					else if (entry.isFile() && entry.name.startsWith(prefix) && suffix.endsWith(".tmp") && token.test(suffix.slice(0, -4))) inventory.files.push(file);
					else if (entry.isDirectory() && (entry.name === `${prefix}lock` || (entry.name.startsWith(`${prefix}reclaim.`) && token.test(suffix.slice("reclaim.".length))))) {
						const owner = path.join(file, "owner.json");
						inventory.files.push(owner); inventory.owners.push(owner); inventory.directories.push(file);
					}
				}
			}
		});
	}
	return inventory;
}
function registryIsOpen(agentDir: string, ids: ReadonlySet<string>): boolean {
	const inventory = registryInventory(agentDir, ids);
	for (const file of [...inventory.projections, ...inventory.owners]) {
		const record = withStoreDirectory(agentDir, path.dirname(file), (held) => JSON.parse(readStoreFile(path.join(held, path.basename(file))))) as { state?: string; pid?: number };
		if (!inventory.owners.includes(file) && record.state === "closed") continue;
		if (!Number.isInteger(record.pid) || !record.pid || record.pid <= 0) throw new Error("Cannot establish registry session liveness");
		try { process.kill(record.pid, 0); return true; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
		}
	}
	return false;
}
function cacheInventory(agentDir: string, ids: ReadonlySet<string>): { targets: CacheTarget[]; unattributed: string[]; owners: Set<string> } {
	const unattributed: string[] = [];
	const owners = new Set<string>();
	const directories = [
		...storeDirectories(agentDir, path.join(agentDir, "context-cache")).filter((directory) => directory !== path.join(agentDir, "context-cache")),
		...storeDirectories(agentDir, path.join(agentDir, "sessions")).filter((directory) => path.basename(directory) === "context"),
	];
	const targets = directories.flatMap((directory) => withStoreDirectory(agentDir, directory, (held) => {
		if (!fs.existsSync(path.join(held, "_manifest.json"))) {
			for (const name of fs.readdirSync(held)) unattributed.push(`Unattributed cache file (not erased): ${path.join(directory, name)}`);
			return [];
		}
		const raw = JSON.parse(readStoreFile(path.join(held, "_manifest.json"))) as { version?: number; files?: unknown };
		if (raw.version !== 1 || !raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) throw new Error(`Invalid cache manifest: ${directory}`);
		const manifest = readManifest(held);
		if (Object.keys(raw.files).length !== Object.keys(manifest.files).length) throw new Error(`Unattributable cache entries: ${directory}`);
		for (const name of fs.readdirSync(held)) {
			if (name !== "_manifest.json" && !Object.hasOwn(manifest.files, name)) unattributed.push(`Unattributed cache file (not erased): ${path.join(directory, name)}`);
		}
		return Object.entries(manifest.files)
			.filter(([, entry]) => ids.has(entry.createdBy) || ids.has(entry.updatedBy))
			.map(([file, entry]) => {
				for (const id of [entry.createdBy, entry.updatedBy]) if (ids.has(id)) owners.add(id);
				return { directory, file };
			});
	}));
	return { targets, unattributed, owners };
}
function removeCacheTarget(agentDir: string, target: CacheTarget): void {
	withStoreDirectory(agentDir, target.directory, (held) => {
		const manifest = readManifest(held);
		// Remove first; never hide a failed deletion by dropping its manifest entry.
		removeStoreFile(agentDir, path.join(target.directory, target.file));
		delete manifest.files[target.file];
		writeManifest(held, manifest);
	});
}
function derivedTargets(agentDir: string, ids: ReadonlySet<string>): { files: string[]; directories: string[] } {
	const inventory = registryInventory(agentDir, ids);
	return { files: [...ids].map((id) => paritySessionFile(agentDir, id)).concat(inventory.files), directories: inventory.directories };
}

/** User-only erasure, with a ledger committed before destructive file operations. */
export async function eraseSession(options: ErasureOptions): Promise<ErasureReceipt> {
	const receipt: ErasureReceipt = { status: "refused", erased: [], failed: [], untouched: [...externalStores] };
	let db: SessionDatabase | undefined;
	try {
		try { validateSessionId(options.sessionId); } catch (error) { throw new ErasureRefusal(errorText(error)); }
		db = new SessionDatabase(options.agentDir);
		const alreadyErased = db.isErased(options.sessionId);
		const target = options.sessions.find((session) => session.id === options.sessionId)
			?? (alreadyErased ? { id: options.sessionId, path: path.join(options.agentDir, "sessions", `${options.sessionId}.jsonl`) } : undefined);
		if (!target) throw new ErasureRefusal("Session id not found in this profile");
		const children: ErasureSession[] = [];
		const paths = new Set([path.resolve(target.path)]);
		// Transitive forks, not just the immediate children.
		for (let changed = true; changed;) {
			changed = false;
			for (const session of options.sessions) {
				if (session.parentSessionPath && paths.has(path.resolve(session.parentSessionPath)) && !paths.has(path.resolve(session.path))) {
					children.push(session); paths.add(path.resolve(session.path)); changed = true;
				}
			}
		}
		const restoredCopies = alreadyErased ? options.sessions.filter((session) => session.id === target.id && session.path !== target.path) : [];
		const selected = [target, ...restoredCopies];
		const isOpen = (sessions: readonly ErasureSession[]) => sessions.some((session) => session.id === options.currentSessionId || db!.isOpen(session.id)) || registryIsOpen(options.agentDir, new Set(sessions.map((session) => session.id)));
		if (isOpen(selected)) throw new ErasureRefusal("Session is open; close it before erasure (including the current session)");
		if (children.length) {
			if (await options.confirm("Include session forks?", children.map((session) => `${session.id}: ${session.path}`).join("\n"))) selected.push(...children);
			else receipt.untouched.push(...children.map((session) => `Unconfirmed fork ${session.id}: ${session.path}`));
		}
		if (isOpen(selected)) throw new ErasureRefusal("A selected session is open; close it before erasure");
		const ids = new Set(selected.map((session) => session.id));
		const cache = cacheInventory(options.agentDir, ids);
		const caches = cache.targets;
		receipt.untouched.push(...cache.unattributed);
		const deleteCaches = caches.length > 0 && await options.confirm("Erase context-cache documents?", "Documents created or updated by these sessions (may be shared):\n" + caches.map((target) => path.join(target.directory, target.file)).join("\n"));
		if (!deleteCaches) receipt.untouched.push(...caches.map((target) => `Unconfirmed cache document: ${path.join(target.directory, target.file)}`));
		const derived = derivedTargets(options.agentDir, ids);
		const files = selected.flatMap((session) => [session.path, `${session.path}.acp.json`]).concat(derived.files);
		// Verify primary identity and containment before and after irreversible consent.
		const verifyPrimary = () => {
			for (const session of selected) {
				try {
					withStoreDirectory(options.agentDir, path.dirname(session.path), (held) => {
						const text = readStoreHeader(path.join(held, path.basename(session.path)));
						let header: { type?: string; id?: string } | undefined;
						try { header = JSON.parse(text) as typeof header; } catch { /* SDK can restore an orphan entry without its header. */ }
						if (header?.type === "session" && header.id === session.id) return;
						// A ledgered, exactly named orphan can be erased with explicit consent.
						// Never substitute filename identity for a different valid session header.
						if (header?.type !== "session" && db!.isErased(session.id) && sessionIdFromFileName(session.path) === session.id) return;
						throw new ErasureRefusal("Session file identity changed");
					});
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (!db!.isErased(session.id) && !db!.sources().some((source) => source.id === session.id && source.path === session.path))) throw error;
					// A known unavailable source can be cleaned up only through this named, confirmed command.
					const relative = path.relative(path.resolve(options.agentDir), path.resolve(session.path));
					if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ErasureRefusal("Source is outside profile stores");
					const notice = `Unavailable transcript ${session.id}: ${session.path}; moved or unmounted copies are not erased.`;
					if (!receipt.untouched.includes(notice)) receipt.untouched.push(notice);
				}
			}
		};
		verifyPrimary();
		if (!await options.confirm("Permanently erase sessions?", [...ids].join(", ") + "\nDirect deletion, not trash.\n" + files.join("\n") + "\n" + receipt.untouched.join("\n"))) return { ...receipt, status: "cancelled" };
		// Recheck after every user interaction. SQLite serializes ledger erasure against open leases.
		if (isOpen(selected)) throw new ErasureRefusal("A selected session is now open; erasure refused");
		verifyPrimary();
		db.erase([...ids]);
		const attempt = (label: string, action: () => void) => {
			try { action(); receipt.erased.push(label); } catch (error) { receipt.failed.push(`${label}: ${errorText(error)}`); }
		};
		for (const file of files) attempt(file, () => removeStoreFile(options.agentDir, file));
		for (const directory of derived.directories) attempt(directory, () => removeStoreDirectory(options.agentDir, directory));
		if (deleteCaches) for (const target of caches) attempt(path.join(target.directory, target.file), () => removeCacheTarget(options.agentDir, target));
		attempt("SQLite derived rows deleted; erasure ids recorded; WAL checkpointed", () => db!.checkpoint());
		return { ...receipt, status: receipt.failed.length ? "incomplete" : "complete" };
	} catch (error) {
		receipt.failed.push(errorText(error));
		return { ...receipt, status: error instanceof ErasureRefusal || error instanceof SessionOpenError ? "refused" : "incomplete" };
	} finally { db?.close(); }
}

/** Previously observed unavailable sources are candidates for explicit consent, not proof of deletion. */
export function missingSessionSources(agentDir: string): ErasureSession[] {
	const db = new SessionDatabase(agentDir);
	try {
		return db.sources().filter((source) => {
			try { fs.lstatSync(source.path); return false; } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw error;
			}
		}).map((source) => ({ id: source.id, path: source.path }));
	} finally { db.close(); }
}

export interface MissingSourceSweep {
	/** Discovery rows dropped: never-written sources with no derived data. Nothing on disk is touched. */
	readonly forgotten: string[];
	/** Missing sources whose one notice was delivered by this sweep. */
	readonly reported: string[];
	readonly failed: string[];
}

function present(file: string): boolean {
	try { fs.lstatSync(file); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Ids that left any profile data behind. Errors propagate: an unknown answer must not forget a source. */
function idsWithDerivedData(agentDir: string, sources: readonly ErasureSession[]): Set<string> {
	const ids = new Set(sources.map((source) => source.id));
	const found = new Set<string>();
	for (const source of sources) {
		if (present(`${source.path}.acp.json`) || present(paritySessionFile(agentDir, source.id))) found.add(source.id);
	}
	const registry = registryInventory(agentDir, ids);
	for (const file of [...registry.files, ...registry.directories]) {
		const parts = file.split(path.sep);
		for (const id of ids) if (parts.some((part) => part === `${id}.json` || part.startsWith(`.${id}.json.`))) found.add(id);
	}
	for (const id of cacheInventory(agentDir, ids).owners) found.add(id);
	return found;
}

/**
 * Background maintenance for recorded sources whose transcript is gone.
 * Pi writes a transcript with a session's first user or assistant message, and that
 * message is recorded just before the write. A source with no recorded message, never
 * seen on disk, and no derived data was never used: its discovery row is dropped without notice. Any
 * other missing source can be an unmounted disk or a moved directory. It is never
 * forgotten or deleted here, and `report` is asked to tell the user once, with every
 * such source in one notice. A report that was not delivered stays pending for a
 * later session.
 */
export function sweepMissingSessions(agentDir: string, currentSessionId: string | undefined, report: (sources: readonly ErasureSession[]) => boolean): MissingSourceSweep {
	const result = { forgotten: [] as string[], reported: [] as string[], failed: [] as string[] };
	// Never create a ledger for a profile that has none: there is nothing to sweep.
	if (!fs.existsSync(sessionDatabaseFile(agentDir))) return result;
	let db: SessionDatabase | undefined;
	try {
		db = new SessionDatabase(agentDir);
		const missing: ErasureSession[] = [];
		const written: string[] = [];
		for (const source of db.sources()) {
			try {
				if (present(source.path)) written.push(source.id);
				else if (source.id !== currentSessionId) missing.push(source);
			} catch (error) { result.failed.push(`${source.id}: ${errorText(error)}`); }
		}
		db.observeWritten(written);
		// A live process holds a lease on a session it has not written yet.
		const closed = missing.filter((source) => !db!.isOpen(source.id));
		const unwritten = closed.filter((source) => !db!.sourceState(source.id).written);
		let withData: Set<string> | undefined = new Set();
		if (unwritten.length) {
			try { withData = idsWithDerivedData(agentDir, unwritten); } catch (error) {
				withData = undefined;
				result.failed.push(`Derived-data check: ${errorText(error)}`);
			}
		}
		// Claim before telling the user, so concurrent sessions report a source once.
		// A claim that was not shown is released for a later session.
		const claimed: ErasureSession[] = [];
		let delivered = false;
		try {
			for (const source of closed) {
				if (!db.sourceState(source.id).written) {
					// Unknown derived data: neither forget nor report until a later sweep can tell.
					if (!withData) continue;
					if (!withData.has(source.id)) {
						if (db.forgetUnwritten(source.id, source.path)) result.forgotten.push(source.id);
						continue;
					}
				}
				if (db.claimReport(source.id)) claimed.push(source);
			}
			if (claimed.length) delivered = report(claimed);
		} finally { if (!delivered) for (const source of claimed) db.releaseReport(source.id); }
		if (delivered) result.reported.push(...claimed.map((source) => source.id));
	} catch (error) { result.failed.push(errorText(error)); }
	finally { db?.close(); }
	return result;
}

export function missingSourceNotice(sources: readonly ErasureSession[]): string {
	const [only] = sources;
	if (sources.length === 1 && only) {
		return [
			`Session transcript missing: ${only.id}`,
			only.path,
			"It may be on an unmounted disk or in a moved directory. Nothing was deleted.",
			`To remove its remaining profile data, run /session-erase ${only.id} and confirm. This notice is shown once.`,
		].join("\n");
	}
	return [
		`Session transcripts missing: ${sources.length}`,
		...sources.map((source) => `${source.id}  ${source.path}`),
		"They may be on an unmounted disk or in a moved directory. Nothing was deleted.",
		"To remove a session's remaining profile data, run /session-erase <session-id> and confirm. This notice is shown once.",
	].join("\n");
}

export function formatErasureReceipt(receipt: ErasureReceipt): string {
	return [`Session erasure: ${receipt.status}`, "Erased:", ...receipt.erased, "Failed:", ...receipt.failed, "Untouched:", ...receipt.untouched].join("\n");
}
