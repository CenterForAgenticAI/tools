/** Deterministic replay and inheritance resolution for authoritative snapshots. */

import {
	isHandoffExpired,
	parseWorktreeHandoff,
	type WorktreeHandoff,
} from "../platform/peer-contracts.js";
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

/**
 * A reachable snapshot and the predecessor its best lineage runs through. The
 * lineage itself is never copied: replay walks these links once, from the
 * winning terminal only.
 */
interface LineageNode {
	readonly candidate: ReplayCandidate;
	readonly predecessor: LineageNode | null;
}

/**
 * Orders lineages by their terminal snapshot alone. The prefix of a lineage
 * never affects the order, so the best lineage through a snapshot is the best
 * lineage through its best eligible predecessor.
 */
function compareTerminals(a: ReplayCandidate, b: ReplayCandidate): number {
	if (a.snapshot.revision !== b.snapshot.revision) return a.snapshot.revision - b.snapshot.revision;
	if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
	if (a.index !== b.index) return a.index - b.index;
	return candidateTie(a, b);
}

function canFollow(candidate: ReplayCandidate, previous: ReplayCandidate): boolean {
	if (candidate.snapshot.revision !== previous.snapshot.revision + 1) return false;
	if (candidate.priorRevision !== undefined && candidate.priorRevision !== previous.snapshot.revision) return false;
	if (candidate.previousEventId !== undefined && candidate.previousEventId !== previous.snapshot.eventId) return false;
	return Date.parse(candidate.snapshot.createdAt) >= Date.parse(previous.snapshot.createdAt);
}

function isRoot(candidate: ReplayCandidate): boolean {
	return candidate.snapshot.revision === 1
		&& (candidate.priorRevision === undefined || candidate.priorRevision === 0)
		&& candidate.previousEventId === undefined;
}

/**
 * The reachable snapshots of one revision, ordered by creation time, with the
 * best terminal among each prefix. A legacy successor that names no predecessor
 * may follow any of them created no later than itself, so a binary search for
 * that bound finds its best predecessor.
 */
interface ReachableRevision {
	readonly createdAt: readonly number[];
	readonly bestUpTo: readonly LineageNode[];
}

function reachableRevision(nodes: readonly LineageNode[]): ReachableRevision {
	const sorted = nodes
		.map((node) => ({ node, createdAt: Date.parse(node.candidate.snapshot.createdAt) }))
		.sort((a, b) => a.createdAt - b.createdAt);
	const createdAt: number[] = [];
	const bestUpTo: LineageNode[] = [];
	let best: LineageNode | null = null;
	for (const entry of sorted) {
		if (best === null || compareTerminals(entry.node.candidate, best.candidate) > 0) best = entry.node;
		createdAt.push(entry.createdAt);
		bestUpTo.push(best);
	}
	return { createdAt, bestUpTo };
}

/** The best reachable snapshot of the revision created at or before `limit`. */
function bestCreatedBy(revision: ReachableRevision, limit: number): LineageNode | null {
	let low = 0;
	let high = revision.createdAt.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((revision.createdAt[middle] ?? Number.POSITIVE_INFINITY) <= limit) low = middle + 1;
		else high = middle;
	}
	return low === 0 ? null : revision.bestUpTo[low - 1] ?? null;
}

/**
 * The best lineage of one workstream: a complete revision chain from a root,
 * each link satisfying {@link canFollow}, ending at the highest terminal under
 * {@link compareTerminals}. Each snapshot keeps one link to the predecessor of
 * its best lineage. A snapshot that names its predecessor costs one lookup; a
 * legacy snapshot that does not costs a binary search, so replay is
 * O(n log n) in the stream's snapshots.
 */
