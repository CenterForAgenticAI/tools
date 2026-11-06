/**
 * Keep Fabric guidance out of a worker that has no fabric_exec (#582).
 *
 * pi-fabric publishes its skills (for example `fabric-exec`) through
 * `resources_discover`, whether or not the worker may use `fabric_exec`. A
 * native worker would then read instructions for a tool it does not have.
 * Fabric's own system-prompt sections already require an active
 * `fabric_exec`; this worker-only extension removes the skill catalog entries
 * that pi-fabric contributed when `fabric_exec` is not active. Every in-process
 * worker loads it: a write-confined worker inside the write-confinement
 * extension, a `confineWrites: false` worker as its own inline extension.
 */
import { dirname, resolve } from "node:path";
import type { Extension, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { FABRIC_EXEC_TOOL_NAME, loadedFabricExtensions } from "./worker-tool-scope.js";

/** Inline extension name for a worker that has no write-confinement extension to carry the gate. */
export const WORKER_FABRIC_GUIDANCE_EXTENSION_NAME = "fabric-guidance";

interface PromptSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
	sourceInfo?: { baseDir?: string };
}

/**
 * Directories Pi records as `sourceInfo.baseDir` for skills that a loaded
 * pi-fabric extension contributed: the directory of the extension entrypoint.
 */
export function fabricSkillSourceDirs(extensions: readonly Extension[]): Set<string> {
	const dirs = new Set<string>();
	for (const extension of loadedFabricExtensions(extensions)) {
		for (const entry of [extension.path, extension.resolvedPath]) {
			if (typeof entry === "string" && entry.length > 0 && !entry.startsWith("<")) dirs.add(resolve(dirname(entry)));
		}
	}
	return dirs;
}

function isFabricSkill(skill: PromptSkill, dirs: ReadonlySet<string>): boolean {
	const baseDir = skill.sourceInfo?.baseDir;
	return typeof baseDir === "string" && dirs.has(resolve(baseDir));
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** The exact catalog block Pi renders for one skill. */
function skillBlock(skill: PromptSkill): string {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

/**
 * Remove pi-fabric skills from one `before_agent_start` event. Mutates the
 * event's skill list, which Pi re-renders, and returns a replacement prompt
 * only when an earlier handler already fixed the prompt text.
 */
export function removeFabricSkills(
	event: { readonly systemPrompt: string; systemPromptOptions: { skills?: PromptSkill[] } },
	dirs: ReadonlySet<string>,
): string | undefined {
	if (dirs.size === 0) return undefined;
	const skills = event.systemPromptOptions.skills;
	if (!Array.isArray(skills)) return undefined;
	const removed = skills.filter((skill) => isFabricSkill(skill, dirs));
	if (removed.length === 0) return undefined;
	event.systemPromptOptions.skills = skills.filter((skill) => !isFabricSkill(skill, dirs));
	const prompt = event.systemPrompt;
	let stripped = prompt;
	for (const skill of removed) stripped = stripped.split(`${skillBlock(skill)}\n`).join("");
	return stripped === prompt ? undefined : stripped;
}

/**
 * Worker-only extension. `getDirs` is read at each turn because the worker's
 * extensions are known only after its loader has run.
 */
export function createWorkerFabricGuidanceExtension(getDirs: () => ReadonlySet<string>): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			if (pi.getActiveTools().includes(FABRIC_EXEC_TOOL_NAME)) return undefined;
			const systemPrompt = removeFabricSkills(event as Parameters<typeof removeFabricSkills>[0], getDirs());
			return systemPrompt === undefined ? undefined : { systemPrompt };
		});
	};
}
