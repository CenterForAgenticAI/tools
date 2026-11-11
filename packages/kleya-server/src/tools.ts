// @centerforagenticai/kleya-server/tools: product API tools (K4). A product declares its HTTP operations once, with
// the origin they live at; each becomes a pi-durable tool that sends the turn's product credential to that origin and
// nowhere else (G-CRED-DEST), builds its request from named fields only (K4-I2), fills bound scope keys from the
// conversation's context and never from the model (K3, K4-I6), and stores nothing that holds the credential.
//
// Loads pi-durable when imported (MIN-19): productTools() returns an Extension whose guard hook needs pi-durable's
// ToolTask at definition time, and a product imports this module only to build the registry it hands the host, which
// loads pi-durable anyway.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask, type Extension, type JsonObject, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { ContextDocument } from "./context.ts";
import { checkScopeKey } from "./scope-keys.ts";
import { turnCredential } from "./host/core.ts";
import { effectTool, type EffectCall } from "./host/effect.ts";
import { named } from "./tools/names.ts";

type JsonValue = JsonObject[string];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** One operation of a product API, as the model sees it and as the host sends it. */
export type HttpTool = {
	readonly name: string;
	readonly description: string;
	/** What the model may send: an object schema with `additionalProperties: false`. It may name no bound key, at any depth. */
	readonly parameters: JsonObject;
	readonly method: HttpMethod;
	/** Below the API's origin, such as `/tenants/{tenant}/notes/{note}`. Each placeholder is a parameter or a bound key. */
	readonly path: string;
	/** Scope keys the host fills from the conversation's context; a call fails, sending nothing, when one is missing. */
	readonly bound?: readonly string[];
	/** What a crash mid-call does (spec 5.4). Default: `read-only` for GET, `once-only` otherwise. */
	readonly effect?: "read-only" | "idempotent-by-key" | "once-only";
};

export type ProductApi = {
	/** The extension's name. */
	readonly name: string;
	/** A bare origin, such as `https://api.example.com`: https, or http on a loopback host. Credentials go nowhere else. */
	readonly origin: string;
	readonly tools: readonly HttpTool[];
	/** Sends a request; default `fetch`. */
	readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
	/** Per request; default 20 s. */
	readonly timeoutMs?: number;
};

/** Bytes of a response body the host reads; a longer body is an error result, never a partial one. */
const MAX_RESPONSE_BYTES = 1_048_576;
/** Characters of a failed response's body that the model sees. */
const ERROR_BODY_CHARS = 2_000;
const REDACTED = "[redacted]";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The first argument key, at any depth, that names a bound key. */
function namingKey(value: unknown, bound: readonly string[]): { key: string; bound: string } | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = namingKey(item, bound);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	for (const [key, inner] of Object.entries(value)) {
		const b = named(key, bound);
		if (b !== undefined) return { key, bound: b };
		const found = namingKey(inner, bound);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Every property name a schema declares, at any depth. */
function declared(schema: unknown, out: string[] = []): string[] {
	if (Array.isArray(schema)) for (const s of schema) declared(s, out);
	else if (schema !== null && typeof schema === "object") {
		for (const [key, inner] of Object.entries(schema)) {
			if (key === "properties" && inner !== null && typeof inner === "object") out.push(...Object.keys(inner));
			declared(inner, out);
		}
	}
	return out;
}

// --- Definition-time checks ---

function checkOrigin(origin: string): URL {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`productTools: origin ${JSON.stringify(origin)} is not a URL`);
	}
	// A bare origin only: with userinfo, a path, a query or a fragment, the string is not what URL calls its origin.
	if (url.origin !== origin) throw new Error(`productTools: origin ${JSON.stringify(origin)} must be a bare origin`);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error(`productTools: origin ${JSON.stringify(origin)} must be https, or http on a loopback host`);
	return url;
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Whether `schema` uses the keyword `name` anywhere. */
function uses(schema: unknown, name: string): boolean {
	if (Array.isArray(schema)) return schema.some((s) => uses(s, name));
	if (schema === null || typeof schema !== "object") return false;
	return Object.entries(schema).some(([key, inner]) => key === name || uses(inner, name));
}

