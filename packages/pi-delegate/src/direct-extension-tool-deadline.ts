import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	Extension,
	RegisteredTool,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { EXCLUDED_TOOL_NAMES } from "./tool-surface.js";

/** The per-invocation limit for inherited extension tools in direct workers. */
export const NON_INTERACTIVE_DIRECT_EXTENSION_TOOL_DEADLINE_MS = 1_800_000;

/** Injectable timer operations used by the direct-worker extension guard. */
export interface DirectExtensionToolDeadlineScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	/** Optional clock used for deterministic parent-budget calculations. */
	now?: () => number;
}

export const productionDirectExtensionToolDeadlineScheduler: DirectExtensionToolDeadlineScheduler = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** The stable error detail returned when an inherited extension tool expires. */
export function formatDirectExtensionToolDeadlineError(toolName: string): string {
	return `Inherited extension tool "${toolName}" exceeded its 30-minute deadline (${NON_INTERACTIVE_DIRECT_EXTENSION_TOOL_DEADLINE_MS} ms) in a non-interactive direct worker.`;
}

/** Stable recovery guidance when a nested call cannot fit inside its parent budget. */
export function formatDirectExtensionToolParentBudgetError(toolName: string, remainingMs: number): string {
	return `Inherited extension tool "${toolName}" cannot start: the parent direct worker has only ${Math.max(0, Math.floor(remainingMs))} ms remaining, so no bounded nested call can be reserved. Commit and push your work before trying another nested call, or rerun without nesting.`;
}

/**
 * Stable guidance when a started nested call exhausts its parent-derived
 * allocation. The call did run, so side effects must be assumed.
 */
export function formatDirectExtensionToolNestedDeadlineError(
	toolName: string,
	allocatedMs: number,
	parentRemainingMs: number,
): string {
	return `Inherited extension tool "${toolName}" started but exceeded its nested deadline of ${Math.max(0, Math.floor(allocatedMs))} ms ` +
		`(the lesser of 30 minutes and half of the parent direct worker's ${Math.max(0, Math.floor(parentRemainingMs))} ms remaining at invocation). ` +
		"The nested call may have partially run; inspect its side effects (for example child runs via delegate_control status) before retrying. " +
		"Commit and push your work before trying another nested call, or rerun without nesting.";
}

export class DirectExtensionToolDeadlineError extends Error {
	readonly toolName: string;
	readonly deadlineMs: number;
	readonly parentBudget: boolean;
	/** Whether the wrapped executor had been invoked before the deadline fired. */
	readonly started: boolean;

	constructor(
		toolName: string,
		options: { deadlineMs?: number; parentBudget?: boolean; parentRemainingMs?: number; started?: boolean } = {},
	) {
		const started = options.started === true;
		super(!options.parentBudget
			? formatDirectExtensionToolDeadlineError(toolName)
			: started
				? formatDirectExtensionToolNestedDeadlineError(
					toolName,
					options.deadlineMs ?? 0,
					options.parentRemainingMs ?? options.deadlineMs ?? 0,
				)
				: formatDirectExtensionToolParentBudgetError(toolName, options.parentRemainingMs ?? options.deadlineMs ?? 0));
		this.name = "DirectExtensionToolDeadlineError";
		this.toolName = toolName;
		this.deadlineMs = options.deadlineMs ?? NON_INTERACTIVE_DIRECT_EXTENSION_TOOL_DEADLINE_MS;
		this.parentBudget = options.parentBudget === true;
		this.started = started;
	}
}

export interface DirectExtensionToolDeadlineController {
	readonly expiryError: DirectExtensionToolDeadlineError | undefined;
	dispose(): void;
}

export interface InstallDirectExtensionToolDeadlineOptions {
	scheduler?: DirectExtensionToolDeadlineScheduler;
	/** Abort only the currently running direct worker session. */
	abortWorker: () => void;
	/** Read the immutable parent deadline at nested-call invocation time. */
	parentDeadlineAtMs?: () => number | undefined;
}

type ExtensionRegistration = RegisteredTool;
type ExtensionToolExecute = ToolDefinition["execute"];

const GUARDED_EXECUTE = Symbol("pi-delegate.direct-extension-tool-deadline");
type GuardedExecute = ExtensionToolExecute & { [GUARDED_EXECUTE]?: true };

