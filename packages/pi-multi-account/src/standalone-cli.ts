/**
 * The standalone `multi-account` shell command entry point.
 *
 * `scripts/multi-account.mjs` is the package's published `bin` launcher; it
 * installs a Node module-customization hook so this package's NodeNext-style
 * ".js"-suffixed relative specifiers resolve to their ".ts" siblings under a
 * bare `node` invocation, then calls {@link runStandaloneCli} with the raw
 * argv. This module owns argument parsing, the preview/confirmation dialog,
 * and stable process exit codes; the actual assignment transaction lives in
 * `account-plan-assignment.ts`, and the read-only cost report projection
 * lives in `cost-report-reader.ts`/`cost-report.ts`.
 *
 * This module implements two commands: `account set-plan` and `cost`
 * (including its explicit `refresh-pricing`/`close-periods` actions). Every
 * command shares one stable exit table: `0` success (including a declined
 * confirmation or a truthful empty report -- the operator's explicit choice
 * or legitimately empty history, not a failure); `1` an unexpected internal
 * failure (a held lease, an I/O error, an unreadable configuration file);
 * `2` a syntax, argument, or domain validation failure (an unknown account or
 * preset id, a malformed or missing `--effective-from`, mutually exclusive
 * report selectors, or an unsupported flag); `3` when retained data cannot
 * satisfy the requested report precision; `4` for corrupt bounded retained
 * cost history; and `5` for an explicit `refresh-pricing`/`close-periods`
 * action failure. `cost` (without `refresh-pricing`/`close-periods`) is a
 * strict read-only, offline probe: it never contacts a provider, refreshes
 * pricing, closes a period, migrates configuration, edits an account rate, or
 * creates a catalog, including on an empty first run.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import {
	AccountPlanAssignmentError,
	commitAccountPlanAssignment,
	type AccountPlanAssignmentInput,
	type AccountPlanAssignmentPreview,
} from "./account-plan-assignment.js";
import { AccountRateHistoryError } from "./account-rate-history.js";
import { parsePiCatalogSnapshot, type PiCatalogSnapshot } from "./api-pricing.js";
import { ConfigValidationError, readConfig } from "./config.js";
import {
	CostReportRangeRequestError,
	createDefaultCostReportReader,
	type CostReportRangeRequest,
	type CostReportReader,
} from "./cost-report-reader.js";
import { renderCostReportJson } from "./cost-report-json.js";
import {
	createDefaultCostPeriodCloser,
	type CostPeriodCloseResult,
} from "./cost-period-closer.js";
import { renderCostReport } from "./cost-report-render.js";
import { PERIOD_TYPES, type PeriodType } from "./period-boundaries.js";
import {
	defaultPricingCachePaths,
	OpenRouterPricingCache,
	type PricingCacheResult,
} from "./pricing-cache.js";

export const EXIT_SUCCESS = 0;
export const EXIT_UNEXPECTED_FAILURE = 1;
export const EXIT_VALIDATION_FAILURE = 2;
export const EXIT_UNSATISFIABLE_PRECISION = 3;
export const EXIT_CORRUPT_RETAINED_INPUT = 4;
export const EXIT_ACTION_FAILURE = 5;

export interface StandaloneCliDependencies {
	readonly configPath?: string;
	readonly lockPath?: string;
	readonly stdin?: NodeJS.ReadableStream;
	readonly stdout?: Pick<NodeJS.WritableStream, "write">;
	readonly stderr?: Pick<NodeJS.WritableStream, "write">;
	/** Overrides the report clock (for testing only). Defaults to `Date.now`. */
	readonly now?: () => number;
}

function defaultConfigPath(): string {
	const baseDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(baseDirectory, "pi-multi-account", "config.json");
}

/**
 * Resolves the actually-installed `@earendil-works/pi-ai` package version by
 * walking up from its resolved `providers/anthropic.models` module file to
 * the nearest `package.json` whose `name` matches. Reading a real installed
 * `package.json` from disk is a local, offline, bounded lookup -- never a
 * network request -- and gives an honest provenance label for whichever
 * pinned catalog this process actually loaded, rather than a hard-coded
 * version string that could drift from what is really installed.
 */
