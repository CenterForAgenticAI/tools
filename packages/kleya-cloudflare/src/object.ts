// @centerforagenticai/kleya-cloudflare/object: the direct Durable Object host for one root conversation (WP-14, K1).
// The shape of Earendil's pi-durable-cloudflare sample (dcb56ce2): init inside blockConcurrencyWhile, pi-durable's
// Durable Object SQLite storage (here under the journal decorator, so every commit also writes change-index rows), one
// alarm set from nextWake, hibernating Feed sockets. Kleya's changes to the sample: the object's name comes only from
// the verified tenant and conversation (conversationObjectName), the bound context is written from that name (WP-4a),
// a size guard refuses an oversized tool result as a tool error (P5), consecutive Harness failures stop the reset loop
// (P8), retention defaults follow P9, and Feed's core runs inside the object (P4).
// No `cloudflare:` import: the application's Durable Object class holds a ConversationHost and forwards its handlers.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, Harness, hook, ROOT_CONVERSATION_ID, ToolTask, type Conversation, type ConversationId, type Extension, type HarnessOptions, type HarnessSettings, type Registry, type Storage, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { ClientFrame, Commit, ConversationRef, FeedError, HarnessId, Reset, ServerFrame } from "@centerforagenticai/kleya-client/protocol";
import { writeContext } from "@centerforagenticai/kleya-server/context";
import { createFeed, type Feed, type FeedOptions } from "@centerforagenticai/kleya-server/feed";
import { nextWake, RECOVERY_DELAY_MS, type DeadlineReaders } from "@centerforagenticai/kleya-server/host";
import { openJournal } from "./journal.ts";

/** The verified identity of one root conversation. Only an authenticated caller's grant may supply it, never a URL. */
export type ConversationIdentity = { readonly tenant: string; readonly conversation: string };

export const TENANT_HEADER = "x-kleya-tenant";
export const CONVERSATION_HEADER = "x-kleya-conversation";
const NAME_PREFIX = "kleya.v1:";

/** The Durable Object name of a root conversation. Two tenants with the same conversation id get different names. */
export function conversationObjectName(identity: ConversationIdentity): string {
	if (!isIdentity(identity)) throw new TypeError("tenant and conversation must be non-empty strings");
	return NAME_PREFIX + JSON.stringify([identity.tenant, identity.conversation]);
}

/** The identity a conversationObjectName encodes, or undefined. */
export function parseObjectName(name: string): ConversationIdentity | undefined {
	if (!name.startsWith(NAME_PREFIX)) return undefined;
	try {
		const value: unknown = JSON.parse(name.slice(NAME_PREFIX.length));
		if (!Array.isArray(value) || value.length !== 2) return undefined;
		const identity = { tenant: value[0], conversation: value[1] };
		return isIdentity(identity) ? identity : undefined;
	} catch {
		return undefined;
	}
}

function isIdentity(value: { tenant: unknown; conversation: unknown }): value is ConversationIdentity {
	return typeof value.tenant === "string" && value.tenant !== "" && typeof value.conversation === "string" && value.conversation !== "";
}

export type ConversationNamespace = { getByName(name: string): { fetch(request: Request): Promise<Response> } };

/**
 * Forwards a request to the conversation's object. The Worker calls it after it verified the caller; `identity` must come
 * from that verification. Copies only the headers the host reads, so nothing else the caller sent reaches the object.
 */
export async function forwardToConversation(namespace: ConversationNamespace, identity: ConversationIdentity, request: Request, path: string): Promise<Response> {
	const headers = new Headers({ [TENANT_HEADER]: identity.tenant, [CONVERSATION_HEADER]: identity.conversation });
	for (const name of ["content-type", "upgrade"]) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
	return namespace.getByName(conversationObjectName(identity)).fetch(new Request(new URL(path, "https://conversation.kleya/"), { method: request.method, headers, body }));
}

