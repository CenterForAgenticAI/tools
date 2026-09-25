/**
 * Detached `orchestrate`-shape child ENTRYPOINT (spec 0005 substrate; spec
 * 0007 boot mechanism).
 *
 * This is the standalone program a detached child process runs. It is COMPILED
 * to `dist/orchestrate-runner.js` by the existing `tsconfig.build` (the
 * `src/**` include) and spawned as a plain `.js` via `process.execPath` — NO
 * jiti / TS-runtime dependency. [decision: runner-entrypoint-compiled-js-no-jiti]
 *
 * Lifecycle (one cfg → one terminal result):
 *   1. Read the cfg-file path from `process.argv[2]`, parse the `OrchestrateCfg`.
 *   2. Spawn a FRESH `pi --mode rpc` CLI subprocess (NOT an in-process
 *      `createAgentSession`) realizing the hosted agent via pi CLI flags
 *      (`--model`, `--system-prompt`/`--append-system-prompt`, `--tools`,
 *      `-e <ext>`, `--thinking`, `--session-dir`). The hosted agent's prompt is
 *      delivered on stdin as `{type:"prompt"}` (RPC), NOT a positional `Task:`
 *      argv. pi's NATIVE bootstrap reads `auth.json`, resolves providers, and
 *      registers models exactly as any normal `pi` invocation does — fixing the
 *      spec 0005 `401 Missing Authentication` bug BY CONSTRUCTION (the child
 *      never re-derives auth). [spec 0007 / REQ-PICLI-1; spec 0013 / REQ-RPC-1]
 *   3. Drive the child over the `--mode rpc` JSON stdin/stdout protocol via
 *      `OrchestrateRpcClient` (src/orchestrate-rpc-client.ts): RPC mode NEVER
 *      self-exits, so the terminal is detected off the EVENT STREAM — a
 *      qualifying `agent_end{willRetry:false}` with a clean `stopReason:"stop"`
 *      + non-empty accumulated text → `done`; a provider error / exit before a
 *      qualifying agent_end / stall / empty stop → `failed` (NEVER a silent
 *      empty `done` — REQ-RPC-4); a graceful cancel → `steered` (node B). On a
 *      qualifying terminal the child is torn down EXPLICITLY (end stdin →
 *      bounded SIGTERM → SIGKILL) before the lifecycle promise resolves
 *      (REQ-RPC-6).
 *   4. Write the terminal result file (`done` / `failed`) AND a copy in the
 *      pending dir for hydrate-and-deliver (REQ-ORCH-6).
 *
 * `cfg.bootProofOnly` is retained ONLY as an OFFLINE self-test short-circuit
 * (boots a real in-process session + loads extensions, no model/network) — it
 * is NO LONGER the production hosted-agent run path. [decision:
 * bootproof-kept-as-offline-selftest]
 *
 * The detached-spawn + pi-CLI-subprocess PATTERN (spawn resolution + arg build)
 * is adopted from pi-subagents-nicobailon (github.com/nicobailon/pi-subagents,
 * MIT): `runs/shared/pi-spawn.ts` (`getPiSpawnCommand`), `runs/shared/pi-args.ts`
 * (`buildPiArgs`). The terminal-detection half is now the `--mode rpc` event
 * stream (spec 0013), NOT a print-stream parse — see `OrchestrateRpcClient`.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	type AgentSession,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type { AgentConfig } from "./agents.js";
import {
	type ConsumedControl,
	consumeControlRequests,
	type ControlRequest,
	pollControlRequests,
	writeControlResult,
} from "./control-inbox.js";
import {
	CONTROL_SECRET_ENV,
	finalizeTerminalOrchestrateRoute,
} from "./control-route.js";
import {
	captureProcessIdentity,
	getProcessNonce,
} from "./process-identity.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import {
	acquireOrchestrateRecoveryLock,
	releaseOrchestrateRecoveryLock,
	type OrchestrateRecoveryLock,
} from "./orchestrate-recovery-lock.js";
import {
	type OrchestrateCfg,
	type OrchestrateResult,
	type OrchestrateResultDone,
	type OrchestrateResultFailed,
	readOrchestrateReplacementHandoff,
	resolveOrchestrateLogsDir,
	stampOrchestrateActiveMarkerPid,
	synthFailed,
	writeOrchestrateReplacementHandoff,
	ORCHESTRATE_OWNER_SESSION_ENV,
} from "./detached-spawn.js";
import { createChildLogWriter, type ChildLogWriter } from "./orchestrate-childlog.js";
import { spawnEnvPatch, withTrustedEnvOverrides } from "./env-overrides.js";
import type { DepthFrame } from "./depth-guard.js";
import {
	OrchestrateRpcClient,
	type RpcDriveResult,
	type RpcStreamOutcome,
} from "./orchestrate-rpc-client.js";
import type { OrchestrateBootProof } from "./detached-spawn.js";
import { appendBusEvent, readBusEvents } from "./event-bus.js";
import {
	buildWorkerSessionDir,
	prepareWorkerSessionResources,
	withForkOffline,
} from "./fork-runner.js";
import { makeWorkerAskRoutingTool, replaceLoadedAskTools } from "./worker-ask-routing.js";
import { applyWorkerSeeds } from "./worker-session-seeds.js";
import {
	assertValidTasksSeed,
	parseTaskLedger,
	readTaskProgressFields,
	TASK_ATTEMPT_ENV,
	TASK_ATTEMPT_FIELD,
	TASK_LEDGER_FIELD,
	TASKS_SEED_ENV,
	type TaskLedger,
	type TaskProgressFields,
} from "./task-seam.js";
import { disposeWorkerSession } from "./worker-session-lifecycle.js";
import {
	derivePortableExtensionIdentity,
	isPiDelegateExtensionIdentity,
	isPiDelegatePackageIdentifier,
	normalizeGitIdentity,
	normalizeNpmIdentity,
	resolveExtensionPolicyCandidateSelection,
	type ExtensionPolicyCandidateSelection,
} from "./extension-policy.js";
import {
	deserializeLineage,
	deserializeLineageDetached,
	lineagePath,
	serializeLineage,
	serializeLineageDetached,
} from "./lineage.js";
import {
	ASK_TOOL_NAME,
	assertValidExtensionToolSelectors,
	DELEGATE_TOOL_NAME,
	extensionSelectorAliases,
	resolveRunToolSurface,
	setTrustedOptionalGlobalExtensionSelectorKeys,
	type ResolvedToolSurface,
} from "./tool-surface.js";
import {
	createDetachedWorkerToolScopeEnvelope,
	prepareWorkerToolScope,
	DETACHED_WORKER_TOOL_OWNER_REGISTRY_KEY,
	DETACHED_WORKER_TOOL_SCOPE_ENV,
	type DetachedWorkerToolScopeEnvelope,
} from "./worker-tool-scope.js";
import {
	DETACHED_THINKING_POLICY_ENV,
	THINKING_LEVELS,
	type DetachedThinkingPolicyRequirements,
	type SessionThinkingPolicy,
} from "./thinking-policy.js";

/**
 * Reconstruct a minimal `AgentConfig` from the cfg so the SAME loader/tool-
 * surface helpers the in-process runs use (`buildWorkerLoaderOptions`,
 * `resolveRunToolSurface`) apply identically in the child — we do NOT reinvent
 * how a run inherits context.
 */
function cfgToAgentConfig(cfg: OrchestrateCfg): AgentConfig {
	return {
		name: cfg.agentName,
		description: `driver child for ${cfg.agentName}`,
		systemPrompt: cfg.systemPrompt ?? "",
		systemPromptMode: cfg.systemPromptMode ?? "append",
		source: "user",
		filePath: "(detached-driver)",
		inheritProjectContext: cfg.inheritProjectContext,
		inheritSkills: cfg.inheritSkills,
		...(cfg.skills ? { skills: cfg.skills } : {}),
		...(cfg.extensions ? { extensions: cfg.extensions } : {}),
		...(cfg.extensionInclude ? { extensionInclude: cfg.extensionInclude } : {}),
		...(cfg.extensionExclude ? { extensionExclude: cfg.extensionExclude } : {}),
		...(cfg.tools ? { tools: cfg.tools } : {}),
		...(cfg.model ? { model: cfg.model } : {}),
		...(cfg.env ? { env: cfg.env } : {}),
		...(cfg.thinking ? { thinking: cfg.thinking } : {}),
		...(cfg.thinkingMin ? { thinkingMin: cfg.thinkingMin } : {}),
		...(cfg.thinkingMax ? { thinkingMax: cfg.thinkingMax } : {}),
	};
}

function resolveCfgHasExplicitAllowlist(cfg: OrchestrateCfg): boolean {
	const hasExtensionSelectors = (cfg.extensionToolSelectors?.length ?? 0) > 0;
	if (
		cfg.hasExplicitAllowlist === true &&
		(cfg.tools?.length ?? 0) === 0 &&
		!hasExtensionSelectors
	) {
		throw new Error(
			"Explicit tools allowlist selects no usable tools; refusing to widen the worker to Pi defaults.",
		);
	}
	// Old records flattened implicit defaults and explicit builtin lists into the
	// same `tools` array. Without a marker, only extension selectors prove intent;
	// ambiguous builtin-only records retain the pre-floor implicit behavior.
	return hasExtensionSelectors || cfg.hasExplicitAllowlist === true;
}

function applyCfgAllowlistIntent(
	cfg: OrchestrateCfg,
	surface: ResolvedToolSurface,
): ResolvedToolSurface {
	return { ...surface, hasExplicitAllowlist: resolveCfgHasExplicitAllowlist(cfg) };
}

/** Rebuild the coordinator-resolved driver surface and restore only trusted transported provenance. */
export function reconstructOrchestrateToolSurface(cfg: OrchestrateCfg): ResolvedToolSurface {
	const resolvedSurface = resolveRunToolSurface(cfgToAgentConfig(cfg), "orchestrate");
	const transportedSurface = cfg.extensionToolSelectors?.length
		? { ...resolvedSurface, extSelectors: cfg.extensionToolSelectors }
		: resolvedSurface;
	const surface = applyCfgAllowlistIntent(cfg, transportedSurface);
	return setTrustedOptionalGlobalExtensionSelectorKeys(
		surface,
		cfg.optionalGlobalExtensionSelectorKeys ?? [],
	);
}

async function resolveAndValidateOrchestrateExtensionPolicy(
	cfg: OrchestrateCfg,
	agent: AgentConfig,
	surface: ResolvedToolSurface,
): Promise<ExtensionPolicyCandidateSelection | undefined> {
	const hasPolicy = Boolean(cfg.extensionInclude?.length || cfg.extensionExclude?.length);
	if (!hasPolicy) return undefined;
	const selection = await withForkOffline(() =>
		resolveExtensionPolicyCandidateSelection(agent, {
			cwd: cfg.cwd,
			agentDir: cfg.agentDir,
		}),
	);
	const delegateCandidates = selection.candidates.filter(
		(candidate) => isPiDelegateExtensionIdentity(candidate.identity),
	);
	const selectedDelegateCandidates = selection.selected.filter(
		(candidate) => isPiDelegateExtensionIdentity(candidate.identity),
	);
	if (
		surface.tools?.includes("delegate") &&
		delegateCandidates.length > 0 &&
		selectedDelegateCandidates.length === 0
	) {
		throw new Error(
			"driver extension policy excludes pi-delegate, but the hosted driver requires its delegate tool; " +
			"remove that exclusion or use a non-driver worker shape",
		);
	}
	return selection;
}

export function extensionPathProvidesDelegateOwner(
	extensionSpec: string,
	cwd: string,
	delegateSelfPath: string | undefined = resolveDelegateSelfPath(),
): boolean {
	if (extensionSpec !== extensionSpec.trim()) return false;
	const npm = normalizeNpmIdentity(extensionSpec);
	if (npm) return isPiDelegatePackageIdentifier(extensionSpec);

	const explicitGitSource = /^(?:git:|github:|https?:\/\/|ssh:\/\/|git:\/\/|[^@/\s]+@[^:]+:)/i.test(extensionSpec);
	if (explicitGitSource) {
		const source = normalizeGitIdentity(extensionSpec);
		if (!source || !delegateSelfPath || !fs.existsSync(delegateSelfPath)) return false;
		const selfIdentity = derivePortableExtensionIdentity(delegateSelfPath, {
			path: delegateSelfPath,
			source: delegateSelfPath,
			scope: "temporary",
			origin: "top-level",
			baseDir: path.dirname(delegateSelfPath),
		});
		return selfIdentity.source === source;
	}

	const resolvedPath = path.isAbsolute(extensionSpec)
		? extensionSpec
		: path.resolve(cwd, extensionSpec);
	// Never let an unresolved relative path inherit package identity from the
	// host process's cwd/repository.
	if (!fs.existsSync(resolvedPath)) return false;
	const identity = derivePortableExtensionIdentity(resolvedPath, {
		path: resolvedPath,
		source: extensionSpec,
		scope: "temporary",
		origin: "top-level",
		baseDir: path.dirname(resolvedPath),
	});
	return isPiDelegateExtensionIdentity(identity);
}

// ── pi-CLI subprocess: resolution + args + stream parse (spec 0007) ──────────
//
// PATTERN adopted from pi-subagents-nicobailon (github.com/nicobailon/pi-subagents,
// MIT): `runs/shared/pi-spawn.ts` (getPiSpawnCommand), `runs/shared/pi-args.ts`
// (buildPiArgs), `runs/background/subagent-runner.ts` (runPiStreaming). We do
// NOT vendor that code; we reimplement the minimal slice the orchestrate runner
// needs, citing the source.

/** The pi CLI package whose native bootstrap owns auth + model resolution. */
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Walk upward from an entry file to the directory whose `package.json` declares
 * `name === @earendil-works/pi-coding-agent`. Mirrors nicobailon
 * `findPiPackageRootFromEntry`.
 */
function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const pkgPath = path.join(dir, "package.json");
		try {
			if (fs.existsSync(pkgPath)) {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
					name?: unknown;
				};
				if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
			}
		} catch {
			/* unreadable package.json — keep walking */
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

/** Resolve the installed pi package root via `import.meta.resolve`. */
function resolveInstalledPiPackageRoot(): string | undefined {
	try {
		return findPiPackageRootFromEntry(
			fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)),
		);
	} catch {
		return undefined;
	}
}

