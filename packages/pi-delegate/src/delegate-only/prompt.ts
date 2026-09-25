import {
	BANNED_BY_RULE_FOREGROUND_TOOLS,
	FOREGROUND_BUILTINS_KEPT,
	IRREDUCIBLE_FOREGROUND_TOOLS,
} from "./constants.js";
import type { DelegateOnlyMode } from "./runtime-state.js";

const DELEGATE_ROUTE_TOOLS = IRREDUCIBLE_FOREGROUND_TOOLS.filter((tool) =>
	["delegate", "delegate_control"].includes(tool),
);

export function renderDelegateOnlyPromptSection(mode: DelegateOnlyMode): string {
	if (!mode.active) return "";

	const keptBuiltins = FOREGROUND_BUILTINS_KEPT.join(", ");
	const bannedTools = BANNED_BY_RULE_FOREGROUND_TOOLS.join(", ");
	const routeTools = DELEGATE_ROUTE_TOOLS.join(", ");
	const { config } = mode;

	return [
		"## Delegate-only mode (active)",
		"HARD RULES:",
		`- REMOVED: all foreground built-in tools except ${keptBuiltins}; this includes bash, edit, and write. ${bannedTools} is banned by rule, even if an allowlist names it.`,
		`- DELEGATE ROUTE: to run a command, search, fetch data, or perform a large read, delegate that work to a worker through ${routeTools}. Use delegate_control with action=result to retrieve its result, action=status to inspect progress, action=steer to redirect it, or action=cancel to stop it.`,
		`- CAPS IN FORCE: readBytesPerCall=${config.readBytesPerCall} bytes; readBytesPerTurn=${config.readBytesPerTurn} bytes; resultAdvisoryBytes=${config.resultAdvisoryBytes} bytes; resultHardCapBytes=${config.resultHardCapBytes} bytes; nestingDepth=${config.nestingDepth}.`,
	].join("\n");
}
