/** Effective discovery and worker capabilities using the native dispatch owners. */

import { projectAgentTrustError } from "./project-trust.js";
import { createAgentSession, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { applyAgentOverrides } from "./agent-overrides.js";
import {
	discoverAgents,
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
	type PackageAgentDiscoveryOptions,
} from "./agents.js";
import { loadConfigReadOnly, type DelegateConfig } from "./config.js";
import { configuredPackageRoots } from "./configured-package-roots.js";
import { toRuntimeEscalation } from "./delegate-runs.js";
import { resolveParentTranscriptSearch } from "./direct-shape.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { mergeEnvOverrides, withEnvOverrides, type EnvOverrides } from "./env-overrides.js";
import { resolveSlotEscalationPolicy } from "./escalation-policy.js";
import { invalidateFailedWorkerRuntime } from "./extension-policy.js";
import { prepareWorkerSessionResources } from "./fork-runner.js";
import {
	inheritsWorkspaceTools,
	resolveWorkerToolOverrides,
	resolveWorkerToolSurface,
	type ExtSelector,
} from "./tool-surface.js";
import { createIsolatedWorkerSettingsManager } from "./worker-settings.js";

export interface EffectiveAgentDiscoveryOptions {
	/** Definition scopes, as the delegate call's `agent_scope`. Defaults to `"both"`. */
	scope?: AgentScope;
	/** Read project-local package settings only after the host trusts the project. */
	projectTrusted?: boolean;
}

export interface EffectiveAgentDiscovery extends AgentDiscoveryResult {
	/** The delegate configuration the overrides came from; dispatch policy reads it too. */
	config: DelegateConfig;
}

/** @internal Package-root discovery options shared by agent and chain discovery. */
export function agentDiscoveryOptions(
	cwd: string,
	projectTrusted: boolean,
	warnings?: string[],
): PackageAgentDiscoveryOptions {
	return {
		additionalResolvedPackageRoots: configuredPackageRoots({
			cwd,
			agentDir: getAgentDir(),
			projectTrusted,
			...(warnings ? { warn: (message: string) => warnings.push(message) } : {}),
		}),
	};
}

/** Discover the agents native dispatch selects from, with configured overrides applied. */
export function resolveEffectiveAgents(
	cwd: string,
	options: EffectiveAgentDiscoveryOptions = {},
): EffectiveAgentDiscovery {
	const agentDir = getAgentDir();
	const packageWarnings: string[] = [];
	const discovery = discoverAgents(
		cwd,
		options.scope ?? "both",
		agentDiscoveryOptions(cwd, options.projectTrusted === true, packageWarnings),
	);
	const config = loadConfigReadOnly(agentDir);
	const overridden = applyAgentOverrides(discovery.agents, config);
	if (overridden.unmatched.length > 0) {
		logDelegateDiagnostic(
			`agentOverrides keys had no matching agent: ${overridden.unmatched.join(", ")}`,
			{ agentDir },
		);
	}
	return { ...discovery, warnings: [...packageWarnings, ...discovery.warnings], agents: overridden.agents, config };
}

/** The run fields that change a worker's tools, in delegate `runs[]` spelling. */
export interface EffectiveWorkerRun {
	/** `"off"`, `"local"` or a partial escalation object (`escalation_mode` or `mode`). */
	escalation?: unknown;
	readOnly?: boolean;
	parentTranscriptSearch?: boolean;
	/** `false` opts a writable run out of write confinement. */
	confineWrites?: boolean;
	/** Invocation patch layered over the agent's `env`. */
	env?: EnvOverrides;
}

export interface EffectiveWorkerTools {
	/** Tools the bound worker admits at construction, plus run-supplied tools. Lifecycle registration can change this snapshot. */
	toolNames: string[];
	/** Live owner-qualified grants, including selectors whose tools have not registered yet. */
	extensionToolSelectors: readonly ExtSelector[];
	/** Bound inheritance, excluding explicit allowlists and readOnly confinement. */
	inheritsWorkspaceTools: boolean;
}

/**
 * Load the agent's worker extensions exactly as native dispatch does and bind its tools.
 * Fabric is admitted only after the worker's own Fabric acknowledges the host policy.
 */
export async function resolveEffectiveWorkerTools(args: {
	cwd: string;
	agent: AgentConfig;
	config: Pick<DelegateConfig, "escalationGlobalLayer">;
	run?: EffectiveWorkerRun;
	/** Whether the host trusts the project; a project-local agent is refused before any extension loads otherwise. */
	projectTrusted?: boolean;
}): Promise<EffectiveWorkerTools> {
	const trustError = projectAgentTrustError([args.agent], args.projectTrusted === true);
	if (trustError) throw new Error(trustError);
	const run = args.run ?? {};
	const escalationPolicy = resolveSlotEscalationPolicy({
		shape: "direct",
		config: args.config,
		agent: args.agent,
		invocationValue: toRuntimeEscalation(run.escalation),
		fieldPath: "escalation",
	});
	const overrides = resolveWorkerToolOverrides({
		readOnly: run.readOnly,
		escalationPolicy,
		parentTranscriptSearch: resolveParentTranscriptSearch(run.parentTranscriptSearch, args.agent),
	});
	const requested = resolveWorkerToolSurface(args.agent, overrides);
	const agentDir = getAgentDir();
	return await withEnvOverrides(mergeEnvOverrides(args.agent.env, run.env), async () => {
		const settingsManager = createIsolatedWorkerSettingsManager(args.cwd, agentDir);
		const { loader, surface, toolScope } = await prepareWorkerSessionResources(args.agent, {
			cwd: args.cwd,
			agentDir,
			settingsManager,
			writeConfined: run.readOnly === true || run.confineWrites !== false,
			workerGrantedToolNames: overrides.customToolNames,
		}, requested);
		let session: AgentSession;
		try {
			({ session } = await createAgentSession({
				cwd: args.cwd,
				agentDir,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(args.cwd),
			}));
		} catch (error) {
			invalidateFailedWorkerRuntime(loader);
			throw error;
		}
		try {
			return {
				toolNames: [...new Set([...toolScope.currentActiveToolNames(session), ...surface.runToolNames])],
				extensionToolSelectors: toolScope.extensionToolSelectors,
				inheritsWorkspaceTools: inheritsWorkspaceTools(surface),
			};
		} finally {
			session.dispose();
		}
	});
}
