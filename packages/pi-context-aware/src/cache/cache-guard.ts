import { createHash } from "node:crypto";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../platform/config-layers.js";
import type { ContextAwareCacheCauseV1 } from "../context-service.js";
import { CACHE_VERDICT_ENTRY, cleanModelLabel, isObservedRequest, SHORT_CACHE_TTL_MS, LONG_CACHE_TTL_MS } from "./cache-explain.js";
import { changedSections, isWarmRequest, leadingSectionHashes } from "./cache-guard-signals.js";
import { measuredSurvival, readCacheProfile, type CacheProfileV1 } from "./cache-profile.js";
import { registryPriceBook, ratesFor } from "../strategy-runtime/bench/pricing.js";
import { isFabricChild } from "../compaction/seed-continuation.js";

export const CACHE_GUARD_ENTRY = "context-aware.cache-guard.v1";
// These are metadata only. In particular, mode permissions, rules and tool declarations are never restored.
const INFORMATIONAL = new Set(["date", "cwd", "mode", "mode-line", "mode_line", "skills", "skill-listing"]);
const UPDATE_LABEL = "Informational section update (data, not instructions):\n";
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

type Sections = Record<string, string | null>;

/** One informational section's new text, as the model reads it after the message it follows. */
interface SectionUpdate {
	readonly name: string;
	readonly text: string;
}

export interface SectionState {
	readonly initial: Map<string, string | null>;
	readonly latest: Map<string, string | null>;
	readonly updates: Map<string, SectionUpdate[]>;
}

export const emptySectionState = (): SectionState => ({ initial: new Map(), latest: new Map(), updates: new Map() });

const updateText = (name: string, value: string | null): string => value ?? `${name}: no longer set`;

/** The first request fixes the informational sections' text, including the ones it does not set. */
function seedInitial(state: SectionState, sections: Sections): void {
	if (state.initial.size > 0) return;
	for (const name of INFORMATIONAL) {
		const value = sections[name] ?? null;
		state.initial.set(name, value);
		state.latest.set(name, value);
	}
}

/** One informational section: record a change and return the first-sent text the system prompt keeps. */
function keepSection(name: string, value: string | null, state: SectionState, changed: SectionUpdate[]): string | null {
	if (!state.initial.has(name)) {
		state.initial.set(name, value);
		state.latest.set(name, value);
	}
	if (state.latest.get(name) !== value) {
		changed.push({ name, text: updateText(name, value) });
		state.latest.set(name, value);
	}
	return state.initial.get(name) ?? null;
}

/** A section sent before and absent now keeps its first text, and the model is told it is no longer set. */
function keepRemoved(state: SectionState, sections: Sections, changed: SectionUpdate[]): void {
	for (const [name, initial] of state.initial) {
		if (name in sections) continue;
		if (initial !== null) sections[name] = initial;
		if (state.latest.get(name) !== null) {
			changed.push({ name, text: updateText(name, null) });
			state.latest.set(name, null);
		}
	}
}

/** Keyed by role and timestamp: later transforms may rewrite a message's content, and the update must stay put. */
function messageKey(message: { role: string }): string {
	const at = (message as { timestamp?: unknown }).timestamp;
	return typeof at === "number" ? `${message.role}:${at}` : hash(message);
}

function keptSystem(system: SystemMessage, sections: Sections): SystemMessage {
	const kept: SystemMessage = { role: "system", content: system.content, timestamp: system.timestamp, sections };
	if (system.toolsAdded) kept.toolsAdded = system.toolsAdded;
	if (system.toolsRemoved) kept.toolsRemoved = system.toolsRemoved;
	return kept;
}

