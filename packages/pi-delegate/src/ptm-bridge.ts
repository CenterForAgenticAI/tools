/**
 * pi-prompt-template-model (PTM) bridge.
 *
 * Lets pi-delegate serve as the delegation backend for PTM templates that
 * use `subagent:`, `parallel:`, or `bestOfN:` frontmatter. PTM keeps
 * being the prompt-template language; pi-delegate becomes the runtime
 * it dispatches to.
 *
 * See docs/prompt-template-bridge.md for the full design. Phase 1 scope:
 *
 *   - Listen for `prompt-template:subagent:request`.
 *   - Translate to ExecuteDirectShapeArgs (direct mode, no supervisor).
 *   - Run sync via injected `runDelegate` (executeDirectShape from index.ts).
 *   - Emit `prompt-template:subagent:started` + `:response`.
 *   - Listen for `:cancel` and propagate via abort signal.
 *   - Set `PI_SUBAGENT_RUNTIME_ROOT` as a compatibility hook for older PTM
 *     installations that still perform runtime-root discovery.
 *
 * Phase 1 OUT of scope: live `:update` events, parallel chunking
 * beyond 6, supervised-clone mode (`runtime: supervised`).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "./agents.js";
import type { DelegateConfig } from "./config.js";
import type { DirectTaskInput } from "./direct-shape.js";
import type { RunResult } from "./fork-runner.js";
import { applyInvocationOverrides } from "./invocation-overrides.js";
import { canMountStatusWidget } from "./status-widget.js";

// ── Event channels (verbatim from PTM's subagent-runtime.ts) ─────────────
export const PTM_REQUEST = "prompt-template:subagent:request";
export const PTM_STARTED = "prompt-template:subagent:started";
export const PTM_RESPONSE = "prompt-template:subagent:response";
export const PTM_UPDATE = "prompt-template:subagent:update";
export const PTM_CANCEL = "prompt-template:subagent:cancel";
export const PTM_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const PTM_BACKEND_ID = "pi-delegate" as const;

/**
 * Receipt emitted before a PTM delegation begins. New fields are optional on
 * the wire so consumers can remain compatible with older backends; an absent
 * `ownsProgress` value is never an ownership claim.
 */
export interface PtmStarted {
	requestId: string;
	backend?: string;
	ownsProgress?: boolean;
}

const FORK_CONTEXT_ERROR =
	'PTM bridge context:"fork" is not supported: bounded parent-context snapshot is not yet supported. Use context:"fresh" or provide a bounded, trusted producer-context seed when that compatibility path is available.';

export type PtmEffectiveContext = "fresh";

// ── Wire types (mirror PTM's exported interfaces; we don't import from PTM) ─
export interface PtmRequestTask {
	agent: string;
	task: string;
	model?: string;
	skill?: string[];
	cwd?: string;
}

export interface PtmRequest {
	version?: typeof PTM_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	agent: string;
	task: string;
	tasks?: PtmRequestTask[];
	context: "fresh" | "fork";
	model: string;
	skill?: string[];
	cwd: string;
	worktree?: boolean;
}

export interface PtmParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
	/** PTM-selected model for this task. Added for provenance; v1 consumers ignore it. */
	requestedModel?: string;
	/** Actual provider/model resolved by pi-delegate for this task, when known. */
	actualModel?: string;
	/** Ordered model refs pi-delegate tried while resolving/falling back, when known. */
	attemptedModels?: string[];
	/** True when execution moved away from the requested model. */
	modelFallback?: boolean;
}

export interface PtmResponse {
	requestId: string;
	agent: string;
	task: string;
	/** v1 compatibility field: the PTM-requested context. Effective context provenance is below. */
	context: "fresh" | "fork";
	/** v1 compatibility field: the PTM-selected request model. Actual execution provenance is below. */
	model: string;
	cwd: string;
	messages: unknown[];
	parallelResults?: PtmParallelResult[];
	contentText?: string;
	isError: boolean;
	errorText?: string;
	/** PTM-selected request model, kept distinct from actualModel. */
	requestedModel?: string;
	/** Actual provider/model resolved by pi-delegate for single-task requests, when known. */
	actualModel?: string;
	/** Ordered model refs pi-delegate tried for single-task requests, when known. */
	attemptedModels?: string[];
	/** True when single-task execution moved away from requestedModel. */
	modelFallback?: boolean;
	/** PTM-requested context mode. */
	requestedContext?: "fresh" | "fork";
	/** Effective bridge context mode; omitted when a request is rejected before execution. */
	effectiveContext?: PtmEffectiveContext;
	/** Optional compatibility warning; omitted for the current fail-closed compatibility rejection. */
	contextWarning?: string;
}

