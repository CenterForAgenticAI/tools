/**
 * `load_skill` — resolve a skill by name and return its body.
 *
 * Why this exists: every load instruction this package ships names a skill and
 * gives no path, because a path that is correct in this repository is wrong in
 * the repository the prompt actually runs in. The only loader an agent has is
 * `read`, which needs a path, so the agent reconstructs one — and the
 * reconstruction that looks right, `~/.pi/agent/skills/<name>/SKILL.md`, is
 * wrong for every skill this package ships. Measured across ~6,500 stored
 * sessions on 2026-08-25: 523 failed reads in 186 sessions, 412 of them for
 * `test-execution` alone. The agent then continues without the contract it was
 * told to follow, and nothing reports the loss. See issue #191.
 *
 * The fix is to make the name-only instruction executable. The caller supplies
 * a name; this module answers from the skills Pi already discovered for this
 * session, and returns that skill's own recorded path.
 *
 * The caller's string is never turned into a path. It is compared against
 * discovered skill names and nothing else, so no input — `../../etc/passwd`,
 * an absolute path, a symlink — can cause a read outside the discovered set.
 * `resolveSkill` returns the `Skill` object Pi recorded, and the caller reads
 * `skill.filePath`, a value this module never derives from input.
 */

import { readFileSync } from "node:fs";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SkillLoadHooks } from "./skill-registry.js";

/** The fields of Pi's `Skill` this module uses. Structural, so tests need no host. */
export interface DiscoveredSkill {
	name: string;
	description: string;
	filePath: string;
}

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

function unescapeXml(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

/**
 * Read the skills out of the `<available_skills>` block of a system prompt.
 *
 * This is the authoritative source and not a reconstruction: it is the exact
 * list the agent was shown, already filtered to what this session may use, so a
 * worker restricted to four skills resolves against those four. Pi emits the
 * block from `formatSkillsForPrompt`, one `<name>`/`<description>`/`<location>`
 * per entry, XML-escaped.
 *
 * A prompt with no block yields no skills, which `resolveSkill` reports as
 * `no-skills` rather than as an unknown name.
 */
export function skillsFromSystemPrompt(prompt: string): DiscoveredSkill[] {
	const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(prompt);
	if (!block) return [];
	const skills: DiscoveredSkill[] = [];
	const entry = /<skill>([\s\S]*?)<\/skill>/g;
	for (const [, body] of block[1]!.matchAll(entry)) {
		const name = /<name>([\s\S]*?)<\/name>/.exec(body!)?.[1];
		const filePath = /<location>([\s\S]*?)<\/location>/.exec(body!)?.[1];
		if (name === undefined || filePath === undefined) continue;
		const description = /<description>([\s\S]*?)<\/description>/.exec(body!)?.[1] ?? "";
		skills.push({
			name: unescapeXml(name).trim(),
			description: unescapeXml(description).trim(),
			filePath: unescapeXml(filePath).trim(),
		});
	}
	return skills;
}

export type SkillResolution =
	| { readonly ok: true; readonly skill: DiscoveredSkill; readonly shadowed: readonly string[] }
	| { readonly ok: false; readonly reason: "no-skills" | "empty-name" | "unknown"; readonly message: string };

/** Names an agent can ask for, in a stable order, for an error message. */
export function availableNames(skills: readonly DiscoveredSkill[]): string[] {
	return [...new Set(skills.map((skill) => skill.name))].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve `requested` against the discovered skills.
 *
 * Matching is exact on the trimmed name, then case-insensitive as a courtesy —
 * a model that writes `Glab` meant `glab`, and failing that would send it back
 * to guessing a path, which is the whole defect. Neither branch builds a path.
 *
 * When two discovered skills share a name, the last one wins, which is Pi's own
 * precedence (project overrides user overrides package), and the paths it
 * shadowed are reported rather than hidden.
 */
export function resolveSkill(requested: string, skills: readonly DiscoveredSkill[]): SkillResolution {
	const name = requested.trim();
	if (name === "") {
		return { ok: false, reason: "empty-name", message: "load_skill needs a skill `name`." };
	}
	if (skills.length === 0) {
		return {
			ok: false,
			reason: "no-skills",
			message:
				"This session has no discovered skills, so load_skill cannot resolve a name. " +
				"Do not construct a skill path: report that the skill could not be loaded.",
		};
	}

	const exact = skills.filter((skill) => skill.name === name);
	const matches = exact.length > 0
		? exact
		: skills.filter((skill) => skill.name.toLowerCase() === name.toLowerCase());

	if (matches.length === 0) {
		return {
			ok: false,
			reason: "unknown",
			message:
				`No skill named "${name}" is available in this session. ` +
				`Available: ${availableNames(skills).join(", ")}. ` +
				"Do not construct a skill path from the requested name.",
		};
	}

	const skill = matches[matches.length - 1]!;
	const shadowed = matches.slice(0, -1).map((other) => other.filePath);
	return { ok: true, skill, shadowed };
}

/** The slice of Pi's extension API this registration needs. */
export interface LoadSkillToolAPI {
	registerTool<TParams extends object>(tool: ToolDefinition<TParams>): void;
	on(
		event: "before_agent_start",
		handler: (event: { systemPrompt: string; systemPromptOptions?: { skills?: readonly DiscoveredSkill[] } }, ctx: ExtensionContext) => unknown,
	): void;
}

/**
 * The slice of the tool-execution context this registration needs.
 *
 * `getSystemPrompt` is optional here although Pi's own context type declares
 * it required: a host or worker shim that does not provide it must produce a
 * refusal, not a crash and not a guessed path.
 */
export type LoadSkillContext = Partial<Pick<ExtensionContext, "getSystemPrompt" | "cwd">> & {
	readonly sessionManager?: Parameters<SkillLoadHooks["decide"]>[0]["sessionManager"];
};

const PARAMETERS = Type.Object({
	name: Type.String({
		description:
			"The skill's name, for example \"glab\" or \"test-execution\". Use the name from <available_skills> or from the prompt or skill that told you to load it; <available_skills> is not exhaustive. A name, never a path.",
	}),
	force: Type.Optional(Type.Boolean({
		description:
			"Return the full body even when the skill is already loaded and unchanged. Use only when the earlier copy cannot be read or restored.",
	})),
});

export interface LoadSkillParams {
	name: string;
	force?: boolean;
}

/** One text result, in the shape Pi's tool protocol expects. */
function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

interface PiResourceLoaderAPI {
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
		noExtensions: boolean;
		noPromptTemplates: boolean;
		noThemes: boolean;
		noContextFiles: boolean;
	}) => {
		reload(): Promise<void>;
		getSkills(): {
			skills: Array<{ name: string; description: string; filePath: string }>;
			diagnostics: Array<{
				type: string;
				collision?: { resourceType: string; winnerPath: string; loserPath: string };
			}>;
		};
	};
	getAgentDir(): string;
	SettingsManager: {
		create(cwd: string, agentDir: string): { setProjectTrusted(trusted: boolean): void };
	};
}

