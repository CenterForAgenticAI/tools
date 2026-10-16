import * as path from "node:path";
import {
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

// A stand-in for the Fabric side of `pi-fabric:compaction-owner:v1`. It never imports
// Fabric. Each behaviour a test relies on follows pi-fabric commit b67da914; the comment
// above each part names the source file and function it follows.

export const OWNER_EVENT = "pi-fabric:compaction-owner:v1";
// src/protocol.ts: FABRIC_COMPACTION_OWNER_REQUEST_FIELDS, FABRIC_COMPACTION_OWNER_CARRY_FIELDS,
// and the action names in readOwnerActions.
export const REQUEST_FIELDS = ["reason", "instructions", "preserve", "requestedBy", "seed"] as const;
export const CARRY_FIELDS = ["items", "add", "remove", "clear"] as const;
export const ACTION_NAMES = ["request", "status", "pressure", "carry", "cancel"] as const;

// src/compaction/instructions.ts and src/core/compact-controller.ts: the request limits.
export const MAX_COMPACTION_INSTRUCTIONS_CHARS = 8 * 1024;
export const MAX_PRESERVE_ITEMS = 16;
export const MAX_PRESERVE_ITEM_CHARS = 2 * 1024;
export const MAX_TYPED_COMPACTION_SOURCE_BYTES = 16 * 1024;
export const MAX_COMPACTION_SEED_CHARS = 8192;
// src/compaction/carry.ts: MAX_CARRY_ITEMS and MAX_CARRY_ITEM_CHARS.
export const MAX_CARRY_ITEMS = MAX_PRESERVE_ITEMS;
export const MAX_CARRY_ITEM_CHARS = MAX_PRESERVE_ITEM_CHARS;
// src/providers/compact-provider.ts: MAX_OWNER_RESULT_BYTES.
export const MAX_OWNER_RESULT_BYTES = 16 * 1024;

type Json = Record<string, unknown>;
type Handler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;

const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// src/protocol.ts: COMPACTION_OWNER_TEXT and ownerText.
// eslint-disable-next-line no-control-regex -- Fabric's own expression, copied as written.
const COMPACTION_OWNER_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
function ownerText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && COMPACTION_OWNER_TEXT.test(value);
}

// src/protocol.ts: unknownKey.
const unknownKey = (record: Json, known: readonly string[]): string | undefined =>
	Object.keys(record).find((key) => !known.includes(key));

// src/protocol.ts: readOwnerFields.
function readOwnerFields(value: unknown, known: readonly string[], action: string): string[] | string {
	if (!Array.isArray(value) || value.length > known.length * 2) return `actions.${action}.fields must be an array of ${known.join(", ")}`;
	const fields: string[] = [];
	for (const field of value) {
		if (typeof field !== "string" || !known.includes(field)) return `actions.${action}.fields has an unknown field: ${String(field).slice(0, 64)}`;
		if (!fields.includes(field)) fields.push(field);
	}
	return fields;
}

type OwnerAction = { fields?: readonly string[]; handler: (...args: never[]) => unknown };

// src/protocol.ts: readOwnerActions. Each field is read once into a fresh copy.
function readOwnerActions(value: unknown): Record<string, OwnerAction> | string {
	if (!isRecord(value)) return "actions must be an object";
	const unknown = unknownKey(value, ACTION_NAMES);
	if (unknown !== undefined) return `actions has an unknown action: ${unknown.slice(0, 64)}`;
	const actions: Record<string, OwnerAction> = {};
	for (const name of ACTION_NAMES) {
		const entry = value[name];
		if (entry === undefined) continue;
		const handler = isRecord(entry) ? entry.handler : undefined;
		if (!isRecord(entry) || typeof handler !== "function") return `actions.${name} must be an object with a handler function`;
		const extra = unknownKey(entry, name === "request" || name === "carry" ? ["fields", "handler"] : ["handler"]);
		if (extra !== undefined) return `actions.${name} has an unknown key: ${extra.slice(0, 64)}`;
		if (name === "request" || name === "carry") {
			const fields = readOwnerFields(entry.fields, name === "request" ? REQUEST_FIELDS : CARRY_FIELDS, name);
			if (typeof fields === "string") return fields;
			actions[name] = { fields, handler: handler as OwnerAction["handler"] };
		} else {
			actions[name] = { handler: handler as OwnerAction["handler"] };
		}
	}
	return actions;
}

