import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionDatabase } from "./database.js";
import { eraseSession, formatErasureReceipt, missingSessionSources, missingSourceNotice, sweepMissingSessions, type ErasureSession } from "./session-erasure.js";
import { readStoreHeader, storeDirectories, withStoreDirectory } from "./files.js";
import { restoredErasedSessions } from "./restored.js";

/** SDK listAll(customDir) is flat: explicitly list the profile root and its project directories. */
export async function discoverProfileSessions(agentDir: string): Promise<ErasureSession[]> {
	const root = path.join(agentDir, "sessions");
	const sessions = [];
	for (const directory of storeDirectories(agentDir, root).filter((dir) => dir === root || path.dirname(dir) === root)) {
		const held = withStoreDirectory(agentDir, directory, (dir) => {
			const fd = fs.openSync(`${dir}/.`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
			return { fd, path: path.join(path.dirname(dir), String(fd)) };
		});
		try {
			for (const session of await SessionManager.listAll(held.path)) {
				sessions.push({ ...session, path: path.join(directory, path.basename(session.path)) });
			}
		} finally { fs.closeSync(held.fd); }
	}
	return sessions;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	// SDK hosts can omit UI capabilities. Protection must not break their lifecycle.
	if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, level);
}

/** True only when an interactive user can have seen the message. A stale context after session replacement is not delivery. */
function deliver(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): boolean {
	try {
		if (!ctx.hasUI || typeof ctx.ui?.notify !== "function") return false;
		ctx.ui.notify(message, level);
		return true;
	} catch { return false; }
}

/** Routine maintenance goes to the shared debug log, without session ids, never to the user. */
function diagnostic(agentDir: string, message: string): void {
	try { fs.appendFileSync(path.join(agentDir, "context-aware-debug.log"), `[${new Date().toISOString()}] session erasure: ${message}\n`); } catch { /* best effort */ }
}

/** The error's code or class only: error text can name a session path, and the debug log is never erased. */
function errorKind(error: unknown): string {
	return (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : "unknown");
}

function transcriptWritten(file: string): boolean {
	try { fs.lstatSync(file); return true; } catch { return false; }
}

function currentSession(ctx: ExtensionContext): ErasureSession | undefined {
	const file = ctx.sessionManager.getSessionFile();
	return file ? { id: ctx.sessionManager.getSessionId(), path: file } : undefined;
}

