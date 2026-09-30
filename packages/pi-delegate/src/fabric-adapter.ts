/**
 * Optional Fabric adapter (issue 568).
 *
 * When a compatible pi-fabric runtime is active in the invoking Pi session, this
 * module exposes the typed runtime client (see `runtime-api.ts`) as the Fabric
 * provider `delegate`, whose actions are reached inside `fabric_exec` as
 * `tools.call({ ref: "delegate.<action>", args })`. It also supplies the
 * Fabric-mode model instructions.
 *
 * Activation is runtime capability negotiation, never a check for an installed
 * package:
 *
 * - Fabric emits `pi-fabric:provider:discover:v1` each time its runtime mounts
 *   execution in a session. A version 1 payload whose `register()` accepts this
 *   provider is the handshake that marks the surface `ready`.
 * - pi-delegate also emits `pi-fabric:provider:register:v1` at every foreground
 *   `session_start`, so a Fabric listener that is already loaded stores the
 *   provider for its next activation. Registration uses `overwrite: true` with
 *   one provider object, so repeated delivery keeps exactly one binding.
 * - Fabric calls `provider.close()` when it withdraws the binding, for example
 *   at its session shutdown or `/fabric reload`. The surface is then `withdrawn`
 *   until the next discovery handshake.
 *
 * The provider never imports or caches a runtime core. Every action resolves the
 * live instance through the process-global handle and binds a fresh client to
 * the invoking `fabric_exec` context, so session switches, reloads, and a second
 * module copy cannot reach a stale or empty core.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FABRIC_PROVIDER_DISCOVER_EVENT,
	FABRIC_PROVIDER_PROTOCOL_VERSION,
	FABRIC_PROVIDER_REGISTER_EVENT,
	readFabricProviderDiscovery,
	type FabricActionDescriptor,
	type FabricInvocationContext,
	type FabricProvider,
	type FabricProviderRegistration,
	type FabricRisk,
} from "./fabric-protocol.js";
import { DELEGATE_RUNTIME_CAPABILITIES, type DelegateRuntimeCapability } from "./runtime-contract.js";
import type { DelegateRuntimeApiHandle, DelegateRuntimeClient, DelegateRuntimeInvocationOptions, DelegateRuntimeUpdate } from "./runtime-api.js";

export {
	FABRIC_PROVIDER_DISCOVER_EVENT,
	FABRIC_PROVIDER_PROTOCOL_VERSION,
	FABRIC_PROVIDER_REGISTER_EVENT,
} from "./fabric-protocol.js";
export type {
	FabricActionDescriptor,
	FabricInvocationContext,
	FabricProvider,
	FabricProviderDiscovery,
	FabricProviderRegistration,
} from "./fabric-protocol.js";

/** Fabric provider name; action refs are `delegate.<capability>`. */
export const DELEGATE_FABRIC_PROVIDER_NAME = "delegate";

/**
 * Same key as `DELEGATE_RUNTIME_API_HANDLE_KEY`. Repeated here so this module
 * reaches the live instance without depending on its own copy of runtime-api.
 */
const RUNTIME_HANDLE_KEY = Symbol.for("pi-delegate.runtime-api.v1");

/** Longest error or diagnostic text the adapter produces. */
export const FABRIC_ADAPTER_MAX_MESSAGE_CHARS = 2_000;

const NATIVE_MAPPING = "The request is the same object the native `delegate` tool takes.";

type JsonSchema = Record<string, unknown>;
/**
 * Input schemas describe fields; they do not constrain them. pi-delegate's
 * shared native/client boundary is the single validator, so a malformed call
 * rejects with the same `DelegateRuntimeError` code through Fabric as through
 * the client. A Fabric-side type or `required` check would reject first with
 * Fabric's own message, and Fabric normalizes argument forms only for closed
 * schemas. The client copies only named fields for every action except
 * dispatch, which rejects unknown fields itself.
 */
const str = (description: string): JsonSchema => ({ description: `string. ${description}` });
const runIdField = str("Required. Run ID from a dispatch receipt or listRuns.");
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
	type: "object",
	properties,
	additionalProperties: true,
});

interface DelegateFabricAction {
	descriptor: FabricActionDescriptor;
	run(client: DelegateRuntimeClient, args: Record<string, unknown>, options: DelegateRuntimeInvocationOptions): Promise<unknown>;
}

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const field = <T>(args: Record<string, unknown>, key: string): T => args[key] as T;

