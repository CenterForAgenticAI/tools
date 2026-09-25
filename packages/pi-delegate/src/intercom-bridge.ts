/**
 * Phase D D.1 — intercom bridge instruction injection.
 *
 * When `pi-intercom` is installed AND the worker is in direct/chain mode
 * AND the bridge is enabled, we append a runtime instruction to the
 * worker's system prompt telling it how to coordinate with the
 * orchestrator session via the `intercom` tool.
 *
 * Source-compatible with pi-subagents' instruction template:
 *   - Same `INTERCOM_BRIDGE_MARKER` sentinel string (so log scrapers /
 *     tests that look for it work across both extensions).
 *   - Same `{orchestratorTarget}` placeholder in the template.
 *   - Same `mode: "off" | "always" | "fork-only"` semantics, except
 *     pi-delegate doesn't yet support `seed_from: "branch"` so
 *     `"fork-only"` collapses to `"off"` here.
 *
 * Supervised forks (the multi-turn fork-clone path) deliberately do NOT
 * get an intercom bridge — the supervisor IS a clone of the main agent,
 * so the "orchestrator" concept is ambiguous and intercom-ing back
 * would race with the fork-clone's own LLM turn. Documented in the
 * parity plan §2.7.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import type { DelegateConfig } from "./config.js";
import {
	derivePortableExtensionIdentity,
	portableExtensionIdentityMatchesSelector,
	resolveExtensionPolicyCandidateSelection,
} from "./extension-policy.js";

/** Marker prefix in the injected instruction. Matches pi-subagents byte-for-byte. */
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";

/** Bridge mode: when to inject the instruction. */
export type IntercomBridgeMode = "off" | "always" | "fork-only";

export interface IntercomBridgeConfig {
	/** When to inject. Default: "always" (when pi-intercom is available). */
	mode?: IntercomBridgeMode;
	/**
	 * Optional path to a `.md` file whose contents replace the default
	 * template. Supports the `{orchestratorTarget}` placeholder.
	 */
	instructionFile?: string;
}

export interface ResolveBridgeArgs {
	config: DelegateConfig;
	agent: AgentConfig;
	/** Direct/chain modes pass true; supervised passes false. */
	directMode: boolean;
	/**
	 * The intercom name of the parent session. Typically a `subagent-chat-…`
	 * style identifier resolved from the main session's name/id.
	 */
	orchestratorTarget?: string;
	/**
	 * Override path for the pi-intercom extension dir. Used by tests so we
	 * don't depend on the real ~/.pi/agent/extensions/pi-intercom/ being
	 * present. Production resolution hits that path by default.
	 */
	intercomExtensionDir?: string;
	/**
	 * Override path for the pi-intercom config file. Used by tests. The
	 * default looks at ~/.pi/agent/intercom/config.json.
	 */
	intercomConfigPath?: string;
}

export interface ResolveBridgeWithPolicyArgs extends ResolveBridgeArgs {
	cwd: string;
	agentDir: string;
	/** Test seam for deterministic package/source provenance. */
	policyResolver?: typeof resolveExtensionPolicyCandidateSelection;
}

export interface ResolvedBridge {
	active: boolean;
	mode: IntercomBridgeMode;
	orchestratorTarget?: string;
	/**
	 * Final instruction text. Empty string when `active === false`.
	 */
	instruction: string;
	/**
	 * Diagnostic reason — surfaced in run-history / logs when the bridge
	 * was wanted but couldn't be activated. Only populated when
	 * `active === false`.
	 */
	reason?: string;
}

const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `${INTERCOM_BRIDGE_MARKER} use intercom only for coordination with the orchestrator session "{orchestratorTarget}".
- Need a decision or blocked: intercom({ action: "ask", to: "{orchestratorTarget}", message: "<question>" })
- Blocked or explicitly asked to send progress: intercom({ action: "send", to: "{orchestratorTarget}", message: "UPDATE: <summary>" })

Do not send routine completion handoffs through intercom. If no coordination is needed, return a focused task result.`;