// src/protocol.ts: isAbortSignalLike.
const isAbortSignalLike = (value: unknown): value is AbortSignal =>
	typeof value === "object" && value !== null
	&& typeof (value as { aborted?: unknown }).aborted === "boolean"
	&& typeof (value as { addEventListener?: unknown }).addEventListener === "function"
	&& typeof (value as { removeEventListener?: unknown }).removeEventListener === "function";

interface ReadClaim {
	owner: { name: string; version: string };
	actions: Record<string, OwnerAction>;
	branchSummary: boolean;
	signal: AbortSignal | undefined;
	reply: (result: unknown) => void;
}

/** src/protocol.ts readFabricCompactionOwnerMessageV1, claim branch: an error text, or the fresh copy. */
export function readClaim(value: unknown): { ok: true; claim: ReadClaim } | { ok: false; error: string; reply?: (r: unknown) => void } {
	if (!isRecord(value)) return { ok: false, error: "message must be an object" };
	const rawReply = value.reply;
	const reply = typeof rawReply === "function" ? rawReply as (r: unknown) => void : undefined;
	const fail = (error: string) => ({ ok: false as const, error, ...(reply ? { reply } : {}) });
	if (value.version !== 1) return fail("version must be 1");
	if (value.type !== "claim") return fail('type must be "claim" or "withdraw"');
	const extra = unknownKey(value, ["version", "type", "owner", "actions", "branchSummary", "signal", "reply"]);
	if (extra !== undefined) return fail(`claim has an unknown key: ${extra.slice(0, 64)}`);
	if (!reply) return fail("reply must be a function");
	const owner = value.owner;
	const name = isRecord(owner) ? owner.name : undefined;
	const version = isRecord(owner) ? owner.version : undefined;
	if (!ownerText(name, 128) || !ownerText(version, 64)) return fail("owner must be { name, version } with non-empty printable text");
	const actions = readOwnerActions(value.actions);
	if (typeof actions === "string") return fail(actions);
	const branchSummary = value.branchSummary;
	if (branchSummary !== undefined && typeof branchSummary !== "boolean") return fail("branchSummary must be a boolean");
	const signal = value.signal;
	if (signal !== undefined && !isAbortSignalLike(signal)) return fail("signal must be an AbortSignal");
	return { ok: true, claim: { owner: { name, version }, actions, branchSummary: branchSummary === true, signal, reply } };
}

/** The reader's verdict on a claim message: an error text, or undefined when it is valid. */
export function claimShapeError(value: unknown): string | undefined {
	const read = readClaim(value);
	return read.ok ? undefined : read.error;
}

