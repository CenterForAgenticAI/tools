import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ContextAwareModesV1 } from "../context-service.js";
import { createContextAwareModesV1, type ContextAwareModesRuntime } from "./modes-runtime.js";
import { createModeIndicatorWidget, MODES_WIDGET_KEY } from "./mode-indicator.js";
import { MAX_MODE_ID_LENGTH, MAX_MODE_REASON_LENGTH, modeDisplayText } from "./modes-state.js";

export const MODES_STATUS_KEY = "caair.context-aware/mode";
export const SUGGEST_MODE_TOOL_NAME = "suggest_mode";

const suggestModeSchema = Type.Object({
	mode: Type.String({ minLength: 1, maxLength: MAX_MODE_ID_LENGTH }),
	action: Type.Union([Type.Literal("enter"), Type.Literal("exit")]),
	reason: Type.Optional(Type.String({ maxLength: MAX_MODE_REASON_LENGTH })),
});

interface ModeControllerOptions {
	readonly suggestToolEnabled: (ctx?: ExtensionContext) => boolean;
}

export interface ModesExtensionController {
	readonly register: () => void;
	readonly start: (ctx: ExtensionContext) => void;
	readonly restore: (ctx: ExtensionContext) => void;
	readonly shutdown: (ctx: ExtensionContext) => void;
	readonly resend: (ctx: ExtensionContext) => void;
	readonly current: () => ContextAwareModesRuntime | undefined;
	readonly capability: () => ContextAwareModesV1 | undefined;
}

function resultText(result: { status: string; code?: string; message?: string }): string {
	return result.status === "ok" ? "ok" : `${result.code ?? "REFUSED"}: ${result.message ?? "Mode operation refused."}`;
}

function statusText(runtime: ContextAwareModesRuntime | undefined): string | undefined {
	const current = runtime?.current();
	if (current === null || current === undefined) return undefined;
	const availability = current.available ? "" : " (unavailable)";
	const outer = current.outer === undefined ? "" : ` ← ${modeDisplayText(current.outer.id)}${current.outer.available ? "" : " (unavailable)"}`;
	const suggestion = current.suggestedBy === "model" ? " [model-confirmed]" : "";
	return `mode: ${modeDisplayText(current.id)}${availability}${outer} · owner: ${modeDisplayText(current.owner)}${suggestion}`;
}

