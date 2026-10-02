/**
 * Programmatic managed runtime facade.
 *
 * The extension installs the exact handlers registered as `delegate`,
 * `delegate_status`, `delegate_result`, `delegate_steer`, and
 * `delegate_cancel`. Consumers therefore get a code-owned entrypoint without a
 * second execution path or tool-to-tool invocation.
 *
 * Receipt and result files are stable observer contracts. They live under
 * `<agentDir>/extensions/pi-delegate/runtime-api/<runId>/` and are replaced
 * atomically so a dashboard may read them without coordinating with the
 * running extension.
 */

import type { EscalationKind } from "./escalation-store.js";
import { runtimeOperations, resolveRuntimeForkName } from "./runtime-operations.js";
import { RuntimeStatusSchema, RuntimeSteerSchema, RuntimeCancelSchema, assertRuntimeCorrespondence, RuntimeResultContractError, decodeRuntimeResult, type DelegateRuntimeCapability, type DelegateRuntimeStatus, type DelegateRuntimeControlResult } from "./runtime-contract.js";
export * from "./runtime-contract.js";
import type { RuntimeToolName } from "./runtime-boundary.js";
import { RuntimeInvocation, withRuntimeInvocation, type RuntimeContextBinding, type DelegateRuntimeInvocationOptions } from "./runtime-invocation.js";
export type { DelegateRuntimeInvocationOptions, DelegateRuntimeUpdate } from "./runtime-invocation.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { readDaemonDriverCfg } from "./daemon-driver.js";
import { daemonDispatchEntries, projectDispatchSteps, digestDispatchInputs, readDispatchEvidence, type DispatchAcceptance, type DispatchFailureEvidence, type DispatchInputDigest, type DispatchStepEvidence } from "./dispatch-evidence.js";
export type { DispatchAcceptance, DispatchFailureEvidence, DispatchStepEvidence } from "./dispatch-evidence.js";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CancelReason, DelegateDispatchSnapshot } from "./runtime.js";
import { getRunSnapshot } from "./runtime.js";
import { isSafeRunId } from "./run-id.js";
import { readJsonFile, replaceJsonFile, resolveDelegateStateDir } from "./state-io.js";
import { normalizeDelegateParams } from "./delegate-normalize.js";
import { prepareArguments, prepareRuntimeDispatchArguments } from "./delegate-params.js";
import { compileDelegateRuns, UnsupportedRunOptionError } from "./delegate-runs.js";
import { resolveEffectiveCwd } from "./cwd-resolution.js";

export const DELEGATE_RUNTIME_ENVELOPE_VERSION = 1 as const;

export type DelegateRuntimeErrorCode =
	| "core-unavailable"
	| "context-unavailable"
	| "stale-context"
	| "invocation-aborted"
	| "unsupported-capability"
	| "invalid-request"
	| "authorization-denied"
	| "unsupported-option"
	| "input-unreadable"
	| "unknown-agent"
	| "model-unavailable"
	| "invalid-confinement"
	| "not-found"
	| "control-unavailable"
	| "core-error"
	| "provenance-unavailable";

export class DelegateRuntimeError extends Error {
	constructor(
		readonly code: DelegateRuntimeErrorCode,
		message: string,
		readonly cause?: unknown,
		readonly evidence?: DispatchFailureEvidence,
	) {
		super(message);
		this.name = "DelegateRuntimeError";
	}
}

export type DelegateRuntimeInputDigest = DispatchInputDigest;

export interface DelegateRuntimeRunReceipt {
	name: string;
	agent: string;
	workerCwd?: string;
	branch?: string;
	maxRounds: number;
	cloneMode?: string;
	collapseMode?: string;
	confineWrites?: boolean;
	readOnly?: boolean;
	requestedModel?: string;
	resolvedModel?: string;
	skills?: string[];
	inputDigests: DelegateRuntimeInputDigest[];
}

/** @deprecated Use {@link DelegateRuntimeRunReceipt}; retained for compatibility. */
export type DelegateRuntimeForkReceipt = DelegateRuntimeRunReceipt;

export interface DelegateRuntimeReceipt {
	schema: "pi-delegate.runtime-receipt";
	version: typeof DELEGATE_RUNTIME_ENVELOPE_VERSION;
	runId: string;
	createdAt: string;
	shape: string;
	acceptance?: DispatchAcceptance;
	inputDigests?: DispatchInputDigest[];
	steps?: DispatchStepEvidence[];
	/** Stable runtime-API field retained as `forks`; entries are runs. */
	forks: DelegateRuntimeRunReceipt[];
	receiptPath: string;
	resultPath: string;
}

