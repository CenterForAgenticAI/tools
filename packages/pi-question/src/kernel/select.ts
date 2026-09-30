import type { AskDelivery } from "../contract/index.ts";

/** What the host declares it can do. Mirrors `Caps`. */
export interface Capabilities {
	host: boolean;
	interactive: boolean;
	ui: boolean;
}

/** piQuestion.surfaces as flags. Mirrors `Allow`. */
export interface Allowed {
	host: boolean;
	tui: boolean;
	dialogs: boolean;
}

export type SurfaceName = AskDelivery["surface"];

/**
 * First allowed and available surface in the order host, tui, dialogs
 * (`select` in proofs/question.bend). Laws L10-L13: the choice is always
 * allowed by config, never needs a UI that is absent, and an available host wins.
 */
export function chooseSurface(caps: Capabilities, allowed: Allowed): SurfaceName {
	if (caps.host && allowed.host) return "host";
	if (caps.interactive && caps.ui && allowed.tui) return "tui";
	if (caps.ui && allowed.dialogs) return "dialogs";
	return "none";
}

export function allowedFrom(surfaces: readonly SurfaceName[]): Allowed {
	return { host: surfaces.includes("host"), tui: surfaces.includes("tui"), dialogs: surfaces.includes("dialogs") };
}
