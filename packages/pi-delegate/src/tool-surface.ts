/**
 * tool-surface.ts — the single, unified resolver for which tools a run's
 * session is constructed with.
 *
 * Replaces three former ad-hoc paths:
 *   - the supervised clone's hardcoded 6-tool `CLONE_*` harness (fork-runner),
 *   - the direct/supervised worker's per-agent builtin allowlist,
 *   - (forthcoming) the orchestrate driver's full-set-incl-`delegate` surface.
 *
 * One function, shape-aware defaults. No backwards-compat shim — this is THE
 * resolver; the old per-path resolution is removed.
 *
 * `createAgentSession({ tools })` is an ALLOW-LIST applied to BOTH built-ins
 * and customTools (pi turns it into `new Set(options.tools)`). Two foot-guns
 * this resolver guards against:
 *   1. `tools: []` is truthy → passing an empty array strips EVERYTHING incl.
 *      custom tools. We never return `[]`; an empty resolution yields
 *      `undefined` (pi default) or the shape default instead.
 *   2. custom tool NAMES must be in the allow-list or they're filtered out —
 *      so when a shape supplies customTools, their names are always included.
 *
 * `ext:` selector syntax:
 *   - `ext:foo`          → include all of extension `foo`'s tools (compatibility)
 *   - `ext:foo:bar`      → narrow extension `foo` to tool `bar`
 *   - `ext:foo#mod:bar`  → narrow a declared package module to tool `bar`
 *   - `ext:foo/bar`      → accepted old final-slash form during migration
 *   - `isolated`         → drop ALL extension tools (and skills)
 */

import * as fs from "node:fs";
import { mergeToolGrants, parseToolGrant as parseControlToolGrant } from "./control-surface.js";
import * as path from "node:path";

import type { Extension } from "@earendil-works/pi-coding-agent";
import { getOptionalGlobalToolEntries, type AgentConfig } from "./agents.js";
import type { EffectiveEscalationPolicy } from "./escalation-policy.js";
import { assertReadOnlyValue } from "./write-confinement.js";
import { TASKS_TOOL_NAME } from "./task-seam.js";
import { FOCUS_TOOL_NAME } from "./focus-seam.js";
import {
	isPiDelegatePackageIdentifier,
	normalizeNpmIdentity,
} from "./extension-policy.js";
import {
	parseToolGrant as parseSelectorToolGrant,
	ToolSelectorDiagnosticCode,
	toolSelectorDiagnostic,
} from "./tool-selector.js";

/**
 * Built-in tool names `createAgentSession` exposes (pi's `createAllTools`).
 * Baked in (not imported) so a future pi SDK addition cannot silently widen
 * what delegate exposes without a delegate code change.
 */
export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

/** The delegate-invocation tool. Runs may NOT inherit it unless the shape/agent opts in. */
export const DELEGATE_TOOL_NAME = "delegate";
/** Recovery remains foreground-only even when ordinary nested delegation is opted in. */
export const DELEGATE_RECOVER_TOOL_NAME = "delegate_recover";

/** Generic extension ask tool; workers replace its implementation with a safe shim. */
export const ASK_TOOL_NAME = "ask";

/**
 * Tools that are stripped from an inherited surface by default so a run
 * cannot recurse into delegation unless its shape/agent explicitly opts in
 * (orchestrate does; direct workers can via allowNestedDelegate). Mirrors
 * tintinweb's `EXCLUDED_TOOL_NAMES`.
 */
export const EXCLUDED_TOOL_NAMES: readonly string[] = [
	DELEGATE_TOOL_NAME,
	"delegate_steer",
	"delegate_cancel",
	DELEGATE_RECOVER_TOOL_NAME,
	"delegate_result",
	"delegate_status",
	// The consolidated surface (#265) must be excluded under the SAME rule.
	// Legacy names resolve to these before the strip runs, so omitting them
	// would let `tools: delegate_status` smuggle the whole control surface into
	// a worker that never opted into nested delegation.
	"delegate_control",
	"delegate_escalation",
];

/** The supervised clone's six-tool delegation harness (its shape default). */
export const SUPERVISED_HARNESS_TOOLS = [
	"message_subagent",
	"wait_for_worker",
	"inspect_worker",
	"cancel_worker",
	"restart_worker",
	"finish_delegation",
] as const;

/** Escalation raise verbs exposed to an enabled direct worker. [spec §2.3] */
export const ESCALATE_DECISION_TOOL = "escalate_decision";
export const ESCALATE_BLOCKER_TOOL = "escalate_blocker";
export const ESCALATE_AMENDMENT_TOOL = "escalate_amendment";

/** Escalation hop verbs exposed to an enabled supervisor. [spec §2.3] */
export const RESOLVE_ESCALATION_TOOL = "resolve_escalation";
export const ESCALATE_TOOL = "escalate";

/**
 * Session-declaration tools a worker may need even under a least-privilege
 * `tools:` allowlist, when a loaded extension actually claims them.
 *
 * These are not capabilities the agent file grants. They are the means to
 * discharge an obligation the DISPATCH created: `handoff.tasks` seeds a
 * checklist, and the seam then reads that list back as the lane's progress.
 * An agent that declares `tools:` at all lost them, so a seeded worker was
 * handed a plan it could not move and a supervisor watched `0/8 gap` for the
 * whole run (#338).
 *
 * Widening here is safe in a way that an `ext:` selector in an agent file is
 * not: no extension is named, nothing throws when none is loaded, and Pi
 * ignores an allowlist entry with no registered tool (`setActiveToolsByName`:
 * "Unknown tool names are ignored"). The caller decides whether a claimant is
 * actually present; see `claimedSessionToolNames`.
 */