/** Pi may rebuild the leading system message. Retain metadata there and replay updates at their turn's tail. */
export function stabilizeSections<T extends { role: string }>(messages: readonly T[], state: SectionState): Array<T | Message> {
	const leading = messages[0];
	if (leading?.role !== "system") return [...messages];
	const system = leading as T & SystemMessage;
	const incoming = system.sections ?? {};
	seedInitial(state, incoming);
	const sections: Sections = {};
	const changed: SectionUpdate[] = [];
	for (const [name, value] of Object.entries(incoming)) sections[name] = INFORMATIONAL.has(name) ? keepSection(name, value, state, changed) : value;
	keepRemoved(state, sections, changed);
	resendLost(state, messages.slice(1), changed);
	recordUpdates(state, messages.at(-1), changed);
	return [keptSystem(system, sections), ...withUpdates(messages.slice(1), state, system.timestamp)];
}

/**
 * Compaction or pruning can drop the message an update follows. A section whose newest surviving update, or else
 * its first-sent text, is not its current value is sent again with this request's changes.
 */
function resendLost(state: SectionState, messages: ReadonlyArray<{ role: string }>, changed: SectionUpdate[]): void {
	const delivered = new Map<string, string>();
	for (const [name, value] of state.initial) delivered.set(name, updateText(name, value));
	for (const message of messages) for (const update of state.updates.get(messageKey(message)) ?? []) delivered.set(update.name, update.text);
	for (const update of changed) delivered.set(update.name, update.text);
	for (const [name, value] of state.latest) {
		const text = updateText(name, value);
		if (delivered.get(name) !== text) changed.push({ name, text });
	}
}

/** This request's changes arrive after its newest message, and stay there on later requests. */
function recordUpdates(state: SectionState, last: { role: string } | undefined, changed: readonly SectionUpdate[]): void {
	if (changed.length === 0 || !last) return;
	const key = messageKey(last);
	state.updates.set(key, [...(state.updates.get(key) ?? []), ...changed]);
}

function withUpdates<T extends { role: string }>(messages: readonly T[], state: SectionState, fallback: number): Array<T | Message> {
	const result: Array<T | Message> = [];
	for (const message of messages) {
		result.push(message);
		const updates = state.updates.get(messageKey(message));
		const timestamp = (message as T & { timestamp?: number }).timestamp ?? fallback;
		if (updates) result.push({ role: "user", content: UPDATE_LABEL + updates.map((update) => update.text).join("\n\n"), timestamp });
	}
	return result;
}

type MessageDescriptor = Omit<Extract<ContextAwareCacheCauseV1, { kind: "message-block" }>, "kind" | "index" | "count">;
interface Snapshot {
	readonly model: string;
	readonly tools: string;
	readonly toolNames: readonly string[];
	readonly sections: ReadonlyMap<string, string>;
	readonly seen: ReadonlyMap<string, string>;
	readonly settings: string;
	readonly blocks: readonly string[];
	readonly sizes: readonly number[];
	readonly messageOffset: number;
	readonly messages: readonly MessageDescriptor[];
	readonly breakpoint: number;
	/** When the request was sent. */
	readonly at: number;
	/** When its response ended with usage, once it has; the measured profile's idle gap starts here. */
	readonly endedAt?: number;
}
export interface CachePrediction {
	readonly kind: "tools" | "system-section" | "model" | "setting" | "unknown";
	readonly sections: readonly string[];
	readonly names: readonly string[];
	readonly lostTokens: number | null;
	readonly costUsd: number | null;
}
type Cause = Pick<CachePrediction, "kind" | "sections" | "names">;

/** A string, or the text of an array of text blocks or parts. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(record).map((block) => (typeof block.text === "string" ? block.text : "")).join("\n");
}

const INSTRUCTION_ROLES = new Set(["system", "developer"]);

/**
 * The system prompt as text, in each provider shape Pi encodes: Anthropic and Bedrock `system` (string or blocks),
 * OpenAI Responses `instructions`, Google `config.systemInstruction`, or else the leading system or developer
 * messages of Chat Completions `messages` and Responses `input`.
 */
function systemTextOf(payload: Json): string {
	return topLevelSystem(payload) ?? leadingInstructions(payload);
}

/** A system prompt sent outside the message list; undefined when the messages carry it. */
function topLevelSystem(payload: Json): string | undefined {
	if (payload.system !== undefined) return textOf(payload.system);
	if (typeof payload.instructions === "string") return payload.instructions;
	if (record(payload.config) && payload.config.systemInstruction !== undefined) return textOf(payload.config.systemInstruction);
	return undefined;
}

