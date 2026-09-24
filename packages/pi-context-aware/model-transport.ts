import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiAiCompat } from "./pi-ai-compat.js";

/**
 * Whether the loaded pi-ai compat instance can itself dispatch this model's api.
 *
 * Built-in apis (anthropic-messages, openai-*, google-*, …) are registered into
 * every compat copy on load, so they resolve in any instance. An api registered
 * at runtime by another extension — for example
 * `@centerforagenticai/pi-multi-account`'s `unified` alias router — is only in
 * the instance Pi loaded. When context-aware
 * is loaded as a `packages:` entry, its `@earendil-works/pi-ai/compat` bare
 * specifier resolves to THIS package's own on-disk copy, a separate module
 * instance whose registry never received `unified`. A raw `streamSimple` on that
 * copy then throws `No API provider registered for api: unified` synchronously,
 * before any overflow/transient recovery can run (the module-split failure
 * that originally motivated this guard).
 *
 * When this returns false, the caller must route through Pi's own
 * `ctx.modelRegistry` (which resolves every registered api) instead of the raw
 * compat stream. When it returns true, raw compat streaming is safe and keeps
 * incremental progress. This makes transport adapt to what the loaded instance
 * can actually do rather than assuming the bare specifier reached Pi's copy.
 */
export function compatCanDispatch(compat: Pick<PiAiCompat, "getApiProvider">, model: Model<Api>): boolean {
	try {
		return compat.getApiProvider(model.api) !== undefined;
	} catch {
		return false;
	}
}
