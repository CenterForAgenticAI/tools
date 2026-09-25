/** Fence-aware, byte-preserving filtering of Markdown heading sections. */

export interface MarkdownHeading {
	text: string;
	level: number;
	start: number;
}

export type SkillSectionFilterResult =
	| { kind: "unchanged"; source: string }
	| { kind: "filtered"; source: string; removedSections: number }
	| { kind: "unmatched"; source: string };

interface Line {
	start: number;
	end: number;
	text: string;
}

function linesOf(source: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline < 0 ? source.length : newline + 1;
		const raw = source.slice(start, end);
		lines.push({ start, end, text: raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw });
		start = end;
	}
	if (source.length === 0 || (source.length > 0 && !source.endsWith("\n"))) {
		if (lines.length === 0 || lines.at(-1)!.end !== source.length) {
			lines.push({ start: source.length, end: source.length, text: "" });
		}
	}
	return lines;
}

function atxHeading(text: string): { level: number; text: string } | undefined {
	const match = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|)$/.exec(text);
	if (!match) return undefined;
	let visible = match[3] ?? "";
	visible = visible.replace(/[ \t]+#+[ \t]*$/, "").replace(/[ \t]+$/, "");
	return { level: match[2]!.length, text: visible };
}

function setextLevel(text: string): number | undefined {
	const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(text);
	return match ? (match[1]![0] === "=" ? 1 : 2) : undefined;
}

function fence(text: string): { marker: "`" | "~"; length: number; rest: string } | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
	return match
		? { marker: match[2]![0] as "`" | "~", length: match[2]!.length, rest: match[3] ?? "" }
		: undefined;
}

function indentedCode(text: string): boolean {
	return /^(?: {4,}| {0,3}\t)/.test(text);
}

/** Scan ATX and setext headings while ignoring YAML frontmatter and fences. */
export function scanMarkdownHeadings(source: string): MarkdownHeading[] {
	const lines = linesOf(source);
	const headings: MarkdownHeading[] = [];
	let inFrontmatter = false;
	let frontmatterPossible = lines.length > 0;
	let activeFence: { marker: "`" | "~"; length: number } | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (frontmatterPossible) {
			frontmatterPossible = false;
			if (line.text.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (/^ {0,3}(---|\.\.\.)[ \t]*$/.test(line.text)) inFrontmatter = false;
			continue;
		}
		const marker = fence(line.text);
		if (activeFence) {
			if (
				marker &&
				marker.marker === activeFence.marker &&
				marker.length >= activeFence.length &&
				/^[ \t]*$/.test(marker.rest)
			) {
				activeFence = undefined;
			}
			continue;
		}
		if (marker) {
			activeFence = marker;
			continue;
		}

		const atx = atxHeading(line.text);
		if (atx) {
			headings.push({ text: atx.text, level: atx.level, start: line.start });
			continue;
		}
		const level = setextLevel(line.text);
		if (level && index > 0) {
			const previous = lines[index - 1]!;
			if (previous.text.trim().length > 0 && !indentedCode(previous.text) && !atxHeading(previous.text) && !fence(previous.text)) {
				headings.push({ text: previous.text.trim(), level, start: previous.start });
			}
		}
	}
	return headings;
}

/**
 * Remove every section selected by exact visible heading text. A section ends
 * immediately before the next heading at the same or a higher level.
 */
export function filterSkillSections(source: string, selectors: readonly string[]): SkillSectionFilterResult {
	if (selectors.length === 0) return { kind: "unchanged", source };
	const headings = scanMarkdownHeadings(source);
	const requested = new Set(selectors);
	const selected = headings.filter((heading) => requested.has(heading.text));
	if (![...requested].every((selector) => headings.some((heading) => heading.text === selector))) {
		return { kind: "unmatched", source };
	}

	const ranges: Array<[number, number]> = [];
	for (const heading of selected) {
		const position = headings.indexOf(heading);
		let end = source.length;
		for (let index = position + 1; index < headings.length; index++) {
			if (headings[index]!.level <= heading.level) {
				end = headings[index]!.start;
				break;
			}
		}
		ranges.push([heading.start, end]);
	}
	ranges.sort((left, right) => left[0] - right[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
		else merged.push([...range]);
	}
	let filtered = "";
	let cursor = 0;
	for (const [start, end] of merged) {
		filtered += source.slice(cursor, start);
		cursor = end;
	}
	filtered += source.slice(cursor);
	return { kind: "filtered", source: filtered, removedSections: merged.length };
}
