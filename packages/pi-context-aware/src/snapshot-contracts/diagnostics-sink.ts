/** Rate-limited adapter diagnostics and health, built on the redaction helpers in ./safety.ts. */
// The registry, cmux and activity adapters report failures here. Each line is scrubbed by
// ./safety.ts before it is stored or emitted, so this module holds no redaction rules itself.

import { MAX_DIAGNOSTIC_LENGTH, redactText, redactUnknown } from "./safety.js";

export const MAX_TRACKED_DIAGNOSTIC_KEYS = 256;

export type AdapterHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface AdapterHealth {
	readonly adapter: string;
	readonly status: AdapterHealthStatus;
	readonly failureCount: number;
	readonly lastCheckedAt?: number;
	readonly lastError?: string;
}

export interface DiagnosticInput {
	readonly adapter: string;
	readonly code: string;
	readonly detail?: unknown;
}

export interface RateLimitedDiagnostics {
	record(input: DiagnosticInput): boolean;
	markUnavailable(adapter: string, detail: unknown): AdapterHealth;
	markHealthy(adapter: string): AdapterHealth;
	getHealth(adapter: string): AdapterHealth;
	snapshotHealth(): readonly AdapterHealth[];
}

export interface RateLimitedDiagnosticsOptions {
	readonly clock?: () => number;
	readonly windowMs?: number;
	readonly maxPerWindow?: number;
	readonly emit?: (line: string) => void;
}

interface MutableHealth {
	adapter: string;
	status: AdapterHealthStatus;
	failureCount: number;
	lastCheckedAt?: number;
	lastError?: string;
}

export function scrubDiagnosticDetail(value: unknown): string {
	const redacted = redactUnknown(value, { maxDepth: 4, maxItems: 20, maxLength: MAX_DIAGNOSTIC_LENGTH });
	const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
	return redactText(serialized ?? "[REDACTED]", { maxLength: MAX_DIAGNOSTIC_LENGTH });
}

/**
 * A bounded best-effort sink. Recording a diagnostic never throws, and each
 * adapter/code pair can emit only a small number of scrubbed lines per window.
 */
export function createRateLimitedDiagnostics(options: RateLimitedDiagnosticsOptions = {}): RateLimitedDiagnostics {
	const clock = options.clock ?? Date.now;
	const windowMs = Math.max(1, options.windowMs ?? 60_000);
	const maxPerWindow = Math.max(1, Math.floor(options.maxPerWindow ?? 3));
	const emit = options.emit ?? (() => undefined);
	const counts = new Map<string, { startedAt: number; count: number }>();
	const health = new Map<string, MutableHealth>();

	function getMutable(adapter: string): MutableHealth {
		const current = health.get(adapter);
		if (current) return current;
		if (health.size >= MAX_TRACKED_DIAGNOSTIC_KEYS) {
			const oldest = health.keys().next().value;
			if (typeof oldest === "string") health.delete(oldest);
		}
		const created: MutableHealth = { adapter, status: "unknown", failureCount: 0 };
		health.set(adapter, created);
		return created;
	}

	function copy(value: MutableHealth): AdapterHealth {
		return { ...value };
	}

	function record(input: DiagnosticInput): boolean {
		try {
			const adapter = redactText(input.adapter, { maxLength: 64 });
			const code = redactText(input.code, { maxLength: 64 });
			const key = `${adapter}:${code}`;
			const now = clock();
			if (!counts.has(key) && counts.size >= MAX_TRACKED_DIAGNOSTIC_KEYS) {
				const oldest = counts.keys().next().value;
				if (typeof oldest === "string") counts.delete(oldest);
			}
			const prior = counts.get(key);
			const current = !prior || now - prior.startedAt >= windowMs ? { startedAt: now, count: 0 } : prior;
			if (current.count >= maxPerWindow) {
				counts.set(key, current);
				return false;
			}
			current.count += 1;
			counts.set(key, current);
			const state = getMutable(adapter);
			state.status = "degraded";
			state.failureCount = Math.min(1_000, state.failureCount + 1);
			state.lastCheckedAt = now;
			state.lastError = scrubDiagnosticDetail(input.detail ?? code);
			emit(redactText(JSON.stringify({ adapter, code, detail: state.lastError, at: now }), { maxLength: MAX_DIAGNOSTIC_LENGTH }));
			return true;
		} catch {
			return false;
		}
	}

	function markUnavailable(adapter: string, detail: unknown): AdapterHealth {
		const state = getMutable(redactText(adapter, { maxLength: 64 }));
		state.status = "unavailable";
		state.failureCount = Math.min(1_000, state.failureCount + 1);
		state.lastCheckedAt = clock();
		state.lastError = scrubDiagnosticDetail(detail);
		return copy(state);
	}

	function markHealthy(adapter: string): AdapterHealth {
		const state = getMutable(redactText(adapter, { maxLength: 64 }));
		state.status = "healthy";
		state.lastCheckedAt = clock();
		state.lastError = undefined;
		return copy(state);
	}

	return {
		record,
		markUnavailable,
		markHealthy,
		getHealth: (adapter) => copy(getMutable(redactText(adapter, { maxLength: 64 }))),
		snapshotHealth: () => [...health.values()].map(copy),
	};
}
