import { normalizeLabel } from "./account-labels.js";
import type { ManagedFamily } from "./config.js";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";

export type LogicalRouteIndicatorPhase =
	| "waiting"
	| "trying"
	| "completed"
	| "failed"
	| "cancelled";

export type LogicalRouteIndicatorRoute = Readonly<{
	providerId: string;
	family: ManagedFamily;
}>;

export type LogicalRouteUsage =
	| Readonly<{
			status: "fresh";
			utilization?: number;
			remainingRequests?: number;
			remainingTokens?: number;
			recoveryAtMs?: number;
	  }>
	| Readonly<{ status: "stale" }>
	| Readonly<{ status: "missing" }>;

export interface LogicalRouteIndicatorAttempt {
	completed(): void;
	failed(): void;
	cancelled(): void;
}

export interface LogicalRouteIndicator {
	modelSelected(providerId: string | undefined): void;
	beginAttempt(route: LogicalRouteIndicatorRoute): LogicalRouteIndicatorAttempt;
	usageChanged(providerId: string): void;
	settle(): void;
	shutdown(): void;
}

export interface LogicalRouteIndicatorDependencies {
	publish(text: string | undefined): void;
	usage(providerId: string, nowMs: number): LogicalRouteUsage;
	configuredLabel(providerId: string): string | undefined;
	now(): number;
}

type DisplayedAttempt = Readonly<{
	phase: Exclude<LogicalRouteIndicatorPhase, "waiting">;
	route: LogicalRouteIndicatorRoute;
}>;

const NOOP_ATTEMPT: LogicalRouteIndicatorAttempt = Object.freeze({
	completed() {},
	failed() {},
	cancelled() {},
});

function validUtilization(value: number | undefined): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function validCount(value: number | undefined): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compactCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) {
		const thousands = value / 1_000;
		return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
	}
	const millions = value / 1_000_000;
	return `${millions < 100 ? millions.toFixed(1) : Math.round(millions)}M`;
}

function compactDuration(milliseconds: number): string {
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (milliseconds < hour) return `${Math.max(1, Math.ceil(milliseconds / minute))}m`;
	if (milliseconds < 48 * hour) return `${Math.ceil(milliseconds / hour)}h`;
	return `${Math.ceil(milliseconds / day)}d`;
}

function usageText(usage: LogicalRouteUsage, nowMs: number): string {
	if (usage.status === "missing") return "usage unknown";
	if (usage.status === "stale") return "usage stale";

	const parts: string[] = [];
	if (validUtilization(usage.utilization)) {
		parts.push(`${Math.round((1 - usage.utilization) * 100)}% left`);
	} else {
		if (validCount(usage.remainingRequests)) {
			parts.push(`${compactCount(usage.remainingRequests)} req left`);
		}
		if (validCount(usage.remainingTokens)) {
			parts.push(`${compactCount(usage.remainingTokens)} tok left`);
		}
	}
	if (parts.length === 0) return "usage stale";
	if (
		typeof usage.recoveryAtMs === "number" &&
		Number.isFinite(usage.recoveryAtMs) &&
		usage.recoveryAtMs > nowMs
	) {
		parts.push(`resets in ${compactDuration(usage.recoveryAtMs - nowMs)}`);
	}
	return parts.join(" · ");
}

/** Creates one host-neutral route indicator for one extension session. */
export function createLogicalRouteIndicator(
	dependencies: LogicalRouteIndicatorDependencies,
): LogicalRouteIndicator {
	let generation = 0;
	let logicalSelected = false;
	let displayed: "waiting" | DisplayedAttempt | undefined;

	const publish = (text: string | undefined): void => {
		try {
			dependencies.publish(text);
		} catch {
			// The widget is observational; its sink cannot affect provider lifecycle.
		}
	};

	const render = (): void => {
		if (!logicalSelected || displayed === undefined) {
			publish(undefined);
			return;
		}
		if (displayed === "waiting") {
			publish("unified(waiting)");
			return;
		}
		const nowMs = dependencies.now();
		let usage: LogicalRouteUsage = { status: "missing" };
		try {
			usage = dependencies.usage(displayed.route.providerId, nowMs);
		} catch {
			// A display projection failure is unknown usage, never a routing failure.
		}
		let label: string | undefined;
		try {
			label = normalizeLabel(
				dependencies.configuredLabel(displayed.route.providerId),
			);
		} catch {
			// Labels are optional presentation data.
		}
		publish(
			`unified(${displayed.route.providerId} · ${usageText(usage, nowMs)}` +
				(label === undefined ? ")" : ` · ${label})`),
		);
	};

	return {
		modelSelected(providerId) {
			generation += 1;
			logicalSelected = providerId === LOGICAL_PROVIDER_ID;
			displayed = logicalSelected ? "waiting" : undefined;
			render();
		},
		beginAttempt(route) {
			const attemptGeneration = generation;
			if (!logicalSelected) return NOOP_ATTEMPT;
			const attemptRoute: LogicalRouteIndicatorRoute = Object.freeze({
				providerId: route.providerId,
				family: route.family,
			});
			displayed = { phase: "trying", route: attemptRoute };
			render();
			const settleAttempt = (phase: DisplayedAttempt["phase"]): void => {
				if (!logicalSelected || generation !== attemptGeneration) return;
				displayed = { phase, route: attemptRoute };
				render();
			};
			return {
				completed: () => settleAttempt("completed"),
				failed: () => settleAttempt("failed"),
				cancelled: () => settleAttempt("cancelled"),
			};
		},
		usageChanged(providerId) {
			if (
				!logicalSelected ||
				typeof displayed !== "object" ||
				displayed.route.providerId !== providerId
			) {
				return;
			}
			render();
		},
		settle() {
			generation += 1;
			if (typeof displayed === "object" && displayed.phase === "trying") {
				displayed = { phase: "failed", route: displayed.route };
				render();
			}
		},
		shutdown() {
			generation += 1;
			logicalSelected = false;
			displayed = undefined;
			publish(undefined);
		},
	};
}
