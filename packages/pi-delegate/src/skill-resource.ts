import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, type DelegateConfig } from "./config.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { isBundledSkillEnabled } from "./package-skill-authority.js";
import { filterSkillSections } from "./skill-sections.js";
import { replaceTextFile, resolveDelegateStateDir } from "./state-io.js";

const UNMATCHED_WARNING = "[delegate] skill.excludeSections contains an unmatched heading; using complete skill";
const WRITE_FAILURE_WARNING = "filtered skill could not be written; using complete skill";

export interface SkillResourceOptions {
	cwd?: string;
	reason?: "startup" | "reload";
	agentDir?: string;
	projectTrusted?: boolean;
	config?: DelegateConfig;
	packageRoot?: string;
	probeRoot?: string;
	warn?: (message: string) => void;
}

export function bundledSkillPath(packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): string {
	return path.join(packageRoot, "skills", "pi-delegate", "SKILL.md");
}

function warning(options: SkillResourceOptions, message: string): void {
	(options.warn ?? ((text: string) => logDelegateDiagnostic(text, { agentDir: options.agentDir, level: "warn" })))(message);
}

/** Resolve the authoritative original or content-addressed filtered skill path. */
export async function resolveSkillResource(options: SkillResourceOptions = {}): Promise<string | undefined> {
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const packageRoot = options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const original = bundledSkillPath(packageRoot);
	if (!(await isBundledSkillEnabled({
		cwd,
		agentDir,
		projectTrusted: options.projectTrusted === true,
		packageRoot,
		probeRoot: options.probeRoot,
		warn: (message) => warning(options, message),
	}))) {
		return undefined;
	}

	const config = options.config ?? loadConfig(agentDir);
	const selectors = config.skill?.excludeSections;
	if (!selectors || selectors.length === 0) return original;

	let source: string;
	try {
		source = readFileSync(original, "utf8");
	} catch {
		warning(options, WRITE_FAILURE_WARNING);
		return original;
	}
	const filtered = filterSkillSections(source, selectors);
	if (filtered.kind === "unmatched") {
		warning(options, UNMATCHED_WARNING);
		return original;
	}
	if (filtered.kind === "unchanged") return original;

	const digest = createHash("sha256").update(filtered.source, "utf8").digest("hex");
	const generated = path.join(resolveDelegateStateDir(agentDir), "generated-skills", `${digest}.md`);
	try {
		replaceTextFile(generated, filtered.source);
		return generated;
	} catch {
		warning(options, WRITE_FAILURE_WARNING);
		return original;
	}
}