/** Injectable seams so a unit test can drive resolution without a real install. */
export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, enc: "utf8") => string;
	piPackageRoot?: string;
	/** Test seam / override: whether `pi` resolves on PATH (skips the spawnSync probe). */
	piOnPath?: boolean;
}

/** A resolved spawn target: the command + the args to hand it. */
export interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(
	filePath: string,
	existsSync: (filePath: string) => boolean,
): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

/**
 * Resolve the pi CLI bin script (Windows-safe: `node <cli.js> <args>`). Reads
 * the resolved package's `bin.pi`. Returns undefined if it cannot be resolved,
 * letting the caller fall back to `pi` on PATH. Mirrors nicobailon
 * `resolveWindowsPiCliScript`.
 */
export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync =
		deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
	try {
		const root = deps.piPackageRoot ?? resolveInstalledPiPackageRoot();
		if (!root) return undefined;
		const pkgPath = path.join(root, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = pkg.bin;
		const binPath =
			typeof binField === "string"
				? binField
				: (binField?.pi ?? Object.values(binField ?? {})[0]);
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(pkgPath), binPath);
		return isRunnableNodeScript(candidate, existsSync) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the command + args to spawn pi (REQ-PICLI-1). Prefer `pi` on PATH
 * — the SAME binary the foreground runs (the user's installed pi), which is
 * what authenticates correctly. Mirrors nicobailon `getPiSpawnCommand`, whose
 * default is `command: "pi"`.
 *
 * CRITICAL (live-test finding): do NOT prefer the resolvable
 * `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` — in a path-loaded
 * extension that copy is a (possibly STALE) devDependency. Spawning the stale
 * repo-local cli.js ran an OLD pi build whose openrouter auth resolution was
 * broken → `401 Missing Authentication header`, while the current global `pi`
 * authenticated fine. The child must run the same pi the foreground does.
 *
 * `process.execPath <resolved-cli.js>` is the FALLBACK, used only when `pi` is
 * not resolvable on PATH (e.g. a clean CI checkout). Windows always needs the
 * execPath+script form (no PATH `pi` shim), so it keeps the fallback when the
 * script resolves.
 */
export function getPiSpawnCommand(
	args: string[],
	deps: PiSpawnDeps = {},
): PiSpawnCommand {
	const platform = deps.platform ?? process.platform;
	const cliScript = resolvePiCliScript(deps);
	// Windows has no `pi` PATH shim — must use execPath + the resolved script.
	if (platform === "win32" && cliScript) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [cliScript, ...args],
		};
	}
	// POSIX: prefer the PATH `pi` (current, foreground-equivalent build).
	if (deps.piOnPath ?? hasPiOnPath()) {
		return { command: "pi", args };
	}
	// Fallback: the resolvable cli.js (clean checkout with no PATH `pi`).
	if (cliScript) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [cliScript, ...args],
		};
	}
	return { command: "pi", args };
}

/** Best-effort check that `pi` resolves on PATH (POSIX). */
function hasPiOnPath(): boolean {
	try {
		const r = spawnSync("pi", ["--version"], { stdio: "ignore" });
		return r.status === 0 || r.error === undefined;
	} catch {
		return false;
	}
}

/** Result of building the pi CLI args, plus a temp dir to clean up after. */
export interface OrchestratePiArgs {
	args: string[];
	tempDir?: string;
	/** Original extension entrypoint to generated child-side owner proxy. */
	extensionRuntimePaths?: Record<string, string>;
	/** Trusted worker ask shim loaded ahead of consumer extensions. */
	workerAskRuntimePath?: string;
	/** Trusted delegate-self entrypoint loaded ahead of other consumers. */
	workerDelegateRuntimePath?: string;
	/** Delegate-owned child-authoritative task delivery bridge. */
	tasksSeedBridgePath?: string;
}

/**
 * Append the thinking level as a `:level` model suffix when the model ref does
 * not already carry one (mirrors nicobailon `applyThinkingSuffix`).
 */
function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | undefined,
): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colon = model.lastIndexOf(":");
	if (colon !== -1 && THINKING_LEVELS.includes(model.slice(colon + 1) as (typeof THINKING_LEVELS)[number]))
		return model;
	return `${model}:${thinking}`;
}

/**
 * Resolve the delegate-self extension entry (this extension's own `dist/index.js`)
 * from the running runner's location (spec 0025, REQ-OCHILD-1).
 *
 * The compiled runner is `dist/orchestrate-runner.js`; the delegate extension
 * entry is its SIBLING `dist/index.js` in the SAME dir. We derive it from
 * `import.meta.url` (the same self-location pattern the entrypoint-guard uses at
 * the bottom of this file) so it resolves correctly in BOTH a normal install and
 * the `.deploy` worktree — never a hard-coded path.
 *
 * Returns the absolute path when it exists on disk, else `undefined` so the
 * caller can log a diagnostic and proceed WITHOUT it (REQ-OCHILD-4 — the child
 * still boots, it just can't dispatch; same as before this spec, no crash).
 */
export function resolveDelegateSelfPath(): string | undefined {
	const here = fileURLToPath(import.meta.url);
	const candidate = path.join(path.dirname(here), "index.js");
	return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Resolve a single-purpose child extension entry that ships beside this runner.
 *
 * The compiled sibling (`dist/<name>.js`) is preferred, but this package is
 * commonly loaded from source — `pi.extensions` may point at `src/index.ts` — in
 * which case `import.meta.url` resolves into `src/` and only the TypeScript
 * sibling exists. Pi loads extensions through jiti, which transpiles TypeScript,
 * so the `.ts` sibling is a genuine fallback rather than a broken path, and it
 * cannot be a stale build of the `.js` one. Both candidates are `-e` entries for
 * the child process, never imported into this one.
 *
 * Applies only to these self-contained policy shims. `resolveDelegateSelfPath()`
 * deliberately keeps `.js`-only resolution: swapping the child's whole delegate
 * extension to a source entry is a behavioral change beyond this helper, and its
 * unresolvable case is an existing documented degradation (REQ-OCHILD-4).
 */
function resolveChildExtensionSibling(baseName: string): string | undefined {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	return [`${baseName}.js`, `${baseName}.ts`]
		.map((fileName) => path.join(dir, fileName))
		.find((candidate) => fs.existsSync(candidate));
}

/**
 * Resolve the worker-ask deny shim loaded before consumer extensions.
 *
 * Returns `undefined` only when neither sibling exists (a partial install);
 * callers must still degrade safely — see `buildOrchestratePiArgs`.
 */
export function resolveWorkerAskShimPath(): string | undefined {
	return resolveChildExtensionSibling("worker-ask-deny");
}

/** Resolve the detached thinking-policy bridge beside this runner. */
export function resolveThinkingPolicyBridgePath(): string | undefined {
	return resolveChildExtensionSibling("thinking-policy-bridge");
}

/** Resolve the authoritative hosted-child live worker-tool scope bridge. */
export function resolveWorkerToolScopeBridgePath(): string | undefined {
	return resolveChildExtensionSibling("worker-tool-scope-bridge");
}

/** Resolve the child-side durable task seed bootstrap. */
export function resolveTasksSeedBridgePath(): string | undefined {
	return resolveChildExtensionSibling("tasks-seed-bridge");
}

function resolveWorkerToolOwnerPath(extensionPath: string, cwd: string): string {
	return extensionPath.startsWith("file:")
		? fileURLToPath(extensionPath)
		: path.resolve(cwd, extensionPath);
}

function materializeWorkerToolOwnerProxy(
	dir: string,
	ownerPath: string,
	index: number,
): string {
	const runtimePath = path.join(dir, `worker-tool-owner-${index}.mjs`);
	const importSpecifier = pathToFileURL(ownerPath).href;
	const source = `import * as extensionModule from ${JSON.stringify(importSpecifier)};
const importedFactory = extensionModule.default;
const factory = typeof importedFactory === "function"
  ? importedFactory
  : typeof importedFactory?.default === "function"
    ? importedFactory.default
    : undefined;
const registryKey = Symbol.for(${JSON.stringify(DETACHED_WORKER_TOOL_OWNER_REGISTRY_KEY)});
const ownerPath = ${JSON.stringify(ownerPath)};
const runtimePath = ${JSON.stringify(runtimePath)};
export default async function workerToolOwnerProxy(pi) {
  if (typeof factory !== "function") {
    throw new TypeError("Extension does not export a valid factory function: " + ownerPath);
  }
  const proxied = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool) => {
          let registry = globalThis[registryKey];
          if (!(registry instanceof Map)) {
            registry = new Map();
            globalThis[registryKey] = registry;
          }
          let owners = registry.get(tool.name);
          if (!(owners instanceof Map)) {
            owners = new Map();
            registry.set(tool.name, owners);
          }
          owners.set(runtimePath, ownerPath);
          return target.registerTool(tool);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return factory(proxied);
}
`;
	fs.writeFileSync(runtimePath, source, { mode: 0o600 });
	return runtimePath;
}

/**
 * Build the `pi --mode rpc` argv that realizes the hosted agent (REQ-RPC-1).
 * There is NO `--agent` pi flag, so the agent's identity is expressed entirely
 * through these flags, derived from the resolved `cfg`/`agent`:
 *
 *   --mode rpc                             (headless JSON stdin/stdout protocol)
 *   --model <ref[:thinking]>               (cfg.model; pi resolves provider auth)
 *   --system-prompt|--append-system-prompt <tmp.md>   (per systemPromptMode)
 *   --tools <csv>                          (orchestrate surface incl `delegate`)
 *   -e <ext> (\u00d7N)                          (consumer extensions \u2014 graft tools load)
 *   -e <delegate-self>                     (spec 0025: when the surface includes
 *                                           delegate, load delegate-self so the
 *                                           allow-listed `delegate` tool is real)
 *   --thinking <level>                     (when set)
 *   --session-dir <dir>                    (child session dir)
 *
 * RPC switch (spec 0013, node A): the child no longer runs `--mode json -p`
 * (print / one-shot) and there is NO positional `Task:` argv — the prompt moves
 * onto stdin as `{type:'prompt', message:<task>}` (sent by `OrchestrateRpcClient`
 * once the child is up). [decision: clean-break-includes-positional-task-arg]
 *
 * The system prompt is written to a 0600 temp file (pi's `--system-prompt`
 * takes a path); the returned `tempDir` must be cleaned up by the caller after
 * the child exits. Pure apart from the temp write, so a unit test can assert the
 * emitted flags from a sample cfg.
 */
export function buildOrchestratePiArgs(
	cfg: OrchestrateCfg,
	opts: {
		sessionDir?: string;
		tmpRoot?: string;
		/**
		 * TEST-ONLY seam (spec 0025): override how the delegate-self extension
		 * entry is resolved. A test passes a fixed path (or one that does not
		 * exist) to exercise the resolve / existsSync-guard branches without
		 * depending on the real `dist/index.js` being built. Production omits it
		 * → `resolveDelegateSelfPath()` (import.meta.url → sibling index.js).
		 */
		resolveDelegateSelf?: () => string | undefined;
		/** Test seam for the compiled worker ask deny shim. */
		resolveWorkerAskShim?: () => string | undefined;
		/** Test seam for the compiled session-local thinking-policy bridge. */
		resolveThinkingPolicyBridge?: () => string | undefined;
		/** Test seam for the compiled live worker-tool scope bridge. */
		resolveWorkerToolScopeBridge?: () => string | undefined;
		/** Test seam for the compiled task-seed bootstrap. */
		resolveTasksSeedBridge?: () => string | undefined;
	} = {},
): OrchestratePiArgs {
	if (cfg.tasks !== undefined) assertValidTasksSeed(cfg.tasks);
	const args: string[] = ["--mode", "rpc"];
	let tempDir: string | undefined;
	const ensureTempDir = (): string => {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(
				path.join(opts.tmpRoot ?? os.tmpdir(), "orchestrate-pi-"),
			);
		}
		return tempDir;
	};

	const modelArg = applyThinkingSuffix(cfg.model, cfg.thinking);
	if (modelArg) args.push("--model", modelArg);

	// Worker `ask` safety (issue #75): a detached child has NO prompt surface, so
	// `ask` may only be exposed when the deny shim can be loaded ahead of consumer
	// extensions. When the compiled shim is unavailable (source-loaded checkout,
	// unbuilt install), DROP `ask` from the emitted allowlist instead of failing
	// the whole dispatch: `--tools` is a FILTER, so an unlisted `ask` cannot reach
	// the child's model even if a consumer extension registers it. The one shape
	// with no safe degradation is an ask-ONLY allowlist — omitting `--tools` there
	// would widen the child to Pi's defaults — so that case still fails closed.
	const liveSelectorScope = (cfg.extensionToolSelectors?.length ?? 0) > 0;
	const requestedAsk = cfg.tools?.includes(ASK_TOOL_NAME) === true;
	const selectedExtensionMayProvideAsk = cfg.extensionToolSelectors?.some(
		(selector) => selector.tool === undefined || selector.tool === ASK_TOOL_NAME,
	) === true;
	const wantsAsk = requestedAsk || selectedExtensionMayProvideAsk;
	const askShimPath = wantsAsk
		? (opts.resolveWorkerAskShim ?? resolveWorkerAskShimPath)()
		: undefined;
	const hasExplicitAllowlist = resolveCfgHasExplicitAllowlist(cfg);
	const needsWorkerScopeBridge = liveSelectorScope || hasExplicitAllowlist || cfg.tasks !== undefined;
	const scopeBridgePath = needsWorkerScopeBridge
		? (opts.resolveWorkerToolScopeBridge ?? resolveWorkerToolScopeBridgePath)()
		: undefined;
	if (needsWorkerScopeBridge && !scopeBridgePath) {
		throw new Error(
			"Detached driver requires the compiled worker tool scope bridge for an explicit tool allowlist; " +
				"run the pi-delegate build or upgrade the installed package.",
		);
	}
	const thinkingBridgePath = cfg.thinkingMin || cfg.thinkingMax
		? (opts.resolveThinkingPolicyBridge ?? resolveThinkingPolicyBridgePath)()
		: undefined;
	if ((cfg.thinkingMin || cfg.thinkingMax) && !thinkingBridgePath) {
		throw new Error(
			"Detached driver requires the compiled thinking-policy bridge for bounded agents; " +
			"run the pi-delegate build or upgrade the installed package.",
		);
	}
	const tasksSeedBridgePath = cfg.tasks === undefined
		? undefined
		: (opts.resolveTasksSeedBridge ?? resolveTasksSeedBridgePath)();
	if (cfg.tasks !== undefined && !tasksSeedBridgePath) {
		throw new Error(
			"Detached driver requires the compiled task-seed bridge for structured handoff.tasks; " +
			"run the pi-delegate build or upgrade the installed package.",
		);
	}
	let childTools = cfg.tools;
	if (requestedAsk && !askShimPath) {
		childTools = cfg.tools!.filter((name) => name !== ASK_TOOL_NAME);
		if (childTools.length === 0) {
			throw new Error(
				"Detached driver cannot safely expose ask: compiled worker ask shim is unavailable " +
				"and `ask` is the only requested tool, so dropping it would widen the child to Pi defaults.",
			);
		}
		logDelegateDiagnostic(
			"[driver] compiled worker ask shim not found beside the runner; dropping `ask` from " +
				"the child tool allowlist (a detached child has no prompt surface)",
			{ agentDir: cfg.agentDir, level: "warn", throttleKey: "worker-ask-shim-missing" },
		);
	}
	if (!liveSelectorScope && childTools && childTools.length > 0) {
		args.push("--tools", childTools.join(","));
	}

	// DISABLE extension auto-discovery, then load ONLY the explicit consumer
	// extensions. CRITICAL: without `--no-extensions` the child re-discovers
	// the SAME delegate extension that spawned it (it is path-loaded globally
	// via ~/.pi/agent/settings.json), whose foreground-only `session_start`
	// hook (hydrate-and-deliver, which calls pi.sendMessage) fires INSIDE the
	// worker while it is already processing its `-p` task → the child crashes
	// with "Agent is already processing". A child must run only the consumer's
	// extensions (e.g. graft), never delegate itself. Mirrors
	// github.com/nicobailon pi-subagents runs/shared/pi-args.ts (`--no-extensions`
	// then explicit `--extension`). Defense-in-depth: `PI_DELEGATE_CHILD` env
	// (set on the spawn) makes delegate's own foreground hooks self-skip if it
	// is ever loaded explicitly.
	args.push("--no-extensions");
	if (askShimPath) {
		// Load before consumer extensions because Pi resolves duplicate tool names
		// by first registration, not last registration.
		args.push("-e", askShimPath);
	}

	// Load an independently resolved delegate-self before consumer extensions.
	// This keeps every unproxied tool provider ahead of the proxied consumers, so
	// a same-name provider cannot hide behind Pi's first-registration flattening.
	const includesDelegate = (cfg.tools ?? []).includes("delegate");
	let workerDelegateRuntimePath: string | undefined;
	if (includesDelegate && !cfg.delegateSelfAlreadySelected) {
		const resolveSelf = opts.resolveDelegateSelf ?? resolveDelegateSelfPath;
		const delegateSelfPath = resolveSelf();
		if (delegateSelfPath) {
			workerDelegateRuntimePath = delegateSelfPath;
			args.push("-e", delegateSelfPath);
		} else {
			logDelegateDiagnostic(
				"[driver] delegate-self extension entry not found beside the runner; " +
					"driver child will boot WITHOUT the delegate tool (cannot dispatch sub-agents)",
				{ agentDir: cfg.agentDir, level: "warn", throttleKey: "delegate-self-missing" },
			);
		}
	}

	const extensionRuntimePaths = Object.create(null) as Record<string, string>;
	const extensionEntries = new Map<string, string[]>();
	const configuredExtensions = [...(cfg.extensions ?? [])];
	let orderedExtensions = configuredExtensions;
	if (includesDelegate && cfg.delegateSelfAlreadySelected) {
		const delegateOwners: string[] = [];
		const otherExtensions: string[] = [];
		for (const extensionPath of configuredExtensions) {
			const target = extensionPathProvidesDelegateOwner(
				resolveWorkerToolOwnerPath(extensionPath, cfg.cwd),
				cfg.cwd,
			)
				? delegateOwners
				: otherExtensions;
			target.push(extensionPath);
		}
		orderedExtensions = [...delegateOwners, ...otherExtensions];
	}
	for (const extensionPath of orderedExtensions) {
		const ownerPath = liveSelectorScope
			? resolveWorkerToolOwnerPath(extensionPath, cfg.cwd)
			: extensionPath;
		const aliases = extensionEntries.get(ownerPath) ?? [];
		if (!aliases.includes(extensionPath)) aliases.push(extensionPath);
		extensionEntries.set(ownerPath, aliases);
	}
	try {
		for (const [index, [ownerPath, aliases]] of [...extensionEntries].entries()) {
			const runtimePath = liveSelectorScope
				? materializeWorkerToolOwnerProxy(ensureTempDir(), ownerPath, index)
				: ownerPath;
			extensionRuntimePaths[ownerPath] = runtimePath;
			for (const alias of aliases) extensionRuntimePaths[alias] = runtimePath;
			if (includesDelegate && extensionPathProvidesDelegateOwner(ownerPath, cfg.cwd)) {
				if (workerDelegateRuntimePath && workerDelegateRuntimePath !== runtimePath) {
					throw new Error("Detached driver resolved multiple delegate-self runtime owners");
				}
				workerDelegateRuntimePath = runtimePath;
			}
			args.push("-e", runtimePath);
		}
	} catch (error) {
		cleanupTempDir(tempDir);
		throw new Error("Detached driver could not create worker tool owner proxies", { cause: error });
	}
	if (scopeBridgePath) {
		// The bridge loads after every consumer extension so its lifecycle
		// narrowing sees owner records from every earlier consumer handler.
		args.push("-e", scopeBridgePath);
	}

	if (thinkingBridgePath) {
		// Load after consumer extensions so the bridge's policy emission reaches
		// adaptive-thinking's already-registered session-local listener.
		args.push("-e", thinkingBridgePath);
	}

	if (tasksSeedBridgePath) {
		// Load last. Its lifecycle handlers decide structured seed versus Markdown
		// only after lazy consumer registrations and final tool-scope enforcement.
		args.push("-e", tasksSeedBridgePath);
	}
	// Skills gate (matches the in-process runs): when the agent does not
	// inherit skills, disable skill discovery in the child.
	if (!cfg.inheritSkills) {
		args.push("--no-skills");
	}

	if (cfg.thinking !== undefined) {
		args.push("--thinking", cfg.thinking);
	}

	if (opts.sessionDir) {
		args.push("--session-dir", opts.sessionDir);
	}

	const systemPrompt = cfg.systemPrompt;
	if (
		systemPrompt !== undefined &&
		systemPrompt !== null &&
		systemPrompt !== ""
	) {
		const dir = ensureTempDir();
		const promptPath = path.join(dir, "system-prompt.md");
		try {
			fs.writeFileSync(promptPath, systemPrompt, { mode: 0o600 });
		} catch (error) {
			cleanupTempDir(tempDir);
			throw error;
		}
		args.push(
			cfg.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			promptPath,
		);
	}

	// NO positional `Task:` argv (RPC switch): the prompt is delivered on stdin
	// as `{type:'prompt'}` by `OrchestrateRpcClient.start(cfg.task)`.
	return {
		args,
		...(tempDir ? { tempDir } : {}),
		...(liveSelectorScope ? { extensionRuntimePaths } : {}),
		...(askShimPath ? { workerAskRuntimePath: askShimPath } : {}),
		...(workerDelegateRuntimePath ? { workerDelegateRuntimePath } : {}),
		...(tasksSeedBridgePath ? { tasksSeedBridgePath } : {}),
	};
}

