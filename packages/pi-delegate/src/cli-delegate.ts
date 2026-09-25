/**
 * CLI-callable entrypoint for pi-delegate.
 *
 * `delegateFromCli` lets a free-standing Node process — graft's
 * `graft tick` CLI verb is the canonical case; scripted pipelines and CI
 * smoke tests are similar — dispatch one or more direct-mode workers
 * WITHOUT a live pi session. It wraps the existing `pumpDirectWorkers` runner
 * with the minimal runtime state that pump
 * needs (model runtime/registry services, a base cwd, an optional
 * model override) and translates the resulting `RunResult[]` into a
 * CLI-friendly shape with the pi-runtime abstractions stripped out.
 *
 * Out of scope (keep the door open for follow-ups):
 *   - Supervised mode (`agents: [...]` with multi-turn supervisor ↔
 *     worker dialogue). The CLI surface is direct-only; if a consumer
 *     wants supervised round-tripping, add a separate
 *     `delegateFromCliSupervised()` later.
 *   - Chain mode (`chain: [...]`). Chains are pi-runtime-coupled today
 *     because their per-step `artifact:` resolution and slash-command
 *     overlay tie into a live extension API. Out of scope for now.
 *   - Dispatch mode (return immediately, notify later via
 *     `pi.sendMessage`). Dispatch is meaningless without a parent pi
 *     session to receive the wake-up; CLI consumers wrap
 *     `delegateFromCli` in their own detached promise instead.
 *
 * The sync-mode-only constraint keeps this entrypoint free of a live
 * `ExtensionAPI`: `pumpDirectWorkers` and `runDirectWorker` receive the
 * concrete runtime state they need directly, and dispatch/wake-up surfaces
 * remain intentionally out of scope for CLI callers.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import type { EnvOverrides } from "./env-overrides.js";
import { configuredPackageRoots } from "./configured-package-roots.js";
import { applyAgentOverrides } from "./agent-overrides.js";
import {
	loadConfig,
	loadConfigReadOnly,
	stripRemovedPlaneConfigKeys,
	type DelegateConfig,
} from "./config.js";
import { resolveIntercomBridgeWithPolicy } from "./intercom-bridge.js";
import { pumpDirectWorkers, type DirectTaskInput, expandParallelTasks } from "./direct-shape.js";
import type { RunResult } from "./fork-runner.js";
import { projectRunResult, type RunResultDetailExtensions } from "./run-result-boundary.js";
import type { WorkerArtifactReference } from "./artifact-workspace.js";
import { abortWorkerCompaction } from "./worker-compaction-seam.js";
import { aggregateRunResults, saturatingAdd, type DelegateUsageTotals } from "./usage-rollup.js";
import { prepareChainDir, sweepOldChainDirs } from "./output-file.js";
import { deriveRunId } from "./run-id.js";
import type { ModelRuntimeLike } from "./sdk-model-runtime.js";
import {
	completeRun,
	type CancelReason,
	type RunLiveState,
	type DelegateDispatchState,
	registerRun,
	updateRunState,
	appendTranscriptEntry,
} from "./runtime.js";
import {
	cleanupWorktrees,
	createWorktrees,
	type WorktreeDiff,
	type WorktreeSetup,
} from "./worktree.js";

// Re-export so CLI consumers don't have to reach into `agents.js`.
export type { AgentConfig };

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export interface CliDelegateTaskInput {
	/** Unique label for this task within the batch. Defaults to agent name. */
	name?: string;
	/**
	 * Agent to delegate to. Either:
	 *   - a string (agent name; resolved via pi-delegate's standard
	 *     agent-discovery rules: builtin → user → project, scope filtered
	 *     by `agentScope`).
	 *   - a fully-resolved `AgentConfig` object (advanced; bypasses
	 *     discovery — useful when the consumer wants to construct an
	 *     agent in-memory rather than serialise a markdown file).
	 */
	agent: string | AgentConfig;
	/** Initial user task / prompt body. */
	task: string;
	/** Working directory for the worker (default: opts.cwd). */
	cwd?: string;
	/** Name one file the worker writes as the authoritative artifact; the runtime resolves it in the per-worktree artifact workspace and injects the absolute path. Pass `false` to suppress an agent-level default. */
	artifact?: string | false;
	/**
	 * Files or exact returned artifact references to read into the worker's first
	 * message as `<context-file>` blocks. Strings stay relative to the worker's
	 * cwd unless they are exact retained payload paths. `false` disables an
	 * agent-level default.
	 */
	reads?: Array<string | WorkerArtifactReference> | false;
	/** Append a `[done] <name>` line to <chainDir>/progress.md on completion. */
	progress?: boolean;
	/**
	 * Route worker UI prompts to the user. CLI-mode default: false
	 * (workers run with no UI; auto-deny on prompts). Set true only if
	 * the CLI is itself attended (e.g. graft init driven by a human at
	 * a terminal). NOTE: even with `interactive: true`, the CLI stub
	 * has no UI plumbing wired to a TUI — this currently behaves as a
	 * no-op for direct-mode workers. Reserved for future expansion.
	 */
	interactive?: boolean;
	/** Environment patch for this worker; null removes an inherited variable. */
	env?: EnvOverrides;
	/** Removed decision-plane settings are accepted only so they can be ignored with a warning. */
	[removedKey: `decision${string}`]: unknown;
}

