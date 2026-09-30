import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCatalog } from "../model.js";

/**
 * What a resolved agent definition contributes to a worker's command line.
 *
 * Deliberately not a mirror of `pi-delegate`'s full frontmatter. This carries the
 * four things a child process can actually be started with, and nothing else: a
 * field we cannot translate into a `pi` flag would be a promise we do not keep.
 */
export interface AgentDefinition {
	readonly name: string;
	/** The file body, which becomes the worker's system prompt. */
	readonly prompt: string;
	/** `replace` overwrites Pi's own system prompt; `append` adds to it. */
	readonly promptMode: "replace" | "append";
	readonly model?: string;
	readonly tools?: readonly string[];
}

/** Resolves an agent name to its definition, or `undefined` when nothing declares it. */
export interface AgentResolver {
	resolve(name: string): Promise<AgentDefinition | undefined>;
}

/**
 * Where agent definitions live, lowest precedence first.
 *
 * This mirrors `pi-delegate`'s documented discovery order, minus the two scopes a
 * child process cannot see: `builtin` agents live inside that extension, and
 * `package` agents come from an installed package's declared directory. Both are
 * resolved by machinery we would have to import to reach, and D-006 plus
 * `.spec/0009` §7 — peers own their planes — say we do not.
 *
 * The consequence is worth stating plainly rather than discovering later: a graph
 * naming `reviewer` gets the *project or user* file of that name, and never
 * `pi-delegate`'s builtin or package agent of the same name. A name that exists
 * only as a builtin does not resolve here at all, and the node fails saying so.
 * That is the honest failure, and it is why the message names the directories
 * that were searched.
 */
function searchPath(cwd: string): string[] {
	const home = homedir();
	return [
		join(home, ".agents"),
		join(home, ".pi", "agent", "agents"),
		join(cwd, ".agents"),
		join(cwd, ".pi", "agents"),
	];
}

/** The value of one frontmatter key, or undefined. Quotes are stripped; nothing else is interpreted. */
function scalar(frontmatter: string, key: string): string | undefined {
	for (const line of frontmatter.split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
		if (!match || match[1] !== key) continue;
		const raw = (match[2] ?? "").trim();
		if (!raw) return undefined;
		const unquoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
		return (unquoted?.[1] ?? raw).trim();
	}
	return undefined;
}

/** A `[a, b]` inline array or a bare comma-separated list. Both spellings are in the wild. */
function list(frontmatter: string, key: string): string[] | undefined {
	const raw = scalar(frontmatter, key);
	if (raw === undefined) return undefined;
	const inner = /^\[(.*)\]$/.exec(raw)?.[1] ?? raw;
	const items = inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	return items.length ? items : undefined;
}

/**
 * Parses one agent file into the parts a worker can be started with.
 *
 * Returns undefined when the file has no frontmatter or declares no `name`, which
 * is exactly when `pi-delegate` skips it too. A file that cannot be understood is
 * not silently treated as an agent with a blank prompt.
 */
export function parseAgentFile(source: string): AgentDefinition | undefined {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
	if (!match) return undefined;
	const [, frontmatter = "", body = ""] = match;
	const name = scalar(frontmatter, "name");
	if (!name) return undefined;

	// `name` comes from the frontmatter, not the filename: that is pi-delegate's
	// rule, and a mismatch there is a documented source of "I edited the file and
	// nothing changed".
	const declared = scalar(frontmatter, "systemPromptMode") ?? scalar(frontmatter, "system_prompt_mode");
	const model = scalar(frontmatter, "model");
	const tools = list(frontmatter, "tools");
	return {
		name,
		prompt: body.trim(),
		promptMode: declared === "append" ? "append" : "replace",
		...(model === undefined ? {} : { model }),
		...(tools === undefined ? {} : { tools }),
	};
}

/** The directories a failed resolution searched, for the message the node fails with. */
export function agentSearchPath(cwd: string): readonly string[] {
	return searchPath(cwd);
}

/**
 * Names an invalid candidate well enough to prevent a lower definition from
 * being selected in its place. A readable malformed file may still declare a
 * name; an unreadable file can only be identified by its filename.
 */
function invalidCandidateName(entry: string, source?: string): string {
	return (source === undefined ? undefined : scalar(source, "name")) ?? entry.slice(0, -".md".length);
}

/**
 * Resolves and catalogues agent names from the filesystem, later scopes winning.
 *
 * Both public operations perform the same discovery on every call. The compile
 * catalogue is one immutable snapshot, while runtime resolution deliberately
 * refreshes so an agent edited after compilation is not silently stale.
 */
export class FileAgentResolver implements AgentResolver {
	constructor(private readonly cwd: string) {}

	async catalog(): Promise<AgentCatalog> {
		const definitions = await this.discover();
		const entries = Object.freeze(Object.fromEntries([...definitions.keys()].map((name) => [name, true] as const)));
		return Object.freeze({ entries });
	}

	async resolve(name: string): Promise<AgentDefinition | undefined> {
		return (await this.discover()).get(name);
	}

	private async discover(): Promise<Map<string, AgentDefinition>> {
		const found = new Map<string, AgentDefinition>();
		for (const directory of searchPath(this.cwd)) {
			let entries: string[];
			try {
				entries = await readdir(directory);
			} catch {
				// An absent or unreadable directory exposes no candidates, so it cannot
				// shadow anything found in a lower-precedence scope.
				continue;
			}
			for (const entry of entries) {
				// Reserved for saved chain definitions, and excluded from agent
				// discovery. A file named `reviewer.chain.md` is not an agent.
				if (!entry.endsWith(".md") || entry.endsWith(".chain.md")) continue;
				let source: string;
				try {
					source = await readFile(join(directory, entry), "utf8");
				} catch {
					// The discovered higher-precedence candidate owns this effective
					// name even though it cannot become a catalogue entry. Falling back
					// could execute a different, lower-precedence agent silently.
					found.delete(invalidCandidateName(entry));
					continue;
				}
				const parsed = parseAgentFile(source);
				// Later scopes win, and within one directory the last matching file does.
				if (parsed) found.set(parsed.name, parsed);
				else found.delete(invalidCandidateName(entry, source));
			}
		}
		return found;
	}
}
