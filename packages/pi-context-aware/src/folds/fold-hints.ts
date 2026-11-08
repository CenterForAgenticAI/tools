/**
 * Fold hints (pi-context-aware#281): how an extension's own messages and tool
 * results fold and compact.
 *
 * A hint selects content by a typed key, never by reading message text:
 * `{ customType }` matches a `pi.sendMessage()` custom message entry, and
 * `{ toolName }` matches that tool's calls and results. A user message the
 * operator typed is a `message` entry with role `user`; no key can select it.
 *
 * The registry copies only the named fields of a registration and bounds
 * them. A key belongs to the first owner that registers it for the life of
 * the registry (one session); another owner is refused. Context-aware owns
 * its built-in hints and the `context-aware.` prefix.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type FoldHintPolicy = "verbatim" | "one-line" | "condensed" | "drop-after-read" | "default";

export type FoldHintMatch = { readonly customType: string } | { readonly toolName: string };

export interface FoldHintRegistration {
	readonly ownerKey: string;
	readonly match: FoldHintMatch;
	readonly policy: FoldHintPolicy;
	/** `one-line`: the record shown in place of the content. */
	readonly line?: string;
	/** `one-line`: builds the record from the message's `details` only. Takes precedence over `line`. */
	readonly summarize?: (details: unknown) => unknown;
	/** `condensed`: the text shown in place of a custom message. */
	readonly condensed?: string;
}

export type FoldHintResult = { readonly ok: true; readonly replaced: boolean } | { readonly ok: false; readonly error: string };

/** The hint one entry resolves to. `line` is set for `one-line`, `condensed` for `condensed`. */
export interface ResolvedFoldHint {
	readonly policy: Exclude<FoldHintPolicy, "default">;
	readonly key: string;
	readonly line?: string;
	readonly condensed?: string;
}

/** What the planner and compaction read. */
export interface FoldHintView {
	forEntry(entry: SessionEntry): ResolvedFoldHint | undefined;
	/** Same rules as `forEntry`, for a message in a compaction preparation. */
	forMessage(message: unknown): ResolvedFoldHint | undefined;
	/** Tool names whose calls and results stay word for word. */
	verbatimTools(): string[];
}

export interface FoldHints extends FoldHintView {
	register(registration: unknown): FoldHintResult;
	/**
	 * Register several hints as one: all are stored, or none is and the first error is returned.
	 * A contributor's hints use it (pi-context-aware#300).
	 */
	registerAll(registrations: readonly unknown[]): FoldHintResult;
	/** Remove an owner's hints. Its keys stay claimed for the session. Returns how many hints were removed. */
	endOwner(ownerKey: unknown): number;
}

export const CONTEXT_AWARE_HINT_OWNER = "context-aware";
export const RESERVED_CUSTOM_TYPE_PREFIX = "context-aware.";
/** The custom type of the next-turn notice for folds that were not written (pi-context-aware#282). */
export const FOLD_NOTICE_TYPE = "context-aware.fold-notice";
/** The custom type the `/ask-me` command sends its body with (pi-context-aware#278). */
export const ASK_ME_CUSTOM_TYPE = "ask-me";

export const MAX_HINT_KEY_CHARS = 128;
export const MAX_HINT_OWNER_CHARS = 200;
export const MAX_HINT_LINE_CHARS = 200;
export const MAX_HINT_CONDENSED_CHARS = 32_000;
export const MAX_HINTS = 256;
/** `summarize` is not called for `details` whose JSON is longer than this. */
export const MAX_HINT_DETAILS_CHARS = 16_000;
/**
 * A `verbatim` message longer than this folds as usual. A call whose result is longer, and a
 * result whose call is longer, fold together (the fold adapter drops the hint), so no hint can
 * pin a large call or result.
 */
export const MAX_VERBATIM_CHARS = 16_000;

const POLICIES: ReadonlySet<string> = new Set(["verbatim", "one-line", "condensed", "drop-after-read", "default"]);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