/** pi-subagents v1 response emitted for a versioned single-task request. */
export interface PtmV1Response {
	version: typeof PTM_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	status: "completed" | "failed";
	error?: string;
	agent?: string;
	model?: string;
	output?: string;
	effects?: {
		fileMutation?: {
			status?: string;
			expected?: boolean;
			attempted?: boolean;
		};
	};
	/** Optional bridge provenance retained for diagnostics; v1 consumers ignore it. */
	requestedModel?: string;
	actualModel?: string;
	attemptedModels?: string[];
	modelFallback?: boolean;
}

export type PtmWireResponse = PtmResponse | PtmV1Response;

// ── Bridge config / dependency injection ─────────────────────────────────
export type PtmBridgeMode = "auto" | "always" | "never";

/** Shape of the runDelegate function the bridge calls. Matches the
 * top-level executeDirectShape signature from src/index.ts. We accept it
 * as an injected dep so tests can mock it without spinning up a real
 * pi runtime. */
export interface RunDelegateFn {
	(args: {
		pi: ExtensionAPI;
		mode: "single-direct" | "parallel-direct";
		tasks: DirectTaskInput[];
		concurrency: number;
		worktree: boolean;
		sync: boolean;
		signal: AbortSignal | undefined;
		ctx: ExtensionContext;
		ctxCwd?: string;
		/** null disables the implicit session-model fallback for explicit PTM model requests. */
		mainModel?: { provider: string; id: string } | null;
		toolCallId: string;
		onUpdate: ((u: any) => void) | undefined;
		config: DelegateConfig;
	}): Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: any;
		isError?: boolean;
	}>;
}

export interface DiscoverAgentsFn {
	(cwd: string, scope: "user" | "project" | "both"): { agents: AgentConfig[]; warnings?: string[] };
}

export interface PtmBridgeDeps {
	runDelegate: RunDelegateFn;
	discoverAgents: DiscoverAgentsFn;
	loadConfig: () => DelegateConfig;
}

export interface InstallPtmBridgeOptions {
	/** auto = listen iff legacy subagent ext absent. always = listen unconditionally.
	 * never = don't subscribe and don't set the env var. Default: "auto". */
	mode?: PtmBridgeMode;
	/** Absolute path to set as PI_SUBAGENT_RUNTIME_ROOT for older PTM runtime
	 * discovery. Required when the bridge will set the compatibility hook. */
	runtimeRoot: string;
	/** Override for the legacy-subagent-ext probe path. Default:
	 * `~/.pi/agent/extensions/subagent`. Tests can point this elsewhere. */
	legacyExtPath?: string;
	/** Override for `process.env`. Defaults to the real process.env. Tests
	 * use this to avoid clobbering the test runner's env. */
	envRef?: NodeJS.ProcessEnv;
}

// ── Public surface ───────────────────────────────────────────────────────

export interface PtmBridgeHandle {
	/** Whether the bridge is actively listening (false when mode resolves
	 * to "never" or auto-detected legacy ext). */
	active: boolean;
	/** Reason the bridge is/isn't active — surfaced for diagnostics. */
	reason: "active" | "disabled" | "legacy-detected";
	dispose(): void;
}

/**
 * Wire the PTM bridge into pi's event bus.
 *
 * Idempotent: calling twice without `dispose()` between them returns the
 * same handle on the second call (the first listeners stay registered).
 *
 * Returns a handle whose `.dispose()` unsubscribes all listeners and aborts
 * any in-flight requests. Returns `{ active: false, ... }` when the bridge
 * decided not to listen (auto-mode + legacy ext present, or mode = never).
 */