function resolveInstalledPiAiVersion(): string {
	try {
		const moduleUrl = import.meta.resolve(
			"@earendil-works/pi-ai/providers/anthropic.models",
		);
		let directory = dirname(fileURLToPath(moduleUrl));
		for (let depth = 0; depth < 6; depth += 1) {
			try {
				const candidate = JSON.parse(
					readFileSync(join(directory, "package.json"), "utf-8"),
				) as { readonly name?: unknown; readonly version?: unknown };
				if (
					candidate.name === "@earendil-works/pi-ai" &&
					typeof candidate.version === "string" &&
					candidate.version.length > 0
				) {
					return `pi-ai@${candidate.version}`;
				}
			} catch {
				// Keep walking toward the installed package root.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		// Resolution failure falls through to the bounded fallback below.
	}
	return "pi-ai@unknown";
}

interface OfflineCatalogModelSource {
	readonly vendor: "anthropic" | "openai";
	readonly id: string;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly tiers?: ReadonlyArray<{
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly inputTokensAbove: number;
		}>;
	};
}

/**
 * Every managed-vendor model the pinned `@earendil-works/pi-ai` package
 * ships, tagged with the vendor prefix `lookupPiCatalogCost` resolves
 * requests against (see `api-pricing.ts`'s `accountAuthor`): the `anthropic`
 * family keeps its own `anthropic` provider id, while the `openai-codex`
 * family's models are authored by, and therefore keyed under, `openai`. The
 * separate owning-vendor-api `openai` platform family is deliberately
 * excluded -- it never resolves through `accountAuthor` and stays outside
 * this subscription-value report's scope.
 */
function offlineManagedModels(): readonly OfflineCatalogModelSource[] {
	const models: OfflineCatalogModelSource[] = [];
	for (const model of Object.values(ANTHROPIC_MODELS)) {
		models.push({ vendor: "anthropic", id: model.id, cost: model.cost });
	}
	for (const model of Object.values(OPENAI_CODEX_MODELS)) {
		models.push({ vendor: "openai", id: model.id, cost: model.cost });
	}
	return models;
}

/**
 * The standalone CLI's read-only, offline Pi-catalog source. The pinned
 * `@earendil-works/pi-ai` dependency ships the exact same per-response tier
 * metadata (`model.cost`/`model.cost.tiers`, matched by `inputTokensAbove`)
 * that a live `ExtensionContext.modelRegistry` exposes to the extension's
 * slash/tool surfaces (see `src/index.ts`'s own live-registry adapter).
 * Reading it here is a local package import already resolved by Node's own
 * module loader, never a network call or a write, so the report stays
 * offline even on an empty first run. Returns `undefined` (never throws) so
 * a shape this parser rejects degrades to the pre-existing
 * OpenRouter-snapshot-only pricing instead of failing the whole report.
 */
function buildOfflinePiCatalogSnapshot(nowMs: number): PiCatalogSnapshot | undefined {
	const costsBySourceModelId: Record<string, unknown> = {};
	for (const model of offlineManagedModels()) {
		costsBySourceModelId[`${model.vendor}/${model.id}`] = {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
			...(model.cost.tiers === undefined ? {} : { tiers: model.cost.tiers }),
		};
	}
	try {
		return parsePiCatalogSnapshot({
			schemaVersion: 1,
			source: "pi-installed-catalog",
			catalogVersion: resolveInstalledPiAiVersion(),
			capturedAtMs: nowMs,
			costsBySourceModelId,
		});
	} catch {
		return undefined;
	}
}

/** Binds the pure cost-report projection to `configPath` and the offline catalog above. Never itself contacts a provider or writes anything. */
function buildCostReportReader(
	configPath: string,
	now: () => number,
): CostReportReader {
	return createDefaultCostReportReader({
		config: () => readConfig(configPath),
		now,
		piCatalog: () => buildOfflinePiCatalogSnapshot(now()),
	});
}

class CostCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CostCliError";
	}
}

