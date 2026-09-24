import type { ManagedFamily } from "./config.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";

const MAX_MODEL_ID_LENGTH = 256;

/** A bounded, process-local observation that one account cannot serve a model. */
export interface UnsupportedModelPair {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly modelId: string;
	readonly observedAtMs: number;
}

function assertPair(pair: UnsupportedModelPair): void {
	if (!isCanonicalManagedProviderId(pair.providerId, pair.family)) {
		throw new TypeError("providerId must be canonical for its managed family.");
	}
	if (
		typeof pair.modelId !== "string" ||
		pair.modelId.length === 0 ||
		pair.modelId.length > MAX_MODEL_ID_LENGTH
	) {
		throw new TypeError("modelId must be a bounded non-empty string.");
	}
	if (!Number.isFinite(pair.observedAtMs) || pair.observedAtMs < 0) {
		throw new TypeError(
			"observedAtMs must be a finite non-negative timestamp.",
		);
	}
}

function pairKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}

/**
 * Process-local support observations. Unknown pairings remain eligible: this
 * registry only excludes a pairing after the provider itself reports 404.
 */
export class ModelSupportRegistry {
	readonly #unsupported = new Map<string, UnsupportedModelPair>();

	markUnsupported(pair: UnsupportedModelPair): void {
		assertPair(pair);
		const key = pairKey(pair.providerId, pair.modelId);
		if (!this.#unsupported.has(key)) {
			this.#unsupported.set(key, Object.freeze({ ...pair }));
		}
	}

	isUnsupported(providerId: string, modelId: string): boolean {
		return this.#unsupported.has(pairKey(providerId, modelId));
	}

	isSupported(providerId: string, modelId: string): boolean {
		return !this.isUnsupported(providerId, modelId);
	}

	unsupported(): readonly UnsupportedModelPair[] {
		return [...this.#unsupported.values()];
	}

	clear(): void {
		this.#unsupported.clear();
	}
}
