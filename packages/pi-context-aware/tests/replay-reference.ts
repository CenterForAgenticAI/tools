/**
 * The focus lineage selection replay used before full-history replay,
 * kept only as a test oracle. It copied a full predecessor path for every
 * reachable snapshot, which is quadratic in a long chain, but its selection is
 * the contract: the linked-lineage replay must choose the same snapshot and
 * the same inherited provenance for every history.
 *
 * `referenceReplay` is that replay end to end without its entry limit:
 * parsing, duplicate resolution, candidate ordering and lineage selection.
 */

import type { ReplayCandidate } from "../src/workstream/workstream-replay.js";
import type { WorkstreamMutation, WorkstreamProvenance } from "../src/workstream/workstream-schema.js";
import { focusEntry, historyTime } from "./replay-history.js";
import {
	WORKSTREAM_ENTRY_TYPE,
	createWorkstreamSnapshot,
	parseTranscriptWorkstreamEntryDetails,
	workstreamEntry,
} from "../src/workstream/workstream-state.js";

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
	const mutationOrder = canonical(a.mutation ?? null).localeCompare(canonical(b.mutation ?? null));
	if (mutationOrder !== 0) return mutationOrder;
	if (a.entryId !== b.entryId) return a.entryId.localeCompare(b.entryId);
	return a.timestamp.localeCompare(b.timestamp);
}

interface ReferenceLineage {
	readonly candidates: readonly ReplayCandidate[];
	readonly terminal: ReplayCandidate;
}

