import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["coverage/**", "dist/**", ".test-dist/**", "node_modules/**", ".worktrees/**", "*.tgz"],
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
		// L3.2/L3.3: the contract is pure. It must stay importable by pi-daemon and
		// pi-delegate without loading the pi SDK or touching I/O.
		files: ["src/contract/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{ group: ["@earendil-works/*"], message: "src/contract must not import the pi SDK." },
						{ group: ["node:*"], message: "src/contract must not do I/O." },
						{ group: ["typebox"], message: "src/contract has no runtime dependencies." },
						{ group: ["../*"], message: "src/contract must not import the rest of the package." },
					],
				},
			],
		},
	},
);
