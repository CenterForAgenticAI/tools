import { randomUUID } from "node:crypto";
import type {
	ContextAwareModeConfirmerV1,
	ContextAwareModeDefinitionResultV1,
	ContextAwareModeDefinitionV1,
	ContextAwareModeHandleV1,
	ContextAwareModeResultV1,
	ContextAwareModeSnapshotV1,
	ContextAwareModeUiV1,
	ContextAwareModesV1,
} from "../context-service.js";
import {
	copyReference,
	createModeStateEntry,
	MAX_MODE_ID_LENGTH,
	MAX_MODE_OWNER_LENGTH,
	MAX_MODE_TOOL_LENGTH,
	MAX_MODE_TRANSITION_LENGTH,
	normalizeModeUi,
	MODE_MESSAGE_TYPE,
	MODE_STATE_ENTRY_TYPE,
	replayModeState,
	snapshotReference,
	type ModeStateReference,
} from "./modes-state.js";
import { isReadOnlyShellCommand } from "./read-only-shell.js";

export { MODE_MESSAGE_TYPE, MODE_STATE_ENTRY_TYPE } from "./modes-state.js";

const MAX_REASON_LENGTH = 240;

type ToolBlock = { block: true; reason: string };
type Guard = NonNullable<ContextAwareModeDefinitionV1["guard"]>;
type CommandAllowed = NonNullable<ContextAwareModeDefinitionV1["commandAllowed"]>;

interface RuntimeToolPolicy {
	readonly allowedTools: ReadonlySet<string>;
	readonly readOnlyShell: boolean;
	readonly lifted?: () => boolean;
}

interface RuntimeDefinition {
	readonly id: string;
	readonly owner: string;
	readonly transition: string;
	readonly blockedTools: ReadonlySet<string>;
	readonly guard?: Guard;
	readonly commandAllowed?: CommandAllowed;
	readonly toolPolicy?: RuntimeToolPolicy;
	readonly ui?: Readonly<ContextAwareModeUiV1>;
}

interface RuntimeState {
	current: ModeStateReference | null;
	outer: ModeStateReference | null;
	updatedAt: string;
}

export interface ContextAwareModesRuntimeDeps {
	readonly appendEntry: (customType: typeof MODE_STATE_ENTRY_TYPE, data: unknown) => void;
	readonly sendMessage: (customType: typeof MODE_MESSAGE_TYPE, content: string, details: { id: string; owner: string; action: "enter" | "exit"; suggestedBy?: "model"; transitionId?: string }) => void;
	readonly entries: () => readonly unknown[];
	readonly isActive?: () => boolean;
	readonly interactiveConfirm?: (request: { mode: string; action: "enter" | "exit"; reason?: string }) => Promise<boolean | undefined>;
	readonly onChange?: () => void;
}

export interface ContextAwareModesRuntime extends ContextAwareModesV1 {
	readonly enterSuggested: (id: string, reason?: string) => Promise<ContextAwareModeResultV1>;
	readonly exitSuggested: (id: string, reason?: string) => Promise<ContextAwareModeResultV1>;
	readonly handleToolCall: (toolName: string, input: Record<string, unknown>) => ToolBlock | undefined;
	readonly restore: (entries?: readonly unknown[]) => void;
	readonly resend: () => void;
	readonly userExit: () => ContextAwareModeResultV1;
	readonly close: () => void;
	readonly isClosed: () => boolean;
}

function refused(code: ContextAwareModeResultV1 extends infer T ? T extends { status: "refused"; code: infer C } ? C : never : never, message: string): ContextAwareModeResultV1 {
	return { status: "refused", code, message } as ContextAwareModeResultV1;
}

function normalizeText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 && text.length <= max ? text : null;
}

function normalizeToolNames(value: unknown): Set<string> | null {
	if (!Array.isArray(value) || value.length > 64) return null;
	const tools = new Set<string>();
	for (const toolName of value) {
		const normalized = normalizeText(toolName, MAX_MODE_TOOL_LENGTH);
		if (normalized === null) return null;
		tools.add(normalized);
	}
	return tools;
}

