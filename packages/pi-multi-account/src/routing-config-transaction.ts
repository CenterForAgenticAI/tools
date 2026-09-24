/**
 * The commit boundary for an operator-driven cross-family routing edit.
 *
 * Human dialogs never hold a machine lease. This module owns everything that
 * happens after the operator has answered: a short bounded lease, a fresh
 * under-lease read of both disk and the process-effective config, commit-time
 * drift detection against the persisted prompt snapshot, a merge that preserves
 * every unrelated persisted field, the atomic write, and a routing-only
 * synchronous publication into the current process.
 *
 * Publication is deliberately routing-only. Assigning a whole freshly read
 * config into the live closure would change account, label, usage, and cost
 * behavior without the account rediscovery `/multi-account reload` performs.
 */

import { dirname, join } from "node:path";
import {
	nonRoutingProjectionsEqual,
	readConfig,
	routingProjection,
	routingProjectionsEqual,
	writeConfig,
	type ConfigWriteOutcome,
	type MultiAccountConfig,
	type RoutingProjection,
} from "./config.js";
import type { DiagnosticLog } from "./diagnostics.js";
import {
	MACHINE_LEASE_TTL_MS,
	acquireMachineLease,
	type MachineLeaseHandle,
	type MachineLeaseOptions,
} from "./machine-lease.js";

/** Bounded contention handling: no recurring timer survives the command. */
export const ROUTING_CONFIG_LEASE_ATTEMPTS = 3;
export const ROUTING_CONFIG_LEASE_WINDOW_MS = 300;
const LEASE_RETRY_INTERVAL_MS = Math.ceil(
	ROUTING_CONFIG_LEASE_WINDOW_MS / ROUTING_CONFIG_LEASE_ATTEMPTS,
);

export const ROUTING_CONFIG_LOCK_FILE = "config.lock";

export function routingConfigLockPath(configPath: string): string {
	return join(dirname(configPath), ROUTING_CONFIG_LOCK_FILE);
}

export const NON_ROUTING_DRIFT_GUIDANCE =
	"Routing configuration was published, but this process's non-routing configuration differs from the persisted file. Run /multi-account reload or restart Pi before relying on the persisted non-routing values.";

export const COMMIT_WARNING_GUIDANCE =
	"Routing configuration was committed and published, but its final file mode or directory durability was not verified. Inspect the machine-global config file, then run /multi-account reload or configure again.";

/**
 * A pre-rename write failure. The original error is deliberately discarded:
 * filesystem errors carry raw paths, and this message crosses the operator
 * command surface.
 */
export class RoutingConfigWriteError extends Error {
	constructor() {
		super(
			"the routing configuration could not be written; the previous configuration is unchanged.",
		);
		this.name = "RoutingConfigWriteError";
	}
}

export type RoutingConfigCommitResult =
	| { readonly status: "applied"; readonly nonRoutingDrift: boolean }
	| { readonly status: "applied-warning"; readonly nonRoutingDrift: boolean }
	| { readonly status: "unchanged" }
	| { readonly status: "busy" }
	| { readonly status: "changed" }
	| { readonly status: "invalid" };

export interface RoutingConfigTransactionOptions {
	readonly configPath: string;
	readonly lockPath: string;
	/** Normalized persisted routing policy shown to the operator before dialogs. */
	readonly promptSnapshot: RoutingProjection;
	/** The complete validated routing policy the operator confirmed. */
	readonly candidate: RoutingProjection;
	/** Re-read under the lease; never a pre-dialog snapshot. */
	readonly processEffectiveConfig: () => MultiAccountConfig;
	/** Contracted non-throwing routing-only assignment into the live closure. */
	readonly publishRouting: (projection: RoutingProjection) => void;
	readonly diagnostics?: Pick<DiagnosticLog, "record">;
	readonly signal?: AbortSignal;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly acquireLease?: (
		options: MachineLeaseOptions,
	) => MachineLeaseHandle | undefined;
	readonly readConfigImpl?: (configPath: string) => MultiAccountConfig;
	readonly writeConfigImpl?: (
		configPath: string,
		config: MultiAccountConfig,
		onCommitted?: () => void,
	) => ConfigWriteOutcome;
}

const BUSY = Object.freeze({ status: "busy" } as const);
const CHANGED = Object.freeze({ status: "changed" } as const);
const INVALID = Object.freeze({ status: "invalid" } as const);
const UNCHANGED = Object.freeze({ status: "unchanged" } as const);

function defaultSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Commits one routing-only configuration change and publishes it to this
 * process.
 *
 * Ordering is load-bearing. The lease is taken only after every dialog has
 * closed; disk and the process-effective config are read only under that lease;
 * the persisted candidate is built from the fresh disk value so unrelated
 * fields survive; and publication runs as the first statement after the atomic
 * rename so disk and this process cannot be split by a later durability
 * failure. Once the rename begins, abort is ignored: there is no conditional
 * rollback, because a stale rollback could destroy a later writer's edit.
 */
export async function commitRoutingConfig(
	options: RoutingConfigTransactionOptions,
): Promise<RoutingConfigCommitResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const acquire = options.acquireLease ?? acquireMachineLease;
	const read = options.readConfigImpl ?? readConfig;
	const write = options.writeConfigImpl ?? writeConfig;
	const signal = options.signal;

	if (signal?.aborted) return CHANGED;

	const startedMs = now();
	let handle: MachineLeaseHandle | undefined;
	for (
		let attempt = 1;
		attempt <= ROUTING_CONFIG_LEASE_ATTEMPTS;
		attempt += 1
	) {
		handle = acquire({
			lockPath: options.lockPath,
			ttlMs: MACHINE_LEASE_TTL_MS,
			now,
		});
		if (handle !== undefined) break;
		if (attempt === ROUTING_CONFIG_LEASE_ATTEMPTS) break;
		const remainingMs = ROUTING_CONFIG_LEASE_WINDOW_MS - (now() - startedMs);
		if (remainingMs <= 0) break;
		await sleep(Math.min(remainingMs, LEASE_RETRY_INTERVAL_MS));
	}
	// A held OR malformed lease is fail-closed, and this caller deliberately
	// does not opt into malformed reclaim. The original reason no longer holds:
	// a malformed record was once indistinguishable from a live writer
	// mid-record, but leases are now published by link(2) from a complete
	// fsynced temporary file, so the lock path is never contentless mid-write.
	// The opt-out stands on its own ground instead. This path is operator
	// initiated and returns BUSY immediately, so a wedged lock is visible and
	// retryable rather than a silent permanent refusal, and
	// .spec/configure-explicit-routing-chains.md requires that actionable busy
	// guidance. Changing it is a spec decision, not a lock-recovery one.
	if (handle === undefined) return BUSY;

	try {
		if (signal?.aborted) return CHANGED;

		let fresh: MultiAccountConfig;
		let effective: MultiAccountConfig;
		try {
			fresh = read(options.configPath);
			effective = options.processEffectiveConfig();
		} catch {
			return INVALID;
		}

		const freshRouting = routingProjection(fresh);
		// Compared against the PERSISTED prompt snapshot, not the process-effective
		// one: a flow started while this process was stale must still be able to
		// converge once disk stops moving.
		if (!routingProjectionsEqual(freshRouting, options.promptSnapshot)) {
			return CHANGED;
		}

		const candidate = routingProjection(options.candidate);
		const nonRoutingDrift = !nonRoutingProjectionsEqual(fresh, effective);

		// The only no-op, and it is decided from fresh values on both sides. A
		// pre-dialog comparison could assert "already configured" while this
		// process is still running the old policy.
		if (
			routingProjectionsEqual(freshRouting, candidate) &&
			routingProjectionsEqual(routingProjection(effective), candidate)
		) {
			return UNCHANGED;
		}

		const persisted: MultiAccountConfig = { ...fresh, ...candidate };

		if (signal?.aborted) return CHANGED;

		let outcome: ConfigWriteOutcome;
		try {
			outcome = write(options.configPath, persisted, () => {
				options.publishRouting(candidate);
			});
		} catch {
			throw new RoutingConfigWriteError();
		}

		if (nonRoutingDrift) {
			options.diagnostics?.record(
				"warning",
				"config.routing-drift",
				NON_ROUTING_DRIFT_GUIDANCE,
			);
		}
		if (outcome === "committed-warning") {
			options.diagnostics?.record(
				"warning",
				"config.routing-commit",
				COMMIT_WARNING_GUIDANCE,
			);
			return { status: "applied-warning", nonRoutingDrift };
		}
		return { status: "applied", nonRoutingDrift };
	} finally {
		handle.release();
	}
}
