// @centerforagenticai/kleya-cloudflare/object: the Kleya host on Cloudflare (WP-14, plan step 5). One Durable Object per
// session, named `harnessIdOf(scope)`; inside it the host core (kleya-server/host) over ports on the object's own storage
// (./ports.ts). The Worker runs the HTTP edge (kleya-server/http) unchanged and reaches the object through
// `objectSession`, one RPC call per SessionHost call; a follow call waits at most `LIMITS.followWaitMs` in the object.
// Kleya's changes to a plain host: the object serves only the session its name encodes, a size guard refuses a tool
// result too large for one row (P5), consecutive failures stop the reset loop for a while (P8), and both retention
// timers default to 0 so an idle object can be evicted (P9).
// No `cloudflare:` import: the application's Durable Object class holds a `sessionObject` and forwards its methods.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask, type Extension, type Registry, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Accepted, FeedError, HarnessId, Rejected, SessionCursor, SessionPage, TurnPage, TurnStatus } from "@centerforagenticai/kleya-client/protocol";
import { createHost, harnessIdOf, type Caller, type FollowOptions, type Host, type HostOptions, type Scope, type SessionHost, type SubmitOptions } from "@centerforagenticai/kleya-server/host";
import { objectPorts, type ObjectState } from "./ports.ts";

export type { ObjectState } from "./ports.ts";

/** Consecutive failures after which the object stops opening its session for `stopMs`. */
export const MAX_FAILURES = 3;
/** How long a stop lasts. */
export const STOP_MS = 5 * 60_000;
/** The largest tool result the size guard lets through; the platform holds at most 2,000,000 bytes in one row. */
export const MAX_ENTRY_BYTES = 1_900_000;
/** pi-durable's default `outputLimits.maxBytes`. */
const DEFAULT_OUTPUT_BYTES = 50 * 1024;

export type SessionObjectOptions = Omit<HostOptions, "ports" | "registry"> & {
	/** The host installs its size guard here. */
	readonly registry: Registry;
	/** Default `MAX_FAILURES`. */
	readonly maxFailures?: number;
	/** Default `STOP_MS`. */
	readonly stopMs?: number;
	/** Default `MAX_ENTRY_BYTES`. */
	readonly maxEntryBytes?: number;
	/** Told of each failure the object counts, and of a stop. Must not throw. */
	readonly report?: (event: ObjectEvent) => void;
};

/** `failed`: an open or the open session failed, and the object resets. `stopped`: it refuses until `until`. */
export type ObjectEvent = { readonly type: "failed"; readonly failures: number } | { readonly type: "stopped"; readonly until: number };

/**
 * The object's methods, for its Durable Object class to expose as RPC methods. Each names the scope it is for, and is
 * refused unless `harnessIdOf(scope)` is the object's name. A refused or stopped call rejects; the edge answers 503.
 */
export type SessionObject = {
	submit(scope: Scope, caller: Caller, requestId: string, text: string, options: SubmitOptions): Promise<Accepted | Rejected | FeedError>;
	status(scope: Scope, caller: Caller, requestId: string, conversation?: number): Promise<TurnStatus | FeedError>;
	follow(scope: Scope, caller: Caller, requestId: string, options: FollowOptions): Promise<TurnPage | FeedError>;
	abort(scope: Scope, caller: Caller, requestId: string, abortId: string, conversation?: number): Promise<TurnStatus | Rejected | FeedError>;
	followSession(scope: Scope, caller: Caller, options: { readonly after?: SessionCursor; readonly waitMs?: number }): Promise<SessionPage | FeedError>;
	/** The Durable Object's `alarm` handler. */
	alarm(): Promise<void>;
	/** Closes the session and the stores. Idempotent. */
	close(): Promise<void>;
};

/** The object refuses: it is stopped until `until`, or the scope is not the one its name encodes. */
class Refused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Refused";
	}
}

