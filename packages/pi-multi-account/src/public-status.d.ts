/**
 * Types for the public, read-only live account status contract
 * (`./public-status` subpath). The runtime is `public-status.js`, plain
 * JavaScript with no imports; this hand-written declaration file must export
 * exactly the same names (test/public-status.test.ts checks this) and, like
 * the runtime, has no imports.
 *
 * The wire shape is version 1 and is frozen: the query channel, the
 * `sourceVersion`, and the record and cost-estimate shapes must not change in
 * place. A new shape needs a new version.
 */

export declare const PUBLIC_ACCOUNT_STATUS_VERSION: "public-status-v1";

export declare const PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION: 1;
export declare const PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY: "pi-multi-account:public-status-service-query:v1";

/** The families the v1 consumer accepts. Other families are omitted. */
export type PublicAccountStatusFamily = "anthropic" | "openai-codex";

/** Coarse health, ordered most-severe first. */
export type PublicAccountHealth =
	| "unavailable"
	| "disabled"
	| "cooling"
	| "rate-limited"
	| "exhausted"
	| "low-headroom"
	| "ready";

export interface PublicAccountStatusRecord {
	readonly accountId: string;
	/** Operator-configured label, else the provider id. Never token-derived. */
	readonly label: string;
	readonly family: PublicAccountStatusFamily;
	readonly active: boolean;
	readonly health: PublicAccountHealth;
	readonly usageHeadroomPercent: number | null;
	readonly remainingRequests: number | null;
	readonly remainingTokens: number | null;
	readonly recoveryAt: number | null;
	readonly credentialExpiresAt: number | null;
	readonly fetchObservedAt: number | null;
	readonly fetchStale: boolean;
	readonly costEstimateIds: readonly string[];
}

export interface PublicCostEstimate {
	readonly estimateId: string;
	readonly accountId: string | null;
	readonly classification: "estimate-not-billing";
	readonly source: "pi-multi-account:api-equivalent-public-rates";
	readonly currency: "USD";
	readonly amount: number;
	readonly periodStart: number;
	readonly periodEnd: number;
	readonly observedAt: number;
}

export interface PublicAccountStatusSnapshot {
	readonly sourceVersion: typeof PUBLIC_ACCOUNT_STATUS_VERSION;
	readonly observedAtMs: number;
	readonly accounts: readonly PublicAccountStatusRecord[];
	readonly costEstimates: readonly PublicCostEstimate[];
}

export type PublicAccountStatusUnavailableReason =
	| "owner-unavailable"
	| "source-error";

export type PublicAccountStatusReadResult =
	| {
			readonly status: "available";
			readonly snapshot: PublicAccountStatusSnapshot;
	  }
	| {
			readonly status: "unavailable";
			readonly reason: PublicAccountStatusUnavailableReason;
	  };

export interface PublicAccountStatusReader {
	read(): Promise<PublicAccountStatusReadResult>;
}

export type PublicAccountStatusReaderDiscovery =
	| {
			readonly status: "available";
			readonly reader: PublicAccountStatusReader;
	  }
	| {
			readonly status: "unsupported";
	  };

/** Structurally compatible with Pi's `pi.events`. */
export interface PublicAccountStatusEventBus {
	emit(channel: string, payload: unknown): void;
	on(channel: string, handler: (payload: unknown) => void): () => void;
}

/**
 * Register the owner extension's read-only status service on Pi's shared event
 * transport. The callback owns the live state; this module neither stores
 * credentials nor creates a second account manager. A throwing callback reads
 * as `source-error` and its message never reaches the consumer.
 */
export declare function registerPublicAccountStatusService(
	events: Pick<PublicAccountStatusEventBus, "on">,
	read: () =>
		| PublicAccountStatusReadResult
		| Promise<PublicAccountStatusReadResult>,
): () => void;

/** Discover the optional live owner without treating absence as owner failure. */
export declare function discoverPublicAccountStatusReader(
	events: Pick<PublicAccountStatusEventBus, "emit">,
): PublicAccountStatusReaderDiscovery;
