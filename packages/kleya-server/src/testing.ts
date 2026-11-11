// @centerforagenticai/kleya-server/testing: what an adapter needs to prove itself. A scripted model behind a model
// gateway, an in-memory adapter, and the host contract suite every adapter must pass unchanged (G-HOST-PARITY). The
// suite takes its test functions from the caller, so this module depends on no test runner (MIN-10).
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type Context as ModelContext, type Model } from "@earendil-works/pi-ai";
import {
	configure,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	MemoryStorage,
	type ConversationId,
	type EntryRecord,
	type HarnessSettings,
	type JsonObject,
	type Storage,
	type SubmissionRecord,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { decodeSessionCursor, LIMITS, type Accepted, type FeedError, type HarnessId, type SessionEvent, type SessionPage, type TurnEvent, type TurnPage, type TurnStatus } from "@centerforagenticai/kleya-client/protocol";
import { writeContext } from "./context.ts";
import { indexChanges, type ChangeIndex } from "./feed.ts";
import { productTools, type HttpTool } from "./tools.ts";
import {
	createHost,
	effectTool,
	hostRequestId,
	turnCredential,
	type Caller,
	type CredentialPort,
	type EffectClass,
	type EffectTool,
	type Fence,
	type Gateway,
	type Host,
	type HostOptions,
	type HostPorts,
	type Right,
	type Scope,
	type SessionHost,
	type SubmitOptions,
	type Turn,
} from "./host.ts";
import { RECOVERY_DELAY_MS } from "./host.ts";
import { RETENTION } from "./host/core.ts";

// --- Scripted model behind a gateway ---

/** One model response. Text streams in `chunks`; `hold` keeps the stream open after them until it resolves or the request is aborted. */
export type Step = { readonly chunks?: readonly string[]; readonly hold?: Promise<void>; readonly error?: string; readonly toolCalls?: readonly { name: string; arguments: JsonObject; id?: string }[] };
/** One request the model received: its messages, its headers, and the base URL and key it was sent to. */
export type ModelCall = { readonly context: ModelContext; readonly headers: Record<string, string>; readonly baseUrl: string; readonly apiKey: string | undefined };

export type ScriptedModel = {
	/** The model gateway (K6) to give the host: the scripted model, reached at its own base URL with `credential`. */
	readonly gateway: Gateway;
	readonly agentModel: { provider: string; modelId: string };
	readonly calls: ModelCall[];
	/** The scope of each `gateway.access` call. */
	readonly accesses: Scope[];
	/** Queues responses. A request with none queued answers "ok". */
	script(...steps: Step[]): void;
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** The base URL the scripted gateway hands out. The catalog model names another, which no request may use. */
const GATEWAY_URL = "http://gateway.invalid";

/** A scripted model behind a gateway whose `access` returns GATEWAY_URL and `credential`. */
export function scriptedModel(options: { readonly credential?: string } = {}): ScriptedModel {
	const steps: Step[] = [];
	const calls: ModelCall[] = [];
	const accesses: Scope[] = [];
	const model = {
		id: "script-1",
		name: "Scripted",
		api: "kleya-script",
		provider: "script",
		baseUrl: "http://catalog.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as unknown as Model<"openai-completions">;

	const stream = (m: Model<never>, context: ModelContext, options?: { signal?: AbortSignal; headers?: Record<string, string>; apiKey?: string }) => {
		const out = createAssistantMessageEventStream();
		const step = steps.shift() ?? { chunks: ["ok"] };
		calls.push({ context: structuredClone(context), headers: { ...(options?.headers ?? {}) }, baseUrl: m.baseUrl, apiKey: options?.apiKey });
		const signal = options?.signal;
		const message: AssistantMessage = { role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, usage: structuredClone(ZERO), stopReason: "stop", timestamp: Date.now() };
		const finish = (reason: "aborted" | "error", text: string) => {
			message.stopReason = reason;
			message.errorMessage = text;
			out.push({ type: "error", reason, error: { ...message } });
			out.end({ ...message });
		};
		void (async () => {
			out.push({ type: "start", partial: { ...message } });
			if (step.chunks !== undefined && step.chunks.length > 0) {
				const block = { type: "text" as const, text: "" };
				message.content.push(block);
				out.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
				for (const chunk of step.chunks) {
					block.text += chunk;
					out.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: { ...message } });
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				if (step.hold !== undefined) {
					const aborted = new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
					await Promise.race([step.hold, aborted]);
				}
				if (signal?.aborted) return finish("aborted", "Request was aborted");
				out.push({ type: "text_end", contentIndex: 0, content: block.text, partial: { ...message } });
			}
			if (signal?.aborted) return finish("aborted", "Request was aborted");
			if (step.error !== undefined) return finish("error", step.error);
			for (const [i, call] of (step.toolCalls ?? []).entries()) {
				const toolCall = { type: "toolCall" as const, id: call.id ?? `call_${calls.length}_${i}`, name: call.name, arguments: call.arguments };
				message.content.push(toolCall);
				const index = message.content.length - 1;
				out.push({ type: "toolcall_start", contentIndex: index, partial: { ...message } });
				out.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: { ...message } });
				message.stopReason = "toolUse";
			}
			out.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message: { ...message } });
			out.end({ ...message });
		})();
		return out;
	};
	const gateway: Gateway = {
		models: [model],
		streams: { stream: stream as never, streamSimple: stream as never },
		async access(scope) {
			accesses.push(scope);
			return { baseUrl: GATEWAY_URL, credential: options.credential ?? "gateway-credential" };
		},
	};
	return { gateway, agentModel: { provider: "script", modelId: "script-1" }, calls, accesses, script: (...more) => void steps.push(...more) };
}

// --- In-memory adapter ---

/** Thrown by a store write under a stale fence (K1-I2). */
class FencedError extends Error {
	readonly id: HarnessId;
	constructor(id: HarnessId) {
		super(`session ${id} has a newer owner`);
		this.id = id;
	}
}

type MemoryStore = { storage: MemoryStorage; indexed: { storage: Storage; changes: ChangeIndex } };

/**
 * Ports over process memory. A store outlives the host that opened it, so a second host over the same ports recovers it,
 * and a host closing a session leaves its store open for the next. No alarm port: `hostContract` records its own.
 */
export function memoryPorts(): HostPorts & { stored(id: HarnessId): MemoryStorage | undefined } {
	const stores = new Map<HarnessId, MemoryStore>();
	const epochs = new Map<HarnessId, number>();
	return {
		owner: {
			async acquire(id) {
				const epoch = (epochs.get(id) ?? 0) + 1;
				epochs.set(id, epoch);
				return { epoch };
			},
			async release() {},
		},
		storage: {
			async open(id, fence: Fence) {
				let store = stores.get(id);
				if (store === undefined) {
					const storage = new MemoryStorage();
					store = { storage, indexed: indexChanges(storage) };
					stores.set(id, store);
				}
				// One change index for the store's life, so the store name in its cursors survives a takeover.
				const { indexed } = store;
				const fenced = new Proxy(indexed.storage, {
					get(target, key) {
						const value = Reflect.get(target, key, target) as unknown;
						if (typeof value !== "function") return value;
						if (key === "close") return async () => {};
						if (key === "commit" || key === "mintId") {
							return (...args: unknown[]) => {
								if (epochs.get(id) !== fence.epoch) return Promise.reject(new FencedError(id));
								return (value as (...a: unknown[]) => unknown).apply(target, args);
							};
						}
						return (value as (...a: unknown[]) => unknown).bind(target);
					},
				});
				return { storage: fenced, changes: indexed.changes };
			},
			async drop(id) {
				stores.delete(id);
			},
		},
		stored: (id) => stores.get(id)?.storage,
	};
}

// --- Host contract suite ---

/** The test functions the suite needs, such as Vitest's or node:test's. */
export type Runner = {
	describe(name: string, body: () => void): void;
	test(name: string, body: () => Promise<void>, timeoutMs?: number): void;
};

/** Builds the adapter's ports for one test; `dispose` runs after it. */
export type Adapter = () => Promise<{ ports: HostPorts; dispose(): Promise<void> }>;

const ctx: Context = BACKGROUND_CONTEXT;
const SCOPE: Scope = { product: "contract", keys: ["tenant-a", "thread-1"] };

/** Every credential in the suite contains this, so one scan finds any of them where it must not be. */
const SECRET = "kleya-contract-secret";
const GATEWAY_CREDENTIAL = `${SECRET}:gateway`;
/** What the suite's credential port mints for a turn. */
const minted = (turn: Turn) => `${SECRET}:product:${turn.principal ?? "host"}:${turn.requestId}:${turn.attempt}`;

const caller = (principal: string, ...rights: Right[]): Caller => ({ principal, rights });
const ALICE = caller("alice", "read", "submit", "steer", "cancel");
const BOB = caller("bob", "read", "submit", "steer", "cancel");
const VIEWER = caller("vera", "read");
const NOBODY = caller("nora");
/** An event source: it may submit and nothing else (spec 5.3.3, trigger). */
const EVENTS = caller("events", "submit");

const NOT_FOUND: FeedError = { t: "error", code: "not_found", retry: "never" };
const FORBIDDEN: FeedError = { t: "error", code: "forbidden", retry: "never" };

