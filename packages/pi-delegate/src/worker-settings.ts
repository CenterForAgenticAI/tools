import { SettingsManager } from "@earendil-works/pi-coding-agent";

type SettingsScope = "global" | "project";
type WorkerSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/**
 * Snapshot Pi's global and project settings into worker-local storage.
 *
 * Keeping both scopes lets the SDK retain its own version-specific merge and
 * project-resource resolution semantics. JSON serialization also prevents a
 * worker from retaining a nested mutable reference into another worker's
 * snapshot. A worker model or thinking switch must not be able to update the
 * foreground manager or either shared settings file.
 */
export function createIsolatedWorkerSettingsManager(cwd: string, agentDir: string): SettingsManager {
	const inherited = SettingsManager.create(cwd, agentDir);
	const values: Record<SettingsScope, string | undefined> = {
		global: JSON.stringify(inherited.getGlobalSettings()),
		project: JSON.stringify(inherited.getProjectSettings()),
	};
	const storage: WorkerSettingsStorage = {
		withLock(scope, callback): void {
			const next = callback(values[scope]);
			if (next !== undefined) values[scope] = next;
		},
	};
	return SettingsManager.fromStorage(storage, { projectTrusted: inherited.isProjectTrusted() });
}