interface StoredHint {
	readonly ownerKey: string;
	readonly policy: FoldHintPolicy;
	readonly line?: string;
	readonly summarize?: (details: unknown) => unknown;
	readonly condensed?: string;
}

function own<T>(value: unknown, key: string): T | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, T>)[key] : undefined;
	} catch {
		return undefined;
	}
}

/** One printable line: control characters and runs of whitespace become one space, then the text is clipped. */
export function oneLine(text: string, max = MAX_HINT_LINE_CHARS): string {
	const flat = text.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_HINT_KEY_CHARS && KEY_PATTERN.test(value);
}

function keyOf(match: unknown): { key: string; kind: "customType" | "toolName" } | string {
	const customType = own<unknown>(match, "customType");
	const toolName = own<unknown>(match, "toolName");
	if ((customType === undefined) === (toolName === undefined)) return "match must name exactly one of customType or toolName";
	if (customType !== undefined) {
		if (!validKey(customType)) return `customType must be 1-${MAX_HINT_KEY_CHARS} characters of letters, digits and . _ : @ / -`;
		return { key: `custom:${customType}`, kind: "customType" };
	}
	if (!validKey(toolName)) return `toolName must be 1-${MAX_HINT_KEY_CHARS} characters of letters, digits and . _ : @ / -`;
	return { key: `tool:${toolName}`, kind: "toolName" };
}

function validate(registration: unknown, builtIn: boolean): { key: string; hint: StoredHint } | string {
	if (typeof registration !== "object" || registration === null) return "registration must be an object";
	const ownerKey = own<unknown>(registration, "ownerKey");
	if (typeof ownerKey !== "string" || oneLine(ownerKey, MAX_HINT_OWNER_CHARS + 1) !== ownerKey || ownerKey.length === 0 || ownerKey.length > MAX_HINT_OWNER_CHARS) {
		return `ownerKey must be 1-${MAX_HINT_OWNER_CHARS} printable characters`;
	}
	if (!builtIn && ownerKey === CONTEXT_AWARE_HINT_OWNER) return `ownerKey "${CONTEXT_AWARE_HINT_OWNER}" is reserved`;
	const match = keyOf(own<unknown>(registration, "match"));
	if (typeof match === "string") return match;
	if (!builtIn && match.kind === "customType" && match.key.startsWith(`custom:${RESERVED_CUSTOM_TYPE_PREFIX}`)) {
		return `customType prefix "${RESERVED_CUSTOM_TYPE_PREFIX}" is reserved`;
	}
	const policy = own<unknown>(registration, "policy");
	if (typeof policy !== "string" || !POLICIES.has(policy)) return "policy must be one of verbatim, one-line, condensed, drop-after-read, default";
	const typed = policy as FoldHintPolicy;
	if (typed === "condensed" && match.kind !== "customType") return "condensed applies to a customType only";
	if (typed === "verbatim" && match.kind !== "toolName") return "verbatim applies to a toolName only";
	const hint: { -readonly [K in keyof StoredHint]: StoredHint[K] } = { ownerKey, policy: typed };
	if (typed === "one-line") {
		const line = own<unknown>(registration, "line");
		const summarize = own<unknown>(registration, "summarize");
		if (summarize !== undefined && typeof summarize !== "function") return "summarize must be a function";
		if (line !== undefined && typeof line !== "string") return "line must be a string";
		const clean = typeof line === "string" ? oneLine(line) : "";
		if (clean.length === 0 && summarize === undefined) return "one-line needs a line or a summarize function";
		if (clean.length > 0) hint.line = clean;
		if (typeof summarize === "function") hint.summarize = summarize as (details: unknown) => unknown;
	}
	if (typed === "condensed") {
		const condensed = own<unknown>(registration, "condensed");
		if (typeof condensed !== "string" || condensed.trim().length === 0) return "condensed needs non-empty condensed text";
		if (condensed.length > MAX_HINT_CONDENSED_CHARS) return `condensed text is longer than ${MAX_HINT_CONDENSED_CHARS} characters`;
		hint.condensed = condensed;
	}
	return { key: match.key, hint };
}

