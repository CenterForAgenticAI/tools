// Effect classes (spec 5.4 "Effect record"): what a tool call cut off by a crash does when its session resumes.
// pi-durable commits each call's intent before execute(); `replay` decides whether a later Harness runs it again.
// read-only and idempotent-by-key calls run again under the same key; a reconcilable call asks the counterparty
// first; a once-only call (the default) is never sent again: the model receives an `interrupted` error and decides.
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { callKey } from "./core.ts";

export type EffectClass = "read-only" | "idempotent-by-key" | "reconcilable" | "once-only";

/** A call's identity across restarts: the same key every time this intent runs, never a new one (spec 5.4). `key` is `callKey`'s. */
export type EffectCall = { readonly key: string; readonly api: ToolExecutionApi };
type Result = Awaited<ReturnType<ToolRegistration["execute"]>>;

type Common = {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
	execute(args: JsonObject, call: EffectCall, context: Context): Promise<Result>;
};
export type EffectTool =
	| (Common & { readonly effect?: "once-only" | "read-only" | "idempotent-by-key" })
	/** `reconcile` runs before a resumed call: a result means the effect happened, `undefined` that it did not. */
	| (Common & { readonly effect: "reconcilable"; reconcile(args: JsonObject, call: EffectCall, context: Context): Promise<Result | undefined> });

const STARTED = "kleya.effect.started";

/** The pi-durable registration for `tool`: its effect class sets `replay`, and a reconcilable call reconciles before it runs again. */
export function effectTool(tool: EffectTool): ToolRegistration {
	const effect = tool.effect ?? "once-only";
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as never,
		replay: effect === "once-only" ? "unsafe" : "safe",
		async execute(args, api, context) {
			const call: EffectCall = { key: await callKey(api, context), api };
			if (tool.effect === "reconcilable") {
				// The marker is stored before the first send, so a call that finds it was cut off after it.
				const resumed = (await api.memo<boolean>(STARTED, context)) === true;
				if (resumed) {
					const found = await tool.reconcile(args as JsonObject, call, context);
					if (found !== undefined) return found;
				} else await api.memo(STARTED, true, context);
			}
			return tool.execute(args as JsonObject, call, context);
		},
	};
}
