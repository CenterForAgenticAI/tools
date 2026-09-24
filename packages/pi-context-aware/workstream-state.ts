/** Transcript-backed workstream state primitives.
 *
 * Only a validated complete snapshot carried by a Pi custom entry is state. All
 * other representations (summaries, cache documents, registry records, peer
 * metadata, activity, and terminal data) are projections and intentionally have
 * no parser in this module.
 */

import { randomUUID } from "node:crypto";
import {
	WORKSTREAM_SCHEMA_VERSION,
	asPiSessionId,
	asWorkstreamId,
	parseWorkstreamSnapshot,
	parseWorkstreamMutation,
	type WorkstreamGoal,
	type WorkstreamMutation,
	type WorkstreamRef,
	type WorkstreamSnapshot,
	type WorkstreamStatus,
} from "./workstream-schema.js";

export const WORKSTREAM_ENTRY_TYPE = "context-aware.workstream.v1" as const;

export interface TranscriptCustomEntry<T = unknown> {
	readonly type: "custom";
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly customType: string;
	readonly data?: T;
}

export interface WorkstreamEntryData {
	readonly snapshot: WorkstreamSnapshot;
	readonly mutation?: WorkstreamMutation;
	readonly priorRevision?: number;
	readonly previousEventId?: string;
}

export type WorkstreamEntry = TranscriptCustomEntry<WorkstreamSnapshot | WorkstreamEntryData>;

export interface SnapshotIdentityOptions {
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly intercomConnectionId?: string;
	readonly terminal?: WorkstreamSnapshot["terminal"];
}

export interface CreateSnapshotOptions extends SnapshotIdentityOptions {
	readonly objective: string;
	readonly objectivePinned?: boolean;
	readonly status?: WorkstreamStatus;
	readonly goals?: readonly WorkstreamGoal[];
	readonly refs?: readonly WorkstreamRef[];
	readonly boundaries?: readonly string[];
	readonly revision?: number;
	readonly eventId?: string;
	readonly now?: string | Date;
	readonly provenance?: WorkstreamSnapshot["provenance"];
	readonly idFactory?: () => string;
}

function timestamp(value: string | Date | undefined): string {
	if (value === undefined) return new Date().toISOString();
	const result = value instanceof Date ? value.toISOString() : value;
	if (!Number.isFinite(Date.parse(result))) throw new Error("snapshot timestamp must be an ISO date");
	return result;
}

function generatedId(factory: (() => string) | undefined, prefix: string): string {
	const value = (factory ?? randomUUID)();
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error(`${prefix} must be a bounded non-empty string`);
	return value;
}

/** Build a complete, schema-validated snapshot before it is appended. */
export function createWorkstreamSnapshot(options: CreateSnapshotOptions): WorkstreamSnapshot {
	const now = timestamp(options.now);
	const snapshot: WorkstreamSnapshot = {
		schemaVersion: WORKSTREAM_SCHEMA_VERSION,
		eventId: options.eventId ?? generatedId(options.idFactory, "eventId"),
		workstreamId: asWorkstreamId(options.workstreamId),
		piSessionId: asPiSessionId(options.piSessionId),
		...(options.intercomConnectionId === undefined ? {} : { intercomConnectionId: options.intercomConnectionId as WorkstreamSnapshot["intercomConnectionId"] }),
		...(options.terminal === undefined ? {} : { terminal: options.terminal }),
		revision: options.revision ?? 1,
		objective: options.objective,
		objectivePinned: options.objectivePinned ?? false,
		status: options.status ?? "active",
		goals: [...(options.goals ?? [])],
		refs: [...(options.refs ?? [])],
		boundaries: [...(options.boundaries ?? [])],
		createdAt: now,
		updatedAt: now,
		...(options.provenance === undefined ? {} : { provenance: options.provenance }),
	};
	const parsed = parseWorkstreamSnapshot(snapshot);
	if (!parsed) throw new Error("snapshot does not satisfy the workstream schema");
	return parsed;
}

/** Convert a snapshot into the exact custom-entry payload written to Pi. */
export function workstreamEntry(snapshot: WorkstreamSnapshot, options: {
	readonly entryId?: string;
	readonly parentId?: string | null;
	readonly timestamp?: string | Date;
	readonly idFactory?: () => string;
	readonly mutation?: WorkstreamMutation;
	readonly priorRevision?: number;
	readonly previousEventId?: string;
} = {}): WorkstreamEntry {
	const parsed = parseWorkstreamSnapshot(snapshot);
	if (!parsed) throw new Error("cannot append an invalid workstream snapshot");
	if (options.mutation !== undefined) {
		const parsedMutation = parseWorkstreamMutation(options.mutation);
		if (!parsedMutation || parsedMutation.accepted !== true) throw new Error("cannot append an invalid workstream mutation");
	}
	const hasMetadata = options.mutation !== undefined || options.priorRevision !== undefined || options.previousEventId !== undefined;
	const data: WorkstreamSnapshot | WorkstreamEntryData = hasMetadata
		? {
				snapshot: parsed,
				...(options.mutation === undefined ? {} : { mutation: options.mutation }),
				...(options.priorRevision === undefined ? {} : { priorRevision: options.priorRevision }),
				...(options.previousEventId === undefined ? {} : { previousEventId: options.previousEventId }),
			}
		: parsed;
	return {
		type: "custom",
		id: options.entryId ?? generatedId(options.idFactory, "entryId"),
		parentId: options.parentId ?? null,
		timestamp: timestamp(options.timestamp),
		customType: WORKSTREAM_ENTRY_TYPE,
		data,
	};
}

