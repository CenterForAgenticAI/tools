import * as path from "node:path";

/** Resolve an optional child working directory exactly as runtime dispatch does. */
export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return baseCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

/** Resolve a canonical run cwd against the dispatching session cwd. */
export function resolveEffectiveCwd(
	sessionCwd: string,
	topLevelCwd?: string,
	entryCwd?: string,
): string {
	const selected = entryCwd ?? topLevelCwd;
	return selected === undefined ? sessionCwd : resolveChildCwd(sessionCwd, selected);
}
