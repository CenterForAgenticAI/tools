import { closeSync, openSync, readSync } from "node:fs";

export const DEFAULT_FILE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_FILE_READ_CHUNK_BYTES = 1024 * 1024;

export interface BoundedFileLineReadOptions {
	readonly maxLineBytes: number;
	readonly chunkBytes?: number;
	readonly includeIncompleteFinalLine?: boolean;
	readonly maxBytes?: number;
	readonly onReadChunk?: (bytes: number) => void;
}

export function normalizedFileReadChunkBytes(value: number | undefined): number {
	const chunkBytes = value ?? DEFAULT_FILE_READ_CHUNK_BYTES;
	if (
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > MAX_FILE_READ_CHUNK_BYTES
	) {
		throw new RangeError("chunkBytes must be a safe integer from 1 to 1048576.");
	}
	return chunkBytes;
}

/**
 * Iterate complete bounded UTF-8 lines without decoding or retaining the whole file.
 * Lines above maxLineBytes are skipped until their next newline.
 */
export function* iterateBoundedFileLines(
	path: string,
	options: BoundedFileLineReadOptions,
): Generator<string> {
	if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 1) {
		throw new RangeError("maxLineBytes must be a positive safe integer.");
	}
	const chunkBytes = normalizedFileReadChunkBytes(options.chunkBytes);
	if (
		options.maxBytes !== undefined &&
		(!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
	) {
		throw new RangeError("maxBytes must be a non-negative safe integer.");
	}
	const includeIncompleteFinalLine = options.includeIncompleteFinalLine ?? true;
	const descriptor = openSync(path, "r");
	const readBuffer = Buffer.allocUnsafe(chunkBytes);
	let fragments: Buffer[] = [];
	let lineBytes = 0;
	let oversized = false;

	const addSegment = (segment: Buffer): void => {
		if (oversized || segment.length === 0) return;
		if (lineBytes + segment.length > options.maxLineBytes) {
			fragments = [];
			lineBytes = 0;
			oversized = true;
			return;
		}
		fragments.push(Buffer.from(segment));
		lineBytes += segment.length;
	};
	const finishLine = (): string | undefined => {
		const value = oversized
			? undefined
			: Buffer.concat(fragments, lineBytes).toString("utf8");
		fragments = [];
		lineBytes = 0;
		oversized = false;
		return value;
	};

	let remainingBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
	try {
		while (remainingBytes > 0) {
			const requested = Math.min(readBuffer.length, remainingBytes);
			const bytesRead = readSync(descriptor, readBuffer, 0, requested, null);
			if (bytesRead === 0) break;
			remainingBytes -= bytesRead;
			options.onReadChunk?.(bytesRead);
			let segmentStart = 0;
			for (let index = 0; index < bytesRead; index += 1) {
				if (readBuffer[index] !== 0x0a) continue;
				addSegment(readBuffer.subarray(segmentStart, index));
				const line = finishLine();
				if (line !== undefined) yield line;
				segmentStart = index + 1;
			}
			addSegment(readBuffer.subarray(segmentStart, bytesRead));
		}
		if (includeIncompleteFinalLine && (fragments.length > 0 || oversized)) {
			const line = finishLine();
			if (line !== undefined) yield line;
		}
	} finally {
		closeSync(descriptor);
	}
}
