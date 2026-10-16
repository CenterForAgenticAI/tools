import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { erasedSessionIds, SessionDatabase, SessionErasedError } from "../erasure/database.js";
import { appendFile, mkdir, open, readdir, stat, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

/** Record schema version. Records with an older version are ignored: they lack evidence later versions compare. */
export const PARITY_RECORD_VERSION = 5 as const;
export type DiffKind =
	| "outcome" | "error-type" | "outcome-unknown" | "block-count" | "coverage" | "tier" | "absorbed" | "input-parse" | "ref-unmapped" | "import-unsupported" | "import-skipped" | "side-file-missing" | "too-large" | "recorder-error"
	| "summaries" | "content" | "tool-calls" | "tool-results" | "tool-pairing" | "tool-evidence" | "tags-absent";
export interface ParityDiff {
	readonly kind: DiffKind;
	readonly oursOnlyCount?: number;
	readonly bcpOnlyCount?: number;
	readonly oursOnly?: readonly string[];
	readonly bcpOnly?: readonly string[];
	readonly reason?: string;
}
export type Verdict = "match" | "diff" | "inconclusive";
export const INCONCLUSIVE_KINDS: ReadonlySet<DiffKind> = new Set(["side-file-missing", "import-unsupported", "ref-unmapped", "too-large", "tags-absent", "recorder-error", "tool-evidence", "outcome-unknown"]);
export function verdictFor(diffs: readonly ParityDiff[]): Verdict {
	return diffs.some((diff) => INCONCLUSIVE_KINDS.has(diff.kind)) ? "inconclusive" : diffs.length ? "diff" : "match";
}
interface RecordBase {
	readonly v: typeof PARITY_RECORD_VERSION;
	readonly fingerprint: string;
	readonly sessionId: string;
	readonly at: string;
	readonly verdict: Verdict;
	readonly diffs: readonly ParityDiff[];
}
export interface BlockEvidence {
	readonly count: number;
	readonly coverageCount: number;
	readonly coverageIds: readonly string[];
	/** SHA-256 of the full sorted coverage id list, before capping diagnostic ids. */
	readonly coverageHash: string;
	/** Native created block ids, in creation order; absent on bcp. */
	readonly createdIds?: readonly string[];
	/** True when createdIds or absorbed was truncated at 2,000 entries. */
	readonly blockIdsCapped?: boolean;
	readonly partialEntries: number;
	readonly tiers: readonly number[];
	readonly absorbed: readonly string[];
}
/** Closed outcome categories; raw result and error text is never stored. */
export type OutcomeType = "accepted" | "partial" | "rejected" | "no-op" | "invalid-input" | "tier3-rewrite" | "dead-range" | "capped-retry" | "aborted" | "unknown";
export type RejectReason = "summary-empty" | "summary-short" | "summary-long" | "unknown-ref" | "dangling-ref" | "consumed" | "protected-zone" | "split" | "too-small" | "no-fold" | "header-missing" | "stub-summary" | "other";
export interface OutcomeEvidence {
	readonly type: OutcomeType;
	/** Sorted rejection reason codes; `other` means a message no pattern recognized. */
	readonly reasons: readonly RejectReason[];
}
export interface CompressRecord extends RecordBase {
	readonly kind: "compress";
	readonly toolCallId: string;
	readonly parentToolCallId?: string;
	readonly nested: boolean;
	readonly awaitingNextRequest?: boolean;
	readonly bcp?: BlockEvidence;
	readonly ours?: BlockEvidence;
	readonly producer?: string;
	readonly isError?: boolean;
	readonly resultHash?: string;
	readonly refs?: readonly { readonly bcp: string; readonly ours?: string }[];
	readonly refContinuity?: { readonly same: number; readonly used: number };
	readonly parseKind?: string;
	/** Dropped parser items, including failures in an otherwise `ok` parse. */
	readonly parseInvalidItems?: number;
	readonly oursOutcome?: OutcomeEvidence;
	readonly bcpOutcome?: OutcomeEvidence;
}
/** Tool ids and names are kept when they look like identifiers, otherwise hashed; arguments are always hashed. */
export interface ToolCallHash {
	readonly id: string;
	readonly name: string;
	readonly argsHash: string;
	/** Hash after bcp's exact 200-character summary shortening, only when it changes compress arguments. */
	readonly compactedArgsHash?: string;
}
export interface ToolResultHash {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
}
export interface MessageHash {
	readonly role: string;
	readonly hash: string;
	readonly summary: boolean;
	readonly topicHash?: string;
	readonly toolCalls?: readonly ToolCallHash[];
	readonly toolResult?: ToolResultHash;
	/** Set when a tool call or result lacks the fields needed to compare it. */
	readonly toolEvidence?: "incomplete";
}
export interface RequestHashes {
	/** Preview state after imports, accepted calls and absorption; independent of evidence collection and rendering. */
	readonly activeFoldCount?: number;
	/** Sorted native active block ids, independent of rendering. */
	readonly activeFoldIds?: readonly string[];
	/** True when activeFoldIds was truncated at 2,000 entries. */
	readonly activeFoldIdsCapped?: boolean;
	/** Ordered body hashes from planned active folds, independent of rendered messages.
	 * Absent when any active fold lacks source evidence. Length must agree with activeFoldCount.
	 */
	readonly expectedSummaryHashes?: readonly string[];
	/** Ordered heading/topic-line hashes from the same source folds. Both lists are required. */
	readonly expectedSummaryTopicHashes?: readonly string[];
	/** Original opening user hash, only when the effective policy actually folded it. */
	readonly firstUserFolded?: MessageHash;
	/** Expected body hash of the active fold replacing the opening user. */
	readonly firstUserReplacementHash?: string;
	readonly messages: readonly MessageHash[];
	readonly tagsSeen: boolean;
	readonly total: number;
}
/** Endings only billion-context-pi produces: it refused the call and created no fold. */
export const REFUSAL_OUTCOMES = ["capped-retry", "dead-range", "tier3-rewrite", "aborted"] as const satisfies readonly OutcomeType[];
export type RefusalOutcome = (typeof REFUSAL_OUTCOMES)[number];
export function isRefusalOutcome(type: unknown): type is RefusalOutcome {
	return (REFUSAL_OUTCOMES as readonly unknown[]).includes(type);
}
export interface RefusedCall {
	readonly toolCallId: string;
	readonly type: RefusalOutcome;
}
/** Why the full native request is not the counterfactual one with only the refused calls' folds applied. */
export type RequestDeltaReason =
	| "attribution-unavailable" | "too-large" | "unattributed-fold" | "sibling-covered" | "sibling-absorbed" | "sibling-changed" | "summary-missing" | "message-changed";
/**
 * The structural check of the full native request against the counterfactual one. Counts and a
 * closed reason only; no message, summary or tool-argument content.
 */
export interface RequestDelta {
	/** `refused-folds-only` when the two requests differ only by the refused calls' own folds. */
	readonly verdict: "refused-folds-only" | "other";
	readonly reason?: RequestDeltaReason;
	/** Folds the refused calls created in the full preview. */
	readonly refusedFolds: number;
	/** Entries those folds cover. */
	readonly coveredEntries: number;
	/** Counterfactual messages from covered entries, which the full request replaces with the refused summaries. */
	readonly removedMessages?: number;
	/** Index in the full request of the first message that differs from the expected one. */
	readonly mismatchAt?: number;
}
export interface NextRequestRecord extends RecordBase {
	readonly kind: "next-request";
	readonly toolCallIds: readonly string[];
	readonly bcp?: RequestHashes;
	readonly ours?: RequestHashes;
	/** Calls in this batch that billion-context-pi refused with an ending only it has. */
	readonly refused?: readonly RefusedCall[];
	/**
	 * The comparison of billion-context-pi's request with a native preview of the same batch that
	 * omits the refused calls. Present when the batch has refused calls and `diffs` is a plain diff.
	 */
	readonly counterfactual?: { readonly diffs: readonly ParityDiff[]; readonly delta?: RequestDelta };
	/**
	 * The counterfactual preview's request evidence, in the same form as `ours`. The report recomputes
	 * the counterfactual comparison from it, so a register entry can explain a known difference that
	 * the counterfactual shares with the full request. Hashes only, like `ours`.
	 */
	readonly counterfactualOurs?: RequestHashes;
}
export type ParityRecord = CompressRecord | NextRequestRecord;

const STORE_DIRS = ["fold-parity", "v1", "sessions"] as const;
export class ParityStoreError extends Error {
	constructor(reason: string) { super(`Unsafe parity store: ${reason}`); }
}
function sessionFileName(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/u.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Invalid parity session id");
	return `${sessionId}.jsonl`;
}
export function paritySessionFile(agentDir: string, sessionId: string): string {
	return path.join(agentDir, ...STORE_DIRS, sessionFileName(sessionId));
}
const ownUid = () => process.getuid?.();
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/*
 * Race-safe traversal. Node has no openat(2), so each verified directory is held open and the
 * next name is resolved through its descriptor's magic link (`/proc/self/fd/<fd>/<name>`). That
 * path reaches the directory the descriptor holds even if its pathname has since been renamed
 * or replaced by a symlink, and the final name is opened with O_NOFOLLOW. Nothing is resolved
 * by pathname after it has been checked, so there is no window between check and open.
 */
const DESCRIPTOR_ROOTS = ["/proc/self/fd", "/dev/fd"] as const;
let descriptorRoot: Promise<string | undefined> | undefined;
/** The first root through which `<root>/<fd>/.` is the directory the descriptor holds, if any. */
function findDescriptorRoot(dir: FileHandle): Promise<string | undefined> {
	if (descriptorRoot) return descriptorRoot;
	const probe = (async () => {
		const held = await dir.stat();
		for (const root of DESCRIPTOR_ROOTS) {
			try {
				const reached = await stat(`${root}/${dir.fd}/.`);
				if (reached.dev === held.dev && reached.ino === held.ino) return root;
			} catch { /* Try the next root. */ }
		}
		return undefined;
	})();
	descriptorRoot = probe;
	// A probe that failed outright, rather than finding no root, is retried on the next open.
	void probe.catch(() => { if (descriptorRoot === probe) descriptorRoot = undefined; });
	return probe;
}
/** A directory held open and verified; names below it are resolved through `path`, its descriptor's magic link. */
interface HeldDir { readonly handle: FileHandle; readonly path: string }
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;
/** Open `name` below a held directory without following a symlink, and check that it is a private real directory. */
async function openChildDir(parent: string, name: string, create: boolean): Promise<FileHandle | undefined> {
	const child = `${parent}/${name}`;
	if (create) {
		try { await mkdir(child, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
	}
	let handle: FileHandle;
	try { handle = await open(child, DIR_FLAGS | constants.O_NOFOLLOW); } catch (error) {
		const code = errorCode(error);
		if (!create && code === "ENOENT") return undefined;
		// O_DIRECTORY | O_NOFOLLOW reports a symlink as ENOTDIR on Linux and ELOOP elsewhere.
		if (code === "ENOTDIR" || code === "ELOOP") throw new ParityStoreError(`${name} is not a real directory`);
		throw error;
	}
	try {
		const info = await handle.stat();
		const uid = ownUid();
		if (!info.isDirectory()) throw new ParityStoreError(`${name} is not a real directory`);
		if (uid !== undefined && info.uid !== uid) throw new ParityStoreError(`${name} is owned by another user`);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
/**
 * Verify, and optionally create, each directory the store owns below the agent directory, and
 * return the sessions directory held open. A symlinked, non-directory or foreign-owned component
 * is rejected rather than followed. Returns undefined when the store does not exist and `create`
 * is false. The caller closes the returned handle.
 */
async function openStoreDir(agentDir: string, create: boolean): Promise<HeldDir | undefined> {
	if (create) await mkdir(agentDir, { recursive: true, mode: 0o700 });
	let current: FileHandle | undefined;
	try { current = await open(agentDir, DIR_FLAGS); } catch (error) {
		if (!create && errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		const root = await findDescriptorRoot(current);
		if (!root) throw new ParityStoreError("this platform cannot open files relative to a verified directory");
		for (const part of STORE_DIRS) {
			const parent: FileHandle = current;
			current = undefined;
			try { current = await openChildDir(`${root}/${parent.fd}`, part, create); } finally { await parent.close(); }
			if (!current) return undefined;
		}
		const held: HeldDir = { handle: current, path: `${root}/${current.fd}` };
		current = undefined;
		return held;
	} finally { await current?.close(); }
}
/** Open a session file in a held directory without following a symlink; accept only a regular, singly linked, own file. */
async function openStoreFile(dir: HeldDir, name: string, flags: number, mode?: number): Promise<FileHandle> {
	let handle: FileHandle;
	try { handle = await open(`${dir.path}/${name}`, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode); } catch (error) {
		const code = errorCode(error);
		if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO") throw new ParityStoreError(`${name} is not a regular file`);
		throw error;
	}
	try {
		const info = await handle.stat();
		const uid = ownUid();
		if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid)) throw new ParityStoreError(`${name} is not a private regular file`);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
export async function appendParityRecord(agentDir: string, record: ParityRecord): Promise<void> {
	await appendParityRecords(agentDir, record.sessionId, [record]);
}
/** Append several records for one session in a single write. */
export async function appendParityRecords(agentDir: string, sessionId: string, records: readonly ParityRecord[]): Promise<void> {
	if (records.some((record) => record.sessionId !== sessionId)) throw new Error("Parity records belong to another session");
	const name = sessionFileName(sessionId);
	const db = new SessionDatabase(agentDir);
	const owner = randomUUID();
	try {
		// The same transaction that refuses erased ids takes a lease through all async writes.
		try { db.openSession(sessionId, null, owner); } catch (error) {
			if (error instanceof SessionErasedError) return;
			throw error;
		}
		const dir = await openStoreDir(agentDir, true);
		if (!dir) throw new Error("Parity store was not created");
		try {
			const handle = await openStoreFile(dir, name, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
			try { await appendFile(handle, records.map((record) => `${JSON.stringify(record)}\n`).join("")); } finally { await handle.close(); }
		} finally { await dir.handle.close(); }
	} finally { db.closeSession(sessionId, owner); db.close(); }
}
/** Ignore a torn final line and records of older schema versions, but surface other invalid records instead of claiming readiness. */
export async function readParityRecords(agentDir: string): Promise<ParityRecord[]> {
	const erasedAtStart = erasedSessionIds(agentDir);
	const dir = await openStoreDir(agentDir, false);
	if (!dir) return [];
	const records: ParityRecord[] = [];
	try {
		for (const file of (await readdir(dir.path)).sort()) {
			if (!file.endsWith(".jsonl") || erasedAtStart.has(file.slice(0, -6))) continue;
			const handle = await openStoreFile(dir, sessionFileName(file.slice(0, -6)), constants.O_RDONLY);
			let text: string;
			try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
			const lines = text.split("\n");
			for (const line of lines.slice(0, -1)) {
				if (!line) continue;
				const record = JSON.parse(line) as { v?: unknown; kind?: unknown; diffs?: unknown };
				if (typeof record.v === "number" && Number.isInteger(record.v) && record.v >= 1 && record.v < PARITY_RECORD_VERSION) continue;
				if (record.v !== PARITY_RECORD_VERSION || (record.kind !== "compress" && record.kind !== "next-request") || !Array.isArray(record.diffs)) throw new Error("Invalid parity record");
				records.push(record as ParityRecord);
			}
		}
	} finally { await dir.handle.close(); }
	const erased = erasedSessionIds(agentDir);
	return records.filter((record) => !erased.has(record.sessionId)).sort((a, b) => a.at.localeCompare(b.at));
}
