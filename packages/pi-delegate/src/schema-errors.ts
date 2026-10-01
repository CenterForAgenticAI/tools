import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** One validation failure: a JSON-pointer `path` (e.g. `/config/model`) and a message. */
export interface SchemaIssue {
	path: string;
	message: string;
}

interface ValidationError {
	keyword: string;
	schemaPath: string;
	instancePath: string;
	params?: unknown;
	message: string;
}

function pointerSegment(name: string): string {
	return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Sub-schema addressed by an error's `schemaPath` (`#/properties/a/anyOf/0`). */
function schemaAt(root: TSchema, schemaPath: string): Record<string, unknown> | undefined {
	let node: unknown = root;
	for (const raw of schemaPath.replace(/^#/, "").split("/").filter(Boolean)) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[raw.replaceAll("~1", "/").replaceAll("~0", "~")];
	}
	return node && typeof node === "object" ? (node as Record<string, unknown>) : undefined;
}

/** TypeBox 0.34's wording for the common keywords; anything else keeps the 1.x message. */
function legacyMessage(error: ValidationError, schema: Record<string, unknown> | undefined): string {
	const kind = typeof schema?.type === "string" ? schema.type : "number";
	switch (error.keyword) {
		case "type":
			return typeof schema?.type === "string" ? `Expected ${schema.type}` : error.message;
		case "const": {
			const value = schema?.const;
			return `Expected ${typeof value === "string" ? `'${value}'` : String(value)}`;
		}
		case "minimum":
			return `Expected ${kind} to be greater or equal to ${String(schema?.minimum)}`;
		case "maximum":
			return `Expected ${kind} to be less or equal to ${String(schema?.maximum)}`;
		case "exclusiveMinimum":
			return `Expected ${kind} to be greater than ${String(schema?.exclusiveMinimum)}`;
		case "exclusiveMaximum":
			return `Expected ${kind} to be less than ${String(schema?.exclusiveMaximum)}`;
		case "minLength":
			return `Expected string length greater or equal to ${String(schema?.minLength)}`;
		case "maxLength":
			return `Expected string length less or equal to ${String(schema?.maxLength)}`;
		case "minItems":
			return `Expected array length to be greater or equal to ${String(schema?.minItems)}`;
		case "maxItems":
			return `Expected array length to be less or equal to ${String(schema?.maxItems)}`;
		case "pattern":
			return `Expected string to match '${String(schema?.pattern)}'`;
		// 0.34 checked a string `enum` as a union of literals; keep that wording.
		case "enum":
			return "Expected union value";
		default:
			return error.message;
	}
}

/**
 * Validation failures for `value`, with the paths and wording TypeBox 0.34 used.
 *
 * TypeBox 1.x returns ajv-style errors (`instancePath`, `keyword`, `params`)
 * as an array and reports a failed union as each failed branch. Callers match
 * on field paths (`/config/tools`), so this reports a failed union once, at
 * the union's own path, as `Expected union value`; an unknown property at that
 * property's path; and a missing required property at the property's path.
 */
export function schemaIssues(schema: TSchema, value: unknown): SchemaIssue[] {
	const errors = Value.Errors(schema, value) as ValidationError[];
	const issues: SchemaIssue[] = [];
	const seen = new Set<string>();
	const push = (path: string, message: string) => {
		const key = `${path}\u0000${message}`;
		if (seen.has(key)) return;
		seen.add(key);
		issues.push({ path, message });
	};
	// Every error inside a union's branch belongs to the outermost failed union.
	const unions = new Map<string, string>();
	for (const error of errors) {
		const at = error.schemaPath.search(/\/(?:anyOf|oneOf)(?:\/|$)/);
		if (at < 0) continue;
		const union = error.schemaPath.slice(0, at);
		const known = unions.get(union);
		if (known === undefined || error.instancePath.length < known.length) unions.set(union, error.instancePath);
	}
	const unexpected = new Set(errors.filter((error) => error.keyword === "boolean").map((error) => error.instancePath));
	for (const error of errors) {
		const at = error.schemaPath.search(/\/(?:anyOf|oneOf)(?:\/|$)/);
		if (at >= 0) {
			push(unions.get(error.schemaPath.slice(0, at)) ?? error.instancePath, "Expected union value");
			continue;
		}
		const params = (error.params ?? {}) as Record<string, unknown>;
		switch (error.keyword) {
			case "anyOf":
			case "oneOf":
				push(error.instancePath, "Expected union value");
				break;
			case "boolean":
				push(error.instancePath, "Unexpected property");
				break;
			case "additionalProperties": {
				const names = Array.isArray(params.additionalProperties) ? params.additionalProperties : [];
				for (const name of names) {
					const path = `${error.instancePath}/${pointerSegment(String(name))}`;
					if (!unexpected.has(path)) push(path, "Unexpected property");
				}
				break;
			}
			case "required": {
				const names = Array.isArray(params.requiredProperties) ? params.requiredProperties : [];
				for (const name of names) push(`${error.instancePath}/${pointerSegment(String(name))}`, "Expected required property");
				break;
			}
			default:
				push(error.instancePath, legacyMessage(error, schemaAt(schema, error.schemaPath)));
		}
	}
	return issues;
}

/** The first validation failure, or `undefined` when `value` matches `schema`. */
export function firstSchemaIssue(schema: TSchema, value: unknown): SchemaIssue | undefined {
	if (Value.Check(schema, value)) return undefined;
	return schemaIssues(schema, value)[0];
}
