import type {
	AdapterBinding,
	AgentCatalog,
	CompileReport,
	CompileResult,
	CompiledNode,
	CompiledTransitions,
	Condition,
	Destination,
	ExecutableGraph,
	GraphSourceBody,
	JoinMode,
	JsonObject,
	StatePath,
	TemplateCatalog,
	VerdictSet,
} from "../model.js";
import { parseShorthand } from "./parser.js";
import {
	CONTRACT_KEYS,
	RESERVED_VERDICTS,
	UNSAFE_PATH_SEGMENTS,
	conditionToCompiled,
	contractVerdicts,
	isIdentifier,
	isJsonValue,
	isRecord,
	isSafeRegex,
	isStatePath,
	validateRegexFlags,
} from "./validator.js";

const terminal = new Set(["done", "fail"]);
const nodeKinds = ["template", "agent", "command", "human", "set"] as const;
const defaultTimeout: Record<(typeof nodeKinds)[number], number | null> = { set: 1000, command: 600000, template: 900000, agent: 1800000, human: null };
const graphNamePattern = /^[a-z][a-z0-9-]*$/;

interface WorkDiagnostic {
	code: string;
	severity: "error" | "warning";
	message: string;
	nodeId?: string;
	path?: string;
}

function diag(diagnostics: WorkDiagnostic[], code: string, message: string, nodeId?: string, path?: string, severity: WorkDiagnostic["severity"] = "error") {
	diagnostics.push({ code, severity, message, ...(nodeId ? { nodeId } : {}), ...(path ? { path } : {}) });
}

function isIntegerAtLeast(value: unknown, minimum = 1): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function destination(value: unknown): value is Destination {
	return typeof value === "string" && (terminal.has(value) || isIdentifier(value));
}
function sourceKeys(node: Record<string, unknown>): string[] {
	return Object.keys(node);
}

function validateContractShape(contract: unknown, diagnostics: WorkDiagnostic[], nodeId: string, path: string): { schema?: JsonObject; routable?: VerdictSet } {
	if (!isRecord(contract)) {
		diag(diagnostics, "E-INVALID-CONTRACT", "Contract must be a JSON Schema object.", nodeId, path);
		return {};
	}
	const valid = validateSchemaObject(contract, diagnostics, nodeId, path);
	const properties = isRecord(contract.properties) ? contract.properties : undefined;
	const verdictSchema = properties && isRecord(properties.verdict) ? properties.verdict : undefined;
	if (verdictSchema && Array.isArray(verdictSchema.enum)) for (const verdict of verdictSchema.enum) if (typeof verdict === "string" && RESERVED_VERDICTS.has(verdict)) diag(diagnostics, "E-RESERVED-VERDICT", `Reserved verdict ${verdict} cannot be declared by a contract.`, nodeId, `${path}.properties.verdict`);
	if (!valid) return {};
	const routable = contractVerdicts(contract);
	return { schema: contract as JsonObject, ...(routable === undefined ? {} : { routable }) };
}
function validateSchemaObject(schema: Record<string, unknown>, diagnostics: WorkDiagnostic[], nodeId: string, path: string): boolean {
	let valid = true;
	for (const key of Object.keys(schema)) {
		if (!CONTRACT_KEYS.has(key)) {
			diag(diagnostics, "E-INVALID-CONTRACT", `Contract keyword ${key} is not permitted.`, nodeId, `${path}.${key}`);
			valid = false;
		}
	}
	if (schema.type !== undefined && !(typeof schema.type === "string" || (Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string")))) valid = false;
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.every(isJsonValue))) valid = false;
	if (schema.const !== undefined && !isJsonValue(schema.const)) valid = false;
	if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) valid = false;
	if (schema.properties !== undefined) {
		if (!isRecord(schema.properties)) valid = false;
		else for (const [key, child] of Object.entries(schema.properties)) if (!isRecord(child) || !validateSchemaObject(child, diagnostics, nodeId, `${path}.properties.${key}`)) valid = false;
	}
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && (!isRecord(schema.additionalProperties) || !validateSchemaObject(schema.additionalProperties, diagnostics, nodeId, `${path}.additionalProperties`))) valid = false;
	for (const key of ["items", "not"]) if (schema[key] !== undefined && (!isRecord(schema[key]) || !validateSchemaObject(schema[key], diagnostics, nodeId, `${path}.${key}`))) valid = false;
	for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
		if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].every((item) => isRecord(item) && validateSchemaObject(item, diagnostics, nodeId, `${path}.${key}`)))) valid = false;
	}
	for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) {
		if (schema[key] !== undefined && typeof schema[key] !== "number") valid = false;
	}
	if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") valid = false;
	if (schema.pattern !== undefined) {
		if (typeof schema.pattern !== "string") valid = false;
		else {
			const check = isSafeRegex(schema.pattern);
			if (check.code) { diag(diagnostics, check.code, check.error ?? "Invalid contract pattern.", nodeId, `${path}.pattern`); valid = false; }
		}
	}
	if (!valid) diag(diagnostics, "E-INVALID-CONTRACT", "Contract is outside the supported JSON Schema dialect.", nodeId, path);
	return valid;
}

function interpolated(value: unknown, diagnostics: WorkDiagnostic[], nodeId: string, path: string): Array<{ literal: string } | { path: StatePath }> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diag(diagnostics, "E-SOURCE-SHAPE", "Interpolated value must be a string.", nodeId, path);
		return undefined;
	}
	const result: Array<{ literal: string } | { path: StatePath }> = [];
	let cursor = 0;
	while (cursor < value.length) {
		const open = value.indexOf("{", cursor);
		if (open < 0) {
			if (cursor < value.length) result.push({ literal: value.slice(cursor) });
			break;
		}
		if (open > cursor) result.push({ literal: value.slice(cursor, open) });
		const close = value.indexOf("}", open + 1);
		if (close < 0) {
			diag(diagnostics, "E-INTERPOLATION-SYNTAX", "Interpolation has an unclosed placeholder.", nodeId, path);
			return undefined;
		}
		const state = value.slice(open + 1, close);
		if (!isStatePath(state)) {
			diag(diagnostics, "E-INTERPOLATION-SYNTAX", `Invalid state path ${state}.`, nodeId, path);
			return undefined;
		}
		result.push({ path: state });
		cursor = close + 1;
	}
	return result;
}

