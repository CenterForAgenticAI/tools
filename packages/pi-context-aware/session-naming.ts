/**
 * Automatic session naming.
 *
 * The extension names pi sessions with a one-shot completion against a
 * lightweight model. Sessions a user named — `--name`, `/name`, an RPC
 * rename, or fork inheritance — are frozen permanently and never touched.
 *
 * The grammar is semi-templated: one of a fixed set of templates with
 * lowercase-hyphen slugs, or a bounded free-form fallback. Template-fitting
 * names are final. Free-form names are provisional and revised at
 * checkpoints (compaction, every K turns) up to R times.
 *
 * Everything that can fail is swallowed and logged: a naming failure must be
 * invisible to the session. A name is cosmetic.
 */

import type { SessionNamingConfig } from "./config-layers.js";

// ---------------------------------------------------------------------------
// Name grammar
// ---------------------------------------------------------------------------

const REPO_SLUG = "[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*";
const SHORT_SLUG = "[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])";

// Case-insensitive so model casing is normalized; accepted names are lowercased.
const TEMPLATE_PATTERNS: readonly RegExp[] = [
	new RegExp(`^open-mr\\((${REPO_SLUG})#(\\d+)\\)$`, "i"),
	new RegExp(`^code-review\\((${REPO_SLUG})!(\\d+)\\)$`, "i"),
	new RegExp(`^planning\\((${SHORT_SLUG})\\)$`, "i"),
	new RegExp(`^overseer\\((${REPO_SLUG})\\)$`, "i"),
	new RegExp(`^research\\((${SHORT_SLUG})\\)$`, "i"),
];

/** A model answer that carries a usable name. */
export type ValidatedName =
	| { readonly kind: "template"; readonly name: string }
	| { readonly kind: "free-form"; readonly name: string };

/** Reduce raw model output to one candidate string worth validating. */
function stripWrappers(raw: string): string {
	return raw
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Does this name fit one of the templates exactly? Template names are lowercased. */
export function fitTemplate(candidate: string): string | null {
	const cleaned = stripWrappers(candidate);
	for (const pattern of TEMPLATE_PATTERNS) {
		const match = pattern.exec(cleaned);
		if (match) return cleaned.toLowerCase();
	}
	return null;
}

/**
 * Clean a free-form candidate: strip wrappers, collapse whitespace, cap at
 * `maxLength`. Returns null when nothing usable remains.
 */
export function cleanFreeForm(candidate: string, maxLength: number): string | null {
	const cleaned = stripWrappers(candidate)
		.replace(/[.!?;,:]+$/, "")
		.slice(0, maxLength)
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}

/** Accept a name only if it fits the grammar or survives the free-form cap. */
export function validateName(candidate: string, maxLength: number): ValidatedName | null {
	const template = fitTemplate(candidate);
	if (template) return { kind: "template", name: template };
	const freeForm = cleanFreeForm(candidate, maxLength);
	return freeForm ? { kind: "free-form", name: freeForm } : null;
}

// ---------------------------------------------------------------------------
// Model response protocol
// ---------------------------------------------------------------------------

export type ParsedNamingResponse =
	| { readonly action: "defer" }
	| ({ readonly action: "name" } & ValidatedName);

/**
 * Parse one model answer. `defer` (any casing, optionally with trailing
 * punctuation) means "not confident yet". Anything else is either a template
 * name, a bounded free-form name, or null when the answer is unusable
 * (empty, or whitespace/control noise only).
 */
export function parseNamingResponse(raw: string, maxLength: number): ParsedNamingResponse | null {
	const trimmed = raw.trim();
	if (/^defer[.!]?$/i.test(trimmed)) return { action: "defer" };
	if (trimmed.length === 0) return null;
	// Models that explain before answering put the name last; judge only the
	// final non-empty line of multi-line output.
	const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
	const candidate = lines[lines.length - 1];
	if (candidate === undefined) return null;
	const validated = validateName(candidate, maxLength);
	if (!validated) return null;
	return { action: "name", ...validated };
}

export const NAMING_SYSTEM_PROMPT = `You name coding sessions. Respond with EXACTLY one line and nothing else.

Either the word DEFER — when the conversation is too short or too ambiguous to name — or a session name matching one of these templates:

open-mr(owner/repo#123)       — the session opens a merge request for an issue
code-review(owner/repo!123)   — the session reviews a merge request
planning(feature-slug)        — the session plans a specific feature
overseer(owner/repo)          — the session coordinates other agents for a repository
research(topic-slug)          — the session researches a topic

Rules:
- owner/repo is the repository path (group/project).
- feature-slug and topic-slug are lowercase words joined by hyphens, at most 24 characters.
- Choose the closest template. Only answer DEFER when genuinely nothing fits yet.`;

export function namingUserPrompt(conversationText: string, prior?: { readonly name: string; readonly kind: "template" | "free-form" }): string {
	const repair = prior
		? `\n\nA previous attempt produced the name "${prior.name}" (${prior.kind === "template" ? "template-fitting" : "free-form"}), which is being re-evaluated. Respond with the best name now, or DEFER.`
		: "";
	return `<conversation>\n${conversationText}\n</conversation>\n\nName this session now. One line only.${repair}`;
}

export function namingRepairPrompt(badAnswer: string): string {
	return `Your previous answer did not match the required session-name grammar:\n\n<your-answer>\n${badAnswer.slice(0, 400)}\n</your-answer>\n\nRespond with EXACTLY one line: the same session as a name matching one of the templates from your instructions. No explanations; no conversation is needed for this re-format.`;
}

// ---------------------------------------------------------------------------
// Conversation input
// ---------------------------------------------------------------------------

export interface NamingTurnSource {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Text blocks the extension or its host injects; never naming-relevant. */
const INJECTED_TEXT_PREFIXES = ["<context-telemetry", "<context-cache"] as const;

function isInjectedText(text: string): boolean {
	return INJECTED_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Extract one message's text content. Non-text blocks (images, tool calls, tool results) are dropped. */
export function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null) {
			const candidate = block as { type?: unknown; text?: unknown };
			if (candidate.type === "text" && typeof candidate.text === "string" && !isInjectedText(candidate.text)) {
				parts.push(candidate.text);
			}
		}
	}
	return parts.join("\n");
}

