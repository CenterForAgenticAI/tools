/**
 * Named system-prompt sections owned by context-aware.
 *
 * Pi 1.0 builds the system prompt from named sections and sends a changed
 * section as an update instead of rewriting the whole prompt. Each block this
 * extension injects gets its own section, so a change to one input (a focus
 * edit, a new cache document, a compaction) touches only that section and the
 * others stay byte-identical across turns.
 *
 * Per-turn state (pressure telemetry and the task list) is not a section. A
 * model that cannot take system messages mid-conversation has every section
 * update folded back into the leading system prompt, so per-turn text there
 * would rewrite the cached prefix on every turn. That state stays in the
 * hidden late message instead.
 */

/** Section names, in the order this extension inserts them. */
export const PROMPT_SECTION = {
	/** Telemetry-reading and pressure-band guidance. Changes only with compaction availability. */
	contextAwareness: "context-awareness",
	/** Durable-focus tool guidance. Changes only with session role and tool reachability. */
	focusGuidance: "durable-focus-guidance",
	/** One section for the context tools. Changes only with which of them are reachable. */
	contextTools: "context-tools",
	/** Count of cached reference documents. Changes when the document count changes. */
	contextCache: "context-cache",
	/** Current durable focus. Changes when the focus changes. */
	sessionFocus: "session_focus",
	/** Compaction count of the current branch. Changes after a compaction. */
	compactionHistory: "compaction_history",
} as const;

export type PromptSectionName = typeof PROMPT_SECTION[keyof typeof PROMPT_SECTION];

/** Desired content per owned section; `null` means the section is absent this turn. */
export type PromptSectionValues = { readonly [Name in Exclude<PromptSectionName, "context-tools">]: string | null }
	& { readonly "context-tools"?: string | null };

/** Which context tools the session can reach; the section names only these. */
export interface ContextToolsAvailability {
	readonly status: boolean;
	readonly recall: boolean;
	readonly fold: boolean;
	readonly compact: boolean;
}

/**
 * The one guidance section for the context tools (pi-context-aware#195).
 *
 * Each tool's own prompt snippet and guidelines stay short; the shared advice
 * lives here once. The section, snippets and guidelines together stay under
 * 1,500 tokens (tests/context-tool-guidance.test.ts). Returns `null` when no context tool is reachable.
 */
export function buildContextToolsSection(available: ContextToolsAvailability): string | null {
	const lines: string[] = [];
	if (available.status) lines.push("- context_status: read context size, stage, compactions and active folds. Cache numbers: the user runs /context-status cache.");
	if (available.recall) lines.push("- context_recall: get back text that left context. query searches earlier sessions and the cache; scope \"session\" or include_current: true also searches this session, folded text included. ref (a fold id such as b5) returns the original entries behind a fold.");
	if (available.fold) lines.push("- context_fold: replace a consumed range of messages (by acp refs) with a summary you write. Keep paths, errors and decisions verbatim. Never fold what the current step still uses.");
	if (available.compact) lines.push("- context_compact: end a phase at a clean boundary and continue from a seed_prompt. Call it alone in its response.");
	if (lines.length === 0) return null;
	return [
		"Context tools:",
		...lines,
		`Under pressure: ${available.fold ? "fold what you have finished with, " : ""}${available.compact ? "compact at a phase boundary, " : ""}and recall instead of guessing or asking the user to paste again.`,
	].join("\n");
}

/** The parts of Pi's `before_agent_start` event this module reads and mutates. */
export interface PromptSectionEvent {
	readonly systemPrompt?: string;
	readonly systemPromptOptions?: {
		sections?: Record<string, string>;
		forceSystemPrompt?: string;
	};
}

const OWNED_SECTION_NAMES: readonly PromptSectionName[] = Object.values(PROMPT_SECTION);

/**
 * Section content for a block already framed as `<name>\n...\n</name>`.
 *
 * Pi frames every custom section in a tag of the section's name, so the
 * content is the block's body and the rendered prompt keeps the block's exact
 * bytes. A block without that exact frame is kept whole.
 */
export function sectionContent(name: PromptSectionName, block: string | null): string | null {
	if (block === null) return null;
	const open = `<${name}>\n`;
	const close = `\n</${name}>`;
	return block.startsWith(open) && block.endsWith(close) && block.length >= open.length + close.length
		? block.slice(open.length, block.length - close.length)
		: block;
}

/** Render one section the way Pi renders a custom section into the prompt. */
export function renderPromptSection(name: string, content: string): string {
	return `<${name}>\n${content}\n</${name}>`;
}

/**
 * Write the owned sections into the event's mutable prompt options.
 *
 * Returns `undefined` when the sections will reach the model. When an earlier
 * handler already replaced the whole prompt, Pi ignores sections, so this
 * returns that prompt with the sections rendered after it; the caller must
 * return it as `systemPrompt` or the guidance is lost.
 */
export function applyPromptSections(event: PromptSectionEvent, values: PromptSectionValues): string | undefined {
	const options = event.systemPromptOptions;
	const sections = options?.sections;
	if (options?.forceSystemPrompt !== undefined || typeof sections !== "object" || sections === null) {
		const base = event.systemPrompt ?? "";
		const rendered = OWNED_SECTION_NAMES.flatMap((name) => {
			const content = values[name];
			if (!content) return [];
			const block = renderPromptSection(name, content);
			return base.includes(block) ? [] : [block];
		});
		return [base, ...rendered].filter((part) => part.length > 0).join("\n\n");
	}
	for (const name of OWNED_SECTION_NAMES) {
		const content = values[name];
		if (content) sections[name] = content;
		else delete sections[name];
	}
	return undefined;
}
