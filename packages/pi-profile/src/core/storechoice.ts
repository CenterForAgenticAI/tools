import type { MachineConfig } from "./config.ts";
import type { Manifest } from "./manifest.ts";

/**
 * Where a profile's sessions go: `profile.json` `sessions.store` looked up in
 * this host's machine config. `doctor` checks `settings.json` against it and
 * config sync renders `settings.json` from it, so the two cannot drift.
 */
export type StoreChoice =
	/** No `sessions.store`: pi-profile does not manage `sessionDir`. */
	| { readonly kind: "unset" }
	/** `"profile"`: the profile's own sessions folder, so no `sessionDir`. */
	| { readonly kind: "profile" }
	/** A store ID this host does not define. */
	| { readonly kind: "unknown"; readonly id: string }
	| { readonly kind: "store"; readonly id: string; readonly path: string };

export function storeChoice(manifest: Pick<Manifest, "sessions">, config: MachineConfig | undefined): StoreChoice {
	const id = manifest.sessions?.store;
	if (id === undefined) return { kind: "unset" };
	if (id === "profile") return { kind: "profile" };
	const store = config !== undefined && Object.hasOwn(config.sessionStores, id) ? config.sessionStores[id] : undefined;
	if (store === undefined) return { kind: "unknown", id };
	return { kind: "store", id, path: store.path };
}

/** The `sessionDir` that `settings.json` holds for `choice`: the store path, else none. */
export function expectedSessionDir(choice: StoreChoice): string | undefined {
	return choice.kind === "store" ? choice.path : undefined;
}