// ── pi child stream parsing + terminal classification ───────────────────────────────────
//
// The spec-0007 print-stream parser + clean-stop classifier (extractTextFromContent
// / parsePiJsonStream / PiStreamOutcome / decidePiStreamTerminal / PiTerminal /
// cleanStopText) were REMOVED by the spec-0013 RPC switch (clean break, no
// fallback). The child now speaks `pi --mode rpc`; the equivalent stream text
// accumulation + the REQ-RPC-4 clean-stop predicate are re-expressed over the RPC
// EVENT STREAM in src/orchestrate-rpc-client.ts (OrchestrateRpcClient +
// classifyRpcTerminal).

/** Best-effort recursive temp-dir cleanup (no throw). */
function cleanupTempDir(tempDir: string | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

/**
 * The shape of a finished pi child the runner needs to classify a terminal.
 * Returned by `runPiChild`; injectable in tests via a spawn stub.
 *
 * The `outcome` field name + shape are PRESERVED from spec 0007 (now sourced
 * from the RPC event stream via `OrchestrateRpcClient`, not the print stream),
 * so `runOrchestrateChild`'s `steered`-branch read of
 * `outcome.cleanStopText/finalText/toolStarts` and the supervision substrate are
 * unchanged at the field level. `terminal` + `reason` carry the RPC client's
 * classification (REQ-RPC-4) so the runner no longer needs the removed
 * `decidePiStreamTerminal`.
 */
function attachChildLogReader(
	stream: NodeJS.ReadableStream | null,
	writer: ChildLogWriter | undefined,
): () => void {
	if (!stream || !writer) return () => {};
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const onLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			const event = JSON.parse(trimmed) as unknown;
			writer.writeEvent(event);
		} catch {
			writer.writeEvent(undefined, `rpc.invalid ${JSON.stringify(trimmed)}`);
		}
		writer.writeRaw(trimmed);
	};
	const onData = (chunk: string | Buffer): void => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	};
	const onEnd = (): void => {
		buffer += decoder.end();
		if (buffer) onLine(buffer);
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

export interface PiChildResult {
	outcome: RpcStreamOutcome;
	/** The RPC client's terminal classification (REQ-RPC-4). */
	terminal: RpcDriveResult["terminal"];
	/** Why the run reached a terminal (agent_end / process_exit / stalled). */
	reason: RpcDriveResult["reason"];
	exitCode: number | null;
	stderr: string;
	/** A spawn/transport-level error (ENOENT, stdin EPIPE), distinct from a nonzero exit. */
	spawnError?: string;
}

/**
 * Spawn the resolved pi child as a MANAGED (NOT detached) child of THIS detached
 * node runner with `stdio: ['pipe','pipe','pipe']` (REQ-RPC-1: stdin = RPC
 * commands, stdout = events, stderr = a captured pipe as before), drive it over
 * the `--mode rpc` protocol via `OrchestrateRpcClient`, and resolve a
 * `PiChildResult` once a qualifying terminal is reached AND the child has been
 * torn down (REQ-RPC-6). The node runner is the detached one; the pi child is
 * its supervised worker. Lineage / sink / inbox env are threaded via `spawnEnv`.
 *
 * RPC mode NEVER self-exits (rpc-mode.ts: `return new Promise(()=>{})`), so the
 * lifecycle anchor is the EVENT STREAM (a qualifying `agent_end{willRetry:false}`
 * raced with process exit/error + a liveness ceiling), NOT `child.on('close')`.
 * The RPC client attaches its stdout reader SYNCHRONOUSLY at construction
 * (before the first write) because the child stalls its loop on stdout
 * backpressure (REQ-RPC-2).
 *
 * `onSpawn` exposes the live `ChildProcess`; `onClient` exposes the live
 * `OrchestrateRpcClient` so spec 0013 node B's SteerableSession facade can hang
 * steer/cancel off it. Best-effort: a spawn error resolves to a `PiChildResult`
 * carrying `spawnError`, never throws into the caller.
 */
export function runPiChild(args: {
	command: string;
	argv: string[];
	cwd: string;
	/** The hosted agent's prompt, delivered on stdin as `{type:'prompt'}` (RPC). */
	task: string;
	spawnEnv?: Record<string, string | undefined>;
	onSpawn?: (child: ReturnType<typeof spawn>) => void;
	onClient?: (client: OrchestrateRpcClient) => void;
	/** Always-on structured childlog writer; raw frames are debug-only. */
	childLog?: ChildLogWriter;
	/** Test seam: liveness ceiling for the RPC client (REQ-RPC-10). */
	livenessCeilingMs?: number;
}): Promise<PiChildResult> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(args.spawnEnv ?? {}) };
			for (const [key, value] of Object.entries(childEnv)) {
				if (value === undefined) delete childEnv[key];
			}
			child = spawn(args.command, args.argv, {
				cwd: args.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: childEnv,
				windowsHide: true,
			});
		} catch (err) {
			// Synchronous spawn failure (rare). Resolve a clean failed PiChildResult.
			const message = err instanceof Error ? err.message : String(err);
			resolve({
				outcome: {
					finalText: "",
					toolStarts: [],
					usage: { turns: 0, input: 0, output: 0, cost: 0 },
					cleanStop: false,
					rawLines: [],
				},
				terminal: { kind: "failed", error: `failed to spawn pi child: ${message}` },
				reason: "process_exit",
				exitCode: null,
				stderr: "",
				spawnError: message,
			});
			return;
		}

		// Tee the stdout stream before constructing the client. The client still
		// owns terminal parsing; this observer only renders durable childlog lines.
		const detachChildLog = attachChildLogReader(child.stdout, args.childLog);
		// Construct the client SYNCHRONOUSLY (it attaches the stdout reader before
		// any write — the #1 hang guard, REQ-RPC-2), THEN expose the handles, THEN
		// send the initial prompt.
		const client = new OrchestrateRpcClient(child, {
			...(args.childLog?.file ? { childlogPath: args.childLog.file } : {}),
			...(args.livenessCeilingMs !== undefined
				? { livenessCeilingMs: args.livenessCeilingMs }
				: {}),
		});
		args.onSpawn?.(child);
		args.onClient?.(client);

		client.start(args.task);

		void client.waitForTerminal().then((driven) => {
			detachChildLog();
			if (driven.stderr) {
				args.childLog?.writeEvent(undefined, `pi.stderr ${JSON.stringify(driven.stderr)}`);
			}
			args.childLog?.writeEvent(
				{ type: "runner_terminal", terminal: driven.terminal.kind, reason: driven.reason },
			);
			args.childLog?.close();
			resolve({
				outcome: driven.outcome,
				terminal: driven.terminal,
				reason: driven.reason,
				exitCode: driven.exitCode,
				stderr: driven.stderr,
				...(driven.spawnError ? { spawnError: driven.spawnError } : {}),
			});
		});
	});
}