export function sessionObject(state: ObjectState, options: SessionObjectOptions): SessionObject {
	const { maxFailures = MAX_FAILURES, stopMs = STOP_MS, maxEntryBytes = MAX_ENTRY_BYTES, report = () => {} } = options;
	const now = options.now ?? Date.now;
	const guard = sizeGuard(options.registry, maxEntryBytes);
	options.registry.install(guard);
	const settings = { documentRetentionMs: 0, contextRetentionMs: 0, ...options.settings };
	if (settings.extensions !== undefined && !settings.extensions.some((e) => e.name === guard.name)) settings.extensions = [...settings.extensions, guard];

	const sql = state.storage.sql;
	sql.exec("CREATE TABLE IF NOT EXISTS kleya_object (id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, failed_at INTEGER NOT NULL) STRICT");
	const row = sql.exec("SELECT failures, failed_at FROM kleya_object WHERE id = 1").next();
	const count = { failures: row.done ? 0 : Number(row.value.failures), failedAt: row.done ? 0 : Number(row.value.failed_at) };
	const write = () => sql.exec("INSERT OR REPLACE INTO kleya_object (id, failures, failed_at) VALUES (1, ?, ?)", count.failures, count.failedAt);

	/** A throwing `report` must not skip the reset or the refusal. */
	const tell = (event: ObjectEvent) => {
		try {
			report(event);
		} catch {
			// Reports are the application's; the object's state does not depend on them.
		}
	};

	let resetting = false;
	/**
	 * Counts a failure and resets the object. workerd discards the writes of a request that throws, so the count is made
	 * durable before the reset (WP-14: without the sync the object reset 6 times instead of 3). The reset happens even
	 * when the write or the sync fails.
	 */
	async function failed(): Promise<void> {
		if (resetting) return;
		resetting = true;
		count.failures += 1;
		count.failedAt = now();
		tell({ type: "failed", failures: count.failures });
		try {
			write();
			await state.storage.sync();
		} catch {
			// The reset below matters more than the count.
		}
		try {
			state.abort("the Kleya session failed");
		} catch {
			// `abort` throws in the calling context once it has reset the object.
		}
	}
	const clear = () => {
		if (count.failures === 0) return;
		count.failures = 0;
		try {
			write();
		} catch {
			// Counted again from where it was; the next answered turn clears it.
		}
	};

	const ports = objectPorts(state, { failed: () => void failed(), answered: clear }, now);
	const host: Host = createHost({ ...options, ports, registry: options.registry, settings });
	let closed = false;

	const stoppedUntil = () => (count.failures >= maxFailures ? count.failedAt + stopMs : undefined);

	/** `woken`: called by the alarm, with a scope from the object's own alarm row, where the platform may give no name. */
	async function session(scope: Scope, woken = false): Promise<SessionHost> {
		if (closed) throw new Refused("the object is closed");
		const name = state.id.name;
		if (!(woken && name === undefined) && harnessIdOf(scope) !== name) throw new Refused("the object serves only the session its name encodes");
		const until = stoppedUntil();
		if (until !== undefined && now() < until) {
			tell({ type: "stopped", until });
			throw new Refused("the object is stopped after repeated failures");
		}
		let opened: SessionHost;
		try {
			opened = await host.session(scope, ctx);
		} catch (error) {
			await failed();
			throw error;
		}
		// A stop has run out and the session opened: the count starts again.
		if (until !== undefined) clear();
		return opened;
	}

	return {
		submit: async (scope, caller, requestId, text, o) => (await session(scope)).submit(caller, requestId, text, o, ctx),
		status: async (scope, caller, requestId, conversation) => (await session(scope)).status(caller, requestId, ctx, conversation),
		follow: async (scope, caller, requestId, o) => (await session(scope)).follow(caller, requestId, o, ctx),
		abort: async (scope, caller, requestId, abortId, conversation) => (await session(scope)).abort(caller, requestId, abortId, ctx, conversation),
		followSession: async (scope, caller, o) => (await session(scope)).followSession(caller, o, ctx),
		async alarm() {
			const until = stoppedUntil();
			// Stopped: nothing opens until the stop ends, when the alarm comes again.
			if (until !== undefined && now() < until) return state.storage.setAlarm(until);
			await ports.fire(async (scope) => {
				await session(scope, true);
				await host.wake(scope, ctx);
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			await host.close(ctx);
			await ports.close();
		},
	};
}

/** What `objectSession` calls: the Durable Object's stub, whose RPC methods forward to a `SessionObject`. */
export type SessionStub = Pick<SessionObject, "submit" | "status" | "follow" | "abort" | "followSession">;

/**
 * The SessionHost the edge's `session` hook returns on Cloudflare: each call goes to the session's object. `stub` must
 * be the object named `harnessIdOf(scope)`, such as `env.SESSIONS.getByName(harnessIdOf(scope))`; the object checks.
 * The context stays in the Worker: the object runs each call under its own.
 */
export function objectSession(stub: SessionStub, scope: Scope): SessionHost {
	const id: HarnessId = harnessIdOf(scope);
	return {
		id,
		submit: (caller, requestId, text, options) => stub.submit(scope, caller, requestId, text, options),
		status: (caller, requestId, _context, conversation) => stub.status(scope, caller, requestId, conversation),
		follow: (caller, requestId, options) => stub.follow(scope, caller, requestId, options),
		abort: (caller, requestId, abortId, _context, conversation) => stub.abort(scope, caller, requestId, abortId, conversation),
		followSession: (caller, options) => stub.followSession(scope, caller, options),
	};
}

/**
 * P5. Refuses, as a tool error, a result whose stored size would pass `maxEntryBytes`: its output as pi-durable keeps
 * it (text cut to the tool's own output limit, which pi-durable applies after this hook), details and structured output
 * in full. Installed by `sessionObject`; exported for a host that builds its own.
 */
export function sizeGuard(registry: Registry, maxEntryBytes: number): Extension {
	return defineExtension({
		name: "kleya.size-guard",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result: ToolExecutionResult) => {
					const limit = registry.snapshot().tools().find((t) => t.tool.name === call.name)?.tool.outputLimits?.maxBytes ?? DEFAULT_OUTPUT_BYTES;
					const size = storedBytes(result, limit);
					if (size <= maxEntryBytes) return undefined;
					return { output: [{ type: "text", text: `${call.name} returned about ${size} bytes, and one stored tool result holds at most ${maxEntryBytes}. The result was refused.` }], isError: true };
				},
			}),
		],
	});
}

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text).byteLength;
const jsonBytes = (value: unknown) => (value === undefined ? 0 : utf8(JSON.stringify(value)));

/** About how many bytes `result` takes once stored as JSON, with its text cut to `limit` (the product's original guard). */
function storedBytes(result: ToolExecutionResult, limit: number): number {
	const output = result.output ?? [];
	const text = utf8(output.map((item) => (item.type === "text" ? item.text : "")).join(""));
	const json = utf8(JSON.stringify(output));
	const kept = text <= limit ? json : Math.ceil((json * limit) / text);
	return kept + jsonBytes(result.details) + jsonBytes(result.structuredOutput) + jsonBytes(result.diagnostics) + jsonBytes(result.usage);
}
