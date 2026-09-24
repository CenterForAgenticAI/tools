/** Health and diagnostics facade for optional workstream integrations. */

import {
	createRateLimitedDiagnostics,
	redactText,
	scrubDiagnosticDetail,
	type AdapterHealth,
	type RateLimitedDiagnostics,
	type RateLimitedDiagnosticsOptions,
} from "./workstream-safety.js";
import type { CapabilityName, CapabilityGate } from "./workstream-schema.js";

export interface CapabilityHealth extends CapabilityGate {
	readonly status: "healthy" | "degraded" | "unavailable" | "disabled";
	readonly failureCount: number;
	readonly lastCheckedAt?: number;
	readonly lastError?: string;
}

export interface WorkstreamHealth {
	readonly adapters: readonly AdapterHealth[];
	readonly capabilities: readonly CapabilityHealth[];
}

export interface WorkstreamDiagnosticsOptions extends RateLimitedDiagnosticsOptions {
	readonly capabilities?: readonly CapabilityGate[];
}

export interface WorkstreamDiagnostics {
	recordFailure(adapter: string, code: string, detail?: unknown): boolean;
	markUnavailable(adapter: string, detail: unknown): CapabilityHealth | AdapterHealth;
	markHealthy(adapter: string): CapabilityHealth | AdapterHealth;
	setCapability(gate: CapabilityGate): CapabilityHealth;
	isCapabilityEnabled(capability: CapabilityName): boolean;
	health(): WorkstreamHealth;
	healthText(): string;
}

interface MutableCapability {
	capability: CapabilityName;
	enabled: boolean;
	available: boolean;
	status: CapabilityHealth["status"];
	failureCount: number;
	lastCheckedAt?: number;
	lastError?: string;
}

const CAPABILITIES: readonly CapabilityName[] = ["luna-activity", "cmux", "tmux", "intercom", "worktree-launcher"];

function capabilityName(value: string): CapabilityName | undefined {
	return CAPABILITIES.includes(value as CapabilityName) ? value as CapabilityName : undefined;
}

function createCapability(gate: CapabilityGate): MutableCapability {
	return {
		capability: gate.capability,
		enabled: gate.enabled,
		available: gate.available,
		status: gate.enabled ? (gate.available ? "healthy" : "unavailable") : "disabled",
		failureCount: 0,
		...(gate.reason === undefined ? {} : { lastError: redactText(gate.reason, { maxLength: 240 }) }),
	};
}

function copyCapability(capability: MutableCapability): CapabilityHealth {
	return { ...capability };
}

function adapterCapability(adapter: string): CapabilityName | undefined {
	return capabilityName(adapter);
}

/**
 * Combine rate-limited scrubbed diagnostics with capability state suitable for
 * `/focus` or `/sessions` health displays. All operations are best effort.
 */
export function createWorkstreamDiagnostics(options: WorkstreamDiagnosticsOptions = {}): WorkstreamDiagnostics {
	const sink: RateLimitedDiagnostics = createRateLimitedDiagnostics(options);
	const capabilities = new Map<CapabilityName, MutableCapability>();
	for (const capability of options.capabilities ?? []) {
		capabilities.set(capability.capability, createCapability(capability));
	}

	function setCapability(gate: CapabilityGate): CapabilityHealth {
		const current = capabilities.get(gate.capability) ?? createCapability(gate);
		current.enabled = gate.enabled;
		current.available = gate.available;
		current.status = !gate.enabled ? "disabled" : gate.available ? "healthy" : "unavailable";
		current.lastError = gate.reason === undefined ? undefined : redactText(gate.reason, { maxLength: 240 });
		current.lastCheckedAt = options.clock?.() ?? Date.now();
		capabilities.set(gate.capability, current);
		return copyCapability(current);
	}

	function recordFailure(adapter: string, code: string, detail?: string): boolean {
		const emitted = sink.record({ adapter, code, ...(detail === undefined ? {} : { detail }) });
		const capability = adapterCapability(adapter);
		if (capability) {
			const current = capabilities.get(capability) ?? createCapability({ capability, enabled: true, available: true });
			current.status = "degraded";
			current.available = false;
			current.failureCount = Math.min(1_000, current.failureCount + 1);
			current.lastCheckedAt = options.clock?.() ?? Date.now();
			current.lastError = detail === undefined ? code : scrubDiagnosticDetail(detail);
			capabilities.set(capability, current);
		}
		return emitted;
	}

	function markUnavailable(adapter: string, detail: unknown): CapabilityHealth | AdapterHealth {
		const health = sink.markUnavailable(adapter, detail);
		const capability = adapterCapability(adapter);
		if (!capability) return health;
		const current = capabilities.get(capability) ?? createCapability({ capability, enabled: true, available: false });
		current.available = false;
		current.status = "unavailable";
		current.failureCount = Math.min(1_000, current.failureCount + 1);
		current.lastCheckedAt = options.clock?.() ?? Date.now();
		current.lastError = scrubDiagnosticDetail(detail);
		capabilities.set(capability, current);
		return copyCapability(current);
	}

	function markHealthy(adapter: string): CapabilityHealth | AdapterHealth {
		const health = sink.markHealthy(adapter);
		const capability = adapterCapability(adapter);
		if (!capability) return health;
		const current = capabilities.get(capability) ?? createCapability({ capability, enabled: true, available: true });
		current.available = true;
		current.status = current.enabled ? "healthy" : "disabled";
		current.lastCheckedAt = options.clock?.() ?? Date.now();
		current.lastError = undefined;
		capabilities.set(capability, current);
		return copyCapability(current);
	}

	function isCapabilityEnabled(capability: CapabilityName): boolean {
		const gate = capabilities.get(capability);
		return gate?.enabled === true && gate.available;
	}

	function health(): WorkstreamHealth {
		return { adapters: sink.snapshotHealth(), capabilities: [...capabilities.values()].map(copyCapability) };
	}

	return {
		recordFailure,
		markUnavailable,
		markHealthy,
		setCapability,
		isCapabilityEnabled,
		health,
		healthText: () => {
			const current = health();
			const adapters = current.adapters.map((item) => `${item.adapter}:${item.status}`).join(", ") || "none";
			const gates = current.capabilities.map((item) => `${item.capability}:${item.status}`).join(", ") || "none";
			return redactText(`adapters=${adapters}; capabilities=${gates}`, { maxLength: 512 });
		},
	};
}
