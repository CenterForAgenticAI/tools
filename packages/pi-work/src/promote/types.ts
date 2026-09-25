import type { FindingPath, FindingSeverity } from "../schema/findings.js";

export type PromotionRegionName = "summary" | "rationale" | "criteria" | "decisions";

export interface SourceRegion {
	name: PromotionRegionName;
	level: number;
	start: number;
	end: number;
	source: string;
	line: number;
}

export type PromotionFindingCode =
	| "criteria-missing"
	| "criteria-malformed"
	| "criteria-marker-malformed"
	| "criteria-duplicate-marker"
	| "criteria-duplicate-id"
	| "criteria-overlapping-markers"
	| "decisions-malformed"
	| "decisions-duplicate-id"
	| "optional-region-missing"
	| "read-error"
	| "write-error";

export interface PromotionFinding {
	code: PromotionFindingCode;
	severity: FindingSeverity;
	path: FindingPath;
	message: string;
	sourcePath: string;
	expectedFormat: string;
	region?: PromotionRegionName;
	line?: number;
	id?: string;
	relatedPaths?: FindingPath[];
}

export interface CriteriaEntry {
	id: string;
	line: number;
	statement: string;
}

/** One promoted open decision. Every field the spec requires is required here. */
export interface DecisionEntry {
	id: string;
	line: number;
	question: string;
	tripwire: string;
	decides: string;
}

const criteriaBlockBrand: unique symbol = Symbol("CriteriaBlock");

export interface CriteriaBlock extends SourceRegion {
	name: "criteria";
	entries: readonly CriteriaEntry[];
	readonly [criteriaBlockBrand]: true;
}

/** Internal construction/guard boundary for the validated criteria value. */
export function makeValidatedCriteriaBlock(region: SourceRegion, entries: readonly CriteriaEntry[]): CriteriaBlock {
	return {
		...region,
		name: "criteria",
		entries,
		[criteriaBlockBrand]: true,
	};
}

export function isValidatedCriteriaBlock(value: unknown): value is CriteriaBlock {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[criteriaBlockBrand] === true;
}

export interface ParsedDraftSuccess {
	ok: true;
	sourcePath: string;
	source: string;
	criteria: CriteriaBlock;
	summary?: SourceRegion;
	rationale?: SourceRegion;
	/** Absent when the draft declares no decisions region; empty when it declares an empty one. */
	decisions?: readonly DecisionEntry[];
	findings: PromotionFinding[];
}

export interface ParsedDraftFailure {
	ok: false;
	sourcePath: string;
	findings: PromotionFinding[];
}

export type ParsedDraft = ParsedDraftSuccess | ParsedDraftFailure;

export interface PromotedDraftSuccess {
	ok: true;
	sourcePath: string;
	specSource: string;
	findings: PromotionFinding[];
}

export interface PromotedDraftFailure {
	ok: false;
	sourcePath: string;
	findings: PromotionFinding[];
}

export type PromotedDraft = PromotedDraftSuccess | PromotedDraftFailure;

export interface LiteralBlock {
	header: string;
	source: string;
	indent: number;
}