export interface CliDelegateOptions {
	/**
	 * One or more direct-mode tasks to run in parallel. Pass a single
	 * element for the typical graft "one worker per dispatch" use.
	 */
	tasks: CliDelegateTaskInput[];
	/** Max concurrent workers. Default: tasks.length (run all in parallel). */
	concurrency?: number;
	/**
	 * When true, each worker runs in its own ephemeral git worktree.
	 * Requires a clean git tree at `cwd`. Incompatible with per-task
	 * `cwd:`. Default: false.
	 */
	worktree?: boolean;
	/**
	 * Working directory for the batch. Workers inherit this unless
	 * they override via `tasks[].cwd`. Default: `process.cwd()`.
	 */
	cwd?: string;
	/**
	 * Cancellation signal. Aborting cancels all in-flight workers
	 * (cancelReason="user"); the function rejects with an `AbortError`
	 * shortly after.
	 */
	signal?: AbortSignal;
	/**
	 * Override the pi config / agent dir. Default: pi-delegate's
	 * `getAgentDir()` (which respects PI_AGENT_DIR / standard locations).
	 * Pass an explicit path for tests or sandboxed runs.
	 */
	agentDir?: string;
	/**
	 * Agent-discovery scope. Default: "both" (builtin + user + project).
	 * Direct callers can narrow to "user" (skip project-local agents) or
	 * "project" (skip user/builtin) for tighter sandboxing.
	 */
	agentScope?: AgentScope;
	/**
	 * Issue #12 — explicit opt-in to run PROJECT-LOCAL agents (discovered
	 * from `<repo>/.pi/agents/` / `<repo>/.agents/`) from this CLI call.
	 * A headless caller has no Pi trust context, so without this explicit
	 * capability project agents are rejected before any session is created.
	 * Builtin/user/package agents and caller-constructed `AgentConfig`
	 * objects are never gated. Default: false.
	 */
	trustProject?: boolean;
	/**
	 * Compatibility auth storage. New callers should pass `modelRuntime`.
	 * Retained so packaged consumers can upgrade pi-delegate independently.
	 */
	authStorage?: object;
	/**
	 * Canonical Pi 0.80+ model/auth runtime. When omitted, CLI mode creates one
	 * from `<agentDir>/auth.json` and `<agentDir>/models.json`.
	 */
	modelRuntime?: ModelRuntimeLike;
	/**
	 * Model registry compatibility facade. By default it is created from the
	 * resolved model runtime (or from the compatibility auth storage).
	 * Pass an explicit registry for tests that register a scripted
	 * mock provider.
	 */
	modelRegistry?: ModelRegistry;
	/**
	 * Model selection for workers that don't override per-agent. Identical
	 * semantics to the in-pi `delegate` tool: when undefined, each agent
	 * resolves its own model (agent.model → agent.fallbackModels →
	 * mainModel → registry first-available). When set, the dispatch uses
	 * this model unless the agent pins a different one for the dispatch.
	 *
	 * The CLI consumer is responsible for ensuring the chosen model has
	 * resolvable auth (env var, persisted credential, etc.).
	 */
	mainModel?: { provider: string; id: string };
	/**
	 * Optional progress callback. Fires every time the batch's worker
	 * states change. Useful for CLIs that want to print a live status
	 * line.
	 */
	onUpdate?: (snapshot: CliDelegateSnapshot) => void;
	/**
	 * Whether to attempt graft trailer extraction (`Graft-Spec:` /
	 * `Graft-Commit:` block) on each worker's output. Default: true.
	 * Disable by passing `extractCommit: false` if the consumer wants
	 * to do its own grep, or if commit extraction interferes with
	 * non-graft callers.
	 */
	extractCommit?: boolean;
}

export interface CliDelegateRunSnapshot {
	name: string;
	agent: string;
	// Spec 0019 / REQ-PAUSE-4 — `paused` is a legitimate terminal status
	// (supervisor forced to finish at max_rounds). Without it here, a paused
	// worker in a snapshot was coerced to `pending` (looks still-running).
	status: "pending" | "running" | "completed" | "failed" | "aborted" | "paused";
	/** Worker session file path. Set once the AgentSession exists. */
	workerSessionFile?: string;
	/** True when an unsuccessful terminal run still yielded recoverable worker output. */
	recoveredOutput?: boolean;
	/** Token / cost counters (best-effort; absent when not yet emitted). */
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost?: number;
	};
}