const VALID_FORMATS = new Set(["text", "json"]);

function validTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

type CostCliRangeSelector =
	| { readonly kind: "period"; readonly periodType: PeriodType; readonly timeZone: string }
	| {
			readonly kind: "custom";
			readonly fromRaw: string;
			readonly toRaw: string;
			readonly timeZone: string;
	  }
	| { readonly kind: "all-history" };

interface CostReportCliRequest {
	readonly selector: CostCliRangeSelector;
	readonly format: "text" | "json";
}

/**
 * Parses `cost`'s report flags only; `refresh-pricing`/`close-periods` are
 * dispatched before this ever runs. `--period`, paired `--from`/`--to`, and
 * `--all-history` are mutually exclusive; `--format` defaults to `text` and
 * `--timezone` defaults to `UTC`. Never infers a partial `--from`/`--to` pair
 * or silently drops an unsupported flag.
 */
function parseCostReportArgs(args: readonly string[]): CostReportCliRequest {
	let period: string | undefined;
	let sawPeriodFlag = false;
	let fromRaw: string | undefined;
	let toRaw: string | undefined;
	let sawAllHistory = false;
	let format: string | undefined;
	let timeZone: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--period") {
			sawPeriodFlag = true;
			period = args[index + 1];
			index += 1;
		} else if (token === "--from") {
			fromRaw = args[index + 1];
			index += 1;
		} else if (token === "--to") {
			toRaw = args[index + 1];
			index += 1;
		} else if (token === "--all-history") {
			sawAllHistory = true;
		} else if (token === "--format") {
			format = args[index + 1];
			index += 1;
		} else if (token === "--timezone") {
			timeZone = args[index + 1];
			index += 1;
		} else {
			throw new CostCliError(`Unsupported argument "${token}".`);
		}
	}

	const selectorCount =
		(sawPeriodFlag ? 1 : 0) +
		(fromRaw !== undefined || toRaw !== undefined ? 1 : 0) +
		(sawAllHistory ? 1 : 0);
	if (selectorCount > 1) {
		throw new CostCliError(
			"--period, --from/--to, and --all-history are mutually exclusive.",
		);
	}
	if ((fromRaw === undefined) !== (toRaw === undefined)) {
		throw new CostCliError("--from and --to must both be supplied together.");
	}

	const resolvedFormat = format ?? "text";
	if (!VALID_FORMATS.has(resolvedFormat)) {
		throw new CostCliError(
			`--format must be "text" or "json", not "${resolvedFormat}".`,
		);
	}

	const resolvedTimeZone = timeZone ?? "UTC";
	if (!validTimeZone(resolvedTimeZone)) {
		throw new CostCliError(
			`"${resolvedTimeZone}" is not a supported IANA timezone.`,
		);
	}

	let selector: CostCliRangeSelector;
	if (sawAllHistory) {
		selector = { kind: "all-history" };
	} else if (fromRaw !== undefined && toRaw !== undefined) {
		selector = { kind: "custom", fromRaw, toRaw, timeZone: resolvedTimeZone };
	} else {
		const resolvedPeriod = period ?? "month";
		if (!PERIOD_TYPES.includes(resolvedPeriod as PeriodType)) {
			throw new CostCliError(
				`--period must be one of ${PERIOD_TYPES.join(", ")}, not "${resolvedPeriod}".`,
			);
		}
		selector = {
			kind: "period",
			periodType: resolvedPeriod as PeriodType,
			timeZone: resolvedTimeZone,
		};
	}

	return { selector, format: resolvedFormat as "text" | "json" };
}

/**
 * A bare `--period` request carries no timezone slot in
 * {@link CostReportRangeRequest} (see `cost-report-reader.ts`): only its
 * `"period"` and `"custom"` variants do. For the default `UTC` timezone this
 * passes the bare {@link PeriodType} straight through, byte-identical to the
 * existing slash/tool compatibility path. A non-UTC `--timezone` resolves
 * through the reader's `"period"` request kind instead, which dispatches
 * directly to `buildCostReport`'s own `periodType`/`timeZone` bounds path --
 * never through `"custom"` -- so the selected calendar period keeps its
 * correct zoned bounds and "current unfinished period" semantics rather than
 * collapsing to a single exact-bounds custom window.
 */
