import type { FindingPath, SchemaFinding } from "./findings.js";

type JsonSchema = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

function record(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaRecord(value: unknown): JsonSchema | undefined {
	return record(value) ? value : undefined;
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema | undefined {
	if (!reference.startsWith("#/")) {
		return record(root.$defs) ? schemaRecord(root.$defs[reference]) : undefined;
	}
	let value: unknown = root;
	for (const encoded of reference.slice(2).split("/")) {
		if (!record(value)) return undefined;
		const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		value = value[segment];
	}
	return schemaRecord(value);
}

function resolvedSchema(schema: JsonSchema, roots: readonly JsonSchema[]): JsonSchema {
	const reference = typeof schema.$ref === "string" ? schema.$ref : undefined;
	if (reference === undefined) return schema;
	for (let index = roots.length - 1; index >= 0; index -= 1) {
		const resolved = resolveReference(roots[index]!, reference);
		if (resolved !== undefined) return resolved;
	}
	return schema;
}

function valueMatchesType(type: unknown, value: unknown): boolean | undefined {
	if (typeof type !== "string") return undefined;
	switch (type) {
		case "array": return Array.isArray(value);
		case "object": return record(value);
		case "string": return typeof value === "string";
		case "number": return typeof value === "number";
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return undefined;
	}
}

function branchScore(schema: JsonSchema, value: unknown, roots: readonly JsonSchema[]): number {
	const resolved = resolvedSchema(schema, roots);
	if (record(resolved.not) && Object.keys(resolved.not).length === 0) return -10_000;
	let score = 0;
	if ("const" in resolved) score += Object.is(resolved.const, value) ? 1_000 : -1_000;
	const typeMatch = valueMatchesType(resolved.type, value);
	if (typeMatch !== undefined) score += typeMatch ? 20 : -20;
	if (!record(value) || !record(resolved.properties)) return score;
	for (const [key, propertyValue] of Object.entries(value)) {
		const propertySchema = schemaRecord(resolved.properties[key]);
		if (propertySchema === undefined) {
			if (resolved.additionalProperties === false) score -= 5;
			continue;
		}
		score += 2;
		const propertyResolved = resolvedSchema(propertySchema, roots);
		if (record(propertyResolved.not) && Object.keys(propertyResolved.not).length === 0) {
			score -= 100;
			continue;
		}
		if ("const" in propertyResolved) score += Object.is(propertyResolved.const, propertyValue) ? 100 : -100;
		const propertyTypeMatch = valueMatchesType(propertyResolved.type, propertyValue);
		if (propertyTypeMatch !== undefined) score += propertyTypeMatch ? 10 : -10;
	}
	return score;
}

function selectUnionBranch(branches: readonly unknown[], value: unknown, roots: readonly JsonSchema[]): JsonSchema | undefined {
	const schemas = branches.map(schemaRecord).filter((schema): schema is JsonSchema => schema !== undefined);
	let selected: JsonSchema | undefined;
	let selectedScore = Number.NEGATIVE_INFINITY;
	for (const schema of schemas) {
		const score = branchScore(schema, value, roots);
		if (score > selectedScore) {
			selected = schema;
			selectedScore = score;
		}
	}
	return selected;
}

/** Find keys rejected by closed object schemas without depending on TypeBox's error iterator. */
export function unknownPropertyFindings(schema: unknown, value: unknown): SchemaFinding[] {
	const root = schemaRecord(schema);
	if (root === undefined) return [];
	const findings: SchemaFinding[] = [];
	const seen = new Set<string>();

	function add(path: FindingPath, property: string): void {
		const key = JSON.stringify(path);
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({
			code: "schema-additional-properties",
			severity: "error",
			path,
			keyword: "additionalProperties",
			properties: [property],
			params: { additionalProperties: [property] },
		});
	}

	function visit(candidate: JsonSchema, current: unknown, path: FindingPath, inheritedRoots: readonly JsonSchema[]): void {
		const roots = record(candidate.$defs) ? [...inheritedRoots, candidate] : inheritedRoots;
		const resolved = resolvedSchema(candidate, roots);
		if (resolved !== candidate) {
			visit(resolved, current, path, roots);
			return;
		}
		const union = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : undefined;
		if (union !== undefined) {
			const branch = selectUnionBranch(union, current, roots);
			if (branch !== undefined) visit(branch, current, path, roots);
			return;
		}
		if (Array.isArray(resolved.allOf)) {
			for (const branch of resolved.allOf) {
				const branchSchema = schemaRecord(branch);
				if (branchSchema !== undefined) visit(branchSchema, current, path, roots);
			}
		}
		if (Array.isArray(current)) {
			const itemSchema = schemaRecord(resolved.items);
			if (itemSchema !== undefined) current.forEach((item, index) => visit(itemSchema, item, [...path, index], roots));
			return;
		}
		if (!record(current) || !record(resolved.properties)) return;
		const properties = resolved.properties;
		if (resolved.additionalProperties === false) {
			for (const property of Object.keys(current)) {
				if (!Object.hasOwn(properties, property)) add([...path, property], property);
			}
		}
		for (const property of Object.keys(current)) {
			const propertySchema = schemaRecord(properties[property]);
			if (propertySchema !== undefined) visit(propertySchema, current[property], [...path, property], roots);
		}
	}

	visit(root, value, [], []);
	return findings;
}