/** A hibernatable WebSocket as the host uses it. */
export type HostSocket = {
	send(message: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
};

/** The parts of DurableObjectState the host uses. */
export type HostState = {
	readonly id: { readonly name?: string };
	readonly storage: DurableObjectSqliteStorage & {
		getAlarm(): Promise<number | null>;
		setAlarm(scheduledTime: number): Promise<void>;
		deleteAlarm(): Promise<void>;
		/** Resolves once earlier writes are durable. */
		sync(): Promise<void>;
	};
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
	acceptWebSocket(socket: HostSocket): void;
	getWebSockets(): HostSocket[];
	abort(reason?: string): void;
};

/** K7 events. `stopped`: the object reached `maxFailures` consecutive failures and serves only 503 until reset by hand. */
export type HostEvent = { readonly type: "open_failed" | "harness_failed" | "stopped" | "report"; readonly failures?: number; readonly error: string };

export type HostConfig = {
	readonly models: HarnessOptions["models"];
	/** The application's registry. The host installs its size guard into it. */
	readonly registry: Registry;
	/** Harness settings. `documentRetentionMs` and `contextRetentionMs` default to 0: a retention timer keeps the object from being evicted (P9). */
	readonly settings?: HarnessSettings;
	/** Root conversation setup, after the host wrote the bound context `{tenant, conversation}`. */
	readonly init?: (tx: Tx, id: ConversationId, identity: ConversationIdentity) => void | Promise<void>;
	readonly deadlines?: DeadlineReaders;
	/** Largest stored tool result and turn text (P5). Default 1 MiB, half the platform's 2 MB row limit. */
	readonly maxEntryBytes?: number;
	/** Consecutive failures before the object stops resetting (P8). Default 3. */
	readonly maxFailures?: number;
	readonly recoveryDelayMs?: number;
	readonly feed?: Omit<FeedOptions, "harnessId">;
	readonly report?: (event: HostEvent) => void;
};

type Attachment = { conv: ConversationRef; cursor: string | null };

const ROOT = ROOT_CONVERSATION_ID as ConversationId;
const DEFAULT_OUTPUT_BYTES = 50 * 1024;
/** Longest requestId a turn may carry; it is stored in the submissions table. */
const MAX_REQUEST_ID = 256;
/** A turn body may exceed its stored text by this much (the requestId and JSON framing). */
const BODY_SLACK = 4096;
const encoder = new TextEncoder();
const WAKE: Reset = { t: "reset", reason: "wake", reload: "live" };
const UNAVAILABLE: FeedError = { t: "error", code: "unavailable", retry: "reattach" };
const FORBIDDEN: FeedError = { t: "error", code: "forbidden", retry: "never" };
const serialized = new WeakMap<object, string>();

declare const WebSocketPair: new () => { 0: HostSocket; 1: HostSocket };

function send(socket: HostSocket, frame: ServerFrame): void {
	let text = serialized.get(frame);
	if (text === undefined) serialized.set(frame, (text = JSON.stringify(frame)));
	try {
		socket.send(text);
	} catch {
		// A closed socket; webSocketClose removes it.
	}
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const message = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const bytes = (value: unknown) => (value === undefined ? 0 : encoder.encode(JSON.stringify(value)).length);

/** The body as text, or undefined once it passes `max` bytes; the rest is never read. */
async function readBounded(request: Request, max: number): Promise<string | undefined> {
	const reader = request.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		all.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
}

function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

/**
 * P5. Refuses, as a tool error, a result whose stored size would exceed `maxEntryBytes`: output counts up to the tool's
 * own output limit (pi bounds it after this hook), details and structured output count in full.
 */
export function sizeGuard(registry: Registry, maxEntryBytes: number): Extension {
	return defineExtension({
		name: "kleya.size-guard",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result: ToolExecutionResult) => {
					const limit = registry.snapshot().tools().find((t) => t.tool.name === call.name)?.tool.outputLimits?.maxBytes ?? DEFAULT_OUTPUT_BYTES;
					const size = Math.min(bytes(result.output), limit) + bytes(result.details) + bytes(result.structuredOutput);
					if (size <= maxEntryBytes) return undefined;
					return { output: [{ type: "text", text: `${call.name} returned about ${size} bytes; a stored result may hold ${maxEntryBytes}. The result was refused.` }], isError: true };
				},
			}),
		],
	});
}

