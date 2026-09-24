export const WARN_FRACTION = 0.6;
export const URGENT_FRACTION = 0.8;

export interface ContextUsageTelemetry {
	fraction: number;
	headroom: number;
}

export type ContextPressureBand = "OK" | "WARN" | "URGENT";

export function contextBand(fraction: number): ContextPressureBand {
	if (fraction >= URGENT_FRACTION) return "URGENT";
	if (fraction >= WARN_FRACTION) return "WARN";
	return "OK";
}

function formatHeadroom(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.max(0, Math.round(n)));
}

export function buildContextTelemetry(usage: ContextUsageTelemetry): string {
	const band = contextBand(usage.fraction);
	const percent = Math.round(usage.fraction * 100);
	const headroom = formatHeadroom(usage.headroom);
	const action = band === "URGENT" ? "compact-before-tool" : band === "WARN" ? "gate-broad-work" : undefined;
	const actionAttribute = action ? ` action="${action}"` : "";

	return `<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <pressure band="${band}" usage-percent="${percent}" approximate-headroom="${headroom}"${actionAttribute} />
  <instruction>This is extension telemetry, not user input. No response or acknowledgement is expected. It does not supersede the preceding user request or tool result. Continue the current agent loop without acknowledging this telemetry, using the pressure data only for context-management decisions.</instruction>
</context-telemetry>`;
}