export const SESSION_DECLARATION_TOOL_NAMES: readonly string[] = [TASKS_TOOL_NAME, FOCUS_TOOL_NAME];

/**
 * Which claimed session-declaration tools a surface should gain.
 *
 * The single home for this rule. The resolver applies it up front from the
 * dispatching session's view, and `amendClaimedSessionTools` re-applies it once
 * the worker's own extensions are loaded, which is the first moment the real
 * is known. Both must agree, so neither restates the conditions.
 */
export function sessionDeclarationToolsToAdd(
	claimed: readonly string[] | undefined,
	context: { hasExplicitAllowlist: boolean; isolated: boolean },
): string[] {
	// An isolated surface drops every extension tool by construction, and a
	// worker with no explicit allowlist already reaches these through Pi's
	// defaults — adding them there would convert implicit defaults into an
	// explicit list and NARROW the surface instead of widening it.
	if (context.isolated || !context.hasExplicitAllowlist) return [];
	return (claimed ?? []).filter((name) => SESSION_DECLARATION_TOOL_NAMES.includes(name));
}

/**
 * Which session role we're resolving a tool surface for.
 *
 * Historical names are retained for compatibility:
 * - `direct` means a plain worker session. Both a top-level direct dispatch and
 *   the inner worker within a supervised run use this role.
 * - `supervised` means the supervisor clone and its delegation harness, not the
 *   inner worker it supervises.
 * - `orchestrate` means the detached hosted driver.
 */
export type RunShape = "supervised" | "direct" | "orchestrate";

/** Per-call overrides (from the shape entry in the delegate tool call). */
export interface ToolSurfaceOverrides {
	/** Override the agent's `tools:` CSV entirely. */
	tools?: string[];
	/** Drop all extension tools (and skills). */
	isolated?: boolean;
	/** Custom tool names supplied by the shape (always force-included in the allow-list). */
	customToolNames?: readonly string[];
	/** Immutable per-slot preflight policy; enabled roles receive escalation verbs. */
	escalationPolicy?: EffectiveEscalationPolicy;
	/** Remove built-in write/edit and enforce a read-only worker surface. */
	readOnly?: unknown;
	/**
	 * Session-declaration tool names an actually-loaded extension claims.
	 *
	 * Supplied by the runner from the worker's own loaded extension set, never
	 * assumed: an empty or omitted list widens nothing. Names outside
	 * `SESSION_DECLARATION_TOOL_NAMES` are ignored, so this cannot become a
	 * general back door into a least-privilege allowlist.
	 */
	claimedSessionToolNames?: readonly string[];
}

/** A parsed `ext:` selector retained by the live worker scope. */
export interface ExtSelector {
	/** Authored owner identity. Kept as `extension` for the worker-scope wire contract. */
	extension: string;
	/** Optional package module id from the owner's `pi-delegate.modules` map. */
	module?: string;
	/** Narrowed bare tool name, or undefined for the compatibility whole-owner form. */
	tool?: string;
	/** Optional action grant, applied only after the tool provider is verified. */
	action?: string;
	/** Exact authored selector for diagnostics. */
	authored?: string;
	/** Whether the parser accepted the old final-slash form. */
	legacy?: boolean;
}

/** The concrete surface fed to `createAgentSession`. */
export interface ResolvedToolSurface {
	/**
	 * Stable names requested by the resolved worker surface. For a live `ext:`
	 * scope this is not necessarily the array passed to `createAgentSession`:
	 * Pi receives an unset `tools` gate plus a denylist so lifecycle-registered
	 * extension tools can enter the registry and be narrowed after binding.
	 * `undefined` still means "pi default" for workers without an explicit list.
	 */
	tools: string[] | undefined;
	/** Parsed `ext:` selectors for extension-tool narrowing. */
	extSelectors: ExtSelector[];
	/** True → drop all extension tools + skills. */
	isolated: boolean;
	/** Whether delegate-invocation tools are included in the returned allow-list. */
	includesDelegate: boolean;
	/** Whether this worker explicitly opted into delegate-family capabilities. */
	delegateOptIn: boolean;
	/** Diagnostics (e.g. unknown tool names that were warn-and-skipped). */
	diagnostics: string[];
	/** Names denied even if an extension attempts to register them later. */
	deniedToolNames: readonly string[];
	/**
	 * Per-tool action grants for the consolidated control surface (#265).
	 * `undefined` for a granted tool means unrestricted. A tool absent from this
	 * map was not granted an action-scoped entry, so it carries no restriction.
	 */
	actionGrants?: Record<string, string[] | undefined>;
	/**
	 * Whether this surface came from an explicit least-privilege allowlist.
	 *
	 * Retained so `amendClaimedSessionTools` can re-apply the session-declaration
	 * rule after the worker's extensions load, without re-deriving it from an
	 * `AgentConfig` the amending caller no longer has.
	 */
	hasExplicitAllowlist: boolean;
}

const optionalGlobalExtensionSelectorKeys = new WeakMap<ResolvedToolSurface, ReadonlySet<string>>();

