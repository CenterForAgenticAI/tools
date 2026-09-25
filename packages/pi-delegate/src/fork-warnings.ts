import type { ForkWarning } from "./fork-runner.js";

/** Render structured non-fatal warnings without dropping their category or order. */
export function formatForkWarningLines(
	warnings: readonly ForkWarning[] | undefined,
): string[] {
	return warnings?.map((warning) => `warning [${warning.kind}]: ${warning.message}`) ?? [];
}
