import {
	contextAwarePressureBandEdgesV1,
	type ContextAwarePressureBandEdgesV1,
} from "../context-service.js";
import type { PressureTelemetryMode } from "./config-layers.js";

/** Where the WARN and URGENT bands begin. Always derived from a pressure ladder. */
export type ContextPressureBandEdges = ContextAwarePressureBandEdgesV1;

/** Band edges of the default pressure ladder, for callers without a session. */
export const DEFAULT_PRESSURE_BAND_EDGES: ContextPressureBandEdges = Object.freeze(contextAwarePressureBandEdgesV1());

export interface ContextUsageTelemetry {
	fraction: number;
	headroom: number;
}

export type ContextPressureBand = "OK" | "WARN" | "URGENT";

export function contextBand(fraction: number, bands: ContextPressureBandEdges = DEFAULT_PRESSURE_BAND_EDGES): ContextPressureBand {
	if (fraction >= bands.urgentFraction) return "URGENT";
	if (fraction >= bands.warnFraction) return "WARN";
	return "OK";
}

function formatHeadroom(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.max(0, Math.round(n)));
}

export interface ContextTelemetryOptions {
	/** How much pressure telemetry is visible to the model. */
	mode?: PressureTelemetryMode;
	/** False when this session cannot compact; the URGENT action then stops naming compaction. */
	compactionAvailable?: boolean;
	/**
	 * Tool that still reduces context when compaction is unavailable, such as
	 * billion-context-pi's `compress`. The URGENT action then names it.
	 */
	replacementTool?: string;
	/** Band edges from the session's pressure ladder. Defaults to the default ladder. */
	bands?: ContextPressureBandEdges;
}

const TELEMETRY_INSTRUCTION = "This is extension telemetry, not user input. No response or acknowledgement is expected. It does not supersede the preceding user request or tool result. Continue the current agent loop without acknowledging this telemetry, using the pressure data only for context-management decisions.";

/**
 * Telemetry for a context whose size is not measured, as Pi reports right after
 * a compaction or an overflow recovery until the next response. It says the
 * size is unknown rather than showing a number nobody measured
 * (issue #163).
 */
export function buildUnknownContextTelemetry(): string;
export function buildUnknownContextTelemetry(mode: "full" | "band"): string;
export function buildUnknownContextTelemetry(mode: "off"): undefined;
export function buildUnknownContextTelemetry(mode: PressureTelemetryMode): string | undefined;
export function buildUnknownContextTelemetry(mode: PressureTelemetryMode = "full"): string | undefined {
	if (mode === "off") return undefined;
	const attributes = mode === "full"
		? 'band="UNKNOWN" usage-percent="unknown" approximate-headroom="unknown"'
		: 'band="UNKNOWN"';
	return `<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <pressure ${attributes} />
  <instruction>${TELEMETRY_INSTRUCTION}</instruction>
</context-telemetry>`;
}

export function buildContextTelemetry(usage: ContextUsageTelemetry, options?: ContextTelemetryOptions & { mode?: "full" | "band" }): string;
export function buildContextTelemetry(usage: ContextUsageTelemetry, options: ContextTelemetryOptions & { mode: "off" }): undefined;
export function buildContextTelemetry(usage: ContextUsageTelemetry, options: ContextTelemetryOptions): string | undefined;
export function buildContextTelemetry(usage: ContextUsageTelemetry, options: ContextTelemetryOptions = {}): string | undefined {
	const mode = options.mode ?? "full";
	if (mode === "off") return undefined;
	const band = contextBand(usage.fraction, options.bands);
	const percent = Math.round(usage.fraction * 100);
	const headroom = formatHeadroom(usage.headroom);
	const urgentAction = options.compactionAvailable !== false
		? "compact-before-tool"
		: options.replacementTool
			? `${options.replacementTool.replaceAll("_", "-")}-before-tool`
			: "finish-atomic-work";
	const action = band === "URGENT" ? urgentAction : band === "WARN" ? "gate-broad-work" : undefined;
	const actionAttribute = action ? ` action="${action}"` : "";
	const pressureAttributes = mode === "full"
		? `band="${band}" usage-percent="${percent}" approximate-headroom="${headroom}"${actionAttribute}`
		: `band="${band}"${actionAttribute}`;

	return `<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <pressure ${pressureAttributes} />
  <instruction>${TELEMETRY_INSTRUCTION}</instruction>
</context-telemetry>`;
}