export interface AppendEntryApi {
	readonly appendEntry: <T = unknown>(customType: string, data?: T) => void;
}

/** Append only validated complete snapshots; Pi supplies the entry envelope. */
export interface AppendWorkstreamSnapshotOptions {
	readonly mutation?: WorkstreamMutation;
	readonly priorRevision?: number;
	readonly previousEventId?: string;
}

export function appendWorkstreamSnapshot(api: AppendEntryApi, snapshot: WorkstreamSnapshot, options: AppendWorkstreamSnapshotOptions = {}): void {
	const parsed = parseWorkstreamSnapshot(snapshot);
	if (!parsed) throw new Error("cannot append an invalid workstream snapshot");
	if (options.mutation === undefined && options.priorRevision === undefined && options.previousEventId === undefined) {
		api.appendEntry(WORKSTREAM_ENTRY_TYPE, parsed);
		return;
	}
	if (options.mutation !== undefined) {
		const parsedMutation = parseWorkstreamMutation(options.mutation);
		if (!parsedMutation || parsedMutation.accepted !== true) throw new Error("cannot append an invalid workstream mutation");
	}
	api.appendEntry(WORKSTREAM_ENTRY_TYPE, {
		snapshot: parsed,
		...(options.mutation === undefined ? {} : { mutation: options.mutation }),
		...(options.priorRevision === undefined ? {} : { priorRevision: options.priorRevision }),
		...(options.previousEventId === undefined ? {} : { previousEventId: options.previousEventId }),
	});
}

export interface DetachedSnapshotOptions {
	readonly piSessionId?: string;
	readonly now?: string | Date;
	readonly eventId?: string;
	readonly workstreamId?: string;
	readonly idFactory?: () => string;
}

/** Start a new stream. The old stream is retained only as provenance metadata. */
export function detachWorkstream(snapshot: WorkstreamSnapshot, options: DetachedSnapshotOptions = {}): WorkstreamSnapshot {
	const source = parseWorkstreamSnapshot(snapshot);
	if (!source) throw new Error("cannot detach an invalid workstream snapshot");
	const workstreamId = options.workstreamId ?? `ws-${generatedId(options.idFactory, "workstreamId")}`;
	const piSessionId = options.piSessionId ?? source.piSessionId;
	if (workstreamId === source.workstreamId) throw new Error("detached workstream must have a new identity");
	if (piSessionId === workstreamId) throw new Error("workstream and Pi session identities must remain distinct");
	return createWorkstreamSnapshot({
		workstreamId,
		piSessionId,
		revision: 1,
		eventId: options.eventId ?? generatedId(options.idFactory, "eventId"),
		objective: source.objective,
		objectivePinned: source.objectivePinned,
		status: "active",
		goals: source.goals,
		refs: source.refs,
		boundaries: source.boundaries,
		now: options.now,
		provenance: {
			source: "user",
			parentPiSessionId: source.piSessionId,
			inheritedWorkstreamId: source.workstreamId,
		},
	});
}

/** Rebind inherited state to a child session without changing the workstream ID. */
export function inheritWorkstream(snapshot: WorkstreamSnapshot, piSessionId: string, options: {
	readonly now?: string | Date;
	readonly eventId?: string;
	readonly idFactory?: () => string;
} = {}): WorkstreamSnapshot {
	const source = parseWorkstreamSnapshot(snapshot);
	if (!source) throw new Error("cannot inherit an invalid workstream snapshot");
	if (piSessionId === source.workstreamId) throw new Error("workstream and Pi session identities must remain distinct");
	return createWorkstreamSnapshot({
		workstreamId: source.workstreamId,
		piSessionId,
		intercomConnectionId: source.intercomConnectionId,
		terminal: source.terminal,
		revision: source.revision,
		eventId: options.eventId ?? generatedId(options.idFactory, "eventId"),
		objective: source.objective,
		objectivePinned: source.objectivePinned,
		status: source.status,
		goals: source.goals,
		refs: source.refs,
		boundaries: source.boundaries,
		now: options.now ?? source.updatedAt,
		provenance: {
			source: "transcript",
			parentPiSessionId: source.piSessionId,
			inheritedWorkstreamId: source.workstreamId,
		},
	});
}