function resolveRangeRequest(selector: CostCliRangeSelector): CostReportRangeRequest {
	if (selector.kind === "all-history") return { kind: "all-history" };
	if (selector.kind === "custom") {
		return {
			kind: "custom",
			fromRaw: selector.fromRaw,
			toRaw: selector.toRaw,
			timeZone: selector.timeZone,
		};
	}
	if (selector.timeZone === "UTC") return selector.periodType;
	return {
		kind: "period",
		periodType: selector.periodType,
		timeZone: selector.timeZone,
	};
}

async function runCostReport(
	args: readonly string[],
	deps: {
		readonly stdout: Pick<NodeJS.WritableStream, "write">;
		readonly stderr: Pick<NodeJS.WritableStream, "write">;
		readonly configPath: string;
		readonly now: () => number;
	},
): Promise<number> {
	let parsed: CostReportCliRequest;
	let range: CostReportRangeRequest;
	try {
		parsed = parseCostReportArgs(args);
		range = resolveRangeRequest(parsed.selector);
	} catch (error) {
		deps.stderr.write(`multi-account: ${(error as Error).message}\n${COST_USAGE}`);
		return EXIT_VALIDATION_FAILURE;
	}

	const reader = buildCostReportReader(deps.configPath, deps.now);
	try {
		const report = reader(range);
		const rendered =
			parsed.format === "json" ? renderCostReportJson(report) : renderCostReport(report);
		deps.stdout.write(`${rendered}\n`);
		return EXIT_SUCCESS;
	} catch (error) {
		if (error instanceof CostReportRangeRequestError) {
			deps.stderr.write(`multi-account: ${error.message}\n`);
			return error.exitCode;
		}
		if (error instanceof ConfigValidationError) {
			deps.stderr.write(`multi-account: ${error.message}\n`);
			return EXIT_UNEXPECTED_FAILURE;
		}
		deps.stderr.write(
			`multi-account: retained cost history could not be read: ${(error as Error).message}\n`,
		);
		return EXIT_CORRUPT_RETAINED_INPUT;
	}
}

async function runRefreshPricing(deps: {
	readonly stdout: Pick<NodeJS.WritableStream, "write">;
	readonly stderr: Pick<NodeJS.WritableStream, "write">;
}): Promise<number> {
	const cache = new OpenRouterPricingCache(defaultPricingCachePaths());
	let result: PricingCacheResult;
	try {
		result = await cache.refreshIfNeeded();
	} catch (error) {
		deps.stderr.write(
			`multi-account: pricing refresh failed: ${(error as Error).message}\n`,
		);
		return EXIT_ACTION_FAILURE;
	}
	if (result.state === "fresh") {
		deps.stdout.write(
			`Pricing cache refreshed (${Object.keys(result.snapshot.rates).length} rate(s), fetched ${new Date(result.snapshot.fetchedAtMs).toISOString()}).\n`,
		);
		return EXIT_SUCCESS;
	}
	deps.stderr.write(`multi-account: pricing refresh failed (${result.reason}).\n`);
	return EXIT_ACTION_FAILURE;
}

async function runClosePeriods(deps: {
	readonly stdout: Pick<NodeJS.WritableStream, "write">;
	readonly stderr: Pick<NodeJS.WritableStream, "write">;
}): Promise<number> {
	const closer = createDefaultCostPeriodCloser();
	let result: CostPeriodCloseResult;
	try {
		result = await closer.closeCompletedPeriods();
	} catch (error) {
		deps.stderr.write(
			`multi-account: period closure failed: ${(error as Error).message}\n`,
		);
		return EXIT_ACTION_FAILURE;
	}
	if (result.status === "closed") {
		deps.stdout.write(`Closed ${result.appendedRows} cost period row(s).\n`);
		return EXIT_SUCCESS;
	}
	if (result.status === "no-op") {
		deps.stdout.write("No completed cost periods were ready to close.\n");
		return EXIT_SUCCESS;
	}
	const reason =
		result.status === "lease-held"
			? "another writer holds the digest lease"
			: result.status === "skipped"
				? "already attempted for the current day"
				: "the digest write did not complete";
	deps.stderr.write(`multi-account: period closure failed (${reason}).\n`);
	return EXIT_ACTION_FAILURE;
}

