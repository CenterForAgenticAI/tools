/**
 * Questions a blocked task asks the user, and their answers.
 *
 * Session entries are the source of truth, so replay, reload and `/tree` see
 * asks the way they see tasks:
 * - `context-aware.ask.v1` records the question on a task;
 * - `context-aware.ask-raised.v1` records the Fabric decision that carries it;
 * - `context-aware.answer.v1` records the first answer. Later answers are ignored;
 * - `context-aware.ask-closed.v1` records that the ask's task was removed or
 *   replaced, so the ask can never attach to a later task that reuses the id.
 *
 * An ask is open while it has no answer or close entry, its task still exists,
 * and no later ask on the same task replaced it.
 *
 * Fabric decisions are only a transport, spoken through Fabric's public events
 * (`pi-fabric:decisions:capability:v1` and `pi-fabric:decisions:request:v1`).
 * This module does not import Fabric: the shapes below mirror its published
 * protocol, and an unclaimed event means Fabric is not loaded, so the ask stays
 * in-session.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactText } from "../workstream/workstream-safety.js";
import { findTask, isValidTaskRef, MAX_TASK_ID_CHARS, type Task } from "./session-tasks.js";

export const ASK_ENTRY_TYPE = "context-aware.ask.v1" as const;
export const ASK_RAISED_ENTRY_TYPE = "context-aware.ask-raised.v1" as const;
export const ANSWER_ENTRY_TYPE = "context-aware.answer.v1" as const;
export const ASK_CLOSED_ENTRY_TYPE = "context-aware.ask-closed.v1" as const;
export const ASK_SCHEMA_VERSION = 1 as const;

export const MAX_ASK_QUESTION_CHARS = 500;
export const MAX_ASK_OPTIONS = 8;
export const MAX_ASK_OPTION_LABEL_CHARS = 80;
export const MAX_ASK_ANSWER_CHARS = 500;
/** Option ids follow the task-id rules. */
export const MAX_ASK_OPTION_ID_CHARS = MAX_TASK_ID_CHARS;
const MAX_ASK_ID_CHARS = 64;
const MAX_DECISION_ID_CHARS = 128;
const MAX_TIMESTAMP_CHARS = 64;

/** Names this extension to Fabric; recorded as `extension:pi-context-aware`. */
export const ASK_SOURCE = "pi-context-aware" as const;
export const FABRIC_DECISIONS_CAPABILITY_EVENT = "pi-fabric:decisions:capability:v1" as const;
export const FABRIC_DECISION_REQUEST_EVENT = "pi-fabric:decisions:request:v1" as const;
/** How long to wait for Fabric to say whether decisions are available. */
const CAPABILITY_TIMEOUT_MS = 10_000;

export const ASK_ANSWER_MESSAGE_TYPE = "context-aware-ask-answer" as const;
/** Delivery for a relayed answer: a message that starts a turn, queued as a follow-up. */
export const ASK_ANSWER_DELIVERY = { triggerTurn: true, deliverAs: "followUp" } as const;

export type AnswerRoute = "fabric" | "command" | "agent";
export const ANSWER_ROUTES: readonly AnswerRoute[] = ["fabric", "command", "agent"];

export interface AskOption {
	readonly id: string;
	readonly label: string;
}

export interface AskEntry {
	readonly schemaVersion: typeof ASK_SCHEMA_VERSION;
	readonly askId: string;
	readonly taskId: string;
	readonly goal?: string;
	readonly question: string;
	readonly options?: readonly AskOption[];
	readonly createdAt: string;
}

export interface AskRaisedEntry {
	readonly askId: string;
	readonly decisionId: string;
}

export interface AnswerEntry {
	readonly askId: string;
	readonly answer: string;
	readonly route: AnswerRoute;
	readonly answeredAt: string;
}

export type AskCloseReason = "task-removed" | "task-replaced";
export const ASK_CLOSE_REASONS: readonly AskCloseReason[] = ["task-removed", "task-replaced"];

export interface AskClosedEntry {
	readonly askId: string;
	readonly reason: AskCloseReason;
	readonly closedAt: string;
}