/** Optional chain metadata is validated separately from the canonical snapshot. */
export interface TranscriptWorkstreamChainMetadata {
	readonly priorRevision?: number;
	readonly previousEventId?: string;
}

export interface ParsedTranscriptWorkstreamEntry {
	readonly snapshot: WorkstreamSnapshot;
	readonly metadata: TranscriptWorkstreamChainMetadata;
	readonly mutation?: WorkstreamMutation;
	readonly entryId: string;
	readonly timestamp: string;
}

function parseTranscriptChainMetadata(value: Record<string, unknown>): TranscriptWorkstreamChainMetadata | null {
	const hasPriorRevision = Object.prototype.hasOwnProperty.call(value, "priorRevision");
	const hasPreviousEventId = Object.prototype.hasOwnProperty.call(value, "previousEventId");
	if (hasPriorRevision && (typeof value.priorRevision !== "number" || !Number.isSafeInteger(value.priorRevision) || value.priorRevision < 0)) return null;
	if (hasPreviousEventId && (typeof value.previousEventId !== "string" || value.previousEventId.trim().length === 0 || value.previousEventId.length > 256)) return null;
	return {
		...(hasPriorRevision ? { priorRevision: value.priorRevision as number } : {}),
		...(hasPreviousEventId ? { previousEventId: value.previousEventId as string } : {}),
	};
}

/** Parse a complete transcript entry and its validated optional chain metadata. */
export function parseTranscriptWorkstreamEntryDetails(value: unknown): ParsedTranscriptWorkstreamEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== "custom" || candidate.customType !== WORKSTREAM_ENTRY_TYPE) return null;
	if (typeof candidate.id !== "string" || candidate.id.trim().length === 0 || candidate.id.length > 256) return null;
	if (candidate.parentId !== null && (typeof candidate.parentId !== "string" || candidate.parentId.length > 256)) return null;
	if (typeof candidate.timestamp !== "string" || !Number.isFinite(Date.parse(candidate.timestamp))) return null;
	const data = candidate.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const payload = data as Record<string, unknown>;
	const snapshotValue = Object.prototype.hasOwnProperty.call(payload, "snapshot") ? payload.snapshot : data;
	if (typeof snapshotValue !== "object" || snapshotValue === null || Array.isArray(snapshotValue)) return null;
	const snapshotRecord = snapshotValue as Record<string, unknown>;
	const outerMetadata = parseTranscriptChainMetadata(payload);
	const snapshotMetadata = payload === snapshotRecord ? outerMetadata : parseTranscriptChainMetadata(snapshotRecord);
	let mutation: WorkstreamMutation | undefined;
	if (payload.mutation !== undefined) {
		const parsedMutation = parseWorkstreamMutation(payload.mutation);
		if (!parsedMutation || parsedMutation.accepted !== true) return null;
		mutation = parsedMutation;
	}
	if (outerMetadata === null || snapshotMetadata === null) return null;
	if (outerMetadata.priorRevision !== undefined && snapshotMetadata.priorRevision !== undefined && outerMetadata.priorRevision !== snapshotMetadata.priorRevision) return null;
	if (outerMetadata.previousEventId !== undefined && snapshotMetadata.previousEventId !== undefined && outerMetadata.previousEventId !== snapshotMetadata.previousEventId) return null;
	const metadata: TranscriptWorkstreamChainMetadata = {
		...(outerMetadata.priorRevision === undefined ? {} : { priorRevision: outerMetadata.priorRevision }),
		...(snapshotMetadata.priorRevision === undefined ? {} : { priorRevision: snapshotMetadata.priorRevision }),
		...(outerMetadata.previousEventId === undefined ? {} : { previousEventId: outerMetadata.previousEventId }),
		...(snapshotMetadata.previousEventId === undefined ? {} : { previousEventId: snapshotMetadata.previousEventId }),
	};
	const snapshot = parseWorkstreamSnapshot(snapshotValue);
	if (!snapshot) return null;
	if (mutation !== undefined) {
		if (mutation.workstreamId !== snapshot.workstreamId || mutation.newRevision !== snapshot.revision) return null;
		if (mutation.kind !== "detach" && mutation.priorRevision !== snapshot.revision - 1) return null;
		if (mutation.kind === "detach" && snapshot.revision !== 1) return null;
	}
	return { snapshot, metadata, ...(mutation === undefined ? {} : { mutation }), entryId: candidate.id, timestamp: candidate.timestamp };
}

/** A narrow guard used by replay; projections cannot satisfy this contract. */
export function parseTranscriptWorkstreamEntry(value: unknown): WorkstreamSnapshot | null {
	return parseTranscriptWorkstreamEntryDetails(value)?.snapshot ?? null;
}

export function isTranscriptWorkstreamEntry(value: unknown): value is WorkstreamEntry {
	return parseTranscriptWorkstreamEntry(value) !== null;
}