/** Copy only the named policy fields, so the caller's object is never kept. */
function normalizeToolPolicy(value: unknown): RuntimeToolPolicy | null {
	if (value === null || typeof value !== "object") return null;
	const { allowedTools: names, readOnlyShell, lifted } = value as { allowedTools?: unknown; readOnlyShell?: unknown; lifted?: unknown };
	const allowedTools = normalizeToolNames(names);
	if (allowedTools === null) return null;
	if (readOnlyShell !== undefined && typeof readOnlyShell !== "boolean") return null;
	if (lifted !== undefined && typeof lifted !== "function") return null;
	return { allowedTools, readOnlyShell: readOnlyShell === true, ...(lifted === undefined ? {} : { lifted: lifted as () => boolean }) };
}

function normalizeDefinition(value: ContextAwareModeDefinitionV1): RuntimeDefinition | null {
	if (value === null || typeof value !== "object") return null;
	const id = normalizeText(value.id, MAX_MODE_ID_LENGTH);
	const owner = normalizeText(value.owner, MAX_MODE_OWNER_LENGTH);
	const transition = normalizeText(value.transition, MAX_MODE_TRANSITION_LENGTH);
	if (id === null || owner === null || transition === null) return null;
	const tools = normalizeToolNames(value.blockedTools);
	if (tools === null) return null;
	const toolPolicy = value.toolPolicy === undefined ? undefined : normalizeToolPolicy(value.toolPolicy);
	if (toolPolicy === null) return null;
	if (value.guard !== undefined && typeof value.guard !== "function") return null;
	if (value.commandAllowed !== undefined && typeof value.commandAllowed !== "function") return null;
	const ui = value.ui === undefined ? undefined : normalizeModeUi(value.ui);
	if (ui === null) return null;
	return {
		id,
		owner,
		transition,
		blockedTools: tools,
		...(value.guard === undefined ? {} : { guard: value.guard }),
		...(value.commandAllowed === undefined ? {} : { commandAllowed: value.commandAllowed }),
		...(toolPolicy === undefined ? {} : { toolPolicy }),
		...(ui === undefined ? {} : { ui }),
	};
}

