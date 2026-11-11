// One open session: its Harness, its request records and the four turn operations over it (spec 5.2). Loaded by
// createHost when it opens a session, so importing the host loads no pi-durable runtime.
import { BACKGROUND_CONTEXT, withAbortSignal, withContextValue, type Context } from "@earendil-works/chord/context";
import { createModels, createProvider, lazyStream, type Api, type Model, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	ConversationBusy,
	defineDoc,
	defineDocFamily,
	GenerationTask,
	Harness,
	LiveDoc,
	ProviderDoc,
	ROOT_CONVERSATION_ID,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryId,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
	type Wake,
} from "@earendil-works/pi-durable";
import {
	decodeSessionCursor,
	decodeTurnCursor,
	encodeSessionCursor,
	encodeTurnCursor,
	LIMITS,
	type ConversationRef,
	type FeedError,
	type HarnessId,
	type Rejected,
	type RejectReason,
	type SessionEvent,
	type SessionPosition,
	type TurnEvent,
	type TurnOutcome,
	type TurnStatus,
} from "@centerforagenticai/kleya-client/protocol";
import type { ChangeIndex } from "../feed.ts";
import { liveText, page, readStored } from "./turn.ts";
import { writeContext } from "../context.ts";
import { checkScopeKey } from "../scope-keys.ts";
import { HOST_SESSION, sha256, TURN_CREDENTIALS, type Caller, type CredentialPort, type Fence, type Gateway, type HostOptions, type HostPorts, type Right, type Scope, type SessionHost, type SessionStore, type ToolCallView, type Turn, type TurnCredential, RECOVERY_DELAY_MS, RETENTION } from "./core.ts";

// --- Request records (spec 5.2 "Commands, ids and retention") ---

/**
 * One per request id and conversation, kept whole for LIMITS.requestRetentionMs from `at`; then the pruner deletes it
 * and keeps only the id's seen marker (`Seen`, spec 5.2 "Retention").
 */
type RequestRecord = { digest: string; at: number; principal: string; attempts: number[]; cancels: string | null; cancelledBy: string | null };
type Seed = { digest: string; at: number; principal: string };
const REQUEST_KIND = "kleya.request";
const Requests = defineDocFamily<RequestRecord, Seed>({
	kind: REQUEST_KIND,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	initial: (seed) => ({ digest: seed.digest, at: seed.at, principal: seed.principal, attempts: [], cancels: null, cancelledBy: null }),
	checkpointWhen: () => false,
});

/**
 * An id's seen marker, created with its request record in the same commit, so a commit that reads it finds every id the
 * conversation remembers. `outcome` stays null while the record is whole; the pruner sets it when it deletes the
 * record, and `due` to the record's `at` + LIMITS.requestRetentionMs + markerRetentionMs. Uses of a marked id are
 * `too_old` (`conflict` for another payload). After `due` the pruner deletes the marker, and the id is unknown again.
 * Kept apart from the records so that a pass reads only what is due (`sweep`).
 */
type SeenRecord = { digest: string; at: number; outcome: TurnOutcome | "abort" | null; due: number };
const SEEN_KIND = "kleya.seen";
const Seen = defineDocFamily<SeenRecord, SeenRecord>({
	kind: SEEN_KIND,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	initial: (seed) => ({ digest: seed.digest, at: seed.at, outcome: seed.outcome, due: seed.due }),
	checkpointWhen: () => false,
});
/** Seeds for a read of a record the caller knows exists: a seeded value names a record that was not there. */
const NO_REQUEST: Seed = { digest: "", at: 0, principal: "" };
const NO_SEEN: SeenRecord = { digest: "", at: 0, outcome: null, due: 0 };

/** The store's own id, written once when the store is created: call keys name it (`callKey`). */
const StoreId = defineDoc<{ id: string }>({ kind: "kleya.store", version: 1, scope: "session", initial: () => ({ id: "" }), checkpointWhen: () => true });

/**
 * pi-durable's request id for one attempt of a caller's request. It names the record's `at`, so an id used again after
 * its marker was deleted gets new submissions: pi-durable keeps every submission and returns the stored one for a
 * request id it has seen.
 */
const attemptId = (requestId: string, at: number, attempt: number) => `kleya:${attempt}:${at}:${requestId}`;

/**
 * The name a turn has in the turn API, from its stored submission: a caller's request id, the `host:<kind>:<id>` that
 * product code in the host gave it, or `host:submission:<n>` from its stored id when it has neither. Writes are not
 * turns. Derived from stored data only, so it survives a reopen.
 */
function turnName(submission: { id: number; type?: string; requestId?: string }): { requestId: string; attempt: number } | undefined {
	if (submission.type === "write") return undefined;
	const internal = submission.requestId;
	const caller = internal?.match(/^kleya:(\d+):\d+:(.*)$/s);
	if (caller !== null && caller !== undefined) return { requestId: caller[2]!, attempt: Number(caller[1]) };
	if (internal?.startsWith("host:") && !internal.startsWith("host:submission:")) return { requestId: internal, attempt: 1 };
	return { requestId: `host:submission:${submission.id}`, attempt: 1 };
}

class Refusal extends Error {
	readonly reason: RejectReason;
	constructor(reason: RejectReason) {
		super(reason);
		this.reason = reason;
	}
}

const NOT_FOUND: FeedError = { t: "error", code: "not_found", retry: "never" };
const INVALID_CURSOR: FeedError = { t: "error", code: "invalid_cursor", retry: "reattach" };
const UNAVAILABLE: FeedError = { t: "error", code: "unavailable", retry: "reattach" };
/** A read the caller has no right to: the same answer whether the request id exists or not. */
const FORBIDDEN: FeedError = { t: "error", code: "forbidden", retry: "never" };

