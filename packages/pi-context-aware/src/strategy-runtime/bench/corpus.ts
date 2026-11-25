/**
 * The strategy bench's corpus (pi-context-aware#469): session files under one or more labelled roots,
 * in a fixed order. It reads directories and file metadata only; it opens no file for writing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CorpusRoot {
	/** Host label shown in the report, such as `chris-dev`. */
	readonly label: string;
	readonly dir: string;
}

export interface CorpusFile {
	readonly label: string;
	/** Path under the root, with `/` separators. */
	readonly relative: string;
	readonly absolute: string;
	readonly bytes: number;
	/** A Fabric worker or subagent session (under `.fabric/` or `subagents/`). */
	readonly child: boolean;
}

export interface CorpusOptions {
	/** Epoch milliseconds: only files modified at or after this time. */
	readonly since?: number;
}

const CHILD_DIRS = /(^|\/)(\.fabric|subagents)\//u;

/** Compare strings by UTF-16 code units: the same order on every host and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function walk(dir: string, relative: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(rel);
	}
}

/** Every `.jsonl` file under each root (hidden directories included), roots in the order given, files by path. */
export function listCorpus(roots: readonly CorpusRoot[], options: CorpusOptions = {}): CorpusFile[] {
	return roots.flatMap((root) => {
		const found: string[] = [];
		walk(root.dir, "", found);
		return found.sort(byCodeUnit).flatMap((relative): CorpusFile[] => {
			const absolute = path.join(root.dir, ...relative.split("/"));
			let stat: { readonly size: number; readonly mtimeMs: number };
			try {
				stat = fs.statSync(absolute);
			} catch {
				return [];
			}
			if (options.since !== undefined && stat.mtimeMs < options.since) return [];
			return [{ label: root.label, relative, absolute, bytes: stat.size, child: CHILD_DIRS.test(relative) }];
		});
	});
}
