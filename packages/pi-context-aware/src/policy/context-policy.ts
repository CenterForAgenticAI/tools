/**
 * The context policy and its pressure ladder.
 *
 * The policy says how a session keeps its history. It is stored in the
 * session's `context-aware.policy.v1` entries, so it is read from the current
 * branch path and survives a restart. It is not a mode: nothing switches it
 * automatically, and other extensions can only read it.
 *
 * The pressure ladder belongs to the policy. Its thresholds are the single
 * source for the telemetry bands; `contextAwarePressureBandEdgesV1` holds the
 * one mapping from ladder steps to bands.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1,
	CONTEXT_AWARE_DEFAULT_PRESSURE_LADDER_V1,
	CONTEXT_AWARE_POLICY_CHANGED_EVENT,
	CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
	contextAwarePressureBandEdgesV1,
	type ContextAwareContextPolicyValueV1,
	type ContextAwarePolicyChangedEventV1,
	type ContextAwarePolicySnapshotV1,
	type ContextAwarePolicySourceV1,
	type ContextAwarePolicyV1,
	type ContextAwarePressureBandEdgesV1,
	type ContextAwarePressureLadderSourcesV1,
	type ContextAwarePressureLadderV1,
} from "../context-service.js";
import type { ConfigLayer, ResolvedConfig } from "../platform/config-layers.js";

export type ContextPolicyValue = ContextAwareContextPolicyValueV1;
export type PressureLadderConfig = ContextAwarePressureLadderV1;

export const CONTEXT_POLICY_PATH = "contextPolicy" as const;
export const DEFAULT_CONTEXT_POLICY: ContextPolicyValue = "summaries";
export const DEFAULT_PRESSURE_LADDER: PressureLadderConfig = CONTEXT_AWARE_DEFAULT_PRESSURE_LADDER_V1;

/** Ladder keys, lowest step first. Their order is the order the values must keep. */
export const PRESSURE_LADDER_KEYS = [
	"foldNudgeStartFraction",
	"foldNudgeEndFraction",
	"seededCompactionFraction",
	"recoverableHideFraction",
] as const satisfies readonly (keyof PressureLadderConfig)[];

const LAYER_NAMES: Readonly<Record<ConfigLayer, string>> = {
	default: "default",
	global: "global",
	project: "project",
	cli: "CLI flag",
	session: "session",
	host: "host policy",
};

const SUPPORTED_VALUES_TEXT = CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1.join(", ");

/** The only gate a policy value passes through, from any layer. */
export function parseContextPolicyValue(value: unknown): ContextPolicyValue | undefined {
	return typeof value === "string" && (CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1 as readonly string[]).includes(value)
		? value as ContextPolicyValue
		: undefined;
}