function pathsInInterpolated(value: Array<{ literal: string } | { path: StatePath }> | undefined): StatePath[] {
	return value?.flatMap((part) => "path" in part ? [part.path] : []) ?? [];
}

function validatePath(value: unknown, diagnostics: WorkDiagnostic[], nodeId: string, path: string): value is StatePath {
	if (!isStatePath(value)) {
		diag(diagnostics, value?.toString().includes("__proto__") || value?.toString().includes("constructor") ? "E-UNSAFE-STATE-PATH" : "E-SOURCE-SHAPE", "Invalid state path.", nodeId, path);
		return false;
	}
	return true;
}

function nodeKind(source: Record<string, unknown>): (typeof nodeKinds)[number] | undefined {
	const found = nodeKinds.filter((kind) => kind in source);
	return found.length === 1 ? found[0] : undefined;
}

function verdictSetFor(kind: CompiledNode["kind"], source: Record<string, unknown>, routable: VerdictSet | undefined, deterministic: boolean | undefined): VerdictSet {
	if (kind === "set") return { kind: "closed", verdicts: ["ok"] };
	if (kind === "human") {
		if (source.kind === "choice" && Array.isArray(source.options)) return { kind: "closed", verdicts: source.options.flatMap((option) => isRecord(option) && typeof option.id === "string" ? [option.id] : []) };
		return { kind: "closed", verdicts: source.kind === "text" ? ["answered"] : ["confirmed", "declined"] };
	}
	if (routable) return routable;
	if (source.contract && isRecord(source.contract) && "verdict" in source.contract) return { kind: "open" };
	if (kind === "command" || (kind === "template" && deterministic === true)) return { kind: "closed", verdicts: ["pass", "fail"] };
	if (kind === "agent") return { kind: "closed", verdicts: ["pass"] };
	if (kind === "template" && isRecord(source.sentinel) && isRecord(source.sentinel.verdicts)) return { kind: "closed", verdicts: [...new Set([...Object.values(source.sentinel.verdicts).filter((item): item is string => typeof item === "string"), "unmatched"])] };
	return { kind: "closed", verdicts: ["changed", "unchanged"] };
}

function validateSentinel(source: Record<string, unknown>, diagnostics: WorkDiagnostic[], nodeId: string): void {
	if (!isRecord(source.sentinel)) return;
	diag(diagnostics, "W-SENTINEL-VERDICT", "Routing on assistant prose uses a sentinel regex.", nodeId, "sentinel", "warning");
	if (typeof source.sentinel.pattern !== "string") {
		diag(diagnostics, "E-SOURCE-SHAPE", "Sentinel pattern must be a string.", nodeId, "sentinel.pattern");
		return;
	}
	const regex = isSafeRegex(source.sentinel.pattern);
	if (regex.code) diag(diagnostics, regex.code, regex.error ?? "Invalid regular expression.", nodeId, "sentinel.pattern");
	if (source.sentinel.flags !== undefined && (!validateRegexFlags(source.sentinel.flags) || typeof source.sentinel.flags !== "string")) diag(diagnostics, "E-INVALID-REGEX", "Unsupported regular expression flags.", nodeId, "sentinel.flags");
	if (!source.sentinel.pattern.includes("(?<verdict>")) diag(diagnostics, "E-SENTINEL-NO-GROUP", "Sentinel must contain a named verdict capture group.", nodeId, "sentinel.pattern");
	if (!isRecord(source.sentinel.verdicts)) {
		diag(diagnostics, "E-SOURCE-SHAPE", "Sentinel verdicts must be a mapping.", nodeId, "sentinel.verdicts");
		return;
	}
	for (const value of Object.values(source.sentinel.verdicts)) if (typeof value !== "string" || !isIdentifier(value)) diag(diagnostics, "E-SOURCE-SHAPE", "Sentinel verdicts must be identifier strings.", nodeId, "sentinel.verdicts"); else if (RESERVED_VERDICTS.has(value)) diag(diagnostics, "E-RESERVED-VERDICT", `Reserved verdict ${value} cannot be produced by a node.`, nodeId, "sentinel.verdicts");
}

function validateCommon(source: Record<string, unknown>, kind: CompiledNode["kind"], diagnostics: WorkDiagnostic[], nodeId: string): void {
	if (source.output !== undefined) validatePath(source.output, diagnostics, nodeId, "output");
	if (source.reads !== undefined) {
		if (!Array.isArray(source.reads)) diag(diagnostics, "E-SOURCE-SHAPE", "reads must be an array.", nodeId, "reads");
		else source.reads.forEach((path, index) => validatePath(path, diagnostics, nodeId, `reads[${index}]`));
	}
	if (source.writeMode !== undefined && !["reduce", "overwrite", "unset"].includes(String(source.writeMode))) diag(diagnostics, "E-SOURCE-SHAPE", "Invalid write mode.", nodeId, "writeMode");
	if (source.storage !== undefined && !["state", "artifact"].includes(String(source.storage))) diag(diagnostics, "E-SOURCE-SHAPE", "Invalid storage mode.", nodeId, "storage");
	if (source.storage === "artifact" && source.output === undefined) diag(diagnostics, "E-ARTIFACT-NO-OUTPUT", "Artifact storage requires output.", nodeId, "storage");
	if (source.tools !== undefined && (!isRecord(source.tools) || !Array.isArray(source.tools.allow) || !source.tools.allow.every((item) => typeof item === "string"))) diag(diagnostics, "E-SOURCE-SHAPE", "tools.allow must be an array of strings.", nodeId, "tools");
	if (source.limit !== undefined && !isIntegerAtLeast(source.limit)) diag(diagnostics, "E-NUMERIC-RANGE", "limit must be an integer of at least 1.", nodeId, "limit");
	if (source.limit !== undefined && source.onLimit === undefined) diag(diagnostics, "E-MISSING-ONLIMIT", "limit requires onLimit.", nodeId, "limit");
	if (source.onLimit !== undefined && !destination(source.onLimit)) diag(diagnostics, "E-UNKNOWN-NODE", "onLimit names an invalid destination.", nodeId, "onLimit");
	if (source.retry !== undefined) {
		if (!isRecord(source.retry)) diag(diagnostics, "E-SOURCE-SHAPE", "retry must be a mapping.", nodeId, "retry");
		else {
			if (source.retry.attempts !== undefined && !isIntegerAtLeast(source.retry.attempts)) diag(diagnostics, "E-NUMERIC-RANGE", "retry.attempts must be at least 1.", nodeId, "retry.attempts");
			if (source.retry.backoffMs !== undefined && !isNonNegativeInteger(source.retry.backoffMs)) diag(diagnostics, "E-NUMERIC-RANGE", "retry.backoffMs must be non-negative.", nodeId, "retry.backoffMs");
			if (source.retry.multiplier !== undefined && (typeof source.retry.multiplier !== "number" || source.retry.multiplier < 1)) diag(diagnostics, "E-NUMERIC-RANGE", "retry.multiplier must be at least 1.", nodeId, "retry.multiplier");
		}
	}
	if (source.timeoutMs !== undefined && !isNonNegativeInteger(source.timeoutMs)) diag(diagnostics, "E-NUMERIC-RANGE", "timeoutMs must be non-negative.", nodeId, "timeoutMs");
	if (source.join !== undefined && source.join !== "all" && source.join !== "any" && (!isRecord(source.join) || !isIntegerAtLeast(source.join.quorum))) diag(diagnostics, "E-SOURCE-SHAPE", "Invalid join mode.", nodeId, "join");
	if (kind === "set" && ["contract", "retry", "tools", "timeoutMs", "storage"].some((field) => field in source)) diag(diagnostics, "E-FIELD-NOT-VALID-FOR-KIND", "This field is not valid for a set node.", nodeId);
	if (kind === "human" && ["contract", "retry", "tools", "timeoutMs"].some((field) => field in source)) diag(diagnostics, "E-FIELD-NOT-VALID-FOR-KIND", "This field is not valid for a human node.", nodeId);
	// A shell command has no agent tool surface to narrow ([0005](../../.spec/0005-node-adapters.md) §8).
	// Accepting the field here would mean silently ignoring a declared restriction, which
	// [0011](../../.spec/0011-data-contracts.md) §3.3.1 forbids outright.
	if (kind === "command" && "tools" in source) diag(diagnostics, "E-FIELD-NOT-VALID-FOR-KIND", "tools.allow is not valid for a command node: there is no tool surface to restrict.", nodeId, "tools");
}

