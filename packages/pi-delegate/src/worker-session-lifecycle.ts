import type {
	AgentSession,
	ExtensionAPI,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import {
	isDelegateOwnedExtensionApi,
	withDelegateOwnedExtensionBind,
} from "./delegate-session-scope.js";
import { getLastAssistantError } from "./harvest-outcome.js";
import type { NestedDelegateCallerPolicy } from "./nested-delegate-policy.js";
import { hasLocalRunAuthority, listRuns } from "./runtime.js";

/** Maximum time to wait for worker extensions before invalidating their session. */
export const DEFAULT_WORKER_SESSION_SHUTDOWN_TIMEOUT_MS = 1_000;

/**
 * Notify extensions and then dispose a delegate-owned session.
 *
 * Extension failures are deliberately isolated from session disposal. The timeout
 * is raced inside the delegate-owned bind so a stuck third-party handler cannot
 * leave the process-global lifecycle marker active.
 */
export async function disposeWorkerSession(
	session: AgentSession,
	nestedDelegatePolicy?: NestedDelegateCallerPolicy,
	timeoutMs = DEFAULT_WORKER_SESSION_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
	try {
		const extensionRunner = session.extensionRunner;
		if (extensionRunner.hasHandlers("session_shutdown")) {
			await withDelegateOwnedExtensionBind(async () => {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
					// A handler that never settles must not strand this promise: swallow a
					// late rejection so it cannot surface as an unhandled rejection after
					// the race has already been decided by the timeout.
					const emit = Promise.resolve()
						.then(() => extensionRunner.emit(event))
						.then(() => undefined, () => undefined);
					// The timer is deliberately NOT unref'd. An unref'd timer lets the event
					// loop drain while a hanging handler leaves this race pending, which Node
					// reports as "Promise resolution is still pending but the event loop has
					// already resolved". `clearTimeout` in the finally bounds it either way.
					const timeoutPromise = new Promise<void>((resolve) => {
						timeout = setTimeout(resolve, timeoutMs);
					});
					await Promise.race([emit, timeoutPromise]);
				} catch {
					// Extension shutdown is best effort; disposal must still happen.
				} finally {
					if (timeout !== undefined) clearTimeout(timeout);
				}
			}, nestedDelegatePolicy);
		}
	} catch {
		// Reading or invoking the extension runner is best effort at teardown.
	} finally {
		// Preserve the SDK's caller-visible disposal behavior. Callers that need a
		// runtime-invalidation fallback handle a disposal throw at their boundary.
		session.dispose();
	}
}

/** Poll cadence while a delegated coordinator is parked at `agent_end`. */
export const DEFAULT_CHILD_COMPLETION_INPUT_POLL_INTERVAL_MS = 25;

/** Injectable timer operations for deterministic child-completion gate tests. */
export interface ChildCompletionGateScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ChildCompletionGateOptions {
	scheduler?: ChildCompletionGateScheduler;
	pollIntervalMs?: number;
}

const productionChildCompletionGateScheduler: ChildCompletionGateScheduler = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

interface ChildCompletionGateContext {
	sessionManager: { getSessionId(): string };
	hasPendingMessages(): boolean;
	signal?: AbortSignal;
}

interface ChildCompletionWait {
	context: ChildCompletionGateContext;
	promise: Promise<void>;
	settle(): void;
}

function createChildCompletionWait(
	context: ChildCompletionGateContext,
	scheduler: ChildCompletionGateScheduler,
	pollIntervalMs: number,
): ChildCompletionWait {
	let settled = false;
	let timer: unknown;
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	const signal = context.signal;

	const settle = () => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) {
			scheduler.clearTimeout(timer);
			timer = undefined;
		}
		signal?.removeEventListener("abort", settle);
		resolve();
	};
	const poll = () => {
		timer = undefined;
		if (settled) return;
		if (context.hasPendingMessages()) {
			settle();
			return;
		}
		timer = scheduler.setTimeout(poll, pollIntervalMs);
	};

	signal?.addEventListener("abort", settle, { once: true });
	// Keep exactly one referenced timer while parked. Recheck after arming to
	// close the gap between the agent_end predicate and timer installation.
	timer = scheduler.setTimeout(poll, pollIntervalMs);
	if (signal?.aborted || context.hasPendingMessages()) settle();

	return { context, promise, settle };
}

/** Keep a delegated session available until its owned children can be synthesized. */
export function registerChildCompletionGate(
	pi: ExtensionAPI,
	options: ChildCompletionGateOptions = {},
): () => void {
	const scheduler = options.scheduler ?? productionChildCompletionGateScheduler;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CHILD_COMPLETION_INPUT_POLL_INTERVAL_MS;
	let activeWait: ChildCompletionWait | undefined;
	const unfinishedOwnedChildren = (ctx: Pick<ChildCompletionGateContext, "sessionManager">) =>
		listRuns().filter((run) =>
			hasLocalRunAuthority(run) &&
			run.ownerSessionId === ctx.sessionManager.getSessionId() &&
			run.completedAt === undefined
		);

	pi.on("turn_start", () => {
		const staleWait = activeWait;
		activeWait = undefined;
		staleWait?.settle();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!isDelegateOwnedExtensionApi(pi)) return;
		const wait = activeWait;
		activeWait = undefined;
		wait?.settle();
		for (const child of unfinishedOwnedChildren(ctx)) child.abort();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isDelegateOwnedExtensionApi(pi)) return;
		if (unfinishedOwnedChildren(ctx).length === 0) return;
		const signal = ctx.signal;
		if (signal?.aborted || getLastAssistantError(event.messages)) return;
		if (ctx.hasPendingMessages()) return;

		const wait = createChildCompletionWait(ctx, scheduler, pollIntervalMs);
		activeWait?.settle();
		activeWait = wait;
		try {
			await wait.promise;
		} finally {
			if (activeWait === wait) activeWait = undefined;
			wait.settle();
		}
	});

	return () => {
		const wait = activeWait;
		if (wait && unfinishedOwnedChildren(wait.context).length === 0) wait.settle();
	};
}
