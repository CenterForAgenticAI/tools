import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { ParityDiff } from "./records.js";

export const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024;
export interface SideBlock {
	readonly blockId: string;
	readonly runId: string;
	readonly compressCallId?: string;
	readonly effectiveMessageIds: readonly string[];
	readonly directBlockIds: readonly string[];
	readonly tier: number;
}
export type SideSnapshot =
	| { readonly ok: true; readonly text: string; readonly byRef: Readonly<Record<string, string>>; readonly blocks: readonly SideBlock[]; readonly producer?: string }
	| { readonly ok: false; readonly diff: ParityDiff };

export function parseSideSnapshot(text: string): SideSnapshot {
	if (Buffer.byteLength(text) > MAX_SIDE_FILE_BYTES) return { ok: false, diff: { kind: "too-large", reason: "side file exceeds 8 MB" } };
	try {
		const doc = JSON.parse(text) as { schemaVersion?: unknown; messageRefs?: { byRef?: unknown }; blocks?: unknown; producer?: unknown };
		if (doc?.schemaVersion !== 1 || !Array.isArray(doc.blocks) || !doc.messageRefs || typeof doc.messageRefs.byRef !== "object" || !doc.messageRefs.byRef) throw new Error("Unsupported side file shape");
		const byRef: Record<string, string> = {};
		for (const [ref, raw] of Object.entries(doc.messageRefs.byRef)) if (typeof raw === "string") byRef[ref] = raw;
		const blocks: SideBlock[] = [];
		for (const raw of doc.blocks) {
			const block = raw as SideBlock;
			if (!block || typeof block.blockId !== "string" || typeof block.runId !== "string" || !Array.isArray(block.effectiveMessageIds) || !block.effectiveMessageIds.every((id) => typeof id === "string") || ![1, 2, 3].includes(block.tier) || (block.directBlockIds !== undefined && (!Array.isArray(block.directBlockIds) || !block.directBlockIds.every((id) => typeof id === "string")))) throw new Error("Unsupported block shape");
			blocks.push({ blockId: block.blockId, runId: block.runId, tier: block.tier, effectiveMessageIds: [...block.effectiveMessageIds], directBlockIds: [...(block.directBlockIds ?? [])], ...(typeof block.compressCallId === "string" ? { compressCallId: block.compressCallId } : {}) });
		}
		// Producer is metadata, not conversation text. Bound even malformed producers.
		const producer = doc.producer === undefined ? undefined : (typeof doc.producer === "string" ? doc.producer : JSON.stringify(doc.producer)).slice(0, 200);
		return { ok: true, text, byRef, blocks, ...(producer ? { producer } : {}) };
	} catch {
		return { ok: false, diff: { kind: "import-unsupported", reason: "invalid JSON or unsupported side-file schema" } };
	}
}

/**
 * An in-memory session (`SessionManager.inMemory`, `pi --no-session`, delegated and durable
 * workers) has no session file, so billion-context-pi writes no side file for it. Its calls are not
 * comparable, rather than inconclusive: no later record can supply the missing evidence.
 */
const NO_SESSION_FILE = "session has no file";
export function sessionHasNoFile(diff: ParityDiff): boolean {
	return diff.kind === "side-file-missing" && diff.reason === NO_SESSION_FILE;
}
/** Read at most cap+1 bytes from one open inode, including if it grows mid-read. */
export function snapshotSideFile(sessionFile: string | undefined): SideSnapshot {
	if (!sessionFile) return { ok: false, diff: { kind: "side-file-missing", reason: NO_SESSION_FILE } };
	let fd: number | undefined;
	try {
		fd = openSync(`${sessionFile}.acp.json`, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { ok: false, diff: { kind: "import-unsupported", reason: "side file is not a regular file" } };
		if (stat.size > MAX_SIDE_FILE_BYTES) return { ok: false, diff: { kind: "too-large", reason: "side file exceeds 8 MB" } };
		const buffer = Buffer.alloc(64 * 1024);
		const chunks: Buffer[] = [];
		let length = 0;
		while (length <= MAX_SIDE_FILE_BYTES) {
			const read = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_SIDE_FILE_BYTES + 1 - length), null);
			if (!read) break;
			chunks.push(Buffer.from(buffer.subarray(0, read)));
			length += read;
		}
		if (length > MAX_SIDE_FILE_BYTES) return { ok: false, diff: { kind: "too-large", reason: "side file exceeds 8 MB" } };
		return parseSideSnapshot(Buffer.concat(chunks, length).toString("utf8"));
	} catch {
		return { ok: false, diff: { kind: "side-file-missing", reason: "side file is missing or unreadable" } };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
