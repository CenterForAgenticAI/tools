/**
 * Read and write Pi session files without the Pi SDK: the facts the archive
 * manifest keeps, and the stub an archived session leaves behind.
 *
 * A stub is a small, valid Pi session at the original path, so Pi's session
 * list (/resume, --resume) still shows it with its name, folder, first prompt
 * and date. It holds the original header, the thinking level (so Pi does not
 * append one when it opens the stub), the name, the first prompt, and last an
 * archive notice: a custom_message that tells the reader how to restore the
 * session and carries where the full file went. Any line after the notice
 * was added after archiving; a stub with such lines is "grown" and a restore
 * never replaces it.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** customType of the archive notice; only pi-profile writes it. */
export const ARCHIVE_MARK = "pi-profile/archived";
/** Prompts in the manifest and the stub are cut to this many characters. */
export const PROMPT_LIMIT = 500;
/** Pi's session format version; an older header makes Pi rewrite the file on open. */
const SESSION_VERSION = 3;

export interface SessionFacts {
	readonly id: string;
	/** The working directory the session ran in (the header's cwd). */
	readonly cwd: string;
	readonly name: string | undefined;
	readonly firstPrompt: string | undefined;
	readonly lastPrompt: string | undefined;
	/** ISO time from the header. */
	readonly created: string;
	/** ISO time of the last user or assistant message, as Pi's session list computes it. */
	readonly modified: string;
	readonly thinkingLevel: string | undefined;
	/** The header line to put at the top of a stub. */
	readonly headerLine: string;
}