const USAGE =
	'Usage: multi-account account set-plan <account-id> --type <preset-id> --effective-from <timestamp> [--monthly-usd <amount>]\n' +
	'  <timestamp> must be an RFC 3339 instant with an explicit "Z" or numeric offset.\n';

const COST_USAGE =
	"Usage: multi-account cost [--period day|week|month|quarter|half-year|year]\n" +
	"                          [--from <bound> --to <bound>] [--all-history]\n" +
	"                          [--format text|json] [--timezone <iana-zone>]\n" +
	"       multi-account cost refresh-pricing\n" +
	"       multi-account cost close-periods\n";

const SET_PLAN_HELP =
	"multi-account account set-plan - assign an editable-catalog preset as an account's effective rate record.\n\n" +
	"multi-account account set-plan <account-id> --type <preset-id> --effective-from <timestamp> [--monthly-usd <amount>]\n\n" +
	"  <account-id>                  Canonical account id (for example anthropic, anthropic-account-2).\n" +
	"  --type <preset-id>            Shipped or operator-added catalog preset id.\n" +
	'  --effective-from <timestamp>  Required RFC 3339 instant with an explicit "Z" or numeric offset; never inferred, never a history start or renewal boundary.\n' +
	"  --monthly-usd <amount>        Optional override; an explicit 0 is a valid rate and differs from having no rate at all.\n\n" +
	"Resolves the preset, prints a preview naming the account, provider, account type, preset, monthly rate, effective instant, and catalog version, then asks for a literal \"y\"/\"yes\" confirmation before writing anything.\n" +
	"The preset's terms, label, catalog version, and provenance are copied into the new immutable rate record at write time; a later catalog edit never rewrites an existing record or a past report result.\n" +
	"Performs no configuration migration: nothing here rewrites the legacy monthlySubscriptionUsd value or invents earlier history.\n\n" +
	"Exit codes: 0 success (including a declined confirmation), 1 unexpected internal failure, 2 syntax/argument/domain validation failure.\n";

const COST_HELP =
	"multi-account cost - read-only, offline subscription-value report.\n\n" +
	COST_USAGE +
	"\n" +
	"  --period <day|week|month|quarter|half-year|year>  Calendar period (default: month).\n" +
	"  --from <bound> --to <bound>                       Explicit custom range, start-inclusive and end-exclusive.\n" +
	"  --all-history                                      Every retained period, without double-counting overlapping rollups.\n" +
	"  --format <text|json>                               Output shape (default: text). json is one versioned document.\n" +
	"  --timezone <iana-zone>                             IANA zone for calendar boundaries and date-only bounds (default: UTC). Account-cost allocation always splits at UTC month boundaries regardless of this zone.\n\n" +
	"--period, --from/--to, and --all-history are mutually exclusive.\n" +
	'A custom bound is an ISO date (YYYY-MM-DD) or an RFC 3339 timestamp with an explicit "Z" or numeric offset; an offsetless date-time is rejected.\n' +
	"This command is read-only and offline, including on an empty first run: it never contacts a provider, refreshes pricing, closes a period, migrates configuration, edits an account rate, or creates a catalog.\n\n" +
	"multi-account cost refresh-pricing  Explicit action: refresh the cached OpenRouter API-equivalent rate snapshot (network, write).\n" +
	"multi-account cost close-periods    Explicit action: close completed cost periods into the retained digest (network, write; governed by the existing machine lease).\n\n" +
	"Exit codes: 0 success (including a truthful empty report), 1 unexpected internal failure, 2 syntax/argument error, 3 requested precision unavailable, 4 corrupt retained cost history, 5 explicit action failure.\n";