export function installPtmBridge(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	deps: PtmBridgeDeps,
	opts: InstallPtmBridgeOptions,
): PtmBridgeHandle {
	const mode: PtmBridgeMode = opts.mode ?? "auto";
	const env = opts.envRef ?? process.env;
	const legacyPath = opts.legacyExtPath ?? join(homedir(), ".pi", "agent", "extensions", "subagent");

	// ── Gating ───────────────────────────────────────────────────────────
	if (mode === "never") {
		return { active: false, reason: "disabled", dispose: () => {} };
	}
	const legacyPresent =
		existsSync(join(legacyPath, "agents.ts")) || existsSync(join(legacyPath, "agents.js"));
	if (mode === "auto" && legacyPresent) {
		return { active: false, reason: "legacy-detected", dispose: () => {} };
	}

	// ── Retain the runtime-root hook for older PTM installations ─────────
	// Only set if unset — respect any user / shell value.
	if (!env.PI_SUBAGENT_RUNTIME_ROOT || env.PI_SUBAGENT_RUNTIME_ROOT.trim() === "") {
		env.PI_SUBAGENT_RUNTIME_ROOT = opts.runtimeRoot;
	}

	// ── In-flight tracking for cancel propagation ────────────────────────
	const inflight = new Map<string, AbortController>();
	const warnedAboutRunContext = { value: false };

	const onRequest = (raw: unknown) => {
		// Fire-and-forget; errors surface via PTM_RESPONSE { isError: true }.
		void handleRequest(pi, ctx, deps, raw, inflight, warnedAboutRunContext);
	};
	const onCancel = (raw: unknown) => {
		const requestId = (raw as { requestId?: unknown } | null | undefined)?.requestId;
		if (typeof requestId !== "string") return;
		const aborter = inflight.get(requestId);
		if (aborter) aborter.abort();
	};

	const offRequest = pi.events.on(PTM_REQUEST, onRequest);
	const offCancel = pi.events.on(PTM_CANCEL, onCancel);

	return {
		active: true,
		reason: "active",
		dispose: () => {
			offRequest();
			offCancel();
			for (const a of inflight.values()) a.abort();
			inflight.clear();
		},
	};
}

// ── Request handling ─────────────────────────────────────────────────────

