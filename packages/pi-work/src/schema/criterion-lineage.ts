import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { parseDraft } from "../promote/promote.js";
import { referencedDraftPath } from "../promote/draft-lineage.js";
import { isCompositeNode } from "./dependencies.js";
import type { CriterionLineageFinding, Finding, FindingPath } from "./findings.js";
import type { AcceptanceCriterion, WorkNode, Workspec } from "./workspec.js";

interface LocatedCriterion {
	criterion: AcceptanceCriterion;
	path: FindingPath;
}

export interface CriterionLineageContext {
	source: string;
	root: string;
}

function at(pathSegments: FindingPath, segment: string | number): FindingPath {
	return [...pathSegments, segment];
}

function criterionStatementSha256(statement: string): string {
	return createHash("sha256").update(statement, "utf8").digest("hex");
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function locateCriteria(work: readonly WorkNode[]): LocatedCriterion[] {
	const located: LocatedCriterion[] = [];
	function visit(nodes: readonly WorkNode[], scopePath: FindingPath): void {
		nodes.forEach((node, nodeIndex) => {
			const nodePath = at(scopePath, nodeIndex);
			(node.acceptance ?? []).forEach((criterion, criterionIndex) => {
				located.push({ criterion, path: at(at(nodePath, "acceptance"), criterionIndex) });
			});
			if (isCompositeNode(node)) visit(node.work, at(nodePath, "work"));
		});
	}
	visit(work, ["work"]);
	return located;
}

function validateAmendments(located: LocatedCriterion, rootSha256: string): CriterionLineageFinding[] {
	const { criterion, path: criterionPath } = located;
	const amendments = criterion.amendments ?? [];
	if (amendments.length === 0) {
		if (criterionStatementSha256(criterion.statement) === rootSha256) return [];
		return [{
			code: "criterion-text-unrecorded",
			severity: "error",
			path: at(criterionPath, "statement"),
			criterionId: criterion.id,
			message: `${criterion.id} does not match its statement in the referenced draft and has no recorded amendment chain`,
		}];
	}

	const findings: CriterionLineageFinding[] = [];
	const first = amendments[0];
	if (criterionStatementSha256(first.before) !== rootSha256) {
		findings.push({
			code: "criterion-amendment-root-mismatch",
			severity: "error",
			path: at(at(criterionPath, "amendments"), 0),
			criterionId: criterion.id,
			message: `${criterion.id} amendment chain is not rooted in its statement in the referenced draft`,
		});
	}
	for (let index = 0; index < amendments.length; index++) {
		const amendment = amendments[index];
		const amendmentPath = at(at(criterionPath, "amendments"), index);
		if (amendment.criterion_id !== criterion.id) {
			findings.push({
				code: "criterion-amendment-id-mismatch",
				severity: "error",
				path: at(amendmentPath, "criterion_id"),
				criterionId: criterion.id,
				actualId: amendment.criterion_id,
				message: `amendment names ${amendment.criterion_id} but belongs to ${criterion.id}`,
			});
		}
		if (amendment.before === amendment.after) {
			findings.push({
				code: "criterion-amendment-noop",
				severity: "error",
				path: at(amendmentPath, "after"),
				criterionId: criterion.id,
				message: `${criterion.id} amendment ${index + 1} does not change the statement`,
			});
		}
		const next = amendments[index + 1];
		if (next && amendment.after !== next.before) {
			findings.push({
				code: "criterion-amendment-discontinuous",
				severity: "error",
				path: at(at(criterionPath, "amendments"), index + 1),
				criterionId: criterion.id,
				message: `${criterion.id} amendment ${index + 2} does not begin at amendment ${index + 1}'s endpoint`,
			});
		}
	}
	const endpoint = amendments.at(-1)?.after;
	if (endpoint !== criterion.statement) {
		findings.push({
			code: "criterion-amendment-endpoint-mismatch",
			severity: "error",
			path: at(criterionPath, "statement"),
			criterionId: criterion.id,
			message: `${criterion.id} current statement is not the endpoint of its amendment chain`,
		});
	}
	return findings;
}

function unavailable(message: string, draftPath?: string): CriterionLineageFinding {
	return {
		code: "criterion-draft-unavailable",
		severity: "error",
		path: [],
		...(draftPath === undefined ? {} : { draftPath }),
		message,
	};
}

/**
 * Derive each root from the draft named by the workspec, then validate every
 * current criterion and amendment. The YAML cannot supply a root value. This
 * still relies on review of two conspicuous authored changes: draft prose and
 * the retained draft path.
 */
export function validateCriterionLineage(spec: Workspec, context: CriterionLineageContext): Finding[] {
	const findings: Finding[] = [];
	const located = locateCriteria(spec.work);
	const criteriaById = new Map<string, LocatedCriterion>();
	for (const entry of located) {
		const previous = criteriaById.get(entry.criterion.id);
		if (previous) {
			findings.push({
				code: "duplicate-criterion-id",
				severity: "error",
				path: at(entry.path, "id"),
				id: entry.criterion.id,
				relatedPaths: [at(previous.path, "id")],
			});
		} else criteriaById.set(entry.criterion.id, entry);
	}
	const draftReference = referencedDraftPath(context.source);
	if (!draftReference) {
		if (located.length === 0) return findings;
		return [...findings, unavailable("workspec does not name a draft in its work_promote lineage comment")];
	}
	const validationRoot = path.resolve(context.root);
	const authoredDraftPath = path.resolve(validationRoot, draftReference);
	if (!inside(validationRoot, authoredDraftPath)) {
		return [...findings, unavailable(`referenced draft ${draftReference} escapes the validation root`, draftReference)];
	}
	let draftSource: string;
	try {
		const canonicalRoot = realpathSync(validationRoot);
		const canonicalDraftPath = realpathSync(authoredDraftPath);
		if (!inside(canonicalRoot, canonicalDraftPath)) {
			return [...findings, unavailable(`referenced draft ${draftReference} resolves outside the validation root`, draftReference)];
		}
		draftSource = readFileSync(canonicalDraftPath, "utf8");
	} catch (error) {
		return [...findings, unavailable(`referenced draft ${draftReference} is unreadable: ${error instanceof Error ? error.message : String(error)}`, draftReference)];
	}
	const parsedDraft = parseDraft(draftSource, draftReference);
	if (!parsedDraft.ok) {
		const errors = parsedDraft.findings.filter((finding) => finding.severity === "error");
		return [...findings, {
			code: "criterion-draft-invalid",
			severity: "error",
			path: [],
			draftPath: draftReference,
			message: `referenced draft ${draftReference} cannot establish criterion lineage: ${errors.map((finding) => `${finding.code}: ${finding.message}`).join("; ")}`,
		}];
	}

	const draftById = new Map(parsedDraft.criteria.entries.map((entry) => [entry.id, entry]));
	for (const [criterionId, entry] of criteriaById) {
		const draftCriterion = draftById.get(criterionId);
		if (!draftCriterion) {
			findings.push({
				code: "criterion-draft-criterion-missing",
				severity: "error",
				path: at(entry.path, "statement"),
				criterionId,
				draftPath: draftReference,
				message: `${criterionId} is absent from referenced draft ${draftReference}`,
			});
			continue;
		}
		findings.push(...validateAmendments(entry, criterionStatementSha256(draftCriterion.statement)));
	}
	for (const draftCriterion of parsedDraft.criteria.entries) {
		if (criteriaById.has(draftCriterion.id)) continue;
		findings.push({
			code: "criterion-draft-criterion-unassigned",
			severity: "error",
			path: [],
			criterionId: draftCriterion.id,
			draftPath: draftReference,
			message: `${draftCriterion.id} appears in referenced draft ${draftReference} but has no owning acceptance criterion`,
		});
	}
	return findings;
}
