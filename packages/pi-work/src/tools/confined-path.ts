import path from "node:path";

import type { PathInputFinding } from "../schema/findings.js";

export type ConfinedPathResult =
	| { readonly ok: true; readonly relativePath: string }
	| { readonly ok: false; readonly finding: PathInputFinding };

function isAbsolutePath(value: string): boolean {
	return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Keep pi's @ convenience while rejecting an unprefixed absolute path. */
export function confinedPath(value: string, parameter: string): ConfinedPathResult {
	if (value.startsWith("@")) {
		return { ok: true, relativePath: value.slice(1).replace(/^[/\\]+/, "") };
	}
	if (!isAbsolutePath(value)) return { ok: true, relativePath: value };
	const message = `tool paths are confined to the working directory; absolute paths are not allowed: ${JSON.stringify(value)}`;
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