// src/compaction/instructions.ts: hasPairedSurrogates.
function hasPairedSurrogates(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const codePoints = (text: string): number => [...text].length;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * src/providers/compact-provider.ts checkedRequestArguments: requestSchema (no other keys;
 * reason 1024, instructions 8192, preserve 16 x 2048, requestedBy 256, seed 1-8192), then
 * compactionRequestBoundsError, checkedSeed and encodeCompactionRequest.
 */
export function checkedRequestArguments(args: Json): Json {
	const fail = (message: string): never => { throw new Error(`Invalid compact.request arguments: ${message}`); };
	const extra = unknownKey(args, REQUEST_FIELDS);
	if (extra !== undefined) fail(`/${extra}: must not have additional properties`);
	for (const [field, max] of [["reason", 1024], ["instructions", MAX_COMPACTION_INSTRUCTIONS_CHARS], ["requestedBy", 256], ["seed", MAX_COMPACTION_SEED_CHARS]] as const) {
		const value = args[field];
		if (value === undefined) continue;
		if (typeof value !== "string") fail(`/${field}: must be string`);
		if (codePoints(value as string) > max) fail(`/${field}: must not have more than ${max} characters`);
	}
	if (args.seed !== undefined && codePoints(args.seed as string) < 1) fail("/seed: must not have fewer than 1 characters");
	const preserve = args.preserve;
	if (preserve !== undefined) {
		if (!isStringArray(preserve)) fail("/preserve: must be array of string");
		if ((preserve as string[]).length > MAX_PRESERVE_ITEMS) fail(`/preserve: must not have more than ${MAX_PRESERVE_ITEMS} items`);
	}
	const instructions = args.instructions as string | undefined;
	if (instructions !== undefined) {
		if (!hasPairedSurrogates(instructions)) fail("typed compaction instructions contain an unpaired UTF-16 surrogate");
		if (instructions.length > MAX_COMPACTION_INSTRUCTIONS_CHARS || utf8Bytes(instructions) > MAX_COMPACTION_INSTRUCTIONS_CHARS) {
			fail(`typed compaction instructions exceed ${MAX_COMPACTION_INSTRUCTIONS_CHARS} characters or ${MAX_COMPACTION_INSTRUCTIONS_CHARS} UTF-8 bytes`);
		}
	}
	for (const item of (preserve as string[] | undefined) ?? []) {
		if (!hasPairedSurrogates(item)) fail("typed compaction preserve item contains an unpaired UTF-16 surrogate");
		if (item.length > MAX_PRESERVE_ITEM_CHARS || utf8Bytes(item) > MAX_PRESERVE_ITEM_CHARS) {
			fail(`typed compaction preserve item exceeds ${MAX_PRESERVE_ITEM_CHARS} characters or ${MAX_PRESERVE_ITEM_CHARS} UTF-8 bytes`);
		}
	}
	const seed = args.seed as string | undefined;
	if (seed !== undefined && (seed.trim() === "" || seed.length > MAX_COMPACTION_SEED_CHARS)) {
		fail(`compact seed must be a non-empty string of at most ${MAX_COMPACTION_SEED_CHARS} characters`);
	}
	if (preserve !== undefined) {
		const encoded = `__pi_fabric_compact_request_v1__:${JSON.stringify({ version: 1, ...(instructions === undefined ? {} : { instructions }), preserve })}`;
		if (utf8Bytes(encoded) > MAX_TYPED_COMPACTION_SOURCE_BYTES) {
			throw new Error(`typed compaction request exceeds ${MAX_TYPED_COMPACTION_SOURCE_BYTES} encoded UTF-8 bytes`);
		}
	}
	return args;
}

/** src/providers/compact-provider.ts checkedCarryArguments: carrySchema (no other keys; lists of 16 x 1-2048; clear boolean). */
export function checkedCarryArguments(args: Json): Json {
	const fail = (message: string): never => { throw new Error(`Invalid compact.carry arguments: ${message}`); };
	const extra = unknownKey(args, CARRY_FIELDS);
	if (extra !== undefined) fail(`/${extra}: must not have additional properties`);
	for (const field of ["items", "add", "remove"] as const) {
		const value = args[field];
		if (value === undefined) continue;
		if (!isStringArray(value)) fail(`/${field}: must be array of string`);
		const list = value as string[];
		if (list.length > MAX_CARRY_ITEMS) fail(`/${field}: must not have more than ${MAX_CARRY_ITEMS} items`);
		for (const item of list) {
			if (codePoints(item) < 1) fail(`/${field}: must not have fewer than 1 characters`);
			if (codePoints(item) > MAX_CARRY_ITEM_CHARS) fail(`/${field}: must not have more than ${MAX_CARRY_ITEM_CHARS} characters`);
		}
	}
	if (args.clear !== undefined && typeof args.clear !== "boolean") fail("/clear: must be boolean");
	return args;
}

// src/protocol.ts: FABRIC_COMPACTION_OWNER_HANDLER_TIMEOUT_MS.
export const OWNER_HANDLER_TIMEOUT_MS = 30_000;
// src/config.ts DEFAULT_FABRIC_CONFIG.compaction: pressureBands and outputReserveTokens.
const PRESSURE_BANDS = { warn: 0.6, urgent: 0.8 };
const DEFAULT_OUTPUT_RESERVE_TOKENS = 0;

/**
 * src/compaction/owner.ts ownerFromContext and compactionOwnerOf, reduced: a compaction entry
 * whose details say `compactor: "fabric"` with version 1 or 2 is Fabric's (the real check also
 * validates the rest of the details), one from a hook is `external`, any other is Pi's.
 */
function ownerFromContext(ctx: ExtensionContext | undefined): string {
	try {
		const branch = ctx?.sessionManager?.getBranch?.() as unknown;
		if (!Array.isArray(branch)) return "none";
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as Json;
			if (entry.type !== "compaction") continue;
			const details = entry.details;
			if (isRecord(details) && details.compactor === "fabric" && (details.version === 1 || details.version === 2)) return "fabric";
			return entry.fromHook === true ? "external" : "pi";
		}
		return "none";
	} catch {
		return "none";
	}
}

