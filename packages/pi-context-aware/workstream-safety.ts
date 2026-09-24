/** Privacy, bounds, and non-blocking safety helpers for workstream projections. */

import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	MAX_PINNED_VERBATIM_BLOCK_CHARS,
	type ActivityEvent,
	type RegistryProjection,
	type WorkstreamIdentity,
	type WorkstreamRef,
	type WorkstreamSnapshot,
} from "./workstream-schema.js";

export const MAX_ACTIVITY_SUMMARY_LENGTH = 160;
export const MAX_NOTIFICATION_TITLE_LENGTH = 120;
export const MAX_NOTIFICATION_BODY_LENGTH = 240;
export const MAX_DIAGNOSTIC_LENGTH = 240;
export const MAX_TRACKED_DIAGNOSTIC_KEYS = 256;

export interface RedactionOptions {
	readonly home?: string;
	readonly cwd?: string;
	readonly maxLength?: number;
	readonly maxDepth?: number;
	readonly maxItems?: number;
}

export interface PinnedVerbatimBlockRedaction {
	readonly value: string;
	readonly changed: boolean;
}

/** Redact a pinned block once at set time without silently truncating input. */
export function redactPinnedVerbatimBlock(value: string, options: RedactionOptions = {}): PinnedVerbatimBlockRedaction {
	if (typeof value !== "string") throw new Error("pinned verbatim block must be a string");
	if (value.length > MAX_PINNED_VERBATIM_BLOCK_CHARS) {
		throw new Error(`pinned verbatim block exceeds MAX_PINNED_VERBATIM_BLOCK_CHARS (${MAX_PINNED_VERBATIM_BLOCK_CHARS} characters)`);
	}
	const redacted = redactText(value, { ...options, maxLength: MAX_PINNED_VERBATIM_BLOCK_CHARS });
	return { value: redacted, changed: redacted !== value };
}

function bounded(value: string, maxLength: number): string {
	return value.slice(0, maxLength);
}

function normalizeRoot(value: string): string {
	return path.resolve(value).replace(/[\\/]+$/, "");
}

