/**
 * The out-of-process strategy protocol, version 1 (pi-context-aware#470, REQ-STRAT-005). docs/strategy-protocol.md
 * is the reference for strategy authors.
 *
 * Per request the bench writes one line, `{"protocol":1,"view":{...}}`, and the strategy answers with one
 * line, `{"plans":[[op, ...], ...]}`. This module builds the request from the view's named fields and turns
 * a reply into plans. A reply is untrusted text: it is parsed, every field is checked, and the plans are
 * built fresh from the named fields, never spread or cast from the parsed object. Any fault refuses the
 * whole reply with one code; the bench counts the code and goes on.
 */

import type { ContextPlan, ContextView, PlanOp, SummaryWriter } from "../../strategy/contract.js";

export const EXTERNAL_PROTOCOL_VERSION = 1 as const;

/** Per-request limits on the strategy's process. */
export interface ExternalLimits {
	/** The process is killed this many milliseconds after it starts, and the request is refused. */
	readonly timeoutMs: number;
	/** The process is killed once it has written more than this many bytes, and the request is refused. */
	readonly maxReplyBytes: number;
}

export const DEFAULT_EXTERNAL_LIMITS: ExternalLimits = Object.freeze({ timeoutMs: 10_000, maxReplyBytes: 1024 * 1024 });

/** Limits on what one reply may hold. A reply over any of them is refused. */
export const REPLY_LIMITS = Object.freeze({
	plans: 16,
	opsPerPlan: 32,
	/** Characters of an entry id or a fold's block id. */
	id: 256,
	topic: 200,
	stubText: 4_000,
	sayText: 8_000,
	/** The fold engine's own maximum (`compress.maxSummaryLength`). */
	summary: 20_000,
});

/** Why the bench refused a reply. Stable: a code does not change when its message is reworded. */
export type ExternalRefusalCode =
	| "external-spawn-failed"
	| "external-timeout"
	| "external-reply-too-large"
	| "external-crash"
	| "external-malformed"
	| "external-extra-field"
	| "external-bad-field"
	| "external-field-too-long"
	| "external-too-many"
	| "external-unknown-id";

export type ExternalReply =
	| { readonly ok: true; readonly plans: readonly ContextPlan[] }
	| { readonly ok: false; readonly code: ExternalRefusalCode; readonly message: string };

/**
 * The request line for one view: the protocol version and the view's named fields, copied. Nothing else
 * reaches the strategy: no session path, file name or setting.
 */
export function requestLine(view: ContextView): string {
	const wire = {
		entries: view.entries.map((entry) => ({
			id: entry.id,
			role: entry.role,
			tokens: entry.tokens,
			hint: entry.hint,
			...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
			...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
			...(entry.toolCallIds === undefined ? {} : { toolCallIds: [...entry.toolCallIds] }),
		})),
		pressure: view.pressure,
		unownedTokens: view.unownedTokens,
		cacheAgeMs: view.cacheAgeMs,
		model: { id: view.model.id, contextWindow: view.model.contextWindow },
		tools: [...view.tools],
		registeredTools: [...view.registeredTools],
		folds: view.folds.map((fold) => ({
			blockId: fold.blockId,
			tier: fold.tier,
			topic: fold.topic,
			carrierId: fold.carrierId,
			hiddenIds: [...fold.hiddenIds],
			startId: fold.startId,
			endId: fold.endId,
			compressedTokens: fold.compressedTokens,
		})),
		hides: view.hides.map((hide) => ({ hideId: hide.hideId, targetId: hide.targetId, originalTokens: hide.originalTokens })),
		protectedEntryIds: [...view.protectedEntryIds],
		compactionOwner: view.compactionOwner,
	};
	return `${JSON.stringify({ protocol: EXTERNAL_PROTOCOL_VERSION, view: wire })}\n`;
}

/** A reply fault: thrown inside `parseReply` and returned as a refusal. Messages name fields by position, never by the reply's own text. */
class Fault extends Error {
	constructor(readonly code: ExternalRefusalCode, message: string) {
		super(message);
	}
}

const WRITERS: ReadonlySet<string> = new Set<SummaryWriter>(["plan", "main", "cheap", "mechanical"]);

/** Keys each operation kind may carry; `kind` included. */
const KEYS: Readonly<Record<PlanOp["kind"], ReadonlySet<string>>> = {
	summarize: new Set(["kind", "startId", "endId", "topic", "writer", "summary"]),
	stub: new Set(["kind", "entryId", "text"]),
	say: new Set(["kind", "text"]),
};

