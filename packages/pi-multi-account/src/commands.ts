import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { acquireMachineLease } from "./machine-lease.js";
import {
	DECLARATION_BASE_URL,
	DECLARATION_PLACEHOLDER_KEY,
	LOGICAL_PROVIDER_DISPLAY_NAME,
	LOGICAL_PROVIDER_ID,
	assertProjectedManagedModel,
	assertProjectedManagedModels,
} from "./models-declaration.js";
import type { EffectiveAccountGroupResolution } from "./group-policy.js";
import type {
	AllowedFamily,
	ManagedFamily,
	CrossFamilyChain,
	MultiAccountConfig,
	RoutingProjection,
} from "./config.js";
import type {
	InstalledDeclarationStatus,
	ModelDeclarationCatalogs,
	ModelDeclarationRow,
} from "./models-declaration.js";
import {
	ALLOWED_CROSS_FAMILY_PAIRS,
	ALLOWED_FAMILIES,
	isAllowedFamily,
	isManagedFamily,
	normalizeCrossFamilyChains,
	routingProjection,
	routingProjectionsEqual,
	validateCrossChain,
} from "./config.js";
import {
	buildModelDeclarationWithCodexDefaults,
	type CodexModelDefaultChange,
	planCodexModelDefaults,
	resolveCodexLongContextDefaults,
} from "./codex-model-defaults.js";
import {
	COMMIT_WARNING_GUIDANCE,
	NON_ROUTING_DRIFT_GUIDANCE,
	type RoutingConfigCommitResult,
} from "./routing-config-transaction.js";
import type { ContinuationController } from "./continuation.js";
import type { CostReport } from "./cost-report.js";
import { renderCostReport } from "./cost-report-render.js";
import { type DiagnosticLog, sanitizedJson } from "./diagnostics.js";
import {
	accountHealth,
	renderStatus,
	type StatusViewInput,
} from "./status-view.js";
import type { CredentialType } from "./discovery.js";
import { providerTypeFor, type ProviderType } from "./vendor.js";
import type { UnsupportedModelPair } from "./model-support.js";
import type { UsageFetchStatus } from "./usage-fetch.js";
import { PERIOD_TYPES, type PeriodType } from "./period-boundaries.js";
import {
	isCanonicalManagedProviderId,
	type RuntimeState,
} from "./runtime-state.js";
import type { UsageLedger } from "./usage.js";
import { formatUsageSnapshot } from "./usage.js";
import type { ContinuationWatchdog } from "./watchdog.js";

export const MULTI_ACCOUNT_SUBCOMMANDS = Object.freeze([
	"status",
	"limits",
	"models",
	"model",
	"cost",
	"log",
	"rediscover",
	"add",
	"remove",
	"clear",
	"next",
	"switch",
	"stop",
	"reset",
	"reload",
	"configure",
	"enable",
	"disable",
	"group",
] as const);

export type MultiAccountSubcommand = (typeof MULTI_ACCOUNT_SUBCOMMANDS)[number];

/**
 * Every slash subcommand's supported grammar, exactly as shown in an arity
 * error. Exported read-only so a help-surface test can assert on the real
 * production text directly instead of re-deriving it by triggering an error.
 */
export const COMMAND_USAGE: Readonly<Record<MultiAccountSubcommand, string>> =
	Object.freeze({
		status: "status [account-id|--json]",
		limits: "limits",
		models: "models [account-id|install|update]",
		model: "model [id]",
		cost: "cost [day|week|month|quarter|half-year|year]",
		log: "log [lines]",
		rediscover: "rediscover",
		add: "add <anthropic|openai-codex|google-antigravity|openai> [slot-number]",
		remove: "remove <account-id>",
		clear: "clear <account-id>",
		next: "next",
		switch: "switch <account-id>",
		stop: "stop",
		reset: "reset",
		reload: "reload",
		configure: "configure",
		enable: "enable",
		disable: "disable <anthropic|openai-codex|google-antigravity|openai>",
		group: "group <use <id>|reset|status>",
	});

const COMMAND_ARITY: Readonly<
	Record<MultiAccountSubcommand, readonly [minimum: number, maximum: number]>
> = Object.freeze({
	status: [0, 1],
	limits: [0, 0],
	models: [0, 1],
	model: [0, 1],
	cost: [0, 1],
	log: [0, 1],
	rediscover: [0, 0],
	add: [1, 2],
	remove: [1, 1],
	clear: [1, 1],
	next: [0, 0],
	switch: [1, 1],
	stop: [0, 0],
	reset: [0, 0],
	reload: [0, 0],
	configure: [0, 0],
	enable: [0, 0],
	disable: [1, 1],
	group: [1, 2],
});

function assertCommandArity(
	command: MultiAccountSubcommand,
	argumentCount: number,
): void {
	const [minimum, maximum] = COMMAND_ARITY[command];
	if (argumentCount < minimum || argumentCount > maximum) {
		throw new TypeError(`Usage: /multi-account ${COMMAND_USAGE[command]}`);
	}
}

function assertGroupCommand(
	action: string | undefined,
	groupId: string | undefined,
): asserts action is "use" | "reset" | "status" {
	const valid =
		(action === "use" && groupId !== undefined) ||
		((action === "reset" || action === "status") && groupId === undefined);
	if (!valid) {
		throw new TypeError(`Usage: /multi-account ${COMMAND_USAGE.group}`);
	}
}

export interface OperatorAccount {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly model: Model<Api>;
	readonly modelIds: readonly string[];
	readonly displayName?: string;
	/**
	 * Bounded credential-presence category for this slot, when discovery reported
	 * one. Never a credential value. Drives the derived, live `providerType`
	 * shown on the operator surface (an Anthropic `api_key` account reads as the
	 * owning-vendor-API tier, an Anthropic OAuth account as a subscription). When
	 * absent it defaults to `"unknown"`, which derives the subscription type.
	 */
	readonly credentialType?: CredentialType;
	/**
	 * Derived, non-reversible account identity. Already attached upstream at the
	 * credential boundary; carried here only so the status surface can report two
	 * slots resolving to one account. Never a credential value.
	 */
	readonly accountFingerprint?: string;
}

/**
 * The minimum Pi UI subset this controller needs, declared structurally so the
 * command layer does not depend on the host package. Pi's `ExtensionUIContext`
 * satisfies it.
 */
export interface CommandDialogOptions {
	readonly signal?: AbortSignal;
}

export interface CommandUI {
	select(
		title: string,
		options: string[],
		opts?: CommandDialogOptions,
	): Promise<string | undefined>;
	input(
		title: string,
		placeholder?: string,
		opts?: CommandDialogOptions,
	): Promise<string | undefined>;
	confirm(
		title: string,
		message: string,
		opts?: CommandDialogOptions,
	): Promise<boolean>;
}

/** Mirrors Pi's `ExtensionMode`. */
export type CommandMode = "tui" | "rpc" | "json" | "print";

export interface CommandSession {
	readonly mode: CommandMode;
	readonly hasUI: boolean;
	readonly ui: CommandUI;
	/** Runs the operator-only logical model selector against the live command context. */
	readonly switchLogicalModel?: (argument: string) => Promise<string>;
	/** Shutdown-linked signal; passed through to every dialog. */
	readonly signal?: AbortSignal;
}

/**
 * The configure command's only route to persisted configuration.
 *
 * The controller owns dialogs and validation; it never reads or writes the
 * config file itself, and it never publishes to the running process.
 */
export interface RoutingConfigSurface {
	/** Fresh normalized disk read; authoritative for prompts and confirmation. */
	readonly readPersistedRouting: () => RoutingProjection;
	/** This process's live routing policy, for viewing and divergence only. */
	readonly processEffectiveRouting: () => RoutingProjection;
	readonly commit: (input: {
		readonly promptSnapshot: RoutingProjection;
		readonly candidate: RoutingProjection;
		readonly signal?: AbortSignal;
	}) => Promise<RoutingConfigCommitResult>;
}

export interface MeteredFallbackStatus {
	readonly providerId: "openrouter";
	readonly enabled: boolean;
	readonly reason: string;
	readonly active: boolean;
	readonly sessionDisabled: boolean;
	readonly conversationEgressConsented: boolean;
	readonly delegatesAllowed: false;
	readonly configuredModel?: string;
	readonly dailyLimitUsd?: number;
	readonly reservedTodayUsd?: number;
	readonly remainingTodayUsd?: number;
}