/**
 * An absolute path, anchored so it cannot begin at a slash inside a relative one.
 *
 * The leading group is the required left boundary: start of input, or a
 * character that cannot be part of a path. Without it, `tests/unit/x.ts` matched
 * from its interior slash, was read as the absolute path `/unit/x.ts`, and was
 * rewritten to `tests<path>//unit/x.ts` — corrupting the recorded seed that is
 * meant to carry a task across a compaction (issue #12).
 *
 * The boundary is a capture rather than a lookbehind so the matched prefix is
 * re-emitted verbatim, keeping the surrounding text byte-identical.
 *
 * At least one interior separator is required, so a single-segment token such as
 * the slash command `/focus` is left alone. That deliberately also leaves `/tmp`
 * unredacted: a one-segment root carries no user identity, and this extension's
 * own text is full of slash commands, so the opposite trade would corrupt far
 * more than it protects.
 */
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`([{<=,;:|])((?:[A-Za-z]:[\\/]|\/)(?:[^\s/\\]+[\\/])+[^\s]*)/g;

/** Redact a path without exposing the user's home or arbitrary absolute roots. */
export function redactPath(value: string, roots: Pick<RedactionOptions, "home" | "cwd"> = {}): string {
	let result = value.replaceAll("\\", "/");
	const cwd = roots.cwd ? normalizeRoot(roots.cwd).replaceAll("\\", "/") : undefined;
	const home = roots.home ? normalizeRoot(roots.home).replaceAll("\\", "/") : undefined;
	if (cwd && (result === cwd || result.startsWith(`${cwd}/`))) result = `<cwd>${result.slice(cwd.length)}`;
	if (home && (result === home || result.startsWith(`${home}/`))) result = `<home>${result.slice(home.length)}`;
	if (/^(?:[A-Za-z]:\/|\/)/.test(result)) {
		// Drop the empty leading segment before taking the tail, so a path with three
		// or fewer segments cannot produce `<path>//…` (issue #12).
		const segments = result.split("/").filter((segment) => segment.length > 0);
		result = `<path>/${segments.slice(-3).join("/")}`;
	}
	return bounded(result, 240);
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})/gi,
	/(?:sk|pk)-[A-Za-z0-9_-]{8,}/gi,
	/(?:api[_-]?key|token|password|passwd|secret|authorization|credential|credentials|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
	/(?:Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
];

const TRUNCATED_SECRET_MARKERS = [
	"ghp_",
	"gho_",
	"ghu_",
	"ghs_",
	"ghr_",
	"github_pat_",
	"glpat-",
	"akia",
	"asia",
	"sk-",
	"pk-",
	"bearer ",
	"-----begin ",
] as const;

const PARTIAL_SECRET_MARKERS = [
	"ghp_",
	"gho_",
	"ghu_",
	"ghs_",
	"ghr_",
	"github_pat_",
	"glpat-",
	"akia",
	"asia",
	"sk-",
	"pk-",
] as const;

const MAX_CREDENTIAL_EVIDENCE_LENGTH = 64;

const SENSITIVE_ASSIGNMENT_KEYS = [
	"api_key",
	"api-key",
	"token",
	"password",
	"passwd",
	"secret",
	"authorization",
	"credential",
	"credentials",
	"cookie",
] as const;

function hasWordBefore(value: string, index: number): boolean {
	const previous = value[index - 1];
	return previous !== undefined && /[a-z0-9_]/i.test(previous);
}

function assignmentValueMayBeTruncated(value: string): boolean {
	const trimmed = value.trimStart();
	if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return !trimmed.slice(1).includes(trimmed[0] ?? "");
	return !/[\s,;]/.test(trimmed);
}

function markerValueMayBeTruncated(value: string, index: number, marker: string): boolean {
	const suffix = value.slice(index + marker.length);
	if (marker === "-----begin ") {
		const header = value.slice(index).toLowerCase();
		if (/-----end [a-z ]+ private key-----/i.test(header)) return false;
		return header.includes("private key") || header.endsWith("private k") || header.endsWith("private ") || header.endsWith("private");
	}
	if (marker === "akia" || marker === "asia") return /^[0-9a-z]*$/i.test(suffix);
	if (marker === "bearer ") return /^[a-z0-9._~+/=-]*$/i.test(suffix);
	return /^[a-z0-9_-]*$/i.test(suffix);
}

interface BoundedNormalizedText {
	readonly value: string;
	/** Source is already limited to the caller's output bound. */
	readonly source: string;
	/** Each normalized character points back to its source character. */
	readonly sourceOffsets: readonly number[];
}

function normalizeBoundedInput(value: string, maxLength: number): BoundedNormalizedText {
	const source = stripVTControlCharacters(value.slice(0, maxLength));
	const normalized: string[] = [];
	const sourceCharacterOffsets: number[] = [];
	for (let sourceIndex = 0; sourceIndex < source.length;) {
		const character = String.fromCodePoint(source.codePointAt(sourceIndex) ?? 0);
		const width = character.length;
		sourceIndex += width;
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || (code >= 127 && code <= 159)) continue;
		if (/\s/.test(character)) {
			if (normalized.at(-1) === " ") continue;
			normalized.push(" ");
			sourceCharacterOffsets.push(sourceIndex - width);
			continue;
		}
		normalized.push(character);
		sourceCharacterOffsets.push(sourceIndex - width);
	}
	let start = 0;
	let end = normalized.length;
	while (start < end && normalized[start] === " ") start += 1;
	while (end > start && normalized[end - 1] === " ") end -= 1;
	const retained = normalized.slice(start, end);
	const sourceOffsets: number[] = [];
	for (let index = 0; index < retained.length; index += 1) {
		const character = retained[index] ?? "";
		for (let offset = 0; offset < character.length; offset += 1) {
			sourceOffsets.push(sourceCharacterOffsets[start + index] ?? 0);
		}
	}
	return {
		value: retained.join(""),
		source,
		sourceOffsets,
	};
}