export interface AskState {
	readonly ask: AskEntry;
	readonly decisionIds: readonly string[];
	readonly answer?: AnswerEntry;
	readonly closed?: AskClosedEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validTimestamp(value: unknown): value is string {
	return boundedString(value, MAX_TIMESTAMP_CHARS) && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Caller input
// ---------------------------------------------------------------------------

export type Prepared<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface PreparedAsk {
	readonly question: string;
	readonly options?: readonly AskOption[];
}

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/**
 * Validate and redact an ask from caller input. Only `question` and each
 * option's `id` and `label` are read; nothing else the caller sent is kept.
 * Over-long text is refused with a reason, never truncated.
 */
export function prepareAsk(input: unknown): Prepared<PreparedAsk> {
	if (!isRecord(input)) return { ok: false, reason: "ask must be an object with a question" };
	const rawQuestion = input.question;
	if (typeof rawQuestion !== "string" || rawQuestion.trim().length === 0) return { ok: false, reason: "ask needs a non-empty question" };
	if (rawQuestion.length > MAX_ASK_QUESTION_CHARS) {
		return { ok: false, reason: `ask question is ${rawQuestion.length} characters; the limit is ${MAX_ASK_QUESTION_CHARS}` };
	}
	const question = redactText(rawQuestion, { maxLength: MAX_ASK_QUESTION_CHARS }).trim();
	if (question.length === 0) return { ok: false, reason: "ask question is empty after redaction" };
	if (input.options === undefined) return { ok: true, value: { question } };
	if (!Array.isArray(input.options)) return { ok: false, reason: "ask options must be an array of {id, label}" };
	if (input.options.length > MAX_ASK_OPTIONS) return { ok: false, reason: `ask takes at most ${MAX_ASK_OPTIONS} options` };
	const options: AskOption[] = [];
	const seen = new Set<string>();
	for (const option of input.options as unknown[]) {
		if (!isRecord(option)) return { ok: false, reason: "each ask option needs an id and a label" };
		const { id, label } = option;
		if (typeof id !== "string" || !isValidTaskRef(id)) {
			return { ok: false, reason: `ask option id must use letters, digits, ".", "_" or "-" and be at most ${MAX_ASK_OPTION_ID_CHARS} characters` };
		}
		if (seen.has(id)) return { ok: false, reason: `ask option id ${id} is repeated` };
		if (typeof label !== "string" || label.trim().length === 0 || label.length > MAX_ASK_OPTION_LABEL_CHARS) {
			return { ok: false, reason: `ask option ${id} needs a label of at most ${MAX_ASK_OPTION_LABEL_CHARS} characters` };
		}
		const safeLabel = oneLine(redactText(label, { maxLength: MAX_ASK_OPTION_LABEL_CHARS }));
		if (safeLabel.length === 0) return { ok: false, reason: `ask option ${id} label is empty after redaction` };
		seen.add(id);
		options.push({ id, label: safeLabel });
	}
	return { ok: true, value: options.length === 0 ? { question } : { question, options } };
}

/** Validate and redact an answer the agent or the user supplied. */
export function prepareAnswer(input: unknown): Prepared<string> {
	if (typeof input !== "string" || input.trim().length === 0) return { ok: false, reason: "answer must be non-empty text" };
	if (input.length > MAX_ASK_ANSWER_CHARS) return { ok: false, reason: `answer is ${input.length} characters; the limit is ${MAX_ASK_ANSWER_CHARS}` };
	const answer = redactText(input, { maxLength: MAX_ASK_ANSWER_CHARS }).trim();
	return answer.length === 0 ? { ok: false, reason: "answer is empty after redaction" } : { ok: true, value: answer };
}


/** `/answer` input: an option id or label resolves to the option's label; other text is kept. */
export function resolveAnswerText(ask: AskEntry, text: string): string {
	const wanted = text.trim();
	const lower = wanted.toLowerCase();
	const option = ask.options?.find((candidate) => candidate.id === wanted)
		?? ask.options?.find((candidate) => candidate.label.toLowerCase() === lower);
	return option === undefined ? wanted : option.label;
}

export function newAskEntry(taskId: string, goal: string | undefined, ask: PreparedAsk, now: Date): AskEntry {
	return {
		schemaVersion: ASK_SCHEMA_VERSION,
		askId: `ask-${randomUUID()}`,
		taskId,
		...(goal === undefined ? {} : { goal }),
		question: ask.question,
		...(ask.options === undefined ? {} : { options: ask.options.map((option) => ({ id: option.id, label: option.label })) }),
		createdAt: now.toISOString(),
	};
}

/** Shorten text to a task note's limit, marking the cut. */
export function noteText(text: string, maxChars: number): string {
	const flat = oneLine(text);
	return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export function parseAskEntry(value: unknown): AskEntry | null {
	if (!isRecord(value) || value.schemaVersion !== ASK_SCHEMA_VERSION) return null;
	if (!boundedString(value.askId, MAX_ASK_ID_CHARS)) return null;
	if (typeof value.taskId !== "string" || !isValidTaskRef(value.taskId)) return null;
	if (value.goal !== undefined && (typeof value.goal !== "string" || !isValidTaskRef(value.goal))) return null;
	if (!boundedString(value.question, MAX_ASK_QUESTION_CHARS)) return null;
	if (!validTimestamp(value.createdAt)) return null;
	let options: AskOption[] | undefined;
	if (value.options !== undefined) {
		if (!Array.isArray(value.options) || value.options.length > MAX_ASK_OPTIONS) return null;
		options = [];
		for (const option of value.options as unknown[]) {
			if (!isRecord(option) || typeof option.id !== "string" || !isValidTaskRef(option.id)) return null;
			if (!boundedString(option.label, MAX_ASK_OPTION_LABEL_CHARS)) return null;
			options.push({ id: option.id, label: option.label });
		}
	}
	return {
		schemaVersion: ASK_SCHEMA_VERSION,
		askId: value.askId,
		taskId: value.taskId,
		...(value.goal === undefined ? {} : { goal: value.goal }),
		question: value.question,
		...(options === undefined || options.length === 0 ? {} : { options }),
		createdAt: value.createdAt,
	};
}

function parseRaisedEntry(value: unknown): AskRaisedEntry | null {
	if (!isRecord(value) || !boundedString(value.askId, MAX_ASK_ID_CHARS) || !boundedString(value.decisionId, MAX_DECISION_ID_CHARS)) return null;
	return { askId: value.askId, decisionId: value.decisionId };
}

function parseAnswerEntry(value: unknown): AnswerEntry | null {
	if (!isRecord(value) || !boundedString(value.askId, MAX_ASK_ID_CHARS)) return null;
	if (!boundedString(value.answer, MAX_ASK_ANSWER_CHARS)) return null;
	if (!ANSWER_ROUTES.includes(value.route as AnswerRoute)) return null;
	if (!validTimestamp(value.answeredAt)) return null;
	return { askId: value.askId, answer: value.answer, route: value.route as AnswerRoute, answeredAt: value.answeredAt };
}

function parseClosedEntry(value: unknown): AskClosedEntry | null {
	if (!isRecord(value) || !boundedString(value.askId, MAX_ASK_ID_CHARS)) return null;
	if (!ASK_CLOSE_REASONS.includes(value.reason as AskCloseReason)) return null;
	if (!validTimestamp(value.closedAt)) return null;
	return { askId: value.askId, reason: value.reason as AskCloseReason, closedAt: value.closedAt };
}

/**
 * Every ask on the branch, in order, with its raised decisions and how it
 * ended: the first answer or close entry wins, and the other is then ignored.
 */
export function replayAsks(entries: readonly unknown[]): AskState[] {
	const asks = new Map<string, { ask: AskEntry; decisionIds: string[]; answer?: AnswerEntry; closed?: AskClosedEntry }>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType === ASK_ENTRY_TYPE) {
			const ask = parseAskEntry(entry.data);
			if (ask !== null && !asks.has(ask.askId)) asks.set(ask.askId, { ask, decisionIds: [] });
		} else if (entry.customType === ASK_RAISED_ENTRY_TYPE) {
			const raised = parseRaisedEntry(entry.data);
			const state = raised === null ? undefined : asks.get(raised.askId);
			if (raised !== null && state !== undefined && state.decisionIds.length < 32) state.decisionIds.push(raised.decisionId);
		} else if (entry.customType === ANSWER_ENTRY_TYPE) {
			const answer = parseAnswerEntry(entry.data);
			const state = answer === null ? undefined : asks.get(answer.askId);
			// The first answer wins; a later one, or one after a close, is history, not a change.
			if (answer !== null && state !== undefined && state.answer === undefined && state.closed === undefined) state.answer = answer;
		} else if (entry.customType === ASK_CLOSED_ENTRY_TYPE) {
			const closed = parseClosedEntry(entry.data);
			const state = closed === null ? undefined : asks.get(closed.askId);
			if (closed !== null && state !== undefined && state.answer === undefined && state.closed === undefined) state.closed = closed;
		}
	}
	return [...asks.values()].map((state) => ({
		ask: state.ask,
		decisionIds: state.decisionIds,
		...(state.answer === undefined ? {} : { answer: state.answer }),
		...(state.closed === undefined ? {} : { closed: state.closed }),
	}));
}

/**
 * Asks still waiting for the user: unanswered, not closed, on a task that still
 * exists, and not replaced by a later ask on the same task.
 */
export function openAsks(entries: readonly unknown[], tasks: readonly Task[]): AskState[] {
	const latestByTask = new Map<string, AskState>();
	for (const state of replayAsks(entries)) latestByTask.set(state.ask.taskId, state);
	return [...latestByTask.values()].filter((state) => state.answer === undefined && state.closed === undefined && findTask(tasks, state.ask.taskId) !== null);
}

export function openAskForTask(entries: readonly unknown[], tasks: readonly Task[], taskId: string): AskState | undefined {
	return openAsks(entries, tasks).find((state) => state.ask.taskId === taskId);
}

/** Task id to question, for the per-turn envelope. */
export function openAskQuestions(open: readonly AskState[]): ReadonlyMap<string, string> {
	return new Map(open.map((state) => [state.ask.taskId, state.ask.question]));
}

// ---------------------------------------------------------------------------
// The relayed answer
// ---------------------------------------------------------------------------

const ROUTE_TEXT: Record<AnswerRoute, string> = {
	fabric: "in Fabric's decision list",
	command: "with /answer",
	agent: "in chat",
};

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * The user's answer as a labelled custom message. Pi hands a custom message to
 * the model as user-role text without its type, so the relay is stated in the
 * text, ahead of the escaped answer, which cannot close the wrapper.
 */
export function askAnswerMessage(ask: AskEntry, answer: string, route: AnswerRoute): {
	customType: typeof ASK_ANSWER_MESSAGE_TYPE;
	content: string;
	display: true;
	details: { version: 1; askId: string; taskId: string; route: AnswerRoute };
} {
	return {
		customType: ASK_ANSWER_MESSAGE_TYPE,
		content: [
			`The user answered the question on task ${ask.taskId} ${ROUTE_TEXT[route]}. The context-aware extension relays the answer; the task is pending again, so continue it.`,
			`<user-answer task-id="${escapeXml(ask.taskId)}" question="${escapeXml(ask.question)}">`,
			escapeXml(answer),
			"</user-answer>",
		].join("\n"),
		display: true,
		details: { version: 1, askId: ask.askId, taskId: ask.taskId, route },
	};
}

// ---------------------------------------------------------------------------
// Fabric transport
// ---------------------------------------------------------------------------

/** Mirrors `FabricDecisionsCapabilityResultV1`. */
export type DecisionsCapabilityResult =
	| { ok: true; available: true; inputs: string[]; maxOptions: number; maxTitleChars: number; maxBodyChars: number; maxTextChars: number; minTimeoutMs: number; maxTimeoutMs: number }
	| { ok: true; available: false; reason: string }
	| { ok: false; error: string };

/** Mirrors `FabricDecisionsCapabilityRequestV1`. */
export interface DecisionsCapabilityRequest {
	version: 1;
	context: ExtensionContext;
	claim: () => boolean;
	respond: (result: DecisionsCapabilityResult) => void;
}

/** Mirrors `FabricDecisionQuestionV1`. */
export interface DecisionQuestion {
	title: string;
	body?: string;
	options?: Array<{ id: string; label: string }>;
}

/** Mirrors `FabricDecisionResultV1`. */
export type DecisionResult =
	| { ok: true; id: string; status: "answered"; answer: { optionId?: string; text?: string; answeredBy: string; via: string; at: number } }
	| { ok: true; id: string; status: "cancelled" | "expired" }
	| { ok: false; error: string; id?: string };

/** Mirrors `FabricDecisionRequestV1`. */
export interface DecisionRequest {
	version: 1;
	context: ExtensionContext;
	question: DecisionQuestion;
	source: typeof ASK_SOURCE;
	signal: AbortSignal;
	onRaised: (id: string) => void;
	claim: () => boolean;
	respond: (result: DecisionResult) => void;
}

export type RaiseOutcome = "raised" | "no-fabric" | "unavailable" | "closed";

export interface RaiseHooks {
	/** Whether the ask is still open; checked after waiting on Fabric. */
	readonly stillOpen: () => boolean;
	readonly onRaised: (decisionId: string) => void;
	readonly onAnswer: (answer: string) => void;
}

export interface AskTransport {
	raise(ctx: ExtensionContext, ask: AskEntry, sessionName: string | undefined, hooks: RaiseHooks): Promise<RaiseOutcome>;
	/** Abort the in-flight Fabric request for this ask, if any; Fabric cancels the decision. */
	abort(askId: string): boolean;
	/** Abort every in-flight request, and ignore any response that arrives later. */
	abortAll(): void;
	readonly inFlight: () => readonly string[];
}

function bounded(text: string, max: number): string {
	if (max <= 0) return "";
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The decision title: the session name when set, the task id, then as much of the question as fits. */
export function decisionTitle(ask: AskEntry, sessionName: string | undefined, maxChars: number): string {
	const name = sessionName === undefined ? "" : oneLine(redactText(sessionName, { maxLength: 80 }));
	const prefix = `${name.length > 0 ? `${name} · ` : ""}task ${ask.taskId}: `;
	return bounded(`${prefix}${oneLine(ask.question)}`, maxChars);
}

function answerFromResult(ask: AskEntry, result: DecisionResult): string | undefined {
	if (!result.ok || result.status !== "answered") return undefined;
	const { optionId, text } = result.answer;
	if (typeof text === "string" && text.trim().length > 0) return text;
	if (typeof optionId === "string") return ask.options?.find((option) => option.id === optionId)?.label ?? optionId;
	return undefined;
}

export function createAskTransport(
	events: () => { emit?: (channel: string, data: unknown) => void } | undefined,
	debugLog: (message: string) => void,
): AskTransport {
	const controllers = new Map<string, AbortController>();
	let generation = 0;

	const emit = (channel: string, data: unknown): void => {
		try {
			events()?.emit?.(channel, data);
		} catch (err) {
			debugLog(`asks: ${channel} not delivered: ${String(err)}`);
		}
	};

	const capability = (ctx: ExtensionContext): Promise<DecisionsCapabilityResult | undefined> => new Promise((resolve) => {
		let claimed = false;
		let settled = false;
		const settle = (result: DecisionsCapabilityResult | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => settle({ ok: false, error: "Fabric did not answer the capability request in time" }), CAPABILITY_TIMEOUT_MS);
		(timer as { unref?: () => void }).unref?.();
		const request: DecisionsCapabilityRequest = {
			version: 1,
			context: ctx,
			claim: () => {
				if (claimed) return false;
				claimed = true;
				return true;
			},
			respond: (result) => settle(result),
		};
		emit(FABRIC_DECISIONS_CAPABILITY_EVENT, request);
		// Claiming is synchronous; nobody claiming means no Fabric.
		if (!claimed) settle(undefined);
	});

	return {
		async raise(ctx, ask, sessionName, hooks) {
			const started = generation;
			const offered = await capability(ctx);
			if (offered === undefined) return "no-fabric";
			if (!offered.ok || !offered.available) {
				debugLog(`asks: Fabric decisions unavailable: ${offered.ok ? offered.reason : offered.error}`);
				return "unavailable";
			}
			// An answer or a shutdown may have arrived while Fabric was asked.
			if (started !== generation || !hooks.stillOpen()) return "closed";
			controllers.get(ask.askId)?.abort();
			const controller = new AbortController();
			controllers.set(ask.askId, controller);
			const options = ask.options === undefined || !offered.inputs.includes("select")
				? undefined
				: ask.options.slice(0, Math.max(0, offered.maxOptions)).map((option) => ({ id: option.id, label: option.label }));
			const question: DecisionQuestion = {
				title: decisionTitle(ask, sessionName, offered.maxTitleChars),
				body: bounded(ask.question, offered.maxBodyChars),
				...(options === undefined || options.length === 0 ? {} : { options }),
			};
			if (question.body === "") delete question.body;
			let claimed = false;
			let responded = false;
			const request: DecisionRequest = {
				version: 1,
				context: ctx,
				question,
				source: ASK_SOURCE,
				signal: controller.signal,
				onRaised: (id) => {
					if (controller.signal.aborted || started !== generation) return;
					if (typeof id !== "string" || id.length === 0 || id.length > MAX_DECISION_ID_CHARS) return;
					hooks.onRaised(id);
				},
				claim: () => {
					if (claimed) return false;
					claimed = true;
					return true;
				},
				respond: (result) => {
					if (responded) return;
					responded = true;
					if (controllers.get(ask.askId) === controller) controllers.delete(ask.askId);
					// Cancelled, expired, failed, aborted or stale: none of these answers the ask.
					if (controller.signal.aborted || started !== generation) return;
					const answer = answerFromResult(ask, result);
					if (answer === undefined) {
						debugLog(`asks: decision for ${ask.askId} settled without an answer`);
						return;
					}
					hooks.onAnswer(answer);
				},
			};
			emit(FABRIC_DECISION_REQUEST_EVENT, request);
			if (!claimed) {
				if (controllers.get(ask.askId) === controller) controllers.delete(ask.askId);
				return "no-fabric";
			}
			return "raised";
		},
		abort(askId) {
			const controller = controllers.get(askId);
			if (controller === undefined) return false;
			controllers.delete(askId);
			controller.abort();
			return true;
		},
		abortAll() {
			generation += 1;
			const all = [...controllers.values()];
			controllers.clear();
			for (const controller of all) controller.abort();
		},
		inFlight: () => [...controllers.keys()],
	};
}