function action(
	name: DelegateRuntimeCapability,
	risk: FabricRisk,
	description: string,
	inputSchema: JsonSchema,
	run: DelegateFabricAction["run"],
): DelegateFabricAction {
	return { descriptor: { name, description, inputSchema, risk }, run };
}

/** One action per runtime-client capability, in capability-matrix order. */
const ACTIONS: readonly DelegateFabricAction[] = [
	action("dispatch", "agent", `Submit one delegate request and return its accepted receipt without waiting. ${NATIVE_MAPPING} Use canonical runs[]: mode "solo" (default) runs a worker directly, "supervised" forks this session to supervise the worker, "driver" is a durable pi-daemon session; chain names a saved chain.`,
		object({
			runs: { description: "array of run entries: {agent, task, mode?, name?, after?, reads?, ...}." },
			chain: { description: "Saved chain name." },
			task: str("Task text for a saved chain."),
		}),
		(client, args, options) => client.dispatch(args, options)),
	action("status", "read", "Read one run's uniform status.", object({ runId: runIdField }),
		(client, args, options) => client.status(field(args, "runId"), options)),
	action("harvest", "read", "Read one run's typed result envelope and provenance. A terminal worker failure is a result, not an error.", object({ runId: runIdField }),
		(client, args, options) => client.harvest(field(args, "runId"), options)),
	action("steer", "agent", "Send guidance to a supervised entry or an authenticated driver. Direct workers and chain steps reject steering.",
		object({ runId: runIdField, forkName: str("Entry name."), message: str("Required. Guidance text."), deliverAs: { description: "\"steer\" | \"followUp\" | \"queue\"." }, targetLineagePath: str("Nested target lineage path."), capToken: str("Nested control capability token.") }),
		(client, args, options) => client.steer({ runId: field(args, "runId"), forkName: text(args.forkName), message: field(args, "message"), deliverAs: field(args, "deliverAs"), targetLineagePath: text(args.targetLineagePath), capToken: text(args.capToken) }, options)),
	action("cancel", "agent", "Cancel a run or one named entry. This is the only action that stops accepted work.",
		object({ runId: runIdField, forkName: str("Entry name."), reason: str("Cancellation reason."), targetLineagePath: str("Nested target lineage path."), capToken: str("Nested control capability token.") }),
		(client, args, options) => client.cancel({ runId: field(args, "runId"), forkName: text(args.forkName), reason: text(args.reason), targetLineagePath: text(args.targetLineagePath), capToken: text(args.capToken) }, options)),
	action("listRuns", "read", "List runs this session may observe. Check degraded and truncated before treating the list as complete.", object({}),
		(client, _args, options) => client.listRuns(options)),
	action("logs", "read", "Read a bounded, sanitized child-log tail (native default 40 lines/8 KiB, maximum 256 lines/64 KiB).",
		object({ runId: runIdField, tail: { description: "boolean. Return the full bounded tail." }, tailLines: { description: "integer. Line count, native maximum 256." } }),
		(client, args, options) => client.logs({ runId: field(args, "runId"), tail: field(args, "tail"), tailLines: field(args, "tailLines") }, options)),
	action("wait", "read", "Observe one run until terminal, timeout, abort or unavailable. Timeout or abort never cancels the run.",
		object({ runId: runIdField, timeoutMs: { description: "Required integer, 0 through 2147483647." } }),
		(client, args, options) => client.wait({ runId: field(args, "runId"), timeoutMs: field(args, "timeoutMs") }, options)),
	action("recover", "agent", "Recover a failed worker entry or reconcile a driver prompt. Worker recovery is foreground-only.",
		object({ runId: runIdField, forkName: str("Failed entry name."), strategy: { description: "\"auto\" | \"fresh\" | \"resume\"." }, message: str("Recovery instruction.") }),
		(client, args, options) => client.recover({ runId: field(args, "runId"), forkName: text(args.forkName), strategy: field(args, "strategy"), message: text(args.message) }, options)),
	action("promptStatus", "read", "Read a driver's durable prompt status.", object({ runId: runIdField }),
		(client, args, options) => client.promptStatus(field(args, "runId"), options)),
	action("followUp", "agent", "Queue a follow-up prompt for a driver.", object({ runId: runIdField, message: str("Required. Follow-up text.") }),
		(client, args, options) => client.followUp({ runId: field(args, "runId"), message: field(args, "message") }, options)),
	action("uiAnswer", "agent", "Answer a driver's pending UI question with exactly {value}, {confirmed} or {cancelled: true}.",
		object({ runId: runIdField, questionId: str("Required. Question ID."), answer: { description: "Required. Exactly {value}, {confirmed} or {cancelled: true}." } }),
		(client, args, options) => client.uiAnswer({ runId: field(args, "runId"), questionId: field(args, "questionId"), answer: field(args, "answer") }, options)),
	action("listEscalations", "read", "List held escalations this session may act on.", object({ rootRunId: str("Root run ID."), requestIds: { description: "string[]. Escalation request IDs." } }),
		(client, args, options) => client.listEscalations({ rootRunId: text(args.rootRunId), requestIds: field(args, "requestIds") }, options)),
	action("resolveEscalation", "agent", "Resolve a held escalation within declared authority. Set onBehalfOfUser only after an actual operator choice.",
		object({ rootRunId: str("Root run ID."), requestId: str("Required. Escalation request ID."), selected: { description: "Required. Option index or array of indexes." }, customInstruction: str("Custom instruction."), note: str("Note."), onBehalfOfUser: { description: "boolean. Only after an actual operator choice." } }),
		(client, args, options) => client.resolveEscalation({ rootRunId: text(args.rootRunId), requestId: field(args, "requestId"), selected: field(args, "selected"), customInstruction: text(args.customInstruction), note: text(args.note), onBehalfOfUser: field(args, "onBehalfOfUser") }, options)),
	action("passUpEscalations", "agent", "Pass held escalations up to the next holder.",
		object({ rootRunId: str("Root run ID."), requestIds: { description: "string[]. Escalation request IDs." }, context: str("Context for the next holder."), recommendation: str("Recommendation.") }),
		(client, args, options) => client.passUpEscalations({ rootRunId: text(args.rootRunId), requestIds: field(args, "requestIds"), context: text(args.context), recommendation: text(args.recommendation) }, options)),
	action("manage", "write", "Explicit agent and saved-chain definition management: list, get, create, update, delete, canonicalize.",
		object({ action: { description: "Required. \"list\" | \"get\" | \"create\" | \"update\" | \"delete\" | \"canonicalize\"." }, agent: str("Agent name."), chainName: str("Saved chain name."), agentScope: { description: "\"user\" | \"project\" | \"both\"." }, config: { description: "object. Definition fields for create or update." } }),
		(client, args, options) => client.manage({ action: field(args, "action"), agent: text(args.agent), chainName: text(args.chainName), agentScope: field(args, "agentScope"), config: field(args, "config") }, options)),
	action("health", "read", "Bounded runtime diagnostics. Never dispatches.", object({}),
		(client, _args, options) => client.health(options)),
];

