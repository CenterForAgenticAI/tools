import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	sanitizeDiagnosticText,
	sanitizeForJson,
	type DiagnosticEvent,
	type DiagnosticLevel,
	type DiagnosticPersistence,
} from "./diagnostics.js";
import { acquireMachineLease } from "./machine-lease.js";

export const DEFAULT_DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_RECORD_BYTES = 64 * 1024;
const MAX_PERSISTED_FIELDS = 64;
const DIAGNOSTIC_LEASE_TTL_MS = 5_000;
const LEVELS = new Set<DiagnosticLevel>(["info", "warning", "error"]);

export interface DiagnosticStorePaths {
	readonly path: string;
	readonly lockPath: string;
}

export function defaultDiagnosticStorePaths(): DiagnosticStorePaths {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? ".", ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const directory = join(agentDir, "pi-multi-account");
	return {
		path: join(directory, "diagnostics.ndjson"),
		lockPath: join(directory, "diagnostics.ndjson.lock"),
	};
}

function completePrefixLength(raw: string): number {
	return raw.endsWith("\n") ? raw.length : raw.lastIndexOf("\n") + 1;
}

function validTimestamp(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
	);
}

function projectFields(value: unknown): Readonly<Record<string, string>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const sanitized = sanitizeForJson(value);
	if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) {
		return undefined;
	}
	const fields: Record<string, string> = {};
	for (const [key, fieldValue] of Object.entries(sanitized).slice(
		0,
		MAX_PERSISTED_FIELDS,
	)) {
		if (typeof fieldValue !== "string") continue;
		fields[sanitizeDiagnosticText(key)] = sanitizeDiagnosticText(fieldValue);
	}
	return fields;
}

function projectEvent(value: unknown): DiagnosticEvent | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const allowed = new Set(["timestampMs", "level", "category", "message", "fields"]);
	if (Object.keys(candidate).some((key) => !allowed.has(key))) return undefined;
	if (!validTimestamp(candidate.timestampMs)) return undefined;
	if (typeof candidate.level !== "string" || !LEVELS.has(candidate.level as DiagnosticLevel)) {
		return undefined;
	}
	const fields = projectFields(candidate.fields);
	if (fields === undefined) return undefined;
	return {
		timestampMs: candidate.timestampMs,
		level: candidate.level as DiagnosticLevel,
		category: sanitizeDiagnosticText(candidate.category),
		message: sanitizeDiagnosticText(candidate.message),
		fields,
	};
}

function parseCompleteEvents(raw: string): readonly DiagnosticEvent[] {
	const prefix = raw.slice(0, completePrefixLength(raw));
	const events: DiagnosticEvent[] = [];
	for (const line of prefix.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = projectEvent(JSON.parse(line));
			if (event !== undefined) events.push(event);
		} catch {
			// A malformed or torn record is isolated from later complete records.
		}
	}
	return events;
}

