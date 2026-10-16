/**
 * Decoding of the arguments a `compact.*` owner handler receives.
 *
 * Fabric validates a program's call before it reaches the owner, but the published
 * handlers travel on the shared Pi event bus, so any listener can capture them and call
 * them directly. Every handler therefore decodes its own input: it reads each named field
 * once, checks the type and Fabric's limits before it copies or stores anything, and
 * returns a fresh object. The caller's object never reaches stored state.
 *
 * The limits are Fabric's, from pi-fabric b67da914:
 * - `src/providers/compact-provider.ts` `requestSchema` and `carrySchema`: reason 1024
 *   characters, requestedBy 256, seed 1 to 8192, carry lists at most 16 items of 1 to 2048
 *   characters each, no other keys;
 * - `src/compaction/instructions.ts` `compactionRequestBoundsError` and
 *   `encodeCompactionRequest`: instructions at most 8192 characters and 8192 UTF-8 bytes,
 *   preserve at most 16 items of at most 2048 characters and 2048 UTF-8 bytes, no unpaired
 *   UTF-16 surrogate, and the encoded request at most 16384 UTF-8 bytes;
 * - `src/core/compact-controller.ts` `checkedSeed`: a seed is not blank and has at most
 *   8192 characters.
 *
 * Schema lengths ("characters") count Unicode code points here, as TypeBox does. Fabric's
 * TypeBox may count grapheme clusters, which are never more than code points, so nothing
 * Fabric would refuse is accepted.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOwnerCall, CompactionOwnerCarryUpdate, CompactionOwnerRequest } from "./owner-claim.js";

/**
 * A call the owner refuses because of what was asked, not because the owner failed:
 * bad input, a limit, or a claim that is no longer held. It does not end the claim.
 */
export class OwnerCallRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerCallRefused";
	}
}

export const MAX_REQUEST_REASON_CHARS = 1024;
export const MAX_REQUEST_REQUESTED_BY_CHARS = 256;
export const MAX_REQUEST_INSTRUCTIONS_CHARS = 8 * 1024;
export const MAX_REQUEST_INSTRUCTIONS_BYTES = 8 * 1024;
export const MAX_REQUEST_PRESERVE_ITEMS = 16;
export const MAX_REQUEST_PRESERVE_ITEM_CHARS = 2 * 1024;
export const MAX_REQUEST_PRESERVE_ITEM_BYTES = 2 * 1024;
export const MAX_REQUEST_SEED_CHARS = 8192;
export const MAX_ENCODED_REQUEST_BYTES = 16 * 1024;
/** Fabric's prefix for an encoded request with a preserve list; only its length matters here. */
const ENCODED_REQUEST_PREFIX = "__pi_fabric_compact_request_v1__:";
export const MAX_CARRY_ARGUMENT_ITEMS = 16;
export const MAX_CARRY_ARGUMENT_ITEM_CHARS = 2048;

const REQUEST_KEYS = ["reason", "instructions", "preserve", "requestedBy", "seed"] as const;
const CARRY_KEYS = ["items", "add", "remove", "clear"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** At most `max` code points, without allocating: a string over twice as long cannot qualify. */
function withinCodePoints(value: string, max: number): boolean {
	if (value.length <= max) return true;
	if (value.length > max * 2) return false;
	let count = 0;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) index++;
		}
		if (++count > max) return false;
	}
	return true;
}

/** False when the string holds an unpaired UTF-16 surrogate. */
export function hasPairedSurrogates(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/** Characters and UTF-8 bytes both within `max`; the length is checked first, so a huge string is never measured. */
function withinCharsAndBytes(value: string, max: number): boolean {
	return value.length <= max && Buffer.byteLength(value, "utf8") <= max;
}

/** Refuses any own key outside `known`; stops at the first one. */
function refuseUnknownKeys(value: Record<string, unknown>, known: readonly string[], action: string): void {
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (!known.includes(key)) throw new OwnerCallRefused(`compact.${action} does not support the field "${key.slice(0, 64)}"`);
	}
}

function optionalString(value: unknown, field: string, action: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new OwnerCallRefused(`compact.${action} ${field} must be a string`);
	return value;
}

/** A fresh array of at most `maxItems` strings, each checked by `check` before the copy grows. */
function stringList(
	value: unknown,
	maxItems: number,
	field: string,
	action: string,
	check: (item: string) => string | undefined,
): string[] {
	if (!Array.isArray(value)) throw new OwnerCallRefused(`compact.${action} ${field} must be an array of strings`);
	const length = value.length;
	if (length > maxItems) throw new OwnerCallRefused(`compact.${action} ${field} exceeds ${maxItems} items`);
	const copy: string[] = [];
	for (let index = 0; index < length; index++) {
		const item: unknown = value[index];
		if (typeof item !== "string") throw new OwnerCallRefused(`compact.${action} ${field} must be an array of strings`);
		const problem = check(item);
		if (problem) throw new OwnerCallRefused(`compact.${action} ${field} ${problem}`);
		copy.push(item);
	}
	return copy;
}