/** Canonical selector identity shared by composition and resolved-surface provenance. */
export function canonicalExtensionSelectorKey(selector: ExtSelector): string {
	return JSON.stringify([
		selector.extension,
		selector.module ?? null,
		selector.tool ?? null,
		selector.action ?? null,
	]);
}

/** @internal True only for provenance attached by the trusted post-discovery transform. */
export function isOptionalGlobalExtensionSelector(
	surface: ResolvedToolSurface,
	selector: ExtSelector,
): boolean {
	return optionalGlobalExtensionSelectorKeys.get(surface)?.has(canonicalExtensionSelectorKey(selector)) === true;
}

/** @internal Serialize trusted post-discovery provenance for the detached driver transport. */
export function getOptionalGlobalExtensionSelectorKeys(surface: ResolvedToolSurface): readonly string[] {
	return [...(optionalGlobalExtensionSelectorKeys.get(surface) ?? [])];
}

/**
 * @internal Restore trusted coordinator provenance after detached-driver reconstruction.
 * Unknown keys are discarded so transport corruption can only make a selector stricter.
 */
export function setTrustedOptionalGlobalExtensionSelectorKeys(
	surface: ResolvedToolSurface,
	keys: readonly string[],
): ResolvedToolSurface {
	const selectedKeys = new Set(surface.extSelectors.map(canonicalExtensionSelectorKey));
	const retained = new Set(keys.filter((key) => selectedKeys.has(key)));
	if (retained.size > 0) optionalGlobalExtensionSelectorKeys.set(surface, retained);
	else optionalGlobalExtensionSelectorKeys.delete(surface);
	return surface;
}

/** @internal Preserve trusted selector provenance across a resolved-surface clone. */
export function copyOptionalGlobalExtensionSelectors(
	source: ResolvedToolSurface,
	target: ResolvedToolSurface,
): ResolvedToolSurface {
	const sourceKeys = optionalGlobalExtensionSelectorKeys.get(source);
	if (!sourceKeys) return target;
	const retained = new Set(
		target.extSelectors.map(canonicalExtensionSelectorKey).filter((key) => sourceKeys.has(key)),
	);
	if (retained.size > 0) optionalGlobalExtensionSelectorKeys.set(target, retained);
	return target;
}

const BUILTIN_SET = new Set<string>([...BUILTIN_TOOL_NAMES, ASK_TOOL_NAME]);
const EXCLUDED_SET = new Set<string>(EXCLUDED_TOOL_NAMES);
const POLICY_ONLY_TOOL_SET = new Set<string>([
	...SESSION_DECLARATION_TOOL_NAMES,
	ESCALATE_DECISION_TOOL,
	ESCALATE_BLOCKER_TOOL,
	ESCALATE_AMENDMENT_TOOL,
	RESOLVE_ESCALATION_TOOL,
	ESCALATE_TOOL,
]);

/** Whether a name provides an ordinary worker capability rather than policy. */
export function isUsableWorkerToolName(name: string): boolean {
	return !EXCLUDED_SET.has(name) && !POLICY_ONLY_TOOL_SET.has(name);
}

/**
 * Reject malformed `ext:` requests at worker construction time. Keeping the
 * parser diagnostic-only lets management/UI callers inspect bad input, but a
 * runtime must never turn an empty parsed allowlist into Pi's broad defaults.
 */
export function assertValidExtensionToolSelectors(
	surface: Pick<ResolvedToolSurface, "diagnostics">,
): void {
	const invalid = surface.diagnostics.filter((diagnostic) =>
		diagnostic.startsWith(`[tool-selector:${ToolSelectorDiagnosticCode.SELECTOR_MALFORMED}]`),
	);
	if (invalid.length > 0) {
		throw new Error(`invalid extension tool selector: ${invalid.join("; ")}`);
	}
}

/**
 * Parse a `tools:` CSV (already split into entries) into built-in names,
 * `ext:` selectors, and diagnostics for unknown entries.
 *
 * Unknown plain names are warn-and-skipped (a diagnostic is recorded), NOT a
 * hard error — a single bad name must not fail run construction. Delegate
 * tool names are recognised here so an opted-in direct worker can request
 * exactly the delegate-family tools it needs; the resolver still strips them
 * unless the agent/shape explicitly permits nested delegation.
 */
