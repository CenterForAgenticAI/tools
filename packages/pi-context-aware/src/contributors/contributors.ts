/**
 * Contributors (pi-context-aware#300): text another extension asks context-aware
 * to show the model, and when to show it again.
 *
 * An extension registers `render(budget)` and, optionally, `carry(budget)`.
 * Context-aware calls `render` before each agent run and places the texts that
 * are due in its own per-turn message, within a fixed budget, in registration
 * order. A text is due when it has not been shown on this branch, when its text
 * changed, or when its last showing is no longer in the model's context: a fold
 * covers it, a compaction dropped it, or a context edit hid it.
 *
 * Each showing is recorded as a `context-aware.contributor-shown.v1` custom
 * entry. The record is read back from the branch every turn, so a reload or a
 * `/tree` move replays it and nothing is held in memory but the registrations.
 *
 * `carry(budget)` text is appended to a compaction summary that context-aware
 * writes, under a heading that marks it as not user intent.
 *
 * The registry copies only the named fields of a registration and bounds every
 * text it reads. A contributor that throws or returns a bad value is skipped
 * for that turn; it never breaks the turn.
 */

import { createHash } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { coveredEntryIds, foldRecordsOnBranch } from "../folds/fold-entries.js";
import { CONTEXT_AWARE_HINT_OWNER, MAX_HINT_OWNER_CHARS, oneLine, type FoldHints } from "../folds/fold-hints.js";

/** The custom entry that records the contributions shown in one turn. */
export const CONTRIBUTOR_SHOWN_ENTRY_TYPE = "context-aware.contributor-shown.v1";
/** The customTypes of context-aware's per-turn message; a showing anchors to the next one. */
export const PER_TURN_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	"context-aware-task-state",
	"context-aware-restart-notice",
	"context-aware-usage-marker",
]);
/** The heading of the carried section in a compaction summary. */
export const CARRY_HEADING = "Carried by extensions (not user intent):";

/** One contribution text. A longer text is skipped, never cut. */
export const MAX_CONTRIBUTION_CHARS = 4_000;
/**
 * All contributions in one turn. One owner may use all of it, so the per-owner
 * limit equals this one and needs no separate control.
 */
export const MAX_TURN_CHARS = 8_000;
/** One owner's carry text. A longer text is skipped, never cut. */
export const MAX_CARRY_OWNER_CHARS = 4_000;
/** All carry text in one compaction summary. */
export const MAX_CARRY_CHARS = 8_000;
/** Contributors per session. */
export const MAX_CONTRIBUTORS = 32;
/** Contributions one `render` call may return. */
export const MAX_CONTRIBUTIONS_PER_OWNER = 32;
/** Hints one registration may carry. */
export const MAX_CONTRIBUTOR_HINTS = 32;
/** A contribution id: same characters and length as a fold-hint key. */
export const MAX_CONTRIBUTION_ID_CHARS = 128;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface ContributionBudget {
	readonly maxChars: number;
}

export type ContributorResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** One showing of one contribution, as the shown entry stores it. */
export interface ShownContribution {
	readonly ownerKey: string;
	readonly contributionId: string;
	readonly textDigest: string;
}

/** What one turn shows: the text for the per-turn message and the entry to record it. */
export interface ContributionTurn {
	readonly text: string | null;
	readonly shown: readonly ShownContribution[];
}

/** The session reads the planner needs; a host shim may lack the projection. */
export type ContributorSessionReader = Partial<Pick<SessionManager, "getBranch" | "buildContextEntries" | "buildSessionProjection">>;

export interface Contributors {
	register(registration: unknown): ContributorResult;
	/** Remove a live owner. Returns false when the owner is not registered. Its fold hints stay. */
	endOwner(ownerKey: unknown): boolean;
	/** Owners in registration order. */
	ownerKeys(): string[];
	/** The contributions due this turn, rendered within the budget. */
	planTurn(session: ContributorSessionReader, log?: (message: string) => void): ContributionTurn;
	/** The carried section for a compaction summary, or null when no owner carries text. */
	carrySection(log?: (message: string) => void): string | null;
}

interface Owner {
	readonly ownerKey: string;
	readonly render: (budget: ContributionBudget) => unknown;
	readonly carry?: (budget: ContributionBudget) => unknown;
}

function own<T>(value: unknown, key: string): T | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, T>)[key] : undefined;
	} catch {
		return undefined;
	}
}

export function textDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function validOwnerKey(ownerKey: unknown): ownerKey is string {
	return typeof ownerKey === "string"
		&& ownerKey.length > 0
		&& ownerKey.length <= MAX_HINT_OWNER_CHARS
		&& oneLine(ownerKey, MAX_HINT_OWNER_CHARS + 1) === ownerKey;
}

function validId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_CONTRIBUTION_ID_CHARS && ID_PATTERN.test(id);
}