/** Every session gets a lease, including idle sessions with focus disabled. No model tool. */
export function registerSessionErasure(pi: ExtensionAPI, agentDirectory: () => string, flushParity: () => Promise<void>, options: { registerStartup?: boolean; maintenanceDelayMs?: number } = {}): { start: (ctx: ExtensionContext) => Promise<void>; isBlocked: () => boolean; flushMaintenance: () => void } {
	const owner = randomUUID();
	let leasedId: string | undefined;
	let leasedFile: string | null = null;
	let blocked = false;
	let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
	let maintenance: (() => void) | undefined;
	const reportRestored = (ctx: ExtensionContext, current = currentSession(ctx)) => {
		try {
			for (const session of restoredErasedSessions(agentDirectory(), current)) {
				notify(ctx, `Erased session ${session.id} has data on disk again:\n${session.files.join("\n")}\nNothing deleted. A backup may have been restored intentionally. Close this session and run /session-erase ${session.id} from another session to remove it, with confirmation.`, "warning");
			}
		} catch { notify(ctx, "Could not check for restored erased-session data; nothing deleted.", "warning"); }
	};
	const cancelMaintenance = () => {
		if (maintenanceTimer) clearTimeout(maintenanceTimer);
		maintenanceTimer = undefined;
		maintenance = undefined;
	};
	/** Runs pending startup maintenance now. Tests and shutdown-free hosts use it; the timer calls it otherwise. */
	const flushMaintenance = () => {
		const job = maintenance;
		cancelMaintenance();
		job?.();
	};
	// Both scans are synchronous file work. Keep them off session_start: Pi awaits
	// every session_start handler before the editor accepts input.
	const scheduleMaintenance = (ctx: ExtensionContext, current: ErasureSession | undefined) => {
		cancelMaintenance();
		maintenance = () => {
			const agentDir = agentDirectory();
			try {
				reportRestored(ctx, current);
				const sweep = sweepMissingSessions(agentDir, current?.id ?? leasedId, (missing) => deliver(ctx, missingSourceNotice(missing), "warning"));
				if (sweep.forgotten.length) diagnostic(agentDir, `forgot ${sweep.forgotten.length} session source(s) that never wrote a transcript`);
				if (sweep.failed.length) diagnostic(agentDir, `missing-source sweep incomplete (${sweep.failed.length} check(s) failed); retrying at the next session start`);
			} catch (error) { diagnostic(agentDir, `startup maintenance failed (${errorKind(error)})`); }
		};
		maintenanceTimer = setTimeout(flushMaintenance, options.maintenanceDelayMs ?? 1_000);
		maintenanceTimer.unref?.();
	};
	// before_agent_start has no cancel result and abort there precedes the run's
	// AbortController. agent_start is the first supported abortable boundary.
	// Do not await abort: the SDK waits for this handler to finish before idling.
	pi.on("agent_start", (_event, ctx) => { if (blocked) ctx.abort(); });
	// Pi writes a new transcript when it persists the session's first user or assistant
	// message, and it awaits message_end handlers just before that write. Record it here,
	// first: a crash after the write must not leave a source that looks abandoned and is
	// forgotten once its directory moves. A run that persists no such message records nothing.
	let recordedWrite: string | undefined;
	let loggedFailure: string | undefined;
	pi.on("message_end", (event, ctx) => {
		const role = event.message.role;
		if (blocked || (role !== "user" && role !== "assistant")) return;
		const id = ctx.sessionManager.getSessionId();
		if (recordedWrite === id || !ctx.sessionManager.getSessionFile()) return;
		const agentDir = agentDirectory();
		let db: SessionDatabase | undefined;
		try {
			db = new SessionDatabase(agentDir);
			db.markWritten(id);
			recordedWrite = id;
		} catch (error) {
			if (loggedFailure !== id) diagnostic(agentDir, `could not record a session's first message (${errorKind(error)}); retrying at its next message`);
			loggedFailure = id;
		} finally { db?.close(); }
	});
	pi.on("tool_call", () => blocked ? { block: true, terminate: true, reason: "Session activation refused; all tools are blocked." } : undefined);
	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "resume") return undefined;
		let db: SessionDatabase | undefined;
		try {
			if (!event.targetSessionFile) return { cancel: true };
			const file = event.targetSessionFile;
			const header = withStoreDirectory(agentDirectory(), path.dirname(file), (held) => JSON.parse(readStoreHeader(path.join(held, path.basename(file))))) as { id: string };
			db = new SessionDatabase(agentDirectory());
			if (!db.isErased(header.id)) return undefined;
		} catch { /* An unreadable target cannot be activated safely. */ }
		finally { db?.close(); }
		notify(ctx, "Session activation refused: erased or unavailable target.", "error");
		return { cancel: true };
	});
	pi.on("session_before_fork", async (_event, ctx) => {
		let db: SessionDatabase | undefined;
		try {
			db = new SessionDatabase(agentDirectory());
			if (!db.isErased(ctx.sessionManager.getSessionId()) && !blocked) return undefined;
		} catch { /* Fail closed on unavailable protection. */ }
		finally { db?.close(); }
		return { cancel: true };
	});
	const start = async (ctx: ExtensionContext): Promise<void> => {
		let db: SessionDatabase | undefined;
		try {
			db = new SessionDatabase(agentDirectory());
			const nextId = ctx.sessionManager.getSessionId();
			const nextFile = ctx.sessionManager.getSessionFile() ?? null;
			db.openSession(nextId, nextFile, owner);
			if (leasedId && leasedId !== nextId) {
				await flushParity();
				if (leasedFile && transcriptWritten(leasedFile)) db.observeWritten([leasedId]);
				db.closeSession(leasedId, owner);
			}
			leasedId = nextId;
			leasedFile = nextFile;
			blocked = false;
		} catch {
			blocked = true;
			notify(ctx, "Session activation refused: erased session or unavailable erasure protection. Shutdown requested. Extension writes and input are blocked; external turns will be aborted.", "error");
			ctx.shutdown();
		} finally { db?.close(); }
		// A refused session is shutting down: report restored data now, while its context is live.
		if (blocked) { cancelMaintenance(); reportRestored(ctx); return; }
		scheduleMaintenance(ctx, currentSession(ctx));
	};
	if (options.registerStartup !== false) pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		let db: SessionDatabase | undefined;
		try {
			cancelMaintenance();
			await flushParity();
			db = new SessionDatabase(agentDirectory());
			const file = ctx.sessionManager.getSessionFile();
			if (file && transcriptWritten(file)) db.observeWritten([ctx.sessionManager.getSessionId()]);
			db.closeSession(ctx.sessionManager.getSessionId(), owner);
			leasedId = undefined;
			leasedFile = null;
		} catch { /* A lingering lease refuses erasure conservatively until the process exits. */ }
		finally { db?.close(); }
		if (blocked) reportRestored(ctx);
	});
	pi.registerCommand("session-erase", {
		description: "Permanently erase a closed session and its derived data. Usage: /session-erase <session-id>. User confirmations required; open sessions are refused.",
		async handler(args, ctx) {
			const id = args.trim();
			if (!ctx.hasUI || !id || /\s/u.test(id)) {
				notify(ctx, "Usage: /session-erase <session-id> in interactive Pi. Close the target session first.", "warning");
				return;
			}
			try {
				await flushParity();
				const agentDir = agentDirectory();
				const sessions = await discoverProfileSessions(agentDir);
				for (const restored of restoredErasedSessions(agentDir)) {
					if (!sessions.some((session) => session.id === restored.id && session.path === restored.path)) sessions.push(restored);
				}
				for (const missing of missingSessionSources(agentDir)) {
					if (!sessions.some((session) => session.id === missing.id)) sessions.push(missing);
				}
				const receipt = await eraseSession({
					agentDir, sessionId: id, currentSessionId: ctx.sessionManager.getSessionId(), sessions,
					confirm: (title, message) => ctx.ui.confirm(title, message),
				});
				notify(ctx, formatErasureReceipt(receipt), receipt.status === "complete" ? "info" : "warning");
			} catch {
				notify(ctx, "Session erasure: incomplete. Could not list or access profile stores; no erasure was started.", "error");
			}
		},
	});
	return { start, isBlocked: () => blocked, flushMaintenance };
}
