/**
 * Carry-forward items for the compaction-owner claim.
 *
 * `compact.carry` gives the claim owner a short list of facts that every
 * summary must keep until the list is cleared. The list lives in the session
 * file as a custom entry, so the latest entry on the current branch is the
 * list: restart, reload and `/tree` navigation replay it, and each branch
 * keeps its own.
 *
 * The update rules are the ones the protocol documents for an owner that
 * takes `carry`: clear, then replace, then remove (exact match), then add
 * (skipping items already present), with duplicates dropped, and the whole
 * call refused when the result breaks a limit.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionOwnerCarryUpdate } from "./owner-claim.js";

export const CARRY_ENTRY_TYPE = "context-aware.compaction-carry.v1" as const;
/** The entry type Fabric stores its own carry list under. Read only, to take over its list. */
export const FABRIC_CARRY_ENTRY_TYPE = "pi-fabric-compact-carry" as const;

export const MAX_CARRY_ITEMS = 16;
export const MAX_CARRY_ITEM_CHARS = 2048;
export const MAX_CARRY_ITEM_BYTES = 2048;

export interface CarryEntryData {
	readonly version: 1;
	readonly items: readonly string[];
}

function itemsError(items: readonly string[]): string | undefined {
	if (items.length > MAX_CARRY_ITEMS) return `compact carry exceeds ${MAX_CARRY_ITEMS} items`;
	for (const item of items) {
		if (item.trim() === "") return "compact carry items must be non-empty";
		if (item.length > MAX_CARRY_ITEM_CHARS) return `compact carry items are limited to ${MAX_CARRY_ITEM_CHARS} characters`;
		if (Buffer.byteLength(item, "utf8") > MAX_CARRY_ITEM_BYTES) return `compact carry items are limited to ${MAX_CARRY_ITEM_BYTES} UTF-8 bytes`;
	}
	return undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A stored entry's items, or undefined when the entry does not match the schema. */
export function decodeCarryData(data: unknown): string[] | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || !isStringArray(record.items)) return undefined;
	return itemsError(record.items) === undefined ? [...record.items] : undefined;
}

function latestCarry(branch: readonly SessionEntry[], customType: string): string[] | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		// The latest entry is authoritative, including an empty one. A malformed latest
		// entry reads as an empty list rather than bringing back a value that was replaced.
		return decodeCarryData(entry.data) ?? [];
	}
	return undefined;
}

/** The current list on a branch: the latest of this extension's own entries. */
export function readCarryItems(branch: readonly SessionEntry[]): string[] {
	return latestCarry(branch, CARRY_ENTRY_TYPE) ?? [];
}

/** True when this branch already holds a carry entry of this extension's own. */
export function hasOwnCarryEntry(branch: readonly SessionEntry[]): boolean {
	return latestCarry(branch, CARRY_ENTRY_TYPE) !== undefined;
}

/** Fabric's list on a branch, for taking over when Fabric has not reported it. */
export function readFabricCarryItems(branch: readonly SessionEntry[]): string[] {
	return latestCarry(branch, FABRIC_CARRY_ENTRY_TYPE) ?? [];
}

/** Apply one `compact.carry` call. Throws when the result breaks a limit; the list is then unchanged. */
export function applyCarryUpdate(current: readonly string[], update: CompactionOwnerCarryUpdate): string[] {
	let next = update.clear === true ? [] : [...current];
	if (update.items !== undefined) next = [...update.items];
	if (update.remove !== undefined) {
		const removed = new Set(update.remove);
		next = next.filter((item) => !removed.has(item));
	}
	for (const item of update.add ?? []) {
		if (!next.includes(item)) next.push(item);
	}
	next = next.filter((item, index) => next.indexOf(item) === index);
	const error = itemsError(next);
	if (error) throw new Error(error);
	return next;
}

export function isCarryUpdate(update: CompactionOwnerCarryUpdate): boolean {
	return update.clear === true || update.items !== undefined || update.add !== undefined || update.remove !== undefined;
}

export function sameItems(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

const CARRY_LINE = /^[ \t]*- .* \[carry:\d+\][ \t]*$/u;
const CONSTRAINTS_HEADING = /^##[ \t]+Constraints(?:[ \t]*(?:&|and)[ \t]*Preferences)?[ \t]*$/imu;
const ANY_HEADING = /^##[ \t]+\S/mu;

function carryLine(item: string, index: number): string {
	// One bullet per item: line breaks inside an item would end the bullet early.
	const text = item.replace(/\s+/gu, " ").trim();
	return `- ${text} [carry:${index}]`;
}

/**
 * Put the carry items into the summary's Constraints section.
 *
 * The model writes the summary, so the items are inserted by code rather than
 * asked for. Lines from an earlier insertion (marked `[carry:N]`) are removed
 * first, because Pi's iterative summary keeps its previous text and an item
 * that was since removed must not linger. A summary without a Constraints
 * heading gets one before its first other section.
 */
export function renderCarryIntoSummary(summary: string, items: readonly string[]): string {
	const stripped = summary
		.split("\n")
		.filter((line) => !CARRY_LINE.test(line))
		.join("\n");
	if (items.length === 0) return stripped;
	const block = items.map(carryLine).join("\n");
	const heading = CONSTRAINTS_HEADING.exec(stripped);
	if (heading) {
		const end = heading.index + heading[0].length;
		// The summary format's empty marker for this section no longer holds.
		const rest = stripped.slice(end).replace(/^\n[ \t]*- \(none\)[ \t]*(?=\n|$)/u, "");
		return `${stripped.slice(0, end)}\n${block}${rest}`;
	}
	const section = `## Constraints & Preferences\n${block}\n`;
	const first = ANY_HEADING.exec(stripped);
	if (!first) return stripped.trim() === "" ? section.trimEnd() : `${stripped.trimEnd()}\n\n${section.trimEnd()}`;
	return `${stripped.slice(0, first.index)}${section}\n${stripped.slice(first.index)}`;
}
