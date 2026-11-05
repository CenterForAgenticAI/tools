// bcp issue 309: small models sometimes emit compress summaries whose CJK text
// arrived as literal \uXXXX sequences (double-escaped on the wire, so one
// JSON.parse leaves 6-character "\u5408" runs). The fold stores and renders
// summaries verbatim, so the corruption would persist into every later prompt.
// Normalize at ingest. Ported from billion-context-pi src/summary-sanitize.ts
// (pi-context-aware#255); the unverifiable-quote detector is not ported.

const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/g;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ESCAPED_HEX4 = /^\\u[0-9a-fA-F]{4}$/;

/** Strictly more than this many escapes means double-escaping; a few quoted examples survive. */
export const UNESCAPE_THRESHOLD = 20;

export function countUnicodeEscapes(text: string): number {
	return text.match(UNICODE_ESCAPE)?.length ?? 0;
}

/**
 * Decode only \uXXXX runs, surrogate pairs included. \n, \\ and the like stay literal.
 * An escaped backslash (two backslashes) is copied whole, so \\u0041 is not decoded, and a
 * surrogate with no partner stays as its escape rather than becoming a lone UTF-16 unit.
 */
export function decodeUnicodeEscapes(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.charAt(i) === "\\" && text.charAt(i + 1) === "\\") {
			out += "\\\\";
			i += 2;
			continue;
		}
		if (text.charAt(i) === "\\" && text.charAt(i + 1) === "u") {
			const hex = text.slice(i + 2, i + 6);
			if (HEX4.test(hex)) {
				const high = parseInt(hex, 16);
				const next = text.slice(i + 6, i + 12);
				if (high >= 0xd800 && high <= 0xdbff && ESCAPED_HEX4.test(next)) {
					const low = parseInt(next.slice(2, 6), 16);
					if (low >= 0xdc00 && low <= 0xdfff) {
						out += String.fromCodePoint(((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000);
						i += 12;
						continue;
					}
				}
				if (high >= 0xd800 && high <= 0xdfff) {
					out += text.slice(i, i + 6);
				} else {
					out += String.fromCharCode(high);
				}
				i += 6;
				continue;
			}
		}
		out += text.charAt(i);
		i++;
	}
	return out;
}

export function sanitizeSummary(text: string): { text: string; unescaped: boolean } {
	if (countUnicodeEscapes(text) <= UNESCAPE_THRESHOLD) return { text, unescaped: false };
	return { text: decodeUnicodeEscapes(text), unescaped: true };
}
