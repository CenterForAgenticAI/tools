import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	discoverAgents,
	discoverChains,
	resolveByScopePrecedence,
	resolveChainByName,
	type AgentConfig,
	type ChainFileConfig,
} from "./agents.js";
import {
	DELEGATE_COMMAND,
	DELEGATE_CANCEL_COMMAND,
	DELEGATE_CANCEL_DESCRIPTION,
	DELEGATE_COMMAND_DESCRIPTION,
	DELEGATE_HELP_COMMAND,
	DELEGATE_HELP_DESCRIPTION,
	DELEGATE_INSPECTOR_COMMAND,
	DELEGATE_INSPECTOR_DESCRIPTION,
} from "./command-descriptions.js";
import {
	getDelegatePresentationLegend,
	type FooterIconMode,
} from "./footer-presentation.js";
import {
	parseDelegateArgs,
	parseDelegateCancelArgs,
	type ParsedDelegateDispatch,
} from "./slash-parse.js";

export type DelegateInvokeParams = Record<string, unknown>;

export interface DelegateCancelTarget {
	runId: string;
	entryName?: string;
	/** Unique picker text. Include the run ID so duplicate entry labels stay distinguishable. */
	label: string;
}

export interface DelegateCancelParams {
	runId: string;
	forkName?: string;
}

type DiscoveryContext = Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">;

export type DelegateInvoker = (
	params: DelegateInvokeParams,
	ctx: ExtensionCommandContext,
) => Promise<{ text: string; isError?: boolean }>;
export type DelegateCancelInvoker = (
	params: DelegateCancelParams,
	ctx: ExtensionCommandContext,
) => Promise<{ text: string; isError?: boolean }>;

export interface SlashCommandsOptions {
	invokeDelegate: DelegateInvoker;
	invokeCancel: DelegateCancelInvoker;
	listCancelTargets: () => DelegateCancelTarget[];
	discoverAgents?: (ctx: DiscoveryContext) => AgentConfig[];
	discoverAgentsWithWarnings?: (ctx: DiscoveryContext) => {
		agents: AgentConfig[];
		warnings: string[];
	};
	discoverChains?: (ctx: DiscoveryContext) => ChainFileConfig[];
	discoverChainsWithWarnings?: (ctx: DiscoveryContext) => {
		chains: ChainFileConfig[];
		warnings: string[];
	};
	getCompletionContext?: () => DiscoveryContext | undefined;
	openInspector?: (ctx: ExtensionCommandContext) => Promise<void>;
	footerIcons?: FooterIconMode;
	env?: Readonly<Record<string, string | undefined>>;
}

function discoveryForContext(ctx: DiscoveryContext, options: SlashCommandsOptions): {
	agents: AgentConfig[];
	warnings: string[];
} {
	if (options.discoverAgentsWithWarnings) return options.discoverAgentsWithWarnings(ctx);
	if (options.discoverAgents) return { agents: options.discoverAgents(ctx), warnings: [] };
	const discovery = discoverAgents(ctx.cwd, "both");
	return { agents: discovery.agents, warnings: discovery.warnings };
}

function chainDiscoveryForContext(ctx: DiscoveryContext, options: SlashCommandsOptions): {
	chains: ChainFileConfig[];
	warnings: string[];
} {
	if (options.discoverChainsWithWarnings) return options.discoverChainsWithWarnings(ctx);
	if (options.discoverChains) return { chains: options.discoverChains(ctx), warnings: [] };
	return { chains: discoverChains(ctx.cwd), warnings: [] };
}