const TOP_LEVEL_USAGE =
	"multi-account - standalone subscription-value reporting and account plan assignment.\n\n" +
	"Commands:\n" +
	"  cost [selector] [--format text|json] [--timezone <iana-zone>]  Read-only, offline subscription-value report.\n" +
	"  cost refresh-pricing                                          Explicit pricing-cache refresh action.\n" +
	"  cost close-periods                                            Explicit period-closure action.\n" +
	"  account set-plan <account-id> --type <preset-id> --effective-from <timestamp> [--monthly-usd <amount>]\n" +
	"                                                                 Assign a catalog preset as an account's effective rate.\n\n" +
	"Run `multi-account cost --help` or `multi-account account set-plan --help` for command-specific detail.\n";

/**
 * Parses `account set-plan` arguments. Never infers or defaults
 * `effectiveFrom`: a missing or empty `--effective-from` value is rejected
 * here, identically whether or not the target account already has history.
 */
function parseSetPlanArgs(args: readonly string[]): AccountPlanAssignmentInput {
	const positionals: string[] = [];
	let presetId: string | undefined;
	let effectiveFrom: string | undefined;
	let sawEffectiveFromFlag = false;
	let monthlyUsdOverride: number | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--type") {
			presetId = args[index + 1];
			index += 1;
		} else if (token === "--effective-from") {
			sawEffectiveFromFlag = true;
			effectiveFrom = args[index + 1];
			index += 1;
		} else if (token === "--monthly-usd") {
			const raw = args[index + 1];
			index += 1;
			if (raw === undefined) {
				throw new AccountPlanAssignmentError("--monthly-usd requires a value.");
			}
			const parsedAmount = Number(raw);
			if (!Number.isFinite(parsedAmount)) {
				throw new AccountPlanAssignmentError(
					`--monthly-usd "${raw}" is not a finite number.`,
				);
			}
			monthlyUsdOverride = parsedAmount;
		} else if (token !== undefined && token.startsWith("--")) {
			throw new AccountPlanAssignmentError(`Unsupported flag "${token}".`);
		} else if (token !== undefined) {
			positionals.push(token);
		}
	}

	if (positionals.length !== 1) {
		throw new AccountPlanAssignmentError(
			"account set-plan requires exactly one <account-id> argument.",
		);
	}
	if (presetId === undefined || presetId.length === 0) {
		throw new AccountPlanAssignmentError(
			"account set-plan requires --type <preset-id>.",
		);
	}
	// A missing flag, a present-but-empty value, and (by construction, since
	// this function never derives one) any reliance on a renewal or history
	// default are rejected identically here.
	if (!sawEffectiveFromFlag || effectiveFrom === undefined || effectiveFrom.length === 0) {
		throw new AccountPlanAssignmentError(
			'account set-plan requires --effective-from <timestamp> as an RFC 3339 instant with an explicit "Z" or numeric offset.',
		);
	}

	return {
		accountId: positionals[0] as string,
		presetId,
		effectiveFrom,
		...(monthlyUsdOverride !== undefined ? { monthlyUsdOverride } : {}),
	};
}

function formatPreview(preview: AccountPlanAssignmentPreview): string {
	const rateLine = preview.isOverride
		? `$${preview.monthlyUsd.toFixed(2)}/mo (explicit override)`
		: `$${preview.monthlyUsd.toFixed(2)}/mo (catalog default)`;
	return [
		"Account plan assignment preview:",
		`  account:         ${preview.accountId}`,
		`  provider:        ${preview.provider}`,
		`  account type:    ${preview.accountType}`,
		`  preset:          ${preview.presetId} (${preview.presetLabel})`,
		`  monthly rate:    ${rateLine}`,
		`  effective from:  ${preview.effectiveFrom}`,
		`  catalog version: ${preview.catalogVersion}`,
		"",
	].join("\n");
}

/**
 * Reads exactly one line from `input` and accepts only an exact (trimmed,
 * case-insensitive) "y" or "yes" as confirmation. EOF without a line, or any
 * other input, declines.
 */
