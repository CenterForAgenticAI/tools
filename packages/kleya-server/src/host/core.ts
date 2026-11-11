// The session host core (K1, spec 5.2): the ports, the turn API types, session ids and the host that opens sessions.
// Platform-free (MIN-11): the adapter supplies the ports. Importing this module loads no runtime: pi-durable loads with
// ./session.ts when the host opens its first session.
import type { Context, ContextKey } from "@earendil-works/chord/context";
import type { AgentChange, HarnessSettings, RegistryReader, Storage, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import type {
	Accepted,
	FeedError,
	HarnessId,
	Rejected,
	SessionCursor,
	SessionPage,
	TurnCursor,
	TurnPage,
	TurnStatus,
	WhenBusy,
} from "@centerforagenticai/kleya-client/protocol";
import type { ChangeIndex } from "../feed.ts";
import type { Open } from "./session.ts";

/** What a session belongs to: a product and its ordered scope values, such as a tenant and a thread. */
export type Scope = { readonly product: string; readonly keys: readonly string[] };

/** A writer's claim on a session. A later `acquire` fences every earlier one: their writes fail (K1-I2). */
export type Fence = { readonly epoch: number };
/** A session's store and its change index, written in the same commits. */
export type SessionStore = { readonly storage: Storage; readonly changes: ChangeIndex };

/** What a platform supplies (spec 5.1 "Host adapters"). Serial init, sync, idle and forward arrive with the Node and Cloudflare adapters. */
export interface HostPorts {
	readonly owner: {
		acquire(id: HarnessId, context: Context): Promise<Fence>;
		release(id: HarnessId, fence: Fence): Promise<void>;
	};
	readonly storage: {
		/**
		 * Opens the session's store; its commits fail once `fence` is stale. The change index's `store` name must outlive
		 * the process: a durable adapter persists it with the store, or every cursor expires at the next open.
		 */
		open(id: HarnessId, fence: Fence, context: Context): Promise<SessionStore>;
		/** Deletes a closed session's store, so a reused scope starts empty and its old cursors expire (K1-I9). */
		drop(id: HarnessId, context: Context): Promise<void>;
	};
	/**
	 * The session's wake-up, kept by the adapter. The host sets it whenever the session's next wake changes: `at` is when
	 * to call `Host.wake`, and undefined clears it. A running turn sets it RECOVERY_DELAY_MS ahead, in case its process
	 * dies. Sets are made in order and not awaited by the turn that caused them; a failed set is dropped. While the
	 * session is open the host runs its sleeps itself; the alarm is for a session that is closed or whose process died.
	 * `scope` is for the wake call only: it must not reach a file name or a log (use `sessionName`). Without this port, a
	 * sleeping task runs only while its session stays open.
	 */
	readonly alarm?: {
		set(id: HarnessId, scope: Scope, at: number | undefined, context: Context): Promise<void>;
	};
}

/**
 * The model gateway, a product port (K6). The host reaches models only through it: every model request goes to the
 * base URL `access` returns, with the credential the gateway issued for this session. A catalog model's own `baseUrl`
 * is ignored. No field here or anywhere in HostOptions takes a provider key (D-7). The credential stays in memory: the
 * host stores, logs and reports none of it. Every request for a turn's model call carries an `idempotency-key` header
 * that names the call: the same for every send of it, through retries, new attempts of its turn and host recovery, and
 * different for every other call. A gateway that sees a key again may answer from the first request.
 */
export type Gateway = {
	/** The models the agent may name, grouped into providers by their `provider` field. */
	readonly models: readonly Model<Api>[];
	/**
	 * The wire protocol the gateway speaks, such as pi-ai's OpenAI completions API: one for every model, or one per
	 * `model.api` when the models use more than one, as OpenRouter's Anthropic models use Anthropic messages.
	 */
	readonly streams: ProviderStreams | Partial<Record<Api, ProviderStreams>>;
	/** Called before every model request. */
	access(scope: Scope, context: Context): Promise<{ readonly baseUrl: string; readonly credential: string }>;
};

/** A right a caller holds in one session (spec 5.3.3). The edge maps the caller's role to rights; the core checks them again. */
export type Right = "read" | "submit" | "steer" | "cancel";
/**
 * Who calls the turn API: a separate argument the edge fills from the authenticated principal, never from a request
 * body, a submit payload, or anything a model or tool writes. Principals starting `host:` are the host's own; a caller
 * that names one is refused.
 */
export type Caller = { readonly principal: string; readonly rights: readonly Right[] };

/** The turn a product credential is for. `principal` is undefined for a turn the host started (a schedule, a subagent). */
export type Turn = { readonly requestId: string; readonly attempt: number; readonly principal: string | undefined };

/**
 * The credential port, a product port (spec 5.3.4 "Credential binding"). The product mints a credential for one turn:
 * this scope, request id and attempt, minted for `turn.principal`. Called at a turn's first tool call that asks for it,
 * again after a restart, never with anything a tool supplied.
 */
export type CredentialPort = (scope: Scope, turn: Turn, context: Context) => Promise<string>;

export type HostOptions = {
	readonly ports: HostPorts;
	readonly gateway: Gateway;
	readonly credential?: CredentialPort;
	readonly registry: RegistryReader;
	/** The root conversation's agent, configured when the session is created. */
	readonly agent: AgentChange;
	readonly settings?: HarnessSettings;
	/**
	 * Attempts per request id, default 4. A failed turn submitted again under its id and payload runs again, up to this
	 * many attempts in all; past it, the failed result stands.
	 */
	readonly maxAttempts?: number;
	/**
	 * How long a seen marker is kept after its request record's LIMITS.requestRetentionMs ends (spec 5.2 "Retention"):
	 * a retry of the id meanwhile is `too_old`, and after it the id is unknown and accepted as new. Default 90 days,
	 * between 1 and 365 days; createHost throws a RangeError outside them.
	 */
	readonly markerRetentionMs?: number;
	readonly now?: () => number;
	/**
	 * The session's context keys, such as `{ tenant: scope.keys[0] }` (spec 5.3, `ContextDoc`). The host writes them into
	 * every conversation the session creates, the root and each subagent's, in the creating commit. Tools read bound
	 * values from them, never from the model. Host keys win: a product may add keys to a conversation, never change one.
	 */
	readonly context?: (scope: Scope) => Readonly<Record<string, string>>;
};

/**
 * `credential` is the product credential for this turn, minted by the product for the caller; it saves a call to the
 * credential port. It is held in memory only, and is not part of the request's fingerprint: a retry may carry a new one.
 */
export type SubmitOptions = { readonly whenBusy?: WhenBusy; readonly conversation?: number; readonly credential?: string };
export type FollowOptions = { readonly after?: TurnCursor; readonly conversation?: number; readonly waitMs?: number };

/**
 * The turn API of one session (spec 5.2). Every call names its caller and is checked against the caller's rights:
 * `submit` needs submit, and steer as well for `whenBusy: "steer"`; `abort` needs cancel; `status`, `follow` and
 * `followSession` need read. A refused read answers `forbidden` before anything is looked up. A steer must also come
 * from the principal whose input started the running turn. Request ids starting `host:` name turns the host started:
 * any caller with read may follow them, none may submit under them.
 */
export interface SessionHost {
	readonly id: HarnessId;
	submit(caller: Caller, requestId: string, text: string, options: SubmitOptions, context: Context): Promise<Accepted | Rejected | FeedError>;
	status(caller: Caller, requestId: string, context: Context, conversation?: number): Promise<TurnStatus | FeedError>;
	follow(caller: Caller, requestId: string, options: FollowOptions, context: Context): Promise<TurnPage | FeedError>;
	/** A stored command with its own request id, `abortId`; it names the turn and returns its status. */
	abort(caller: Caller, requestId: string, abortId: string, context: Context, conversation?: number): Promise<TurnStatus | Rejected | FeedError>;
	followSession(caller: Caller, options: { readonly after?: SessionCursor; readonly waitMs?: number }, context: Context): Promise<SessionPage | FeedError>;
}

export interface Host {
	session(scope: Scope, context: Context): Promise<SessionHost>;
	/** Opens the session if it is not open, and resumes its due tasks: what an adapter calls when the alarm fires. */
	wake(scope: Scope, context: Context): Promise<void>;
	/**
	 * Closes the session when it is idle: no task that needs to run now, and no call in flight on its SessionHost. Returns
	 * whether the session is closed; a busy one stays open. The store, its cursors and the alarm are kept, so the next
	 * `session` or `wake` reopens it where it was. A SessionHost obtained before the release must not be used after it.
	 */
	release(scope: Scope, context: Context): Promise<boolean>;
	/** Closes the session, deletes its store and clears its alarm. */
	drop(scope: Scope, context: Context): Promise<void>;
	/** Closes every session. Idempotent. */
	close(context: Context): Promise<void>;
}

// --- Turns the host starts, and their credentials ---

/**
 * The request id product code inside the host gives a turn it starts, such as a scheduled task's: `host:<kind>:<id>`.
 * Session follow lists the turn under it. A pi-durable input with no such id, such as a subagent's, is listed as
 * `host:submission:<n>`, `n` being its stored submission id.
 */
export function hostRequestId(kind: string, id: string): string {
	if (!/^[a-z][a-z0-9-]*$/.test(kind) || kind === "submission") throw new Error(`hostRequestId: invalid kind ${JSON.stringify(kind)}`);
	return `host:${kind}:${id}`;
}

/** The turn a running tool call belongs to, and that turn's product credential. */
export type TurnCredential = Turn & { readonly credential: string };
/** What a tool passes: its pi-durable ToolExecutionApi, of which the lookup reads the conversation and its run. */
export type ToolCallView = Pick<ToolExecutionApi, "conversationId" | "snapshot">;
/** @internal Set by the session on its Harness's context, so it reaches every tool call. */
export const TURN_CREDENTIALS: ContextKey<(call: ToolCallView, context: Context) => Promise<TurnCredential | undefined>> = Object.freeze({ token: Symbol("kleya.turn-credentials") });

/**
 * The product credential of the turn a tool call runs in, from the credential port or the submit that carried it.
 * Undefined when the host has no credential port, when the call runs outside a host session, or when its run answers
 * inputs from more than one principal: such a run acts for no one. Rejects without the port's error text.
 */
export function turnCredential(call: ToolCallView, context: Context): Promise<TurnCredential | undefined> {
	return context.value(TURN_CREDENTIALS)?.(call, context) ?? Promise.resolve(undefined);
}

/**
 * @internal Set by the session on its Harness's context: the session id and its store's id, for call keys. The store id
 * is a random id the store itself holds (`kleya.store`), so it outlives every process and changes when the store is
 * dropped and recreated, as task ids start over.
 */
export const HOST_SESSION: ContextKey<{ readonly id: HarnessId; store: string }> = Object.freeze({ token: Symbol("kleya.host-session") });

/**
 * A tool call's idempotency key (spec 5.4, D33): `kleya1.` and the base64url SHA-256 of a domain-separated encoding of
 * the session id, its store's name and the call's task id. One logical call keeps it across retries and restarts; the
 * same task id in a dropped and recreated store gets a new one. It is opaque and bounded, so no scope value reaches a
 * product's logs through it. Throws outside a host session.
 */
export async function callKey(call: Pick<ToolExecutionApi, "taskId">, context: Context): Promise<string> {
	const session = context.value(HOST_SESSION);
	if (session === undefined || session.store === "") throw new Error("a call key needs a Kleya host session");
	const encoded = JSON.stringify(["kleya.call-key.v1", session.id, session.store, call.taskId]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
	return `kleya1.${base64urlBytes(new Uint8Array(digest))}`;
}

// --- Session ids (K1-I9) ---

function base64urlBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64url(text: string): string {
	return base64urlBytes(new TextEncoder().encode(text));
}

/** Injective: `kleya.v1:` + the JSON array of the product and the scope values, base64url-encoded. */
export function harnessIdOf(scope: Scope): HarnessId {
	return `h_${base64url(`kleya.v1:${JSON.stringify([scope.product, ...scope.keys])}`)}`;
}

/** Hex SHA-256 of `text`. */
export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The name a session id takes in a path or a log: a SHA-256 separated by `domain`, so it reveals no scope value. */
export function sessionName(id: HarnessId, domain: string): Promise<string> {
	return sha256(`kleya.v1.${domain}\u0000${id}`);
}

/** How long a live task with no deadline may sit before the host wakes to resume it (the sample's recovery delay). */
export const RECOVERY_DELAY_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** @internal Request record retention: the marker option's default and bounds, and how the host's passes run. */
export const RETENTION = {
	markerDefaultMs: 90 * DAY_MS,
	markerMinMs: DAY_MS,
	markerMaxMs: 365 * DAY_MS,
	/** An open session starts a pass after a call at most this often; a session also prunes as it opens. */
	everyMs: 60 * 60 * 1000,
	/** Records read and decided per commit. */
	batch: 64,
} as const;

export function createHost(options: HostOptions): Host {
	const { ports } = options;
	const now = options.now ?? Date.now;
	const maxAttempts = options.maxAttempts ?? 4;
	const markerMs = options.markerRetentionMs ?? RETENTION.markerDefaultMs;
	// A zero marker would let a resend of an old id run a second turn the moment its request window ends.
	if (!(markerMs >= RETENTION.markerMinMs && markerMs <= RETENTION.markerMaxMs)) throw new RangeError(`markerRetentionMs must be between ${RETENTION.markerMinMs} and ${RETENTION.markerMaxMs}`);
	const sessions = new Map<HarnessId, Promise<Open>>();
	/** Sessions being closed: a reopen waits for the close, so the old Harness is gone before the new one starts. */
	const closing = new Map<HarnessId, Promise<void>>();
	let closed = false;

	async function open(id: HarnessId, scope: Scope, context: Context): Promise<Open> {
		await closing.get(id);
		return import("./session.ts").then((m) => m.openSession(id, scope, options, maxAttempts, markerMs, now, context));
	}

	function opened(id: HarnessId, scope: Scope, context: Context): Promise<Open> {
		if (closed) return Promise.reject(new Error("host is closed"));
		let pending = sessions.get(id);
		if (pending === undefined) {
			pending = open(id, scope, context);
			sessions.set(id, pending);
			pending.catch(() => sessions.delete(id));
		}
		return pending;
	}

	/** Closes one open session. Synchronous up to its first await, so a caller's idle check still holds when it starts. */
	function closeOpen(id: HarnessId, s: Open, context: Context): Promise<void> {
		sessions.delete(id);
		const done = s.close(context).finally(() => {
			if (closing.get(id) === done) closing.delete(id);
		});
		closing.set(id, done);
		return done;
	}

	async function closeOne(id: HarnessId, context: Context) {
		const pending = sessions.get(id);
		if (pending === undefined) return closing.get(id);
		sessions.delete(id);
		const s = await pending.catch(() => undefined);
		if (s !== undefined) await closeOpen(id, s, context);
	}

	return {
		async session(scope, context) {
			return (await opened(harnessIdOf(scope), scope, context)).session;
		},
		async wake(scope, context) {
			const id = harnessIdOf(scope);
			const wasOpen = sessions.has(id);
			const s = await opened(id, scope, context);
			// A fresh open resumes its tasks itself.
			if (wasOpen) s.harness.resume();
		},
		async release(scope, context) {
			const id = harnessIdOf(scope);
			const pending = sessions.get(id);
			if (pending === undefined) {
				await closing.get(id);
				return true;
			}
			const s = await pending.catch(() => undefined);
			// Opened again or closed by another call while this one waited.
			if (sessions.get(id) !== pending) return !sessions.has(id);
			if (s === undefined) return true;
			if (!s.idle()) return false;
			await closeOpen(id, s, context);
			return true;
		},
		async drop(scope, context) {
			const id = harnessIdOf(scope);
			await closeOne(id, context);
			await ports.storage.drop(id, context);
			await ports.alarm?.set(id, scope, undefined, context);
		},
		async close(context) {
			closed = true;
			await Promise.all([...sessions.keys()].map((id) => closeOne(id, context)));
		},
	};
}