function warningSuffix(warnings: readonly string[]): string {
	return warnings.length === 0
		? ""
		: `\nDiscovery warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

export function buildDelegateParams(parsed: ParsedDelegateDispatch): DelegateInvokeParams {
	if (parsed.mode === "chain") {
		const params: DelegateInvokeParams = {
			chain: parsed.chainName,
			task: parsed.task,
			await: parsed.foreground,
		};
		if (parsed.cwd !== undefined) params.cwd = parsed.cwd;
		return params;
	}

	const run: Record<string, unknown> = {
		agent: parsed.agent,
		task: parsed.task,
		mode: parsed.mode === "supervised" ? "supervised" : "solo",
	};
	if (parsed.worktree) run.worktree = true;
	if (parsed.model !== undefined) run.model = parsed.model;
	if (parsed.thinking !== undefined) run.thinking = parsed.thinking;
	if (parsed.skills.length > 0) run.skills = parsed.skills;
	if (parsed.cwd !== undefined) run.cwd = parsed.cwd;
	return { runs: [run], await: parsed.foreground };
}

const PRESENTATION_DESCRIPTIONS = {
	direct: "one worker without a supervisor; default",
	supervised: "a private supervisor can iterate with the worker",
	chain: "a saved sequential worker pipeline",
	background: "returns immediately and wakes the session later; default",
	unknown: "internal fallback for incomplete or future run metadata",
} as const;

export function renderDelegateHelp(
	footerIcons: FooterIconMode | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const legend = getDelegatePresentationLegend(footerIcons, env).map((entry) => {
		const markerAndLabel = entry.marker === entry.label
			? entry.label
			: `${entry.marker} ${entry.label}`;
		return `  ${markerAndLabel} — ${PRESENTATION_DESCRIPTIONS[entry.kind]}`;
	});
	return [
		"pi-delegate commands",
		"",
		"/delegate TASK [--direct | --fork | --supervised | --chain NAME] [--agent NAME] [--foreground | --fg] [--worktree] [--model MODEL] [--thinking LEVEL] [--skill NAME ...] [--cwd PATH]",
		"/delegate-cancel [RUN_ID [ENTRY]]",
		"/delegate-inspector",
		"/delegate-help",
		"",
		"Syntax legend",
		"  TASK is the work request and must come first. Quote it when its ending looks like an option.",
		"  RUN_ID identifies one dispatched batch; ENTRY identifies one worker in that batch.",
		"  Omit both to pick one live entry. A bare RUN_ID asks before cancelling its whole batch.",
		"  [ ... ] is optional. A | B means choose one alternative. NAME, MODEL, LEVEL, and PATH are values you supply.",
		"  Repeating --skill adds another skill. --foreground and --fg are aliases.",
		"",
		"Management forms (use alone)",
		"  /delegate --agents    List discovered workers.",
		"  /delegate --chains    List discovered saved chains.",
		"  /delegate --health    Show runtime health.",
		"  /delegate --help      Show this help; bare /delegate does the same.",
		"",
		"Modes and runtime presentation",
		...legend,
		"  --fork and --supervised are equivalent. --direct is the explicit default.",
		"",
		"Conflicts",
		"  Mode selectors are mutually exclusive.",
		"  --worktree cannot be combined with --cwd.",
		"  --chain permits only TASK, --cwd, and --foreground/--fg.",
		"  There is no --bg option because background dispatch is the default.",
		"",
		"Examples",
		"  /delegate Review the authentication changes",
		"  /delegate \"Review text ending in --foreground\"",
		"  /delegate Review the change --fork --agent reviewer --thinking high --skill code-review",
		"  /delegate Summarize the repository --chain discovery-report --cwd /repo --fg",
		"  /delegate-cancel",
		"  /delegate-cancel RUN_ID ENTRY",
		"  /delegate-inspector",
	].join("\n");
}

async function runAndRender<TParams>(
	invoke: (params: TParams, ctx: ExtensionCommandContext) => Promise<{ text: string; isError?: boolean }>,
	params: TParams,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		const output = await invoke(params, ctx);
		if (ctx.hasUI) ctx.ui.notify(output.text || "(no output)", output.isError ? "error" : "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Slash command failed: ${message}`, "error");
		else throw error;
	}
}

function notify(ctx: ExtensionCommandContext, text: string, level: "error" | "info" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}

function formatAgents(ctx: DiscoveryContext, options: SlashCommandsOptions): string {
	const discovery = discoveryForContext(ctx, options);
	const agents = [...discovery.agents].sort((left, right) => left.name.localeCompare(right.name));
	return [
		`Workers (${agents.length}):`,
		...(agents.length > 0
			? agents.map((candidate) => `- ${candidate.name} (${candidate.source}): ${candidate.description}`)
			: ["- (none)"]),
	].join("\n") + warningSuffix(discovery.warnings);
}