async function handleRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	deps: PtmBridgeDeps,
	raw: unknown,
	inflight: Map<string, AbortController>,
	warnedAboutRunContext: { value: boolean },
): Promise<void> {
	const parsed = parsePtmRequest(raw);
	if (!parsed.request) {
		emitValidationError(pi, ctx, raw, parsed.error ?? "Malformed PTM delegation request.");
		return;
	}
	const req = parsed.request;
	const contextPlan = buildContextPlan(req.context);
	const requestedModels = requestedModelsFor(req);
	// Compatibility context "fork" is fail-closed, so surface its guidance only
	// through the UI. Keep it out of the wire error response to avoid duplicating
	// the same text in errorText and contextWarning.
	notifyRunContextWarningOnce(
		ctx,
		req.context === "fork" ? FORK_CONTEXT_ERROR : contextPlan.warning,
		warnedAboutRunContext,
	);

	// Reject duplicate requestIds — should never happen but if it does,
	// PTM has its own dedupe and a stale listener would only confuse it.
	if (inflight.has(req.requestId)) return;

	const aborter = new AbortController();
	inflight.set(req.requestId, aborter);

	emitStarted(pi, ctx, req.requestId);

	try {
		if (contextPlan.error) throw new Error(contextPlan.error);
		assertAbsoluteCwds(req);
		const config = deps.loadConfig();
		const discovery = deps.discoverAgents(req.cwd, "both");
		const agents = discovery.agents;
		const discoveryWarnings = discovery.warnings ?? [];

		// Build per-task inputs. For parallel: one entry per `tasks[i]`.
		// For single: one entry from top-level fields.
		const taskList: { agent: string; task: string; cwd?: string; requestedModel: string; skill?: string[] }[] =
			req.tasks && req.tasks.length > 0
				? req.tasks.map((t) => ({
						agent: t.agent,
						task: t.task,
						skill: t.skill,
						// Top-level req.cwd is passed as ctxCwd below. PTM also includes
						// that cwd on every parallel task; omit matching values so
						// worktree:true remains compatible. Preserve only true task-local
						// overrides for non-worktree batches.
						cwd: taskCwdOverride(req.cwd, t.cwd),
						requestedModel: cleanModelRef(t.model) ?? req.model,
					}))
				: [
						{
							agent: req.agent,
							task: req.task,
							skill: req.skill,
							requestedModel: req.model,
						},
					];

		const taskInputs: DirectTaskInput[] = [];
		const unresolved: string[] = [];
		for (let i = 0; i < taskList.length; i++) {
			const t = taskList[i]!;
			const agentDef = agents.find((a) => a.name === t.agent);
			if (!agentDef) {
				unresolved.push(t.agent);
				continue;
			}
			// PTM has already resolved the model for this delegated prompt.
			// Apply it as an invocation-scoped override on a cloned AgentConfig and
			// clear durable agent fallbacks: without an explicit PTM fallback policy,
			// an unresolvable fixed model must fail clearly instead of silently running
			// on the agent/session default.
			const effectiveAgent = applyInvocationOverrides(agentDef, {
				model: t.requestedModel,
				fallbackModels: [],
				...(t.skill !== undefined ? { skill: t.skill } : {}),
			});
			taskInputs.push({
				name: taskList.length > 1 ? `${t.agent}#${i + 1}` : t.agent,
				agent: effectiveAgent,
				task: t.task,
				cwd: t.cwd,
			});
		}

		if (unresolved.length > 0) {
			throw new Error(
				`Unknown agent${unresolved.length > 1 ? "s" : ""}: ${[...new Set(unresolved)].join(", ")}. ` +
					`Available: ${agents
						.map((a) => a.name)
						.sort()
						.join(", ") || "(none)"}.` +
					(discoveryWarnings.length
						? `\nDiscovery warnings:\n${discoveryWarnings.map((warning) => `- ${warning}`).join("\n")}`
						: ""),
			);
		}

		// Phase 1 cap: refuse > 6 parallel. Future phases will chunk.
		if (taskInputs.length > 6) {
			throw new Error(
				`PTM bridge phase 1: parallel cap is 6, got ${taskInputs.length}. ` +
					`Chunking is planned for phase 3.`,
			);
		}

		const mode: "single-direct" | "parallel-direct" =
			taskInputs.length > 1 ? "parallel-direct" : "single-direct";

		const result = await deps.runDelegate({
			pi,
			mode,
			tasks: taskInputs,
			concurrency: Math.min(taskInputs.length, 6),
			worktree: req.worktree ?? false,
			sync: true,
			signal: aborter.signal,
			ctx,
			ctxCwd: req.cwd,
			mainModel: null,
			toolCallId: `ptm-${req.requestId}`,
			onUpdate: undefined,
			config,
		});

		const responseOptions = {
			requestedModels,
			effectiveContext: contextPlan.effectiveContext,
			contextWarning: contextPlan.warning,
		};
		const response = isVersionedSingleRequest(req)
			? translateVersionedResult(req, result, responseOptions)
			: translateResult(req, result, responseOptions);
		pi.events.emit(PTM_RESPONSE, response);
	} catch (err) {
		const errorText = err instanceof Error ? err.message : String(err);
		if (isVersionedSingleRequest(req)) {
			pi.events.emit(PTM_RESPONSE, {
				version: PTM_DELEGATION_PROTOCOL_VERSION,
				requestId: req.requestId,
				status: "failed",
				error: errorText,
				agent: req.agent,
				model: req.model,
				requestedModel: req.model,
				modelFallback: false,
			} satisfies PtmV1Response);
		} else {
			pi.events.emit(PTM_RESPONSE, {
				requestId: req.requestId,
				agent: req.agent,
				task: req.task,
				context: req.context,
				model: req.model,
				cwd: req.cwd,
				messages: [],
				isError: true,
				errorText,
				requestedModel: req.model,
				requestedContext: req.context,
				effectiveContext: contextPlan.effectiveContext,
				contextWarning: undefined,
			} satisfies PtmResponse);
		}
	} finally {
		inflight.delete(req.requestId);
	}
}

// ── Validation ───────────────────────────────────────────────────────────

interface ParsedPtmRequest {
	request?: PtmRequest;
	error?: string;
}