export type DeclarationNotice = NonNullable<StatusViewInput["declarationNotice"]>;

export function declarationNoticeForStatus(
	status: InstalledDeclarationStatus | undefined,
): DeclarationNotice | undefined {
	if (status !== "mismatched" && status !== "unreadable") return undefined;
	return {
		condition: "stale",
		remedy: "/multi-account models update",
		status,
	};
}

export function declarationNoticeMessage(notice: DeclarationNotice): string {
	return notice.status === "mismatched"
		? `Managed model declaration is stale; logical routing is using the live catalog. Run ${notice.remedy} to re-sync it.`
		: `LOGICAL ROUTING OFF: The managed model declaration is unreadable. Run ${notice.remedy}.`;
}

export interface AccountGroupCommandMemberStatus {
	readonly providerId: string;
	readonly eligible: boolean;
	readonly reason: string;
}

export interface AccountGroupCommandStatus {
	readonly resolution: EffectiveAccountGroupResolution;
	readonly members?: readonly AccountGroupCommandMemberStatus[];
}

export interface AccountGroupCommandSurface {
	readonly use: (groupId: string) => AccountGroupCommandStatus;
	readonly reset: () => AccountGroupCommandStatus;
	readonly status: () => AccountGroupCommandStatus;
}

export interface CommandDependencies {
	readonly state: RuntimeState;
	readonly usage: UsageLedger;
	readonly diagnostics: DiagnosticLog;
	readonly continuation: Pick<ContinuationController, "cancelAll">;
	readonly watchdog: Pick<ContinuationWatchdog, "cancelAll">;
	/** Session-owned cancellation of watchdog, continuation, and logical attribution. */
	readonly cancelPendingActivity: () => void;
	readonly accounts: () => readonly OperatorAccount[];
	/** Captured once at session start; status must never recompute declaration state. */
	readonly logicalRoutingState?: () =>
		| { readonly status: InstalledDeclarationStatus }
		| undefined;
	/** Shared process-local policy state used by automatic routing and commands. */
	readonly disabledProviders?: Set<string>;
	/** Full routing eligibility, including credentials and retained usage. */
	readonly isAccountEligible?: (providerId: string, nowMs: number) => boolean;
	readonly currentProviderId: () => string | undefined;
	/** Physical account that served the latest logical-provider turn, when selected. */
	readonly activeAccountProviderId?: () => string | undefined;
	/** Model id actually in use, for display on the active account. */
	readonly activeModelId?: () => string | undefined;
	/** Operator-facing label for a managed account, when one resolves. */
	readonly accountLabel?: (providerId: string) => string | undefined;
	/** Bounded credential expiry for a managed account, when known. */
	readonly credentialExpiry?: (providerId: string) => number | undefined;
	/** Session-local provider/model divergence observations for operator status. */
	readonly unsupportedModels?: () => readonly UnsupportedModelPair[];
	/** Detached authoritative usage fetch state for operator status. */
	readonly usageFetchStatus?: (
		providerId: string,
	) => UsageFetchStatus | undefined;
	/** Read-only project/account/model cost intelligence for one calendar series. */
	readonly costReport?: (periodType: PeriodType) => Promise<CostReport>;
	/** Explicit metered last-resort policy; never includes credential material. */
	readonly meteredFallbackStatus?: () => MeteredFallbackStatus;
	readonly setModel: (model: Model<Api>) => Promise<boolean>;
	readonly rediscover: () => Promise<void>;
	readonly addSlot: (
		family: ManagedFamily,
		slotNumber?: number,
	) => Promise<string>;
	readonly publicRemove?: (providerId: string) => Promise<boolean>;
	readonly reloadGlobalConfig: () => Promise<MultiAccountConfig>;
	readonly onConfigReload?: (
		config: MultiAccountConfig,
	) => void | Promise<void>;
	/** Absent in builds or harnesses with no persisted configuration surface. */
	readonly routingConfig?: RoutingConfigSurface;
	readonly now?: () => number;
	/**
	 * Live inputs for the managed declaration transaction.
	 *
	 * Absent in harnesses with no models file. When absent, `models install`
	 * and `models update` refuse rather than guessing a target path, because a
	 * wrong guess would write a provider declaration into someone else's file.
	 */
	readonly modelsDeclaration?: {
		readonly targetPath: string;
		readonly readCatalogs: () => ModelsCatalogs | Promise<ModelsCatalogs>;
	};
	/** Operator-only session group mutation and status surface. */
	readonly accountGroups?: AccountGroupCommandSurface;
}

export const CONFIGURE_VIEW_OPTION = "View cross-family routing policy";

export function crossFamilyDirectionOption(
	from: AllowedFamily,
	to: AllowedFamily,
): string {
	return `${from} \u2192 ${to}`;
}

const CONFIGURE_TUI_ONLY =
	"/multi-account configure needs an interactive Pi TUI session with dialogs. " +
	"Edit crossFamilyChains and preferredModels in the machine-global config, then run /multi-account reload.";

const CONFIGURE_IN_PROGRESS =
	"Configuration is already in progress. Finish or cancel the open configure dialog before starting another.";

const CONFIGURE_CANCELLED =
	"Configure cancelled; no configuration or routing state changed.";

const ROUTING_DIVERGENCE_NOTE =
	"This process is following a different routing policy than the persisted configuration; run /multi-account reload or restart Pi before it follows persisted policy.";

const MAX_MODEL_INPUT_LENGTH = 1_024;
const MAX_MODEL_ENTRIES = 32;
// Control characters can only reach here from a paste; a model id never has one.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function rediscoverGuidance(family: string): string {
	return (
		`Cross-family routing needs a represented ${family} account in this process. ` +
		"Run /multi-account rediscover after adding/authenticating that family, then rerun configure."
	);
}

function coverageRejection(providerIds: readonly string[]): string {
	return (
		`${providerIds.join(", ")} would have no preferred model in that list, ` +
		"so an authorized account would fall through to an unchosen catalog head. Nothing was changed."
	);
}

type ModelListResult =
	| { readonly status: "ok"; readonly models: readonly string[] }
	| { readonly status: "cancelled" }
	| { readonly status: "rejected"; readonly reason: string };

/**
 * Parses one bounded comma-separated best-first model list.
 *
 * `undefined` is Esc, which is cancellation rather than rejection. Everything
 * else is validated against the live destination catalog BEFORE any mutation,
 * because a typo'd id would otherwise be persisted as policy and then silently
 * fall through to a catalog head.
 */
function parseModelList(
	raw: string | undefined,
	available: readonly string[],
): ModelListResult {
	if (raw === undefined) return { status: "cancelled" };
	if (raw.length > MAX_MODEL_INPUT_LENGTH) {
		return {
			status: "rejected",
			reason: "the model list must be at most 1,024 characters.",
		};
	}
	const entries = raw.split(",").map((entry) => entry.trim());
	if (entries.length > MAX_MODEL_ENTRIES) {
		return {
			status: "rejected",
			reason: "enter at most 32 comma-separated model IDs.",
		};
	}
	const models: string[] = [];
	for (const entry of entries) {
		if (entry.length === 0) {
			return {
				status: "rejected",
				reason: "enter at least one destination model ID.",
			};
		}
		if (/\s/.test(entry)) {
			return {
				status: "rejected",
				reason: "model IDs must not contain whitespace.",
			};
		}
		if (CONTROL_CHARACTER.test(entry)) {
			return {
				status: "rejected",
				reason: "model IDs must not contain a control character.",
			};
		}
		if (models.includes(entry)) {
			return {
				status: "rejected",
				reason: `remove the duplicate model ID ${entry}.`,
			};
		}
		if (!available.includes(entry)) {
			return {
				status: "rejected",
				reason: `${entry} is not offered by any live managed account in that family.`,
			};
		}
		models.push(entry);
	}
	if (models.length === 0) {
		return {
			status: "rejected",
			reason: "enter at least one destination model ID.",
		};
	}
	return { status: "ok", models };
}

function liveModelIds(
	accounts: readonly OperatorAccount[],
	family: AllowedFamily,
): readonly string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const account of accounts) {
		if (account.family !== family) continue;
		for (const modelId of account.modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			ids.push(modelId);
		}
	}
	return ids;
}

/**
 * Per-ACCOUNT coverage, not union membership.
 *
 * A list that names one live model of the family still leaves any account that
 * cannot serve it falling through to whatever its catalog happens to list
 * first, which is exactly the defect `preferredModels` exists to prevent.
 */
