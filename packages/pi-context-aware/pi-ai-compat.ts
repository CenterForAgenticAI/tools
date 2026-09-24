/**
 * Loads pi-ai's compat entrypoint as the SAME module instance Pi itself uses,
 * so a model dispatched by `model.api` resolves against the API registry Pi and
 * every extension share.
 *
 * This MUST import the bare specifier `@earendil-works/pi-ai/compat`, never a
 * computed file URL. Pi's extension loader maps the bare specifier to its one
 * bundled compat instance (jiti `virtualModules`, or the dist alias in an
 * unbundled build). A file URL such as
 * `new URL("./compat.js", import.meta.resolve("@earendil-works/pi-ai"))` is not
 * a mapped specifier, so it loads THIS package's own on-disk copy — a separate
 * module instance with its own, independent API registry.
 *
 * That distinction is invisible to the built-in APIs (they are registered in
 * every copy on load) but fatal to any api id an extension registers at runtime.
 * `@centerforagenticai/pi-multi-account` registers `hypha-anthropic-oauth`
 * (its Anthropic alias accounts) only into Pi's instance, so a file-URL copy throws
 * `No API provider registered for api: hypha-anthropic-oauth` for those models
 * while Pi routes them fine.
 *
 * Do not "optimize" this back to a resolved file URL: it reintroduces the
 * module-instance split.
 */
export type PiAiCompat = typeof import("@earendil-works/pi-ai/compat");

let piAiCompatPromise: Promise<PiAiCompat> | undefined;

export function loadPiAiCompat(): Promise<PiAiCompat> {
	piAiCompatPromise ??= import("@earendil-works/pi-ai/compat") as Promise<PiAiCompat>;
	return piAiCompatPromise;
}
