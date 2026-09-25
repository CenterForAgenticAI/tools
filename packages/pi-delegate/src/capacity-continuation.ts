import { isDeepStrictEqual } from "node:util";

import {
	convertToLlm,
	type AgentSession,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { isCapacityFailureMessage } from "./refusal.js";

type CapacityMessage = AgentSession["messages"][number];
type CapacityThinkingLevel = AgentSession["thinkingLevel"];
type CapacityModel = Parameters<AgentSession["setModel"]>[0];
type CapacityAssistant = Extract<CapacityMessage, { role: "assistant" }>;

type CapacityContinuationRefusalReason =
	| "cancelled"
	| "session-busy"
	| "streaming-message"
	| "pending-tool-calls"
	| "missing-failed-assistant"
	| "failed-assistant-not-error"
	| "capacity-error-mismatch"
	| "failed-assistant-tool-call"
	| "invalid-continuation-boundary"
	| "malformed-tool-history"
	| "missing-persisted-failure"
	| "persisted-context-mismatch";

interface CapacityContinuationRefusal {
	readonly ok: false;
	readonly reason: CapacityContinuationRefusalReason;
	readonly detail: string;
}

interface CapacityContinuationSnapshot {
	readonly session: AgentSession;
	readonly expectedCapacityError: string;
	readonly prefix: readonly CapacityMessage[];
	readonly failedAssistant: CapacityAssistant;
	readonly auditFingerprint: string;
}

interface CapacityContinuationReady {
	readonly ok: true;
	readonly snapshot: CapacityContinuationSnapshot;
}

export type CapacityContinuationInspection = CapacityContinuationReady | CapacityContinuationRefusal;

export interface ContinueCapacityRequestOptions {
	readonly modelChoice?: CapacityModel;
	readonly thinkingLevel?: CapacityThinkingLevel;
	readonly signal: AbortSignal;
}

interface ToolCallRecord {
	readonly kind: "call";
	readonly id: string;
	readonly name: string;
	readonly content: unknown;
}

interface ToolResultRecord {
	readonly kind: "result";
	readonly id: string;
	readonly name: string;
	readonly content: unknown;
}

type ToolHistoryRecord = ToolCallRecord | ToolResultRecord;

type ToolHistoryValidation =
	| { readonly ok: true; readonly records: readonly ToolHistoryRecord[] }
	| { readonly ok: false; readonly detail: string };

function refuse(reason: CapacityContinuationRefusalReason, detail: string): CapacityContinuationRefusal {
	return Object.freeze({ ok: false, reason, detail });
}

function abortError(): DOMException {
	return new DOMException("capacity continuation was cancelled", "AbortError");
}

function auditFingerprint(entries: readonly SessionEntry[]): string {
	return JSON.stringify(entries);
}

function branchMessages(entries: readonly SessionEntry[]): CapacityMessage[] {
	return entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}

function validateToolHistory(messages: readonly Message[]): ToolHistoryValidation {
	const calls = new Map<string, { readonly name: string; resolved: boolean }>();
	const records: ToolHistoryRecord[] = [];

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const id = block.id;
				if (!id.trim()) return { ok: false, detail: "tool call id is empty" };
				if (calls.has(id)) return { ok: false, detail: `tool call id ${JSON.stringify(id)} is duplicated` };
				calls.set(id, { name: block.name, resolved: false });
				records.push({ kind: "call", id, name: block.name, content: block });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;

		const id = message.toolCallId;
		if (!id.trim()) return { ok: false, detail: "tool result id is empty" };
		const call = calls.get(id);
		if (!call) return { ok: false, detail: `tool result ${JSON.stringify(id)} has no preceding call` };
		if (call.resolved) return { ok: false, detail: `tool result ${JSON.stringify(id)} is duplicated` };
		if (call.name !== message.toolName) {
			return {
				ok: false,
				detail: `tool result ${JSON.stringify(id)} names ${JSON.stringify(message.toolName)} instead of ${JSON.stringify(call.name)}`,
			};
		}
		call.resolved = true;
		records.push({ kind: "result", id, name: message.toolName, content: message });
	}

	for (const [id, call] of calls) {
		if (!call.resolved) return { ok: false, detail: `tool call ${JSON.stringify(id)} has no result` };
	}
	return { ok: true, records: Object.freeze(records) };
}

function findLastUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function sessionBusyDetail(session: AgentSession): string | undefined {
	if (!session.isIdle) return "session is not idle";
	if (session.isStreaming || session.agent.state.isStreaming) return "session is streaming";
	if (session.isCompacting) return "session is compacting";
	if (session.isRetrying || session.retryAttempt !== 0) return "session is inside an SDK retry";
	if (session.pendingMessageCount !== 0 || session.agent.hasQueuedMessages()) {
		return "session has a queued continuation";
	}
	return undefined;
}

function sameRoute(left: AgentSession["model"], right: CapacityModel): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

function liveSnapshotMatches(snapshot: CapacityContinuationSnapshot): boolean {
	const messages = snapshot.session.agent.state.messages;
	if (messages.length !== snapshot.prefix.length + 1) return false;
	for (let index = 0; index < snapshot.prefix.length; index += 1) {
		if (messages[index] !== snapshot.prefix[index]) return false;
	}
	return messages.at(-1) === snapshot.failedAssistant;
}

/**
 * Validate that a terminal capacity failure can be resumed without replaying a
 * completed tool effect. This reads only the live AgentSession and its existing
 * SessionManager; it never opens or reconstructs a transcript.
 */
export function inspectCapacityContinuation(
	session: AgentSession,
	expectedCapacityError: string,
	signal?: AbortSignal,
): CapacityContinuationInspection {
	if (signal?.aborted) return refuse("cancelled", "capacity continuation was cancelled");

	const busy = sessionBusyDetail(session);
	if (busy) return refuse("session-busy", busy);
	if (session.agent.state.streamingMessage !== undefined) {
		return refuse("streaming-message", "agent still has a partial streaming message");
	}
	if (session.agent.state.pendingToolCalls.size !== 0) {
		return refuse("pending-tool-calls", "agent still has pending tool calls");
	}

	const liveMessages = session.agent.state.messages;
	const failedAssistant = liveMessages.at(-1);
	if (failedAssistant?.role !== "assistant") {
		return refuse("missing-failed-assistant", "live context does not end with an assistant failure");
	}
	if (failedAssistant.stopReason !== "error") {
		return refuse(
			"failed-assistant-not-error",
			`terminal assistant stop reason is ${JSON.stringify(failedAssistant.stopReason)}, not "error"`,
		);
	}
	const persistedError = failedAssistant.errorMessage;
	const observedError = expectedCapacityError;
	if (
		!persistedError?.trim() ||
		!observedError.trim() ||
		!isCapacityFailureMessage(persistedError) ||
		!isCapacityFailureMessage(observedError) ||
		persistedError !== observedError
	) {
		return refuse(
			"capacity-error-mismatch",
			"terminal assistant error does not exactly match the observed capacity failure",
		);
	}
	if (failedAssistant.content.some((block) => block.type === "toolCall")) {
		return refuse(
			"failed-assistant-tool-call",
			"terminal capacity failure contains a partial tool call whose execution cannot be excluded",
		);
	}

	const prefix = liveMessages.slice(0, -1);
	let providerPrefix: Message[];
	try {
		providerPrefix = convertToLlm(prefix);
	} catch (error) {
		return refuse(
			"invalid-continuation-boundary",
			`live context could not be converted for continuation: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const boundary = providerPrefix.at(-1);
	if (boundary?.role !== "user" && boundary?.role !== "toolResult") {
		return refuse(
			"invalid-continuation-boundary",
			`provider context ends with ${boundary?.role ?? "no message"}, not user or toolResult`,
		);
	}
	const liveToolHistory = validateToolHistory(providerPrefix);
	if (liveToolHistory.ok === false) return refuse("malformed-tool-history", liveToolHistory.detail);
	const liveCurrentTurnStart = findLastUserIndex(providerPrefix);
	if (liveCurrentTurnStart < 0) {
		return refuse("invalid-continuation-boundary", "provider context has no current-turn user message");
	}
	const liveCurrentTurnToolHistory = validateToolHistory(providerPrefix.slice(liveCurrentTurnStart));
	if (liveCurrentTurnToolHistory.ok === false) {
		return refuse("malformed-tool-history", liveCurrentTurnToolHistory.detail);
	}

	const branch = session.sessionManager.getBranch();
	const persistedMessages = branchMessages(branch);
	let persistedFailureIndex = -1;
	for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
		if (!isDeepStrictEqual(persistedMessages[index], failedAssistant)) continue;
		persistedFailureIndex = index;
		break;
	}
	if (persistedFailureIndex < 0 || persistedFailureIndex !== persistedMessages.length - 1) {
		return refuse(
			"missing-persisted-failure",
			"the existing session branch does not end with the exact failed assistant",
		);
	}
	let currentTurnStart = -1;
	for (let index = persistedFailureIndex - 1; index >= 0; index -= 1) {
		if (persistedMessages[index]?.role === "user") {
			currentTurnStart = index;
			break;
		}
	}
	if (currentTurnStart < 0) {
		return refuse("persisted-context-mismatch", "persisted capacity failure has no current-turn user message");
	}

	let persistedCurrentTurn: Message[];
	try {
		persistedCurrentTurn = convertToLlm(persistedMessages.slice(currentTurnStart, persistedFailureIndex));
	} catch (error) {
		return refuse(
			"persisted-context-mismatch",
			`persisted current turn could not be converted: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const persistedToolHistory = validateToolHistory(persistedCurrentTurn);
	if (persistedToolHistory.ok === false) {
		return refuse("persisted-context-mismatch", `persisted ${persistedToolHistory.detail}`);
	}
	if (!isDeepStrictEqual(liveCurrentTurnToolHistory.records, persistedToolHistory.records)) {
		return refuse(
			"persisted-context-mismatch",
			"live context does not retain the exact persisted current-turn tool calls and results",
		);
	}

	const snapshot: CapacityContinuationSnapshot = Object.freeze({
		session,
		expectedCapacityError: observedError,
		prefix: Object.freeze(prefix),
		failedAssistant,
		auditFingerprint: auditFingerprint(branch),
	});
	return Object.freeze({ ok: true, snapshot });
}

/**
 * Resume one already-validated request from its user/toolResult boundary.
 * Persisted entries are append-only: only Agent.state.messages is pruned.
 */
export async function continueCapacityRequest(
	snapshot: CapacityContinuationSnapshot,
	options: ContinueCapacityRequestOptions,
): Promise<readonly CapacityMessage[]> {
	if (options.signal.aborted) throw abortError();
	const current = inspectCapacityContinuation(
		snapshot.session,
		snapshot.expectedCapacityError,
		options.signal,
	);
	if (current.ok === false) {
		throw new Error(`capacity fallback could not continue safely: stale snapshot (${current.detail})`);
	}
	if (!liveSnapshotMatches(snapshot) || current.snapshot.failedAssistant !== snapshot.failedAssistant) {
		throw new Error("capacity fallback could not continue safely: stale snapshot (live continuation identity changed)");
	}
	if (auditFingerprint(snapshot.session.sessionManager.getBranch()) !== snapshot.auditFingerprint) {
		throw new Error("capacity fallback could not continue safely: stale snapshot (session audit changed)");
	}

	const abortAgent = () => snapshot.session.agent.abort();
	options.signal.addEventListener("abort", abortAgent, { once: true });
	try {
		if (options.modelChoice && !sameRoute(snapshot.session.model, options.modelChoice)) {
			await snapshot.session.setModel(options.modelChoice);
			if (options.thinkingLevel !== undefined) snapshot.session.setThinkingLevel(options.thinkingLevel);
		}
		if (options.signal.aborted) throw abortError();
		if (sessionBusyDetail(snapshot.session) || !liveSnapshotMatches(snapshot)) {
			throw new Error("capacity fallback could not continue safely: stale snapshot after model switch");
		}

		snapshot.session.agent.state.messages = [...snapshot.prefix];
		await snapshot.session.agent.continue();
		if (options.signal.aborted) throw abortError();
		return Object.freeze(snapshot.session.agent.state.messages.slice(snapshot.prefix.length));
	} finally {
		options.signal.removeEventListener("abort", abortAgent);
	}
}