function formatChains(ctx: DiscoveryContext, options: SlashCommandsOptions): string {
	const discovery = chainDiscoveryForContext(ctx, options);
	const chains = resolveByScopePrecedence(discovery.chains)
		.sort((left, right) => left.name.localeCompare(right.name));
	return [
		`Chains (${chains.length}):`,
		...(chains.length > 0
			? chains.map((candidate) => `- ${candidate.name} (${candidate.source}): ${candidate.description}`)
			: ["- (none)"]),
	].join("\n") + warningSuffix(discovery.warnings);
}

function makeCompletions(options: SlashCommandsOptions) {
	return (prefix: string): Array<{ value: string; label: string }> | null => {
		const match = prefix.match(/(?:^|\s)(--agent|--chain)\s+([^\s]*)$/);
		if (!match) return null;
		const option = match[1]!;
		const partial = match[2]!;
		const valuePrefix = prefix.slice(0, prefix.length - partial.length);
		const context = options.getCompletionContext?.();
		if (option === "--agent") {
			const agents = context
				? discoveryForContext(context, options).agents
				: discoverAgents(process.cwd(), "both").agents;
			return agents
				.filter((candidate) => candidate.name.startsWith(partial))
				.map((candidate) => ({ value: `${valuePrefix}${candidate.name}`, label: candidate.name }));
		}
		const chains = context
			? chainDiscoveryForContext(context, options).chains
			: discoverChains(process.cwd());
		return resolveByScopePrecedence(chains)
			.filter((candidate) => candidate.name.startsWith(partial))
			.map((candidate) => ({ value: `${valuePrefix}${candidate.name}`, label: candidate.name }));
	};
}

function cancelTargetIssue(targets: readonly DelegateCancelTarget[]): string | undefined {
	const identities = new Set<string>();
	const labels = new Set<string>();
	for (const target of targets) {
		if (!target.runId || !target.label || target.entryName === "") {
			return "Live cancellation targets are invalid. No work was cancelled.";
		}
		const identity = `${target.runId}\u0000${target.entryName ?? ""}`;
		if (identities.has(identity) || labels.has(target.label)) {
			return "Live cancellation targets are duplicate or ambiguous. No work was cancelled.";
		}
		identities.add(identity);
		labels.add(target.label);
	}
	return undefined;
}

function quoteCompletionToken(value: string): string {
	return /^[^\s"\\]+$/.test(value)
		? value
		: `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function makeCancelCompletions(options: SlashCommandsOptions) {
	return (prefix: string): Array<{ value: string; label: string }> | null => {
		let targets: DelegateCancelTarget[];
		try {
			targets = options.listCancelTargets();
		} catch {
			return null;
		}
		if (cancelTargetIssue(targets)) return null;

		const separator = prefix.search(/\s/);
		if (separator < 0) {
			const runIds = [...new Set(targets.map((target) => target.runId))];
			const matches = runIds
				.filter((runId) => runId.startsWith(prefix))
				.map((runId) => ({ value: runId, label: runId }));
			return matches.length > 0 ? matches : null;
		}

		const runId = prefix.slice(0, separator);
		const rawPartial = prefix.slice(separator).trimStart();
		const partial = rawPartial.startsWith('"') ? rawPartial.slice(1) : rawPartial;
		const entryNames = [...new Set(
			targets
				.filter((target) => target.runId === runId && target.entryName !== undefined)
				.map((target) => target.entryName!),
		)];
		const matches = entryNames
			.filter((entryName) => entryName.startsWith(partial))
			.map((entryName) => ({
				value: `${runId} ${quoteCompletionToken(entryName)}`,
				label: entryName,
			}));
		return matches.length > 0 ? matches : null;
	};
}

async function handleDelegateCancel(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	options: SlashCommandsOptions,
): Promise<void> {
	const parsed = parseDelegateCancelArgs(rawArgs);
	if (parsed.ok !== true) {
		notify(ctx, `${parsed.error.message}\nUsage: /delegate-cancel [RUN_ID [ENTRY]]`, "error");
		return;
	}
	if (parsed.value.kind === "help") {
		notify(ctx, renderDelegateHelp(options.footerIcons, options.env));
		return;
	}
	if (parsed.value.kind === "exact") {
		if (parsed.value.entryName === undefined) {
			if (!ctx.hasUI) return;
			const confirmed = await ctx.ui.confirm(
				"Cancel every live entry in this batch?",
				`runId=${parsed.value.runId}\n\nThis cannot be undone.`,
			);
			if (!confirmed) return;
		}
		await runAndRender(
			options.invokeCancel,
			parsed.value.entryName === undefined
				? { runId: parsed.value.runId }
				: { runId: parsed.value.runId, forkName: parsed.value.entryName },
			ctx,
		);
		return;
	}

	if (!ctx.hasUI) return;
	let targets: DelegateCancelTarget[];
	try {
		targets = options.listCancelTargets();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Could not list live delegated work: ${message}`, "error");
		return;
	}
	if (targets.length === 0) {
		notify(ctx, "No live delegated work to cancel.");
		return;
	}
	const issue = cancelTargetIssue(targets);
	if (issue) {
		notify(ctx, issue, "error");
		return;
	}
	const selected = await ctx.ui.select(
		"Cancel delegated work",
		targets.map((target) => target.label),
	);
	if (selected === undefined) return;
	const target = targets.find((candidate) => candidate.label === selected);
	if (!target) {
		notify(ctx, "The selected cancellation target is stale or missing. No work was cancelled.", "error");
		return;
	}
	await runAndRender(
		options.invokeCancel,
		target.entryName === undefined
			? { runId: target.runId }
			: { runId: target.runId, forkName: target.entryName },
		ctx,
	);
}