function guardRegistration(
	registrationName: string,
	registration: ExtensionRegistration,
	options: InstallDirectExtensionToolDeadlineOptions,
	state: { latch(error: DirectExtensionToolDeadlineError): void; addTimer(handle: unknown): void; removeTimer(handle: unknown): void },
): ExtensionRegistration {
	if (registrationName === "ask" || registration.definition.name === "ask") return registration;
	const execute = registration.definition.execute as GuardedExecute;
	if (execute[GUARDED_EXECUTE]) return registration;

	const scheduler = options.scheduler ?? productionDirectExtensionToolDeadlineScheduler;
	const guardedExecute = (async function (
		this: unknown,
		...args: Parameters<ExtensionToolExecute>
	): Promise<AgentToolResult<unknown>> {
		let settled = false;
		let timer: unknown;
		let originalResult: ReturnType<ExtensionToolExecute>;
		const onUpdate = args[3] as AgentToolUpdateCallback<unknown> | undefined;
		const guardedUpdate: AgentToolUpdateCallback<unknown> | undefined = onUpdate
			? (update) => {
				if (!settled) onUpdate(update);
			}
			: undefined;
		const invokeArgs = [...args] as Parameters<ExtensionToolExecute>;
		invokeArgs[3] = guardedUpdate as Parameters<ExtensionToolExecute>[3];

		const guardedToolName = registrationName === registration.definition.name
			? registrationName
			: registration.definition.name;
		const parentDeadlineAtMs = EXCLUDED_TOOL_NAMES.includes(registrationName) || EXCLUDED_TOOL_NAMES.includes(guardedToolName)
			? options.parentDeadlineAtMs?.()
			: undefined;
		const now = scheduler.now?.() ?? Date.now();
		const remainingParentMs = parentDeadlineAtMs === undefined ? undefined : parentDeadlineAtMs - now;
		const deadlineMs = remainingParentMs === undefined
			? NON_INTERACTIVE_DIRECT_EXTENSION_TOOL_DEADLINE_MS
			: Math.min(NON_INTERACTIVE_DIRECT_EXTENSION_TOOL_DEADLINE_MS, Math.floor(remainingParentMs / 2));
		const parentBudget = remainingParentMs !== undefined;
		const result = new Promise<AgentToolResult<unknown>>((resolve, reject) => {
			if (parentBudget && deadlineMs <= 0) {
				settled = true;
				const error = new DirectExtensionToolDeadlineError(registrationName, {
					deadlineMs: remainingParentMs,
					parentRemainingMs: remainingParentMs,
					parentBudget: true,
				});
				state.latch(error);
				reject(error);
				return;
			}
			timer = scheduler.setTimeout(() => {
				if (settled) return;
				settled = true;
				const error = new DirectExtensionToolDeadlineError(registrationName, {
					deadlineMs,
					parentRemainingMs: remainingParentMs,
					parentBudget,
					// The executor is invoked synchronously right after this timer is
					// armed, so any expiry here follows a started call.
					started: true,
				});
				state.removeTimer(timer);
				state.latch(error);
				reject(error);
			}, deadlineMs);
			state.addTimer(timer);
			try {
				originalResult = execute.apply(this, invokeArgs);
			} catch (error) {
				settled = true;
				state.removeTimer(timer);
				scheduler.clearTimeout(timer);
				reject(error);
				return;
			}
			Promise.resolve(originalResult).then(
				(value) => {
					if (settled) return;
					settled = true;
					state.removeTimer(timer);
					scheduler.clearTimeout(timer);
					resolve(value as AgentToolResult<unknown>);
				},
				(error) => {
					if (settled) return;
					settled = true;
					state.removeTimer(timer);
					scheduler.clearTimeout(timer);
					reject(error);
				},
			);
		});
		return result;
	} as GuardedExecute);
	guardedExecute[GUARDED_EXECUTE] = true;

	return {
		...registration,
		definition: {
			...registration.definition,
			execute: guardedExecute,
		},
	};
}

/**
 * Install the deadline on extension registrations belonging to one worker
 * loader. Built-in and SDK custom tools are deliberately not passed here.
 */
export function installDirectExtensionToolDeadline(
	extensions: readonly Pick<Extension, "tools">[],
	options: InstallDirectExtensionToolDeadlineOptions,
): DirectExtensionToolDeadlineController {
	const scheduler = options.scheduler ?? productionDirectExtensionToolDeadlineScheduler;
	const timers = new Set<unknown>();
	let disposed = false;
	let expiryError: DirectExtensionToolDeadlineError | undefined;
	let abortRequested = false;
	const state = {
		addTimer: (handle: unknown) => {
			if (!disposed) timers.add(handle);
		},
		removeTimer: (handle: unknown) => {
			timers.delete(handle);
		},
		latch: (error: DirectExtensionToolDeadlineError) => {
			if (expiryError) return;
			expiryError = error;
			if (abortRequested) return;
			abortRequested = true;
			try {
				options.abortWorker();
			} catch {
				// Worker abort is best-effort; the latched deterministic failure wins.
			}
		},
	};

	for (const extension of extensions) {
		const tools = extension.tools;
		const originalSet = tools.set.bind(tools);
		for (const [name, registration] of tools) {
			originalSet(name, guardRegistration(name, registration, options, state));
		}
		tools.set = ((name: string, registration: ExtensionRegistration) =>
			originalSet(name, guardRegistration(name, registration, options, state))) as typeof tools.set;
	}

	return {
		get expiryError() {
			return expiryError;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const timer of timers) scheduler.clearTimeout(timer);
			timers.clear();
		},
	};
}