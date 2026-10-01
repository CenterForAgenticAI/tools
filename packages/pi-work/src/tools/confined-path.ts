import path from "node:path";

import type { PathInputFinding } from "../schema/findings.js";

export type ConfinedPathResult =
	| { readonly ok: true; readonly relativePath: string }
	| { readonly ok: false; readonly finding: PathInputFinding };

function isAbsolutePath(value: string): boolean {
	return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Keep pi's @ convenience while rejecting an unprefixed absolute path. */
/** What a relative tool path is resolved against; named in the rejection so the caller can fix it. */
export type PathBase = "working-directory" | "worktreePath";

const BASE_TEXT: Readonly<Record<PathBase, string>> = {
	"working-directory": "the working directory (the session's cwd)",
	worktreePath: "the worktreePath you pass in this call",
};

export function confinedPath(value: string, parameter: string, base: PathBase): ConfinedPathResult {
	if (value.startsWith("@")) {
		return { ok: true, relativePath: value.slice(1).replace(/^[/\\]+/, "") };
	}
	if (!isAbsolutePath(value)) return { ok: true, relativePath: value };
	const message = `tool paths are confined to ${BASE_TEXT[base]}: ${parameter} must be relative to it, and absolute paths are not allowed: ${JSON.stringify(value)}`;
	return {
		ok: false,
		finding: {
			code: "absolute-path",
			severity: "error",
			path: [parameter],
			message,
			suppliedPath: value,
		},
	};
}