function fail(what: string, actual: unknown, expected?: unknown): never {
	throw new Error(expected === undefined ? `${what}: ${JSON.stringify(actual)}` : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function equal<T>(actual: T, expected: T, what: string) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(what, actual, expected);
}
function is<T extends { t: string }>(value: { t: string }, t: T["t"], what: string): T {
	if (value.t !== t) fail(what, value);
	return value as T;
}

/** Applies turn events to a client's copy of the text, as a client must: append text, truncate on rewind. */
function applyEvents(text: string, events: readonly TurnEvent[]): string {
	for (const e of events) {
		if (e.t === "text") text += e.text;
		else if (e.t === "rewind") text = text.slice(0, e.to);
	}
	return text;
}

/** Follows a turn from `after` to its end; returns the events, the final cursor and the end status. */
async function followToEnd(session: SessionHost, requestId: string, after?: string, conversation?: number): Promise<{ events: TurnEvent[]; cursor: string; status: TurnStatus }> {
	const events: TurnEvent[] = [];
	let cursor = after;
	for (let i = 0; i < 200; i++) {
		const page = is<TurnPage>(await session.follow(ALICE, requestId, { ...(cursor === undefined ? {} : { after: cursor }), ...(conversation === undefined ? {} : { conversation }) }, ctx), "turn", "follow");
		events.push(...page.events);
		cursor = page.cursor;
		if (page.done) {
			const end = page.events.at(-1);
			if (end?.t !== "end") fail("a done page ends with end", page.events);
			return { events, cursor, status: end.status };
		}
	}
	return fail("the turn never ended", events);
}

/** Follows a turn until the client's text is `text`. */
async function untilText(session: SessionHost, requestId: string, text: string): Promise<TurnPage> {
	for (let i = 0; i < 400; i++) {
		const page = is<TurnPage>(await session.follow(ALICE, requestId, {}, ctx), "turn", "follow");
		if (applyEvents("", page.events) === text) return page;
	}
	return fail(`${requestId} never showed`, text);
}

/** Settings that keep the suite fast: pi-durable retries a cut-off model request after 10 ms, not 2 s. */
const SETTINGS: HarnessSettings = { retry: { baseDelayMs: 10 }, progress: { partialIntervalMs: 10, persistWithinMs: 5_000 } };

/** What a tool call saw of its turn: the credential `turnCredential` gave it, in which conversation. */
type Seen = { conversation: number; requestId: string | undefined; attempt: number | undefined; principal: string | undefined; credential: string | undefined };

/** The host contract (spec 5.2). Every adapter passes it with no change to the core (G-HOST-PARITY). */
export function hostContract(runner: Runner, name: string, adapter: Adapter): void {
	type World = {
		model: ScriptedModel;
		clock: { at: number };
		ports: HostPorts;
		host: Host;
		options: HostOptions;
		session: SessionHost;
		/** Each turn the credential port was called for. */
		portCalls: Turn[];
		/** Each `whoami` tool call. */
		seen: Seen[];
		/** Each subagent the `delegate` tool started: its conversation and submission. */
		subagents: { conversation: number; submission: number }[];
		/** Each alarm the host set, in order: the session and the time, undefined for a cleared alarm. */
		alarms: { id: HarnessId; at: number | undefined }[];
		/** A new host over the same ports, as after a crash: the old host is abandoned, not closed. */
		another(): Host;
		/** Opens the session in a new host over the same ports, as after a crash: the old host is abandoned, not closed. */
		reopen(): Promise<SessionHost>;
		dispose(): Promise<void>;
		entries(c: Context, conversation?: number): Promise<EntryRecord[]>;
		submissions(c: Context): Promise<SubmissionRecord[]>;
		/** Each conversation's context scope, by conversation id. */
		scopes(c: Context): Promise<Record<number, Record<string, string>>>;
		/** Each tool task's id, in order. */
		toolTasks(c: Context): Promise<number[]>;
		/** Everything the store holds that a scan can reach, as JSON. */
		dump(c: Context): Promise<string>;
		/** The current value of the request record `key` in `conversation`, or undefined when there is none. */
		request(c: Context, key: string, conversation?: number): Promise<Record<string, unknown> | undefined>;
		/** The current value of the seen marker `key` in `conversation`, or undefined when there is none. */
		marker(c: Context, key: string, conversation?: number): Promise<Record<string, unknown> | undefined>;
		/**
		 * Each store the host opened, in order: its fence, the prune passes it started (each scans every conversation, which
		 * nothing else does), and its refused commits. While `hold` is set, a pass waits for it before its first read. The
		 * next commit after `holdCommit` is set reaches the store only once it resolves; `heldCommits` counts those.
		 */
		opened: { epoch: number; passes: number; refused: number; heldCommits: number; hold?: Promise<void>; holdCommit?: Promise<void> }[];
	};
	async function world(extra: Partial<HostOptions> = {}): Promise<World> {
		const model = scriptedModel({ credential: GATEWAY_CREDENTIAL });
		const built = await adapter();
		// The host's clock: real time until a case sets `at`.
		const clock = { at: 0 };
		const now = () => (clock.at === 0 ? Date.now() : clock.at);
		const portCalls: Turn[] = [];
		const seen: Seen[] = [];
		const subagents: { conversation: number; submission: number }[] = [];
		const credential: CredentialPort = async (scope, turn) => {
			if (JSON.stringify(scope) !== JSON.stringify(SCOPE)) throw new Error("the credential port was asked for another scope");
			portCalls.push({ requestId: turn.requestId, attempt: turn.attempt, principal: turn.principal });
			return minted(turn);
		};
		const tools = triggerTools(model, seen, subagents);
		const registry = createRegistry();
		registry.install(defineExtension({ name: "contract", tools: tools.tools, tasks: [tools.reminder] }));
		// The alarm, recorded on its way to the adapter's port; an adapter without one gets a port that only records.
		const alarms: { id: HarnessId; at: number | undefined }[] = [];
		const alarm = built.ports.alarm ?? { set: async () => {} };
		const opened: World["opened"] = [];
		const ports: HostPorts = {
			...built.ports,
			// The store, counted on its way to the host: only a prune pass scans every conversation.
			storage: {
				...built.ports.storage,
				async open(id, fence, c) {
					const s = await built.ports.storage.open(id, fence, c);
					const seen: World["opened"][number] = { epoch: fence.epoch, passes: 0, refused: 0, heldCommits: 0 };
					opened.push(seen);
					const storage = new Proxy(s.storage, {
						get(target, key) {
							const value = Reflect.get(target, key, target) as unknown;
							if (typeof value !== "function") return value;
							const f = (value as (...a: unknown[]) => unknown).bind(target);
							// The Harness scans conversations only by owner; a pass scans them all.
							if (key === "scanConversations")
								return (...a: unknown[]) => {
									if (Object.keys(a[0] as object).length > 0) return f(...a);
									seen.passes++;
									return seen.hold === undefined ? f(...a) : seen.hold.then(() => f(...a));
								};
							if (key === "commit")
								return (...a: unknown[]) => {
									const held = seen.holdCommit;
									delete seen.holdCommit;
									if (held !== undefined) seen.heldCommits++;
									return (held ?? Promise.resolve()).then(() => f(...a) as Promise<unknown>).catch((error: unknown) => {
										seen.refused++;
										throw error;
									});
								};
							return f;
						},
					});
					return { ...s, storage };
				},
			},
			alarm: {
				async set(id, scope, at, c) {
					alarms.push({ id, at });
					await alarm.set(id, scope, at, c);
				},
			},
		};
		const options: HostOptions = {
			ports,
			gateway: model.gateway,
			credential,
			registry,
			settings: SETTINGS,
			now,
			...extra,
			agent: { model: model.agentModel, thinkingLevel: "off", tools: tools.tools, ...extra.agent },
		};
		const host = createHost(options);
		const hosts = [host];
		const session = await host.session(SCOPE, ctx);
		const storage = async (c: Context) => (await built.ports.storage.open(session.id, { epoch: -1 }, c)).storage;
		const drain = async <T>(scan: (cursor: never) => Promise<{ items: readonly T[]; next?: unknown }>): Promise<T[]> => {
			const items: T[] = [];
			let cursor: unknown;
			do {
				const page = await scan(cursor as never);
				items.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			return items;
		};
		const member = async (c: Context, kind: string, key: string, conversation: number) => {
			const s = await storage(c);
			const docs = await drain((cursor) => s.scanDocuments({ scope: { kind: "conversation", conversationId: conversation as ConversationId }, at: "current", kind }, 500, cursor, c));
			const doc = docs.find((d) => d.key === key);
			return doc === undefined ? undefined : ((await s.document(doc.id, "current", c))?.value as Record<string, unknown> | undefined);
		};
		const w: World = {
			model,
			clock,
			ports,
			host,
			options,
			session,
			portCalls,
			seen,
			subagents,
			alarms,
			another() {
				const next = createHost(options);
				hosts.push(next);
				return next;
			},
			async reopen() {
				return w.another().session(SCOPE, ctx);
			},
			async dispose() {
				for (const h of hosts) await h.close(ctx).catch(() => {});
				await built.dispose();
			},
			async entries(c, conversation = 1) {
				const s = await storage(c);
				return drain((cursor) => s.scanEntries({ conversationId: conversation as ConversationId, order: "ascending" }, 500, cursor, c));
			},
			async submissions(c) {
				const s = await storage(c);
				return drain((cursor) => s.scanSubmissions({}, 500, cursor, c));
			},
			async scopes(c) {
				const s = await storage(c);
				const out: Record<number, Record<string, string>> = {};
				for (const v of await drain((cursor) => s.scanConversations({}, 500, cursor, c))) {
					const docs = await drain((cursor) => s.scanDocuments({ scope: { kind: "conversation", conversationId: v.id }, at: "current" } as never, 500, cursor, c));
					const record = docs.find((doc) => doc.kind === "kleya.context");
					const stored = record === undefined ? undefined : await s.document(record.id, "current", c);
					out[v.id] = (stored?.value as { scope?: Record<string, string> } | undefined)?.scope ?? {};
				}
				return out;
			},
			async toolTasks(c) {
				const s = await storage(c);
				const tasks = await drain((cursor) => s.scanTasks({}, 500, cursor, c));
				return tasks.filter((t) => t.kind === "pi.tool").map((t) => t.id);
			},
			async dump(c) {
				const s = await storage(c);
				const conversations = await drain((cursor) => s.scanConversations({}, 500, cursor, c));
				const tasks = await drain((cursor) => s.scanTasks({}, 500, cursor, c));
				const out: unknown[] = [conversations, tasks, await drain((cursor) => s.scanSubmissions({}, 500, cursor, c))];
				for (const v of conversations) out.push(await drain((cursor) => s.scanEntries({ conversationId: v.id }, 500, cursor, c)));
				const scopes = [{ kind: "session" }, ...conversations.map((v) => ({ kind: "conversation", conversationId: v.id })), ...tasks.map((t) => ({ kind: "task", taskId: t.id }))];
				for (const scope of scopes) {
					for (const doc of await drain((cursor) => s.scanDocuments({ scope: scope as never, at: "current" }, 500, cursor, c))) out.push(doc, await s.document(doc.id, "current", c));
				}
				return JSON.stringify(out);
			},
			request: (c, key, conversation = 1) => member(c, "kleya.request", key, conversation),
			marker: (c, key, conversation = 1) => member(c, "kleya.seen", key, conversation),
			opened,
		};
		return w;
	}
	const run = (title: string, body: (w: World) => Promise<void>, timeoutMs = 30_000, extra?: Partial<HostOptions>) =>
		runner.test(
			title,
			async () => {
				const w = await world(extra);
				try {
					await body(w);
				} finally {
					await w.dispose();
				}
			},
			timeoutMs,
		);

	/** The turn's text as the store holds it: every answer text after its input, up to the next input. */
	async function storedAnswer(w: World, requestId: string, conversation = 1): Promise<string> {
		const n = requestId.match(/^host:submission:(\d+)$/)?.[1];
		const named = (s: SubmissionRecord) => (n !== undefined ? s.id === Number(n) : s.requestId === requestId || s.requestId?.match(/^kleya:\d+:\d+:(.*)$/s)?.[1] === requestId);
		const sub = (await w.submissions(ctx)).filter((s) => s.conversationId === conversation && named(s)).at(-1);
		const at = sub !== undefined && "entry" in sub ? sub.entry : undefined;
		if (at === undefined) return fail(`no stored input for ${requestId}`, sub);
		const list = await w.entries(ctx, conversation);
		const texts: string[] = [];
		for (const e of list.slice(list.findIndex((x) => x.id === at) + 1)) {
			if (e.kind === "kleya.input" || e.kind === "pi.user") break;
			const m = e.model?.find((x) => x.role === "assistant") as { stopReason?: string; content?: { type: string; text?: string }[] } | undefined;
			if (m === undefined || m.stopReason === "aborted" || m.stopReason === "error") continue;
			const text = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
			if (text !== "") texts.push(text);
		}
		return texts.join("\n\n");
	}

	/** No credential in the store, in a model request's messages or headers, or in anything the turn API answered. */
	async function noSecret(w: World, answers: unknown[]) {
		const stored = await w.dump(ctx);
		const at = stored.indexOf(SECRET);
		if (at >= 0) fail("a credential in the store", stored.slice(Math.max(0, at - 300), at + 100));
		for (const call of w.model.calls) {
			const sent = JSON.stringify([call.context, call.headers]);
			if (sent.includes(SECRET)) fail("a credential in a model request", sent.slice(Math.max(0, sent.indexOf(SECRET) - 300), sent.indexOf(SECRET) + 100));
		}
		const shown = JSON.stringify(answers);
		if (shown.includes(SECRET)) fail("a credential in a turn API answer", shown);
	}

	/**
	 * A turn, however it started: session follow from `from` lists its start and end once each, a follower gets its stored
	 * text with no gap or repeat, and its tool call got the credential the port minted for it.
	 */
	async function traced(w: World, session: SessionHost, from: string, requestId: string, conversation: number, principal: string | undefined, answers: unknown[]) {
		const events: SessionEvent[] = [];
		let cursor = from;
		for (let i = 0; i < 100 && !events.some((e) => e.requestId === requestId && e.phase === "end"); i++) {
			const page = is<SessionPage>(await session.followSession(ALICE, { after: cursor, waitMs: 500 }, ctx), "session", "session follow");
			answers.push(page);
			events.push(...page.events);
			cursor = page.cursor;
		}
		equal(events.filter((e) => e.requestId === requestId).map((e) => [e.phase, e.conversation]), [["start", conversation], ["end", conversation]], `session events of ${requestId}`);
		const end = await followToEnd(session, requestId, undefined, conversation);
		answers.push(end, await session.status(ALICE, requestId, ctx, conversation));
		equal(end.status.state, "done", `${requestId}'s state`);
		equal(applyEvents("", end.events), await storedAnswer(w, requestId, conversation), `${requestId}'s text against the store`);
		const turn: Turn = { requestId, attempt: 1, principal };
		equal(w.portCalls.filter((t) => t.requestId === requestId), [turn], `port calls for ${requestId}`);
		equal(
			w.seen.filter((s) => s.requestId === requestId).map((s) => [s.conversation, s.principal, s.credential]),
			[[conversation, principal, minted(turn)]],
			`what ${requestId}'s tool call saw`,
		);
	}

	/** The texts of the tool results the model saw in its last request, in order. */
	const toolTexts = (w: World): string[] =>
		(w.model.calls.at(-1)?.context.messages ?? []).filter((m) => m.role === "toolResult").map((m) => (m.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join(""));

	/** A case whose turns call the reference product's tools, and `more` hand-written tools beside them. */
	const withProduct = (title: string, body: (w: World, product: ReferenceProduct) => Promise<void>, options: { context?: boolean; credential?: boolean; more?: (product: ReferenceProduct) => ToolRegistration[] } = {}) => {
		const product = referenceProduct();
		const notes = productTools({ name: "notes", origin: PRODUCT_ORIGIN, tools: NOTE_TOOLS, fetch: product.fetch, timeoutMs: PRODUCT_TIMEOUT_MS });
		const more = options.more?.(product) ?? [];
		const registry = createRegistry();
		registry.install(notes);
		if (more.length > 0) registry.install(defineExtension({ name: "contract-more", tools: more }));
		const extra: Partial<HostOptions> = {
			registry,
			credential:
				options.credential === false
					? async () => {
							throw new Error("no credential for this turn");
						}
					: product.port,
			...(options.context === false ? {} : { context: (scope: Scope) => ({ tenant: scope.keys[0]! }) }),
			agent: { tools: [...(notes.tools ?? []), ...more] },
		};
		run(title, (w) => body(w, product), 30_000, extra);
	};

	/** The head of session follow now: where a case starts listening. */
	const head = async (session: SessionHost) => is<SessionPage>(await session.followSession(ALICE, { waitMs: 0 }, ctx), "session", "head").cursor;

	runner.describe(`host contract: ${name}`, () => {
		run("a duplicate request id runs the model once", async (w) => {
			w.model.script({ chunks: ["one answer"] });
			const a = is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "first submit");
			await followToEnd(w.session, "r1");
			const b = is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "duplicate submit");
			await followToEnd(w.session, "r1");
			equal(w.model.calls.length, 1, "model calls");
			equal(b, a, "the duplicate's result");
		});

		run("the same id with another payload is refused as a conflict and runs nothing", async (w) => {
			w.model.script({ chunks: ["first"] });
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "first submit");
			await followToEnd(w.session, "r1");
			equal(await w.session.submit(ALICE, "r1", "something else", {}, ctx), { t: "rejected", requestId: "r1", reason: "conflict" }, "second submit");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("three concurrent submits of one id make one turn", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["held"], hold: new Promise<void>((r) => (release = r)) });
			const results = await Promise.all([1, 2, 3].map(() => w.session.submit(ALICE, "r1", "hello", {}, ctx)));
			release();
			await followToEnd(w.session, "r1");
			for (const r of results) is(r, "accepted", "each submit");
			equal(new Set(results.map((r) => JSON.stringify(r))).size, 1, "distinct results");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("a failed turn is retried under its id at most maxAttempts times", async (w) => {
			const max = 4;
			for (let i = 0; i < max + 3; i++) w.model.script({ error: "invalid request" });
			for (let i = 0; i < max + 3; i++) {
				is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", `submit ${i + 1}`);
				await followToEnd(w.session, "r1");
			}
			equal(w.model.calls.length, max, "model calls");
			const status = is<TurnStatus>(await w.session.status(ALICE, "r1", ctx), "status", "status");
			equal([status.state, status.attempt], ["failed", max], "final status");
		});

		run("a follower resumed from its cursor gets no text twice", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["Hello", " there"], hold: new Promise<void>((r) => (release = r)) });
			is(await w.session.submit(ALICE, "r1", "hi", {}, ctx), "accepted", "submit");
			let first: TurnPage;
			do first = is<TurnPage>(await w.session.follow(ALICE, "r1", {}, ctx), "turn", "follow");
			while (applyEvents("", first.events) !== "Hello there");
			release();
			const rest = await followToEnd(w.session, "r1", first.cursor);
			equal(rest.events.filter((e) => e.t !== "end"), [], "events after the cursor");
			equal(applyEvents(applyEvents("", first.events), rest.events), "Hello there", "client text");
		});

		run("after a crash mid-stream a resumed follower rewinds and ends with the stored text", async (w) => {
			w.model.script({ chunks: ["lost", " words"], hold: new Promise<void>(() => {}) }, { chunks: ["the answer"] });
			is(await w.session.submit(ALICE, "r1", "hi", {}, ctx), "accepted", "submit");
			let seen: TurnPage;
			do seen = is<TurnPage>(await w.session.follow(ALICE, "r1", {}, ctx), "turn", "follow");
			while (applyEvents("", seen.events) !== "lost words");
			// A second host over the same ports takes the session over; the first is abandoned, as if its process died.
			const next = createHost(w.options);
			try {
				const session = await next.session(SCOPE, ctx);
				const rest = await followToEnd(session, "r1", seen.cursor);
				const client = applyEvents(applyEvents("", seen.events), rest.events);
				equal(client, await storedAnswer(w, "r1"), "client text against the store");
				equal(client, "the answer", "client text");
			} finally {
				await next.close(ctx);
			}
		});

		// A crash while a tool call is in flight: its effect class decides what the resumed session does (spec 5.4).
		const crashMidTool = (effect: EffectClass, expected: { sends: number; reconciled: number; interrupted: boolean }) => {
			const sends: string[] = [];
			let reconciled = 0;
			const tool: EffectTool = {
				name: "effect_tool",
				description: "A write the test counts.",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				async execute(_args, call, context) {
					sends.push(call.key);
					// The first send never returns: the process dies with the call in flight.
					if (sends.length === 1) {
						await new Promise((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(new Error("cut off")), { once: true }));
					}
					return { output: [{ type: "text", text: "sent" }] };
				},
				...(effect === "reconcilable"
					? {
							effect,
							async reconcile() {
								reconciled++;
								return sends.length > 0 ? { output: [{ type: "text", text: "already sent" }] } : undefined;
							},
						}
					: { effect }),
			} as EffectTool;
			const registration = effectTool(tool);
			const registry = createRegistry();
			registry.install(defineExtension({ name: "effect-test", tools: [registration] }));
			run(
				`a crash mid-tool: a ${effect} call ${expected.interrupted ? "is reported interrupted and never sent again" : expected.reconciled > 0 ? "reconciles before it runs again" : "runs again under the same key"}`,
				async (w) => {
					w.model.script({ toolCalls: [{ name: "effect_tool", arguments: {} }] }, { chunks: ["after the tool"] });
					is(await w.session.submit(ALICE, "r1", "use the tool", {}, ctx), "accepted", "submit");
					for (let i = 0; i < 400 && sends.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
					equal(sends.length, 1, "first send");
					const next = createHost(w.options);
					try {
						const session = await next.session(SCOPE, ctx);
						const end = await followToEnd(session, "r1");
						equal(end.status.state, "done", "turn state");
						equal([sends.length, reconciled], [expected.sends, expected.reconciled], "sends and reconciles");
						equal(new Set(sends).size, 1, "every send used one key");
						const result = w.model.calls.at(-1)?.context.messages.at(-1) as { role: string; isError?: boolean; content: { text?: string }[] } | undefined;
						equal([result?.role, result?.isError === true], ["toolResult", expected.interrupted], "the result the model saw");
					} finally {
						await next.close(ctx);
					}
				},
				30_000,
				{ registry, agent: { tools: [registration] } },
			);
		};
		crashMidTool("once-only", { sends: 1, reconciled: 0, interrupted: true });
		crashMidTool("read-only", { sends: 2, reconciled: 0, interrupted: false });
		crashMidTool("idempotent-by-key", { sends: 2, reconciled: 0, interrupted: false });
		crashMidTool("reconcilable", { sends: 1, reconciled: 1, interrupted: false });

		run("abort is a stored command: the turn ends cancelled, and an ended turn refuses it", async (w) => {
			w.model.script({ chunks: ["working"], hold: new Promise<void>(() => {}) }, { chunks: ["second"] });
			is(await w.session.submit(ALICE, "r1", "long job", {}, ctx), "accepted", "submit r1");
			is(await w.session.submit(ALICE, "r2", "next", {}, ctx), "accepted", "submit r2");
			let page: TurnPage;
			do page = is<TurnPage>(await w.session.follow(ALICE, "r1", {}, ctx), "turn", "follow");
			while (applyEvents("", page.events) !== "working");
			const status = is<TurnStatus>(await w.session.abort(ALICE, "r1", "a1", ctx), "status", "abort");
			equal([status.state, status.outcome], ["done", "cancelled"], "aborted status");
			equal(await w.session.abort(ALICE, "r1", "a1", ctx), status, "the same abort again");
			equal(await w.session.abort(ALICE, "r1", "a2", ctx), { t: "rejected", requestId: "a2", reason: "run_ended" }, "a new abort of an ended turn");
			const kinds = (await w.entries(ctx)).map((e) => e.kind);
			equal(kinds.includes("kleya.cancel") && kinds.indexOf("kleya.stopped") > kinds.indexOf("kleya.cancel"), true, "cancel then stopped entries");
			const r2 = is<TurnStatus>(await w.session.status(ALICE, "r2", ctx), "status", "r2 status");
			equal([r2.state, r2.started], ["running", false], "the queued turn did not start");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("whenBusy reject refuses an input while a turn runs", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["busy"], hold: new Promise<void>((r) => (release = r)) });
			is(await w.session.submit(ALICE, "r1", "one", {}, ctx), "accepted", "submit r1");
			let page: TurnPage;
			do page = is<TurnPage>(await w.session.follow(ALICE, "r1", {}, ctx), "turn", "follow");
			while (applyEvents("", page.events) !== "busy");
			equal(await w.session.submit(ALICE, "r2", "two", { whenBusy: "reject" }, ctx), { t: "rejected", requestId: "r2", reason: "busy" }, "submit r2");
			release();
			await followToEnd(w.session, "r1");
			equal(await w.session.status(ALICE, "r2", ctx), { t: "error", code: "not_found", retry: "never" }, "r2 left no record");
		});

		run("session follow lists each turn's start and end from the accepted position", async (w) => {
			const accepted = is<Accepted>(await w.session.submit(ALICE, "r1", "one", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			const events: SessionEvent[] = [];
			let cursor = accepted.position;
			for (let i = 0; i < 20; i++) {
				const page = is<{ t: "session"; cursor: string; events: SessionEvent[] }>(await w.session.followSession(ALICE, { after: cursor, waitMs: 0 }, ctx), "session", "follow");
				events.push(...page.events);
				if (page.cursor === cursor) break;
				cursor = page.cursor;
			}
			equal(events.map((e) => [e.phase, e.requestId, e.conversation]), [["start", "r1", 1], ["end", "r1", 1]], "session events");
		});

		run("unknown and reserved request ids", async (w) => {
			equal(await w.session.status(ALICE, "nope", ctx), { t: "error", code: "not_found", retry: "never" }, "unknown status");
			equal(await w.session.follow(ALICE, "nope", { waitMs: 0 }, ctx), { t: "error", code: "not_found", retry: "never" }, "unknown follow");
			equal(await w.session.submit(ALICE, "host:task:1", "x", {}, ctx), { t: "rejected", requestId: "host:task:1", reason: "forbidden" }, "reserved id");
			equal(w.model.calls.length, 0, "model calls");
		});

		run("a stale cursor from a dropped and recreated session expires", async (w) => {
			is(await w.session.submit(ALICE, "r1", "one", {}, ctx), "accepted", "submit");
			const { cursor } = await followToEnd(w.session, "r1");
			const page = is<{ t: "session"; cursor: string }>(await w.session.followSession(ALICE, { waitMs: 0 }, ctx), "session", "head");
			await w.host.drop(SCOPE, ctx);
			const fresh = await w.host.session(SCOPE, ctx);
			// The new store commits past the old cursor's sequence number, so only the store's identity can tell them apart.
			for (const id of ["n1", "n2"]) {
				is(await fresh.submit(ALICE, id, "again", {}, ctx), "accepted", `submit ${id}`);
				await followToEnd(fresh, id);
			}
			equal((await fresh.followSession(ALICE, { after: page.cursor, waitMs: 0 }, ctx)).t, "error", "old session cursor");
			equal(await fresh.status(ALICE, "r1", ctx), { t: "error", code: "not_found", retry: "never" }, "old request id");
			// The new store answers the same request id with other text; the old turn cursor must not resume against it.
			w.model.script({ chunks: ["beta"] });
			is(await fresh.submit(ALICE, "r1", "one", {}, ctx), "accepted", "r1 in the new store");
			await followToEnd(fresh, "r1");
			equal(await fresh.follow(ALICE, "r1", { after: cursor, waitMs: 0 }, ctx), { t: "error", code: "cursor_expired", retry: "reattach" }, "old turn cursor");
		});

		run("a cursor for another request, conversation or session is refused", async (w) => {
			is(await w.session.submit(ALICE, "r1", "one", {}, ctx), "accepted", "r1");
			const { cursor } = await followToEnd(w.session, "r1");
			is(await w.session.submit(ALICE, "r2", "two", {}, ctx), "accepted", "r2");
			await followToEnd(w.session, "r2");
			const head = is<{ t: "session"; cursor: string }>(await w.session.followSession(ALICE, { waitMs: 0 }, ctx), "session", "head").cursor;
			const other = await w.host.session({ product: SCOPE.product, keys: ["tenant-b", "thread-1"] }, ctx);
			is(await other.submit(ALICE, "r1", "one", {}, ctx), "accepted", "r1 in another session");
			await followToEnd(other, "r1");
			const invalid: FeedError = { t: "error", code: "invalid_cursor", retry: "reattach" };
			equal(await w.session.follow(ALICE, "r2", { after: cursor, waitMs: 0 }, ctx), invalid, "r1's cursor for r2");
			equal(await other.follow(ALICE, "r1", { after: cursor, waitMs: 0 }, ctx), invalid, "a turn cursor from another session");
			equal(await other.followSession(ALICE, { after: head, waitMs: 0 }, ctx), invalid, "a session cursor from another session");
			equal(await w.session.follow(ALICE, "r1", { after: "kt1.garbage", waitMs: 0 }, ctx), invalid, "a malformed turn cursor");
			equal(await w.session.followSession(ALICE, { after: "ks1.garbage", waitMs: 0 }, ctx), invalid, "a malformed session cursor");
		});

		run("request ids and texts over their limits are refused before anything runs", async (w) => {
			const long = "r".repeat(LIMITS.requestIdChars + 1);
			equal(await w.session.submit(ALICE, long, "x", {}, ctx), { t: "rejected", requestId: long, reason: "forbidden" }, "long request id");
			// Two UTF-8 bytes per character: within the limit in characters, over it in bytes.
			const text = "\u00e9".repeat(LIMITS.textBytes / 2 + 1);
			equal(await w.session.submit(ALICE, "r1", text, {}, ctx), { t: "rejected", requestId: "r1", reason: "too_large" }, "long text");
			equal(await w.session.status(ALICE, "r1", ctx), { t: "error", code: "not_found", retry: "never" }, "no record for the refused text");
			is(await w.session.submit(ALICE, "r".repeat(LIMITS.requestIdChars), "x", {}, ctx), "accepted", "an id at the limit");
			await followToEnd(w.session, "r".repeat(LIMITS.requestIdChars));
			equal(w.model.calls.length, 1, "model calls");
		});

		run("a follow call returns within the wait bound whatever waitMs asks", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["busy"], hold: new Promise<void>((r) => (release = r)) });
			is(await w.session.submit(ALICE, "r1", "one", {}, ctx), "accepted", "submit r1");
			await untilText(w.session, "r1", "busy");
			// Queued behind r1, so following it finds nothing to send.
			is(await w.session.submit(ALICE, "r2", "two", {}, ctx), "accepted", "submit r2");
			const late = () => new Promise<"late">((r) => setTimeout(() => r("late"), LIMITS.followWaitMs + 1_000));
			for (const waitMs of [Number.NaN, 60_000, Number.POSITIVE_INFINITY]) {
				const started = Date.now();
				const page = await Promise.race([w.session.followSession(ALICE, { after: await head(w.session), waitMs }, ctx), late()]);
				if (page === "late") fail(`followSession with waitMs ${waitMs} still waiting after`, Date.now() - started);
				equal(is<SessionPage>(page, "session", "page").events, [], "session events while nothing changes");
				const turn = await Promise.race([w.session.follow(ALICE, "r2", { waitMs }, ctx), late()]);
				if (turn === "late") fail(`follow with waitMs ${waitMs} still waiting after`, Date.now() - started);
				equal(is<TurnPage>(turn, "turn", "turn page").events, [], "events of a queued turn");
			}
			release();
		}, 40_000);

		run("a turn page holds at most pageChars characters and never splits a character", async (w) => {
			// The page limit falls between the two halves of the emoji's surrogate pair.
			const answer = "a".repeat(LIMITS.pageChars - 1) + "\u{1F600}" + "b".repeat(10);
			w.model.script({ chunks: [answer] });
			is(await w.session.submit(ALICE, "r1", "long", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			let text = "";
			let cursor: string | undefined;
			let pages = 0;
			for (;;) {
				const page = is<TurnPage>(await w.session.follow(ALICE, "r1", { ...(cursor === undefined ? {} : { after: cursor }), waitMs: 0 }, ctx), "turn", "follow");
				pages++;
				for (const e of page.events) {
					if (e.t !== "text") continue;
					if (e.text.length > LIMITS.pageChars) fail("page size", e.text.length);
					if (/[\ud800-\udbff]$/.test(e.text)) fail("a page ends inside a surrogate pair at", text.length + e.text.length);
				}
				text = applyEvents(text, page.events);
				cursor = page.cursor;
				if (page.done) break;
			}
			equal(pages >= 2, true, "more than one page");
			equal(text === answer, true, "client text equals the answer");
		});

		run("a request id older than its retention is refused too_old", async (w) => {
			w.clock.at = 1_000_000;
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "first submit");
			await followToEnd(w.session, "r1");
			w.clock.at += LIMITS.requestRetentionMs + 1;
			equal(await w.session.submit(ALICE, "r1", "hello", {}, ctx), { t: "rejected", requestId: "r1", reason: "too_old" }, "submit after retention");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("a conversation id that is not a positive integer names nothing", async (w) => {
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			const none: FeedError = { t: "error", code: "not_found", retry: "never" };
			for (const conversation of [1.5, -1, 0, Number.NaN]) {
				equal(await w.session.status(ALICE, "r1", ctx, conversation), none, `status in ${conversation}`);
				equal(await w.session.abort(ALICE, "r1", "a1", ctx, conversation), none, `abort in ${conversation}`);
				equal(await w.session.follow(ALICE, "r1", { conversation, waitMs: 0 }, ctx), none, `follow in ${conversation}`);
				equal(await w.session.submit(ALICE, "r2", "x", { conversation }, ctx), none, `submit in ${conversation}`);
			}
		});

		// --- Retention (spec 5.2 "Retention", 11.6 step 4) ---

		const DAY = 24 * 60 * 60 * 1000;
		const WINDOW = LIMITS.requestRetentionMs;
		const MARKER = RETENTION.markerDefaultMs;
		/** Waits up to four seconds for `check`: an open session prunes in the background. */
		const settles = async (what: string, check: () => Promise<boolean>, actual: () => Promise<unknown>) => {
			for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
			if (!(await check())) fail(what, await actual());
		};
		/** A finished request "r1" at the case's clock, which starts now; returns its whole record. */
		const finished = async (w: World, text = "hello") => {
			w.clock.at = Date.now();
			is(await w.session.submit(ALICE, "r1", text, {}, ctx), "accepted", "submit r1");
			await followToEnd(w.session, "r1");
			const full = await w.request(ctx, "r1");
			if (full === undefined || (full.attempts as number[]).length !== 1 || full.principal !== "alice") fail("r1's whole record", full);
			return { t0: w.clock.at, full };
		};

		run("after its request window a record shrinks to a seen marker", async (w) => {
			w.model.script({ chunks: ["one"] }, { chunks: ["two"] });
			const { t0, full } = await finished(w);
			if (!(await w.dump(ctx)).includes('"principal":"alice"')) fail("the whole record names its principal in the store", full);
			w.clock.at = t0 + WINDOW + 1;
			const session = await w.reopen();
			equal(await w.request(ctx, "r1"), undefined, "r1's whole record");
			equal(await w.marker(ctx, "r1"), { digest: full.digest, at: full.at, outcome: "completed", due: (full.at as number) + WINDOW + MARKER }, "r1's marker: digest and outcome");
			const stored = await w.dump(ctx);
			for (const left of ['"principal":"alice"', '"attempts":']) if (stored.includes(left)) fail("a shrunk record's principal or attempts in the store", left);
			equal(await session.submit(ALICE, "r1", "hello", {}, ctx), { t: "rejected", requestId: "r1", reason: "too_old" }, "the same payload again");
			equal(await session.submit(ALICE, "r1", "other", {}, ctx), { t: "rejected", requestId: "r1", reason: "conflict" }, "another payload");
			equal(await session.status(ALICE, "r1", ctx), NOT_FOUND, "status of a marked id");
			is(await session.submit(ALICE, "r9", "new", {}, ctx), "accepted", "a never-seen id at the same moment");
			await followToEnd(session, "r9");
			equal(w.model.calls.length, 2, "model calls");
		});

		run("a retry of a marked id runs no second turn", async (w) => {
			// A failed turn: inside its window a resend would run a second attempt.
			w.model.script({ error: "invalid request" }, { chunks: ["second"] });
			const { t0 } = await finished(w);
			// Another payload under r1, inside its window: refused, and the Harness now holds r1's marker in memory.
			equal(await w.session.submit(ALICE, "r1", "other", {}, ctx), { t: "rejected", requestId: "r1", reason: "conflict" }, "another payload inside the window");
			// The pass's shrink is held on its way to the store: the Harness shows r1 whole and unmarked until it is stored.
			const store = w.opened.at(-1)!;
			let open!: () => void;
			store.holdCommit = new Promise<void>((r) => (open = r));
			w.clock.at = t0 + WINDOW + 1;
			await w.session.status(ALICE, "r1", ctx);
			await settles("the pass's shrink reaches the store", async () => store.heldCommits > 0, async () => store);
			// A retry while the shrink is held: a read before its commit finds r1 unmarked, and its commit runs after the shrink.
			const racing = w.session.submit(ALICE, "r1", "hello", {}, ctx);
			await new Promise((r) => setTimeout(r, 100));
			open();
			const answers: unknown[] = [await racing];
			await settles("r1's marker", async () => (await w.marker(ctx, "r1"))?.outcome === "failed", () => w.marker(ctx, "r1"));
			answers.push(await w.session.submit(ALICE, "r1", "hello", {}, ctx));
			answers.push(await (await w.reopen()).submit(ALICE, "r1", "hello", {}, ctx));
			for (const answer of answers) equal(answer, { t: "rejected", requestId: "r1", reason: "too_old" }, "a retry of r1 past its window");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("an abort under a marked abort id cancels nothing", async (w) => {
			w.model.script({ chunks: ["first"], hold: new Promise<void>(() => {}) });
			const t0 = (w.clock.at = Date.now());
			is(await w.session.submit(ALICE, "r1", "long job", {}, ctx), "accepted", "submit r1");
			await untilText(w.session, "r1", "first");
			w.clock.at = t0 + 2 * DAY;
			equal(((await w.session.abort(ALICE, "r1", "a1", ctx)) as TurnStatus).outcome, "cancelled", "the first abort");
			// r1's marker is gone and a1's is kept: r1 names a new turn, which the old abort id must not reach.
			w.clock.at = t0 + WINDOW + MARKER + DAY;
			const session = await w.reopen();
			equal([await w.request(ctx, "r1"), await w.marker(ctx, "r1"), (await w.marker(ctx, "a1"))?.outcome], [undefined, undefined, "abort"], "r1's record and marker, and a1's marker");
			let release!: () => void;
			w.model.script({ chunks: ["second"], hold: new Promise<void>((r) => (release = r)) });
			is(await session.submit(ALICE, "r1", "long job", {}, ctx), "accepted", "r1 again");
			await untilText(session, "r1", "second");
			equal(await session.abort(ALICE, "r1", "a1", ctx), { t: "rejected", requestId: "a1", reason: "too_old" }, "the old abort id again");
			release();
			equal((await followToEnd(session, "r1")).status.outcome, "completed", "the new turn's outcome");
			equal(w.model.calls.length, 2, "model calls");
		});

		run("pruning never touches a running turn's record", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["held"], hold: new Promise<void>((r) => (release = r)) });
			const t0 = (w.clock.at = Date.now());
			is(await w.session.submit(ALICE, "r1", "long job", {}, ctx), "accepted", "submit r1");
			await untilText(w.session, "r1", "held");
			// Later requests that settle while r1 runs: r2 waits behind r1, and a2 cancels it.
			is(await w.session.submit(ALICE, "r2", "next", { whenBusy: "followUp" }, ctx), "accepted", "submit r2 behind r1");
			equal(((await w.session.abort(ALICE, "r2", "a2", ctx)) as TurnStatus).outcome, "cancelled", "r2 cancelled while it waits");
			const full = await w.request(ctx, "r1");
			w.clock.at = t0 + WINDOW + 1;
			equal(((await w.session.status(ALICE, "r1", ctx)) as TurnStatus).state, "running", "r1's state");
			// r1 is past its window and comes first, but its turn runs: the pass goes on past it.
			const later = async () => [(await w.marker(ctx, "r2"))?.outcome, (await w.marker(ctx, "a2"))?.outcome];
			await settles("r2 and a2 shrink to markers", async () => JSON.stringify(await later()) === '["cancelled","abort"]', later);
			equal([await w.request(ctx, "r1"), (await w.marker(ctx, "r1"))?.outcome], [full, null], "the running turn's record and marker after a pass");
			// Past the later markers' end too: they go, while neither a shrink nor a delete may touch r1.
			w.clock.at = t0 + WINDOW + MARKER + DAY;
			equal(((await w.session.status(ALICE, "r1", ctx)) as TurnStatus).state, "running", "r1's state later");
			const gone = async () => [await w.marker(ctx, "r2"), await w.marker(ctx, "a2")];
			await settles("r2's and a2's markers go, though r1's comes first", async () => (await gone()).every((m) => m === undefined), gone);
			equal([await w.request(ctx, "r1"), (await w.marker(ctx, "r1"))?.outcome], [full, null], "the running turn's record and marker after the marker's end");
			release();
			equal((await followToEnd(w.session, "r1")).status.outcome, "completed", "r1's outcome");
		});

		run("pruning never touches a record inside its window", async (w) => {
			w.model.script({ chunks: ["one"] });
			const { t0, full } = await finished(w);
			w.clock.at = t0 + WINDOW;
			const session = await w.reopen();
			equal(await w.request(ctx, "r1"), full, "r1's record at the end of its window");
			equal(((await session.status(ALICE, "r1", ctx)) as TurnStatus).outcome, "completed", "r1's status");
			is(await session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "a duplicate inside the window");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("after its marker retention the id is accepted as new and runs a new turn", async (w) => {
			w.model.script({ chunks: ["first"] }, { chunks: ["second"] });
			const { t0, full } = await finished(w);
			w.clock.at = t0 + WINDOW + 1;
			await w.reopen();
			equal((await w.marker(ctx, "r1"))?.outcome, "completed", "r1's marker");
			w.clock.at = t0 + WINDOW + MARKER + 1;
			const session = await w.reopen();
			equal([await w.request(ctx, "r1"), await w.marker(ctx, "r1")], [undefined, undefined], "r1's record and marker");
			const stored = await w.dump(ctx);
			for (const left of [full.digest as string, '"principal":"alice"', '"attempts":', '"outcome":"completed"']) if (stored.includes(left)) fail("a deleted record's content in the store", left);
			is(await session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "r1 as new");
			const end = await followToEnd(session, "r1");
			equal([end.status.attempt, end.status.outcome, applyEvents("", end.events)], [1, "completed", "second"], "the new turn");
			equal(w.model.calls.length, 2, "model calls");
		});

		run(
			"a marker is kept until request + marker retention",
			async (w) => {
				w.model.script({ chunks: ["first"] }, { chunks: ["second"] });
				const { t0 } = await finished(w);
				w.clock.at = t0 + WINDOW + 2 * DAY;
				const kept = await w.reopen();
				equal(await kept.submit(ALICE, "r1", "hello", {}, ctx), { t: "rejected", requestId: "r1", reason: "too_old" }, "r1 at the marker's end");
				w.clock.at += 1;
				const session = await w.reopen();
				is(await session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "r1 after the marker's end");
			},
			30_000,
			{ markerRetentionMs: 2 * DAY },
		);

		run("a dormant session prunes on its next open", async (w) => {
			w.model.script({ chunks: ["one"] });
			const { t0 } = await finished(w);
			equal(await w.host.release(SCOPE, ctx), true, "the idle session closes");
			w.clock.at = t0 + WINDOW + 1;
			await w.host.session(SCOPE, ctx);
			equal((await w.marker(ctx, "r1"))?.outcome, "completed", "r1's marker after the open, before any call");
		});

		run("a session that stays open prunes as it takes calls, at most once an hour", async (w) => {
			w.model.script({ chunks: ["one"] });
			const { t0 } = await finished(w);
			const store = w.opened.at(-1)!;
			w.clock.at = t0 + WINDOW + 1;
			await w.session.status(ALICE, "r1", ctx);
			await settles("r1's marker", async () => (await w.marker(ctx, "r1"))?.outcome === "completed", () => w.marker(ctx, "r1"));
			const passes = store.passes;
			for (let i = 0; i < 5; i++) {
				await w.session.status(ALICE, "r1", ctx);
				await new Promise((r) => setTimeout(r, 20));
			}
			equal(store.passes, passes, "passes after calls within the hour");
			w.clock.at += RETENTION.everyMs;
			await w.session.status(ALICE, "r1", ctx);
			equal(store.passes, passes + 1, "passes after a call an hour later");
		});

		run("closing a session waits for its running pass", async (w) => {
			w.model.script({ chunks: ["one"] });
			const { t0 } = await finished(w);
			const store = w.opened.at(-1)!;
			let open!: () => void;
			store.hold = new Promise<void>((r) => (open = r));
			const passes = store.passes;
			w.clock.at = t0 + WINDOW + 1;
			await w.session.status(ALICE, "r1", ctx);
			equal(store.passes, passes + 1, "passes after the call");
			let closed = false;
			const closing = w.host.release(SCOPE, ctx).then((released) => ((closed = true), released));
			await new Promise((r) => setTimeout(r, 100));
			equal(closed, false, "the close while the pass is held");
			open();
			equal(await closing, true, "the close once the pass ends");
		});

		run("retention options outside their bounds are refused", async (w) => {
			for (const markerRetentionMs of [0, -1, RETENTION.markerMinMs - 1, RETENTION.markerMaxMs + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
				let refused: unknown;
				try {
					await createHost({ ...w.options, markerRetentionMs }).close(ctx);
				} catch (error) {
					refused = error;
				}
				if (!(refused instanceof RangeError)) fail(`markerRetentionMs ${markerRetentionMs} is a RangeError`, String(refused));
			}
			for (const markerRetentionMs of [RETENTION.markerMinMs, RETENTION.markerMaxMs]) await createHost({ ...w.options, markerRetentionMs }).close(ctx);
		});

		run("a superseded owner's prune lands nothing, and that owner starts no pass after", async (w) => {
			w.model.script({ chunks: ["one"] });
			const { t0, full } = await finished(w);
			const old = w.opened.at(-1)!;
			const before = old.passes;
			// The newer owner opens while r1 is young, so its own pass on open changes nothing.
			const next = await w.reopen();
			equal(await w.request(ctx, "r1"), full, "r1 after the takeover");
			w.clock.at = t0 + WINDOW + 1;
			await w.session.status(ALICE, "r1", ctx).catch(() => undefined);
			await settles("the store refuses the old owner's prune", async () => old.refused > 0, async () => old);
			equal(await w.request(ctx, "r1"), full, "r1 after the old owner's pass");
			w.clock.at += 2 * RETENTION.everyMs;
			await w.session.status(ALICE, "r1", ctx).catch(() => undefined);
			equal(old.passes - before, 1, "the old owner's passes: its refused one, and none after it");
			await next.status(ALICE, "r1", ctx);
			await settles("the newer owner's prune lands", async () => (await w.marker(ctx, "r1"))?.outcome === "completed", () => w.marker(ctx, "r1"));
			equal(await w.request(ctx, "r1"), undefined, "r1's whole record after the newer owner's pass");
		});

		// --- Callers and rights (spec 5.3.3) ---

		run("each operation checks its right, and a refused read answers the same for every request id", async (w) => {
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			for (const id of ["r1", "missing", "host:submission:1"]) {
				equal(await w.session.status(NOBODY, id, ctx), FORBIDDEN, `status of ${id} without read`);
				equal(await w.session.follow(NOBODY, id, { waitMs: 0 }, ctx), FORBIDDEN, `follow of ${id} without read`);
			}
			equal(await w.session.followSession(NOBODY, { waitMs: 0 }, ctx), FORBIDDEN, "session follow without read");
			equal(await w.session.submit(VIEWER, "r2", "x", {}, ctx), { t: "rejected", requestId: "r2", reason: "forbidden" }, "submit without submit");
			equal(await w.session.abort(VIEWER, "r1", "a1", ctx), { t: "rejected", requestId: "a1", reason: "forbidden" }, "abort without cancel");
			for (const id of ["r1", "missing"]) equal(await w.session.abort(caller("carl", "cancel"), id, "a2", ctx), { t: "rejected", requestId: "a2", reason: "forbidden" }, `abort of ${id} without read`);
			equal(await w.session.submit(caller("alice", "read", "submit"), "s1", "x", { whenBusy: "steer" }, ctx), { t: "rejected", requestId: "s1", reason: "forbidden" }, "steer without steer");
			equal(await w.session.submit(caller("host:schedule", "read", "submit"), "r3", "x", {}, ctx), { t: "rejected", requestId: "r3", reason: "forbidden" }, "a caller claiming a host principal");
			// A viewer reads the turn, and never whose it is.
			const shown = [await w.session.status(VIEWER, "r1", ctx), await w.session.follow(VIEWER, "r1", { waitMs: 0 }, ctx)];
			equal(shown.map((s) => s.t), ["status", "turn"], "what a viewer reads");
			equal(JSON.stringify(shown).includes("alice"), false, "a principal in what a viewer reads");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("the same request id from another principal is a conflict", async (w) => {
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "alice's submit");
			await followToEnd(w.session, "r1");
			equal(await w.session.submit(BOB, "r1", "hello", {}, ctx), { t: "rejected", requestId: "r1", reason: "conflict" }, "bob's submit of the same id and text");
			equal(w.model.calls.length, 1, "model calls");
		});

		run("the caller is its argument: a principal or rights in the submit options change nothing", async (w) => {
			const forged = { principal: "alice", rights: ["read", "submit", "steer", "cancel"], caller: ALICE } as unknown as SubmitOptions;
			equal(await w.session.submit(VIEWER, "v1", "x", forged, ctx), { t: "rejected", requestId: "v1", reason: "forbidden" }, "a viewer's submit with forged rights");
			is(await w.session.submit(BOB, "r1", "hello", forged, ctx), "accepted", "bob's submit naming alice");
			await followToEnd(w.session, "r1");
			equal(await w.session.submit(ALICE, "r1", "hello", {}, ctx), { t: "rejected", requestId: "r1", reason: "conflict" }, "alice's submit of bob's id");
		});

		// --- Turns no caller starts (step 1a) ---

		run("a client's turn is listed by session follow, followed to its end, and its tool gets the port's credential", async (w) => {
			const from = await head(w.session);
			w.model.script({ toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["answered"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "c1", "hello", {}, ctx), "accepted", "submit")];
			await traced(w, w.session, from, "c1", 1, "alice", answers);
			await noSecret(w, answers);
		});

		run("a redelivered event id makes one turn, with the port's credential for the event source", async (w) => {
			const from = await head(w.session);
			w.model.script({ toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["handled"] });
			const first = is(await w.session.submit(EVENTS, "evt-1", "payload", {}, ctx), "accepted", "delivery");
			const again = await w.session.submit(EVENTS, "evt-1", "payload", {}, ctx);
			equal(again, first, "the redelivery's result");
			const answers: unknown[] = [first, again];
			await traced(w, w.session, from, "evt-1", 1, "events", answers);
			equal(await w.session.submit(EVENTS, "evt-1", "payload", {}, ctx), first, "a redelivery after the turn");
			equal(w.model.calls.length, 2, "model calls");
			await noSecret(w, answers);
		});

		run("a turn a scheduled task starts in this process is listed, followed to its end, and gets the port's credential", async (w) => {
			const from = await head(w.session);
			w.model.script({ toolCalls: [{ name: "schedule", arguments: {} }] }, { chunks: ["scheduled"] }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["reminded"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "p1", "remind me", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "p1"));
			await traced(w, w.session, from, hostRequestId("schedule", "s1"), 1, undefined, answers);
			await noSecret(w, answers);
		});

		run("a sleeping task whose timer fires before its time on the host's clock wakes once that time comes", async (w) => {
			w.clock.at = 1_000_000;
			w.model.script({ toolCalls: [{ name: "schedule", arguments: {} }] }, { chunks: ["scheduled"] }, { chunks: ["reminded"] });
			is(await w.session.submit(ALICE, "p1", "remind me", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "p1");
			const id = hostRequestId("schedule", "s1");
			// The reminder sleeps 50 ms on the host's clock, which stands still: a timer that fires in real time finds it not due.
			await new Promise((r) => setTimeout(r, 200));
			equal((await w.session.status(ALICE, id, ctx)).t, "error", "the reminder before its time");
			w.clock.at += 50;
			for (let i = 0; i < 400 && (await w.session.status(ALICE, id, ctx)).t !== "status"; i++) await new Promise((r) => setTimeout(r, 10));
			equal((await followToEnd(w.session, id)).status.state, "done", "the reminder once its time came");
		});

		run("a subagent's turn is listed as host:submission:<n>, followed to its end, gets the port's credential, and keeps its id after a reopen", async (w) => {
			const from = await head(w.session);
			w.model.script({ toolCalls: [{ name: "delegate", arguments: {} }] }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["sub answer"] }, { chunks: ["parent answer"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "p1", "ask a helper", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "p1"));
			const sub = w.subagents[0];
			if (sub === undefined) return fail("no subagent started", w.subagents);
			const id = `host:submission:${sub.submission}`;
			await traced(w, w.session, from, id, sub.conversation, undefined, answers);
			const next = await w.reopen();
			const status = is<TurnStatus>(await next.status(ALICE, id, ctx, sub.conversation), "status", "status after a reopen");
			equal([status.requestId, status.state], [id, "done"], "the subagent's turn after a reopen");
			await noSecret(w, answers);
		});

		run("a turn resumed after its owner is killed is listed, followed to its end, and asks the port again", async (w) => {
			const from = await head(w.session);
			w.model.script({ chunks: ["partial"], hold: new Promise<void>(() => {}) }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["resumed"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "k1", "long job", {}, ctx), "accepted", "submit")];
			await untilText(w.session, "k1", "partial");
			const next = await w.reopen();
			await traced(w, next, from, "k1", 1, "alice", answers);
			await noSecret(w, answers);
		});

		// --- Turn credentials (spec 5.3.4) ---

		run("a credential carried on submit is the turn's, is stored nowhere, and a retry may carry a new one", async (w) => {
			const whoami = { toolCalls: [{ name: "whoami", arguments: {} }] };
			w.model.script(whoami, { error: "invalid request" }, whoami, { chunks: ["done"] });
			const answers: unknown[] = [];
			answers.push(is(await w.session.submit(ALICE, "r1", "hello", { credential: `${SECRET}:carried:1` }, ctx), "accepted", "submit"));
			const first = await followToEnd(w.session, "r1");
			equal(first.status.state, "failed", "the first attempt");
			answers.push(first);
			answers.push(is(await w.session.submit(ALICE, "r1", "hello", { credential: `${SECRET}:carried:2` }, ctx), "accepted", "a retry with a new credential"));
			const second = await followToEnd(w.session, "r1");
			answers.push(second, await w.session.status(ALICE, "r1", ctx));
			equal([second.status.state, second.status.attempt], ["done", 2], "the retry");
			equal(
				w.seen.map((s) => [s.requestId, s.attempt, s.credential]),
				[
					["r1", 1, `${SECRET}:carried:1`],
					["r1", 2, `${SECRET}:carried:2`],
				],
				"what each attempt's tool saw",
			);
			equal(w.portCalls, [], "port calls");
			await noSecret(w, answers);
		});

		run("a steer from another principal is refused, and the turn's tools act only for the principal who started it", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["working"], hold: new Promise<void>((r) => (release = r)) }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "a1", "start", {}, ctx), "accepted", "alice's turn");
			await untilText(w.session, "a1", "working");
			equal(await w.session.submit(BOB, "b1", "do this instead", { whenBusy: "steer" }, ctx), { t: "rejected", requestId: "b1", reason: "forbidden" }, "bob steering alice's turn");
			equal(await w.session.status(ALICE, "b1", ctx), NOT_FOUND, "bob's refused steer left no record");
			is(await w.session.submit(ALICE, "a2", "also this", { whenBusy: "steer" }, ctx), "accepted", "alice steering her own turn");
			release();
			await followToEnd(w.session, "a1");
			await followToEnd(w.session, "a2");
			equal(w.seen.length, 1, "tool calls");
			equal(w.seen.map((s) => [s.principal, s.credential?.startsWith(`${SECRET}:product:alice:`)]), [["alice", true]], "whom the tool acted for");
			equal(w.portCalls.every((t) => t.principal === "alice"), true, "port calls only for alice");
		});

		run("a followUp that runs as its own turn gets a credential for its own principal", async (w) => {
			let release!: () => void;
			const whoami = { toolCalls: [{ name: "whoami", arguments: {} }] };
			w.model.script(whoami, { chunks: ["first"], hold: new Promise<void>((r) => (release = r)) }, whoami, { chunks: ["second"] });
			is(await w.session.submit(ALICE, "a1", "one", {}, ctx), "accepted", "alice's turn");
			await untilText(w.session, "a1", "first");
			is(await w.session.submit(BOB, "b1", "two", {}, ctx), "accepted", "bob's followUp");
			release();
			await followToEnd(w.session, "b1");
			equal(
				w.seen.map((s) => [s.requestId, s.principal, s.credential]),
				[
					["a1", "alice", minted({ requestId: "a1", attempt: 1, principal: "alice" })],
					["b1", "bob", minted({ requestId: "b1", attempt: 1, principal: "bob" })],
				],
				"what each turn's tool saw",
			);
			equal(w.portCalls.map((t) => [t.requestId, t.principal]), [["a1", "alice"], ["b1", "bob"]], "port calls");
		});

		run("a run that answers inputs of two principals acts for no one", async (w) => {
			let release!: () => void;
			w.model.script({ chunks: ["first"], hold: new Promise<void>((r) => (release = r)) }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["both"] });
			is(await w.session.submit(ALICE, "a1", "one", {}, ctx), "accepted", "alice's turn");
			await untilText(w.session, "a1", "first");
			// pi-durable places a pending steer together with the next followUp, so one run answers both.
			is(await w.session.submit(BOB, "b1", "two", {}, ctx), "accepted", "bob's followUp");
			is(await w.session.submit(ALICE, "a2", "three", { whenBusy: "steer" }, ctx), "accepted", "alice's steer");
			release();
			await followToEnd(w.session, "b1");
			await followToEnd(w.session, "a2");
			equal(w.seen.map((s) => s.credential), [undefined], "the credential the shared run's tool saw");
			equal(w.portCalls, [], "port calls");
		});

		run("a credential port's failure text reaches neither the store nor any answer", async (w) => {
			w.model.script({ toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["done"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "r1"), await w.session.status(ALICE, "r1", ctx));
			equal(w.seen, [], "tool calls that got a credential");
			await noSecret(w, answers);
		}, 30_000, {
			credential: async () => {
				throw new Error(`${SECRET}:port-error`);
			},
		});

		run("a model gateway's failure text reaches neither the store nor any answer", async (w) => {
			const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit")];
			const end = await followToEnd(w.session, "r1");
			answers.push(end, await w.session.status(ALICE, "r1", ctx));
			equal(end.status.state, "failed", "a turn whose gateway refuses access");
			equal(w.model.calls.length, 0, "model requests sent without access");
			await noSecret(w, answers);
		}, 30_000, {
			gateway: {
				...scriptedModel().gateway,
				access: async () => {
					throw new Error(`${SECRET}:gateway-error`);
				},
			},
		});

		run("a turn the host started cannot be steered by a caller", async (w) => {
			let release!: () => void;
			w.model.script({ toolCalls: [{ name: "schedule", arguments: {} }] }, { chunks: ["scheduled"] }, { chunks: ["reminding"], hold: new Promise<void>((r) => (release = r)) });
			is(await w.session.submit(ALICE, "p1", "remind me", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "p1");
			const id = hostRequestId("schedule", "s1");
			for (let i = 0; i < 400 && (await w.session.status(ALICE, id, ctx)).t !== "status"; i++) await new Promise((r) => setTimeout(r, 10));
			await untilText(w.session, id, "reminding");
			equal(await w.session.submit(ALICE, "s2", "and this", { whenBusy: "steer" }, ctx), { t: "rejected", requestId: "s2", reason: "forbidden" }, "alice steering the host's turn");
			release();
			await followToEnd(w.session, id);
		});

		run("a forged kleya: request id borrows no one's credential", async (w) => {
			w.model.script({ toolCalls: [{ name: "forge", arguments: {} }] }, { chunks: ["a1 done"] }, { toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["forged done"] });
			is(await w.session.submit(ALICE, "a1", "hello", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "a1");
			for (let i = 0; i < 400 && w.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			equal(w.seen.map((s) => s.credential), [undefined], "the credential the forged input's tool saw");
			equal(w.portCalls, [], "port calls");
		});

		// --- Model gateway (K6) ---

		run(
			"every model request goes to the gateway's base URL with the gateway's credential, never the catalog's base URL or a provider key",
			async (w) => {
				w.model.script({ toolCalls: [{ name: "whoami", arguments: {} }] }, { chunks: ["answered"] });
				const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit")];
				answers.push(await followToEnd(w.session, "r1"));
				equal(
					w.model.calls.map((c) => [c.baseUrl, c.apiKey]),
					[
						[GATEWAY_URL, GATEWAY_CREDENTIAL],
						[GATEWAY_URL, GATEWAY_CREDENTIAL],
					],
					"where each model request went",
				);
				equal(w.model.accesses, [SCOPE, SCOPE], "the scope of each gateway access");
				await noSecret(w, answers);
			},
			30_000,
			// No option takes a provider key: one passed anyway reaches no request.
			{ apiKey: "provider-key", providerKey: "provider-key" } as Partial<HostOptions>,
		);

		// --- Cursors across hosts, page bounds ---

		run("a host that takes a session over resumes every cursor the last one handed out", async (w) => {
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit");
			const end = await followToEnd(w.session, "r1");
			const at = await head(w.session);
			const next = await w.reopen();
			equal((await next.followSession(ALICE, { after: at, waitMs: 0 }, ctx)).t, "session", "a session cursor after the takeover");
			const page = is<TurnPage>(await next.follow(ALICE, "r1", { after: end.cursor, waitMs: 0 }, ctx), "turn", "a turn cursor after the takeover");
			equal([page.done, page.events], [true, []], "the ended turn from its cursor");
		});

		// --- Wake, release and the alarm (spec 5.1 "Host adapters") ---

		/** The last alarm the host set for the session, or "none" before any; fails for an adapter with no alarm port. */
		const lastAlarm = (w: World): number | undefined | "none" => {
			if (w.ports.alarm === undefined) return fail("the adapter has no alarm port", name);
			const sets = w.alarms.filter((a) => a.id === w.session.id);
			return sets.length === 0 ? "none" : sets.at(-1)!.at;
		};
		/** Waits up to two seconds for `check`: the host sets alarms in the background. */
		const eventually = async (what: string, check: () => boolean, actual: () => unknown) => {
			for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
			if (!check()) fail(what, actual());
		};

		run("a running turn sets the session's alarm within the recovery delay, and its end clears it", async (w) => {
			let release = () => {};
			w.model.script({ chunks: ["held"], hold: new Promise<void>((r) => (release = r)) });
			const before = Date.now();
			is(await w.session.submit(ALICE, "a1", "hello", {}, ctx), "accepted", "submit");
			await untilText(w.session, "a1", "held");
			await eventually("an alarm while the turn runs", () => typeof lastAlarm(w) === "number", () => w.alarms);
			const at = lastAlarm(w) as number;
			if (at < before + RECOVERY_DELAY_MS || at > Date.now() + RECOVERY_DELAY_MS) fail("the alarm is the recovery delay from now", at - before);
			release();
			equal((await followToEnd(w.session, "a1")).status.state, "done", "the turn");
			await eventually("no alarm once the turn ends", () => lastAlarm(w) === undefined, () => w.alarms);
		});

		run("a host woken over the same ports finishes a turn its killed owner left running, and the follower sees its end once", async (w) => {
			w.model.script({ chunks: ["partial"], hold: new Promise<void>(() => {}) }, { chunks: ["the whole answer"] });
			is(await w.session.submit(ALICE, "k1", "long job", {}, ctx), "accepted", "submit");
			const page = await untilText(w.session, "k1", "partial");
			const next = w.another();
			await next.wake(SCOPE, ctx);
			const rest = await followToEnd(await next.session(SCOPE, ctx), "k1", page.cursor);
			equal(rest.status.state, "done", "the woken turn");
			equal(applyEvents("partial", rest.events), await storedAnswer(w, "k1"), "the follower's text");
			equal(rest.events.filter((e) => e.t === "end").length, 1, "end events");
			equal((await w.submissions(ctx)).filter((s) => s.type !== "write").length, 1, "submissions: the wake submits nothing");
		});

		run("release keeps a session open while a turn runs or a follower waits, closes it when idle, and its cursors read on", async (w) => {
			let release = () => {};
			w.model.script({ chunks: ["held"], hold: new Promise<void>((r) => (release = r)) }, { chunks: ["again"] });
			is(await w.session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit");
			await untilText(w.session, "r1", "held");
			equal(await w.host.release(SCOPE, ctx), false, "release while a turn runs");
			release();
			const end = await followToEnd(w.session, "r1");
			const at = await head(w.session);
			const waiting = w.session.followSession(ALICE, { after: at, waitMs: 300 }, ctx);
			equal(await w.host.release(SCOPE, ctx), false, "release while a follower waits");
			equal((await waiting).t, "session", "the waiting follower's page");
			equal(await w.host.release(SCOPE, ctx), true, "release once idle");
			const session = await w.host.session(SCOPE, ctx);
			equal((await session.followSession(ALICE, { after: at, waitMs: 0 }, ctx)).t, "session", "a session cursor from before the release");
			const page = is<TurnPage>(await session.follow(ALICE, "r1", { after: end.cursor, waitMs: 0 }, ctx), "turn", "a turn cursor from before the release");
			equal([page.done, page.events], [true, []], "the ended turn from its cursor");
			is(await session.submit(ALICE, "r2", "again", {}, ctx), "accepted", "submit after the release");
			equal((await followToEnd(session, "r2")).status.state, "done", "a turn after the release");
		});

		run("drop clears the session's alarm", async (w) => {
			w.model.script({ chunks: ["held"], hold: new Promise<void>(() => {}) });
			is(await w.session.submit(ALICE, "d1", "hello", {}, ctx), "accepted", "submit");
			await untilText(w.session, "d1", "held");
			await eventually("an alarm while the turn runs", () => typeof lastAlarm(w) === "number", () => w.alarms);
			await w.host.drop(SCOPE, ctx);
			equal(lastAlarm(w), undefined, "the alarm after drop");
		});

		run("a session follow page spans at most pageEntries commits", async (w) => {
			const seq = (cursor: string) => decodeSessionCursor(cursor, w.session.id)?.seq ?? fail("an undecodable session cursor", cursor);
			const first = is<Accepted>(await w.session.submit(ALICE, "p0", "x", {}, ctx), "accepted", "submit p0");
			await followToEnd(w.session, "p0");
			for (let i = 1; seq(await head(w.session)) - seq(first.position) <= LIMITS.pageEntries + 10; i++) {
				is(await w.session.submit(ALICE, `p${i}`, "x", {}, ctx), "accepted", `submit p${i}`);
				await followToEnd(w.session, `p${i}`);
			}
			let cursor = first.position;
			let pages = 0;
			for (;;) {
				const page = is<SessionPage>(await w.session.followSession(ALICE, { after: cursor, waitMs: 0 }, ctx), "session", "session follow");
				const span = seq(page.cursor) - seq(cursor);
				if (span > LIMITS.pageEntries) fail("commits in one page", span);
				if (span === 0) break;
				cursor = page.cursor;
				pages++;
			}
			equal(pages >= 2, true, "more than one page");
		}, 120_000);

		const failedOpen = async () => {
			const model = scriptedModel();
			const built = await adapter();
			const held = new Set<number>();
			let failures = 1;
			const ports: HostPorts = {
				...built.ports,
				owner: {
					async acquire(id, c) {
						const fence = await built.ports.owner.acquire(id, c);
						held.add(fence.epoch);
						return fence;
					},
					async release(id, fence) {
						held.delete(fence.epoch);
						await built.ports.owner.release(id, fence);
					},
				},
				storage: {
					...built.ports.storage,
					open(id, fence, c) {
						if (failures-- > 0) return Promise.reject(new Error("storage unavailable"));
						return built.ports.storage.open(id, fence, c);
					},
				},
			};
			const host = createHost({ ports, gateway: model.gateway, registry: createRegistry(), settings: SETTINGS, agent: { model: model.agentModel, thinkingLevel: "off" } });
			try {
				const first = await host.session(SCOPE, ctx).then(() => "opened", (e: Error) => e.message);
				equal(first, "storage unavailable", "first open");
				equal(held.size, 0, "fences held after the failed open");
				const session = await host.session(SCOPE, ctx);
				is(await session.submit(ALICE, "r1", "hello", {}, ctx), "accepted", "submit after recovery");
				await followToEnd(session, "r1");
			} finally {
				await host.close(ctx);
				await built.dispose();
			}
			equal(held.size, 0, "fences held after close");
		};
		runner.test("a session that fails to open releases its owner fence", failedOpen, 30_000);

		const reservedContext = async () => {
			const model = scriptedModel();
			const built = await adapter();
			const options = (keys: Record<string, string>): HostOptions => ({ ports: built.ports, gateway: model.gateway, registry: createRegistry(), settings: SETTINGS, agent: { model: model.agentModel, thinkingLevel: "off" }, context: () => keys });
			const opened = async (keys: Record<string, string>) => {
				const host = createHost(options(keys));
				try {
					await host.session(SCOPE, ctx);
					return "opened";
				} catch (error) {
					return (error as Error).message;
				} finally {
					await host.close(ctx);
				}
			};
			try {
				// A new store, and then a store whose root conversation already exists, so no conversation is created.
				equal(await opened({ tenant: "tenant-a", constructor: "x" }), 'HostOptions.context: the scope key "constructor" names an Object.prototype member', "a new store");
				equal(await opened({ tenant: "tenant-a" }), "opened", "the same keys without it");
				equal(await opened({ tenant: "tenant-a", toString: "x" }), 'HostOptions.context: the scope key "toString" names an Object.prototype member', "a store that exists");
			} finally {
				await built.dispose();
			}
		};
		runner.test("a host whose context names an Object.prototype member, such as constructor, opens no session", reservedContext, 30_000);

		// --- Product API tools (K4, step 3) ---

		withProduct("a product tool fills a bound key from the conversation's context and sends the turn's credential only in its Authorization header", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "get_note", arguments: { note: "n 1/../x" } }] }, { chunks: ["done"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "read it", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "r1"));
			const credential = minted({ requestId: "r1", attempt: 1, principal: "alice" });
			equal(
				product.requests.map((r) => [r.method, r.url.href, r.authorization, r.redirect, r.body]),
				[["GET", `${PRODUCT_ORIGIN}/tenants/tenant-a/notes/n%201%2F..%2Fx`, `Bearer ${credential}`, "error", ""]],
				"what the product received",
			);
			equal(toolTexts(w), [JSON.stringify({ tenant: "tenant-a", note: "n 1/../x" })], "what the model saw");
			await noSecret(w, answers);
		});

		withProduct(
			"a product tool whose conversation lacks a bound key fails and sends nothing",
			async (w, product) => {
				w.model.script({ toolCalls: [{ name: "get_note", arguments: { note: "n1" } }] }, { chunks: ["done"] });
				is(await w.session.submit(ALICE, "r1", "read it", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, "r1");
				equal(product.requests.length, 0, "requests sent");
				equal(toolTexts(w), ["get_note failed: this conversation has no tenant in its context"], "what the model saw");
			},
			{ context: false },
		);

		withProduct(
			"an argument naming a bound key is blocked before any tool runs, at any depth and in any tool",
			async (w, product) => {
				w.model.script(
					{
						toolCalls: [
							{ name: "get_note", arguments: { note: "n1", filter: { tenantId: "tenant-b" } } },
							{ name: "open_tool", arguments: { list: [{ tenant_ids: ["tenant-b"] }] } },
							{ name: "open_tool", arguments: { lieutenant: "tenant-b" } },
						],
					},
					{ chunks: ["done"] },
				);
				is(await w.session.submit(ALICE, "r1", "try it", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, "r1");
				equal(product.requests.length, 0, "requests sent");
				equal(product.ran, [{ lieutenant: "tenant-b" }], "open_tool runs");
				const [first, second, third] = toolTexts(w);
				equal([first?.includes('"tenantId"'), second?.includes('"tenant_ids"'), third], [true, true, "ran"], "what the model saw");
				equal([first, second].some((t) => t?.includes("tenant-b")), false, "a block echoes no value");
			},
			{ more: (product) => [product.openTool] },
		);

		withProduct("a product response over 1 MiB is an error result, and no part of it reaches the model or the store", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "big", arguments: {} }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "fetch it", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			equal(toolTexts(w), ["big failed: response too large"], "what the model saw");
			equal((await w.dump(ctx)).includes(BIG_MARK), false, "part of the body in the store");
			equal(JSON.stringify(w.model.calls).includes(BIG_MARK), false, "part of the body in a model request");
			equal(product.cancelled(), true, "the oversized body's read was cancelled");
		});

		withProduct("a credential a product echoes is redacted from the result, the error text and the store", async (w) => {
			w.model.script({ toolCalls: ["echo", "fail", "unreachable"].map((name) => ({ name, arguments: {} })) }, { chunks: ["done"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "echo it", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "r1"));
			equal(
				toolTexts(w),
				[
					JSON.stringify({ saw: "Bearer [redacted]" }),
					`fail failed with status 500: ${JSON.stringify({ error: "refused Bearer [redacted]" })}`,
					"unreachable failed: could not reach Bearer [redacted]",
				],
				"what the model saw",
			);
			await noSecret(w, answers);
		});

		withProduct("a product write sent again after a crash carries the same Idempotency-Key, and the product applies it once", async (w, product) => {
			product.hangAfterNextWrite();
			w.model.script({ toolCalls: [{ name: "add_note", arguments: { text: "hi" } }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "note it", {}, ctx), "accepted", "submit");
			for (let i = 0; i < 400 && product.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
			const next = createHost(w.options);
			try {
				const session = await next.session(SCOPE, ctx);
				equal((await followToEnd(session, "r1")).status.state, "done", "turn state");
			} finally {
				await next.close(ctx);
			}
			const keys = product.requests.map((r) => r.key);
			equal(keys.length, 2, "writes sent");
			equal(keys[0], keys[1], "the resent write's key");
			if (!/^kleya1\.[A-Za-z0-9_-]{43}$/.test(keys[0] ?? "")) fail("an Idempotency-Key that is not kleya1. and a SHA-256", keys[0]);
			equal(product.notes.size, 1, "notes the product holds");
		});

		withProduct("the same tool task id in a dropped and recreated store gets a new Idempotency-Key", async (w, product) => {
			const write = async (session: SessionHost) => {
				w.model.script({ toolCalls: [{ name: "add_note", arguments: { text: "hi" } }] }, { chunks: ["done"] });
				is(await session.submit(ALICE, "r1", "note it", {}, ctx), "accepted", "submit");
				await followToEnd(session, "r1");
				return { key: product.requests.at(-1)?.key, tasks: await w.toolTasks(ctx) };
			};
			const before = await write(w.session);
			await w.host.drop(SCOPE, ctx);
			const after = await write(await w.host.session(SCOPE, ctx));
			equal(after.tasks, before.tasks, "tool task ids in the new store");
			if (before.key === undefined || before.key === after.key) fail("the recreated store's key", [before.key, after.key]);
		});

		withProduct("a write with an older attempt's credential is refused by the product", async (w, product) => {
			const add = { toolCalls: [{ name: "add_note", arguments: { text: "hi" } }] };
			w.model.script(add, { error: "invalid request" }, add, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "note it", {}, ctx), "accepted", "attempt 1");
			equal((await followToEnd(w.session, "r1")).status.state, "failed", "attempt 1");
			is(await w.session.submit(ALICE, "r1", "note it", {}, ctx), "accepted", "attempt 2");
			equal((await followToEnd(w.session, "r1")).status.state, "done", "attempt 2");
			equal(product.requests.map((r) => r.status), [201, 201], "each attempt's write");
			// A late write from attempt 1, such as a fenced-out process still holding its credential.
			const late = await product.fetch(new URL(`${PRODUCT_ORIGIN}/tenants/tenant-a/notes`), {
				method: "POST",
				headers: { authorization: product.requests[0]!.authorization!, "content-type": "application/json" },
				body: JSON.stringify({ text: "late" }),
			});
			equal(late.status, 409, "the late write");
		});

		withProduct("a path value of . or .. is refused, and nothing is sent", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "get_note", arguments: { note: ".." } }, { name: "get_note", arguments: { note: "." } }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "read it", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			equal(product.requests.length, 0, "requests sent");
			equal(toolTexts(w), ["get_note failed: note is not a usable path value", "get_note failed: note is not a usable path value"], "what the model saw");
		});

		withProduct("arguments named like inherited keys, such as valueOf and toString, are read only from the model's own arguments", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "get_item", arguments: { valueOf: "c1" } }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "read it", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			equal(product.requests.map((r) => [r.method, r.url.href, r.status]), [["GET", `${PRODUCT_ORIGIN}/items/c1`, 200]], "what the product received");
		});

		withProduct("a bound key that is not in the path is sent as a named field", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "search_notes", arguments: { q: "hi" } }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "find it", {}, ctx), "accepted", "submit");
			await followToEnd(w.session, "r1");
			equal(product.requests.map((r) => [r.method, r.url.href]), [["GET", `${PRODUCT_ORIGIN}/notes?q=hi&tenant=tenant-a`]], "what the product received");
		});

		withProduct(
			"a product tool in a turn without a product credential fails and sends nothing",
			async (w, product) => {
				w.model.script({ toolCalls: [{ name: "get_note", arguments: { note: "n1" } }] }, { chunks: ["done"] });
				is(await w.session.submit(ALICE, "r1", "read it", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, "r1");
				equal(product.requests.length, 0, "requests sent");
				equal(toolTexts(w), ["get_note failed: this turn has no product credential"], "what the model saw");
			},
			{ credential: false },
		);

		withProduct(
			"an argument naming a context key a product added is blocked, in any tool",
			async (w, product) => {
				w.model.script({ toolCalls: [{ name: "annotate", arguments: {} }] }, { toolCalls: [{ name: "open_tool", arguments: { caseId: "c2" } }] }, { chunks: ["done"] });
				is(await w.session.submit(ALICE, "r1", "annotate it", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, "r1");
				equal(product.ran, [], "open_tool runs");
				const [annotated, blocked] = toolTexts(w);
				equal([annotated, blocked?.includes('names the bound key "case"'), blocked?.includes("c2")], ["ok", true, false], "what the model saw");
			},
			{ more: (product) => [product.openTool, ...product.contextTools] },
		);

		withProduct("a product call stops at its timeout, and the model gets an error", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "slow", arguments: {} }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "wait for it", {}, ctx), "accepted", "submit");
			equal((await followToEnd(w.session, "r1")).status.state, "done", "turn state");
			equal(product.stops, ["timeout"], "why the call stopped");
			const [result] = toolTexts(w);
			if (!result?.startsWith("slow failed: ")) fail("what the model saw", result);
		});

		withProduct("aborting a turn stops its product call at once", async (w, product) => {
			w.model.script({ toolCalls: [{ name: "slow", arguments: {} }] }, { chunks: ["done"] });
			is(await w.session.submit(ALICE, "r1", "wait for it", {}, ctx), "accepted", "submit");
			for (let i = 0; i < 400 && product.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
			equal(product.requests.length, 1, "requests sent");
			is(await w.session.abort(ALICE, "r1", "a1", ctx), "status", "abort");
			await followToEnd(w.session, "r1");
			equal(product.stops, ["aborted"], "why the call stopped");
		});

		withProduct("an error body is redacted before it is cut, and the model sees at most 2,000 characters of it", async (w) => {
			w.model.script({ toolCalls: [{ name: "fail_long", arguments: {} }] }, { chunks: ["done"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, "r1", "try it", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, "r1"));
			equal(toolTexts(w), [`fail_long failed with status 500: ${`${"x".repeat(1963)}Bearer [redacted]${"y".repeat(100)}`.slice(0, 2000)}`], "what the model saw");
			await noSecret(w, answers);
		});

		withProduct("a credential a product echoes JSON-escaped is redacted", async (w) => {
			// A request id with / and " makes a credential that a JSON writer escapes.
			const id = 'r/"1';
			w.model.script({ toolCalls: [{ name: "echo", arguments: {} }] }, { chunks: ["done"] });
			const answers: unknown[] = [is(await w.session.submit(ALICE, id, "echo it", {}, ctx), "accepted", "submit")];
			answers.push(await followToEnd(w.session, id));
			equal(toolTexts(w), [JSON.stringify({ saw: "Bearer [redacted]" })], "what the model saw");
			await noSecret(w, answers);
		});

		withProduct("two writes get different Idempotency-Keys, even when the model reuses a tool-call id", async (w, product) => {
			for (const id of ["r1", "r2"]) {
				w.model.script({ toolCalls: [{ name: "add_note", arguments: { text: id }, id: "call_1" }] }, { chunks: ["done"] });
				is(await w.session.submit(ALICE, id, "note it", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, id);
			}
			const keys = product.requests.map((r) => r.key);
			if (keys.length !== 2 || keys[0] === keys[1]) fail("the two writes' keys", keys);
			equal([...product.notes.values()], ["r1", "r2"], "notes the product holds");
		});

		withProduct(
			"a product may add context keys but never change a host key, in an existing conversation or a new one",
			async (w) => {
				w.model.script({ toolCalls: ["rebind", "annotate", "spawn_rebound", "spawn"].map((name) => ({ name, arguments: {} })) }, { chunks: ["done"] });
				is(await w.session.submit(ALICE, "r1", "rescope", {}, ctx), "accepted", "submit");
				await followToEnd(w.session, "r1");
				const texts = toolTexts(w);
				equal([texts[0]?.includes("cannot be changed"), texts[1], texts[2]?.includes("cannot be changed"), texts[3]], [true, "ok", true, "ok"], "what the model saw");
				equal(Object.values(await w.scopes(ctx)), [{ tenant: "tenant-a", case: "c9" }, { tenant: "tenant-a", case: "c1" }], "each conversation's scope");
			},
			{ more: (product) => product.contextTools },
		);
	});
}