function checkTool(tool: HttpTool): void {
	const what = `productTools: tool ${JSON.stringify(tool.name)}`;
	if (!METHODS.includes(tool.method)) throw new Error(`${what}: method ${JSON.stringify(tool.method)} is not one of ${METHODS.join(", ")}`);
	const schema = tool.parameters as { type?: unknown; properties?: unknown; additionalProperties?: unknown };
	if (schema.type !== "object" || schema.additionalProperties !== false) throw new Error(`${what}: parameters must be an object schema with additionalProperties false`);
	// Named fields only (K4-I2): a pattern lets the model choose key names.
	if (uses(tool.parameters, "patternProperties")) throw new Error(`${what}: parameters may not use patternProperties`);
	const bound = tool.bound ?? [];
	const names = declared(tool.parameters);
	// A field named __proto__ would set the request body's prototype instead of a field, and be dropped unseen.
	if (names.includes("__proto__") || bound.includes("__proto__")) throw new Error(`${what}: no parameter or bound key may be named __proto__`);
	for (const key of bound) checkScopeKey(key, what);
	// The model never supplies a bound value: a schema that lets it name one is refused.
	for (const name of names) {
		const b = named(name, bound);
		if (b !== undefined) throw new Error(`${what}: parameter ${JSON.stringify(name)} names the bound key ${JSON.stringify(b)}`);
	}
	const top = Object.keys((schema.properties ?? {}) as object);
	for (const [, name] of tool.path.matchAll(PLACEHOLDER)) {
		if (!top.includes(name!) && !bound.includes(name!)) throw new Error(`${what}: path placeholder {${name}} is neither a parameter nor a bound key`);
	}
	// The path must survive URL parsing unchanged, below the origin. Parsing drops tab, CR and LF, turns \ into /,
	// resolves . and .., and splits off ? and #: "/\t/evil.example/x" would resolve to another host. Placeholder values
	// are percent-encoded, and . and .. are refused, so they cannot change the parsed path.
	const probe = tool.path.replace(PLACEHOLDER, "x");
	const parsed = new URL(probe, "https://kleya.invalid");
	if (!probe.startsWith("/") || parsed.origin !== "https://kleya.invalid" || parsed.pathname !== probe) throw new Error(`${what}: path must start with one / and survive URL parsing unchanged`);
	// A placeholder is a whole segment. Next to other text a value could complete a dot segment: "%{a}" with "2e",
	// ".{a}" with ".", or "{a}{b}" with "." and ".".
	for (const m of tool.path.matchAll(PLACEHOLDER)) {
		const end = m.index! + m[0].length;
		if (tool.path[m.index! - 1] !== "/" || (end < tool.path.length && tool.path[end] !== "/")) throw new Error(`${what}: path placeholder {${m[1]}} must be a whole path segment`);
	}
}

// --- Calls ---

type Result = { output: { type: "text"; text: string }[]; isError?: true };
const text = (t: string): Result => ({ output: [{ type: "text", text: t }] });
const failure = (t: string): Result => ({ output: [{ type: "text", text: t }], isError: true });

/** `t` with every copy of the credential replaced: as sent, and as a JSON string escapes it (with or without `\/`). */
function redact(t: string, credential: string): string {
	const escaped = JSON.stringify(credential).slice(1, -1);
	const forms = [...new Set([credential, escaped, escaped.replaceAll("/", "\\/")])].sort((a, b) => b.length - a.length);
	for (const form of forms) if (form !== "") t = t.split(form).join(REDACTED);
	return t;
}

/** A path value: a string or finite number, percent-encoded, never `.`, `..` or empty. */
function segment(value: unknown): string | undefined {
	if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return undefined;
	const s = String(value);
	return s === "" || s === "." || s === ".." ? undefined : encodeURIComponent(s);
}

