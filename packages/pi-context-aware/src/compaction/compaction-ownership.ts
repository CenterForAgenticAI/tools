import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

export type CompactionOwnershipState = "context-aware" | "pi-native" | "competing" | "none" | "deferred";
export type PiAutoCompactionSettingSource = "default" | "global" | "project";

export type PiAutoCompactionSetting =
	| {
		readonly ok: true;
		readonly enabled: boolean;
		readonly source: PiAutoCompactionSettingSource;
		readonly settingsPath?: string;
	}
	| {
		readonly ok: false;
		readonly diagnostic: string;
	};

export interface ResolvePiAutoCompactionSettingOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
}

export interface CompactionOwnershipAssessment {
	readonly state: CompactionOwnershipState;
	readonly contextAwareEnabled: boolean;
	readonly piNativeEnabled: boolean;
	readonly warning?: string;
}

type CompactionDeclaration =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid" }
	| { readonly kind: "boolean"; readonly enabled: boolean };

function compactionDeclaration(settings: unknown): CompactionDeclaration {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { kind: "absent" };
	if (!Object.prototype.hasOwnProperty.call(settings, "compaction")) return { kind: "absent" };
	const compaction = (settings as { compaction?: unknown }).compaction;
	if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) return { kind: "invalid" };
	if (!Object.prototype.hasOwnProperty.call(compaction, "enabled")) return { kind: "absent" };
	const enabled = (compaction as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? { kind: "boolean", enabled } : { kind: "invalid" };
}

export function resolvePiAutoCompactionSetting(
	options: ResolvePiAutoCompactionSettingOptions,
): PiAutoCompactionSetting {
	try {
		const manager = SettingsManager.create(options.cwd, options.agentDir, {
			projectTrusted: options.projectTrusted,
		});
		const errors = manager.drainErrors();
		if (errors.length > 0) {
			const scopes = [...new Set(errors.map((entry) => `${entry.scope} Pi settings`))].join(" and ");
			return {
				ok: false,
				diagnostic: `Could not resolve ${scopes}; automatic compaction ownership is unknown.`,
			};
		}

		const enabled: unknown = manager.getCompactionEnabled();
		if (typeof enabled !== "boolean") {
			return {
				ok: false,
				diagnostic: "Pi compaction.enabled is not a boolean; automatic compaction ownership is unknown.",
			};
		}

		const project = options.projectTrusted
			? compactionDeclaration(manager.getProjectSettings())
			: { kind: "absent" } as const;
		if (project.kind === "invalid") {
			return {
				ok: false,
				diagnostic: "Project Pi compaction.enabled is not a boolean; automatic compaction ownership is unknown.",
			};
		}
		if (project.kind === "boolean") {
			return {
				ok: true,
				enabled,
				source: "project",
				settingsPath: path.join(options.cwd, ".pi", "settings.json"),
			};
		}
		const global = compactionDeclaration(manager.getGlobalSettings());
		if (global.kind === "invalid") {
			return {
				ok: false,
				diagnostic: "Global Pi compaction.enabled is not a boolean; automatic compaction ownership is unknown.",
			};
		}
		if (global.kind === "boolean") {
			return {
				ok: true,
				enabled,
				source: "global",
				settingsPath: path.join(options.agentDir, "settings.json"),
			};
		}
		return { ok: true, enabled, source: "default" };
	} catch {
		return {
			ok: false,
			diagnostic: "Pi settings could not be loaded; automatic compaction ownership is unknown.",
		};
	}
}

export function assessCompactionOwnership(
	contextAwareEnabled: boolean,
	piNativeEnabled: boolean,
	contextAwareSummarizerEnabled = true,
): CompactionOwnershipAssessment {
	if (!contextAwareSummarizerEnabled) {
		return {
			state: "deferred",
			contextAwareEnabled,
			piNativeEnabled,
		};
	}
	if (contextAwareEnabled && piNativeEnabled) {
		return {
			state: "competing",
			contextAwareEnabled,
			piNativeEnabled,
			warning: "Automatic compaction has competing owners: context-aware proactive compaction and Pi native auto-compaction are both enabled. Disable Pi's compaction.enabled setting, then reload Pi to refresh this ownership check.",
		};
	}
	if (!contextAwareEnabled && !piNativeEnabled) {
		return {
			state: "none",
			contextAwareEnabled,
			piNativeEnabled,
			warning: "Automatic compaction has no owner: context-aware proactive compaction and Pi native auto-compaction are both disabled. Enable one automatic compaction path; reload Pi after changing Pi's setting.",
		};
	}
	return {
		state: contextAwareEnabled ? "context-aware" : "pi-native",
		contextAwareEnabled,
		piNativeEnabled,
	};
}