/** A follow call's wait: at most LIMITS.followWaitMs, and that much when `waitMs` is not a finite number (K2-I9). */
const waitOf = (waitMs: number | undefined) => (waitMs !== undefined && Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), LIMITS.followWaitMs) : LIMITS.followWaitMs);
/** Conversation ids are positive integers; anything else names no conversation. */
const validConversation = (conversation: number) => Number.isSafeInteger(conversation) && conversation > 0;
const CURSOR_EXPIRED: FeedError = { t: "error", code: "cursor_expired", retry: "reattach" };

const validId = (id: string) => id.length > 0 && id.length <= LIMITS.requestIdChars && !id.startsWith("host:");
/** A caller names a principal the edge authenticated; `host:` principals are the host's own. */
const validCaller = (caller: Caller) => typeof caller.principal === "string" && caller.principal.length > 0 && !caller.principal.startsWith("host:") && Array.isArray(caller.rights);
const may = (caller: Caller, right: Right) => validCaller(caller) && caller.rights.includes(right);
const settled = (r: SubmissionRecord) => r.status === "done" || r.status === "unanswered";

function statusOf(requestId: string, conversation: number, attempt: number, r: SubmissionRecord): TurnStatus {
	const base = { t: "status" as const, requestId, conversation, attempt };
	if (r.status === "queued") return { ...base, state: "running", started: false };
	if (r.status === "placed") return { ...base, state: "running", started: true };
	if (r.status === "done") return { ...base, state: "done", started: true, outcome: "completed" };
	if (r.status !== "unanswered") return { ...base, state: "failed", started: true, outcome: "failed" };
	const started = r.entry !== undefined;
	if (r.reason === "aborted") return { ...base, state: "done", started, outcome: "cancelled", reason: r.reason };
	const outcome = r.reason === "interrupted" || r.reason === "restart_limit" ? "interrupted" : "failed";
	return { ...base, state: "failed", started, outcome, reason: r.reason };
}

/** Wakes waiters on every change a session publishes: stored commits and the deferred ones observers see first. */
class Signal {
	#waiters = new Set<() => void>();
	notify() {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const wake of waiters) wake();
	}
	/** Resolves at the next notify or after `ms`. */
	wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.#waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, ms));
			this.#waiters.add(done);
		});
	}
}

export type Open = {
	harness: Harness;
	store: SessionStore;
	fence: Fence;
	session: SessionHost;
	/** No task needs to run now and no call is in flight on `session`. */
	idle(): boolean;
	close(context: Context): Promise<void>;
};

export async function openSession(id: HarnessId, scope: Scope, options: HostOptions, maxAttempts: number, markerMs: number, now: () => number, context: Context): Promise<Open> {
	const { ports } = options;
	const credentials = new Credentials(scope, options.credential);
	const fence = await ports.owner.acquire(id, context);
	const wake = ports.alarm === undefined ? undefined : alarmFollower(id, scope, ports.alarm, now, () => harness);
	const onWake = wake?.onWake;
	let harness: Harness | undefined;
	let store: SessionStore;
	let pruned: number;
	try {
		store = await ports.storage.open(id, fence, context);
		// The Harness's context reaches every tool call, so tools find their turn's credential and their call key through it.
		const hosted = { id, store: "" };
		const toolContext = withContextValue(HOST_SESSION, hosted, withContextValue(TURN_CREDENTIALS, (call, ctx) => credentials.lookup(call, ctx), context));
		const keys = options.context?.(scope);
		// On every open, not only when a conversation is created: a reopened store's root already exists.
		for (const key of Object.keys(keys ?? {})) checkScopeKey(key, "HostOptions.context");
		// Every conversation the session creates gets the host's keys in its creating commit, before a product's init runs.
		const conversationCreated = keys === undefined ? undefined : (tx: Tx, conversation: { id: ConversationId }) => writeContext(tx, conversation.id, keys);
		harness = await Harness.open(
			store.storage,
			{
				models: gatewayModels(options.gateway, scope, (sessionId, c) => modelCallKey(harness, store.storage, hosted.store, sessionId, c)),
				registry: options.registry,
				...(options.settings === undefined ? {} : { settings: options.settings }),
				...(conversationCreated === undefined ? {} : { conversationCreated }),
				...(onWake === undefined ? {} : { onWake }),
				now,
			},
			toolContext,
		);
		credentials.attach(harness);
		await harness.root(context, { init: (tx, conversation) => configure(tx, conversation, options.agent) });
		hosted.store = await harness.commit(async (tx) => {
			const doc = await tx.doc(StoreId);
			if (doc.id === "") doc.id = crypto.randomUUID();
			return doc.id;
		}, context);
		harness.resume();
		// Before the first call: a store that was closed for days serves nothing from a record past its time.
		pruned = now();
		await prune(harness, store.storage, now, markerMs, () => false, context);
	} catch (error) {
		// Whoever acquires releases (MIN-14): a session that failed to open holds no fence and no Harness.
		await harness?.close(context).catch(() => {});
		await ports.owner.release(id, fence);
		throw error;
	}
	const opened = harness;
	const signal = new Signal();
	const unsubscribe = store.changes.subscribe(() => signal.notify());
	const views = new Map<number, Promise<{ view: ConversationView; detach(): void }>>();
	const calls = { open: 0 };
	const pruning = pruner(opened, store.storage, now, markerMs, pruned);
	const session = counted(turnSession(id, opened, store.changes, signal, views, credentials, maxAttempts, now), calls, () => pruning.after());
	return {
		harness: opened,
		store,
		fence,
		session,
		idle: () => calls.open === 0 && !opened.wake().active,
		async close(ctx) {
			wake?.stop();
			unsubscribe();
			credentials.clear();
			for (const view of views.values()) void view.then((v) => v.detach(), () => {});
			views.clear();
			signal.notify();
			await pruning.stop();
			await opened.close(ctx);
			await wake?.settled();
			await ports.owner.release(id, fence);
		},
	};
}