/** The whole body as text, or undefined once it passes the limit; then the read stops. */
async function readBounded(response: Response): Promise<string | undefined> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function send(api: ProductApi, origin: URL, tool: HttpTool, args: JsonObject, call: EffectCall, context: Context): Promise<Result> {
	const bound: Record<string, string> = {};
	if ((tool.bound ?? []).length > 0) {
		const scope = (await call.api.snapshot(ContextDocument, call.api.conversationId, context))?.scope ?? {};
		for (const key of tool.bound ?? []) {
			const value = Object.hasOwn(scope, key) ? scope[key] : undefined;
			if (value === undefined) return failure(`${tool.name} failed: this conversation has no ${key} in its context`);
			bound[key] = value;
		}
	}
	let turn;
	try {
		turn = await turnCredential(call.api as ToolExecutionApi, context);
	} catch {
		turn = undefined;
	}
	if (turn === undefined) return failure(`${tool.name} failed: this turn has no product credential`);
	const credential = turn.credential;

	// Named fields only (K4-I2): the path's placeholders, then each declared parameter and bound key not in the path.
	const used = new Set<string>();
	let path = "";
	let last = 0;
	for (const m of tool.path.matchAll(PLACEHOLDER)) {
		const name = m[1]!;
		const value = segment(Object.hasOwn(bound, name) ? bound[name] : Object.hasOwn(args, name) ? args[name] : undefined);
		if (value === undefined) return failure(`${tool.name} failed: ${name} is not a usable path value`);
		path += tool.path.slice(last, m.index) + value;
		last = m.index! + m[0].length;
		used.add(name);
	}
	path += tool.path.slice(last);
	const url = new URL(path, origin);
	const fields: Record<string, JsonValue> = {};
	for (const name of Object.keys((tool.parameters.properties ?? {}) as object)) {
		if (!used.has(name) && Object.hasOwn(args, name) && args[name] !== undefined) fields[name] = args[name]!;
	}
	for (const [key, value] of Object.entries(bound)) if (!used.has(key)) fields[key] = value;

	const headers = new Headers({ authorization: `Bearer ${credential}`, accept: "application/json" });
	let body: string | undefined;
	if (tool.method === "GET") {
		for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
	} else {
		headers.set("content-type", "application/json");
		headers.set("idempotency-key", call.key);
		body = JSON.stringify(fields);
	}
	const timeout = AbortSignal.timeout(api.timeoutMs ?? 20_000);
	const signal = context.abortSignal === undefined ? timeout : AbortSignal.any([context.abortSignal, timeout]);
	let response: Response;
	try {
		response = await (api.fetch ?? fetch)(url, { method: tool.method, headers, redirect: "error", signal, ...(body === undefined ? {} : { body }) });
	} catch (error) {
		if (context.abortSignal?.aborted) throw error;
		return failure(redact(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`, credential));
	}
	let answer: string | undefined;
	try {
		answer = await readBounded(response);
	} catch (error) {
		if (context.abortSignal?.aborted) throw error;
		return failure(`${tool.name} failed: its response could not be read`);
	}
	if (answer === undefined) return failure(`${tool.name} failed: response too large`);
	// Redact before cutting, so a cut never leaves part of the credential.
	if (response.status < 200 || response.status > 299) return failure(`${tool.name} failed with status ${response.status}: ${redact(answer, credential).slice(0, ERROR_BODY_CHARS)}`);
	return text(redact(answer, credential));
}

/**
 * The product API's tools, and a guard for every tool call in the conversations that select them: a call whose
 * arguments name a bound key at any depth, whatever tool it calls, is blocked before it runs. The bound keys are the
 * conversation's context keys and every key these tools bind. Throws when a tool or the origin breaks a rule above.
 */
export function productTools(api: ProductApi): Extension {
	const origin = checkOrigin(api.origin);
	const seen = new Set<string>();
	for (const tool of api.tools) {
		checkTool(tool);
		if (seen.has(tool.name)) throw new Error(`productTools: tool ${JSON.stringify(tool.name)} is declared twice`);
		seen.add(tool.name);
	}
	const boundKeys = [...new Set(api.tools.flatMap((t) => t.bound ?? []))];
	const tools = api.tools.map((tool) =>
		effectTool({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			effect: tool.effect ?? (tool.method === "GET" ? "read-only" : "once-only"),
			execute: (args, call, context) => send(api, origin, tool, args, call, context),
		}),
	);
	return defineExtension({
		name: api.name,
		tools,
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, hookApi, context) => {
					const scope = (await hookApi.snapshot(ContextDocument, hookApi.conversationId, context))?.scope ?? {};
					const found = namingKey(call.arguments, [...Object.keys(scope), ...boundKeys]);
					// The block names the key, never its value.
					return found === undefined ? undefined : { block: `argument ${JSON.stringify(found.key.slice(0, 64))} names the bound key ${JSON.stringify(found.bound)}, which only the host sets` };
				},
			}),
		],
	});
}