/**
 * Discover the complete skill set through Pi's own loader. Its package manager
 * supplies the fixed default roots and each installed package's `pi.skills`
 * entries, while its loader applies Pi's frontmatter and directory rules.
 */
export async function discoverAllSkills(cwd: string, projectTrusted: boolean): Promise<DiscoveredSkill[]> {
	// The repository's runtime shim intentionally exposes only the extension API,
	// so use the same public runtime exports through a structural boundary here.
	const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as PiResourceLoaderAPI;
	const agentDir = pi.getAgentDir();
	const settingsManager = pi.SettingsManager.create(cwd, agentDir);
	settingsManager.setProjectTrusted(projectTrusted);
	const loader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	const shadowedByWinner = new Map<string, string[]>();
	for (const diagnostic of diagnostics) {
		const collision = diagnostic.collision;
		if (diagnostic.type !== "collision" || collision?.resourceType !== "skill") continue;
		const shadowed = shadowedByWinner.get(collision.winnerPath) ?? [];
		shadowed.push(collision.loserPath);
		shadowedByWinner.set(collision.winnerPath, shadowed);
	}

	// Pi's loader keeps the higher-precedence winner. Include each reported loser
	// before that winner so resolveSkill retains its last-wins and shadow-reporting
	// contract without constructing any path from the caller's requested name.
	return skills.flatMap((skill) => [
		...(shadowedByWinner.get(skill.filePath) ?? []).map((filePath) => ({
			name: skill.name,
			description: "",
			filePath,
		})),
		{
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
		},
	]);
}

/** Records the skill set Pi built the system prompt from; called on `before_agent_start`. */
export type LoadSkillCapture = Parameters<LoadSkillToolAPI["on"]>[1];

export interface LoadSkillRegistrationOptions {
	/**
	 * `false` when the caller already has a `before_agent_start` handler and
	 * calls the returned capture from it, so the extension keeps one handler.
	 */
	readonly listen?: boolean;
	/**
	 * Called after a result that carries the full body, never after a pointer.
	 * The extension captures the skill's `condensed.md` here (pi-context-aware#181).
	 */
	readonly onBody?: (skill: { readonly name: string; readonly filePath: string }, ctx: LoadSkillContext) => void;
}

/**
 * Register `load_skill`.
 *
 * Skills are captured from `before_agent_start`, which carries both the fully
 * assembled system prompt and the structured `systemPromptOptions.skills` Pi
 * built it from. A delegate worker's list is intentionally scoped to its agent
 * declaration, so a miss triggers Pi's full resource loader before the tool
 * reports an unknown name. The context prompt remains a fallback for a first
 * call that somehow precedes the event. Neither source is a path built from
 * caller input.
 *
 * `readSkill` is injected so the registration is testable without a Pi host and
 * without touching the filesystem.
 */
