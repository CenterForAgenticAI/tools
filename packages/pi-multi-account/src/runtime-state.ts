import { isManagedFamily, type ManagedFamily } from "./config.js";
import {
	classifyAccountIdentity,
	shouldClearAccountState,
} from "./credential-lifecycle.js";

/** Numeric revision exposed by maintained, non-secret public credential metadata. */
export type CredentialRevision = number;

export type CooldownReason =
	| "quota"
	| "rate-limit"
	| "auth-transient"
	| "permission"
	| "transport"
	| "unknown";

export interface NumericServerHint {
	readonly retryAfterSeconds?: number;
	readonly resetAtMs?: number;
}

export interface CooldownRecord {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly reason: CooldownReason;
	readonly untilMs: number;
	readonly serverHint?: NumericServerHint;
}

export interface InvalidatedAccount {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly reason: "terminal-auth-failure";
	readonly invalidatedAtMs: number;
}

export type ContinuationRoutingReason =
	| "quota"
	| "rate-limit"
	| "terminal-auth-failure"
	| "permission"
	| "model-not-found"
	| "metered-last-resort";

/** Managed account family or the one explicitly permitted metered bridge. */
export type ContinuationDestinationFamily = ManagedFamily | "openrouter";

/** One session-local, one-shot destination for the next unified dispatch. */
export interface LogicalRoutePin {
	readonly generation: number;
	readonly destinationProviderId: string;
	readonly destinationFamily: ManagedFamily;
	readonly requestedModelId: string;
}

export type LogicalRoutePinInput = Omit<LogicalRoutePin, "generation">;

const runtimeReferenceBrand: unique symbol = Symbol("RuntimeReference");

/**
 * How long limit errors stay relevant when judging whether a usage snapshot is
 * lying. Matches the Sarrius reference (`index.ts:581`, verified 2026-08-05),
 * whose comment records the failure this prevents: "Trusting usage as ground
 * truth then reports the account 'free now', schedules a ~1s retry, gets 429
 * again, and loops."
 */
export const LIMIT_STREAK_WINDOW_MS = 15 * 60 * 1000;

/**
 * Limit errors required inside the window before the usage snapshot is
 * distrusted. TWO, per Sarrius `index.ts:579-580` and `:2258-2265`: one 429 is
 * ordinary under concurrency and the plain cooldown already covers it, so a
 * single sample must not shrink the usable fleet.
 */
export const LIMIT_STREAK_TRUST_THRESHOLD = 2;

/** Process-local identity minted by one RuntimeState without caller content. */
export type RuntimeReference = Readonly<{
	readonly localId: string;
	readonly [runtimeReferenceBrand]: true;
}>;

/**
 * Content-free exactly-once marker. References are state-minted local identities;
 * neither a host identifier nor prompt/message content belongs here.
 */
export interface ContinuationGuard {
	readonly failedTurnRef: RuntimeReference;
	readonly destinationProviderId: string;
	readonly destinationFamily: ContinuationDestinationFamily;
	readonly routingReason: ContinuationRoutingReason;
	readonly guardSetAtMs: number;
}

export interface WatchdogSnapshot {
	readonly continuationTurnRef: RuntimeReference;
	readonly dispatchedAtMs: number;
	readonly lastProgressAtMs: number;
	readonly toolRunning: boolean;
}

/** A queue marker uses a state-minted identity and retains no host input. */
export interface QueuedInputReference {
	readonly inputRef: RuntimeReference;
	readonly queuedAtMs: number;
}

export interface RuntimeStateSnapshot {
	readonly cooldowns: readonly CooldownRecord[];
	readonly invalidatedAccounts: readonly InvalidatedAccount[];
	readonly continuationGuards: readonly ContinuationGuard[];
	readonly watchdogs: readonly WatchdogSnapshot[];
	readonly queuedInputs: readonly QueuedInputReference[];
	readonly inputPaused: boolean;
}

export function isCanonicalManagedProviderId(
	providerId: string,
	family: ManagedFamily,
): boolean {
	if (!isManagedFamily(family)) return false;
	if (providerId === family) return true;
	const prefix = `${family}-account-`;
	if (!providerId.startsWith(prefix)) return false;
	const suffix = providerId.slice(prefix.length);
	if (!/^[1-9]\d*$/.test(suffix)) return false;
	const slotIndex = Number(suffix);
	return Number.isSafeInteger(slotIndex) && slotIndex >= 2;
}

function assertManagedProviderId(
	providerId: string,
	family: ManagedFamily,
): void {
	if (!isCanonicalManagedProviderId(providerId, family)) {
		throw new TypeError("providerId must be canonical for its managed family.");
	}
}