/** A fresh budget object per call, so one owner cannot change what another receives. */
function budget(maxChars: number): ContributionBudget {
	return Object.freeze({ maxChars });
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** A `then`-able result is not a synchronous value; its rejection is observed so it is never unhandled. */
function isThenable(value: unknown): boolean {
	const then = own<unknown>(value, "then") ?? (typeof value === "object" && value !== null ? (value as { then?: unknown }).then : undefined);
	if (typeof then !== "function") return false;
	try {
		(then as (ok: () => void, fail: () => void) => unknown).call(value, () => {}, () => {});
	} catch {
		// Observing the rejection is best effort.
	}
	return true;
}

/** Copy a render result: an array of `{ id, text }` with valid, unique ids. Anything else is refused. */
function readContributions(value: unknown): { id: string; text: string }[] | string {
	if (isThenable(value)) return "render must return its contributions synchronously";
	if (!Array.isArray(value)) return "render must return an array";
	if (value.length > MAX_CONTRIBUTIONS_PER_OWNER) return `render returned more than ${MAX_CONTRIBUTIONS_PER_OWNER} contributions`;
	const seen = new Set<string>();
	const copies: { id: string; text: string }[] = [];
	for (const item of value as unknown[]) {
		const id = own<unknown>(item, "id");
		const text = own<unknown>(item, "text");
		if (!validId(id)) return `contribution id must be 1-${MAX_CONTRIBUTION_ID_CHARS} characters of letters, digits and . _ : @ / -`;
		if (seen.has(id)) return `contribution id ${id} appears twice`;
		if (typeof text !== "string") return `contribution ${id} text must be a string`;
		seen.add(id);
		copies.push({ id, text });
	}
	return copies;
}

/** The latest showing of each contribution on the branch, with the per-turn message it anchors to. */
function latestShowings(branch: readonly SessionEntry[]): Map<string, { digest: string; anchorId: string | undefined }> {
	const latest = new Map<string, { digest: string; anchorId: string | undefined }>();
	let pending: string[] = [];
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CONTRIBUTOR_SHOWN_ENTRY_TYPE) {
			// A record whose message never arrived anchors to nothing; the next record starts a new turn.
			pending = [];
			const shown = own<unknown>(entry.data, "shown");
			if (own<unknown>(entry.data, "version") !== 1 || !Array.isArray(shown)) continue;
			for (const item of shown as unknown[]) {
				const ownerKey = own<unknown>(item, "ownerKey");
				const contributionId = own<unknown>(item, "contributionId");
				const digest = own<unknown>(item, "textDigest");
				if (!validOwnerKey(ownerKey) || !validId(contributionId) || typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) continue;
				const key = JSON.stringify([ownerKey, contributionId]);
				latest.set(key, { digest, anchorId: undefined });
				pending.push(key);
			}
			continue;
		}
		if (pending.length > 0 && entry.type === "custom_message" && PER_TURN_MESSAGE_TYPES.has(entry.customType)) {
			for (const key of pending) {
				const current = latest.get(key);
				if (current) latest.set(key, { ...current, anchorId: entry.id });
			}
			pending = [];
		}
	}
	return latest;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: unknown) => {
		const text = own<unknown>(part, "text");
		return own<unknown>(part, "type") === "text" && typeof text === "string" ? text : "";
	}).join("\n");
}

/** The model-visible text of each entry, with context edits applied when the session can project them. */
function visibleTexts(session: ContributorSessionReader, branch: readonly SessionEntry[]): Map<string, string> {
	const texts = new Map<string, string>();
	if (typeof session.buildSessionProjection === "function") {
		for (const { sourceEntry, messages } of session.buildSessionProjection().entries) {
			if (messages.length === 0) continue;
			texts.set(sourceEntry.id, messages.map((message) => textOfContent(own<unknown>(message, "content"))).join("\n"));
		}
		return texts;
	}
	const entries = typeof session.buildContextEntries === "function" ? session.buildContextEntries() : branch;
	for (const entry of entries) {
		if (entry.type === "custom_message") texts.set(entry.id, textOfContent(entry.content));
	}
	return texts;
}