/**
 * Write a terminal result to BOTH the canonical result file and the pending
 * (hydrate-and-deliver) copy, atomically-ish (write to a tmp sibling, then
 * rename) so the parent's reaper never observes a half-written file.
 */
function writeResultFile(file: string, result: OrchestrateResult): void {
	// New wire writes always expose the canonical public mode. `readResultFile`
	// remains permissive for records written before the driver decision.
	result = { ...result, mode: "driver" };
	// Issue #8 — results carry the hosted agent's full output: private dir +
	// file, with chmod re-asserts since create modes are umask-masked and only
	// honoured on CREATE (same pattern as writeRouteRecord / the prompt file).
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(path.dirname(file), 0o700);
	} catch {
		/* best-effort on a pre-existing dir */
	}
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

function acquireTerminalPublishLock(cfg: OrchestrateCfg): OrchestrateRecoveryLock {
	// A control post holds this lock only around its synchronous terminal check +
	// request write. Waiting here orders publication before the final inbox drain:
	// an earlier accepted post is visible to the drain, while every later poster
	// sees the durable terminal result and refuses to enqueue.
	const wait = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		const lock = acquireOrchestrateRecoveryLock({ agentDir: cfg.agentDir, runId: cfg.runId });
		if (lock) return lock;
		// Never trade a valid terminal result for a synthetic runner-exited failure
		// merely because another live process is briefly in its critical section.
		// Complete locks owned by dead PIDs are reclaimed immediately by the lock
		// helper; demonstrably live owners retain exclusivity until they release.
		Atomics.wait(wait, 0, 0, 5);
	}
}

/** Write the result to the canonical result file + the pending copy. */
function emitResult(cfg: OrchestrateCfg, result: OrchestrateResult): void {
	const lock = acquireTerminalPublishLock(cfg);
	try {
		writeResultFile(cfg.resultFile, result);
		// Pending copy for hydrate-and-deliver: a foreground that was gone when the
		// child finished picks this up on next session_start. Best-effort — the
		// canonical result file is the source of truth for an active foreground.
		try {
			writeResultFile(cfg.pendingFile, result);
		} catch {
			/* best-effort */
		}
	} finally {
		releaseOrchestrateRecoveryLock(lock);
	}
}

/** Capture boot evidence from the created session + extensions result. */
function captureBootProof(
	session: AgentSession,
	extensionsResult: { extensions?: unknown[]; errors?: unknown[] } | undefined,
): OrchestrateBootProof {
	const errors: string[] = [];
	for (const e of extensionsResult?.errors ?? []) {
		errors.push(
			typeof e === "string" ? e : ((e as any)?.message ?? JSON.stringify(e)),
		);
	}
	return {
		booted: true,
		sessionFile: session.sessionFile ?? null,
		thinkingLevel: session.thinkingLevel,
		activeToolNames: [...session.getActiveToolNames()].sort(),
		extensionsLoaded: Array.isArray(extensionsResult?.extensions)
			? extensionsResult!.extensions!.length
			: 0,
		extensionErrors: errors,
	};
}

/**
 * `bootProofOnly` never calls a provider, but Pi still needs a reasoning model
 * in order not to clamp every requested thinking level to `off`. This local
 * model exists solely to exercise construction + extension lifecycle semantics
 * in the offline proof; production continues to resolve the configured model
 * through the real `pi --mode rpc` child.
 */
function createOfflineBootProofModel(): Model<"openai-responses"> {
	return {
		id: "pi-delegate-offline-reasoning",
		name: "Pi Delegate Offline Reasoning Proof",
		api: "openai-responses",
		provider: "pi-delegate-offline",
		baseUrl: "http://127.0.0.1/unused",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
		thinkingLevelMap: {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		},
	};
}

/**
 * Re-anchor the inherited cross-process lineage frame under THIS child's own
 * in-memory `rootSecret` (spec 0005 / REQ-ORCH-5).
 *
 * The parent ships the child's frame SIGNED by a fresh ephemeral Ed25519
 * PRIVATE key (`serializeLineageDetached`) plus the matching PUBLIC key,
 * because the child does NOT share the parent's `rootSecret`.
 * `deserializeLineageDetached` VERIFIES that signature with the public key and,
 * on success, recovers the child's TRUE inherited depth + headroom. The child
 * holds only the public key, so it cannot forge a frame — a mutated payload
 * fails verification and clamps. But the rest of the in-process machinery —
 * `runWithDepth` (depth-guard), the control-inbox auth, the event bus —
 * verifies frames under the in-process `rootSecret` (the spec-0003 model,
 * UNCHANGED). So once the signature gate has authenticated the inherited frame,
 * we re-serialize it with the child's OWN `serializeLineage` (keyed by the
 * child's own `rootSecret`) back into `process.env`. From that point the
 * standard `deserializeLineage(process.env)` seeding inside `runWithDepth`
 * reads an authentic-under-own-secret frame and grants the child its real
 * headroom — a recursive `delegate` from the hosted agent then bottoms out at
 * the inherited cap (≥ 3), not the clamp floor.
 *
 * No verified inherited frame (a bare boundary crossing, an absent/invalid
 * pubkey or signature) → leave `process.env` untouched: the existing
 * fail-closed clamp in `deserializeLineage` governs, exactly as before.
 * Mutating `process.env` in the child is safe — it is a short-lived,
 * single-purpose process we own.
 *
 * Returns the re-anchored frame's depth/cap for boot-proof diagnostics, or
 * `undefined` when no verified frame was inherited.
 */
export function reanchorInheritedLineage(
	env: Record<string, string | undefined> = process.env,
): { depth: number; effectiveMax: number } | undefined {
	const frame = deserializeLineageDetached(env);
	if (!frame) return undefined;
	// Re-serialize under the child's OWN rootSecret so in-process verifiers
	// (depth-guard / control-inbox / event-bus) treat the frame as authentic.
	const reAnchored = serializeLineage(frame);
	for (const [k, v] of Object.entries(reAnchored)) env[k] = v;
	return { depth: frame.depth, effectiveMax: frame.effectiveMax };
}

// ── Observability + control (spec 0005, node C) ─────────────────────────────

/**
 * Wrap-up steer text injected into the hosted agent when the foreground posts
 * a `cancel` control-request. Mirrors the worker wind-down contract (spec 0002
 * `WORKER_WIND_DOWN_STEER`): the agent is told to STOP and produce its final
 * answer within a bounded grace window. This is the ONLY forced-termination
 * path for a driver child — there is NO discretionary mid-pipeline
 * collapse and NO wall-clock hard-kill (REQ-ORCH-4).
 */
export const ORCHESTRATE_CANCEL_WIND_DOWN_STEER =
	"[wind-down] A cancel was requested for this driver run. Stop any in-progress " +
	"work, leave the journal/spec in a consistent state, and produce your final summary " +
	"NOW \u2014 this is a graceful wrap-up, not a discretionary stop. You have a brief grace " +
	"window before the session is closed.";

/** How often the runner polls the control inbox between pipeline steps (ms). */
export const CONTROL_POLL_INTERVAL_MS = 750;
/**
 * Grace window granted after a cancel's wind-down steer before the session is
 * aborted. Mirrors spec 0002's bounded grace: the agent gets a chance to land
 * a clean final answer; if it does not, the session is closed (graceful, not a
 * wall-clock kill of an otherwise-healthy pipeline).
 */
export const CANCEL_GRACE_MS = 15_000;

/**
 * The terminal STATES an orchestrate child can reach. There is deliberately NO
 * `collapsed` / discretionary-stop state — the only ways out are a real
 * pipeline outcome (`done` / `failed`) or a graceful, externally-requested
 * wind-down (`steered`). [decision: child-side-control-consumer-loop]
 */
export type OrchestrateTerminalKind = "done" | "failed" | "steered";

/**
 * Pure terminal-decision function (REQ-ORCH-4): map the pipeline's observed
 * outcome to a terminal result KIND. Exported + side-effect-free so a unit
 * test can assert the contract directly:
 *
 *   - the prompt threw                       → `failed`
 *   - a cancel wind-down fired               → `steered` (graceful)
 *   - the prompt resolved normally           → `done`
 *
 * Crucially there is NO branch that returns a terminal on a discretionary
 * mid-pipeline judgment or a wall-clock deadline — those inputs do not exist in
 * this signature, which is the structural guarantee that the runner cannot
 * collapse a healthy pipeline.
 */
export function decideTerminal(state: {
	errored: boolean;
	cancelWoundDown: boolean;
}): OrchestrateTerminalKind {
	if (state.errored) return "failed";
	if (state.cancelWoundDown) return "steered";
	return "done";
}

/**
 * Classify the terminal KIND for the runner's OUTER catch (REQ-ORCH-4).
 *
 * The runner's only forced-termination path is a cancel that injects a
 * wind-down steer and, after a bounded grace window, calls `session.abort()`.
 * That abort REJECTS the in-flight `session.prompt(cfg.task)`, so a graceful
 * wind-down that reaches its grace timeout does not return through the success
 * path — it throws into the outer catch. This helper is the single source of
 * truth shared by that catch (and a regression test), distinguishing:
 *
 *   - our deliberate cancel-grace abort (`abortWasCancelGrace` + a recorded
 *     `cancelWoundDown`) → the GRACEFUL `steered` terminal; and
 *   - any other thrown error (a genuine boot/pipeline failure, no cancel in
 *     play) → `failed`.
 *
 * Without this, the catch unconditionally reported `failed` and a graceful
 * cancel that timed out its grace window was mis-classified as a pipeline
 * failure — the bug REQ-ORCH-4 forbids.
 */
export function classifyCaughtTerminal(state: {
	abortWasCancelGrace: boolean;
	cancelWoundDown: boolean;
}): OrchestrateTerminalKind {
	const gracefulWindDown = state.abortWasCancelGrace && state.cancelWoundDown;
	return decideTerminal({
		errored: !gracefulWindDown,
		cancelWoundDown: state.cancelWoundDown,
	});
}

/**
 * The session surface the consumer loop drives. A real pi `AgentSession`
 * satisfies this structurally; a test passes a tiny stub. Kept minimal so the
 * consumer is testable without the SDK.
 */
export interface SteerableSession {
	isStreaming?: boolean;
	steer?: (text: string) => Promise<void> | void;
	/**
	 * Queue a message delivered after the agent finishes its current work
	 * (pi `AgentSession.followUp`). Used to actually PERSIST guidance into a
	 * non-streaming session rather than dropping it — so the consumer only
	 * reports "queued" when the message was genuinely enqueued.
	 */
	followUp?: (text: string) => Promise<void> | void;
	abort?: () => Promise<void> | void;
}

/** How a steer was (or was not) delivered into the session. */
export type SteerDelivery = "steered" | "queued" | "missed";

/**
 * Deliver guidance into a session (REQ-ORCH-3), reporting HOW it landed:
 *   - `steered`: the session was streaming and `steer()` interrupted the
 *     current turn (delivered before the next LLM call).
 *   - `queued`: the session was not streaming but `followUp()` PERSISTED the
 *     guidance for delivery after the agent's current work finishes.
 *   - `missed`: neither path was available (no `steer`/`followUp`, or both
 *     threw). A soft miss, not an error — mirrors the in-process runner's
 *     `onWindDownSteer` guard.
 *
 * The distinction matters: the consumer must NOT claim a non-streaming steer
 * was "queued" unless it was actually enqueued. `followUp` is pi's real
 * pending-guidance API, so we use it instead of silently dropping the message.
 */
async function trySteer(
	session: SteerableSession,
	text: string,
): Promise<SteerDelivery> {
	if (session.isStreaming && typeof session.steer === "function") {
		try {
			await session.steer(text);
			return "steered";
		} catch {
			/* fall through to the queue path — a failed live steer can still be
			 * persisted as a follow-up rather than dropped. */
		}
	}
	if (typeof session.followUp === "function") {
		try {
			await session.followUp(text);
			return "queued";
		} catch {
			return "missed";
		}
	}
	return "missed";
}

/**
 * Build the steer/cancel handlers the control consumer dispatches to
 * (`consumeControlRequests`). A `steer` injects the request's `message` as live
 * guidance into the hosted agent; a `cancel` injects the wind-down steer and
 * flips `onCancelWindDown` so the driver knows to grant the grace window and
 * then abort — the GRACEFUL terminal, never a hard mid-pipeline collapse
 * (REQ-ORCH-4).
 */
export function buildControlHandlers(args: {
	session: SteerableSession;
	onCancelWindDown: () => void;
	/** Canonical identity of this single driver entry; absent on legacy cfg records. */
	entryName?: string;
}): {
	onSteer: (req: ControlRequest) => Promise<{ ok: boolean; detail?: string }>;
	onCancel: (req: ControlRequest) => Promise<{ ok: boolean; detail?: string }>;
} {
	return {
		onSteer: async (req) => {
			const message =
				typeof req.payload?.message === "string" ? req.payload.message : "";
			if (!message)
				return { ok: false, detail: "steer request had no message" };
			const delivery = await trySteer(args.session, message);
			switch (delivery) {
				case "steered":
					return { ok: true, detail: "steered" };
				case "queued":
					// Genuinely persisted via followUp — honestly claim queuing.
					return { ok: true, detail: "queued (delivered after current turn)" };
				default:
					// Soft miss: the guidance could NOT be persisted (no steer/followUp
					// surface). Do NOT claim it was queued — report the miss honestly so
					// the foreground knows the steer did not land.
					return {
						ok: false,
						detail: "not delivered (session exposes no steer/followUp surface)",
					};
			}
		},
		onCancel: async (req) => {
			const requestedEntry = req.payload?.forkName;
			if (requestedEntry !== undefined) {
				if (typeof requestedEntry !== "string" || requestedEntry.length === 0) {
					return { ok: false, detail: "cancel request had an invalid entry name" };
				}
				if (args.entryName === undefined) {
					return { ok: false, detail: "exact entry cancellation is unavailable for this legacy driver" };
				}
				if (requestedEntry !== args.entryName) {
					return { ok: false, detail: `entry ${JSON.stringify(requestedEntry)} not found` };
				}
			}
			// Graceful wind-down: steer a wrap-up instruction and signal the driver
			// to grant the grace window + abort. We DO NOT abort synchronously here
			// — that would be the discretionary hard-kill REQ-ORCH-4 forbids.
			await trySteer(args.session, ORCHESTRATE_CANCEL_WIND_DOWN_STEER);
			args.onCancelWindDown();
			return { ok: true, detail: "winding down (graceful)" };
		},
	};
}

