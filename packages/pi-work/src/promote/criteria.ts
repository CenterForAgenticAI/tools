import { REGION_MARKERS } from "./regions.js";
import { makeValidatedCriteriaBlock } from "./types.js";
import type { CriteriaBlock, PromotionFinding, SourceRegion } from "./types.js";

export const CRITERIA_FORMAT = `A column-zero ATX heading ending with ${REGION_MARKERS.criteria}, followed by one or more top-level Markdown bullets of the exact form - <id>: <statement>. IDs match [A-Za-z0-9][A-Za-z0-9._-]* and are unique; blank lines are allowed, and nonblank continuation lines are allowed only after a successfully parsed criterion and only when they begin with at least two spaces or one tab. The region ends at the next same-or-higher heading.`;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BULLET = /^- ([^:]+): (.*)$/;

function criteriaFinding(
	sourcePath: string,
	code: PromotionFinding["code"],
	message: string,
	line: number,
	id?: string,
): PromotionFinding {
	return {
		code,
		severity: "error",
		path: ["regions", "criteria", line],
		message,
		sourcePath,
		expectedFormat: CRITERIA_FORMAT,
		region: "criteria",
		line,
		...(id === undefined ? {} : { id }),
	};
}

function splitLines(source: string): string[] {
	if (source.length === 0) return [];
	return source.split(/\r\n|\r|\n/);
}

function leadingWhitespaceIsContinuation(line: string): boolean {
	return line.startsWith("\t") || line.startsWith("  ");
}

/** Validate the small criteria envelope while retaining the original region slice. */
export function validateCriteria(region: SourceRegion, sourcePath: string): { ok: true; block: CriteriaBlock } | { ok: false; findings: PromotionFinding[] } {
	const findings: PromotionFinding[] = [];
	const entries: { id: string; line: number; statement: string }[] = [];
	const seen = new Map<string, number>();
	let current: { id: string; line: number; statementLines: string[] } | undefined;
	let pendingBlankLines = 0;
	function finishCurrent(): void {
		if (!current) return;
		entries.push({ id: current.id, line: current.line, statement: current.statementLines.join("\n") });
		current = undefined;
		pendingBlankLines = 0;
	}
	const lines = splitLines(region.source);
	for (const [index, line] of lines.entries()) {
		const lineNumber = region.line + index + 1;
		if (line.trim() === "") {
			if (current) pendingBlankLines++;
			continue;
		}
		const match = BULLET.exec(line);
		if (match && !line.startsWith(" ") && !line.startsWith("\t")) {
			finishCurrent();
			const id = match[1];
			const statement = match[2];
			if (!ID.test(id)) {
				findings.push(criteriaFinding(sourcePath, "criteria-malformed", `Criterion id '${id}' is invalid; it must match [A-Za-z0-9][A-Za-z0-9._-]*.`, lineNumber, id));
				continue;
			}
			if (statement.trim().length === 0) {
				findings.push(criteriaFinding(sourcePath, "criteria-malformed", `Criterion '${id}' must have a non-empty statement.`, lineNumber, id));
				continue;
			}
			const previous = seen.get(id);
			if (previous !== undefined) {
				findings.push({
					...criteriaFinding(sourcePath, "criteria-duplicate-id", `Criterion id '${id}' is duplicated.`, lineNumber, id),
					path: ["regions", "criteria", lineNumber],
					relatedPaths: [["regions", "criteria", previous]],
				});
				continue;
			}
			seen.set(id, lineNumber);
			current = { id, line: lineNumber, statementLines: [statement] };
			continue;
		}
		if (!leadingWhitespaceIsContinuation(line)) {
			finishCurrent();
			findings.push(criteriaFinding(sourcePath, "criteria-malformed", `Line ${lineNumber} is not a top-level '- <id>: <statement>' bullet or an indented continuation.`, lineNumber));
			continue;
		}
		if (!current) {
			findings.push(criteriaFinding(sourcePath, "criteria-malformed", `Line ${lineNumber} is an indented continuation without a preceding successfully parsed criterion.`, lineNumber));
			continue;
		}
		while (pendingBlankLines > 0) {
			current.statementLines.push("");
			pendingBlankLines--;
		}
		current.statementLines.push(line.startsWith("\t") ? line.slice(1) : line.slice(2));
	}
	finishCurrent();
	if (entries.length === 0 && findings.length === 0) {
		findings.push(criteriaFinding(sourcePath, "criteria-malformed", "The criteria region must contain at least one criterion bullet.", region.line + 1));
	}
	if (findings.length > 0) return { ok: false, findings };
	return {
		ok: true,
		block: makeValidatedCriteriaBlock(region, entries),
	};
}
