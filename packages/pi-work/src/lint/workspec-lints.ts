import type { LintFinding } from "../schema/findings.js";
import type { WorkNode, Workspec } from "../schema/workspec.js";
import { findTouchOverlaps, flattenWorkNodes } from "./touches-overlap.js";

export const DESCRIPTION_LENGTH_THRESHOLD = 500;
export const INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD = 0.9;
export const TOUCH_CONCENTRATION_THRESHOLD = 3;

function codePointLength(value: string): number {
	return Array.from(value).length;
}

function tokens(value: string): string[] {
	return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Multiset containment of the smaller token multiset in the larger one. */
export function normalizedTokenContainment(description: string, intent: string): number {
	const descriptionTokens = tokens(description);
	const intentTokens = tokens(intent);
	if (descriptionTokens.length === 0 || intentTokens.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const token of descriptionTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	let intersection = 0;
	for (const token of intentTokens) {
		const count = counts.get(token) ?? 0;
		if (count > 0) {
			intersection++;
			counts.set(token, count - 1);
		}
	}
	return intersection / Math.min(descriptionTokens.length, intentTokens.length);
}

function descriptionFinding(path: readonly (string | number)[], description: string): LintFinding | undefined {
	const length = codePointLength(description);
	return length > DESCRIPTION_LENGTH_THRESHOLD
		? { code: "description-too-long", severity: "warning", path, length, threshold: DESCRIPTION_LENGTH_THRESHOLD }
		: undefined;
}

export function lintWorkspec(spec: Workspec): LintFinding[] {
	const findings: LintFinding[] = [];
	const specDescription = descriptionFinding(["description"], spec.description);
	if (specDescription) findings.push(specDescription);
	const score = normalizedTokenContainment(spec.description, spec.intent);
	if (score >= INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD) {
		findings.push({
			code: "intent-description-duplicate",
			severity: "warning",
			path: ["intent"],
			score,
			threshold: INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD,
			relatedPaths: [["description"]],
		});
	}
	for (const located of flattenWorkNodes(spec)) {
		const description = located.node.description;
		if (description !== undefined) {
			const finding = descriptionFinding([...located.path, "description"], description);
			if (finding) findings.push(finding);
		}
	}
	for (const overlap of findTouchOverlaps(spec)) {
		if (overlap.count < TOUCH_CONCENTRATION_THRESHOLD) continue;
		const first = overlap.declarations[0];
		findings.push({
			code: "touches-concentration",
			severity: "warning",
			path: first.path,
			target: overlap.target,
			nodeIds: overlap.nodeIds,
			count: overlap.count,
			threshold: TOUCH_CONCENTRATION_THRESHOLD,
			relatedPaths: overlap.declarations.map((declaration) => declaration.path),
		});
	}
	return findings;
}

export function lintNodeDescriptions(nodes: readonly WorkNode[]): LintFinding[] {
	const synthetic: Workspec = { title: "", description: "", intent: "", work: [...nodes] };
	return lintWorkspec(synthetic).filter((finding) => finding.path[0] !== "description" && finding.code !== "intent-description-duplicate");
}
