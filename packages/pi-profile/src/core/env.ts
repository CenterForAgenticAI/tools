import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fail, ok, type Result } from "./result.ts";

/**
 * The only environment variables a profile may set. Same list as the fish
 * utility's profile-env.json, so existing profiles import unchanged.
 */
export const ENV_KEYS = [
	"PI_MEMORY_DIR",
	"PI_MEMORY_SNAPSHOT",
	"PI_MEMORY_QMD_UPDATE",
	"PI_MEMORY_EXIT_SUMMARY",
	"ACP_AUTO_UPDATE",
	"ACP_DELEGATE",
	"ACP_LOG_FILE",
	"ACP_UPDATE_THROTTLE_FILE",
] as const;

/** Path-valued keys: absolute, and inside the profile directory. */
export const ENV_PATH_KEYS: ReadonlySet<string> = new Set(["PI_MEMORY_DIR", "ACP_LOG_FILE", "ACP_UPDATE_THROTTLE_FILE"]);

// Control characters would let a value break out of shell quoting or a log line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isEnvKey(key: string): boolean {
	return (ENV_KEYS as readonly string[]).includes(key);
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The first existing component of `target` below `root` that is a symlink,
 * or `undefined`. A symlink there could point anywhere, so a path that
 * passes through one is not "inside the profile" even if its text is.
 * The profile directory itself may be a link (the profiles root allows that).
 */
function symlinkOnPath(root: string, target: string): string | undefined {
	let at = realOrSelf(root);
	for (const part of relative(root, target).split(sep)) {
		at = `${at}${sep}${part}`;
		let st;
		try {
			st = lstatSync(at);
		} catch {
			return undefined;
		}
		if (st.isSymbolicLink()) return at;
	}
	return undefined;
}

export function validateEnv(raw: unknown, profileDir: string): Result<Record<string, string>> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("env must be a JSON object");
	const out: Record<string, string> = {};
	const errors: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (!isEnvKey(key)) {
			errors.push(`env: ${key} is not an allowed variable`);
			continue;
		}
		if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value)) {
			errors.push(`env: ${key} must be a plain string`);
			continue;
		}
		if (ENV_PATH_KEYS.has(key)) {
			const within = resolve(profileDir);
			// The value must already be normal: "a/link/../b" is resolved by the
			// kernel through the link, not by the text, so ".." is not allowed.
			if (!value.startsWith("/") || resolve(value) !== value || !value.startsWith(within + sep)) {
				errors.push(`env: ${key} must be an absolute path inside the profile`);
				continue;
			}
			const link = symlinkOnPath(within, resolve(value));
			if (link !== undefined) {
				errors.push(`env: ${key} passes through a symlink (${link}); it must stay inside the profile`);
				continue;
			}
		}
		out[key] = value;
	}
	return errors.length > 0 ? { ok: false, errors } : ok(out);
}
