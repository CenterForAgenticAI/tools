import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CodexContractError } from "./codex-adapter.js";

/**
 * Host boundary: Pi's extension loader aliases only the pi-ai root, `/compat`,
 * `/oauth` and `/providers/all`. Every other `@earendil-works/pi-ai/<subpath>`
 * resolves beneath the aliased root file (`dist/compat.js/<subpath>`) and
 * cannot load, so entries here try loader-safe specifiers first and keep any
 * other subpath behind a guarded fallback for plain Node. See UPSTREAM.md.
 */

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

/** pi-ai specifiers the Codex stream resolver may import. */
export type CodexStreamSpecifier =
	| "@earendil-works/pi-ai"
	| "@earendil-works/pi-ai/api/openai-codex-responses"
	| "@earendil-works/pi-ai/compat";

export type ModuleImporter = (specifier: CodexStreamSpecifier) => Promise<unknown>;

// Literal specifiers keep the imports visible to Pi's loader and to bundlers.
const defaultImporter: ModuleImporter = (specifier) => {
	switch (specifier) {
		case "@earendil-works/pi-ai":
			return import("@earendil-works/pi-ai");
		case "@earendil-works/pi-ai/api/openai-codex-responses":
			return import("@earendil-works/pi-ai/api/openai-codex-responses");
		case "@earendil-works/pi-ai/compat":
			return import("@earendil-works/pi-ai/compat");
	}
};

function field(module: unknown, key: string): unknown {
	return module !== null && typeof module === "object"
		? (module as Record<string, unknown>)[key]
		: undefined;
}

/**
 * Resolves the maintained pi-ai Codex Responses stream, in order:
 * 1. the public root's legacy `streamSimpleOpenAICodexResponses` (present when
 *    Pi's loader aliases the root to `dist/compat.js`);
 * 2. `api/openai-codex-responses` `streamSimple`, guarded (plain Node only);
 * 3. `/compat` `streamSimpleOpenAICodexResponses`, then
 *    `openAICodexResponsesApi().streamSimple`.
 * Fails closed with {@link CodexContractError} when none yields a function.
 */
export async function loadMaintainedCodexStream(
	importModule: ModuleImporter = defaultImporter,
): Promise<StreamSimple> {
	const root = await importModule("@earendil-works/pi-ai");
	const rootStream = field(root, "streamSimpleOpenAICodexResponses");
	if (typeof rootStream === "function") return rootStream as StreamSimple;
	try {
		const maintained = field(
			await importModule("@earendil-works/pi-ai/api/openai-codex-responses"),
			"streamSimple",
		);
		if (typeof maintained === "function") return maintained as StreamSimple;
	} catch {
		// Not resolvable under Pi's aliased loader; try the compat entry.
	}
	try {
		const compat = await importModule("@earendil-works/pi-ai/compat");
		const legacy = field(compat, "streamSimpleOpenAICodexResponses");
		if (typeof legacy === "function") return legacy as StreamSimple;
		const factory = field(compat, "openAICodexResponsesApi");
		if (typeof factory === "function") {
			const lazy = field((factory as () => unknown)(), "streamSimple");
			if (typeof lazy === "function") return lazy as StreamSimple;
		}
	} catch {
		// Fall through to the fail-closed contract error.
	}
	throw new CodexContractError(
		"No pi-ai entry exposes the maintained openai-codex-responses streamSimple.",
	);
}

export interface PiAiVersionSources {
	readonly resolve: (specifier: string) => string;
	readonly readFile: (path: string) => string;
}

const defaultVersionSources: PiAiVersionSources = {
	resolve: (specifier) => import.meta.resolve(specifier),
	readFile: (path) => readFileSync(path, "utf-8"),
};

/**
 * Resolves the installed `@earendil-works/pi-ai` version by walking up from
 * its resolved `/compat` (then root) entry to the nearest `package.json`
 * named `@earendil-works/pi-ai`. Local, bounded and offline. Returns
 * `pi-ai@unknown` when neither specifier resolves to a versioned manifest.
 * The standalone CLI keeps its own resolver (`standalone-cli.ts`), which runs
 * outside Pi's loader.
 */
export function resolveInstalledPiAiVersion(
	sources: PiAiVersionSources = defaultVersionSources,
): string {
	for (const specifier of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]) {
		const version = versionFrom(specifier, sources);
		if (version !== undefined) return version;
	}
	return "pi-ai@unknown";
}

function versionFrom(specifier: string, sources: PiAiVersionSources): string | undefined {
	try {
		let directory = dirname(fileURLToPath(sources.resolve(specifier)));
		for (let depth = 0; depth < 6; depth += 1) {
			try {
				const candidate = JSON.parse(
					sources.readFile(join(directory, "package.json")),
				) as { readonly name?: unknown; readonly version?: unknown };
				if (
					candidate.name === "@earendil-works/pi-ai" &&
					typeof candidate.version === "string" &&
					candidate.version.length > 0
				) {
					return `pi-ai@${candidate.version}`;
				}
			} catch {
				// Keep walking toward the installed package root.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		// Resolution failure lets the caller try its next specifier.
	}
	return undefined;
}
