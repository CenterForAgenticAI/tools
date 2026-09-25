import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeSync } from "node:fs";

import {
	DETACHED_WORKER_TOOL_SCOPE_ENV,
	assertWorkerToolSurfaceHasUsableToolNames,
	isDetachedWorkerToolAllowed,
	parseDetachedWorkerToolScopeEnvelope,
	resolveDetachedWorkerActiveToolNames,
} from "./worker-tool-scope.js";

/**
 * Authoritative live-tool scope for the hosted `pi --mode rpc` child.
 *
 * This extension is loaded after consumer extensions. It therefore narrows the
 * registry after their `session_start` handlers, refreshes after each turn, and
 * supplies the call-time veto for the before-agent-start registration window.
 */
export default function workerToolScopeBridge(pi: ExtensionAPI): void {
	let envelope: ReturnType<typeof parseDetachedWorkerToolScopeEnvelope>;
	let transportError: Error | undefined;
	try {
		const raw = process.env[DETACHED_WORKER_TOOL_SCOPE_ENV];
		if (!raw) {
			throw new Error(`Missing ${DETACHED_WORKER_TOOL_SCOPE_ENV} payload`);
		}
		envelope = parseDetachedWorkerToolScopeEnvelope(raw);
	} catch (error) {
		transportError = error instanceof Error ? error : new Error(String(error));
	}
	if (!envelope && !transportError) return;
	if (transportError) {
		const reason = `Hosted worker tool scope is invalid: ${transportError.message}`;
		const denyAll = (): void => pi.setActiveTools([]);
		// Pi records extension factory/handler failures without necessarily aborting
		// the session. Install an explicit input gate and empty active set so malformed
		// transport cannot turn an omitted --tools gate into broad child authority.
		pi.on("session_start", (_event, ctx) => {
			denyAll();
			console.error(`[pi-delegate] ${reason}`);
			ctx.abort?.();
			ctx.shutdown();
		});
		pi.on("before_agent_start", (_event, ctx) => {
			denyAll();
			ctx.abort?.();
			ctx.shutdown();
		});
		pi.on("input", (_event, ctx) => {
			denyAll();
			ctx.abort?.();
			ctx.shutdown();
			return { action: "handled" as const };
		});
		pi.on("tool_call", () => ({ block: true, reason }));
		return;
	}

	// Pi action methods are unavailable while extension factories load. The first
	// session_start apply establishes the registry baseline; later applies admit
	// newly registered selected tools without restoring names a consumer removed.
	let knownToolNames = new Set<string>();
	const apply = (includeNewlyRegistered = true): string[] => {
		const allTools = pi.getAllTools();
		const currentlyActive = new Set(pi.getActiveTools());
		const allowed = resolveDetachedWorkerActiveToolNames(envelope, allTools);
		const active = allowed.filter(
			(name) => currentlyActive.has(name) || (includeNewlyRegistered && !knownToolNames.has(name)),
		);
		knownToolNames = new Set(allTools.map((tool) => tool.name));
		pi.setActiveTools(active);
		return active;
	};
	const isValidatedHostedChild = envelope !== undefined && process.env.PI_DELEGATE_CHILD === "1";
	const reportFinalFloorFailure = (ctx: { abort?: () => void; shutdown: () => void }, error: unknown): void => {
		pi.setActiveTools([]);
		const diagnostic = error instanceof Error ? error.message : String(error);
		if (isValidatedHostedChild) {
			// The managed RPC child must terminate synchronously. Pi swallows extension
			// handler failures, and shutdown/abort alone can race the provider request.
			const line = `[pi-delegate] ${diagnostic}\n`.slice(0, 4096);
			try { writeSync(2, line); } catch { /* stderr is best effort */ }
			process.exit(78);
		}
		ctx.abort?.();
		ctx.shutdown();
	};
	let capturedProviderToolNames: string[] | undefined;
	const validateFinalFloor = (
		ctx: { abort?: () => void; shutdown: () => void },
		active: readonly string[],
	): boolean => {
		try {
			assertWorkerToolSurfaceHasUsableToolNames(active);
			return true;
		} catch (error) {
			reportFinalFloorFailure(ctx, error);
			return false;
		}
	};
	const enforceFinalFloor = (
		ctx: { abort?: () => void; shutdown: () => void },
	): string[] | undefined => {
		let active: string[];
		try {
			active = apply();
		} catch (error) {
			reportFinalFloorFailure(ctx, error);
			return undefined;
		}
		return validateFinalFloor(ctx, active) ? active : undefined;
	};

	// This bridge is argv-ordered after consumer extensions, so this handler runs
	// after their session_start registrations have been applied to the registry.
	pi.on("session_start", () => {
		capturedProviderToolNames = apply(false);
	});
	// `before_agent_start` runs after consumer handlers for this event because
	// the bridge is argv-ordered last. A consumer may register selected and
	// unselected tools here; activate the selected additions before Pi snapshots
	// the first model turn, while the tool_call veto below closes the race.
	pi.on("before_agent_start", (_event, ctx) => {
		capturedProviderToolNames = enforceFinalFloor(ctx);
	});
	// Pi captures continuation tools after turn_end and before the next turn_start.
	// Validate that provider-bound surface first: registrations during turn_start
	// update later agent state but cannot repair the already-captured request.
	pi.on("turn_start", (_event, ctx) => {
		if (!validateFinalFloor(ctx, capturedProviderToolNames ?? [])) return;
		enforceFinalFloor(ctx);
	});
	pi.on("turn_end", () => {
		capturedProviderToolNames = apply();
	});
	pi.on("tool_call", (event) => {
		if (isDetachedWorkerToolAllowed(envelope, event.toolName, pi.getAllTools())) return;
		return {
			block: true,
			reason: `Tool ${JSON.stringify(event.toolName)} is outside this worker's selected extension tool scope.`,
		};
	});
}
