/**
 * The operator request ledger (caair/pi/pi-context-aware#462).
 *
 * In a session with lots of event traffic (callback wakes, herdr pane events,
 * Fabric completions), a message the operator typed can go unanswered, or its
 * answer can sink under later event turns. Pi already says which input the
 * operator typed: the `input` event's `source` is `"interactive"`, or `"rpc"` for an
 * RPC client, which opens a request only when `operatorRequests.sources` lists it.
 * This module records each such input, tracks it until an assistant reply
 * answers it, reminds the model while it is open, asks for one more turn at the
 * end of a run that left it open, and shows the operator where the last answer is.
 *
 * State is rebuilt from the branch, never kept only in memory, so it survives a
 * restart and follows `/tree`.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OperatorRequestSource } from "../platform/config-layers.js";

export type { OperatorRequestSource } from "../platform/config-layers.js";

export const OPERATOR_REQUEST_ENTRY_TYPE = "context-aware.operator-request.v1" as const;
export const OPERATOR_REQUEST_REMINDER_TYPE = "context-aware.operator-request-reminder" as const;
export const OPERATOR_REPLY_WIDGET_KEY = "caair.context-aware/operator-reply" as const;
/** `/requests [n]` browses every request on the branch (caair/pi/pi-context-aware#507); it replaced `/reply`. */
export const OPERATOR_REQUESTS_COMMAND = "requests" as const;

const REMINDER_LIMIT = 3;
/**
 * The trimmed length at which a reply sent with tool calls is a progress report, not a preamble
 * (caair/pi/pi-context-aware#505). "Let me check the code." stays well below it; two sentences of findings
 * reach it.
 */
export const PROGRESS_MIN_CHARS = 160;
/** Only typed input opens a request unless `operatorRequests.sources` lists more (caair/pi/pi-context-aware#506). */
const DEFAULT_SOURCES: readonly OperatorRequestSource[] = ["interactive"];
const EXCERPT_CHARS = 300;
/** An idle input is saved within moments; a marker older than this was swallowed by another input handler. */
const IDLE_PAIR_WINDOW_MS = 60_000;
/** The RPC fallback of `/requests` prints to the operator's terminal: at most this much of a request and of its answer. */
const REPLY_REQUEST_CHARS = 2_000;
const REPLY_ANSWER_CHARS = 4_000;
const REPLY_LINES = 60;

export interface OperatorAnswer {
	readonly entryId: string;
	readonly text: string;
	readonly at: number;
}

export interface OperatorRequest {
	/** The id of the user message entry that carries the request. */
	readonly entryId: string;
	readonly text: string;
	readonly at: number;
	answer: OperatorAnswer | undefined;
	/**
	 * The latest progress report while the request is unanswered: a substantial reply the model sent with tool
	 * calls. It marks the request in progress; only a final reply answers it.
	 */
	progress: OperatorAnswer | undefined;
	/** Event turns after the request: input groups that did not start with an operator request. */
	eventsAfter: number;
	/** Event turns after the request's answer; 0 while it is unanswered. */
	eventsSinceAnswer: number;
}

export interface OperatorLedger {
	/** Every request on the branch, oldest first. */
	readonly requests: readonly OperatorRequest[];
	/** Requests not yet answered, oldest first. */
	readonly open: readonly OperatorRequest[];
	/** The newest reply that answered an operator request; replies to event turns never count. */
	readonly lastAnswer: OperatorAnswer | undefined;
	/** Event turns since the last answer, or since the start when there is none. */
	readonly eventsSinceLastAnswer: number;
}

/** A typed `/skill:name args`: what Pi's skill expansion keeps of it, so the expanded message can be matched. */
interface SkillInvocation {
	readonly name: string;
	readonly argsHash: string;
	readonly argsLength: number;
}

interface PendingMarker {
	readonly hash: string;
	readonly at: number;
	/** Typed while Pi was idle: Pi saves it as the run's first message, before the model replies. */
	readonly idle: boolean;
	readonly skill: SkillInvocation | undefined;
}