/** @deprecated Use {@link CliDelegateRunSnapshot}; retained for CLI compatibility. */
export type CliDelegateForkSnapshot = CliDelegateRunSnapshot;

export interface CliDelegateSnapshot {
	runId: string;
	forks: CliDelegateRunSnapshot[];
}

export interface CliDelegateRunResult {
	name: string;
	agent: string;
	// Spec 0019 / REQ-PAUSE-4 — `paused` (supervisor forced to finish at
	// max_rounds) is a legitimate terminal state, distinct from `failed`.
	/** "completed" / "failed" / "aborted" / "paused" — terminal state of the worker. */
	status: "completed" | "failed" | "aborted" | "paused";
	/**
	 * The collapsed output (worker's final assistant text). Identical to
	 * `RunResult.collapsedContent`. May be empty when status !==
	 * "completed".
	 */
	output: string;
	/** Worker session file path (for log inspection / replay). */
	workerSessionFile?: string;
	/** True when an unsuccessful terminal run still yielded recoverable worker output. */
	recoveredOutput?: boolean;
	/** Harvest classification from the direct worker's final messages. */
	harvest?: RunResultDetailExtensions["harvest"];
	/** Optional metadata for the worker-written artifact. */
	outputFile?: RunResultDetailExtensions["outputFile"];
	/** Exact validated retained artifact identity. */
	artifactRef?: RunResultDetailExtensions["artifactRef"];
	/** Structured storage lifecycle failure, when artifact delivery failed. */
	artifactError?: RunResultDetailExtensions["artifactError"];
	/** Warnings from optional direct artifact/progress side effects. */
	warnings?: RunResultDetailExtensions["warnings"];
	/** Set when status !== "completed". */
	error?: string;
	policyRefusals?: RunResult["policyRefusals"];
	mutationReport?: RunResult["mutationReport"];
	promptRepairs?: RunResult["promptRepairs"];
	/**
	 * Worker's final commit SHA, IFF the worker emitted one in its
	 * structured handoff using the graft trailer convention
	 * (`Graft-Spec: ...` / `Graft-Commit: <sha>`). Null when not
	 * present, when extraction is disabled, or when extraction fails.
	 */
	commit: string | null;
	/** Token / cost totals if available. */
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost?: number;
	};
}

/**
 * @deprecated Use {@link CliDelegateRunResult}; retained for CLI compatibility.
 * The legacy output-file shape intentionally remains path-only. Runtime values
 * are still projected by name, so canonical results retain `bytes` without
 * widening this deprecated input contract.
 */
export type CliDelegateForkResult = Omit<CliDelegateRunResult, "outputFile"> & {
	outputFile?: { absolutePath: string };
};

export interface CliDelegateResult {
	/** Per-worker final results, in the same order as `opts.tasks`. */
	forks: CliDelegateRunResult[];
	/** True iff at least one worker's status !== "completed". */
	anyFailed: boolean;
	/**
	 * Human-readable combined summary. Same shape returned by the in-pi
	 * `delegate` tool's `content[0].text`: single-task batches collapse
	 * to one section, multi-task batches use level-2 markdown headings.
	 */
	combinedContent: string;
	/** Worktree diffs IFF `worktree: true` was passed. Successful entries include
	 * patch/stat data. A failed capture includes `captureFailed: true` and the
	 * preserved `worktreePath`; callers must not assume the worktree or branch was
	 * reaped and must recover it manually before removal. */
	worktreeDiffs?: Array<{
		forkName: string;
		branch: string;
		diff: string;
		patchPath: string;
		diffStat: string;
		filesChanged: number;
		insertions: number;
		deletions: number;
		captureFailed?: true;
		worktreePath?: string;
	}>;
	/** Aggregate token/cost totals across all worker subagent sessions (present for results produced by this version). */
	usage?: DelegateUsageTotals;
	/** Run-id assigned to this batch (useful for log correlation). */
	runId: string;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort extraction of a graft commit SHA from the worker's
 * collapsed output. The convention is documented in graft's
 * `.spec/decisions.yaml` D-015: workers tail their final response
 * with a trailer block of the shape
 *
 *   Graft-Spec: <spec-id>
 *   Graft-Task: <task-name>
 *   Graft-Commit: <sha>
 *
 * The trailer typically appears at the end of the response, optionally
 * inside a fenced code block. We walk the output line by line looking
 * for the first match — the regex tolerates leading whitespace and
 * trailing junk (e.g. a closing ```) so the parser is robust against
 * minor formatting drift.
 *
 * Returns null when no trailer is present or when extraction is
 * disabled at the call site.
 */
export function extractGraftCommit(output: string): string | null {
	if (!output) return null;
	// Match `Graft-Commit:` (case-insensitive) followed by a 7-40 char
	// hex SHA. Tolerate leading whitespace, optional `>` quoting, and
	// trailing whitespace / fence characters.
	const re = /^[\s>`]*Graft-Commit:\s*([0-9a-fA-F]{7,40})\s*$/m;
	const match = output.match(re);
	if (!match) return null;
	return match[1].toLowerCase();
}