type Fields = Readonly<Record<string, unknown>>;

/** A plain JSON object with no key outside `allowed`. */
function objectAt(value: unknown, where: string, allowed: ReadonlySet<string>): Fields {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Fault("external-bad-field", `${where} is not an object.`);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Fault("external-extra-field", `${where} has a key the protocol does not define.`);
	}
	return value as Fields;
}

function arrayAt(value: unknown, where: string, max: number): readonly unknown[] {
	if (!Array.isArray(value)) throw new Fault("external-bad-field", `${where} is not an array.`);
	if (value.length > max) throw new Fault("external-too-many", `${where} holds ${value.length} items; at most ${max} are allowed.`);
	return value;
}

function stringAt(fields: Fields, key: string, where: string, max: number): string {
	const value = fields[key];
	if (typeof value !== "string") throw new Fault("external-bad-field", `${where}.${key} is not a string.`);
	if (value.length > max) throw new Fault("external-field-too-long", `${where}.${key} has ${value.length} characters; at most ${max} are allowed.`);
	return value;
}

function idAt(fields: Fields, key: string, where: string, known: ReadonlySet<string>): string {
	const id = stringAt(fields, key, where, REPLY_LIMITS.id);
	if (!known.has(id)) throw new Fault("external-unknown-id", `${where}.${key} names an id the view does not hold.`);
	return id;
}

/** One operation, built fresh from its named fields. */
function opAt(value: unknown, where: string, entryIds: ReadonlySet<string>, endIds: ReadonlySet<string>): PlanOp {
	const kind = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields).kind : undefined;
	if (kind !== "summarize" && kind !== "stub" && kind !== "say") throw new Fault("external-bad-field", `${where}.kind is not summarize, stub or say.`);
	const fields = objectAt(value, where, KEYS[kind]);
	if (kind === "say") return { kind: "say", text: stringAt(fields, "text", where, REPLY_LIMITS.sayText) };
	if (kind === "stub") return { kind: "stub", entryId: idAt(fields, "entryId", where, entryIds), text: stringAt(fields, "text", where, REPLY_LIMITS.stubText) };
	const startId = idAt(fields, "startId", where, endIds);
	const endId = idAt(fields, "endId", where, endIds);
	const topic = fields.topic === undefined ? undefined : stringAt(fields, "topic", where, REPLY_LIMITS.topic);
	const writer = fields.writer;
	if (typeof writer !== "string" || !WRITERS.has(writer)) throw new Fault("external-bad-field", `${where}.writer is not plan, main, cheap or mechanical.`);
	const ends = { kind: "summarize" as const, startId, endId, ...(topic === undefined ? {} : { topic }) };
	if (writer === "plan") return { ...ends, writer: "plan", summary: stringAt(fields, "summary", where, REPLY_LIMITS.summary) };
	if (fields.summary !== undefined) throw new Fault("external-bad-field", `${where}.summary is set, but the ${writer} writer writes the summary.`);
	return { ...ends, writer: writer as Exclude<SummaryWriter, "plan"> };
}

/**
 * Turn the strategy's standard output into plans for `view`. It must be exactly one line of JSON (a final
 * line break is optional) holding `plans` and nothing else; see docs/strategy-protocol.md for every field.
 * A `stub` may name only entries of the view, a `summarize` entries or active folds' block ids.
 */
export function parseReply(text: string, view: ContextView): ExternalReply {
	try {
		const line = text.endsWith("\n") ? text.slice(0, -1) : text;
		if (line.trim().length === 0) throw new Fault("external-malformed", "The strategy wrote no reply.");
		if (line.includes("\n")) throw new Fault("external-malformed", "The reply is more than one line.");
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Fault("external-malformed", "The reply is not JSON.");
		}
		const top = objectAt(parsed, "reply", new Set(["plans"]));
		const entryIds = new Set(view.entries.map((entry) => entry.id));
		const endIds = new Set([...entryIds, ...view.folds.map((fold) => fold.blockId)]);
		const plans = arrayAt(top.plans, "reply.plans", REPLY_LIMITS.plans).map((plan, p) =>
			arrayAt(plan, `plans[${p}]`, REPLY_LIMITS.opsPerPlan).map((op, o) => opAt(op, `plans[${p}][${o}]`, entryIds, endIds)));
		return { ok: true, plans };
	} catch (error) {
		if (error instanceof Fault) return { ok: false, code: error.code, message: error.message };
		throw error;
	}
}