export function operatorTextHash(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Pi expands `/skill:<name> [args]` after the input event (AgentSession._expandSkillCommand): the name is the
 * text up to the first space, and the args are the rest, trimmed.
 */
function skillInvocation(text: string): SkillInvocation | undefined {
	if (!text.startsWith("/skill:")) return undefined;
	const space = text.indexOf(" ");
	const name = space === -1 ? text.slice(7) : text.slice(7, space);
	const args = space === -1 ? "" : text.slice(space + 1).trim();
	return name.length > 0 ? { name, argsHash: operatorTextHash(args), argsLength: args.length } : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function skillOf(value: unknown): SkillInvocation | undefined {
	const skill = record(value);
	return typeof skill?.name === "string" && typeof skill.argsHash === "string" && typeof skill.argsLength === "number"
		? { name: skill.name, argsHash: skill.argsHash, argsLength: skill.argsLength }
		: undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(record)
		.filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function timeOf(entry: Record<string, unknown>, message?: Record<string, unknown>): number {
	if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whether this saved message is the input the marker recorded: the same text, or Pi's expansion of the typed
 * skill (its block for that skill name, then exactly the typed args). A prompt template's expansion depends on
 * the template file, so it cannot be shown to come from the input and never pairs.
 */
function provenBy(marker: PendingMarker, text: string): boolean {
	if (marker.hash === operatorTextHash(text)) return true;
	const skill = marker.skill;
	if (!skill || !text.startsWith(`<skill name="${skill.name}" location="`)) return false;
	if (skill.argsLength === 0) return text.endsWith("\n</skill>");
	const cut = text.length - skill.argsLength;
	return text.slice(0, cut).endsWith("\n</skill>\n\n") && operatorTextHash(text.slice(cut)) === skill.argsHash;
}

/** This extension's own per-turn messages are bookkeeping, not events. */
function isOwnCustomType(customType: unknown): boolean {
	return typeof customType === "string" && (customType.startsWith("context-aware") || customType.startsWith("context-cache"));
}

/**
 * A final reply: text, and a stop that hands the turn back. A tool-use stop is
 * mid-work; an error or abort is not an answer.
 */
function answerText(message: Record<string, unknown>): string | undefined {
	const stop = message.stopReason;
	if (stop !== undefined && stop !== "stop" && stop !== "length") return undefined;
	const text = textOf(message.content);
	return text.length > 0 ? text : undefined;
}

/** A progress report: substantial text sent with tool calls, which says the model is working on the request. */
function progressText(message: Record<string, unknown>): string | undefined {
	if (message.stopReason !== "toolUse") return undefined;
	const text = textOf(message.content);
	return text.length >= PROGRESS_MIN_CHARS ? text : undefined;
}

/**
 * Rebuild the ledger from the session branch, oldest entry first.
 *
 * Inputs arrive in groups: the user or custom messages between two model
 * responses. Pi persists a turn's trigger first and the messages other
 * extensions attach in `before_agent_start` after it, and a steered message
 * lands after a tool result. A group that starts with an operator request
 * belongs to that request; any other group is one event turn.
 *
 * A marker pairs only with a message it proves (see `provenBy`), so another
 * extension's text never becomes a request. Markers that cannot pair any more
 * expire: an idle one at the next reply or after the idle window, a queued one
 * when the operator next types while Pi is idle, as Pi has then delivered or
 * dropped everything queued.
 */
export function buildOperatorLedger(branch: readonly unknown[]): OperatorLedger {
	const requests: OperatorRequest[] = [];
	let pending: PendingMarker[] = [];
	let lastAnswer: OperatorAnswer | undefined;
	let eventsSinceLastAnswer = 0;
	let inGroup = false;
	const input = (isRequest: boolean): void => {
		const starts = !inGroup;
		inGroup = true;
		if (!starts || isRequest) return;
		eventsSinceLastAnswer += 1;
		for (const request of requests) {
			if (request.answer === undefined) request.eventsAfter += 1;
			else request.eventsSinceAnswer += 1;
		}
	};
	for (const raw of branch) {
		const entry = record(raw);
		if (!entry) continue;
		if (entry.type === "custom") {
			if (entry.customType !== OPERATOR_REQUEST_ENTRY_TYPE) continue;
			const data = record(entry.data);
			if (typeof data?.hash !== "string") continue;
			const marker = { hash: data.hash, at: typeof data.at === "number" ? data.at : timeOf(entry), idle: data.idle === true, skill: skillOf(data.skill) };
			if (marker.idle) pending = pending.filter((older) => older.idle);
			pending.push(marker);
			continue;
		}
		const message = entry.type === "custom_message"
			? { role: "custom", customType: entry.customType }
			: entry.type === "message" ? record(entry.message) : undefined;
		if (!message) continue;
		const at = timeOf(entry, message);
		pending = pending.filter((marker) => !marker.idle || at - marker.at <= IDLE_PAIR_WINDOW_MS);
		if (message.role === "user") {
			const text = textOf(message.content);
			const index = pending.findIndex((marker) => provenBy(marker, text));
			if (index >= 0) {
				const [marker] = pending.splice(index, 1);
				requests.push({ entryId: String(entry.id ?? ""), text, at: marker?.at ?? at, answer: undefined, progress: undefined, eventsAfter: 0, eventsSinceAnswer: 0 });
			}
			input(index >= 0);
			continue;
		}
		if (message.role === "custom") {
			if (!isOwnCustomType(message.customType)) input(false);
			continue;
		}
		if (message.role === "toolResult") {
			inGroup = false;
			continue;
		}
		if (message.role !== "assistant") continue;
		inGroup = false;
		// Pi saves an idle input before the model replies; a marker still unpaired here never became a message.
		pending = pending.filter((marker) => !marker.idle);
		const report = progressText(message);
		if (report !== undefined) {
			for (const request of requests) if (request.answer === undefined) request.progress = { entryId: String(entry.id ?? ""), text: report, at };
			continue;
		}
		const text = answerText(message);
		if (text === undefined) continue;
		const unanswered = requests.filter((request) => request.answer === undefined);
		// A reply to an event turn is not a reply to the operator; the widget must keep pointing past it.
		if (unanswered.length === 0) continue;
		const answer = { entryId: String(entry.id ?? ""), text, at };
		for (const request of unanswered) request.answer = answer;
		lastAnswer = answer;
		eventsSinceLastAnswer = 0;
	}
	return {
		requests,
		open: requests.filter((request) => request.answer === undefined),
		lastAnswer,
		eventsSinceLastAnswer,
	};
}

export function formatAgo(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * Every Unicode format character (`\p{Cf}`): bidirectional overrides and isolates, zero-width characters, the
 * soft hyphen, and the tag characters U+E0000-E007F, which can carry hidden ASCII text.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Line breaks, other whitespace, and C0 and C1 control characters (ESC, BEL, CSI). */
// eslint-disable-next-line no-control-regex
const BREAKS_AND_CONTROLS = /[\s\u0000-\u001f\u007f-\u009f]+/gu;
/** Control characters a terminal acts on; line feeds and tabs stay. */
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * The request as model-facing data: one line, with no control or format characters, at most 300 characters, in
 * JSON quotes so a quote in the text cannot end it, and with a visible marker when it was cut.
 */
function quotedRequest(text: string): string {
	const flat = text.replace(FORMAT_CHARACTERS, "").replace(BREAKS_AND_CONTROLS, " ").trim();
	if (flat.length <= EXCERPT_CHARS) return JSON.stringify(flat);
	return `${JSON.stringify(flat.slice(0, EXCERPT_CHARS))} (cut to ${EXCERPT_CHARS} of ${flat.length} characters)`;
}

/** The label comes first, so the model reads what the quoted text is before the text itself. */
function requestLine(request: OperatorRequest, now: number): string {
	return `Open operator request (${minutesAgo(now - request.at)}). The operator wrote: ${quotedRequest(request.text)}`;
}

/** An in-progress request: how long it has run and when the latest report came. Its label also comes first. */
function progressLine(request: OperatorRequest, progress: OperatorAnswer, now: number): string {
	return `Operator request in progress (${minutes(now - request.at)}, last update ${minutesAgo(now - progress.at)}). The operator wrote: ${quotedRequest(request.text)}`;
}

function minutes(ms: number): string {
	const count = Math.max(0, Math.round(ms / 60_000));
	return count < 1 ? "under 1 min" : `${count} min`;
}

function minutesAgo(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 1 ? "just now" : `${minutes} min ago`;
}

/**
 * The reminder for requests that an event arrived after, newest first. Only an
 * event makes a reminder due: while the agent works on the request itself, no
 * reminder is needed.
 */
export function operatorReminder(ledger: OperatorLedger, now: number): string | undefined {
	const due = ledger.open.filter((request) => request.eventsAfter > 0).slice(-REMINDER_LIMIT).reverse();
	if (due.length === 0) return undefined;
	const lines = due.map((request) => request.progress
		? `${progressLine(request, request.progress, now)} Keep working on it and report back to the operator when it is done; do not switch to unrelated work.`
		: `${requestLine(request, now)} Answer it before continuing other work; a stopped run does not close it.`);
	const left = leftOutLine(ledger.open.filter((request) => request.eventsAfter > 0).length - due.length);
	return [...lines, ...(left ? [left] : [])].join("\n");
}

/** The line that says how many older open requests a capped list left out, or nothing when none were. */
function leftOutLine(count: number): string | undefined {
	if (count <= 0) return undefined;
	return `${count} older open request${count === 1 ? "" : "s"} not shown; /${OPERATOR_REQUESTS_COMMAND} lists them.`;
}

/**
 * Whether the model ended the run. A run a tool ended (`context_compact` queues
 * a compaction and terminates the run) ends on a tool result, and a
 * continuation would undo what that tool asked for.
 */
export function endedOnAssistant(branch: readonly unknown[]): boolean {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = record(branch[index]);
		if (entry?.type !== "message") continue;
		return record(entry.message)?.role === "assistant";
	}
	return false;
}

/** The note that asks for one more turn when a run ends with a request still open. */
export function operatorSettleNote(open: readonly OperatorRequest[], now: number): string {
	const lines = [...open].slice(-REMINDER_LIMIT).reverse().map((request) => requestLine(request, now));
	const left = leftOutLine(open.length - lines.length);
	return [
		"The run is ending, but the operator's request has no reply yet.",
		...lines,
		...(left ? [left] : []),
		"Reply to the operator now, in plain text. If the work is not finished, say where it stands.",
	].join("\n");
}

/** One line below the editor, or nothing when the newest thing is the answer itself. */
export function operatorWidgetLine(ledger: OperatorLedger, now: number): string | undefined {
	const newestOpen = ledger.open.at(-1);
	if (newestOpen?.progress) return `working on your request (${formatAgo(now - newestOpen.at)}) · update ${formatAgo(now - newestOpen.progress.at)} ago`;
	if (newestOpen) return `your request is open (${formatAgo(now - newestOpen.at)})`;
	if (!ledger.lastAnswer || ledger.eventsSinceLastAnswer === 0) return undefined;
	const count = ledger.eventsSinceLastAnswer;
	return `last reply to you ${formatAgo(now - ledger.lastAnswer.at)} ago · ${count} event turn${count === 1 ? "" : "s"} since · /${OPERATOR_REQUESTS_COMMAND}`;
}

/**
 * Stored text for the operator's terminal: no control or format characters, at most `maxLines` lines and
 * `maxChars` characters, each cut shown with a marker line.
 */
function terminalText(text: string, maxChars: number): string {
	const clean = text.replace(/\r\n/gu, "\n").replace(FORMAT_CHARACTERS, "").replace(TERMINAL_CONTROLS, "");
	const lines = clean.split("\n");
	if (lines.length > REPLY_LINES) return `${lines.slice(0, REPLY_LINES).join("\n").slice(0, maxChars)}\n[cut: showing ${REPLY_LINES} of ${lines.length} lines]`;
	if (clean.length > maxChars) return `${clean.slice(0, maxChars)}\n[cut: showing ${maxChars} of ${clean.length} characters]`;
	return clean;
}

/** `/requests [n]` without a TUI: the n-th newest request (1 is the newest) and its answer, cut to fit the terminal. */
export function formatOperatorReply(ledger: OperatorLedger, n: number, now: number): string {
	const newestFirst = [...ledger.requests].reverse();
	if (newestFirst.length === 0) return "No request from you on this branch yet.";
	const request = newestFirst[n - 1];
	if (!request) return `Only ${newestFirst.length} request${newestFirst.length === 1 ? "" : "s"} on this branch.`;
	const status = request.answer
		? `Answer (${formatAgo(now - request.answer.at)} ago):\n${terminalText(request.answer.text, REPLY_ANSWER_CHARS)}`
		: request.progress
		? `In progress, no answer yet (last update ${formatAgo(now - request.progress.at)} ago):\n${terminalText(request.progress.text, REPLY_ANSWER_CHARS)}`
		: "No answer yet. The request stays open until the agent replies; Esc or any other abort does not close it.";
	return [`Your request ${n} of ${newestFirst.length} (${formatAgo(now - request.at)} ago):`, terminalText(request.text, REPLY_REQUEST_CHARS), "", status].join("\n");
}

export type OperatorRequestState = "open" | "in progress" | "answered";

function stateOf(request: OperatorRequest): OperatorRequestState {
	return request.answer ? "answered" : request.progress ? "in progress" : "open";
}

/** One row of the `/requests` list. */
export interface OperatorRequestRow {
	readonly state: OperatorRequestState;
	/** Time since the request, as `formatAgo` writes it. */
	readonly age: string;
	/** The request's first non-empty line, without control or format characters. */
	readonly summary: string;
	/** Event turns since the answer; 0 for a request not yet answered. */
	readonly eventTurns: number;
}

/** Stored text for the overlay: no format characters, and no control characters except line feeds. */
function displayText(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(FORMAT_CHARACTERS, "").replace(/\t/gu, " ").replace(TERMINAL_CONTROLS, "");
}

/** Every request on the branch, newest first. */
export function operatorRequestRows(ledger: OperatorLedger, now: number): OperatorRequestRow[] {
	return [...ledger.requests].reverse().map((request) => ({
		state: stateOf(request),
		age: formatAgo(now - request.at),
		summary: displayText(request.text).split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "",
		eventTurns: request.eventsSinceAnswer,
	}));
}

export function requestRowText(row: OperatorRequestRow): string {
	const since = row.state === "answered" ? ` · ${row.eventTurns} event turn${row.eventTurns === 1 ? "" : "s"} since the answer` : "";
	return `${row.state} · ${row.age} ago${since} · ${row.summary}`;
}

/** Cut plain text to `width` terminal columns, ending a cut line with an ellipsis. */
function clip(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = "";
	for (const char of line) {
		if (visibleWidth(out + char) > width - 1) break;
		out += char;
	}
	return `${out}…`;
}

function wrapped(text: string, width: number): string[] {
	return displayText(text).split("\n").flatMap((line) => line.length === 0 ? [""] : wrapTextWithAnsi(line, width).map((part) => clip(part, width)));
}

/** The detail view of the n-th newest request: the full request and answer, or its latest progress, wrapped to `width`. */
export function operatorRequestDetail(ledger: OperatorLedger, n: number, now: number, width: number): string[] {
	const newestFirst = [...ledger.requests].reverse();
	const request = newestFirst[n - 1];
	if (!request) return [formatOperatorReply(ledger, n, now)];
	const status = request.answer
		? [`Answer (${formatAgo(now - request.answer.at)} ago):`, ...wrapped(request.answer.text, width)]
		: request.progress
		? [`In progress, no answer yet (last update ${formatAgo(now - request.progress.at)} ago):`, ...wrapped(request.progress.text, width)]
		: wrapped("No answer yet. The request stays open until the agent replies; Esc or any other abort does not close it.", width);
	return [
		...wrapped(`Request ${n} of ${newestFirst.length} · ${stateOf(request)} · ${formatAgo(now - request.at)} ago`, width),
		"",
		...wrapped(request.text, width),
		"",
		...status,
	];
}

export interface RequestsViewState {
	readonly screen: "list" | "detail";
	/** Index into the newest-first list. */
	readonly selected: number;
	/** First detail line shown. */
	readonly scroll: number;
}

export type RequestsViewAction = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel";

/** The overlay's key handling: the next state, or `"close"` when Esc is pressed on the list. */
export function requestsViewKey(
	state: RequestsViewState,
	action: RequestsViewAction,
	sizes: { readonly count: number; readonly detailLines: number; readonly height: number },
): RequestsViewState | "close" {
	const page = Math.max(1, sizes.height);
	const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max));
	if (state.screen === "list") {
		const last = sizes.count - 1;
		switch (action) {
			case "up": return { ...state, selected: clamp(state.selected - 1, last) };
			case "down": return { ...state, selected: clamp(state.selected + 1, last) };
			case "pageUp": return { ...state, selected: clamp(state.selected - page, last) };
			case "pageDown": return { ...state, selected: clamp(state.selected + page, last) };
			case "confirm": return sizes.count === 0 ? state : { screen: "detail", selected: state.selected, scroll: 0 };
			case "cancel": return "close";
		}
	}
	const maxScroll = sizes.detailLines - page;
	switch (action) {
		case "up": return { ...state, scroll: clamp(state.scroll - 1, maxScroll) };
		case "down": return { ...state, scroll: clamp(state.scroll + 1, maxScroll) };
		case "pageUp": return { ...state, scroll: clamp(state.scroll - page, maxScroll) };
		case "pageDown": return { ...state, scroll: clamp(state.scroll + page, maxScroll) };
		case "confirm": return state;
		case "cancel": return { screen: "list", selected: state.selected, scroll: 0 };
	}
}

const VIEW_ACTIONS: ReadonlyArray<readonly [string, RequestsViewAction]> = [
	["tui.select.up", "up"],
	["tui.select.down", "down"],
	["tui.select.pageUp", "pageUp"],
	["tui.select.pageDown", "pageDown"],
	["tui.select.confirm", "confirm"],
	["tui.select.cancel", "cancel"],
];

interface OverlayTui { requestRender(): void; readonly terminal?: { readonly rows?: number } }
interface OverlayKeybindings { matches(data: string, action: string): boolean }

/** Overlay chrome: a title above and a key hint below the body. */
const OVERLAY_CHROME_LINES = 3;

/**
 * The `/requests` overlay. It reads one snapshot of the ledger and writes nothing, so opening, browsing and
 * closing it add nothing to the session.
 */
function requestsOverlay(ledger: OperatorLedger, now: number, selected: number, tui: OverlayTui, keybindings: OverlayKeybindings, done: () => void) {
	const rows = operatorRequestRows(ledger, now);
	let state: RequestsViewState = { screen: "list", selected: Math.min(Math.max(0, selected), Math.max(0, rows.length - 1)), scroll: 0 };
	let width = 80;
	const height = (): number => Math.max(3, Math.floor((tui.terminal?.rows ?? 24) * 0.8) - OVERLAY_CHROME_LINES);
	const detail = (): string[] => operatorRequestDetail(ledger, state.selected + 1, now, width);
	return {
		render(renderWidth: number): string[] {
			width = Math.max(10, renderWidth);
			const fit = (line: string) => clip(line, width);
			if (state.screen === "detail") {
				const lines = detail();
				const body = lines.slice(state.scroll, state.scroll + height());
				const shown = lines.length > height() ? ` · lines ${state.scroll + 1}-${state.scroll + body.length} of ${lines.length}` : "";
				return [...body.map(fit), "", fit(`↑↓ scroll · PgUp/PgDn page · Esc back${shown}`)];
			}
			if (rows.length === 0) return [fit("Your requests"), "", fit("No request from you on this branch yet."), "", fit("Esc close")];
			const first = Math.min(Math.max(0, state.selected - height() + 1), Math.max(0, rows.length - height()));
			const body = rows.slice(first, first + height()).map((row, index) => fit(`${first + index === state.selected ? ">" : " "} ${requestRowText(row)}`));
			return [fit(`Your requests (${rows.length})`), "", ...body, "", fit("↑↓ select · Enter open · Esc close")];
		},
		handleInput(data: string): void {
			const action = VIEW_ACTIONS.find(([binding]) => keybindings.matches(data, binding))?.[1];
			if (!action) return;
			const next = requestsViewKey(state, action, { count: rows.length, detailLines: state.screen === "detail" ? detail().length : 0, height: height() });
			if (next === "close") {
				done();
				return;
			}
			state = next;
			tui.requestRender();
		},
		invalidate(): void { /* Rendering reads only the snapshot and the width; nothing is cached. */ },
	};
}

export interface OperatorRequestOptions {
	readonly enabled: (ctx: ExtensionContext) => boolean;
	/** The input sources that open a request; typed input only when omitted. */
	readonly sources?: (ctx: ExtensionContext) => readonly OperatorRequestSource[];
	readonly now?: () => number;
}

export interface OperatorRequestController {
	readonly ledger: (ctx: ExtensionContext) => OperatorLedger;
	/**
	 * The reminder the latest `context` call appended, which is not saved. The provider hook keeps the cache
	 * breakpoint before it, so the reminder never ends a cached prefix the next request cannot repeat.
	 */
	readonly injection: (ctx: ExtensionContext) => string | undefined;
}

/**
 * Register the ledger's hooks. Call it after every other `context` handler, so
 * the reminder is appended to the list the other handlers produced.
 *
 * Any abort leaves open requests open. Pi reports `agent_settled.aborted` for
 * every `abort()`, from Esc or from code such as this package's compaction
 * drain, and gives no way to tell them apart; an aborted run only gets no
 * continuation.
 */
export function registerOperatorRequests(pi: ExtensionAPI, options: OperatorRequestOptions): OperatorRequestController {
	const now = options.now ?? Date.now;
	// One continuation per request; a restart may grant one more, which is harmless.
	const continued = new WeakMap<object, Set<string>>();
	const shownLine = new WeakMap<object, string | undefined>();
	const injected = new WeakMap<object, string>();
	const ledger = (ctx: ExtensionContext): OperatorLedger => buildOperatorLedger(ctx.sessionManager.getBranch());
	const opensRequest = (source: unknown, ctx: ExtensionContext): boolean => {
		if (source !== "interactive" && source !== "rpc") return false;
		try { return (options.sources?.(ctx) ?? DEFAULT_SOURCES).includes(source); } catch { return false; }
	};
	const active = (ctx: ExtensionContext): boolean => {
		try { return ctx.hasUI === true && options.enabled(ctx); } catch { return false; }
	};
	const refreshWidget = (ctx: ExtensionContext, clear = false): void => {
		if (typeof ctx.ui?.setWidget !== "function") return;
		const line = clear || !active(ctx) ? undefined : operatorWidgetLine(ledger(ctx), now());
		const key = ctx.sessionManager as object;
		if (shownLine.has(key) && shownLine.get(key) === line) return;
		shownLine.set(key, line);
		try { ctx.ui.setWidget(OPERATOR_REPLY_WIDGET_KEY, line === undefined ? undefined : [line], { placement: "belowEditor" }); } catch { /* The widget is a convenience; never fail a hook over it. */ }
	};

	pi.on("input", (event, ctx) => {
		if (!opensRequest(event.source, ctx) || !active(ctx)) return;
		const text = event.text.trim();
		if (text.length === 0) return;
		const skill = skillInvocation(text);
		pi.appendEntry(OPERATOR_REQUEST_ENTRY_TYPE, { schemaVersion: 1, hash: operatorTextHash(text), at: now(), idle: event.streamingBehavior === undefined, ...(skill ? { skill } : {}) });
	});
	pi.on("message_end", (_event, ctx) => refreshWidget(ctx));
	pi.on("context", (event, ctx) => {
		const key = ctx.sessionManager as object;
		const reminder = active(ctx) ? operatorReminder(ledger(ctx), now()) : undefined;
		if (reminder === undefined) {
			injected.delete(key);
			return undefined;
		}
		injected.set(key, reminder);
		return {
			messages: [...event.messages, { role: "custom" as const, customType: OPERATOR_REQUEST_REMINDER_TYPE, content: reminder, display: false, timestamp: now() }],
		};
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || !active(ctx)) return undefined;
		const key = ctx.sessionManager as object;
		const done = continued.get(key) ?? new Set<string>();
		continued.set(key, done);
		const branch = ctx.sessionManager.getBranch();
		if (!endedOnAssistant(branch)) return undefined;
		const owed = buildOperatorLedger(branch).open.filter((request) => !done.has(request.entryId));
		if (owed.length === 0) return undefined;
		for (const request of owed) done.add(request.entryId);
		const note: SessionBoundaryDraft = { type: "custom_message", customType: OPERATOR_REQUEST_REMINDER_TYPE, content: operatorSettleNote(owed, now()), display: false };
		return { entries: [...event.entries, note], continue: true };
	});
	pi.on("agent_settled", (_event, ctx) => refreshWidget(ctx));
	pi.on("session_start", (_event, ctx) => refreshWidget(ctx));
	pi.on("session_tree", (_event, ctx) => refreshWidget(ctx));
	pi.on("session_shutdown", (_event, ctx) => refreshWidget(ctx, true));

	pi.registerCommand(OPERATOR_REQUESTS_COMMAND, {
		description: "Browse your requests on this branch and the agent's answers, without adding anything to the session. Usage: /requests [n], where n counts back from the newest (1).",
		handler: async (args, ctx) => {
			const parsed = Number.parseInt(args.trim() || "1", 10);
			const n = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
			const snapshot = ledger(ctx);
			const at = now();
			if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
				const shown = await ctx.ui.custom<null>(
					(tui, _theme, keybindings, done) => requestsOverlay(snapshot, at, n - 1, tui, keybindings, () => done(null)),
					{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
				);
				if (shown !== undefined) return;
			}
			ctx.ui.notify(formatOperatorReply(snapshot, n, at), "info");
		},
	});
	return { ledger, injection: (ctx) => injected.get(ctx.sessionManager as object) };
}