export function parseToolEntries(entries: readonly string[]): {
	builtins: string[];
	extSelectors: ExtSelector[];
	diagnostics: string[];
	/**
	 * Action grants for the consolidated control tools (#265), merged per tool.
	 * A tool present with `actions: undefined` is an unrestricted grant. Absent
	 * means the surface never granted that tool at all.
	 */
	actionGrants?: Record<string, string[] | undefined>;
} {
	const builtins: string[] = [];
	const extSelectors: ExtSelector[] = [];
	const diagnostics: string[] = [];
	const grantEntries: string[] = [];
	for (const raw of entries) {
		const entry = raw.trim();
		if (!entry) continue;
		if (entry.startsWith("ext:")) {
			const parsedSelector = parseSelectorToolGrant(entry);
			if ("error" in parsedSelector || parsedSelector.kind !== "extension") {
				diagnostics.push(toolSelectorDiagnostic(
					ToolSelectorDiagnosticCode.SELECTOR_MALFORMED,
					`malformed ext selector ${JSON.stringify(entry)}`,
				));
				continue;
			}
			const lowerTool = parsedSelector.tool?.toLowerCase();
			const authoredGrant = lowerTool && parsedSelector.action
				? `${lowerTool}:${parsedSelector.action.toLowerCase()}`
				: lowerTool;
			// A delegate-family selector is normalized into the same grant
			// representation as its bare spelling. The selector remains in the live
			// scope so owner and module checks can prove its provider before lowering.
			const delegateGrant = lowerTool === DELEGATE_TOOL_NAME
				? { tool: DELEGATE_TOOL_NAME }
				: authoredGrant ? parseControlToolGrant(authoredGrant) : undefined;
			if (delegateGrant && EXCLUDED_SET.has(delegateGrant.tool)) {
				if (delegateGrant.actions?.includes("recover")) {
					diagnostics.push(
						`tools-error: "${entry}" is not grantable; recovery dispatches new work and stays with the originating session; skipped`,
					);
					continue;
				}
				if (!builtins.includes(delegateGrant.tool)) builtins.push(delegateGrant.tool);
				const normalizedGrant = delegateGrant.actions === undefined
					? delegateGrant.tool
					: `${delegateGrant.tool}:${delegateGrant.actions[0] ?? ""}`;
				grantEntries.push(normalizedGrant);
				extSelectors.push({
					extension: parsedSelector.owner,
					...(parsedSelector.module ? { module: parsedSelector.module } : {}),
					tool: delegateGrant.tool,
					...(delegateGrant.actions?.[0] ? { action: delegateGrant.actions[0] } : {}),
				});
				continue;
			}
			extSelectors.push({
				extension: parsedSelector.owner,
				...(parsedSelector.module ? { module: parsedSelector.module } : {}),
				...(parsedSelector.tool ? { tool: parsedSelector.tool } : {}),
				...(parsedSelector.action ? { action: parsedSelector.action } : {}),
			});
			continue;
		}
		const lower = entry.toLowerCase();
		// Consolidated surface (#265): `delegate_control:status` grants the action
		// tool, and a legacy name like `delegate_status` is an alias for the action
		// that replaced it. Both resolve to the advertised tool here so an agent
		// file written against either spelling keeps working; without this, every
		// existing `tools: delegate_status` would fall through to warn-and-skip and
		// silently lose the tool.
		const grant = parseControlToolGrant(lower);
		if (grant) {
			// `delegate_recover` was foreground-only as a NAME. Mapping it onto the
			// action tool would hand a worker the whole control surface, so the
			// alias is refused rather than widened. `delegate_control:recover` is
			// likewise not a way in: the runtime rejects the action per call, and
			// this keeps the surface layer from implying otherwise.
			// Checked on the RESOLVED grant, not the spelling: an exact-string test
			// missed `delegate_recover:status`, which parses to the recover action
			// because a legacy alias ignores its suffix.
			if (grant.actions?.includes("recover")) {
				diagnostics.push(
					`tools-error: "${entry}" is not grantable; recovery dispatches new work and stays with the originating session; skipped`,
				);
				continue;
			}
			if (!builtins.includes(grant.tool)) builtins.push(grant.tool);
			grantEntries.push(lower);
			continue;
		}
		if (BUILTIN_SET.has(lower) || EXCLUDED_SET.has(lower)) {
			builtins.push(lower);
		} else {
			// warn-and-skip: unknown tool name, do not throw.
			diagnostics.push(
				`tools-error: tool "${entry}" is not a known built-in (read/bash/edit/write/grep/find/ls/ask), delegate-family tool, or ext: selector; skipped`,
			);
		}
	}
	const merged = mergeToolGrants(grantEntries);
	// Omitted entirely when nothing granted an action-scoped entry, so the
	// common result keeps its previous shape and a caller comparing the whole
	// object does not see a field that carries no information.
	if (merged.size === 0) return { builtins, extSelectors, diagnostics };
	const actionGrants: Record<string, string[] | undefined> = {};
	for (const [tool, grant] of merged) actionGrants[tool] = grant.actions ? [...grant.actions] : undefined;
	return { builtins, extSelectors, diagnostics, actionGrants };
}

/**
 * Resolve the concrete tool surface for a run of the given shape.
 *
 * Session-role DEFAULTS (when the agent has no `tools:` and no override):
 *   - supervised  → the supervisor clone's 6-tool CLONE_* harness.
 *   - direct      → a plain worker's resolved tools (or pi default if none),
 *                   including the inner worker within a supervised run.
 *   - orchestrate → the full inherited built-in set PLUS `delegate` (recursion
 *                   bounded by the depth cap, not tool exclusion).
 *
 * The returned `tools` allow-list ALWAYS includes any `customToolNames` the
 * shape passed (otherwise pi's Set filter would strip the shape's own custom
 * tools). It is never `[]`.
 */
