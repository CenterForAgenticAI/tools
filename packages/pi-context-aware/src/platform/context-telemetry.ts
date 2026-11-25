import {
	contextAwarePressureBandEdgesV1,
	type ContextAwarePressureBandEdgesV1,
} from "../context-service.js";

/** Where the WARN and URGENT bands begin. Always derived from a pressure ladder. */
export type ContextPressureBandEdges = ContextAwarePressureBandEdgesV1;

/** Band edges of the default pressure ladder, for callers without a session. */
export const DEFAULT_PRESSURE_BAND_EDGES: ContextPressureBandEdges = Object.freeze(contextAwarePressureBandEdgesV1());

export type ContextPressureBand = "OK" | "WARN" | "URGENT";

export function contextBand(fraction: number, bands: ContextPressureBandEdges = DEFAULT_PRESSURE_BAND_EDGES): ContextPressureBand {
	if (fraction >= bands.urgentFraction) return "URGENT";
	if (fraction >= bands.warnFraction) return "WARN";
	return "OK";
}

/**
 * The label that starts every line this extension adds to the model's context as a user-role message: the
 * pressure action line and the restart notice. The line says itself that the user did not write it, because no
 * system-prompt rule explains it (pi-context-aware#461).
 */
export const EXTENSION_NOTE_LABEL = "[context-aware extension, not user input]";
