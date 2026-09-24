/** Defensive, capability-gated terminal projections. Static executable/version discovery is adapter-lifetime cached; connectivity uses independent TTLs. This module never launches a terminal or builds shell commands. */

import { redactText, sanitizeNotification, type SanitizedNotification } from "./workstream-safety.js";

export const CMUX_CONNECTED_TTL_MS = 15_000;
export const CMUX_UNAVAILABLE_TTL_MS = 30_000;
export const CMUX_PING_TIMEOUT_MS = 1_000;

export interface CmuxProbe {
	readonly executable: () => boolean;
	readonly version: () => string | undefined;
	readonly ping: (timeoutMs: number) => boolean;
}

export interface CmuxCapability {
	readonly enabled: boolean;
	readonly available: boolean;
	readonly version?: string;
	readonly reason?: string;
}

export interface CmuxProjectionAdapter {
	readonly capabilities: () => CmuxCapability;
	readonly publishStatus: (payload: ProjectionPayload) => boolean;
	readonly publishProgress: (payload: ProjectionPayload) => boolean;
	readonly publishLog: (payload: ProjectionPayload) => boolean;
	readonly publishNotification: (payload: SanitizedNotification) => boolean;
	readonly focus: (location: string) => boolean;
	readonly logActivity: (payload: ActivityPayload) => boolean;
	readonly clear: () => boolean;
}

export interface ProjectionPayload {
	readonly summary: string;
}

export interface ActivityPayload {
	readonly summary: string;
}

export interface CmuxProjectionOptions {
	readonly enabled?: boolean;
	readonly activityLogging?: boolean;
	readonly now?: () => number;
	readonly pingTimeoutMs?: number;
	readonly probe: CmuxProbe;
	readonly execute: (operation: "status" | "progress" | "log" | "notification" | "focus" | "activity" | "clear", payload: unknown) => void;
}

interface StaticCapability {
	readonly version?: string;
	readonly capability: CmuxCapability;
}

interface CachedConnectivity {
	readonly checkedAt: number;
	readonly available: boolean;
}

function boundedSummary(value: string): string {
	return redactText(value, { maxLength: 240 });
}

function payload(value: ProjectionPayload): ProjectionPayload {
	return { summary: boundedSummary(value.summary) };
}

function activity(value: ActivityPayload): ActivityPayload {
	return { summary: boundedSummary(value.summary) };
}

/** Create an injectable cmux adapter; all probes and writes are supplied by callers. */
export function createCmuxProjectionAdapter(options: CmuxProjectionOptions): CmuxProjectionAdapter {
	const clock = options.now ?? Date.now;
	const enabled = options.enabled ?? true;
	const pingTimeoutMs = Math.min(5_000, Math.max(1, options.pingTimeoutMs ?? CMUX_PING_TIMEOUT_MS));
	let staticCapability: StaticCapability | undefined;
	let connectivity: CachedConnectivity | undefined;

	function getStaticCapability(): StaticCapability {
		if (staticCapability) return staticCapability;
		const executable = (() => {
			try { return options.probe.executable(); } catch { return false; }
		})();
		if (!executable) {
			staticCapability = { capability: { enabled: true, available: false, reason: "cmux executable unavailable" } };
			return staticCapability;
		}
		let version: string | undefined;
		try { version = options.probe.version(); } catch { version = undefined; }
		if (!version || version.length > 128) {
			staticCapability = { version, capability: { enabled: true, available: false, reason: "cmux version unavailable" } };
			return staticCapability;
		}
		staticCapability = { version, capability: { enabled: true, available: true, version } };
		return staticCapability;
	}

	function capabilities(): CmuxCapability {
		const current = clock();
		if (!enabled) return { enabled: false, available: false, reason: "disabled" };
		const statics = getStaticCapability();
		if (!statics.capability.available) return statics.capability;
		const ttl = connectivity?.available === true ? CMUX_CONNECTED_TTL_MS : CMUX_UNAVAILABLE_TTL_MS;
		if (connectivity && current >= connectivity.checkedAt && current - connectivity.checkedAt < ttl) {
			return connectivity.available
				? { enabled: true, available: true, version: statics.version }
				: { enabled: true, available: false, version: statics.version, reason: "cmux ping is not reachable" };
		}
		const clockRewound = connectivity !== undefined && current < connectivity.checkedAt;
		const reachable = (() => {
			try { return options.probe.ping(pingTimeoutMs); } catch { return false; }
		})();
		// A wall-clock rewind invalidates the previous age calculation. Fail closed
		// for this probe and retain the negative TTL until the clock is trustworthy.
		const available = !clockRewound && reachable;
		connectivity = { checkedAt: current, available };
		return available
			? { enabled: true, available: true, version: statics.version }
			: { enabled: true, available: false, version: statics.version, reason: "cmux ping is not reachable" };
	}

	function publish(operation: "status" | "progress" | "log" | "notification" | "focus" | "activity" | "clear", value: unknown): boolean {
		if (!capabilities().available) return false;
		try {
			options.execute(operation, value);
			return true;
		} catch {
			connectivity = undefined;
			return false;
		}
	}

	return {
		capabilities,
		publishStatus: (value) => publish("status", payload(value)),
		publishProgress: (value) => publish("progress", payload(value)),
		publishLog: (value) => publish("log", payload(value)),
		publishNotification: (value) => publish("notification", sanitizeNotification(value)),
		focus: (location) => publish("focus", { location: redactText(location, { maxLength: 512 }) }),
		logActivity: (value) => options.activityLogging === true ? publish("activity", activity(value)) : false,
		clear: () => publish("clear", { owned: true }),
	};
}
