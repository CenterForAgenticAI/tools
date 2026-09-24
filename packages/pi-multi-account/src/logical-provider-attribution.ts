/**
 * Physical attribution for turns served through the logical provider.
 *
 * Every attempt closes over one validated physical route. The exact terminal
 * assistant object is the only correlation key shared with `message_end`; no
 * latest-route cell or request identifier exists.
 */

import type { AssistantMessage, ProviderResponse } from "@earendil-works/pi-ai";
import { isManagedFamily } from "./config.js";
import type { ProviderFailureSignal } from "./error-classification.js";
import {
	NOOP_LOGICAL_ATTRIBUTION_ATTEMPT,
	type LogicalAttributionAttempt,
	type LogicalAttributionLifecycle,
	type LogicalAttributionResponse,
	type LogicalRouteFact,
	type LogicalTerminalFailureFact,
	type LogicalTerminalOutcome,
	type ManagedAssistantRecordOutcome,
} from "./logical-provider.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";
import { providerTypeFor, type ProviderType } from "./vendor.js";

export { NOOP_LOGICAL_ATTRIBUTION_ATTEMPT } from "./logical-provider.js";
export type {
	LogicalAttributionAttempt,
	LogicalAttributionLifecycle,
	LogicalAttributionResponse,
	LogicalRouteFact,
	LogicalTerminalOutcome,
	ManagedAssistantRecordOutcome,
} from "./logical-provider.js";

/** Bounded, sanitized output from the raw store. */
export type LogicalAttributionStoreObservation = Readonly<{
	kind: "response" | "authentication" | "model-support" | "health" | "payload" | "tokens" | "cost";
	route: LogicalRouteFact;
	status?: number;
	success?: boolean;
	supported?: boolean;
	health?: Readonly<{
		healthy?: boolean;
		live?: boolean;
		expiresAt?: number;
	}>;
	input?: number;
	output?: number;
	amount?: number;
}>;

export type AttributionDiagnostic = Readonly<{
	code: string;
	reason?: string;
	[key: string]: unknown;
}>;

export type AttributionStoreOptions = {
	onObservation?: (observation: LogicalAttributionStoreObservation) => void;
	onDiagnostic?: (diagnostic: AttributionDiagnostic) => void;
	onShutdownAbort?: (route: LogicalRouteFact) => void;
	/**
	 * Raw response is transient. Production must immediately project its headers
	 * into a bounded fact and RETURN it, so the store can bind that fact to this
	 * exact attempt and deliver it through {@link onAssociation}. Keying response
	 * facts only by physical provider let two concurrent attempts on one provider,
	 * or a stale-generation attempt, consume each other's response facts.
	 */
	onResponse?: (
		route: LogicalRouteFact,
		response: ProviderResponse,
	) => ProviderFailureSignal | void;
	/** Complete terminal message is transient. Production must project it immediately. */
	onTerminal?: (
		route: LogicalRouteFact,
		message: AssistantMessage,
	) => void | Promise<ManagedAssistantRecordOutcome>;
	/** Exact-object association is transient and consumed by the session coordinator. */
	onAssociation?: (
		route: LogicalRouteFact,
		message: AssistantMessage,
		outcome: TerminalOutcome,
		failure: LogicalTerminalFailureFact | undefined,
		/** Bounded response fact bound to THIS attempt, never keyed by provider. */
		response: ProviderFailureSignal | undefined,
	) => void;
	onSettle?: () => void;
	onShutdownComplete?: () => void;
};

export type LogicalHistoryResult =
	| { readonly status: "accepted"; readonly cleaned: true }
	| { readonly status: "not-found"; readonly cleaned: false };

export type AttributionStore = LogicalAttributionLifecycle & {
	messageEnd(message: AssistantMessage): Promise<LogicalHistoryResult>;
	/** Rejects only active, not-yet-terminal attempts; owned terminal history remains valid. */
	cancelActiveAttempts(): void;
	recordDiagnostic(diagnostic: unknown): void;
	activeAttempts(): number;
	snapshot(): unknown;
	drain(): unknown;
};

const MAX_TERMINAL_RECORDS = 64;
const MAX_PENDING_TERMINAL_WRITES = 64;
const MAX_EMITTED_RECORDS = 256;
const MAX_DIAGNOSTICS = 64;

function pushBounded<T>(into: T[], value: T, limit: number): void {
	into.push(value);
	if (into.length > limit) into.splice(0, into.length - limit);
}

function isManagedProviderType(
	value: unknown,
): value is Exclude<ProviderType, "openrouter"> {
	return value === "subscription" || value === "owning-vendor-api";
}