/**
 * Follows the Harness's next wake while the session is open. The alarm port gets one set at a time and in order, off the
 * turn's path; a failed set is dropped. With onWake the Harness arms no timer for sleeps, so this arms it, as the Harness
 * would, and arms it again when it fires early. `stop` ends both and leaves the last set in place, so a turn a close interrupted is still resumed.
 */
function alarmFollower(id: HarnessId, scope: Scope, alarm: NonNullable<HostPorts["alarm"]>, now: () => number, harness: () => Harness | undefined) {
	let sets = Promise.resolve();
	let quiet = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// A timer can fire before `at` on the host's clock, and the Harness repeats no unchanged wake: arm again until it is due.
	const arm = (at: number) => {
		timer = setTimeout(() => (quiet ? undefined : now() < at ? arm(at) : harness()?.resume()), Math.max(0, at - now()));
	};
	return {
		onWake(wake: Wake) {
			if (quiet) return;
			clearTimeout(timer);
			timer = undefined;
			if (!wake.active && wake.at !== undefined) arm(wake.at);
			const at = wake.active ? now() + RECOVERY_DELAY_MS : wake.at;
			sets = sets.then(() => alarm.set(id, scope, at, BACKGROUND_CONTEXT)).catch(() => {});
		},
		stop() {
			quiet = true;
			clearTimeout(timer);
		},
		settled: () => sets,
	};
}

/** `session` with every call counted in `calls.open` while it runs, so a release can see a follower waiting; `after` runs as each ends. */
function counted(session: SessionHost, calls: { open: number }, after: () => void): SessionHost {
	const count =
		<A extends unknown[], R>(f: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			calls.open++;
			try {
				return await f(...args);
			} finally {
				calls.open--;
				after();
			}
		};
	return {
		id: session.id,
		submit: count(session.submit),
		status: count(session.status),
		follow: count(session.follow),
		abort: count(session.abort),
		followSession: count(session.followSession),
	};
}

