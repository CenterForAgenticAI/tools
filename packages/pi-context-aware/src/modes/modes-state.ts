import { createHash } from "node:crypto";
import {
	CONTEXT_AWARE_MODE_COLOR_TOKENS_V1,
	CONTEXT_AWARE_MODE_DEFAULT_LAYER_V1,
	type ContextAwareModeSnapshotV1,
	type ContextAwareModeUiV1,
} from "../context-service.js";

/** The state entry the runtime writes: every active layer. */
export const MODE_STATE_ENTRY_TYPE = "context-aware/mode@2" as const;
/** The state entry of runtimes before layers: one mode and one nested mode. Replay still reads it. */
export const MODE_STATE_ENTRY_TYPE_V1 = "context-aware/mode@1" as const;
export const MODE_MESSAGE_TYPE = "context-aware/mode-transition@1" as const;
export const MODE_STATE_SCHEMA_VERSION = 2 as const;
const MODE_STATE_SCHEMA_VERSION_V1 = 1;

export const MAX_MODE_ID_LENGTH = 128;
export const MAX_MODE_OWNER_LENGTH = 128;
export const MAX_MODE_TRANSITION_LENGTH = 4_000;
export const MAX_MODE_LABEL_LENGTH = 32;
export const MAX_MODE_LAYER_LENGTH = 64;
export const MAX_MODE_RANK = 1_000_000;
/** More layers than any stack needs; bounds a replayed entry. */
export const MAX_MODE_LAYERS = 16;
export const MAX_MODE_TRAIL_LENGTH = 64;
export const MODE_DEFAULT_LAYER = CONTEXT_AWARE_MODE_DEFAULT_LAYER_V1;

const MODE_HEX_COLOR = /^#[0-9a-f]{6}$/iu;
// Control and format characters would let a label move the cursor, recolor the
// footer, or reorder text, so a label may contain neither.
const MODE_LABEL_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MODE_DISPLAY_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A mode id or owner as the footer draws it. Both are only trimmed and
 * length-checked, also when replayed from session entries, so each control or
 * format character becomes U+FFFD: it can neither drive the terminal nor hide.
 */
export function modeDisplayText(text: string): string {
	return text.replace(MODE_DISPLAY_UNSAFE, "\uFFFD");
}

// `/mode exit <layer>` splits on whitespace, and a user cannot type a format
// character, so a layer name is one token of ASCII letters, digits, `_`, `.`
// and `-`, starting with a letter or digit.
const MODE_LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/** True for a trimmed layer name that `/mode exit <layer>` can type: one token of at most MAX_MODE_LAYER_LENGTH characters. */
export function isModeLayerName(value: string): boolean {
	return value.length <= MAX_MODE_LAYER_LENGTH && MODE_LAYER_NAME.test(value);
}

/** True for a layer rank: an integer from -MAX_MODE_RANK to MAX_MODE_RANK. */
export function isModeRank(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_MODE_RANK;
}

/**
 * A trail as the indicator draws it, or null when it is too long or holds a
 * control or format character. An empty text clears the trail.
 */
export function normalizeModeTrail(value: unknown): string | undefined | null {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0) return undefined;
	return [...text].length <= MAX_MODE_TRAIL_LENGTH && !MODE_LABEL_UNSAFE.test(text) ? text : null;
}

/**
 * Copy only `color` and `label`. Returns null when either is present but not
 * accepted, so a mode with a bad indicator is refused rather than shown wrong.
 */
