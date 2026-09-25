import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasActiveDelegateWork } from "../active-delegate-work.js";
import { registerDelegateOnlyEvent } from "./on-guard.js";
import { computeForegroundActiveSet } from "./policy.js";
import type { DelegateOnlyRuntime } from "./runtime-state.js";

const COMMAND_NAME = "delegate-only";
const FLAG_NAME = "delegate-only";

function notify(ctx: ExtensionCommandContext, message: string, level: "error" | "info" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function toggleRefused(ctx: ExtensionCommandContext): boolean {
	const id = sessionId(ctx);
	if (id === undefined) {
		notify(
			ctx,
			"Delegate-only mode cannot be changed because the current session identity is unavailable; refusing to risk a mid-run toggle.",
			"error",
		);
		return true;
	}
	try {
		if (!hasActiveDelegateWork(getAgentDir(), id)) return false;
	} catch {
		// A failure to prove that no run is active must not permit a mid-turn change.
		notify(
			ctx,
			"Delegate-only mode cannot be changed because live delegate work could not be checked; refusing to risk a mid-run toggle.",
			"error",
		);
		return true;
	}
	notify(ctx, "Delegate-only mode cannot be changed while delegate work is in flight.", "error");
	return true;
}

function formatSet(values: readonly string[]): string {
	return values.length > 0 ? values.join(", ") : "(none)";
}

function formatStatus(pi: ExtensionAPI, runtime: DelegateOnlyRuntime): string {
	const mode = runtime.getMode();
	const { active, removed } = computeForegroundActiveSet(mode, pi.getAllTools());
	const caps = mode.config;
	return [
		`delegate-only: ${mode.active ? "on" : "off"} (source: ${mode.source})`,
		`ACTIVE: ${formatSet(active)}`,
		`REMOVED: ${formatSet(removed)}`,
		"CAPS in force:",
		`  allowlist=${formatSet(caps.allowlist)}`,
		`  readBytesPerCall=${caps.readBytesPerCall}`,
		`  readBytesPerTurn=${caps.readBytesPerTurn}`,
		`  resultAdvisoryBytes=${caps.resultAdvisoryBytes}`,
		`  resultHardCapBytes=${caps.resultHardCapBytes}`,
		`  nestingDepth=${caps.nestingDepth}`,
	].join("\n");
}

function handleCommand(rawArgs: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DelegateOnlyRuntime): void {
	const action = rawArgs.trim();
	if (action === "status") {
		notify(ctx, formatStatus(pi, runtime));
		return;
	}
	if (action !== "on" && action !== "off") {
		notify(ctx, "Usage: /delegate-only on|off|status", "error");
		return;
	}
	if (toggleRefused(ctx)) return;

	// setActive changes the state only. Foreground gating reapplies it at the next
	// turn_start/before_agent_start boundary, so a human toggle never changes a
	// tool surface in the middle of the current turn.
	runtime.setActive(action === "on", action === "on" ? "command" : "off");
	notify(ctx, `Delegate-only mode ${action === "on" ? "enabled" : "disabled"} for the next turn.`);
}

export function setupActivation(pi: ExtensionAPI, runtime: DelegateOnlyRuntime): void {
	pi.registerFlag(FLAG_NAME, { type: "boolean" });
	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle delegate-only foreground mode (on, off, or status).",
		handler: async (rawArgs, ctx) => handleCommand(rawArgs, ctx, pi, runtime),
	});
	registerDelegateOnlyEvent(pi, "session_start", (_event, _ctx) => {
		if (process.env.PI_DELEGATE_CHILD === "1") return;
		if (pi.getFlag(FLAG_NAME) === true) runtime.setActive(true, "flag");
	});
}