function turnSession(
	id: HarnessId,
	harness: Harness,
	changes: ChangeIndex,
	signal: Signal,
	views: Map<number, Promise<{ view: ConversationView; detach(): void }>>,
	credentials: Credentials,
	maxAttempts: number,
	now: () => number,
): SessionHost {
	const ref = (conversation: number): ConversationRef => ({ harnessId: id, conversationId: conversation });

	/** One observation per conversation, shared by its followers (MIN-16): the live answer and the wake-ups. */
	function view(conversation: number, context: Context) {
		let pending = views.get(conversation);
		if (pending === undefined) {
			pending = (async () => {
				const holder = { view: undefined as unknown as ConversationView, detach: () => {} };
				const observation = await harness.observeConversation(
					conversation as ConversationId,
					{
						advance(call) {
							if (call.kind === "value") holder.view = call.value;
							signal.notify();
						},
						end() {
							views.delete(conversation);
							signal.notify();
						},
					},
					context,
					{ min: 1, max: 1 },
				);
				holder.view ??= observation.value;
				if (holder.view === undefined) holder.view = observation.value;
				holder.detach = () => observation.detach();
				return holder;
			})();
			views.set(conversation, pending);
			pending.catch(() => views.delete(conversation));
		}
		return pending;
	}

	const record = (conversation: number, requestId: string, context: Context) => harness.snapshot(Requests, conversation as ConversationId, requestId, context);

	/**
	 * The submission a turn name stands for now: a caller's request id names its latest attempt; a `host:` id names one
	 * stored submission at attempt 1, found by its stored request id or, for `host:submission:<n>`, by its id.
	 */
	async function find(conversation: number, requestId: string, context: Context): Promise<{ sub: SubmissionRecord; attempt: number; caller: boolean } | undefined> {
		if (requestId.startsWith("host:")) {
			const n = requestId.match(/^host:submission:([1-9]\d{0,14})$/)?.[1];
			const sub = n !== undefined ? await (await harness.submission(Number(n) as SubmissionId, context))?.status(context) : await harness.commit((tx) => tx.submissionByRequest(conversation as ConversationId, requestId), context);
			if (sub === undefined || sub.conversationId !== conversation || turnName(sub)?.requestId !== requestId) return undefined;
			return { sub, attempt: 1, caller: false };
		}
		const r = await record(conversation, requestId, context);
		if (r === undefined || r.attempts.length === 0) return undefined;
		const sub = await (await harness.submission(r.attempts.at(-1) as SubmissionId, context))?.status(context);
		return sub === undefined ? undefined : { sub, attempt: r.attempts.length, caller: true };
	}

	const rejected = (requestId: string, reason: RejectReason): Rejected => ({ t: "rejected", requestId, reason });

	return {
		id,

		async submit(caller, requestId, text, options, context) {
			if (!may(caller, "submit")) return rejected(requestId, "forbidden");
			if (options.whenBusy === "steer" && !may(caller, "steer")) return rejected(requestId, "forbidden");
			const conversation = options.conversation ?? ROOT_CONVERSATION_ID;
			if (!validConversation(conversation)) return NOT_FOUND;
			if (!validId(requestId)) return rejected(requestId, "forbidden");
			if (new TextEncoder().encode(text).length > LIMITS.textBytes) return rejected(requestId, "too_large");
			const target = await harness.conversation(conversation as ConversationId, context);
			if (target === undefined) return NOT_FOUND;
			// Named fields only: the principal from the caller argument, the credential copied out of the options.
			const principal = caller.principal;
			const credential = typeof options.credential === "string" ? options.credential : undefined;
			const digest = await sha256(JSON.stringify(["input", principal, text]));
			let submission: SubmissionId;
			let carried: SubmissionId | undefined;
			try {
				submission = await harness.commit(async (tx) => {
					// The marker and the record are read in one commit, so a retry racing the pass finds one of them.
					const seen = await tx.doc(Seen, conversation as ConversationId, requestId, { digest, at: now(), outcome: null, due: 0 });
					if (seen.digest !== digest) throw new Refusal("conflict");
					if (seen.outcome !== null) throw new Refusal("too_old");
					const r = await tx.doc(Requests, conversation as ConversationId, requestId, { digest, at: seen.at, principal });
					if (r.attempts.length > 0) {
						if (now() - r.at > LIMITS.requestRetentionMs) throw new Refusal("too_old");
						const last = await tx.submissionByRequest(conversation as ConversationId, attemptId(requestId, r.at, r.attempts.length));
						const retry = last !== undefined && last.status === "unanswered" && last.reason !== "aborted" && r.cancelledBy === null && r.attempts.length < maxAttempts;
						if (!retry) return r.attempts.at(-1) as SubmissionId;
					}
					if (options.whenBusy === "steer" && !(await steerable(tx, conversation as ConversationId, principal))) throw new Refusal("forbidden");
					const attempt = r.attempts.length + 1;
					const sid = await target.submit(tx, {
						type: "input",
						content: text,
						requestId: attemptId(requestId, r.at, attempt),
						entry: { kind: "kleya.input", data: { requestId, attempt } },
						...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
					});
					r.attempts.push(sid);
					// Held before the commit returns, so the attempt's first tool call cannot run ahead of it.
					if (credential !== undefined) credentials.carry((carried = sid), credential);
					return sid;
				}, context);
			} catch (error) {
				if (carried !== undefined) credentials.forget(carried);
				if (error instanceof Refusal) return rejected(requestId, error.reason);
				if (error instanceof ConversationBusy) return rejected(requestId, "busy");
				throw error;
			}
			const state = await (await harness.submission(submission, context))?.status(context);
			const position = (await changes.before(submission, context)) ?? (await changes.head(context));
			return { t: "accepted", requestId, conversation, position: encodeSessionCursor(id, position), state: state?.status === "queued" ? "queued" : "started" };
		},

		async status(caller, requestId, context, conversation = ROOT_CONVERSATION_ID) {
			if (!may(caller, "read")) return FORBIDDEN;
			if (!validConversation(conversation)) return NOT_FOUND;
			const found = await find(conversation, requestId, context);
			return found === undefined ? NOT_FOUND : statusOf(requestId, conversation, found.attempt, found.sub);
		},

		async follow(caller, requestId, options, context) {
			if (!may(caller, "read")) return FORBIDDEN;
			const conversation = options.conversation ?? ROOT_CONVERSATION_ID;
			if (!validConversation(conversation)) return NOT_FOUND;
			const conv = await harness.conversation(conversation as ConversationId, context);
			if (conv === undefined) return NOT_FOUND;
			const from = options.after === undefined ? undefined : decodeTurnCursor(options.after, ref(conversation), requestId);
			if (options.after !== undefined && from === undefined) return INVALID_CURSOR;
			if (from !== undefined && from.store !== changes.store) return CURSOR_EXPIRED;
			const deadline = now() + waitOf(options.waitMs);
			const observed = await view(conversation, context);
			for (;;) {
				const found = await find(conversation, requestId, context);
				if (found === undefined) return NOT_FOUND;
				const { sub, attempt } = found;
				const status = statusOf(requestId, conversation, attempt, sub);
				const ended = settled(sub);
				let events: TurnEvent[] = [];
				let cursor = options.after;
				let done = false;
				if (sub.status !== "queued") {
					const same = from !== undefined && from.attempt === attempt;
					const input = sub.entry ?? 0;
					const after = same ? Math.max(from.entry, input) : input;
					const items = sub.entry === undefined ? { items: [], next: undefined } : await conv.entries({ minEntryId: (after + 1) as never, order: "ascending" }, LIMITS.pageEntries, undefined, context);
					const read = readStored(items.items, sub.status === "done" ? sub.answer : undefined);
					const whole = items.next === undefined || read.complete;
					const live = !ended && whole ? running(observed.view, sub.id) : "";
					const p = page(requestId, attempt, from, whole ? read : { ...read, tail: "" }, live, ended && whole, LIMITS.pageChars);
					events = p.events;
					done = p.position.ended;
					if (done) events.push({ t: "end", status });
					cursor = encodeTurnCursor(ref(conversation), changes.store, p.position);
					if (from?.ended && from.attempt === attempt && events.every((e) => e.t === "end")) events = [];
				}
				if (events.length > 0 || done || now() >= deadline || context.abortSignal?.aborted) {
					return { t: "turn", requestId, events, cursor: cursor ?? encodeTurnCursor(ref(conversation), changes.store, { requestId, attempt, entry: 0, stored: 0, storedHash: "", offset: 0, hash: "", ended: false }), done };
				}
				await signal.wait(deadline - now());
			}
		},

		async abort(caller, requestId, abortId, context, conversation = ROOT_CONVERSATION_ID) {
			if (!may(caller, "cancel")) return rejected(abortId, "forbidden");
			// Abort answers run_ended or not_found, which a caller that may not read must not learn.
			if (!may(caller, "read")) return rejected(abortId, "forbidden");
			if (!validConversation(conversation)) return NOT_FOUND;
			if (!validId(abortId)) return rejected(abortId, "forbidden");
			const found = await find(conversation, requestId, context);
			if (found === undefined) return NOT_FOUND;
			const principal = caller.principal;
			const digest = await sha256(JSON.stringify(["cancel", principal, requestId]));
			let target: SubmissionRecord;
			// The turn's attempt, read in the commit: a pass may delete the record once the turn settles.
			let attempt = 1;
			try {
				target = await harness.commit(async (tx) => {
					const own = await tx.doc(Seen, conversation as ConversationId, abortId, { digest, at: now(), outcome: null, due: 0 });
					if (own.digest !== digest) throw new Refusal("conflict");
					// A marked abort id names nothing any more: its cancel was recorded, and the turn it named may be a new one.
					if (own.outcome !== null) throw new Refusal("too_old");
					const a = await tx.doc(Requests, conversation as ConversationId, abortId, { digest, at: own.at, principal });
					// A caller's turn is its latest attempt, read in this commit; a host-started turn is the one submission found.
					const turn = found.caller ? await tx.doc(Requests, conversation as ConversationId, requestId, NO_REQUEST) : undefined;
					// Pruned since `find`: it had settled. Throwing drops the record the read seeded.
					if (turn !== undefined && turn.digest === "") throw new Refusal("run_ended");
					if (turn !== undefined) attempt = turn.attempts.length;
					const last = turn === undefined ? found.sub : await tx.submissionByRequest(conversation as ConversationId, attemptId(requestId, turn.at, turn.attempts.length));
					if (last === undefined) throw new Refusal("run_ended");
					if (a.cancels !== null) return last;
					if (settled(last)) throw new Refusal("run_ended");
					a.cancels = requestId;
					if (turn !== undefined) turn.cancelledBy = abortId;
					await tx.appendEntry(conversation as ConversationId, { kind: "kleya.cancel", data: { requestId, abortId } });
					return last;
				}, context);
			} catch (error) {
				if (error instanceof Refusal) return rejected(abortId, error.reason);
				throw error;
			}
			let outcome = await harness.abortSubmission(target.id, context, conversation as ConversationId);
			if (outcome === "already_placed") {
				const live = (await view(conversation, context)).view.docs["pi.live"] as { run?: { taskId: number; inputs: number[] } } | undefined;
				if (live?.run?.inputs.includes(target.id)) await harness.abortTask(live.run.taskId as never, context);
				outcome = "aborted";
			}
			const sub = await harness.submission(target.id, context);
			const final = await sub?.wait(context);
			if (final !== undefined && !settled(target)) await harness.commit((tx) => tx.appendEntry(conversation as ConversationId, { kind: "kleya.stopped", data: { requestId, abortId } }), context);
			return final === undefined ? UNAVAILABLE : statusOf(requestId, conversation, attempt, final);
		},

		async followSession(caller, options, context) {
			if (!may(caller, "read")) return FORBIDDEN;
			let position: SessionPosition | undefined = options.after === undefined ? await changes.head(context) : decodeSessionCursor(options.after, id);
			if (position === undefined) return INVALID_CURSOR;
			const wait = waitOf(options.waitMs);
			const deadline = now() + wait;
			for (;;) {
				const read = await changes.read(position, LIMITS.pageEntries, context);
				if ("expired" in read) return { t: "error", code: "cursor_expired", retry: "reattach", oldest: encodeSessionCursor(id, read.oldest) };
				const events: SessionEvent[] = [];
				for (const commit of read.commits) {
					const at = encodeSessionCursor(id, commit.position);
					for (const c of commit.changes) {
						if (c.kind !== "submission" || c.conversation === undefined) continue;
						const requestId = turnName(c)?.requestId;
						if (requestId === undefined) continue;
						if (c.op === "placed") events.push({ t: "turn", phase: "start", requestId, conversation: c.conversation, at });
						else if (c.op === "done" || c.op === "unanswered") events.push({ t: "turn", phase: "end", requestId, conversation: c.conversation, at });
					}
					position = commit.position;
				}
				if (events.length > 0 || now() >= deadline || context.abortSignal?.aborted) return { t: "session", events, cursor: encodeSessionCursor(id, position) };
				await signal.wait(deadline - now());
			}
		},
	};
}