export function resolveRunToolSurface(
	agent: AgentConfig,
	shape: RunShape,
	overrides: ToolSurfaceOverrides = {},
): ResolvedToolSurface {
	assertReadOnlyValue(overrides.readOnly);
	const isolated = overrides.isolated ?? false;
	const customToolNames = overrides.customToolNames ?? [];
	// Historical AgentConfig call sites often materialize `tools: []` to mean
	// "unspecified". Preserve that compatibility while still treating an
	// invocation override (including `tools: []`) and any non-empty agent list
	// as an explicit least-privilege allowlist that must fail closed.
	const hasExplicitAllowlist = overrides.tools !== undefined || (agent.tools?.length ?? 0) > 0;
	const rawEntries = overrides.tools ?? agent.tools ?? [];
	const { builtins, extSelectors, diagnostics, actionGrants } = parseToolEntries(rawEntries);

	const delegateOptIn = shape === "orchestrate" || (shape === "direct" && agent.allowNestedDelegate === true);
	// Built-in write/edit remain available for declared artifact work. The names
	// stay denied to extension owners because confinement cannot prove that a
	// replacement tool honors the built-in path contract.
	const deniedToolNames = overrides.readOnly === true ? ["write", "edit"] : [];
	const selectableBuiltins = delegateOptIn
		? builtins
		: builtins.filter((name) => !EXCLUDED_SET.has(name));
	const filteredBuiltins = selectableBuiltins;
	const selectableExtSelectors = isolated
		? []
		: extSelectors.filter((selector) => !selector.tool || !deniedToolNames.includes(selector.tool));
	// Delegate-family tools are policy capabilities, not a usable worker
	// surface on their own. A caller must name at least one ordinary builtin or
	// non-delegate extension capability; otherwise construction must not turn
	// the empty result into Pi's broad defaults.
	const hasUsableBuiltin = filteredBuiltins.some(isUsableWorkerToolName);
	const hasUsableExtensionSelector = selectableExtSelectors.some(
		(selector) => selector.tool === undefined || isUsableWorkerToolName(selector.tool),
	);
	const hasUsableCustomTool = customToolNames.some(
		isUsableWorkerToolName,
	);
	if (
		hasExplicitAllowlist &&
		!hasUsableBuiltin &&
		!hasUsableExtensionSelector &&
		!hasUsableCustomTool
	) {
		const detail = diagnostics.length > 0 ? ` ${diagnostics.join(" ")}` : "";
		throw new Error(
			`Explicit tools allowlist selects no usable tools; refusing to widen the worker to Pi defaults.${detail}`,
		);
	}

	// Compose the allow-list per shape.
	let allow: string[];
	if (shape === "supervised" && !hasExplicitAllowlist && rawEntries.length === 0 && customToolNames.length === 0) {
		// Default supervised harness.
		allow = [...SUPERVISED_HARNESS_TOOLS];
	} else if (shape === "orchestrate" && !hasExplicitAllowlist) {
		// Only an implicit hosted surface receives the full built-in set + delegate.
		allow = [...BUILTIN_TOOL_NAMES, DELEGATE_TOOL_NAME];
	} else if (overrides.readOnly === true && rawEntries.length === 0) {
		// Keep the surface explicit so readOnly always has the same confined tools,
		// including write/edit for scratch and declared artifact output.
		allow = ["read", "bash", "write", "edit"];
	} else {
		// direct (or supervised with explicit tools): the agent's resolved
		// built-ins, plus any explicitly-named custom tools.
		allow = [...filteredBuiltins];
	}
	if (shape === "direct" && overrides.escalationPolicy?.enabled === true && rawEntries.length === 0) {
		// Adding custom tools turns Pi's implicit defaults into an explicit
		// allow-list. Preserve the ordinary direct-worker default surface.
		allow = ["read", "bash", "edit", "write"];
	}

	// Always force-include the shape's custom tool names so pi's allow-list
	// Set filter does not strip them.
	for (const name of customToolNames) {
		if (!allow.includes(name)) allow.push(name);
	}

	const escalationToolNames = overrides.escalationPolicy?.enabled === true
		? shape === "direct"
			? [ESCALATE_DECISION_TOOL, ESCALATE_BLOCKER_TOOL, ESCALATE_AMENDMENT_TOOL]
			: shape === "supervised"
				? [RESOLVE_ESCALATION_TOOL, ESCALATE_TOOL]
				: []
		: [];
	for (const name of escalationToolNames) {
		if (!allow.includes(name)) allow.push(name);
	}

	for (const name of sessionDeclarationToolsToAdd(overrides.claimedSessionToolNames, { hasExplicitAllowlist, isolated })) {
		if (!allow.includes(name)) allow.push(name);
	}

	// Extension-owner denials are enforced by the live tool scope. Built-in names
	// remain in the allowlist so readOnly workers can write declared artifacts.
	// Strip delegate-invocation tools unless this shape/agent opts in.
	if (!delegateOptIn) {
		allow = allow.filter((n) => !EXCLUDED_SET.has(n));
	}
	// `allowNestedDelegate` grants bounded recursive dispatch/control, but never
	// live foreground recovery authority. Defense in depth in the tool handler
	// independently rejects nested lineage as well.
	//
	// Under the consolidated surface (#265) `recover` is an ACTION rather than a
	// tool, so the name-level strip cannot express it. The equivalent rule is
	// enforced per action inside `delegate_control`, keyed on the worker session
	// (see WORKER_DENIED_CONTROL_ACTIONS). This filter stays for the legacy tool
	// name, which remains an accepted allowlist alias.
	allow = allow.filter((n) => n !== DELEGATE_RECOVER_TOOL_NAME);

	// Foot-gun guard: never return an empty allow-list (would strip
	// everything incl. customTools). Empty → undefined (pi default).
	const tools = allow.length > 0 ? dedupe(allow) : undefined;

	const surface: ResolvedToolSurface = {
		tools,
		extSelectors: selectableExtSelectors,
		isolated,
		includesDelegate: tools?.some((n) => EXCLUDED_SET.has(n)) === true,
		delegateOptIn,
		diagnostics,
		deniedToolNames,
		hasExplicitAllowlist,
		// Only report grants for tools that actually survived into the allow-list;
		// a grant on a stripped tool would be a restriction on nothing.
		//
		// An UNRESTRICTED grant is carried as an explicit `undefined` value rather
		// than being dropped, so a consumer can tell "granted every action" apart
		// from "not granted at all". Dropping it would make the two look the same
		// and turn a restriction into a silent allow.
		...(actionGrants
			? {
					actionGrants: Object.fromEntries(
						Object.entries(actionGrants).filter(([tool]) => tools?.includes(tool)),
					),
				}
			: {}),
	};
	if (overrides.tools === undefined) {
		const optionalKeys = new Set(
			[...getOptionalGlobalToolEntries(agent)].flatMap((entry) =>
				parseToolEntries([entry]).extSelectors.map(canonicalExtensionSelectorKey)),
		);
		const selectedOptionalKeys = new Set(
			selectableExtSelectors.map(canonicalExtensionSelectorKey).filter((key) => optionalKeys.has(key)),
		);
		if (selectedOptionalKeys.size > 0) {
			optionalGlobalExtensionSelectorKeys.set(surface, selectedOptionalKeys);
		}
	}
	return surface;
}