/** A bounded copy of `details` for `summarize`, or `undefined` when it is too large or cannot be copied. */
function boundedDetails(details: unknown): { ok: true; value: unknown } | { ok: false } {
	if (details === undefined) return { ok: true, value: undefined };
	try {
		const json = JSON.stringify(details);
		if (json === undefined || json.length > MAX_HINT_DETAILS_CHARS) return { ok: false };
		return { ok: true, value: JSON.parse(json) as unknown };
	} catch {
		return { ok: false };
	}
}

function fallbackLine(customType: string): string {
	return oneLine(`${customType} message`);
}

function lineFor(hint: StoredHint, name: string, details: unknown): string {
	if (hint.summarize) {
		const copy = boundedDetails(details);
		if (copy.ok) {
			try {
				const produced = hint.summarize(copy.value);
				const clean = typeof produced === "string" ? oneLine(produced) : "";
				if (clean.length > 0) return clean;
			} catch {
				// A throwing callback gets the fallback line; it never stops a fold or a compaction.
			}
		}
	}
	return hint.line ?? fallbackLine(name);
}

/** Characters of a message's text and tool-call arguments, as the verbatim cap counts them. */
export function contentLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum: number, part: unknown) => {
		const text = own<unknown>(part, "text");
		const args = own<unknown>(part, "arguments");
		return sum + (typeof text === "string" ? text.length : 0) + (args !== undefined ? safeLength(args) : 0);
	}, 0);
}

function safeLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function toolNamesOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part: unknown) => {
		const name = own<unknown>(part, "name");
		return own<unknown>(part, "type") === "toolCall" && typeof name === "string" ? [name] : [];
	});
}

const BUILT_IN: readonly FoldHintRegistration[] = [
	{
		ownerKey: CONTEXT_AWARE_HINT_OWNER,
		match: { customType: ASK_ME_CUSTOM_TYPE },
		policy: "one-line",
		line: "/ask-me",
		// The marker pi-caair-dev-tools sends: details { flags: string[], focus: string }.
		summarize: (details) => {
			const flags = own<unknown>(details, "flags");
			const focus = own<unknown>(details, "focus");
			const parts = ["/ask-me ran:", ...(Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === "string") : [])];
			if (typeof focus === "string" && focus.trim().length > 0) parts.push(focus);
			return parts.join(" ");
		},
	},
	{ ownerKey: CONTEXT_AWARE_HINT_OWNER, match: { toolName: "ask" }, policy: "verbatim" },
	{ ownerKey: CONTEXT_AWARE_HINT_OWNER, match: { customType: FOLD_NOTICE_TYPE }, policy: "drop-after-read" },
];