/**
 * Reduce branch entries to user + assistant text for the naming call.
 *
 * Only roles `user` and `assistant` survive. Tool calls, tool results, and
 * extension-injected blocks never reach the naming provider — this is the
 * secrets guarantee in #86 (a credential in a tool result must not be able to
 * cross to the naming model).
 */
export function turnsFromBranchEntries(entries: readonly unknown[]): NamingTurnSource[] {
	const turns: NamingTurnSource[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const message = (entry as { message?: unknown }).message;
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "user" && candidate.role !== "assistant") continue;
		const text = textOfContent(candidate.content).trim();
		if (text.length === 0) continue;
		turns.push({ role: candidate.role, text });
	}
	return turns;
}

/**
 * Newest-weighted conversation text, capped at `contextChars` characters.
 *
 * The newest messages survive whole. When the budget runs out, the tail of
 * the oldest kept message is included (its end is closest to the current
 * topic) and everything older is dropped.
 */
export function extractNamingInput(turns: readonly NamingTurnSource[], contextChars: number): string {
	const kept: string[] = [];
	let budget = contextChars;
	for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
		const text = turns[i].text;
		const line = `${turns[i].role}: ${text}`;
		if (line.length <= budget) {
			kept.push(line);
			budget -= line.length + 2;
		} else if (budget > 40) {
			kept.push(`…${line.slice(line.length - budget)}`);
			budget = 0;
		} else {
			break;
		}
	}
	return kept.reverse().join("\n\n");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const SESSION_NAMING_ENTRY_TYPE = "context-aware.session-naming.v1" as const;
export const SESSION_NAMING_SCHEMA_VERSION = 1 as const;

export type SessionNamingStatus = "active" | "named" | "exhausted" | "user-frozen";

export interface SessionNamingState {
	readonly schemaVersion: typeof SESSION_NAMING_SCHEMA_VERSION;
	readonly attemptsUsed: number;
	readonly status: SessionNamingStatus;
	/** How the current name was produced; absent while unnamed. */
	readonly nameKind?: "template" | "free-form";
	readonly revisionsUsed: number;
	readonly lastAttemptTurn?: number;
	readonly lastRevisionTurn?: number;
}

export function initialNamingState(): SessionNamingState {
	return { schemaVersion: SESSION_NAMING_SCHEMA_VERSION, attemptsUsed: 0, status: "active", revisionsUsed: 0 };
}

