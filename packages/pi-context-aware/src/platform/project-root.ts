import fs from "node:fs";
import path from "node:path";

/** Nearest checkout root, including linked worktrees and submodules. Ignores Git environment overrides. */
export function projectRootFromCwd(cwd: string): string | null {
	try {
		let current = fs.realpathSync(cwd);
		fs.readdirSync(current);
		for (;;) {
			if (fs.existsSync(path.join(current, ".git"))) return current;
			const parent = path.dirname(current);
			if (parent === current) return cwd;
			current = parent;
		}
	} catch { return null; }
}