function compileTransitions(source: Record<string, unknown>, nodes: Set<string>, diagnostics: WorkDiagnostic[], nodeId: string): CompiledTransitions {
	const hasNext = "next" in source;
	const hasConditional = "on" in source || "when" in source || "default" in source;
	if (hasNext && hasConditional) diag(diagnostics, "E-MULTIPLE-TRANSITIONS", "next cannot be combined with on, when, or default.", nodeId);
	if (!hasNext && !hasConditional) diag(diagnostics, "E-NO-TRANSITION", "Every node must declare a transition.", nodeId);
	const check = (value: unknown, path: string): Destination | undefined => {
		if (!destination(value)) {
			diag(diagnostics, "E-UNKNOWN-NODE", "Transition names an unknown destination.", nodeId, path);
			return undefined;
		}
		if (!terminal.has(value) && !nodes.has(value)) diag(diagnostics, "E-UNKNOWN-NODE", `Transition destination ${value} does not exist.`, nodeId, path);
		return value;
	};
	if (hasNext) {
		const values = Array.isArray(source.next) ? source.next : [source.next];
		const next = values.map((value, index) => check(value, `next[${index}]`)).filter((value): value is Destination => value !== undefined);
		return { kind: "next", next, when: [], on: {} };
	}
	const on: Record<string, Destination> = {};
	if (source.on !== undefined) {
		if (!isRecord(source.on)) diag(diagnostics, "E-SOURCE-SHAPE", "on must be a mapping.", nodeId, "on");
		else for (const [verdict, target] of Object.entries(source.on)) {
			if (!isIdentifier(verdict) || verdict === "true" || verdict === "false") diag(diagnostics, "E-NON-STRING-VERDICT-KEY", "Verdict keys must be identifier strings; YAML boolean keys are not supported.", nodeId, `on.${verdict}`);
			const checked = check(target, `on.${verdict}`);
			if (checked) on[verdict] = checked;
		}
	}
	const when: Array<{ condition: Condition; to: Destination }> = [];
	if (source.when !== undefined) {
		if (!Array.isArray(source.when)) diag(diagnostics, "E-SOURCE-SHAPE", "when must be an array.", nodeId, "when");
		else for (const [index, clause] of source.when.entries()) {
			if (!isRecord(clause)) { diag(diagnostics, "E-SOURCE-SHAPE", "when clauses must be mappings.", nodeId, `when[${index}]`); continue; }
			const condition = conditionToCompiled(clause.if);
			if (!condition) diag(diagnostics, "E-SOURCE-SHAPE", "Invalid condition.", nodeId, `when[${index}].if`);
			const to = check(clause.to, `when[${index}].to`);
			if (condition && to) when.push({ condition, to });
			validateConditionRegex(condition, diagnostics, nodeId, `when[${index}].if`);
		}
	}
	let defaultTarget: Destination | undefined;
	if (source.default !== undefined) defaultTarget = check(source.default, "default");
	return { kind: "conditional", when, on, ...(defaultTarget ? { default: defaultTarget } : {}) };
}
function validateConditionRegex(condition: Condition | undefined, diagnostics: WorkDiagnostic[], nodeId: string, path: string): void {
	if (!condition) return;
	if (condition.op === "matches") {
		const result = isSafeRegex(condition.pattern);
		if (result.code) diag(diagnostics, result.code, result.error ?? "Invalid regular expression.", nodeId, path);
		if (!validateRegexFlags(condition.flags)) diag(diagnostics, "E-INVALID-REGEX", "Unsupported regular expression flags.", nodeId, path);
	} else if ("of" in condition) { const children = Array.isArray(condition.of) ? condition.of : [condition.of]; children.forEach((child, index) => validateConditionRegex(child, diagnostics, nodeId, `${path}.${index}`)); }
}