/** A read-only snapshot of one extension's registered tool surface. */
export interface ToolSurfaceInventoryEntry {
	/** Canonical normalized selector identity. */
	identity: string;
	/** Loader provenance retained for diagnostics and alternate selector matching. */
	source?: string;
	path?: string;
	packageName?: string;
	/** Package root, when the foreground provenance exposes one. */
	packageRoot?: string;
	/** Tool names registered by this extension, without executing it. */
	toolNames: readonly string[];
}

export interface ToolSurfaceInventoryResolution {
	/** Exact configured entries that cannot be resolved to a usable capability. */
	unresolvedSelectors: string[];
	/** Exact configured entries whose ownership or inventory cannot be verified. */
	uncertainSelectors: string[];
	/** Package identities absent from the read-only inventory. */
	missingPackages: string[];
}

export interface ToolSurfaceInventoryResolutionOptions {
	/** True when the foreground inventory could not be read completely. */
	inventoryDegraded?: boolean;
}

/**
 * Resolve an agent's configured tool surface against a read-only inventory.
 *
 * This is deliberately separate from the live worker scope: health must answer
 * whether dispatch is possible without loading extension factories or creating a
 * worker session. The inventory carries the names already registered by the
 * foreground session; this function only parses and compares strings.
 */
export function resolveToolSurfaceAgainstInventory(
	agent: AgentConfig,
	inventory: readonly ToolSurfaceInventoryEntry[],
	options: ToolSurfaceInventoryResolutionOptions = {},
): ToolSurfaceInventoryResolution {
	const entries = agent.tools ?? [];
	const parsed = parseToolEntries(entries);
	const malformedSelectors = entries
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith("ext:") && parseToolEntries([entry]).extSelectors.length === 0 &&
			parseToolEntries([entry]).diagnostics.some((diagnostic) =>
				diagnostic.startsWith(`[tool-selector:${ToolSelectorDiagnosticCode.SELECTOR_MALFORMED}]`)));
	let surface: ResolvedToolSurface | undefined;
	try {
		surface = resolveRunToolSurface(agent, "direct");
		// This is the exact construction-time validator used by worker preflight.
		assertValidExtensionToolSelectors({ diagnostics: parsed.diagnostics });
	} catch {
		// Health is a per-agent scan: an unconstructable surface fails here without
		// aborting the scan, and sibling agents continue to be checked. Only provably
		// broken parts become BROKEN -- a malformed selector, an absent package, an
		// absent named export. A present-package ext: selector stays subject to the
		// UNKNOWN ceiling even on this path, because the inventory is name-collapsed
		// and cannot prove what the package does or does not provide. Dispatch still
		// rejects such a surface at construction; health simply does not claim to
		// have proven it.
	}
	const unresolvedSelectors: string[] = [...malformedSelectors];
	const uncertainSelectors: string[] = [];
	const missingPackages: string[] = [];
	const identitiesFor = (entry: ToolSurfaceInventoryEntry): Set<string> => {
		const identities = new Set<string>();
		const add = (value: unknown): void => {
			if (typeof value !== "string" || value.trim().length === 0) return;
			const normalized = normalizeExtensionIdentity(value);
			identities.add(normalized);
			const npm = normalizeNpmIdentityForInventory(value);
			if (npm) identities.add(npm);
		};
		for (const value of [entry.identity, entry.source, entry.path, entry.packageName]) add(value);
		if (entry.packageName) add(entry.packageName.split("/").at(-1));
		if (entry.path) {
			const aliases = extensionSelectorAliases({ path: entry.path, resolvedPath: entry.path } as Extension);
			for (const alias of aliases) add(alias);
		}
		if (entry.packageRoot && entry.path && entry.packageName) {
			const entrypoint = path.relative(entry.packageRoot, entry.path).replaceAll("\\\\", "/");
			if (entrypoint && !entrypoint.startsWith("..")) {
				add(`${entry.packageName}#${entrypoint}`);
				if (entry.source) add(`${entry.source}#${entrypoint}`);
			}
		}
		return identities;
	};
	const normalizedInventory = inventory.map((entry) => ({ entry, identities: identitiesFor(entry) }));
	for (const { selector, rawSelector } of entries.flatMap((entry) => {
		const rawSelector = entry.trim();
		const one = parseToolEntries([rawSelector]);
		return one.extSelectors.map((selector) => ({ selector, rawSelector }));
	})) {
		const extensionIdentity = normalizeExtensionIdentity(selector.extension);
		const npmIdentity = normalizeNpmIdentityForInventory(selector.extension);
		// A partial foreground inventory cannot prove either presence or unique
		// ownership. Never turn that uncertainty into a BROKEN or OK verdict.
		if (options.inventoryDegraded) {
			uncertainSelectors.push(rawSelector);
			continue;
		}
		const owners = normalizedInventory.filter(({ entry, identities }) => {
			const canonicalPiDelegate = [entry.identity, entry.packageName, entry.source]
				.some((value) => typeof value === "string" && isPiDelegatePackageIdentifier(value));
			if (extensionIdentity === "pi-delegate" && !canonicalPiDelegate) return false;
			return identities.has(extensionIdentity) || (npmIdentity !== undefined && identities.has(npmIdentity));
		});
		if (owners.length === 0) {
			unresolvedSelectors.push(rawSelector);
			if (!missingPackages.includes(selector.extension)) missingPackages.push(selector.extension);
			continue;
		}
		const registeredNames = new Set(owners.flatMap(({ entry }) => entry.toolNames));
		const selectedNames = selector.tool === undefined ? [...registeredNames] : [selector.tool];
		const missingSelectedName = selectedNames.some((name) =>
			!registeredNames.has(name) || (!surface?.delegateOptIn && EXCLUDED_SET.has(name)));
		if (missingSelectedName || registeredNames.size === 0) {
			unresolvedSelectors.push(rawSelector);
			continue;
		}
		// This is structural, not a detector for one known ambiguity. In the
		// installed Pi host, @earendil-works/pi-coding-agent's agent-session.js:
		// 613 getAllTools() reads a name-keyed Map, and :623 looks up by name.
		// Same-named registrations therefore collapse before health can observe
		// them. Ownership cannot be proven without loading Extension[] entries
		// and their extension.tools maps, but health must not load extensions.
		// Every present-package ext: selector is consequently UNKNOWN.
		uncertainSelectors.push(rawSelector);
	}
	if (!surface) {
		for (const entry of entries) {
			const trimmed = entry.trim();
			if (trimmed && !unresolvedSelectors.includes(trimmed)) unresolvedSelectors.push(trimmed);
		}
	}
	// `resolveRunToolSurface` already rejects an explicit all-policy/unknown
	// allowlist. Preserve the exact configured entries when that rejection is
	// surfaced to health, rather than hiding the cause behind its error text.
	if (surface?.hasExplicitAllowlist && surface.tools?.every((name) => !isUsableWorkerToolName(name)) === true) {
		for (const entry of entries) {
			if (!entry.trim().startsWith("ext:") && !unresolvedSelectors.includes(entry.trim())) unresolvedSelectors.push(entry.trim());
		}
	}
	// Do not exempt explicit `ext:` selectors from this uncertainty ceiling:
	// the floor's condition was computed from the name-collapsed inventory, so no
	// exemption resting on it can be sound. A policy-only sole selector on a
	// present package is therefore UNKNOWN rather than BROKEN by design.
	const uncertainSet = new Set(uncertainSelectors);
	return {
		unresolvedSelectors: unresolvedSelectors.filter((selector) => !uncertainSet.has(selector)),
		uncertainSelectors,
		missingPackages,
	};
}