function accountsMissingPreference(
	accounts: readonly OperatorAccount[],
	family: AllowedFamily,
	models: readonly string[],
): readonly string[] {
	return accounts
		.filter(
			(account) =>
				account.family === family &&
				!account.modelIds.some((modelId) => models.includes(modelId)),
		)
		.map((account) => account.providerId);
}

function describeTierModelMap(projection: RoutingProjection): string {
	const summary = Object.entries(projection.tierModelMap)
		.map(([destination, mappings]) => {
			const count = Object.keys(mappings).length;
			return `${destination}: ${count} ${count === 1 ? "entry" : "entries"}`;
		})
		.join("; ");
	return summary.length === 0 ? "none" : summary;
}

function describeRoutingPolicy(projection: RoutingProjection): string {
	const edges =
		projection.crossFamilyChains.length === 0
			? "no directional edges"
			: projection.crossFamilyChains
					.map((edge) => crossFamilyDirectionOption(edge.from, edge.to))
					.join("; ");
	const preferred = Object.entries(projection.preferredModels)
		.map(([family, models]) => `${family}: ${models.join(", ")}`)
		.join("; ");
	return (
		`${projection.crossFamilyChainEnabled ? "enabled" : "disabled"}; ` +
		`${edges}; preferred models: ${preferred.length === 0 ? "none" : preferred}; ` +
		`tier model map: ${describeTierModelMap(projection)}`
	);
}

function renderRoutingView(
	persisted: RoutingProjection,
	effective: RoutingProjection,
): string {
	const lines = [
		`Persisted cross-family routing: ${describeRoutingPolicy(persisted)}`,
		`Process-effective cross-family routing: ${describeRoutingPolicy(effective)}`,
	];
	if (!routingProjectionsEqual(persisted, effective)) {
		lines.push(ROUTING_DIVERGENCE_NOTE);
	}
	return lines.join("\n");
}

function renderCommitResult(
	result: RoutingConfigCommitResult,
	candidate: RoutingProjection,
	destinationFamily: AllowedFamily,
): string {
	switch (result.status) {
		case "applied":
		case "applied-warning": {
			const edges = candidate.crossFamilyChains
				.map((edge) => crossFamilyDirectionOption(edge.from, edge.to))
				.join("; ");
			const models = (candidate.preferredModels[destinationFamily] ?? []).join(
				", ",
			);
			const lines = [
				`Cross-family routing is enabled with ${edges}; preferred ${destinationFamily} models: ${models}.`,
			];
			if (result.status === "applied-warning") {
				lines.push(COMMIT_WARNING_GUIDANCE);
			}
			if (result.nonRoutingDrift) lines.push(NON_ROUTING_DRIFT_GUIDANCE);
			return lines.join("\n");
		}
		case "unchanged":
			return "Cross-family routing is already configured exactly that way, on disk and in this process; nothing was written.";
		case "busy":
			return "Another process is committing multi-account configuration. Nothing was changed; rerun /multi-account configure in a moment.";
		case "changed":
			return "The persisted configuration changed while this dialog was open, so nothing was written. Rerun /multi-account configure from the current policy.";
		case "invalid":
			return "The machine-global configuration is malformed, so nothing was written. Repair the file, then rerun /multi-account configure.";
	}
}

const MANUAL_REMOVE_INSTRUCTIONS =
	"Credentials remain in AuthStorage. Run Pi's /logout command and select this provider; this command does not edit auth.json directly.";

function parseLineCount(value: string | undefined): number {
	if (value === undefined) return 20;
	if (!/^\d+$/.test(value))
		throw new TypeError("log lines must be an integer from 1 through 100.");
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
		throw new RangeError("log lines must be an integer from 1 through 100.");
	}
	return count;
}

function parseSlotNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value))
		throw new TypeError("slot number must be a positive safe integer.");
	const slot = Number(value);
	if (!Number.isSafeInteger(slot) || slot < 2) {
		throw new RangeError("slot number must be a safe integer of at least 2.");
	}
	return slot;
}

export class MultiAccountCommandController {
	readonly #dependencies: CommandDependencies;
	readonly #disabledProviders: Set<string>;
	/** One configure flow per controller: dialogs are modal to the operator. */
	#configureInProgress = false;

	constructor(dependencies: CommandDependencies) {
		this.#dependencies = dependencies;
		this.#disabledProviders =
			dependencies.disabledProviders ?? new Set<string>();
	}

