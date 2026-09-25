import type {
	AgentSession,
	Extension,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { clearSessionControlGrants, registerSessionControlGrants } from "./control-grant-registry.js";
import {
	ASK_TOOL_NAME,
	BUILTIN_TOOL_NAMES,
	DELEGATE_TOOL_NAME,
	EXCLUDED_TOOL_NAMES,
	artifactWriterToolNames,
	extensionSelectorAliases,
	isOptionalGlobalExtensionSelector,
	isUsableWorkerToolName,
	type ArtifactWriterRequirement,
	type ExtSelector,
	type ResolvedToolSurface,
} from "./tool-surface.js";
import {
	getPortableExtensionIdentity,
	identifyLoadedExtension,
	isPiDelegateExtensionIdentity,
	isPiDelegateExtensionSelector,
	normalizeNpmIdentity,
	PI_DELEGATE_NPM_SOURCES,
	PI_DELEGATE_PACKAGE_NAMES,
	portableExtensionIdentityMatchesSelector,
	resolveLoadedExtensionForToolSelector,
} from "./extension-policy.js";
import { ToolSelectorDiagnosticCode, toolSelectorDiagnostic } from "./tool-selector.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PARENT_TRANSCRIPT_SEARCH_TOOL_NAME } from "./parent-transcript-search.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** Version of the detached live-scope transport contract. */
export const WORKER_TOOL_SCOPE_PROTOCOL_VERSION = 1 as const;
/** Environment key used by the authoritative hosted Pi child. */
export const DETACHED_WORKER_TOOL_SCOPE_ENV = "PI_DELEGATE_WORKER_TOOL_SCOPE_V1";
/** Maximum serialized transport size accepted by the hosted bridge. */
export const MAX_WORKER_TOOL_SCOPE_ENV_BYTES = 64 * 1024;
/** Process-local registry populated by hosted consumer-extension owner proxies. */
export const DETACHED_WORKER_TOOL_OWNER_REGISTRY_KEY = "pi-delegate.worker-tool-owners.v1";

export interface DetachedWorkerToolScopeEnvelope {
	protocolVersion: typeof WORKER_TOOL_SCOPE_PROTOCOL_VERSION;
	/** Stable built-in/custom names requested by the worker surface. */
	requestedToolNames: string[];
	/** Names that only Pi's built-in provider may satisfy. */
	deniedExtensionToolNames?: string[];
	/**
	 * Per-tool action grants for the consolidated control surface (#265).
	 * A tool mapped to `null` is an unrestricted grant; an array restricts the
	 * worker to those actions. JSON cannot carry `undefined`, so `null` is the
	 * wire spelling of "granted every action" and must not be read as "none".
	 */
	controlActionGrants?: Record<string, string[] | null>;
	/** Extension selectors whose tool membership is evaluated live. */
	extensionToolSelectors: ExtSelector[];
	/** Parent-validated original owner path for each selector at the same array index. */
	selectorExtensionPaths: string[];
	/** Generated runtime entrypoint for each selector at the same array index. */
	selectorRuntimeExtensionPaths: string[];
	/** Parent-validated original extension entrypoints selected for the child. */
	selectedExtensionPaths: string[];
	/** Parent-generated extension entrypoints loaded by the child. */
	selectedRuntimeExtensionPaths: string[];
	/** Trusted worker ask shim loaded ahead of consumer extensions, when available. */
	workerAskRuntimePath?: string;
	/** Trusted delegate-self entrypoint loaded ahead of other consumer extensions. */
	workerDelegateRuntimePath?: string;
	/** Parent-resolved pi-fabric entrypoint loaded by this child, if any. */
	workerFabricRuntimePath?: string;
	/** Parent-authorized unrestricted Fabric admission; never inferred from empty arrays. */
	allowFabricExec?: boolean;
	/** Whether the worker opted into delegate-family capabilities. */
	allowNestedDelegate?: boolean;
	/** Selector indexes that requested delegate-family tools by extension scope. */
	delegateToolSelectorIndexes?: number[];
}

export interface WorkerToolScopeSessionOptions {
	/** Static Pi allowlist, or undefined for a live extension scope. */
	tools?: string[];
	/** Known names that must remain unavailable while the live scope is active. */
	excludeTools?: string[];
}

export interface PreparedWorkerToolScope {
	/** Stable names requested by the resolved worker surface. */
	readonly requestedToolNames: string[] | undefined;
	/** Exact loaded pi-fabric owner, if uniquely identified by the parent. */
	readonly workerFabricRuntimePath?: string;
	/** Requested names that an extension-owned replacement must not satisfy. */
	readonly deniedToolNames: readonly string[];
	readonly controlActionGrants?: Record<string, string[] | undefined>;
	/** Diagnostics retained for worker binding (missing selectors fail construction). */
	readonly diagnostics: string[];
	/** Parsed extension selectors, retained without eager tool snapshots. */
	readonly extensionToolSelectors: readonly ExtSelector[];
	/** Exact loaded owner path for each selector at the same array index. */
	readonly selectorExtensionPaths: readonly string[];
	/** Exact loaded identities selected by those selectors. */
	readonly selectedExtensionPaths: readonly string[];
	/** Whether this worker explicitly opted into delegate-family capabilities. */
	readonly delegateOptIn?: boolean;
	/** Selector indexes that requested delegate-family tools by extension scope. */
	readonly delegateToolSelectorIndexes: readonly number[];
	/** Whether an empty whole-extension selector is a deferred capability. */
	readonly hasDeferredWholeExtensionSelector: boolean;
	/** Whether Pi must use its live registry rather than a static allowlist. */
	readonly dynamic: boolean;
	/** Whether the final provider floor is required for this explicit surface. */
	readonly hasExplicitAllowlist: boolean;
	/** Mode-aware artifact writer capability that must survive the final live scope. */
	readonly artifactWriterRequirement?: ArtifactWriterRequirement;
	/** Pi options for session construction. */
	readonly sessionOptions: WorkerToolScopeSessionOptions;
	/** Names currently allowed by the live extension registry. */
	currentActiveToolNames(session?: Pick<AgentSession, "getAllTools">): string[];
	/** Call-time authority check for the undocumented Agent hook seam. */
	isAllowedToolName(name: string, session?: Pick<AgentSession, "getAllTools">): boolean;
	/** Apply the current active set, avoiding redundant Pi rebuilds. */
	apply(session: Pick<AgentSession, "getAllTools" | "getActiveToolNames" | "setActiveToolsByName">): void;
	/** Install turn refresh and call-time veto for this session lifetime. */
	install(session: AgentSession): () => void;
}

const KNOWN_SCOPE_NAMES = [...BUILTIN_TOOL_NAMES, ASK_TOOL_NAME, ...EXCLUDED_TOOL_NAMES];

function dedupe(names: readonly string[]): string[] {
	return [...new Set(names)];
}

function extensionDisplayName(extension: Extension): string {
	return extension.path || extension.resolvedPath;
}

function sameOrderedNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

type AgentStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
type AgentStreamArguments = Parameters<AgentStreamFunction>;
type AgentStreamContext = AgentStreamArguments[1];
type AgentCompatibilitySurface = {
	streamFunction?: AgentStreamFunction;
	streamFn?: AgentStreamFunction;
};
type FinalAgentToolDefinition = NonNullable<AgentStreamContext["tools"]>[number];
type WorkerTurnSnapshot =
	| { definitions: FinalAgentToolDefinition[] }
	| { errorMessage: string };

function createFinalFloorErrorStream(errorMessage: string): ReturnType<AgentStreamFunction> {
	const stream = createAssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "pi-messages",
		provider: "pi-delegate",
		model: "worker-tool-scope",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error });
	return stream;
}