export class ConversationHost {
	readonly #state: HostState;
	readonly #config: HostConfig;
	readonly #ready: Promise<void>;
	#identity: ConversationIdentity | undefined;
	#harness: Harness | undefined;
	#storage: Storage | undefined;
	#root: Conversation | undefined;
	#feed: Feed | undefined;
	#conv: ConversationRef | undefined;
	#stopped = false;
	#closed = false;
	readonly #sockets = new Map<HostSocket, () => void>();
	#alarmUpdate: Promise<void> = Promise.resolve();
	readonly #watched = new Set<number>();

	constructor(state: HostState, config: HostConfig) {
		this.#state = state;
		this.#config = config;
		this.#ready = state.blockConcurrencyWhile(() => this.#start());
	}

	#rows(sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
		return this.#state.storage.sql.exec(sql, ...params).toArray() as Record<string, unknown>[];
	}
	#get(key: string): string | undefined {
		return this.#rows("SELECT value FROM kleya_object WHERE key = ?", key)[0]?.value as string | undefined;
	}
	#set(key: string, value: string): void {
		this.#rows("INSERT INTO kleya_object (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}
	#report(event: HostEvent): void {
		try {
			this.#config.report?.(event);
		} catch {
			// Reporting never changes the host's behaviour.
		}
	}
	#fail(type: "open_failed" | "harness_failed", error: unknown): void {
		const failures = Number(this.#get("failures") ?? "0") + 1;
		this.#set("failures", String(failures));
		this.#report({ type, failures, error: message(error) });
	}

	async #start(): Promise<void> {
		this.#rows("CREATE TABLE IF NOT EXISTS kleya_object (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const name = this.#state.id.name;
		const stored = this.#get("identity");
		// A named object takes its identity from its name; an alarm may wake it without one, so the first open stores it.
		this.#identity = name !== undefined ? parseObjectName(name) : stored === undefined ? undefined : (JSON.parse(stored) as ConversationIdentity);
		if (this.#identity !== undefined && stored === undefined) this.#set("identity", JSON.stringify(this.#identity));
		// P4: sockets restored after hibernation reattach by cursor.
		for (const socket of this.#state.getWebSockets()) send(socket, WAKE);
		if (this.#identity !== undefined) await this.#open(this.#identity);
	}

	async #open(identity: ConversationIdentity): Promise<void> {
		const failures = Number(this.#get("failures") ?? "0");
		if (failures >= (this.#config.maxFailures ?? 3)) {
			this.#stopped = true;
			await this.#state.storage.deleteAlarm();
			this.#report({ type: "stopped", failures, error: "too many consecutive failures; the object no longer resets" });
			return;
		}
		try {
			const guard = sizeGuard(this.#config.registry, this.#config.maxEntryBytes ?? 1024 * 1024);
			this.#config.registry.install(guard);
			const chosen = this.#config.settings?.extensions;
			const settings: HarnessSettings = { documentRetentionMs: 0, contextRetentionMs: 0, ...this.#config.settings, ...(chosen === undefined ? {} : { extensions: [...chosen, guard] }) };
			const { storage } = await openJournal(new DurableObjectSqliteDatabase(this.#state.storage));
			const harness = await Harness.open(storage, { models: this.#config.models, registry: this.#config.registry, settings, onReport: (error) => this.#report({ type: "report", error: message(error) }) }, ctx);
			void harness.closed
				.then(async (end) => {
					if (end.reason !== "failed") return;
					try {
						// The count is made durable before the reset: abort discards writes not yet flushed.
						this.#fail("harness_failed", end.error);
						await this.#state.storage.sync();
					} catch (error) {
						this.#report({ type: "report", error: message(error) });
					} finally {
						// A failed Harness never serves again, even when its failure could not be counted.
						this.#state.abort("Harness failed");
					}
				})
				.catch(() => {
					// abort throws to end the object's current work; there is nothing left to do here.
				});
			const root = await harness.root(ctx, {
				init: async (tx, id) => {
					await writeContext(tx, id, { tenant: identity.tenant, conversation: identity.conversation });
					await this.#config.init?.(tx, id, identity);
				},
			});
			let harnessId = this.#get("harness_id") as HarnessId | undefined;
			if (harnessId === undefined) this.#set("harness_id", (harnessId = `h_${crypto.randomUUID()}`));
			this.#harness = harness;
			this.#storage = storage;
			this.#root = root;
			this.#conv = { harnessId, conversationId: ROOT };
			this.#feed = createFeed(harness, { ...this.#config.feed, harnessId });
			await this.#refreshAlarm();
		} catch (error) {
			// The platform discards the writes of an event that throws, so the count is made durable first.
			this.#fail("open_failed", error);
			await this.#state.storage.sync();
			throw error;
		}
	}

	async fetch(request: Request): Promise<Response> {
		await this.#ready;
		const identity = this.#identity;
		if (identity === undefined || request.headers.get(TENANT_HEADER) !== identity.tenant || request.headers.get(CONVERSATION_HEADER) !== identity.conversation) {
			return json(403, { error: "forbidden" });
		}
		const root = this.#root;
		if (this.#stopped || this.#closed || root === undefined) return json(503, { error: "unavailable" });
		const { pathname } = new URL(request.url);
		if (pathname === "/conversation" && request.method === "GET") return json(200, this.#conv);
		if (pathname === "/turn" && request.method === "POST") return this.#turn(root, request);
		const status = /^\/turn\/([^/]+)$/.exec(pathname);
		if (status !== null && request.method === "GET") {
			const requestId = decodeSegment(status[1]!);
			if (requestId === undefined) return json(400, { error: "invalid_turn" });
			const record = await this.#storage!.submissionByRequest(ROOT, requestId, ctx);
			return record === undefined ? json(404, { error: "not_found" }) : json(200, { status: record.status });
		}
		if (pathname === "/feed" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			const pair = new WebSocketPair();
			this.#state.acceptWebSocket(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
		}
		return json(404, { error: "not_found" });
	}

	/**
	 * One turn. pi dedupes a retried requestId to the same submission (P7). Answers once admitted; the alarm recovers it.
	 * Text larger than `maxEntryBytes` as stored JSON, or a requestId over 256 characters, is refused `too_large` before
	 * anything is stored: a row over the platform limit would fail the Session.
	 */
	async #turn(root: Conversation, request: Request): Promise<Response> {
		const maxEntryBytes = this.#config.maxEntryBytes ?? 1024 * 1024;
		const raw = await readBounded(request, maxEntryBytes + BODY_SLACK);
		if (raw === undefined) return json(413, { error: "too_large" });
		let body: { requestId?: unknown; text?: unknown } | undefined;
		try {
			body = JSON.parse(raw) as typeof body;
		} catch {
			body = undefined;
		}
		if (typeof body !== "object" || body === null || typeof body.requestId !== "string" || body.requestId === "" || typeof body.text !== "string") return json(400, { error: "invalid_turn" });
		if (body.requestId.length > MAX_REQUEST_ID || bytes(body.text) > maxEntryBytes) return json(413, { error: "too_large" });
		await this.#setAlarmNoLaterThan(Date.now() + (this.#config.recoveryDelayMs ?? RECOVERY_DELAY_MS));
		const submission = await root.submit({ type: "input", content: body.text, requestId: body.requestId, whenBusy: "followUp" }, ctx);
		void submission
			.wait(ctx)
			.then((settled) => {
				if (settled.status === "done") this.#set("failures", "0");
				return this.#refreshAlarm();
			})
			.catch((error: unknown) => this.#report({ type: "report", error: message(error) }));
		return json(202, { requestId: body.requestId, submission: submission.id });
	}

	async alarm(): Promise<void> {
		await this.#ready;
		if (this.#harness !== undefined && !this.#closed) await this.#refreshAlarm();
	}

	async webSocketMessage(socket: HostSocket, data: string | ArrayBuffer): Promise<void> {
		await this.#ready;
		let frame: ClientFrame;
		try {
			frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as ClientFrame;
		} catch {
			socket.close(1002, "invalid frame");
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
			socket.close(1002, "invalid frame");
			return;
		}
		const feed = this.#feed;
		const conv = this.#conv;
		if (feed === undefined || conv === undefined || this.#closed || this.#stopped) return send(socket, UNAVAILABLE);
		if (frame.t === "attach") return this.#attach(socket, feed, conv, frame);
		if (frame.t === "since") {
			// A socket attached before a wake must reattach first (P4).
			if (!this.#sockets.has(socket)) return send(socket, UNAVAILABLE);
			const page = await feed.since(conv, { t: "since", after: frame.after, through: frame.through, ...(frame.maxBytes === undefined ? {} : { maxBytes: frame.maxBytes }) }, ctx);
			if (page.t === "page") socket.serializeAttachment({ conv, cursor: frame.after } satisfies Attachment);
			return send(socket, page);
		}
		// RV1 takes turns over the HTTP route only.
		send(socket, FORBIDDEN);
	}

	async #attach(socket: HostSocket, feed: Feed, conv: ConversationRef, frame: Extract<ClientFrame, { t: "attach" }>): Promise<void> {
		if (frame.conv?.harnessId !== conv.harnessId || frame.conv.conversationId !== conv.conversationId) return send(socket, FORBIDDEN);
		this.#sockets.get(socket)?.();
		this.#sockets.delete(socket);
		// Subscribe before reading the watermark, and hold commit frames until `attached` is sent: none is lost in between.
		const held: Commit[] = [];
		let live = false;
		const stop = feed.subscribe(conv.conversationId, (commit) => (live ? send(socket, commit) : held.push(commit)));
		const result = await feed.attach({ t: "attach", conv, ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }) }, ctx);
		if (result.t !== "attached") {
			stop();
			return send(socket, result);
		}
		this.#sockets.set(socket, stop);
		socket.serializeAttachment({ conv, cursor: frame.cursor ?? null } satisfies Attachment);
		send(socket, result);
		live = true;
		for (const commit of held) send(socket, commit);
	}

	async webSocketClose(socket: HostSocket, code: number, reason: string): Promise<void> {
		this.#sockets.get(socket)?.();
		this.#sockets.delete(socket);
		try {
			socket.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/** test:dispose. Stops every Feed subscription and closes the Harness. Idempotent; later requests get 503. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const stop of this.#sockets.values()) stop();
		this.#sockets.clear();
		this.#feed?.dispose();
		await this.#harness?.close(ctx);
	}

	// The alarm, as in the sample: every update runs in order; a live task holds a recovery wake until it settles.
	#serializeAlarmUpdate(update: () => Promise<void>): Promise<void> {
		const next = this.#alarmUpdate.then(update, update);
		this.#alarmUpdate = next.catch(() => {});
		return next;
	}

	#refreshAlarm(): Promise<void> {
		return this.#serializeAlarmUpdate(async () => {
			const harness = this.#harness;
			if (harness === undefined || this.#closed) return;
			const wake = nextWake(await harness.inspect(ctx), this.#config.deadlines ?? {}, Date.now(), this.#config.recoveryDelayMs);
			await this.#replaceAlarm(wake.at);
			// waitForTask starts the scheduler, so the recovery alarm is stored first.
			for (const id of wake.resume) {
				if (this.#watched.has(id)) continue;
				this.#watched.add(id);
				void harness
					.waitForTask(id as Parameters<Harness["waitForTask"]>[0], ctx)
					.then(() => this.#refreshAlarm())
					.catch((error: unknown) => this.#report({ type: "report", error: message(error) }))
					.finally(() => this.#watched.delete(id));
			}
		});
	}

	async #replaceAlarm(at: number | undefined): Promise<void> {
		const current = await this.#state.storage.getAlarm();
		if (at === undefined) {
			if (current !== null) await this.#state.storage.deleteAlarm();
		} else if (current !== at) {
			await this.#arm(at);
		}
	}

	#setAlarmNoLaterThan(at: number): Promise<void> {
		return this.#serializeAlarmUpdate(async () => {
			const current = await this.#state.storage.getAlarm();
			if (current === null || at < current) await this.#arm(at);
		});
	}

	#arm(at: number): Promise<void> {
		return this.#state.storage.setAlarm(at);
	}
}