const RETIRED_PROTOCOL_FIELDS = [
	"protocolVersion",
	"fallbackModels",
	"thinking",
	"skills",
	"contextSeed",
	"compatibility",
	"capabilities",
] as const;

const COMMON_REQUEST_FIELDS = [
	"requestId",
	"agent",
	"task",
	"tasks",
	"context",
	"model",
	"skill",
	"cwd",
	"worktree",
] as const;
const VERSIONED_V1_REQUEST_FIELDS = new Set<string>(["version", ...COMMON_REQUEST_FIELDS]);

function hasValue(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
}

function unsupportedProtocolField(
	record: Record<string, unknown>,
	path: string,
	fields: readonly string[] = RETIRED_PROTOCOL_FIELDS,
): string | undefined {
	for (const field of fields) {
		if (hasValue(record, field)) {
			return `${path}.${field} is not supported by PTM delegation; supported shapes are legacy unversioned single/parallel requests and version 1 single requests.`;
		}
	}
	return undefined;
}

function unsupportedVersionedField(
	record: Record<string, unknown>,
	path: string,
	allowedFields: ReadonlySet<string>,
): string | undefined {
	const field = Object.keys(record).find((key) => !allowedFields.has(key));
	return field
		? `${path}.${field} is not recognized by this PTM delegation protocol version; refusing to discard possible behavior.`
		: undefined;
}

function parseSkillList(value: unknown, path: string): { skills?: string[]; error?: string } {
	if (!Array.isArray(value)) {
		return { error: `${path} must be an array of non-empty strings.` };
	}
	const skills: string[] = [];
	for (const [index, skill] of value.entries()) {
		if (typeof skill !== "string" || skill.trim().length === 0) {
			return { error: `${path}[${index}] must be a non-empty string.` };
		}
		skills.push(skill);
	}
	return { skills };
}

function parsePtmRequest(raw: unknown): ParsedPtmRequest {
	if (!raw || typeof raw !== "object") return { error: "PTM delegation request must be an object." };
	const r = raw as Record<string, unknown>;
	if (hasValue(r, "protocolVersion")) {
		return {
			error: `Unsupported PTM delegation protocolVersion ${JSON.stringify(r.protocolVersion)}; supported shapes are legacy unversioned single/parallel requests and version 1 single requests.`,
		};
	}
	const unsupported = unsupportedProtocolField(r, "request");
	if (unsupported) return { error: unsupported };
	if (r.version !== undefined && r.version !== PTM_DELEGATION_PROTOCOL_VERSION) {
		return {
			error: `Unsupported PTM delegation version ${JSON.stringify(r.version)}; supported shapes are legacy unversioned single/parallel requests and version 1 single requests.`,
		};
	}
	if (r.version === PTM_DELEGATION_PROTOCOL_VERSION) {
		const unsupportedField = unsupportedVersionedField(r, "request", VERSIONED_V1_REQUEST_FIELDS);
		if (unsupportedField) return { error: unsupportedField };
		if (hasValue(r, "tasks")) {
			return { error: "PTM delegation protocol v1 is a single-request contract; parallel tasks must remain unversioned." };
		}
	}
	if (hasValue(r, "worktree") && typeof r.worktree !== "boolean") {
		return { error: "request.worktree must be a boolean when provided." };
	}
	if (typeof r.requestId !== "string" || !r.requestId) return { error: "request.requestId must be a non-empty string." };
	if (typeof r.agent !== "string" || !r.agent) return { error: "request.agent must be a non-empty string." };
	if (typeof r.task !== "string") return { error: "request.task must be a string." };
	if (r.context !== "fresh" && r.context !== "fork") return { error: "request.context must be \"fresh\" or \"fork\"." };
	if (typeof r.model !== "string" || !r.model.trim()) return { error: "request.model must be a non-empty string." };
	if (typeof r.cwd !== "string") return { error: "request.cwd must be a string." };

	let skill: string[] | undefined;
	if (hasValue(r, "skill")) {
		const parsed = parseSkillList(r.skill, "request.skill");
		if (parsed.error) return { error: parsed.error };
		skill = parsed.skills;
	}

	let tasks: PtmRequestTask[] | undefined;
	if (hasValue(r, "tasks")) {
		if (!Array.isArray(r.tasks)) return { error: "request.tasks must be an array." };
		tasks = [];
		for (const [index, value] of r.tasks.entries()) {
			const path = `request.tasks[${index}]`;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return { error: `${path} must be an object.` };
			}
			const task = value as Record<string, unknown>;
			const taskUnsupported = unsupportedProtocolField(task, path);
			if (taskUnsupported) return { error: taskUnsupported };
			if (typeof task.agent !== "string" || !task.agent) {
				return { error: `${path}.agent must be a non-empty string.` };
			}
			if (typeof task.task !== "string") return { error: `${path}.task must be a string.` };
			if (task.model !== undefined && cleanModelRef(task.model) === undefined) {
				return { error: `${path}.model must be a non-empty string when provided.` };
			}
			if (task.cwd !== undefined && typeof task.cwd !== "string") {
				return { error: `${path}.cwd must be a string when provided.` };
			}
			let taskSkill: string[] | undefined;
			if (hasValue(task, "skill")) {
				const parsed = parseSkillList(task.skill, `${path}.skill`);
				if (parsed.error) return { error: parsed.error };
				taskSkill = parsed.skills;
			}
			tasks.push({
				agent: task.agent,
				task: task.task,
				model: cleanModelRef(task.model),
				...(taskSkill !== undefined ? { skill: taskSkill } : {}),
				cwd: typeof task.cwd === "string" ? task.cwd : undefined,
			});
		}
	}
	if (skill !== undefined && tasks !== undefined && tasks.length > 0) {
		return { error: "request.skill is only supported for a single request; use tasks[i].skill for parallel tasks." };
	}

	return {
		request: {
			...(r.version === PTM_DELEGATION_PROTOCOL_VERSION ? { version: PTM_DELEGATION_PROTOCOL_VERSION } : {}),
			requestId: r.requestId,
			agent: r.agent,
			task: r.task,
			tasks,
			context: r.context,
			model: r.model.trim(),
			...(skill !== undefined ? { skill } : {}),
			cwd: r.cwd,
			worktree: r.worktree === true ? true : undefined,
		},
	};
}