/**
 * src/compaction/pressure.ts compactionPressure with Fabric's default configuration and no
 * per-model threshold, which is what #invokeOwner reports under a claim (it drops
 * thresholdFraction and thresholdTokens).
 */
function compactionPressure(ctx: ExtensionContext | undefined): Json {
	let usage: { tokens?: unknown; contextWindow?: unknown } | undefined;
	try {
		usage = ctx?.getContextUsage?.() as typeof usage;
	} catch {
		usage = undefined;
	}
	const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	const contextWindow = positive(usage?.contextWindow) ?? positive((ctx?.model as { contextWindow?: unknown } | undefined)?.contextWindow);
	const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
	const known = tokens !== null && contextWindow !== undefined;
	const fraction = known ? tokens / contextWindow : null;
	const band = fraction === null ? "unknown" : fraction >= PRESSURE_BANDS.urgent ? "urgent" : fraction >= PRESSURE_BANDS.warn ? "warn" : "ok";
	return {
		tokens,
		contextWindow: contextWindow ?? null,
		fraction,
		headroomTokens: known ? contextWindow - tokens : null,
		band,
		outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
		owner: ownerFromContext(ctx),
	};
}

// src/providers/compact-provider.ts: MAX_OWNER_THRESHOLDS, RESERVED_THRESHOLD_NAMES and ownerPressure.
const MAX_OWNER_THRESHOLDS = 16;
const RESERVED_THRESHOLD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
function ownerPressure(label: string, value: unknown): Json {
	const invalid = () => new Error(`compaction owner ${label}: compact.pressure must return { stage, thresholds? }`);
	if (!isRecord(value) || typeof value.stage !== "string" || value.stage.length === 0 || value.stage.length > 64) throw invalid();
	if (value.thresholds === undefined) return { stage: value.stage };
	if (!isRecord(value.thresholds)) throw invalid();
	const entries = Object.entries(value.thresholds);
	if (entries.length > MAX_OWNER_THRESHOLDS) throw invalid();
	const thresholds: Record<string, number> = {};
	for (const [name, threshold] of entries) {
		if (RESERVED_THRESHOLD_NAMES.has(name)) throw new Error(`compaction owner ${label}: compact.pressure threshold name "${name}" is reserved`);
		if (name.length === 0 || name.length > 64 || typeof threshold !== "number" || !Number.isFinite(threshold)) throw invalid();
		thresholds[name] = threshold;
	}
	return { stage: value.stage, thresholds };
}

// src/providers/compact-provider.ts: ownerCarryItems.
function ownerCarryItems(label: string, value: unknown): string[] {
	if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every((item) => typeof item === "string")) {
		throw new Error(`compaction owner ${label}: compact.carry must return { items: string[] }`);
	}
	return [...value.items as string[]];
}

// src/providers/compact-provider.ts: ownerJson.
function ownerJson(label: string, action: string, value: unknown): unknown {
	if (value === undefined) return undefined;
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		throw new Error(`compaction owner ${label}: compact.${action} returned a value that is not JSON`);
	}
	if (text === undefined) return undefined;
	if (utf8Bytes(text) > MAX_OWNER_RESULT_BYTES) throw new Error(`compaction owner ${label}: compact.${action} returned more than ${MAX_OWNER_RESULT_BYTES} bytes`);
	return JSON.parse(text) as unknown;
}

export interface FakeFabricOptions {
	/** Carry-forward items Fabric hands the owner in the claim reply. */
	readonly carry?: readonly string[];
}

export interface FakeFabricClaim {
	readonly owner: { name: string; version: string };
	readonly actions: Readonly<Record<string, OwnerAction>>;
	readonly branchSummary: boolean;
	readonly signal: AbortSignal | undefined;
	readonly token: string;
}

export interface FallbackCall {
	readonly event: SessionBeforeCompactEvent;
	readonly options: { carry?: readonly string[] } | undefined;
}

