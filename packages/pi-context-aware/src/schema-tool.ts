/**
 * Tool registration typed by pi-schema.
 *
 * Pi's `ToolDefinition` derives `execute`, `prepareArguments` and `renderCall`
 * argument types from TypeBox `Static`, which is `unknown` for a pi-schema
 * schema, and declares them as methods, so any annotation passes. `schemaTool`
 * binds them to pi-schema `Static` as function properties, so a wrong
 * annotation fails the typecheck.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { num, type Annotations, type Schema, type Static } from "@earendil-works/pi-schema";

type HostTool<TDetails, TState> = ToolDefinition<ToolDefinition["parameters"], TDetails, TState>;
type HostRenderCall<TDetails, TState> = NonNullable<HostTool<TDetails, TState>["renderCall"]>;

export type SchemaToolDefinition<S extends Schema, TDetails = unknown, TState = unknown> =
	Omit<HostTool<TDetails, TState>, "parameters" | "prepareArguments" | "execute" | "renderCall"> & {
		readonly parameters: S;
		readonly prepareArguments?: (args: unknown) => Static<S>;
		readonly execute: (
			toolCallId: string,
			params: Static<S>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
			ctx: ExtensionToolContext,
		) => Promise<AgentToolResult<TDetails>>;
		readonly renderCall?: (args: Static<S>, theme: Theme, context: Parameters<HostRenderCall<TDetails, TState>>[2]) => ReturnType<HostRenderCall<TDetails, TState>>;
	};

export function schemaTool<S extends Schema, TDetails = unknown, TState = unknown>(tool: SchemaToolDefinition<S, TDetails, TState>): HostTool<TDetails, TState> {
	return tool as HostTool<TDetails, TState>;
}

/** A finite number; bare `num()` admits ±Infinity. */
export function finite(options: Annotations<number> = {}): Schema<number> {
	return num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, ...options });
}