function completeCredentialAt(value: BoundedNormalizedText, index: number, marker: string): boolean {
	const sourceIndex = value.sourceOffsets[index];
	if (sourceIndex === undefined) return false;
	const candidate = value.source.slice(sourceIndex, sourceIndex + MAX_CREDENTIAL_EVIDENCE_LENGTH).toLowerCase();
	if (["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].includes(marker)) return new RegExp(`^${marker}[a-z0-9]{20,}`, "i").test(candidate);
	if (marker === "github_pat_") return /^github_pat_[a-z0-9_]{20,}/i.test(candidate);
	if (marker === "glpat-") return /^glpat-[a-z0-9_-]{20,}/i.test(candidate);
	if (marker === "akia" || marker === "asia") return /^(?:akia|asia)[0-9a-z]{16}/i.test(candidate);
	if (marker === "sk-" || marker === "pk-") return new RegExp(`^${marker}[a-z0-9_-]{8,}`, "i").test(candidate);
	if (marker === "bearer ") return /^bearer\s+[a-z0-9._~+/=-]{8,}/i.test(candidate);
	if (marker === "-----begin ") return /^-----begin [a-z ]*private key-----/i.test(candidate);
	return false;
}

function markerMayBeRemoved(value: BoundedNormalizedText, index: number, marker: string): boolean {
	return !hasWordBefore(value.value, index) || completeCredentialAt(value, index, marker) || markerValueMayBeTruncated(value.value.toLowerCase(), index, marker);
}

function partialSecretMarkerIndex(value: string): number {
	for (const marker of PARTIAL_SECRET_MARKERS) {
		for (let length = marker.length - 1; length >= 2; length -= 1) {
			if (!value.endsWith(marker.slice(0, length))) continue;
			const index = value.length - length;
			if (!hasWordBefore(value, index)) return index;
		}
	}
	return -1;
}

function removeTruncatedSecret(value: BoundedNormalizedText, wasTruncated: boolean): string {
	if (!wasTruncated) return value.value;
	const lower = value.value.toLowerCase();
	let markerIndex = partialSecretMarkerIndex(lower);
	for (const marker of TRUNCATED_SECRET_MARKERS) {
		const index = lower.lastIndexOf(marker);
		if (index >= 0 && markerValueMayBeTruncated(lower, index, marker) && markerMayBeRemoved(value, index, marker)) {
			markerIndex = Math.max(markerIndex, index);
		}
	}
	for (const key of SENSITIVE_ASSIGNMENT_KEYS) {
		let index = lower.lastIndexOf(key);
		while (index >= 0) {
			const assignment = lower.slice(index + key.length).match(/^\s*[:=]\s*/);
			const sourceIndex = value.sourceOffsets[index];
			const sourceAssignment = sourceIndex === undefined ? "" : value.source.slice(sourceIndex + key.length, sourceIndex + key.length + MAX_CREDENTIAL_EVIDENCE_LENGTH).toLowerCase();
			if (assignment && assignmentValueMayBeTruncated(lower.slice(index + key.length + assignment[0].length)) &&
				(!hasWordBefore(lower, index) || assignmentValueMayBeTruncated(sourceAssignment))) {
				markerIndex = Math.max(markerIndex, index);
				break;
			}
			if (index === 0) break;
			index = lower.lastIndexOf(key, index - 1);
		}
	}
	return markerIndex < 0 ? value.value : `${value.value.slice(0, markerIndex)}[REDACTED]`;
}

/**
 * Scrub credentials, controls, absolute paths, and unbounded text before any
 * activity, context, diagnostic, registry, or terminal projection receives it.
 */
export function redactText(value: string, options: RedactionOptions = {}): string {
	const maxLength = Math.max(0, Math.floor(options.maxLength ?? MAX_DIAGNOSTIC_LENGTH));
	const wasTruncated = value.length > maxLength;
	const normalized = normalizeBoundedInput(value, maxLength);
	let result = bounded(removeTruncatedSecret(normalized, wasTruncated), maxLength);
	for (const pattern of SECRET_PATTERNS) result = bounded(result.replace(pattern, "[REDACTED]"), maxLength);
	if (options.cwd) result = bounded(result.replaceAll(normalizeRoot(options.cwd).replaceAll("\\", "/"), "<cwd>"), maxLength);
	if (options.home) result = bounded(result.replaceAll(normalizeRoot(options.home).replaceAll("\\", "/"), "<home>"), maxLength);
	result = bounded(result.replace(ABSOLUTE_PATH_PATTERN, (match, prefix: string, target: string) => `${prefix}${redactPath(target, options)}`), maxLength);
	return bounded(removeTruncatedSecret(normalizeBoundedInput(result, maxLength), wasTruncated), maxLength);
}

const SENSITIVE_KEY_PATTERN = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret)/i;

export type RedactedValue = string | number | boolean | null | RedactedValue[] | { readonly [key: string]: RedactedValue };

/** Recursively redact untrusted structured details before diagnostics or projections. */
export function redactUnknown(value: unknown, options: RedactionOptions = {}, depth = 0): RedactedValue {
	const maxDepth = Math.max(1, options.maxDepth ?? 5);
	const maxItems = Math.max(1, options.maxItems ?? 50);
	if (depth >= maxDepth) return "[REDACTED]";
	if (typeof value === "string") return redactText(value, options);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => redactUnknown(item, options, depth + 1));
	if (typeof value === "object") {
		const output: { [key: string]: RedactedValue } = {};
		for (const [key, item] of Object.entries(value).slice(0, maxItems)) {
			const safeKey = redactText(key, { maxLength: 96 });
			const oversizedKey = key.length > 96;
			output[safeKey] = oversizedKey || SENSITIVE_KEY_PATTERN.test(safeKey) ? "[REDACTED]" : redactUnknown(item, options, depth + 1);
		}
		return output;
	}
	return "[REDACTED]";
}

