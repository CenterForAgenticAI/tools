import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	shouldSkipForegroundLifecycleForDelegateOwnedApi,
} from "../delegate-session-scope.js";
import { BANNED_BY_RULE_FOREGROUND_TOOLS } from "./constants.js";
import { registerDelegateOnlyEvent } from "./on-guard.js";
import { computeForegroundActiveSet } from "./policy.js";
import type { DelegateOnlyMode, DelegateOnlyRuntime } from "./runtime-state.js";

type LifecycleContext = { mode?: string; abort?: () => void; shutdown?: () => void };
type RuntimeLike = Partial<DelegateOnlyRuntime> | undefined;
type PiLike = Partial<ExtensionAPI>;

const refusal = (reason: string): never => {
	throw new Error(`[delegate-only] refusing to start: ${reason}`);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function setupForegroundGating(
	pi: ExtensionAPI,
	runtime: DelegateOnlyRuntime,
	deps: { renderPromptSection: (mode: DelegateOnlyMode) => string },
): void {
	const api = pi as PiLike;
	const runtimeLike = runtime as unknown as RuntimeLike;

	const getMode = (): DelegateOnlyMode => {
		if (typeof runtimeLike?.getMode !== "function") return refusal("runtime.getMode is unavailable");
		let mode: DelegateOnlyMode;
		try {
			mode = runtimeLike.getMode();
		} catch (error) {
			return refusal(`runtime.getMode threw: ${errorText(error)}`);
		}
		if (!mode || typeof mode !== "object" || typeof mode.active !== "boolean") {
			return refusal("runtime.getMode returned an invalid mode");
		}
		return mode;
	};

	const isDelegateOwnedChild = (): boolean =>
		shouldSkipForegroundLifecycleForDelegateOwnedApi(pi) || process.env.PI_DELEGATE_CHILD === "1";

	const runForeground = <T>(ctx: LifecycleContext | undefined, work: () => T): T => {
		try {
			return work();
		} catch (error) {
			// Pi records extension handler failures and continues. Shutdown and abort
			// make a fail-closed refusal effective even when that happens.
			ctx?.abort?.();
			ctx?.shutdown?.();
			throw error;
		}
	};

	const requireForegroundContext = (ctx: LifecycleContext | undefined): void => {
		if (!ctx || typeof ctx.mode !== "string") return refusal("foreground mode is unavailable");
		if (ctx.mode !== "tui") return refusal(`active-tool enforcement is unavailable in ${ctx.mode} mode`);
	};

	let initialActiveTools: string[] | undefined;
	const apply = (mode: DelegateOnlyMode, ctx: LifecycleContext | undefined): void => {
		if (!mode.active) {
			if (initialActiveTools === undefined) return;
			if (typeof api.setActiveTools !== "function") return refusal("pi.setActiveTools is unavailable");
			try {
				api.setActiveTools([...initialActiveTools]);
			} catch (error) {
				return refusal(`pi.setActiveTools threw: ${errorText(error)}`);
			}
			initialActiveTools = undefined;
			return;
		}

		// Check the enforcement primitive before any other active-mode detail so a
		// refusal names the failed call that made the gate impossible.
		if (typeof api.setActiveTools !== "function") return refusal("pi.setActiveTools is unavailable");
		requireForegroundContext(ctx);
		if (initialActiveTools === undefined) {
			if (typeof api.getActiveTools !== "function") return refusal("pi.getActiveTools is unavailable");
			try {
				initialActiveTools = [...api.getActiveTools()];
			} catch (error) {
				return refusal(`pi.getActiveTools threw: ${errorText(error)}`);
			}
		}
		if (typeof api.getAllTools !== "function") return refusal("pi.getAllTools is unavailable");
		let allTools: ReturnType<NonNullable<PiLike["getAllTools"]>>;
		try {
			allTools = api.getAllTools();
		} catch (error) {
			return refusal(`pi.getAllTools threw: ${errorText(error)}`);
		}
		const { active } = computeForegroundActiveSet(mode, allTools);
		try {
			api.setActiveTools(active);
		} catch (error) {
			return refusal(`pi.setActiveTools threw: ${errorText(error)}`);
		}
	};

	let foregroundContext: LifecycleContext | undefined;
	const applyCurrentMode = (ctx: LifecycleContext | undefined): DelegateOnlyMode => {
		const mode = getMode();
		apply(mode, ctx);
		return mode;
	};

	// An inactive session may still be enabled later, so it must have the event
	// seam needed to install enforcement before that happens.
	const register = (event: string, handler: (...args: never[]) => unknown): void => {
		registerDelegateOnlyEvent(api, event, handler);
	};

	register("session_start", ((_event: unknown, ctx: LifecycleContext) => {
		if (isDelegateOwnedChild()) return;
		foregroundContext = ctx;
		return runForeground(ctx, () => {
			const mode = getMode();
			if (mode.active) apply(mode, ctx);
		});
	}) as (...args: never[]) => unknown);

	register("before_agent_start", ((event: { systemPrompt: string }, ctx: LifecycleContext) => {
		if (isDelegateOwnedChild()) return;
		foregroundContext = ctx;
		return runForeground(ctx, () => {
			const mode = getMode();
			if (!mode.active) return undefined;
			apply(mode, ctx);
			if (typeof deps.renderPromptSection !== "function") return refusal("prompt section renderer is unavailable");
			let section: string;
			try {
				section = deps.renderPromptSection(mode);
			} catch (error) {
				return refusal(`prompt section renderer threw: ${errorText(error)}`);
			}
			return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
		});
	}) as (...args: never[]) => unknown);

	register("turn_start", ((_event: unknown, ctx: LifecycleContext) => {
		if (isDelegateOwnedChild()) return;
		foregroundContext = ctx;
		return runForeground(ctx, () => {
			const mode = getMode();
			if (mode.active) apply(mode, ctx);
		});
	}) as (...args: never[]) => unknown);

	register("turn_end", ((_event: unknown, ctx: LifecycleContext) => {
		if (isDelegateOwnedChild()) return;
		foregroundContext = ctx;
		return runForeground(ctx, () => {
			const mode = getMode();
			if (mode.active) apply(mode, ctx);
		});
	}) as (...args: never[]) => unknown);

	register("tool_call", ((event: { toolName: string }) => {
		if (isDelegateOwnedChild()) return;
		let mode: DelegateOnlyMode;
		try {
			mode = getMode();
		} catch (error) {
			return { block: true, reason: errorText(error) };
		}
		if (!mode.active) return;
		if (typeof api.getAllTools !== "function") {
			return { block: true, reason: "[delegate-only] pi.getAllTools is unavailable" };
		}
		let allTools: ReturnType<NonNullable<PiLike["getAllTools"]>>;
		try {
			allTools = api.getAllTools();
		} catch (error) {
			return { block: true, reason: `[delegate-only] pi.getAllTools threw: ${errorText(error)}` };
		}
		const { active } = computeForegroundActiveSet(mode, allTools);
		if (BANNED_BY_RULE_FOREGROUND_TOOLS.includes(event.toolName)) {
			return {
				block: true,
				reason: `Tool ${JSON.stringify(event.toolName)} is banned by delegate-only policy.`,
			};
		}
		if (!active.includes(event.toolName)) {
			return {
				block: true,
				reason: `Tool ${JSON.stringify(event.toolName)} is outside the delegate-only foreground surface.`,
			};
		}
	}) as (...args: never[]) => unknown);

	if (typeof runtimeLike?.subscribe !== "function") {
		if (getMode().active) return refusal("runtime.subscribe is unavailable");
		return;
	}
	runtimeLike.subscribe((mode) => {
		if (isDelegateOwnedChild()) return;
		// A flag activation runs setActive during session_start, before this
		// lifecycle's own session_start handler has captured the foreground
		// context, so the subscriber can fire with no context yet. There is
		// nothing to reapply in that window: the pending session_start,
		// before_agent_start, and turn_start events establish gating once the
		// context exists. Fail-closed refusals for the genuine cases (no context
		// ever arrives, or a non-tui mode) come from those handlers, which hold a
		// real context whose abort/shutdown make the refusal effective.
		if (!foregroundContext) return;
		return runForeground(foregroundContext, () => {
			if (mode.active) {
				applyCurrentMode(foregroundContext);
			} else {
				apply(mode, foregroundContext);
			}
		});
	});
}