function withState(state: SessionNamingState, patch: Partial<SessionNamingState>): SessionNamingState {
	return { ...state, ...patch };
}

/** Parse one persisted entry; null for anything from a different version or shape. */
export function parseNamingStateEntry(value: unknown): SessionNamingState | null {
	if (typeof value !== "object" || value === null) return null;
	const data = (value as { data?: unknown }).data ?? value;
	if (typeof data !== "object" || data === null) return null;
	const candidate = data as Record<string, unknown>;
	if (candidate.schemaVersion !== SESSION_NAMING_SCHEMA_VERSION) return null;
	const status = candidate.status;
	if (status !== "active" && status !== "named" && status !== "exhausted" && status !== "user-frozen") return null;
	const attemptsUsed = candidate.attemptsUsed;
	const revisionsUsed = candidate.revisionsUsed;
	if (typeof attemptsUsed !== "number" || !Number.isSafeInteger(attemptsUsed) || attemptsUsed < 0) return null;
	if (typeof revisionsUsed !== "number" || !Number.isSafeInteger(revisionsUsed) || revisionsUsed < 0) return null;
	let nameKind: "template" | "free-form" | undefined;
	if (candidate.nameKind === "template" || candidate.nameKind === "free-form") nameKind = candidate.nameKind;
	else if (candidate.nameKind !== undefined) return null;
	return withState(initialNamingState(), {
		attemptsUsed,
		status,
		revisionsUsed,
		...(nameKind === undefined ? {} : { nameKind }),
		...(typeof candidate.lastAttemptTurn === "number" && Number.isSafeInteger(candidate.lastAttemptTurn)
			? { lastAttemptTurn: candidate.lastAttemptTurn }
			: {}),
		...(typeof candidate.lastRevisionTurn === "number" && Number.isSafeInteger(candidate.lastRevisionTurn)
			? { lastRevisionTurn: candidate.lastRevisionTurn }
			: {}),
	});
}

/** Replay persisted entries; the latest valid one wins. */
export function replayNamingStateEntries(entries: readonly unknown[]): SessionNamingState | null {
	let restored: SessionNamingState | null = null;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { customType?: unknown };
		if (candidate.customType !== SESSION_NAMING_ENTRY_TYPE) continue;
		const parsed = parseNamingStateEntry(entry);
		if (parsed) restored = parsed;
	}
	return restored;
}

// ---------------------------------------------------------------------------
// Startup decision
// ---------------------------------------------------------------------------

/**
 * The startup decision for one session: which state the controller starts
 * from, and whether the session is frozen from its first observed moment.
 *
 * A fork copies the parent's branch entries — the inherited name and the
 * parent's naming state ride along. The inherited name is user-set by
 * definition (#86): the child never revises it, and an unnamed child names
 * itself with a fresh budget (the parent's attempt budget and exhausted
 * state do not perpetuate to children). For any other start, a name observed
 * without persisted extension state is treated as user-set: we cannot prove
 * the name was ours, so fail closed.
 */