function derivedVerdicts(kind: CompiledNode["kind"], source: Record<string, unknown>, routable: VerdictSet | undefined, deterministic: boolean | undefined): VerdictSet {
	return verdictSetFor(kind, source, routable, deterministic);
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

// Small self-contained SHA-256 implementation keeps compile() free of node and platform APIs.
export function sha256(value: string): string {
	const bytes = new TextEncoder().encode(value);
	const words = new Uint32Array(64);
	const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
	const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6); padded.set(bytes); padded[bytes.length] = 0x80;
	const bitLength = bytes.length * 8; for (let index = 0; index < 8; index++) padded[padded.length - 1 - index] = (bitLength / 2 ** (index * 8)) & 0xff;
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index++) words[index] = (padded[offset + index * 4] << 24) | (padded[offset + index * 4 + 1] << 16) | (padded[offset + index * 4 + 2] << 8) | padded[offset + index * 4 + 3];
		for (let index = 16; index < 64; index++) { const s0 = (words[index - 15] >>> 7 | words[index - 15] << 25) ^ (words[index - 15] >>> 18 | words[index - 15] << 14) ^ (words[index - 15] >>> 3); const s1 = (words[index - 2] >>> 17 | words[index - 2] << 15) ^ (words[index - 2] >>> 19 | words[index - 2] << 13) ^ (words[index - 2] >>> 10); words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0; }
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index++) { const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7); const ch = (e & f) ^ (~e & g); const t1 = (h + s1 + ch + constants[index] + words[index]) >>> 0; const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10); const maj = (a & b) ^ (a & c) ^ (b & c); const t2 = (s0 + maj) >>> 0; [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g]; }
		hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0; hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0; hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
	}
	return [...hash].map((part) => part.toString(16).padStart(8, "0")).join("");
}

function graphName(path: string): string {
	const base = path.replaceAll("\\", "/").split("/").at(-1) ?? "graph";
	return base.replace(/\.md$/i, "");
}

function reachableNodes(entry: string, nodes: Record<string, CompiledNode>): Set<string> {
	const seen = new Set<string>(); const pending = [entry];
	while (pending.length) { const node = pending.pop()!; if (seen.has(node)) continue; seen.add(node); const transitions = nodes[node]?.transitions; if (!transitions) continue; const targets = [...(transitions.next ?? []), ...Object.values(transitions.on), ...(transitions.default ? [transitions.default] : []), ...transitions.when.map((item) => item.to), ...(nodes[node]?.limit ? [nodes[node].limit.onLimit] : []), ...(nodes[node]?.onError.kind === "route" ? [nodes[node].onError.to] : [])]; for (const target of targets) if (!terminal.has(target)) pending.push(target); }
	return seen;
}
function canReachTerminal(nodes: Record<string, CompiledNode>): Set<string> {
	const result = new Set<string>(); let changed = true;
	while (changed) { changed = false; for (const [id, node] of Object.entries(nodes)) { const targets = [...(node.transitions.next ?? []), ...Object.values(node.transitions.on), ...(node.transitions.default ? [node.transitions.default] : []), ...node.transitions.when.map((item) => item.to)]; if (targets.some((target) => terminal.has(target) || result.has(target))) { if (!result.has(id)) { result.add(id); changed = true; } } } }
	return result;
}
function inCycle(nodes: Record<string, CompiledNode>): Set<string> {
	const result = new Set<string>();
	for (const start of Object.keys(nodes)) { const stack = [...targetsFor(nodes[start])]; const seen = new Set<string>(); while (stack.length) { const target = stack.pop()!; if (target === start) { result.add(start); break; } if (terminal.has(target) || seen.has(target)) continue; seen.add(target); stack.push(...targetsFor(nodes[target])); } }
	return result;
}
function targetsFor(node: CompiledNode): string[] { return [...(node?.transitions.next ?? []), ...Object.values(node?.transitions.on ?? {}), ...(node?.transitions.default ? [node.transitions.default] : []), ...(node?.transitions.when ?? []).map((item) => item.to)].filter((target) => !terminal.has(target)); }
function writes(node: CompiledNode): string[] { return node.kind === "set" ? node.binding.kind === "set" ? node.binding.ops.map((op) => op.path) : [] : node.output ? [node.output] : []; }

/**
 * Every node with any transition into `target` — the ways a run can arrive there.
 *
 * Counts error and limit routes as well as verdict edges, because each of them
 * really does start the node.
 */
function enteredBy(target: string, nodes: Record<string, CompiledNode>): string[] {
	return Object.values(nodes).filter((node) => targetsFor(node).includes(target) || node.limit?.onLimit === target || (node.onError.kind === "route" && node.onError.to === target)).map((node) => node.id);
}

/**
 * Reports an `all` join that can never fire, when that can be **proved** from one
 * node's transitions.
 *
 * The proof is deliberately narrow, and the narrowness is the point: two of the
 * join's sources are direct destinations of one node's conditional map, so exactly
 * one of those edges is taken and at most one of the two sources can run. If
 * neither source is in a cycle, nothing can deliver the other token later, so the
 * join waits for a token that cannot exist. `all` needs one token from every
 * source (§7.3), so the run holds the tokens it has, spends its budget, and ends
 * with no result — the least useful outcome available ([0007](0007-safety-limits-and-security.md) §2).
 *
 * What it deliberately does not claim:
 *
 * - **A cycle makes it legal.** Each arm can deliver on a different lap, so a
 *   cyclic graph is never reported. Whether such a join *should* fire is the
 *   separate question D-046 identified and issue #25 carries.
 * - **Only direct destinations.** `b -> x -> j` against `b -> c -> j` is equally
 *   unsatisfiable and is **not** reported. Chasing it means reasoning about which
 *   whole paths can co-occur, and a false positive here rejects a legal graph at
 *   compile time — the worst direction to be wrong in (D-064).
 * - **`any` and `quorum` are untouched.** One arrival satisfies `any`, and a
 *   quorum exceeding its parallel sources is already `E-QUORUM-UNREACHABLE`.
 */