export function normalizeModeUi(value: unknown): Readonly<ContextAwareModeUiV1> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const { color, label } = value as { color?: unknown; label?: unknown };
	let normalizedColor: ContextAwareModeUiV1["color"];
	if (color !== undefined) {
		if (typeof color !== "string") return null;
		if (MODE_HEX_COLOR.test(color)) normalizedColor = color.toLowerCase() as `#${string}`;
		else if ((CONTEXT_AWARE_MODE_COLOR_TOKENS_V1 as readonly string[]).includes(color)) normalizedColor = color as ContextAwareModeUiV1["color"];
		else return null;
	}
	let normalizedLabel: string | undefined;
	if (label !== undefined) {
		if (typeof label !== "string") return null;
		const text = label.trim();
		if (text.length === 0 || [...text].length > MAX_MODE_LABEL_LENGTH || MODE_LABEL_UNSAFE.test(text)) return null;
		normalizedLabel = text;
	}
	return Object.freeze({
		...(normalizedColor === undefined ? {} : { color: normalizedColor }),
		...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
	});
}
export const MAX_MODE_TOOL_LENGTH = 128;
export const MAX_MODE_REASON_LENGTH = 500;
export const MAX_MODE_INSTANCE_ID_LENGTH = 128;
export const MAX_MODE_TRANSITION_ID_LENGTH = 128;

export interface ModeStateReference {
	readonly id: string;
	readonly owner: string;
	/** Unique per enter. Replay derives a stable one for entries written without it. */
	readonly instanceId: string;
	readonly suggestedBy?: "model";
	readonly enteredAt: string;
}

/** One active layer: its place and the mode that holds it. */
export interface ModeLayerState {
	readonly layer: string;
	readonly rank: number;
	readonly pinned?: true;
	/** Entered for one run. Never replayed. */
	readonly runScoped?: true;
	readonly mode: ModeStateReference;
}

/** A layer as a `mode@2` entry stores it. */
interface StoredLayer {
	readonly layer: string;
	readonly rank: number;
	readonly pinned?: true;
	readonly scope?: "run";
	readonly mode: ModeStateReference;
}

export interface ModeStateEntryData {
	readonly schemaVersion: typeof MODE_STATE_SCHEMA_VERSION;
	/** Lowest rank first, ties by layer name. */
	readonly layers: readonly StoredLayer[];
	readonly updatedAt: string;
	/** Also in the details of this entry's transition message. */
	readonly transitionId?: string;
}

export interface ReplayedModeState {
	/** Lowest rank first, without run-scoped layers. */
	readonly layers: readonly ModeLayerState[];
	readonly updatedAt: string;
	/** instanceId → the transition text its enter sent. */
	readonly transitionTexts: ReadonlyMap<string, string>;
}

