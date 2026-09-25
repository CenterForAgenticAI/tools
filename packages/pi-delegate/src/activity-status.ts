import type { RunActivitySummary } from "./fork-digest.js";
import type { RunLiveStatus } from "./runtime.js";

/** Maximum number of changed activity statuses retained on each run entry. */
export const MAX_ACTIVITY_HISTORY_ENTRIES = 10;
/** Maximum persisted/displayed headline length in UTF-16 code units. */
export const MAX_ACTIVITY_TEXT_CHARS = 120;

export type ActivityStatusSource = "local" | "model" | "lifecycle";
export type ActivityStatusClassification = "tool" | "phase" | "lifecycle" | "error";

/** A redacted, bounded status suitable for display and durable runtime state. */
export interface ActivityStatusEntry {
	text: string;
	source: ActivityStatusSource;
	classification: ActivityStatusClassification;
	timestamp: number;
}

export type ActivityStatusDraft = Omit<ActivityStatusEntry, "timestamp">;

const SENSITIVE_NAME =
	"(?:token|secret|password|passwd|api[-_]?key|authorization|credential)";
const SENSITIVE_KEY_CHARS = "[-A-Za-z0-9_.%+~\\\\]+";
const QUOTED_KEY = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;
const BRACKETED_KEY = `\\[\\s*(?:${SENSITIVE_KEY_CHARS}|${QUOTED_KEY})\\s*\\]`;
const ASSIGNMENT_KEY = `(?:${BRACKETED_KEY}|${QUOTED_KEY}|${SENSITIVE_KEY_CHARS})(?:\\[\\])?`;
const ACTIVITY_CONTROL = "[\\s\\x00-\\x1f\\x7f]";
const ACTIVITY_SEPARATOR = `${ACTIVITY_CONTROL}*`;

