import {
	acquireMachineLease,
	type MachineLeaseHandle,
} from "./machine-lease.js";
import {
	credentialWarmingThresholdMs,
	type AllowedFamily,
	type MultiAccountConfig,
} from "./config.js";
import type { DiagnosticLog } from "./diagnostics.js";
import type { CredentialType } from "./discovery.js";

export interface WarmCandidate {
	readonly providerId: string;
	readonly family: AllowedFamily;
	/**
	 * Discovered credential type, carried so the usage fetcher can branch an
	 * `api_key` account to its unmeasured outcome before any OAuth call. Optional
	 * so existing construction sites and fixtures stay valid.
	 */
	readonly credentialType?: CredentialType;
	readonly expiresAtMs?: number;
}

export type CredentialWarmResolver = (providerId: string) => Promise<boolean>;

export interface WarmCycleResult {
	readonly holder: boolean;
	readonly attempted: readonly string[];
	readonly warmed: readonly string[];
	readonly unavailable: readonly string[];
}

export interface CredentialWarmerOptions {
	readonly lockPath: string;
	readonly leaseTtlMs?: number;
	readonly now?: () => number;
	readonly random?: () => number;
	readonly baseIntervalMs?: number;
	readonly jitterFraction?: number;
	/** Test harnesses can disable recursive timers while still exercising a cycle. */
	readonly scheduleBackground?: boolean;
	readonly resolveCredential: CredentialWarmResolver;
	readonly onUnavailable?: (candidate: WarmCandidate) => void;
	readonly onWarmed?: (candidate: WarmCandidate) => void;
	/** Runs while this cycle owns the machine lease; it must remain bounded. */
	readonly compactUnderLease?: (lease: MachineLeaseHandle) => void;
	readonly diagnostics?: DiagnosticLog;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_FRACTION = 0.2;

function boundedRandom(random: () => number): number {
	try {
		const value = random();
		return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5;
	} catch {
		return 0.5;
	}
}

/**
 * Runs Pi's public credential resolver under the machine-global lease. The
 * resolver returns only a boolean, so an access token cannot be retained,
 * logged, or returned by this module.
 */
export class CredentialWarmer {
	readonly #options: CredentialWarmerOptions;
	readonly #now: () => number;
	readonly #random: () => number;
	readonly #baseIntervalMs: number;
	readonly #jitterFraction: number;
	readonly #scheduleBackground: boolean;
	readonly #unavailable = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;

	constructor(options: CredentialWarmerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
		this.#baseIntervalMs = options.baseIntervalMs ?? DEFAULT_INTERVAL_MS;
		this.#jitterFraction = options.jitterFraction ?? DEFAULT_JITTER_FRACTION;
		this.#scheduleBackground = options.scheduleBackground ?? true;
		if (
			!Number.isFinite(this.#baseIntervalMs) ||
			this.#baseIntervalMs < 1_000
		) {
			throw new RangeError("warmer baseIntervalMs must be at least 1000 ms.");
		}
		if (
			!Number.isFinite(this.#jitterFraction) ||
			this.#jitterFraction < 0 ||
			this.#jitterFraction > 1
		) {
			throw new RangeError("warmer jitterFraction must be between 0 and 1.");
		}
	}

	async runCycle(
		candidates: readonly WarmCandidate[],
		config: MultiAccountConfig,
	): Promise<WarmCycleResult> {
		const empty: WarmCycleResult = {
			holder: false,
			attempted: [],
			warmed: [],
			unavailable: [],
		};
		let lease: MachineLeaseHandle | undefined;
		try {
			lease = acquireMachineLease({
				lockPath: this.#options.lockPath,
				...(this.#options.leaseTtlMs === undefined
					? {}
					: { ttlMs: this.#options.leaseTtlMs }),
				now: this.#now,
				// A contentless warming.lock left by a crash would otherwise disable
				// credential warming permanently and silently.
				reclaimMalformed: true,
			});
		} catch (error) {
			this.#options.diagnostics?.recordError("credential.warmer.lease", error);
			return empty;
		}
		if (!lease) return empty;

		try {
			this.#options.compactUnderLease?.(lease);
		} catch (error) {
			this.#options.diagnostics?.recordError(
				"credential.warmer.compact",
				error,
			);
		}
		const attempted: string[] = [];
		const warmed: string[] = [];
		const unavailable: string[] = [];
		try {
			const nowMs = this.#now();
			const thresholdMs = credentialWarmingThresholdMs(config);
			for (const candidate of candidates) {
				if (
					this.#unavailable.has(candidate.providerId) ||
					candidate.expiresAtMs === undefined ||
					!Number.isFinite(candidate.expiresAtMs) ||
					candidate.expiresAtMs - nowMs > thresholdMs
				)
					continue;
				if (!lease.renew()) break;
				attempted.push(candidate.providerId);
				let resolved = false;
				try {
					resolved =
						(await this.#options.resolveCredential(candidate.providerId)) ===
						true;
				} catch (error) {
					this.#options.diagnostics?.recordError(
						"credential.warmer.resolve",
						error,
					);
				}
				if (resolved) {
					warmed.push(candidate.providerId);
					this.#unavailable.delete(candidate.providerId);
					this.#options.onWarmed?.(candidate);
				} else {
					unavailable.push(candidate.providerId);
					this.#unavailable.add(candidate.providerId);
					this.#options.onUnavailable?.(candidate);
				}
			}
		} catch (error) {
			this.#options.diagnostics?.recordError("credential.warmer.cycle", error);
		} finally {
			lease.release();
		}
		return { holder: true, attempted, warmed, unavailable };
	}

	/** Forget terminal failures after rediscovery observes a new account state. */
	resetUnavailable(providerId?: string): void {
		if (providerId === undefined) this.#unavailable.clear();
		else this.#unavailable.delete(providerId);
	}

	/** Starts one leased cycle at a time; only the holder touches credentials. */
	async start(
		getCandidates: () => readonly WarmCandidate[],
		config: MultiAccountConfig,
	): Promise<WarmCycleResult> {
		this.#stopped = false;
		const result = await this.runCycle(getCandidates(), config);
		if (this.#scheduleBackground) this.#schedule(getCandidates, config);
		return result;
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(
		getCandidates: () => readonly WarmCandidate[],
		config: MultiAccountConfig,
	): void {
		if (this.#stopped || this.#timer !== undefined) return;
		const jitter = (boundedRandom(this.#random) * 2 - 1) * this.#jitterFraction;
		const delay = Math.max(
			1_000,
			Math.round(this.#baseIntervalMs * (1 + jitter)),
		);
		this.#timer = setTimeout(async () => {
			this.#timer = undefined;
			try {
				await this.runCycle(getCandidates(), config);
			} catch (error) {
				this.#options.diagnostics?.recordError(
					"credential.warmer.schedule",
					error,
				);
			}
			this.#schedule(getCandidates, config);
		}, delay);
		this.#timer.unref?.();
	}
}

export { credentialWarmingThresholdMs as warmerThresholdMs } from "./config.js";
