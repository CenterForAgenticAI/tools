import type { AgentDefinition, Diagnostic } from "./definition.ts";

/** What happened to one field when a definition was read from, or written for, another format or runtime. */
export type LoweringAction = "dropped" | "weakened" | "inlined" | "unmapped";

export interface LoweringEntry {
	/** Field path in the definition, such as `workspace.isolation`, or the foreign key on an import. */
	readonly path: string;
	readonly action: LoweringAction;
	/** What the target holds instead, such as `isolation: worktree`. Omitted when nothing replaces the field. */
	readonly result?: string;
	/** Why, in one sentence. */
	readonly reason: string;
}

export interface LoweringReport {
	/** The format or runtime, such as `claude-code`, `opencode`, `pi-agents` or `pi-durable`. */
	readonly target: string;
	readonly direction: "import" | "export" | "runtime";
	readonly entries: readonly LoweringEntry[];
}

/** Render a lowering report as plain text, one line per changed field. */
export function formatLoweringReport(report: LoweringReport): string {
	const count = report.entries.length;
	const heading = `${report.direction} ${report.target}: ${count === 0 ? "nothing lost" : `${count} ${count === 1 ? "change" : "changes"}`}`;
	const lines = report.entries.map((entry) => {
		const outcome = entry.result === undefined ? entry.action : `${entry.action} to "${entry.result}"`;
		return `- ${entry.path}: ${outcome}. ${entry.reason}`;
	});
	return [heading, ...lines].join("\n") + "\n";
}

/** Options for reading another tool's agent file. */
export interface ImportOptions {
	/** The file's path or name. Some formats take the agent's name from it. */
	readonly file?: string;
}

/**
 * The result of reading another tool's agent file. A foreign key with no
 * mapping is kept under `runtimes.<format name>` and listed in the report with
 * the action `unmapped`, so an import never drops a field silently.
 */
export type ImportResult =
	| {
			readonly ok: true;
			readonly definition: AgentDefinition;
			readonly report: LoweringReport;
			readonly diagnostics: readonly Diagnostic[];
	  }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** One file an export writes, at a path relative to the project root, such as `.claude/agents/reviewer.md`. */
export interface ExportedFile {
	readonly path: string;
	readonly text: string;
}

/** The result of writing a definition in another tool's format. */
export interface ExportResult {
	readonly files: readonly ExportedFile[];
	readonly report: LoweringReport;
}

/** Another tool's agent file format. A format may support import, export or both. */
export interface AgentFormat {
	/** Lowercase name with hyphens, such as `claude-code`. Also the `runtimes` key for its unmapped fields. */
	readonly name: string;
	readonly import?: (source: string, options: ImportOptions) => ImportResult;
	readonly export?: (definition: AgentDefinition) => ExportResult;
}
