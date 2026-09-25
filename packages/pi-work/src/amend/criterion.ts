import type { Finding, FindingPath } from "../schema/findings.js";
import { isCompositeNode } from "../schema/dependencies.js";
import { parseYaml } from "../schema/parser.js";
import { validateWorkspec, type WorkspecValidationContext } from "../schema/index.js";
import type { CriterionAmendment, WorkNode } from "../schema/workspec.js";

export interface CriterionAmendmentRequest {
	criterionId: string;
	before: string;
	after: string;
	reason: string;
	authority: string;
	at: string;
}

export type CriterionAmendmentContext = WorkspecValidationContext;

export type CriterionAmendmentFailureCode =
	| "invalid-request"
	| "invalid-spec"
	| "criterion-not-found"
	| "criterion-before-mismatch"
	| "criterion-amendment-noop"
	| "serialization-invalid";

export interface CriterionAmendmentFailure {
	ok: false;
	code: CriterionAmendmentFailureCode;
	message: string;
	findings: Finding[];
}

export interface CriterionAmendmentSuccess {
	ok: true;
	specSource: string;
	path: FindingPath;
	amendment: CriterionAmendment;
}

export type CriterionAmendmentResult = CriterionAmendmentFailure | CriterionAmendmentSuccess;

function failure(code: CriterionAmendmentFailureCode, message: string, findings: Finding[] = []): CriterionAmendmentFailure {
	return { ok: false, code, message, findings };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function locateCriterion(nodes: readonly WorkNode[], criterionId: string): { path: FindingPath; statement: string; hasAmendments: boolean } | undefined {
	let match: { path: FindingPath; statement: string; hasAmendments: boolean } | undefined;
	function visit(scope: readonly WorkNode[], scopePath: FindingPath): void {
		scope.forEach((node, nodeIndex) => {
			const nodePath: FindingPath = [...scopePath, nodeIndex];
			(node.acceptance ?? []).forEach((criterion, criterionIndex) => {
				if (criterion.id === criterionId) match = { path: [...nodePath, "acceptance", criterionIndex], statement: criterion.statement, hasAmendments: criterion.amendments !== undefined };
			});
			if (isCompositeNode(node)) visit(node.work, [...nodePath, "work"]);
		});
	}
	visit(nodes, ["work"]);
	return match;
}

/** Apply exactly one append-only criterion amendment to a currently valid workspec. */
export function amendCriterion(source: string, request: CriterionAmendmentRequest, context?: CriterionAmendmentContext): CriterionAmendmentResult {
	if (!nonEmptyString(request?.criterionId) || typeof request?.before !== "string" || typeof request?.after !== "string" || !nonEmptyString(request?.reason) || !nonEmptyString(request?.authority) || !nonEmptyString(request?.at)) {
		return failure("invalid-request", "criterionId, before, after, reason, authority, and at must be strings; all except before and after must be non-empty");
	}
	if (request.before === request.after) return failure("criterion-amendment-noop", `${request.criterionId} amendment must change the statement`);

	const validation = context ? validateWorkspec(source, context) : validateWorkspec(source);
	if (!validation.structuralValid || !validation.valid) {
		return failure("invalid-spec", "the source workspec must validate before it can be amended", validation.findings);
	}
	const located = locateCriterion(validation.spec.work, request.criterionId);
	if (!located) return failure("criterion-not-found", `criterion ${request.criterionId} was not found`);
	if (located.statement !== request.before) {
		return failure("criterion-before-mismatch", `criterion ${request.criterionId} does not currently equal the supplied before text`);
	}

	const amendment: CriterionAmendment = {
		criterion_id: request.criterionId,
		before: request.before,
		after: request.after,
		reason: request.reason,
		authority: request.authority,
		at: request.at,
	};
	const parsed = parseYaml(source);
	const document = parsed.document;
	if (!document) return failure("serialization-invalid", "the validated workspec has no writable YAML document");
	const statementPath = [...located.path, "statement"];
	const amendmentsPath = [...located.path, "amendments"];
	const statementNode = rangedNode(document.getIn(statementPath, true));
	const criterionNode = rangedNode(document.getIn(located.path, true));
	const amendmentsNode = located.hasAmendments ? rangedNode(document.getIn(amendmentsPath, true)) : undefined;
	if (!statementNode || !criterionNode || (located.hasAmendments && !amendmentsNode)) {
		return failure("serialization-invalid", "the validated criterion has no source-preserving YAML range");
	}
	const statementField = statementFieldEncoding(source, statementNode.start);
	if (!statementField) return failure("serialization-invalid", "criterion statement is not encoded as a block mapping field");
	const insertionAt = amendmentsNode?.nodeEnd ?? criterionNode.nodeEnd;
	const recordSource = renderAmendmentRecord(amendment, statementField.keyIndent, located.hasAmendments, source);
	const statementSource = source.slice(statementNode.start, statementNode.end);
	const trailingBreak = /(?:\r\n|\r|\n)$/.exec(statementSource)?.[0] ?? "";
	const specSource = applySourceEdits(source, [
		{ start: statementField.valueStart, end: statementNode.end - trailingBreak.length, replacement: JSON.stringify(request.after) },
		{ start: insertionAt, end: insertionAt, replacement: recordSource },
	]);
	const outputValidation = context ? validateWorkspec(specSource, context) : validateWorkspec(specSource);
	if (!outputValidation.valid) {
		return failure("serialization-invalid", "the amended workspec did not validate", outputValidation.findings);
	}
	return { ok: true, specSource, path: located.path, amendment };
}

interface SourceRange {
	start: number;
	end: number;
	nodeEnd: number;
}

function rangedNode(value: unknown): SourceRange | undefined {
	if (typeof value !== "object" || value === null || !("range" in value)) return undefined;
	const range = (value as { range?: unknown }).range;
	if (!Array.isArray(range) || typeof range[0] !== "number" || typeof range[1] !== "number") return undefined;
	return { start: range[0], end: range[1], nodeEnd: typeof range[2] === "number" ? range[2] : range[1] };
}

function statementFieldEncoding(source: string, valueStart: number): { keyIndent: string; valueStart: number } | undefined {
	const lineStart = source.lastIndexOf("\n", valueStart - 1) + 1;
	const prefix = source.slice(lineStart, valueStart);
	const match = /^([ \t]*)statement:[ \t]*(?:![^ \t]+[ \t]*)?$/.exec(prefix);
	if (!match) return undefined;
	const valueOffset = /^([ \t]*statement:[ \t]*)/.exec(prefix)?.[1].length;
	if (valueOffset === undefined) return undefined;
	return { keyIndent: match[1], valueStart: lineStart + valueOffset };
}

function renderAmendmentRecord(amendment: CriterionAmendment, keyIndent: string, append: boolean, source: string): string {
	const eol = source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
	const itemIndent = `${keyIndent}  `;
	const fieldIndent = `${keyIndent}    `;
	const lines = [
		...(append ? [] : [`${keyIndent}amendments:`]),
		`${itemIndent}- criterion_id: ${JSON.stringify(amendment.criterion_id)}`,
		`${fieldIndent}before: ${JSON.stringify(amendment.before)}`,
		`${fieldIndent}after: ${JSON.stringify(amendment.after)}`,
		`${fieldIndent}reason: ${JSON.stringify(amendment.reason)}`,
		`${fieldIndent}authority: ${JSON.stringify(amendment.authority)}`,
		`${fieldIndent}at: ${JSON.stringify(amendment.at)}`,
	];
	return `${lines.join(eol)}${eol}`;
}

function applySourceEdits(source: string, edits: readonly { start: number; end: number; replacement: string }[]): string {
	return [...edits]
		.sort((left, right) => right.start - left.start)
		.reduce((current, edit) => current.slice(0, edit.start) + edit.replacement + current.slice(edit.end), source);
}