/** A registry for one session, holding context-aware's built-in hints. */
export function createFoldHints(): FoldHints {
	const hints = new Map<string, StoredHint>();
	const owners = new Map<string, string>();

	const store = (registration: unknown, builtIn: boolean): FoldHintResult => {
		const checked = validate(registration, builtIn);
		if (typeof checked === "string") return { ok: false, error: checked };
		const owner = owners.get(checked.key);
		if (owner !== undefined && owner !== checked.hint.ownerKey) {
			return { ok: false, error: `${checked.key.replace(/^(custom|tool):/u, "")} is owned by another extension in this session` };
		}
		const replaced = hints.has(checked.key);
		if (!replaced && owner === undefined && owners.size >= MAX_HINTS) return { ok: false, error: `at most ${MAX_HINTS} hint keys per session` };
		owners.set(checked.key, checked.hint.ownerKey);
		if (checked.hint.policy === "default") hints.delete(checked.key);
		else hints.set(checked.key, checked.hint);
		return { ok: true, replaced };
	};
	for (const registration of BUILT_IN) store(registration, true);

	const registerAll = (registrations: readonly unknown[]): FoldHintResult => {
		const checked: { key: string; hint: StoredHint }[] = [];
		for (const registration of registrations) {
			const one = validate(registration, false);
			if (typeof one === "string") return { ok: false, error: one };
			const owner = owners.get(one.key);
			if (owner !== undefined && owner !== one.hint.ownerKey) {
				return { ok: false, error: `${one.key.replace(/^(custom|tool):/u, "")} is owned by another extension in this session` };
			}
			checked.push(one);
		}
		const added = new Set(checked.map(({ key }) => key).filter((key) => !owners.has(key)));
		if (owners.size + added.size > MAX_HINTS) return { ok: false, error: `at most ${MAX_HINTS} hint keys per session` };
		let replaced = false;
		for (const { key, hint } of checked) {
			replaced ||= hints.has(key);
			owners.set(key, hint.ownerKey);
			if (hint.policy === "default") hints.delete(key);
			else hints.set(key, hint);
		}
		return { ok: true, replaced };
	};

	const resolve = (key: string, name: string, details: unknown, size: number): ResolvedFoldHint | undefined => {
		const hint = hints.get(key);
		if (!hint || hint.policy === "default") return undefined;
		if (hint.policy === "one-line") return { policy: "one-line", key: name, line: lineFor(hint, name, details) };
		if (hint.policy === "condensed") return { policy: "condensed", key: name, condensed: hint.condensed! };
		if (hint.policy === "verbatim" && size > MAX_VERBATIM_CHARS) return undefined;
		return { policy: hint.policy, key: name };
	};
	const forMessage = (message: unknown): ResolvedFoldHint | undefined => {
		const role = own<unknown>(message, "role");
		if (role === "custom") {
			const customType = own<unknown>(message, "customType");
			if (typeof customType !== "string") return undefined;
			return resolve(`custom:${customType}`, customType, own<unknown>(message, "details"), contentLength(own<unknown>(message, "content")));
		}
		if (role === "toolResult") {
			const toolName = own<unknown>(message, "toolName");
			if (typeof toolName !== "string") return undefined;
			const hint = resolve(`tool:${toolName}`, toolName, own<unknown>(message, "details"), contentLength(own<unknown>(message, "content")));
			return hint?.policy === "condensed" ? undefined : hint;
		}
		if (role === "assistant") {
			// A call is kept with its verbatim result; other policies act on the result only.
			const content = own<unknown>(message, "content");
			const size = contentLength(content);
			for (const name of toolNamesOf(content)) {
				const hint = resolve(`tool:${name}`, name, undefined, size);
				if (hint?.policy === "verbatim") return hint;
			}
		}
		// Role `user` is what the operator typed: no hint applies to it.
		return undefined;
	};

	return {
		register: (registration) => store(registration, false),
		registerAll,
		endOwner(ownerKey) {
			if (typeof ownerKey !== "string" || ownerKey === CONTEXT_AWARE_HINT_OWNER) return 0;
			let removed = 0;
			for (const [key, hint] of hints) {
				if (hint.ownerKey !== ownerKey) continue;
				hints.delete(key);
				removed += 1;
			}
			return removed;
		},
		forEntry(entry) {
			if (entry.type === "custom_message") {
				return forMessage({ role: "custom", customType: entry.customType, content: entry.content, details: entry.details });
			}
			if (entry.type !== "message") return undefined;
			return forMessage(entry.message);
		},
		forMessage,
		verbatimTools: () => [...hints].flatMap(([key, hint]) => (hint.policy === "verbatim" && key.startsWith("tool:") ? [key.slice(5)] : [])),
	};
}

/** At most this many one-line records are listed under one fold summary. */
export const MAX_FOLD_ONE_LINES = 20;

/** The section a fold summary gets for the one-line entries it covers. Empty when there are none. */
export function renderOneLineSection(lines: readonly string[]): string {
	if (lines.length === 0) return "";
	const shown = lines.slice(0, MAX_FOLD_ONE_LINES).map((line) => `- ${line}`);
	const more = lines.length - shown.length;
	if (more > 0) shown.push(`- ${more} more extension message${more === 1 ? "" : "s"}`);
	return ["Extension messages in this fold (one line each; not user intent):", ...shown].join("\n");
}

export interface HintedCompactionInput {
	readonly messagesToSummarize: readonly unknown[];
	readonly turnPrefixMessages: readonly unknown[];
}

