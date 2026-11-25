/**
 * Keep the conversation cache breakpoint off the request's non-persisted injection (pi-context-aware#461).
 *
 * pi-ai marks the end of the last user message as the conversation cache breakpoint: `cache_control` on its
 * last block (Anthropic Messages, and the last text part on OpenAI-compatible payloads), or a trailing
 * `cachePoint` block (Bedrock Converse). When that block is the fold nudge or the pressure action line, the next
 * request no longer contains it: the cache entry written there is never read, and every such request writes the
 * whole history again. Moving the breakpoint to the block before the injection, the end of the session's own
 * messages, writes an entry the next request repeats and reads. The injection itself, a few dozen tokens, is
 * never cached. A request can end with several injections, the pressure line and then the operator reminder
 * (pi-context-aware#462); the breakpoint moves before all of them.
 *
 * The breakpoint moves only onto a text, tool-call or tool-result block, the blocks pi-ai itself marks. It never
 * moves onto an image, a thinking block, a string message or a block that already carries one; the payload is
 * then left alone, as is a payload of any other shape and a last block that is not the injection.
 */

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Anthropic and OpenAI-compatible block types that may carry `cache_control`. */
const MOVABLE_TYPES = new Set(["text", "tool_result", "tool_use"]);
/** Bedrock Converse blocks are keyed by kind; these may be followed by a `cachePoint`. */
const BEDROCK_MOVABLE_KEYS = ["text", "toolResult", "toolUse"] as const;

/** Where a block sits in the payload: its message and its index in that message's content. */
interface Position {
	readonly message: number;
	readonly block: number;
}

/**
 * The payload with the breakpoint moved from the trailing run of injected blocks to the block before the run, or
 * undefined when nothing moves. `injected` lists every non-persisted text this request ends with, such as the
 * fold nudge and pressure line and the operator reminder (pi-context-aware#462); any of them may be absent. The
 * input is not changed.
 */
export function cacheBreakpointBeforeInjection(payload: unknown, injected: string | readonly string[]): unknown {
	const texts = new Set((typeof injected === "string" ? [injected] : injected).filter((text) => text.length > 0));
	if (texts.size === 0) return undefined;
	if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) return undefined;
	const messages = payload.messages as unknown[];
	const lastIndex = skipEffortMarkers(messages, messages.length - 1);
	const last = messages[lastIndex];
	if (!isRecord(last) || last.role !== "user" || !Array.isArray(last.content) || last.content.length === 0) return undefined;
	const tail = last.content[last.content.length - 1];
	if (isRecord(tail) && isRecord(tail.cachePoint)) return lastIndex === messages.length - 1 ? bedrockBreakpointBeforeInjection(payload, texts) : undefined;
	if (!isRecord(tail) || tail.type !== "text" || typeof tail.text !== "string" || !texts.has(tail.text) || tail.cache_control === undefined) return undefined;
	// The session's own last block: before the injected tail and every injected block right before it.
	const isInjected = (block: unknown): boolean => isRecord(block) && block.type === "text" && typeof block.text === "string" && texts.has(block.text) && block.cache_control === undefined;
	let at = before(messages, { message: lastIndex, block: last.content.length - 1 });
	while (at && isInjected(blockAt(messages, at))) at = before(messages, at);
	if (!at) return undefined;
	const previous = blockAt(messages, at);
	if (!isRecord(previous) || typeof previous.type !== "string" || !MOVABLE_TYPES.has(previous.type) || previous.cache_control !== undefined) return undefined;
	const next = structuredClone(payload);
	const nextMessages = next.messages as Json[];
	const nextTail = (nextMessages[lastIndex]!.content as Json[]).at(-1)!;
	(blockAt(nextMessages, at) as Json).cache_control = nextTail.cache_control;
	delete nextTail.cache_control;
	return next;
}

function blockAt(messages: readonly unknown[], at: Position): unknown {
	const message = messages[at.message];
	return isRecord(message) && Array.isArray(message.content) ? message.content[at.block] : undefined;
}

/** Pi's managed-effort markers have no blocks and must not interrupt a backward walk. */
function skipEffortMarkers(messages: readonly unknown[], from: number): number {
	let index = from;
	while (index >= 0) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "system" || !Array.isArray(message.content) || message.content.length !== 0) break;
		index--;
	}
	return index;
}

/** The block before `at`, stepping over empty system effort markers between messages. */
function before(messages: readonly unknown[], at: Position): Position | undefined {
	if (at.block > 0) return { message: at.message, block: at.block - 1 };
	const previousIndex = skipEffortMarkers(messages, at.message - 1);
	const message = messages[previousIndex];
	if (!isRecord(message) || !Array.isArray(message.content) || message.content.length === 0) return undefined;
	return { message: previousIndex, block: message.content.length - 1 };
}

/**
 * Bedrock Converse: pi-ai appends `{ cachePoint }` after the last block of the last user message. When the blocks
 * before it are injections, the cache point moves to just after the session's own last block, inside the same
 * message or at the end of an earlier one.
 */
function bedrockBreakpointBeforeInjection(payload: Json, texts: ReadonlySet<string>): unknown {
	const messages = payload.messages as unknown[];
	const content = (messages[messages.length - 1] as Json).content as unknown[];
	if (content.length < 2 || Object.keys(content[content.length - 1] as Json).length !== 1) return undefined;
	const isInjected = (block: unknown): boolean => isRecord(block) && typeof block.text === "string" && texts.has(block.text);
	const injectedAt = { message: messages.length - 1, block: content.length - 2 };
	if (!isInjected(blockAt(messages, injectedAt))) return undefined;
	let at = before(messages, injectedAt);
	while (at && isInjected(blockAt(messages, at))) at = before(messages, at);
	if (!at) return undefined;
	const previous = blockAt(messages, at);
	if (!isRecord(previous) || "cachePoint" in previous || !BEDROCK_MOVABLE_KEYS.some((key) => key in previous)) return undefined;
	const next = structuredClone(payload);
	const nextMessages = next.messages as Json[];
	const point = (nextMessages[nextMessages.length - 1]!.content as Json[]).pop()!;
	(nextMessages[at.message]!.content as Json[]).splice(at.block + 1, 0, point);
	return next;
}