export function createContributors(hints: Pick<FoldHints, "registerAll">): Contributors {
	const owners = new Map<string, Owner>();

	const register = (registration: unknown): ContributorResult => {
		if (typeof registration !== "object" || registration === null) return { ok: false, error: "registration must be an object" };
		const ownerKey = own<unknown>(registration, "ownerKey");
		if (!validOwnerKey(ownerKey)) return { ok: false, error: `ownerKey must be 1-${MAX_HINT_OWNER_CHARS} printable characters` };
		if (ownerKey === CONTEXT_AWARE_HINT_OWNER) return { ok: false, error: `ownerKey "${CONTEXT_AWARE_HINT_OWNER}" is reserved` };
		if (owners.has(ownerKey)) return { ok: false, error: `${ownerKey} is already registered in this session` };
		if (owners.size >= MAX_CONTRIBUTORS) return { ok: false, error: `at most ${MAX_CONTRIBUTORS} contributors per session` };
		const render = own<unknown>(registration, "render");
		if (typeof render !== "function") return { ok: false, error: "render must be a function" };
		const carry = own<unknown>(registration, "carry");
		if (carry !== undefined && typeof carry !== "function") return { ok: false, error: "carry must be a function" };
		const listed = own<unknown>(registration, "hints");
		if (listed !== undefined) {
			if (!Array.isArray(listed)) return { ok: false, error: "hints must be an array" };
			if (listed.length > MAX_CONTRIBUTOR_HINTS) return { ok: false, error: `at most ${MAX_CONTRIBUTOR_HINTS} hints per contributor` };
			// The hint registry reads only its named fields; the ownerKey is always the contributor's own.
			const copies = (listed as unknown[]).map((hint) => ({
				match: own<unknown>(hint, "match"),
				policy: own<unknown>(hint, "policy"),
				line: own<unknown>(hint, "line"),
				summarize: own<unknown>(hint, "summarize"),
				condensed: own<unknown>(hint, "condensed"),
				ownerKey,
			}));
			const stored = hints.registerAll(copies);
			if (!stored.ok) return { ok: false, error: `hints: ${stored.error}` };
		}
		owners.set(ownerKey, {
			ownerKey,
			render: render as Owner["render"],
			...(typeof carry === "function" ? { carry: carry as Owner["carry"] } : {}),
		});
		return { ok: true };
	};

	const planTurn = (session: ContributorSessionReader, log?: (message: string) => void): ContributionTurn => {
		if (owners.size === 0 || typeof session.getBranch !== "function") return { text: null, shown: [] };
		const branch = session.getBranch();
		const showings = latestShowings(branch);
		const folded = new Set(foldRecordsOnBranch(branch).flatMap(({ record }) => coveredEntryIds(record)));
		let visible: Map<string, string> | undefined;
		const isDue = (ownerKey: string, id: string, text: string, digest: string): boolean => {
			const last = showings.get(JSON.stringify([ownerKey, id]));
			if (!last || last.digest !== digest || last.anchorId === undefined) return true;
			if (folded.has(last.anchorId)) return true;
			visible ??= visibleTexts(session, branch);
			return !(visible.get(last.anchorId) ?? "").includes(text);
		};
		const texts: string[] = [];
		const shown: ShownContribution[] = [];
		let turnLeft = MAX_TURN_CHARS;
		for (const owner of owners.values()) {
			if (turnLeft <= 0) break;
			const ownerBudget = turnLeft;
			let produced: unknown;
			try {
				produced = owner.render(budget(ownerBudget));
			} catch (error) {
				log?.(`contributors: ${owner.ownerKey} render failed: ${describe(error)}`);
				continue;
			}
			const contributions = readContributions(produced);
			if (typeof contributions === "string") {
				log?.(`contributors: ${owner.ownerKey} skipped this turn: ${contributions}`);
				continue;
			}
			let ownerLeft = ownerBudget;
			for (const { id, text } of contributions) {
				if (text.trim().length === 0) continue;
				// Too long for the cap or what is left: skipped, never cut, and still due next turn.
				if (text.length > MAX_CONTRIBUTION_CHARS || text.length > ownerLeft) continue;
				const digest = textDigest(text);
				if (!isDue(owner.ownerKey, id, text, digest)) continue;
				texts.push(text);
				shown.push({ ownerKey: owner.ownerKey, contributionId: id, textDigest: digest });
				ownerLeft -= text.length;
			}
			turnLeft -= ownerBudget - ownerLeft;
		}
		return { text: texts.length > 0 ? texts.join("\n\n") : null, shown };
	};

	const carrySection = (log?: (message: string) => void): string | null => {
		const parts: string[] = [];
		let left = MAX_CARRY_CHARS;
		for (const owner of owners.values()) {
			if (!owner.carry || left <= 0) continue;
			const ownerBudget = Math.min(MAX_CARRY_OWNER_CHARS, left);
			let produced: unknown;
			try {
				produced = owner.carry(budget(ownerBudget));
			} catch (error) {
				log?.(`contributors: ${owner.ownerKey} carry failed: ${describe(error)}`);
				continue;
			}
			if (produced === null || produced === undefined) continue;
			if (isThenable(produced) || typeof produced !== "string") {
				log?.(`contributors: ${owner.ownerKey} carry skipped: carry must return a string or null synchronously`);
				continue;
			}
			const text = produced.trim();
			if (text.length === 0) continue;
			if (text.length > ownerBudget) {
				log?.(`contributors: ${owner.ownerKey} carry skipped: ${text.length} characters is over its ${ownerBudget}`);
				continue;
			}
			parts.push(`[${owner.ownerKey}]\n${text}`);
			left -= text.length;
		}
		return parts.length > 0 ? [CARRY_HEADING, ...parts].join("\n\n") : null;
	};

	return {
		register,
		endOwner: (ownerKey) => typeof ownerKey === "string" && owners.delete(ownerKey),
		ownerKeys: () => [...owners.keys()],
		planTurn,
		carrySection,
	};
}

/** The summary with the carried section appended, or the summary unchanged when there is none. */
export function appendCarrySection(summary: string, section: string | null): string {
	return section === null ? summary : `${summary.trimEnd()}\n\n${section}`;
}
