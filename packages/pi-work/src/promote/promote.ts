import path from "node:path";

import { CRITERIA_FORMAT, validateCriteria } from "./criteria.js";
import { validateDecisions } from "./decisions.js";
import { renderDraftLineageComment } from "./draft-lineage.js";
import { renderLiteralField, splitPhysicalSource } from "./literal-block.js";
import { scanRegions, REGION_MARKERS } from "./regions.js";
import { isValidatedCriteriaBlock } from "./types.js";
import type { DecisionEntry, ParsedDraft, ParsedDraftSuccess, PromotedDraft, PromotionFinding, PromotionRegionName } from "./types.js";

export const REGION_FORMAT = "A column-zero ATX heading whose final content is the exact marker comment, followed by its source region until the next same-or-higher heading.";

function warning(sourcePath: string, region: "summary" | "rationale"): PromotionFinding {
	return {
		code: "optional-region-missing",
		severity: "warning",
		path: ["regions", region],
		message: `The optional ${region} region is absent; the promoted ${region === "summary" ? "description" : "intent"} will be empty.`,
		sourcePath,
		expectedFormat: `${REGION_FORMAT} Marker: ${REGION_MARKERS[region]}`,
		region,
	};
}

function error(sourcePath: string, code: PromotionFinding["code"], message: string, region: PromotionRegionName): PromotionFinding {
	return {
		code,
		severity: "error",
		path: ["regions", region],
		message,
		sourcePath,
		expectedFormat: region === "criteria" ? CRITERIA_FORMAT : `${REGION_FORMAT} Marker: ${REGION_MARKERS[region]}`,
		region,
	};
}

function hasErrors(findings: readonly PromotionFinding[]): boolean {
	return findings.some((finding) => finding.severity === "error");
}

/** Parse a draft into a validated, source-preserving promotion input. */
export function parseDraft(source: string, sourcePath = "draft.md"): ParsedDraft {
	const scanned = scanRegions(source, sourcePath);
	const findings = [...scanned.findings];
	const criteriaRegion = scanned.regions.criteria;
	if (!criteriaRegion) {
		findings.push(error(sourcePath, "criteria-missing", `Required criteria region is absent. Expected ${CRITERIA_FORMAT}`, "criteria"));
	} else {
		const criteria = validateCriteria(criteriaRegion, sourcePath);
		if (!criteria.ok) findings.push(...criteria.findings);
		// A malformed decisions region is an error, not a dropped section: an open
		// decision that fails to promote is a gate nobody is told about.
		const decisionsRegion = scanned.regions.decisions;
		const decisions = decisionsRegion === undefined ? undefined : validateDecisions(decisionsRegion, sourcePath);
		if (decisions && !decisions.ok) findings.push(...decisions.findings);
		if (criteria.ok && !hasErrors(findings)) {
			for (const name of ["summary", "rationale"] as const) {
				if (!scanned.regions[name]) findings.push(warning(sourcePath, name));
			}
			return {
				ok: true,
				sourcePath,
				source,
				criteria: criteria.block,
				...(scanned.regions.summary === undefined ? {} : { summary: scanned.regions.summary }),
				...(scanned.regions.rationale === undefined ? {} : { rationale: scanned.regions.rationale }),
				...(decisions?.ok === true ? { decisions: decisions.entries } : {}),
				findings,
			};
		}
	}
	for (const name of ["summary", "rationale"] as const) {
		if (!scanned.regions[name] && !findings.some((finding) => finding.region === name && finding.severity === "warning")) findings.push(warning(sourcePath, name));
	}
	return { ok: false, sourcePath, findings };
}

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

function filenameStem(sourcePath: string): string {
	const base = path.basename(sourcePath);
	return base.replace(/\.(?:md|markdown)$/i, "");
}

function lineagePath(sourcePath: string): string {
	return sourcePath.replaceAll("\\", "/");
}

/**
 * Render the promoted open decisions.
 *
 * Absent and empty are deliberately the same output: the spec key is optional, and
 * emitting `open_decisions: []` would assert a decision list the draft never made.
 */
function renderOpenDecisions(decisions: readonly DecisionEntry[] | undefined): string {
	if (decisions === undefined || decisions.length === 0) return "";
	return [
		"open_decisions:\n",
		...decisions.map((decision) => [
			`  - id: ${yamlQuote(decision.id)}\n`,
			`    question: ${yamlQuote(decision.question)}\n`,
			`    tripwire: ${yamlQuote(decision.tripwire)}\n`,
			`    decides: ${yamlQuote(decision.decides)}\n`,
		].join("")),
	].join("");
}

/** Serialize only the successful parse branch; malformed drafts have no output state. */
export function promoteDraft(parsed: ParsedDraftSuccess): PromotedDraft {
	if (!isValidatedCriteriaBlock(parsed?.criteria)) {
		return {
			ok: false,
			sourcePath: parsed?.sourcePath ?? "draft.md",
			findings: [error(parsed?.sourcePath ?? "draft.md", "criteria-malformed", "The promotion input does not contain a criteria block created by validation.", "criteria")],
		};
	}
	const validatedCriteria = validateCriteria(parsed.criteria, parsed.sourcePath);
	if (!validatedCriteria.ok) {
		return { ok: false, sourcePath: parsed.sourcePath, findings: validatedCriteria.findings };
	}
	const sourcePath = lineagePath(parsed.sourcePath);
	const summary = parsed.summary?.source ?? "";
	const rationale = parsed.rationale?.source ?? "";
	const specSource = [
		`${renderDraftLineageComment(parsed.sourcePath)}\n`,
		`title: ${yamlQuote(filenameStem(parsed.sourcePath))}\n`,
		renderLiteralField("description", summary, 0),
		renderLiteralField("intent", rationale, 0),
		renderOpenDecisions(parsed.decisions),
		"work:\n",
		"  - id: decompose\n",
		"    task: Assign every promoted criterion to exactly one owning work node\n",
		"    refs:\n",
		"      - path: " + yamlQuote(sourcePath) + "\n",
		"        why: Source draft retained as promotion lineage\n",
		renderLiteralField("description", validatedCriteria.block.source, 4, false),
	].join("");
	return { ok: true, sourcePath: parsed.sourcePath, specSource, findings: parsed.findings };
}

export function recoverCriteriaFromPromotedSource(specSource: string): string {
	const marker = "    description: !md |2";
	const markerStart = specSource.lastIndexOf(marker);
	if (markerStart < 0) throw new Error("promoted criteria field is absent");
	const headerEnd = specSource.indexOf("\n", markerStart);
	if (headerEnd < 0) return "";
	const body = specSource.slice(headerEnd + 1);
	return splitPhysicalSource(body).map((line) => line.content.startsWith("      ") ? line.content.slice(6) + line.terminator : "").join("");
}
