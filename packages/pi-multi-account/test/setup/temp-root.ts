import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives one Vitest run a temp root of its own, then deletes it.
 *
 * `npm test` already runs under scripts/with-temp-root.mjs. A direct
 * `npx vitest run <file>` did not, so every fixture that used os.tmpdir()
 * wrote into the machine's shared temp directory and anything a test left
 * behind stayed there (#188).
 *
 * os.tmpdir() reads TMPDIR (TMP and TEMP on other platforms). Global setup runs
 * before Vitest starts its workers, and workers inherit this environment, so
 * pointing these at the run root moves every fixture at once. Under the
 * wrapper the root is nested inside the wrapper's own root; both are removed.
 *
 * Set PI_KEEP_TEST_TMP=1 to keep the root for inspection after a failure.
 */
const TEMP_KEYS = ["TMPDIR", "TMP", "TEMP", "TMUX_TMPDIR"] as const;

function usableDir(value: string): boolean {
	try {
		accessSync(value, constants.W_OK);
		return statSync(value).isDirectory();
	} catch {
		return false;
	}
}

/** os.tmpdir() with TMPDIR, TMP and TEMP ignored, as scripts/with-temp-root.mjs does. */
function platformTempDir(): string {
	const saved = ["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]] as const);
	for (const [key] of saved) Reflect.deleteProperty(process.env, key);
	try {
		return tmpdir();
	} finally {
		for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
	}
}

export default function setup(): () => void {
	// A stale TMPDIR, such as a run root that was already removed, falls back to
	// the platform default instead of failing the run.
	const configured = tmpdir();
	const base = usableDir(configured) ? configured : platformTempDir();
	const root = mkdtempSync(join(base, "pi-multi-account-vitest-"));
	const saved = new Map<string, string | undefined>(
		TEMP_KEYS.map((key) => [key, process.env[key]]),
	);
	for (const key of TEMP_KEYS) process.env[key] = root;
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		if (process.env.PI_KEEP_TEST_TMP === "1") {
			console.error(`temp-root: keeping ${root} (PI_KEEP_TEST_TMP=1)`);
			return;
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (error) {
			// A leak is what this exists to stop, so say so; a passing run stays green.
			console.error(
				`temp-root: could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}
