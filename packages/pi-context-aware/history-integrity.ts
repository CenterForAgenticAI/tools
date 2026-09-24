/**
 * Keeping every tool result attached to the tool call that produced it.
 *
 * A provider rejects a whole conversation when a `tool_result` block has no
 * matching `tool_use` block in the message right before it. One such orphan kills
 * a session: the request fails, and every later turn rebuilds the same rejection.
 * A session died this way on 2026-08-17, and a census of 3,254 transcripts on one
 * machine found five whose persisted history can never be resumed.
 *
 * This module holds the two guards that keep that from happening:
 *
 *  1. `buildRecoveryReplacement` (issue #10, the cause). Pi applies a `message_end`
 *     replacement with `_replaceMessageInPlace`, which deletes every key of the
 *     original object — an object that is in both `agent.state.messages` and the
 *     running loop's `context.messages`. Replacing the content of a message that
 *     carries tool calls therefore destroys their `tool_use` blocks everywhere at
 *     once, while a tool that is already executing still delivers its result. The
 *     guard keeps the tool-call blocks and replaces only the prose.
 *
 *  2. `findOrphanedToolResults` / `repairOrphanedToolResults` (issue #56, the net).
 *     The cause above is not the only route: pi core's `transformMessages` drops any
 *     assistant message whose `stopReason` is `error` or `aborted` while pushing
 *     every tool result through unconditionally, which produces the identical orphan
 *     with no extension involved. Detection runs on the shape the provider actually
 *     sees, because consecutive tool-result messages are merged into one message —
 *     an orphan can hide at `content.2` of a batch whose first two blocks are fine.
 *
 * The detection mirrors three pi stages, in order, so the reported coordinates are
 * the provider's own `messages.<i>.content.<b>`:
 *   `convertToLlm`      — custom, bash-execution and summary messages become user
 *                         messages, and anything excluded from context disappears;
 *   `transformMessages` — errored and aborted assistant messages are dropped, and a
 *                         synthetic result is inserted for any unanswered tool call;
 *   the provider converter — consecutive tool results merge into one message, and a
 *                         message whose blocks all vanish is skipped entirely.
 *
 * Nothing here throws on odd input: a guard that dies on a strange history is worse
 * than the defect it guards against.
 */

/** A tool call as it appears in assistant content. */
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	[key: string]: unknown;
}

/** One tool result the provider will reject, with the coordinates it will report. */
export interface OrphanedToolResult {
	/** The `i` in `messages.<i>`: index in the payload the provider receives. */
	payloadIndex: number;
	/** The `b` in `content.<b>`: block index inside that payload message. */
	blockIndex: number;
	/** Index of the offending tool-result message in the list handed in. */
	messageIndex: number;
	toolCallId: string;
	toolName: string;
	/** Index of a message that still carries the parent tool call, if any. */
	parentMessageIndex: number | null;
	/** True when the parent can be restored without duplicating a live `tool_use`. */
	reattachable: boolean;
}

/**
 * `reattach` restores the parent tool call, keeping tool output that may have cost
 * minutes of work. `drop` removes the result, which costs one retry.
 */
export type HistoryRepairKind = "reattach" | "drop";

export interface HistoryRepair {
	kind: HistoryRepairKind;
	toolCallId: string;
	toolName: string;
	payloadIndex: number;
	blockIndex: number;
}

export interface HistoryRepairResult<T> {
	messages: T[];
	repairs: HistoryRepair[];
}

/**
 * Anthropic and OpenAI report the same defect in two unrelated-looking ways.
 * Anything grepping for only one wording undercounts it.
 */
const ANTHROPIC_ORPHAN_PATTERN = /unexpected\s+`?tool_use_id`?\s+found\s+in\s+`?tool_result`?\s+blocks/i;
const OPENAI_ORPHAN_PATTERN = /No tool call found for function call output/i;
const ANTHROPIC_ORPHAN_ID_PATTERN = /blocks:\s*([^\s.,]+)/i;
const OPENAI_ORPHAN_ID_PATTERN = /call_id\s+([^\s.,]+)/i;

/** True when a provider error is this defect rather than a genuinely bad request. */
export function isOrphanedToolResultRejection(errorMessage: unknown): boolean {
	if (typeof errorMessage !== "string" || errorMessage.length === 0) return false;
	return ANTHROPIC_ORPHAN_PATTERN.test(errorMessage) || OPENAI_ORPHAN_PATTERN.test(errorMessage);
}