	async execute(
		rawArguments: string,
		session?: CommandSession,
	): Promise<string> {
		try {
			if (rawArguments.length > 1_024)
				throw new RangeError("command arguments are too long.");
			const parts = rawArguments.trim()
				? rawArguments.trim().split(/\s+/)
				: ["status"];
			if (parts.length > 3) throw new TypeError("too many command arguments.");
			const [rawCommand, first, second] = parts;
			if (
				!rawCommand ||
				!MULTI_ACCOUNT_SUBCOMMANDS.includes(
					rawCommand as MultiAccountSubcommand,
				)
			) {
				return this.#output(
					`Unknown subcommand. Use: ${MULTI_ACCOUNT_SUBCOMMANDS.join(", ")}.`,
				);
			}
			const command = rawCommand as MultiAccountSubcommand;
			assertCommandArity(command, parts.length - 1);
			if (command === "group") assertGroupCommand(first, second);
			let result: string;
			switch (command) {
				case "status":
					result = this.#status(first);
					break;
				case "limits":
					result = this.#limits();
					break;
				case "models":
					// `models` shares its first word with two different commands: the
					// per-account lister, and the declaration transaction. Only the two
					// exact action words route to the transaction; every other argument
					// keeps the pre-existing listing behaviour unchanged.
					result =
						first === "install" || first === "update"
							? await this.#modelsTransaction(first, session)
							: this.#models(first);
					break;
				case "model":
					if (session?.switchLogicalModel === undefined) {
						throw new Error("Logical model selection requires a live command session.");
					}
					result = await session.switchLogicalModel(first ?? "");
					break;
				case "cost":
					result = await this.#cost(first);
					break;
				case "log":
					result = this.#dependencies.diagnostics.formatRecent(
						parseLineCount(first),
					);
					break;
				case "rediscover":
					result = await this.#rediscover();
					break;
				case "add":
					result = await this.#add(first, second);
					break;
				case "remove":
					result = await this.#remove(first);
					break;
				case "clear":
					result = this.#clear(first);
					break;
				case "next":
					result = this.#next();
					break;
				case "switch":
					result = await this.#switch(first);
					break;
				case "stop":
					result = this.#stop();
					break;
				case "reset":
					result = this.#reset();
					break;
				case "reload":
					result = await this.#reload();
					break;
				case "configure":
					result = await this.#configure(session);
					break;
				case "enable":
					result = this.#enable();
					break;
				case "disable":
					result = this.#disable(first);
					break;
				case "group":
					result = this.#group(first, second);
					break;
				default:
					throw new TypeError(`Unsupported subcommand: ${String(command)}`);
			}
			return this.#output(result);
		} catch (error) {
			this.#dependencies.diagnostics.recordError(
				"command.multi-account",
				error,
			);
			const detail = error instanceof Error ? error.message : error;
			return this.#output(
				`Command failed: ${String(detail)} Review /multi-account status and retry.`,
			);
		}
	}

	#accounts(): readonly OperatorAccount[] {
		return this.#dependencies
			.accounts()
			.filter(
				(account) =>
					isCanonicalManagedProviderId(account.providerId, account.family) &&
					account.model.provider === account.providerId,
			);
	}

	#account(providerId: string | undefined): OperatorAccount {
		if (!providerId) throw new TypeError("an account ID is required.");
		const account = this.#accounts().find(
			(candidate) => candidate.providerId === providerId,
		);
		if (!account)
			throw new TypeError(
				`Unknown managed account ${providerId}. Run rediscover.`,
			);
		return account;
	}

	/**
	 * Renders account status. Human-readable by default; `status --json` keeps the
	 * original machine-readable shape for scripted consumers.
	 */
	#status(argument: string | undefined): string {
		const now = this.#now();
		const unsupportedModels = this.#dependencies.unsupportedModels?.() ?? [];
		const asJson = argument === "--json";
		const declarationNotice = declarationNoticeForStatus(
			this.#dependencies.logicalRoutingState?.()?.status,
		);
		const declarationNoticeJson =
			declarationNotice === undefined
				? undefined
				: {
						condition: declarationNotice.condition,
						remedy: declarationNotice.remedy,
						status: declarationNotice.status,
					};
		const providerId = asJson ? undefined : argument;
		const allAccounts = this.#accounts();
		const accounts = providerId ? [this.#account(providerId)] : allAccounts;
		if (accounts.length === 0) {
			const message =
				"No managed accounts are available. Run /multi-account rediscover.";
			if (asJson) {
				return sanitizedJson({
					message,
					...(declarationNoticeJson === undefined
						? {}
						: { declarationNotice: declarationNoticeJson }),
				});
			}
			return renderStatus({
				nowMs: now,
				accounts: [],
				...(declarationNotice === undefined ? {} : { declarationNotice }),
			});
		}
		const currentProviderId = this.#dependencies.currentProviderId();
		const activeAccountProviderId =
			this.#dependencies.activeAccountProviderId?.() ?? currentProviderId;
		// Label and expiry are resolved HERE, not per-branch, so the JSON and
		// human-readable views cannot drift: a scripted consumer sees the same
		// credential freshness the operator does.
		const projected = accounts.map((account) => {
			const disabled = this.#disabledProviders.has(account.providerId);
			const coolingUntilMs = this.#dependencies.state.getCooldown(
				account.providerId,
				now,
			)?.untilMs;
			const unavailable =
				this.#dependencies.state.getInvalidation(account.providerId) !==
				undefined;
			const usageUntrusted =
				this.#dependencies.state.isUsageSnapshotUntrusted(
					account.providerId,
					now,
				);
			const usage = this.#dependencies.usage.get(account.providerId);
			const view = {
				providerId: account.providerId,
				family: account.family,
				// Derived live from the discovered credential type; additive field,
				// no existing field changes. An absent credentialType defaults to
				// the subscription type.
				providerType: providerTypeFor(
					account.family,
					account.credentialType ?? "unknown",
				),
				active: account.providerId === activeAccountProviderId,
				disabled,
				unavailable,
				...(coolingUntilMs === undefined ? {} : { coolingUntilMs }),
				...(usageUntrusted ? { usageUntrusted: true } : {}),
				...(usage === undefined ? {} : { usage }),
			};
			const health = accountHealth(view, now);
			return {
				...view,
				api: account.model.api,
				healthy: health === "ready" || health === "low-headroom",
				...(account.accountFingerprint === undefined
					? {}
					: { accountFingerprint: account.accountFingerprint }),
				usageFetch: this.#dependencies.usageFetchStatus?.(account.providerId),
				allModelsUnsupported:
					account.modelIds.length > 0 &&
					account.modelIds.every((modelId) =>
						unsupportedModels.some(
							(pair) =>
								pair.providerId === account.providerId &&
								pair.modelId === modelId,
						),
					),
				...this.#optionalField(
					"label",
					this.#dependencies.accountLabel?.(account.providerId),
				),
				...this.#optionalField(
					"expiresAtMs",
					this.#dependencies.credentialExpiry?.(account.providerId),
				),
			};
		});
		const meteredFallback = this.#dependencies.meteredFallbackStatus?.();
		if (asJson) {
			return sanitizedJson({
				currentProviderId,
				healthyAccountCount: projected.filter((account) => account.healthy)
					.length,
				accounts: projected,
				unsupportedModels: this.#dependencies.unsupportedModels?.(),
				...(declarationNoticeJson === undefined
					? {}
					: { declarationNotice: declarationNoticeJson }),
				...(meteredFallback === undefined ? {} : { meteredFallback }),
			});
		}
		const rendered = renderStatus({
			nowMs: now,
			scoped: providerId !== undefined,
			accounts: projected.map((account) => ({
				providerId: account.providerId,
				family: account.family,
				providerType: account.providerType,
				active: account.active,
				disabled: account.disabled,
				unavailable: account.unavailable,
				...(account.usageUntrusted ? { usageUntrusted: true } : {}),
				...(account.coolingUntilMs === undefined
					? {}
					: { coolingUntilMs: account.coolingUntilMs }),
				...(account.usage === undefined ? {} : { usage: account.usage }),
				...(account.usageFetch === undefined
					? {}
					: { usageFetch: account.usageFetch }),
				...(account.allModelsUnsupported ? { allModelsUnsupported: true } : {}),
				...("label" in account ? { label: account.label } : {}),
				...("expiresAtMs" in account
					? { expiresAtMs: account.expiresAtMs }
					: {}),
				...("accountFingerprint" in account
					? { accountFingerprint: account.accountFingerprint }
					: {}),
				...this.#activeModelIdField(account.active),
			})),
			...(unsupportedModels.length === 0 ? {} : { unsupportedModels }),
			...(declarationNotice === undefined ? {} : { declarationNotice }),
		});
		if (meteredFallback === undefined) return rendered;
		const budget =
			meteredFallback.reservedTodayUsd === undefined ||
			meteredFallback.dailyLimitUsd === undefined
				? "daily reservation state unavailable"
				: `$${meteredFallback.reservedTodayUsd.toFixed(2)} reserved of $${meteredFallback.dailyLimitUsd.toFixed(2)} today`;
		if (!meteredFallback.enabled) {
			const configured =
				meteredFallback.configuredModel === undefined
					? ""
					: `; configured for ${meteredFallback.configuredModel}; ${budget}`;
			return `${rendered}\n\nOpenRouter last resort: disabled (${meteredFallback.reason})${configured}.`;
		}
		return (
			`${rendered}\n\nOpenRouter last resort: enabled for ${meteredFallback.configuredModel ?? "an unavailable model"}; ` +
			`${budget}; active ${meteredFallback.active ? "yes" : "no"}; delegate use blocked.`
		);
	}

	#limits(): string {
		const snapshots = this.#dependencies.usage.snapshots();
		if (snapshots.length === 0)
			return "No usage observations are available yet.";
		return snapshots
			.map((snapshot) => formatUsageSnapshot(snapshot, this.#now()))
			.join("\n");
	}

	async #cost(periodValue: string | undefined): Promise<string> {
		const periodType = periodValue ?? "month";
		if (!PERIOD_TYPES.includes(periodType as PeriodType)) {
			throw new TypeError(
				"cost period must be day, week, month, quarter, half-year, or year.",
			);
		}
		if (this.#dependencies.costReport === undefined) {
			return "Cost intelligence is unavailable in this Pi build.";
		}
		return renderCostReport(
			await this.#dependencies.costReport(periodType as PeriodType),
		);
	}

	/**
	 * Run the managed declaration transaction for `install` or `update`.
	 *
	 * This fails closed in two ways rather than writing something the operator
	 * did not see. Without declaration inputs there is no target path to write.
	 * Without an interactive session there is no way to show the diff, and
	 * `executeModelsCommand` requires a confirmation answer before it commits;
	 * defaulting that answer to yes would write an unreviewed provider entry.
	 */
	async #modelsTransaction(
		action: "install" | "update",
		session: CommandSession | undefined,
	): Promise<string> {
		const declaration = this.#dependencies.modelsDeclaration;
		if (declaration === undefined) {
			throw new Error(
				"Managed model declarations are unavailable in this session.",
			);
		}
		if (session === undefined || !session.hasUI) {
			throw new Error(
				`/multi-account models ${action} needs an interactive session to confirm the change.`,
			);
		}
		const { ui, signal } = session;
		const result = await executeModelsCommand(`models ${action}`, {
			targetPath: declaration.targetPath,
			readCatalogs: declaration.readCatalogs,
			// `confirm` is an adapter, not a handoff: the transaction supplies one
			// rendered diff, while the dialog surface takes a title and a body.
			confirm: (diff: string) =>
				ui.confirm(
					`Apply managed model declaration (${action})`,
					diff,
					signal ? { signal } : undefined,
				),
		});
		if (result.outcome === "cancelled") {
			return `No change was written. ${result.action} cancelled.`;
		}
		const lines = [
			`Managed declaration ${result.action === "install" ? "installed" : "updated"} with ${result.modelIds.length} models.`,
			...result.diagnostics,
		];
		return lines.join("\n");
	}

	#models(providerId: string | undefined): string {
		const accounts = providerId
			? [this.#account(providerId)]
			: this.#accounts();
		if (accounts.length === 0)
			return "No models are available. Add or rediscover an account.";
		const unsupportedModels = this.#dependencies.unsupportedModels?.() ?? [];
		return sanitizedJson(
			accounts.map((account) => {
				const unsupported = account.modelIds.filter((modelId) =>
					unsupportedModels.some(
						(pair) =>
							pair.providerId === account.providerId &&
							pair.modelId === modelId,
					),
				);
				return {
					providerId: account.providerId,
					displayName: account.displayName ?? account.providerId,
					api: account.model.api,
					models: account.modelIds,
					...(unsupported.length === 0
						? {}
						: { unsupportedModels: unsupported }),
					...(unsupported.length === account.modelIds.length &&
					account.modelIds.length > 0
						? { allModelsUnsupported: true }
						: {}),
				};
			}),
		);
	}

	async #rediscover(): Promise<string> {
		await this.#dependencies.rediscover();
		return "Account metadata rediscovered and provider slots refreshed.";
	}

	async #add(
		familyValue: string | undefined,
		slotValue: string | undefined,
	): Promise<string> {
		if (!familyValue || !isManagedFamily(familyValue)) {
			throw new TypeError(
				"add requires family anthropic, openai-codex, google-antigravity, or openai.",
			);
		}
		const providerId = await this.#dependencies.addSlot(
			familyValue,
			parseSlotNumber(slotValue),
		);
		// The owning-vendor-api openai family authenticates from an API key, not an
		// OAuth login, so its guidance must not tell the operator to run a login.
		// Captured as a plain string so this branch does not depend on how the
		// family-acceptance guard above narrows `familyValue`.
		const requestedFamily: string = familyValue;
		return requestedFamily === "openai"
			? `Registered API-key slot ${providerId}. Set OPENAI_API_KEY so it can authenticate.`
			: `Registered OAuth login slot ${providerId}. Use Pi's public login command to authenticate it.`;
	}

	async #remove(providerId: string | undefined): Promise<string> {
		const account = this.#account(providerId);
		if (!this.#dependencies.publicRemove) return MANUAL_REMOVE_INSTRUCTIONS;
		const removed = await this.#dependencies.publicRemove(account.providerId);
		return removed
			? `Removed credentials for ${account.providerId} through Pi's public API.`
			: MANUAL_REMOVE_INSTRUCTIONS;
	}

	#clear(providerId: string | undefined): string {
		const account = this.#account(providerId);
		this.#disabledProviders.add(account.providerId);
		this.#dependencies.state.resetAccount(account.providerId);
		this.#dependencies.usage.clear(account.providerId);
		return `Cleared process-local state and disabled ${account.providerId}; credentials were preserved.`;
	}

	#next(): string {
		const now = this.#now();
		const current = this.#dependencies.currentProviderId();
		const next = this.#accounts().find((account) => {
			if (
				account.providerId === current ||
				this.#disabledProviders.has(account.providerId)
			) {
				return false;
			}
			if (this.#dependencies.isAccountEligible !== undefined) {
				return this.#dependencies.isAccountEligible(account.providerId, now);
			}
			return (
				this.#dependencies.state.getCooldown(account.providerId, now) ===
					undefined &&
				this.#dependencies.state.getInvalidation(account.providerId) ===
					undefined
			);
		});
		return next
			? `Next healthy account: ${next.providerId}.`
			: "No healthy alternative is available; add or rediscover an account.";
	}

	async #switch(providerId: string | undefined): Promise<string> {
		const account = this.#account(providerId);
		if (this.#disabledProviders.has(account.providerId)) {
			return `${account.providerId} is disabled in this process. Run enable or reset first.`;
		}
		const cooldown = this.#dependencies.state.getCooldown(
			account.providerId,
			this.#now(),
		);
		if (cooldown) {
			return `${account.providerId} is cooling until ${cooldown.untilMs}. Run /multi-account next or wait for recovery.`;
		}
		if (this.#dependencies.state.getInvalidation(account.providerId)) {
			return `${account.providerId} is unavailable after an authentication failure. Run rediscover or reset.`;
		}
		const switched =
			(await this.#dependencies.setModel(account.model)) === true;
		return switched
			? `Switched explicitly to ${account.providerId}.`
			: `Pi could not select ${account.providerId}; authenticate it or choose another healthy account.`;
	}

	#stop(): string {
		this.#dependencies.cancelPendingActivity();
		return "Pending automatic continuation and queued input were cancelled.";
	}

	#reset(): string {
		this.#dependencies.cancelPendingActivity();
		this.#dependencies.state.clearAll();
		this.#dependencies.usage.clear();
		this.#disabledProviders.clear();
		return "Reset process-local cooldown, continuation, watchdog, usage, and disabled-account state.";
	}

	async #reload(): Promise<string> {
		const config = await this.#dependencies.reloadGlobalConfig();
		await this.#dependencies.onConfigReload?.(config);
		return "Reloaded the machine-global multi-account configuration.";
	}

	/**
	 * Interactive cross-family routing configuration.
	 *
	 * TUI-only by explicit `mode` check, not by `hasUI`: Pi reports `hasUI` true
	 * in RPC as well, and an RPC caller opening a modal selector would hang.
	 */
	async #configure(session: CommandSession | undefined): Promise<string> {
		const routingConfig = this.#dependencies.routingConfig;
		if (routingConfig === undefined) {
			return "Cross-family routing configuration is unavailable in this build.";
		}
		if (
			session === undefined ||
			session.mode !== "tui" ||
			session.hasUI !== true
		) {
			return CONFIGURE_TUI_ONLY;
		}
		if (this.#configureInProgress) return CONFIGURE_IN_PROGRESS;
		this.#configureInProgress = true;
		try {
			return await this.#runConfigure(session, routingConfig);
		} finally {
			// Cleared on success, Esc, rejection, every commit outcome, abort, and
			// exceptions, so one bad flow cannot block the command permanently.
			this.#configureInProgress = false;
		}
	}

	async #runConfigure(
		session: CommandSession,
		routingConfig: RoutingConfigSurface,
	): Promise<string> {
		const { ui } = session;
		const signal = session.signal;
		const dialogOptions: CommandDialogOptions =
			signal === undefined ? {} : { signal };
		const aborted = (): boolean => signal?.aborted === true;

		const preAccounts = this.#accounts();
		const represented = new Set(preAccounts.map((account) => account.family));
		// Authoritative for replacement detection, confirmation, and the commit-time
		// drift comparison. The process-effective read is for display only.
		const persisted = routingProjection(routingConfig.readPersistedRouting());
		const effective = routingProjection(
			routingConfig.processEffectiveRouting(),
		);

		const directions = ALLOWED_CROSS_FAMILY_PAIRS.filter(
			([from, to]) => represented.has(from) && represented.has(to),
		);
		if (directions.length === 0) {
			const missing = ALLOWED_FAMILIES.filter(
				(family) => !represented.has(family),
			);
			return rediscoverGuidance(missing.join(" and "));
		}

		const choice = await ui.select(
			"Cross-family routing",
			[
				CONFIGURE_VIEW_OPTION,
				...directions.map(([from, to]) =>
					crossFamilyDirectionOption(from, to),
				),
			],
			dialogOptions,
		);
		if (aborted() || choice === undefined) return CONFIGURE_CANCELLED;
		if (choice === CONFIGURE_VIEW_OPTION) {
			return renderRoutingView(persisted, effective);
		}
		const direction = directions.find(
			([from, to]) => crossFamilyDirectionOption(from, to) === choice,
		);
		if (direction === undefined) return CONFIGURE_CANCELLED;
		const [sourceFamily, destinationFamily] = direction;

		const available = liveModelIds(preAccounts, destinationFamily);
		const selected = parseModelList(
			await ui.input(
				`Preferred ${destinationFamily} models, best first (comma-separated)`,
				`Available: ${available.join(", ")}`,
				dialogOptions,
			),
			available,
		);
		if (aborted() || selected.status === "cancelled") return CONFIGURE_CANCELLED;
		if (selected.status === "rejected") {
			return `Configure rejected that entry: ${selected.reason} Nothing was changed.`;
		}

		// Re-read accounts AFTER the dialog: an account can disappear while the
		// operator is typing, and every representation and coverage decision below
		// must use the later snapshot.
		const postAccounts = this.#accounts();
		const postRepresented = new Set(
			postAccounts.map((account) => account.family),
		);
		if (!postRepresented.has(destinationFamily)) {
			return rediscoverGuidance(destinationFamily);
		}
		const uncovered = accountsMissingPreference(
			postAccounts,
			destinationFamily,
			selected.models,
		);
		if (uncovered.length > 0) return coverageRejection(uncovered);

		const selectedEdge: CrossFamilyChain = {
			from: sourceFamily,
			to: destinationFamily,
		};
		const preserved = normalizeCrossFamilyChains(persisted.crossFamilyChains);
		// Selecting an existing edge is a replacement, never an added duplicate.
		const edges = preserved.some(
			(edge) =>
				edge.from === selectedEdge.from && edge.to === selectedEdge.to,
		)
			? preserved
			: [...preserved, selectedEdge];
		const preferredModels: Record<string, readonly string[]> = {
			...persisted.preferredModels,
			[destinationFamily]: selected.models,
		};

		// Enabling the global flag activates every staged edge at once, so a second
		// destination family whose preference lacks coverage is repaired in the SAME
		// invocation rather than being activated uncovered.
		const collected = new Set<AllowedFamily>([destinationFamily]);
		for (const edge of edges) {
			for (const family of [edge.from, edge.to]) {
				if (!postRepresented.has(family)) return rediscoverGuidance(family);
			}
			if (collected.has(edge.to)) continue;
			collected.add(edge.to);
			if (
				accountsMissingPreference(
					postAccounts,
					edge.to,
					preferredModels[edge.to] ?? [],
				).length === 0
			) {
				continue;
			}
			const repairAvailable = liveModelIds(postAccounts, edge.to);
			const repaired = parseModelList(
				await ui.input(
					`Preferred ${edge.to} models, best first (comma-separated)`,
					`Available: ${repairAvailable.join(", ")}`,
					dialogOptions,
				),
				repairAvailable,
			);
			if (aborted() || repaired.status === "cancelled") {
				return CONFIGURE_CANCELLED;
			}
			if (repaired.status === "rejected") {
				return `Configure rejected that entry: ${repaired.reason} Nothing was changed.`;
			}
			const stillUncovered = accountsMissingPreference(
				postAccounts,
				edge.to,
				repaired.models,
			);
			if (stillUncovered.length > 0) return coverageRejection(stillUncovered);
			preferredModels[edge.to] = repaired.models;
		}

		// Defense in depth over the COMPLETE enabled candidate. The per-step guards
		// above are the intended owners; this pass exists so a hand-edited invalid
		// edge cannot be activated because one of them was bypassed.
		for (const edge of edges) {
			try {
				validateCrossChain(edge);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return `Configure refused the resulting policy: ${detail} Repair the machine-global config, then rerun configure.`;
			}
			if (!postRepresented.has(edge.from)) return rediscoverGuidance(edge.from);
			if (!postRepresented.has(edge.to)) return rediscoverGuidance(edge.to);
			const missing = accountsMissingPreference(
				postAccounts,
				edge.to,
				preferredModels[edge.to] ?? [],
			);
			if (missing.length > 0) return coverageRejection(missing);
		}

		const candidate: RoutingProjection = {
			crossFamilyChainEnabled: true,
			crossFamilyChains: edges,
			preferredModels,
			tierModelMap: persisted.tierModelMap,
		};

		const lines = [
			`Persisted starting policy: ${describeRoutingPolicy(persisted)}`,
			`Process-effective starting policy: ${describeRoutingPolicy(effective)}`,
		];
		if (!routingProjectionsEqual(persisted, effective)) {
			lines.push(ROUTING_DIVERGENCE_NOTE);
		}
		lines.push(`Persisted candidate: ${describeRoutingPolicy(candidate)}`);
		if (!persisted.crossFamilyChainEnabled) {
			lines.push("Enabling cross-family routing activates every staged edge:");
			for (const edge of edges) {
				lines.push(`  - ${crossFamilyDirectionOption(edge.from, edge.to)}`);
			}
		}
		lines.push(
			`preferredModels is family-scoped: this ${destinationFamily} list also affects same-family fallback for that destination family.`,
		);
		const approved = await ui.confirm(
			"Apply cross-family routing configuration",
			lines.join("\n"),
			dialogOptions,
		);
		if (aborted() || !approved) return CONFIGURE_CANCELLED;

		return renderCommitResult(
			await routingConfig.commit({
				promptSnapshot: persisted,
				candidate,
				...(signal === undefined ? {} : { signal }),
			}),
			candidate,
			destinationFamily,
		);
	}

	#group(action: string | undefined, groupId: string | undefined): string {
		assertGroupCommand(action, groupId);
		const surface = this.#dependencies.accountGroups;
		if (surface === undefined) {
			throw new Error("Session account groups are unavailable in this build.");
		}
		if (action === "use") {
			if (groupId === undefined) {
				throw new TypeError(`Usage: /multi-account ${COMMAND_USAGE.group}`);
			}
			const status = surface.use(groupId);
			return `Session account group set to ${groupId}.\n${this.#renderAccountGroupStatus(status)}`;
		}
		if (action === "reset") {
			return `Session account group override reset.\n${this.#renderAccountGroupStatus(surface.reset())}`;
		}
		return this.#renderAccountGroupStatus(surface.status());
	}

	#renderAccountGroupStatus(status: AccountGroupCommandStatus): string {
		const { resolution } = status;
		const source = resolution.source.replaceAll("-", " ");
		const groupId =
			resolution.source === "unrestricted" ? "unrestricted" : resolution.groupId;
		const lines = [`Effective account group: ${groupId} (${source}).`];
		for (const member of status.members ?? []) {
			lines.push(
				`- ${member.providerId}: ${member.eligible ? "eligible" : "blocked"} (${member.reason})`,
			);
		}
		return lines.join("\n");
	}

	#enable(): string {
		this.#reset();
		return "Re-enabled all managed accounts and reset process-local routing, continuation, watchdog, and usage state.";
	}

	#disable(familyValue: string | undefined): string {
		if (!familyValue || !isManagedFamily(familyValue)) {
			throw new TypeError(
				"disable requires family anthropic, openai-codex, google-antigravity, or openai.",
			);
		}
		for (const account of this.#accounts()) {
			if (account.family === familyValue)
				this.#disabledProviders.add(account.providerId);
		}
		return `Disabled ${familyValue} accounts in this process only.`;
	}

	/**
	 * Yields `{ activeModelId }` only when the account is active AND the host
	 * actually reported a model id, so no `undefined` value is ever constructed
	 * under exactOptionalPropertyTypes.
	 */
	/**
	 * Yields `{ [key]: value }` only when the value is present, so no `undefined`
	 * member is ever constructed under exactOptionalPropertyTypes.
	 */
	#optionalField<K extends string, V>(
		key: K,
		value: V | undefined,
	): Record<K, V> | Record<string, never> {
		return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
	}

	#activeModelIdField(isActive: boolean): { activeModelId?: string } {
		if (!isActive) return {};
		const modelId = this.#dependencies.activeModelId?.();
		return modelId === undefined ? {} : { activeModelId: modelId };
	}

	/**
	 * Machine-readable account status for the agent-invocable tool.
	 *
	 * REQ-STATUS-TOOL. This delegates to the SAME `#status("--json")` path the
	 * operator's `/multi-account status --json` renders, rather than assembling a
	 * second view. Duplicating it would let the operator surface and the agent
	 * surface drift, and the label rule below is exactly the kind of detail that
	 * drifts first.
	 *
	 * Human-readable labels are decorated HERE, at render time, from live config
	 * via `dependencies.accountLabel`. They are never read from the usage store:
	 * the store holds observations keyed by canonical provider id, and a label
	 * persisted alongside them would go stale the moment config changed, then be
	 * reported as current.
	 */
	statusJson(): string {
		return this.#status("--json");
	}

	isDisabled(providerId: string): boolean {
		return this.#disabledProviders.has(providerId);
	}

	shutdown(): void {
		this.#dependencies.watchdog.cancelAll();
		this.#dependencies.continuation.cancelAll();
		this.#dependencies.usage.clear();
		this.#disabledProviders.clear();
	}

	#now(): number {
		return (this.#dependencies.now ?? Date.now)();
	}

	#output(value: unknown): string {
		return this.#dependencies.diagnostics.sanitizeOutput(value);
	}
}

