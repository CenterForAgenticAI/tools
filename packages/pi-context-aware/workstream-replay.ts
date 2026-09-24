/** Deterministic replay and inheritance resolution for authoritative snapshots. */

import {
	isHandoffExpired,
	parseWorktreeHandoff,
	type WorktreeHandoff,
} from "./peer-contracts.js";
import {
	parseTranscriptWorkstreamEntry,
	parseTranscriptWorkstreamEntryDetails,
	type WorkstreamEntry,
	WORKSTREAM_ENTRY_TYPE,
} from "./workstream-state.js";
import {
	asPiSessionId,
	type WorkstreamMutation,
	type WorkstreamProvenance,
	type WorkstreamSnapshot,
} from "./workstream-schema.js";

export const MAX_REPLAY_ENTRIES = 10_000;

export interface ReplayOptions {
	/** Optional cap protects startup from adversarially large transcript arrays. */
	readonly maxEntries?: number;
}

export interface ReplayCandidate {
	readonly snapshot: WorkstreamSnapshot;
	readonly entryId: string;
	readonly timestamp: string;
	readonly index: number;
	readonly priorRevision?: number;
	readonly previousEventId?: string;
	readonly mutation?: WorkstreamMutation;
}

export interface ReplayResult {
	readonly snapshot: WorkstreamSnapshot | null;
	readonly authority: "transcript" | null;
	readonly provenance?: WorkstreamProvenance;
	readonly mutation?: WorkstreamMutation;
	readonly candidates: readonly ReplayCandidate[];
	readonly rejected: number;
	readonly duplicateEventIds: number;
	readonly chainValid: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function candidateTie(a: ReplayCandidate, b: ReplayCandidate): number {
	if (a.snapshot.revision !== b.snapshot.revision) return a.snapshot.revision - b.snapshot.revision;
	const snapshotOrder = canonical(a.snapshot).localeCompare(canonical(b.snapshot));
	if (snapshotOrder !== 0) return snapshotOrder;
	const metadataOrder = canonical({ priorRevision: a.priorRevision, previousEventId: a.previousEventId })
		.localeCompare(canonical({ priorRevision: b.priorRevision, previousEventId: b.previousEventId }));
	if (metadataOrder !== 0) return metadataOrder;
	// Mutation provenance is authoritative and must not be selected by input order.
	const mutationOrder = canonical(a.mutation ?? null).localeCompare(canonical(b.mutation ?? null));
	if (mutationOrder !== 0) return mutationOrder;
	if (a.entryId !== b.entryId) return a.entryId.localeCompare(b.entryId);
	return a.timestamp.localeCompare(b.timestamp);
}

interface ReplayLineage {
	readonly candidates: readonly ReplayCandidate[];
	readonly terminal: ReplayCandidate;
}

function compareLineages(a: ReplayLineage, b: ReplayLineage): number {
	if (a.terminal.snapshot.revision !== b.terminal.snapshot.revision) {
		return a.terminal.snapshot.revision - b.terminal.snapshot.revision;
	}
	if (a.terminal.timestamp !== b.terminal.timestamp) return a.terminal.timestamp.localeCompare(b.terminal.timestamp);
	if (a.terminal.index !== b.terminal.index) return a.terminal.index - b.terminal.index;
	return candidateTie(a.terminal, b.terminal);
}

function canFollow(candidate: ReplayCandidate, previous: ReplayCandidate): boolean {
	if (candidate.snapshot.revision !== previous.snapshot.revision + 1) return false;
	if (candidate.priorRevision !== undefined && candidate.priorRevision !== previous.snapshot.revision) return false;
	if (candidate.previousEventId !== undefined && candidate.previousEventId !== previous.snapshot.eventId) return false;
	return Date.parse(candidate.snapshot.createdAt) >= Date.parse(previous.snapshot.createdAt);
}

/** Find every reachable terminal and retain the best complete lineage for each. */
function validLineages(candidates: readonly ReplayCandidate[]): readonly ReplayLineage[] {
	const byRevision = new Map<number, ReplayCandidate[]>();
	const byEventId = new Map<string, ReplayCandidate>();
	for (const candidate of candidates) {
		const revision = byRevision.get(candidate.snapshot.revision) ?? [];
		revision.push(candidate);
		byRevision.set(candidate.snapshot.revision, revision);
		byEventId.set(candidate.snapshot.eventId, candidate);
	}
	const paths = new Map<string, ReplayLineage>();
	const revisions = [...byRevision.keys()].sort((a, b) => a - b);
	for (const revision of revisions) {
		for (const candidate of byRevision.get(revision) ?? []) {
			if (revision === 1) {
				if ((candidate.priorRevision === undefined || candidate.priorRevision === 0) && candidate.previousEventId === undefined) {
					paths.set(candidate.snapshot.eventId, { candidates: [candidate], terminal: candidate });
				}
				continue;
			}
			let best: ReplayLineage | null = null;
			const predecessors = candidate.previousEventId === undefined
				? byRevision.get(revision - 1) ?? []
				: [byEventId.get(candidate.previousEventId)].filter((value): value is ReplayCandidate => value !== undefined);
			for (const predecessor of predecessors) {
				const predecessorLineage = paths.get(predecessor.snapshot.eventId);
				if (!predecessorLineage || predecessor.snapshot.workstreamId !== candidate.snapshot.workstreamId || !canFollow(candidate, predecessor)) continue;
				if (!best || compareLineages(predecessorLineage, best) > 0) best = predecessorLineage;
			}
			if (best) paths.set(candidate.snapshot.eventId, { candidates: [...best.candidates, candidate], terminal: candidate });
		}
	}
	return [...paths.values()];
}

function compareStreamLineages(a: ReplayLineage, b: ReplayLineage): number {
	const updatedAt = Date.parse(a.terminal.snapshot.updatedAt) - Date.parse(b.terminal.snapshot.updatedAt);
	if (updatedAt !== 0) return updatedAt;
	// Equal snapshot timestamps are resolved by validated transcript chronology,
	// not by the old stream's revision count.
	const transcriptTimestamp = a.terminal.timestamp.localeCompare(b.terminal.timestamp);
	if (transcriptTimestamp !== 0) return transcriptTimestamp;
	if (a.terminal.index !== b.terminal.index) return a.terminal.index - b.terminal.index;
	return compareLineages(a, b);
}

function latestValidChain(candidates: readonly ReplayCandidate[]): ReplayLineage | null {
	const byWorkstream = new Map<string, ReplayCandidate[]>();
	for (const candidate of candidates) {
		const stream = byWorkstream.get(candidate.snapshot.workstreamId) ?? [];
		stream.push(candidate);
		byWorkstream.set(candidate.snapshot.workstreamId, stream);
	}
	let latest: ReplayLineage | null = null;
	for (const stream of byWorkstream.values()) {
		const streamLineages = validLineages(stream);
		const streamLatest = streamLineages.reduce<ReplayLineage | null>((best, lineage) => (
			best === null || compareLineages(lineage, best) > 0 ? lineage : best
		), null);
		if (streamLatest !== null && (latest === null || compareStreamLineages(streamLatest, latest) > 0)) latest = streamLatest;
	}
	return latest;
}

function inheritedProvenance(lineage: ReplayLineage | null): WorkstreamProvenance | undefined {
	if (!lineage) return undefined;
	for (let index = lineage.candidates.length - 1; index >= 0; index -= 1) {
		const provenance = lineage.candidates[index]?.snapshot.provenance;
		if (provenance !== undefined) return provenance;
	}
	return undefined;
}

/**
 * Replay only complete, supported custom entries. No projection or fallback
 * argument is accepted here, so summaries/cache/registry/activity/peer/
 * terminal metadata can never establish authority.
 */
export function replayWorkstreamEntries(entries: readonly unknown[], options: ReplayOptions = {}): ReplayResult {
	if (!Array.isArray(entries)) return { snapshot: null, authority: null, candidates: [], rejected: 0, duplicateEventIds: 0, chainValid: false };
	const maxEntries = options.maxEntries ?? MAX_REPLAY_ENTRIES;
	const boundedEntries = entries.slice(0, Math.max(0, Math.min(maxEntries, MAX_REPLAY_ENTRIES)));
	const byEventId = new Map<string, ReplayCandidate>();
	let rejected = Math.max(0, entries.length - boundedEntries.length);
	let duplicateEventIds = 0;
	for (let index = 0; index < boundedEntries.length; index += 1) {
		const entry = boundedEntries[index];
		const details = parseTranscriptWorkstreamEntryDetails(entry);
		if (!details) {
			rejected += 1;
			continue;
		}
		const candidate: ReplayCandidate = {
			snapshot: details.snapshot,
			entryId: details.entryId,
			timestamp: details.timestamp,
			index,
			...details.metadata,
			...(details.mutation === undefined ? {} : { mutation: details.mutation }),
		};
		const prior = byEventId.get(details.snapshot.eventId);
		if (prior) {
			duplicateEventIds += 1;
			if (candidateTie(candidate, prior) < 0) byEventId.set(details.snapshot.eventId, candidate);
			continue;
		}
		byEventId.set(details.snapshot.eventId, candidate);
	}
	const candidates = [...byEventId.values()].sort(candidateTie);
	const lineage = latestValidChain(candidates);
	const snapshot = lineage?.terminal.snapshot ?? null;
	const provenance = inheritedProvenance(lineage);
	const mutation = lineage?.terminal.mutation;
	return {
		snapshot,
		authority: snapshot === null ? null : "transcript",
		...(provenance === undefined ? {} : { provenance }),
		...(mutation === undefined ? {} : { mutation }),
		candidates,
		rejected,
		duplicateEventIds,
		chainValid: snapshot !== null,
	};
}

export interface InheritanceResolution {
	/** Only transcript means an authoritative state was found. */
	readonly authority: "transcript" | null;
	readonly snapshot: WorkstreamSnapshot | null;
	readonly provenance?: WorkstreamProvenance;
	readonly launcherFallback?: Pick<WorktreeHandoff, "handoffId" | "workstreamId" | "parentPiSessionId">;
}

export interface InheritanceOptions {
	readonly launcherHandoff?: unknown;
	readonly now?: Date;
}

/** Transcript provenance wins; launcher data is an expiring, non-authoritative fallback. */
export function resolveWorkstreamInheritance(entries: readonly unknown[], options: InheritanceOptions = {}): InheritanceResolution {
	const replay = replayWorkstreamEntries(entries);
	if (replay.snapshot) {
		return {
			authority: "transcript",
			snapshot: replay.snapshot,
			...(replay.provenance === undefined ? {} : { provenance: replay.provenance }),
		};
	}
	const handoff = parseWorktreeHandoff(options.launcherHandoff);
	if (!handoff || isHandoffExpired(handoff, options.now)) return { authority: null, snapshot: null };
	return {
		authority: null,
		snapshot: null,
		provenance: {
			source: "launcher",
			parentPiSessionId: asPiSessionId(handoff.parentPiSessionId),
			inheritedWorkstreamId: handoff.workstreamId as WorkstreamSnapshot["workstreamId"],
			handoffId: handoff.handoffId,
		},
		launcherFallback: {
			handoffId: handoff.handoffId,
			workstreamId: handoff.workstreamId,
			parentPiSessionId: handoff.parentPiSessionId,
		},
	};
}

export function isWorkstreamEntry(value: unknown): value is WorkstreamEntry {
	return record(value) && value.type === "custom" && value.customType === WORKSTREAM_ENTRY_TYPE && parseTranscriptWorkstreamEntry(value) !== null;
}
