import { isRefusalErrorMessage, type WorkerErrorKind } from "./refusal.js";

/** Minimal message surface needed to classify a worker transcript. */
export interface HarvestMessage {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly customType?: unknown;
	readonly stopReason?: unknown;
	readonly errorMessage?: unknown;
	readonly usage?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly cost?: { readonly total?: number };
	};
}

export type HarvestMethod = "terminal" | "salvage";

export type HarvestOutcome =
	| {
			kind: "substantive";
			method: HarvestMethod;
			text: string;
	  }
	| {
			kind: "failure";
			error: string;
			errorKind?: WorkerErrorKind;
			stopReason?: string;
	  }
	| {
			kind: "missing";
			reason: "no-assistant" | "empty";
			text: "";
	  }
	| {
			kind: "missing";
			reason: "cancellation-only";
			text: "";
	  };

export interface HarvestAssistantError {
	message: string;
	kind?: WorkerErrorKind;
	stopReason?: string;
}

export const NO_SUBSTANTIVE_WORKER_OUTPUT = "(no substantive worker output recovered)";

/** A run-ending tool gets one final chance to produce the requested deliverable. */
export const RUN_ENDING_CONTINUATION_LIMIT = 1;

/** Identifiable internal prompt used only after a run-ending tool yielded no deliverable. */
export const RUN_ENDING_CONTINUATION_PROMPT =
	"<machine-origin continuation>\n" +
	"The previous tool ended the worker turn before a final answer. " +
	"Continue the original task and provide only the substantive deliverable.";

export function formatRunEndingBoundaryFailure(workerSessionFile?: string): string {
	const session = workerSessionFile ?? "unavailable";
	return `No substantive assistant output recovered after run-ending tool boundary (worker session: ${session})`;
}

export function formatRunEndingContinuationFailure(workerSessionFile?: string): string {
	const session = workerSessionFile ?? "unavailable";
	return `No substantive assistant output recovered after run-ending tool continuation (worker session: ${session})`;
}

export interface PromptLifecycleHarvest {
	/** Arm one prompt attempt. Omit the cursor when a history fallback would cross a busy run. */
	begin(fallbackCursor?: number): void;
	/** Bind this attempt to the exact SDK user-message object created for the request. */
	expectUserMessage(message: HarvestMessage): void;
	/** Observe one SDK session event while the prompt is in flight. */
	observe(event: unknown): void;
	/** Finish collection, using history only when its exact request boundary is known. */
	finish(allMessages: readonly HarvestMessage[]): PromptLifecycleHarvestResult;
}

export interface PromptLifecycleHarvestResult {
	messages: HarvestMessage[];
	lifecycleObserved: boolean;
	anchorFound: boolean;
	runEndingToolObserved: boolean;
	/** Whether the observed tool explicitly declared termination. */
	runEndingToolDeclared?: boolean;
	settled: boolean;
	/** Stop reason on the newest assistant message in this exact prompt lifecycle. */
	lastAssistantStopReason?: string;
}

/** Stop reasons that mean the model's work, rather than its answer, ended. */
const INCOMPLETE_WORK_STOP_REASONS = new Set([
	"toolUse",
	"toolCall",
	"tool_use",
	"tool_call",
	"length",
	"maxToken",
	"maxTokens",
	"max_tokens",
	"maxTurn",
	"maxTurns",
	"max_turn",
	"max_turns",
	"turnLimit",
	"turn_limit",
	"contextLength",
	"context_length",
]);

function isIncompleteWorkStopReason(stopReason: string | undefined): boolean {
	return stopReason !== undefined && INCOMPLETE_WORK_STOP_REASONS.has(stopReason);
}

/**
 * Decide whether one bounded machine continuation is needed at a settled
 * harvest boundary. The boundary belongs to the worker's work: a tool signal
 * is useful evidence, but it is not required. Any settled incomplete work
 * boundary (including an empty max-turn result) gets the same one retry.
 */
