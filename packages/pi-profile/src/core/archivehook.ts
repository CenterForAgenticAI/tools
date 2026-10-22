import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { restoreSession } from "./archive.ts";
import { processToolRunner, type ToolRunner } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { layoutFromEnv, type Env } from "./paths.ts";
import { localHost, printable } from "./repo.ts";
import { ARCHIVE_MARK, parseStubDetails, readStubFile } from "./sessionfile.ts";

/** What the session_before_switch hook decided for one target file. */
export type SwitchAction =
	| { readonly kind: "none" }
	| { readonly kind: "restored"; readonly note: string }
	| { readonly kind: "kept-both"; readonly note: string }
	| { readonly kind: "cancel"; readonly note: string };

/**
 * Before Pi opens target (/resume and session import): restore it from the
 * archive when it is a stub. Never throws. A stub that cannot be restored
 * cancels the switch, so Pi does not open the stub as if it were the
 * session; the note names the command to run in a shell.
 */
export function beforeSwitch(env: Env, target: string | undefined, run: ToolRunner = processToolRunner): SwitchAction {
	if (target === undefined || !isAbsolute(target) || !target.endsWith(".jsonl")) return { kind: "none" };
	let id: string;
	try {
		const st = lstatSync(target, { throwIfNoEntry: false });
		if (st?.isFile() !== true) return { kind: "none" };
		// Only the first lines are read: they hold a stub's notice, however large Pi has made the file.
		const stub = readStubFile(target);
		if (stub === undefined) return { kind: "none" };
		id = stub.id;
	} catch {
		return { kind: "none" };
	}
	const how = "run pi-profile sessions restore " + printable(id) + " in a shell, then /resume it again";
	try {
		const l = layoutFromEnv(env);
		const r = restoreSession(l, target, loadConfig(l, env).archive, { host: localHost(l, env), run });
		if (r.kind === "restored") return { kind: "restored", note: "archive: restored this session from the archive" + (r.warning === undefined ? "" : "; " + printable(r.warning)) };
		if (r.kind === "kept-both") return { kind: "kept-both", note: "archive: this stub has lines added after it was archived, so it is kept as it is; the full session is at " + printable(r.full ?? "?") };
		return { kind: "none" };
	} catch (error) {
		const why = error instanceof Error ? printable(error.message) : "unknown error";
		return { kind: "cancel", note: "archive: could not restore this session (" + why + "); " + how };
	}
}

/** The header and entries of the session Pi opened, as far as this module reads them. */
export interface OpenedSession {
	readonly header: { readonly id?: unknown } | null | undefined;
	readonly entries: ReadonlyArray<{ readonly type?: unknown; readonly customType?: unknown; readonly details?: unknown }>;
}

/**
 * The warning for a session that Pi opened at startup (pi --session, -c,
 * --resume picker, --fork): these choose a session before extensions load,
 * so session_before_switch does not run for them. Undefined when the session
 * carries no archive notice.
 */
export function startupNotice(s: OpenedSession): { readonly text: string; readonly stub: boolean } | undefined {
	const id = typeof s.header?.id === "string" ? s.header.id : undefined;
	for (const e of s.entries) {
		if (e.type !== "custom_message" || e.customType !== ARCHIVE_MARK) continue;
		const d = parseStubDetails(e.details);
		if (d === undefined) return undefined;
		if (d.sessionId === id) return { stub: true, text: "archive: this is the stub of an archived session; quit and run pi-profile sessions restore " + printable(d.sessionId) + ", or /resume it from inside Pi, to get its full history" };
		return { stub: false, text: "archive: this session was forked from an archived session's stub, so it holds only the first prompt; quit and run pi-profile sessions restore " + printable(d.sessionId) + ", then fork the restored session" };
	}
	return undefined;
}
