import { AsyncLocalStorage } from "node:async_hooks";
import type { DispatchAcceptance } from "./dispatch-evidence.js";
import { DelegateRuntimeError } from "./runtime-api.js";

export type DelegateRuntimeUpdate =
	| { kind: "accepted"; acceptance: DispatchAcceptance }
	| { kind: "progress"; runId: string; forks: Array<{ name: string; agent: string; status: string; currentRound?: number; maxRounds?: number }> }
	| { kind: "terminal"; runId: string; state: string };

export interface DelegateRuntimeInvocationOptions {
	signal?: AbortSignal;
	/** Called in event order without awaiting completion. Rejected promises detach observation. */
	onUpdate?: (update: DelegateRuntimeUpdate) => void;
}

export interface RuntimeContextBinding {
	assertCurrent(): void;
	onInvalidate(callback: () => void): () => void;
}

type SessionContext = { sessionManager?: { getSessionId?: () => string } };
function sessionId(context: SessionContext): string | undefined {
	try { const id = context.sessionManager?.getSessionId?.(); return typeof id === "string" && id.length > 0 ? id : undefined; }
	catch { return undefined; }
}

/** One authority per installed foreground core. Every start, including same-ID, advances it. */
export function createInvocationAuthority() {
	let generation = 0;
	let owner: string | undefined;
	let manager: SessionContext["sessionManager"];
	const observers = new Set<() => void>();
	return {
		get observerCount() { return observers.size; },
		replace(context: SessionContext | undefined) {
			generation++;
			owner = context ? sessionId(context) : undefined;
			manager = context?.sessionManager;
			for (const callback of [...observers]) callback();
			observers.clear();
		},
		bind(context: SessionContext): RuntimeContextBinding {
			const id = sessionId(context);
			if (!id || !owner) throw new DelegateRuntimeError("context-unavailable", "A live invoking session context is required");
			const epoch = generation;
			const assertCurrent = () => {
				if (epoch !== generation || id !== owner || context.sessionManager !== manager || sessionId(context) !== id) {
					throw new DelegateRuntimeError("stale-context", "Runtime client belongs to a replaced session; bind a fresh client to the invoking callback context");
				}
			};
			assertCurrent();
			return { assertCurrent, onInvalidate(callback) { assertCurrent(); observers.add(callback); return () => { observers.delete(callback); }; } };
		},
	};
}

function copyAcceptance(value: DispatchAcceptance): DispatchAcceptance {
	return { runId: value.runId, transport: value.transport, state: value.state,
		...(value.daemonSessionId !== undefined ? { daemonSessionId: value.daemonSessionId } : {}),
		...(value.promptId !== undefined ? { promptId: value.promptId } : {}),
		...(value.idempotencyKey !== undefined ? { idempotencyKey: value.idempotencyKey } : {}) };
}
function copyUpdate(update: DelegateRuntimeUpdate): DelegateRuntimeUpdate {
	if (update.kind === "accepted") return { kind: "accepted", acceptance: copyAcceptance(update.acceptance) };
	if (update.kind === "terminal") return { kind: "terminal", runId: update.runId, state: update.state };
	return { kind: "progress", runId: update.runId, forks: update.forks.map((fork) => ({ name: fork.name, agent: fork.agent, status: fork.status,
		...(fork.currentRound !== undefined ? { currentRound: fork.currentRound } : {}),
		...(fork.maxRounds !== undefined ? { maxRounds: fork.maxRounds } : {}) })) };
}

/** Invocation cancellation owns observation, never an accepted run's AbortController. */
export class RuntimeInvocation {
	private accepted?: DispatchAcceptance;
	private disposed = false;
	private observationOnly = false;
	private callback?: DelegateRuntimeInvocationOptions["onUpdate"];
	private buffered: DelegateRuntimeUpdate[] = [];
	private disposers: Array<() => void> = [];
	readonly signal?: AbortSignal;
	constructor(private readonly binding: RuntimeContextBinding, options: DelegateRuntimeInvocationOptions = {}, private readonly diagnostic: () => void = () => {}) {
		this.signal = options.signal;
		this.callback = options.onUpdate;
		this.own(binding.onInvalidate(() => this.dispose()));
		if (this.signal) {
			const abort = () => this.dispose();
			this.signal.addEventListener("abort", abort, { once: true });
			this.own(() => this.signal?.removeEventListener("abort", abort));
			if (this.signal.aborted) this.dispose();
		}
	}
	get acceptance(): DispatchAcceptance | undefined { return this.accepted ? copyAcceptance(this.accepted) : undefined; }
	get observing(): boolean { return !this.disposed && this.callback !== undefined; }
	assertLaunch(): void { this.binding.assertCurrent(); this.assertPreparing(); }
	assertPreparing(): void {
		if (this.accepted) return;
		this.binding.assertCurrent();
		if (this.signal?.aborted) throw new DelegateRuntimeError("invocation-aborted", "Runtime invocation aborted before acceptance");
	}
	own(dispose: () => void): void { if (this.disposed) dispose(); else this.disposers.push(dispose); }
	/** Attach to existing work without manufacturing dispatch acceptance. */
	observeExisting(): void {
		this.observationOnly = true;
		const buffered = this.buffered;
		this.buffered = [];
		for (const update of buffered) this.update(update);
	}
	accept(acceptance: DispatchAcceptance): void {
		if (this.accepted) return;
		this.accepted = copyAcceptance(acceptance);
		this.emit({ kind: "accepted", acceptance });
		const buffered = this.buffered;
		this.buffered = [];
		for (const update of buffered) this.update(update);
	}
	update(update: DelegateRuntimeUpdate): void {
		if (this.disposed) return;
		if (!this.accepted && !this.observationOnly) {
			// Bounded latest progress plus terminal: startup cannot retain conversation data.
			if (update.kind === "progress") this.buffered = this.buffered.filter((item) => item.kind !== "progress");
			this.buffered.push(copyUpdate(update));
			return;
		}
		this.emit(update);
		if (update.kind === "terminal") this.dispose();
	}
	private emit(update: DelegateRuntimeUpdate): void {
		if (this.disposed || !this.callback) return;
		const failed = () => {
			this.dispose();
			try { this.diagnostic(); } catch { /* Diagnostics cannot affect accepted work. */ }
		};
		// Start callbacks in event order, but never await user work on the run path.
		// Promise.resolve also contains foreign thenables and throwing `then` getters.
		try { void Promise.resolve(this.callback(copyUpdate(update))).catch(failed); }
		catch { failed(); }
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.callback = undefined;
		this.buffered = [];
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}

const invocations = new AsyncLocalStorage<RuntimeInvocation>();
export function withRuntimeInvocation<T>(invocation: RuntimeInvocation, operation: () => Promise<T>): Promise<T> {
	return invocations.run(invocation, async () => { invocation.assertPreparing(); return operation(); });
}
export function assertInvocationLaunch(): void { invocations.getStore()?.assertLaunch(); }
export function assertInvocationPreparing(): void { invocations.getStore()?.assertPreparing(); }
export function acceptInvocation(acceptance: DispatchAcceptance): void { invocations.getStore()?.accept(acceptance); }