function sanitizeIdentity(identity: WorkstreamIdentity, options: RedactionOptions): WorkstreamIdentity {
	const terminal = identity.terminal === undefined ? undefined : {
		...identity.terminal,
		terminalId: redactText(identity.terminal.terminalId, { ...options, maxLength: 128 }) as typeof identity.terminal.terminalId,
		...(identity.terminal.location === undefined ? {} : { location: redactPath(identity.terminal.location, options) }),
	};
	return {
		...identity,
		workstreamId: redactText(identity.workstreamId, { ...options, maxLength: 128 }) as typeof identity.workstreamId,
		piSessionId: redactText(identity.piSessionId, { ...options, maxLength: 128 }) as typeof identity.piSessionId,
		...(identity.intercomConnectionId === undefined ? {} : { intercomConnectionId: redactText(identity.intercomConnectionId, { ...options, maxLength: 128 }) as typeof identity.intercomConnectionId }),
		...(terminal === undefined ? {} : { terminal }),
	};
}

export function sanitizeRef(ref: WorkstreamRef, options: RedactionOptions = {}): WorkstreamRef {
	return {
		kind: ref.kind,
		value: redactText(ref.value, { ...options, maxLength: 240 }),
	};
}

export function sanitizeActivityEvent(event: ActivityEvent, options: RedactionOptions = {}): ActivityEvent {
	return {
		...event,
		...sanitizeIdentity(event, options),
		summary: redactText(event.summary, { ...options, maxLength: MAX_ACTIVITY_SUMMARY_LENGTH }),
		sourceEntryIds: event.sourceEntryIds.slice(0, 20).map((entryId) => redactText(entryId, { ...options, maxLength: 96 })),
	};
}

export function sanitizeRegistryProjection(projection: RegistryProjection, options: RedactionOptions = {}): RegistryProjection {
	return {
		...projection,
		...sanitizeIdentity(projection, options),
		projectKey: redactText(projection.projectKey, { ...options, maxLength: 240 }),
		objective: redactText(projection.objective, { ...options, maxLength: 240 }),
		refs: projection.refs.slice(0, 50).map((ref) => sanitizeRef(ref, options)),
	};
}

