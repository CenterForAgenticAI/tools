import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Pin discovery to this project's test/ directory only.
		// Without this, vitest follows .scratch/reference/ symlinks and picks
		// up failing tests from pi-ananke-sessions, graft worktrees, etc.
		include: ["test/**/*.test.ts"],
		exclude: ["node_modules/**", ".scratch/**"],
	},
});