export interface DelegateRuntimeRunProvenance {
	name: string;
	agent: string;
	resolvedModel?: string;
	workerCwd?: string;
	workerSessionFile?: string;
	status: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	inputDigests: DelegateRuntimeInputDigest[];
	actualInputDigests: Array<{ sequence: number; algorithm: "sha256"; digest: string }>;
}

/** @deprecated Use {@link DelegateRuntimeRunProvenance}; retained for compatibility. */
export type DelegateRuntimeForkProvenance = DelegateRuntimeRunProvenance;

export interface DelegateRuntimeResult {
	schema: "pi-delegate.runtime-result";
	version: typeof DELEGATE_RUNTIME_ENVELOPE_VERSION;
	runId: string;
	state: string;
	observedAt: string;
	terminal: boolean;
	provenance: DelegateRuntimeRunProvenance[];
	acceptance?: DispatchAcceptance;
	inputDigests?: DispatchInputDigest[];
	steps?: DispatchStepEvidence[];
	content?: Array<{ type: string; text?: string }>;
	result: unknown;
	resultPath: string;
}

export interface DelegateRuntimeDispatchRequest extends Record<string, unknown> {
	/** Canonical entries; legacy spellings remain accepted by normalization. */
	runs?: import("./delegate-runs.js").CanonicalRun[];
	agent?: string;
	task?: string;
	chain?: string | Array<Record<string, unknown>>;
	chainName?: string;
	/** Unsupported legacy claim: pi-delegate does not enforce edit intent. */
	edit?: never;
}

export interface DelegateRuntimeSteerRequest {
	runId: string;
	/** Stable runtime-API addressing key retained for compatibility. */
	forkName?: string;
	message: string;
	deliverAs?: "steer" | "followUp" | "queue";
	targetLineagePath?: string;
	capToken?: string;
}

export interface DelegateRuntimeCancelRequest {
	runId: string;
	/** Stable runtime-API addressing key retained for compatibility. */
	forkName?: string;
	reason?: string;
	targetLineagePath?: string;
	capToken?: string;
}

export interface DelegateRuntimeToolResult {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface InstalledRuntimeCore {
	configureHostEscalationDelivery?(kinds: readonly EscalationKind[]): void;
	capabilities?: readonly DelegateRuntimeCapability[];
	bindContext?(context: ExtensionContext): RuntimeContextBinding;
	observe?(runId: string, invocation: RuntimeInvocation, context?: ExtensionContext): () => void;
	inspectWait?(runId: string, context: ExtensionContext): DelegateRuntimeToolResult | Promise<DelegateRuntimeToolResult>;
	observeDetached?(runId: string, invocation: RuntimeInvocation): Promise<boolean>;
	/** Native handler owns lookup, input preflight and evidence preparation. */
	sharedPreparation?: true;
	invoke(
		name: RuntimeToolName,
		params: Record<string, unknown>,
		ctx: ExtensionContext,
		invocation?: RuntimeInvocation,
	): Promise<DelegateRuntimeToolResult>;
}

let installedCore: InstalledRuntimeCore | undefined;
const activeInvocations = new Set<RuntimeInvocation>();
function disposeInvocations(): void { for (const invocation of activeInvocations) invocation.dispose(); }

/**
 * Process-global key for the live runtime API handle.
 *
 * The runtime client only works through the core that the loaded pi-delegate
 * instance installed. Another package that resolves its own copy of this module
 * gets an empty `installedCore` and fails closed with `core-unavailable`. A
 * consumer extension such as pi-work reads this handle to reach the live
 * instance instead of importing a second copy. The `v1` suffix versions the
 * handle shape, not the package.
 */
export const DELEGATE_RUNTIME_API_HANDLE_KEY: unique symbol = Symbol.for("pi-delegate.runtime-api.v1") as never;

/** Shape published under {@link DELEGATE_RUNTIME_API_HANDLE_KEY}. */
export interface DelegateRuntimeApiHandle {
	readonly createDelegateRuntimeClient: typeof createDelegateRuntimeClient;
	readonly normalizeDelegateParams: typeof normalizeDelegateParams;
}

/**
 * Frozen handle object for this module instance. Created once, so an ownership
 * check can compare by identity: a stale instance never deletes a successor's
 * handle. Freezing makes the object shallowly immutable only; the global slot
 * itself stays writable, like any `globalThis` property. This is not a security
 * boundary: every extension already runs with full process authority.
 */
const runtimeApiHandle: DelegateRuntimeApiHandle = Object.freeze({ createDelegateRuntimeClient, normalizeDelegateParams });

/**
 * Extension-internal installation seam. The public factory fails closed until
 * installed. Installing publishes this instance's handle under
 * {@link DELEGATE_RUNTIME_API_HANDLE_KEY}. `undefined` is a test-only reset that
 * clears the core and this instance's handle.
 */
export function installDelegateRuntimeCore(core: InstalledRuntimeCore | undefined): void {
	if (core === undefined) {
		if (installedCore !== undefined) uninstallDelegateRuntimeCore(installedCore);
		return;
	}
	if (installedCore !== core) disposeInvocations();
	installedCore = core;
	(globalThis as Record<symbol, unknown>)[DELEGATE_RUNTIME_API_HANDLE_KEY] = runtimeApiHandle;
}

/**
 * Withdraw a core this instance installed. It is a no-op when a different core
 * is installed. The global handle is removed only while it is still this
 * instance's handle, so a successor module's fresh publication survives.
 */
export function uninstallDelegateRuntimeCore(core: InstalledRuntimeCore): void {
	if (installedCore !== core) return;
	disposeInvocations();
	installedCore = undefined;
	const slot = globalThis as Record<symbol, unknown>;
	if (slot[DELEGATE_RUNTIME_API_HANDLE_KEY] === runtimeApiHandle) delete slot[DELEGATE_RUNTIME_API_HANDLE_KEY];
}

function receiptDir(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) throw new Error(`unsafe delegate runId: ${JSON.stringify(runId)}`);
	return path.join(resolveDelegateStateDir(agentDir), "runtime-api", runId);
}

