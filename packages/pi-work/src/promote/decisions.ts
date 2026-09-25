import { REGION_MARKERS } from "./regions.js";
import type { DecisionEntry, PromotionFinding, SourceRegion } from "./types.js";

export const DECISIONS_FORMAT = `A column-zero ATX heading ending with ${REGION_MARKERS.decisions}, followed by zero or more top-level Markdown bullets of the exact form - <id>: <question>. IDs match [A-Za-z0-9][A-Za-z0-9._-]* and are unique. Indented lines continue the question until the fields begin. Each bullet then requires exactly one indented 'tripwire: <when it must be answered>' line and exactly one indented 'decides: <who answers it>' line. The region ends at the next same-or-higher heading.`;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BULLET = /^- ([^:]+): (.*)$/;
const FIELD = /^(tripwire|decides): (.*)$/;

type FieldName = "tripwire" | "decides";

interface PendingDecision {
	id: string;
	line: number;
	questionLines: string[];
	tripwire?: string;
	decides?: string;
}

function decisionsFinding(sourcePath: string, code: PromotionFinding["code"], message: string, line: number, id?: string): PromotionFinding {
	return {
		code,
		severity: "error",
		path: ["regions", "decisions", line],
		message,
		sourcePath,
		expectedFormat: DECISIONS_FORMAT,
		region: "decisions",
		line,
		...(id === undefined ? {} : { id }),
	};
}

function splitLines(source: string): string[] {
	if (source.length === 0) return [];
	return source.split(/\r\n|\r|\n/);
}

function continuation(line: string): string | undefined {
	if (line.startsWith("\t")) return line.slice(1);
	if (line.startsWith("  ")) return line.slice(2);
	return undefined;
}

/**
 * Validate the decisions envelope.
 *
 * An open decision gates execution readiness, so every field the spec requires is
 * required here too. A decision that promoted without its tripwire would be a
 * question nobody is told when to answer, which is the shape AG8 exists to stop.
 */
export function validateDecisions(region: SourceRegion, sourcePath: string): { ok: true; entries: readonly DecisionEntry[] } | { ok: false; findings: PromotionFinding[] } {
	const findings: PromotionFinding[] = [];
	const entries: DecisionEntry[] = [];
	const seen = new Map<string, number>();
	let current: PendingDecision | undefined;

	function finishCurrent(): void {
		if (!current) return;
		const missing: FieldName[] = [];
		if (current.tripwire === undefined) missing.push("tripwire");
		if (current.decides === undefined) missing.push("decides");
		if (missing.length > 0) {
			findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Open decision '${current.id}' is missing its ${missing.join(" and ")} line.`, current.line, current.id));
		} else {
			entries.push({ id: current.id, line: current.line, question: current.questionLines.join(" ").trim(), tripwire: current.tripwire!, decides: current.decides! });
		}
		current = undefined;
	}

	const lines = splitLines(region.source);
	for (const [index, line] of lines.entries()) {
		const lineNumber = region.line + index + 1;
		if (line.trim() === "") continue;
		const bullet = BULLET.exec(line);
		if (bullet && !line.startsWith(" ") && !line.startsWith("\t")) {
			finishCurrent();
			const id = bullet[1]!;
			const question = bullet[2]!;
			if (!ID.test(id)) {
				findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Open decision id '${id}' is invalid; it must match [A-Za-z0-9][A-Za-z0-9._-]*.`, lineNumber, id));
				continue;
			}
			if (question.trim().length === 0) {
				findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Open decision '${id}' must have a non-empty question.`, lineNumber, id));
				continue;
			}
			const previous = seen.get(id);
			if (previous !== undefined) {
				findings.push({
					...decisionsFinding(sourcePath, "decisions-duplicate-id", `Open decision id '${id}' is duplicated.`, lineNumber, id),
					relatedPaths: [["regions", "decisions", previous]],
				});
				continue;
			}
			seen.set(id, lineNumber);
			current = { id, line: lineNumber, questionLines: [question] };
			continue;
		}
		const indented = continuation(line);
		if (indented === undefined) {
			finishCurrent();
			findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Line ${lineNumber} is not a top-level '- <id>: <question>' bullet or an indented tripwire/decides line.`, lineNumber));
			continue;
		}
		if (!current) {
			findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Line ${lineNumber} is an indented line without a preceding successfully parsed open decision.`, lineNumber));
			continue;
		}
		const field = FIELD.exec(indented);
		if (!field) {
			// Indented prose extends the question, as it does for a criterion statement,
			// so a decision keeps the context its author wrote. It is only allowed before
			// the fields: after them it is ambiguous which value it continues.
			if (current.tripwire !== undefined || current.decides !== undefined) {
				findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Line ${lineNumber} continues the question of '${current.id}' after its tripwire or decides line; put question text before them.`, lineNumber, current.id));
				continue;
			}
			current.questionLines.push(indented.trim());
			continue;
		}
		const name = field[1] as FieldName;
		const value = field[2]!.trim();
		if (value.length === 0) {
			findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Open decision '${current.id}' has an empty ${name} value.`, lineNumber, current.id));
			continue;
		}
		if (current[name] !== undefined) {
			findings.push(decisionsFinding(sourcePath, "decisions-malformed", `Open decision '${current.id}' declares ${name} more than once.`, lineNumber, current.id));
			continue;
		}
		current[name] = value;
	}
	finishCurrent();

	if (findings.length > 0) return { ok: false, findings };
	return { ok: true, entries };
}
