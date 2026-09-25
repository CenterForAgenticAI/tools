import type { TLocalizedValidationError } from "typebox/error";

export type FindingPath = readonly (string | number)[];
export type FindingSeverity = "error" | "warning";

/** A recorded acceptance of one advisory. Only ever set on a warning. */
export interface FindingDisposition {
	readonly reason: string;
	readonly authority: string;
	readonly at: string;
}

interface FindingBase<S extends FindingSeverity, C extends string> {
	code: C;
	severity: S;
	path: FindingPath;
	/**
	 * Present when the spec records an accepted reason for this advisory. The finding
	 * is still reported: an accepted advisory is annotated, never removed, so a reader
	 * sees both the concern and who accepted it.
	 */
	disposition?: FindingDisposition | undefined;
}

export type SchemaFinding =
	| (FindingBase<"error", "schema-required"> & { keyword: "required"; property: string; params: Record<string, unknown> })
	| (FindingBase<"error", "schema-additional-properties"> & { keyword: "additionalProperties"; properties: string[]; params: Record<string, unknown> })
	| (FindingBase<"error", "schema-invalid"> & { keyword: string; params: Record<string, unknown>; message?: string });

export type PathInputFinding = FindingBase<"error", "absolute-path"> & { message: string; suppliedPath: string };

export type YamlFinding =
	| (FindingBase<"error", "read-error"> & { message: string })
	| (FindingBase<"error", "yaml-syntax"> & { message: string })
	| (FindingBase<"error", "yaml-unknown-tag"> & { tag: string })
	| (FindingBase<"error", "yaml-tag-style"> & { tag: string; style: string })
	| (FindingBase<"error", "yaml-multiple-documents"> & { count: number });

export type SemanticFinding =
	| (FindingBase<"error", "duplicate-node-id"> & { id: string; relatedPaths: FindingPath[] })
	| (FindingBase<"error", "duplicate-criterion-id"> & { id: string; relatedPaths: FindingPath[] })
	| (FindingBase<"error", "dependency-unresolved"> & { dependency: string })
	| (FindingBase<"error", "dependency-self"> & { dependency: string })
	| (FindingBase<"error", "dependency-cycle"> & { members: string[]; relatedPaths: FindingPath[] });

export type CriterionLineageFinding =
	| (FindingBase<"error", "criterion-draft-unavailable"> & { draftPath?: string; message: string })
	| (FindingBase<"error", "criterion-draft-invalid"> & { draftPath: string; message: string })
	| (FindingBase<"error", "criterion-draft-criterion-missing"> & { criterionId: string; draftPath: string; message: string })
	| (FindingBase<"error", "criterion-draft-criterion-unassigned"> & { criterionId: string; draftPath: string; message: string })
	| (FindingBase<"error", "criterion-text-unrecorded"> & { criterionId: string; message: string })
	| (FindingBase<"error", "criterion-amendment-root-mismatch"> & { criterionId: string; message: string })
	| (FindingBase<"error", "criterion-amendment-id-mismatch"> & { criterionId: string; actualId: string; message: string })
	| (FindingBase<"error", "criterion-amendment-discontinuous"> & { criterionId: string; message: string })
	| (FindingBase<"error", "criterion-amendment-endpoint-mismatch"> & { criterionId: string; message: string })
	| (FindingBase<"error", "criterion-amendment-noop"> & { criterionId: string; message: string });

export type LintFinding =
	| (FindingBase<"warning", "touches-concentration"> & { target: string; nodeIds: string[]; count: number; threshold: number; relatedPaths: FindingPath[] })
	| (FindingBase<"warning", "description-too-long"> & { length: number; threshold: number })
	| (FindingBase<"warning", "intent-description-duplicate"> & { score: number; threshold: number; relatedPaths: FindingPath[] });

/** Findings about the disposition records themselves, never about what they accept. */
export type DispositionFinding =
	| (FindingBase<"error", "disposition-targets-error"> & { dispositionCode: string; target: string; message: string })
	| (FindingBase<"warning", "disposition-unmatched"> & { dispositionCode: string; target: string; message: string });