export function createModesExtensionController(pi: ExtensionAPI, options: ModeControllerOptions): ModesExtensionController {
	let activeRuntime: ContextAwareModesRuntime | undefined;
	let activeContext: ExtensionContext | undefined;
	let registered = false;
	// The widget last set, and on which context: a replacement context starts with no widgets.
	let shownWidget: string | undefined;
	let shownContext: ExtensionContext | undefined;

	const refreshWidget = (context: ExtensionContext): void => {
		if (typeof context.ui?.setWidget !== "function") return;
		const current = activeRuntime?.current() ?? null;
		// Definitions of other modes also call onChange; only a visible change re-renders.
		const signature = current === null ? undefined : JSON.stringify(current, (key, value) => key === "updatedAt" ? undefined : value);
		if (context === shownContext && signature === shownWidget) return;
		shownContext = context;
		shownWidget = signature;
		context.ui.setWidget(
			MODES_WIDGET_KEY,
			current === null ? undefined : createModeIndicatorWidget(current),
			{ placement: "belowEditor" },
		);
	};
	const refreshStatus = (): void => {
		const context = activeContext;
		if (context?.ui?.setStatus === undefined) return;
		try {
			context.ui.setStatus(MODES_STATUS_KEY, statusText(activeRuntime));
			refreshWidget(context);
		} catch {
			// A replacement context can be torn down while a callback is completing.
		}
	};
	const confirm = async (request: { mode: string; action: "enter" | "exit"; reason?: string }): Promise<boolean | undefined> => {
		const context = activeContext;
		if (!context?.hasUI) return undefined;
		try {
			return await context.ui.confirm(
				`Confirm mode ${request.action}`,
				`Allow the model to ${request.action} mode ${request.mode}?${request.reason ? `\nReason: ${request.reason}` : ""}`,
			);
		} catch {
			return false;
		}
	};
	const ensureRuntime = (ctx: ExtensionContext): ContextAwareModesRuntime => {
		if (activeRuntime !== undefined && !activeRuntime.isClosed()) return activeRuntime;
		const created = createContextAwareModesV1({
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			sendMessage: (customType, content, details) => pi.sendMessage(
				{ customType, content, display: true, details },
				{ triggerTurn: false },
			),
			entries: () => ctx.sessionManager.getBranch(),
			isActive: () => activeRuntime === created && activeContext?.sessionManager === ctx.sessionManager,
			interactiveConfirm: confirm,
			onChange: refreshStatus,
		});
		activeRuntime = created;
		activeContext = ctx;
		refreshStatus();
		return created;
	};

	const controller: ModesExtensionController = {
		register: () => {
			if (registered) return;
			registered = true;
			pi.on("tool_call", async (event: ToolCallEvent) => {
				const runtime = activeRuntime;
				if (runtime === undefined) return undefined;
				const result = runtime.handleToolCall(event.toolName, event.input);
				return result;
			});
			pi.registerCommand("mode", {
				description: "Show the active session mode or exit the innermost mode. Usage: /mode [status|exit]",
				handler: async (args, ctx) => {
					activeContext = ctx;
					const runtime = ensureRuntime(ctx);
					const action = args.trim();
					if (action === "exit") {
						const result = runtime.userExit();
						ctx.ui.notify(resultText(result), result.status === "ok" ? "info" : "warning");
						return;
					}
					if (action !== "" && action !== "status") {
						ctx.ui.notify("Usage: /mode [status|exit]", "warning");
						return;
					}
					ctx.ui.notify(statusText(runtime) ?? "No active mode.", "info");
				},
			});
			pi.registerTool({
				name: SUGGEST_MODE_TOOL_NAME,
				label: "Suggest Mode",
				description: "Ask the user to confirm entering or exiting a session mode.",
				promptSnippet: "Use suggest_mode only when a mode transition needs explicit user confirmation.",
				parameters: suggestModeSchema,
				exposure: "direct",
				prepareLoadout: (_loadout) => {
					if (options.suggestToolEnabled(activeContext)) return undefined;
					return { hiddenDeclarations: [SUGGEST_MODE_TOOL_NAME] };
				},
				async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
					activeContext = ctx;
					const runtime = ensureRuntime(ctx);
					const result = params.action === "enter"
						? await runtime.enterSuggested(params.mode, params.reason)
						: await runtime.exitSuggested(params.mode, params.reason);
					return {
						content: [{ type: "text", text: resultText(result) }],
						isError: result.status !== "ok",
						details: result,
					};
				},
			});
		},
		start: (ctx) => {
			activeRuntime?.close();
			activeContext = ctx;
			activeRuntime = undefined;
			ensureRuntime(ctx);
		},
		restore: (ctx) => {
			activeContext = ctx;
			ensureRuntime(ctx).restore(ctx.sessionManager.getBranch());
		},
		shutdown: (ctx) => {
			if (activeContext === ctx || activeContext?.sessionManager === ctx.sessionManager) {
				activeRuntime?.close();
				activeRuntime = undefined;
				activeContext = undefined;
				try { ctx.ui.setStatus(MODES_STATUS_KEY, undefined); } catch { /* session is already leaving */ }
				try { ctx.ui.setWidget?.(MODES_WIDGET_KEY, undefined); } catch { /* session is already leaving */ }
				shownWidget = undefined;
				shownContext = undefined;
			}
		},
		resend: (ctx) => {
			activeContext = ctx;
			activeRuntime?.resend();
		},
		current: () => activeRuntime,
		capability: () => {
			const runtime = activeRuntime;
			if (runtime === undefined) return undefined;
			return Object.freeze({
				instanceIds: true as const,
				toolPolicies: true as const,
				ui: true as const,
				defineMode: runtime.defineMode,
				current: runtime.current,
				setSuggestionConfirmer: runtime.setSuggestionConfirmer,
			});
		},
	};
	return controller;
}