function normalizeSensitiveKey(value: string): string {
	let decoded = value.replace(/\+/g, " ");
	for (let pass = 0; pass < 16; pass += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			// Decode valid escape bytes around malformed sequences so a sensitive
			// name cannot hide behind one invalid percent escape.
			const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
				String.fromCharCode(Number.parseInt(hex, 16)));
			if (next === decoded) break;
			decoded = next;
		}
	}
	decoded = decoded.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)));
	decoded = decoded.replace(/\\([\\"'])/g, "$1");
	return decoded.replace(/[[\]"']/g, "").replace(/\[\]$/g, "").toLowerCase();
}

function isSensitiveKey(value: string): boolean {
	const normalized = normalizeSensitiveKey(value);
	return new RegExp(SENSITIVE_NAME, "i").test(normalized);
}

function isAuthorizationKey(value: string): boolean {
	return /authorization/i.test(normalizeSensitiveKey(value));
}

function isActivitySeparator(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return /\s/.test(character) || code <= 31 || code === 127;
}

function consumeQuotedValue(text: string, start: number): number {
	const quote = text[start];
	for (let index = start + 1; index < text.length; index += 1) {
		if (text[index] === "\\") {
			index += 1;
		} else if (text[index] === quote) {
			return index + 1;
		}
	}
	return text.length;
}

function consumeBalancedValue(text: string, start: number): number {
	const opening = text[start];
	const closing = opening === "[" ? "]" : "}";
	let depth = 0;
	let quote: string | undefined;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (quote) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
		} else if (character === opening) {
			depth += 1;
		} else if (character === closing) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return text.length;
}

function consumeActivityValue(text: string, start: number, fullValue: boolean): number {
	let index = start;
	while (isActivitySeparator(text[index])) index += 1;
	if (index >= text.length) return index;
	if (text[index] === "\"" || text[index] === "'") return consumeQuotedValue(text, index);
	if (text[index] === "[" || text[index] === "{") return consumeBalancedValue(text, index);
	for (; index < text.length; index += 1) {
		const character = text[index];
		if (character === "," || character === ";" || character === "&" || character === "#" || character === "}") {
			break;
		}
		if (!fullValue && isActivitySeparator(character)) break;
	}
	return index;
}

function redactSensitiveAssignments(value: string): string {
	const pattern = new RegExp(`(^|[?&;,:{#\\[]|${ACTIVITY_CONTROL})(${ASSIGNMENT_KEY})(${ACTIVITY_SEPARATOR}[:=]${ACTIVITY_SEPARATOR})`, "gi");
	let text = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		const key = match[2];
		if (!isSensitiveKey(key)) continue;
		const valueStart = match.index + match[0].length;
		const valueEnd = consumeActivityValue(value, valueStart, isAuthorizationKey(key));
		if (valueEnd <= valueStart) continue;
		text += value.slice(cursor, valueStart) + "[REDACTED]";
		cursor = valueEnd;
		pattern.lastIndex = valueEnd;
	}
	return text + value.slice(cursor);
}

function redactSensitiveFlags(value: string): string {
	const flagValueSeparator = `(?:${ACTIVITY_SEPARATOR}=${ACTIVITY_SEPARATOR}|${ACTIVITY_CONTROL}+)`;
	const pattern = new RegExp(`(^|${ACTIVITY_CONTROL})(--?)(${SENSITIVE_KEY_CHARS})(${flagValueSeparator})`, "gi");
	let text = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		const key = match[3];
		if (!isSensitiveKey(key)) continue;
		const valueStart = match.index + match[0].length;
		const valueEnd = consumeActivityValue(value, valueStart, isAuthorizationKey(key));
		if (valueEnd <= valueStart) continue;
		text += value.slice(cursor, valueStart) + "[REDACTED]";
		cursor = valueEnd;
		pattern.lastIndex = valueEnd;
	}
	return text + value.slice(cursor);
}

/**
 * Remove credential-shaped values before any local status is displayed or
 * persisted. This deliberately handles both shell-style flags and URL/query
 * or object-style assignments because tool metadata can use any of them.
 */
export function redactActivityText(value: string): string {
	let text = value;
	text = text.replace(/((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
	text = redactSensitiveAssignments(text);
	text = redactSensitiveFlags(text);
	text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]");
	return text;
}

/**
 * Truncate to at most `max` UTF-16 units without splitting a surrogate pair.
 *
 * A lone surrogate is not encodable as UTF-8: writing it to the terminal emits
 * U+FFFD instead, which occupies a column that the in-memory `visibleWidth`
 * measurement never counted. A row bounded to exactly the available width can
 * therefore overflow by one column once encoded, so the cut has to fall on a
 * whole code point. Cutting (rather than keeping) the orphaned half preserves
 * the `length <= max` bound every caller relies on.
 */
function truncateOnCodePointBoundary(value: string, max: number): string {
	if (value.length <= max) return value;
	const lastUnit = value.charCodeAt(max - 1);
	const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
	return value.slice(0, splitsSurrogatePair ? max - 1 : max);
}

/** Normalize controls/whitespace, redact secrets, and apply the hard bound. */
export function boundActivityText(value: string): string {
	const redacted = redactActivityText(value);
	const withoutControls = [...redacted]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || (code >= 127 && code <= 159) ? " " : character;
		})
		.join("");
	const normalized = withoutControls.replace(/\s+/g, " ").trim();
	return truncateOnCodePointBoundary(normalized, MAX_ACTIVITY_TEXT_CHARS).trimEnd();
}

/**
 * Admit only a tool identifier, never command text or an argument/path that was
 * accidentally placed in a provider's `toolName` field.
 */
export function safeActivityToolName(
	value: string | undefined,
	maxChars = 64,
): string | undefined {
	if (!value) return undefined;
	const normalized = boundActivityText(value);
	if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) return undefined;
	const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 64;
	return normalized.slice(0, limit);
}

export function projectLifecycleActivity(status: RunLiveStatus): ActivityStatusDraft | undefined {
	switch (status) {
		case "awaiting-escalation":
			return { text: "awaiting escalation", source: "lifecycle", classification: "lifecycle" };
		case "paused":
			return { text: "paused", source: "lifecycle", classification: "lifecycle" };
		case "failed":
			return { text: "failed", source: "lifecycle", classification: "error" };
		case "aborted":
			return { text: "aborted", source: "lifecycle", classification: "lifecycle" };
		case "completed":
			return { text: "completed", source: "lifecycle", classification: "lifecycle" };
		default:
			return undefined;
	}
}