/** Items that declare tools in place and carry no instruction text; the instructions may follow them. */
const TOOL_DECLARATION_ITEMS = new Set(["additional_tools", "tool_search_call", "tool_search_output"]);

function isToolDeclaration(message: Json): boolean {
	return typeof message.type === "string" && TOOL_DECLARATION_ITEMS.has(message.type);
}

/** The leading system or developer messages, read past tool declarations that precede them. */
function leadingInstructions(payload: Json): string {
	const leading: string[] = [];
	for (const message of messagesOf(payload)) {
		if (!record(message)) break;
		if (isToolDeclaration(message)) continue;
		if (typeof message.role !== "string" || !INSTRUCTION_ROLES.has(message.role)) break;
		leading.push(textOf(message.content));
	}
	return leading.join("\n");
}

/** Pi renders each structured section as `<name>\n...\n</name>`; the whole prompt is one more entry. */
function sectionHashes(system: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const match of system.matchAll(/<([\w-]+)>\n([\s\S]*?)\n<\/\1>/gu)) sections.set(match[1]!, hash(match[2]));
	sections.set("whole-prompt", hash(system));
	return sections;
}

function withoutCacheControl(value: unknown): unknown {
	if (!record(value)) return value;
	const { cache_control: _marker, ...rest } = value;
	return rest;
}

/** Chat Completions and Anthropic `messages`, Responses `input`, or Google `contents`. */
function messagesOf(payload: Json): unknown[] {
	if (Array.isArray(payload.messages)) return payload.messages;
	if (Array.isArray(payload.input)) return payload.input;
	return Array.isArray(payload.contents) ? payload.contents : [];
}

