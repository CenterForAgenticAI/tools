/**
 * `reads:` field handling for direct + chain modes.
 *
 * pi-subagents lets an agent declare files it wants pre-loaded as context
 * before its task message runs. We replicate that by reading each path
 * (resolved against the worker cwd), wrapping the contents in
 * `<context-file path="…">…</context-file>` blocks, and prepending the
 * combined block to the worker's first user message.
 *
 * Missing or unreadable files surface as `ContextFileWarning`s and
 * placeholder `<context-file path="…" missing="true"/>` blocks so the
 * worker still sees the request and can react. Oversized files are
 * truncated at `DEFAULT_MAX_BYTES_PER_FILE` and tagged with
 * `truncated="true"`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Hard cap per file. Anything larger is truncated and tagged. */
export const DEFAULT_MAX_BYTES_PER_FILE = 200 * 1024;

export interface ContextFileWarning {
	path: string;
	reason: "missing" | "not-a-file" | "truncated" | "read-failed";
	details?: string;
}

export interface ContextFilesResult {
	/** Combined block ready to prepend ahead of the user task. Empty when `reads` is empty. */
	block: string;
	/** Files that couldn't be read or had to be truncated. */
	warnings: ContextFileWarning[];
}

export interface ComposeReadsArgs {
	reads: string[];
	baseCwd: string;
	maxBytesPerFile?: number;
}

/**
 * Read each path (resolved against `baseCwd`) and produce a single block
 * of `<context-file path="…">…</context-file>` entries.
 *
 * - Missing files: emit a self-closing placeholder `<context-file path=… missing="true"/>`
 *   and a warning (reason="missing").
 * - Non-files (dirs, sockets, …): same shape, reason="not-a-file".
 * - Oversized files: truncate at `maxBytesPerFile` and tag `truncated="true"`.
 * - Read errors: placeholder + warning (reason="read-failed").
 *
 * Block path attributes are emitted with the *raw* user-supplied path
 * (not the absolute resolution) so the worker sees the same string the
 * agent author typed.
 */
export function composeReadsBlock(args: ComposeReadsArgs): ContextFilesResult {
	const max = args.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
	const warnings: ContextFileWarning[] = [];
	const parts: string[] = [];

	for (const raw of args.reads) {
		const resolved = path.isAbsolute(raw) ? raw : path.resolve(args.baseCwd, raw);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch (err: any) {
			const reason: ContextFileWarning["reason"] =
				err?.code === "ENOENT" ? "missing" : "read-failed";
			warnings.push({ path: raw, reason, details: err?.message ?? String(err) });
			parts.push(`<context-file path="${escapeAttr(raw)}" missing="true"/>`);
			continue;
		}
		if (!stat.isFile()) {
			warnings.push({ path: raw, reason: "not-a-file", details: "not a regular file" });
			parts.push(`<context-file path="${escapeAttr(raw)}" missing="true"/>`);
			continue;
		}
		let buf: Buffer;
		try {
			buf = fs.readFileSync(resolved);
		} catch (err: any) {
			warnings.push({ path: raw, reason: "read-failed", details: err?.message ?? String(err) });
			parts.push(`<context-file path="${escapeAttr(raw)}" missing="true"/>`);
			continue;
		}
		const truncated = buf.byteLength > max;
		const text = truncated ? buf.subarray(0, max).toString("utf-8") : buf.toString("utf-8");
		if (truncated) {
			warnings.push({
				path: raw,
				reason: "truncated",
				details: `truncated to ${max} bytes (file is ${buf.byteLength})`,
			});
		}
		const openTag = truncated
			? `<context-file path="${escapeAttr(raw)}" truncated="true">`
			: `<context-file path="${escapeAttr(raw)}">`;
		parts.push(`${openTag}\n${text}\n</context-file>`);
	}

	return { block: parts.join("\n\n"), warnings };
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Render a one-line warning string suitable for the tool result's
 * `(warnings: …)` suffix. Returns `""` when there are no warnings.
 */
export function formatReadsWarnings(warnings: readonly ContextFileWarning[]): string {
	if (warnings.length === 0) return "";
	return warnings
		.map((w) => {
			const detail = w.details ? ` (${w.details})` : "";
			return `${w.path}: ${w.reason}${detail}`;
		})
		.join("; ");
}
