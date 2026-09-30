import type { Condition, JsonValue, VerdictName } from "../model.js";

export type { Diagnostic, ExecutableGraph } from "../model.js";

export interface ValidatorBoundary {
	readonly graph: unknown;
	readonly diagnostics: readonly unknown[];
}

export const RESERVED_VERDICTS = new Set(["pass", "fail", "error", "aborted", "timeout", "changed", "unchanged", "ok", "limit", "unmatched"]);
export const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
export const CONTRACT_KEYS = new Set([
	"type", "enum", "const", "required", "properties", "additionalProperties", "items", "prefixItems",
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern",
	"minItems", "maxItems", "uniqueItems", "oneOf", "anyOf", "allOf", "not",
]);

const identifier = /^[a-z][a-z0-9-]*$/;
const statePath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const regexFlags = new Set(["i", "m", "s", "u"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && identifier.test(value);
}

export function isStatePath(value: unknown): value is string {
	return typeof value === "string" && statePath.test(value) && value.split(".").every((part) => !UNSAFE_PATH_SEGMENTS.has(part));
}

export function isSafeRegex(pattern: string): { code?: "E-INVALID-REGEX" | "E-UNSAFE-REGEX"; error?: string } {
	if (pattern.length > 512) return { code: "E-INVALID-REGEX", error: "Pattern exceeds 512 characters." };
	if (/\\(?:[1-9]\d*)/.test(pattern) || /\(\?(?:[=!]|<[=!])/.test(pattern)) return { code: "E-UNSAFE-REGEX", error: "Backreferences and lookaround are not supported." };
	if (/\((?:[^()]*(?:[+*]|\{\d+,\}))[^()]*\)(?:[+*]|\{\d+,\})/.test(pattern) || /\((?:[^()]\|[^()]*)\)(?:[+*]|\{\d+,\})/.test(pattern)) {
		return { code: "E-UNSAFE-REGEX", error: "Nested unbounded quantifiers or alternation are not supported." };
	}
	try {
		new RegExp(pattern);
	} catch (error) {
		return { code: "E-INVALID-REGEX", error: error instanceof Error ? error.message : "Invalid regular expression." };
	}
	return {};
}

export function validateRegexFlags(flags: unknown): boolean {
	return typeof flags === "string" && [...flags].every((flag) => regexFlags.has(flag)) && new Set(flags).size === flags.length;
}

function equalJson(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return equalJson(leftKeys, rightKeys) && leftKeys.every((key) => equalJson(left[key], right[key]));
	}
	return false;
}

/** Validate a value against the restricted graph contract dialect. */
export function validateContractValue(schema: unknown, value: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => equalJson(candidate, value))) return false;
	if ("const" in schema && !equalJson(schema.const, value)) return false;
	if (Array.isArray(schema.oneOf) && schema.oneOf.filter((item) => validateContractValue(item, value)).length !== 1) return false;
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => validateContractValue(item, value))) return false;
	if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => validateContractValue(item, value))) return false;
	if (schema.not !== undefined && validateContractValue(schema.not, value)) return false;
	if (typeof schema.type === "string" || Array.isArray(schema.type)) {
		const types = typeof schema.type === "string" ? [schema.type] : schema.type;
		if (!types.some((type) => matchesType(type, value))) return false;
	}
	if (typeof schema.minimum === "number" && (typeof value !== "number" || value < schema.minimum)) return false;
	if (typeof schema.maximum === "number" && (typeof value !== "number" || value > schema.maximum)) return false;
	if (typeof schema.exclusiveMinimum === "number" && (typeof value !== "number" || value <= schema.exclusiveMinimum)) return false;
	if (typeof schema.exclusiveMaximum === "number" && (typeof value !== "number" || value >= schema.exclusiveMaximum)) return false;
	if (typeof schema.minLength === "number" && (typeof value !== "string" || value.length < schema.minLength)) return false;
	if (typeof schema.maxLength === "number" && (typeof value !== "string" || value.length > schema.maxLength)) return false;
	if (typeof schema.pattern === "string" && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) return false;
	if (typeof schema.minItems === "number" && (!Array.isArray(value) || value.length < schema.minItems)) return false;
	if (typeof schema.maxItems === "number" && (!Array.isArray(value) || value.length > schema.maxItems)) return false;
	if (schema.uniqueItems === true && Array.isArray(value) && value.some((item, index) => value.slice(0, index).some((prior) => equalJson(item, prior)))) return false;
	if (Array.isArray(schema.items) ? false : schema.items !== undefined && Array.isArray(value) && !value.every((item) => validateContractValue(schema.items, item))) return false;
	if (Array.isArray(schema.prefixItems) && Array.isArray(value) && schema.prefixItems.some((item, index) => index < value.length && !validateContractValue(item, value[index]))) return false;
	const properties = isRecord(schema.properties) ? schema.properties : undefined;
	if (properties && isRecord(value)) {
		if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !(key in value)))) return false;
		for (const [key, child] of Object.entries(properties)) if (key in value && !validateContractValue(child, value[key])) return false;
		if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
		if (isRecord(schema.additionalProperties)) {
			for (const [key, child] of Object.entries(value)) if (!(key in properties) && !validateContractValue(schema.additionalProperties, child)) return false;
		}
	}
	return true;
}

