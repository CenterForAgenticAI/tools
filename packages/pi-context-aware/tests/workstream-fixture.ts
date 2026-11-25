/**
 * Test builders for focus snapshots and the transcript entries that carry them.
 *
 * pi-workstream writes these entries now; this package only reads them. The builders write
 * pi-workstream's entry type by default, and `customType` writes the older
 * `context-aware.workstream.v1` type that sessions from before the move hold.
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
} from "../src/snapshot-contracts/schema.js";
import { WORKSTREAM_ENTRY_TYPE } from "../src/snapshot-contracts/transcript.js";

export { LEGACY_WORKSTREAM_ENTRY_TYPE, WORKSTREAM_ENTRY_TYPE } from "../src/snapshot-contracts/transcript.js";

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
	readonly customType?: string;
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
		customType: options.customType ?? WORKSTREAM_ENTRY_TYPE,
		data,
	};
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
