/**
 * Assigning guidance to each new session (pi-context-aware#473, pi-context-aware#526, REQ-STRAT-007, ADR 0002
 * decision 5).
 *
 * `strategy.assign` names the guidance variants to draw from and a seed. It never draws methods: every session keeps
 * every method its settings list. The draw is a pure function of the seed, the list and the session id, so the same
 * seed and session list give the same assignment, and anyone can recompute one:
 * `printf '<seed>\n<session id>' | shasum -a 256`, the first four bytes as an unsigned big-endian integer, modulo the
 * length of the list, indexes the list. A list of one is a fixed assignment; a repeated id weighs its variant.
 *
 * The fold engine records the draw in the session as a custom entry (`ASSIGNMENT_ENTRY_TYPE`, never sent to the
 * model), so a resumed session, and a fork whose branch copies the entry, keep their guidance when the setting
 * changes later. The first version of the entry recorded a recipe; it is never read as an assignment, only counted
 * (`retiredAssignmentsOnBranch`). This module only draws and reads; it writes nothing.
 */

import { createHash } from "node:crypto";

import { isGuidanceVariant, type GuidanceVariant } from "../../strategy/guidance.js";

export const ASSIGNMENT_ENTRY_TYPE = "context-aware.strategy-assignment.v2" as const;
export const ASSIGNMENT_SCHEMA_VERSION = 2 as const;
/** Entry types of earlier versions, which recorded a recipe: never read as an assignment. */
export const RETIRED_ASSIGNMENT_ENTRY_TYPES: readonly string[] = ["context-aware.strategy-assignment.v1"];
/** A seed: letters, digits and `._:-`, 1 to 64 characters, so it shows as written on one line. */
export const ASSIGNMENT_SEED = /^[A-Za-z0-9._:-]{1,64}$/u;
/** Most ids a list holds; a longer list is not an assignment. */
export const MAX_ASSIGNMENT_VARIANTS = 16;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/** An assignment recorded in a session: what was drawn, from what, for which session. */
export interface RecordedAssignment {
	readonly guidance: GuidanceVariant;
	readonly seed: string;
	readonly variants: readonly GuidanceVariant[];
	/** The session the draw was made for; a fork keeps its parent's. */
	readonly drawnFor: string;
}

export interface AssignmentEntryData extends RecordedAssignment {
	readonly schemaVersion: typeof ASSIGNMENT_SCHEMA_VERSION;
}

/** The item the seed draws for a session from a non-empty list. */
export function drawFrom<T>(seed: string, list: readonly T[], sessionId: string): T {
	if (list.length === 0) throw new Error("Nothing to draw from");
	const digest = createHash("sha256").update(`${seed}\n${sessionId}`, "utf8").digest();
	return list[digest.readUInt32BE(0) % list.length]!;
}

/** True for a session id the recorded entry can carry and read back. */
export function isAssignableSessionId(id: string): boolean {
	return SESSION_ID.test(id) && id !== "." && id !== "..";
}

/** The entry data that records an assignment. Copies the named fields. */
export function assignmentEntryData(assignment: RecordedAssignment): AssignmentEntryData {
	return { schemaVersion: ASSIGNMENT_SCHEMA_VERSION, guidance: assignment.guidance, seed: assignment.seed, variants: [...assignment.variants], drawnFor: assignment.drawnFor };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Entry data as an assignment, or null. Every field is checked, and the guidance must be the variant the seed draws
 * for `drawnFor` from the list, so an entry that names a variant the draw did not give is not an assignment.
 */
export function parseAssignmentData(data: unknown): RecordedAssignment | null {
	if (!isRecord(data) || data.schemaVersion !== ASSIGNMENT_SCHEMA_VERSION) return null;
	const { guidance, seed, variants, drawnFor } = data;
	if (typeof guidance !== "string" || !isGuidanceVariant(guidance)) return null;
	if (typeof seed !== "string" || !ASSIGNMENT_SEED.test(seed)) return null;
	if (typeof drawnFor !== "string" || !isAssignableSessionId(drawnFor)) return null;
	if (!Array.isArray(variants) || variants.length === 0 || variants.length > MAX_ASSIGNMENT_VARIANTS) return null;
	const list: GuidanceVariant[] = [];
	for (const id of variants) {
		if (typeof id !== "string" || !isGuidanceVariant(id)) return null;
		list.push(id);
	}
	if (drawFrom(seed, list, drawnFor) !== guidance) return null;
	return { guidance, seed, variants: list, drawnFor };
}

const customEntries = function* (entries: Iterable<unknown>): Generator<Record<string, unknown>> {
	for (const entry of entries) if (isRecord(entry) && entry.type === "custom") yield entry;
};

/** The first valid assignment entry among `entries` (a session branch), or null: the guidance is chosen once. */
export function assignmentOnBranch(entries: Iterable<unknown>): RecordedAssignment | null {
	for (const entry of customEntries(entries)) {
		if (entry.customType !== ASSIGNMENT_ENTRY_TYPE) continue;
		const parsed = parseAssignmentData(entry.data);
		if (parsed) return parsed;
	}
	return null;
}

/** How many entries of a retired assignment version the branch holds; each is ignored. */
export function retiredAssignmentsOnBranch(entries: Iterable<unknown>): number {
	let count = 0;
	for (const entry of customEntries(entries)) if (typeof entry.customType === "string" && RETIRED_ASSIGNMENT_ENTRY_TYPES.includes(entry.customType)) count += 1;
	return count;
}
