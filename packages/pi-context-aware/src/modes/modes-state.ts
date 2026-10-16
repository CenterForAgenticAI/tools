import { createHash } from "node:crypto";
import type { ContextAwareModeSnapshotV1 } from "../context-service.js";

export const MODE_STATE_ENTRY_TYPE = "context-aware/mode@1" as const;
export const MODE_MESSAGE_TYPE = "context-aware/mode-transition@1" as const;
export const MODE_STATE_SCHEMA_VERSION = 1 as const;

export const MAX_MODE_ID_LENGTH = 128;
export const MAX_MODE_OWNER_LENGTH = 128;
export const MAX_MODE_TRANSITION_LENGTH = 4_000;
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

export interface ModeStateEntryData {
	readonly schemaVersion: typeof MODE_STATE_SCHEMA_VERSION;
	readonly current: ModeStateReference | null;
	readonly outer: ModeStateReference | null;
	readonly updatedAt: string;
	/** Also in the details of this entry's transition message. Absent in entries written before it existed. */
	readonly transitionId?: string;
}

export interface ReplayedModeState {
	readonly current: ModeStateReference | null;
	readonly outer: ModeStateReference | null;
	readonly updatedAt: string;
	readonly transitionText?: string;
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

/** A reference as stored. `instanceId` is absent in entries written before it existed. */
interface StoredReference extends Omit<ModeStateReference, "instanceId"> {
	readonly instanceId?: string;
}

interface StoredEntryData {
	readonly current: StoredReference | null;
	readonly outer: StoredReference | null;
	readonly updatedAt: string;
	readonly transitionId?: string;
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

function parseStoredEntry(value: unknown): StoredEntryData | null {
	if (!isRecord(value)) return null;
	const data = isRecord(value.data) ? value.data : value;
	if (data.schemaVersion !== MODE_STATE_SCHEMA_VERSION || !isIsoTimestamp(data.updatedAt)) return null;
	const current = data.current === null ? null : parseReference(data.current);
	const outer = data.outer === null ? null : parseReference(data.outer);
	if ((data.current !== null && current === null) || (data.outer !== null && outer === null)) return null;
	if (current !== null && outer !== null && current.id === outer.id) return null;
	if (data.transitionId !== undefined && !boundedString(data.transitionId, MAX_MODE_TRANSITION_ID_LENGTH)) return null;
	return { current, outer, updatedAt: data.updatedAt, ...(data.transitionId === undefined ? {} : { transitionId: data.transitionId }) };
}

/** What makes two stored references the same enter when neither has an instance id. */
function identityKey(reference: StoredReference): string {
	return JSON.stringify([reference.id, reference.owner, reference.enteredAt]);
}

/** Instances that are active after the last accepted state entry, and those that ended. */
interface IdentityLedger {
	/** instanceId → identity key of the enter it belongs to. */
	readonly live: Map<string, string>;
	readonly retired: Set<string>;
}

interface ResolvedEntry {
	readonly current: ModeStateReference | null;
	readonly outer: ModeStateReference | null;
}

/**
 * Give each reference of one stored entry its instance id and check that the
 * id still names one enter. A reference stored without an id inherits the id of
 * the active instance with the same mode id, owner and enteredAt (a later entry
 * copying it), or else starts a new enter whose id is derived from this session
 * entry's own id. An id that ended earlier on the branch, an id that is active
 * for a different enter, or one id on both current and outer refuses the whole
 * entry, as a malformed field does. A legacy enter in an entry with no session
 * entry id is refused too: Pi always gives one, and an id taken from a position
 * would not be unique across branches.
 */
function resolveEntry(stored: StoredEntryData, entryId: unknown, ledger: IdentityLedger): ResolvedEntry | null {
	const liveByKey = new Map<string, string>();
	for (const [instanceId, key] of ledger.live) liveByKey.set(key, instanceId);
	const resolve = (reference: StoredReference | null): ModeStateReference | null | undefined => {
		if (reference === null) return null;
		const key = identityKey(reference);
		let instanceId = reference.instanceId ?? liveByKey.get(key);
		if (instanceId === undefined) {
			if (typeof entryId !== "string" || entryId.length === 0) return undefined;
			const digest = createHash("sha256").update(JSON.stringify([entryId, reference.id, reference.owner, reference.enteredAt])).digest("hex");
			instanceId = `legacy-${digest.slice(0, 32)}`;
		}
		if (ledger.retired.has(instanceId)) return undefined;
		const liveKey = ledger.live.get(instanceId);
		if (liveKey !== undefined && liveKey !== key) return undefined;
		return {
			id: reference.id,
			owner: reference.owner,
			instanceId,
			...(reference.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
			enteredAt: reference.enteredAt,
		};
	};
	const current = resolve(stored.current);
	const outer = resolve(stored.outer);
	if (current === undefined || outer === undefined) return null;
	if (current !== null && outer !== null && current.instanceId === outer.instanceId) return null;
	return { current, outer };
}

/** The last state entry that parses and keeps every instance id to one enter. */
type AcceptedState = ResolvedEntry & { index: number; updatedAt: string; transitionId?: string };

function lastAcceptedState(entries: readonly unknown[]): AcceptedState | undefined {
	const ledger: IdentityLedger = { live: new Map(), retired: new Set() };
	let accepted: AcceptedState | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
		const stored = parseStoredEntry(entry.data);
		if (stored === null) continue;
		const resolved = resolveEntry(stored, entry.id, ledger);
		if (resolved === null) continue;
		const next = new Map<string, string>();
		for (const reference of [resolved.current, resolved.outer]) {
			if (reference !== null) next.set(reference.instanceId, identityKey(reference));
		}
		for (const instanceId of ledger.live.keys()) if (!next.has(instanceId)) ledger.retired.add(instanceId);
		ledger.live.clear();
		for (const [instanceId, key] of next) ledger.live.set(instanceId, key);
		accepted = { ...resolved, index, updatedAt: stored.updatedAt, ...(stored.transitionId === undefined ? {} : { transitionId: stored.transitionId }) };
	}
	return accepted;
}


function transitionTextFromEntry(entry: SessionEntryLike): string | undefined {
	if (entry.customType !== MODE_MESSAGE_TYPE || typeof entry.content !== "string") return undefined;
	return entry.content.length <= MAX_MODE_TRANSITION_LENGTH ? entry.content : undefined;
}

function messageTransitionId(entry: SessionEntryLike): unknown {
	return isRecord(entry.details) ? entry.details.transitionId : undefined;
}

function messageMatches(entry: SessionEntryLike, state: ModeStateReference): boolean {
	if (!isRecord(entry.details)) return true;
	return entry.details.id === state.id && entry.details.owner === state.owner;
}

/**
 * The text of the accepted entry's own transition message, found by its
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
			started = entry.customType === MODE_STATE_ENTRY_TYPE && isRecord(entry.data) && entry.data.transitionId === transitionId;
			continue;
		}
		if (entry.customType === MODE_MESSAGE_TYPE && messageTransitionId(entry as SessionEntryLike) === transitionId) return transitionTextFromEntry(entry as SessionEntryLike);
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
		if (isRecord(entry) && entry.customType === MODE_STATE_ENTRY_TYPE) return index;
	}
	return entries.length;
}

export function replayModeState(entries: readonly unknown[]): ReplayedModeState {
	const accepted = lastAcceptedState(entries);
	if (accepted === undefined) return { current: null, outer: null, updatedAt: new Date(0).toISOString() };
	if (accepted.transitionId !== undefined) {
		const text = accepted.current === null ? undefined : textForTransition(entries, accepted.transitionId);
		return { current: accepted.current, outer: accepted.outer, updatedAt: accepted.updatedAt, ...(text === undefined ? {} : { transitionText: text }) };
	}
	const acceptedIndex = accepted.index;
	const end = messageWindowEnd(entries, acceptedIndex);
	const legacyMessage = (index: number): SessionEntryLike | undefined => {
		const entry = entries[index];
		if (!isRecord(entry) || messageTransitionId(entry as SessionEntryLike) !== undefined) return undefined;
		return entry as SessionEntryLike;
	};
	let transitionText: string | undefined;
	for (let index = end - 1; index > acceptedIndex && transitionText === undefined; index -= 1) {
		const message = legacyMessage(index);
		if (message !== undefined) transitionText = transitionTextFromEntry(message);
	}
	let matchingText: string | undefined;
	if (accepted.current !== null) {
		for (let messageIndex = acceptedIndex + 1; messageIndex < end; messageIndex += 1) {
			const messageLike = legacyMessage(messageIndex);
			if (messageLike === undefined) continue;
			if (messageMatches(messageLike, accepted.current)) {
				matchingText = transitionTextFromEntry(messageLike);
				if (matchingText !== undefined) break;
			}
		}
	}
	return {
		current: accepted.current,
		outer: accepted.outer,
		updatedAt: accepted.updatedAt,
		...(matchingText ?? transitionText ? { transitionText: matchingText ?? transitionText } : {}),
	};
}

export function copyReference(reference: ModeStateReference | null): ModeStateReference | null {
	if (reference === null) return null;
	return {
		id: reference.id,
		owner: reference.owner,
		instanceId: reference.instanceId,
		...(reference.suggestedBy === "model" ? { suggestedBy: "model" as const } : {}),
		enteredAt: reference.enteredAt,
	};
}

export function createModeStateEntry(
	current: ModeStateReference | null,
	outer: ModeStateReference | null,
	updatedAt: string,
	transitionId?: string,
): ModeStateEntryData {
	return {
		schemaVersion: MODE_STATE_SCHEMA_VERSION,
		current: copyReference(current),
		outer: copyReference(outer),
		updatedAt,
		...(transitionId === undefined ? {} : { transitionId }),
	};
}

export function snapshotReference(
	reference: ModeStateReference,
	available: boolean,
	updatedAt: string,
	outer?: ContextAwareModeSnapshotV1,
): ContextAwareModeSnapshotV1 {
	const snapshot: ContextAwareModeSnapshotV1 = {
		id: reference.id,
		owner: reference.owner,
		instanceId: reference.instanceId,
		available,
		suggestedBy: reference.suggestedBy,
		enteredAt: reference.enteredAt,
		updatedAt,
		...(outer === undefined ? {} : { outer }),
	};
	return Object.freeze(snapshot);
}