/** Reject malformed payloads without executing workers. */
export function validatePtmRequest(raw: unknown): PtmRequest | undefined {
	return parsePtmRequest(raw).request;
}

function isVersionedSingleRequest(request: PtmRequest): boolean {
	return request.version === PTM_DELEGATION_PROTOCOL_VERSION && !(request.tasks && request.tasks.length > 0);
}

function emitStarted(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	ownsProgress = canMountStatusWidget(ctx),
): void {
	pi.events.emit(PTM_STARTED, {
		requestId,
		backend: PTM_BACKEND_ID,
		ownsProgress,
	} satisfies PtmStarted);
}

function emitValidationError(pi: ExtensionAPI, ctx: ExtensionContext, raw: unknown, errorText: string): void {
	if (!raw || typeof raw !== "object") return;
	const r = raw as Record<string, unknown>;
	if (typeof r.requestId !== "string" || !r.requestId) return;

	const isVersioned = r.version === PTM_DELEGATION_PROTOCOL_VERSION && !(Array.isArray(r.tasks) && r.tasks.length > 0);
	emitStarted(pi, ctx, r.requestId, false);
	if (isVersioned) {
		pi.events.emit(PTM_RESPONSE, {
			version: PTM_DELEGATION_PROTOCOL_VERSION,
			requestId: r.requestId,
			status: "failed",
			error: errorText,
			agent: typeof r.agent === "string" ? r.agent : undefined,
			model: typeof r.model === "string" ? r.model.trim() : undefined,
		} satisfies PtmV1Response);
		return;
	}
	pi.events.emit(PTM_RESPONSE, {
		requestId: r.requestId,
		agent: typeof r.agent === "string" ? r.agent : "delegate",
		task: typeof r.task === "string" ? r.task : "",
		context: r.context === "fork" ? "fork" : "fresh",
		model: typeof r.model === "string" ? r.model.trim() : "",
		cwd: typeof r.cwd === "string" ? r.cwd : "",
		messages: [],
		isError: true,
		errorText,
	} satisfies PtmResponse);
}

// ── Context compatibility / cwd validation ──────────────────────────────