/**
 * Whether `principal` may steer the run in `conversation`: it may when no run is active, or when the input that started
 * the run is the principal's own. A steer joins the running turn and acts with its credential, so another principal's
 * steer, an owner's included, is refused.
 */
async function steerable(tx: Tx, conversation: ConversationId, principal: string): Promise<boolean> {
	const run = (await tx.doc(LiveDoc, conversation)).run;
	if (run === undefined) return true;
	const first = run.first === undefined ? undefined : await tx.entry(run.first);
	const requestId = first?.kind === "kleya.input" ? (first.data as { requestId?: unknown }).requestId : undefined;
	if (typeof requestId !== "string") return false;
	const started = await tx.doc(Requests, conversation, requestId, NO_REQUEST);
	return started.principal === principal;
}

/** The live text of the run working on `submission`, from the conversation's `pi.live` document. */
function running(view: ConversationView, submission: number): string {
	const live = view.docs["pi.live"] as { run?: { inputs?: number[] } } | undefined;
	return live?.run?.inputs?.includes(submission) ? liveText(live as never) : "";
}
// --- Pruning (spec 5.2 "Retention", 11.6 step 4) ---

/** What a pass does with one scanned document: changes it, passes over it, or ends the scan of its family there. */
type Verdict = "due" | "skip" | "stop";