export { MANUAL_REMOVE_INSTRUCTIONS };

/*
 * ---------------------------------------------------------------------------
 * `/multi-account models install` and `/multi-account models update`
 * ---------------------------------------------------------------------------
 *
 * Writes the logical provider's declaration into the host's `models.json`.
 *
 * The file belongs to the operator, not to this extension. It may hold provider
 * entries this extension knows nothing about. The transaction owns the logical
 * provider declaration and `contextWindow` on offline-approved or independently
 * verified Codex overrides; it copies every other field through untouched.
 */

/** Live physical catalogs, keyed by managed family. */
export type ModelsCatalogs = ModelDeclarationCatalogs;

/** Reported just before the atomic replacement, while the target is still old. */
export type ModelsAtomicRenameDetails = {
	readonly temporaryPath: string;
	/** The prior bytes, kept aside. Absent only when there was no target. */
	readonly rollbackPath?: string | undefined;
};

export type ModelsLeaseHandle = { readonly release: () => void | Promise<void> };

export type ModelsCommandOptions = {
	readonly targetPath: string;
	readonly readCatalogs: () => ModelsCatalogs | Promise<ModelsCatalogs>;
	/** Synthetic evidence seam for tests; production reads exact official pages. */
	readonly fetchCodexModelDocumentation?: typeof fetch;
	readonly validateCandidate?: (candidate: unknown) => void | Promise<void>;
	readonly confirm: (diff: string) => boolean | Promise<boolean>;
	readonly acquireLease?: (
		targetPath: string,
	) => ModelsLeaseHandle | undefined | Promise<ModelsLeaseHandle | undefined>;
	readonly beforeAtomicRename?: (
		details: ModelsAtomicRenameDetails,
	) => void | Promise<void>;
	readonly afterAtomicRename?: (
		details: ModelsAtomicRenameDetails,
	) => void | Promise<void>;
};