interface ContextPlan {
	effectiveContext?: PtmEffectiveContext;
	error?: string;
	warning?: string;
}

function cleanModelRef(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function requestedModelsFor(req: PtmRequest): string[] {
	if (req.tasks && req.tasks.length > 0) {
		return req.tasks.map((t) => cleanModelRef(t.model) ?? req.model);
	}
	return [req.model];
}

function assertAbsoluteCwds(req: PtmRequest): void {
	if (!isAbsolute(req.cwd)) {
		throw new Error(`PTM bridge expected an absolute cwd, got ${JSON.stringify(req.cwd)}.`);
	}
	for (const [i, task] of (req.tasks ?? []).entries()) {
		if (task.cwd !== undefined && !isAbsolute(task.cwd)) {
			throw new Error(
				`PTM bridge expected an absolute cwd for tasks[${i}], got ${JSON.stringify(task.cwd)}.`,
			);
		}
	}
}

function taskCwdOverride(baseCwd: string, taskCwd: string | undefined): string | undefined {
	if (!taskCwd || taskCwd === baseCwd) return undefined;
	if (resolve(taskCwd) === resolve(baseCwd)) return undefined;
	return taskCwd;
}

function notifyRunContextWarningOnce(
	ctx: ExtensionContext,
	warning: string | undefined,
	warned: { value: boolean },
): void {
	if (!warning || warned.value) return;
	try {
		if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
			ctx.ui.notify(warning, "warning");
			warned.value = true;
		}
	} catch {
		/* best-effort compatibility warning */
	}
}

function buildContextPlan(requested: "fresh" | "fork"): ContextPlan {
	if (requested === "fresh") return { effectiveContext: "fresh" };

	return { error: FORK_CONTEXT_ERROR };
}

// ── Result translation ──────────────────────────────────────────────────

/** Build a PTM-shaped response from a delegate sync result. Public for
 * tests. */
export function translateResult(
	req: PtmRequest,
	result: { content: Array<{ type: "text"; text: string }>; details: any; isError?: boolean },
	options: {
		requestedModels?: string[];
		effectiveContext?: PtmEffectiveContext;
		contextWarning?: string;
	} = {},
): PtmResponse {
	const results: RunResult[] = Array.isArray(result.details?.forks) ? result.details.forks : [];
	const isParallel = (req.tasks?.length ?? 0) > 0;
	const requestedModels = options.requestedModels ?? requestedModelsFor(req);
	const effectiveContext = options.effectiveContext ?? (req.context === "fresh" ? "fresh" : undefined);
	const contextWarning = options.contextWarning;

	const contentText = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	const messages = isParallel ? [] : synthesizeMessages(req.task, results[0]);
	const parallelResults: PtmParallelResult[] | undefined = isParallel
		? results.map((f, i) => ({
				agent: req.tasks?.[i]?.agent ?? f.agent,
				messages: synthesizeMessages(req.tasks?.[i]?.task ?? f.task, f),
				isError: f.status !== "completed",
				errorText: f.error ?? undefined,
				requestedModel: requestedModels[i],
				actualModel: f.workerModel,
				attemptedModels: f.attemptedModels,
				modelFallback: modelFallbackOccurred(requestedModels[i], f),
			}))
		: undefined;
	const firstResult = results[0];
	const requestedModel = req.model;

	return {
		requestId: req.requestId,
		agent: req.agent,
		task: req.task,
		context: req.context,
		model: req.model,
		cwd: req.cwd,
		messages,
		parallelResults,
		contentText,
		isError: Boolean(result.isError),
		errorText: result.isError ? (collectErrorText(results) ?? (contentText || undefined)) : undefined,
		requestedModel,
		actualModel: isParallel ? undefined : firstResult?.workerModel,
		attemptedModels: isParallel ? undefined : firstResult?.attemptedModels,
		modelFallback: isParallel ? undefined : modelFallbackOccurred(requestedModel, firstResult),
		requestedContext: req.context,
		effectiveContext,
		contextWarning,
	};
}