function matchesType(type: unknown, value: unknown): boolean {
	switch (type) {
		case "null": return value === null;
		case "boolean": return typeof value === "boolean";
		case "object": return isRecord(value) || Array.isArray(value);
		case "array": return Array.isArray(value);
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "string": return typeof value === "string";
		default: return false;
	}
}

export function conditionToCompiled(source: unknown): Condition | undefined {
	if (!isRecord(source)) return undefined;
	if (typeof source.path === "string" && typeof source.op === "string") {
		if (!["exists", "truthy"].includes(source.op) && !("value" in source) && source.op !== "matches") return undefined;
		if (!["eq", "ne", "gt", "gte", "lt", "lte", "exists", "truthy", "includes", "matches"].includes(source.op)) return undefined;
		if (!isStatePath(source.path)) return undefined;
		if (source.op === "matches") {
			if (typeof source.pattern !== "string") return undefined;
			return { op: "matches", path: source.path, pattern: source.pattern, flags: typeof source.flags === "string" ? source.flags : "" };
		}
		if (source.op === "exists" || source.op === "truthy") return { op: source.op, path: source.path };
		if (!isJsonValue(source.value)) return undefined;
		return { op: source.op, path: source.path, value: source.value } as Condition;
	}
	if (Array.isArray(source.all)) {
		const of = source.all.map(conditionToCompiled);
		return of.every((item): item is Condition => item !== undefined) ? { op: "all", of } : undefined;
	}
	if (Array.isArray(source.any)) {
		const of = source.any.map(conditionToCompiled);
		return of.every((item): item is Condition => item !== undefined) ? { op: "any", of } : undefined;
	}
	if (source.not !== undefined) {
		const of = conditionToCompiled(source.not);
		return of ? { op: "not", of } : undefined;
	}
	return undefined;
}

export function contractVerdicts(contract: Record<string, unknown>): { kind: "closed"; verdicts: VerdictName[] } | { kind: "open" } | undefined {
	if (contract.type !== "object" || !Array.isArray(contract.required) || !contract.required.includes("verdict")) return undefined;
	const properties = isRecord(contract.properties) ? contract.properties : undefined;
	const verdict = properties?.verdict;
	if (!isRecord(verdict)) return { kind: "open" };
	if (!Array.isArray(verdict.enum) || !verdict.enum.every((item): item is string => typeof item === "string" && isIdentifier(item))) return { kind: "open" };
	return { kind: "closed", verdicts: [...new Set(verdict.enum)] };
}