export type ModelsFileShape = {
	providers?: Record<string, Record<string, unknown>>;
};

/** What the operator sees when a transaction finishes or declines to act. */
export type ModelsCommandResult = {
	readonly action: "install" | "update";
	readonly outcome: "committed" | "cancelled";
	readonly modelIds: readonly string[];
	readonly diagnostics: readonly string[];
};

const MODELS_COMMAND_USAGE =
	"Usage: /multi-account models install|update";
/** Previous provider identity, retained only for the models.json migration. */
const LEGACY_LOGICAL_PROVIDER_ID = "pi-multi-account";

/**
 * Read the target, treating an absent file as an empty one.
 *
 * Unparseable bytes fail closed rather than being replaced. Overwriting a file
 * this extension cannot read would destroy provider entries belonging to
 * someone else, which is the one outcome this transaction exists to prevent.
 */
function readModelsTarget(targetPath: string): {
	parsed: ModelsFileShape;
	bytes: Buffer | undefined;
} {
	if (!existsSync(targetPath)) return { parsed: {}, bytes: undefined };
	const bytes = readFileSync(targetPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(
			`The models file at ${targetPath} is not valid JSON, so it will not be replaced.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`The models file at ${targetPath} is not a JSON object, so it will not be replaced.`,
		);
	}
	return { parsed: parsed as ModelsFileShape, bytes };
}

/**
 * The default candidate check: structural, hermetic and always run.
 *
 * It confirms the bytes about to be written parse back to the declaration this
 * transaction intended — the managed entry present and correctly identified,
 * every row carrying an id, and no forbidden field. Driving a real host to
 * confirm the declaration actually loads is a live-integration concern and is
 * out of this node's scope; `validateCandidate` is the seam for it.
 */
function validateCandidateStructure(candidate: unknown): void {
	const providers =
		typeof candidate === "object" && candidate !== null
			? (candidate as ModelsFileShape).providers
			: undefined;
	const declaration = providers?.[LOGICAL_PROVIDER_ID];
	if (declaration === undefined) {
		throw new Error("the candidate declaration is missing the managed provider");
	}
	if (declaration.api !== LOGICAL_PROVIDER_ID) {
		throw new Error("the candidate declaration has the wrong api id");
	}
	// The host needs both of these to compose the provider at all, and deletes
	// it when composition fails. A candidate missing either is a file that
	// would load as nothing.
	if (declaration.name !== LOGICAL_PROVIDER_DISPLAY_NAME) {
		throw new Error("the candidate declaration has no usable provider name");
	}
	if (typeof declaration.apiKey !== "string" || declaration.apiKey === "") {
		throw new Error(
			"the candidate declaration has no authentication method, so the host would discard it",
		);
	}
	if (declaration.baseUrl !== DECLARATION_BASE_URL) {
		throw new Error("the candidate declaration has the wrong baseUrl");
	}
	if ("oauth" in declaration) {
		throw new Error("the candidate declaration carries a forbidden oauth field");
	}
	const models = declaration.models;
	if (!Array.isArray(models)) {
		throw new Error("the candidate declaration has no model rows");
	}
	assertProjectedManagedModels(models);
}

const MODELS_DIFF_ID_LIST_LIMIT = 20;
const MODEL_ID_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

function managedRowId(row: unknown): string | undefined {
	try {
		const id = (row as { readonly id?: unknown } | null | undefined)?.id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Canonical content used only to decide whether a row changed. */
function renderManagedRow(row: unknown): string | undefined {
	try {
		return JSON.stringify(assertProjectedManagedModel(row));
	} catch {
		return undefined;
	}
}

function renderModelId(id: string): string {
	return id.replace(MODEL_ID_SINGLE_LINE_CONTROLS, (character) => {
		switch (character) {
			case "\b":
				return "\\b";
			case "\t":
				return "\\t";
			case "\n":
				return "\\n";
			case "\f":
				return "\\f";
			case "\r":
				return "\\r";
			default:
				return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
		}
	});
}

function renderModelIds(ids: readonly string[]): string {
	const sorted = [...ids].sort();
	const visible = sorted.slice(0, MODELS_DIFF_ID_LIST_LIMIT).map(renderModelId);
	const overflow = sorted.length - visible.length;
	return `${visible.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`;
}

function renderCodexModelDefaultChanges(
	changes: readonly CodexModelDefaultChange[],
): string[] {
	if (changes.length === 0) {
		return ["  openai-codex modelOverrides: no contextWindow changes"];
	}
	const lines = ["  openai-codex modelOverrides:"];
	for (const change of changes) {
		if (change.contextWindow === undefined) {
			lines.push(
				`    - ${change.modelId}.contextWindow (was ${change.previousContextWindow})`,
			);
			continue;
		}
		if (!change.hadOverride) {
			lines.push(
				`    + ${change.modelId}.contextWindow = ${change.contextWindow}`,
			);
			continue;
		}
		lines.push(
			`    ~ ${change.modelId}.contextWindow: ${change.previousContextWindow ?? "<unset>"} -> ${change.contextWindow}`,
		);
	}
	return lines;
}

function renderModelsDiff(
	targetPath: string,
	action: "install" | "update",
	previous: readonly unknown[] | undefined,
	next: readonly ModelDeclarationRow[],
	diagnostics: readonly string[],
	codexChanges: readonly CodexModelDefaultChange[],
): string {
	type PreviousRowKey = string | symbol;
	interface PreviousRowEntry {
		readonly displayId: string;
		readonly row: unknown;
	}

	const previousById = new Map<PreviousRowKey, PreviousRowEntry>();
	for (const row of previous ?? []) {
		const id = managedRowId(row);
		previousById.set(id ?? Symbol("invalid previous model id"), {
			displayId: id ?? "<unknown>",
			row,
		});
	}
	const nextById = new Map<string, ModelDeclarationRow>();
	for (const row of next) nextById.set(row.id, row);

	const added = [...nextById.keys()].filter((id) => !previousById.has(id));
	const removed = [...previousById]
		.filter(([id]) => typeof id !== "string" || !nextById.has(id))
		.map(([, entry]) => entry.displayId);
	const changed: string[] = [];
	const unchanged: string[] = [];
	for (const [id, after] of nextById) {
		if (!previousById.has(id)) continue;
		const renderedBefore = renderManagedRow(previousById.get(id)?.row);
		const renderedAfter = renderManagedRow(after);
		if (
			renderedBefore !== undefined &&
			renderedAfter !== undefined &&
			renderedBefore === renderedAfter
		) {
			unchanged.push(id);
		} else {
			changed.push(id);
		}
	}

	const lines = [
		`${action} ${LOGICAL_PROVIDER_ID} in ${targetPath}`,
		`  ${next.length} models total: ${added.length} added, ${removed.length} removed, ${changed.length} changed, ${unchanged.length} unchanged`,
	];
	if (added.length > 0) lines.push(`  + added:   ${renderModelIds(added)}`);
	if (removed.length > 0) lines.push(`  - removed: ${renderModelIds(removed)}`);
	if (changed.length > 0) lines.push(`  ~ changed: ${renderModelIds(changed)}`);
	lines.push(...renderCodexModelDefaultChanges(codexChanges));
	for (const note of diagnostics) lines.push(`  note: ${note}`);
	return lines.join("\n");
}

/**
 * Install or update the logical provider's declaration.
 *
 * The order of operations is the contract. Syntax and declaration state are
 * settled before the live catalogs are read, so a mistyped command never
 * reaches the network. The candidate is validated and confirmed before the
 * lease is taken, so a rejected write never blocks another writer. The target
 * is re-read after the lease is held, so a change made by someone else between
 * the first read and the write aborts instead of being overwritten.
 */
export async function executeModelsCommand(
	rawArguments: string,
	options: ModelsCommandOptions,
): Promise<ModelsCommandResult> {
	const tokens = rawArguments.trim().split(/\s+/u).filter((t) => t.length > 0);
	const [head, action, ...rest] = tokens;
	if (head !== "models" || rest.length > 0) throw new TypeError(MODELS_COMMAND_USAGE);
	if (action !== "install" && action !== "update") {
		throw new TypeError(MODELS_COMMAND_USAGE);
	}

	const { targetPath } = options;
	const initial = readModelsTarget(targetPath);
	const existingDeclaration = initial.parsed.providers?.[LOGICAL_PROVIDER_ID];
	const legacyDeclaration =
		initial.parsed.providers?.[LEGACY_LOGICAL_PROVIDER_ID];
	const hasManagedLegacyDeclaration =
		legacyDeclaration?.api === LEGACY_LOGICAL_PROVIDER_ID &&
		legacyDeclaration.baseUrl === DECLARATION_BASE_URL;

	// Declaration state is checked before anything is read from the providers.
	if (action === "install" && existingDeclaration !== undefined) {
		throw new Error(
			`A managed declaration already exists in ${targetPath}. Run /multi-account models update to refresh it.`,
		);
	}
	if (
		action === "update" &&
		existingDeclaration === undefined &&
		!hasManagedLegacyDeclaration
	) {
		throw new Error(
			`No managed declaration is present in ${targetPath}. Run /multi-account models install first.`,
		);
	}

	const previousDeclaration =
		existingDeclaration ??
		(action === "update" && hasManagedLegacyDeclaration
			? legacyDeclaration
			: undefined);
	const previousRows = Array.isArray(previousDeclaration?.models)
		? previousDeclaration.models
		: undefined;

	// Validate operator-owned Codex overrides before consulting live providers.
	// A malformed override survives byte-for-byte because no catalog or official
	// documentation is read and no candidate is built.
	planCodexModelDefaults(initial.parsed.providers);

	// Fail closed: an unreadable catalog produces no write or documentation
	// request. Validate a projection before deriving any network candidate IDs;
	// the final projection below uses the independently resolved map.
	const catalogs = await options.readCatalogs();
	buildModelDeclarationWithCodexDefaults(catalogs, new Map<string, number>());
	const resolvedCodexDefaults = await resolveCodexLongContextDefaults(
		catalogs["openai-codex"],
		{
			...(options.fetchCodexModelDocumentation === undefined
				? {}
				: { fetchDocumentation: options.fetchCodexModelDocumentation }),
		},
	);
	const codexDefaults = planCodexModelDefaults(
		initial.parsed.providers,
		resolvedCodexDefaults.contextWindowByModelId,
		resolvedCodexDefaults.liveCompleteOfflineModelIds,
	);
	const built = buildModelDeclarationWithCodexDefaults(
		catalogs,
		codexDefaults.contextWindowByModelId,
	);
	const diagnostics = [...resolvedCodexDefaults.diagnostics, ...built.diagnostics];
	const modelIds = built.models.map((row) => String(row.id));

	const candidateProviders = { ...codexDefaults.providers };
	// Remove only the declaration shape this extension used before the ID rename.
	if (hasManagedLegacyDeclaration) {
		delete candidateProviders[LEGACY_LOGICAL_PROVIDER_ID];
	}
	const candidate: ModelsFileShape = {
		...initial.parsed,
		providers: {
			...candidateProviders,
			[LOGICAL_PROVIDER_ID]: {
				name: LOGICAL_PROVIDER_DISPLAY_NAME,
				api: LOGICAL_PROVIDER_ID,
				baseUrl: DECLARATION_BASE_URL,
				// Pi's provider composer requires an authentication method, and it
				// DELETES a provider whose entry fails to compose. Without this the
				// installed declaration would be discarded in silence and the
				// operator would simply never see the models they installed.
				//
				// The value is a fixed placeholder, not a credential. This provider
				// is never dialed: every request is dispatched through a physical
				// account that authenticates itself, and the baseUrl is a reserved
				// address that resolves nowhere.
				apiKey: DECLARATION_PLACEHOLDER_KEY,
				models: built.models,
			},
		},
	};

	await (options.validateCandidate ?? validateCandidateStructure)(candidate);

	const diff = renderModelsDiff(
		targetPath,
		action,
		previousRows,
		built.models,
		diagnostics,
		codexDefaults.changes,
	);
	if (!(await options.confirm(diff))) {
		return {
			action,
			outcome: "cancelled",
			modelIds,
			diagnostics,
		};
	}

	// The lock sits beside the file it protects. A machine-global lock would
	// serialize writers of unrelated models files against each other, and would
	// write real machine state on behalf of a caller working in a sandbox.
	const acquire =
		options.acquireLease ??
		((path: string) => acquireMachineLease({ lockPath: `${path}.lock` }));
	const lease = await acquire(targetPath);
	if (lease === undefined) {
		throw new Error(
			`Another process is writing ${targetPath}. Try again in a moment.`,
		);
	}

	try {
		const current = readModelsTarget(targetPath);
		const drifted =
			initial.bytes === undefined
				? current.bytes !== undefined
				: current.bytes === undefined || !current.bytes.equals(initial.bytes);
		if (drifted) {
			throw new Error(
				`${targetPath} changed while this command was preparing its write, so nothing was written.`,
			);
		}
		await commitModelsCandidate(targetPath, candidate, options);
		return {
			action,
			outcome: "committed",
			modelIds,
			diagnostics,
		};
	} finally {
		await lease.release();
	}
}

/**
 * Replace the target atomically, mirroring `writeConfig`.
 *
 * The candidate is written to an owner-only temporary file in the target's own
 * directory, so the rename is a same-filesystem atomic swap and no reader ever
 * observes a half-written file. When a target already exists its bytes are
 * copied aside first: if anything fails after that point the prior file can be
 * put back exactly as it was. Both scratch files are removed on every path,
 * because a leftover temporary is itself a partial write someone will find.
 */
async function commitModelsCandidate(
	targetPath: string,
	candidate: ModelsFileShape,
	options: ModelsCommandOptions,
): Promise<void> {
	const directory = dirname(targetPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stem = `${basename(targetPath)}.${process.pid}.${randomUUID()}`;
	const temporaryPath = join(directory, `.${stem}.tmp`);
	const rollbackPath = existsSync(targetPath)
		? join(directory, `.${stem}.rollback`)
		: undefined;

	let descriptor: number | undefined;
	let replaced = false;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(candidate, null, "\t")}\n`, {
			encoding: "utf-8",
		});
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);

		if (rollbackPath !== undefined) {
			copyFileSync(targetPath, rollbackPath);
			chmodSync(rollbackPath, 0o600);
		}

		await options.beforeAtomicRename?.({ temporaryPath, rollbackPath });

		renameSync(temporaryPath, targetPath);
		replaced = true;
		await options.afterAtomicRename?.({ temporaryPath, rollbackPath });
		chmodSync(targetPath, 0o600);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		// The rename either happened or it did not. When it did not, the target
		// was never touched, so putting the rollback copy back would be a write
		// where none occurred. Restore only after a failure past the swap.
		if (replaced && rollbackPath !== undefined && existsSync(rollbackPath)) {
			copyFileSync(rollbackPath, targetPath);
		} else if (replaced && rollbackPath === undefined && existsSync(targetPath)) {
			unlinkSync(targetPath);
		}
		throw error;
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		if (rollbackPath !== undefined && existsSync(rollbackPath)) {
			unlinkSync(rollbackPath);
		}
	}
}