export interface ContextEnvelope {
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly revision: number;
	readonly objective: string;
	readonly goals: readonly string[];
	readonly refs: readonly WorkstreamRef[];
	readonly boundaries: readonly string[];
}

export function sanitizeContextEnvelope(envelope: ContextEnvelope, options: RedactionOptions = {}): ContextEnvelope {
	return {
		workstreamId: redactText(envelope.workstreamId, { ...options, maxLength: 128 }),
		piSessionId: redactText(envelope.piSessionId, { ...options, maxLength: 128 }),
		revision: envelope.revision,
		objective: redactText(envelope.objective, { ...options, maxLength: 320 }),
		goals: envelope.goals.slice(0, 20).map((goal) => redactText(goal, { ...options, maxLength: 240 })),
		refs: envelope.refs.slice(0, 50).map((ref) => sanitizeRef(ref, options)),
		boundaries: envelope.boundaries.slice(0, 20).map((boundary) => redactText(boundary, { ...options, maxLength: 240 })),
	};
}

export interface NotificationInput {
	readonly title: string;
	readonly body: string;
}

export type SanitizedNotification = NotificationInput;

export function sanitizeNotification(notification: NotificationInput, options: RedactionOptions = {}): SanitizedNotification {
	return {
		title: redactText(notification.title, { ...options, maxLength: MAX_NOTIFICATION_TITLE_LENGTH }),
		body: redactText(notification.body, { ...options, maxLength: MAX_NOTIFICATION_BODY_LENGTH }),
	};
}

export type AdapterHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface AdapterHealth {
	readonly adapter: string;
	readonly status: AdapterHealthStatus;
	readonly failureCount: number;
	readonly lastCheckedAt?: number;
	readonly lastError?: string;
}

export interface DiagnosticInput {
	readonly adapter: string;
	readonly code: string;
	readonly detail?: unknown;
}

export interface RateLimitedDiagnostics {
	record(input: DiagnosticInput): boolean;
	markUnavailable(adapter: string, detail: unknown): AdapterHealth;
	markHealthy(adapter: string): AdapterHealth;
	getHealth(adapter: string): AdapterHealth;
	snapshotHealth(): readonly AdapterHealth[];
}

export interface RateLimitedDiagnosticsOptions {
	readonly clock?: () => number;
	readonly windowMs?: number;
	readonly maxPerWindow?: number;
	readonly emit?: (line: string) => void;
}

interface MutableHealth {
	adapter: string;
	status: AdapterHealthStatus;
	failureCount: number;
	lastCheckedAt?: number;
	lastError?: string;
}

export function scrubDiagnosticDetail(value: unknown): string {
	const redacted = redactUnknown(value, { maxDepth: 4, maxItems: 20, maxLength: MAX_DIAGNOSTIC_LENGTH });
	const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
	return redactText(serialized ?? "[REDACTED]", { maxLength: MAX_DIAGNOSTIC_LENGTH });
}

/**
 * A bounded best-effort sink. Recording a diagnostic never throws, and each
 * adapter/code pair can emit only a small number of scrubbed lines per window.
 */
