import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	parseOpenRouterRateSnapshot,
	parseStoredApiRateSnapshot,
	type ApiRateSnapshot,
} from "./api-pricing.js";
import { acquireMachineLease } from "./machine-lease.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const PRICING_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const PRICING_FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CACHE_BYTES = 1_000_000;

interface PricingFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}

type PricingFetch = (
	url: string,
	init?: RequestInit,
) => Promise<PricingFetchResponse>;

export type PricingCacheResult =
	| { readonly state: "fresh"; readonly snapshot: ApiRateSnapshot }
	| {
			readonly state: "stale";
			readonly snapshot: ApiRateSnapshot;
			readonly reason: "expired" | "refresh-failed" | "lease-held";
	  }
	| {
			readonly state: "unavailable";
			readonly reason: "cache-miss" | "refresh-failed" | "lease-held";
	  };

export function defaultPricingCachePaths(): {
	readonly cachePath: string;
	readonly lockPath: string;
} {
	const agentDirectory =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const directory = join(agentDirectory, "pi-multi-account");
	return {
		cachePath: join(directory, "api-pricing.json"),
		lockPath: join(directory, "api-pricing.lock"),
	};
}

function writeSnapshot(cachePath: string, snapshot: ApiRateSnapshot): void {
	const raw = `${JSON.stringify(snapshot)}\n`;
	if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
		throw new RangeError("API rate snapshot exceeds the cache size limit.");
	}
	const directory = dirname(cachePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporaryPath = join(
		directory,
		`.${basename(cachePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, raw, { encoding: "utf8" });
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, cachePath);
		chmodSync(cachePath, 0o600);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the original write failure.
			}
		}
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The rename may already have consumed the temporary path.
		}
		throw error;
	}
}

function readSnapshot(cachePath: string): ApiRateSnapshot | undefined {
	try {
		const stats = statSync(cachePath);
		if (!stats.isFile() || stats.size < 1 || stats.size > MAX_CACHE_BYTES) {
			return undefined;
		}
		return parseStoredApiRateSnapshot(
			JSON.parse(readFileSync(cachePath, "utf8")) as unknown,
		);
	} catch {
		return undefined;
	}
}

function withReason(
	current: PricingCacheResult,
	reason: "refresh-failed" | "lease-held",
): PricingCacheResult {
	return current.state === "fresh"
		? current
		: current.state === "stale"
			? { state: "stale", snapshot: current.snapshot, reason }
			: { state: "unavailable", reason };
}

export class OpenRouterPricingCache {
	readonly #cachePath: string;
	readonly #lockPath: string;
	readonly #fetchImpl: PricingFetch;
	readonly #now: () => number;
	readonly #refreshIntervalMs: number;
	readonly #timeoutMs: number;

	constructor(options: {
		readonly cachePath: string;
		readonly lockPath: string;
		readonly fetchImpl?: PricingFetch;
		readonly now?: () => number;
		readonly refreshIntervalMs?: number;
		readonly timeoutMs?: number;
	}) {
		this.#cachePath = options.cachePath;
		this.#lockPath = options.lockPath;
		this.#fetchImpl =
			options.fetchImpl ??
			((url, init) => {
				if (process.env.VITEST === "true") {
					return Promise.reject(new Error("network disabled in tests"));
				}
				if (url !== OPENROUTER_MODELS_URL) {
					return Promise.reject(new Error("pricing URL is not allowlisted"));
				}
				return globalThis.fetch(url, init);
			});
		this.#now = options.now ?? Date.now;
		this.#refreshIntervalMs =
			options.refreshIntervalMs ?? PRICING_REFRESH_INTERVAL_MS;
		this.#timeoutMs = options.timeoutMs ?? PRICING_FETCH_TIMEOUT_MS;
		if (
			!Number.isFinite(this.#refreshIntervalMs) ||
			this.#refreshIntervalMs <= 0 ||
			!Number.isFinite(this.#timeoutMs) ||
			this.#timeoutMs <= 0
		) {
			throw new RangeError("Pricing cache intervals must be finite and positive.");
		}
	}

	readStatus(): PricingCacheResult {
		const snapshot = readSnapshot(this.#cachePath);
		if (snapshot === undefined) {
			return { state: "unavailable", reason: "cache-miss" };
		}
		const ageMs = this.#now() - snapshot.fetchedAtMs;
		return ageMs >= 0 && ageMs <= this.#refreshIntervalMs
			? { state: "fresh", snapshot }
			: { state: "stale", snapshot, reason: "expired" };
	}

	async #fetchSnapshot(): Promise<ApiRateSnapshot> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const response = await this.#fetchImpl(OPENROUTER_MODELS_URL, {
				method: "GET",
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error("pricing endpoint failed");
			const raw = await response.text();
			if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
				throw new RangeError("pricing response exceeds the size limit");
			}
			const snapshot = parseOpenRouterRateSnapshot(
				JSON.parse(raw) as unknown,
				this.#now(),
			);
			if (Object.keys(snapshot.rates).length === 0) {
				throw new TypeError("pricing response has no managed model rates");
			}
			return snapshot;
		} finally {
			clearTimeout(timeout);
		}
	}

	async refreshIfNeeded(): Promise<PricingCacheResult> {
		const initial = this.readStatus();
		if (initial.state === "fresh") return initial;
		const lease = acquireMachineLease({
			lockPath: this.#lockPath,
			ttlMs: Math.max(30_000, this.#timeoutMs * 2),
			now: this.#now,
			// A wedged lock would otherwise freeze pricing at its last snapshot.
			reclaimMalformed: true,
		});
		if (lease === undefined) return withReason(initial, "lease-held");
		try {
			const afterLease = this.readStatus();
			if (afterLease.state === "fresh") return afterLease;
			try {
				const snapshot = await this.#fetchSnapshot();
				writeSnapshot(this.#cachePath, snapshot);
				return { state: "fresh", snapshot };
			} catch {
				return withReason(afterLease, "refresh-failed");
			}
		} finally {
			lease.release();
		}
	}
}
