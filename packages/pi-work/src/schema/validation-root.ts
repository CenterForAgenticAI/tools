import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Find the repository that owns a spec, not the process that happens to read it. */
export function validationRootForSpec(specPath: string, fallbackCwd: string = process.cwd()): string {
	let canonicalSpecPath = path.resolve(specPath);
	try {
		canonicalSpecPath = realpathSync(canonicalSpecPath);
	} catch {
		// In-memory validation and missing paths still use the supplied location.
	}
	const specDirectory = path.dirname(canonicalSpecPath);
	try {
		return execFileSync("git", ["-C", specDirectory, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		// A spec may live in a project that has no Git repository.
	}
	let directory = specDirectory;
	for (;;) {
		try {
			if (statSync(path.join(directory, ".work")).isDirectory()) return directory;
		} catch { /* no .work directory here */ }
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return path.resolve(fallbackCwd);
}