function newestLinesWithin(
	events: readonly DiagnosticEvent[],
	budgetBytes: number,
): string {
	const retained: string[] = [];
	let used = 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const line = `${JSON.stringify(events[index])}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > budgetBytes - used) break;
		retained.push(line);
		used += bytes;
	}
	return retained.reverse().join("");
}

/** Machine-global, credential-free, bounded diagnostic event history. */
export class DiagnosticStore implements DiagnosticPersistence {
	readonly #path: string;
	readonly #lockPath: string;
	readonly #maxBytes: number;
	readonly #beforeCompactionRename: (() => void) | undefined;

	constructor(options: {
		readonly path?: string;
		readonly lockPath?: string;
		readonly maxBytes?: number;
		/** Test seam for a peer append immediately before the stable-tail sample. */
		readonly beforeCompactionRename?: () => void;
	} = {}) {
		const defaults = defaultDiagnosticStorePaths();
		this.#path = options.path ?? defaults.path;
		this.#lockPath = options.lockPath ?? defaults.lockPath;
		this.#maxBytes = options.maxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES;
		this.#beforeCompactionRename = options.beforeCompactionRename;
		if (
			!Number.isSafeInteger(this.#maxBytes) ||
			this.#maxBytes < 1_024 ||
			this.#maxBytes > 64 * 1024 * 1024
		) {
			throw new RangeError("maxBytes must be an integer from 1024 through 67108864.");
		}
	}

	path(): string {
		return this.#path;
	}

	readRecent(limit: number): readonly DiagnosticEvent[] {
		const safeLimit = Number.isSafeInteger(limit)
			? Math.max(0, Math.min(limit, 1_000))
			: 100;
		if (safeLimit === 0) return [];
		try {
			return parseCompleteEvents(readFileSync(this.#path, "utf8")).slice(-safeLimit);
		} catch {
			return [];
		}
	}

	append(event: DiagnosticEvent): boolean {
		try {
			const projected = projectEvent(event);
			if (projected === undefined) return false;
			const line = `${JSON.stringify(projected)}\n`;
			if (Buffer.byteLength(line, "utf8") > MAX_DIAGNOSTIC_RECORD_BYTES) {
				return false;
			}
			const directory = dirname(this.#path);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			let separator = "";
			try {
				const current = readFileSync(this.#path, "utf8");
				if (current.length > 0 && !current.endsWith("\n")) separator = "\n";
			} catch {
				// appendFileSync creates a missing file below.
			}
			appendFileSync(this.#path, `${separator}${line}`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(this.#path, 0o600);
			this.#compactIfNeeded();
			return true;
		} catch {
			return false;
		}
	}

	#compactIfNeeded(): boolean {
		try {
			if (statSync(this.#path).size <= this.#maxBytes) return false;
		} catch {
			return false;
		}
		let lease: ReturnType<typeof acquireMachineLease>;
		try {
			lease = acquireMachineLease({
				lockPath: this.#lockPath,
				ttlMs: DIAGNOSTIC_LEASE_TTL_MS,
				// A wedged lock would otherwise stop compaction and let the
				// diagnostics log grow past its bound forever.
				reclaimMalformed: true,
			});
		} catch {
			return false;
		}
		if (lease === undefined) return false;
		let temporaryPath: string | undefined;
		try {
			if (!lease.renew()) return false;
			const initialRaw = readFileSync(this.#path, "utf8");
			const prefixLength = completePrefixLength(initialRaw);
			const completePrefix = initialRaw.slice(0, prefixLength);
			const events = parseCompleteEvents(completePrefix);
			this.#beforeCompactionRename?.();

			let tail: string | undefined;
			for (let snapshot = 0; snapshot < 3; snapshot += 1) {
				const before = statSync(this.#path);
				const latestRaw = readFileSync(this.#path, "utf8");
				const after = statSync(this.#path);
				if (
					before.dev !== after.dev ||
					before.ino !== after.ino ||
					before.size !== after.size
				) {
					continue;
				}
				if (!latestRaw.startsWith(completePrefix)) return false;
				tail = latestRaw.slice(prefixLength);
				break;
			}
			if (tail === undefined) return false;
			const tailBytes = Buffer.byteLength(tail, "utf8");
			if (tailBytes > this.#maxBytes) return false;
			const targetBytes = Math.min(
				Math.floor(this.#maxBytes / 2),
				this.#maxBytes - tailBytes,
			);
			const compacted = newestLinesWithin(events, targetBytes);
			const encoded = compacted + tail;
			if (Buffer.byteLength(encoded, "utf8") > this.#maxBytes) return false;
			temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
			writeFileSync(temporaryPath, encoded, { encoding: "utf8", mode: 0o600 });
			renameSync(temporaryPath, this.#path);
			temporaryPath = undefined;
			chmodSync(this.#path, 0o600);
			return true;
		} catch {
			return false;
		} finally {
			if (temporaryPath !== undefined) {
				try {
					unlinkSync(temporaryPath);
				} catch {
					// Best-effort cleanup of an uncommitted compacted snapshot.
				}
			}
			lease.release();
		}
	}
}