/** The tool-call ids a provider named in an orphan rejection, for the warning text. */
export function orphanedToolCallIdsFromError(errorMessage: unknown): string[] {
	if (typeof errorMessage !== "string") return [];
	const ids: string[] = [];
	for (const pattern of [ANTHROPIC_ORPHAN_ID_PATTERN, OPENAI_ORPHAN_ID_PATTERN]) {
		const match = pattern.exec(errorMessage);
		if (match?.[1] && !ids.includes(match[1])) ids.push(match[1]);
	}
	return ids;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const blocks: Record<string, unknown>[] = [];
	for (const entry of content) {
		const block = asRecord(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

function isToolCallBlock(block: Record<string, unknown>): boolean {
	return block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0;
}

function toolCallsOf(message: Record<string, unknown>): ToolCallBlock[] {
	return contentBlocks(message)
		.filter(isToolCallBlock)
		.map((block) => block as unknown as ToolCallBlock);
}

/** Text a provider keeps: an empty or whitespace-only block is dropped. */
function hasText(block: Record<string, unknown>): boolean {
	return typeof block.text === "string" && block.text.trim().length > 0;
}

/**
 * Whether an assistant message survives conversion. Biased towards "visible":
 * treating a skipped message as visible can only hide an orphan, while treating a
 * surviving message as invisible would invent one and repair a healthy history.
 */
function assistantIsVisible(message: Record<string, unknown>): boolean {
	return contentBlocks(message).some((block) => {
		if (isToolCallBlock(block)) return true;
		if (block.type === "text") return hasText(block);
		if (block.type === "thinking") {
			const signature = block.thinkingSignature;
			return hasThinking(block) || (typeof signature === "string" && signature.trim().length > 0);
		}
		return true;
	});
}

function hasThinking(block: Record<string, unknown>): boolean {
	return typeof block.thinking === "string" && block.thinking.trim().length > 0;
}

function userIsVisible(message: Record<string, unknown>): boolean {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return contentBlocks(message).some((block) => (block.type === "text" ? hasText(block) : true));
}

type ProjectedMessage =
	| { kind: "assistant"; dropped: boolean; visible: boolean; toolCalls: ToolCallBlock[] }
	| { kind: "toolResult"; toolCallId: string; toolName: string }
	| { kind: "user"; visible: boolean }
	| null;

/** One message as `convertToLlm` and `transformMessages` will see it. */
function projectMessage(value: unknown): ProjectedMessage {
	const message = asRecord(value);
	if (!message) return null;
	switch (message.role) {
		case "assistant":
			return {
				kind: "assistant",
				// transformMessages skips these entirely: partial turns are not replayed.
				dropped: message.stopReason === "error" || message.stopReason === "aborted",
				visible: assistantIsVisible(message),
				toolCalls: toolCallsOf(message),
			};
		case "toolResult": {
			if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) return null;
			return {
				kind: "toolResult",
				toolCallId: message.toolCallId,
				toolName: typeof message.toolName === "string" ? message.toolName : "tool",
			};
		}
		case "user":
			return { kind: "user", visible: userIsVisible(message) };
		case "bashExecution":
			// The `!!` prefix keeps a bash execution out of context entirely.
			return message.excludeFromContext === true ? null : { kind: "user", visible: true };
		case "custom":
			return { kind: "user", visible: userIsVisible(message) };
		case "branchSummary":
		case "compactionSummary":
			// Both convert to a user message wrapped in a non-empty summary envelope.
			return { kind: "user", visible: true };
		default:
			return null;
	}
}

interface PayloadResultBlock {
	toolCallId: string;
	toolName: string;
	/** Null for a result pi core synthesizes, which has no message of its own. */
	messageIndex: number | null;
}

type PayloadMessage =
	| { role: "assistant"; toolUseIds: string[] }
	| { role: "user"; results: PayloadResultBlock[]; startMessageIndex: number | null };

interface HistoryAnalysis {
	payload: PayloadMessage[];
	orphans: OrphanedToolResult[];
	/** Source index of the assistant message before each payload message, if any. */
	assistantSourceIndex: Map<number, number>;
}

/**
 * Rebuild the payload the provider will receive, message by message and block by
 * block, then apply the provider's pairing rule to it.
 */
function analyzeHistory(messages: readonly unknown[]): HistoryAnalysis {
	const payload: PayloadMessage[] = [];
	const assistantSourceIndex = new Map<number, number>();
	const visibleToolUseIds = new Set<string>();
	let pending: ToolCallBlock[] = [];
	let answered = new Set<string>();
	let openResults: PayloadResultBlock[] | null = null;
	let openResultsStart: number | null = null;

	const closeResults = (): void => {
		if (openResults === null) return;
		payload.push({ role: "user", results: openResults, startMessageIndex: openResultsStart });
		openResults = null;
		openResultsStart = null;
	};
	const pushResult = (block: PayloadResultBlock): void => {
		if (openResults === null) openResults = [];
		openResults.push(block);
		if (openResultsStart === null && block.messageIndex !== null) openResultsStart = block.messageIndex;
	};
	// pi core's synthetic-result pass: the mirror case, a tool call with no result.
	const insertSyntheticResults = (): void => {
		if (pending.length === 0) return;
		for (const call of pending) {
			if (!answered.has(call.id)) pushResult({ toolCallId: call.id, toolName: call.name, messageIndex: null });
		}
		pending = [];
		answered = new Set();
	};

	for (let index = 0; index < messages.length; index++) {
		const projected = projectMessage(messages[index]);
		if (projected === null) continue;
		if (projected.kind === "toolResult") {
			answered.add(projected.toolCallId);
			pushResult({ toolCallId: projected.toolCallId, toolName: projected.toolName, messageIndex: index });
			continue;
		}
		insertSyntheticResults();
		if (projected.kind === "assistant") {
			// A dropped message never reaches the converter, so it does not break the
			// run of tool results around it: they merge into one payload message.
			if (projected.dropped) continue;
			if (projected.toolCalls.length > 0) {
				pending = projected.toolCalls;
				answered = new Set();
			}
			closeResults();
			if (!projected.visible) continue;
			const toolUseIds = projected.toolCalls.map((call) => call.id);
			for (const id of toolUseIds) visibleToolUseIds.add(id);
			assistantSourceIndex.set(payload.length, index);
			payload.push({ role: "assistant", toolUseIds });
			continue;
		}
		closeResults();
		if (!projected.visible) continue;
		payload.push({ role: "user", results: [], startMessageIndex: null });
	}
	insertSyntheticResults();
	closeResults();

	const orphans: OrphanedToolResult[] = [];
	for (let payloadIndex = 0; payloadIndex < payload.length; payloadIndex++) {
		const message = payload[payloadIndex];
		if (message === undefined || message.role !== "user" || message.results.length === 0) continue;
		const previous = payload[payloadIndex - 1];
		const parentIds = previous !== undefined && previous.role === "assistant"
			? new Set(previous.toolUseIds)
			: new Set<string>();
		for (let blockIndex = 0; blockIndex < message.results.length; blockIndex++) {
			const result = message.results[blockIndex];
			if (result === undefined || parentIds.has(result.toolCallId)) continue;
			// A synthetic result always follows the message that owns it, and pi core
			// owns it in any case: there is nothing here to repair.
			if (result.messageIndex === null) continue;
			const parentMessageIndex = findParentMessageIndex(messages, result.messageIndex, result.toolCallId);
			orphans.push({
				payloadIndex,
				blockIndex,
				messageIndex: result.messageIndex,
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				parentMessageIndex,
				// Reattaching a call the provider can still see would duplicate a live
				// `tool_use` id, a shape this guard cannot prove valid offline.
				reattachable: parentMessageIndex !== null && !visibleToolUseIds.has(result.toolCallId),
			});
		}
	}
	return { payload, orphans, assistantSourceIndex };
}

function findParentMessageIndex(
	messages: readonly unknown[],
	before: number,
	toolCallId: string,
): number | null {
	for (let index = Math.min(before, messages.length) - 1; index >= 0; index--) {
		const message = asRecord(messages[index]);
		if (!message || message.role !== "assistant") continue;
		if (toolCallsOf(message).some((call) => call.id === toolCallId)) return index;
	}
	return null;
}

/**
 * Every tool result the provider will reject, in payload order.
 * An empty array means the history is safe to send as it stands.
 */
export function findOrphanedToolResults(messages: readonly unknown[]): OrphanedToolResult[] {
	try {
		return analyzeHistory(messages).orphans;
	} catch {
		// A validator must never be the reason a turn fails.
		return [];
	}
}

/** Two reattach passes, then drop, so repair always terminates. */
const MAX_REPAIR_PASSES = 4;
const MAX_REATTACH_PASSES = 2;

function syntheticParentMessage(
	template: Record<string, unknown> | null,
	toolCalls: ToolCallBlock[],
): Record<string, unknown> {
	return {
		role: "assistant",
		content: toolCalls,
		api: typeof template?.api === "string" ? template.api : "context-aware-history-repair",
		provider: typeof template?.provider === "string" ? template.provider : "context-aware",
		model: typeof template?.model === "string" ? template.model : "history-repair",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// Never `error` or `aborted`: pi core would drop this message and orphan the
		// very result it exists to keep.
		stopReason: "stop",
		timestamp: typeof template?.timestamp === "number" ? template.timestamp : Date.now(),
	};
}

/**
 * Return a history the provider will accept, plus what had to be done to it.
 *
 * Repairs are preferred in this order, following the shape of pi core's existing
 * synthetic-result pass rather than inventing a parallel mechanism:
 *   reattach — restore the missing `tool_use`, keeping the tool output;
 *   drop     — remove the result when its call cannot be recovered.
 * The caller's list is never modified.
 */
export function repairOrphanedToolResults<T>(messages: readonly T[]): HistoryRepairResult<T> {
	const repairs: HistoryRepair[] = [];
	let current: unknown[] = [...messages];
	for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
		let analysis: HistoryAnalysis;
		try {
			analysis = analyzeHistory(current);
		} catch {
			return { messages: current as T[], repairs };
		}
		if (analysis.orphans.length === 0) break;

		// Reattached calls join the assistant message that already precedes the merged
		// batch, so the healthy results in that batch keep their own parent. Where no
		// assistant precedes it, a minimal one is inserted before the batch instead.
		const appendTo = new Map<number, ToolCallBlock[]>();
		const insertBefore = new Map<number, ToolCallBlock[]>();
		const drops = new Set<number>();
		const allowReattach = pass < MAX_REATTACH_PASSES;

		for (const orphan of analysis.orphans) {
			const parentCall = orphan.parentMessageIndex === null
				? null
				: toolCallsOf(asRecord(current[orphan.parentMessageIndex]) ?? {})
					.find((call) => call.id === orphan.toolCallId) ?? null;
			if (allowReattach && orphan.reattachable && parentCall !== null) {
				const batch = analysis.payload[orphan.payloadIndex];
				const precedingAssistant = analysis.assistantSourceIndex.get(orphan.payloadIndex - 1);
				if (precedingAssistant !== undefined) {
					pushCall(appendTo, precedingAssistant, parentCall);
				} else {
					const anchor = batch !== undefined && batch.role === "user" && batch.startMessageIndex !== null
						? batch.startMessageIndex
						: orphan.messageIndex;
					pushCall(insertBefore, anchor, parentCall);
				}
				repairs.push(describeRepair("reattach", orphan));
				continue;
			}
			drops.add(orphan.messageIndex);
			repairs.push(describeRepair("drop", orphan));
		}

		const next: unknown[] = [];
		for (let index = 0; index < current.length; index++) {
			const inserted = insertBefore.get(index);
			if (inserted !== undefined) {
				next.push(syntheticParentMessage(asRecord(current[index]), inserted));
			}
			if (drops.has(index)) continue;
			const appended = appendTo.get(index);
			const message = asRecord(current[index]);
			if (appended !== undefined && message !== null) {
				next.push({ ...message, content: [...contentBlocks(message), ...appended] });
				continue;
			}
			next.push(current[index]);
		}
		current = next;
	}
	return { messages: current as T[], repairs };
}

function pushCall(target: Map<number, ToolCallBlock[]>, key: number, call: ToolCallBlock): void {
	const calls = target.get(key) ?? [];
	if (!calls.some((existing) => existing.id === call.id)) calls.push(call);
	target.set(key, calls);
}

function describeRepair(kind: HistoryRepairKind, orphan: OrphanedToolResult): HistoryRepair {
	return {
		kind,
		toolCallId: orphan.toolCallId,
		toolName: orphan.toolName,
		payloadIndex: orphan.payloadIndex,
		blockIndex: orphan.blockIndex,
	};
}

/** One line naming what was repaired, for the user-facing warning and the log. */
export function describeHistoryRepairs(repairs: readonly HistoryRepair[]): string {
	const listed = repairs
		.map((repair) => `${repair.kind === "reattach" ? "restored the tool call for" : "dropped the result of"} ${repair.toolName} (${repair.toolCallId}) at messages.${repair.payloadIndex}.content.${repair.blockIndex}`)
		.join("; ");
	return `A tool result had lost its tool call, which the provider rejects for the whole conversation. Repaired the history before sending: ${listed}.`;
}

/**
 * The replacement to hand back from `message_end` when a transient assistant
 * response has to be discarded.
 *
 * Pi applies this in place on the object held by both agent state and the running
 * loop, so any tool call left out of it is destroyed while its tool may still be
 * executing. Tool calls are therefore preserved and only the prose is replaced.
 * `stopReason` is forced to a value pi core will not drop, except for `length`,
 * which pi core needs in order to keep refusing to execute truncated arguments.
 */
export function buildRecoveryReplacement<T>(message: T, recoveryText: string): T {
	const record = asRecord(message);
	const text = { type: "text", text: recoveryText };
	if (record === null) return message;
	const toolCalls = toolCallsOf(record);
	const stopReason = toolCalls.length > 0 && record.stopReason === "length" ? "length" : "stop";
	return {
		...record,
		content: toolCalls.length > 0 ? [text, ...toolCalls] : [text],
		stopReason,
		errorMessage: undefined,
	} as unknown as T;
}