export function shouldAttemptHarvestContinuation(
	harvest: HarvestOutcome,
	boundary: Pick<
		PromptLifecycleHarvestResult,
		"runEndingToolObserved" | "runEndingToolDeclared" | "settled" | "lastAssistantStopReason"
	> & {
		/** RPC streams may omit the first user carrier; preserve the window guard when present. */
		hasUserMessage?: boolean;
	},
	continuationAttempts: number,
): boolean {
	if (
		continuationAttempts >= RUN_ENDING_CONTINUATION_LIMIT ||
		harvest.kind === "failure"
	) return false;

	// A finalized run-ending tool remains a strong incomplete-work signal, but
	// an assistant that actually stopped cleanly is still complete. Tool
	// boundaries are allowed to continue before a separate settled event; some
	// SDK versions close the prompt as part of that tool event.
	if (boundary.runEndingToolObserved) {
		return boundary.runEndingToolDeclared === true
			? harvest.kind === "missing"
			: harvest.kind === "missing" || isIncompleteWorkStopReason(boundary.lastAssistantStopReason);
	}
	if (!boundary.settled) return false;
	if (isIncompleteWorkStopReason(boundary.lastAssistantStopReason)) return true;

	// A missing carrier without either a tool boundary or an explicit incomplete
	// stop reason is ambiguous when a user carrier is present: it may be an
	// unanswered newer user prompt. RPC streams can omit that carrier on a
	// first turn, so only their no-user case gets the bounded retry.
	return harvest.kind === "missing" &&
		harvest.reason === "no-assistant" &&
		boundary.hasUserMessage !== true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Detect the SDK's finalized run-ending signal without inspecting tool text. */
export function isRunEndingToolExecutionEnd(event: unknown): boolean {
	return isRecord(event) &&
		event.type === "tool_execution_end" &&
		isRecord(event.result) &&
		event.result.terminate === true;
}

/**
 * Collect finalized messages from exactly one SDK prompt lifecycle. The event
 * stream remains authoritative when the SDK replaces its active message array
 * during compaction; older session doubles without lifecycle events retain the
 * message-slice fallback.
 */
export function createPromptLifecycleHarvest(): PromptLifecycleHarvest {
	let active = false;
	let lifecycleObserved = false;
	let anchorFound = false;
	let expectedUserMessage: HarvestMessage | undefined;
	let fallbackCursor: number | undefined;
	let runEndingToolObserved = false;
	let runEndingToolDeclared = false;
	let settled = false;
	let messages: HarvestMessage[] = [];

	return {
		begin(cursor?: number) {
			active = true;
			lifecycleObserved = false;
			anchorFound = false;
			expectedUserMessage = undefined;
			fallbackCursor = cursor;
			runEndingToolObserved = false;
			runEndingToolDeclared = false;
			settled = false;
			messages = [];
		},
		expectUserMessage(message: HarvestMessage) {
			if (
				!active ||
				expectedUserMessage !== undefined ||
				!isRecord(message) ||
				message.role !== "user"
			) return;
			expectedUserMessage = message;
		},
		observe(event: unknown) {
			if (!active || !isRecord(event) || typeof event.type !== "string") return;
			switch (event.type) {
				case "agent_start":
				case "agent_end":
				case "agent_settled":
				case "message_end":
				case "tool_execution_end":
					lifecycleObserved = true;
					break;
				default:
					return;
			}

			if (!anchorFound) {
				if (
					event.type === "message_end" &&
					event.message === expectedUserMessage &&
					isRecord(event.message) &&
					event.message.role === "user"
				) {
					anchorFound = true;
					messages.push(event.message as HarvestMessage);
				}
				return;
			}

			if (event.type === "message_end" && isRecord(event.message)) {
				if (event.message.role === "user") {
					// A later genuine request supersedes any prior tool boundary in
					// this lifecycle. Keep the selection window authoritative.
					runEndingToolObserved = false;
					runEndingToolDeclared = false;
				}
				messages.push(event.message as HarvestMessage);
			}
			// Any finalized tool execution can be the boundary that ended the
			// worker's work. `terminate:true` remains exposed by
			// isRunEndingToolExecutionEnd for callers that need the narrower SDK
			// signal, but harvesting must not depend on that declaration.
			if (event.type === "tool_execution_end") {
				runEndingToolObserved = true;
				if (isRunEndingToolExecutionEnd(event)) runEndingToolDeclared = true;
			}
			if (event.type === "agent_settled") settled = true;
		},
		finish(allMessages: readonly HarvestMessage[]): PromptLifecycleHarvestResult {
			active = false;
			let harvestedMessages: HarvestMessage[];
			if (lifecycleObserved) {
				// Lifecycle events are authoritative. If the exact current user event
				// never finalized, fail closed instead of admitting an older run.
				harvestedMessages = anchorFound ? messages : [];
			} else if (expectedUserMessage) {
				const anchorIndex = allMessages.indexOf(expectedUserMessage);
				harvestedMessages = anchorIndex >= 0 ? allMessages.slice(anchorIndex) : [];
			} else {
				harvestedMessages = fallbackCursor === undefined ? [] : allMessages.slice(fallbackCursor);
			}
			let lastAssistantStopReason: string | undefined;
			for (let i = harvestedMessages.length - 1; i >= 0; i -= 1) {
				const message = harvestedMessages[i]!;
				if (message.role !== "assistant") continue;
				lastAssistantStopReason = typeof message.stopReason === "string"
					? message.stopReason
					: undefined;
				break;
			}
			return {
				messages: harvestedMessages,
				lifecycleObserved,
				anchorFound,
				runEndingToolObserved,
				...(runEndingToolDeclared ? { runEndingToolDeclared: true } : {}),
				settled,
				...(lastAssistantStopReason ? { lastAssistantStopReason } : {}),
			};
		},
	};
}

const CHATTER_MAX_LENGTH = 240;

/**
 * Decide whether assistant text can be harvested as a worker deliverable.
 * Short lifecycle notices are chatter; long-form text remains a deliverable
 * because losing a real answer is worse than showing an old lifecycle banner.
 */
export function isSubstantiveAssistantText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const startsWithLifecycleMarker = /^\s*\[[^\]\r\n]*(?:recovery|retry|compaction|cancellation)[^\]\r\n]*\]/i.test(trimmed);
	const isShortSingleBlock = trimmed.length <= CHATTER_MAX_LENGTH && !/\r?\n\s*\r?\n/.test(trimmed);
	return !(startsWithLifecycleMarker && isShortSingleBlock);
}