/**
 * Decide whether to inject the bridge instruction. Pure function — does
 * filesystem reads (for the instructionFile and the pi-intercom availability
 * check) but no logging side-effects.
 *
 * Resolution order:
 *   1. `mode === "off"` → inactive.
 *   2. Supervised mode (`directMode === false`) → inactive (see §2.7).
 *   3. `pi-intercom` not available (extension dir missing) → inactive.
 *   4. pi-intercom config explicitly disabled (`enabled: false`) → inactive.
 *   5. Agent explicitly excludes `pi-intercom` through
 *      `extensionExclude:` → inactive.
 *   6. `mode === "fork-only"` → inactive (Phase D follow-up: needs
 *      `seed_from: "branch"` to be meaningful).
 *   7. Otherwise: inject.
 *
 * `orchestratorTarget` falls through into the instruction template via
 * the `{orchestratorTarget}` placeholder.
 */
export function resolveIntercomBridge(args: ResolveBridgeArgs): ResolvedBridge {
	const cfg = args.config.intercomBridge ?? {};
	const mode = resolveBridgeMode(cfg.mode);

	if (mode === "off") {
		return { active: false, mode, instruction: "", reason: "config: mode=off" };
	}
	if (!args.directMode) {
		return {
			active: false,
			mode,
			instruction: "",
			reason: "supervised mode: bridge target is ambiguous",
		};
	}

	const intercomDir =
		args.intercomExtensionDir ??
		path.join(getDefaultPiAgentDir(), "extensions", "pi-intercom");
	if (!fs.existsSync(intercomDir)) {
		return {
			active: false,
			mode,
			instruction: "",
			reason: `pi-intercom not installed at ${intercomDir}`,
		};
	}

	const intercomConfigPath =
		args.intercomConfigPath ?? path.join(getDefaultPiAgentDir(), "intercom", "config.json");
	const configStatus = readIntercomConfig(intercomConfigPath);
	if (!configStatus.enabled) {
		return {
			active: false,
			mode,
			instruction: "",
			reason: `pi-intercom disabled by config at ${intercomConfigPath}`,
		};
	}

	if (agentExcludesIntercom(args.agent, intercomDir)) {
		return {
			active: false,
			mode,
			instruction: "",
			reason: "agent.extensionExclude excludes pi-intercom",
		};
	}

	if (mode === "fork-only") {
		// `seed_from: "branch"` isn't yet a supported parameter — Phase D
		// follow-up (§13.4). For now, fork-only collapses to inactive.
		return {
			active: false,
			mode,
			instruction: "",
			reason: "mode=fork-only requires seed_from=branch (Phase D follow-up)",
		};
	}

	const target = args.orchestratorTarget ?? "orchestrator";
	const template = readInstructionTemplate(cfg.instructionFile) ?? DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
	const instruction = template.replaceAll("{orchestratorTarget}", target);
	return { active: true, mode, orchestratorTarget: target, instruction };
}

/**
 * Resolve bridge activation against the same pre-factory candidate policy as
 * worker construction. The synchronous resolver remains for callers/tests
 * without worker context; production direct/chain dispatch uses this form so
 * npm/git-qualified exclusions cannot disagree with the runtime loader.
 */
export async function resolveIntercomBridgeWithPolicy(
	args: ResolveBridgeWithPolicyArgs,
): Promise<ResolvedBridge> {
	const agentWithoutExclusion: AgentConfig = {
		...args.agent,
		extensionExclude: undefined,
	};
	const intercomDir = args.intercomExtensionDir ?? path.join(args.agentDir, "extensions", "pi-intercom");
	const intercomConfigPath = args.intercomConfigPath ?? path.join(args.agentDir, "intercom", "config.json");
	const resolvedArgs: ResolveBridgeArgs = {
		...args,
		intercomExtensionDir: intercomDir,
		intercomConfigPath,
	};
	const baseline = resolveIntercomBridge({ ...resolvedArgs, agent: agentWithoutExclusion });
	if (!baseline.active || !args.agent.extensionExclude?.length) return baseline;

	const resolver = args.policyResolver ?? resolveExtensionPolicyCandidateSelection;
	const selection = await resolver(args.agent, {
		cwd: args.cwd,
		agentDir: args.agentDir,
	});
	const entrypointKeys = new Set(intercomEntrypoints(intercomDir).map(canonicalPathKey));
	const relevant = selection.candidates.filter((candidate) =>
		entrypointKeys.has(canonicalPathKey(candidate.path)),
	);
	if (relevant.length === 0) {
		// Preserve compatibility for bare development installs that Pi's package
		// manager does not report as configured; the sync fallback still handles
		// package-name/path/repository selectors.
		return resolveIntercomBridge(resolvedArgs);
	}
	const selectedKeys = new Set(selection.selected.map((candidate) => canonicalPathKey(candidate.path)));
	if (relevant.some((candidate) => selectedKeys.has(canonicalPathKey(candidate.path)))) {
		return baseline;
	}
	return {
		active: false,
		mode: baseline.mode,
		instruction: "",
		reason: "resolved extension policy excludes pi-intercom",
	};
}