function bestStreamLineage(candidates: readonly ReplayCandidate[]): LineageNode | null {
	const byRevision = new Map<number, ReplayCandidate[]>();
	for (const candidate of candidates) {
		const revision = byRevision.get(candidate.snapshot.revision) ?? [];
		revision.push(candidate);
		byRevision.set(candidate.snapshot.revision, revision);
	}
	let reachable: LineageNode[] = (byRevision.get(1) ?? []).filter(isRoot).map((candidate) => ({ candidate, predecessor: null }));
	let best: LineageNode | null = null;
	for (let revision = 1; reachable.length > 0; revision += 1) {
		for (const node of reachable) {
			if (best === null || compareTerminals(node.candidate, best.candidate) > 0) best = node;
		}
		const successors = byRevision.get(revision + 1) ?? [];
		if (successors.length === 0) break;
		const byEventId = new Map(reachable.map((node) => [node.candidate.snapshot.eventId, node]));
		let legacy: ReachableRevision | null = null;
		const next: LineageNode[] = [];
		for (const candidate of successors) {
			let predecessor: LineageNode | null;
			if (candidate.previousEventId !== undefined) {
				predecessor = byEventId.get(candidate.previousEventId) ?? null;
			} else {
				legacy ??= reachableRevision(reachable);
				predecessor = bestCreatedBy(legacy, Date.parse(candidate.snapshot.createdAt));
			}
			if (predecessor !== null && canFollow(candidate, predecessor.candidate)) next.push({ candidate, predecessor });
		}
		reachable = next;
	}
	return best;
}

function compareStreamLineages(a: LineageNode, b: LineageNode): number {
	const updatedAt = Date.parse(a.candidate.snapshot.updatedAt) - Date.parse(b.candidate.snapshot.updatedAt);
	if (updatedAt !== 0) return updatedAt;
	// Equal snapshot timestamps are resolved by validated transcript chronology,
	// not by the old stream's revision count.
	const transcriptTimestamp = a.candidate.timestamp.localeCompare(b.candidate.timestamp);
	if (transcriptTimestamp !== 0) return transcriptTimestamp;
	if (a.candidate.index !== b.candidate.index) return a.candidate.index - b.candidate.index;
	return compareTerminals(a.candidate, b.candidate);
}

function latestValidChain(candidates: readonly ReplayCandidate[]): LineageNode | null {
	const byWorkstream = new Map<string, ReplayCandidate[]>();
	for (const candidate of candidates) {
		const stream = byWorkstream.get(candidate.snapshot.workstreamId) ?? [];
		stream.push(candidate);
		byWorkstream.set(candidate.snapshot.workstreamId, stream);
	}
	let latest: LineageNode | null = null;
	for (const stream of byWorkstream.values()) {
		const streamLatest = bestStreamLineage(stream);
		if (streamLatest !== null && (latest === null || compareStreamLineages(streamLatest, latest) > 0)) latest = streamLatest;
	}
	return latest;
}

/** The provenance nearest the terminal, walking the winning lineage once. */
function inheritedProvenance(lineage: LineageNode | null): WorkstreamProvenance | undefined {
	for (let node = lineage; node !== null; node = node.predecessor) {
		if (node.candidate.snapshot.provenance !== undefined) return node.candidate.snapshot.provenance;
	}
	return undefined;
}

/**
 * Replay only complete, supported custom entries. No projection or fallback
 * argument is accepted here, so summaries/cache/registry/activity/peer/
 * terminal metadata can never establish authority.
 *
 * Every supplied entry is read. A partial read could return an older focus as
 * current, so replay has no entry limit; the caller bounds the input by
 * supplying only the selected branch.
 */
export function replayWorkstreamEntries(entries: readonly unknown[]): ReplayResult {
	if (!Array.isArray(entries)) return { snapshot: null, authority: null, candidates: [], rejected: 0, duplicateEventIds: 0, chainValid: false };
	const workstreamEntries = entries.filter((entry) => record(entry) && entry.type === "custom" && entry.customType === WORKSTREAM_ENTRY_TYPE);
	const byEventId = new Map<string, ReplayCandidate>();
	// Every supplied entry that is not a valid focus snapshot counts as rejected.
	let rejected = entries.length - workstreamEntries.length;
	let duplicateEventIds = 0;
	for (let index = 0; index < workstreamEntries.length; index += 1) {
		const entry = workstreamEntries[index];
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
	const snapshot = lineage?.candidate.snapshot ?? null;
	const provenance = inheritedProvenance(lineage);
	const mutation = lineage?.candidate.mutation;
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
