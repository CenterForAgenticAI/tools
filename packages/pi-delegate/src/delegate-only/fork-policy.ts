import { getActiveDelegateOnlyMode } from "./runtime-state.js";
import {
	copyOptionalGlobalExtensionSelectors,
	EXCLUDED_TOOL_NAMES,
	type ExtSelector,
	type ResolvedToolSurface,
} from "../tool-surface.js";
import { DELEGATE_ONLY_STEERING_ACTIONS } from "../control-surface.js";

/**
 * Resolve the per-agent depth argument used at a run root.
 *
 * An explicit agent setting remains authoritative. Delegate-only configuration
 * supplies the default when the agent does not set one; `runWithDepth` still
 * applies the inherited cap and hard ceiling.
 */
export function resolveDelegateOnlyDepth(agentMax: number | undefined): number | undefined {
	return agentMax ?? getActiveDelegateOnlyMode()?.config.nestingDepth;
}

const DELEGATE_ONLY_DENIED_TOOLS = new Set(
	EXCLUDED_TOOL_NAMES.filter((name) => name !== "delegate_control"),
);

/**
 * Restrict the inner worker of a supervised fork to control actions that steer
 * an existing run. Ordinary worker tools remain unchanged. The restriction is
 * deliberately a no-op outside an active delegate-only session.
 */
export function resolveDelegateOnlySteeringSurface(surface: ResolvedToolSurface): ResolvedToolSurface {
	if (!getActiveDelegateOnlyMode()) return surface;

	// `undefined` means Pi's ordinary read/bash/edit/write defaults. Materialize
	// those only for an implicit surface; an explicit extension-only allowlist
	// must remain least-privilege rather than gaining unrelated built-ins.
	const ordinaryTools = surface.tools ?? (
		surface.hasExplicitAllowlist ? [] : ["read", "bash", "edit", "write"]
	);
	const tools = ordinaryTools.filter((name) => !DELEGATE_ONLY_DENIED_TOOLS.has(name));
	if (!tools.includes("delegate_control")) tools.push("delegate_control");

	// Exact delegate-family selectors would otherwise qualify a live extension
	// tool after the name filter. Keep whole-extension selectors for ordinary
	// tools, but remove exact selectors because the consolidated control tool is
	// added by name and is narrowed by the action grant below.
	const extSelectors: ExtSelector[] = surface.extSelectors.filter(
		(selector) => selector.tool === undefined || !DELEGATE_ONLY_DENIED_TOOLS.has(selector.tool),
	);
	const deniedToolNames = [...new Set([
		...surface.deniedToolNames,
		...DELEGATE_ONLY_DENIED_TOOLS,
	])];

	return copyOptionalGlobalExtensionSelectors(surface, {
		...surface,
		tools,
		extSelectors,
		includesDelegate: true,
		// Keep extension-selected delegate-family tools out of the live scope.
		// `delegate_control` is force-included above and constrained by grants.
		delegateOptIn: false,
		deniedToolNames,
		actionGrants: {
			...(surface.actionGrants ?? {}),
			delegate_control: [...DELEGATE_ONLY_STEERING_ACTIONS],
		},
	});
}