export function resolveDelegateRuntimeReceiptPath(agentDir: string, runId: string): string {
	return path.join(receiptDir(agentDir, runId), "receipt.json");
}

export function resolveDelegateRuntimeResultPath(agentDir: string, runId: string): string {
	return path.join(receiptDir(agentDir, runId), "result.json");
}

function stringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : undefined;
}

/** Compatibility for old installed cores: declared inputs only, never execution planning. */
function slotsForRequest(request: DelegateRuntimeDispatchRequest): Array<Record<string, unknown>> {
	if (Array.isArray(request.runs)) return request.runs;
	if (Array.isArray(request.agents)) return request.agents;
	if (Array.isArray(request.tasks)) return request.tasks;
	if (typeof request.agent === "string" && typeof request.task === "string") return [request];
	return [];
}

const digestSlotInputs = digestDispatchInputs;


function runReceipt(
	runState: DelegateDispatchSnapshot["forks"][string],
	slot: Record<string, unknown> | undefined,
	inputDigests: DelegateRuntimeInputDigest[],
): DelegateRuntimeRunReceipt {
	const skills = stringArray(slot?.skills ?? slot?.skill);
	return {
		name: runState.name,
		agent: runState.agent,
		...(runState.workerCwd ? { workerCwd: runState.workerCwd } : {}),
		...(runState.workerBranch ? { branch: runState.workerBranch } : {}),
		maxRounds: runState.maxRounds,
		...(runState.cloneMode ? { cloneMode: runState.cloneMode } : {}),
		...(runState.collapseMode ? { collapseMode: runState.collapseMode } : {}),
		...(runState.confineWrites !== undefined ? { confineWrites: runState.confineWrites } : {}),
		...(runState.readOnly !== undefined
			? { readOnly: runState.readOnly }
			: typeof slot?.readOnly === "boolean" ? { readOnly: slot.readOnly } : {}),
		...(runState.requestedModel ? { requestedModel: runState.requestedModel } : {}),
		...(runState.resolvedModel ? { resolvedModel: runState.resolvedModel } : {}),
		...(runState.skills ? { skills: [...runState.skills] } : skills ? { skills } : {}),
		inputDigests,
	};
}