function providerTypeMatchesFamily(
	family: LogicalRouteFact["family"],
	providerType: Exclude<ProviderType, "openrouter">,
): boolean {
	return (
		providerTypeFor(
			family,
			providerType === "owning-vendor-api" ? "api_key" : "oauth",
		) === providerType
	);
}

/** Validate identity first, then project only the permitted route fields. */
export function canonicalAttributionRoute(
	route: LogicalRouteFact,
): LogicalRouteFact | undefined {
	if (typeof route !== "object" || route === null) return undefined;
	const candidate = route as unknown as Record<string, unknown>;
	const providerId = candidate.providerId;
	const family = candidate.family;
	const providerType = candidate.providerType;
	const accountFingerprint = candidate.accountFingerprint;
	if (
		typeof providerId !== "string" ||
		typeof family !== "string" ||
		!isManagedFamily(family) ||
		!isManagedProviderType(providerType) ||
		typeof accountFingerprint !== "string"
	) {
		return undefined;
	}
	if (!providerTypeMatchesFamily(family, providerType)) return undefined;
	if (!isCanonicalManagedProviderId(providerId, family)) return undefined;
	if (accountFingerprint !== providerId) return undefined;
	return Object.freeze({
		providerId,
		family,
		providerType,
		accountFingerprint: providerId,
	});
}

type TerminalOutcome = "finish" | "fail" | "abort";

type AttemptRecord = {
	readonly route: LogicalRouteFact;
	readonly generation: number;
	active: boolean;
	terminalOutcome?: TerminalOutcome;
	terminalBarrier?: Promise<LogicalTerminalOutcome>;
	/** Latest bounded response fact observed for THIS attempt, retired with it. */
	responseFact?: ProviderFailureSignal;
};

type TerminalRecord = Readonly<{
	route: LogicalRouteFact;
	outcome: TerminalOutcome;
}>;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectedHealth(value: unknown): LogicalAttributionStoreObservation["health"] {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	const healthy = typeof candidate.healthy === "boolean" ? candidate.healthy : undefined;
	const live = typeof candidate.live === "boolean" ? candidate.live : undefined;
	const expiresAt = finiteNumber(candidate.expiresAt);
	if (healthy === undefined && live === undefined && expiresAt === undefined) {
		return undefined;
	}
	return Object.freeze({
		...(healthy === undefined ? {} : { healthy }),
		...(live === undefined ? {} : { live }),
		...(expiresAt === undefined ? {} : { expiresAt }),
	});
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { role?: unknown }).role === "assistant"
	);
}

const createAssistantAssociations = () =>
	new WeakMap<AssistantMessage, AttemptRecord>();