/**
 * Resolve the frame the child uses to emit bus events + poll the control
 * inbox. After `reanchorInheritedLineage` the inherited frame is re-MAC'd under
 * THIS process's own `rootSecret` and written into `process.env`, so
 * `deserializeLineage(process.env)` recovers an authentic in-process frame
 * whose cap-token `verifyCapToken` accepts (auth is NOT bypassed). Returns
 * `undefined` for a genuine top-level child with no inherited lineage — emits
 * + polls then no-op (best-effort).
 */
export function resolveChildFrame(
	env: Record<string, string | undefined> = process.env,
): DepthFrame | undefined {
	return deserializeLineage(env);
}

/**
 * One control-consumer step the runner schedules on an interval between
 * pipeline steps (REQ-ORCH-3): poll the inbox for AUTHENTICATED requests
 * addressed to `frame` and dispatch each to the steer/cancel handlers. Thin
 * wrapper over `consumeControlRequests` so the runner has a single call site;
 * exported for direct testing. Best-effort: a poll failure resolves to `[]`.
 */
export async function runControlConsumerStep(args: {
	agentDir: string;
	frame: DepthFrame;
	session: SteerableSession;
	onCancelWindDown: () => void;
	/** Canonical identity of this single driver entry; absent on legacy cfg records. */
	entryName?: string;
	/**
	 * This child's OWN per-run control secret (spec 0009, REQ-CTRL-4), read from
	 * its spawn env (`CONTROL_SECRET_ENV`, provisioned by node A). Threaded to
	 * `consumeControlRequests` so a DETACHED foreground steer/cancel presenting a
	 * matching secret authenticates alongside the in-process cap-token path.
	 * Absent for a genuine top-level child (no detached control credential).
	 */
	controlSecret?: string;
	now?: number;
}): Promise<ConsumedControl[]> {
	const handlers = buildControlHandlers({
		session: args.session,
		onCancelWindDown: args.onCancelWindDown,
		...(args.entryName !== undefined ? { entryName: args.entryName } : {}),
	});
	return consumeControlRequests({
		agentDir: args.agentDir,
		frame: args.frame,
		handlers,
		...(args.controlSecret !== undefined ? { controlSecret: args.controlSecret } : {}),
		...(args.now !== undefined ? { now: args.now } : {}),
	});
}

/** Best-effort bus emit keyed to the child's frame (no-op without a frame). */
function emitBus(
	agentDir: string,
	frame: DepthFrame | undefined,
	kind: "started" | "updated" | "completed",
	fields?: Record<string, unknown>,
): void {
	if (!frame) return;
	appendBusEvent({ agentDir, frame }, { kind, ...(fields ? { fields } : {}) });
}

interface DetachedTaskState {
	readonly progress: TaskProgressFields;
	readonly ledger: TaskLedger;
}

/** Read the latest task snapshot emitted by the authoritative RPC child. */
function readDetachedTaskState(cfg: OrchestrateCfg, frame: DepthFrame | undefined): DetachedTaskState | undefined {
	if (!frame || cfg.tasks === undefined) return undefined;
	const taskAttempt = detachedTaskAttempt(cfg);
	const emitterPath = lineagePath(frame);
	const candidates = readBusEvents(cfg.agentDir, frame.rootRunId)
		.filter((event) =>
			event.lineagePath === emitterPath &&
			event.fields?.[TASK_ATTEMPT_FIELD] === taskAttempt,
		)
		.sort((left, right) => left.ts - right.ts);
	let progress: TaskProgressFields | undefined;
	let ledger: TaskLedger | undefined;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const fields = candidates[index]?.fields;
		progress ??= readTaskProgressFields(fields);
		if (ledger === undefined && fields && typeof fields === "object") {
			ledger = parseTaskLedger((fields as Record<string, unknown>)[TASK_LEDGER_FIELD]);
		}
		if (progress && ledger) return { progress, ledger };
	}
	return progress && ledger ? { progress, ledger } : undefined;
}

// ── pi-child supervision: lineage env + control consumer + graceful cancel ───
//
// Node A ran the pi child BARE (no control consumer, no lineage env on the
// child, no event emits bracketing the run). Node B re-integrates spec 0005's
// supervision substrate AROUND the pi child:
//   1. the lineage/sink/inbox env so the child + ITS grandchildren chain
//      depth/cap and route liveness/control to the same root (REQ-PICLI-6),
//   2. the control-consumer loop wrapping the running child (REQ-PICLI-5),
//   3. graceful cancel of the pi child (SIGTERM → grace → SIGKILL → `steered`).

/**
 * The agent-dir env var the pi CLI's `getAgentDir()` reads
 * (`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, default `PI_CODING_AGENT_DIR`).
 * Set on the child's spawn env so its delegate extension resolves the SAME
 * `agentDir` — and therefore the SAME event-sink + control-inbox roots
 * (`<agentDir>/extensions/pi-delegate/event-bus/<rootRunId>/…`) — that this
 * runner uses. Combined with the inherited `rootRunId` from the lineage env,
 * this completes the sink/inbox routing for the child's grandchildren
 * (REQ-PICLI-6). The literal is the documented default; the codebase never
 * overrides `APP_NAME`, and the SDK does not re-export the constant from its
 * package entry (only the deep `dist/config.js`, which package `exports`
 * blocks), so we name it explicitly rather than via a fragile deep import.
 */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Build the spawn env for the pi child (REQ-PICLI-6). Merges, over the inherited
 * environment that `runPiChild` spreads from `process.env`:
 *   - the Ed25519-signed DETACHED lineage env for the authentic `frame`
 *     (`serializeLineageDetached`) so the child — and its OWN nested
 *     sub-dispatches via the delegate extension — recover the real inherited
 *     depth/cap across the process boundary (the verify happens when delegate
 *     loads in the child; spec 0005 / REQ-ORCH-5). Only the derived per-path
 *     key crosses the boundary — NEVER `rootSecret`.
 *   - `PI_AGENT_DIR_ENV = cfg.agentDir` so the child's delegate extension
 *     routes its grandchildren's event-sink + control-inbox writes to the SAME
 *     `<agentDir>/…/<rootRunId>/…` root this runner observes.
 *   - `PI_DELEGATE_CHILD: "1"` — node A's defense-in-depth child guard (kept).
 *
 * `frame` is `undefined` for a genuine top-level child with no inherited
 * lineage → no lineage env is set (the child seeds a fresh root), but the
 * agent-dir + child-guard vars are still applied.
 */
function detachedTaskAttempt(cfg: Pick<OrchestrateCfg, "restartAttempts">): number {
	const attempt = cfg.restartAttempts ?? 0;
	if (!Number.isSafeInteger(attempt) || attempt < 0) {
		throw new Error("driver cfg restartAttempts must be a non-negative safe integer");
	}
	return attempt;
}

export function buildPiChildSpawnEnv(
	cfg: OrchestrateCfg,
	frame: DepthFrame | undefined,
	thinkingPolicy?: SessionThinkingPolicy,
	thinkingPolicyRequirements?: DetachedThinkingPolicyRequirements,
	workerToolScope?: DetachedWorkerToolScopeEnvelope,
): Record<string, string | undefined> {
	return {
		...spawnEnvPatch(cfg.env),
		PI_DELEGATE_CHILD: "1",
		[PI_AGENT_DIR_ENV]: cfg.agentDir,
		// Owner attribution is trusted cfg metadata, not lineage authority. Put it
		// on the delegate-owned child spawn after public cfg.env is merged.
		[ORCHESTRATE_OWNER_SESSION_ENV]: cfg.ownerSessionId,
		...(cfg.tasks
			? {
					[TASKS_SEED_ENV]: JSON.stringify(cfg.tasks),
					[TASK_ATTEMPT_ENV]: String(detachedTaskAttempt(cfg)),
				}
			: { [TASKS_SEED_ENV]: undefined, [TASK_ATTEMPT_ENV]: undefined }),
		...(frame ? serializeLineageDetached(frame) : {}),
		// Explicitly clear inherited child policies when this child does not
		// carry the corresponding live selector contract.
		[DETACHED_THINKING_POLICY_ENV]: thinkingPolicy
			? JSON.stringify({
					...thinkingPolicy,
					...(thinkingPolicyRequirements
						? { detachedRequirements: thinkingPolicyRequirements }
						: {}),
				})
			: undefined,
		[DETACHED_WORKER_TOOL_SCOPE_ENV]: workerToolScope
			? JSON.stringify(workerToolScope)
			: undefined,
		// Explicit scopes retain native Pi tools; Fabric full-code mode hides
		// them and its provider calls bypass the worker's native tool veto.
		PI_FABRIC_FULL_CODE_MODE: resolveCfgHasExplicitAllowlist(cfg) ? "false" : undefined,
		PI_FABRIC_TOOL_ALLOWLIST: undefined,
	};
}

/**
 * Adapt the PERSISTENT `OrchestrateRpcClient` to the `SteerableSession` surface
 * the control consumer drives (`buildControlHandlers` / `runControlConsumerStep`).
 *
 * Spec 0013 node B: the orchestrate child now speaks `pi --mode rpc` with a
 * LIVE stdin channel (`['pipe','pipe','pipe']`), so a delivered steer ACTUALLY
 * interrupts the running child mid-turn — the payoff the originally-failing
 * "NOT STEERED" gate demanded. This facade is THIN: it holds no state of its
 * own; everything reads through the shared client (which owns the live
 * `child.stdin` + the `isStreaming` flag derived from `agent_start`/`agent_end`
 * on the event stream). It MUST be built over the SAME persistent client across
 * every control-tick — never reconstructed per-tick (REQ-RPC-8) — because the
 * RPC channel + turn-state cannot survive reconstruction.
 *
 * The surface:
 *   - `isStreaming` → `client.isStreaming` (REQ-RPC-8): true between an
 *     `agent_start` and its matching `agent_end`. `trySteer` reads this to
 *     decide live-steer vs follow_up. NO `get_state` round-trip per tick.
 *   - `steer(text)` → `client.steer(text)` writes `{type:'steer', message}` to
 *     stdin (REQ-RPC-7), interrupting the in-flight turn. `trySteer` only calls
 *     this when `isStreaming` is true. EPIPE-safe (the client's `send` returns
 *     false on a dead pipe, never throws). If the write fails on a dead pipe it
 *     throws here so `trySteer` falls through to its follow_up path rather than
 *     falsely reporting a live steer.
 *   - `followUp(text)` → `client.followUp(text)` writes `{type:'follow_up'}`
 *     (REQ-RPC-7): genuine queuing for delivery after the current work. We do
 *     NOT promote an idle steer to a follow_up at the facade level — `trySteer`
 *     owns that policy, and an idle follow_up only enqueues without a trigger;
 *     the truly-terminal case is the spec-0009 drain's job. A failed write
 *     throws so `trySteer` reports an honest miss instead of a false queue.
 *   - `abort()` → the DOUBLE-PATH wind-down (REQ-RPC-7, decision
 *     abort-is-double-path-command-then-signal): FIRST write the in-protocol
 *     `{type:'abort'}` (graceful, EPIPE-safe — never throws/rejects), THEN the
 *     bounded SIGTERM→SIGKILL signal backstop on the live child process
 *     (preserving spec-0007-B's `terminated`-gate + `hasExited()`). NEVER
 *     rejects the runner — a throw would orphan the detached child.
 */
export function buildPiChildSteerableSession(
	client: Pick<
		OrchestrateRpcClient,
		"isStreaming" | "childProcess" | "steer" | "followUp" | "abort"
	>,
	opts: { sigkillBackstopMs?: number } = {},
): SteerableSession {
	const backstopMs = opts.sigkillBackstopMs ?? 5_000;
	const child = client.childProcess;
	// REAL exit detection (REQ-RPC-7 / spec-0007-B `hasExited()` gate): Node sets
	// `child.killed = true` when a signal is successfully SENT, NOT when the
	// process exits. So `killed` must NOT gate the SIGKILL backstop — a child
	// that IGNORES SIGTERM has killed===true, exitCode===null, and would never
	// be SIGKILLed. The only sound "has it actually exited?" signal is
	// `exitCode !== null || signalCode != null` (a real ChildProcess sets one).
	const hasExited = (): boolean =>
		child.exitCode !== null ||
		(child as { signalCode?: string | null }).signalCode != null;
	return {
		// Live, derived from the stream (REQ-RPC-8) — `trySteer` reads this to
		// decide whether a steer interrupts the turn or routes to follow_up.
		get isStreaming(): boolean {
			return client.isStreaming;
		},
		steer(text: string) {
			// `trySteer` gates this on `isStreaming`; write the in-protocol steer.
			// A dead-pipe write returns false (EPIPE-safe) — throw so `trySteer`
			// falls through to follow_up rather than falsely reporting `steered`.
			if (!client.steer(text)) {
				throw new Error("steer write failed (stdin not writable)");
			}
		},
		followUp(text: string) {
			// Genuine queuing via `{type:'follow_up'}`. A dead-pipe write returns
			// false — throw so `trySteer` reports an honest miss, never a false
			// "queued".
			if (!client.followUp(text)) {
				throw new Error("follow_up write failed (stdin not writable)");
			}
		},
		abort() {
			// DOUBLE PATH (REQ-RPC-7): (1) in-protocol graceful `{type:'abort'}` —
			// EPIPE-safe, never throws (the client's `send` swallows a dead pipe).
			// (2) THEN the bounded SIGTERM→SIGKILL signal backstop. The command may
			// cause the child to emit a final `agent_end`; the runner's
			// `cancelWoundDown=steered` precedence (set before this fires) wins over
			// that classification.
			client.abort();

			// Signal backstop. Already exited → nothing to signal.
			if (hasExited()) return;
			try {
				child.kill("SIGTERM");
			} catch {
				/* best-effort — must never reject the runner / orphan the child */
			}
			// SIGKILL backstop: if the child has NOT actually exited after a
			// bounded window (it ignored SIGTERM + the stdin `{abort}`), force it.
			// Keyed on real exit (exitCode/signalCode), NOT `killed` (already true
			// from the SIGTERM above). Unref'd so it never keeps the event loop
			// alive past a clean exit.
			const killTimer = setTimeout(() => {
				if (hasExited()) return;
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}, backstopMs);
			if (typeof killTimer.unref === "function") killTimer.unref();
		},
	};
}