export function resolveStartupNamingState(
	restored: SessionNamingState | null,
	observedName: string | undefined,
	reason: string | undefined,
): { state: SessionNamingState; freeze: boolean } {
	if (reason === "fork") {
		return { state: initialNamingState(), freeze: observedName !== undefined };
	}
	return {
		state: restored ?? initialNamingState(),
		freeze: restored === null && observedName !== undefined,
	};
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface SessionNamingDeps {
	readonly config: SessionNamingConfig;
	/** True when the session is user-attached (config `sessionRole` is "foreground"). */
	readonly interactive: boolean;
	/** One-shot model call. `null` means the model chain is exhausted or the call failed. */
	readonly callModel: (systemPrompt: string, userText: string) => Promise<string | null>;
	/** Persist the session's name. The extension wraps this with echo suppression. */
	readonly applyName: (name: string) => void;
	/** The session's current name. */
	readonly currentName: () => string | undefined;
	/** The conversation turns so far. */
	readonly turns: () => readonly NamingTurnSource[];
	/**
	 * True while the session this controller was created for is still the
	 * active session. An attempt completing after the session was replaced
	 * or shut down is discarded before anything is written.
	 */
	readonly isActive?: () => boolean;
	/** Called after every state mutation so the host can persist it. */
	readonly onStateChange?: (state: SessionNamingState) => void;
	readonly log?: (message: string) => void;
}

/**
 * One session's naming state machine.
 *
 * The controller owns every decision in #86 — attempt rhythm, defer cap,
 * repair retry, template finality, revision checkpoints, freeze semantics,
 * and echo suppression. The extension only supplies the model call and the
 * session-name plumbing, and forwards events.
 */
export class SessionNamingController {
	readonly deps: SessionNamingDeps;
	private state: SessionNamingState;
	/** True while our own `applyName` is in flight; session_info_changed during it is our echo. */
	private suppressEcho = false;
	/**
	 * The last name we applied; an event carrying it is our echo even outside
	 * the suppression window. This is the live mechanism: pi emits
	 * session_info_changed asynchronously from the extension's perspective
	 * (agent-session.js emits via `void this._extensionRunner.emit(event)`),
	 * so the synchronous suppressEcho window never covers the event. Both
	 * mechanisms are kept deliberately; do not remove lastAppliedName.
	 */
	private lastAppliedName: string | undefined;
	/** True while a model call is in flight; a second overlapping event waits for the next checkpoint. */
	private inFlight = false;
	/** The most recent turn_end index observed; lets compaction revisions anchor the turn interval. */
	private lastSeenTurn: number | undefined;

	constructor(deps: SessionNamingDeps, restored?: SessionNamingState | null) {
		this.deps = deps;
		this.state = restored ?? initialNamingState();
	}

	getState(): SessionNamingState {
		return this.state;
	}

	private commit(patch: Partial<SessionNamingState>): void {
		this.state = withState(this.state, patch);
		this.deps.onStateChange?.(this.state);
	}

	private log(message: string): void {
		this.deps.log?.(`session naming: ${message}`);
	}

	/** User rename, RPC rename, or any other non-extension name setter. */
	freeze(reason: string): void {
		if (this.state.status === "user-frozen") return;
		this.commit({ status: "user-frozen" });
		this.log(`frozen permanently (${reason})`);
	}

	/**
	 * A name arrived from the outside. Our own echoes are ignored; everything
	 * else freezes the session permanently.
	 */
	handleInfoChanged(name: string | undefined): void {
		if (name === undefined) return;
		if (this.suppressEcho || name === this.lastAppliedName) return;
		this.freeze("name set outside the extension");
	}

	/** scope: "off" disables everything; "interactive" excludes worker sessions. */
	private scopeAllows(): boolean {
		const scope = this.deps.config.scope;
		if (scope === "off") return false;
		if (scope === "interactive" && !this.deps.interactive) return false;
		return true;
	}

	private unnamed(): boolean {
		return this.state.nameKind === undefined;
	}

	private provisional(): boolean {
		return this.state.nameKind === "free-form";
	}

	private budgetRemaining(): boolean {
		return this.unnamed() ? this.state.attemptsUsed < this.deps.config.attempts : this.state.revisionsUsed < this.deps.config.maxRevisions;
	}

	private canAttempt(): boolean {
		if (this.inFlight) return false;
		if (!this.scopeAllows()) return false;
		if (this.state.status === "user-frozen" || this.state.status === "exhausted") return false;
		if (this.state.status === "named" && this.state.nameKind === "template") return false;
		return this.budgetRemaining();
	}

	/** A turn ended: name if unnamed, or revise a provisional name at the K-turn checkpoint. */
	async handleTurnEnd(turnIndex: number): Promise<void> {
		this.lastSeenTurn = turnIndex;
		if (!this.canAttempt()) return;
		if (this.unnamed()) {
			await this.attempt(turnIndex, { mode: "name" });
			return;
		}
		const anchor = this.state.lastRevisionTurn ?? this.state.lastAttemptTurn ?? turnIndex;
		if (turnIndex - anchor < this.deps.config.reviseEveryTurns) return;
		await this.attempt(turnIndex, { mode: "revise", prior: { name: this.deps.currentName() ?? "", kind: "free-form" } });
	}

	/** A compaction landed: a provisional name is re-evaluated. The revision
	 * anchors the turn interval at the most recent turn_end, so the next
	 * interval revision really is K turns after this one. */
	async handleCompaction(): Promise<void> {
		if (!this.canAttempt() || !this.provisional()) return;
		await this.attempt(this.lastSeenTurn, { mode: "revise", prior: { name: this.deps.currentName() ?? "", kind: "free-form" } });
	}

	/** Resume: an unnamed session gets one naming attempt against the loaded history. */
	async handleResume(): Promise<void> {
		if (!this.canAttempt() || !this.unnamed()) return;
		await this.attempt(undefined, { mode: "name" });
	}

	private discardInFlight(expectedName: string | undefined): boolean {
		// The session was replaced or shut down while the call ran: nothing
		// this controller produced may be written anywhere.
		if (this.deps.isActive && !this.deps.isActive()) return true;
		// A user rename between dispatch and completion wins; our result dies.
		if (this.state.status === "user-frozen") return true;
		const current = this.deps.currentName();
		if (expectedName === undefined) return current !== undefined;
		return current !== expectedName;
	}

	/** One naming decision. Guarded: while a model call is in flight, later
	 * checkpoints return instead of double-calling (issue #86 review). */
	private async attempt(turnIndex: number | undefined, options: { mode: "name" | "revise"; prior?: { name: string; kind: "template" | "free-form" } }): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			await this.attemptUnguarded(turnIndex, options);
		} finally {
			this.inFlight = false;
		}
	}

	private async attemptUnguarded(turnIndex: number | undefined, options: { mode: "name" | "revise"; prior?: { name: string; kind: "template" | "free-form" } }): Promise<void> {
		const isRevision = options.mode === "revise";
		const nameBefore = this.deps.currentName();
		this.commit({
			attemptsUsed: this.state.attemptsUsed + 1,
			revisionsUsed: isRevision ? this.state.revisionsUsed + 1 : this.state.revisionsUsed,
			...(turnIndex === undefined ? {} : { lastAttemptTurn: turnIndex }),
			...(isRevision && turnIndex !== undefined ? { lastRevisionTurn: turnIndex } : {}),
		});

		const conversationText = extractNamingInput(this.deps.turns(), this.deps.config.contextChars);
		const answer = await this.deps.callModel(
			NAMING_SYSTEM_PROMPT,
			namingUserPrompt(conversationText, options.prior),
		);

		let parsed = answer === null ? null : parseNamingResponse(answer, this.deps.config.maxNameLength);

		// Malformed output gets exactly one repair retry; after that, a
		// free-form fallback from whatever the model did answer. The repair
		// call carries only the prior answer — a bounded re-format request,
		// not a second full-conversation call.
		const repairable = answer !== null && answer.trim().length > 0
			&& (parsed === null || (parsed.action === "name" && parsed.kind === "free-form" && !isRevision));
		if (repairable) {
			const repaired = await this.deps.callModel(
				NAMING_SYSTEM_PROMPT,
				namingRepairPrompt(answer),
			);
			const repairedParsed = repaired === null ? null : parseNamingResponse(repaired, this.deps.config.maxNameLength);
			if (repairedParsed && repairedParsed.action === "name" && repairedParsed.kind === "template") {
				parsed = repairedParsed;
			} else {
				// Keep the first answer's free-form reading; the repair attempt
				// produced nothing better.
			}
		}

		// The session may have been replaced, shut down, or renamed while the model
		// call(s) were in flight. Guard BEFORE any result-dependent write, so a stale
		// defer/null result cannot persist an exhausted status onto a session that has
		// stopped being active and burn a later resume's naming budget
		// (#86 review, CR-STALE-SESSION-WRITE).
		if (this.discardInFlight(nameBefore)) {
			this.log(`${options.mode} result discarded: the name changed or the session ended while the call was in flight`);
			return;
		}

		if (parsed === null || parsed.action === "defer") {
			this.log(`${options.mode} attempt ${this.state.attemptsUsed} returned ${parsed === null ? "nothing usable" : "defer"}`);
			if (!isRevision && this.unnamed() && this.state.attemptsUsed >= this.deps.config.attempts) {
				this.commit({ status: "exhausted" });
				this.log("attempt budget exhausted; the session stays unnamed");
			}
			return;
		}

		if (parsed.kind === "template") {
			this.commit({ status: "named", nameKind: "template" });
			this.applyName(parsed.name);
			this.log(`named "${parsed.name}" (template, final)`);
			return;
		}

		this.commit({ status: "named", nameKind: "free-form" });
		this.applyName(parsed.name);
		this.log(`named "${parsed.name}" (free-form, provisional)`);
	}

	private applyName(name: string): void {
		this.lastAppliedName = name;
		this.suppressEcho = true;
		try {
			this.deps.applyName(name);
		} finally {
			this.suppressEcho = false;
		}
	}
}