/** Build one reusable raw attribution store. Session permanence is added outside. */
export function createAttributionStore(
	options: AttributionStoreOptions = {},
): AttributionStore {
	let generation = 0;
	const attemptRecords = new Set<AttemptRecord>();
	let assistantAssociations = createAssistantAssociations();
	let publicTerminals = new WeakMap<AssistantMessage, AssistantMessage>();
	let publishedPhysical = new WeakSet<AssistantMessage>();
	let terminalOwners = new WeakMap<AssistantMessage, AttemptRecord>();
	let terminalRecords: TerminalRecord[] = [];
	let emittedRecords: LogicalAttributionStoreObservation[] = [];
	let pendingTerminalWrites = 0;
	let diagnosticCount = 0;
	let invalidRouteDiagnosed = false;
	let emittingDiagnostic = false;

	const callbackFailureDiagnostic = (error: unknown): AttributionDiagnostic =>
		Object.freeze({
			code: "attribution.callback-failed",
			reason: "attribution.callback-failed",
		});

	const attributionDiagnostic = (diagnostic: AttributionDiagnostic): void => {
		if (diagnosticCount >= MAX_DIAGNOSTICS) return;
		diagnosticCount += 1;
		emittingDiagnostic = true;
		try {
			safeAttributionCall(() => options.onDiagnostic?.(diagnostic));
		} finally {
			emittingDiagnostic = false;
		}
	};

	const safeAttributionCall = (
		call: () => void | Promise<void>,
	): void | Promise<void> => {
		try {
			const result = call();
			if (result instanceof Promise) {
				return result.catch((error: unknown) => {
					if (!emittingDiagnostic) {
						attributionDiagnostic(callbackFailureDiagnostic(error));
					}
				});
			}
			return undefined;
		} catch (error) {
			if (!emittingDiagnostic) {
				attributionDiagnostic(callbackFailureDiagnostic(error));
			}
			return undefined;
		}
	};

	const safeTerminalCall = (
		route: LogicalRouteFact,
		message: AssistantMessage,
	): Promise<LogicalTerminalOutcome> => {
		try {
			const result = options.onTerminal?.(route, message);
			if (result === undefined) return Promise.resolve({ status: "not-attempted" });
			return Promise.resolve(result).then(
				(value) =>
					typeof value === "object" && value !== null &&
						(value as { status?: unknown }).status === "retained"
						? { status: "retained" }
						: { status: "failed" },
				(error: unknown) => {
					attributionDiagnostic(callbackFailureDiagnostic(error));
					return { status: "failed" };
				},
			);
		} catch (error) {
			attributionDiagnostic(callbackFailureDiagnostic(error));
			return Promise.resolve({ status: "failed" });
		}
	};

	const observe = (observation: LogicalAttributionStoreObservation): void => {
		pushBounded(emittedRecords, observation, MAX_EMITTED_RECORDS);
		safeAttributionCall(() => options.onObservation?.(observation));
	};

	const isCurrent = (record: AttemptRecord): boolean =>
		record.generation === generation;

	const beginAttempt = (route: LogicalRouteFact): LogicalAttributionAttempt => {
		const canonicalRoute = canonicalAttributionRoute(route);
		if (canonicalRoute === undefined) {
			if (!invalidRouteDiagnosed) {
				invalidRouteDiagnosed = true;
				attributionDiagnostic({ code: "attribution.invalid-route" });
			}
			return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
		}
		const attemptGeneration = generation;
		const record: AttemptRecord = {
			route: canonicalRoute,
			generation: attemptGeneration,
			active: true,
		};
		attemptRecords.add(record);

		const terminal =
			(outcome: TerminalOutcome) =>
			(
				message: AssistantMessage,
				failure?: LogicalTerminalFailureFact,
			): boolean => {
				if (!isCurrent(record) || !isAssistantMessage(message)) return false;
				if (record.terminalOutcome !== undefined) {
					return record.terminalOutcome === outcome;
				}
				if (!record.active) return false;
				const terminalOwner = terminalOwners.get(message);
				record.terminalOutcome = outcome;
				record.active = false;
				if (terminalOwner === undefined) {
					terminalOwners.set(message, record);
					assistantAssociations.set(message, record);
					if (pendingTerminalWrites >= MAX_PENDING_TERMINAL_WRITES) {
						attributionDiagnostic({ code: "attribution.terminal-capacity" });
						record.terminalBarrier = Promise.resolve({ status: "not-attempted-capacity" });
					} else {
						pendingTerminalWrites += 1;
						let resolveBarrier!: (result: LogicalTerminalOutcome) => void;
						const barrier = new Promise<LogicalTerminalOutcome>((resolve) => {
							resolveBarrier = resolve;
						});
						// Install the shared barrier before invoking any external callback so
						// a reentrant second attempt cannot observe a half-owned terminal. The
						// callback itself still starts synchronously, before the terminal yields.
						record.terminalBarrier = barrier.finally(() => {
							pendingTerminalWrites -= 1;
						});
						void safeTerminalCall(record.route, message).then(resolveBarrier);
					}
				} else {
					// Exact-object ambiguity must still reach onAssociation so routing can
					// fail closed, but the first owner remains authoritative for both
					// accounting and history. Every claimant awaits the same barrier.
					record.terminalBarrier =
						terminalOwner.terminalBarrier ??
						Promise.resolve({ status: "not-attempted" });
				}
				let associationAccepted = true;
				try {
					options.onAssociation?.(
						record.route,
						message,
						outcome,
						failure,
						record.responseFact,
					);
				} catch (error) {
					associationAccepted = false;
					attributionDiagnostic(callbackFailureDiagnostic(error));
				}
				pushBounded(
					terminalRecords,
					Object.freeze({ route: record.route, outcome }),
					MAX_TERMINAL_RECORDS,
				);
				attemptRecords.delete(record);
				return associationAccepted;
			};

		return Object.freeze({
			onResponse: (response: LogicalAttributionResponse): void => {
				if (!isCurrent(record) || !record.active) return;
				const status = finiteNumber(response?.status);
				observe(Object.freeze({
					kind: "response",
					route: record.route,
					...(status === undefined ? {} : { status }),
				}));
				if (status !== undefined) {
					// Capture the projected fact on THIS attempt record so the terminal
					// association carries the response fact bound to the exact attempt,
					// never one keyed by physical provider that a concurrent or stale
					// attempt could overwrite.
					try {
						const fact = options.onResponse?.(
							record.route,
							response as ProviderResponse,
						);
						if (fact !== undefined && fact !== null) record.responseFact = fact;
					} catch (error) {
						attributionDiagnostic(callbackFailureDiagnostic(error));
					}
				}
			},
			onAuthentication: (success: boolean): void => {
				if (!isCurrent(record) || !record.active || typeof success !== "boolean") return;
				observe(Object.freeze({ kind: "authentication", route: record.route, success }));
			},
			onModelSupport: (supported: boolean): void => {
				if (!isCurrent(record) || !record.active || typeof supported !== "boolean") return;
				observe(Object.freeze({ kind: "model-support", route: record.route, supported }));
			},
			onHealth: (health: unknown): void => {
				if (!isCurrent(record) || !record.active) return;
				const projected = projectedHealth(health);
				observe(Object.freeze({
					kind: "health",
					route: record.route,
					...(projected === undefined ? {} : { health: projected }),
				}));
			},
			onPayload: (_payload: unknown): void => {
				if (!isCurrent(record) || !record.active) return;
				observe(Object.freeze({ kind: "payload", route: record.route }));
			},
			finish: terminal("finish"),
			fail: terminal("fail"),
			abort: terminal("abort"),
			waitForTerminal: (): Promise<LogicalTerminalOutcome> =>
				record.terminalBarrier ?? Promise.resolve({ status: "not-attempted" }),
			bindPublicTerminal: (physical: AssistantMessage, publicMessage: AssistantMessage): void => {
				if (!isCurrent(record) || terminalOwners.get(physical) !== record ||
					!assistantAssociations.has(physical) || publicTerminals.has(publicMessage)) return;
				publicTerminals.set(publicMessage, physical);
				publishedPhysical.add(physical);
			},
		});
	};

	const messageEnd = async (message: AssistantMessage): Promise<LogicalHistoryResult> => {
		const physical = publicTerminals.get(message) ?? message;
		if (physical === message && publishedPhysical.has(message)) {
			return { status: "not-found", cleaned: false };
		}
		const record = assistantAssociations.get(physical);
		if (record === undefined || record.generation !== generation) {
			return { status: "not-found", cleaned: false };
		}
		// Reserve the exact physical owner before the writer barrier yields control.
		assistantAssociations.delete(physical);
		publicTerminals.delete(message);
		try {
			await (record.terminalBarrier ?? Promise.resolve({ status: "not-attempted" }));
			let input: number | undefined;
			let output: number | undefined;
			let amount: number | undefined;
			try {
				input = finiteNumber(physical.usage.input);
				output = finiteNumber(physical.usage.output);
				amount = finiteNumber(physical.usage.cost.total);
			} catch {
				// A malformed terminal object cannot escape the fail-soft boundary.
			}
			if (input !== undefined || output !== undefined) {
				observe(Object.freeze({
					kind: "tokens",
					route: record.route,
					...(input === undefined ? {} : { input }),
					...(output === undefined ? {} : { output }),
				}));
			}
			if (amount !== undefined) {
				observe(Object.freeze({ kind: "cost", route: record.route, amount }));
			}
			return { status: "accepted", cleaned: true };
		} finally {
			assistantAssociations.delete(physical);
			publicTerminals.delete(message);
		}
	};

	return {
		beginAttempt,
		messageEnd,

		cancelActiveAttempts: (): void => {
			for (const record of attemptRecords) {
				if (!isCurrent(record) || !record.active) continue;
				record.active = false;
				attemptRecords.delete(record);
			}
		},

		recordDiagnostic: (diagnostic: unknown): void => {
			attributionDiagnostic(callbackFailureDiagnostic(diagnostic));
		},

		settle: (): void => {
			generation += 1;
			attemptRecords.clear();
			assistantAssociations = createAssistantAssociations();
			publicTerminals = new WeakMap<AssistantMessage, AssistantMessage>();
			publishedPhysical = new WeakSet<AssistantMessage>();
			terminalOwners = new WeakMap<AssistantMessage, AttemptRecord>();
			safeAttributionCall(() => options.onSettle?.());
		},

		shutdown: (): void => {
			try {
				generation += 1;
				for (const record of attemptRecords) {
					if (record.active) {
						safeAttributionCall(() => options.onShutdownAbort?.(record.route));
					}
				}
				attemptRecords.clear();
				assistantAssociations = createAssistantAssociations();
				publicTerminals = new WeakMap<AssistantMessage, AssistantMessage>();
				publishedPhysical = new WeakSet<AssistantMessage>();
				terminalOwners = new WeakMap<AssistantMessage, AttemptRecord>();
				terminalRecords = [];
				emittedRecords = [];
				invalidRouteDiagnosed = false;
			} finally {
				safeAttributionCall(() => options.onShutdownComplete?.());
			}
		},

		activeAttempts: (): number => {
			let active = 0;
			for (const record of attemptRecords) {
				if (record.active && record.generation === generation) active += 1;
			}
			return active;
		},

		snapshot: () => ({ terminal: [...terminalRecords] }),

		drain: () => {
			const drained = emittedRecords;
			emittedRecords = [];
			return drained;
		},
	};
}