function buildReceipt(
	agentDir: string,
	run: DelegateDispatchSnapshot,
	request: DelegateRuntimeDispatchRequest,
	inputDigests: DelegateRuntimeInputDigest[][],
): DelegateRuntimeReceipt {
	const slots = slotsForRequest(request);
	const byName = new Map(slots.map((slot, index) => [String(slot.name ?? index), inputDigests[index] ?? []]));
	const runEntries = Object.values(run.forks);
	const receiptPath = resolveDelegateRuntimeReceiptPath(agentDir, run.runId);
	const resultPath = resolveDelegateRuntimeResultPath(agentDir, run.runId);
	return {
		schema: "pi-delegate.runtime-receipt",
		version: DELEGATE_RUNTIME_ENVELOPE_VERSION,
		runId: run.runId,
		createdAt: new Date(run.createdAt).toISOString(),
		shape: run.shape ?? "unknown",
		forks: runEntries.map((runState, index) => {
			const slot = slots.find((candidate) => String(candidate.name) === runState.name) ?? slots[index];
			return runReceipt(runState, slot, byName.get(String(slot?.name ?? index)) ?? inputDigests[index] ?? []);
		}),
		receiptPath,
		resultPath,
	};
}


function requireCore(): InstalledRuntimeCore {
	if (!installedCore) {
		throw new DelegateRuntimeError(
			"core-unavailable",
			"pi-delegate runtime API is unavailable: the extension core is not installed",
		);
	}
	return installedCore;
}

function requireSuccessful(result: DelegateRuntimeToolResult, operation: string): DelegateRuntimeToolResult {
	if (!result.isError) return result;
	const message = result.content?.find((item) => item.type === "text")?.text;
	const code = recordDetails(result.details).errorCode;
	if (code === "input-unreadable" || code === "invalid-request" || code === "authorization-denied" || code === "unsupported-option" || code === "unsupported-capability" || code === "control-unavailable" || code === "not-found" || code === "unknown-agent" || code === "model-unavailable" || code === "invalid-confinement") throw new DelegateRuntimeError(code, `${operation} failed${message ? `: ${message}` : ""}`);
	const fullMessage = `${operation} failed${message ? `: ${message}` : ""}`;
	throw new DelegateRuntimeError("core-error", fullMessage);
}

