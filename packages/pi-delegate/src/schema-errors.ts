import { compile, type CoercingValidator, type Schema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

// Preserve all-optional native types under this package's non-strict-null TS configuration.
export type SchemaValue<S extends Schema> = S extends Schema<infer T> ? T : unknown;

/** One structural refusal, using the validator's JSON-pointer path. */
export interface SchemaIssue {
	path: string;
	message: string;
}

const validators = new WeakMap<Schema, ReturnType<typeof compile>>();
const coercers = new WeakMap<Schema, CoercingValidator>();

function validator(schema: Schema) {
	let cached = validators.get(schema);
	if (!cached) {
		cached = compile(schema, { formats });
		validators.set(schema, cached);
	}
	return cached;
}

/** Structural admission never coerces wire or persisted data. */
export function checkSchema<S extends Schema>(schema: S, value: unknown): value is SchemaValue<S> {
	return validator(schema).check(value);
}

/** Explicit tool-ingress preparation; callers own semantic/null policy. */
export function coerceSchema(schema: Schema, value: unknown): unknown {
	// Keep coercion compiled separately so result admission cannot enable it.
	const cached = coercers.get(schema);
	if (cached) return cached.coerce(value);
	const coercer = compile(schema, { formats, coerce: true });
	coercers.set(schema, coercer);
	return coercer.coerce(value);
}

/** Native errors retain the actual failing field instead of parsing TypeBox prose. */
export function schemaIssues(schema: Schema, value: unknown): SchemaIssue[] {
	return validator(schema).errors(value).map(({ path, keyword, message }) => ({ path, message: refineMessage(schema, value, path, keyword, message) }));
}

/**
 * The validator blames one branch of a failed literal union (`expected "solo"`), which misleads a caller about
 * the other allowed values. Report every literal the field accepts instead, in the validator's own enum wording.
 * A non-finite number, which JSON cannot carry, is named rather than reported as a wrong `number`.
 */
function refineMessage(schema: Schema, value: unknown, path: string, keyword: string, message: string): string {
	const segments = path === "" ? [] : path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	if (keyword === "const" || keyword === "enum") {
		const accepted = acceptedAt(schema, segments);
		if (!accepted || accepted.literals.length + accepted.types.length < 2) return message;
		const list = `expected one of ${JSON.stringify(accepted.literals)}`;
		return accepted.types.length ? `${list} or ${accepted.types.join(" or ")}` : list;
	}
	const actual = valueAt(value, segments);
	if (typeof actual === "number" && !Number.isFinite(actual)) return message.replace(/got number$/, `got ${String(actual)}`);
	return message;
}

function valueAt(value: unknown, segments: string[]): unknown {
	let current = value;
	for (const segment of segments) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The node itself and every branch reachable through its unions. */
function branches(node: unknown): Node[] {
	if (!isNode(node)) return [];
	const out: Node[] = [node];
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const list = node[key];
		if (Array.isArray(list)) for (const branch of list) out.push(...branches(branch));
	}
	return out;
}

/** Every subschema that can govern the value at `segments`, following union branches. */
export function schemasAt(schema: Schema, segments: string[]): Schema[] {
	let candidates: unknown[] = [schema];
	for (const segment of segments) {
		const next: unknown[] = [];
		for (const node of candidates.flatMap(branches)) {
			const properties = node.properties;
			if (isNode(properties) && segment in properties) next.push(properties[segment]);
			else if (/^\d+$/.test(segment) && node.items !== undefined) next.push(node.items);
			else if (isNode(node.additionalProperties)) next.push(node.additionalProperties);
		}
		candidates = next;
	}
	return candidates.filter(isNode) as Schema[];
}

/** Whether `schema` or any branch of its unions is object-typed. */
export function admitsObject(schema: Schema): boolean {
	return branches(schema).some((node) => node.type === "object");
}

/**
 * The literals a literal-bearing field accepts, plus the JSON types of any non-literal branches, or undefined when
 * the field cannot be resolved to one node or has a branch without a plain `type`.
 */
function acceptedAt(schema: Schema, segments: string[]): { literals: unknown[]; types: string[] } | undefined {
	const candidates = schemasAt(schema, segments);
	if (candidates.length !== 1) return undefined;
	const field = candidates[0];
	const leaves = Array.isArray(field.anyOf) ? field.anyOf : Array.isArray(field.oneOf) ? field.oneOf : [field];
	const literals: unknown[] = [];
	const types: string[] = [];
	for (const leaf of leaves) {
		if (!isNode(leaf)) return undefined;
		if ("const" in leaf) literals.push(leaf.const);
		else if (Array.isArray(leaf.enum)) literals.push(...leaf.enum);
		else if (typeof leaf.type === "string") {
			if (!types.includes(leaf.type)) types.push(leaf.type);
		} else return undefined;
	}
	return literals.length ? { literals, types } : undefined;
}

/** The first structural refusal, or undefined when the value is admitted. */
export function firstSchemaIssue(schema: Schema, value: unknown): SchemaIssue | undefined {
	return checkSchema(schema, value) ? undefined : schemaIssues(schema, value)[0];
}