const ACTION_BY_NAME = new Map(ACTIONS.map((entry) => [entry.descriptor.name, entry]));

/** Fabric refs in capability-matrix order, for docs and mechanical checks. */
export const DELEGATE_FABRIC_ACTIONS: readonly DelegateRuntimeCapability[] = Object.freeze(ACTIONS.map((entry) => entry.descriptor.name as DelegateRuntimeCapability));

function cloneDescriptor(descriptor: FabricActionDescriptor): FabricActionDescriptor {
	return structuredClone(descriptor);
}

function bounded(value: string, max = FABRIC_ADAPTER_MAX_MESSAGE_CHARS): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Error thrown to Fabric. Inside `fabric_exec` only the message crosses into the
 * guest, so it leads with the stable runtime code: `[code] message`. A
 * post-acceptance failure appends its evidence, including the accepted run ID
 * and the recovery action, so the run stays discoverable.
 */
export class DelegateFabricError extends Error {
	constructor(readonly code: string, detail: string, readonly evidence?: unknown) {
		super(bounded(`[${code}] ${detail}${evidence === undefined ? "" : ` evidence=${safeJson(evidence)}`}`));
		this.name = "DelegateFabricError";
	}
}

function safeJson(value: unknown): string {
	try { return JSON.stringify(value) ?? "null"; } catch { return "\"unserializable\""; }
}

/** Class identity differs across module copies, so errors are read structurally. */
function toFabricError(error: unknown): DelegateFabricError {
	if (error instanceof DelegateFabricError) return error;
	const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
	const message = typeof record.message === "string" ? record.message : String(error);
	if (record.name === "DelegateRuntimeError" && typeof record.code === "string") {
		return new DelegateFabricError(record.code, message, record.evidence);
	}
	return new DelegateFabricError("core-error", message);
}