export function createRateLimitedDiagnostics(options: RateLimitedDiagnosticsOptions = {}): RateLimitedDiagnostics {
	const clock = options.clock ?? Date.now;
	const windowMs = Math.max(1, options.windowMs ?? 60_000);
	const maxPerWindow = Math.max(1, Math.floor(options.maxPerWindow ?? 3));
	const emit = options.emit ?? (() => undefined);
	const counts = new Map<string, { startedAt: number; count: number }>();
	const health = new Map<string, MutableHealth>();

	function getMutable(adapter: string): MutableHealth {
		const current = health.get(adapter);
		if (current) return current;
		if (health.size >= MAX_TRACKED_DIAGNOSTIC_KEYS) {
			const oldest = health.keys().next().value;
			if (typeof oldest === "string") health.delete(oldest);
		}
		const created: MutableHealth = { adapter, status: "unknown", failureCount: 0 };
		health.set(adapter, created);
		return created;
	}

	function copy(value: MutableHealth): AdapterHealth {
		return { ...value };
	}

	function record(input: DiagnosticInput): boolean {
		try {
			const adapter = redactText(input.adapter, { maxLength: 64 });
			const code = redactText(input.code, { maxLength: 64 });
			const key = `${adapter}:${code}`;
			const now = clock();
			if (!counts.has(key) && counts.size >= MAX_TRACKED_DIAGNOSTIC_KEYS) {
				const oldest = counts.keys().next().value;
				if (typeof oldest === "string") counts.delete(oldest);
			}
			const prior = counts.get(key);
			const current = !prior || now - prior.startedAt >= windowMs ? { startedAt: now, count: 0 } : prior;
			if (current.count >= maxPerWindow) {
				counts.set(key, current);
				return false;
			}
			current.count += 1;
			counts.set(key, current);
			const state = getMutable(adapter);
			state.status = "degraded";
			state.failureCount = Math.min(1_000, state.failureCount + 1);
			state.lastCheckedAt = now;
			state.lastError = scrubDiagnosticDetail(input.detail ?? code);
			emit(redactText(JSON.stringify({ adapter, code, detail: state.lastError, at: now }), { maxLength: MAX_DIAGNOSTIC_LENGTH }));
			return true;
		} catch {
			return false;
		}
	}

	function markUnavailable(adapter: string, detail: unknown): AdapterHealth {
		const state = getMutable(redactText(adapter, { maxLength: 64 }));
		state.status = "unavailable";
		state.failureCount = Math.min(1_000, state.failureCount + 1);
		state.lastCheckedAt = clock();
		state.lastError = scrubDiagnosticDetail(detail);
		return copy(state);
	}

	function markHealthy(adapter: string): AdapterHealth {
		const state = getMutable(redactText(adapter, { maxLength: 64 }));
		state.status = "healthy";
		state.lastCheckedAt = clock();
		state.lastError = undefined;
		return copy(state);
	}

	return {
		record,
		markUnavailable,
		markHealthy,
		getHealth: (adapter) => copy(getMutable(redactText(adapter, { maxLength: 64 }))),
		snapshotHealth: () => [...health.values()].map(copy),
	};
}

export function sanitizeSnapshot(snapshot: WorkstreamSnapshot, options: RedactionOptions = {}): WorkstreamSnapshot {
	const provenance = snapshot.provenance === undefined ? undefined : {
		...snapshot.provenance,
		...(snapshot.provenance.parentPiSessionId === undefined ? {} : { parentPiSessionId: redactText(snapshot.provenance.parentPiSessionId, { ...options, maxLength: 128 }) as typeof snapshot.provenance.parentPiSessionId }),
		...(snapshot.provenance.inheritedWorkstreamId === undefined ? {} : { inheritedWorkstreamId: redactText(snapshot.provenance.inheritedWorkstreamId, { ...options, maxLength: 128 }) as typeof snapshot.provenance.inheritedWorkstreamId }),
		...(snapshot.provenance.handoffId === undefined ? {} : { handoffId: redactText(snapshot.provenance.handoffId, { ...options, maxLength: 128 }) }),
	};
	return {
		...snapshot,
		...sanitizeIdentity(snapshot, options),
		objective: redactText(snapshot.objective, { ...options, maxLength: 1_000 }),
		goals: snapshot.goals.slice(0, 50).map((goal) => ({ ...goal, text: redactText(goal.text, { ...options, maxLength: 512 }) })),
		refs: snapshot.refs.slice(0, 100).map((ref) => sanitizeRef(ref, options)),
		boundaries: snapshot.boundaries.slice(0, 50).map((boundary) => redactText(boundary, { ...options, maxLength: 512 })),
		...(provenance === undefined ? {} : { provenance }),
	};
}