interface SessionEntryLike {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly customType?: unknown;
	readonly data?: unknown;
	readonly content?: unknown;
	readonly details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/** Lowest rank first; a tie is broken by layer name. */
export function compareModeLayers(left: { layer: string; rank: number }, right: { layer: string; rank: number }): number {
	if (left.rank !== right.rank) return left.rank - right.rank;
	return left.layer < right.layer ? -1 : left.layer > right.layer ? 1 : 0;
}

function isStateEntryType(value: unknown): boolean {
	return value === MODE_STATE_ENTRY_TYPE || value === MODE_STATE_ENTRY_TYPE_V1;
}

/** A reference as stored. `instanceId` is absent in `mode@1` entries written before it existed. */
interface StoredReference extends Omit<ModeStateReference, "instanceId"> {
	readonly instanceId?: string;
}

function parseReference(value: unknown): StoredReference | null {
	if (!isRecord(value)) return null;
	if (!boundedString(value.id, MAX_MODE_ID_LENGTH) || !boundedString(value.owner, MAX_MODE_OWNER_LENGTH)) return null;
	if (!isIsoTimestamp(value.enteredAt)) return null;
	if (value.suggestedBy !== undefined && value.suggestedBy !== "model") return null;
	if (value.instanceId !== undefined && !boundedString(value.instanceId, MAX_MODE_INSTANCE_ID_LENGTH)) return null;
	return {
		id: value.id.trim(),
		owner: value.owner.trim(),
		...(value.instanceId === undefined ? {} : { instanceId: value.instanceId.trim() }),
		...(value.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
		enteredAt: value.enteredAt,
	};
}

/** One stored slot before identity resolution. */
interface StoredSlot {
	readonly layer: string;
	readonly rank: number;
	readonly pinned?: true;
	readonly runScoped?: true;
	readonly mode: StoredReference;
}

interface StoredEntryData {
	readonly version: 1 | 2;
	/** Every reference the entry holds, for the identity ledger. A `mode@1` outer is held but not active. */
	readonly held: readonly StoredReference[];
	/** The active layers, lowest rank first. */
	readonly layers: readonly StoredSlot[];
	readonly updatedAt: string;
	readonly transitionId?: string;
}

function entryData(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	return isRecord(value.data) ? value.data : value;
}

function parseTransitionId(data: Record<string, unknown>): { ok: boolean; transitionId?: string } {
	if (data.transitionId === undefined) return { ok: true };
	return boundedString(data.transitionId, MAX_MODE_TRANSITION_ID_LENGTH) ? { ok: true, transitionId: data.transitionId } : { ok: false };
}

/** A `mode@1` entry: `current` sits on the default layer; the nested-away `outer` is held, not active. */
function parseV1Entry(value: unknown): StoredEntryData | null {
	const data = entryData(value);
	if (data === null || data.schemaVersion !== MODE_STATE_SCHEMA_VERSION_V1 || !isIsoTimestamp(data.updatedAt)) return null;
	const current = data.current === null ? null : parseReference(data.current);
	const outer = data.outer === null ? null : parseReference(data.outer);
	if ((data.current !== null && current === null) || (data.outer !== null && outer === null)) return null;
	if (current !== null && outer !== null && current.id === outer.id) return null;
	const transition = parseTransitionId(data);
	if (!transition.ok) return null;
	return {
		version: 1,
		held: [current, outer].filter((reference): reference is StoredReference => reference !== null),
		layers: current === null ? [] : [{ layer: MODE_DEFAULT_LAYER, rank: 0, mode: current }],
		updatedAt: data.updatedAt,
		...(transition.transitionId === undefined ? {} : { transitionId: transition.transitionId }),
	};
}

/** A `mode@2` entry. Every layer needs an instance id; names, mode ids and instance ids are unique. */
function parseV2Entry(value: unknown): StoredEntryData | null {
	const data = entryData(value);
	if (data === null || data.schemaVersion !== MODE_STATE_SCHEMA_VERSION || !isIsoTimestamp(data.updatedAt)) return null;
	if (!Array.isArray(data.layers) || data.layers.length > MAX_MODE_LAYERS) return null;
	const layers: StoredSlot[] = [];
	for (const raw of data.layers) {
		if (!isRecord(raw) || !boundedString(raw.layer, MAX_MODE_LAYER_LENGTH) || !isModeLayerName(raw.layer.trim()) || !isModeRank(raw.rank)) return null;
		if (raw.pinned !== undefined && raw.pinned !== true) return null;
		if (raw.scope !== undefined && raw.scope !== "run") return null;
		if (raw.pinned === true && raw.scope === "run") return null;
		// The default layer is what a definition without `layer` gets: rank 0, never pinned.
		if (raw.layer.trim() === MODE_DEFAULT_LAYER && (raw.rank !== 0 || raw.pinned === true)) return null;
		const mode = parseReference(raw.mode);
		if (mode === null || mode.instanceId === undefined) return null;
		layers.push({
			layer: raw.layer.trim(),
			rank: raw.rank,
			...(raw.pinned === true ? { pinned: true as const } : {}),
			...(raw.scope === "run" ? { runScoped: true as const } : {}),
			mode,
		});
	}
	const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
	if (!unique(layers.map((slot) => slot.layer)) || !unique(layers.map((slot) => slot.mode.id))) return null;
	const transition = parseTransitionId(data);
	if (!transition.ok) return null;
	layers.sort(compareModeLayers);
	return {
		version: 2,
		held: layers.map((slot) => slot.mode),
		layers,
		updatedAt: data.updatedAt,
		...(transition.transitionId === undefined ? {} : { transitionId: transition.transitionId }),
	};
}

function parseStoredEntry(entry: Record<string, unknown>): StoredEntryData | null {
	if (entry.customType === MODE_STATE_ENTRY_TYPE) return parseV2Entry(entry.data);
	if (entry.customType === MODE_STATE_ENTRY_TYPE_V1) return parseV1Entry(entry.data);
	return null;
}

/** What makes two stored references the same enter when neither has an instance id. */
function identityKey(reference: StoredReference): string {
	return JSON.stringify([reference.id, reference.owner, reference.enteredAt]);
}

/** Instances that are held after the last accepted state entry, and those that ended. */
interface IdentityLedger {
	/** instanceId → identity key of the enter it belongs to. */
	readonly live: Map<string, string>;
	readonly retired: Set<string>;
}

/**
 * Give each reference of one stored entry its instance id and check that the
 * id still names one enter. A reference stored without an id (a `mode@1` entry
 * from before ids) inherits the id of the held instance with the same mode id,
 * owner and enteredAt, or else starts a new enter whose id is derived from this
 * session entry's own id. An id that ended earlier on the branch, an id held by
 * a different enter, or one id twice in the entry refuses the whole entry, as a
 * malformed field does. A legacy enter in an entry with no session entry id is
 * refused too: Pi always gives one, and an id taken from a position would not
 * be unique across branches. Returns the resolved references in input order.
 */
function resolveReferences(references: readonly StoredReference[], entryId: unknown, ledger: IdentityLedger): ModeStateReference[] | null {
	const liveByKey = new Map<string, string>();
	for (const [instanceId, key] of ledger.live) liveByKey.set(key, instanceId);
	const resolved: ModeStateReference[] = [];
	const seen = new Set<string>();
	for (const reference of references) {
		const key = identityKey(reference);
		let instanceId = reference.instanceId ?? liveByKey.get(key);
		if (instanceId === undefined) {
			if (typeof entryId !== "string" || entryId.length === 0) return null;
			const digest = createHash("sha256").update(JSON.stringify([entryId, reference.id, reference.owner, reference.enteredAt])).digest("hex");
			instanceId = `legacy-${digest.slice(0, 32)}`;
		}
		if (ledger.retired.has(instanceId) || seen.has(instanceId)) return null;
		const liveKey = ledger.live.get(instanceId);
		if (liveKey !== undefined && liveKey !== key) return null;
		seen.add(instanceId);
		resolved.push({
			id: reference.id,
			owner: reference.owner,
			instanceId,
			...(reference.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
			enteredAt: reference.enteredAt,
		});
	}
	return resolved;
}

/** The last state entry that parses and keeps every instance id to one enter. */
interface AcceptedState {
	readonly version: 1 | 2;
	readonly index: number;
	readonly layers: readonly ModeLayerState[];
	readonly updatedAt: string;
	readonly transitionId?: string;
}

function acceptedStates(entries: readonly unknown[]): AcceptedState[] {
	const ledger: IdentityLedger = { live: new Map(), retired: new Set() };
	const accepted: AcceptedState[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!isRecord(entry) || !isStateEntryType(entry.customType)) continue;
		const stored = parseStoredEntry(entry);
		if (stored === null) continue;
		const held = resolveReferences(stored.held, entry.id, ledger);
		if (held === null) continue;
		const next = new Map<string, string>();
		for (const reference of held) next.set(reference.instanceId, identityKey(reference));
		for (const instanceId of ledger.live.keys()) if (!next.has(instanceId)) ledger.retired.add(instanceId);
		ledger.live.clear();
		for (const [instanceId, key] of next) ledger.live.set(instanceId, key);
		// `held` lists the layers' modes first, in layer order, for both versions.
		const layers = stored.layers.map((slot, slotIndex): ModeLayerState => ({
			layer: slot.layer,
			rank: slot.rank,
			...(slot.pinned === true ? { pinned: true as const } : {}),
			...(slot.runScoped === true ? { runScoped: true as const } : {}),
			mode: held[slotIndex]!,
		}));
		accepted.push({ version: stored.version, index, layers, updatedAt: stored.updatedAt, ...(stored.transitionId === undefined ? {} : { transitionId: stored.transitionId }) });
	}
	return accepted;
}

function transitionTextFromEntry(entry: SessionEntryLike): string | undefined {
	if (entry.customType !== MODE_MESSAGE_TYPE || typeof entry.content !== "string") return undefined;
	return entry.content.length <= MAX_MODE_TRANSITION_LENGTH ? entry.content : undefined;
}

function messageDetail(entry: SessionEntryLike, key: "transitionId" | "instanceId" | "action"): unknown {
	return isRecord(entry.details) ? entry.details[key] : undefined;
}

function messageMatches(entry: SessionEntryLike, state: ModeStateReference): boolean {
	if (!isRecord(entry.details)) return true;
	return entry.details.id === state.id && entry.details.owner === state.owner;
}

/**
 * The text of an accepted entry's own transition message, found by its
 * `transitionId`. Pi can defer a message to the end of a turn, after later
 * state entries, so position cannot tell which entry a message belongs to. The
 * scan starts at the first state entry with this id, because the runtime sends
 * the message after it; a later copy of that entry can be the accepted one. The
 * first match wins, so a copied message cannot replace the original.
 */
function textForTransition(entries: readonly unknown[], transitionId: string): string | undefined {
	let started = false;
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (!started) {
			started = isStateEntryType(entry.customType) && isRecord(entry.data) && entry.data.transitionId === transitionId;
			continue;
		}
		if (entry.customType === MODE_MESSAGE_TYPE && messageDetail(entry as SessionEntryLike, "transitionId") === transitionId) return transitionTextFromEntry(entry as SessionEntryLike);
	}
	return undefined;
}

/**
 * For an entry written before `transitionId` existed: where its transition
 * messages end. The runtime appended each state entry before its message, so a
 * message after a later state entry belongs to that entry. Pi can defer a
 * message, so the window may also hold an earlier entry's message; the matching
 * scan prefers the accepted mode's. Messages with a `transitionId` belong to
 * newer entries and are skipped.
 */
function messageWindowEnd(entries: readonly unknown[], acceptedIndex: number): number {
	for (let index = acceptedIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		if (isRecord(entry) && isStateEntryType(entry.customType)) return index;
	}
	return entries.length;
}

/** The transition text a `mode@1` entry's current mode had, by the rules that entry was written under. */
function textForV1Entry(entries: readonly unknown[], accepted: AcceptedState): string | undefined {
	const current = accepted.layers[0]?.mode;
	if (current === undefined) return undefined;
	if (accepted.transitionId !== undefined) return textForTransition(entries, accepted.transitionId);
	const end = messageWindowEnd(entries, accepted.index);
	const legacyMessage = (index: number): SessionEntryLike | undefined => {
		const entry = entries[index];
		if (!isRecord(entry) || messageDetail(entry as SessionEntryLike, "transitionId") !== undefined) return undefined;
		return entry as SessionEntryLike;
	};
	let transitionText: string | undefined;
	for (let index = end - 1; index > accepted.index && transitionText === undefined; index -= 1) {
		const message = legacyMessage(index);
		if (message !== undefined) transitionText = transitionTextFromEntry(message);
	}
	for (let index = accepted.index + 1; index < end; index += 1) {
		const message = legacyMessage(index);
		if (message === undefined || !messageMatches(message, current)) continue;
		const text = transitionTextFromEntry(message);
		if (text !== undefined) return text;
	}
	return transitionText;
}

/**
 * The enter text of each instance an accepted `mode@2` entry entered. A
 * message counts only after the first accepted state entry with its
 * `transitionId`, and only when that entry holds the instance the message
 * names; the first match wins. An entry the identity ledger refused vouches
 * for no message.
 */
function v2EnterTexts(entries: readonly unknown[], accepted: readonly AcceptedState[]): Map<string, string> {
	const heldBy = new Map<string, { index: number; instances: Set<string> }>();
	for (const state of accepted) {
		if (state.version !== 2 || state.transitionId === undefined || heldBy.has(state.transitionId)) continue;
		heldBy.set(state.transitionId, { index: state.index, instances: new Set(state.layers.map((slot) => slot.mode.instanceId)) });
	}
	const texts = new Map<string, string>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.customType !== MODE_MESSAGE_TYPE) continue;
		const message = entry as SessionEntryLike;
		const transitionId = messageDetail(message, "transitionId");
		const instanceId = messageDetail(message, "instanceId");
		if (messageDetail(message, "action") !== "enter" || typeof transitionId !== "string" || typeof instanceId !== "string") continue;
		const owner = heldBy.get(transitionId);
		if (texts.has(instanceId) || owner === undefined || owner.index >= index || !owner.instances.has(instanceId)) continue;
		const text = transitionTextFromEntry(message);
		if (text !== undefined) texts.set(instanceId, text);
	}
	return texts;
}