function readHandle(): DelegateRuntimeApiHandle | undefined {
	const value = (globalThis as Record<symbol, unknown>)[RUNTIME_HANDLE_KEY];
	if (value === null || typeof value !== "object") return undefined;
	const handle = value as Partial<DelegateRuntimeApiHandle>;
	return typeof handle.createDelegateRuntimeClient === "function" ? handle as DelegateRuntimeApiHandle : undefined;
}

function describeUpdate(update: DelegateRuntimeUpdate): string {
	if (update.kind === "accepted") return `accepted runId=${update.acceptance.runId} (${update.acceptance.transport})`;
	if (update.kind === "terminal") return `runId=${update.runId} ${update.state}`;
	const entries = update.forks.map((fork) => `${fork.name}(${fork.agent}) ${fork.status}${fork.currentRound !== undefined && fork.maxRounds !== undefined ? ` ${fork.currentRound}/${fork.maxRounds}` : ""}`);
	return bounded(`runId=${update.runId} ${entries.join(", ")}`, 300);
}

export interface DelegateFabricProviderOptions {
	/** Override live-core lookup; defaults to the process-global runtime handle. */
	resolveHandle?: () => DelegateRuntimeApiHandle | undefined;
	/** Called when Fabric withdraws this provider binding. */
	onClosed?: () => void;
}

/** Build the Fabric provider over the live runtime client. */
export function createDelegateFabricProvider(options: DelegateFabricProviderOptions = {}): FabricProvider {
	const resolveHandle = options.resolveHandle ?? readHandle;
	return {
		name: DELEGATE_FABRIC_PROVIDER_NAME,
		description: "pi-delegate: dispatch specialist subagent runs and observe, control and harvest them through the typed runtime client.",
		async list() {
			return ACTIONS.map((entry) => cloneDescriptor(entry.descriptor));
		},
		async describe(actionName) {
			const entry = ACTION_BY_NAME.get(actionName);
			return entry ? cloneDescriptor(entry.descriptor) : undefined;
		},
		async invoke(actionName, args, context: FabricInvocationContext) {
			const entry = ACTION_BY_NAME.get(actionName);
			if (!entry) throw new DelegateFabricError("invalid-request", `unknown delegate action: ${bounded(String(actionName), 80)}`);
			if (args === null || typeof args !== "object" || Array.isArray(args)) throw new DelegateFabricError("invalid-request", "arguments must be an object");
			const handle = resolveHandle();
			if (!handle) {
				throw new DelegateFabricError("core-unavailable", "pi-delegate runtime core is not installed in this Pi session; the foreground session has not started or has shut down");
			}
			const extensionContext: ExtensionContext | undefined = context?.extensionContext;
			if (!extensionContext) throw new DelegateFabricError("context-unavailable", "Fabric did not supply the invoking session context");
			const report = (message: string) => {
				try {
					if (typeof context.activity === "function") context.activity({ type: "progress", message });
					else context.update?.(message);
				} catch { /* Presentation cannot affect accepted work. */ }
			};
			// Observation is owned by this call. Aborting it after the call returns
			// detaches progress without touching the accepted run.
			const observation = new AbortController();
			const forward = () => observation.abort();
			context.signal?.addEventListener("abort", forward, { once: true });
			if (context.signal?.aborted) observation.abort();
			const observe = actionName === "dispatch" || actionName === "wait";
			const invocation: DelegateRuntimeInvocationOptions = {
				signal: observation.signal,
				...(observe ? {
					onUpdate(update: DelegateRuntimeUpdate) {
						if (update.kind === "accepted") {
							try { context.activity?.({ type: "entity", id: update.acceptance.runId, kind: "agent", name: `delegate ${update.acceptance.runId}` }); } catch { /* presentation only */ }
						}
						report(describeUpdate(update));
					},
				} : {}),
			};
			try {
				const client = handle.createDelegateRuntimeClient({ context: extensionContext });
				return await entry.run(client, args, invocation);
			} catch (error) {
				throw toFabricError(error);
			} finally {
				context.signal?.removeEventListener("abort", forward);
				observation.abort();
			}
		},
		async close() {
			options.onClosed?.();
		},
	};
}

/**
 * Fabric-mode model instructions. They replace native call examples while the
 * Fabric surface is ready; they never include a native `delegate` call.
 */
