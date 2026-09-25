import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type PackageManager,
	type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { normalizeGitIdentity, normalizeNpmIdentity } from "./extension-policy.js";

const AUTHORITY_FAILURE_WARNING = "[delegate] unable to establish package skill policy; skill loading is disabled";

export interface PackageSkillAuthorityOptions {
	cwd: string;
	agentDir?: string;
	projectTrusted?: boolean;
	/** The package root containing the running extension. */
	packageRoot?: string;
	/** A minimal package with the same relative skill path used for probing filters. */
	probeRoot?: string;
	settingsManager?: SettingsManager;
	packageManager?: Pick<PackageManager, "listConfiguredPackages">;
	warn?: (message: string) => void;
}

function canonical(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

function sourceOf(value: PackageSource): string {
	return typeof value === "string" ? value : value.source;
}

function projectSource(value: PackageSource, probeRoot: string): PackageSource {
	if (typeof value === "string") return probeRoot;
	const projected: Exclude<PackageSource, string> = { source: probeRoot };
	if (typeof value.autoload === "boolean") projected.autoload = value.autoload;
	if (Array.isArray(value.extensions)) projected.extensions = [...value.extensions];
	if (Array.isArray(value.skills)) projected.skills = [...value.skills];
	if (Array.isArray(value.prompts)) projected.prompts = [...value.prompts];
	if (Array.isArray(value.themes)) projected.themes = [...value.themes];
	return projected;
}

function sameConfiguredPackage(
	entry: { source: string; scope: "user" | "project"; installedPath?: string },
	packageRoot: string,
): boolean {
	return entry.installedPath !== undefined && canonical(entry.installedPath) === canonical(packageRoot);
}

function packageIdentity(source: string): string | undefined {
	const npm = normalizeNpmIdentity(source);
	if (npm) return npm;

	const raw = source.trim();
	if (!/^(?:git:|github:|https?:\/\/|ssh:\/\/)/i.test(raw)) return undefined;

	const provider = /^git:(github|gitlab|bitbucket|gist|sourcehut):(.+)$/i.exec(raw);
	if (provider) {
		const hosts: Record<string, string> = {
			github: "github.com",
			gitlab: "gitlab.com",
			bitbucket: "bitbucket.org",
			gist: "gist.github.com",
			sourcehut: "git.sr.ht",
		};
		const providerName = provider[1]!.toLowerCase();
		const repositoryPath = provider[2]!;
		const providerPath = providerName === "gist" && !repositoryPath.includes("/") ? `null/${repositoryPath}` : repositoryPath;
		const git = normalizeGitIdentity(`git:${hosts[providerName]}/${providerPath}`);
		if (git) return git;
	}
	return normalizeGitIdentity(raw);
}

interface MatchingSources {
	userPackages: PackageSource[];
	projectPackages: PackageSource[];
	found: boolean;
}

function matchingSources(
	settingsManager: SettingsManager,
	configured: Array<{ source: string; scope: "user" | "project"; installedPath?: string }>,
	packageRoot: string,
	probeRoot: string,
): MatchingSources {
	const globalSettings = settingsManager.getGlobalSettings();
	const projectSettings = settingsManager.getProjectSettings();
	const userPackages: PackageSource[] = [];
	const projectPackages: PackageSource[] = [];
	let found = false;
	// Pi can resolve a project delta against the user install, so its path may
	// differ from packageRoot. Correlate only with an already trusted user entry.
	const trustedUserSources = configured
		.filter((entry) => entry.scope === "user" && sameConfiguredPackage(entry, packageRoot))
		.map((entry) => packageIdentity(entry.source))
		.filter((identity): identity is string => identity !== undefined);
	for (const [scope, values] of [
		["project", projectSettings.packages ?? []] as const,
		["user", globalSettings.packages ?? []] as const,
	]) {
		for (const value of values) {
			const source = sourceOf(value);
			const packageMatch = configured.find((entry) => {
				if (entry.scope !== scope || entry.source !== source) return false;
				if (sameConfiguredPackage(entry, packageRoot)) return true;
				const identity = packageIdentity(source);
				return scope === "project" && identity !== undefined && trustedUserSources.includes(identity);
			});
			if (!packageMatch) continue;
			found = true;
			const projected = projectSource(value, probeRoot);
			if (scope === "project") projectPackages.push(projected);
			else userPackages.push(projected);
		}
	}
	return { userPackages, projectPackages, found };
}

/**
 * Ask Pi's public package resolver whether the bundled skill is enabled. The
 * resolver receives a projected probe package, so package filters, trust,
 * autoload, and project-over-global delta semantics remain Pi-owned.
 */
export async function isBundledSkillEnabled(options: PackageSkillAuthorityOptions): Promise<boolean> {
	const packageRoot = options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const probeRoot = options.probeRoot ?? path.resolve(packageRoot, "skill-filter-probe");
	if (!existsSync(probeRoot)) {
		options.warn?.(AUTHORITY_FAILURE_WARNING);
		return false;
	}
	try {
		const agentDir = options.agentDir ?? getAgentDir();
		const settingsManager =
			options.settingsManager ??
			SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.projectTrusted === true });
		await settingsManager.reload();
		const packageManager =
			options.packageManager ??
			new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager });
		const configured = packageManager.listConfiguredPackages();
		const selected = matchingSources(settingsManager, configured, packageRoot, probeRoot);
		if (!selected.found) return true;

		const projectedSettings = SettingsManager.inMemory(
			{ packages: selected.userPackages },
			{ projectTrusted: options.projectTrusted === true },
		);
		if (selected.projectPackages.length > 0) projectedSettings.setProjectPackages(selected.projectPackages);
		const probeManager = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager: projectedSettings });
		const resolved = await probeManager.resolve();
		const expected = canonical(path.join(probeRoot, "skills", "pi-delegate", "SKILL.md"));
		return resolved.skills.some((resource) => canonical(resource.path) === expected && resource.enabled);
	} catch {
		options.warn?.(AUTHORITY_FAILURE_WARNING);
		return false;
	}
}

export const PACKAGE_SKILL_AUTHORITY_WARNING = AUTHORITY_FAILURE_WARNING;