/**
 * The layers of the last accepted state entry, without run-scoped layers, and
 * the transition text of each. A layer that a `mode@1` entry entered gets the
 * text that entry's rules recover.
 */
export function replayModeState(entries: readonly unknown[]): ReplayedModeState {
	const accepted = acceptedStates(entries);
	const last = accepted.at(-1);
	if (last === undefined) return { layers: [], updatedAt: new Date(0).toISOString(), transitionTexts: new Map() };
	const layers = last.layers.filter((slot) => slot.runScoped !== true);
	const texts = v2EnterTexts(entries, accepted);
	const transitionTexts = new Map<string, string>();
	for (const slot of layers) {
		let text = texts.get(slot.mode.instanceId);
		if (text === undefined) {
			for (let index = accepted.length - 1; index >= 0 && text === undefined; index -= 1) {
				const state = accepted[index]!;
				if (state.version === 1 && state.layers[0]?.mode.instanceId === slot.mode.instanceId) text = textForV1Entry(entries, state);
			}
		}
		if (text !== undefined) transitionTexts.set(slot.mode.instanceId, text);
	}
	return { layers, updatedAt: last.updatedAt, transitionTexts };
}

export function copyReference(reference: ModeStateReference): ModeStateReference {
	return {
		id: reference.id,
		owner: reference.owner,
		instanceId: reference.instanceId,
		...(reference.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
		enteredAt: reference.enteredAt,
	};
}

export function copyLayer(layer: ModeLayerState): ModeLayerState {
	return {
		layer: layer.layer,
		rank: layer.rank,
		...(layer.pinned === true ? { pinned: true as const } : {}),
		...(layer.runScoped === true ? { runScoped: true as const } : {}),
		mode: copyReference(layer.mode),
	};
}

export function createModeStateEntry(layers: readonly ModeLayerState[], updatedAt: string, transitionId?: string): ModeStateEntryData {
	return {
		schemaVersion: MODE_STATE_SCHEMA_VERSION,
		layers: [...layers].sort(compareModeLayers).map((layer) => ({
			layer: layer.layer,
			rank: layer.rank,
			...(layer.pinned === true ? { pinned: true as const } : {}),
			...(layer.runScoped === true ? { scope: "run" as const } : {}),
			mode: copyReference(layer.mode),
		})),
		updatedAt,
		...(transitionId === undefined ? {} : { transitionId }),
	};
}

export function snapshotLayer(
	layer: ModeLayerState,
	available: boolean,
	updatedAt: string,
	outer?: ContextAwareModeSnapshotV1,
	ui?: Readonly<ContextAwareModeUiV1>,
): ContextAwareModeSnapshotV1 {
	const reference = layer.mode;
	const snapshot: ContextAwareModeSnapshotV1 = {
		id: reference.id,
		owner: reference.owner,
		instanceId: reference.instanceId,
		available,
		suggestedBy: reference.suggestedBy,
		enteredAt: reference.enteredAt,
		updatedAt,
		layer: layer.layer,
		rank: layer.rank,
		...(layer.pinned === true ? { pinned: true as const } : {}),
		...(layer.runScoped === true ? { runScoped: true as const } : {}),
		...(outer === undefined ? {} : { outer }),
		...(ui === undefined ? {} : { ui }),
	};
	return Object.freeze(snapshot);
}