export const FABRIC_MODE_INSTRUCTIONS = [
	"## pi-delegate through Fabric",
	"",
	"Delegate inside `fabric_exec` with the `delegate` provider: `await tools.call({ ref: \"delegate.dispatch\", args: { runs: [{ agent: \"worker\", task: \"...\" }] } })`. `args` is the same request the pi-delegate skill describes: use the object from any native call example there as `delegate.dispatch` args.",
	"- Workers and supervisors: `mode: \"solo\"` (default) runs the named agent as a direct worker. `mode: \"supervised\"` forks this session into a supervisor that iterates with that worker. `mode: \"driver\"` is a durable pi-daemon session. `chain: \"<name>\"` runs a saved chain; `after` orders runs.",
	"- Receipts: dispatch returns an accepted receipt (`runId`, `forks`, `steps`, `acceptance`) and never waits for the work. Solo and supervised completion still wakes this session. When the same program needs the result, call `delegate.wait` with `{runId, timeoutMs}` and then `delegate.harvest` with `{runId}`. Do not poll `delegate.status` in a loop.",
	"- Controls: `delegate.status`, `delegate.listRuns`, `delegate.logs`; `delegate.steer` and `delegate.cancel` for supervised entries and authenticated drivers; `delegate.recover`; driver `delegate.promptStatus`, `delegate.followUp`, `delegate.uiAnswer`; `delegate.listEscalations`, `delegate.resolveEscalation`, `delegate.passUpEscalations`; `delegate.manage` with an explicit `action`; `delegate.health`.",
	"- Authorization is unchanged: trust, nesting, confinement, ownership and control grants apply to every call. A denied call rejects with `[authorization-denied]`.",
	"- Errors reject with `[code] message`, for example `[invalid-request]`, `[unknown-agent]`, `[control-unavailable]` or `[not-found]`. `[provenance-unavailable]` means the run WAS accepted: use the runId in its evidence with `delegate.status` and `delegate.harvest`; never redispatch it.",
	"- Cancellation: aborting `fabric_exec` before acceptance launches nothing; after acceptance it only stops observing. Only `delegate.cancel` stops accepted work.",
	"- Results are bounded: logs follow native tail limits, and a result larger than Fabric's nested result limit arrives as a truncated preview. The complete envelope stays at the receipt's `resultPath`.",
].join("\n");

/** Remove exact whole lines, leaving every other byte of the prompt unchanged. */
export function withoutLines(text: string, lines: readonly string[]): string {
	if (lines.length === 0) return text;
	const drop = new Set(lines);
	return text.split("\n").filter((line) => !drop.has(line)).join("\n");
}

export type DelegateFabricSurfaceState = "absent" | "ready" | "unsupported" | "failed" | "withdrawn";

export interface DelegateFabricAdapter {
	readonly provider: FabricProvider;
	readonly state: DelegateFabricSurfaceState;
	/** Last bounded diagnostic for an unsupported or failed negotiation. */
	readonly diagnostic: string | undefined;
	/** Registrations Fabric accepted through discovery in this session. */
	readonly registrations: number;
	/** True when the ready Fabric surface exposes every native capability. */
	coversNativeSurface(): boolean;
	/**
	 * True when the Fabric interface is the selected model interface: the surface
	 * is ready and complete, `fabric_exec` is active, and no mode requires the
	 * native surface. Fabric-mode instructions and native suppression follow it.
	 */
	selected(): boolean;
	/**
	 * True when a Fabric host is loaded (`fabric_exec` is registered) but has not
	 * selected the Fabric interface yet. Fabric may still select it from its own
	 * `session_start` when it loads after pi-delegate, so model-facing startup
	 * text should wait until every `session_start` handler has run.
	 */
	selectionPending(): boolean;
	/** Call from the foreground `session_start`, after the runtime core is installed. */
	sessionStart(context: ExtensionContext): void;
	/** Call from the foreground `session_shutdown`. */
	sessionShutdown(): void;
}

export interface DelegateFabricAdapterHost {
	/** False inside delegate-owned worker sessions, which never register. */
	isForeground(): boolean;
	/** True while another mode, such as delegate-only, owns the native surface. */
	nativeSurfaceRequired(): boolean;
	/** Capabilities of the runtime core this instance installs; empty when none is installed. */
	coreCapabilities(): readonly string[];
	/** Exact native prompt lines (tool snippet and guidelines) Fabric mode replaces. */
	nativePromptLines(): readonly string[];
	/** Reconcile native advertisement after the Fabric surface changes. */
	onSurfaceChange(): void;
	/** Persist a bounded diagnostic. */
	diagnose(message: string): void;
}