/**
 * One pass over every conversation: shrinks each request record past its window to its marker (`shrink`), then deletes
 * each marker past its due time (`forget`). The first error ends the pass, and the session starts none after it: any
 * failed Storage call, a fenced commit among them, fails the Session (pi-durable 1.5.0 session/session.d.ts, "Storage
 * failures are final"), so nothing after it could land. `stopped` is asked between commits.
 */
async function prune(harness: Harness, storage: Storage, now: () => number, markerMs: number, stopped: () => boolean, context: Context): Promise<void> {
	let conversations: Cursor | undefined;
	do {
		const page = await storage.scanConversations({}, RETENTION.batch, conversations, context);
		for (const { id: conversation } of page.items) {
			const scope = { kind: "conversation", conversationId: conversation } as const;
			const young = (at: number) => now() - at <= LIMITS.requestRetentionMs;
			await sweep<RequestRecord>(harness, storage, scope, REQUEST_KIND, (r) => (young(r.at) ? "stop" : "due"), (tx, key) => shrink(tx, conversation, key, now(), markerMs), stopped, context);
			// A marker with no outcome belongs to a whole record: past its window, that record's turn is still running.
			await sweep<SeenRecord>(harness, storage, scope, SEEN_KIND, (s) => (s.outcome === null ? (young(s.at) ? "stop" : "skip") : now() <= s.due ? "stop" : "due"), (tx, key) => forget(tx, conversation, key, now()), stopped, context);
		}
		conversations = page.next;
	} while (conversations !== undefined);
}

/** Scans one conversation's documents of `kind`, RETENTION.batch to a page, and changes the due ones in one commit a page. */
async function sweep<T>(
	harness: Harness,
	storage: Storage,
	scope: { kind: "conversation"; conversationId: ConversationId },
	kind: string,
	verdict: (value: T) => Verdict,
	change: (tx: Tx, key: string) => Promise<void>,
	stopped: () => boolean,
	context: Context,
): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		if (stopped()) return;
		const found = await storage.scanDocuments({ scope, at: "current", kind }, RETENTION.batch, cursor, context);
		const keys: string[] = [];
		let end = false;
		for (const d of found.items) {
			const value = (await storage.document(d.id, "current", context))?.value as T | undefined;
			if (d.key === undefined || value === undefined) continue;
			const v = verdict(value);
			// The scan ends at the first document that is not yet due. pi-durable scans in id order, and ids are minted in
			// creation order (`Storage.mintId` in pi-durable 1.5.0 types.d.ts); a record's `at` and a marker's `due` are set
			// from its creation, so nothing after it is due either. Nothing rests on that order: each change is decided again
			// in its commit, so another order only delays a prune, by at most one retention period.
			if (v === "stop") {
				end = true;
				break;
			}
			if (v === "due") keys.push(d.key);
		}
		if (keys.length > 0) await harness.commit(async (tx) => { for (const key of keys) await change(tx, key); }, context);
		cursor = end ? undefined : found.next;
	} while (cursor !== undefined);
}

/**
 * Replaces a request record past LIMITS.requestRetentionMs by its marker: the outcome, and the time it is due, the
 * record's `at` + LIMITS.requestRetentionMs + markerMs. A record whose last attempt has not settled stays whole.
 */
async function shrink(tx: Tx, conversation: ConversationId, key: string, t: number, markerMs: number): Promise<void> {
	const r = await tx.doc(Requests, conversation, key, NO_REQUEST);
	// Only a pass deletes a record, and passes run one at a time, so the record the scan found is here. Were it gone, the
	// read would seed an empty one; throwing drops it with the commit.
	if (r.digest === "") throw new Error(`request record ${key} went during the pass`);
	if (t - r.at <= LIMITS.requestRetentionMs) return;
	// A record with no attempt is an abort's own.
	let outcome: TurnOutcome | "abort" = "abort";
	const attempts = r.attempts.length;
	if (attempts > 0) {
		const last = await tx.submissionByRequest(conversation, attemptId(key, r.at, attempts));
		if (last === undefined || !settled(last)) return;
		outcome = statusOf(key, conversation, attempts, last).outcome as TurnOutcome;
	}
	const seen = await tx.doc(Seen, conversation, key, { digest: r.digest, at: r.at, outcome: null, due: 0 });
	seen.outcome = outcome;
	seen.due = r.at + LIMITS.requestRetentionMs + markerMs;
	await tx.retireDoc(Requests, conversation, key);
}

/** Deletes a marker past its due time; after it the id is unknown. */
async function forget(tx: Tx, conversation: ConversationId, key: string, t: number): Promise<void> {
	const seen = await tx.doc(Seen, conversation, key, NO_SEEN);
	// As in `shrink`: only a pass deletes a marker, so the one the scan found is here.
	if (seen.digest === "") throw new Error(`seen marker ${key} went during the pass`);
	if (seen.outcome !== null && t > seen.due) await tx.retireDoc(Seen, conversation, key);
}

