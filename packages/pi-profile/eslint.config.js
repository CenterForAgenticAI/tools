import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["coverage/**", "dist/**", "node_modules/**", ".worktrees/**", ".bun-cache/**", "model/**", "*.tgz"],
	},
	{
		files: ["**/*.{js,mjs,cjs,ts}"],
		languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
		linterOptions: { reportUnusedDisableDirectives: "error" },
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		// src/core is the pure-ish domain: it must not load the Pi SDK.
		files: ["src/core/**/*.ts", "src/cli/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", { patterns: [{ group: ["@earendil-works/*"], message: "core and cli must not import the Pi SDK." }] }],
		},
	},
);