async function handleDelegate(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	options: SlashCommandsOptions,
): Promise<void> {
	const parsed = parseDelegateArgs(rawArgs);
	if (parsed.ok !== true) {
		notify(ctx, parsed.error.message, "error");
		return;
	}
	const value = parsed.value;
	if (value.kind === "help") {
		notify(ctx, renderDelegateHelp(options.footerIcons, options.env));
		return;
	}
	if (value.kind === "management") {
		if (value.action === "agents") {
			notify(ctx, formatAgents(ctx, options));
			return;
		}
		if (value.action === "chains") {
			notify(ctx, formatChains(ctx, options));
			return;
		}
		await runAndRender(options.invokeDelegate, { action: "health" }, ctx);
		return;
	}

	if (value.mode === "chain") {
		const discovery = chainDiscoveryForContext(ctx, options);
		if (!value.chainName || !resolveChainByName(value.chainName, discovery.chains)) {
			notify(
				ctx,
				`Unknown chain: ${value.chainName ?? "(missing)"}${warningSuffix(discovery.warnings)}`,
				"error",
			);
			return;
		}
	} else {
		const discovery = discoveryForContext(ctx, options);
		if (!discovery.agents.some((candidate) => candidate.name === value.agent)) {
			notify(ctx, `Unknown agent: ${value.agent}${warningSuffix(discovery.warnings)}`, "error");
			return;
		}
	}
	await runAndRender(options.invokeDelegate, buildDelegateParams(value), ctx);
}

/** Register the complete supported slash surface. Registration failures are intentional and visible. */
export function setupSlashCommands(pi: ExtensionAPI, options: SlashCommandsOptions): void {
	pi.registerCommand(DELEGATE_COMMAND, {
		description: DELEGATE_COMMAND_DESCRIPTION,
		getArgumentCompletions: makeCompletions(options),
		handler: async (rawArgs, ctx) => handleDelegate(rawArgs, ctx, options),
	});
	pi.registerCommand(DELEGATE_CANCEL_COMMAND, {
		description: DELEGATE_CANCEL_DESCRIPTION,
		getArgumentCompletions: makeCancelCompletions(options),
		handler: async (rawArgs, ctx) => handleDelegateCancel(rawArgs, ctx, options),
	});
	pi.registerCommand(DELEGATE_INSPECTOR_COMMAND, {
		description: DELEGATE_INSPECTOR_DESCRIPTION,
		handler: async (_rawArgs, ctx) => {
			if (options.openInspector) await options.openInspector(ctx);
			else notify(ctx, "Delegate inspector is unavailable in this session.");
		},
	});
	pi.registerCommand(DELEGATE_HELP_COMMAND, {
		description: DELEGATE_HELP_DESCRIPTION,
		handler: async (_rawArgs, ctx) => {
			notify(ctx, renderDelegateHelp(options.footerIcons, options.env));
		},
	});
}
