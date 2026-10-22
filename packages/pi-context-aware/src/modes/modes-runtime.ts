import { randomUUID } from "node:crypto";
import type {
	ContextAwareModeConfirmerV1,
	ContextAwareModeDefinitionResultV1,
	ContextAwareModeDefinitionV1,
	ContextAwareModeEnterOptionsV1,
	ContextAwareModeHandleV1,
	ContextAwareModeResultV1,
	ContextAwareModeSnapshotV1,
	ContextAwareModeSuggestionV1,
	ContextAwareModeUiV1,
	ContextAwareModesV1,
} from "../context-service.js";
import {
	compareModeLayers,
	copyLayer,
	createModeStateEntry,
	isModeRank,
	MAX_MODE_ID_LENGTH,
	MAX_MODE_LAYER_LENGTH,
	MAX_MODE_OWNER_LENGTH,
	MAX_MODE_TOOL_LENGTH,
	MAX_MODE_TRANSITION_LENGTH,
	MODE_DEFAULT_LAYER,
	normalizeModeTrail,
	normalizeModeUi,
	MODE_MESSAGE_TYPE,
	MODE_STATE_ENTRY_TYPE,
	replayModeState,
	snapshotLayer,
	type ModeLayerState,
} from "./modes-state.js";
import { isReadOnlyShellCommand } from "./read-only-shell.js";

export { MODE_MESSAGE_TYPE, MODE_STATE_ENTRY_TYPE, MODE_STATE_ENTRY_TYPE_V1 } from "./modes-state.js";

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
	readonly layer: string;
	readonly rank: number;
	readonly pinned: boolean;
	readonly blockedTools: ReadonlySet<string>;
	readonly guard?: Guard;
	readonly commandAllowed?: CommandAllowed;
	readonly toolPolicy?: RuntimeToolPolicy;
	readonly ui?: Readonly<ContextAwareModeUiV1>;
}

export interface ModeTransitionDetails {
	readonly id: string;
	readonly owner: string;
	readonly action: "enter" | "exit";
	readonly suggestedBy?: "model";
	readonly transitionId?: string;
	readonly instanceId?: string;
	readonly layer?: string;
}

export interface ContextAwareModesRuntimeDeps {
	readonly appendEntry: (customType: typeof MODE_STATE_ENTRY_TYPE, data: unknown) => void;
	readonly sendMessage: (customType: typeof MODE_MESSAGE_TYPE, content: string, details: ModeTransitionDetails) => void;
	readonly entries: () => readonly unknown[];
	readonly isActive?: () => boolean;
	readonly interactiveConfirm?: (request: { mode: string; action: "enter" | "exit"; reason?: string }) => Promise<boolean | undefined>;
	readonly onChange?: () => void;
}

