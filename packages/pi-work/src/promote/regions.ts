import type { PromotionFinding, PromotionRegionName, SourceRegion } from "./types.js";

export const REGION_MARKERS = {
	summary: "<!-- work:summary -->",
	rationale: "<!-- work:rationale -->",
	criteria: "<!-- work:criteria -->",
	decisions: "<!-- work:decisions -->",
} as const satisfies Record<PromotionRegionName, string>;

export interface DraftRegions {
	regions: Partial<Record<PromotionRegionName, SourceRegion>>;
	findings: PromotionFinding[];
}

interface PhysicalLine {
	text: string;
	start: number;
	contentEnd: number;
	end: number;
	line: number;
}

interface MarkerHeading {
	name: PromotionRegionName;
	level: number;
	line: PhysicalLine;
}

function physicalLines(source: string): PhysicalLine[] {
	const lines: PhysicalLine[] = [];
	let start = 0;
	let line = 1;
	while (start < source.length) {
		let contentEnd = start;
		while (contentEnd < source.length && source[contentEnd] !== "\n" && source[contentEnd] !== "\r") contentEnd++;
		let end = contentEnd;
		if (source[contentEnd] === "\r" && source[contentEnd + 1] === "\n") end += 2;
		else if (contentEnd < source.length) end++;
		lines.push({ text: source.slice(start, contentEnd), start, contentEnd, end, line });
		start = end;
		line++;
	}
	if (source.length === 0) lines.push({ text: "", start: 0, contentEnd: 0, end: 0, line: 1 });
	return lines;
}

/** Derived from REGION_MARKERS so a newly declared region cannot be silently unscanned. */
const REGION_NAMES = Object.keys(REGION_MARKERS) as readonly PromotionRegionName[];

function markerForContent(content: string): PromotionRegionName | undefined {
	for (const name of REGION_NAMES) {
		const marker = REGION_MARKERS[name];
		if (content === marker || content.endsWith(` ${marker}`) || content.endsWith(`\t${marker}`)) return name;
	}
	return undefined;
}

function headingLevel(content: string): number | undefined {
	const match = /^(#{1,6})(?:[ \t]+)(.*)$/.exec(content);
	return match ? match[1].length : undefined;
}

function markerInContent(content: string): PromotionRegionName | undefined {
	for (const name of REGION_NAMES) {
		if (content.includes(REGION_MARKERS[name])) return name;
	}
	return undefined;
}

function isFenceLine(content: string): { character: "`" | "~"; length: number } | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})/.exec(content);
	return match ? { character: match[1][0] as "`" | "~", length: match[1].length } : undefined;
}

function isInsideFence(content: string, fence: { character: "`" | "~"; length: number } | undefined): boolean {
	if (!fence) return false;
	const escaped = fence.character === "`" ? "`" : "~";
	const expression = new RegExp(`^ {0,3}${escaped}{${fence.length},}(?:[ \\t]*)$`);
	return !expression.test(content);
}

function finding(
	sourcePath: string,
	code: PromotionFinding["code"],
	message: string,
	line: number,
	region?: PromotionRegionName,
): PromotionFinding {
	return {
		code,
		severity: "error",
		path: region ? ["regions", region, line] : ["regions", line],
		message,
		sourcePath,
		expectedFormat: `A column-zero Markdown heading ending with one of ${Object.values(REGION_MARKERS).join(", ")}; criteria must contain top-level '- <id>: <statement>' bullets.`,
		...(region === undefined ? {} : { region }),
		line,
	};
}

/** Locate all four recognized regions; the decisions region is optional. */
export function scanRegions(source: string, sourcePath: string): DraftRegions {
	const lines = physicalLines(source);
	const headings: MarkerHeading[] = [];
	const visibleHeadingStarts = new Set<number>();
	const malformed: PromotionFinding[] = [];
	let fence: { character: "`" | "~"; length: number } | undefined;

	for (const line of lines) {
		const fenceLine = isFenceLine(line.text);
		if (fenceLine) {
			if (!fence) fence = fenceLine;
			else if (fence.character === fenceLine.character && fenceLine.length >= fence.length && !isInsideFence(line.text, fence)) fence = undefined;
			continue;
		}
		if (fence) continue;
		visibleHeadingStarts.add(line.start);

		const level = headingLevel(line.text);
		const marker = markerForContent(level === undefined ? "" : line.text.slice(line.text.indexOf("#") + level + 1).trimEnd());
		if (level !== undefined && marker) {
			headings.push({ name: marker, level, line });
			continue;
		}
		const malformedMarker = markerInContent(line.text);
		if (malformedMarker) {
			malformed.push(finding(sourcePath, "criteria-marker-malformed", `The ${malformedMarker} marker must be the final content of a column-zero ATX heading.`, line.line, malformedMarker));
		}
	}

	const findings = [...malformed];
	const levels = new Set(headings.map((heading) => heading.level));
	if (levels.size > 1 && headings.length > 1) {
		findings.push({
			...finding(sourcePath, "criteria-overlapping-markers", "Marked regions must use sibling headings at one shared level; differing levels would overlap.", headings[0].line.line),
			path: ["regions"],
		});
	}
	const regions: Partial<Record<PromotionRegionName, SourceRegion>> = {};
	for (const name of REGION_NAMES) {
		const matches = headings.filter((heading) => heading.name === name);
		if (matches.length > 1) {
			findings.push({
				...finding(sourcePath, "criteria-duplicate-marker", `The ${name} region marker appears more than once.`, matches[1].line.line, name),
				path: ["regions", name],
				relatedPaths: matches.map((match) => ["regions", name, match.line.line]),
			});
			continue;
		}
		const match = matches[0];
		if (!match) continue;
		const next = lines.find((line) => visibleHeadingStarts.has(line.start) && line.start > match.line.start && headingLevel(line.text) !== undefined && (headingLevel(line.text) as number) <= match.level);
		const start = match.line.end;
		const end = next?.start ?? source.length;
		regions[name] = { name, level: match.level, start, end, source: source.slice(start, end), line: match.line.line };
	}
	return { regions, findings };
}

export function lineNumberAt(source: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index++) {
		if (source[index] === "\n") line++;
	}
	return line;
}