/** src/compaction/claim.ts CompactionOwnerRegistry, wired as src/extension.ts wires it. */
export class FakeFabric {
	claim: FakeFabricClaim | undefined;
	readonly claims: unknown[] = [];
	readonly invalid: string[] = [];
	readonly fallbackCalls: FallbackCall[] = [];
	readonly warnings: string[] = [];
	/** Set by a test: what Fabric's deterministic summary (`options.fallback`) returns. */
	fallbackResult: { ok: true; compaction: Record<string, unknown> } | { ok: false; reason: string } = {
		ok: true,
		compaction: {
			summary: "Fabric deterministic summary",
			firstKeptEntryId: "kept-entry",
			tokensBefore: 120_000,
			details: { compactor: "fabric" },
		},
	};
	private nextToken = 1;
	private release: (() => void) | undefined;
	/** Set by a test: the handle's withdraw does nothing, so only the lifetime signal can end the claim. */
	ignoreHandleWithdraw = false;

	constructor(bus: EventBus, private readonly options: FakeFabricOptions = {}) {
		bus.on(OWNER_EVENT, (value) => this.receive(value));
	}

	/** True when Fabric's own engine compacts: it yields while a claim is held (src/compaction/hook.ts). */
	get engineActive(): boolean {
		return this.claim === undefined;
	}

	// src/extension.ts: the FABRIC_COMPACTION_OWNER_EVENT listener, then CompactionOwnerRegistry.handle and .claim.
	private receive(value: unknown): void {
		this.claims.push(value);
		const read = readClaim(value);
		if (!read.ok) {
			const error = `Invalid Pi Fabric compaction owner message: ${read.error}`;
			this.invalid.push(read.error);
			if (!read.reply) throw new Error(error);
			read.reply({ ok: false, error });
			return;
		}
		const message = read.claim;
		const owner = { name: message.owner.name, version: message.owner.version };
		const label = `${owner.name}@${owner.version}`;
		if (this.claim) {
			const error = `Fabric refused the compaction owner claim from ${label}: ${this.claim.owner.name}@${this.claim.owner.version} already owns compaction. Only one extension can own it; the holder must withdraw first.`;
			this.warnings.push(error);
			message.reply({ ok: false, error, holder: { ...this.claim.owner } });
			return;
		}
		if (message.signal?.aborted) {
			message.reply({ ok: false, error: `Fabric refused the compaction owner claim from ${label}: its signal is already aborted` });
			return;
		}
		const carry = this.options.carry === undefined ? undefined : Object.freeze([...this.options.carry]);
		const token = `token-${this.nextToken++}`;
		const signal = message.signal;
		const onAbort = (): void => { this.withdraw(token); };
		signal?.addEventListener("abort", onAbort, { once: true });
		this.claim = Object.freeze({
			owner: Object.freeze(owner),
			actions: Object.freeze({ ...message.actions }),
			branchSummary: message.branchSummary,
			signal,
			token,
		});
		this.release = () => signal?.removeEventListener("abort", onAbort);
		const result = { ok: true, handle: this.handle(token, owner.name), ...(carry ? { carry } : {}) };
		try {
			message.reply(result);
		} catch (error) {
			this.withdraw(token);
			throw error;
		}
	}

	// src/compaction/claim.ts: CompactionOwnerRegistry.#handle, including the fallback's claimOwner tag.
	private handle(token: string, ownerName: string): unknown {
		const holds = (): boolean => this.claim?.token === token;
		return Object.freeze({
			token,
			get active() { return holds(); },
			withdraw: () => (this.ignoreHandleWithdraw ? false : this.withdraw(token)),
			fallback: (event: SessionBeforeCompactEvent, _ctx?: ExtensionContext, options?: { carry?: readonly string[] }) => {
				if (!holds()) return { ok: false, reason: "fabric: the compaction owner claim is no longer held" };
				this.fallbackCalls.push({ event, options });
				const result = this.fallbackResult;
				if (!result.ok) return result;
				const details = result.compaction.details as Json | undefined;
				return { ok: true, compaction: { ...result.compaction, ...(details ? { details: { ...details, claimOwner: ownerName } } : {}) } };
			},
		});
	}

	// src/compaction/claim.ts: CompactionOwnerRegistry.withdraw and .clear.
	withdraw(token: string): boolean {
		if (this.claim?.token !== token) return false;
		this.shutdown();
		return true;
	}

	/** Fabric's own `session_shutdown` (src/extension.ts): it clears any claim. */
	shutdown(): void {
		const held = this.claim;
		this.claim = undefined;
		if (!held) return;
		this.release?.();
		this.release = undefined;
	}