/** Where the full session went, as the stub and the manifest record it. */
export interface StubDetails {
	readonly schemaVersion: 1;
	/** The archived session's id. A fork of a stub copies the notice under a new id, so it is no stub. */
	readonly sessionId: string;
	/** The host that archived it. */
	readonly host: string;
	/** Path of the compressed copy, relative to this host's archive folder. */
	readonly archive: string;
	/** SHA-256 of the full, uncompressed session file. */
	readonly sha256: string;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface Stub {
	readonly details: StubDetails;
	/** True when lines follow the archive notice: Pi wrote to the stub after it was archived. */
	readonly grown: boolean;
	readonly id: string;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function parseLine(line: string): Json | undefined {
	if (line.trim() === "") return undefined;
	try {
		const v = JSON.parse(line) as unknown;
		return isRecord(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function cut(text: string): string {
	const chars = [...text];
	return chars.length <= PROMPT_LIMIT ? text : chars.slice(0, PROMPT_LIMIT).join("");
}

/** The text of a message's content, as Pi's session list reads it. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join(" ");
}

function activityTime(entry: Json): number | undefined {
	const m = entry.message;
	if (!isRecord(m) || !("content" in m) || (m.role !== "user" && m.role !== "assistant")) return undefined;
	if (typeof m.timestamp === "number") return m.timestamp;
	const t = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	return Number.isNaN(t) ? undefined : t;
}

/** The facts of a Pi session file, or undefined when its first entry is not a session header. */
export function sessionFacts(text: string): SessionFacts | undefined {
	let header: Json | undefined;
	let headerLine = "";
	let name: string | undefined;
	let first: string | undefined;
	let last: string | undefined;
	let latest: number | undefined;
	let thinking: string | undefined;
	for (const line of text.split("\n")) {
		const e = parseLine(line);
		if (e === undefined) continue;
		if (header === undefined) {
			if (e.type !== "session" || typeof e.id !== "string") return undefined;
			header = e;
			headerLine = line.trim();
			continue;
		}
		if (e.type === "session_info") name = typeof e.name === "string" && e.name.trim() !== "" ? cut(e.name.trim()) : undefined;
		if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") thinking = e.thinkingLevel;
		if (e.type !== "message") continue;
		const t = activityTime(e);
		if (t !== undefined) latest = Math.max(latest ?? 0, t);
		const m = e.message;
		if (!isRecord(m) || m.role !== "user") continue;
		const words = textOf(m.content);
		if (words === "") continue;
		first ??= cut(words);
		last = cut(words);
	}
	if (header === undefined) return undefined;
	const created = typeof header.timestamp === "string" && !Number.isNaN(Date.parse(header.timestamp)) ? new Date(header.timestamp).toISOString() : new Date(0).toISOString();
	const modified = latest !== undefined && latest > 0 ? new Date(latest).toISOString() : created;
	if (header.version !== SESSION_VERSION) {
		const h: Json = { type: "session", version: SESSION_VERSION, id: header.id, timestamp: header.timestamp, cwd: header.cwd };
		if (typeof header.parentSession === "string") h.parentSession = header.parentSession;
		headerLine = JSON.stringify(h);
	}
	return { id: header.id as string, cwd: typeof header.cwd === "string" ? header.cwd : "", name, firstPrompt: first, lastPrompt: last, created, modified, thinkingLevel: thinking, headerLine };
}

/** The restore instruction a stub shows when Pi opens it. */
export function restoreNotice(id: string): string {
	return "This session was archived by pi-profile to save disk space. Only its first prompt is shown here. " +
		"Its full history is kept in the archive. To get it back, quit Pi and run: pi-profile sessions restore " + id +
		" , then open the session again. (Inside Pi, /resume restores it for you.) Anything you add here is kept as a separate copy.";
}

/** The stub text for an archived session. */
export function buildStub(f: SessionFacts, d: StubDetails, archivedAt: string): string {
	const at = Date.parse(f.modified);
	const lines: Json[] = [];
	let parent: string | null = null;
	let n = 0;
	const add = (entry: Json): void => {
		const id = "a7c" + (++n).toString(16).padStart(5, "0");
		lines.push({ ...entry, id, parentId: parent, timestamp: f.modified });
		parent = id;
	};
	add({ type: "thinking_level_change", thinkingLevel: f.thinkingLevel ?? "off" });
	if (f.name !== undefined) add({ type: "session_info", name: f.name });
	if (f.firstPrompt !== undefined) add({ type: "message", message: { role: "user", content: [{ type: "text", text: f.firstPrompt }], timestamp: at } });
	add({ type: "custom_message", customType: ARCHIVE_MARK, content: restoreNotice(f.id), display: true, details: { ...d, archivedAt } });
	return [f.headerLine, ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n";
}

const SHA256 = /^[0-9a-f]{64}$/;
const HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** True when rel is a safe relative path below an archive folder, ending in .jsonl.zst. */
export function isArchiveRel(rel: unknown): rel is string {
	if (typeof rel !== "string" || rel.length > 4096 || CONTROL.test(rel) || !rel.endsWith(".jsonl.zst")) return false;
	const parts = rel.split("/");
	return parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.startsWith("."));
}

/** StubDetails copied field by field from untrusted JSON; undefined when any field is wrong. */
export function parseStubDetails(raw: unknown): StubDetails | undefined {
	if (!isRecord(raw) || raw.schemaVersion !== 1) return undefined;
	const { sessionId, host, archive, sha256, size, mtimeMs } = raw;
	if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 256 || CONTROL.test(sessionId)) return undefined;
	if (typeof host !== "string" || !HOST.test(host) || !isArchiveRel(archive) || typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
	return { schemaVersion: 1, sessionId, host, archive, sha256, size, mtimeMs };
}

/**
 * A stub's archive notice is in its first lines: the header, the thinking
 * level, the name, the first prompt (at most PROMPT_LIMIT characters) and the
 * notice. Lines Pi adds later go after it, so this many bytes from the start
 * of a file always reach the notice, however large the file has grown.
 */
export const STUB_HEAD = 256 * 1024;

/**
 * The stub in the first bytes of a file of the given size, whatever that
 * size. A line the head cuts off is not valid JSON, so it is skipped like
 * any other bad line. A file larger than its head has lines after the
 * notice, so it is grown.
 */
export function readStubHead(head: Buffer, size: number): Stub | undefined {
	const stub = readStub(head.toString("utf8"));
	return stub === undefined || head.length >= size ? stub : { ...stub, grown: true };
}

/** The stub at path, read from its first STUB_HEAD bytes; undefined when the file is no stub. */
export function readStubFile(path: string): Stub | undefined {
	const fd = openSync(path, "r");
	try {
		return readStubFd(fd, fstatSync(fd).size);
	} finally {
		closeSync(fd);
	}
}

/** The first STUB_HEAD bytes of an open file of the given size (fewer when it is shorter). */
export function readHead(fd: number, size: number): Buffer {
	const head = Buffer.alloc(Math.min(size, STUB_HEAD));
	let off = 0;
	while (off < head.length) {
		const n = readSync(fd, head, off, head.length - off, off);
		if (n === 0) break;
		off += n;
	}
	return head.subarray(0, off);
}

/** The stub in an open file of the given size, read from its first STUB_HEAD bytes. */
export function readStubFd(fd: number, size: number): Stub | undefined {
	return readStubHead(readHead(fd, size), size);
}

/** The stub in text, or undefined when text is not a pi-profile stub. */
export function readStub(text: string): Stub | undefined {
	const lines = text.split("\n");
	let id: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const e = parseLine(lines[i] ?? "");
		if (e === undefined) continue;
		if (id === undefined) {
			if (e.type !== "session" || typeof e.id !== "string") return undefined;
			id = e.id;
			continue;
		}
		if (e.type !== "custom_message" || e.customType !== ARCHIVE_MARK) continue;
		const details = parseStubDetails(e.details);
		if (details === undefined || details.sessionId !== id) return undefined;
		const grown = lines.slice(i + 1).some((l) => l.trim() !== "");
		return { details, grown, id };
	}
	return undefined;
}

/**
 * The archive notice in a session, read from its first lines: the id of the
 * archived session it names, and whether that is this session (a stub) or
 * another (a fork or copy of a stub). Undefined when there is no notice.
 */
export function archivedNotice(text: string): { sessionId: string; own: boolean } | undefined {
	let id: string | undefined;
	for (const line of text.split("\n")) {
		const e = parseLine(line);
		if (e === undefined) continue;
		if (id === undefined) {
			if (e.type !== "session" || typeof e.id !== "string") return undefined;
			id = e.id;
			continue;
		}
		if (e.type !== "custom_message" || e.customType !== ARCHIVE_MARK) continue;
		const d = parseStubDetails(e.details);
		return d === undefined ? undefined : { sessionId: d.sessionId, own: d.sessionId === id };
	}
	return undefined;
}

/**
 * A checkout's origin remote as host/path: lower-case host, no user,
 * password, port, scheme or .git. Undefined for a local path or a URL it
 * cannot read, so a local remote never looks like a forge project.
 */
export function normalizeForgeKey(url: string): string | undefined {
	const u = url.trim();
	if (u === "" || CONTROL.test(u)) return undefined;
	let host: string | undefined;
	let path: string | undefined;
	const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d+)?\/(.+)$/i.exec(u);
	if (withScheme !== null) {
		if (!["ssh", "git", "http", "https", "git+ssh", "ssh+git"].includes((withScheme[1] ?? "").toLowerCase())) return undefined;
		host = withScheme[2];
		path = withScheme[3];
	} else if (!u.includes("://")) {
		const scp = /^(?:[^@/:]+@)?([^/:@]+):(.+)$/.exec(u);
		if (scp === null || (scp[1] ?? "").length < 2) return undefined;
		host = scp[1];
		path = scp[2];
	}
	if (host === undefined || path === undefined) return undefined;
	const parts = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter((p) => p !== "");
	if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) return undefined;
	return host.toLowerCase() + "/" + parts.join("/");
}
