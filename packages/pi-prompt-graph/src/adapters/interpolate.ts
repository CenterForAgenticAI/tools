import type { JsonObject } from "../model.js";

export type InterpolatedPart = { literal: string } | { path: string };

/** Joins literal and state-path parts into one string. A missing path contributes nothing. */
export function interpolate(parts: readonly InterpolatedPart[], state: JsonObject): string {
	return parts.map((part) => "literal" in part ? part.literal : String(valueAt(state, part.path) ?? "")).join("");
}

export function valueAt(state: JsonObject, path: string): unknown {
	let value: unknown = state;
	for (const part of path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}
