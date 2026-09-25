import { AsyncLocalStorage } from "node:async_hooks";
import type { NestedDelegateCallerPolicy } from "./nested-delegate-policy.js";

const DELEGATE_OWNED_API_SET_KEY = Symbol.for("pi-delegate.delegateOwnedExtensionApis");
const DELEGATE_OWNED_API_POLICY_KEY = Symbol.for("pi-delegate.delegateOwnedExtensionApiPolicies");
const DELEGATE_OWNED_BIND_POLICY_ALS_KEY = Symbol.for("pi-delegate.delegateOwnedExtensionBindPolicyStorage");

interface DelegateOwnedExtensionBindFrame {
	policy: NestedDelegateCallerPolicy | undefined;
}

/**
 * The bind-time ownership frame, kept on `globalThis` rather than in this module.
 *
 * A worker session loads its extensions through Pi's loader, which calls
 * `createJiti(..., { moduleCache: false })`. A worker's copy of pi-delegate is
 * therefore usually a SEPARATE module instance from the runner's, with its own
 * copy of every module-local binding. The runner opens the bind scope; the
 * worker's copy reads it from inside its own `session_start` handler. A
 * module-local AsyncLocalStorage cannot span that boundary: the worker's copy
 * would read its own empty storage, mark the API with no policy, and leave the
 * nested-dispatch clamp inert — a confined worker could then mint an unconfined
 * child, which is the escape this policy exists to refuse.
 *
 * The other two keys in this module are process-global for the same reason.
 * `AsyncLocalStorage` comes from a Node builtin, which is shared across module
 * instances, so both the `instanceof` check and cross-instance `run`/`getStore`
 * are sound. Frame presence records worker ownership even when the worker has
 * no nested-delegation policy.
 */
function getBindPolicyStorage(): AsyncLocalStorage<DelegateOwnedExtensionBindFrame> {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[DELEGATE_OWNED_BIND_POLICY_ALS_KEY];
	if (existing instanceof AsyncLocalStorage) {
		return existing as AsyncLocalStorage<DelegateOwnedExtensionBindFrame>;
	}
	const created = new AsyncLocalStorage<DelegateOwnedExtensionBindFrame>();
	g[DELEGATE_OWNED_BIND_POLICY_ALS_KEY] = created;
	return created;
}

function getDelegateOwnedApiSet(): WeakSet<object> {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[DELEGATE_OWNED_API_SET_KEY];
	if (existing instanceof WeakSet) return existing as WeakSet<object>;
	const created = new WeakSet<object>();
	g[DELEGATE_OWNED_API_SET_KEY] = created;
	return created;
}

function getDelegateOwnedApiPolicyMap(): WeakMap<object, NestedDelegateCallerPolicy> {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[DELEGATE_OWNED_API_POLICY_KEY];
	if (existing instanceof WeakMap) return existing as WeakMap<object, NestedDelegateCallerPolicy>;
	const created = new WeakMap<object, NestedDelegateCallerPolicy>();
	g[DELEGATE_OWNED_API_POLICY_KEY] = created;
	return created;
}

/**
 * True while pi-delegate is binding extensions for an in-process session it owns
 * (direct worker / supervised worker / supervisor clone), rather than the real
 * foreground/originator session.
 */
export function isDelegateOwnedExtensionBindActive(): boolean {
	return getBindPolicyStorage().getStore() !== undefined;
}

/** Mark this extension API as belonging to a delegate-owned in-process session. */
export function markDelegateOwnedExtensionApi(api: object, policy?: NestedDelegateCallerPolicy): void {
	getDelegateOwnedApiSet().add(api);
	if (policy) getDelegateOwnedApiPolicyMap().set(api, policy);
}

/** True for delegate-owned in-process worker/clone extension runtimes. */
export function isDelegateOwnedExtensionApi(api: object): boolean {
	return getDelegateOwnedApiSet().has(api);
}

/** Policy carried by a delegate-owned worker session, if it has one. */
export function nestedDelegatePolicyForApi(api: object): NestedDelegateCallerPolicy | undefined {
	return getDelegateOwnedApiPolicyMap().get(api);
}

/**
 * Return true when pi-delegate's foreground-only lifecycle handlers should no-op.
 *
 * During a delegate-owned `bindExtensions()` call, the SDK is emitting lifecycle
 * events for an in-process worker/clone session, not for the real foreground
 * originator. Mark that ExtensionAPI persistently so later worker `turn_start` /
 * `session_shutdown` events also no-op.
 */
export function shouldSkipForegroundLifecycleForDelegateOwnedApi(api: object): boolean {
	const frame = getBindPolicyStorage().getStore();
	if (frame !== undefined) {
		markDelegateOwnedExtensionApi(api, frame.policy);
		return true;
	}
	return isDelegateOwnedExtensionApi(api);
}

/**
 * Mark an awaited AgentSession.bindExtensions(...) call as delegate-owned.
 *
 * The SDK emits `session_start` during bindExtensions(). Without this marker,
 * pi-delegate's own foreground-only `session_start` handler runs inside worker
 * sessions too, clobbering the originator's process-global live wake sink.
 */
export async function withDelegateOwnedExtensionBind<T>(
	fn: () => Promise<T>,
	policy?: NestedDelegateCallerPolicy,
): Promise<T> {
	return await getBindPolicyStorage().run({ policy }, fn);
}