function decodeOrRefuse<T>(decode: () => T): T {
	try {
		return decode();
	} catch (error) {
		// A getter or proxy that throws is the caller's input too.
		if (error instanceof OwnerCallRefused) throw error;
		throw new OwnerCallRefused(`the arguments could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Decodes `compact.request` arguments into a fresh request, or throws `OwnerCallRefused`. */
export function decodeOwnerRequest(value: unknown): CompactionOwnerRequest {
	return decodeOrRefuse(() => {
		if (!isPlainRecord(value)) throw new OwnerCallRefused("compact.request arguments must be an object");
		refuseUnknownKeys(value, REQUEST_KEYS, "request");
		const reason = optionalString(value.reason, "reason", "request");
		const instructions = optionalString(value.instructions, "instructions", "request");
		const preserveValue: unknown = value.preserve;
		const requestedBy = optionalString(value.requestedBy, "requestedBy", "request");
		const seed = optionalString(value.seed, "seed", "request");

		if (reason !== undefined && !withinCodePoints(reason, MAX_REQUEST_REASON_CHARS)) {
			throw new OwnerCallRefused(`compact.request reason exceeds ${MAX_REQUEST_REASON_CHARS} characters`);
		}
		if (requestedBy !== undefined && !withinCodePoints(requestedBy, MAX_REQUEST_REQUESTED_BY_CHARS)) {
			throw new OwnerCallRefused(`compact.request requestedBy exceeds ${MAX_REQUEST_REQUESTED_BY_CHARS} characters`);
		}
		if (instructions !== undefined) {
			if (!withinCharsAndBytes(instructions, MAX_REQUEST_INSTRUCTIONS_CHARS)) {
				throw new OwnerCallRefused(`compact.request instructions exceed ${MAX_REQUEST_INSTRUCTIONS_CHARS} characters or ${MAX_REQUEST_INSTRUCTIONS_BYTES} UTF-8 bytes`);
			}
			if (!hasPairedSurrogates(instructions)) throw new OwnerCallRefused("compact.request instructions contain an unpaired UTF-16 surrogate");
		}
		if (seed !== undefined && (seed.trim() === "" || seed.length > MAX_REQUEST_SEED_CHARS)) {
			throw new OwnerCallRefused(`compact.request seed must be a non-empty string of at most ${MAX_REQUEST_SEED_CHARS} characters`);
		}
		const preserve = preserveValue === undefined
			? undefined
			: stringList(preserveValue, MAX_REQUEST_PRESERVE_ITEMS, "preserve", "request", (item) => {
				if (!withinCharsAndBytes(item, MAX_REQUEST_PRESERVE_ITEM_CHARS)) {
					return `items exceed ${MAX_REQUEST_PRESERVE_ITEM_CHARS} characters or ${MAX_REQUEST_PRESERVE_ITEM_BYTES} UTF-8 bytes`;
				}
				return hasPairedSurrogates(item) ? undefined : "items contain an unpaired UTF-16 surrogate";
			});
		if (preserve !== undefined) {
			// Fabric encodes a request with a preserve list; it refuses one whose encoding is too large.
			const encoded = `${ENCODED_REQUEST_PREFIX}${JSON.stringify({ version: 1, ...(instructions === undefined ? {} : { instructions }), preserve })}`;
			if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_REQUEST_BYTES) {
				throw new OwnerCallRefused(`compact.request exceeds ${MAX_ENCODED_REQUEST_BYTES} encoded UTF-8 bytes`);
			}
		}
		return {
			...(reason === undefined ? {} : { reason }),
			...(instructions === undefined ? {} : { instructions }),
			...(preserve === undefined ? {} : { preserve }),
			...(requestedBy === undefined ? {} : { requestedBy }),
			...(seed === undefined ? {} : { seed }),
		};
	});
}

/** Decodes `compact.carry` arguments into a fresh update, or throws `OwnerCallRefused`. */
export function decodeOwnerCarryUpdate(value: unknown): CompactionOwnerCarryUpdate {
	return decodeOrRefuse(() => {
		if (!isPlainRecord(value)) throw new OwnerCallRefused("compact.carry arguments must be an object");
		refuseUnknownKeys(value, CARRY_KEYS, "carry");
		const update: CompactionOwnerCarryUpdate = {};
		for (const field of ["items", "add", "remove"] as const) {
			const list: unknown = value[field];
			if (list === undefined) continue;
			update[field] = stringList(list, MAX_CARRY_ARGUMENT_ITEMS, field, "carry", (item) =>
				item.length >= 1 && withinCodePoints(item, MAX_CARRY_ARGUMENT_ITEM_CHARS)
					? undefined
					: `items must have 1 to ${MAX_CARRY_ARGUMENT_ITEM_CHARS} characters`);
		}
		const clear: unknown = value.clear;
		if (clear !== undefined) {
			if (typeof clear !== "boolean") throw new OwnerCallRefused("compact.carry clear must be a boolean");
			update.clear = clear;
		}
		return update;
	});
}

/**
 * Decodes the `{ context, signal }` every handler receives. Fabric always passes both
 * (pi-fabric b67da914 `CompactProvider.#invokeOwner`); a direct caller may pass anything,
 * and a malformed call is refused rather than failing inside the handler.
 */
export function decodeOwnerCall(value: unknown): CompactionOwnerCall {
	return decodeOrRefuse(() => {
		if (!isPlainRecord(value)) throw new OwnerCallRefused("the call must be { context, signal }");
		const context: unknown = value.context;
		const signal: unknown = value.signal;
		if (context !== undefined && (typeof context !== "object" || context === null)) {
			throw new OwnerCallRefused("the call's context must be an extension context");
		}
		if (
			typeof signal !== "object" || signal === null
			|| typeof (signal as { aborted?: unknown }).aborted !== "boolean"
			|| typeof (signal as { addEventListener?: unknown }).addEventListener !== "function"
		) {
			throw new OwnerCallRefused("the call's signal must be an AbortSignal");
		}
		// Fabric aborts the signal once it has failed the call; work for it would be discarded.
		if ((signal as AbortSignal).aborted) throw new OwnerCallRefused("the call was cancelled before it started; nothing was changed");
		return { context: context as ExtensionContext | undefined, signal: signal as AbortSignal };
	});
}