// --- Tools and a task the suite's turns use ---

/**
 * `whoami` records the credential `turnCredential` gives it and returns none of it; `schedule` starts a task that submits
 * a turn of its own 50 ms later; `delegate` runs a subagent in a conversation it owns and waits for it.
 */
function triggerTools(model: ScriptedModel, seen: Seen[], subagents: { conversation: number; submission: number }[]) {
	const empty = { type: "object", properties: {}, additionalProperties: false } as const;
	const whoami = defineTool({
		name: "whoami",
		description: "Says whether this turn acts for someone.",
		parameters: empty,
		replay: "safe",
		async execute(_args, api, context) {
			const turn = await turnCredential(api, context);
			seen.push({ conversation: api.conversationId, requestId: turn?.requestId, attempt: turn?.attempt, principal: turn?.principal, credential: turn?.credential });
			return { output: [{ type: "text", text: turn === undefined ? "for no one" : "for someone" }] };
		},
	});
	const reminder = defineTask<{ at: number; id: string }, { phase: "wait" } | { phase: "fire" }, null>({
		name: "kleya-contract.reminder",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "fire" }, context),
			fire: async (task, runtime, context) => {
				const conversation = await runtime.conversation(runtime.conversationId, context);
				await runtime.commit(async (tx) => {
					await conversation?.submit(tx, { type: "input", content: "the reminder is due", requestId: hostRequestId("schedule", task.input.id) });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const schedule = defineTool({
		name: "schedule",
		description: "Starts a reminder.",
		parameters: empty,
		async execute(_args, api, context) {
			await api.createTask(reminder, { at: api.now() + 50, id: "s1" }, { ownership: { kind: "conversation" }, background: true }, context);
			return { output: [{ type: "text", text: "scheduled" }] };
		},
	});
	const delegate = defineTool({
		name: "delegate",
		description: "Runs a subagent.",
		parameters: empty,
		replay: "safe",
		async execute(_args, api, context) {
			const child = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, created.id, { model: model.agentModel, thinkingLevel: "off", tools: [whoami] });
				return created.id;
			}, context);
			const handle = await api.conversation(child, context);
			if (handle === undefined) throw new Error("no subagent conversation");
			const submission = await handle.submit({ type: "input", content: "a sub task", requestId: `subagent:${api.taskId}` }, context);
			subagents.push({ conversation: child, submission: submission.id });
			await submission.wait(context);
			return { output: [{ type: "text", text: "delegated" }] };
		},
	});
	// Tool code that submits under a caller's internal id, as a confused or hostile tool might.
	const forge = defineTool({
		name: "forge",
		description: "Submits an input under another request's id.",
		parameters: empty,
		async execute(_args, api, context) {
			const handle = await api.conversation(api.conversationId, context);
			await handle?.submit({ type: "input", content: "forged", requestId: "kleya:2:0:a1" }, context);
			return { output: [{ type: "text", text: "forged" }] };
		},
	});
	return { tools: [whoami, schedule, delegate, forge], reminder };
}

