/**
 * Import of a legacy billion-context-pi side file at session start (pi-context-aware#254).
 *
 * billion-context-pi keeps a session's folds in `<session>.jsonl.acp.json`. Without this import a
 * resumed session shows its full, unfolded history. The import runs once per session start, only
 * when this extension owns folding (the fold engine is live, not in shadow mode beside
 * billion-context-pi) and only when the session has no native fold entries. Nothing here writes the
 * side file. A side file that cannot be read or imported gives one warning and leaves the session
 * as it was.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { importAcpSideFileFromProfile } from "./acp-import.js";
import { applyDraftsLinear, type BatchableManager as WritableManager } from "./branch-cache.js";
import type { FoldEngine } from "./fold-engine.js";
import { MAX_SIDE_FILE_BYTES } from "../parity/side-file.js";

export interface AcpStartupImportOptions {
	/** The fold engine. Only its mode is read: the import runs when it is live. */
	readonly engine: Pick<FoldEngine, "mode">;
	/** The profile directory that holds the erasure ledger. Read at each session start. */
	readonly agentDir: () => string;
	/** Show the user one warning. Called at most once per session start. */
	readonly warn: (ctx: ExtensionContext, message: string) => void;
	/** Diagnostics for the debug log. */
	readonly log?: (message: string) => void;
}

/** Register the session_start import. Register it after the fold engine, whose handler resets the mode. */
export function registerAcpStartupImport(pi: ExtensionAPI, options: AcpStartupImportOptions): void {
	// One attempt per session manager: a second start on the same session never reads the side file again.
	const attempted = new WeakSet<object>();
	pi.on("session_start", (_event, ctx) => {
		if (attempted.has(ctx.sessionManager)) return;
		if (options.engine.mode(ctx) !== "live") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		// An in-memory session has no file, so billion-context-pi wrote no side file for it.
		if (!sessionFile) return;
		attempted.add(ctx.sessionManager);
		try {
			importSideFile(ctx, sessionFile, options);
		} catch (error) {
			warnOnce(ctx, options, `${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
		}
	});
}

function warnOnce(ctx: ExtensionContext, options: AcpStartupImportOptions, rawReason: string): void {
	const reason = rawReason.slice(0, 200);
	options.log?.(`acp side-file import failed: ${reason}`);
	options.warn(ctx, `The billion-context-pi side file for this session could not be imported (${reason}). The session was left as it was.`);
}

function importSideFile(ctx: ExtensionContext, sessionFile: string, options: AcpStartupImportOptions): void {
	const manager = ctx.sessionManager;
	// Native folds win, so a session that has them never reads its side file.
	if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "context-aware.fold.v1")) return;
	const read = readSideFile(`${sessionFile}.acp.json`);
	if (read.kind === "missing") return;
	if (read.kind === "unreadable") return warnOnce(ctx, options, read.reason);
	const result = importAcpSideFileFromProfile(options.agentDir(), {
		sideFileText: read.text,
		entries: manager.getEntries(),
		branch: manager.getBranch(),
		sessionId: manager.getSessionId(),
	});
	if (result.status === "unsupported") return warnOnce(ctx, options, result.reason);
	if (result.status === "skipped") {
		options.log?.(`acp side-file import skipped: ${result.reason}`);
		return;
	}
	if (result.records.length === 0) {
		options.log?.(`acp side-file import: no block applied (${result.skippedBlocks.length} skipped)`);
		return;
	}
	// Prove the drafts apply to a copy of the branch first, so a draft that Pi refuses cannot leave half the folds in the file.
	const header = manager.getHeader();
	if (!header) return warnOnce(ctx, options, "the session header is unavailable");
	applyDraftsLinear(SessionManager.inMemory(ctx.cwd, undefined, [header, ...manager.getBranch()]), result.drafts);
	applyDraftsLinear(manager as unknown as WritableManager, result.drafts);
	options.log?.(`acp side-file import: ${result.records.length} fold(s) imported, ${result.skippedBlocks.length} block(s) skipped`);
}

type SideFileRead = { readonly kind: "text"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "unreadable"; readonly reason: string };

/** Read the side file from one open inode, refusing anything but a regular file within the size cap. */
function readSideFile(file: string): SideFileRead {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { kind: "unreadable", reason: "the side file is not a regular file" };
		if (stat.size > MAX_SIDE_FILE_BYTES) return { kind: "unreadable", reason: "the side file exceeds 8 MB" };
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < stat.size) {
			const count = readSync(fd, buffer, offset, stat.size - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		return { kind: "text", text: buffer.subarray(0, offset).toString("utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "unreadable", reason: "the side file is unreadable" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