/** Artifact writer capability that must survive requested and final live tool resolution. */
export interface ArtifactWriterRequirement {
	readonly artifactName: string;
	/** Read-only confinement permits artifact creation only through built-in write. */
	readonly readOnly: boolean;
}

/** Built-in tool names that can create a fresh artifact candidate in this mode. */
export function artifactWriterToolNames(
	requirement: Pick<ArtifactWriterRequirement, "readOnly">,
): readonly ("write" | "bash")[] {
	return requirement.readOnly ? ["write"] : ["write", "bash"];
}

/**
 * Assert that an artifact producer's resolved requested surface names a writer
 * supported by its confinement mode. An omitted allowlist means Pi's default
 * built-ins, which include both writers; an explicit allowlist must name one.
 */
export function assertArtifactWriterCapability(
	surface: Pick<ResolvedToolSurface, "tools" | "hasExplicitAllowlist">,
	requirement: ArtifactWriterRequirement,
): void {
	const acceptedWriters = artifactWriterToolNames(requirement);
	const hasWriter = acceptedWriters.some((name) => surface.tools?.includes(name) === true);
	if (hasWriter || (!surface.hasExplicitAllowlist && surface.tools === undefined)) return;
	if (requirement.readOnly) {
		throw new Error(
			`artifact ${JSON.stringify(requirement.artifactName)} requires the built-in write tool, ` +
				`but the explicit tools allowlist does not include it; add "write" to tools before dispatch`,
		);
	}
	throw new Error(
		`artifact ${JSON.stringify(requirement.artifactName)} requires the built-in write or bash tool, ` +
			`but the explicit tools allowlist includes neither; add "write" or "bash" to tools before dispatch`,
	);
}