export interface HintedCompaction {
	readonly messagesToSummarize: unknown[];
	readonly turnPrefixMessages: unknown[];
	/** True when any message was replaced or removed. */
	readonly changed: boolean;
	/** Instruction for the summarizer, set when the history holds verbatim tool content. */
	readonly instruction?: string;
}

/** The current replacement content of each custom message a context edit replaced, by entry. */
function editedCustomMessages(branch: readonly SessionEntry[]): { customType: string; timestamp: number; content: string }[] {
	const latest = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type === "context_edit") latest.set(entry.targetId, entry.replacement);
	}
	const found: { customType: string; timestamp: number; content: string }[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom_message" || !latest.has(entry.id)) continue;
		const replacement = latest.get(entry.id);
		if (replacement === null || replacement === undefined) continue;
		found.push({ customType: entry.customType, timestamp: new Date(entry.timestamp).getTime(), content: safeJson(own<unknown>(replacement, "content")) });
	}
	return found;
}

/**
 * True when this projected custom message is one a context edit replaced: same type, same
 * timestamp, and the edit's content. A false match only leaves a message unhinted.
 */
function isEdited(message: unknown, edited: readonly { customType: string; timestamp: number; content: string }[]): boolean {
	if (edited.length === 0) return false;
	const customType = own<unknown>(message, "customType");
	const timestamp = own<unknown>(message, "timestamp");
	const content = safeJson(own<unknown>(message, "content"));
	return edited.some((edit) => edit.customType === customType && edit.timestamp === timestamp && edit.content === content);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(typeof value === "string" ? [{ type: "text", text: value }] : value) ?? "";
	} catch {
		return "";
	}
}

/**
 * Apply hints to the history a compaction summarizes. A `one-line` custom
 * message is replaced by its marked line, a `condensed` one by its text, and a
 * `drop-after-read` one is removed when an assistant message follows it.
 * Calls and results of a `verbatim` tool are kept and named in an instruction. A custom
 * message whose content a context edit on `branch` replaced (a fold's carrier, a condensed
 * swap) is passed through unchanged.
 */
export function applyHintsToCompaction(
	input: HintedCompactionInput,
	hints: FoldHintView,
	branch: readonly SessionEntry[] = [],
): HintedCompaction {
	const edited = editedCustomMessages(branch);
	const all = [...input.messagesToSummarize, ...input.turnPrefixMessages];
	const split = input.messagesToSummarize.length;
	const lastAssistant = all.reduce((last: number, message, index) => (own<unknown>(message, "role") === "assistant" ? index : last), -1);
	let changed = false;
	const verbatim = new Set<string>();
	const summarize: unknown[] = [];
	const prefix: unknown[] = [];
	for (const [index, message] of all.entries()) {
		const target = index < split ? summarize : prefix;
		const hint = hints.forMessage(message);
		// A custom message a context edit replaced, such as a fold's carrier, shows what the edit
		// chose (pi-context-aware!279 CR-HINT-CARRIER-SUMMARY-LOST); its hint no longer applies.
		if (!hint || own<unknown>(message, "role") !== "custom" || isEdited(message, edited)) {
			if (hint?.policy === "verbatim") verbatim.add(hint.key);
			target.push(message);
			continue;
		}
		if (hint.policy === "drop-after-read") {
			if (index < lastAssistant) changed = true;
			else target.push(message);
			continue;
		}
		if (hint.policy !== "one-line" && hint.policy !== "condensed") {
			target.push(message);
			continue;
		}
		changed = true;
		const content = hint.policy === "one-line"
			? `[${hint.key}: extension message kept as one line; not user intent] ${hint.line ?? ""}`.trimEnd()
			: hint.condensed ?? "";
		target.push({ ...(message as object), content });
	}
	const names = [...verbatim].sort().slice(0, 20);
	return {
		messagesToSummarize: summarize,
		turnPrefixMessages: prefix,
		changed,
		...(names.length > 0
			? { instruction: `Quote every call and result of these tools word for word in the summary, as decisions: ${names.join(", ")}.` }
			: {}),
	};
}