/**
 * The persistent-client surface `supervisePiChild` drives. Spec 0013 node B:
 * the supervisor OWNS the single `OrchestrateRpcClient` for the run (delivered
 * via `runPiChild`'s `onClient` seam), and builds ONE SteerableSession facade
 * over it that is reused across every control-tick — NOT reconstructed per-tick
 * (REQ-RPC-8), because the RPC channel + turn-state cannot survive
 * reconstruction. This is the minimal slice the facade reads.
 */
export type SupervisedRpcClient = Pick<
	OrchestrateRpcClient,
	"isStreaming" | "childProcess" | "steer" | "followUp" | "abort"
>;

/**
 * Wrap a RUNNING pi child with the spec-0005 supervision substrate
 * (REQ-PICLI-5 / REQ-RPC-8): emit a `started` liveness event, run the
 * control-consumer loop on a bounded interval (steer → interrupt the live turn
 * over RPC; cancel → graceful in-protocol abort + SIGTERM-grace-SIGKILL
 * wind-down), emit periodic `updated` phase events so the foreground observes
 * progress (and the spec-0004 false-cancel suppression sees a busy pipeline),
 * and tear down all timers on terminal. Returns whether a graceful cancel
 * wound the child down, so the caller maps the terminal to `steered` (a
 * graceful `done`), NOT `failed`.
 *
 * `childRun` is the in-flight `runPiChild` promise; `getClient` returns the live
 * PERSISTENT `OrchestrateRpcClient` once `onClient` has fired (it may be
 * `undefined` for the brief window before spawn, or in a spawn-failure). The
 * SteerableSession facade over that client is built ONCE — the first tick the
 * client is available — and held for the run (REQ-RPC-8): the live `child.stdin`
 * + the `isStreaming` flag derived from the event stream cannot be
 * reconstructed per-tick. Best-effort throughout: a poll or emit failure never
 * wedges or fails the pipeline (REQ-BUS-4).
 */
export async function supervisePiChild(args: {
	agentDir: string;
	frame: DepthFrame | undefined;
	/** The live persistent RPC client once `onClient` has fired (REQ-RPC-8). */
	getClient: () => SupervisedRpcClient | undefined;
	childRun: Promise<PiChildResult>;
	/** Canonical identity of this single driver entry; absent on legacy cfg records. */
	entryName?: string;
	pollIntervalMs?: number;
	graceMs?: number;
	/** Bounded SIGKILL backstop window for the facade's signal teardown (tests). */
	sigkillBackstopMs?: number;
	/**
	 * This run's per-run control secret (spec 0009, REQ-CTRL-4) so a DETACHED
	 * foreground steer/cancel authenticates alongside the cap-token path.
	 * Defaults to the spawn-env value (`CONTROL_SECRET_ENV`, provisioned by node
	 * A); a test may inject it directly. `undefined`/absent → cap-token-only.
	 */
	controlSecret?: string;
	now?: () => number;
}): Promise<{ result: PiChildResult; cancelWoundDown: boolean }> {
	const { agentDir, frame, getClient, childRun } = args;
	const pollIntervalMs = args.pollIntervalMs ?? CONTROL_POLL_INTERVAL_MS;
	const graceMs = args.graceMs ?? CANCEL_GRACE_MS;
	const facadeOpts =
		args.sigkillBackstopMs !== undefined
			? { sigkillBackstopMs: args.sigkillBackstopMs }
			: {};
	// The detached child reads its OWN control secret from the spawn env node A
	// injected (`CONTROL_SECRET_ENV`). A caller may override (tests). An absent
	// secret leaves the consumer cap-token-only — unchanged from before spec 0009.
	const controlSecret = args.controlSecret ?? process.env[CONTROL_SECRET_ENV];

	let cancelWoundDown = false;
	let graceTimer: NodeJS.Timeout | undefined;
	let consumerTimer: NodeJS.Timeout | undefined;
	// `terminated` gates LATE work (REQ-PICLI-5 race fix): once the child has
	// resolved we stop launching new polls AND reject any cancel handler that an
	// in-flight poll fires afterward, so no `graceTimer` is ever armed after the
	// `finally` cleared timers, and no post-terminal signal is sent.
	let terminated = false;
	// In-flight consumer-step promises — awaited (drained) before returning so a
	// cancel being authenticated/handled as `childRun` resolves still flips
	// `cancelWoundDown` BEFORE the terminal classification is read.
	const inFlight = new Set<Promise<unknown>>();

	// The PERSISTENT SteerableSession facade (REQ-RPC-8). Built ONCE — the first
	// time `getClient()` yields the live client — and held for the run, so the
	// RPC channel (live stdin) + the stream-derived `isStreaming` flag survive
	// across every control-tick. NEVER reconstructed per-tick. A no-op session
	// covers the brief pre-spawn window (so a cancel still flips the wind-down
	// flag), and is replaced by the real facade as soon as the client is live.
	let session: SteerableSession | undefined;
	const ensureSession = (): SteerableSession => {
		if (session) return session;
		const client = getClient();
		if (client) {
			session = buildPiChildSteerableSession(client, facadeOpts);
		} else {
			// Before spawn: a no-op session so a cancel still flips the wind-down
			// flag. NOT cached — the real facade is built once the client is live.
			return { isStreaming: false } as SteerableSession;
		}
		return session;
	};

	// A cancel control-request → GRACEFUL wind-down: grant a bounded grace
	// window, THEN the facade's double-path abort (in-protocol `{type:'abort'}`
	// + a bounded SIGTERM→SIGKILL signal backstop). This is the ONLY
	// forced-termination path — no discretionary collapse, no wall-clock
	// hard-kill (REQ-PICLI-5/REQ-ORCH-4/REQ-RPC-7).
	const onCancelWindDown = () => {
		if (cancelWoundDown) return; // idempotent — first cancel wins
		cancelWoundDown = true;
		// A cancel observed AFTER terminal still flips the flag (so a cancel that
		// races the child's own exit is honored as `steered`), but must NOT arm a
		// post-terminal grace timer / signal a dead child.
		if (terminated) return;
		emitBus(agentDir, frame, "updated", { phase: "cancel-wind-down" });
		graceTimer = setTimeout(() => {
			// Use the SAME persistent facade the ticks drive (REQ-RPC-8) so the
			// abort writes the in-protocol `{type:'abort'}` over the live stdin
			// THEN signals — never a freshly-reconstructed stateless session. No
			// live client yet (never spawned / already gone) → the wind-down flag
			// alone maps the terminal to `steered`.
			if (!getClient()) return;
			try {
				ensureSession().abort?.();
			} catch {
				/* best-effort — must never reject the runner / orphan the child */
			}
		}, graceMs);
		if (typeof graceTimer.unref === "function") graceTimer.unref();
	};

	if (frame) {
		const tick = () => {
			// Don't launch new polls once the child has resolved.
			if (terminated) return;
			// Periodic `updated` so a quiet-but-busy pipeline is observably alive
			// (REQ-PICLI-5; the spec-0004 readDescendantActivity fix reads these).
			emitBus(agentDir, frame, "updated", { phase: "running" });
			// The PERSISTENT facade (REQ-RPC-8) — built once, reused every tick.
			const tickSession = ensureSession();
			const step = runControlConsumerStep({
				agentDir,
				frame,
				session: tickSession,
				onCancelWindDown,
				...(args.entryName !== undefined ? { entryName: args.entryName } : {}),
				...(controlSecret !== undefined ? { controlSecret } : {}),
				...(args.now ? { now: args.now() } : {}),
			}).catch(() => {
				/* consumer step is best-effort; never wedge the pipeline */
			});
			// Track the in-flight poll so terminal-time draining can await a
			// cancel that is mid-authentication when `childRun` resolves.
			inFlight.add(step);
			void step.finally(() => inFlight.delete(step));
		};
		consumerTimer = setInterval(tick, pollIntervalMs);
		if (typeof consumerTimer.unref === "function") consumerTimer.unref();
	}

	try {
		const result = await childRun;
		// Child resolved: stop new polls, then DRAIN any in-flight poll so a
		// cancel it is handling flips `cancelWoundDown` before we read it. The
		// `terminated` flag (set before the drain) makes `onCancelWindDown` skip
		// arming a post-terminal grace timer while still recording the wind-down.
		terminated = true;
		if (consumerTimer) clearInterval(consumerTimer);
		if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		return { result, cancelWoundDown };
	} finally {
		terminated = true;
		if (consumerTimer) clearInterval(consumerTimer);
		if (graceTimer) clearTimeout(graceTimer);
	}
}

/**
 * Final control-inbox drain at the child's TERMINAL transition (spec 0009,
 * REQ-CTRL-7 — THE AUTHORITY). [decision: terminality-authority-child-side-drain]
 *
 * The child OWNS the live control channel (the
 * nicobailon-`subagent-executor.ts:475` invariant), so it — not the poster — is
 * the authority on terminal-run-steer correctness. On the terminal transition
 * the runner performs, IN THIS ORDER:
 *
 *   (1) record its terminal marker  — the result FILE (`emitResult`), written
 *       inside `runOrchestrateChild` BEFORE this drain is called;
 *   (2) THIS final drain             — one last `pollControlRequests` pass that
 *       REJECTS every still-pending request addressed to this child with
 *       `{ ok: false, detail: 'already terminal' }`, never APPLYING it;
 *   (3) exit                         — the caller (`main`) `process.exit`s after
 *       this returns.
 *
 * Why this is load-bearing: `consumeControlRequests` has NO terminal gate — it
 * dispatches every authenticated request unconditionally. Without this final
 * pass, a steer/cancel posted during the wind-down / terminal window (after the
 * supervisor loop stopped polling but before the process exits) would LEAK in
 * the `requests/` dir forever AND the foreground's `awaitControlResult` (5s)
 * would time out ambiguously (no result ever written). The measurable bound on
 * the leak window is `CONTROL_POLL_INTERVAL_MS` — a request posted within one
 * poll interval of terminal is caught by this drain.
 *
 * AUTH is NOT bypassed: `pollControlRequests` still verifies each request's cap
 * token / control secret against `frame` and only returns AUTHENTICATED requests
 * addressed to THIS child; a request that fails auth is rejected there (its own
 * `{ ok:false }` result) and never reaches this loop. This drain then rejects
 * the authenticated-but-too-late requests with the terminal detail, so the
 * poster's await terminates cleanly instead of hanging.
 *
 * Best-effort (REQ-BUS-4): a poll/write failure is swallowed; never throws into
 * the exit path. Returns the count rejected (diagnostics / tests). A no-op when
 * `frame` is undefined (a genuine top-level child has no control channel).
 */
export function drainControlRequestsAtTerminal(args: {
	agentDir: string;
	frame: DepthFrame | undefined;
	controlSecret?: string;
	now?: number;
}): number {
	const { agentDir, frame } = args;
	// CONTRACT (issue #8 nit): an `undefined` frame is a deliberate NO-OP, not
	// an error. A genuine top-level child (no inherited lineage) — or a crash
	// so early that `reanchorInheritedLineage` never ran — has no lineage path
	// to poll, and therefore no addressable inbox to drain. Callers rely on
	// being able to call this unconditionally on every exit path.
	if (!frame) return 0;
	// The child reads its OWN secret from the spawn env unless overridden (tests).
	const controlSecret = args.controlSecret ?? process.env[CONTROL_SECRET_ENV];
	let rejected = 0;
	try {
		const pending = pollControlRequests({
			agentDir,
			frame,
			...(controlSecret !== undefined ? { controlSecret } : {}),
			...(args.now !== undefined ? { now: args.now } : {}),
		});
		for (const req of pending) {
			// A request observed AFTER the terminal marker is REJECTED, never applied
			// (REQ-CTRL-7): write a terminal-rejection result so the poster's await
			// resolves, and do NOT dispatch it to any steer/cancel handler.
			writeControlResult({
				agentDir,
				frame,
				id: req.id,
				ok: false,
				detail: "already terminal",
				...(args.now !== undefined ? { now: args.now } : {}),
			});
			rejected++;
		}
	} catch {
		/* best-effort; the exit path must never be wedged by the drain */
	}
	return rejected;
}

/**
 * Boot a real session for the cfg, run the hosted agent's task to terminal (or
 * stop at boot in `bootProofOnly` mode), and write the terminal result.
 *
 * Exported for direct (in-process) testing of the boot + result round-trip
 * without re-spawning; the integration test exercises the REAL detached path.
 */
