import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/cli/main.ts";
import type { Manifest } from "../src/core/manifest.ts";
import type { Layout } from "../src/core/paths.ts";
import { type ProfileInfo, type SaveHooks, updateManifest } from "../src/core/profiles.ts";

/**
 * False where rsync runs, else the reason to skip a test that runs the real
 * one. rsync is a runtime dependency of backups and pulls, but the public
 * release check image (node:24) has none. This project's CI sets
 * PI_PROFILE_REQUIRE_RSYNC=1, so there the tests run and a missing rsync fails.
 */
export const rsyncSkip: string | false =
	spawnSync("rsync", ["--version"]).status === 0 || process.env.PI_PROFILE_REQUIRE_RSYNC === "1" ? false : "rsync is not installed";
export interface Sandbox {
	readonly home: string;
	readonly l: Layout;
	readonly cleanup: () => void;
}

/** A fresh `~/.pi` with a default agent dir and a shared auth file. */
export function sandbox(): Sandbox {
	// The real path: `pushable` refuses a profile directory reached through a link, and tmpdir() is one on macOS.
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-profile-test-")));
	mkdirSync(join(home, "agent"), { recursive: true });
	writeFileSync(join(home, "agent", "auth.json"), '{"anthropic":{"type":"api_key","key":"shared"}}\n', { mode: 0o600 });
	return { home, l: { piHome: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export interface Captured extends Io {
	stdout: string;
	stderr: string;
	runs: Array<{ args: readonly string[]; env: Record<string, string> }>;
}

export function captureIo(env: Record<string, string | undefined>): Captured {
	const io: Captured = {
		env,
		stdout: "",
		stderr: "",
		runs: [],
		out: (t) => {
			io.stdout += t;
		},
		err: (t) => {
			io.stderr += t;
		},
		runPi: (args, e) => {
			io.runs.push({ args, env: e });
			return 0;
		},
	};
	return io;
}

/**
 * Test shorthand: save a whole manifest through updateManifest. Production
 * code must derive the new manifest from the value updateManifest passes in.
 */
export function saveManifest(
	l: Layout,
	name: string,
	manifest: Manifest,
	opts: { copyAuth?: boolean } = {},
	hooks: SaveHooks = {},
): ProfileInfo {
	return updateManifest(l, name, () => manifest, opts, hooks);
}
