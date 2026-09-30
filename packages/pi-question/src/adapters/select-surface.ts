import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allowedFrom, chooseSurface, type SurfaceName } from "../kernel/select.ts";
import { dialogSurface } from "./dialogs.ts";
import { unavailableSurface, type AskSurface } from "./surface.ts";

/**
 * Pick a surface from declared capability, never by guessing. The choice itself
 * is the proven `chooseSurface` (proofs/question.bend `select`).
 *
 * TODO(spec 03): the host channel (pi-daemon `question` method) and the rich
 * TUI are not built yet, so they are reported as unavailable here.
 */
export function selectSurface(
	ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
	surfaces: readonly SurfaceName[] = ["host", "tui", "dialogs"],
): AskSurface {
	const choice = chooseSurface({ host: false, interactive: false, ui: ctx.hasUI }, allowedFrom(surfaces));
	return choice === "dialogs" ? dialogSurface(ctx.ui) : unavailableSurface;
}
