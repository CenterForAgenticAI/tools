/**
 * Resolve package roots configured through Pi's package settings.
 *
 * This is intentionally a narrow additive seam: the normal cwd-based package
 * discovery remains authoritative, while callers may append these already
 * resolved package roots when Pi has configured a package outside that walk.
 */
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type PackageManager,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { logDelegateDiagnostic } from "./diagnostics.js";

export interface ConfiguredPackageRootsOptions {
	cwd: string;
	agentDir?: string;
	/** Must come from the live extension context, never inferred from disk. */
	projectTrusted?: boolean;
	/** Test seam; production uses Pi's canonical SettingsManager. */
	settingsManager?: SettingsManager;
	/** Test seam; production uses Pi's canonical DefaultPackageManager. */
	packageManager?: Pick<PackageManager, "listConfiguredPackages">;
	warn?: (message: string) => void;
}

/**
 * Returns configured, installed package roots in Pi's settings order.
 * Missing/unreadable settings or package metadata are non-fatal: callers keep
 * cwd discovery and receive an empty additive list instead.
 */
export function configuredPackageRoots(options: ConfiguredPackageRootsOptions): string[] {
	try {
		const agentDir = options.agentDir ?? getAgentDir();
		const settingsManager =
			options.settingsManager ??
			SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.projectTrusted === true });
		const packageManager =
			options.packageManager ??
			new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager });
		const roots: string[] = [];
		const seen = new Set<string>();
		for (const configured of packageManager.listConfiguredPackages()) {
			if (!configured.installedPath) continue;
			const root = path.resolve(configured.installedPath);
			if (seen.has(root)) continue;
			seen.add(root);
			roots.push(root);
		}
		return roots;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// The default sink is the diagnostics log, not the console: a raw console
		// write from the supervisor process lands on top of the pi TUI (#306). The
		// logger adds the `[delegate] ` prefix, so the message must not repeat it.
		const warn =
			options.warn ??
			((message: string) => logDelegateDiagnostic(message, { agentDir: options.agentDir }));
		warn(`configured package agent discovery unavailable; retaining cwd discovery: ${detail}`);
		return [];
	}
}