export async function runOrchestrateChild(
	cfg: OrchestrateCfg,
): Promise<OrchestrateResult> {
	const agentDir = cfg.agentDir;

	// Re-anchor the inherited cross-process lineage frame BEFORE any depth-
	// guarded work, so a recursive `delegate` the hosted agent's pi child runs
	// sees the child's REAL inherited cap (≥ 3) rather than the cross-process
	// clamp floor (spec 0005 / REQ-ORCH-5). No-op when no verified frame was
	// inherited. The re-anchored env is read by node B when it threads lineage
	// onto the pi child's spawn env.
	reanchorInheritedLineage();

	// The frame the child emits bus events from + polls the control inbox with
	// (REQ-ORCH-3). Resolved AFTER reanchor so it is authentic under THIS
	// process's rootSecret. `undefined` for a genuine top-level child → emits
	// no-op (best-effort).
	const frame = resolveChildFrame();
	// Childlogs are always enabled; PI_DELEGATE_DEBUG only adds raw frames.
	const childLog = createChildLogWriter(
		resolveOrchestrateLogsDir(agentDir),
		cfg.runId,
	);
	childLog?.writeEvent({ type: "runner_start", runId: cfg.runId });

	// ── bootProofOnly: OFFLINE self-test ONLY (no longer the production path) ──
	// Boots a REAL in-process session + loads extensions WITHOUT a model call,
	// proving the cross-process boot + extension-load + file round-trip
	// deterministically and offline. The production hosted-agent run is the pi
	// CLI subprocess below. [decision: bootproof-kept-as-offline-selftest]
	if (cfg.bootProofOnly) {
		try {
			const result = await runBootProofSelfTest(cfg);
			childLog?.writeEvent({ type: "runner_terminal", terminal: result.status });
			return result;
		} finally {
			childLog?.close();
		}
	}

	// ── Production path: spawn a FRESH `pi --mode rpc` CLI subprocess ──
	// (REQ-PICLI-1 / spec-0013) so pi's NATIVE bootstrap owns auth + model +
	// provider resolution, and the RPC stdin channel carries the prompt + live
	// steer/follow_up/abort. The detached node runner is the long-lived process; the pi
	// child is its supervised worker.
	try {
		emitBus(agentDir, frame, "started", {
			agent: cfg.agentName,
			runId: cfg.runId,
			phase: "boot",
		});

		// Preflight with the same policy-aware loader/tool-surface path as
		// in-process workers. Portable include/exclude selection happens before
		// factories run; exact ext: tools and bounded thinking are then resolved
		// together against that selected set.
		const hostedAgent = cfgToAgentConfig(cfg);
		const hostedSurface = reconstructOrchestrateToolSurface(cfg);
		for (const d of hostedSurface.diagnostics)
			logDelegateDiagnostic(d, { agentDir: cfg.agentDir, throttleKey: "tool-surface" });
		assertValidExtensionToolSelectors(hostedSurface);
		const policySelection = await resolveAndValidateOrchestrateExtensionPolicy(
			cfg,
			hostedAgent,
			hostedSurface,
		);

		const hasThinkingBounds = Boolean(cfg.thinkingMin || cfg.thinkingMax);
		const needsResourcePreflight = hostedSurface.extSelectors.length > 0 || hasThinkingBounds || cfg.tasks !== undefined;
		const prepareResources = () => prepareWorkerSessionResources(
			hostedAgent,
			{ cwd: cfg.cwd, agentDir: cfg.agentDir },
			hostedSurface,
		);
		const preparedResources = !needsResourcePreflight
			? undefined
			: cfg.tasks !== undefined
				? await withTrustedEnvOverrides(
					{
						PI_DELEGATE_CHILD: "1",
						[PI_AGENT_DIR_ENV]: cfg.agentDir,
						[TASKS_SEED_ENV]: JSON.stringify(cfg.tasks),
					},
					prepareResources,
				)
				: await prepareResources();
		// Inline policy emitters exist only in this host-side preflight. The real
		// child receives policy through the versioned environment bridge, so only
		// concrete extension entrypoints may become child `-e` arguments.
		const selectedExtensionPaths = preparedResources
			? [
					...new Set(
						preparedResources.loader
							.getExtensions()
							.extensions.filter((extension) => !extension.path.startsWith("<inline:"))
							.map((extension) => extension.resolvedPath),
					),
				]
			: policySelection
				? [...new Set(policySelection.selected.map((candidate) => candidate.path))]
				: cfg.extensions;
		const delegateSelfAlreadySelected = selectedExtensionPaths?.some(
			(extensionPath) => extensionPathProvidesDelegateOwner(extensionPath, cfg.cwd),
		) ?? false;
		const effectiveHostedSurface = preparedResources?.surface ?? hostedSurface;
		const liveToolScope = preparedResources?.toolScope.dynamic ? preparedResources.toolScope : undefined;
		// Keep the stable requested surface in the child. The live bridge, not a
		// construction-time tool snapshot, resolves extension membership. A static
		// explicit allowlist is widened for this dispatch-created obligation even
		// when the claimant registers lazily; dynamic ext: scopes must select it.
		const effectiveRequestedToolNames = effectiveHostedSurface.tools ?? cfg.tools;
		const requestedToolNames = liveToolScope
			? cfg.tasks !== undefined && !hostedSurface.tools?.includes("session_tasks")
				? effectiveRequestedToolNames?.filter((name) => name !== "session_tasks")
				: effectiveRequestedToolNames
			: cfg.tools;
		const selectedToolNames = cfg.tasks !== undefined && !liveToolScope && requestedToolNames
			? [...new Set([...requestedToolNames, "session_tasks"])]
			: requestedToolNames;
		const thinkingPolicyContext = preparedResources?.thinkingPolicyContext;
		const providerPresent = thinkingPolicyContext?.assertCompatible(
			preparedResources!.loader.getExtensions(),
		) ?? false;
		const adaptiveProvider = thinkingPolicyContext
			? preparedResources!.loader
					.getExtensions()
					.extensions.find((extension) => extension.tools.has("set_thinking_effort"))
			: undefined;
		const selectedThinkingTool = selectedToolNames?.includes("set_thinking_effort") === true ||
			effectiveHostedSurface.extSelectors.some((selector) => selector.tool === "set_thinking_effort") ||
			liveToolScope?.currentActiveToolNames().includes("set_thinking_effort") === true;
		const hostedCfg: OrchestrateCfg = {
			...cfg,
			...(selectedExtensionPaths ? { extensions: selectedExtensionPaths } : {}),
			...(selectedToolNames ? { tools: selectedToolNames } : {}),
			...(liveToolScope
				? { extensionToolSelectors: [...effectiveHostedSurface.extSelectors] }
				: { extensionToolSelectors: undefined }),
			...(delegateSelfAlreadySelected ? { delegateSelfAlreadySelected: true } : {}),
		};

		const sessionDir = buildWorkerSessionDir(cfg.agentDir);
		const built = buildOrchestratePiArgs(hostedCfg, { sessionDir });
		let workerToolScopeEnvelope: DetachedWorkerToolScopeEnvelope | undefined;
		let thinkingPolicyRequirements: DetachedThinkingPolicyRequirements | undefined;
		try {
			const staticTaskToolScope = cfg.tasks !== undefined && !liveToolScope &&
				selectedToolNames?.includes("session_tasks")
				? preparedResources?.toolScope
				: undefined;
			const staticExplicitToolScope = !liveToolScope &&
				!staticTaskToolScope &&
				effectiveHostedSurface.hasExplicitAllowlist
				? prepareWorkerToolScope({ ...effectiveHostedSurface, tools: selectedToolNames }, [])
				: undefined;
			const childToolScopeBase = liveToolScope ?? staticTaskToolScope ?? staticExplicitToolScope;
			const childToolScope = childToolScopeBase
				? { ...childToolScopeBase, requestedToolNames: selectedToolNames }
				: undefined;
			const transportRequestedToolNames = childToolScope?.requestedToolNames?.filter(
				(name) =>
					(name !== ASK_TOOL_NAME || built.workerAskRuntimePath !== undefined) &&
					(name !== DELEGATE_TOOL_NAME || built.workerDelegateRuntimePath !== undefined),
			);
			const transportedToolScope = childToolScope &&
				transportRequestedToolNames?.length !== childToolScope.requestedToolNames?.length
				? { ...childToolScope, requestedToolNames: transportRequestedToolNames }
				: childToolScope;
			workerToolScopeEnvelope = transportedToolScope
				? createDetachedWorkerToolScopeEnvelope(
						transportedToolScope,
						transportedToolScope.selectedExtensionPaths,
						built.extensionRuntimePaths,
						built.workerAskRuntimePath,
						built.workerDelegateRuntimePath,
						{
							force: staticTaskToolScope !== undefined || staticExplicitToolScope !== undefined,
							...(preparedResources?.toolScope.workerFabricRuntimePath
								? { workerFabricRuntimePath: built.extensionRuntimePaths?.[preparedResources.toolScope.workerFabricRuntimePath] ??
									preparedResources.toolScope.workerFabricRuntimePath }
								: {}),
						},
					)
				: undefined;
			const adaptiveRuntimePath = adaptiveProvider
				? built.extensionRuntimePaths?.[adaptiveProvider.resolvedPath]
				: undefined;
			thinkingPolicyRequirements = thinkingPolicyContext
				? {
					requireProvider: providerPresent,
					requireTool: providerPresent && selectedThinkingTool,
					...(providerPresent && adaptiveProvider
						? {
							expectedProviderIdentities: [
								...new Set([
									...extensionSelectorAliases(adaptiveProvider),
									...(adaptiveRuntimePath ? [adaptiveRuntimePath] : []),
								]),
							],
						}
						: {}),
					...(selectedThinkingTool
						? { expectedToolName: "set_thinking_effort" }
						: {}),
				}
				: undefined;
		} catch (error) {
			cleanupTempDir(built.tempDir);
			throw error;
		}
		// Production: resolve the pi CLI via `getPiSpawnCommand` (node <cli.js> …
		// or `pi` on PATH). TEST-ONLY: `cfg.piSpawnOverride` substitutes a
		// faithful stub so REQ-PICLI-8's live e2e exercises the REAL spawn+parse
		// path against a deterministic canned stream (no model/network).
		const spawnSpec: PiSpawnCommand = cfg.piSpawnOverride
			? {
					command: cfg.piSpawnOverride.program,
					args: [...(cfg.piSpawnOverride.prefixArgs ?? []), ...built.args],
				}
			: getPiSpawnCommand(built.args);

		// Run the pi child to terminal, WRAPPED with spec 0005's supervision
		// substrate (REQ-PICLI-5/6): the control-consumer loop polls the inbox
		// while the child runs, started/updated/completed bracket the run, and the
		// child's spawn env carries the lineage (derived-key) + agent-dir routing
		// so its OWN grandchildren chain depth/cap + route liveness/control to the
		// same root. `onClient` captures the PERSISTENT RPC client (spec 0013 node
		// B): the supervisor holds the SAME client for the run so a steer
		// interrupts the live turn over its stdin and a cancel writes the
		// in-protocol abort + gracefully signals (SIGTERM → grace → SIGKILL).
		let rpcClient: OrchestrateRpcClient | undefined;
		const childRun = runPiChild({
			command: spawnSpec.command,
			argv: spawnSpec.args,
			cwd: cfg.cwd,
			// The hosted agent's prompt is delivered on stdin as `{type:'prompt'}`
			// (RPC switch) — there is no positional `Task:` argv anymore.
			task: hostedCfg.task,
			// Lineage (derived-key) + event-sink/control-inbox routing + node A's
			// `PI_DELEGATE_CHILD` child guard (REQ-PICLI-6). `--no-extensions`
			// keeps the child itself from running delegate's foreground hooks; the
			// lineage env still matters for when the child explicitly loads
			// delegate (via `-e`) for a nested dispatch — set it regardless so the
			// depth/cap chain is correct across the boundary.
			spawnEnv: buildPiChildSpawnEnv(
				hostedCfg,
				frame,
				thinkingPolicyContext?.policy,
				thinkingPolicyRequirements,
				workerToolScopeEnvelope,
			),
			childLog,
			onClient: (c) => {
				rpcClient = c;
			},
		});

		let childResult: PiChildResult;
		let cancelWoundDown = false;
		try {
			const supervised = await supervisePiChild({
				agentDir,
				frame,
				getClient: () => rpcClient,
				childRun,
				...(cfg.entryName !== undefined ? { entryName: cfg.entryName } : {}),
			});
			childResult = supervised.result;
			cancelWoundDown = supervised.cancelWoundDown;
		} finally {
			cleanupTempDir(built.tempDir);
		}
		const detachedTaskState = readDetachedTaskState(cfg, frame);
		// The bridge already emitted the ledger in its own bounded event. Keep the
		// terminal event small so a maximal valid ledger cannot erase phase/outcome.
		const taskTerminalFields = detachedTaskState
			? { tasks: detachedTaskState.progress }
			: {};

		// A spawn-level failure (pi binary not found, etc.) is a clean `failed`
		// — never a silent empty `done` (REQ-PICLI-4). A cancel that fired before
		// the child ever spawned still wound down gracefully → `steered`, not a
		// failure (REQ-PICLI-5).
		if (childResult.spawnError && !cancelWoundDown) {
			emitBus(agentDir, frame, "completed", {
				phase: "terminal",
				kind: "failed",
				...taskTerminalFields,
			});
			return emitFailed(
				cfg,
				`failed to spawn pi child (${spawnSpec.command}): ${childResult.spawnError}`,
				undefined,
				detachedTaskState?.ledger,
			);
		}

		// A GRACEFUL cancel wind-down (REQ-PICLI-5 / REQ-ORCH-4): the child was
		// signalled to stop on an authenticated cancel control-request. This is
		// the `steered` terminal — a graceful `done`, NEVER a `failed` (there is
		// no `steered` result status; spec 0005 mapped it to a `done` carrying
		// whatever terminal text the child landed before wind-down). `decideTerminal`
		// is the single source of truth for the kind; its inputs cannot express a
		// discretionary collapse or a wall-clock kill.
		const terminalKind = decideTerminal({
			errored: false,
			cancelWoundDown,
		});
		if (terminalKind === "steered") {
			emitBus(agentDir, frame, "completed", {
				phase: "terminal",
				kind: "steered",
				tools: childResult.outcome.toolStarts.length,
				...taskTerminalFields,
			});
			const steered: OrchestrateResultDone = {
				mode: "driver",
				status: "done",
				runId: cfg.runId,
				agentName: cfg.agentName,
				output:
					(childResult.outcome.cleanStopText ?? childResult.outcome.finalText)
						.trim() ||
					"(wound down on cancel request; the pi child was signalled to stop)",
				usage: childResult.outcome.usage,
				...(detachedTaskState ? { taskLedger: detachedTaskState.ledger } : {}),
				finishedAt: new Date().toISOString(),
			};
			emitResult(cfg, steered);
			return steered;
		}

		// The RPC client already classified the terminal off the event stream
		// (REQ-RPC-4): a qualifying `agent_end{willRetry:false}` with a clean stop +
		// non-empty text → `done`; a provider/assistant error, an exit before a
		// qualifying agent_end, a stall, an empty/partial stop → `failed`. The
		// removed `decidePiStreamTerminal` predicate is preserved inside
		// `classifyRpcTerminal` (orchestrate-rpc-client.ts).
		const terminal = childResult.terminal;
		emitBus(agentDir, frame, "completed", {
			phase: "terminal",
			kind: terminal.kind,
			tools: childResult.outcome.toolStarts.length,
			...taskTerminalFields,
		});

		if (terminal.kind === "done") {
			const done: OrchestrateResultDone = {
				mode: "driver",
				status: "done",
				runId: cfg.runId,
				agentName: cfg.agentName,
				output: terminal.output,
				usage: childResult.outcome.usage,
				...(detachedTaskState ? { taskLedger: detachedTaskState.ledger } : {}),
				finishedAt: new Date().toISOString(),
			};
			emitResult(cfg, done);
			return done;
		}
		return emitFailed(cfg, terminal.error, childResult.outcome.usage, detachedTaskState?.ledger);
	} catch (err) {
		// Any unexpected throw in the spawn/parse path is a clean `failed` with
		// context — NEVER a silent empty `done` (REQ-PICLI-4).
		childLog?.writeEvent({ type: "runner_error", error: String((err as Error)?.message ?? err) });
		childLog?.close();
		emitBus(agentDir, frame, "completed", {
			phase: "terminal",
			kind: "failed",
		});
		return emitFailed(
			cfg,
			(err as Error)?.stack ?? (err as Error)?.message ?? String(err),
		);
	}
}

