import { Check, Errors } from "typebox/value";

import { applyAdvisoryDispositions } from "./advisory-disposition.js";
import { validateCriterionLineage } from "./criterion-lineage.js";
import { validateDependencies } from "./dependencies.js";
import { decodeJsonPointer, deduplicateFindings, errorCount, type Finding, type ValidationResult, typeboxFindings } from "./findings.js";
import { workspecFormatFindings } from "./formats.js";
import { unknownPropertyFindings } from "./unknown-properties.js";
import { parseYaml } from "./parser.js";
import { WorkspecSchema, type Workspec } from "./workspec.js";
import { validationRootForSpec } from "./validation-root.js";
import { lintWorkspec } from "../lint/workspec-lints.js";

export * from "./advisory-disposition.js";
export * from "./dependencies.js";
export * from "./findings.js";
export * from "./parser.js";
export * from "./tags.js";
export * from "./workspec.js";
export { WorkspecSchema };

export interface WorkspecValidationContext {
	/** Absolute path to the spec being validated. Required when providing a context. */
	specPath: string;
	/** Used only when the spec has neither a Git root nor a .work ancestor. */
	cwd?: string;
}

export function validateWorkspec(source: string): ValidationResult<Workspec>;
export function validateWorkspec(source: string, context: WorkspecValidationContext): ValidationResult<Workspec>;
export function validateWorkspec(source: string, context?: WorkspecValidationContext): ValidationResult<Workspec> {
	const parsed = parseYaml(source);
	const findings: Finding[] = [...parsed.findings];
	if (parsed.findings.some((finding) => finding.severity === "error") || parsed.value === undefined) {
		return { structuralValid: false, valid: false, findings: deduplicateFindings(findings), value: parsed.value, source, tags: parsed.tags };
	}
	const schemaErrors = Errors(WorkspecSchema, parsed.value);
	const unknownProperties = unknownPropertyFindings(WorkspecSchema, parsed.value);
	const unknownPaths = new Set(unknownProperties.map((finding) => JSON.stringify(finding.path)));
	const directSchemaFindings = [...unknownProperties, ...workspecFormatFindings(parsed.value)];
	const otherSchemaErrors = schemaErrors.filter((error) => error.keyword !== "additionalProperties" && !unknownPaths.has(JSON.stringify(decodeJsonPointer(error.instancePath))));
	findings.push(...typeboxFindings(otherSchemaErrors), ...directSchemaFindings);
	if (schemaErrors.length > 0 || directSchemaFindings.length > 0 || !Check(WorkspecSchema, parsed.value)) {
		return { structuralValid: false, valid: false, findings: deduplicateFindings(findings), value: parsed.value, source, tags: parsed.tags };
	}
	const spec = parsed.value as Workspec;
	findings.push(...validateDependencies(spec));
	findings.push(...validateCriterionLineage(spec, { source, root: context ? validationRootForSpec(context.specPath, context.cwd) : process.cwd() }));
	findings.push(...lintWorkspec(spec));
	// Dispositions run last so they see every finding, and after deduplication so one
	// reason cannot be consumed by a duplicate that is about to be collapsed.
	const dispositioned = applyAdvisoryDispositions(spec, deduplicateFindings(findings));
	const deduplicated = deduplicateFindings([...dispositioned.findings]);
	return {
		structuralValid: true,
		valid: errorCount(deduplicated) === 0,
		findings: deduplicated,
		value: spec,
		spec,
		source,
		tags: parsed.tags,
	};
}