export function registerLoadSkillTool(
	pi: LoadSkillToolAPI,
	readSkill: (filePath: string) => string = (filePath) => readFileSync(filePath, "utf8"),
	discoverSkills: (cwd: string, projectTrusted: boolean) => Promise<readonly DiscoveredSkill[]> = discoverAllSkills,
	registry?: SkillLoadHooks,
	options: LoadSkillRegistrationOptions = {},
): LoadSkillCapture {
	let captured: readonly DiscoveredSkill[] = [];
	let hasCapturedEvent = false;
	let fallbackContext: { cwd: string; projectTrusted: boolean } | undefined;
	let fallbackPromise: Promise<readonly DiscoveredSkill[]> | undefined;
	const capture: LoadSkillCapture = (event, ctx) => {
		const structured = event.systemPromptOptions?.skills;
		captured = structured && structured.length > 0
			? structured
			: skillsFromSystemPrompt(event.systemPrompt ?? "");
		hasCapturedEvent = true;
		// A host shim without isProjectTrusted gets the safe answer: project skills are not trusted.
		fallbackContext = { cwd: ctx.cwd, projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false };
		fallbackPromise = undefined;
	};
	if (options.listen !== false) pi.on("before_agent_start", capture);

	pi.registerTool({
		name: "load_skill",
		label: "Load Skill",
		description:
			"Load a skill's full instructions by name from Pi's discovered skill set. A skill need not appear in <available_skills>: when a prompt or skill tells you to load one, pass that name anyway. The path comes from the skill Pi discovered, so you never construct one. Use this instead of reading a skill path you worked out yourself — the plausible-looking ~/.pi/agent/skills/<name>/SKILL.md is wrong for most skills and fails silently, leaving you working without the contract you were told to follow.",
		promptSnippet: "Load a skill's instructions by name, so no skill path has to be guessed",
		promptGuidelines: [
			"When an instruction tells you to load a skill, call load_skill with that name even if it is absent from <available_skills>; that list is not exhaustive. Do not construct a skill path, and do not read one you inferred from another skill's location: package skills, user skills, and project skills all live in different places.",
			"If load_skill reports an unknown name, use one of the names it lists, or say the skill could not be loaded. Falling back to a guessed path is the failure this tool exists to prevent.",
			"If load_skill says a skill is already loaded, follow the pointer it gives: re-read the result it names, or restore the block it names as the pointer says. Do not load the skill again.",
		],
		parameters: PARAMETERS,
		async execute(toolCallId: string, params: LoadSkillParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: LoadSkillContext) {
			const declared = captured.length > 0
				? captured
				: skillsFromSystemPrompt(ctx.getSystemPrompt?.() ?? "");
			let skills = declared;
			let resolved = resolveSkill(params.name, declared);
			let fromFallback = false;
			if (hasCapturedEvent && !resolved.ok && (resolved.reason === "unknown" || resolved.reason === "no-skills")) {
				fallbackPromise ??= discoverSkills(fallbackContext!.cwd, fallbackContext!.projectTrusted).catch(() => []);
				const fallback = await fallbackPromise;
				if (fallback && fallback.length > 0) {
					skills = fallback;
					resolved = resolveSkill(params.name, fallback);
					fromFallback = resolved.ok;
				}
			}
			if (!resolved.ok && skills.length === 0 && declared.length > 0) {
				// A failed or empty fallback must not replace the prompt's useful refusal.
				skills = declared;
				resolved = resolveSkill(params.name, declared);
			}
			if (!resolved.ok) {
				return textResult(`load_skill: ${resolved.message}`, {
					error: resolved.reason,
					requested: params.name,
					available: availableNames(skills),
				});
			}

			const { skill, shadowed } = resolved;
			let body: string;
			try {
				body = readSkill(skill.filePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(
					`load_skill: "${skill.name}" is discovered at ${skill.filePath}, but reading it failed: ${message}. ` +
						"Report this rather than looking for the file somewhere else.",
					{ error: "unreadable", requested: params.name, path: skill.filePath },
				);
			}

			const decision = registry?.decide({
				name: skill.name,
				path: skill.filePath,
				body,
				force: params.force === true,
				...(ctx.sessionManager ? { sessionManager: ctx.sessionManager } : {}),
			});
			if (decision?.kind === "pointer") return textResult(decision.text, { ...decision.details });
			const header = fromFallback
				? `Skill "${skill.name}" loaded from ${skill.filePath}. This skill is outside this agent's declared skill set; it was resolved from Pi's full discovered skill set.`
				: `Skill "${skill.name}" loaded from ${skill.filePath}.`;
			const note = shadowed.length > 0
				? ` This copy shadows ${shadowed.length} other discovered copy/copies: ${shadowed.join(", ")}.`
				: "";
			const changed = decision?.kind === "body" && decision.changed
				? " The file changed since this skill was last loaded; this copy replaces the earlier one."
				: "";
			const text = `${header}${note}${changed}\n\n${body}`;
			registry?.record({ toolCallId, name: skill.name, path: skill.filePath, body, resultText: text });
			options.onBody?.({ name: skill.name, filePath: skill.filePath }, ctx);
			return textResult(text, {
				name: skill.name,
				path: skill.filePath,
				bytes: new TextEncoder().encode(body).length,
				shadowed,
				...(decision?.kind === "body" && decision.changed ? { changed: true } : {}),
			});
		},
	});
	return capture;
}
