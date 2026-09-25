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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CancelReason, DelegateDispatchSnapshot } from "./runtime.js";
import { getRunSnapshot } from "./runtime.js";
import { isSafeRunId } from "./run-id.js";
import { readJsonFile, replaceJsonFile, resolveDelegateStateDir } from "./state-io.js";
import { normalizeDelegateParams } from "./delegate-normalize.js";
import { openWorkerArtifact } from "./artifact-workspace.js";
import { prepareArguments } from "./delegate-params.js";
import { compileDelegateRuns, UnsupportedRunOptionError } from "./delegate-runs.js";
import { resolveEffectiveCwd } from "./cwd-resolution.js";

export const DELEGATE_RUNTIME_ENVELOPE_VERSION = 1 as const;

export type DelegateRuntimeErrorCode =
	| "core-unavailable"
	| "invalid-request"
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
	) {
		super(message);
		this.name = "DelegateRuntimeError";
	}
}

export interface DelegateRuntimeInputDigest {
	kind: "task" | "read" | "checklist" | "focus";
	name: string;
	algorithm: "sha256";
	digest: string;
}

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
	result: unknown;
	resultPath: string;
}

export interface DelegateRuntimeDispatchRequest extends Record<string, unknown> {
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
	invoke(
		name: "delegate" | "delegate_status" | "delegate_result" | "delegate_steer" | "delegate_cancel",
		params: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<DelegateRuntimeToolResult>;
}

let installedCore: InstalledRuntimeCore | undefined;

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
	installedCore = undefined;
	const slot = globalThis as Record<symbol, unknown>;
	if (slot[DELEGATE_RUNTIME_API_HANDLE_KEY] === runtimeApiHandle) delete slot[DELEGATE_RUNTIME_API_HANDLE_KEY];
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
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

function slotsForRequest(request: DelegateRuntimeDispatchRequest): Array<Record<string, unknown>> {
	const expand = (slots: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
		const used = new Set<string>();
		return slots.flatMap((slot, slotIndex) => {
			const count = typeof slot.count === "number" && Number.isInteger(slot.count) && slot.count > 0 ? slot.count : 1;
			return Array.from({ length: count }, (_, index) => {
				const copy = { ...slot };
				const base = typeof copy.name === "string" ? copy.name : `${String(copy.agent ?? "run")}${slotIndex + 1}`;
				const name = index === 0 && !used.has(base) ? base : `${base}#${index + 1}`;
				copy.name = name; used.add(name); return copy;
			});
		});
	};
	if (Array.isArray(request.runs)) return expand(request.runs as Array<Record<string, unknown>>);
	if (Array.isArray(request.agents)) return expand(request.agents as Array<Record<string, unknown>>);
	if (Array.isArray(request.tasks)) return expand(request.tasks as Array<Record<string, unknown>>);
	if (typeof request.agent === "string" && typeof request.task === "string") return [{ ...request, name: request.name ?? request.agent }];
	return [];
}

async function digestSlotInputs(slot: Record<string, unknown>, baseCwd: string): Promise<DelegateRuntimeInputDigest[]> {
	const digests: DelegateRuntimeInputDigest[] = [];
	if (typeof slot.task === "string") {
		digests.push({ kind: "task", name: "task", algorithm: "sha256", digest: sha256(slot.task) });
	}
	const reads = Array.isArray(slot.reads) ? slot.reads : [];
	for (const read of reads) {
		if (typeof read === "string") {
			const absolute = path.resolve(baseCwd, read);
			const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
			digests.push({ kind: "read", name: read, algorithm: "sha256", digest });
			continue;
		}
		// Use the same pin-aware reader admission as execution. Successful opening
		// recomputes and verifies the exact payload digest before this receipt trusts
		// the manifest-bound SHA-256.
		const opened = await openWorkerArtifact(read);
		try {
			digests.push({ kind: "read", name: opened.artifactRef.artifactName, algorithm: "sha256", digest: opened.artifactRef.sha256 });
		} finally {
			await opened.release();
		}
	}
	const checklist = slot.handoff && typeof slot.handoff === "object"
		? (slot.handoff as Record<string, unknown>).tasks
		: slot.checklist;
	if (checklist !== undefined) {
		digests.push({
			kind: "checklist",
			name: "checklist",
			algorithm: "sha256",
			digest: sha256(JSON.stringify(checklist)),
		});
	}
	const handoff = slot.handoff && typeof slot.handoff === "object"
		? (slot.handoff as Record<string, unknown>)
		: undefined;
	const focus = handoff?.focus ?? slot.focus;
	if (focus !== undefined) {
		digests.push({
			kind: "focus",
			name: "focus",
			algorithm: "sha256",
			// Hash the caller's own namespace bytes. Do not use the derived worker
			// seed, whose boundaries and provenance are added after this point.
			digest: sha256(JSON.stringify(focus)),
		});
	}
	return digests;
}

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

function errorCodeForMessage(message: string): DelegateRuntimeErrorCode {
	if (/unknown agent/i.test(message)) return "unknown-agent";
	if (/(?:model.*(?:unavailable|not found|resolve)|resolve.*model|unresolvable model)/i.test(message)) return "model-unavailable";
	if (/confin|writable root|write guard/i.test(message)) return "invalid-confinement";
	if (/unknown runId|no run found|not found/i.test(message)) return "not-found";
	if (/cannot (?:steer|cancel)|credential-unavailable|uncontrollable/i.test(message)) return "control-unavailable";
	return "core-error";
}

function requireSuccessful(result: DelegateRuntimeToolResult, operation: string): DelegateRuntimeToolResult {
	if (!result.isError) return result;
	const message = result.content?.find((item) => item.type === "text")?.text;
	const fullMessage = `${operation} failed${message ? `: ${message}` : ""}`;
	throw new DelegateRuntimeError(errorCodeForMessage(fullMessage), fullMessage);
}

function recordDetails(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export interface DelegateRuntimeClient {
	dispatch(request: DelegateRuntimeDispatchRequest): Promise<DelegateRuntimeReceipt>;
	direct(request: DelegateRuntimeDispatchRequest): Promise<DelegateRuntimeReceipt>;
	managed(request: DelegateRuntimeDispatchRequest): Promise<DelegateRuntimeReceipt>;
	status(runId: string): Promise<unknown>;
	harvest(runId: string): Promise<DelegateRuntimeResult>;
	steer(request: DelegateRuntimeSteerRequest): Promise<unknown>;
	cancel(request: DelegateRuntimeCancelRequest): Promise<unknown>;
}

/**
 * Construct a client bound to one live extension context.
 *
 * This deliberately exposes no wait, poll, loop, retry, or sequencing method.
 */
export function createDelegateRuntimeClient(options: {
	context: ExtensionContext;
	agentDir?: string;
}): DelegateRuntimeClient {
	const { context } = options;
	const agentDir = options.agentDir ?? getAgentDir();
	const dispatch = async (request: DelegateRuntimeDispatchRequest): Promise<DelegateRuntimeReceipt> => {
		if (Object.prototype.hasOwnProperty.call(request, "edit")) {
			throw new DelegateRuntimeError(
				"unsupported-option",
				"delegate runtime dispatch does not support or enforce `edit`; omit it explicitly",
			);
		}
		let canonical: Record<string, unknown>;
		try {
			canonical = prepareArguments(normalizeDelegateParams(request));
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
		const slots = slotsForRequest(canonical as DelegateRuntimeDispatchRequest);
		if (slots.length === 0) {
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
		const params = { ...compileDelegateRuns(canonical), await: false } as Record<string, unknown>;
		const raw = requireSuccessful(await requireCore().invoke("delegate", params, context), "dispatch");
		const runId = recordDetails(raw.details).runId;
		if (typeof runId !== "string") {
			throw new DelegateRuntimeError("provenance-unavailable", "dispatch failed: core returned no durable runId");
		}
		const run = getRunSnapshot(runId);
		if (!run) {
			throw new DelegateRuntimeError(
				"provenance-unavailable",
				`dispatch failed: runId=${runId} was not durably registered`,
			);
		}
		const receipt = buildReceipt(agentDir, run, canonical as DelegateRuntimeDispatchRequest, inputDigests);
		try {
			replaceJsonFile(receipt.receiptPath, receipt);
		} catch (error) {
			// Dispatch has already registered the run. If provenance publication
			// fails, revoke the unreceipted work before withholding its handle.
			try {
				await requireCore().invoke("delegate_cancel", { runId, reason: "runtime receipt publication failed" }, context);
			} catch {
				// Preserve the publication error; cancellation is best-effort but the
				// caller still receives a stable fail-closed classification.
			}
			throw new DelegateRuntimeError(
				"provenance-unavailable",
				`dispatch cancelled because its durable receipt could not be published: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
		return receipt;
	};

	return {
		dispatch,
		direct: dispatch,
		managed: dispatch,
		async status(runId) {
			const raw = requireSuccessful(
				await requireCore().invoke("delegate_status", { runId }, context),
				"status",
			);
			return raw.details;
		},
		async harvest(runId) {
			const raw = await requireCore().invoke("delegate_result", { runId }, context);
			const details = recordDetails(raw.details);
			// Terminal failures are valid judged outcomes and the production tool
			// deliberately marks them isError. Only reject an error that carries no
			// typed run result to persist.
			if (raw.isError && (typeof details.runId !== "string" || typeof details.status !== "string")) {
				requireSuccessful(raw, "harvest");
			}
			const state = typeof details.status === "string" ? details.status : "unknown";
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
				result: details,
				resultPath,
			};
			replaceJsonFile(resultPath, envelope);
			return envelope;
		},
		async steer(request) {
			const raw = requireSuccessful(
				await requireCore().invoke("delegate_steer", { ...request }, context),
				"steer",
			);
			return raw.details;
		},
		async cancel(request) {
			const raw = requireSuccessful(
				await requireCore().invoke("delegate_cancel", { ...request }, context),
				"cancel",
			);
			return raw.details;
		},
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