/**
 * Resolve a per-task `agent` field to a concrete `AgentConfig`. Strings
 * are looked up via `discoverAgents` (filtered by `scope`). Objects
 * are returned as-is.
 *
 * Mirrors the discovery + override pipeline that the in-pi `delegate`
 * tool uses, so a CLI consumer's "scout" agent picks up the same
 * builtin/user/project hierarchy.
 */
function resolveTaskAgents(
	tasks: CliDelegateTaskInput[],
	cwd: string,
	scope: AgentScope,
	config: DelegateConfig,
	trustProject: boolean,
	agentDir: string,
): AgentConfig[] {
	const stringRequests = tasks.filter((t) => typeof t.agent === "string") as Array<
		CliDelegateTaskInput & { agent: string }
	>;
	let lookup = new Map<string, AgentConfig>();
	let discoveryWarnings: string[] = [];
	let projectRoot: string | null = null;
	let projectTrusted = false;
	if (stringRequests.length > 0) {
		const discovery = discoverAgents(cwd, scope, {
			additionalResolvedPackageRoots: configuredPackageRoots({
				cwd,
				agentDir,
				projectTrusted: trustProject,
			}),
		});
		discoveryWarnings = discovery.warnings;
		projectRoot = discovery.projectRoot;
		projectTrusted = trustProject;
		const overridden = applyAgentOverrides(discovery.agents, config);
		lookup = new Map(overridden.agents.map((a) => [a.name, a]));
	}
	const resolved: AgentConfig[] = [];
	const unknown: string[] = [];
	for (const t of tasks) {
		if (typeof t.agent === "string") {
			const found = lookup.get(t.agent);
			if (!found) {
				unknown.push(t.agent);
				continue;
			}
			resolved.push(found);
		} else {
			resolved.push(t.agent);
		}
	}
	if (unknown.length > 0) {
		const available = [...lookup.keys()].join(", ") || "none";
		throw new Error(
			`[pi-delegate CLI mode] Unknown agent(s): ${[...new Set(unknown)].join(", ")}. ` +
				`Available: ${available}` +
				(discoveryWarnings.length
					? `\nDiscovery warnings:\n${discoveryWarnings.map((warning) => `- ${warning}`).join("\n")}`
					: ""),
		);
	}
	// Issue #12 — CLI trust gate. The in-pi tool prompts before executing a
	// PROJECT-LOCAL agent (a repo can ship arbitrary system prompts in
	// `.pi/agents/`); the CLI has no prompt, so previously cloning an
	// untrusted repo and running the CLI in it executed whatever the repo
	// shipped. Refuse unless the caller explicitly opts in. Only
	// DISCOVERED project agents are gated: an object-form AgentConfig was
	// constructed by the calling program itself, not read from the repo.
	const gatedProjectAgents = resolved.filter(
		(a, i) => typeof tasks[i]?.agent === "string" && a.source === "project",
	);
	if (gatedProjectAgents.length > 0 && !projectTrusted) {
		const names = [...new Set(gatedProjectAgents.map((a) => a.name))].join(", ");
		throw new Error(
			`[pi-delegate CLI mode] Refusing to run project-local agent(s) ${names} from untrusted ` +
				`project ${projectRoot ?? cwd}. A repo can ship arbitrary agent definitions in ` +
				`.pi/agents/; the CLI has no Pi trust context. Pass { trustProject: true } to ` +
				`delegateFromCli, or use agentScope: "user" to skip project-local agents entirely.`,
		);
	}
	return resolved;
}

/**
 * Map `pumpDirectWorkers`' `RunResult[]` plus direct-only fields such as
 * `harvest`, `warnings`, and `outputFile` onto the CLI-friendly
 * `CliDelegateRunResult[]` shape.
 *
 * Exported so the spec-0019 paused-passthrough regression test can invoke the
 * REAL mapping (not a duplicated literal) and assert a paused worker maps to
 * `status: "paused"`, never coerced to `"failed"`.
 */