function messageRole(message: HarvestMessage): string | undefined {
	return typeof message.role === "string" ? message.role : undefined;
}

function authoritativeSelectionWindow(
	messages: readonly HarvestMessage[],
): readonly HarvestMessage[] {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (
			messageRole(message) === "user" ||
			(messageRole(message) === "custom" && message.customType === "delegate:complete")
		) return messages.slice(i);
	}
	return messages;
}

function assistantText(message: HarvestMessage): string {
	if (messageRole(message) !== "assistant") return "";
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => typeof part.text === "string" ? part.text : "")
		.join("\n");
}

/** Extract the newest assistant text without applying the deliverable filter. */
export function getLastAssistantMessageText(messages: readonly HarvestMessage[]): string {
	const window = authoritativeSelectionWindow(messages);
	for (let i = window.length - 1; i >= 0; i -= 1) {
		const text = assistantText(window[i]!);
		if (text) return text;
	}
	return "";
}

interface HarvestedText {
	text: string;
	assistantIndex: number;
	lastAssistantIndex: number;
}

function substantiveAssistantBefore(
	messages: readonly HarvestMessage[],
	startIndex: number,
): { index: number; text: string } | undefined {
	for (let i = startIndex; i >= 0; i -= 1) {
		const text = assistantText(messages[i]!);
		if (text && isSubstantiveAssistantText(text)) return { index: i, text };
	}
	return undefined;
}

function substantiveTextFromMessages(
	messages: readonly HarvestMessage[],
): HarvestedText | undefined {
	const window = authoritativeSelectionWindow(messages);
	let lastAssistantIndex = -1;
	for (let i = 0; i < window.length; i += 1) {
		if (messageRole(window[i]!) === "assistant") lastAssistantIndex = i;
	}
	const substantive = substantiveAssistantBefore(window, window.length - 1);
	return substantive
		? { text: substantive.text, assistantIndex: substantive.index, lastAssistantIndex }
		: undefined;
}

/** Extract a terminal assistant/provider error from the transcript. */
export function getLastAssistantError(
	messages: readonly HarvestMessage[],
): HarvestAssistantError | undefined {
	const window = authoritativeSelectionWindow(messages);
	for (let i = window.length - 1; i >= 0; i -= 1) {
		const message = window[i]!;
		if (messageRole(message) !== "assistant") continue;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
		if (errorMessage) {
			return {
				message: errorMessage,
				...(isRefusalErrorMessage(stopReason, errorMessage) ? { kind: "refusal" as const } : {}),
				stopReason,
			};
		}
		if (stopReason === "error" || stopReason === "aborted") {
			const error = `Assistant failed with stopReason=${stopReason}`;
			return {
				message: error,
				...(isRefusalErrorMessage(stopReason, error) ? { kind: "refusal" as const } : {}),
				stopReason,
			};
		}
		return undefined;
	}
	return undefined;
}

/**
 * Classify one worker transcript at the terminal harvest boundary. This is
 * shared by direct workers and supervised WorkerChannel turns so neither path
 * can mistake lifecycle chatter or absent output for a successful reply.
 */
export function classifyHarvestOutcome(messages: readonly HarvestMessage[]): HarvestOutcome {
	const assistantError = getLastAssistantError(messages);
	if (assistantError) {
		return {
			kind: "failure",
			error: assistantError.message,
			...(assistantError.kind ? { errorKind: assistantError.kind } : {}),
			...(assistantError.stopReason ? { stopReason: assistantError.stopReason } : {}),
		};
	}

	const harvested = substantiveTextFromMessages(messages);
	if (harvested) {
		return {
			kind: "substantive",
			method: harvested.assistantIndex !== harvested.lastAssistantIndex
				? "salvage"
				: "terminal",
			text: harvested.text,
		};
	}

	const window = authoritativeSelectionWindow(messages);
	const hasAssistant = window.some((message) => messageRole(message) === "assistant");
	const hasAssistantText = window.some((message) => assistantText(message).length > 0);
	return {
		kind: "missing",
		reason: !hasAssistant ? "no-assistant" : !hasAssistantText ? "empty" : "cancellation-only",
		text: "",
	};
}

/** Extract the newest substantive assistant text, or the honest chatter marker. */
export function getLastAssistantText(messages: readonly HarvestMessage[]): string {
	const harvested = substantiveTextFromMessages(messages);
	if (harvested) return harvested.text;
	const hasAssistantText = authoritativeSelectionWindow(messages)
		.some((message) => assistantText(message).length > 0);
	return hasAssistantText ? NO_SUBSTANTIVE_WORKER_OUTPUT : "";
}