export interface ContextAwareModesRuntime extends ContextAwareModesV1 {
	readonly layers: () => readonly ContextAwareModeSnapshotV1[];
	readonly setTrail: (text: string | undefined) => ContextAwareModeResultV1;
	readonly enterSuggested: (id: string, reason?: string) => Promise<ContextAwareModeResultV1>;
	readonly exitSuggested: (id: string, reason?: string) => Promise<ContextAwareModeResultV1>;
	readonly handleToolCall: (toolName: string, input: Record<string, unknown>) => ToolBlock | undefined;
	readonly restore: (entries?: readonly unknown[]) => void;
	readonly resend: () => void;
	/** Leave the named layer, or the highest-ranked layer that is not pinned. Only the user calls this. */
	readonly userExit: (layer?: string) => ContextAwareModeResultV1;
	/** Let a pinned layer be entered. Call it only at the start of a new session, before its first agent run. */
	readonly openPinnedWindow: () => void;
	/** Refuse every later enter of a pinned layer. Call it when the first agent run starts. */
	readonly closePinnedWindow: () => void;
	readonly trail: () => string | undefined;
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

/** Copy only `name`, `rank` and `pinned`. An absent layer is the reserved default layer, which no definition may name. */
function normalizeLayer(value: unknown): { layer: string; rank: number; pinned: boolean } | null {
	if (value === undefined) return { layer: MODE_DEFAULT_LAYER, rank: 0, pinned: false };
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const { name, rank, pinned } = value as { name?: unknown; rank?: unknown; pinned?: unknown };
	const layer = normalizeText(name, MAX_MODE_LAYER_LENGTH);
	if (layer === null || layer === MODE_DEFAULT_LAYER || !isModeRank(rank)) return null;
	if (pinned !== undefined && pinned !== true) return null;
	return { layer, rank, pinned: pinned === true };
}

function normalizeDefinition(value: ContextAwareModeDefinitionV1): RuntimeDefinition | null {
	if (value === null || typeof value !== "object") return null;
	const id = normalizeText(value.id, MAX_MODE_ID_LENGTH);
	const owner = normalizeText(value.owner, MAX_MODE_OWNER_LENGTH);
	const transition = normalizeText(value.transition, MAX_MODE_TRANSITION_LENGTH);
	if (id === null || owner === null || transition === null) return null;
	const layer = normalizeLayer(value.layer);
	if (layer === null) return null;
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
		...layer,
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

function guardBlock(definition: RuntimeDefinition, toolName: string, input: Record<string, unknown>): ToolBlock | undefined {
	if (definition.guard === undefined) return undefined;
	try {
		const result = definition.guard(toolName, input);
		if (result?.block === true) return { block: true, reason: sanitizeReason(result.reason, `Tool ${toolName} is blocked by mode ${definition.id}.`) };
	} catch {
		return { block: true, reason: `Tool ${toolName} is blocked by mode ${definition.id}.` };
	}
	return undefined;
}

function isSuggested(value: unknown): value is { suggestedBy: "model"; confirm: true } {
	return typeof value === "object" && value !== null
		&& (value as { suggestedBy?: unknown }).suggestedBy === "model"
		&& (value as { confirm?: unknown }).confirm === true;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return typeof value === "object" && value !== null
		&& typeof (value as { aborted?: unknown }).aborted === "boolean"
		&& typeof (value as { addEventListener?: unknown }).addEventListener === "function"
		&& typeof (value as { removeEventListener?: unknown }).removeEventListener === "function";
}

function runEnded(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

interface EnterRequest {
	readonly suggestion?: { suggestedBy: "model"; confirm: true };
	readonly until?: AbortSignal;
	readonly reason?: string;
}

/** Read only `suggestedBy`, `confirm` and `until` from the caller's options. */
function enterRequest(options: unknown): EnterRequest | ContextAwareModeResultV1 {
	if (options === undefined) return {};
	if (options === null || typeof options !== "object") return refused("INVALID_REQUEST", "Enter options must be an object.");
	const { suggestedBy, until } = options as { suggestedBy?: unknown; until?: unknown };
	if (until !== undefined && !isAbortSignal(until)) return refused("INVALID_REQUEST", "until must be an AbortSignal.");
	if (suggestedBy !== undefined && !isSuggested(options)) return refused("CONFIRMATION_REQUIRED", "Model suggestions require confirm: true.");
	return {
		...(suggestedBy === undefined ? {} : { suggestion: { suggestedBy: "model" as const, confirm: true as const } }),
		...(until === undefined ? {} : { until }),
	};
}

export function createContextAwareModesV1(deps: ContextAwareModesRuntimeDeps): ContextAwareModesRuntime {
	const definitions = new Map<string, RuntimeDefinition>();
	const owners = new WeakMap<ContextAwareModeHandleV1, RuntimeDefinition>();
	/** The active layers, lowest rank first. */
	let layers: ModeLayerState[] = [];
	let updatedAt = new Date(0).toISOString();
	/** instanceId → recovered transition text, for modes whose owner has not defined them again. */
	let recoveredTexts: ReadonlyMap<string, string> = new Map();
	/** instanceId → removes the abort listener of a run-scoped layer. */
	const runListeners = new Map<string, () => void>();
	let suggestionConfirmer: ContextAwareModeConfirmerV1 | undefined;
	let trailText: string | undefined;
	let pinnedWindowOpen = false;
	let revision = 0;
	let closed = false;

	const active = (): boolean => !closed && (deps.isActive?.() ?? true);
	/** The live definition of a layer's mode, when its owner defined it again on the same layer. */
	const available = (slot: ModeLayerState): RuntimeDefinition | undefined => {
		const definition = definitions.get(slot.mode.id);
		return definition !== undefined && definition.owner === slot.mode.owner && definition.layer === slot.layer && definition.rank === slot.rank && definition.pinned === (slot.pinned === true)
			? definition
			: undefined;
	};
	const slotOf = (layer: string): ModeLayerState | undefined => layers.find((slot) => slot.layer === layer);
	const heldSlot = (definition: RuntimeDefinition): ModeLayerState | undefined => {
		const slot = slotOf(definition.layer);
		return slot !== undefined && available(slot) === definition ? slot : undefined;
	};
	const dropListeners = (): void => {
		const held = new Set(layers.map((slot) => slot.mode.instanceId));
		for (const [instanceId, remove] of runListeners) {
			if (held.has(instanceId)) continue;
			runListeners.delete(instanceId);
			remove();
		}
	};
	const commit = (
		next: ModeLayerState[],
		transition: { content: string; slot: ModeLayerState; action: "enter" | "exit" },
	): ContextAwareModeResultV1 => {
		const transitionId = randomUUID();
		const now = new Date().toISOString();
		const sorted = [...next].sort(compareModeLayers);
		deps.appendEntry(MODE_STATE_ENTRY_TYPE, createModeStateEntry(sorted, now, transitionId));
		layers = sorted;
		updatedAt = now;
		revision += 1;
		dropListeners();
		const mode = transition.slot.mode;
		deps.sendMessage(MODE_MESSAGE_TYPE, transition.content, {
			id: mode.id,
			owner: mode.owner,
			action: transition.action,
			...(transition.action === "enter" && mode.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
			// Ties the message to its state entry: Pi can deliver it after later entries.
			transitionId,
			instanceId: mode.instanceId,
			layer: transition.slot.layer,
		});
		deps.onChange?.();
		return { status: "ok" };
	};
	const leave = (slot: ModeLayerState): ContextAwareModeResultV1 =>
		commit(layers.filter((candidate) => candidate !== slot), { content: `Exited mode ${slot.mode.id}.`, slot, action: "exit" });
	const snapshotOf = (slot: ModeLayerState): ContextAwareModeSnapshotV1 => {
		const definition = available(slot);
		return snapshotLayer(slot, definition !== undefined, updatedAt, undefined, definition?.ui);
	};
	/** The top layer's mode, with the next layer down as `outer`. */
	const current = (): ContextAwareModeSnapshotV1 | null => {
		const top = layers.at(-1);
		if (top === undefined) return null;
		const below = layers.at(-2);
		const definition = available(top);
		return snapshotLayer(top, definition !== undefined, updatedAt, below === undefined ? undefined : snapshotOf(below), definition?.ui);
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
	const watchRun = (slot: ModeLayerState, signal: AbortSignal): void => {
		const onAbort = (): void => {
			runListeners.delete(slot.mode.instanceId);
			if (!active()) return;
			// Only the enter this signal belongs to ends; a replacement keeps its layer.
			const held = slotOf(slot.layer);
			if (held?.mode.instanceId === slot.mode.instanceId) leave(held);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		runListeners.set(slot.mode.instanceId, () => signal.removeEventListener("abort", onAbort));
	};
	const enterRecord = async (definition: RuntimeDefinition, handle: ContextAwareModeHandleV1, request: EnterRequest): Promise<ContextAwareModeResultV1> => {
		if (owners.get(handle) !== definition) return refused("INACTIVE_HANDLE", "Only the defining mode handle can enter this mode.");
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		const existing = slotOf(definition.layer);
		if (existing !== undefined && available(existing) === definition) return refused("ALREADY_ACTIVE", "The mode is already active.");
		if (definition.pinned) {
			if (request.until !== undefined) return refused("INVALID_REQUEST", "A pinned layer cannot be entered for one run.");
			if (request.suggestion !== undefined) return refused("PINNED_LAYER", "A pinned layer is entered only by its owner at session start.");
			if (!pinnedWindowOpen || existing !== undefined) return refused("PINNED_LAYER", "A pinned layer can be entered only before the session's first agent run.");
		}
		if (existing?.pinned === true) return refused("PINNED_LAYER", "The layer holds a pinned mode.");
		if (existing !== undefined && available(existing) === undefined) return refused("UNAVAILABLE", "The layer's mode is unavailable until its owner redefines it.");
		if (runEnded(request.until)) return refused("RUN_ENDED", "The run this mode was entered for has ended.");
		const expectedRevision = revision;
		if (request.suggestion !== undefined) {
			const confirmed = await checkSuggestion(definition.id, "enter", request.reason, expectedRevision);
			if (confirmed.status === "refused") return confirmed;
		}
		if (!active() || revision !== expectedRevision) return refused("STATE_CHANGED", "The mode state changed while confirmation was pending.");
		// A confirmation can outlast the run.
		if (runEnded(request.until)) return refused("RUN_ENDED", "The run this mode was entered for has ended.");
		const slot: ModeLayerState = {
			layer: definition.layer,
			rank: definition.rank,
			...(definition.pinned ? { pinned: true as const } : {}),
			...(request.until === undefined ? {} : { runScoped: true as const }),
			mode: {
				id: definition.id,
				owner: definition.owner,
				// enteredAt has millisecond precision, so it cannot tell two enters apart.
				instanceId: randomUUID(),
				...(request.suggestion === undefined ? {} : { suggestedBy: "model" as const }),
				enteredAt: new Date().toISOString(),
			},
		};
		const result = commit([...layers.filter((candidate) => candidate !== existing), slot], { content: definition.transition, slot, action: "enter" });
		if (request.until !== undefined) watchRun(slot, request.until);
		return result;
	};
	const exitRecord = (definition: RuntimeDefinition, handle: ContextAwareModeHandleV1): ContextAwareModeResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		const slot = heldSlot(definition);
		if (slot === undefined || owners.get(handle) !== definition) return refused("INACTIVE_HANDLE", "Only the handle of an active mode can exit it.");
		if (slot.pinned === true) return refused("PINNED_LAYER", "A pinned mode cannot be exited.");
		return leave(slot);
	};
	const userExit = (layer?: string): ContextAwareModeResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		if (layers.length === 0) return refused("NOT_FOUND", "No mode is active.");
		if (layer !== undefined) {
			const slot = slotOf(layer);
			if (slot === undefined) return refused("NOT_FOUND", "No mode is active on that layer.");
			// A pinned mode whose definition is gone can be cleared; a live one cannot.
			if (slot.pinned === true && available(slot) !== undefined) return refused("PINNED_LAYER", "A pinned mode cannot be exited while its owner defines it.");
			return leave(slot);
		}
		const slot = [...layers].reverse().find((candidate) => candidate.pinned !== true);
		if (slot === undefined) return refused("PINNED_LAYER", "Only pinned modes are active.");
		return leave(slot);
	};
	const handleRecords: Array<{ definition: RuntimeDefinition; handle: ContextAwareModeHandleV1 }> = [];
	const suggest = async (id: string, action: "enter" | "exit", reason?: string): Promise<ContextAwareModeResultV1> => {
		const definition = definitions.get(id);
		if (definition === undefined) return refused("NOT_FOUND", "Mode is not defined in this runtime.");
		if (action === "enter") {
			// The handle is recovered through the definition map below; it is never
			// accepted from a caller, so owner text cannot confer authority.
			for (const candidate of handleRecords) {
				if (candidate.definition === definition) return enterRecord(definition, candidate.handle, { suggestion: { suggestedBy: "model", confirm: true }, ...(reason === undefined ? {} : { reason }) });
			}
			return refused("UNAVAILABLE", "Mode handle is unavailable.");
		}
		const slot = heldSlot(definition);
		if (slot === undefined) return refused("WRONG_EFFECTIVE_HANDLE", "The suggested mode is not active.");
		if (slot.pinned === true) return refused("PINNED_LAYER", "A pinned mode cannot be exited.");
		const expectedRevision = revision;
		const confirmed = await checkSuggestion(id, "exit", reason, expectedRevision);
		if (confirmed.status === "refused") return confirmed;
		if (heldSlot(definition) !== slot) return refused("WRONG_EFFECTIVE_HANDLE", "The suggested mode is not active.");
		return leave(slot);
	};

	const defineMode = (value: ContextAwareModeDefinitionV1): ContextAwareModeDefinitionResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.") as ContextAwareModeDefinitionResultV1;
		const definition = normalizeDefinition(value);
		if (definition === null) return refused("INVALID_REQUEST", "Mode definition is invalid or exceeds its bounds.") as ContextAwareModeDefinitionResultV1;
		if (definitions.has(definition.id)) return refused("DUPLICATE_ID", "The mode id is already defined in this runtime.") as ContextAwareModeDefinitionResultV1;
		for (const other of definitions.values()) {
			if (other.layer === definition.layer && (other.rank !== definition.rank || other.pinned !== definition.pinned)) {
				return refused("INVALID_REQUEST", "Another mode names this layer with a different rank or pin.") as ContextAwareModeDefinitionResultV1;
			}
		}
		// A restored pinned layer keeps its rank and pin until it is cleared, so a
		// later definition cannot take its name and leave the owner unable to re-arm
		// it. An unpinned leftover does not hold its name: the user can clear it.
		for (const slot of layers) {
			if (slot.pinned === true && slot.layer === definition.layer && slot.mode.id !== definition.id && (slot.rank !== definition.rank || !definition.pinned)) {
				return refused("INVALID_REQUEST", "A restored mode holds this layer with a different rank or pin.") as ContextAwareModeDefinitionResultV1;
			}
		}
		const orphan = layers.find((slot) => slot.mode.id === definition.id);
		if (orphan !== undefined && (orphan.mode.owner !== definition.owner || orphan.layer !== definition.layer || orphan.rank !== definition.rank || (orphan.pinned === true) !== definition.pinned)) {
			return refused("OWNER_MISMATCH", "The restored mode's owner label or layer does not match.") as ContextAwareModeDefinitionResultV1;
		}
		const handle = {} as ContextAwareModeHandleV1;
		const enter = function (this: ContextAwareModeHandleV1, options?: ContextAwareModeSuggestionV1 | ContextAwareModeEnterOptionsV1): Promise<ContextAwareModeResultV1> {
			if (this !== handle) return Promise.resolve(refused("INACTIVE_HANDLE", "Only the defining mode handle can enter this mode."));
			const request = enterRequest(options);
			if ("status" in request) return Promise.resolve(request);
			return enterRecord(definition, handle, request);
		};
		const exit = function (this: ContextAwareModeHandleV1): ContextAwareModeResultV1 {
			return exitRecord(definition, this);
		};
		const commandAllowed = function (this: ContextAwareModeHandleV1, name: string): boolean {
			if (this !== handle || typeof name !== "string" || heldSlot(definition) === undefined) return false;
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
		layers = replayed.layers.map(copyLayer);
		updatedAt = replayed.updatedAt;
		recoveredTexts = replayed.transitionTexts;
		pinnedWindowOpen = false;
		revision += 1;
		dropListeners();
		deps.onChange?.();
	};
	/** One message that joins every active layer's transition, lowest rank first, without repeats. */
	const resend = (): void => {
		const top = layers.at(-1);
		if (!active() || top === undefined) return;
		const texts: string[] = [];
		for (const slot of layers) {
			const text = available(slot)?.transition ?? recoveredTexts.get(slot.mode.instanceId);
			if (text !== undefined && !texts.includes(text)) texts.push(text);
		}
		if (texts.length === 0) return;
		deps.sendMessage(MODE_MESSAGE_TYPE, texts.join("\n\n"), {
			id: top.mode.id,
			owner: top.mode.owner,
			action: "enter",
			...(top.mode.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
		});
	};
	/** Every layer's rules apply: the first block wins, blocked tools before policies before guards. */
	const handleToolCall = (toolName: string, input: Record<string, unknown>): ToolBlock | undefined => {
		const live = layers.map(available).filter((definition): definition is RuntimeDefinition => definition !== undefined);
		for (const definition of live) {
			if (definition.blockedTools.has(toolName)) return { block: true, reason: `Tool ${toolName} is blocked by mode ${definition.id}.` };
		}
		for (const definition of live) {
			const block = toolPolicyBlock(definition, toolName, input);
			if (block !== undefined) return block;
		}
		for (const definition of live) {
			const block = guardBlock(definition, toolName, input);
			if (block !== undefined) return block;
		}
		return undefined;
	};
	const setTrail = (text: string | undefined): ContextAwareModeResultV1 => {
		if (!active()) return refused("STALE_RUNTIME", "The session runtime is no longer active.");
		const normalized = normalizeModeTrail(text);
		if (normalized === null) return refused("INVALID_REQUEST", "The trail is too long or holds control characters.");
		if (normalized !== trailText) {
			trailText = normalized;
			deps.onChange?.();
		}
		return { status: "ok" };
	};
	const close = (): void => {
		closed = true;
		revision += 1;
		definitions.clear();
		handleRecords.length = 0;
		suggestionConfirmer = undefined;
		pinnedWindowOpen = false;
		for (const remove of runListeners.values()) remove();
		runListeners.clear();
	};
	const runtime: ContextAwareModesRuntime = {
		defineMode,
		current,
		layers: () => Object.freeze(layers.map(snapshotOf)),
		setTrail,
		setSuggestionConfirmer(confirmer) {
			suggestionConfirmer = confirmer;
		},
		enterSuggested: (id, reason) => suggest(id, "enter", reason),
		exitSuggested: (id, reason) => suggest(id, "exit", reason),
		handleToolCall,
		restore,
		resend,
		userExit,
		openPinnedWindow: () => {
			if (active() && !layers.some((slot) => slot.pinned === true)) pinnedWindowOpen = true;
		},
		closePinnedWindow: () => {
			pinnedWindowOpen = false;
		},
		trail: () => trailText,
		close,
		isClosed: () => closed,
	};
	restore();
	return runtime;
}
