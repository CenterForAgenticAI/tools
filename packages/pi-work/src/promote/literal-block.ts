import type { LiteralBlock } from "./types.js";

export interface PhysicalSourceLine {
	content: string;
	terminator: string;
}

export function splitPhysicalSource(source: string): PhysicalSourceLine[] {
	const lines: PhysicalSourceLine[] = [];
	let start = 0;
	while (start < source.length) {
		let contentEnd = start;
		while (contentEnd < source.length && source[contentEnd] !== "\n" && source[contentEnd] !== "\r") contentEnd++;
		let end = contentEnd;
		if (source[contentEnd] === "\r" && source[contentEnd + 1] === "\n") end += 2;
		else if (contentEnd < source.length) end++;
		lines.push({ content: source.slice(start, contentEnd), terminator: source.slice(contentEnd, end) });
		start = end;
	}
	return lines;
}

function terminalBreakCount(source: string): number {
	let count = 0;
	let end = source.length;
	while (end > 0) {
		if (end >= 2 && source.slice(end - 2, end) === "\r\n") {
			count++;
			end -= 2;
		} else if (source[end - 1] === "\n" || source[end - 1] === "\r") {
			count++;
			end--;
		} else break;
	}
	return count;
}

function chompingIndicator(source: string): "-" | "" | "+" {
	const breaks = terminalBreakCount(source);
	if (breaks === 0) return "-";
	if (breaks === 1) return "";
	return "+";
}

/**
 * Frame opaque source in a YAML literal scalar. The source bytes are never
 * split and reassembled with normalized line endings: each physical line is
 * prefixed once, while its original terminator is appended unchanged.
 */
export function literalBlock(source: string, indent: number, contentIndent = indent): LiteralBlock {
	const indicator = chompingIndicator(source);
	const header = `!md |${indent}${indicator}`;
	const prefix = " ".repeat(contentIndent);
	const lines = splitPhysicalSource(source);
	const framed = lines.map((line) => `${prefix}${line.content}${line.terminator}`).join("");
	return { header, source: framed, indent: contentIndent };
}

export function renderLiteralField(key: string, source: string, propertyIndent: number, ensureTerminator = true): string {
	const block = literalBlock(source, 2, propertyIndent + 2);
	const keyPrefix = " ".repeat(propertyIndent);
	let body = block.source;
	if (ensureTerminator && body.length > 0 && !body.endsWith("\n") && !body.endsWith("\r")) body += "\n";
	return `${keyPrefix}${key}: ${block.header}\n${body}`;
}

/** Remove the known YAML framing from a generated literal field for byte checks. */
export function unframeLiteralSource(framed: string, indent: number): string {
	const prefix = " ".repeat(indent);
	return splitPhysicalSource(framed).map((line) => {
		if (!line.content.startsWith(prefix)) throw new Error("literal source is missing its explicit indentation");
		return line.content.slice(indent) + line.terminator;
	}).join("");
}
