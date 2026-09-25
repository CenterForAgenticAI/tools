/** Legacy proofs lack containment; new proofs must name the executor they used. */
export function validCommandContainment(containment: unknown, executorPath: unknown, shellPath: unknown): boolean {
	if (containment === undefined) return true;
	if (containment === "process-group") return executorPath === shellPath;
	if (containment === "systemd-scope") return executorPath !== shellPath;
	return false;
}