// --- A reference product API the suite's product tools call ---

const PRODUCT_ORIGIN = "https://notes.invalid";
/** The suite's product calls time out after this long; `slow` waits for it. */
const PRODUCT_TIMEOUT_MS = 1_000;
/** In every chunk of the oversized response, so a scan finds any part of it. */
const BIG_MARK = "kleya-big-body-mark";

/** The notes API: reads, an idempotent write, a search, an oversized response, an echo of the credential, failures, a call that never answers and an unreachable host. */
const NOTE_TOOLS: HttpTool[] = [
	{
		name: "get_note",
		description: "Reads a note.",
		parameters: { type: "object", properties: { note: { type: "string" }, filter: { type: "object" } }, required: ["note"], additionalProperties: false },
		method: "GET",
		path: "/tenants/{tenant}/notes/{note}",
		bound: ["tenant"],
	},
	{
		name: "add_note",
		description: "Adds a note.",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
		method: "POST",
		path: "/tenants/{tenant}/notes",
		bound: ["tenant"],
		effect: "idempotent-by-key",
	},
	{
		name: "search_notes",
		description: "Searches notes.",
		parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
		method: "GET",
		path: "/notes",
		bound: ["tenant"],
	},
	{
		// Parameters named like keys every object inherits: only the model's own arguments may supply them.
		name: "get_item",
		description: "Reads an item.",
		parameters: { type: "object", properties: { valueOf: { type: "string" }, toString: { type: "string" } }, required: ["valueOf"], additionalProperties: false },
		method: "GET",
		path: "/items/{valueOf}",
	},
	...["big", "echo", "fail", "fail_long", "slow", "unreachable"].map((name): HttpTool => ({ name, description: `Calls /${name}.`, parameters: { type: "object", properties: {}, additionalProperties: false }, method: "GET", path: `/${name}` })),
];

