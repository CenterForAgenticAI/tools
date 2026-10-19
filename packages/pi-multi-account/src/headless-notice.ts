import { parseArgs } from "@earendil-works/pi-coding-agent";

/**
 * Whether this process is a Pi print-mode run: `--print`, `--mode json`, or a
 * stdin or stdout that is not a terminal. It mirrors the host's
 * `resolveAppMode` through Pi's own parser. RPC and interactive processes never
 * qualify, so a write here never lands on a TUI or on an RPC stdout stream.
 */
export function isPrintModeProcess(
	argv: readonly string[],
	stdinIsTTY: boolean | undefined,
	stdoutIsTTY: boolean | undefined,
): boolean {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs([...argv]);
	} catch {
		return false;
	}
	if (parsed.mode === "rpc") return false;
	if (parsed.mode === "json") return true;
	return parsed.print === true || stdinIsTTY !== true || stdoutIsTTY !== true;
}

/**
 * Print mode binds no extension UI, so `ui.notify` is discarded and a refused
 * prompt would end with no output. Write the same notice as one stderr line,
 * and only in a print-mode process.
 */
export function writeHeadlessNotice(text: string): void {
	if (
		!isPrintModeProcess(
			process.argv.slice(2),
			process.stdin.isTTY,
			process.stdout.isTTY,
		)
	) {
		return;
	}
	process.stderr.write(`${text.replace(/[\r\n]+/g, " ")}\n`);
}
