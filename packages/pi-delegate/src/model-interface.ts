/**
 * Model-facing control hints that follow the selected delegate interface (#568).
 *
 * While the Fabric interface is selected, pi-delegate withholds its native
 * `delegate`, `delegate_control` and `delegate_escalation` tools from the model
 * and the Fabric-mode instructions tell it to use the `delegate` provider from
 * `fabric_exec`. A wake or tool result that still said "call delegate_control"
 * would contradict those instructions. Every model-facing hint that names a
 * control route is therefore rendered from this table, for the interface of
 * the session that receives it. Native text is unchanged byte for byte.
 */

/** The interface a receiving session uses to reach pi-delegate controls. */
export type DelegateModelInterface = "native" | "fabric";

/** Hints that name a control route. Each returns one sentence or clause. */
export interface DelegateControlHints {
	/** How to retrieve a completed background dispatch at a natural checkpoint. */
	checkpointResult(): string;
	/** A failed entry can be recovered (no trailing space). */
	recover(strategy: string): string;
	/** A recovered sync run stays retrievable; completes "Recovered ... below; ". */
	retainedResult(): string;
	/** Where a failed detached driver's details live. */
	failureDetails(runId: string): string;
	/** A daemon-hosted driver was accepted and is controlled from here on. */
	daemonDriverAccepted(): string;
	/** Completes "Live state is visible in the delegate overlay and via ". */
	detachedDriverStatus(): string;
	/** Completes "... this run is RUNNING but UNCONTROLLABLE — ". */
	uncontrollableDriver(): string;
	/** How to pass an escalation beyond the root agent's authority. */
	escalationPassUp(): string;
}

const NATIVE_HINTS: DelegateControlHints = {
	checkpointResult: () => 'Results arrive when you would otherwise stop, or earlier via delegate_control(action="result", runId) at a natural checkpoint. Do not poll or sleep.',
	recover: (strategy) => `Recovery is available; call delegate_control action recover (strategy: ${strategy}).`,
	retainedResult: () => `the run remains available via delegate_control(action="result", runId).`,
	failureDetails: (runId) => `Failure details are available through delegate_control(action="result", runId="${runId}").`,
	daemonDriverAccepted: () => "The prompt is durably accepted and continues without this client; use delegate_control for status, result, and control.",
	detachedDriverStatus: () => "delegate_control(action=\"status\", runId); delegate health reports detached counts separately.",
	uncontrollableDriver: () => `delegate_control(action="steer"/"cancel") will be unavailable for it.`,
	escalationPassUp: () => "Use `delegate_escalation` with action \"pass_up\" to pass it to the operator.",
};

// Wording follows FABRIC_MODE_INSTRUCTIONS: provider refs `delegate.<action>`
// called from `fabric_exec`, and only actions the provider actually lists.
const FABRIC_HINTS: DelegateControlHints = {
	checkpointResult: () => "Results arrive when you would otherwise stop, or earlier via `delegate.harvest` with {runId} from fabric_exec at a natural checkpoint. Do not poll or sleep.",
	recover: (strategy) => `Recovery is available; call \`delegate.recover\` with {runId, forkName} from fabric_exec (strategy: ${strategy}).`,
	retainedResult: () => "the run remains available via `delegate.harvest` with {runId} from fabric_exec.",
	failureDetails: (runId) => `Failure details are available through \`delegate.harvest\` with {runId: "${runId}"} from fabric_exec.`,
	daemonDriverAccepted: () => "The prompt is durably accepted and continues without this client; use `delegate.status`, `delegate.harvest` and the driver controls (`delegate.promptStatus`, `delegate.followUp`, `delegate.steer`, `delegate.cancel`) from fabric_exec.",
	detachedDriverStatus: () => "`delegate.status` with {runId} from fabric_exec; `delegate.health` reports detached counts separately.",
	uncontrollableDriver: () => "`delegate.steer` and `delegate.cancel` will be unavailable for it.",
	escalationPassUp: () => "Use `delegate.passUpEscalations` from fabric_exec to pass it to the operator.",
};

const HINTS: Readonly<Record<DelegateModelInterface, DelegateControlHints>> = Object.freeze({
	native: Object.freeze(NATIVE_HINTS),
	fabric: Object.freeze(FABRIC_HINTS),
});

/** The control hints for one interface. */
export function controlHints(modelInterface: DelegateModelInterface = "native"): DelegateControlHints {
	return HINTS[modelInterface] ?? HINTS.native;
}

// Keyed by the receiving session's sink (its ExtensionAPI), on globalThis: a
// wake built by a predecessor module instance can be delivered through a
// successor's live sink, and must follow the successor's selection. Worker
// module instances register their own sink, whose selection is always native.
const PROBES_KEY = Symbol.for("pi-delegate.modelInterfaceProbes.v1");
const probes = (() => {
	const shared = globalThis as Record<symbol, unknown>;
	const existing = shared[PROBES_KEY];
	if (existing instanceof WeakMap) return existing as WeakMap<object, () => DelegateModelInterface>;
	const created = new WeakMap<object, () => DelegateModelInterface>();
	shared[PROBES_KEY] = created;
	return created;
})();

/**
 * Register how a session sink reports its selected interface. pi-delegate
 * registers its foreground `pi` with the same predicate that drives the
 * Fabric-mode instructions and native tool suppression.
 */
export function setModelInterfaceProbe(sink: object, probe: () => DelegateModelInterface): void {
	probes.set(sink, probe);
}

/** Carry a sink's probe to a wrapper that delivers through it. */
export function inheritModelInterfaceProbe(from: object, to: object): void {
	const probe = probes.get(from);
	if (probe) probes.set(to, probe);
}

/** The interface of the session behind `sink`; native unless it proves Fabric. */
export function modelInterfaceFor(sink: object | undefined): DelegateModelInterface {
	if (sink === undefined || sink === null) return "native";
	try {
		return probes.get(sink)?.() === "fabric" ? "fabric" : "native";
	} catch {
		return "native";
	}
}