const ACTIONS: Record<string, { active: string; settled: string }> = {
	bash: { active: "running", settled: "ran" },
	shell: { active: "running", settled: "ran" },
	exec: { active: "running", settled: "ran" },
	read: { active: "reading", settled: "read" },
	cat: { active: "reading", settled: "read" },
	edit: { active: "editing", settled: "edited" },
	write: { active: "writing", settled: "wrote" },
	apply_patch: { active: "editing", settled: "edited" },
	grep: { active: "searching", settled: "searched" },
	rg: { active: "searching", settled: "searched" },
	search: { active: "searching", settled: "searched" },
	find: { active: "finding", settled: "found" },
	glob: { active: "finding", settled: "found" },
	fetch: { active: "fetching", settled: "fetched" },
	curl: { active: "fetching", settled: "fetched" },
	web: { active: "browsing", settled: "browsed" },
};

/**
 * Derive a concrete local headline from the shared structured transcript
 * summary. Lifecycle truth wins and unknown tools retain their true name.
 */
export function projectLocalActivity(input: {
	status: RunLiveStatus;
	activity: Pick<RunActivitySummary, "lastToolName" | "lastToolMeta" | "toolActive">;
}): ActivityStatusDraft {
	const lifecycle = projectLifecycleActivity(input.status);
	if (lifecycle) return lifecycle;

	const toolName = input.activity.lastToolName;
	if (!toolName) {
		return {
			text: input.status === "pending" || input.status === "constructing" ? "starting" : "working",
			source: "local",
			classification: "phase",
		};
	}
	const safeName = safeActivityToolName(toolName) ?? "unknown tool";
	const target = input.activity.lastToolMeta ? boundActivityText(input.activity.lastToolMeta) : "";
	const actionName = toolName.toLowerCase();
	const action = Object.hasOwn(ACTIONS, actionName) ? ACTIONS[actionName] : undefined;
	const verb = action
		? input.activity.toolActive
			? action.active
			: action.settled
		: input.activity.toolActive
			? "using"
			: "used";
	const text = target
		? action
			? `${verb} ${target}`
			: `${verb} ${safeName} ${target}`
		: `${verb} ${safeName}`;
	return {
		text: boundActivityText(text),
		source: "local",
		classification: "tool",
	};
}

function validSource(value: unknown): value is ActivityStatusSource {
	return value === "local" || value === "model" || value === "lifecycle";
}

function validClassification(value: unknown): value is ActivityStatusClassification {
	return value === "tool" || value === "phase" || value === "lifecycle" || value === "error";
}

/** Normalize a persisted entry defensively at the runtime boundary. */
export function normalizeActivityStatusEntry(
	entry: Partial<ActivityStatusEntry>,
	now = Date.now(),
): ActivityStatusEntry | undefined {
	if (typeof entry.text !== "string") return undefined;
	const text = boundActivityText(entry.text);
	if (!text) return undefined;
	return {
		text,
		source: validSource(entry.source) ? entry.source : "local",
		classification: validClassification(entry.classification) ? entry.classification : "phase",
		timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
			? entry.timestamp
			: now,
	};
}

/** Normalize and cap a history loaded from a legacy or malformed record. */
export function normalizeActivityHistory(
	entries: readonly Partial<ActivityStatusEntry>[] | undefined,
	now = Date.now(),
): ActivityStatusEntry[] {
	if (!entries) return [];
	let history: ActivityStatusEntry[] = [];
	for (const entry of entries) history = appendActivityStatus(history, entry, now);
	return history;
}

/** Append one entry, dropping only consecutive equal visible text. */
export function appendActivityStatus(
	history: readonly ActivityStatusEntry[] | undefined,
	entry: Partial<ActivityStatusEntry>,
	now = Date.now(),
): ActivityStatusEntry[] {
	const normalized = normalizeActivityStatusEntry(entry, now);
	if (!normalized) return history ? [...history] as ActivityStatusEntry[] : [];
	const prior = history?.at(-1);
	if (prior?.text === normalized.text) return history ? [...history] as ActivityStatusEntry[] : [];
	return [...(history ?? []), normalized].slice(-MAX_ACTIVITY_HISTORY_ENTRIES);
}