/**
 * The open session's passes after the one on open: after a call ends, at most one every RETENTION.everyMs, one at a
 * time. A pass that fails starts none after it. `stop` ends the passes and waits for the one running (MIN-14).
 */
function pruner(harness: Harness, storage: Storage, now: () => number, markerMs: number, last: number) {
	let running: Promise<void> | undefined;
	let stopped = false;
	let failed = false;
	return {
		after() {
			if (stopped || failed || running !== undefined || now() - last < RETENTION.everyMs) return;
			last = now();
			running = prune(harness, storage, now, markerMs, () => stopped, BACKGROUND_CONTEXT)
				.catch(() => {
					failed = true;
				})
				.finally(() => {
					running = undefined;
				});
		},
		async stop() {
			stopped = true;
			await running;
		},
	};
}

// --- Turn credentials (spec 5.3.4 "Credential binding") ---

/**
 * Each running turn's product credential, in memory only: carried by its submit, or minted by the credential port at
 * the turn's first tool call that asks. Keyed by the submission that started the run, and dropped when it settles. A
 * run answering inputs of more than one principal acts for no one: its tools get no credential.
 */
/** @internal Exported for conformance/host/credentials.test.ts; not part of any package subpath. */
export class Credentials {
	#scope: Scope;
	#port: CredentialPort | undefined;
	#harness: Harness | undefined;
	#detach: (() => void) | undefined;
	#carried = new Map<number, string>();
	#minted = new Map<number, Promise<TurnCredential>>();

	constructor(scope: Scope, port: CredentialPort | undefined) {
		this.#scope = scope;
		this.#port = port;
	}

	attach(harness: Harness) {
		this.#harness = harness;
		const observation = harness.observeCommits({
			advance: (publication) => {
				for (const c of publication.changes) if (c.type === "submission" && settled(c.value)) this.forget(c.value.id);
			},
			end: () => this.clear(),
		});
		this.#detach = () => observation.detach();
	}

	carry(submission: SubmissionId, credential: string) {
		this.#carried.set(submission, credential);
		this.#minted.delete(submission);
	}

	clear() {
		this.#detach?.();
		this.#carried.clear();
		this.#minted.clear();
	}

	forget(submission: number) {
		this.#carried.delete(submission);
		this.#minted.delete(submission);
	}