/** Wire the adapter into one pi-delegate extension instance. */
export function setupFabricAdapter(pi: ExtensionAPI, host: DelegateFabricAdapterHost): DelegateFabricAdapter {
	let state: DelegateFabricSurfaceState = "absent";
	let diagnostic: string | undefined;
	let registrations = 0;
	let pendingNotice: string | undefined;
	const transition = (next: DelegateFabricSurfaceState) => {
		if (state === next) return;
		state = next;
		try { host.onSurfaceChange(); } catch { /* Native access never depends on reconciliation. */ }
	};
	const report = (reason: string) => {
		diagnostic = bounded(`pi-delegate: Fabric adapter not registered (${bounded(reason, 300)}). Native delegate tools stay active. Use a pi-fabric build that speaks provider protocol v${FABRIC_PROVIDER_PROTOCOL_VERSION} (tested with 0.96.x), or report the pi-fabric version.`, 600);
		pendingNotice = diagnostic;
		try { host.diagnose(diagnostic); } catch { /* Diagnostics are best-effort. */ }
	};
	const provider = createDelegateFabricProvider({
		onClosed: () => { if (state === "ready") transition("withdrawn"); },
	});
	const onDiscover = (value: unknown) => {
		if (!host.isForeground()) return;
		const read = readFabricProviderDiscovery(value);
		if (read.kind === "unsupported") {
			report(read.reason);
			if (state !== "ready") transition("unsupported");
			return;
		}
		try {
			read.discovery.register(provider, { overwrite: true });
		} catch (error) {
			report(`registration failed: ${error instanceof Error ? error.message : String(error)}`);
			transition("failed");
			return;
		}
		registrations++;
		diagnostic = undefined;
		transition("ready");
	};
	let unsubscribeDiscover: (() => void) | undefined;
	const subscribe = () => {
		if (unsubscribeDiscover) return;
		const unsubscribe = pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, onDiscover);
		unsubscribeDiscover = typeof unsubscribe === "function" ? unsubscribe : () => {};
	};
	// Subscribe at load: Fabric may activate from its own session_start, before
	// pi-delegate's session_start handler runs.
	subscribe();

	pi.on("before_agent_start", (event, ctx) => {
		if (!host.isForeground()) return undefined;
		if (pendingNotice && ctx.hasUI) {
			try { ctx.ui.notify(pendingNotice, "warning"); } catch { /* best-effort */ }
		}
		pendingNotice = undefined;
		if (!adapter.selected()) return undefined;
		// The base prompt for this turn can predate native suppression, so drop the
		// native delegate lines here as well; later turns omit them already.
		return { systemPrompt: `${withoutLines(event.systemPrompt, host.nativePromptLines())}\n\n${FABRIC_MODE_INSTRUCTIONS}` };
	});

	const adapter: DelegateFabricAdapter = {
		provider,
		get state() { return state; },
		get diagnostic() { return diagnostic; },
		get registrations() { return registrations; },
		coversNativeSurface() {
			if (state !== "ready") return false;
			// Judged on the installed core: every native capability must be both
			// supported there and exposed as a provider action.
			let capabilities: readonly string[];
			try { capabilities = host.coreCapabilities(); } catch { return false; }
			return DELEGATE_RUNTIME_CAPABILITIES.every((capability) => capabilities.includes(capability) && ACTION_BY_NAME.has(capability));
		},
		selected() {
			if (!host.isForeground() || host.nativeSurfaceRequired() || !adapter.coversNativeSurface()) return false;
			let active: unknown;
			try { active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined; } catch { return false; }
			return Array.isArray(active) && active.includes("fabric_exec");
		},
		selectionPending() {
			if (!host.isForeground() || host.nativeSurfaceRequired() || adapter.selected()) return false;
			try {
				const all: unknown = typeof pi.getAllTools === "function" ? pi.getAllTools() : undefined;
				return Array.isArray(all) && all.some((tool) => (tool as { name?: unknown } | null)?.name === "fabric_exec");
			} catch {
				return false;
			}
		},
		sessionStart() {
			if (!host.isForeground()) return;
			subscribe();
			const registration: FabricProviderRegistration = { version: FABRIC_PROVIDER_PROTOCOL_VERSION, provider, overwrite: true };
			try { pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, registration); } catch { /* No Fabric listener is a normal state. */ }
			try { host.onSurfaceChange(); } catch { /* best-effort */ }
		},
		sessionShutdown() {
			unsubscribeDiscover?.();
			unsubscribeDiscover = undefined;
			registrations = 0;
			pendingNotice = undefined;
			// The session is ending: record the state without reconciling tools
			// on a runtime that is being disposed.
			state = "absent";
		},
	};
	return adapter;
}