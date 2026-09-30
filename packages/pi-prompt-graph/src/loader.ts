import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface LoadedGraphSource {
	readonly path: string;
	readonly document: unknown;
	readonly bodyBytes: number;
	readonly sha256: string;
}

export interface GraphLoadResult {
	source?: LoadedGraphSource;
	diagnostics: Array<{ code: "E-SOURCE-SYNTAX"; severity: "error"; message: string; path?: string }>;
}

export interface GraphLoaderBoundary {
	readonly source: LoadedGraphSource;
}

/** Read and decode one graph file. Compilation remains responsible for shape validation. */
export async function loadGraphSource(path: string): Promise<GraphLoadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { diagnostics: [{ code: "E-SOURCE-SYNTAX", severity: "error", message: error instanceof Error ? error.message : "Unable to read graph source.", path }] };
	}
	if (!/^---\s*\n/.test(text) || !/\n---(?:\s*\n|\s*$)/.test(text)) return { diagnostics: [{ code: "E-SOURCE-SYNTAX", severity: "error", message: "Graph source has no complete frontmatter block.", path }] };
	try {
		const parsed = parseFrontmatter(text);
		return { source: { path, document: parsed.frontmatter, bodyBytes: Buffer.byteLength(text), sha256: sourceSha256(text) }, diagnostics: [] };
	} catch (error) {
		return { diagnostics: [{ code: "E-SOURCE-SYNTAX", severity: "error", message: error instanceof Error ? error.message : "Graph frontmatter is not valid YAML.", path }] };
	}
}

export function sourceSha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}