function compareLineages(a: ReferenceLineage, b: ReferenceLineage): number {
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

function validLineages(candidates: readonly ReplayCandidate[]): readonly ReferenceLineage[] {
	const byRevision = new Map<number, ReplayCandidate[]>();
	const byEventId = new Map<string, ReplayCandidate>();
	for (const candidate of candidates) {
		const revision = byRevision.get(candidate.snapshot.revision) ?? [];
		revision.push(candidate);
		byRevision.set(candidate.snapshot.revision, revision);
		byEventId.set(candidate.snapshot.eventId, candidate);
	}
	const paths = new Map<string, ReferenceLineage>();
	const revisions = [...byRevision.keys()].sort((a, b) => a - b);
	for (const revision of revisions) {
		for (const candidate of byRevision.get(revision) ?? []) {
			if (revision === 1) {
				if ((candidate.priorRevision === undefined || candidate.priorRevision === 0) && candidate.previousEventId === undefined) {
					paths.set(candidate.snapshot.eventId, { candidates: [candidate], terminal: candidate });
				}
				continue;
			}
			let best: ReferenceLineage | null = null;
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

function compareStreamLineages(a: ReferenceLineage, b: ReferenceLineage): number {
	const updatedAt = Date.parse(a.terminal.snapshot.updatedAt) - Date.parse(b.terminal.snapshot.updatedAt);
	if (updatedAt !== 0) return updatedAt;
	const transcriptTimestamp = a.terminal.timestamp.localeCompare(b.terminal.timestamp);
	if (transcriptTimestamp !== 0) return transcriptTimestamp;
	if (a.terminal.index !== b.terminal.index) return a.terminal.index - b.terminal.index;
	return compareLineages(a, b);
}

export interface ReferenceSelection {
	readonly eventId: string | null;
	readonly provenance?: WorkstreamProvenance;
	readonly mutation?: WorkstreamMutation;
}

export interface ReferenceReplay extends ReferenceSelection {
	readonly candidates: number;
	readonly rejected: number;
	readonly duplicateEventIds: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pre-#148 `replayWorkstreamEntries`, reading every entry. */
export function referenceReplay(entries: readonly unknown[]): ReferenceReplay {
	const workstreamEntries = entries.filter((entry) => record(entry) && entry.type === "custom" && entry.customType === WORKSTREAM_ENTRY_TYPE);
	const byEventId = new Map<string, ReplayCandidate>();
	let rejected = entries.length - workstreamEntries.length;
	let duplicateEventIds = 0;
	workstreamEntries.forEach((entry, index) => {
		const details = parseTranscriptWorkstreamEntryDetails(entry);
		if (!details) {
			rejected += 1;
			return;
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
			return;
		}
		byEventId.set(details.snapshot.eventId, candidate);
	});
	const candidates = [...byEventId.values()].sort(candidateTie);
	return { ...referenceLineage(candidates), candidates: candidates.length, rejected, duplicateEventIds };
}

/** The snapshot, inherited provenance and mutation the pre-#148 replay selected. */
export function referenceLineage(candidates: readonly ReplayCandidate[]): ReferenceSelection {
	const byWorkstream = new Map<string, ReplayCandidate[]>();
	for (const candidate of candidates) {
		const stream = byWorkstream.get(candidate.snapshot.workstreamId) ?? [];
		stream.push(candidate);
		byWorkstream.set(candidate.snapshot.workstreamId, stream);
	}
	let latest: ReferenceLineage | null = null;
	for (const stream of byWorkstream.values()) {
		const streamLatest = validLineages(stream).reduce<ReferenceLineage | null>((best, lineage) => (
			best === null || compareLineages(lineage, best) > 0 ? lineage : best
		), null);
		if (streamLatest !== null && (latest === null || compareStreamLineages(streamLatest, latest) > 0)) latest = streamLatest;
	}
	if (latest === null) return { eventId: null };
	const mutation = latest.terminal.mutation;
	const selected = { eventId: latest.terminal.snapshot.eventId, ...(mutation === undefined ? {} : { mutation }) };
	for (let index = latest.candidates.length - 1; index >= 0; index -= 1) {
		const provenance = latest.candidates[index]?.snapshot.provenance;
		if (provenance !== undefined) return { ...selected, provenance };
	}
	return selected;
}

/**
 * A small random focus history that exercises every selection rule: two
 * workstreams, competing snapshots per revision, linked and legacy entries,
 * links to missing or wrong predecessors, wrong prior revisions, roots that
 * name a predecessor, overlapping creation times, equal transcript timestamps
 * and equal update times, scattered provenance and mutations, duplicate event
 * IDs with conflicting content, malformed and ordinary entries, and shuffled
 * entry order.
 */
export function randomFocusHistory(seed: number): unknown[] {
	let state = seed >>> 0;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
	const pick = (limit: number): number => Math.floor(next() * limit);
	const entries: unknown[] = [];
	for (const workstreamId of ["ws-a", "ws-b"].slice(0, 1 + pick(2))) {
		const levels = 1 + pick(6);
		const previous: string[] = [];
		for (let revision = 1; revision <= levels; revision += 1) {
			const current: string[] = [];
			const width = 1 + pick(4);
			for (let slot = 0; slot < width; slot += 1) {
				const eventId = `${workstreamId}-${revision}-${slot}`;
				current.push(eventId);
				const createdSeconds = revision * 10 + pick(25) - 8;
				const snapshot = createWorkstreamSnapshot({
					workstreamId,
					piSessionId: "pi-history",
					revision,
					eventId,
					objective: `objective ${eventId}`,
					now: historyTime(createdSeconds),
					...(next() < 0.3 ? { provenance: { source: "host" as const, host: `host-${eventId}` } } : {}),
				});
				const updated = { ...snapshot, updatedAt: historyTime(createdSeconds + pick(3)) };
				const link = next();
				let metadata: { priorRevision?: number; previousEventId?: string } = {};
				if (revision === 1) {
					if (link < 0.1) metadata = { previousEventId: "not-a-root" };
				} else if (link < 0.45) {
					const named = next() < 0.85 ? previous[pick(previous.length)] ?? "missing" : "missing";
					metadata = { priorRevision: next() < 0.9 ? revision - 1 : revision, previousEventId: named };
				} else if (link < 0.55) {
					metadata = { priorRevision: next() < 0.7 ? revision - 1 : revision + 1 };
				}
				const mutation = (actor: "user" | "agent"): WorkstreamMutation => ({
					kind: "objective",
					actor,
					reason: `${actor} edit`,
					timestamp: updated.updatedAt,
					priorRevision: revision - 1,
					newRevision: revision,
					accepted: true,
					workstreamId: updated.workstreamId,
					proposedObjective: updated.objective,
				});
				const withMutation = revision > 1 && next() < 0.3;
				entries.push(workstreamEntry(updated, {
					entryId: `entry-${eventId}`,
					timestamp: historyTime(pick(40)),
					...metadata,
					...(withMutation ? { mutation: mutation("user") } : {}),
				}));
				// A duplicate event ID with different content, entry or mutation.
				if (next() < 0.15) {
					const variant = next();
					const duplicate = variant < 0.5 ? { ...updated, objective: `duplicate ${eventId}` } : updated;
					entries.push(workstreamEntry(duplicate, {
						entryId: variant < 0.75 ? `entry-${eventId}-copy` : `entry-${eventId}`,
						timestamp: historyTime(pick(40)),
						...metadata,
						...(revision > 1 && variant >= 0.75 ? { mutation: mutation("agent") } : {}),
					}));
				}
			}
			previous.splice(0, previous.length, ...current);
		}
	}
	// An occasional detached-looking root of a third stream competes on update time.
	if (next() < 0.3) {
		entries.push(focusEntry(1, "ws-c-1-0", {
			workstreamId: "ws-c", piSessionId: "pi-history", objective: "third stream",
			entryId: "entry-ws-c-1-0", timestamp: historyTime(pick(40)), createdAt: historyTime(30 + pick(30)),
		}));
	}
	for (let count = pick(3); count > 0; count -= 1) {
		entries.push({ type: "custom", id: `malformed-${count}`, parentId: null, timestamp: historyTime(pick(40)), customType: WORKSTREAM_ENTRY_TYPE, data: { revision: 99 } });
		entries.push({ type: "message", id: `message-${count}`, parentId: null, timestamp: historyTime(pick(40)), message: { role: "user", content: "ordinary" } });
	}
	for (let index = entries.length - 1; index > 0; index -= 1) {
		const other = pick(index + 1);
		[entries[index], entries[other]] = [entries[other], entries[index]];
	}
	return entries;
}