export function mapRunResults(
	results: RunResult[],
	tasks: DirectTaskInput[],
	extractCommit: boolean,
): CliDelegateRunResult[] {
	return results.map((input, i) => {
		const r = projectRunResult(input);
		const task = tasks[i];
		const status: CliDelegateRunResult["status"] =
			// Spec 0019 / REQ-PAUSE-4 — `paused` (supervisor forced to finish at
			// max_rounds) is a LEGITIMATE terminal state; pass it through as
			// itself rather than coercing it to `failed`.
			r.status === "completed" ||
			r.status === "failed" ||
			r.status === "aborted" ||
			r.status === "paused"
				? r.status
				: // Anything else (running / pending) shouldn't happen at this
				  // point because pumpDirectWorkers only resolves once every
				  // worker hits a terminal state — coerce defensively.
				  "failed";
		const out: CliDelegateRunResult = {
			name: r.name,
			agent: r.agent || task?.agent.name || "unknown",
			status,
			output: r.collapsedContent ?? "",
			workerSessionFile: r.workerSessionFile,
			recoveredOutput: r.recoveredOutput,
			warnings: r.warnings,
			error: r.error,
			policyRefusals: r.policyRefusals,
			mutationReport: r.mutationReport,
			promptRepairs: r.promptRepairs,
			commit: extractCommit ? extractGraftCommit(r.collapsedContent ?? "") : null,
		};
		if (r.harvest !== undefined) out.harvest = r.harvest;
		if (r.outputFile !== undefined) {
			out.outputFile = { absolutePath: r.outputFile.absolutePath, bytes: r.outputFile.bytes };
		}
		if (r.artifactRef !== undefined) out.artifactRef = r.artifactRef;
		if (r.artifactError !== undefined) out.artifactError = r.artifactError;
		if (r.warnings !== undefined) out.warnings = r.warnings.map((warning) => ({ kind: warning.kind, message: warning.message }));
		const promptTokens = r.usage?.workerInput ?? 0;
		const completionTokens = r.usage?.workerOutput ?? 0;
		if (promptTokens || completionTokens || r.usage?.cost) {
			out.usage = {
				promptTokens,
				completionTokens,
				totalTokens: saturatingAdd(promptTokens, completionTokens),
				cost: r.usage?.cost,
			};
		}
		return out;
	});
}

/** @deprecated Use {@link mapRunResults}; retained for CLI compatibility. */
export const mapForkResults = mapRunResults;

/** Build a snapshot for `onUpdate`. */
function buildSnapshot(
	runId: string,
	tasks: DirectTaskInput[],
	partial: RunResult[],
): CliDelegateSnapshot {
	const runs: CliDelegateRunSnapshot[] = partial.map((r, i) => {
		const task = tasks[i];
		const status: CliDelegateRunSnapshot["status"] =
			// Spec 0019 / REQ-PAUSE-4 — a paused worker in a snapshot must read as
			// `paused`, not be coerced to `pending` (which would make a terminal
			// forced-finish worker look still-running to the CLI operator).
			r.status === "pending" ||
			r.status === "running" ||
			r.status === "completed" ||
			r.status === "failed" ||
			r.status === "aborted" ||
			r.status === "paused"
				? r.status
				: "pending";
		const snap: CliDelegateRunSnapshot = {
			name: r.name,
			agent: r.agent || task?.agent.name || "unknown",
			status,
			workerSessionFile: r.workerSessionFile,
			recoveredOutput: r.recoveredOutput,
		};
		const promptTokens = r.usage?.workerInput ?? 0;
		const completionTokens = r.usage?.workerOutput ?? 0;
		if (promptTokens || completionTokens || r.usage?.cost) {
			snap.usage = {
				promptTokens,
				completionTokens,
				totalTokens: saturatingAdd(promptTokens, completionTokens),
				cost: r.usage?.cost,
			};
		}
		return snap;
	});
	return { runId, forks: runs };
}

// ──────────────────────────────────────────────────────────────────────
// Model/auth compatibility
// ──────────────────────────────────────────────────────────────────────

type PiModelRegistryConstructorCompat = {
	new (modelRuntime: ModelRuntimeLike): ModelRegistry;
	create?(authStorage: object, modelsPath?: string): ModelRegistry;
};

type PiModelSdkCompat = {
	ModelRuntime?: {
		create(options?: Record<string, unknown>): Promise<ModelRuntimeLike>;
	};
	AuthStorage?: {
		create(authPath?: string): object;
	};
	ModelRegistry: PiModelRegistryConstructorCompat;
};

type CliModelServiceOptions = Pick<
	CliDelegateOptions,
	"authStorage" | "modelRuntime" | "modelRegistry"
>;