/**
 * Write + return a clean `failed` result (REQ-PICLI-4). Distinct from a crash
 * (absent file): here the child DID write a terminal. A write failure is
 * swallowed — the parent's reaper synthesizes a crash from the absent file +
 * dead pid (REQ-ORCH-6).
 */
function emitFailed(
	cfg: OrchestrateCfg,
	error: string,
	usage?: OrchestrateResultFailed["usage"],
	taskLedger?: TaskLedger,
): OrchestrateResultFailed {
	const failed: OrchestrateResultFailed = {
		mode: "driver",
		status: "failed",
		runId: cfg.runId,
		agentName: cfg.agentName,
		error,
		...(usage ? { usage } : {}),
		...(taskLedger ? { taskLedger } : {}),
		finishedAt: new Date().toISOString(),
	};
	try {
		emitResult(cfg, failed);
	} catch {
		/* best-effort; parent reaper covers a write failure (REQ-ORCH-6) */
	}
	return failed;
}

/**
 * OFFLINE self-test (bootProofOnly): boot a REAL in-process pi session + load
 * extensions WITHOUT making a model call, then write a `done` documenting the
 * boot. This is the de-risk gate's deterministic offline proof — NOT the
 * production hosted-agent run (that is the pi CLI subprocess in
 * `runOrchestrateChild`). [decision: bootproof-kept-as-offline-selftest]
 */
async function runBootProofSelfTest(
	cfg: OrchestrateCfg,
): Promise<OrchestrateResult> {
	const agent = cfgToAgentConfig(cfg);
	let session: AgentSession | undefined;
	try {
		const surface = reconstructOrchestrateToolSurface(cfg);
		// Issue #10 — log dropped/unknown tool entries (previously collected
		// but never logged at this call site).
		for (const d of surface.diagnostics) logDelegateDiagnostic(d, { agentDir: cfg.agentDir, throttleKey: "tool-surface" });
		assertValidExtensionToolSelectors(surface);
		await resolveAndValidateOrchestrateExtensionPolicy(cfg, agent, surface);
		const preparedResources = await prepareWorkerSessionResources(
			agent,
			{ cwd: cfg.cwd, agentDir: cfg.agentDir },
			surface,
		);
		const loader = preparedResources.loader;
		replaceLoadedAskTools(loader, makeWorkerAskRoutingTool({ enabled: false }));
		const toolScope = preparedResources.toolScope;
		const thinkingPolicyContext = preparedResources.thinkingPolicyContext;

		const sessionDir = buildWorkerSessionDir(cfg.agentDir);
		const sessionMgr = SessionManager.create(cfg.cwd, sessionDir);
		applyWorkerSeeds(sessionMgr, {
			thinkingPolicy: thinkingPolicyContext?.policy,
			extensions: loader.getExtensions().extensions,
		});

		const created = await createAgentSession({
			cwd: cfg.cwd,
			agentDir: cfg.agentDir,
			model: createOfflineBootProofModel(),
			...(cfg.thinking ? { thinkingLevel: cfg.thinking } : {}),
			...(toolScope.sessionOptions.tools ? { tools: toolScope.sessionOptions.tools } : {}),
			...(toolScope.sessionOptions.excludeTools
				? { excludeTools: toolScope.sessionOptions.excludeTools }
				: {}),
			sessionManager: sessionMgr,
			resourceLoader: loader,
		});
		session = created.session;
		await session.bindExtensions({});
		toolScope.install(session);

		const bootProof = captureBootProof(
			session,
			created.extensionsResult as any,
		);
		const done: OrchestrateResultDone = {
			mode: "driver",
			status: "done",
			runId: cfg.runId,
			agentName: cfg.agentName,
			output: "(boot-proof) session booted; extensions loaded; no prompt run",
			bootProof,
			finishedAt: new Date().toISOString(),
		};
		emitResult(cfg, done);
		return done;
	} catch (err) {
		return emitFailed(
			cfg,
			(err as Error)?.stack ?? (err as Error)?.message ?? String(err),
		);
	} finally {
		try {
			if (session) await disposeWorkerSession(session);
		} catch { /* boot proof cleanup is best effort */ }
	}
}

/** Parse + validate the cfg file handed on argv. Throws on a missing path. */
export function loadCfg(cfgPath: string): OrchestrateCfg {
	const raw = fs.readFileSync(cfgPath, "utf8");
	const cfg = JSON.parse(raw) as OrchestrateCfg;
	if (!cfg.runId || !cfg.resultFile || !cfg.cwd || !cfg.agentDir) {
		throw new Error(
			"driver cfg missing required fields (runId/resultFile/cwd/agentDir)",
		);
	}
	if (cfg.tasks !== undefined) assertValidTasksSeed(cfg.tasks);
	return cfg;
}

/**
 * Stamp the PID of the process that actually loaded the runner. The optional
 * function is a unit-test seam; production uses the shared fixed-width,
 * in-place marker writer. A stamp failure is deliberately non-fatal so marker
 * bookkeeping can never prevent the detached run from starting.
 */
export function stampOrchestrateRunnerPid(
	cfg: OrchestrateCfg,
	stampPid: (cfg: OrchestrateCfg, pid: number, overwriteExisting?: boolean) => void =
		stampOrchestrateActiveMarkerPid,
): void {
	try {
		stampPid(cfg, process.pid, true);
	} catch {
		/* best-effort; the run must continue even if marker bookkeeping fails */
	}
	if (cfg.restartAttempts !== 1) return;
	try {
		const handoff = readOrchestrateReplacementHandoff(cfg.agentDir, cfg.runId);
		const identity = captureProcessIdentity(process.pid);
		const runnerNonce = getProcessNonce();
		if (handoff) {
			const {
				runnerStartTicks: _oldRunnerStartTicks,
				runnerBootId: _oldRunnerBootId,
				runnerNonce: _oldRunnerNonce,
				...handoffRecord
			} = handoff;
			writeOrchestrateReplacementHandoff(cfg.agentDir, {
				...handoffRecord,
				runnerPid: process.pid,
				...(identity?.startTicks ? { runnerStartTicks: identity.startTicks } : {}),
				...(identity?.bootId ? { runnerBootId: identity.bootId } : {}),
				runnerNonce,
			});
		}
	} catch {
		/* best-effort; handoff bookkeeping must never block runner boot */
	}
}

export interface OrchestrateRunnerEntrypointDeps {
	stampPid?: typeof stampOrchestrateRunnerPid;
	runChild?: typeof runChildToTerminal;
}

/** Execute the loaded runner entrypoint; kept small so production wiring is testable. */
export async function runOrchestrateRunnerEntrypoint(
	cfg: OrchestrateCfg,
	deps: OrchestrateRunnerEntrypointDeps = {},
): Promise<number> {
	(deps.stampPid ?? stampOrchestrateRunnerPid)(cfg);
	return (deps.runChild ?? runChildToTerminal)(cfg);
}

/** Standalone entrypoint: `node dist/orchestrate-runner.js <cfgPath>`. */
async function main(): Promise<void> {
	const cfgPath = process.argv[2];
	if (!cfgPath) {
		console.error(
			"[orchestrate-runner] usage: orchestrate-runner.js <cfgPath>",
		);
		process.exit(2);
		return;
	}
	let cfg: OrchestrateCfg;
	try {
		cfg = loadCfg(cfgPath);
	} catch (err) {
		console.error(
			`[orchestrate-runner] failed to load cfg: ${(err as Error)?.message ?? err}`,
		);
		process.exit(2);
		return;
	}
	process.exit(await runOrchestrateRunnerEntrypoint(cfg));
}

/**
 * Issue #8 — crash-path containment, extracted from `main()` for direct unit
 * testing (no process.exit inside). Previously the terminal drain ran only
 * AFTER a successful `runOrchestrateChild` return; a child that THREW fell out
 * to the entrypoint `.catch(exit 1)` WITHOUT draining pending control requests
 * (posters then hung their full timeout) and WITHOUT a terminal result on
 * disk, while the route record — which stores the PLAINTEXT control secret —
 * persisted until some later startup sweep.
 *
 * Now: a throw synthesizes + emits a failed result (best-effort), and the
 * `finally` ALWAYS (a) drains the control inbox so every poster gets a prompt
 * terminal rejection, and (b) deletes the secret-bearing route record so the
 * secret never outlives the child process (REQ-CTRL-8; the parent-side deletes
 * on delivery/fast-path remain as idempotent belt-and-suspenders).
 *
 * Returns the process exit code: 0 for a `done` result, 1 otherwise. A clean
 * `failed` is still a written-result success — the result FILE carries the
 * verdict; the exit code only distinguishes "ran" from a crash the OS reports.
 *
 * `runChild` is an injection seam for tests (defaults to the real
 * `runOrchestrateChild`).
 *
 * SAFETY CONTRACT (reviewer finding, MR !15): `runChild` must either RETURN
 * its terminal result (having already written the result file via
 * `emitResult`, as `runOrchestrateChild` does on every return path) or THROW
 * without having written one. The crash synthesizer below additionally guards
 * on result-file existence, so even a write-then-throw `runChild` can never
 * have its REAL result clobbered by the synthesized failure.
 */
export async function runChildToTerminal(
	cfg: OrchestrateCfg,
	runChild: (cfg: OrchestrateCfg) => Promise<OrchestrateResult> = runOrchestrateChild,
): Promise<number> {
	let result: OrchestrateResult;
	try {
		result = await runChild(cfg);
	} catch (err) {
		result = synthFailed(
			cfg.runId,
			cfg.agentName,
			`driver child crashed: ${(err as Error)?.stack ?? err}`,
		);
		try {
			// Existence guard: if the child already wrote a REAL terminal result
			// before throwing, that result is the truth — never overwrite it
			// with the synthesized failure (the synthesized `result` still
			// drives this process's exit code, which is fine: nonzero on throw).
			if (!fs.existsSync(cfg.resultFile)) {
				emitResult(cfg, result);
			}
		} catch {
			/* best-effort: the finally below must still drain + delete */
		}
	} finally {
		// (1) terminal marker is now recorded (the result FILE was written inside
		// `runOrchestrateChild`, or synthesized above on the crash path).
		// (2) FINAL control-inbox drain (spec 0009, REQ-CTRL-7 — the authority):
		// reject any request that arrived during the wind-down / terminal window
		// with `already terminal`, so it never leaks in `requests/` and the
		// poster's await resolves rather than hanging. The frame is re-resolved
		// here — `runOrchestrateChild` already re-anchored the inherited lineage
		// into `process.env`, so `resolveChildFrame()` recovers the SAME
		// authentic frame the supervisor polled with. On a pre-reanchor crash the
		// frame resolves `undefined` and the drain is a contractual no-op (see
		// `drainControlRequestsAtTerminal`'s no-frame contract).
		drainControlRequestsAtTerminal({ agentDir: cfg.agentDir, frame: resolveChildFrame() });
		// (3) the route record stores the plaintext control secret — reap it at
		// child terminal, success or crash. Best-effort + idempotent.
		try {
			// Cleanup is authorized only by a durable terminal result. If both the
			// normal and synthesized writes failed, retain route + active marker so a
			// foreground reconciler still has authority to terminalize the orphan.
			finalizeTerminalOrchestrateRoute({
				agentDir: cfg.agentDir,
				runId: cfg.runId,
				ownerSessionId: cfg.ownerSessionId,
			});
		} catch {
			/* best-effort */
		}
	}
	return result.status === "done" ? 0 : 1;
}

// Run main() only when executed directly as the spawned entrypoint — NOT when
// imported by a test or by the parent process for its helpers. The canonical
// "am I the entrypoint" check for ESM is `import.meta.url ===
// pathToFileURL(process.argv[1]).href` — true when this module is the file
// `node` was launched with (the detached spawn passes the compiled
// `dist/orchestrate-runner.js` as argv[1]), false when imported.
const invokedAsScript =
	Boolean(process.argv[1]) &&
	import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
	main().catch((err) => {
		console.error(
			`[orchestrate-runner] fatal: ${(err as Error)?.stack ?? err}`,
		);
		process.exit(1);
	});
}