/**
 * Resolve the tool surface for a plain worker session.
 *
 * This is deliberately shared by `runDirectWorker` and the inner worker in
 * `runFork`. A top-level dispatch shape does not change the worker's capability
 * contract. The supervisor clone uses `resolveRunToolSurface(...,
 * "supervised")` separately and never inherits the worker's nested-delegate
 * opt-in.
 */
export function resolveWorkerToolSurface(
	agent: AgentConfig,
	overrides: ToolSurfaceOverrides = {},
): ResolvedToolSurface {
	return resolveRunToolSurface(agent, "direct", overrides);
}

/**
 * Re-apply the session-declaration rule once the WORKER's extensions are known.
 *
 * The surface has to be resolved before the resource loader exists, so the
 * up-front pass can only use the dispatching session's view of what is loaded.
 * A worker can load a different extension set — `additionalExtensionPaths`, or a
 * package present for the parent and not the child — so this is the first point
 * where the answer is authoritative.
 *
 * Returns the same object when nothing changes, so a caller can cheaply tell
 * whether the worker actually gained anything.
 */
export function amendClaimedSessionTools(
	surface: ResolvedToolSurface,
	claimed: readonly string[],
): ResolvedToolSurface {
	const additions = sessionDeclarationToolsToAdd(claimed, {
		hasExplicitAllowlist: surface.hasExplicitAllowlist,
		isolated: surface.isolated,
	}).filter((name) => !surface.deniedToolNames.includes(name) && !(surface.tools ?? []).includes(name));
	if (additions.length === 0) return surface;
	// `tools: undefined` has two meanings, and only one of them is "pi default".
	//
	// With no explicit allowlist it really is the default surface, which already
	// includes extension tools; materializing a list there would NARROW it to
	// exactly these names. But `resolveRunToolSurface` also collapses to
	// undefined when an explicit allowlist selected no built-in at all — an
	// extension-only `tools: ["ext:..."]` agent. That surface is explicitly
	// restricted, the claimed tool is not in it, and returning early there let a
	// dispatch seed a checklist the worker still could not move: the very bug
	// this function exists to fix, one door over.
	if (surface.tools === undefined) {
		if (!surface.hasExplicitAllowlist) return surface;
		return copyOptionalGlobalExtensionSelectors(surface, { ...surface, tools: dedupe(additions) });
	}
	return copyOptionalGlobalExtensionSelectors(surface, { ...surface, tools: [...surface.tools, ...additions] });
}

export function extensionSelectorAliases(extension: Extension): Set<string> {
	const aliases = new Set<string>();
	for (const raw of [extension.path, extension.resolvedPath]) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		const normalized = normalizeExtensionIdentity(raw);
		aliases.add(normalized);
		addNearestPackageAliases(aliases, raw);
		const segments = normalized.split("/").filter(Boolean);
		const file = segments.at(-1);
		if (!file) continue;
		const stem = file.replace(/\.(?:[cm]?[jt]s)$/i, "");
		aliases.add(stem);
		// Directory-style extensions conventionally enter through index/main.
		// Expose the immediate package directory as the human selector, but do
		// not expose every ancestor ("tmp", "src", etc.) as an alias.
		if (["index", "main", "mod"].includes(stem)) {
			const parent = segments.at(-2);
			if (parent) aliases.add(parent);
		}
	}
	return aliases;
}

/**
 * A provider's stable protocol identity is its package name, not whichever
 * checkout/worktree directory happens to contain `index.ts`. Pi's extension
 * provenance currently exposes paths but not package metadata, so recover the
 * nearest manifest name as an additional canonical alias. This also lets a
 * full-path-loaded worktree acknowledge as `adaptive-thinking` without
 * pretending the branch directory is the provider identity.
 */
function addNearestPackageAliases(aliases: Set<string>, rawPath: string): void {
	if (rawPath.startsWith("<") || rawPath.startsWith("file:")) return;
	const pathApi = /^[A-Za-z]:[\\/]/.test(rawPath) ? path.win32 : path;
	let current = pathApi.dirname(rawPath);
	const root = pathApi.parse(current).root;
	for (let depth = 0; depth < 12 && current && current !== root; depth++) {
		const manifestPath = pathApi.join(current, "package.json");
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
			if (typeof manifest.name === "string" && manifest.name.trim()) {
				const packageName = normalizeExtensionIdentity(manifest.name);
				aliases.add(packageName);
				const unscoped = packageName.split("/").at(-1);
				if (unscoped) aliases.add(unscoped);
				return;
			}
		} catch {
			// Missing/malformed manifests are not extension-load failures; continue
			// toward the filesystem root and retain path-derived aliases.
		}
		const parent = pathApi.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/** Normalize path-like extension identities across POSIX and Windows hosts. */
export function normalizeExtensionIdentity(raw: string): string {
	return raw.trim().replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function normalizeNpmIdentityForInventory(raw: string): string | undefined {
	return normalizeNpmIdentity(raw)?.toLowerCase();
}

function dedupe(names: string[]): string[] {
	return [...new Set(names)];
}


/** @deprecated Use {@link RunShape}; retained for compatibility. */
export type ForkShape = RunShape;
/** @deprecated Use {@link resolveRunToolSurface}; retained for compatibility. */
export const resolveForkToolSurface = resolveRunToolSurface;