/** @internal Exported for deterministic SDK-generation compatibility tests. */
export async function resolveCliModelServicesForSdk(
	opts: CliModelServiceOptions,
	agentDir: string,
	sdk: PiModelSdkCompat,
): Promise<{
	authStorage?: object;
	modelRuntime?: ModelRuntimeLike;
	modelRegistry: ModelRegistry;
}> {
	if (sdk.ModelRuntime) {
		if (opts.authStorage) {
			throw new Error(
				"[pi-delegate CLI mode] authStorage is a legacy Pi 0.79 option; " +
					"pass modelRuntime when using Pi 0.80+",
			);
		}
		const registry = opts.modelRegistry as unknown as {
			runtime?: ModelRuntimeLike;
			find?: unknown;
			getAll?: unknown;
		} | undefined;
		const registryRuntime = registry && typeof registry.find === "function" && typeof registry.getAll === "function"
			? registry.runtime
			: undefined;
		if (opts.modelRegistry && !opts.modelRuntime && !registryRuntime) {
			throw new Error(
				"[pi-delegate CLI mode] a Pi 0.80 modelRegistry must be accompanied by its modelRuntime",
			);
		}
		const modelRuntime = opts.modelRuntime ?? registryRuntime ?? await sdk.ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
		});
		return {
			modelRuntime,
			modelRegistry: opts.modelRegistry ?? new sdk.ModelRegistry(modelRuntime),
		};
	}

	if (opts.modelRuntime) {
		throw new Error("[pi-delegate CLI mode] modelRuntime requires Pi 0.80+");
	}
	const registryAuthStorage = (
		opts.modelRegistry as unknown as { authStorage?: object } | undefined
	)?.authStorage;
	const authStorage = opts.authStorage ?? registryAuthStorage ?? sdk.AuthStorage?.create(
		path.join(agentDir, "auth.json"),
	);
	if (!authStorage) {
		throw new Error("[pi-delegate CLI mode] active Pi SDK exposes neither ModelRuntime nor legacy AuthStorage");
	}
	if (opts.modelRegistry) {
		return { authStorage, modelRegistry: opts.modelRegistry };
	}
	if (!sdk.ModelRegistry.create) {
		throw new Error("[pi-delegate CLI mode] active Pi SDK cannot create a model registry");
	}
	return {
		authStorage,
		modelRegistry: sdk.ModelRegistry.create(authStorage, path.join(agentDir, "models.json")),
	};
}

async function resolveCliModelServices(
	opts: CliModelServiceOptions,
	agentDir: string,
): ReturnType<typeof resolveCliModelServicesForSdk> {
	const sdk = await import("@earendil-works/pi-coding-agent") as unknown as PiModelSdkCompat;
	return resolveCliModelServicesForSdk(opts, agentDir, sdk);
}

// ──────────────────────────────────────────────────────────────────────
// Public entrypoint
// ──────────────────────────────────────────────────────────────────────

/**
 * Map pump worktree diffs to the CLI result shape. `worktreePath` crosses only
 * with `captureFailed`, matching the projection and failure-wake boundaries.
 */
export function mapCliWorktreeDiffs(diffs: WorktreeDiff[], tasks: DirectTaskInput[]): CliDelegateResult["worktreeDiffs"] {
	return diffs.map((d) => {
		let diffText = "";
		try {
			diffText = readFileSync(d.patchPath, "utf-8");
		} catch {
			/* best effort */
		}
		return {
			forkName: tasks[d.index]?.name ?? d.agent,
			branch: d.branch,
			diff: diffText,
			patchPath: d.patchPath,
			diffStat: d.diffStat,
			filesChanged: d.filesChanged,
			insertions: d.insertions,
			deletions: d.deletions,
			...(d.captureFailed === true ? { captureFailed: true as const } : {}),
			...(d.captureFailed === true && typeof d.worktreePath === "string" ? { worktreePath: d.worktreePath } : {}),
		};
	});
}

/**
 * CLI-callable entrypoint for pi-delegate. Synthesizes the minimal
 * runtime state that `pumpDirectWorkers` needs and runs in sync mode.
 *
 * Designed for Node processes that DO NOT have a live pi session — e.g.
 * graft's `graft tick` CLI verb, scripted pipelines, CI smoke tests.
 *
 * Security note (issue #12): project-local agents are gated under CLI mode.
 * The CLI has no Pi trust context, so it refuses discovered project agents
 * unless `trustProject: true` is passed explicitly. Pass `agentScope: "user"`
 * to skip project-local discovery entirely.
 */