	/**
	 * A listener that captured the published actions from the event bus and calls a handler
	 * itself, bypassing Fabric's validation. Nothing in the protocol stops this.
	 */
	async direct(action: string, args: unknown, ctx: ExtensionContext | undefined, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
		const message = this.claims.find((value) => isRecord(value) && isRecord(value.actions) && (value.actions as Json)[action] !== undefined) as Json | undefined;
		const entry = message ? (message.actions as Record<string, OwnerAction>)[action] : undefined;
		if (!entry) throw new Error(`no claim message published compact.${action}`);
		const call = { context: ctx, signal };
		return action === "request" || action === "carry"
			? (entry.handler as (a: unknown, c: typeof call) => unknown)(args, call)
			: (entry.handler as (c: typeof call) => unknown)(call);
	}

	/** Set by a test: Fabric's own pending compaction intent (src/core/compact-controller.ts CompactController). */
	pendingIntent: Json | undefined;

	/**
	 * A program's `compact.<action>` call under the claim, as the program sees it:
	 * src/providers/compact-provider.ts CompactProvider.invoke, then CompactProvider.#invokeOwner.
	 * - The arguments are validated exactly as without a claim (checkedRequestArguments,
	 *   checkedCarryArguments), and the owner gets a copy holding only declared fields.
	 * - Every handler call (#invokeOwner `call`) gets its own signal and races a 30 s timer and
	 *   the program's cancellation. Either one aborts the signal and fails the program call at
	 *   once, without waiting for the owner. A handler error is wrapped and passed on.
	 * - Every owner result passes `ownerJson` (JSON only, at most 16 KiB), then `ownerPressure`
	 *   or `ownerCarryItems` for those actions, after the handler returns.
	 * - The result is wrapped: request `{ requested, intent, claim, result? }`, status Fabric's
	 *   status plus `ownerStatus`, pressure Fabric's pressure plus `ownerPressure`, carry
	 *   `{ items, claim }`, cancel `{ cancelled, claim, fabricIntentCleared, ownerCancelled, result? }`.
	 * Fabric keeps the claim whatever the handler does. Progress activity is not reproduced.
	 */
	invoke(action: "request" | "carry", args: Json, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<Json>;
	invoke(action: "status" | "pressure" | "cancel", args: undefined, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<Json>;
	async invoke(action: string, args: Json | undefined, ctx: ExtensionContext | undefined, programSignal?: AbortSignal): Promise<Json> {
		const claim = this.claim;
		if (!claim) throw new Error("no compaction owner claim is held");
		const label = `${claim.owner.name}@${claim.owner.version}`;
		const ownerRef = { name: claim.owner.name, version: claim.owner.version };
		const ownerError = (message: string): Error => new Error(`compaction owner ${label}: ${message}`);
		type OwnerCall = { context: ExtensionContext | undefined; signal: AbortSignal };
		// #invokeOwner `call`: the signal, the timer and the program's cancellation.
		const run = async (name: string, invoke: (call: OwnerCall) => unknown): Promise<unknown> => {
			if (programSignal?.aborted) throw ownerError(`compact.${name} was not called: the calling program was cancelled`);
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onProgramAbort: (() => void) | undefined;
			const stopped = new Promise<never>((_resolve, reject) => {
				// b67da914 compact-provider.ts:412-423: the signal is aborted with the same error the
				// program call fails with, so its reason names the cause: "did not finish within 30 s"
				// (the timer) or "was cancelled by the calling program" (the program's signal).
				const stop = (why: string): void => {
					const error = ownerError(`compact.${name} ${why}`);
					controller.abort(error);
					reject(error);
				};
				timer = setTimeout(() => stop(`did not finish within ${OWNER_HANDLER_TIMEOUT_MS / 1000} s`), OWNER_HANDLER_TIMEOUT_MS);
				onProgramAbort = () => stop("was cancelled by the calling program");
				programSignal?.addEventListener("abort", onProgramAbort, { once: true });
			});
			const handled = (async () => {
				try {
					return await invoke({ context: ctx, signal: controller.signal });
				} catch (error) {
					throw ownerError(`compact.${name} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
			// Fabric does not observe the handler after the race is lost; nor does the stand-in.
			handled.catch(() => {});
			try {
				return await Promise.race([handled, stopped]);
			} finally {
				clearTimeout(timer);
				if (onProgramAbort) programSignal?.removeEventListener("abort", onProgramAbort);
			}
		};
		const unsupported = (name: string, field?: string): Error => ownerError(field === undefined
			? `does not support compact.${name}; nothing was recorded`
			: `does not support the compact.${name} field "${field}"; nothing was recorded`);
		const declaredCopy = (name: "request" | "carry", input: Json, entry: OwnerAction): Json => {
			const copy: Json = {};
			for (const field of name === "request" ? REQUEST_FIELDS : CARRY_FIELDS) {
				const value = input[field];
				if (value === undefined) continue;
				if (!entry.fields?.includes(field)) throw unsupported(name, field);
				copy[field] = Array.isArray(value) ? [...value as string[]] : value;
			}
			return copy;
		};
		switch (action) {
			case "request": {
				const input = checkedRequestArguments(args ?? {});
				const entry = claim.actions.request;
				if (!entry) throw unsupported("request");
				const request = declaredCopy("request", input, entry);
				const result = ownerJson(label, "request", await run("request", (call) => (entry.handler as (a: Json, c: OwnerCall) => unknown)(request, call)));
				const intent: Json = {
					requestedBy: (request.requestedBy as string | undefined) || "model",
					requestedAt: Date.now(),
					...(request.reason ? { reason: request.reason } : {}),
					...(request.instructions ? { instructions: request.instructions } : {}),
					...(request.preserve ? { preserve: [...request.preserve as string[]] } : {}),
					...(request.seed ? { seed: request.seed } : {}),
				};
				return { requested: true, intent, claim: ownerRef, ...(result !== undefined ? { result } : {}) };
			}
			case "status": {
				const status = {
					...(this.pendingIntent ? { pending: this.pendingIntent } : {}),
					owner: ownerFromContext(ctx),
					outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
					claim: { ...ownerRef, branchSummary: claim.branchSummary, actions: Object.keys(claim.actions).sort() },
				};
				const entry = claim.actions.status;
				if (!entry) return status;
				const ownerStatus = ownerJson(label, "status", await run("status", (call) => (entry.handler as (c: OwnerCall) => unknown)(call)));
				return { ...status, ...(ownerStatus !== undefined ? { ownerStatus } : {}) };
			}
			case "pressure": {
				const pressure = compactionPressure(ctx);
				const entry = claim.actions.pressure;
				if (!entry) return { ...pressure, claim: ownerRef };
				const reported = ownerPressure(label, ownerJson(label, "pressure", await run("pressure", (call) => (entry.handler as (c: OwnerCall) => unknown)(call))));
				return { ...pressure, claim: ownerRef, ownerPressure: reported };
			}
			case "carry": {
				const input = checkedCarryArguments(args ?? {});
				const entry = claim.actions.carry;
				if (!entry) throw unsupported("carry");
				const update = declaredCopy("carry", input, entry);
				const items = ownerCarryItems(label, ownerJson(label, "carry", await run("carry", (call) => (entry.handler as (a: Json, c: OwnerCall) => unknown)(update, call))));
				return { items, claim: ownerRef };
			}
			case "cancel": {
				const fabricIntentCleared = this.pendingIntent !== undefined;
				this.pendingIntent = undefined;
				const entry = claim.actions.cancel;
				if (!entry) {
					if (!fabricIntentCleared) throw ownerError("does not support compact.cancel, and Fabric had no pending compaction request; nothing was cancelled");
					return { cancelled: true, claim: ownerRef, fabricIntentCleared, ownerCancelled: false };
				}
				let result: unknown;
				try {
					result = ownerJson(label, "cancel", await run("cancel", (call) => (entry.handler as (c: OwnerCall) => unknown)(call)));
				} catch (error) {
					if (!fabricIntentCleared) throw error;
					throw new Error(`${error instanceof Error ? error.message : String(error)}; Fabric's own pending compaction request was cleared`, { cause: error });
				}
				return { cancelled: true, claim: ownerRef, fabricIntentCleared, ownerCancelled: true, ...(result !== undefined ? { result } : {}) };
			}
			default:
				throw new Error(`Unknown compact action: ${action}`);
		}
	}

	/**
	 * `invoke`, with the owner's own result taken back out of Fabric's envelope: `result`
	 * (request, cancel), `ownerStatus`, `ownerPressure`, or `{ items }` (carry).
	 */
	call(action: "request" | "carry", args: Json, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<unknown>;
	call(action: "status" | "pressure" | "cancel", args: undefined, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<unknown>;
	async call(action: string, args: Json | undefined, ctx: ExtensionContext | undefined, signal?: AbortSignal): Promise<unknown> {
		const wrapped = await (this.invoke as (a: string, b: Json | undefined, c: ExtensionContext | undefined, d?: AbortSignal) => Promise<Json>)(action, args, ctx, signal);
		switch (action) {
			case "status": return wrapped.ownerStatus;
			case "pressure": return wrapped.ownerPressure;
			case "carry": return { items: wrapped.items };
			default: return wrapped.result;
		}
	}
}

export interface FakeHostPi {
	readonly api: ExtensionAPI;
	readonly bus: EventBus;
	readonly events: Map<string, Handler[]>;
	readonly tools: Map<string, unknown>;
	readonly messages: Array<{ message: Json; options: unknown }>;
	readonly userMessages: unknown[];
	readonly entries: Array<{ customType: string; data: unknown }>;
	handler(name: string): (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
}

/** The part of Pi's extension API this extension touches, over Pi's real event bus. */
export function createHostPi(sharedBus?: EventBus): FakeHostPi {
	// A reloaded extension gets a new API object over the same event bus.
	const bus = sharedBus ?? createEventBus();
	const events = new Map<string, Handler[]>();
	const tools = new Map<string, unknown>();
	const messages: FakeHostPi["messages"] = [];
	const userMessages: unknown[] = [];
	const entries: FakeHostPi["entries"] = [];
	let activeTools = ["read", "bash", "edit"];
	const api = {
		events: bus,
		registerFlag() {},
		getFlag() { return undefined; },
		on(name: string, handler: Handler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand() {},
		getCommands() { return []; },
		sendMessage(message: Json, options?: unknown) { messages.push({ message, options }); },
		sendUserMessage(message: unknown) { userMessages.push(message); },
		getActiveTools() { return [...activeTools]; },
		getAllTools() { return [...tools.values()].map((tool) => ({ name: (tool as { name: string }).name, description: "", parameters: {} })); },
		setActiveTools(names: string[]) { activeTools = [...names]; },
		async setModel() { return true; },
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
	} as unknown as ExtensionAPI;
	return {
		api,
		bus,
		events,
		tools,
		messages,
		userMessages,
		entries,
		handler(name: string) {
			const handlers = events.get(name);
			if (!handlers?.length) throw new Error(`no ${name} handler registered`);
			return async (event: unknown, ctx: ExtensionContext) => {
				let result: unknown;
				let current = event as Json;
				for (const handler of handlers) {
					const next = await (handler as unknown as (e: Json, c: ExtensionContext) => unknown)(current, ctx);
					if (next !== undefined) {
						result = next;
						if (typeof next === "object" && next !== null) current = { ...current, ...next };
					}
				}
				return result;
			};
		},
	};
}

export interface CapturedCompact {
	customInstructions?: string;
	onComplete?: (result: { summary: string; details?: unknown }) => void;
	onError?: (error: Error) => void;
}

export interface FakeSession {
	readonly ctx: ExtensionContext;
	readonly compactions: CapturedCompact[];
	readonly branch: Json[];
	setIdle(idle: boolean): void;
}

export function createSession(root: string, name: string, options: { model?: unknown; branch?: Json[] } = {}): FakeSession {
	let idle = true;
	const compactions: CapturedCompact[] = [];
	const branch: Json[] = options.branch ?? [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-13T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "Work on the migration." }], timestamp: Date.now() },
		},
	];
	const ctx = {
		hasUI: false,
		cwd: root,
		model: options.model ?? { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000 }),
		isProjectTrusted: () => true,
		isIdle: () => idle,
		abort: () => {},
		compact(compactOptions: CapturedCompact) { compactions.push(compactOptions); },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
		},
		ui: {},
		sessionManager: {
			getEntries: () => branch,
			getBranch: () => branch,
			getSessionDir: () => root,
			getSessionFile: () => path.join(root, `${name}.jsonl`),
			getSessionId: () => name,
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => `${name}-leaf`,
			appendCustomEntry: () => `${name}-entry`,
		},
	} as unknown as ExtensionContext;
	return { ctx, compactions, branch, setIdle: (next) => { idle = next; } };
}

export function compactionEvent(overrides: Json = {}): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		customInstructions: undefined,
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [{ role: "user", content: "earlier phase ".repeat(50), timestamp: Date.now() }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 120_000,
			settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 2_000 },
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		},
		...overrides,
	} as unknown as SessionBeforeCompactEvent;
}
