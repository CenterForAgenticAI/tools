// Service tokens compared in constant time (K1-I10). Internal to kleya-server/http; the tests read it directly.

const encoder = new TextEncoder();

/** The fewest characters a service token may have (K1-I10). */
export const MIN_TOKEN_CHARS = 32;

/** Whether two byte arrays are equal. Reads every byte of both, whatever they hold, so the time taken leaks nothing. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

/** Compares the SHA-256 digests of both tokens, so the time taken depends on neither token's content nor its length. */
export async function sameToken(presented: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([digest(presented), digest(expected)]);
	return sameBytes(a, b);
}

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}