/** Build the upstream pi-subagents v1 response for a versioned single request. */
export function translateVersionedResult(
	req: PtmRequest,
	result: { content: Array<{ type: "text"; text: string }>; details: any; isError?: boolean },
	options: {
		requestedModels?: string[];
		effectiveContext?: PtmEffectiveContext;
		contextWarning?: string;
	} = {},
): PtmV1Response {
	const legacy = translateResult(req, result, options);
	const firstResult = Array.isArray(result.details?.forks) ? (result.details.forks[0] as RunResult | undefined) : undefined;
	const changed = firstResult ? runResultChanged(firstResult) : false;
	return {
		version: PTM_DELEGATION_PROTOCOL_VERSION,
		requestId: req.requestId,
		status: legacy.isError ? "failed" : "completed",
		...(legacy.errorText ? { error: legacy.errorText } : {}),
		agent: req.agent,
		// Keep the v1 model field tied to PTM's requested model. The optional
		// provenance fields preserve the bridge's actual-resolution details.
		model: req.model,
		// `executeDirectShape`'s combined content includes bridge metadata such
		// as the worker session path. v1 `output` is the worker answer itself.
		output: firstResult?.collapsedContent?.trim() || legacy.contentText || "",
		...(changed
			? { effects: { fileMutation: { status: "observed", attempted: true } } }
			: {}),
		requestedModel: legacy.requestedModel,
		actualModel: legacy.actualModel,
		attemptedModels: legacy.attemptedModels,
		modelFallback: legacy.modelFallback,
	};
}

function runResultChanged(result: RunResult): boolean {
	return workerMutationTools(result).length > 0;
}

function workerMutationTools(result: RunResult): string[] {
	return result.transcript.flatMap((entry) => {
		if (entry.source !== "worker" || entry.role !== "toolCall") return [];
		const match = /^(\w+)\(/.exec(entry.text);
		return match?.[1] === "write" || match?.[1] === "edit" ? [match[1]] : [];
	});
}

function modelFallbackOccurred(requestedModel: string | undefined, result: RunResult | undefined): boolean {
	if (!requestedModel || !result?.workerModel) return false;
	const attempts = result.attemptedModels ?? [];
	// A single attempted PTM model that resolves to a canonical provider/model
	// is not a fallback, even when PTM supplied an alias/bare id and the worker
	// reports the canonical ref. Multiple attempted refs are the observable
	// fallback signal recorded by the direct/supervised runners.
	return attempts.length > 1 || (attempts.length === 0 && result.workerModel !== requestedModel);
}

function collectErrorText(results: RunResult[]): string | undefined {
	const errs = results
		.filter((f) => f.status !== "completed")
		.map((f) => `${f.name}: ${f.error ?? f.status}`)
		.join("; ");
	return errs || undefined;
}

/**
 * Synthesize a 2-message [user, assistant] array from a RunResult.
 *
 * Phase 1: lossy reconstruction. We extract write/edit tool calls from
 * the worker's transcript so PTM's `delegatedMessagesChanged()` (loop
 * convergence check) still works. Argument fidelity is not preserved —
 * the transcript renders args as `JSON.stringify(arguments)`, which we
 * don't try to reverse. Only the tool *name* is needed for convergence.
 *
 * Public for tests.
 */
export function synthesizeMessages(task: string, result: RunResult | undefined): unknown[] {
	if (!result) {
		return [{ role: "user", content: [{ type: "text", text: task }], timestamp: Date.now() }];
	}
	const userMsg = {
		role: "user",
		content: [{ type: "text", text: task }],
		timestamp: Date.now(),
	};
	const assistantBlocks: any[] = [];
	if (result.collapsedContent) {
		assistantBlocks.push({ type: "text", text: result.collapsedContent });
	}
	for (const name of workerMutationTools(result)) {
		// Only reconstruct tools PTM cares about for convergence detection.
		// Other tool calls aren't needed and would bloat the synthesized
		// message without changing PTM's behaviour.
		assistantBlocks.push({ type: "toolCall", name, arguments: {} });
	}
	if (assistantBlocks.length === 0) {
		// Always include at least one assistant block so extractDelegatedText
		// finds *something* (it walks looking for assistant text).
		assistantBlocks.push({ type: "text", text: result.error ?? "" });
	}
	return [
		userMsg,
		{ role: "assistant", content: assistantBlocks, timestamp: Date.now() },
	];
}