function projectServerHint(
	hint: NumericServerHint | undefined,
): NumericServerHint | undefined {
	if (hint === undefined) return undefined;
	const projected: { retryAfterSeconds?: number; resetAtMs?: number } = {};
	if (hint.retryAfterSeconds !== undefined) {
		projected.retryAfterSeconds = hint.retryAfterSeconds;
	}
	if (hint.resetAtMs !== undefined) projected.resetAtMs = hint.resetAtMs;
	return Object.freeze(projected);
}

function assertTimestamp(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a finite non-negative timestamp.`);
	}
}

/**
 * Entirely process-local routing state. It intentionally has no persistence,
 * generic metadata bag, raw error field, or content-bearing queue field.
 */
export class RuntimeState {
	readonly #cooldowns = new Map<string, CooldownRecord>();
	readonly #invalidatedAccounts = new Map<string, InvalidatedAccount>();
	/**
	 * Limit-error timestamps per provider, newest last, used to distrust a usage
	 * snapshot the provider itself contradicts.
	 *
	 * WHY THIS EXISTS. The usage endpoint tracks the QUOTA window and cannot see a
	 * SESSION limit, so an account can report `utilization: 0` while every request
	 * returns 429. Observed live on 2026-08-05: base `anthropic` held
	 * `{utilization: 0, utilizationSource: "usage-endpoint"}` refreshed 4.7 minutes
	 * earlier while the operator was taking a 429 on every attempt, and the
	 * operator surface truthfully rendered "limits: 0% used". Selection therefore
	 * kept choosing the one account the provider was refusing.
	 */
	readonly #limitErrors = new Map<string, number[]>();
	readonly #credentialRevisions = new Map<string, CredentialRevision>();
	/** Stable account fingerprint per slot; absent when it cannot be derived. */
	readonly #accountIdentities = new Map<string, string>();
	readonly #continuationGuards = new Map<RuntimeReference, ContinuationGuard>();
	readonly #watchdogs = new Map<RuntimeReference, WatchdogSnapshot>();
	readonly #queuedInputs = new Map<RuntimeReference, QueuedInputReference>();
	readonly #issuedReferences = new Set<RuntimeReference>();
	#referenceCounter = 0;
	#logicalRoutePinGeneration = 0;
	#logicalRoutePin: LogicalRoutePin | undefined;
	#inputPaused = false;

	/** Mints an identity from local state only; no caller value can enter it. */
	mintReference(): RuntimeReference {
		const next = this.#referenceCounter + 1;
		if (!Number.isSafeInteger(next)) {
			throw new RangeError(
				"runtime reference counter exhausted safe integers.",
			);
		}
		const reference: RuntimeReference = Object.freeze({
			localId: `runtime-ref-${next}`,
			[runtimeReferenceBrand]: true as const,
		});
		this.#referenceCounter = next;
		this.#issuedReferences.add(reference);
		return reference;
	}

	setCooldown(record: CooldownRecord): void {
		assertManagedProviderId(record.providerId, record.family);
		assertTimestamp(record.untilMs, "untilMs");
		const serverHint = projectServerHint(record.serverHint);
		this.#cooldowns.set(
			record.providerId,
			Object.freeze({
				providerId: record.providerId,
				family: record.family,
				reason: record.reason,
				untilMs: record.untilMs,
				...(serverHint === undefined ? {} : { serverHint }),
			}),
		);
	}

	/**
	 * Runs one synchronous cooldown write set and returns an ownership-aware undo.
	 * The closure retains only canonical ids and cooldown records, never messages,
	 * credentials, fingerprints, or other caller objects.
	 */
	runReversibleCooldownMutation<T>(
		providerIds: readonly string[],
		mutate: () => T,
	): { readonly value: T; readonly rollback: () => void } {
		const ids = [...new Set(providerIds)];
		for (const providerId of ids) {
			if (typeof providerId !== "string" || providerId.length === 0) {
				throw new TypeError("providerIds must contain non-empty strings.");
			}
		}
		const before = new Map(
			ids.map((providerId) => [providerId, this.#cooldowns.get(providerId)]),
		);
		let value: T;
		try {
			value = mutate();
		} catch (error) {
			for (const providerId of ids) {
				const previous = before.get(providerId);
				if (previous === undefined) this.#cooldowns.delete(providerId);
				else this.#cooldowns.set(providerId, previous);
			}
			throw error;
		}
		const written = new Map(
			ids.map((providerId) => [providerId, this.#cooldowns.get(providerId)]),
		);
		let active = true;
		return {
			value,
			rollback: () => {
				if (!active) return;
				active = false;
				for (let index = ids.length - 1; index >= 0; index -= 1) {
					const providerId = ids[index]!;
					if (this.#cooldowns.get(providerId) !== written.get(providerId)) continue;
					const previous = before.get(providerId);
					if (previous === undefined) this.#cooldowns.delete(providerId);
					else this.#cooldowns.set(providerId, previous);
				}
			},
		};
	}

	getCooldown(providerId: string, nowMs: number): CooldownRecord | undefined {
		const record = this.#cooldowns.get(providerId);
		if (record && record.untilMs <= nowMs) {
			this.#cooldowns.delete(providerId);
			return undefined;
		}
		return record;
	}

	/** Reads cooldown state without pruning an expired record. */
	peekCooldown(providerId: string, nowMs: number): CooldownRecord | undefined {
		const record = this.#cooldowns.get(providerId);
		return record !== undefined && record.untilMs > nowMs ? record : undefined;
	}

	clearCooldown(providerId: string): void {
		this.#cooldowns.delete(providerId);
	}

	invalidateAccount(record: InvalidatedAccount): void {
		assertManagedProviderId(record.providerId, record.family);
		assertTimestamp(record.invalidatedAtMs, "invalidatedAtMs");
		this.#invalidatedAccounts.set(
			providerIdKey(record.providerId),
			Object.freeze({
				providerId: record.providerId,
				family: record.family,
				reason: "terminal-auth-failure",
				invalidatedAtMs: record.invalidatedAtMs,
			}),
		);
	}

	getInvalidation(providerId: string): InvalidatedAccount | undefined {
		return this.#invalidatedAccounts.get(providerIdKey(providerId));
	}

	markAuthenticationSuccess(providerId: string): void {
		this.#invalidatedAccounts.delete(providerIdKey(providerId));
		this.#cooldowns.delete(providerId);
		// A success is the provider contradicting our distrust, so the streak is
		// retired. Without this the account would stay untrusted until the window
		// aged out, long after it started serving again.
		this.#limitErrors.delete(providerId);
	}

	/**
	 * A credential resolver returning a value proves only that auth material is
	 * available. It may clear terminal auth invalidation, but it cannot prove that
	 * an upstream cooldown or repeated 429 has recovered.
	 */
	markCredentialResolutionSuccess(providerId: string): void {
		this.#invalidatedAccounts.delete(providerIdKey(providerId));
	}

	/**
	 * Record a limit error (429 / quota) so repeated ones can override a usage
	 * snapshot that still claims headroom.
	 */
	recordLimitError(providerId: string, nowMs: number): void {
		assertTimestamp(nowMs, "nowMs");
		const within = (this.#limitErrors.get(providerId) ?? []).filter(
			(at) => nowMs - at < LIMIT_STREAK_WINDOW_MS,
		);
		within.push(nowMs);
		// Bounded: only the streak threshold matters, so never accumulate history.
		this.#limitErrors.set(providerId, within.slice(-LIMIT_STREAK_TRUST_THRESHOLD));
	}

	/**
	 * True when this provider has produced enough limit errors inside the window
	 * that its usage snapshot should no longer be believed.
	 *
	 * A SINGLE limit error is deliberately not enough. One 429 is normal under
	 * concurrency and is already handled by the ordinary cooldown; distrusting a
	 * snapshot on one sample would shrink the usable fleet on noise. The threshold
	 * follows the Sarrius reference (`index.ts:577-581`, accounting at
	 * `:2258-2265`), which reached the same conclusion after shipping the naive
	 * version.
	 */
	isUsageSnapshotUntrusted(providerId: string, nowMs: number): boolean {
		const within = (this.#limitErrors.get(providerId) ?? []).filter(
			(at) => nowMs - at < LIMIT_STREAK_WINDOW_MS,
		);
		if (within.length !== this.#limitErrors.get(providerId)?.length) {
			// Prune lazily so a long-idle provider does not keep stale timestamps.
			if (within.length === 0) this.#limitErrors.delete(providerId);
			else this.#limitErrors.set(providerId, within);
		}
		return within.length >= LIMIT_STREAK_TRUST_THRESHOLD;
	}

	/** Reads usage distrust without pruning expired limit observations. */
	peekUsageSnapshotUntrusted(providerId: string, nowMs: number): boolean {
		const within = (this.#limitErrors.get(providerId) ?? []).filter(
			(at) => nowMs - at < LIMIT_STREAK_WINDOW_MS,
		);
		return within.length >= LIMIT_STREAK_TRUST_THRESHOLD;
	}

	/**
	 * Clears terminal invalidation only when maintained public metadata exposes a
	 * changed numeric revision. No credential value or derived fingerprint is read.
	 *
	 * A revision change means the stored credential was replaced, which includes a
	 * routine token refresh. That is enough to retry a terminal auth failure — the
	 * new credential may well authenticate — but it is NOT enough to drop a
	 * cooldown, which belongs to the account rather than the credential. Use
	 * {@link observeAccountIdentity} for that distinction.
	 */
	observeCredentialRevision(
		providerId: string,
		family: ManagedFamily,
		revision: CredentialRevision,
	): boolean {
		assertManagedProviderId(providerId, family);
		if (!Number.isSafeInteger(revision) || revision < 0) {
			throw new TypeError(
				"credential revision must be a non-negative safe integer.",
			);
		}
		const key = providerIdKey(providerId);
		const previous = this.#credentialRevisions.get(key);
		this.#credentialRevisions.set(key, revision);
		if (previous !== undefined && previous !== revision) {
			return this.#invalidatedAccounts.delete(key);
		}
		return false;
	}

	/**
	 * Records the account identity now occupying a slot, clearing that slot's
	 * accumulated routing state only when the account has provably changed.
	 *
	 * Cooldowns and terminal invalidations describe a real upstream account, so a
	 * routine OAuth refresh — which rotates the token but not the account — must
	 * leave them intact: a server-side rate limit is not lifted by minting a new
	 * token, and forgetting the cooldown routes traffic straight back into the
	 * limit. Only a genuine re-login to a DIFFERENT account makes prior state
	 * irrelevant.
	 *
	 * `fingerprint` must be a stable account identifier derived from non-secret
	 * claims, or undefined when identity cannot be established (Anthropic's
	 * opaque tokens). Undefined is treated as "cannot prove a change" and retains
	 * state, never as a change. Returns true when state was cleared.
	 */
	observeAccountIdentity(
		providerId: string,
		family: ManagedFamily,
		fingerprint: string | undefined,
	): boolean {
		assertManagedProviderId(providerId, family);
		const key = providerIdKey(providerId);
		const change = classifyAccountIdentity(
			this.#accountIdentities.get(key),
			fingerprint,
		);
		if (fingerprint !== undefined)
			this.#accountIdentities.set(key, fingerprint);
		if (!shouldClearAccountState(change)) return false;
		this.#cooldowns.delete(providerId);
		this.#invalidatedAccounts.delete(key);
		return true;
	}

	resetAccount(providerId: string): void {
		const key = providerIdKey(providerId);
		this.#cooldowns.delete(providerId);
		this.#invalidatedAccounts.delete(key);
		this.#credentialRevisions.delete(key);
		this.#accountIdentities.delete(key);
	}

	resetRouting(): void {
		this.#cooldowns.clear();
		this.#invalidatedAccounts.clear();
		this.#credentialRevisions.clear();
		this.#accountIdentities.clear();
	}

	establishContinuationGuard(guard: ContinuationGuard): boolean {
		if (guard.destinationFamily === "openrouter") {
			if (guard.destinationProviderId !== "openrouter") {
				throw new TypeError(
					"metered continuation destination must use provider openrouter.",
				);
			}
		} else {
			assertManagedProviderId(
				guard.destinationProviderId,
				guard.destinationFamily,
			);
		}
		this.#assertIssuedReference(guard.failedTurnRef, "failedTurnRef");
		assertTimestamp(guard.guardSetAtMs, "guardSetAtMs");
		if (this.#continuationGuards.has(guard.failedTurnRef)) return false;
		this.#continuationGuards.set(
			guard.failedTurnRef,
			Object.freeze({
				failedTurnRef: guard.failedTurnRef,
				destinationProviderId: guard.destinationProviderId,
				destinationFamily: guard.destinationFamily,
				routingReason: guard.routingReason,
				guardSetAtMs: guard.guardSetAtMs,
			}),
		);
		return true;
	}

	clearContinuationGuard(failedTurnRef: RuntimeReference): void {
		this.#assertIssuedReference(failedTurnRef, "failedTurnRef");
		this.#continuationGuards.delete(failedTurnRef);
		this.#releaseReferenceIfUnused(failedTurnRef);
	}

	setWatchdog(snapshot: WatchdogSnapshot): void {
		this.#assertIssuedReference(
			snapshot.continuationTurnRef,
			"continuationTurnRef",
		);
		assertTimestamp(snapshot.dispatchedAtMs, "dispatchedAtMs");
		assertTimestamp(snapshot.lastProgressAtMs, "lastProgressAtMs");
		this.#watchdogs.set(
			snapshot.continuationTurnRef,
			Object.freeze({
				continuationTurnRef: snapshot.continuationTurnRef,
				dispatchedAtMs: snapshot.dispatchedAtMs,
				lastProgressAtMs: snapshot.lastProgressAtMs,
				toolRunning: snapshot.toolRunning,
			}),
		);
	}

	clearWatchdog(continuationTurnRef: RuntimeReference): void {
		this.#assertIssuedReference(continuationTurnRef, "continuationTurnRef");
		this.#watchdogs.delete(continuationTurnRef);
		this.#releaseReferenceIfUnused(continuationTurnRef);
	}

	queueInput(reference: QueuedInputReference): void {
		this.#assertIssuedReference(reference.inputRef, "inputRef");
		assertTimestamp(reference.queuedAtMs, "queuedAtMs");
		this.#queuedInputs.set(
			reference.inputRef,
			Object.freeze({
				inputRef: reference.inputRef,
				queuedAtMs: reference.queuedAtMs,
			}),
		);
	}

	setInputPaused(paused: boolean): void {
		this.#inputPaused = paused;
	}

	setLogicalRoutePin(input: LogicalRoutePinInput): LogicalRoutePin {
		assertManagedProviderId(input.destinationProviderId, input.destinationFamily);
		if (typeof input.requestedModelId !== "string" || input.requestedModelId.length === 0) {
			throw new TypeError("requestedModelId must be a non-empty string.");
		}
		const generation = this.#advanceLogicalRoutePinGeneration();
		const pin = Object.freeze({
			generation,
			destinationProviderId: input.destinationProviderId,
			destinationFamily: input.destinationFamily,
			requestedModelId: input.requestedModelId,
		});
		this.#logicalRoutePin = pin;
		return pin;
	}

	getLogicalRoutePin(): LogicalRoutePin | undefined {
		return this.#logicalRoutePin;
	}

	consumeLogicalRoutePin(
		expectedGeneration: number,
		requestedModelId: string,
	): LogicalRoutePin | undefined {
		const pin = this.#logicalRoutePin;
		this.#logicalRoutePin = undefined;
		if (
			pin === undefined ||
			pin.generation !== expectedGeneration ||
			pin.requestedModelId !== requestedModelId
		) {
			return undefined;
		}
		return pin;
	}

	clearLogicalRoutePin(): void {
		this.#logicalRoutePin = undefined;
	}

	clearPendingActivity(): void {
		this.#advanceLogicalRoutePinGeneration();
		this.#logicalRoutePin = undefined;
		this.#continuationGuards.clear();
		this.#watchdogs.clear();
		this.#queuedInputs.clear();
		this.#issuedReferences.clear();
		this.#inputPaused = false;
	}

	clearAll(): void {
		this.resetRouting();
		this.clearPendingActivity();
	}

	snapshot(nowMs: number): RuntimeStateSnapshot {
		for (const providerId of this.#cooldowns.keys()) {
			this.getCooldown(providerId, nowMs);
		}
		return {
			cooldowns: [...this.#cooldowns.values()],
			invalidatedAccounts: [...this.#invalidatedAccounts.values()],
			continuationGuards: [...this.#continuationGuards.values()],
			watchdogs: [...this.#watchdogs.values()],
			queuedInputs: [...this.#queuedInputs.values()],
			inputPaused: this.#inputPaused,
		};
	}

	#advanceLogicalRoutePinGeneration(): number {
		const next = this.#logicalRoutePinGeneration + 1;
		if (!Number.isSafeInteger(next)) {
			throw new RangeError("logical route pin generation exhausted safe integers.");
		}
		this.#logicalRoutePinGeneration = next;
		return next;
	}

	#assertIssuedReference(reference: RuntimeReference, name: string): void {
		if (
			typeof reference !== "object" ||
			reference === null ||
			!this.#issuedReferences.has(reference)
		) {
			throw new TypeError(`${name} must be minted by this RuntimeState.`);
		}
	}

	#releaseReferenceIfUnused(reference: RuntimeReference): void {
		if (
			this.#continuationGuards.has(reference) ||
			this.#watchdogs.has(reference) ||
			this.#queuedInputs.has(reference)
		) {
			return;
		}
		this.#issuedReferences.delete(reference);
	}
}

function providerIdKey(providerId: string): string {
	return providerId;
}