export type Finding = SchemaFinding | YamlFinding | SemanticFinding | CriterionLineageFinding | LintFinding | PathInputFinding | DispositionFinding;
export type WorkFinding = Finding;

export interface TaggedScalar {
	path: FindingPath;
	tag: string;
	style: "literal" | "folded";
}

export interface StructurallyInvalidResult {
	structuralValid: false;
	valid: false;
	findings: Finding[];
	value?: unknown;
	source: string;
	tags: TaggedScalar[];
}

export interface StructurallyValidResult<T> {
	structuralValid: true;
	valid: boolean;
	findings: Finding[];
	value: T;
	spec: T;
	source: string;
	tags: TaggedScalar[];
}

/** Structural validity is independent from semantic validity and warnings. */
export type ValidationResult<T = unknown> = StructurallyInvalidResult | StructurallyValidResult<T>;

/** Decode a JSON Pointer path emitted by TypeBox into the public path form. */
export function decodeJsonPointer(pointer: string): FindingPath {
	if (pointer === "") return [];
	return pointer
		.split("/")
		.slice(1)
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
		.map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment);
}

function pathWith(path: FindingPath, segment: string | number): FindingPath {
	return [...path, segment];
}

/** Convert TypeBox's structured validation errors into stable, path-aware findings. */
export function typeboxFindings(errors: readonly TLocalizedValidationError[]): SchemaFinding[] {
	const findings: SchemaFinding[] = [];
	for (const error of errors) {
		const path = decodeJsonPointer(error.instancePath);
		if (error.keyword === "required") {
			const requiredProperties = Array.isArray(error.params.requiredProperties)
				? error.params.requiredProperties.filter((property): property is string => typeof property === "string")
				: [];
			for (const property of requiredProperties) {
				findings.push({
					code: "schema-required",
					severity: "error",
					path: pathWith(path, property),
					keyword: "required",
					property,
					params: error.params as Record<string, unknown>,
				});
			}
		} else if (error.keyword === "additionalProperties") {
			const properties = Array.isArray(error.params.additionalProperties)
				? error.params.additionalProperties.filter((property): property is string => typeof property === "string")
				: [];
			for (const property of properties) {
				findings.push({
					code: "schema-additional-properties",
					severity: "error",
					path: pathWith(path, property),
					keyword: "additionalProperties",
					properties: [property],
					params: error.params as Record<string, unknown>,
				});
			}
		} else {
			findings.push({
				code: "schema-invalid",
				severity: "error",
				path,
				keyword: error.keyword,
				params: error.params as Record<string, unknown>,
				message: error.message,
			});
		}
	}
	return deduplicateFindings(findings);
}

export function deduplicateFindings<T extends Finding>(findings: readonly T[]): T[] {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = `${finding.code}|${finding.severity}|${JSON.stringify(finding.path)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function formatFindingPath(pathSegments: FindingPath): string {
	return pathSegments.length === 0 ? "$" : `$${pathSegments.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("")}`;
}

export function renderFinding(finding: Finding): string {
	// An accepted advisory is still printed. The marker and reason are appended so the
	// reader sees the concern first and who accepted it second, rather than the finding
	// quietly not being there.
	const accepted = finding.disposition === undefined
		? ""
		: ` [accepted by ${finding.disposition.authority} at ${finding.disposition.at}: ${finding.disposition.reason}]`;
	const summary = `${finding.severity} ${finding.code} at ${formatFindingPath(finding.path)}`;
	if (finding.code === "touches-concentration") {
		return `${summary}: ${finding.target} (${finding.nodeIds.join(", ")})${accepted}`;
	}
	if (finding.code === "absolute-path") return `${summary}: ${finding.message}`;
	if (finding.code === "disposition-targets-error" || finding.code === "disposition-unmatched") return `${summary}: ${finding.message}`;
	if ("message" in finding && finding.code.startsWith("criterion-")) return `${summary}: ${finding.message}`;
	return `${summary}${accepted}`;
}

export function errorCount(findings: readonly Finding[]): number {
	return findings.filter((finding) => finding.severity === "error").length;
}

export function warningCount(findings: readonly Finding[]): number {
	return findings.filter((finding) => finding.severity === "warning").length;
}
