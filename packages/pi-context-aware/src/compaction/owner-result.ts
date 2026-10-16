/**
 * The checks Fabric applies to an owner handler's result after the handler returns.
 *
 * Fabric calls a `compact.*` handler, then checks what it returned before the program
 * sees it (pi-fabric b67da914 `src/providers/compact-provider.ts`):
 * - `ownerJson`, for every action: the result must survive `JSON.stringify`, and its
 *   UTF-8 encoding must be at most `MAX_OWNER_RESULT_BYTES`;
 * - `ownerPressure`, for `pressure`: `{ stage, thresholds? }`, stage 1-64 characters, at
 *   most 16 thresholds, each name 1-64 characters and not reserved, each value finite;
 * - `ownerCarryItems`, for `carry`: `{ items: string[] }`.
 * A result that fails one of them fails the program call after the handler has finished,
 * where the handler's own guard cannot see it. The handlers use these checks to stay
 * inside the bounds, and the guard (owner-claim.ts) runs them before it lets a result go.
 */

/** pi-fabric b67da914 `src/providers/compact-provider.ts` `MAX_OWNER_RESULT_BYTES`. */
export const MAX_OWNER_RESULT_BYTES = 16 * 1024;
/** pi-fabric b67da914 `src/protocol.ts` `FABRIC_COMPACTION_OWNER_HANDLER_TIMEOUT_MS`. */
export const OWNER_HANDLER_TIMEOUT_MS = 30_000;

const MAX_OWNER_THRESHOLDS = 16;
const RESERVED_THRESHOLD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The UTF-8 size of a result as Fabric measures it, or undefined when it is not JSON. */
export function ownerResultBytes(value: unknown): number | undefined {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
	} catch {
		return undefined;
	}
}

function pressureError(value: unknown): string | undefined {
	const invalid = "must return { stage, thresholds? }";
	if (!isRecord(value) || typeof value.stage !== "string" || value.stage.length === 0 || value.stage.length > 64) return invalid;
	if (value.thresholds === undefined) return undefined;
	if (!isRecord(value.thresholds)) return invalid;
	const entries = Object.entries(value.thresholds);
	if (entries.length > MAX_OWNER_THRESHOLDS) return invalid;
	for (const [name, threshold] of entries) {
		if (RESERVED_THRESHOLD_NAMES.has(name)) return `threshold name "${name}" is reserved`;
		if (name.length === 0 || name.length > 64 || typeof threshold !== "number" || !Number.isFinite(threshold)) return invalid;
	}
	return undefined;
}

/** Why Fabric would reject this result of `compact.<action>`, or undefined when it passes. */
export function ownerResultError(action: string, value: unknown): string | undefined {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		return "returned a value that is not JSON";
	}
	if (text !== undefined && Buffer.byteLength(text, "utf8") > MAX_OWNER_RESULT_BYTES) {
		return `returned more than ${MAX_OWNER_RESULT_BYTES} bytes`;
	}
	// Fabric checks the shape of the JSON copy, so it is checked here too.
	const copy: unknown = text === undefined ? undefined : JSON.parse(text);
	if (action === "pressure") return pressureError(copy);
	if (action === "carry") {
		const items = isRecord(copy) ? copy.items : undefined;
		if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) return "must return { items: string[] }";
	}
	return undefined;
}