type ProductRequest = { method: string; url: URL; authorization: string | null; redirect: RequestRedirect | undefined; body: string; key: string | null; status?: number };

/** The product side of the suite's product tools: its credential port, its API and what it received. */
export type ReferenceProduct = {
	readonly port: CredentialPort;
	readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
	readonly requests: ProductRequest[];
	/** Notes by Idempotency-Key. */
	readonly notes: Map<string, string>;
	/** Arguments \`open_tool\` ran with. */
	readonly ran: JsonObject[];
	readonly openTool: ToolRegistration;
	readonly contextTools: ToolRegistration[];
	/** The next write is applied, and its response never arrives, as when the host dies waiting for it. */
	hangAfterNextWrite(): void;
	/** Whether the host cancelled its read of the oversized response. */
	cancelled(): boolean;
	/** Why each `slow` call stopped: its timeout, or an abort. */
	readonly stops: ("timeout" | "aborted")[];
};

function referenceProduct(): ReferenceProduct {
	const requests: ProductRequest[] = [];
	const notes = new Map<string, string>();
	const ran: JsonObject[] = [];
	/** What the port minted: each credential's turn, and each request id's latest attempt. */
	const issued = new Map<string, Turn>();
	const latest = new Map<string, number>();
	let hang = false;
	let pulled = 0;
	let cancelled = false;
	const stops: ("timeout" | "aborted")[] = [];
	const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
	const port: CredentialPort = async (scope, turn) => {
		if (JSON.stringify(scope) !== JSON.stringify(SCOPE)) throw new Error("the credential port was asked for another scope");
		const credential = minted(turn);
		issued.set(credential, turn);
		latest.set(turn.requestId, Math.max(latest.get(turn.requestId) ?? 0, turn.attempt));
		return credential;
	};
	const fetch = async (url: URL, init: RequestInit): Promise<Response> => {
		const headers = new Headers(init.headers);
		const authorization = headers.get("authorization");
		const request: ProductRequest = { method: init.method ?? "GET", url, authorization, redirect: init.redirect, body: typeof init.body === "string" ? init.body : "", key: headers.get("idempotency-key") };
		requests.push(request);
		const answer = (status: number, value: unknown) => {
			request.status = status;
			return json(status, value);
		};
		if (url.origin !== PRODUCT_ORIGIN) throw new Error(`no such host ${url.host}`);
		const turn = authorization?.startsWith("Bearer ") ? issued.get(authorization.slice(7)) : undefined;
		if (turn === undefined) return answer(401, { error: "unauthorized" });
		const path = url.pathname;
		const note = path.match(/^\/tenants\/([^/]+)\/notes\/([^/]+)$/);
		if (init.method === "GET" && note !== null) return answer(200, { tenant: decodeURIComponent(note[1]!), note: decodeURIComponent(note[2]!) });
		if (init.method === "POST" && /^\/tenants\/[^/]+\/notes$/.test(path)) {
			// A write must come from the latest attempt of its request: an older attempt's credential is refused.
			if (turn.attempt < (latest.get(turn.requestId) ?? 0)) return answer(409, { error: "stale attempt" });
			const key = request.key ?? crypto.randomUUID();
			if (!notes.has(key)) notes.set(key, (JSON.parse(request.body) as { text: string }).text);
			if (hang) {
				hang = false;
				return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			}
			return answer(201, { id: key });
		}
		if (init.method === "GET" && path === "/notes") return answer(200, Object.fromEntries(url.searchParams));
		// As some servers write JSON: with every / escaped.
		if (path === "/echo") {
			request.status = 200;
			return new Response(JSON.stringify({ saw: authorization }).replaceAll("/", "\\/"), { status: 200 });
		}
		// The credential straddles character 2,000 of the body.
		if (path === "/fail_long") {
			request.status = 500;
			return new Response(`${"x".repeat(1963)}${authorization}${"y".repeat(100)}`, { status: 500 });
		}
		if (path === "/slow") {
			return new Promise((_, reject) => {
				const signal = init.signal;
				const stop = () => {
					const reason: unknown = signal?.reason;
					stops.push(reason instanceof DOMException && reason.name === "TimeoutError" ? "timeout" : "aborted");
					reject(reason);
				};
				if (signal?.aborted) stop();
				else signal?.addEventListener("abort", stop, { once: true });
			});
		}
		if (path === "/fail") return answer(500, { error: `refused ${authorization}` });
		if (path === "/unreachable") throw new Error(`could not reach ${authorization}`);
		const item = path.match(/^\/items\/([^/]+)$/);
		if (init.method === "GET" && item !== null) return answer(200, { item: decodeURIComponent(item[1]!), query: url.search });
		if (path === "/big") {
			const chunk = new TextEncoder().encode(`${BIG_MARK} `.repeat(65_536 / (BIG_MARK.length + 1)).padEnd(65_536, "."));
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (++pulled > 32) controller.close();
					else controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			});
			request.status = 200;
			return new Response(body, { status: 200 });
		}
		return answer(404, { error: "not found" });
	};
	const empty = { type: "object", properties: {}, additionalProperties: false } as const;
	const ok = { output: [{ type: "text" as const, text: "ok" }] };
	const openTool = defineTool({
		name: "open_tool",
		description: "A hand-written tool that takes any arguments.",
		parameters: { type: "object", additionalProperties: true },
		async execute(args) {
			ran.push(args as JsonObject);
			return { output: [{ type: "text", text: "ran" }] };
		},
	});
	/** Tools that write context: over a host key or beside it, in this conversation or a new one. */
	const writes = (name: string, scope: Record<string, string>, spawn: boolean) =>
		defineTool({
			name,
			description: `Writes ${JSON.stringify(scope)} into ${spawn ? "a new" : "this"} conversation's context.`,
			parameters: empty,
			async execute(_args, api, context) {
				await api.commit(async (tx) => {
					const id = spawn ? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id : api.conversationId;
					await writeContext(tx, id, scope);
				}, context);
				return ok;
			},
		});
	const contextTools = [
		writes("rebind", { tenant: "tenant-b" }, false),
		writes("annotate", { tenant: "tenant-a", case: "c9" }, false),
		writes("spawn_rebound", { tenant: "tenant-b" }, true),
		writes("spawn", { tenant: "tenant-a", case: "c1" }, true),
	];
	return { port, fetch, requests, notes, ran, openTool, contextTools, hangAfterNextWrite: () => (hang = true), cancelled: () => cancelled, stops };
}

