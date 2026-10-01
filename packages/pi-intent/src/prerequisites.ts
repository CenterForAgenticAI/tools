import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** A pi package or executable pi-intent expects to be installed beside it. */
export interface Prerequisite {
	/** Name shown to the user. */
	readonly label: string;
	/** What breaks without it. */
	readonly purpose: string;
	/** How to install it. */
	readonly install: string;
	readonly kind: "pi-package" | "executable";
	/** Package names that satisfy a pi-package prerequisite (internal and public scopes). */
	readonly packages?: readonly string[];
	/** Executable name and fallback install locations for an executable prerequisite. */
	readonly command?: string;
	readonly fallbacks?: readonly string[];
}

export const PREREQUISITES: readonly Prerequisite[] = [
	{
		label: "pi-fabric",
		kind: "pi-package",
		packages: ["pi-fabric"],
		purpose: "runs Jev evaluations that produce the required laws receipt",
		install: "pi install npm:pi-fabric",
	},
	{
		label: "pi-work",
		kind: "pi-package",
		packages: ["@centerforagenticai/pi-work", "@caair/pi-work", "pi-work"],
		purpose: "carries intent records into workspecs and model-change nodes",
		install: "pi install npm:@centerforagenticai/pi-work",
	},
	{
		label: "pi-delegate",
		kind: "pi-package",
		packages: ["@centerforagenticai/pi-delegate", "@caair/pi-delegate", "pi-delegate"],
		purpose: "runs independent reviews of laws and proofs",
		install: "pi install npm:@centerforagenticai/pi-delegate",
	},
	{
		label: "pi-artifacts",
		kind: "pi-package",
		packages: ["@centerforagenticai/pi-artifacts", "@caair/pi-artifacts", "pi-artifacts"],
		purpose: "shows the plain-language law projection for human approval",
		install: "pi install npm:@centerforagenticai/pi-artifacts",
	},
	{
		label: "bend",
		kind: "executable",
		command: "bend",
		fallbacks: [join(homedir(), ".bend", "bin", "bend")],
		purpose: "checks LAWS.bend and PROOF.bend",
		install: "curl -fsSL https://bend-lang.com/install.sh | sh",
	},
	{
		label: "jev-fabric",
		kind: "executable",
		command: "jev-fabric",
		fallbacks: [join(homedir(), ".local", "bin", "jev-fabric")],
		purpose: "runs Jev evaluations from scripts outside a pi session",
		install: "curl -fsSL https://raw.githubusercontent.com/monotykamary/jev-fabric/main/install.sh | sh",
	},
];

/** The fields of a loaded tool's source that identify its package. */
export interface ToolSource {
	readonly source: string;
	readonly baseDir?: string | undefined;
}

/** Package names that loaded tools came from, read from `npm:` sources and package directories. */
export function loadedPackages(sources: readonly ToolSource[]): Set<string> {
	const names = new Set<string>();
	for (const s of sources) {
		if (s.source.startsWith("npm:")) names.add(stripVersion(s.source.slice(4)));
		if (s.baseDir) {
			const dir = s.baseDir.replace(/[\\/]+$/, "");
			const name = basename(dir);
			const parent = basename(dir.slice(0, dir.length - name.length - 1));
			names.add(parent.startsWith("@") ? `${parent}/${name}` : name);
		}
	}
	return names;
}

function stripVersion(spec: string): string {
	const at = spec.indexOf("@", 1);
	return at === -1 ? spec : spec.slice(0, at);
}

export type CommandProbe = (command: string, fallbacks: readonly string[]) => boolean;

/** True when `command` resolves on PATH or at one of its fallback paths. */
export const probeCommand: CommandProbe = (command, fallbacks) => {
	const which = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore", timeout: 5_000 });
	return which.status === 0 || fallbacks.some((path) => existsSync(path));
};

/** Prerequisites that are not satisfied by the loaded tool sources or the command probe. */
export function missingPrerequisites(
	sources: readonly ToolSource[],
	probe: CommandProbe = probeCommand,
	list: readonly Prerequisite[] = PREREQUISITES,
): Prerequisite[] {
	const loaded = loadedPackages(sources);
	return list.filter((p) =>
		p.kind === "pi-package" ? !(p.packages ?? []).some((name) => loaded.has(name)) : !probe(p.command ?? p.label, p.fallbacks ?? []),
	);
}

/** One user-facing warning naming every missing prerequisite, or undefined when nothing is missing. */
export function prerequisiteNotice(missing: readonly Prerequisite[]): string | undefined {
	if (missing.length === 0) return undefined;
	const lines = missing.map((p) => `- ${p.label}: ${p.purpose}. Install: ${p.install}`);
	return [`pi-intent: ${missing.length} prerequisite${missing.length === 1 ? " is" : "s are"} missing, so pi-intent will not work correctly.`, ...lines].join("\n");
}
