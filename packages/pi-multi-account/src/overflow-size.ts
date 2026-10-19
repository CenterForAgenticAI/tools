/**
* Bounded size buckets for a context overflow.
*
* An operator who sees `request-bytes` or `media-limit` needs to know how far
* over the limit the request was, and whether image stripping took effect.
* Only these closed labels are kept: never an exact size, a count or content.
*/
import { countImageBlocks } from "./image-strip.js";

/** Approximate JSON size of the context sent, in decimal megabytes. */
export const REQUEST_BYTES_BUCKETS = ["<1MB", "1-8MB", "8-32MB", "32MB+"] as const;
export type RequestBytesBucket = (typeof REQUEST_BYTES_BUCKETS)[number];

/** Image blocks in the messages sent, after any image stripping. */
export const IMAGE_COUNT_BUCKETS = ["0", "1-8", "9-32", "33-100", "101+"] as const;
export type ImageCountBucket = (typeof IMAGE_COUNT_BUCKETS)[number];

export interface OverflowSizeBuckets {
	readonly requestBytes: RequestBytesBucket;
	readonly imageCount: ImageCountBucket;
}

const MB = 1_000_000;
/** Counting stops here: every larger request is `32MB+`. */
const BYTE_CAP = 32 * MB;
/** A context with more values than this is not measured. */
const MAX_VALUES = 2_000_000;
/** Deeper nesting, such as a cycle, is not JSON a provider was sent. */
const MAX_DEPTH = 256;

const BYTES_SET: ReadonlySet<string> = new Set(REQUEST_BYTES_BUCKETS);
const IMAGES_SET: ReadonlySet<string> = new Set(IMAGE_COUNT_BUCKETS);

export function isRequestBytesBucket(value: unknown): value is RequestBytesBucket {
	return typeof value === "string" && BYTES_SET.has(value);
}

export function isImageCountBucket(value: unknown): value is ImageCountBucket {
	return typeof value === "string" && IMAGES_SET.has(value);
}

/** Half-open ranges: 1,000,000 bytes is `1-8MB`. */
export function requestBytesBucket(bytes: number): RequestBytesBucket {
	if (bytes < MB) return "<1MB";
	if (bytes < 8 * MB) return "1-8MB";
	if (bytes < BYTE_CAP) return "8-32MB";
	return "32MB+";
}

export function imageCountBucket(count: number): ImageCountBucket {
	if (count <= 0) return "0";
	if (count <= 8) return "1-8";
	if (count <= 32) return "9-32";
	if (count <= 100) return "33-100";
	return "101+";
}

/** `JSON.stringify` writes these control characters as two-byte escapes. */
const SHORT_ESCAPES: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/**
* UTF-8 bytes of `text` written as a JSON string, quotes included, as
* `JSON.stringify` writes it: `"`, `\` and the short control escapes take two
* bytes; other control characters and lone surrogates take a six-byte `\u`
* escape. Counting stops once it reaches `limit`, so the result falls short of
* the full size only when it is already at least `limit`.
*/
export function jsonStringBytes(text: string, limit = Number.POSITIVE_INFINITY): number {
	let bytes = 2;
	for (let index = 0; index < text.length && bytes < limit; index += 1) {
		const code = text.charCodeAt(index);
		if (code === 0x22 || code === 0x5c) bytes += 2;
		else if (code < 0x20) bytes += SHORT_ESCAPES.has(code) ? 2 : 6;
		else if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (low >= 0xdc00 && low <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 6;
		} else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
		else bytes += 3;
	}
	return bytes;
}

/**
* Approximate UTF-8 size of `value` serialized as JSON, counted up to the cap.
* It walks the value without building the JSON string, so a large request
* costs no second copy. Past the cap it stops reading strings but still walks
* every value, so a cycle or deep nesting after the cap is still refused.
*/
function approximateJsonBytes(value: unknown): number | undefined {
	let total = 0;
	let values = 1;
	const pending: Array<readonly [unknown, number]> = [[value, 0]];
	const enqueue = (entry: unknown, depth: number): boolean => {
		values += 1;
		if (values > MAX_VALUES) return false;
		pending.push([entry, depth]);
		return true;
	};
	while (pending.length > 0) {
		const [next, depth] = pending.pop()!;
		if (depth > MAX_DEPTH) return undefined;
		if (typeof next === "string") {
			if (total < BYTE_CAP) total += jsonStringBytes(next, BYTE_CAP - total);
		} else if (typeof next === "number" || typeof next === "boolean") total += String(next).length;
		else if (next === null) total += 4;
		else if (Array.isArray(next)) {
			total += 2;
			for (const entry of next) if (!enqueue(entry, depth + 1)) return undefined;
		} else if (typeof next === "object") {
			total += 2;
			for (const [key, entry] of Object.entries(next)) {
				// The key as a JSON string, then its colon and separating comma.
				if (total < BYTE_CAP) total += jsonStringBytes(key, BYTE_CAP - total) + 2;
				if (!enqueue(entry, depth + 1)) return undefined;
			}
		}
	}
	return total;
}

/**
* Closed buckets for the context an attempt sent. Undefined when the context
* has no message list or cannot be measured. It only reads the context, and
* never throws.
*/
export function measureSentContext(context: unknown): OverflowSizeBuckets | undefined {
	try {
		const images = countImageBlocks(context);
		if (images === undefined) return undefined;
		const bytes = approximateJsonBytes(context);
		if (bytes === undefined) return undefined;
		return Object.freeze({ requestBytes: requestBytesBucket(bytes), imageCount: imageCountBucket(images) });
	} catch {
		return undefined;
	}
}