async function readConfirmation(input: NodeJS.ReadableStream): Promise<boolean> {
	const rl = createInterface({ input, terminal: false });
	try {
		for await (const line of rl) {
			const normalized = line.trim().toLowerCase();
			return normalized === "y" || normalized === "yes";
		}
		return false;
	} finally {
		rl.close();
	}
}

async function runSetPlan(
	args: readonly string[],
	deps: Required<Pick<StandaloneCliDependencies, "stdout" | "stderr" | "stdin">> &
		Pick<StandaloneCliDependencies, "configPath" | "lockPath">,
): Promise<number> {
	let input: AccountPlanAssignmentInput;
	try {
		input = parseSetPlanArgs(args);
	} catch (error) {
		deps.stderr.write(`multi-account: ${(error as Error).message}\n${USAGE}`);
		return EXIT_VALIDATION_FAILURE;
	}

	const configPath = deps.configPath ?? defaultConfigPath();

	try {
		const result = await commitAccountPlanAssignment({
			configPath,
			...(deps.lockPath !== undefined ? { lockPath: deps.lockPath } : {}),
			input,
			onPreview: (preview) => {
				deps.stdout.write(formatPreview(preview));
			},
			confirm: async () => {
				deps.stdout.write("Apply this account plan assignment? [y/N] ");
				return readConfirmation(deps.stdin);
			},
		});
		if (result.status === "declined") {
			deps.stdout.write("No change was written.\n");
			return EXIT_SUCCESS;
		}
		if (result.status === "busy") {
			deps.stderr.write(
				"multi-account: configuration is locked by another writer; try again.\n",
			);
			return EXIT_UNEXPECTED_FAILURE;
		}
		deps.stdout.write(
			`Recorded ${result.record.presetLabel} for ${result.record.accountId}, effective ${result.record.effectiveFrom}.\n`,
		);
		return EXIT_SUCCESS;
	} catch (error) {
		if (
			error instanceof AccountPlanAssignmentError ||
			error instanceof AccountRateHistoryError ||
			error instanceof ConfigValidationError
		) {
			deps.stderr.write(`multi-account: ${error.message}\n`);
			return EXIT_VALIDATION_FAILURE;
		}
		deps.stderr.write(`multi-account: ${(error as Error).message}\n`);
		return EXIT_UNEXPECTED_FAILURE;
	}
}

export async function runStandaloneCli(
	argv: readonly string[],
	deps: StandaloneCliDependencies = {},
): Promise<number> {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const stdin = deps.stdin ?? process.stdin;
	const now = deps.now ?? Date.now;

	if (argv[0] === "--help" || argv[0] === "help") {
		stdout.write(TOP_LEVEL_USAGE);
		return EXIT_SUCCESS;
	}

	if (argv[0] === "account" && argv[1] === "set-plan") {
		const rest = argv.slice(2);
		if (rest.includes("--help")) {
			stdout.write(SET_PLAN_HELP);
			return EXIT_SUCCESS;
		}
		return runSetPlan(rest, {
			stdout,
			stderr,
			stdin,
			...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
			...(deps.lockPath !== undefined ? { lockPath: deps.lockPath } : {}),
		});
	}

	if (argv[0] === "cost") {
		const rest = argv.slice(1);
		if (rest.includes("--help")) {
			stdout.write(COST_HELP);
			return EXIT_SUCCESS;
		}
		if (rest.length === 1 && rest[0] === "refresh-pricing") {
			return runRefreshPricing({ stdout, stderr });
		}
		if (rest.length === 1 && rest[0] === "close-periods") {
			return runClosePeriods({ stdout, stderr });
		}
		const configPath = deps.configPath ?? defaultConfigPath();
		return runCostReport(rest, { stdout, stderr, configPath, now });
	}

	stderr.write(`multi-account: unsupported command "${argv.join(" ")}".\n${TOP_LEVEL_USAGE}`);
	return EXIT_VALIDATION_FAILURE;
}
