// Splits an agent definition file into its YAML frontmatter and its Markdown
// body, and joins them back. The rules are in docs/format.md under "File layout".

import { stringify } from "yaml";

export type SplitErrorCode = "missing-opening-fence" | "missing-closing-fence";

export type SplitResult =
	| {
			readonly ok: true;
			/** YAML text between the fences. It always starts on line 2 of the file. */
			readonly frontmatter: string;
			/** Everything after the closing fence, unchanged apart from line endings. */
			readonly body: string;
			/** 1-based line of the file where the body starts. */
			readonly bodyLine: number;
	  }
	| {
			readonly ok: false;
			readonly code: SplitErrorCode;
			/** 1-based line of the file the error refers to. */
			readonly line: number;
			readonly message: string;
	  };

const OPENING_FENCE = /^---[ \t]*(?:\n|$)/;
const FENCE = /^---[ \t]*$/;

export function splitFrontmatter(source: string): SplitResult {
	const text = (source.startsWith("\uFEFF") ? source.slice(1) : source).replace(/\r\n/g, "\n");
	if (!OPENING_FENCE.test(text)) {
		return {
			ok: false,
			code: "missing-opening-fence",
			line: 1,
			message: "An agent definition must start with a line that contains only ---.",
		};
	}
	const lines = text.split("\n");
	const closing = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
	if (closing === -1) {
		return {
			ok: false,
			code: "missing-closing-fence",
			line: 1,
			message: "The frontmatter that starts on line 1 has no closing line that contains only ---.",
		};
	}
	return {
		ok: true,
		frontmatter: lines.slice(1, closing).join("\n"),
		body: lines.slice(closing + 1).join("\n"),
		bodyLine: closing + 2,
	};
}

/**
 * Write frontmatter fields and a body as one definition file. Keys keep their
 * insertion order; `undefined` values are left out. Empty fields give an empty
 * frontmatter block. `splitFrontmatter` returns the same body unchanged.
 */
export function joinFrontmatter(fields: Readonly<Record<string, unknown>>, body: string): string {
	const present = Object.entries(fields).filter(([, value]) => value !== undefined);
	const yaml = present.length === 0 ? "" : stringify(Object.fromEntries(present), { lineWidth: 0 });
	return `---\n${yaml}---\n${body}`;
}