function recordDetails(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/** Emitted synchronously at foreground start, before durable wakes replay. */
export interface DelegateHostEscalationDeliveryEvent {
	readonly context: ExtensionContext;
	/** Claim selected user-held kinds for this session; call synchronously. */
	readonly configure: (kinds: readonly EscalationKind[]) => void;
}

export interface DelegateRuntimeClient extends ReturnType<typeof runtimeOperations> {
	/** Replace host-owned user-held kinds for this live session; [] releases ownership. */
	configureHostEscalationDelivery(kinds: readonly EscalationKind[]): void;
	readonly capabilities: readonly DelegateRuntimeCapability[];
	/** Canonical entry point. The request selects the execution mode. */
	dispatch(request: DelegateRuntimeDispatchRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeReceipt>;
	/** @deprecated Use {@link DelegateRuntimeClient.dispatch | dispatch()}. Literal alias; does not force solo mode. */
	direct(request: DelegateRuntimeDispatchRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeReceipt>;
	/** @deprecated Use {@link DelegateRuntimeClient.dispatch | dispatch()}. Literal alias; does not force supervised mode. */
	managed(request: DelegateRuntimeDispatchRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeReceipt>;
	status(runId: string, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeStatus>;
	harvest(runId: string, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeResult>;
	steer(request: DelegateRuntimeSteerRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeControlResult>;
	cancel(request: DelegateRuntimeCancelRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeControlResult>;
}

/**
 * Construct a client bound to one live extension context.
 *
 * Wait is bounded observation; dispatch always returns accepted receipts immediately.
 */
export function createDelegateRuntimeClient(options: {
	context: ExtensionContext;
	agentDir?: string;
}): DelegateRuntimeClient {
	const { context } = options;
	const agentDir = options.agentDir ?? getAgentDir();
	const core = installedCore;
	let binding: RuntimeContextBinding | undefined;
	let bindingError: unknown;
	try {
		if (!core) requireCore();
		if (typeof core?.bindContext !== "function" || typeof core.observe !== "function") throw new DelegateRuntimeError("unsupported-capability", "Installed core does not support invocation lifecycle");
		const bound = core.bindContext(context);
		binding = {
			assertCurrent() {
				if (!installedCore) throw new DelegateRuntimeError("core-unavailable", "Runtime core is no longer installed");
				if (installedCore !== core) throw new DelegateRuntimeError("stale-context", "Runtime client belongs to a replaced core");
				bound.assertCurrent();
			},
			onInvalidate: (callback) => bound.onInvalidate(callback),
		};
	} catch (error) { bindingError = error; }
	const invoke = async <T>(options: DelegateRuntimeInvocationOptions | undefined, retain: boolean, operation: (invocation: RuntimeInvocation) => Promise<T>): Promise<T> => {
		if (options !== undefined && (options === null || typeof options !== "object" || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (options.onUpdate !== undefined && typeof options.onUpdate !== "function"))) throw new DelegateRuntimeError("invalid-request", "Invocation options require an AbortSignal and/or onUpdate function");
		requireCore();
		if (installedCore !== core) throw new DelegateRuntimeError("stale-context", "Runtime client belongs to a replaced core");
		if (bindingError) throw bindingError;
		const invocation = new RuntimeInvocation(binding!, options, () => logDelegateDiagnostic("runtime API observer threw; observation detached", { agentDir, level: "warn" }));
		activeInvocations.add(invocation);
		invocation.own(() => { activeInvocations.delete(invocation); });
		try { return await withRuntimeInvocation(invocation, () => operation(invocation)); }
		catch (error) {
			invocation.dispose();
			const acceptance = invocation.acceptance;
			if (acceptance && !(error instanceof DelegateRuntimeError && error.evidence)) {
				throw new DelegateRuntimeError("provenance-unavailable", "Accepted invocation failed; inspect the existing run rather than redispatching", error,
					{ acceptance, stage: "metadata", cleanup: "not-requested", terminalConfirmed: false, recovery: { runId: acceptance.runId, action: "status-and-harvest" } });
			}
			if (error instanceof DelegateRuntimeError) throw error;
			throw new DelegateRuntimeError(error instanceof RuntimeResultContractError ? "unsupported-capability" : "core-error", error instanceof Error ? error.message : "Runtime operation failed", error);
		}
		finally { if (!retain) invocation.dispose(); }
	};
	const dispatch = (request: DelegateRuntimeDispatchRequest, options?: DelegateRuntimeInvocationOptions): Promise<DelegateRuntimeReceipt> => invoke(options, Boolean(options?.onUpdate), async (invocation) => {
		if (Object.prototype.hasOwnProperty.call(request, "action")) throw new DelegateRuntimeError("invalid-request", "Use manage() or health() for explicit management operations");
		if (Object.prototype.hasOwnProperty.call(request, "edit")) {
			throw new DelegateRuntimeError(
				"unsupported-option",
				"delegate runtime dispatch does not support or enforce `edit`; omit it explicitly",
			);
		}
		let canonical: Record<string, unknown>;
		try {
			canonical = core!.sharedPreparation === true ? normalizeDelegateParams(prepareRuntimeDispatchArguments(request)) : prepareArguments(normalizeDelegateParams(request));
		} catch (error) {
			// A well-formed request naming an unsupported option combination (for
			// example `reads` with `worktree: true`) keeps its precise code. Schema
			// and normalization failures still resolve first, so error-code
			// precedence matches a pre-guard baseline.
			if (error instanceof UnsupportedRunOptionError) {
				throw new DelegateRuntimeError("unsupported-option", error.message, error);
			}
			throw new DelegateRuntimeError("invalid-request", `delegate runtime dispatch request is invalid: ${error instanceof Error ? error.message : String(error)}`, error);
		}
		const sharedPreparation = core!.sharedPreparation === true;
		const slots = sharedPreparation ? [] : slotsForRequest(canonical as DelegateRuntimeDispatchRequest);
		if (!sharedPreparation && slots.length === 0 && typeof canonical.chain !== "string" && typeof canonical.chainName !== "string") {
			throw new DelegateRuntimeError(
				"invalid-request",
				"delegate runtime dispatch accepts exactly one direct `{agent, task}`, `tasks`, or managed `agents` shape",
			);
		}
		// Validate every named input before the production core creates a run.
		// A receipt is evidence; an unreadable input must therefore prevent
		// dispatch rather than create unreceipted work and fail afterwards.
		const inputDigests: DelegateRuntimeInputDigest[][] = [];
		for (const slot of slots) {
			const slotCwd = resolveEffectiveCwd(context.cwd, typeof canonical.cwd === "string" ? canonical.cwd : undefined, typeof slot.cwd === "string" ? slot.cwd : undefined);
			try {
				inputDigests.push(await digestSlotInputs(slot, slotCwd));
			} catch (error) {
				throw new DelegateRuntimeError(
					"input-unreadable",
					`delegate runtime dispatch could not read a named input: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);
			}
		}
		const driver = Array.isArray(canonical.runs) && canonical.runs.some((run) => recordDetails(run).mode === "driver");
		// Drivers are intrinsically asynchronous and reject even await:false.
		const params = { ...(sharedPreparation ? prepareRuntimeDispatchArguments(request) : compileDelegateRuns(canonical)), ...(driver ? {} : { await: false }) } as Record<string, unknown>;
		invocation.assertPreparing();
		const raw = await core!.invoke("delegate", params, context, invocation);
		const detail = recordDetails(raw.details);
		if (raw.isError && detail.dispatchFailure) {
			throw new DelegateRuntimeError("provenance-unavailable", raw.content?.[0]?.text ?? "daemon submission failed", undefined, detail.dispatchFailure as DispatchFailureEvidence);
		}
		if (raw.isError && invocation.acceptance) {
			const acceptance = invocation.acceptance;
			throw new DelegateRuntimeError("provenance-unavailable", "Accepted run preparation failed; inspect the existing run rather than redispatching", undefined,
				{ acceptance, stage: "metadata", cleanup: "not-requested", terminalConfirmed: false, recovery: { runId: acceptance.runId, action: "status-and-harvest" } });
		}
		requireSuccessful(raw, "dispatch");
		const runId = recordDetails(raw.details).runId;
		if (typeof runId !== "string") {
			throw new DelegateRuntimeError("provenance-unavailable", "dispatch failed: core returned no durable runId");
		}
		const acceptance: DispatchAcceptance = {
			runId, transport: detail.mode === "driver" ? "daemon" : "in-process", state: "accepted",
			...(typeof detail.daemonSessionId === "string" ? { daemonSessionId: detail.daemonSessionId } : {}),
			...(typeof detail.promptId === "string" ? { promptId: detail.promptId } : {}),
			...(typeof detail.idempotencyKey === "string" ? { idempotencyKey: detail.idempotencyKey } : {}),
		};
		invocation.accept(acceptance);
		let stage: "metadata" | "receipt" = "metadata";
		try {
			const run = getRunSnapshot(runId);
			const evidence = readDispatchEvidence(agentDir, runId);
			if (sharedPreparation && !evidence) throw new Error("shared dispatch evidence unavailable");
			if (!run && !(detail.accepted === true && acceptance.transport === "daemon" && acceptance.promptId)) throw new Error("accepted run metadata unavailable");
			const receipt: DelegateRuntimeReceipt = run
				? buildReceipt(agentDir, run, canonical as DelegateRuntimeDispatchRequest, inputDigests)
				: { schema: "pi-delegate.runtime-receipt", version: 1, runId,
					createdAt: evidence?.createdAt ?? new Date().toISOString(), shape: evidence?.shape ?? "driver",
					forks: [], receiptPath: resolveDelegateRuntimeReceiptPath(agentDir, runId), resultPath: resolveDelegateRuntimeResultPath(agentDir, runId) };
			receipt.acceptance = acceptance;
			if (evidence) {
				receipt.inputDigests = evidence.inputDigests;
				receipt.steps = projectDispatchSteps(evidence.steps, run, daemonDispatchEntries(readDaemonDriverCfg(agentDir, runId)), Boolean(run?.completedAt));
				receipt.forks = evidence.steps.map((step) => {
					const live = run?.forks[step.name];
					return live ? runReceipt(live, undefined, step.inputDigests) : { name: step.name, agent: step.agent, maxRounds: 1, inputDigests: step.inputDigests };
				});
			}
			stage = "receipt";
			replaceJsonFile(receipt.receiptPath, receipt);
			// Completion can precede receipt publication. Its earlier event could not see a receipt.
			if (run?.completedAt !== undefined) {
				try { publishDelegateRuntimeResult(agentDir, runId, await core!.invoke("delegate_result", { runId }, context)); }
				catch { logDelegateDiagnostic("runtime API fast terminal publication failed; use harvest", { agentDir, level: "warn" }); }
			}
			return receipt;
		} catch (error) {
			let cleanup: DispatchFailureEvidence["cleanup"] = "unknown";
			try {
				const cancelled = await core!.invoke("delegate_cancel", { runId, reason: "runtime evidence publication failed" }, context);
				cleanup = cancelled.isError ? "rejected" : "acknowledged";
			} catch { /* Cancellation outcome is unknown, not rolled back. */ }
			throw new DelegateRuntimeError("provenance-unavailable",
				`Accepted runId=${runId}; ${stage} publication failed. Cancellation ${cleanup}; terminal outcome unconfirmed. Recover by status/harvest, not redispatch.`, error,
				{ acceptance, stage, cleanup, terminalConfirmed: false, recovery: { runId, action: "status-and-harvest" } });
		}
	});

	return {
		...runtimeOperations({ agentDir, binding: () => binding!, invoke, call: (name, params, invocation) => core!.invoke(name, params, context, invocation), observe: (runId, invocation) => core!.observe!(runId, invocation, context), observeDetached: (runId, invocation) => core?.observeDetached?.(runId, invocation) ?? Promise.resolve(false), inspectWait: runId => { if (!core?.inspectWait) throw new DelegateRuntimeError("unsupported-capability", "Installed core lacks read-only wait inspection"); return core.inspectWait(runId, context); }, require: requireSuccessful, supports: capability => core?.capabilities?.includes(capability) === true }),
		configureHostEscalationDelivery(kinds) {
			requireCore();
			if (installedCore !== core) throw new DelegateRuntimeError("stale-context", "Runtime client belongs to a replaced core");
			if (bindingError) throw bindingError;
			binding!.assertCurrent();
			if (!Array.isArray(kinds) || kinds.some((kind) => kind !== "decision" && kind !== "blocker" && kind !== "amendment")) {
				throw new DelegateRuntimeError("invalid-request", "Host escalation kinds must be an array of decision, blocker, or amendment");
			}
			if (!core!.configureHostEscalationDelivery) throw new DelegateRuntimeError("unsupported-capability", "Installed core does not support host escalation delivery");
			core!.configureHostEscalationDelivery(kinds);
		},
		capabilities: Object.freeze([...(core?.capabilities ?? [])]),
		dispatch,
		direct: dispatch,
		managed: dispatch,
		status: (runId, options) => invoke(options, false, async (invocation) => {
			if (!isSafeRunId(runId)) throw new DelegateRuntimeError("invalid-request", "status requires a safe runId; use listRuns() to enumerate");
			const result = decodeRuntimeResult(RuntimeStatusSchema, requireSuccessful(await core!.invoke("delegate_status", { runId }, context, invocation), "status").details);
			for (const run of result.dispatches) assertRuntimeCorrespondence({ runId }, run);
			return result;
		}),
		harvest: (runId, options) => invoke(options, false, async (invocation) => {
			return publishDelegateRuntimeResult(agentDir, runId, await core!.invoke("delegate_result", { runId }, context, invocation));
		}),
		steer: (request, options) => invoke(options, false, async (invocation) => {
			const forkName = resolveRuntimeForkName("steer", request.runId, request.forkName);
			const result = decodeRuntimeResult(RuntimeSteerSchema, requireSuccessful(await core!.invoke("delegate_steer", { runId: request.runId, forkName: request.forkName, message: request.message, deliverAs: request.deliverAs, targetLineagePath: request.targetLineagePath, capToken: request.capToken }, context, invocation), "steer").details);
			assertRuntimeCorrespondence({ runId: request.runId, targetLineagePath: request.targetLineagePath, forkName: result.forkName === undefined && (result.alreadyTerminal || result.requestId || result.mode === "driver") ? undefined : forkName }, result);
			return result;
		}),
		cancel: (request, options) => invoke(options, false, async (invocation) => {
			const forkName = resolveRuntimeForkName("cancel", request.runId, request.forkName);
			const result = decodeRuntimeResult(RuntimeCancelSchema, requireSuccessful(await core!.invoke("delegate_cancel", { runId: request.runId, forkName: request.forkName, reason: request.reason, targetLineagePath: request.targetLineagePath, capToken: request.capToken }, context, invocation), "cancel").details);
			assertRuntimeCorrespondence({ runId: request.runId, targetLineagePath: request.targetLineagePath, forkName: result.forkName === undefined && (result.alreadyTerminal || result.requestId || result.mode === "driver") ? undefined : forkName }, result);
			return result;
		}),
	};
}

/** Re-read a stable receipt without requiring a live extension core. */
export function readDelegateRuntimeReceipt(agentDir: string, runId: string): DelegateRuntimeReceipt | undefined {
	const result = readJsonFile(resolveDelegateRuntimeReceiptPath(agentDir, runId));
	return result.kind === "ok" ? result.value as DelegateRuntimeReceipt : undefined;
}

/** Re-read the most recently harvested stable result without a live core. */
export function readDelegateRuntimeResult(agentDir: string, runId: string): DelegateRuntimeResult | undefined {
	const result = readJsonFile(resolveDelegateRuntimeResultPath(agentDir, runId));
	return result.kind === "ok" ? result.value as DelegateRuntimeResult : undefined;
}

export type { CancelReason };

/** Internal publication seam: callers must invoke the authorized result handler first. */
export function publishDelegateRuntimeResult(agentDir: string, runId: string, raw: DelegateRuntimeToolResult): DelegateRuntimeResult {
	const details = recordDetails(raw.details);
	// Terminal failures are valid judged outcomes and the production tool
	// deliberately marks them isError. Only reject an error that carries no
	// typed run result to persist.
	if (raw.isError && (typeof details.runId !== "string" || typeof details.status !== "string")) {
		requireSuccessful(raw, "harvest");
	}
	// Validate before reading or replacing requested-run evidence. A core response
	// is not authority to relabel another run's outcome as this one.
	assertRuntimeCorrespondence({ runId }, details);
	if (typeof details.status !== "string" || !details.status.trim()) throw new RuntimeResultContractError("Missing harvest status");
	if (details.acceptance !== undefined) assertRuntimeCorrespondence({ runId }, details.acceptance);
	const state = details.status;
	const receiptRead = readJsonFile(resolveDelegateRuntimeReceiptPath(agentDir, runId));
	const receipt = receiptRead.kind === "ok" ? receiptRead.value as DelegateRuntimeReceipt : undefined;
	const run = getRunSnapshot(runId);
	const runEntries = Array.isArray(details.forks) ? details.forks as Array<Record<string, unknown>> : [];
	const receiptByName = new Map((receipt?.forks ?? []).map((item) => [item.name, item]));
	const provenance = runEntries.map((entry, index): DelegateRuntimeRunProvenance => {
		const live = run?.forks[String(entry.name)];
		const runReceiptData = receiptByName.get(String(entry.name)) ?? receipt?.forks[index];
		const startedAtMs = live?.startedAt ?? live?.startedAtMs;
		const endedAtMs = live?.endedAt;
		return {
			name: String(entry.name),
			agent: String(entry.agent),
			...(typeof entry.workerModel === "string" ? { resolvedModel: entry.workerModel } : {}),
			...(typeof entry.workerCwd === "string" ? { workerCwd: entry.workerCwd } : {}),
			...(typeof entry.workerSessionFile === "string" ? { workerSessionFile: entry.workerSessionFile } : {}),
			status: String(entry.status),
			...(startedAtMs ? { startedAt: new Date(startedAtMs).toISOString() } : {}),
			...(endedAtMs ? { finishedAt: new Date(endedAtMs).toISOString() } : {}),
			...(startedAtMs && endedAtMs ? { durationMs: Math.max(0, endedAtMs - startedAtMs) } : {}),
			inputDigests: runReceiptData?.inputDigests ?? [],
			actualInputDigests: Array.isArray(entry.inputDigests)
				? entry.inputDigests.filter((digest): digest is { sequence: number; algorithm: "sha256"; digest: string } =>
					Boolean(digest) && typeof digest === "object" &&
					typeof (digest as Record<string, unknown>).sequence === "number" &&
					(digest as Record<string, unknown>).algorithm === "sha256" &&
					typeof (digest as Record<string, unknown>).digest === "string")
				: [],
		};
	});
	const terminal = state.startsWith("terminal-");
	const resultPath = resolveDelegateRuntimeResultPath(agentDir, runId);
	const envelope: DelegateRuntimeResult = {
		schema: "pi-delegate.runtime-result",
		version: DELEGATE_RUNTIME_ENVELOPE_VERSION,
		runId,
		state,
		observedAt: new Date().toISOString(),
		terminal,
		provenance,
		...(receipt?.acceptance || details.acceptance ? { acceptance: receipt?.acceptance ?? details.acceptance as DispatchAcceptance } : {}),
		...(receipt?.inputDigests ? { inputDigests: receipt.inputDigests } : {}),
		steps: projectDispatchSteps(readDispatchEvidence(agentDir, runId)?.steps ?? receipt?.steps ?? [], run, runEntries, terminal),
		...(raw.content ? { content: raw.content.map((item) => ({ type: item.type, ...(typeof item.text === "string" ? { text: item.text } : {}) })) } : {}),
		result: details,
		resultPath,
	};
	replaceJsonFile(resultPath, envelope);
	return envelope;
}