/** Top-level `tools`, or Google `config.tools` with each function declaration as one tool. */
function toolsOf(payload: Json): unknown[] {
	if (Array.isArray(payload.tools)) return payload.tools;
	if (!record(payload.config) || !Array.isArray(payload.config.tools)) return [];
	return payload.config.tools.flatMap((tool: unknown) => (record(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [tool]));
}

/** Request settings that start a new cache, at the top level or in Google `config`. */
function settingsOf(payload: Json): unknown[] {
	const config = record(payload.config) ? payload.config : {};
	return [
		payload.temperature, payload.top_p, payload.thinking, payload.reasoning, payload.reasoning_effort,
		config.temperature, config.topP, config.thinkingConfig, config.toolConfig,
	];
}

/** Every cacheable block in provider order: tools, then system, then message content (which may hold the system). */
function cacheBlocks(payload: Json): unknown[] {
	const blocks: unknown[] = [...toolsOf(payload)];
	const system = topLevelSystem(payload);
	if (Array.isArray(payload.system)) blocks.push(...payload.system);
	else if (system) blocks.push(system);
	for (const message of messagesOf(payload)) blocks.push(...messageBlocks(message));
	return blocks;
}

/** A message with content blocks (or Google parts) caches block by block, each tagged with its role. */
function messageBlocks(message: unknown): unknown[] {
	if (!record(message)) return [message];
	const blocks = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : undefined;
	if (!blocks) return [message];
	return blocks.map((block: unknown) => ({ role: message.role, ...(record(block) ? block : { content: block }) }));
}

function toolNameOf(tool: Json): string {
	if (typeof tool.name === "string") return tool.name;
	return record(tool.function) && typeof tool.function.name === "string" ? tool.function.name : "unknown";
}

/** Chat Completions `tool_calls` on an assistant message: function or custom calls with their ids. */
function chatToolCalls(fields: Json): Array<{ readonly id: string; readonly name: string }> {
	if (!Array.isArray(fields.tool_calls)) return [];
	return fields.tool_calls.filter(record).flatMap((call) => {
		const target = record(call.function) ? call.function : record(call.custom) ? call.custom : undefined;
		return typeof call.id === "string" && typeof target?.name === "string" ? [{ id: call.id, name: target.name }] : [];
	});
}

/** Google parts carry no `type`; the part's one payload key names it. */
const GOOGLE_PART_TYPES = ["functionCall", "functionResponse", "inlineData", "fileData", "executableCode", "codeExecutionResult"] as const;
/** Responses items without a role: tool calls come from the assistant, their outputs are tool results. */
const ITEM_ROLES: ReadonlyMap<string, string> = new Map([
	["function_call", "assistant"], ["custom_tool_call", "assistant"], ["reasoning", "assistant"],
	["function_call_output", "tool"], ["custom_tool_call_output", "tool"],
]);

function blockType(fields: Json): string {
	if (typeof fields.type === "string") return fields.type;
	const part = GOOGLE_PART_TYPES.find((key) => record(fields[key]));
	if (part) return part;
	if (fields.thought === true) return "thought";
	return chatToolCalls(fields).length > 0 ? "tool_calls" : "text";
}

function blockRole(fields: Json): string {
	if (typeof fields.role === "string") return fields.role;
	return (typeof fields.type === "string" ? ITEM_ROLES.get(fields.type) : undefined) ?? "unknown";
}

/** Each tool call's id and name: Anthropic `tool_use`, Responses calls by `call_id`, Chat Completions `tool_calls`. */
function toolCallNames(blocks: readonly unknown[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const block of blocks) {
		if (!record(block)) continue;
		const id = typeof block.call_id === "string" ? block.call_id : block.id;
		if (typeof id === "string" && typeof block.name === "string") names.set(id, block.name);
		for (const call of chatToolCalls(block)) names.set(call.id, call.name);
	}
	return names;
}

const RESULT_ID_FIELDS = ["tool_use_id", "call_id", "tool_call_id"] as const;

function messageToolName(fields: Json, calls: ReadonlyMap<string, string>): string | undefined {
	if (typeof fields.name === "string") return fields.name;
	for (const key of ["functionCall", "functionResponse"] as const) {
		const part = fields[key];
		if (record(part) && typeof part.name === "string") return part.name;
	}
	const chat = chatToolCalls(fields);
	if (chat.length > 0) return chat.map((call) => call.name).join(", ");
	const key = RESULT_ID_FIELDS.find((field) => typeof fields[field] === "string");
	return key === undefined ? undefined : calls.get(fields[key] as string);
}

function describeMessages(payload: Json): MessageDescriptor[] {
	const blocks = messagesOf(payload).flatMap(messageBlocks);
	const calls = toolCallNames(blocks);
	return blocks.map((block) => {
		const fields = record(block) ? block : {};
		const name = messageToolName(fields, calls);
		return {
			role: cleanModelLabel(blockRole(fields)),
			type: cleanModelLabel(blockType(fields)),
			...(name === undefined ? {} : { tool: cleanModelLabel(name) }),
		};
	});
}

/** Compare only the prefix the previous request could cache; appended blocks are growth. */
function compareMessages(previous: Snapshot, next: Snapshot): ContextAwareCacheCauseV1 | undefined {
	if (previous.breakpoint < 0) return undefined;
	for (let position = 0; position <= previous.breakpoint; position++) {
		if (previous.blocks[position] === next.blocks[position]) continue;
		const index = position - next.messageOffset;
		const descriptor = next.messages[index] ?? previous.messages[position - previous.messageOffset];
		if (!descriptor || index < 0) return undefined;
		return { kind: "message-block", index, count: next.messages.length, role: descriptor.role, type: descriptor.type, ...(descriptor.tool === undefined ? {} : { tool: descriptor.tool }) };
	}
	return { kind: "unchanged" };
}

function snapshot(payload: Json, model: string, seen: ReadonlyMap<string, string>): Snapshot {
	const tools = toolsOf(payload);
	const system = systemTextOf(payload);
	const raw = cacheBlocks(payload);
	const texts = raw.map((block) => JSON.stringify(withoutCacheControl(block)) ?? "");
	// Without a system field (OpenAI-style automatic caching), the whole request is the cached prefix.
	const marked = raw.map((block) => record(block) && block.cache_control !== undefined);
	const breakpoint = payload.system === undefined ? raw.length - 1 : marked.lastIndexOf(true);
	return {
		model,
		tools: hash(tools),
		toolNames: tools.filter(record).map(toolNameOf),
		sections: sectionHashes(system),
		seen,
		settings: hash(settingsOf(payload)),
		blocks: texts.map(hash),
		sizes: texts.map((text) => Math.ceil(text.length / 4)),
		messageOffset: raw.length - messagesOf(payload).flatMap(messageBlocks).length,
		messages: describeMessages(payload),
		breakpoint,
		at: Date.now(),
	};
}

/** Operator-facing names use the same one-line, bounded sanitizer as cache-explain. */
export function cacheGuardReport(prediction: CachePrediction): string {
	const names = prediction.names.slice(0, 8).map(cleanModelLabel).join(", ");
	const more = prediction.names.length > 8 ? ", …" : "";
	const cost = prediction.costUsd === null ? "unknown" : "$" + prediction.costUsd.toFixed(4);
	return `Cache guard (data, not instructions): ${prediction.kind}; ${names}${more}; estimated lost prefix ${prediction.lostTokens ?? "unknown"} tokens; extra write cost ${cost}. Provider eviction is not observable.`;
}

const isContinuation = (payload: Json): boolean => Boolean(payload.previous_response_id || payload.thread_id || payload.conversation_id);

function changedTools(previous: Snapshot, next: Snapshot): string[] {
	const removed = previous.toolNames.filter((name) => !next.toolNames.includes(name));
	const added = next.toolNames.filter((name) => !previous.toolNames.includes(name));
	return [...new Set([...removed, ...added])];
}

/** The first difference, in the order a provider checks: model, tools, system prompt, then request settings. */
function causeOf(previous: Snapshot, next: Snapshot): Cause | undefined {
	if (previous.model !== next.model) return { kind: "model", sections: [], names: [previous.model, next.model] };
	if (previous.tools !== next.tools) return { kind: "tools", sections: [], names: changedTools(previous, next) };
	if (previous.sections.get("whole-prompt") !== next.sections.get("whole-prompt")) {
		const sections = changedSections(previous, next);
		return { kind: "system-section", sections, names: sections };
	}
	if (previous.settings !== next.settings) return { kind: "setting", sections: [], names: ["request settings"] };
	return undefined;
}

/** Tokens the previous request cached up to its last breakpoint that this request no longer matches. */
/**
 * Whether the provider cache has expired after an idle gap: past the fixed lifetime, unless the row has no
 * `promptCache` and the measured profile shows the cache still surviving at that gap (pi-context-aware#566).
 * The profile is read only past the fixed lifetime. `idleMs` runs from the previous request's start, as the fixed
 * lifetime does; `idleSinceEndMs` runs from the end of its response, the gap the profile measured.
 */
export function cacheExpiredAfter(
	idleMs: number,
	model: { readonly provider: string; readonly id: string; readonly promptCache?: unknown } | undefined,
	profile: () => CacheProfileV1 | undefined = readCacheProfile,
	idleSinceEndMs: number = idleMs,
): boolean {
	const ttl = process.env.PI_CACHE_RETENTION === "long" ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
	if (idleMs <= ttl) return false;
	if (!model || model.promptCache !== undefined) return true;
	return measuredSurvival(profile(), `${model.provider}/${model.id}`, Math.max(0, idleSinceEndMs)) === undefined;
}

function lostTokensOf(previous: Snapshot, next: Snapshot, kind: Cause["kind"], ctx: ExtensionContext): number {
	// An expired cache is lost whatever this request sends.
	if (cacheExpiredAfter(next.at - previous.at, ctx.model, readCacheProfile, next.at - (previous.endedAt ?? previous.at))) return 0;
	let first = 0;
	// A model or setting change starts a new cache, so the whole cached prefix is lost.
	if (kind !== "model" && kind !== "setting") while (first < previous.blocks.length && previous.blocks[first] === next.blocks[first]) first++;
	return sum(previous.sizes.slice(first, previous.breakpoint + 1));
}

/** Lost tokens × (cache write price − cache read price), from the registry price book. */
function costOf(ctx: ExtensionContext, next: Snapshot, lostTokens: number): number | null {
	const model = ctx.model;
	const price = model ? registryPriceBook().lookup(model.provider, model.id) : undefined;
	if (!price) return null;
	const rates = ratesFor(price, sum(next.sizes));
	return lostTokens * Math.max(0, rates.cacheWrite - rates.cacheRead) / 1e6;
}

function predict(previous: Snapshot | undefined, next: Snapshot, payload: Json, ctx: ExtensionContext): CachePrediction | undefined {
	if (isContinuation(payload)) return { kind: "unknown", sections: [], names: ["continuation transport"], lostTokens: null, costUsd: null };
	const cause = previous ? causeOf(previous, next) : undefined;
	if (!previous || !cause) return undefined;
	const lostTokens = lostTokensOf(previous, next, cause.kind, ctx);
	return { ...cause, lostTokens, costUsd: costOf(ctx, next, lostTokens) };
}

/** The two request hooks the extension calls from its own handlers, so each hook keeps one handler per extension. */
export interface CacheGuard {
	/** Call at the start of every before_agent_start. */
	agentStart(event: object): void;
	/**
	 * Call last in before_provider_request, with the payload as it will be sent. Returns undefined when the guard is
	 * off, so a disabled guard leaves the hook synchronous.
	 */
	providerRequest(payload: unknown, ctx: ExtensionContext): Promise<void> | undefined;
	/**
	 * Call from message_end with the message as it ends. A reply that reports no usage (a failed or aborted
	 * attempt) does not make its request the baseline: cache.explain measures usage against the last request that
	 * reported usage, so the guard compares the next request with that one too.
	 */
	messageEnd(message: unknown): void;
}

export type CacheGuardInteractive = "auto" | "never" | "always";
export const DEFAULT_ASK_TIMEOUT_MS = 60_000;

interface AskInput {
	readonly at: "turn-start" | "tool-loop";
	readonly userTurn: boolean;
	readonly costUsd: number | null;
	readonly askAboveUsd: number;
	readonly interactive: CacheGuardInteractive;
}

/**
 * Pi RPC mode reports hasUI, but its dialogs go to a host that may have nobody at the other end. "auto" therefore
 * asks only where a person is at the terminal (mode "tui"); a Pi that reports no mode keeps asking whenever hasUI.
 */
function dialogReachable(ctx: ExtensionContext, interactive: CacheGuardInteractive): boolean {
	if (interactive === "never" || !ctx.hasUI) return false;
	return interactive === "always" || ctx.mode === undefined || ctx.mode === "tui";
}

/** Only a priced break at the start of a user turn, above the threshold, in a session a person answers. */
function shouldAsk(input: AskInput, ctx: ExtensionContext): boolean {
	if (input.at !== "turn-start" || !input.userTurn || input.costUsd === null || input.costUsd <= input.askAboveUsd) return false;
	// Fabric children may report a UI, but nobody is there to answer: they only log.
	return dialogReachable(ctx, input.interactive) && !isFabricChild();
}

interface Answer {
	readonly proceed: boolean;
	readonly timedOut: boolean;
}

/**
 * Asks, and never waits longer than timeoutMs: an RPC host's dialog has no timeout of its own, and a host that
 * forwards it to a web UI may never answer. No answer in time, or a dialog that fails, sends the request as is.
 */
async function askBounded(ctx: ExtensionContext, text: string, timeoutMs: number): Promise<Answer> {
	const dismiss = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
	try {
		const answer = await Promise.race([ctx.ui.confirm("Prompt-cache break", text + " Continue?", { signal: dismiss.signal }), expired]);
		return answer === "timeout" ? { proceed: true, timedOut: true } : { proceed: answer, timedOut: false };
	} catch {
		return { proceed: true, timedOut: false };
	} finally {
		clearTimeout(timer);
		dismiss.abort();
	}
}

const modelKey = (ctx: ExtensionContext): string => `${ctx.model?.provider}/${ctx.model?.id}/${ctx.model?.api}`;

function supportsMidConversationSystem(ctx: ExtensionContext): boolean {
	const compat = ctx.model?.compat;
	return Boolean(compat && "supportsMidConvoSystemMessages" in compat && compat.supportsMidConvoSystemMessages === true);
}

/** State belongs to a session branch; no previous request body or tool definition is retained for restoration. */
export function registerCacheGuard(pi: ExtensionAPI, config: (ctx: ExtensionContext) => Config["cacheGuard"]): CacheGuard {
	let sectionState = emptySectionState();
	let seen: ReadonlyMap<string, string> = new Map();
	let previous: Snapshot | undefined;
	/** The baseline before the request whose reply has not ended yet. */
	let attempt: { readonly before: Snapshot | undefined } | undefined;
	let turnStart = true;
	let userTurn = true;
	const reset = () => { previous = undefined; attempt = undefined; turnStart = true; sectionState = emptySectionState(); seen = new Map(); };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("context_with_system", (event, ctx) => {
		const messages = !config(ctx)?.enabled || supportsMidConversationSystem(ctx) ? event.messages : stabilizeSections(event.messages, sectionState);
		seen = leadingSectionHashes(messages, hash);
		if (messages !== event.messages) return { messages };
	});
	/** Logs the break, asks when it must, and returns whether the request may go. */
	const report = async (prediction: CachePrediction, at: AskInput["at"], ctx: ExtensionContext): Promise<boolean> => {
		const text = cacheGuardReport(prediction);
		const settings = config(ctx);
		const asked = shouldAsk({ at, userTurn, costUsd: prediction.costUsd, askAboveUsd: settings?.askAboveUsd ?? 0.01, interactive: settings?.interactive ?? "auto" }, ctx);
		const answer: Answer = asked ? await askBounded(ctx, text, settings?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) : { proceed: true, timedOut: false };
		const proceed = answer.proceed;
		pi.appendEntry(CACHE_GUARD_ENTRY, { at, kind: prediction.kind, sections: prediction.sections.map(cleanModelLabel), names: prediction.names.slice(0, 32).map(cleanModelLabel), asked, timedOut: answer.timedOut, lostTokens: prediction.lostTokens, costUsd: prediction.costUsd, report: text, declined: !proceed });
		if (!asked && ctx.hasUI) ctx.ui.setStatus("cache-guard", text);
		return proceed;
	};
	const guard = async (payload: Json, ctx: ExtensionContext): Promise<void> => {
		const before = previous;
		attempt = undefined;
		if (isWarmRequest(payload)) return;
		const next = snapshot(payload, modelKey(ctx), seen);
		const prediction = predict(previous, next, payload, ctx);
		const at = turnStart ? "turn-start" : "tool-loop";
		turnStart = false;
		if (prediction && !(await report(prediction, at, ctx))) {
			// Declining stops the turn; nothing is sent, and the previous request stays the reference.
			ctx.abort();
			return;
		}
		if (previous && !isContinuation(payload) && !causeOf(previous, next)) {
			const verdict = compareMessages(previous, next);
			if (verdict) pi.appendEntry(CACHE_VERDICT_ENTRY, verdict);
		}
		previous = isContinuation(payload) ? undefined : next;
		attempt = { before };
	};
	return {
		agentStart(event) { turnStart = true; userTurn = "prompt" in event; },
		providerRequest(payload, ctx) {
			if (!config(ctx)?.enabled) { previous = undefined; attempt = undefined; return undefined; }
			return record(payload) ? guard(payload, ctx) : undefined;
		},
		messageEnd(message) {
			if (!record(message) || message.role !== "assistant" || !attempt) return;
			if (!isObservedRequest(message)) previous = attempt.before;
			else if (previous) previous = { ...previous, endedAt: Date.now() };
			attempt = undefined;
		},
	};
}