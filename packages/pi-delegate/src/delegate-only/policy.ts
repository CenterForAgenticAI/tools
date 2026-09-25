import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	BANNED_BY_RULE_FOREGROUND_TOOLS,
	DEFAULT_DELEGATE_ONLY_ALLOWLIST,
	FOREGROUND_BUILTINS_KEPT,
	IRREDUCIBLE_FOREGROUND_TOOLS,
} from "./constants.js";
import { BUILTIN_TOOL_NAMES } from "../tool-surface.js";
import { verifyToolGrantProvider } from "../extension-policy.js";
import { parseToolGrant, type ExtensionToolGrant } from "../tool-selector.js";
import type { DelegateOnlyMode } from "./runtime-state.js";

const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);
const OWNER_SCOPED_TOOL_NAMES = new Set([
	"session_tasks",
	"session_focus",
	"compact_session",
	"load_skill",
]);

type ForegroundTool = string | Pick<ToolInfo, "name" | "sourceInfo">;

function toolName(tool: ForegroundTool): string {
	return typeof tool === "string" ? tool : tool.name;
}

function verifiedExtensionTool(
	grant: ExtensionToolGrant,
	tools: readonly ForegroundTool[],
): string | undefined {
	if (!grant.tool) return undefined;
	const candidates = tools.filter((tool): tool is Pick<ToolInfo, "name" | "sourceInfo"> =>
		typeof tool !== "string" && tool.name === grant.tool);
	if (candidates.length !== 1) return undefined;
	try {
		verifyToolGrantProvider(grant, candidates[0]!);
		return grant.tool;
	} catch {
		// Owner/module verification is an authorization check. Any uncertainty
		// removes the grant rather than falling back to a same-named provider.
		return undefined;
	}
}

function resolvedGrantName(authored: string, tools: readonly ForegroundTool[]): string | undefined {
	const grant = parseToolGrant(authored);
	if ("error" in grant) return undefined;
	if (grant.kind === "builtin") {
		// These extension tools have trusted defaults. A bare configured spelling
		// must not bypass the sourceInfo check by entering through the name path.
		return OWNER_SCOPED_TOOL_NAMES.has(grant.tool) ? undefined : grant.tool;
	}
	return verifiedExtensionTool(grant, tools);
}

export function computeForegroundActiveSet(
	mode: DelegateOnlyMode,
	allTools: readonly ForegroundTool[],
): { active: string[]; removed: string[] } {
	const allToolNames = allTools.map(toolName);
	if (!mode.active) return { active: [...allToolNames], removed: [] };

	// Keep this as an ordered union. The order is stable for provider payloads.
	// Extension grants enter it only after the current ToolInfo source verifies.
	const allowed = new Set<string>();
	const allNames = new Set(allToolNames);
	for (const name of FOREGROUND_BUILTINS_KEPT) {
		if (allNames.has(name)) allowed.add(name);
	}
	for (const authored of DEFAULT_DELEGATE_ONLY_ALLOWLIST) {
		const name = resolvedGrantName(authored, allTools);
		if (name) allowed.add(name);
	}
	const configuredAllowlist = mode.config && Array.isArray(mode.config.allowlist) ? mode.config.allowlist : [];
	for (const authored of configuredAllowlist) {
		if (typeof authored !== "string") continue;
		const name = resolvedGrantName(authored, allTools);
		if (name && !BUILTIN_TOOL_NAME_SET.has(name)) allowed.add(name);
	}
	for (const name of IRREDUCIBLE_FOREGROUND_TOOLS) {
		// compact_session remains a floor only when the owner-scoped default above
		// verified context-aware provider. Never re-add a wrong-owner registration.
		if (name === "compact_session" && !allowed.has(name)) continue;
		allowed.add(name);
	}

	// The rule ban is applied last. Configuration must never be able to widen
	// the surface with a forbidden tool.
	for (const name of BANNED_BY_RULE_FOREGROUND_TOOLS) allowed.delete(name);

	const active = [...allowed].filter((name) => allNames.has(name));
	const activeNames = new Set(active);
	const removed = allToolNames.filter((name) => !activeNames.has(name));
	return { active, removed };
}