/** A ladder threshold is a fraction of the context window: above 0, at most 1. */
export function parsePressureLadderFraction(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

function ladderFrom(config: { readonly pressureLadder?: Partial<PressureLadderConfig> }): PressureLadderConfig {
	const configured = config.pressureLadder ?? {};
	return {
		foldNudgeStartFraction: configured.foldNudgeStartFraction ?? DEFAULT_PRESSURE_LADDER.foldNudgeStartFraction,
		foldNudgeEndFraction: configured.foldNudgeEndFraction ?? DEFAULT_PRESSURE_LADDER.foldNudgeEndFraction,
		seededCompactionFraction: configured.seededCompactionFraction ?? DEFAULT_PRESSURE_LADDER.seededCompactionFraction,
		recoverableHideFraction: configured.recoverableHideFraction ?? DEFAULT_PRESSURE_LADDER.recoverableHideFraction,
	};
}

function isOrderedLadder(ladder: PressureLadderConfig): boolean {
	return PRESSURE_LADDER_KEYS.every((key, index) => index === 0 || ladder[PRESSURE_LADDER_KEYS[index - 1] as typeof key] <= ladder[key]);
}

/** The ladder in force: the configured values when they keep their order, otherwise the defaults. */
export function effectivePressureLadder(config: { readonly pressureLadder?: Partial<PressureLadderConfig> }): {
	readonly ladder: PressureLadderConfig;
	readonly ordered: boolean;
} {
	const configured = ladderFrom(config);
	const ordered = isOrderedLadder(configured);
	return { ladder: ordered ? configured : DEFAULT_PRESSURE_LADDER, ordered };
}

/** Telemetry band edges for a resolved configuration. */
export function contextPolicyBands(config: { readonly pressureLadder?: Partial<PressureLadderConfig> }): ContextAwarePressureBandEdgesV1 {
	return contextAwarePressureBandEdgesV1(effectivePressureLadder(config).ladder);
}

function formatFraction(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

function rejectionDiagnostic(path: string, layer: ConfigLayer): string | undefined {
	if (path === CONTEXT_POLICY_PATH) {
		return `Ignored an unsupported contextPolicy in the ${LAYER_NAMES[layer]} layer; supported values: ${SUPPORTED_VALUES_TEXT}.`;
	}
	if (path.startsWith("pressureLadder.")) {
		return `Ignored an invalid ${path} in the ${LAYER_NAMES[layer]} layer; ladder values must be numbers above 0 and at most 1.`;
	}
	return undefined;
}

/** The policy on the current branch, with the layer each value came from. */
export function resolveContextPolicy(resolved: ResolvedConfig): ContextAwarePolicySnapshotV1 {
	const value = resolved.config.contextPolicy ?? DEFAULT_CONTEXT_POLICY;
	const source: ContextAwarePolicySourceV1 = resolved.byPath.get(CONTEXT_POLICY_PATH)?.layer ?? "default";
	const { ladder, ordered } = effectivePressureLadder(resolved.config);
	const ladderSources = Object.fromEntries(PRESSURE_LADDER_KEYS.map((key) => [
		key,
		ordered ? resolved.byPath.get(`pressureLadder.${key}`)?.layer ?? "default" : "default",
	])) as unknown as ContextAwarePressureLadderSourcesV1;
	const diagnostics = resolved.rejected
		.map((entry) => rejectionDiagnostic(entry.path, entry.layer))
		.filter((message): message is string => message !== undefined);
	if (!ordered) {
		const configured = ladderFrom(resolved.config);
		diagnostics.push(`pressureLadder values are out of order (${PRESSURE_LADDER_KEYS.map((key) => formatFraction(configured[key])).join(", ")}); using the default ladder.`);
	}
	return Object.freeze({
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		value,
		source,
		ladder: Object.freeze({ ...ladder }),
		ladderSources: Object.freeze(ladderSources),
		bands: Object.freeze(contextAwarePressureBandEdgesV1(ladder)),
		...(diagnostics.length > 0 ? { diagnostic: diagnostics.join(" ") } : {}),
	});
}

export type ContextPolicyCommandArgument =
	| { readonly kind: "status" }
	| { readonly kind: "set"; readonly value: ContextPolicyValue }
	| { readonly kind: "invalid"; readonly message: string };

export function parseContextPolicyCommandArgument(args: string): ContextPolicyCommandArgument {
	const arg = args.trim();
	if (arg.length === 0 || arg === "status") return { kind: "status" };
	const value = parseContextPolicyValue(arg);
	if (value !== undefined) return { kind: "set", value };
	const shown = arg.length > 60 ? `${arg.slice(0, 60)}…` : arg;
	return {
		kind: "invalid",
		message: `Unsupported context policy "${shown}". Supported values: ${SUPPORTED_VALUES_TEXT}. The policy is unchanged.`,
	};
}

export function formatContextPolicyStatus(snapshot: ContextAwarePolicySnapshotV1): string {
	const { ladder, ladderSources } = snapshot;
	const lines = [
		`Context policy: ${snapshot.value} (source: ${snapshot.source})`,
		`Fold nudges: ${formatFraction(ladder.foldNudgeStartFraction)} to ${formatFraction(ladder.foldNudgeEndFraction)} (sources: ${ladderSources.foldNudgeStartFraction}, ${ladderSources.foldNudgeEndFraction})`,
		`Seeded compaction: ${formatFraction(ladder.seededCompactionFraction)} (source: ${ladderSources.seededCompactionFraction})`,
		`Recoverable hide, only when compaction cannot run: ${formatFraction(ladder.recoverableHideFraction)} (source: ${ladderSources.recoverableHideFraction})`,
		`Telemetry bands: WARN from ${formatFraction(snapshot.bands.warnFraction)}, URGENT from ${formatFraction(snapshot.bands.urgentFraction)}`,
	];
	if (snapshot.diagnostic) lines.push(`Diagnostic: ${snapshot.diagnostic}`);
	return lines.join("\n");
}

function samePolicy(a: ContextAwarePolicySnapshotV1, b: ContextAwarePolicySnapshotV1): boolean {
	return a.value === b.value
		&& a.source === b.source
		&& PRESSURE_LADDER_KEYS.every((key) => a.ladder[key] === b.ladder[key] && a.ladderSources[key] === b.ladderSources[key]);
}

export interface ContextPolicyControllerOptions {
	readonly resolve: (ctx: ExtensionContext) => ResolvedConfig;
	readonly appendSessionOverride: (ctx: ExtensionContext, values: Readonly<Record<string, unknown>>) => void;
}

export interface ContextPolicyController {
	readonly register: () => void;
	readonly current: (ctx: ExtensionContext) => ContextAwarePolicySnapshotV1;
	/** Read-only capability bound to one session context. */
	readonly capability: (ctx: ExtensionContext) => ContextAwarePolicyV1;
	/** Record the session's policy without announcing it. */
	readonly start: (ctx: ExtensionContext) => void;
	/** Re-read the policy and announce it when it differs from the last one seen. */
	readonly sync: (ctx: ExtensionContext, reason: ContextAwarePolicyChangedEventV1["reason"]) => void;
}

export function createContextPolicyController(
	pi: Pick<ExtensionAPI, "registerCommand" | "events">,
	options: ContextPolicyControllerOptions,
): ContextPolicyController {
	const lastSeen = new WeakMap<ExtensionContext["sessionManager"], ContextAwarePolicySnapshotV1>();
	const current = (ctx: ExtensionContext): ContextAwarePolicySnapshotV1 => resolveContextPolicy(options.resolve(ctx));

	const sync = (ctx: ExtensionContext, reason: ContextAwarePolicyChangedEventV1["reason"]): void => {
		const next = current(ctx);
		const previous = lastSeen.get(ctx.sessionManager) ?? null;
		lastSeen.set(ctx.sessionManager, next);
		if (previous !== null && samePolicy(previous, next)) return;
		const event: ContextAwarePolicyChangedEventV1 = Object.freeze({
			protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
			reason,
			sessionId: ctx.sessionManager.getSessionId(),
			at: new Date().toISOString(),
			previous,
			current: next,
		});
		pi.events?.emit(CONTEXT_AWARE_POLICY_CHANGED_EVENT, event);
	};

	const controller: ContextPolicyController = {
		register: () => {
			pi.registerCommand("context-policy", {
				description: `Show or set the context policy for this branch. Usage: /context-policy <status|${CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1.join("|")}>.`,
				getArgumentCompletions: (prefix) => {
					const items = [
						{ value: "status", label: "status — show the policy, its pressure ladder and sources" },
						{ value: "summaries", label: "summaries — the model folds older ranges into summaries (default)" },
					];
					const filtered = items.filter((item) => item.value.startsWith(prefix));
					return filtered.length > 0 ? filtered : null;
				},
				handler: async (args, ctx) => {
					const parsed = parseContextPolicyCommandArgument(args);
					if (parsed.kind === "invalid") {
						ctx.ui.notify(parsed.message, "error");
						return;
					}
					if (parsed.kind === "status") {
						const resolved = options.resolve(ctx);
					const folds = ["folds.firstUserMessage", "folds.firstUserMessageMaxTokens"].map((path) => {
						const entry = resolved.byPath.get(path);
						return `${path}: ${String(entry?.value)} (source: ${entry?.layer ?? "default"})`;
					});
					ctx.ui.notify([formatContextPolicyStatus(resolveContextPolicy(resolved)), ...folds].join("\n"), "info");
						return;
					}
					try {
						options.appendSessionOverride(ctx, { [CONTEXT_POLICY_PATH]: parsed.value });
					} catch (err) {
						ctx.ui.notify(`Failed to record the context policy: ${err instanceof Error ? err.message : String(err)}`, "error");
						return;
					}
					sync(ctx, "command");
					ctx.ui.notify(`Context policy set to ${parsed.value} for this branch.`, "info");
				},
			});
		},
		current,
		capability: (ctx) => Object.freeze({ current: () => current(ctx) }),
		start: (ctx) => {
			lastSeen.set(ctx.sessionManager, current(ctx));
		},
		sync,
	};
	return controller;
}