function exclusiveJoinSources(joinId: string, nodes: Record<string, CompiledNode>, cycles: ReadonlySet<string>, entry: string): { chooser: string; sources: string[] } | undefined {
	// The join's sources, as §7.3 means the word: everything with an edge into it.
	const sources = enteredBy(joinId, nodes);
	// One source cannot be in conflict with itself, and a source that a cycle can
	// re-enter may deliver on a later lap.
	if (sources.length < 2 || sources.some((source) => cycles.has(source))) return undefined;
	for (const node of Object.values(nodes)) {
		// Only a conditional map is exclusive. A `next` array is a fan-out: every
		// destination runs, which is the shape scan-consolidate.md uses.
		if (node.transitions.kind !== "conditional") continue;
		const alternatives = new Set<string>([...Object.values(node.transitions.on), ...node.transitions.when.map((clause) => clause.to), ...(node.transitions.default ? [node.transitions.default] : [])]);

		/**
		 * A rival must be reachable **only** through this node's conditional map.
		 * Anything else that can start it — another node's edge, an error route, a
		 * limit route, or being the graph's entry — is a second way in, and then both
		 * rivals can run and the join can fire after all. Without this the rule
		 * rejects a legal graph, which is the worst direction to be wrong in.
		 */
		const onlyVia = (source: string): boolean => source !== entry && enteredBy(source, nodes).every((entrant) => entrant === node.id);

		// Two of the join's sources on separate arms: taking one arm excludes the other.
		const rivals = sources.filter((source) => alternatives.has(source) && onlyVia(source));
		if (rivals.length >= 2) return { chooser: node.id, sources: rivals.sort() };


		// The chooser is itself a source, and one arm goes to the join while another
		// goes to a different source. This is the reported graph: `b on { pass: j,
		// fail: c }`. Reaching `c` means `b` routed away from the join, so `b`'s own
		// token was never emitted; reaching the join directly means `c` never ran.
		// Either way exactly one of the two tokens exists.
		if (sources.includes(node.id) && alternatives.has(joinId)) {
			const diverted = sources.filter((source) => source !== node.id && alternatives.has(source) && onlyVia(source));
			if (diverted.length) return { chooser: node.id, sources: [node.id, ...diverted].sort() };
		}
	}
	return undefined;
}
function overlapping(left: string, right: string): boolean { return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`); }

/**
 * Paths every artifact-storing node turns into an `ArtifactRef` rather than a
 * body. A condition reading one is reading the reference, and reading `preview`
 * is reading a truncated display string ([0011](../../.spec/0011-data-contracts.md) §8.3).
 */
function artifactPreviewPaths(nodes: Record<string, CompiledNode>): string[] {
	return Object.values(nodes).flatMap((node) => node.storage === "artifact" && node.output ? [`${node.output}.preview`] : []);
}

function conditionPaths(condition: Condition): string[] {
	if (condition.op === "all" || condition.op === "any") return condition.of.flatMap(conditionPaths);
	if (condition.op === "not") return conditionPaths(condition.of);
	return "path" in condition ? [condition.path] : [];
}

function validateRouting(node: CompiledNode, diagnostics: WorkDiagnostic[]): void {
	if (node.onError.kind === "continue" && node.transitions.kind !== "next") diag(diagnostics, "E-CONTINUE-NOT-UNCONDITIONAL", "onError: continue requires unconditional next.", node.id);
	if (node.transitions.kind !== "conditional") return;
	if (node.verdicts.kind === "open") {
		if (node.transitions.default === undefined) diag(diagnostics, "E-OPEN-VERDICT-NO-DEFAULT", "An open verdict set requires default.", node.id);
	} else {
		for (const verdict of node.verdicts.verdicts) if (!(verdict in node.transitions.on) && node.transitions.default === undefined) diag(diagnostics, "E-NON-TOTAL-ROUTING", `Verdict ${verdict} is not routed.`, node.id);
		for (const verdict of Object.keys(node.transitions.on)) if (!node.verdicts.verdicts.includes(verdict)) diag(diagnostics, "W-UNREACHABLE-VERDICT", `Verdict ${verdict} cannot be produced by this node.`, node.id, `on.${verdict}`, "warning");
	}
}

function compileNode(id: string, source: Record<string, unknown>, nodes: Set<string>, templateCatalog: TemplateCatalog | undefined, agentCatalog: AgentCatalog | undefined, diagnostics: WorkDiagnostic[]): CompiledNode | undefined {
	const kind = nodeKind(source);
	if (!kind) { diag(diagnostics, "E-NODE-KIND", "A node must declare exactly one node kind.", id); return undefined; }
	const allowed = new Set(["output", "writeMode", "storage", "contract", "reads", "tools", "join", "limit", "onLimit", "retry", "onError", "timeoutMs", "next", "on", "when", "default", ...nodeKinds, "args", "thinking", "sentinel", "task", "cwd", "worktree", "escalation", "command", "env", "human", "kind", "options", "set"]);
	for (const key of sourceKeys(source)) if (!allowed.has(key) && key !== "prompt") diag(diagnostics, "E-SOURCE-SHAPE", `Unknown node field ${key}.`, id, key);
	if (kind === "template" && "prompt" in source) diag(diagnostics, "E-INLINE-PROMPT", "Template nodes reference a template and cannot carry an inline prompt.", id, "prompt");
	validateCommon(source, kind, diagnostics, id);
	const contractResult = source.contract === undefined ? {} : validateContractShape(source.contract, diagnostics, id, "contract");
	if (kind === "template" && (typeof source.template !== "string" || source.template.length === 0)) diag(diagnostics, "E-SOURCE-SHAPE", "Template nodes require a template name.", id, "template");
	if (kind === "agent" && (typeof source.agent !== "string" || source.agent.length === 0)) diag(diagnostics, "E-SOURCE-SHAPE", "Agent nodes require an agent name.", id, "agent");
	if (kind === "human") {
		if (typeof source.human !== "string") diag(diagnostics, "E-SOURCE-SHAPE", "Human nodes require a question.", id, "human");
		if (source.kind !== "confirm" && source.kind !== "choice" && source.kind !== "text") diag(diagnostics, "E-SOURCE-SHAPE", "Human kind must be confirm, choice, or text.", id, "kind");
		if (source.kind === "choice") {
			if (!Array.isArray(source.options) || source.options.length < 2 || source.options.some((option) => !isRecord(option) || typeof option.id !== "string" || typeof option.label !== "string") || new Set(source.options.map((option) => isRecord(option) ? option.id : undefined)).size !== source.options.length) diag(diagnostics, "E-CHOICE-OPTIONS", "Choice nodes need at least two unique options.", id, "options");
			else for (const option of source.options) if (typeof option.id === "string" && RESERVED_VERDICTS.has(option.id)) diag(diagnostics, "E-RESERVED-VERDICT", `Reserved verdict ${option.id} cannot be a choice.`, id, "options");
		}
		if (source.kind === "text" && source.output === undefined) diag(diagnostics, "E-TEXT-NODE-NO-OUTPUT", "Text nodes require output.", id, "output");
	}
	if (kind === "command" && (!Array.isArray(source.command) || source.command.length === 0 || !source.command.every((item) => typeof item === "string"))) diag(diagnostics, "E-COMMAND-NOT-VECTOR", "Command must be a non-empty string array.", id, "command");
	if (kind === "set") {
		if (!Array.isArray(source.set) || source.set.length === 0) diag(diagnostics, "E-SOURCE-SHAPE", "Set nodes require state operations.", id, "set");
		else for (const [index, operation] of source.set.entries()) {
			if (!isRecord(operation) || !validatePath(operation.path, diagnostics, id, `set[${index}].path`) || !["set", "unset", "increment"].includes(String(operation.op))) { diag(diagnostics, "E-SOURCE-SHAPE", "Invalid state operation.", id, `set[${index}]`); continue; }
			if (operation.op === "set" && !isJsonValue(operation.value)) diag(diagnostics, "E-SOURCE-SHAPE", "set operations require a JSON value.", id, `set[${index}].value`);
			if (operation.op === "increment" && operation.by !== undefined && (typeof operation.by !== "number" || !Number.isFinite(operation.by))) diag(diagnostics, "E-NUMERIC-RANGE", "increment.by must be numeric.", id, `set[${index}].by`);
		}
	}
	validateSentinel(source, diagnostics, id);
	const templateEntry = kind === "template" && templateCatalog ? templateCatalog.entries[String(source.template)] : undefined;
	if (kind === "template" && templateCatalog && !templateEntry) diag(diagnostics, "E-UNKNOWN-TEMPLATE", `Template ${String(source.template)} is not in the catalog.`, id);
	if (kind === "template" && templateEntry && templateEntry.invocable === false) diag(diagnostics, "E-TEMPLATE-NOT-INVOCABLE", `Template ${String(source.template)} cannot be invoked.`, id);
	if (kind === "template" && !templateCatalog) diag(diagnostics, "W-UNRESOLVED-TEMPLATE-KIND", "No template catalog was supplied.", id, undefined, "warning");
	if (kind === "agent" && typeof source.agent === "string" && source.agent.length > 0 && agentCatalog && !Object.hasOwn(agentCatalog.entries, source.agent)) diag(diagnostics, "E-UNKNOWN-AGENT", `Agent ${source.agent} is not in the catalog.`, id, "agent");
	const args = kind === "template" ? interpolated(source.args, diagnostics, id, "args") : undefined;
	const task = kind === "agent" ? interpolated(source.task, diagnostics, id, "task") : undefined;
	const cwdInterpolated = kind === "agent" ? interpolated(source.cwd, diagnostics, id, "cwd") : undefined;
	const argv = kind === "command" && Array.isArray(source.command) ? source.command.map((arg, index) => interpolated(arg, diagnostics, id, `command[${index}]`)).filter((item): item is Array<{ literal: string } | { path: StatePath }> => item !== undefined) : [];
	const question = kind === "human" ? interpolated(source.human, diagnostics, id, "human") : undefined;
	const reads = Array.isArray(source.reads) ? source.reads.filter((path): path is StatePath => isStatePath(path)) : [];
	for (const path of [...pathsInInterpolated(args), ...pathsInInterpolated(task), ...pathsInInterpolated(cwdInterpolated), ...argv.flatMap(pathsInInterpolated), ...pathsInInterpolated(question)]) if (reads.includes(path)) diag(diagnostics, "W-DUPLICATE-STATE-INJECTION", `State path ${path} is projected more than once.`, id, "reads", "warning");
	if (source.onError !== undefined && source.onError !== "fail" && source.onError !== "continue" && (!isRecord(source.onError) || !destination(source.onError.route))) diag(diagnostics, "E-SOURCE-SHAPE", "onError must be fail, continue, or a route destination.", id, "onError");
	const transitions = compileTransitions(source, nodes, diagnostics, id);
	const deterministic = templateEntry?.deterministic;
	const verdicts = derivedVerdicts(kind, source, contractResult.routable, deterministic);
	const binding: AdapterBinding = kind === "template" ? { kind, command: String(source.template), ...(args ? { args } : {}), ...(typeof source.thinking === "string" ? { thinking: source.thinking } : {}), ...(deterministic !== undefined ? { deterministic } : {}), ...(isRecord(source.sentinel) && typeof source.sentinel.pattern === "string" && isRecord(source.sentinel.verdicts) ? { sentinel: { pattern: source.sentinel.pattern, ...(typeof source.sentinel.flags === "string" ? { flags: source.sentinel.flags } : {}), verdicts: Object.fromEntries(Object.entries(source.sentinel.verdicts).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } } : {}) } : kind === "agent" ? { kind, agent: String(source.agent), ...(task ? { task } : {}), ...(typeof source.thinking === "string" ? { thinking: source.thinking } : {}), ...(cwdInterpolated ? { cwd: cwdInterpolated } : {}), worktree: source.worktree === true, escalation: source.escalation === "local" ? "local" : "off" } : kind === "command" ? { kind, argv, ...(typeof source.cwd === "string" ? { cwd: source.cwd } : {}), ...(isRecord(source.env) ? { env: Object.fromEntries(Object.entries(source.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}) } : kind === "human" ? { kind, question: question ?? [], form: source.kind === "choice" && Array.isArray(source.options) ? { kind: "choice", options: source.options.filter(isRecord).filter((option): option is { id: string; label: string } => typeof option.id === "string" && typeof option.label === "string") } : { kind: source.kind === "text" ? "text" : "confirm" } } : { kind, ops: Array.isArray(source.set) ? source.set.filter(isRecord).map((op) => ({ path: String(op.path), op: op.op as "set" | "unset" | "increment", ...(op.value !== undefined ? { value: op.value as never } : {}), ...(typeof op.by === "number" ? { by: op.by } : {}) })) : [] };
	const node: CompiledNode = { id, kind, binding, ...(isStatePath(source.output) ? { output: source.output } : {}), writeMode: source.writeMode === "overwrite" || source.writeMode === "unset" ? source.writeMode : "reduce", storage: source.storage === "artifact" ? "artifact" : "state", ...(contractResult.schema ? { contract: contractResult.schema } : {}), reads, ...(isRecord(source.tools) && Array.isArray(source.tools.allow) ? { tools: { allow: source.tools.allow.filter((item): item is string => typeof item === "string") } } : {}), ...(source.join === undefined ? {} : { join: source.join as JoinMode }), transitions, verdicts, ...(isIntegerAtLeast(source.limit) && destination(source.onLimit) ? { limit: { max: source.limit, onLimit: source.onLimit } } : {}), retry: { attempts: isRecord(source.retry) && isIntegerAtLeast(source.retry.attempts) ? source.retry.attempts : 1, backoffMs: isRecord(source.retry) && isNonNegativeInteger(source.retry.backoffMs) ? source.retry.backoffMs : 500, multiplier: isRecord(source.retry) && typeof source.retry.multiplier === "number" && source.retry.multiplier >= 1 ? source.retry.multiplier : 2 }, onError: source.onError === "continue" ? { kind: "continue" } : isRecord(source.onError) && destination(source.onError.route) ? { kind: "route", to: source.onError.route } : { kind: "fail" }, timeoutMs: kind === "human" ? null : isNonNegativeInteger(source.timeoutMs) ? source.timeoutMs : defaultTimeout[kind] };
	validateRouting(node, diagnostics);
	return node;
}

export function compile(input: import("../model.js").CompileInput): CompileResult {
	const diagnostics: WorkDiagnostic[] = [];
	if (!isRecord(input.document)) { diag(diagnostics, "E-SOURCE-SHAPE", "Graph frontmatter must be a mapping."); return { diagnostics }; }
	const source = input.document as Record<string, unknown>;
	if (!isIntegerAtLeast(source.budget)) diag(diagnostics, "E-NO-BUDGET", "Graph budget must be an integer of at least 1.", undefined, "budget");
	if (typeof source.description !== "undefined" && typeof source.description !== "string") diag(diagnostics, "E-SOURCE-SHAPE", "description must be a string.", undefined, "description");
	const mode = source.mode === "orchestrated" ? "orchestrated" : "session";
	if (source.mode !== undefined && source.mode !== "session" && source.mode !== "orchestrated") diag(diagnostics, "E-SOURCE-SHAPE", "mode must be session or orchestrated.", undefined, "mode");
	const collapse = source.collapse === "on-back-edge" ? "on-back-edge" : "off";
	if (source.collapse !== undefined && source.collapse !== "off" && source.collapse !== "on-back-edge") diag(diagnostics, "E-SOURCE-SHAPE", "collapse must be off or on-back-edge.", undefined, "collapse");
	const name = graphName(input.origin.path);
	if (!graphNamePattern.test(name)) diag(diagnostics, "E-SOURCE-SHAPE", `Graph name ${name} is not a valid identifier.`, undefined, "origin.path");
	let body: GraphSourceBody | undefined;
	let authoredForm: "long" | "shorthand" = "long";
	if (typeof source.graph === "string") {
		authoredForm = "shorthand";
		const parsed = parseShorthand(source.graph);
		for (const item of parsed.diagnostics) diag(diagnostics, item.code, item.message, undefined, item.path);
		body = parsed.body;
	} else if (isRecord(source.graph)) body = source.graph as unknown as GraphSourceBody;
	else diag(diagnostics, "E-SOURCE-SHAPE", "graph must be a long-form mapping or shorthand string.", undefined, "graph");
	if (!body || typeof body.entry !== "string" || !isRecord(body.nodes)) { if (body) diag(diagnostics, "E-SOURCE-SHAPE", "graph requires entry and nodes.", undefined, "graph"); return { diagnostics }; }
	const nodes = new Set(Object.keys(body.nodes));
	if (!isIdentifier(body.entry)) diag(diagnostics, "E-SOURCE-SHAPE", "entry must be a node identifier.", undefined, "graph.entry");
	else if (!nodes.has(body.entry)) diag(diagnostics, "E-UNKNOWN-NODE", `Entry node ${body.entry} does not exist.`, undefined, "graph.entry");
	const compiledNodes: Record<string, CompiledNode> = {};
	for (const [id, raw] of Object.entries(body.nodes)) {
		if (!isIdentifier(id)) diag(diagnostics, "E-SOURCE-SHAPE", `Invalid node id ${id}.`, id, "graph.nodes");
		if (terminal.has(id)) diag(diagnostics, "E-RESERVED-NODE-ID", `Node id ${id} is reserved.`, id, "graph.nodes");
		if (!isRecord(raw)) { diag(diagnostics, "E-SOURCE-SHAPE", "Node must be a mapping.", id, `graph.nodes.${id}`); continue; }
		const node = compileNode(id, raw, nodes, input.templates, input.agents, diagnostics); if (node) compiledNodes[id] = node;
	}
	for (const [id, node] of Object.entries(compiledNodes)) {
		for (const target of [...targetsFor(node), ...(node.limit ? [node.limit.onLimit] : []), ...(node.onError.kind === "route" ? [node.onError.to] : [])]) if (!terminal.has(target) && !nodes.has(target)) diag(diagnostics, "E-UNKNOWN-NODE", `Destination ${target} does not exist.`, id);
	}
	// "Routing MUST NOT read `preview`" is a rule the compiler can keep, because it
	// knows which paths hold an `ArtifactRef`. A preview is truncated for display,
	// so a condition over one routes on where the body happened to be cut (D-058).
	const previewPaths = new Set(artifactPreviewPaths(compiledNodes));
	if (previewPaths.size) {
		for (const [id, node] of Object.entries(compiledNodes)) {
			for (const [index, clause] of node.transitions.when.entries()) {
				for (const path of conditionPaths(clause.condition)) if (previewPaths.has(path)) diag(diagnostics, "E-ROUTING-ON-ARTIFACT-PREVIEW", `Condition reads ${path}, which is an artifact preview truncated for display. Route on a value the node puts in state instead.`, id, `when[${index}].if`);
			}
		}
	}
	const reachable = reachableNodes(body.entry, compiledNodes);
	for (const id of Object.keys(compiledNodes)) if (!reachable.has(id)) diag(diagnostics, "E-UNREACHABLE-NODE", `Node ${id} cannot be reached from entry.`, id);
	const terminalReachable = canReachTerminal(compiledNodes);
	for (const id of Object.keys(compiledNodes)) if (!terminalReachable.has(id)) diag(diagnostics, "E-NO-TERMINAL-PATH", `Node ${id} has no path to a terminal.`, id);
	const cycles = inCycle(compiledNodes);
	for (const [id, node] of Object.entries(compiledNodes)) if (node.transitions.next && node.transitions.next.length > 1) {
		const branches = node.transitions.next.filter((target) => !terminal.has(target)).map((target) => compiledNodes[target]).filter((branch): branch is CompiledNode => branch !== undefined);
		const branchWrites = branches.map(writes);
		for (let left = 0; left < branchWrites.length; left++) for (let right = left + 1; right < branchWrites.length; right++) for (const a of branchWrites[left]) for (const b of branchWrites[right]) if (overlapping(a, b)) diag(diagnostics, a === b ? "E-CONFLICTING-PARALLEL-WRITE" : "E-PARENT-CHILD-WRITE", `Parallel branches write overlapping paths ${a} and ${b}.`, id);
		const arrivals = new Map<string, number>();
		for (const branch of branches) for (const target of targetsFor(branch)) arrivals.set(target, (arrivals.get(target) ?? 0) + 1);
		for (const [target, count] of arrivals) if (count > 1 && !compiledNodes[target]?.join) diag(diagnostics, "E-MISSING-JOIN", `Parallel branches converge on ${target}, which must declare join.`, target);
		for (const [target, count] of arrivals) {
			const join = compiledNodes[target]?.join;
			if (join && typeof join === "object" && "quorum" in join && join.quorum > count) diag(diagnostics, "E-QUORUM-UNREACHABLE", `Join quorum ${join.quorum} exceeds its ${count} parallel sources.`, target);
		}
	}
	for (const [id, node] of Object.entries(compiledNodes)) {
		if (node.join !== "all") continue;
		const unsatisfiable = exclusiveJoinSources(id, compiledNodes, cycles, body.entry);
		if (unsatisfiable) diag(diagnostics, "E-EXCLUSIVE-JOIN-SOURCES", `Join ${id} declares all, but its sources ${unsatisfiable.sources.join(" and ")} are alternative outcomes of ${unsatisfiable.chooser}, so only one of them can ever arrive.`, id);
	}
	for (const id of cycles) {
		const node = compiledNodes[id];
		if (node && !writes(node).length && !node.limit) diag(diagnostics, "W-CYCLE-NO-MEASURE", "Cycle has no state measure and is bounded only by the graph budget.", id, undefined, "warning");
		const policyPaths = isRecord(source.statePolicy) && Array.isArray(source.statePolicy.paths) ? source.statePolicy.paths : [];
		for (const path of writes(node)) if (!policyPaths.some((item) => isRecord(item) && item.path === path)) diag(diagnostics, "W-UNBOUNDED-STATE-PATH", `Cycle path ${path} has no size budget.`, id, undefined, "warning");
	}
	const policyEntries = isRecord(source.statePolicy) && Array.isArray(source.statePolicy.paths) ? source.statePolicy.paths : [];
	const limits: Array<{ path: string; maxBytes: number }> = policyEntries.filter(isRecord).flatMap((item) => isStatePath(item.path) && isIntegerAtLeast(item.maxBytes, 1024) ? [{ path: item.path, maxBytes: item.maxBytes }] : []);
	if (source.maxStateBytes !== undefined && !isIntegerAtLeast(source.maxStateBytes, 1024)) diag(diagnostics, "E-NUMERIC-RANGE", "maxStateBytes must be at least 1024.", undefined, "maxStateBytes");
	for (const item of limits) if (item.path.split(".").some((part: string) => UNSAFE_PATH_SEGMENTS.has(part))) diag(diagnostics, "E-UNSAFE-STATE-PATH", "State policy path is unsafe.", undefined, "statePolicy");
	for (const field of ["graphTimeoutMs", "maxPromptBytes"] as const) if (source[field] !== undefined && !isNonNegativeInteger(source[field])) diag(diagnostics, "E-NUMERIC-RANGE", `${field} must be a non-negative integer.`, undefined, field);
	if (source.maxCostUsd !== undefined && (typeof source.maxCostUsd !== "number" || source.maxCostUsd <= 0)) diag(diagnostics, "E-NUMERIC-RANGE", "maxCostUsd must be positive.", undefined, "maxCostUsd");
	const result = isRecord(source.result) && Array.isArray(source.result.paths) ? { paths: source.result.paths.filter((path): path is string => isStatePath(path)), includeState: source.result.includeState === true } : { paths: [], includeState: false };
	const graph: ExecutableGraph = { schemaVersion: 1, name, hash: "", mode, entry: body.entry, nodes: compiledNodes, limits: { budget: isIntegerAtLeast(source.budget) ? source.budget : 1, maxConcurrency: isIntegerAtLeast(source.maxConcurrency) ? source.maxConcurrency : mode === "orchestrated" ? 4 : 1, ...(isNonNegativeInteger(source.graphTimeoutMs) ? { graphTimeoutMs: source.graphTimeoutMs } : {}), ...(typeof source.maxCostUsd === "number" && source.maxCostUsd > 0 ? { maxCostUsd: source.maxCostUsd } : {}), maxStateBytes: isIntegerAtLeast(source.maxStateBytes, 1024) ? source.maxStateBytes : 1048576, ...(isNonNegativeInteger(source.maxPromptBytes) ? { maxPromptBytes: source.maxPromptBytes } : {}) }, collapse, result, statePolicy: { paths: limits }, policy: { requireInteractive: isRecord(source.policy) && source.policy.requireInteractive === true } };
	const { hash: _hash, ...hashInput } = graph;
	graph.hash = sha256(canonical(hashInput));
	const errors = diagnostics.filter((item) => item.severity === "error");
	if (errors.length) return { diagnostics };
	const report: CompileReport = { schemaVersion: 1, graphHash: graph.hash, source: { scope: input.origin.scope, path: input.origin.path, bytes: input.bodyBytes, sha256: input.origin.sha256 }, ...(typeof source.description === "string" ? { description: source.description } : {}), authoredForm, ...(input.templates ? { templatesCapturedAt: input.templates.capturedAt } : {}), derived: { exits: Object.values(compiledNodes).filter((node) => targetsFor(node).some((target) => terminal.has(target))).map((node) => node.id), inCycle: [...cycles], reachable: [...reachable] }, diagnostics };
	return { diagnostics, graph, report };
}

export type { CompileInput, CompileReport, CompileResult, ExecutableGraph } from "../model.js";