export async function delegateFromCli(opts: CliDelegateOptions): Promise<CliDelegateResult> {
	if (!opts || !Array.isArray(opts.tasks) || opts.tasks.length === 0) {
		throw new Error("[pi-delegate CLI mode] delegateFromCli: opts.tasks must be a non-empty array");
	}
	if (opts.signal?.aborted) {
		throw makeAbortError("aborted before dispatch");
	}

	const cwd = opts.cwd ?? process.cwd();
	const agentDir = opts.agentDir ?? getAgentDir();
	const agentScope: AgentScope = opts.agentScope ?? "both";
	const extractCommit = opts.extractCommit !== false;

	// ── Resolve agents (string → AgentConfig) + project-trust gate (#12) ─
	let config = loadConfigReadOnly(agentDir);
	const resolvedAgents = resolveTaskAgents(
		opts.tasks,
		cwd,
		agentScope,
		config,
		opts.trustProject === true,
		agentDir,
	);

	const expandedRaw = opts.tasks.map((rawTask, i) => {
		for (const field of ["output", "outputFrom"] as const) {
			if (Object.prototype.hasOwnProperty.call(rawTask, field)) {
				throw new Error(`[pi-delegate CLI mode] tasks[${i}].${field} is removed; use artifact instead`);
			}
		}
		const task = stripRemovedPlaneConfigKeys(
			rawTask as unknown as Record<string, unknown>,
			`tasks[${i}].`,
		) as unknown as CliDelegateTaskInput;
		return {
			name: task.name,
			agent: resolvedAgents[i],
			task: task.task,
			cwd: task.cwd,
			artifact: task.artifact,
			reads: task.reads,
			progress: task.progress,
			interactive: task.interactive,
			env: task.env,
		};
	});
	const tasks: DirectTaskInput[] = expandParallelTasks({ rawTasks: expandedRaw });
	// Only accepted calls may migrate legacy config or emit config diagnostics.
	config = loadConfig(agentDir);

	// ── Validate worktree + per-task cwd combo (mirrors executeDirectShape) ─
	if (opts.worktree) {
		const conflict = opts.tasks.find((t) => t.cwd !== undefined);
		if (conflict) {
			throw new Error(
				`[pi-delegate CLI mode] worktree: true is incompatible with per-task cwd. ` +
					`Task "${conflict.name ?? (typeof conflict.agent === "string" ? conflict.agent : conflict.agent.name)}" sets cwd=${JSON.stringify(conflict.cwd)}.`,
			);
		}
	}

	// ── Model/auth services: select the supported SDK shape ─────────────
	const modelServices = await resolveCliModelServices(opts, agentDir);
	const { authStorage, modelRuntime, modelRegistry } = modelServices;


	// ── Run scaffolding (runId, runState, chainDir) ───────────────────
	const runId = deriveRunId(`cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const dispatchAbort = new AbortController();
	const taskAbortControllers: Record<string, AbortController> = Object.fromEntries(
		tasks.map((task) => [task.name, new AbortController()]),
	);
	const cancelReasonsByTask: Record<string, CancelReason | undefined> = {};
	const abortTasksWithDispatch = () => {
		for (const controller of Object.values(taskAbortControllers)) controller.abort();
	};
	dispatchAbort.signal.addEventListener("abort", abortTasksWithDispatch, { once: true });
	const onSignalAbort = () => dispatchAbort.abort();
	if (opts.signal) {
		opts.signal.addEventListener("abort", onSignalAbort, { once: true });
	}

	// Synthesize a minimal DelegateDispatchState so `runtime.updateRunState`
	// calls from inside the pump don't no-op. We don't strictly need
	// the registry for sync-mode CLI use (no interactive inspector,
	// no inbound steer), but keeping it consistent means the
	// transcript / status helpers continue to work if the caller pokes
	// at them via runtime APIs.
	const sessionRefsByTask: Record<string, { worker?: any }> = {};
	for (const t of tasks) sessionRefsByTask[t.name] = {};
	const runState: DelegateDispatchState = {
		runId,
		// Issue #76 — `delegateFromCli` covers direct mode only (single + parallel).
		shape: "direct",
		createdAt: Date.now(),
		forks: Object.fromEntries(
			tasks.map((t) => [
				t.name,
				{
					name: t.name,
					...(t.displayLabel !== undefined ? { displayLabel: t.displayLabel } : {}),
					agent: t.agent.name,
					agentSource: t.agent.source,
					task: t.task,
					collapseMode: "final_output" as const,
					status: "pending" as const,
					currentRound: 0,
					maxRounds: 1,
					transcript: [],
					pendingGuidance: [],
					interactive: t.interactive ?? false,
				} satisfies RunLiveState,
			]),
		),
		abort: () => dispatchAbort.abort(),
		// Steering is meaningless without a supervisor — return a
		// queue-only stub so any future caller that walks the run
		// registry doesn't crash on .steer === undefined.
		steer: async () => ({
			delivered: "queued" as const,
			error: "CLI mode does not support steering",
		}),
		cancel: async (taskName, reason) => {
			const why: CancelReason = reason ?? "user";
			if (taskName !== undefined && runState.forks[taskName] === undefined) return;
			const targets = taskName === undefined ? Object.keys(runState.forks) : [taskName];
			for (const name of targets) {
				const refs = sessionRefsByTask[name];
				const current = runState.forks[name]?.status;
				if (current === "completed" || current === "failed" || current === "aborted") continue;
				if (cancelReasonsByTask[name] === undefined) cancelReasonsByTask[name] = why;
				taskAbortControllers[name]?.abort();
				abortWorkerCompaction(refs?.worker ?? {});
				updateRunState(runId, name, {
					status: "aborted",
					error: `cancelled (${why})`,
					cancelReason: cancelReasonsByTask[name],
				});
				try {
					await refs?.worker?.abort();
				} catch {
					/* swallow */
				}
			}
			if (taskName === undefined) dispatchAbort.abort();
		},
	};
	registerRun(runState);


	// Chain dir for `artifact:` / `progress.md` writes.
	try {
		sweepOldChainDirs({});
	} catch {
		/* best-effort */
	}
	const chainDir = prepareChainDir({ runId });

	// Worktree setup (optional).
	let worktreeSetup: WorktreeSetup | undefined;
	if (opts.worktree) {
		worktreeSetup = createWorktrees(cwd, runId, tasks.length, {
			agents: tasks.map((t) => t.agent.name),
			setupHook: config.worktreeSetupHook
				? {
						hookPath: config.worktreeSetupHook,
						timeoutMs: config.worktreeSetupHookTimeoutMs,
					}
				: undefined,
		});
	}

	// Snapshot bridge for onUpdate (caller-supplied).
	const onForkRuntimeUpdate = (forkName: string, patch: Partial<RunLiveState>) => {
		updateRunState(runId, forkName, patch);
	};
	const onForkTranscriptEntry = opts.onUpdate
		? (forkName: string, entry: any) => appendTranscriptEntry(runId, forkName, entry)
		: undefined;

	// ── Run the pump in sync mode ─────────────────────────────────────
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? tasks.length, tasks.length));
	let pumped: Awaited<ReturnType<typeof pumpDirectWorkers>>;
	try {
		pumped = await pumpDirectWorkers({
			tasks,
			concurrency,
			signal: dispatchAbort.signal,
			taskSignals: Object.fromEntries(
				Object.entries(taskAbortControllers).map(([name, controller]) => [name, controller.signal]),
			),
			getCancelReasonByTask: Object.fromEntries(
				tasks.map((task) => [task.name, () => cancelReasonsByTask[task.name]]),
			),
			ctxCwd: cwd,
			mainModel: opts.mainModel,
			authStorage,
			modelRuntime,
			modelRegistry,
			agentDir,
			runId,
			worktreeSetup,
			chainDir,
			onForkRuntimeUpdate,
			onForkTranscriptEntry,
			sessionRefsByTask,
			resolveIntercomBridgeForTask: (task, effectiveCwd) =>
				resolveIntercomBridgeWithPolicy({
					config,
					agent: task.agent,
					directMode: true,
					cwd: effectiveCwd,
					agentDir,
				}),
			onStreamUpdate: opts.onUpdate
				? (results) => {
						try {
							opts.onUpdate!(buildSnapshot(runId, tasks, results));
						} catch {
							/* swallow callback errors so they can't break the pump */
						}
					}
				: undefined,
		});
		completeRun(runId, pumped.finalResults);
	} catch (err: any) {
		// pumpDirectWorkers shouldn't normally throw (it surfaces failures
		// inside individual RunResult.status). If it does — most likely
		// during worktree teardown — treat it as a catastrophic call
		// failure: clean up the worktree and re-throw so the consumer
		// sees a single rejection rather than a partial result.
		completeRun(runId, []);
		if (worktreeSetup) {
			try {
				cleanupWorktrees(worktreeSetup);
			} catch {
				/* swallow */
			}
		}
		if (opts.signal) opts.signal.removeEventListener("abort", onSignalAbort);
		dispatchAbort.signal.removeEventListener("abort", abortTasksWithDispatch);
		// AbortError propagation: if the dispatch was aborted, surface as
		// AbortError regardless of what the underlying err was.
		if (dispatchAbort.signal.aborted) {
			throw makeAbortError(err?.message ?? "aborted");
		}
		throw err;
	}
	if (opts.signal) opts.signal.removeEventListener("abort", onSignalAbort);
	dispatchAbort.signal.removeEventListener("abort", abortTasksWithDispatch);

	// Aborted dispatches: still resolve with a result (matches step 8
	// of the spec — per-worker failures don't reject; only catastrophic
	// errors do). However, if the CALLER's signal aborted (vs internal
	// cancel), we do reject with AbortError per step 7.
	const wasUserAborted = opts.signal?.aborted === true;

	const runs = mapRunResults(pumped.finalResults, tasks, extractCommit);
	const result: CliDelegateResult = {
		forks: runs,
		anyFailed: pumped.anyFailed,
		combinedContent: pumped.combinedContent,
		usage: aggregateRunResults(pumped.finalResults),
		runId,
	};
	if (worktreeSetup && pumped.worktreeDiffs.length > 0) {
		result.worktreeDiffs = mapCliWorktreeDiffs(pumped.worktreeDiffs, tasks);
	}

	if (wasUserAborted) {
		// Surface the in-flight result on the rejection so the caller can
		// still inspect partial state if they choose.
		const err = makeAbortError("aborted by caller signal");
		(err as any).result = result;
		throw err;
	}

	return result;
}

function makeAbortError(message: string): Error {
	const err = new Error(message);
	(err as any).name = "AbortError";
	return err;
}