/** Guard exactly one provider request after each real AgentSession turn_start. */
function installFinalWorkerToolFloor(
	session: AgentSession,
	apply: () => void,
	enabled: boolean,
	artifactWriterRequirement?: ArtifactWriterRequirement,
	requestedToolNames?: readonly string[],
	workerFabricRuntimePath?: string,
): () => void {
	if (!enabled) return () => {};
	const agent = session.agent as (typeof session.agent & AgentCompatibilitySurface) | undefined;
	if (!agent) return () => {};
	const property: "streamFunction" | "streamFn" | undefined =
		typeof agent.streamFunction === "function" ? "streamFunction" :
			typeof agent.streamFn === "function" ? "streamFn" : undefined;
	if (!property) return () => {};
	const previousProvider = agent[property] as AgentStreamFunction;
	let pendingSnapshot: WorkerTurnSnapshot | undefined;
	let released = false;
	const onTurnStart = (event: { type?: string }): void => {
		if (event.type !== "turn_start") return;
		try {
			apply();
			const definitions = session.agent.state.tools.slice() as FinalAgentToolDefinition[];
			if (artifactWriterRequirement !== undefined) {
				assertWorkerArtifactWriterRetained(
					artifactWriterRequirement,
					definitions,
					session.getAllTools(),
					{
						requestedToolNames,
						workerFabricRuntimePath,
						fullCodeMode: process.env.PI_FABRIC_FULL_CODE_MODE !== "false" &&
							!definitions.some((tool) => FABRIC_CORE_TOOL_NAMES.has(tool.name)),
						hasRunner: session.extensionRunner !== undefined,
					},
				);
			}
			assertWorkerToolSurfaceHasUsableToolNames(definitions.map((tool) => tool.name));
			pendingSnapshot = { definitions };
		} catch (error) {
			pendingSnapshot = {
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
	};
	const unsubscribe = session.subscribe(onTurnStart as Parameters<AgentSession["subscribe"]>[0]);
	const wrappedProvider: AgentStreamFunction = (...args: AgentStreamArguments): ReturnType<AgentStreamFunction> => {
		const snapshot = pendingSnapshot;
		pendingSnapshot = undefined;
		if (!snapshot) return previousProvider(...args);
		if ("errorMessage" in snapshot) return createFinalFloorErrorStream(snapshot.errorMessage);
		const context = args[1];
		const nextArgs = [args[0], { ...context, tools: snapshot.definitions }, args[2]] as AgentStreamArguments;
		return previousProvider(...nextArgs);
	};
	agent[property] = wrappedProvider;
	return () => {
		if (released) return;
		released = true;
		unsubscribe();
		if (agent[property] === wrappedProvider) agent[property] = previousProvider;
	};
}

function isPiDelegateSelectorAlias(selector: string): boolean {
	const wanted = selector.trim().toLowerCase();
	if (wanted === "pi-delegate") return true;
	const hasPackageBoundary = (prefix: string): boolean => {
		if (!wanted.startsWith(prefix)) return false;
		const next = wanted[prefix.length];
		return next === undefined || next === "@" || next === "#" || next === "/";
	};
	// Reuse the canonical npm parser for package/version forms. Entrypoints
	// retain their `#`/`/` suffix, so the same exact package boundary handles
	// those forms without swallowing sibling packages.
	return PI_DELEGATE_PACKAGE_NAMES.some((packageName) => hasPackageBoundary(packageName)) ||
		PI_DELEGATE_NPM_SOURCES.includes(normalizeNpmIdentity(wanted) ?? "") ||
		PI_DELEGATE_NPM_SOURCES.some((npmSource) => hasPackageBoundary(npmSource));
}

function resolveExtensionMatches(
	selector: string,
	extensions: readonly Extension[],
): Extension[] {
	const trimmed = selector.trim();
	const wanted = trimmed.toLowerCase();
	const isPiDelegateAlias = isPiDelegateSelectorAlias(trimmed);
	return extensions.filter((extension) => {
		try {
			const identity = getPortableExtensionIdentity(extension) ?? identifyLoadedExtension(extension);
			// The convenience alias is trusted only after the loaded portable
			// identity proves this is the real pi-delegate package. Do not let a
			// foreign extension whose path happens to contain `pi-delegate` match.
			if (isPiDelegateExtensionSelector(identity, trimmed)) return true;
			// A pi-delegate-shaped selector must not fall through to path or package
			// aliases for a foreign extension. Generic selectors still use the full
			// portable identity before the compatibility aliases below.
			if (isPiDelegateAlias) return false;
			if (portableExtensionIdentityMatchesSelector(identity, trimmed)) return true;
		} catch {
			return false;
		}
		return extensionSelectorAliases(extension).has(wanted);
	});
}

/** Compatibility aliases cannot prove that several matches are entrypoints of one package. */
function matchesShareSelectedPackageIdentity(
	selector: string,
	matches: readonly Extension[],
): boolean {
	if (matches.length < 2) return false;
	const identities = matches.map((extension) =>
		getPortableExtensionIdentity(extension) ?? identifyLoadedExtension(extension),
	);
	const first = identities[0]!;
	if (!first.packageRoot || !first.packageName || !first.source) return false;
	if (!identities.every((identity) =>
		identity.packageRoot === first.packageRoot &&
		identity.packageName === first.packageName &&
		identity.source === first.source
	)) return false;
	const trimmed = selector.trim();
	return trimmed === first.packageName || trimmed === first.source;
}

/** A selector retained only when it resolves to one loaded extension owner. */
interface WorkerToolScopeSelectorBinding {
	selector: ExtSelector;
	extension: Extension;
}

interface WorkerToolScopeSelectorResolution {
	bindings: WorkerToolScopeSelectorBinding[];
	selectedExtensions: Extension[];
	diagnostics: string[];
}

/**
 * Resolve extension identity before binding a selector to one loaded entrypoint.
 * An exact tool can disambiguate same-package entrypoints only when one matching
 * entrypoint already owns it. A lazy or multiply-owned tool cannot prove which
 * entrypoint the selector intended, so that identity remains ambiguous.
 *
 * Missing and ambiguous owners are hard errors. The worker must fail closed:
 * dropping an authored extension-only grant could otherwise collapse its
 * explicit surface into a default or leave a same-named provider reachable.
 */
function resolveWorkerToolScopeSelectorBindings(
	selectors: readonly ExtSelector[],
	extensions: readonly Extension[],
	isOptionalGlobal: (selector: ExtSelector) => boolean = () => false,
): WorkerToolScopeSelectorResolution {
	const bindings: WorkerToolScopeSelectorBinding[] = [];
	const selectedExtensions: Extension[] = [];
	const diagnostics: string[] = [];
	for (const selector of selectors) {
		const rendered = `ext:${selector.extension}${selector.module ? `#${selector.module}` : ""}${selector.tool ? `:${selector.tool}` : ""}`;
		let matches: Extension[];
		if (selector.module) {
			try {
				matches = [resolveLoadedExtensionForToolSelector(selector, extensions).extension];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (
					isOptionalGlobal(selector) &&
					message.includes(`[tool-selector:${ToolSelectorDiagnosticCode.OWNER_NOT_FOUND}]`)
				) {
					diagnostics.push(toolSelectorDiagnostic(
						ToolSelectorDiagnosticCode.OWNER_NOT_FOUND,
						"optional global extension tool selector was not loaded and was omitted",
					));
					continue;
				}
				throw error;
			}
		} else {
			matches = resolveExtensionMatches(selector.extension, extensions);
		}
		if (matches.length === 0) {
			if (isOptionalGlobal(selector)) {
				diagnostics.push(toolSelectorDiagnostic(
					ToolSelectorDiagnosticCode.OWNER_NOT_FOUND,
					"optional global extension tool selector was not loaded and was omitted",
				));
				continue;
			}
			const loaded = extensions.map(extensionDisplayName).join(", ") || "none";
			throw new Error(toolSelectorDiagnostic(
				ToolSelectorDiagnosticCode.OWNER_NOT_FOUND,
				`owner ${JSON.stringify(selector.extension)} was not found; loaded extensions: ${loaded}`,
			));
		}
		let resolvedMatches = matches;
		if (matches.length > 1 && selector.tool !== undefined &&
			matchesShareSelectedPackageIdentity(selector.extension, matches)) {
			const selectedTool = selector.tool;
			const matchingToolOwners = matches.filter((extension) => extension.tools.has(selectedTool));
			if (matchingToolOwners.length === 1) resolvedMatches = matchingToolOwners;
		}
		if (resolvedMatches.length > 1) {
			throw new Error(toolSelectorDiagnostic(
				ToolSelectorDiagnosticCode.OWNER_AMBIGUOUS,
				`Could not resolve ${rendered}: owner is ambiguous across loaded extensions: ` +
				matches.map(extensionDisplayName).join(", ") + ". Use a declared #module selector.",
			));
		}
		const extension = resolvedMatches[0]!;
		bindings.push({ selector, extension });
		if (!selectedExtensions.includes(extension)) selectedExtensions.push(extension);
	}
	return { bindings, selectedExtensions, diagnostics };
}

export function resolveWorkerToolScopeExtensions(
	selectors: readonly ExtSelector[],
	extensions: readonly Extension[],
): Extension[] {
	return resolveWorkerToolScopeSelectorBindings(selectors, extensions).selectedExtensions;
}

function extensionOwnsSelectedTool(
	selectedExtension: Extension,
	toolName: string,
	extensions: readonly Extension[],
): boolean {
	if (!selectedExtension.tools.has(toolName)) return false;
	const owners = extensions.filter((extension) => extension.tools.has(toolName));
	return owners.length === 1 && owners[0] === selectedExtension;
}

function extensionIsTrustedDelegateOwner(extension: Extension): boolean {
	try {
		return isPiDelegateExtensionIdentity(
			getPortableExtensionIdentity(extension) ?? identifyLoadedExtension(extension),
		);
	} catch {
		return false;
	}
}

function selectedExtensionAllowsTool(
	selectedExtension: Extension,
	toolName: string,
	extensions: readonly Extension[],
	delegateOptIn: boolean,
	exactDelegateSelector = false,
): boolean {
	if (EXCLUDED_TOOL_NAMES.includes(toolName)) {
		return exactDelegateSelector && delegateOptIn && extensionIsTrustedDelegateOwner(selectedExtension) &&
			extensionOwnsSelectedTool(selectedExtension, toolName, extensions);
	}
	return extensionOwnsSelectedTool(selectedExtension, toolName, extensions);
}

/**
 * Prepare one live tool scope. This is the only resolver used by in-process
 * worker sessions after extension selectors have been parsed.
 */
export function prepareWorkerToolScope(
	surface: Pick<ResolvedToolSurface, "tools" | "extSelectors"> & Partial<Pick<ResolvedToolSurface, "deniedToolNames" | "actionGrants" | "delegateOptIn" | "hasExplicitAllowlist">>,
	extensions: readonly Extension[],
	options: { workerGrantedToolNames?: readonly string[]; artifactWriterRequirement?: ArtifactWriterRequirement; writeConfined?: boolean } = {},
): PreparedWorkerToolScope {
	const requestedSelectors = [...surface.extSelectors];
	// Production callers provide the resolved flag. Compatibility literals infer
	// explicitness only from a non-empty requested allowlist or selector.
	const hasExplicitAllowlist = surface.hasExplicitAllowlist ?? (
		(surface.tools !== undefined && surface.tools.length > 0) || requestedSelectors.length > 0
	);
	const delegateOptIn = surface.delegateOptIn ?? true;
	// A direct worker's opt-in is two-part: the agent flag and an extension
	// selector that can prove the trusted delegate owner. Keep this denylist
	// active after binding so bare, foreign, and late registrations stay closed.
	const hasExplicitDelegateToolSelector = requestedSelectors.some((selector) =>
		selector.tool !== undefined && EXCLUDED_TOOL_NAMES.includes(selector.tool));
	const delegateFamilyDenied = surface.delegateOptIn !== undefined &&
		(!delegateOptIn || !hasExplicitDelegateToolSelector);
	const deniedToolNames = new Set([
		...(surface.deniedToolNames ?? []),
		...(delegateFamilyDenied ? EXCLUDED_TOOL_NAMES : []),
	]);
	// Keep this true when every selector is missing. A selector-only allowlist
	// must remain a bounded, empty live surface rather than falling back to Pi defaults.
	const dynamic = requestedSelectors.length > 0;
	const workerGrantedToolNames = new Set(options.workerGrantedToolNames ?? []);
	const artifactWriterRequirement = options.artifactWriterRequirement;
	const isWorkerGrantedToolName = (name: string): boolean =>
		name !== PARENT_TRANSCRIPT_SEARCH_TOOL_NAME || workerGrantedToolNames.has(name);
	const requestedToolNames = surface.tools
		? [...surface.tools].filter(isWorkerGrantedToolName)
		: undefined;
	const controlActionGrants = surface.actionGrants;
	const fabricOwners = extensions.filter((extension) =>
		extension.tools.has(FABRIC_EXEC_TOOL_NAME) &&
		(getPortableExtensionIdentity(extension) ?? identifyLoadedExtension(extension)).packageName === "pi-fabric");
	const workerFabricRuntimePath = fabricOwners.length === 1 ? fabricOwners[0]!.resolvedPath : undefined;
	const resolution = resolveWorkerToolScopeSelectorBindings(
		requestedSelectors,
		extensions,
		(selector) => isOptionalGlobalExtensionSelector(surface as ResolvedToolSurface, selector),
	);
	const selectors = resolution.bindings.map(({ selector }) => selector);
	// Fabric providers bypass this scope's native veto. Denied names cannot be
	// preserved through full Fabric, even when the agent omitted a tools list.
	const fabricAllowed = !hasExplicitAllowlist && requestedToolNames === undefined && !dynamic &&
		deniedToolNames.size === 0 && options.writeConfined !== true;
	const selectedExtensions = resolution.selectedExtensions;
	const selectorExtensions = resolution.bindings.map(({ extension }) => extension);
	const diagnostics = resolution.diagnostics;
	// Whole-extension selectors are never enough to grant delegate-family tools:
	// the worker must name the exact trusted tool selector.
	const delegateToolSelectorIndexes = selectors.flatMap((selector, index) => {
		const selectedExtension = selectorExtensions[index]!;
		if (!extensionIsTrustedDelegateOwner(selectedExtension)) return [];
		if (selector.tool !== undefined && EXCLUDED_TOOL_NAMES.includes(selector.tool)) return [index];
		return [];
	});
	// Existing registrations still have to preserve the selected extension's
	// authority. A missing exact tool is intentionally deferred for lazy
	// providers; a name already owned by multiple loaded extensions is not.
	for (const [index, selector] of selectors.entries()) {
		const selectedExtension = selectorExtensions[index]!;
		const eagerNames = selector.tool
			? selectedExtension.tools.has(selector.tool) ? [selector.tool] : []
			: [...selectedExtension.tools.keys()];
		for (const name of eagerNames) {
			if (deniedToolNames.has(name) || !isWorkerGrantedToolName(name)) continue;
			if (EXCLUDED_TOOL_NAMES.includes(name) && !selectedExtensionAllowsTool(selectedExtension, name, extensions, delegateOptIn, selector.tool !== undefined)) continue;
			if (!extensionOwnsSelectedTool(selectedExtension, name, extensions)) {
				const owners = extensions
					.filter((extension) => extension.tools.has(name))
					.map(extensionDisplayName)
					.join(", ") || "(none)";
				throw new Error(toolSelectorDiagnostic(
					ToolSelectorDiagnosticCode.PROVIDER_MISMATCH,
					`Could not resolve ext:${selector.extension}${selector.module ? `#${selector.module}` : ""}${selector.tool ? `:${selector.tool}` : ""}: ` +
					`tool ${JSON.stringify(name)} does not have a unique loaded extension owner. ` +
					`Owners: ${owners}. Pi tool allowlists are name-only, so selecting this tool would not preserve extension authority.`,
				));
			}
		}
	}

	if (!dynamic) {
		const allowedRequestedNames = (session?: Pick<AgentSession, "getAllTools">): string[] =>
			(requestedToolNames ?? []).filter((name) => {
				if (name === FABRIC_EXEC_TOOL_NAME) return false;
				if (!session) return true;
				if (deniedToolNames.has(name)) {
					// Delegate-family names are denied even when Pi exposes a built-in
					// or same-named extension registration. They become eligible only
					// through the dynamic trusted-owner selector path below.
					if (EXCLUDED_TOOL_NAMES.includes(name)) return false;
					return requestedToolHasAuthoritativeSource(name, session.getAllTools(), deniedToolNames);
				}
				return session.getAllTools().some((tool) => tool.name === name);
			});
		return {
			requestedToolNames,
			workerFabricRuntimePath,
			deniedToolNames: [...deniedToolNames],
			controlActionGrants: surface.actionGrants,
			diagnostics,
			extensionToolSelectors: selectors,
			selectorExtensionPaths: [],
			selectedExtensionPaths: [],
			...(surface.delegateOptIn !== undefined ? { delegateOptIn } : {}),
			delegateToolSelectorIndexes,
			hasDeferredWholeExtensionSelector: false,
			hasExplicitAllowlist,
			...(artifactWriterRequirement !== undefined ? { artifactWriterRequirement } : {}),
			dynamic: false,
			sessionOptions: requestedToolNames ? { tools: requestedToolNames.filter((name) => name !== FABRIC_EXEC_TOOL_NAME) } : {},
			currentActiveToolNames(session) {
				return requestedToolNames
					? allowedRequestedNames(session)
					: session?.getAllTools().map((tool) => tool.name).filter((name) =>
						!deniedToolNames.has(name) && (name !== FABRIC_EXEC_TOOL_NAME ||
							(fabricAllowed && fabricExecAdmitted(undefined, session.getAllTools(), workerFabricRuntimePath)))) ?? [];
			},
			isAllowedToolName(name, session) {
				if (!isWorkerGrantedToolName(name)) return false;
				if (name === FABRIC_EXEC_TOOL_NAME) return fabricAllowed && session !== undefined &&
					fabricExecAdmitted(undefined, session.getAllTools(), workerFabricRuntimePath);
				if (requestedToolNames === undefined) return !deniedToolNames.has(name);
				if (!requestedToolNames.includes(name)) return false;
				if (!session) return !deniedToolNames.has(name);
				return allowedRequestedNames(session).includes(name);
			},
			apply() {
				// Static Pi options already establish the requested active set.
			},
			install(session) {
				// Static options are applied before bindExtensions(), but a deferred
				// parent grant may only become registered during that bind. Re-apply
				// the allowlist now so a newly available deferred tool is active in
				// the worker without changing the foreground session's tool set.
				const applyRequested = (): void => {
					if (typeof session.getAllTools !== "function") return;
					const active = this.currentActiveToolNames(session);
					if (!sameOrderedNames(session.getActiveToolNames(), active)) session.setActiveToolsByName(active);
				};
				applyRequested();
				const onEvent = (event: { type?: string }): void => {
					if (event.type === "before_agent_start" || event.type === "turn_end") applyRequested();
				};
				const unsubscribe = typeof session.subscribe === "function"
					? session.subscribe(onEvent as Parameters<AgentSession["subscribe"]>[0])
					: () => {};
				const releaseFinalFloor = installFinalWorkerToolFloor(
					session,
					applyRequested,
					hasExplicitAllowlist || artifactWriterRequirement !== undefined,
					artifactWriterRequirement,
					requestedToolNames,
					workerFabricRuntimePath,
				);
				// A static allowlist still needs its ACTION grants bound: the
				// allowlist can only grant or withhold the whole delegate_control
				// tool, so the narrowing to specific actions lives here. Skipping
				// this is what let a `tools: delegate_status` worker cancel a run.
				const releaseGrants = bindSessionControlGrants(session, controlActionGrants);
				type BeforeToolCall = (input: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
				const sessionAgent = session.agent as { beforeToolCall?: BeforeToolCall } | undefined;
				const previousBeforeToolCall = sessionAgent?.beforeToolCall;
				const wrappedBeforeToolCall: BeforeToolCall = async (input, signal) => {
					const name = (input as { toolCall?: { name?: unknown } } | undefined)?.toolCall?.name;
					if (typeof name === "string" && !this.isAllowedToolName(name, session)) {
						return { block: true, reason: `Tool ${JSON.stringify(name)} is outside this worker's selected extension tool scope.` };
					}
					return previousBeforeToolCall?.(input, signal);
				};
				if (deniedToolNames.size > 0 || requestedToolNames !== undefined) {
					if (!sessionAgent) {
						releaseFinalFloor();
						releaseGrants();
						throw new Error("Cannot enforce extension-owner tool denials without a worker agent");
					}
					sessionAgent.beforeToolCall = wrappedBeforeToolCall;
				}
				return () => {
					releaseFinalFloor();
					releaseGrants();
					if (sessionAgent?.beforeToolCall === wrappedBeforeToolCall) {
						sessionAgent.beforeToolCall = previousBeforeToolCall;
					}
					unsubscribe();
				};
			},
		};
	}

	const requested = new Set(requestedToolNames ?? []);
	// `excludeTools` is a stable denylist for names Pi knows before lifecycle
	// registration. Exact selectors reserve their selected name even when it is
	// `ask` or another control name. A whole-extension selector can register any
	// known name later, so it cannot use a permanent known-name denylist; the
	// post-bind active-set narrowing and call-time veto remain authoritative.
	const selectedEagerNames = new Set(
		selectors.flatMap((selector, index) => {
			const selectedExtension = selectorExtensions[index]!;
			return (selector.tool ? [selector.tool] : [...selectedExtension.tools.keys()])
				.filter((name) => selectedExtensionAllowsTool(selectedExtension, name, extensions, delegateOptIn, selector.tool !== undefined));
		}).filter((name) => !deniedToolNames.has(name) && isWorkerGrantedToolName(name)),
	);
	const selectsWholeExtension = selectors.some((selector) => selector.tool === undefined);
	const selectedCurrentlyUsableNames = selectors.flatMap((selector, index) => {
		const selectedExtension = selectorExtensions[index]!;
		return (selector.tool
			? [selector.tool]
			: [...selectedExtension.tools.keys()])
			.filter((name) => selectedExtensionAllowsTool(selectedExtension, name, extensions, delegateOptIn, selector.tool !== undefined));
	}).filter((name) => !deniedToolNames.has(name) && isWorkerGrantedToolName(name));
	const hasDeferredWholeExtensionSelector = selectors.some((selector, index) =>
		selector.tool === undefined && selectorExtensions[index]!.tools.size === 0,
	);
	const requestedUsableNames = [...requested].filter(isUsableWorkerToolName);
	const selectedCurrentlyUsableNamesWithoutDelegate = selectedCurrentlyUsableNames.filter(
		isUsableWorkerToolName,
	);
	if (
		requestedUsableNames.length === 0 &&
		selectedCurrentlyUsableNamesWithoutDelegate.length === 0 &&
		selectors.length > 0 &&
		!hasDeferredWholeExtensionSelector &&
		!selectors.some((selector) => selector.tool !== undefined && isUsableWorkerToolName(selector.tool))
	) {
		throw new Error("Explicit extension tool selection resolves only to denied tools; refusing an empty worker tool surface.");
	}
	const excluded = selectsWholeExtension
		? []
		: KNOWN_SCOPE_NAMES.filter(
			(name) => !requested.has(name) && !selectedEagerNames.has(name),
		);
	const sessionOptions: WorkerToolScopeSessionOptions = {
		// Leaving tools unset is essential: Pi must refresh its registry when a
		// lifecycle handler registers a selected tool after construction.
		excludeTools: dedupe(excluded),
	};

	const allowedNames = (session?: Pick<AgentSession, "getAllTools">): string[] => {
		const availableTools = session?.getAllTools();
		const available = availableTools
			? new Set(availableTools.map((tool) => tool.name))
			: undefined;
		const names: string[] = [];
		for (const name of requestedToolNames ?? []) {
			if (!isWorkerGrantedToolName(name) || name === FABRIC_EXEC_TOOL_NAME) continue;
			// Every delegate-family request is authorized by its selected
			// extension owner below, never by a name-only or built-in registration.
			if (EXCLUDED_TOOL_NAMES.includes(name)) continue;
			if (
				!availableTools ||
				requestedToolHasAuthoritativeSource(name, availableTools, deniedToolNames)
			) names.push(name);
		}
		for (const [index, selector] of selectors.entries()) {
			const selectedExtension = selectorExtensions[index]!;
			const candidateNames = selector.tool
				? [selector.tool]
				: [...selectedExtension.tools.keys()];
			for (const name of candidateNames) {
				if (deniedToolNames.has(name) || !isWorkerGrantedToolName(name) || name === FABRIC_EXEC_TOOL_NAME) continue;
				if (
					selectedExtensionAllowsTool(selectedExtension, name, extensions, delegateOptIn, selector.tool !== undefined) &&
					(!available || available.has(name))
				) names.push(name);
			}
		}
		if (fabricAllowed && availableTools && fabricExecAdmitted(undefined, availableTools, workerFabricRuntimePath)) {
			names.push(FABRIC_EXEC_TOOL_NAME);
		}
		return dedupe(names);
	};

	return {
		requestedToolNames,
		workerFabricRuntimePath,
		deniedToolNames: [...deniedToolNames],
		controlActionGrants: surface.actionGrants,
		diagnostics,
		extensionToolSelectors: selectors,
		selectorExtensionPaths: selectorExtensions.map((extension) => extension.resolvedPath),
		selectedExtensionPaths: dedupe(selectedExtensions.map((extension) => extension.resolvedPath)),
		...(surface.delegateOptIn !== undefined ? { delegateOptIn } : {}),
		delegateToolSelectorIndexes,
		hasDeferredWholeExtensionSelector,
		hasExplicitAllowlist,
		...(artifactWriterRequirement !== undefined ? { artifactWriterRequirement } : {}),
		dynamic: true,
		sessionOptions,
		currentActiveToolNames: allowedNames,
		isAllowedToolName(name, session) {
			return isWorkerGrantedToolName(name) && allowedNames(session).includes(name);
		},
		apply(session) {
			const next = allowedNames(session);
			if (!sameOrderedNames(session.getActiveToolNames(), next)) {
				session.setActiveToolsByName(next);
			}
		},
		install(session) {
			const releaseGrants = bindSessionControlGrants(session, controlActionGrants);
			const releaseFinalFloor = installFinalWorkerToolFloor(
				session,
				() => this.apply(session),
				hasExplicitAllowlist || artifactWriterRequirement !== undefined,
				artifactWriterRequirement,
				requestedToolNames,
				workerFabricRuntimePath,
			);
			const previousBeforeToolCall = (session.agent as {
				beforeToolCall?: (input: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
			}).beforeToolCall;
			const onEvent = (event: { type?: string }): void => {
				if (event.type === "before_agent_start" || event.type === "turn_end") this.apply(session);
			};
			const unsubscribe = session.subscribe(onEvent as Parameters<AgentSession["subscribe"]>[0]);
			this.apply(session);
			const wrappedBeforeToolCall = async (input: unknown, signal?: AbortSignal): Promise<unknown> => {
				const context = input as { toolCall?: { name?: unknown } } | undefined;
				const name = context?.toolCall?.name;
				if (typeof name === "string" && !this.isAllowedToolName(name, session)) {
					return {
						block: true,
						reason: `Tool ${JSON.stringify(name)} is outside this worker's selected extension tool scope.`,
					};
				}
				return previousBeforeToolCall?.(input, signal);
			};
			(session.agent as {
				beforeToolCall?: typeof previousBeforeToolCall;
			}).beforeToolCall = wrappedBeforeToolCall;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				releaseFinalFloor();
				releaseGrants();
				if ((session.agent as { beforeToolCall?: typeof previousBeforeToolCall }).beforeToolCall === wrappedBeforeToolCall) {
					(session.agent as { beforeToolCall?: typeof previousBeforeToolCall }).beforeToolCall = previousBeforeToolCall;
				}
				unsubscribe();
			};
		},
	};
}

/**
 * Bind a worker session's control-action grants into the trusted registry, and
 * return the release. Keyed by the session's own id so a lookup at call time
 * cannot be confused with another session's scope.
 */
function bindSessionControlGrants(
	session: Pick<AgentSession, "sessionManager">,
	grants: Record<string, readonly string[] | undefined> | undefined,
): () => void {
	if (!grants) return () => {};
	let sessionId: string | undefined;
	try {
		sessionId = session.sessionManager?.getSessionId?.();
	} catch {
		sessionId = undefined;
	}
	if (!sessionId) {
		// Without an identity the grant cannot be scoped to this session, and a
		// silently unenforced grant is the bug this registry exists to prevent.
		throw new Error(
			"pi-delegate: cannot bind control-action grants without a worker session id; refusing to construct an unrestricted worker",
		);
	}
	registerSessionControlGrants(sessionId, grants);
	return () => clearSessionControlGrants(sessionId);
}

/**
 * Enforce the construction-time usable-surface floor after extension policy
 * and owner binding have resolved. Exact selectors may still register lazily,
 * so a qualified non-delegate selector counts as a deferred capability.
 */
export function assertWorkerToolSurfaceUsable(
	surface: Pick<ResolvedToolSurface, "hasExplicitAllowlist">,
	scope: Pick<PreparedWorkerToolScope, "currentActiveToolNames" | "extensionToolSelectors" | "hasDeferredWholeExtensionSelector">,
): void {
	if (!surface.hasExplicitAllowlist) return;
	const active = scope.currentActiveToolNames();
	if (active.some(isUsableWorkerToolName)) return;
	if (scope.extensionToolSelectors.some(
		(selector) => selector.tool !== undefined && isUsableWorkerToolName(selector.tool),
	)) return;
	if (scope.hasDeferredWholeExtensionSelector) return;
	throw new Error(
		"Explicit tools allowlist resolves to no usable tools; refusing to construct an empty worker tool surface.",
	);
}

/**
 * Assert that the final live surface retained a built-in writer supported by
 * the artifact producer's confinement mode. The live registry is authoritative
 * because extension registration can replace a built-in name after the
 * requested surface was checked.
 */
export function assertWorkerArtifactWriterRetained(
	requirement: ArtifactWriterRequirement,
	definitions: readonly { name: string }[],
	tools: readonly ToolInfo[],
	fabric: {
		requestedToolNames?: readonly string[];
		workerFabricRuntimePath?: string;
		fullCodeMode?: boolean;
		hasRunner?: boolean;
	} = {},
): void {
	const retainedBuiltinWriter = artifactWriterToolNames(requirement).some((name) => {
		const writer = uniquelyRegisteredTool(tools, name);
		const retained = definitions.some((tool) => tool.name === name);
		const builtin = writer !== undefined &&
			(writer.sourceInfo.source === "builtin" || writer.sourceInfo.path.startsWith("<builtin:"));
		return builtin && retained;
	});
	if (retainedBuiltinWriter) return;
	// Fabric full-code mode serves the builtin writer through fabric_exec.
	const fabricServesWriter = fabric.fullCodeMode === true && fabric.hasRunner === true &&
		definitions.some((tool) => tool.name === FABRIC_EXEC_TOOL_NAME) &&
		fabricExecAdmitted(fabric.requestedToolNames, tools, fabric.workerFabricRuntimePath) &&
		artifactWriterToolNames(requirement).some((name) => {
			const writer = uniquelyRegisteredTool(tools, name);
			return writer !== undefined && (writer.sourceInfo.source === "builtin" || writer.sourceInfo.path.startsWith("<builtin:"));
		});
	if (fabricServesWriter) return;
	const capability = requirement.readOnly
		? "the uniquely registered built-in write tool"
		: "a uniquely registered built-in write or bash tool";
	throw new Error(toolSelectorDiagnostic(
		ToolSelectorDiagnosticCode.TOOL_UNDECLARED,
		`Final live worker tool surface lost ${capability} required for artifact ${JSON.stringify(requirement.artifactName)}; ` +
			"an extension-owned replacement or final binding filter removed the writer before the provider request.",
	));
}

/** Assert that the final live surface still exposes ordinary worker capability. */
export function assertWorkerToolSurfaceHasUsableToolNames(names: readonly string[]): void {
	if (names.some(isUsableWorkerToolName)) return;
	throw new Error(toolSelectorDiagnostic(
		ToolSelectorDiagnosticCode.TOOL_UNDECLARED,
		"Final live worker tool surface has no usable ordinary tools declared; refusing provider request.",
	));
}

/**
 * Return a bounded transport envelope for the hosted child. The caller must
 * provide the parent-validated extension paths; selectors are never resolved
 * from an untrusted child-side package discovery result.
 */
export function createDetachedWorkerToolScopeEnvelope(
	scope: Pick<PreparedWorkerToolScope, "requestedToolNames" | "deniedToolNames" | "extensionToolSelectors" | "selectorExtensionPaths" | "dynamic" | "controlActionGrants" | "hasExplicitAllowlist"> &
		Partial<Pick<PreparedWorkerToolScope, "delegateOptIn" | "delegateToolSelectorIndexes">>,
	selectedExtensionPaths: readonly string[],
	extensionRuntimePaths?: Readonly<Record<string, string>>,
	workerAskRuntimePath?: string,
	workerDelegateRuntimePath?: string,
	options: { force?: boolean; workerFabricRuntimePath?: string } = {},
): DetachedWorkerToolScopeEnvelope | undefined {
	// A STATIC allowlist still needs an envelope when it carries action grants:
	// the detached child has no other way to learn them, and without it every
	// action would be permitted. A caller may also force one so lifecycle-time
	// registrations can be re-applied to a static allowlist. Dynamic scopes need
	// one regardless, for their selector narrowing.
	if (!scope.dynamic && !scope.controlActionGrants && scope.deniedToolNames.length === 0 && options.force !== true) return undefined;
	const validatedOwnerPaths = dedupe(selectedExtensionPaths);
	const runtimePathFor = (ownerPath: string): string | undefined => {
		if (!extensionRuntimePaths) return ownerPath;
		return Object.prototype.hasOwnProperty.call(extensionRuntimePaths, ownerPath)
			? extensionRuntimePaths[ownerPath]
			: undefined;
	};
	const selectorRuntimeExtensionPaths = scope.selectorExtensionPaths.map(runtimePathFor);
	const selectedRuntimeExtensionPaths = validatedOwnerPaths.map(runtimePathFor);
	if (
		scope.selectorExtensionPaths.length !== scope.extensionToolSelectors.length ||
		validatedOwnerPaths.some((path) => path.trim().length === 0) ||
		scope.selectorExtensionPaths.some(
			(path) => path.trim().length === 0 || !validatedOwnerPaths.includes(path),
		) ||
		selectorRuntimeExtensionPaths.some(
			(path) => typeof path !== "string" || path.trim().length === 0,
		) ||
		selectedRuntimeExtensionPaths.some(
			(path) => typeof path !== "string" || path.trim().length === 0,
		) ||
		(workerAskRuntimePath !== undefined &&
			(workerAskRuntimePath.trim().length === 0 || selectedRuntimeExtensionPaths.includes(workerAskRuntimePath))) ||
		(workerDelegateRuntimePath !== undefined && workerDelegateRuntimePath.trim().length === 0) ||
		(options.workerFabricRuntimePath !== undefined &&
			(options.workerFabricRuntimePath.trim().length === 0 ||
				!selectedRuntimeExtensionPaths.includes(options.workerFabricRuntimePath))) ||
		new Set(selectedRuntimeExtensionPaths).size !== validatedOwnerPaths.length
	) {
		throw new Error("Detached worker tool scope selector owners do not match the parent-validated extension paths");
	}
	const envelope: DetachedWorkerToolScopeEnvelope = {
		protocolVersion: WORKER_TOOL_SCOPE_PROTOCOL_VERSION,
		requestedToolNames: [...(scope.requestedToolNames ?? [])],
		...(scope.deniedToolNames.length > 0 ? { deniedExtensionToolNames: [...scope.deniedToolNames] } : {}),
		...(scope.controlActionGrants
			? {
					controlActionGrants: Object.fromEntries(
						Object.entries(scope.controlActionGrants).map(([tool, actions]) => [
							tool,
							actions === undefined ? null : [...actions],
						]),
					),
				}
			: {}),
		extensionToolSelectors: scope.extensionToolSelectors.map((selector) => ({ ...selector })),
		selectorExtensionPaths: [...scope.selectorExtensionPaths],
		selectorRuntimeExtensionPaths: selectorRuntimeExtensionPaths as string[],
		selectedExtensionPaths: validatedOwnerPaths,
		selectedRuntimeExtensionPaths: dedupe(selectedRuntimeExtensionPaths as string[]),
		...(workerAskRuntimePath ? { workerAskRuntimePath } : {}),
		...(workerDelegateRuntimePath ? { workerDelegateRuntimePath } : {}),
		...(options.workerFabricRuntimePath ? { workerFabricRuntimePath: options.workerFabricRuntimePath } : {}),
		...(!scope.hasExplicitAllowlist && scope.requestedToolNames === undefined && !scope.dynamic &&
			scope.deniedToolNames.length === 0 && options.workerFabricRuntimePath
			? { allowFabricExec: true } : {}),
		...(scope.delegateOptIn !== undefined ? { allowNestedDelegate: scope.delegateOptIn } : {}),
		...(scope.delegateToolSelectorIndexes && scope.delegateToolSelectorIndexes.length > 0
			? { delegateToolSelectorIndexes: [...scope.delegateToolSelectorIndexes] }
			: {}),
	};
	const encoded = JSON.stringify(envelope);
	if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_TOOL_SCOPE_ENV_BYTES) {
		throw new Error(
			`Detached worker tool scope exceeds ${MAX_WORKER_TOOL_SCOPE_ENV_BYTES} bytes; refusing to spawn an unbounded child.`,
		);
	}
	return envelope;
}

export function parseDetachedWorkerToolScopeEnvelope(raw: string | undefined): DetachedWorkerToolScopeEnvelope | undefined {
	if (!raw) return undefined;
	if (Buffer.byteLength(raw, "utf8") > MAX_WORKER_TOOL_SCOPE_ENV_BYTES) {
		throw new Error(`Invalid ${DETACHED_WORKER_TOOL_SCOPE_ENV}: payload exceeds ${MAX_WORKER_TOOL_SCOPE_ENV_BYTES} bytes`);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`Invalid ${DETACHED_WORKER_TOOL_SCOPE_ENV} payload: malformed JSON`, { cause: error });
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error(
			`Invalid ${DETACHED_WORKER_TOOL_SCOPE_ENV} payload: expected worker tool scope protocol v${WORKER_TOOL_SCOPE_PROTOCOL_VERSION}`,
		);
	}
	const parsed = decoded as Partial<DetachedWorkerToolScopeEnvelope>;
	if (
		parsed.protocolVersion !== WORKER_TOOL_SCOPE_PROTOCOL_VERSION ||
		!Array.isArray(parsed.requestedToolNames) ||
		!parsed.requestedToolNames.every((name) => typeof name === "string" && name.trim().length > 0) ||
		(parsed.deniedExtensionToolNames !== undefined &&
			(!Array.isArray(parsed.deniedExtensionToolNames) ||
				!parsed.deniedExtensionToolNames.every((name) => typeof name === "string" && name.trim().length > 0))) ||
		!Array.isArray(parsed.extensionToolSelectors) ||
		!parsed.extensionToolSelectors.every(
			(selector) => selector && typeof selector.extension === "string" && selector.extension.trim().length > 0 &&
			(selector.module === undefined || (typeof selector.module === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selector.module))) &&
			(selector.tool === undefined || (typeof selector.tool === "string" && selector.tool.trim().length > 0)) &&
			(selector.action === undefined || (typeof selector.action === "string" && selector.action.trim().length > 0)),
		) ||
		!Array.isArray(parsed.selectorExtensionPaths) ||
		!parsed.selectorExtensionPaths.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
		parsed.selectorExtensionPaths.length !== parsed.extensionToolSelectors.length ||
		!Array.isArray(parsed.selectorRuntimeExtensionPaths) ||
		!parsed.selectorRuntimeExtensionPaths.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
		parsed.selectorRuntimeExtensionPaths.length !== parsed.extensionToolSelectors.length ||
		!Array.isArray(parsed.selectedExtensionPaths) ||
		!parsed.selectedExtensionPaths.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
		parsed.selectorExtensionPaths.some((entry) => !parsed.selectedExtensionPaths!.includes(entry)) ||
		!Array.isArray(parsed.selectedRuntimeExtensionPaths) ||
		!parsed.selectedRuntimeExtensionPaths.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
		parsed.selectedRuntimeExtensionPaths.length !== parsed.selectedExtensionPaths.length ||
		new Set(parsed.selectedExtensionPaths).size !== parsed.selectedExtensionPaths.length ||
		new Set(parsed.selectedRuntimeExtensionPaths).size !== parsed.selectedRuntimeExtensionPaths.length ||
		parsed.selectorRuntimeExtensionPaths.some((entry) => !parsed.selectedRuntimeExtensionPaths!.includes(entry)) ||
		(parsed.workerAskRuntimePath !== undefined &&
			(typeof parsed.workerAskRuntimePath !== "string" ||
				parsed.workerAskRuntimePath.trim().length === 0 ||
				parsed.selectedRuntimeExtensionPaths.includes(parsed.workerAskRuntimePath))) ||
		(parsed.workerDelegateRuntimePath !== undefined &&
			(typeof parsed.workerDelegateRuntimePath !== "string" ||
				parsed.workerDelegateRuntimePath.trim().length === 0)) ||
		(parsed.workerFabricRuntimePath !== undefined &&
			(typeof parsed.workerFabricRuntimePath !== "string" ||
				!parsed.selectedRuntimeExtensionPaths.includes(parsed.workerFabricRuntimePath))) ||
		(parsed.allowFabricExec !== undefined &&
			(parsed.allowFabricExec !== true || !parsed.workerFabricRuntimePath || parsed.requestedToolNames.length !== 0 ||
				parsed.extensionToolSelectors.length !== 0 || (parsed.deniedExtensionToolNames?.length ?? 0) !== 0)) ||
		(parsed.allowNestedDelegate !== undefined && typeof parsed.allowNestedDelegate !== "boolean") ||
		(parsed.delegateToolSelectorIndexes !== undefined &&
			(!Array.isArray(parsed.delegateToolSelectorIndexes) ||
				!parsed.delegateToolSelectorIndexes.every((index) =>
				numberIsSafeSelectorIndex(index, parsed.extensionToolSelectors?.length ?? 0))))
	) {
		throw new Error(
			`Invalid ${DETACHED_WORKER_TOOL_SCOPE_ENV} payload: expected worker tool scope protocol v${WORKER_TOOL_SCOPE_PROTOCOL_VERSION}`,
		);
	}
	return {
		protocolVersion: WORKER_TOOL_SCOPE_PROTOCOL_VERSION,
		requestedToolNames: dedupe(parsed.requestedToolNames),
		...(parsed.deniedExtensionToolNames ? { deniedExtensionToolNames: dedupe(parsed.deniedExtensionToolNames) } : {}),
		// Validated defensively: a malformed grant map must fail closed to "no
		// actions granted" rather than being dropped, which would read as an
		// unrestricted grant.
		...(parsed.controlActionGrants && typeof parsed.controlActionGrants === "object"
			? {
					controlActionGrants: Object.fromEntries(
						Object.entries(parsed.controlActionGrants as Record<string, unknown>).map(([tool, actions]) => [
							tool,
							actions === null
								? null
								: Array.isArray(actions)
									? actions.filter((action): action is string => typeof action === "string")
									: [],
						]),
					),
				}
			: {}),
		extensionToolSelectors: parsed.extensionToolSelectors.map((selector) => ({
			extension: selector.extension,
			...(selector.module ? { module: selector.module } : {}),
			...(selector.tool ? { tool: selector.tool } : {}),
			...(selector.action ? { action: selector.action } : {}),
		})),
		selectorExtensionPaths: [...parsed.selectorExtensionPaths],
		selectorRuntimeExtensionPaths: [...parsed.selectorRuntimeExtensionPaths],
		selectedExtensionPaths: dedupe(parsed.selectedExtensionPaths),
		selectedRuntimeExtensionPaths: dedupe(parsed.selectedRuntimeExtensionPaths),
		...(parsed.workerAskRuntimePath ? { workerAskRuntimePath: parsed.workerAskRuntimePath } : {}),
		...(parsed.workerDelegateRuntimePath
			? { workerDelegateRuntimePath: parsed.workerDelegateRuntimePath }
			: {}),
		...(parsed.workerFabricRuntimePath ? { workerFabricRuntimePath: parsed.workerFabricRuntimePath } : {}),
		...(parsed.allowFabricExec === true ? { allowFabricExec: true } : {}),
		...(parsed.allowNestedDelegate !== undefined ? { allowNestedDelegate: parsed.allowNestedDelegate } : {}),
		...(parsed.delegateToolSelectorIndexes
			? { delegateToolSelectorIndexes: [...new Set(parsed.delegateToolSelectorIndexes)] }
			: {}),
	};
}

