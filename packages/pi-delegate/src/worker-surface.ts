/**
 * Which tool surface a delegate worker received, and why (#582).
 *
 * A worker either reaches tools through `fabric_exec` (the Fabric surface) or
 * through Pi's native tools. The receipt, the harvested result and
 * `delegate.status` report the surface with one reason from a closed set, so a
 * caller can tell an intended native worker from a Fabric fallback without
 * reading the worker transcript.
 */

/** The tool path a worker uses. */
export type WorkerSurface = "fabric" | "native";

/**
 * Why the worker got its surface. Fabric reasons first, then native ones, in
 * the order the admission check evaluates them.
 */
export const WORKER_SURFACE_REASONS = Object.freeze([
	/** Fabric: the worker shape needs no host policy. */
	"fabric-unrestricted",
	/** Fabric: a write-confined or tool-denying worker whose Fabric acknowledged the host policy. */
	"fabric-host-policy",
	/** Native: the worker loads no single pi-fabric extension. */
	"fabric-not-loaded",
	/** Native: the agent or the task set `fabric: false`. */
	"fabric-opt-out",
	/** Native: a readOnly worker, until pi-fabric supports a worker write policy (#587). */
	"readonly-worker",
	/** Native: an explicit `tools:` list, `ext:` selectors or dynamic tools (such as escalation verbs). */
	"explicit-tool-scope",
	/** Native: a restricted worker whose Fabric did not acknowledge the host policy (older pi-fabric). */
	"host-policy-unacknowledged",
	/** Native: Fabric was admitted, but `fabric_exec` was not active when the worker started. */
	"fabric-exec-inactive",
] as const);

export type WorkerSurfaceReason = typeof WORKER_SURFACE_REASONS[number];

/** Admission reasons that grant `fabric_exec`. */
export type WorkerFabricAdmittedReason = Extract<WorkerSurfaceReason, "fabric-unrestricted" | "fabric-host-policy">;

export interface WorkerSurfaceReport {
	surface: WorkerSurface;
	surfaceReason: WorkerSurfaceReason;
}

const REASONS: ReadonlySet<string> = new Set(WORKER_SURFACE_REASONS);

export function isWorkerSurface(value: unknown): value is WorkerSurface {
	return value === "fabric" || value === "native";
}

export function isWorkerSurfaceReason(value: unknown): value is WorkerSurfaceReason {
	return typeof value === "string" && REASONS.has(value);
}

function isAdmitted(reason: WorkerSurfaceReason): reason is WorkerFabricAdmittedReason {
	return reason === "fabric-unrestricted" || reason === "fabric-host-policy";
}

/**
 * Report the surface from the scope's admission decision and the tools that
 * are actually active in the live worker session.
 */
export function describeWorkerSurface(
	admission: WorkerSurfaceReason,
	activeToolNames: readonly string[],
): WorkerSurfaceReport {
	if (activeToolNames.includes("fabric_exec")) return { surface: "fabric", surfaceReason: admission };
	return { surface: "native", surfaceReason: isAdmitted(admission) ? "fabric-exec-inactive" : admission };
}

/** Copy only a valid surface pair from untrusted or persisted input. */
export function projectWorkerSurfaceReport(value: { surface?: unknown; surfaceReason?: unknown }): Partial<WorkerSurfaceReport> {
	return isWorkerSurface(value.surface) && isWorkerSurfaceReason(value.surfaceReason)
		? { surface: value.surface, surfaceReason: value.surfaceReason }
		: {};
}

/** Forget a previous attempt's surface before a replacement attempt starts. */
export function clearWorkerSurfaceReport(target: { surface?: WorkerSurface; surfaceReason?: WorkerSurfaceReason }): void {
	delete target.surface;
	delete target.surfaceReason;
}

/** One result line, for example `surface: native (fabric-opt-out)`. */
export function formatWorkerSurfaceLine(report: WorkerSurfaceReport): string {
	return `surface: ${report.surface} (${report.surfaceReason})`;
}