/** Default agent dir lookup. Centralised so tests can swap if needed. */
function getDefaultPiAgentDir(): string {
	return path.join(process.env.HOME ?? "", ".pi", "agent");
}

function resolveBridgeMode(value: unknown): IntercomBridgeMode {
	if (value === "off" || value === "always" || value === "fork-only") return value;
	return "always";
}

function readIntercomConfig(configPath: string): { enabled: boolean; error?: string } {
	if (!fs.existsSync(configPath)) return { enabled: true };
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { enabled?: unknown };
		return { enabled: parsed.enabled !== false };
	} catch (err: any) {
		return { enabled: true, error: err?.message ?? String(err) };
	}
}

/**
 * Legacy `extensions:` entries are additive and never form a sandbox. Only
 * the explicit portable exclusion field can disable an inherited intercom.
 */
function canonicalPathKey(value: string): string {
	try {
		return fs.realpathSync(path.resolve(value));
	} catch {
		return path.resolve(value);
	}
}

function intercomEntrypoints(intercomDir: string): string[] {
	const entrypoints = [intercomDir];
	try {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(intercomDir, "package.json"), "utf-8"),
		) as { pi?: { extensions?: unknown } };
		if (Array.isArray(manifest.pi?.extensions)) {
			for (const entry of manifest.pi.extensions) {
				if (typeof entry !== "string" || !entry.trim()) continue;
				const resolved = path.resolve(intercomDir, entry);
				if (fs.existsSync(resolved)) entrypoints.push(resolved);
			}
			// Match Pi's package manager: valid explicit entries take precedence
			// over conventional package-root entrypoints.
			if (entrypoints.length > 1) return entrypoints;
		}
	} catch {
		/* fall through to Pi's conventional package entrypoint discovery */
	}
	// Pi falls back to index.ts first, then index.js, when the manifest has no
	// usable pi.extensions entries. Include that same physical candidate so a
	// qualified exclusion cannot disagree with the worker loader.
	for (const file of ["index.ts", "index.js"]) {
		const conventional = path.join(intercomDir, file);
		if (fs.existsSync(conventional)) {
			entrypoints.push(conventional);
			break;
		}
	}
	return entrypoints;
}

function agentExcludesIntercom(agent: AgentConfig, intercomDir: string): boolean {
	// Preserve the common no-policy fast path: portable identity discovery may
	// consult package/Git metadata and is unnecessary without an exclusion.
	if (!agent.extensionExclude?.length) return false;

	const identities = intercomEntrypoints(intercomDir).map((entrypoint) =>
		derivePortableExtensionIdentity(entrypoint, {
			path: entrypoint,
			source: intercomDir,
			scope: "user",
			origin: "package",
			baseDir: intercomDir,
		}),
	);
	for (const entry of agent.extensionExclude ?? []) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		// A bare development install may not have package metadata, but the
		// well-known portable package selector must still disable its bridge.
		if (trimmed === "pi-intercom") return true;
		if (identities.some((identity) => portableExtensionIdentityMatchesSelector(identity, trimmed))) {
			return true;
		}
	}
	return false;
}

function readInstructionTemplate(instructionFile: string | undefined): string | null {
	if (!instructionFile) return null;
	try {
		return fs.readFileSync(instructionFile, "utf-8");
	} catch {
		return null;
	}
}