	async lookup(call: ToolCallView, context: Context): Promise<TurnCredential | undefined> {
		const run = (await call.snapshot(LiveDoc, call.conversationId, context))?.run;
		const inputs = run?.inputs ?? [];
		if (inputs.length === 0) return undefined;
		const turns = await Promise.all(inputs.map((input) => this.#turn(input, context)));
		const turn = turns[0];
		if (turn === undefined || turns.some((t) => t === undefined || t.principal !== turn.principal)) return undefined;
		const first = inputs[0]!;
		const carried = this.#carried.get(first);
		if (carried !== undefined) return { ...turn, credential: carried };
		const port = this.#port;
		if (port === undefined) return undefined;
		let minted = this.#minted.get(first);
		if (minted === undefined) {
			minted = port(this.#scope, turn, context).then(
				(credential) => ({ ...turn, credential }),
				() => {
					this.#minted.delete(first);
					throw new Error("the credential port failed");
				},
			);
			this.#minted.set(first, minted);
		}
		return minted;
	}

	/** The turn a run input belongs to, and whose input it was: a caller's principal, or none for the host's own. */
	async #turn(submission: SubmissionId, context: Context): Promise<Turn | undefined> {
		const harness = this.#harness;
		const sub = await (await harness?.submission(submission, context))?.status(context);
		const name = sub === undefined ? undefined : turnName(sub);
		if (harness === undefined || sub === undefined || name === undefined) return undefined;
		if (name.requestId.startsWith("host:")) return { ...name, principal: undefined };
		const r = await harness.snapshot(Requests, sub.conversationId, name.requestId, context);
		// The record must list this submission as that attempt: a `kleya:` id that tool code submitted itself borrows no one's principal.
		if (r === undefined || r.attempts[name.attempt - 1] !== submission) return undefined;
		return { ...name, principal: r.principal };
	}
}

// --- Model gateway (K6) ---

/**
 * The session's models: one provider per gateway provider name, whose every request goes to the base URL and with the
 * credential `access` returns for this scope. The resolved base URL replaces the catalog model's own.
 */
function gatewayModels(gateway: Gateway, scope: Scope, callKey: CallKey) {
	const models = createModels();
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of gateway.models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
	const resolve = async ({ signal }: { signal: AbortSignal }) => {
		let access: Awaited<ReturnType<Gateway["access"]>>;
		try {
			access = await gateway.access(scope, withAbortSignal(signal, BACKGROUND_CONTEXT));
		} catch {
			// pi-ai stores a failed request's error text; the gateway's own may hold its credential.
			throw new Error("the model gateway refused access");
		}
		return { auth: { apiKey: access.credential, baseUrl: access.baseUrl } };
	};
	for (const [provider, list] of byProvider) {
		models.setProvider(createProvider({ id: provider, auth: { apiKey: { name: "Model gateway", resolve } }, models: list, api: keyed(gateway.streams, callKey) }));
	}
	return models;
}

// --- Model call keys ---

/** The header a model request carries its key in. A gateway that sees a key again answers from the first request, if it can. */
const IDEMPOTENCY_KEY = "idempotency-key";

/** Names the model call a request belongs to, from the provider session id pi-durable gives its requests; undefined when it is no turn's. */
type CallKey = (sessionId: string, context: Context) => Promise<string | undefined>;

/**
 * The gateway's streams, with every generation request keyed by its model call. Only a generation request is keyed:
 * pi-durable gives it `onPayload`, which a compaction's summary request and a tool's own model calls lack.
 */
function keyed(streams: Gateway["streams"], callKey: CallKey): ProviderStreams | Partial<Record<Api, ProviderStreams>> {
	const one = (api: ProviderStreams): ProviderStreams => {
		const withKey = async <O extends StreamOptions>(options: O | undefined): Promise<O | undefined> => {
			if (options?.onPayload === undefined || options.sessionId === undefined) return options;
			let key: string | undefined;
			try {
				key = await callKey(options.sessionId, options.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(options.signal, BACKGROUND_CONTEXT));
			} catch {
				throw new Error("the host could not name this model call");
			}
			return key === undefined ? options : { ...options, headers: { ...options.headers, [IDEMPOTENCY_KEY]: key } };
		};
		return {
			...api,
			stream: (model, context, options) => lazyStream(model, async () => api.stream(model, context, await withKey(options))),
			streamSimple: (model, context, options) => lazyStream(model, async () => api.streamSimple(model, context, await withKey(options))),
		};
	};
	if (typeof (streams as ProviderStreams).stream === "function") return one(streams as ProviderStreams);
	return Object.fromEntries(Object.entries(streams as Partial<Record<Api, ProviderStreams>>).map(([api, s]) => [api, s === undefined ? s : one(s)]));
}

const SCAN_PAGE = 100;
const CALLER_ATTEMPT = /^kleya:\d+:(\d+):(.*)$/s;

/**
 * The key of the model call whose generation request carries `sessionId`: the same for every send of that call, and
 * different for every other call. A call is its turn and its place in the turn. The turn is the request id of the
 * run's first input, without its attempt, so a new attempt of the turn sends its calls under the same keys. The place
 * is the number of answers the model completed since the input of the turn's first attempt, so a new attempt goes on
 * from the call that failed instead of starting over: an answer cut off by a crash or ended by an error does not
 * count, so the request that replaces it gets its key. Never the attempt number, which every retry changes. Answers
 * another turn completed between two attempts count too: that only moves the place past every call this turn
 * completed, so a call gets a key no completed call has, never one that has.
 */
async function modelCallKey(harness: Harness | undefined, storage: Storage, store: string, sessionId: string, context: Context): Promise<string | undefined> {
	if (harness === undefined) return undefined;
	const generation = await requestingGeneration(harness, storage, sessionId, context);
	if (generation === undefined) return undefined;
	const { taskId, conversationId } = generation;
	const run = (await harness.snapshot(LiveDoc, conversationId, context))?.run;
	const first = run?.taskId === taskId ? run.inputs[0] : undefined;
	const input = first === undefined ? undefined : await storage.submission(first, context);
	const turn = input === undefined ? undefined : turnOf(input);
	if (turn === undefined) return undefined;
	const from = await openingEntry(storage, conversationId, turn.earlier, context);
	const place = await completedAnswers(storage, conversationId, from ?? turn.entry, context);
	return `kleya-model.${await sha256(JSON.stringify(["kleya.model-key.v1", store, conversationId, turn.name, place]))}`;
}

/** The turn an input starts, named without its attempt; the entry the input wrote; the request ids of the turn's earlier attempts, first first. */
function turnOf(input: SubmissionRecord): { name: string; entry: EntryId; earlier: string[] } | undefined {
	const name = turnName(input);
	if (input.type !== "input" || input.entry === undefined || name === undefined) return undefined;
	const caller = input.requestId?.match(CALLER_ATTEMPT);
	if (caller === null || caller === undefined) return { name: name.requestId, entry: input.entry, earlier: [] };
	const earlier = Array.from({ length: name.attempt - 1 }, (_, i) => attemptId(caller[2]!, Number(caller[1]), i + 1));
	return { name: `${caller[1]}:${caller[2]}`, entry: input.entry, earlier };
}

/** The entry of the turn's earliest attempt that reached the conversation; an attempt dropped while queued wrote none. */
async function openingEntry(storage: Storage, conversationId: ConversationId, earlier: readonly string[], context: Context): Promise<EntryId | undefined> {
	for (const requestId of earlier) {
		const entry = (await storage.submissionByRequest(conversationId, requestId, context))?.entry;
		if (entry !== undefined) return entry;
	}
	return undefined;
}

/** The answers the model completed in a conversation from entry `from` on; one cut off or ended by an error does not count. */
async function completedAnswers(storage: Storage, conversationId: ConversationId, from: EntryId, context: Context): Promise<number> {
	let place = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId, minEntryId: from, order: "ascending" }, SCAN_PAGE, cursor, context);
		for (const entry of page.items) {
			if (!AssistantEntry.is(entry)) continue;
			const stop = (entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason;
			if (stop !== "error" && stop !== "aborted") place++;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return place;
}

/** The running generation task in its request phase whose conversation's provider session id is `sessionId`. */
async function requestingGeneration(harness: Harness, storage: Storage, sessionId: string, context: Context): Promise<{ taskId: number; conversationId: ConversationId } | undefined> {
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanTasks({ kind: GenerationTask.definition.name, status: "running" }, SCAN_PAGE, cursor, context);
		for (const task of page.items) {
			if ((task.state as { checkpoint?: { phase?: unknown } }).checkpoint?.phase !== "request") continue;
			const provider = await harness.snapshot(ProviderDoc, task.conversationId, context);
			if (provider?.sessionId === sessionId) return { taskId: task.id, conversationId: task.conversationId };
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}