function numberIsSafeSelectorIndex(value: unknown, length: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < length;
}

function normalizeExtensionPath(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sourcePathMatchesOwner(sourceInfo: ToolInfo["sourceInfo"], ownerPath: string): boolean {
	return normalizeExtensionPath(sourceInfo.path) === normalizeExtensionPath(ownerPath);
}

function requestedToolHasAuthoritativeSource(
	toolName: string,
	tools: readonly ToolInfo[],
	deniedExtensionToolNames: ReadonlySet<string> = new Set(),
): boolean {
	// Pi's active-tool registry is name-only. Most plain declarations authorize
	// the final unique registration by name, including a configured extension
	// replacement. Security-sensitive names can require Pi's built-in owner.
	const tool = uniquelyRegisteredTool(tools, toolName);
	if (!tool) return false;
	if (!deniedExtensionToolNames.has(toolName)) return true;
	return tool.sourceInfo.source === "builtin" || tool.sourceInfo.path.startsWith("<builtin:");
}

interface DetachedWorkerToolOwnerRecord {
	ownerPath: string;
	runtimePath: string;
}

type DetachedWorkerToolOwnerRegistry = Map<string, Map<string, string>>;

function detachedWorkerToolOwnerRegistry(): DetachedWorkerToolOwnerRegistry | undefined {
	const key = Symbol.for(DETACHED_WORKER_TOOL_OWNER_REGISTRY_KEY);
	const value = (globalThis as Record<symbol, unknown>)[key];
	return value instanceof Map ? value as DetachedWorkerToolOwnerRegistry : undefined;
}

function detachedWorkerToolOwners(toolName: string): DetachedWorkerToolOwnerRecord[] {
	const owners = detachedWorkerToolOwnerRegistry()?.get(toolName);
	if (!(owners instanceof Map)) return [];
	const entries = [...owners];
	if (entries.some(([runtimePath, ownerPath]) =>
		typeof runtimePath !== "string" || typeof ownerPath !== "string"
	)) return [];
	return entries.map(([runtimePath, ownerPath]) => ({ ownerPath, runtimePath }));
}

function indexedSelectorAuthorizesTool(
	envelope: DetachedWorkerToolScopeEnvelope,
	tool: ToolInfo,
	selectorIndexes?: readonly number[],
): boolean {
	const allowedIndexes = selectorIndexes ? new Set(selectorIndexes) : undefined;
	const selectedByIndex = (index: number): boolean => allowedIndexes === undefined || allowedIndexes.has(index);
	const observedOwners = detachedWorkerToolOwners(tool.name);
	if (observedOwners.length > 0) {
		if (observedOwners.length !== 1) return false;
		const [observed] = observedOwners;
		if (!observed) return false;
		const visibleOwnerMatches = tool.name === ASK_TOOL_NAME
			? envelope.workerAskRuntimePath !== undefined &&
				sourcePathMatchesOwner(tool.sourceInfo, envelope.workerAskRuntimePath)
			: sourcePathMatchesOwner(tool.sourceInfo, observed.runtimePath);
		if (!visibleOwnerMatches) return false;
		return envelope.extensionToolSelectors.some((selector, index) =>
			selectedByIndex(index) &&
			(selector.tool === undefined || selector.tool === tool.name) &&
			normalizeExtensionPath(envelope.selectorExtensionPaths[index]!) ===
				normalizeExtensionPath(observed.ownerPath) &&
			normalizeExtensionPath(envelope.selectorRuntimeExtensionPaths[index]!) ===
				normalizeExtensionPath(observed.runtimePath),
		);
	}
	return envelope.extensionToolSelectors.some((selector, index) => {
		if (!selectedByIndex(index)) return false;
		const ownerPath = envelope.selectorExtensionPaths[index]!;
		const runtimePath = envelope.selectorRuntimeExtensionPaths[index]!;
		// A generated proxy must always leave a pre-dedup owner record. Falling
		// back to ToolInfo provenance is safe only for the identity (unproxied)
		// transport used by pure/public helpers and older static fixtures.
		if (normalizeExtensionPath(ownerPath) !== normalizeExtensionPath(runtimePath)) return false;
		return (selector.tool === undefined || selector.tool === tool.name) &&
			sourcePathMatchesOwner(tool.sourceInfo, runtimePath);
	});
}

function uniquelyRegisteredTool(
	tools: readonly ToolInfo[],
	toolName: string,
): ToolInfo | undefined {
	const candidates = tools.filter((tool) => tool.name === toolName);
	return candidates.length === 1 ? candidates[0] : undefined;
}

/** Fabric's single programmable tool. In full-code mode it serves Pi core tools. */
export const FABRIC_EXEC_TOOL_NAME = "fabric_exec";
export const FABRIC_CORE_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

/** Only unrestricted workers may use the exact pi-fabric owner resolved by their parent. */
export function fabricExecAdmitted(
	requestedToolNames: readonly string[] | undefined,
	tools: readonly ToolInfo[],
	workerFabricRuntimePath?: string,
): boolean {
	if (requestedToolNames !== undefined || !workerFabricRuntimePath) return false;
	const tool = uniquelyRegisteredTool(tools, FABRIC_EXEC_TOOL_NAME);
	return tool !== undefined && sourcePathMatchesOwner(tool.sourceInfo, workerFabricRuntimePath);
}


/** Whether a detached selector requested this delegate-family tool. */
function qualifiedDelegateSelectorIndexes(
	envelope: DetachedWorkerToolScopeEnvelope,
	toolName: string,
): number[] {
	return (envelope.delegateToolSelectorIndexes ?? []).filter((index) => {
		const selector = envelope.extensionToolSelectors[index];
		return selector !== undefined && (selector.tool === undefined || selector.tool === toolName);
	});
}

function hasQualifiedDelegateSelector(
	envelope: DetachedWorkerToolScopeEnvelope,
	toolName: string,
): boolean {
	return qualifiedDelegateSelectorIndexes(envelope, toolName).length > 0;
}

/** Whether the parent explicitly selected this delegate-family tool by name. */
function hasDelegateFamilySelector(
	envelope: DetachedWorkerToolScopeEnvelope,
	toolName: string,
): boolean {
	return envelope.extensionToolSelectors.some((selector) => selector.tool === toolName);
}

function detachedDelegateToolAuthorizes(
	envelope: DetachedWorkerToolScopeEnvelope,
	tool: ToolInfo,
): boolean {
	if (envelope.allowNestedDelegate === false) return false;
	const selectorIndexes = qualifiedDelegateSelectorIndexes(envelope, tool.name);
	return selectorIndexes.length > 0 && indexedSelectorAuthorizesTool(envelope, tool, selectorIndexes);
}

/** Compute active names for a detached child from public ToolInfo provenance. */
export function resolveDetachedWorkerActiveToolNames(
	envelope: DetachedWorkerToolScopeEnvelope,
	tools: readonly ToolInfo[],
): string[] {
	const requested = new Set(envelope.requestedToolNames);
	const deniedExtensionToolNames = new Set(envelope.deniedExtensionToolNames ?? []);
	const names: string[] = [];
	for (const tool of tools) {
		if (tool.name === FABRIC_EXEC_TOOL_NAME) continue;
		if (requested.has(tool.name)) {
			if (EXCLUDED_TOOL_NAMES.includes(tool.name)) {
				if (detachedDelegateToolAuthorizes(envelope, tool)) names.push(tool.name);
				else if (tool.name === DELEGATE_TOOL_NAME && !hasDelegateFamilySelector(envelope, tool.name) &&
					!deniedExtensionToolNames.has(tool.name) && envelope.allowNestedDelegate !== false &&
					envelope.workerDelegateRuntimePath !== undefined &&
					sourcePathMatchesOwner(tool.sourceInfo, envelope.workerDelegateRuntimePath)) names.push(tool.name);
				continue;
			}
			if (hasQualifiedDelegateSelector(envelope, tool.name)) {
				if (indexedSelectorAuthorizesTool(envelope, tool)) names.push(tool.name);
			} else if (tool.name === ASK_TOOL_NAME) {
				if (envelope.workerAskRuntimePath !== undefined &&
					sourcePathMatchesOwner(tool.sourceInfo, envelope.workerAskRuntimePath)) {
					names.push(tool.name);
				}
			} else if (tool.name === DELEGATE_TOOL_NAME) {
				if (envelope.workerDelegateRuntimePath !== undefined &&
					sourcePathMatchesOwner(tool.sourceInfo, envelope.workerDelegateRuntimePath)) {
					names.push(tool.name);
				}
			} else if (
				requestedToolHasAuthoritativeSource(tool.name, tools, deniedExtensionToolNames)
			) {
				names.push(tool.name);
			}
			continue;
		}
		const candidate = uniquelyRegisteredTool(tools, tool.name);
		if (deniedExtensionToolNames.has(tool.name)) continue;
		if (EXCLUDED_TOOL_NAMES.includes(tool.name)) {
			if (candidate === tool && detachedDelegateToolAuthorizes(envelope, tool)) names.push(tool.name);
			continue;
		}
		if (candidate === tool && indexedSelectorAuthorizesTool(envelope, candidate)) {
			names.push(tool.name);
		}
	}
	if (envelope.allowFabricExec === true && envelope.requestedToolNames.length === 0 &&
		envelope.extensionToolSelectors.length === 0 && deniedExtensionToolNames.size === 0 &&
		fabricExecAdmitted(undefined, tools, envelope.workerFabricRuntimePath)) {
		names.push(FABRIC_EXEC_TOOL_NAME);
	}
	return dedupe(names);
}

/** Verify a detached tool call is both selected by name and owned by its selector's validated extension. */
export function isDetachedWorkerToolAllowed(
	envelope: DetachedWorkerToolScopeEnvelope,
	toolName: string,
	tools: readonly ToolInfo[],
): boolean {
	const deniedExtensionToolNames = new Set(envelope.deniedExtensionToolNames ?? []);
	if (toolName === FABRIC_EXEC_TOOL_NAME) {
		return envelope.allowFabricExec === true && envelope.requestedToolNames.length === 0 &&
			envelope.extensionToolSelectors.length === 0 && deniedExtensionToolNames.size === 0 &&
			fabricExecAdmitted(undefined, tools, envelope.workerFabricRuntimePath);
	}
	if (envelope.requestedToolNames.includes(toolName)) {
		if (EXCLUDED_TOOL_NAMES.includes(toolName)) {
			const qualified = uniquelyRegisteredTool(tools, toolName);
			if (qualified !== undefined && detachedDelegateToolAuthorizes(envelope, qualified)) return true;
			return toolName === DELEGATE_TOOL_NAME && !hasDelegateFamilySelector(envelope, toolName) &&
				!deniedExtensionToolNames.has(toolName) && envelope.allowNestedDelegate !== false && envelope.workerDelegateRuntimePath !== undefined &&
				uniquelyRegisteredTool(tools, toolName) !== undefined &&
				sourcePathMatchesOwner(uniquelyRegisteredTool(tools, toolName)!.sourceInfo, envelope.workerDelegateRuntimePath);
		}
		if (hasQualifiedDelegateSelector(envelope, toolName)) {
			const qualified = uniquelyRegisteredTool(tools, toolName);
			return qualified !== undefined && indexedSelectorAuthorizesTool(envelope, qualified);
		}
		if (toolName !== ASK_TOOL_NAME) {
			return requestedToolHasAuthoritativeSource(toolName, tools, deniedExtensionToolNames);
		}
		const requestedAsk = uniquelyRegisteredTool(tools, toolName);
		return requestedAsk !== undefined && envelope.workerAskRuntimePath !== undefined &&
			sourcePathMatchesOwner(requestedAsk.sourceInfo, envelope.workerAskRuntimePath);
	}
	const candidate = uniquelyRegisteredTool(tools, toolName);
	if (deniedExtensionToolNames.has(toolName)) return false;
	if (EXCLUDED_TOOL_NAMES.includes(toolName)) {
		return candidate !== undefined && detachedDelegateToolAuthorizes(envelope, candidate);
	}
	return candidate !== undefined && indexedSelectorAuthorizesTool(envelope, candidate);
}