function sanitizeReason(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const reason = value.trim();
	if (reason.length === 0) return fallback;
	return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function toolPolicyBlock(definition: RuntimeDefinition, toolName: string, input: Record<string, unknown> | undefined): ToolBlock | undefined {
	const policy = definition.toolPolicy;
	if (policy === undefined) return undefined;
	let reason: string;
	if (!policy.allowedTools.has(toolName)) {
		reason = `Tool ${toolName} is not allowed by mode ${definition.id}.`;
	} else if (toolName === "bash" && policy.readOnlyShell && !isReadOnlyShellCommand(input?.command)) {
		// The reason names the tool and mode only; the command may carry secrets.
		reason = `Tool bash is not allowed by mode ${definition.id}: the command is not on the read-only shell list.`;
	} else {
		return undefined;
	}
	return isLifted(policy) ? undefined : { block: true, reason };
}

function isLifted(policy: RuntimeToolPolicy): boolean {
	if (policy.lifted === undefined) return false;
	try {
		const lift = policy.lifted;
		return lift() === true;
	} catch {
		return false;
	}
}

function isSuggested(value: unknown): value is { suggestedBy: "model"; confirm: true } {
	return typeof value === "object" && value !== null
		&& (value as { suggestedBy?: unknown }).suggestedBy === "model"
		&& (value as { confirm?: unknown }).confirm === true;
}

export function createContextAwareModesV1(deps: ContextAwareModesRuntimeDeps): ContextAwareModesRuntime {
	const definitions = new Map<string, RuntimeDefinition>();
	const owners = new WeakMap<ContextAwareModeHandleV1, RuntimeDefinition>();
	let state: RuntimeState = { current: null, outer: null, updatedAt: new Date(0).toISOString() };
	let recoveredTransition: string | undefined;
	let suggestionConfirmer: ContextAwareModeConfirmerV1 | undefined;
	let revision = 0;
	let closed = false;

	const active = (): boolean => !closed && (deps.isActive?.() ?? true);
	const available = (reference: ModeStateReference | null): RuntimeDefinition | undefined => {
		if (reference === null) return undefined;
		const definition = definitions.get(reference.id);
		return definition?.owner === reference.owner ? definition : undefined;
	};
	const referenceFor = (definition: RuntimeDefinition, suggestedBy?: "model"): ModeStateReference => ({
		id: definition.id,
		owner: definition.owner,
		// enteredAt has millisecond precision, so it cannot tell two enters apart.
		instanceId: randomUUID(),
		...(suggestedBy === "model" ? { suggestedBy } : {}),
		enteredAt: new Date().toISOString(),
	});
	const persist = (next: RuntimeState, transitionId: string): void => {
		deps.appendEntry(MODE_STATE_ENTRY_TYPE, createModeStateEntry(next.current, next.outer, next.updatedAt, transitionId));
	};
	const message = (definition: RuntimeDefinition | undefined, reference: ModeStateReference, action: "enter" | "exit", transitionId: string, suggestedBy?: "model"): void => {
		// Recovered text belongs to the mode that was active at replay, so it never
		// describes a transition; only a live definition or the runtime notice does.
		const content = definition?.transition ?? `${action === "enter" ? "Entered" : "Exited"} mode ${reference.id}.`;
		deps.sendMessage(MODE_MESSAGE_TYPE, content, {
			id: reference.id,
			owner: reference.owner,
			action,
			...(suggestedBy === "model" ? { suggestedBy } : {}),
			// Ties the message to its state entry: Pi can deliver it after later entries.
			transitionId,
		});
	};
	const commit = (next: RuntimeState, transition: { definition?: RuntimeDefinition; reference: ModeStateReference; action: "enter" | "exit"; suggestedBy?: "model" }): ContextAwareModeResultV1 => {
		const transitionId = randomUUID();
		persist(next, transitionId);
		state = next;
		revision += 1;
		message(transition.definition, transition.reference, transition.action, transitionId, transition.suggestedBy);
		// After any transition the recovered text no longer matches the current mode.
		recoveredTransition = transition.definition?.transition;
		deps.onChange?.();
		return { status: "ok" };
	};
	const effectiveDefinition = (): RuntimeDefinition | undefined => available(state.current);
	const snapshot = (reference: ModeStateReference | null, updatedAt: string, outerSnapshot?: ContextAwareModeSnapshotV1): ContextAwareModeSnapshotV1 | null => {
		if (reference === null) return null;
		return snapshotReference(reference, available(reference) !== undefined, updatedAt, outerSnapshot, available(reference)?.ui);
	};
	const current = (): ContextAwareModeSnapshotV1 | null => {
		const outerSnapshot = state.outer === null ? undefined : snapshot(state.outer, state.updatedAt);
		return snapshot(state.current, state.updatedAt, outerSnapshot ?? undefined);
	};
	const checkSuggestion = async (id: string, action: "enter" | "exit", reason: string | undefined, expectedRevision: number): Promise<ContextAwareModeResultV1> => {
		let accepted: boolean;
		try {
			const request = { mode: id, action, ...(reason === undefined ? {} : { reason }) };
			const interactiveResult = deps.interactiveConfirm === undefined
				? undefined
				: await deps.interactiveConfirm(request);
			if (interactiveResult !== undefined) {
				accepted = interactiveResult;
			} else if (suggestionConfirmer !== undefined) {
				accepted = await suggestionConfirmer(request);
			} else {
				return refused("CONFIRMATION_REQUIRED", "Mode suggestion requires confirmation.");
			}
		} catch {
			return refused("CONFIRMATION_DECLINED", "Mode suggestion was not confirmed.");
		}
		if (!accepted) return refused("CONFIRMATION_DECLINED", "Mode suggestion was not confirmed.");
		if (!active() || revision !== expectedRevision) return refused("STATE_CHANGED", "The mode state changed while confirmation was pending.");
		return { status: "ok" };
	};
	const enterRecord = async (
		definition: RuntimeDefinition,
		handle: ContextAwareModeHandleV1,
		suggestion?: { suggestedBy: "model"; confirm: true },
		reason?: string,
	): Promise<ContextAwareModeResultV1> => {
		if (owners.get(handle) !== definition) return refused("INACTIVE_HANDLE", "Only the defining mode handle can enter this mode.");
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		if (available(state.current) === undefined && state.current !== null) return refused("UNAVAILABLE", "The active mode is unavailable until its owner redefines it.");
		if (state.current?.id === definition.id && available(state.current) !== undefined) return refused("ALREADY_ACTIVE", "The mode is already active.");
		if (state.current !== null && state.outer !== null) return refused("NESTING_LIMIT", "Only one nested mode is supported.");
		const expectedRevision = revision;
		if (suggestion !== undefined) {
			const confirmed = await checkSuggestion(definition.id, "enter", reason, expectedRevision);
			if (confirmed.status === "refused") return confirmed;
		}
		if (!active() || revision !== expectedRevision) return refused("STATE_CHANGED", "The mode state changed while confirmation was pending.");
		const now = new Date().toISOString();
		const next: RuntimeState = {
			current: referenceFor(definition, suggestion?.suggestedBy),
			outer: copyReference(state.current),
			updatedAt: now,
		};
		return commit(next, { definition, reference: next.current!, action: "enter", ...(suggestion?.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}) });
	};
	const exitRecord = (definition: RuntimeDefinition, handle: ContextAwareModeHandleV1): ContextAwareModeResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		const currentDefinition = effectiveDefinition();
		if (currentDefinition === undefined || currentDefinition !== definition || owners.get(handle) !== definition) {
			return refused(state.current?.id === definition.id ? "WRONG_EFFECTIVE_HANDLE" : "INACTIVE_HANDLE", "Only the effective mode handle can exit this mode.");
		}
		const now = new Date().toISOString();
		const restored = copyReference(state.outer);
		const next: RuntimeState = { current: restored, outer: null, updatedAt: now };
		return commit(next, { definition: available(restored), reference: state.current!, action: "exit" });
	};
	const userExit = (): ContextAwareModeResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		if (state.current === null) return refused("NOT_FOUND", "No mode is active.");
		const now = new Date().toISOString();
		const restored = copyReference(state.outer);
		return commit({ current: restored, outer: null, updatedAt: now }, { definition: available(restored), reference: state.current, action: "exit" });
	};
	const suggest = async (id: string, action: "enter" | "exit", reason?: string): Promise<ContextAwareModeResultV1> => {
		const definition = definitions.get(id);
		if (definition === undefined) return refused("NOT_FOUND", "Mode is not defined in this runtime.");
		if (action === "enter") {
			// The handle is recovered through the definition map below; it is never
			// accepted from a caller, so owner text cannot confer authority.
			for (const candidate of handleRecords) {
				if (candidate.definition === definition) return enterRecord(definition, candidate.handle, { suggestedBy: "model", confirm: true }, reason);
			}
			return refused("UNAVAILABLE", "Mode handle is unavailable.");
		}
		const expectedRevision = revision;
		const confirmed = await checkSuggestion(id, "exit", reason, expectedRevision);
		if (confirmed.status === "refused") return confirmed;
		const currentDefinition = effectiveDefinition();
		if (currentDefinition !== definition) return refused("WRONG_EFFECTIVE_HANDLE", "The suggested mode is not effective.");
		return userExit();
	};
	const handleRecords: Array<{ definition: RuntimeDefinition; handle: ContextAwareModeHandleV1 }> = [];

	const defineMode = (value: ContextAwareModeDefinitionV1): ContextAwareModeDefinitionResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.") as ContextAwareModeDefinitionResultV1;
		const definition = normalizeDefinition(value);
		if (definition === null) return refused("INVALID_REQUEST", "Mode definition is invalid or exceeds its bounds.") as ContextAwareModeDefinitionResultV1;
		const existing = definitions.get(definition.id);
		if (existing !== undefined) return refused("DUPLICATE_ID", "The mode id is already defined in this runtime.") as ContextAwareModeDefinitionResultV1;
		const orphan = [state.current, state.outer].find((reference) => reference?.id === definition.id);
		if (orphan !== undefined && orphan !== null && orphan.owner !== definition.owner) return refused("OWNER_MISMATCH", "The restored mode owner label does not match.") as ContextAwareModeDefinitionResultV1;
		const handle = {} as ContextAwareModeHandleV1;
		const enter = function (this: ContextAwareModeHandleV1, suggestion?: { suggestedBy: "model"; confirm?: true }): Promise<ContextAwareModeResultV1> {
			if (this !== handle) return Promise.resolve(refused("INACTIVE_HANDLE", "Only the defining mode handle can enter this mode."));
			if (suggestion !== undefined && !isSuggested(suggestion)) return Promise.resolve(refused("CONFIRMATION_REQUIRED", "Model suggestions require confirm: true."));
			return enterRecord(definition, handle, suggestion as { suggestedBy: "model"; confirm: true } | undefined);
		};
		const exit = function (this: ContextAwareModeHandleV1): ContextAwareModeResultV1 {
			return exitRecord(definition, this);
		};
		const commandAllowed = function (this: ContextAwareModeHandleV1, name: string): boolean {
			if (this !== handle || typeof name !== "string" || effectiveDefinition() !== definition || available(state.current) !== definition) return false;
			if (definition.commandAllowed === undefined) return true;
			try {
				return definition.commandAllowed(name) === true;
			} catch {
				return false;
			}
		};
		Object.assign(handle, { enter, exit, commandAllowed });
		Object.freeze(handle);
		owners.set(handle, definition);
		definitions.set(definition.id, definition);
		handleRecords.push({ definition, handle });
		deps.onChange?.();
		return { status: "ok", handle };
	};
	const restore = (entries: readonly unknown[] = deps.entries()): void => {
		const replayed = replayModeState(entries);
		state = { current: copyReference(replayed.current), outer: copyReference(replayed.outer), updatedAt: replayed.updatedAt };
		recoveredTransition = replayed.transitionText;
		revision += 1;
		deps.onChange?.();
	};
	const resend = (): void => {
		if (!active() || state.current === null) return;
		const definition = effectiveDefinition();
		const content = definition?.transition ?? recoveredTransition;
		if (content === undefined) return;
		deps.sendMessage(MODE_MESSAGE_TYPE, content, { id: state.current.id, owner: state.current.owner, action: "enter", ...(state.current.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}) });
	};
	const handleToolCall = (toolName: string, input: Record<string, unknown>): ToolBlock | undefined => {
		const definition = effectiveDefinition();
		if (definition === undefined) return undefined;
		if (definition.blockedTools.has(toolName)) return { block: true, reason: `Tool ${toolName} is blocked by mode ${definition.id}.` };
		const policyBlock = toolPolicyBlock(definition, toolName, input);
		if (policyBlock !== undefined) return policyBlock;
		if (definition.guard !== undefined) {
			try {
				const result = definition.guard(toolName, input);
				if (result?.block === true) return { block: true, reason: sanitizeReason(result.reason, `Tool ${toolName} is blocked by mode ${definition.id}.`) };
			} catch {
				return { block: true, reason: `Tool ${toolName} is blocked by mode ${definition.id}.` };
			}
		}
		return undefined;
	};
	const close = (): void => {
		closed = true;
		revision += 1;
		definitions.clear();
		handleRecords.length = 0;
		suggestionConfirmer = undefined;
	};
	const runtime: ContextAwareModesRuntime = {
		defineMode,
		current,
		setSuggestionConfirmer(confirmer) {
			suggestionConfirmer = confirmer;
		},
		enterSuggested: (id, reason) => suggest(id, "enter", reason),
		exitSuggested: (id, reason) => suggest(id, "exit", reason),
		handleToolCall,
		restore,
		resend,
		userExit,
		close,
		isClosed: () => closed,
	};
	restore();
	return runtime;
}
