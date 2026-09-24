/**
 * The preview-confirm-atomic-write workflow behind `multi-account account
 * set-plan`.
 *
 * This module holds the domain transaction only: resolving and validating a
 * candidate assignment against the current catalog and canonical account set,
 * building the immutable {@link AccountRateRecord} it selects, and committing
 * it through exactly one atomic {@link writeConfig} call. It never guesses
 * `effectiveFrom`, a history start, or a next-renewal boundary, and it never
 * suggests a nearby preset for an unknown id -- both are rejected outright.
 *
 * Ordering mirrors `routing-config-transaction.ts`'s documented invariant:
 * human dialogs never hold a machine lease. The preview is built from an
 * unlocked read; the machine lease guarding `config.json` is acquired only
 * after the operator has confirmed, and every value written to disk is
 * re-resolved from a fresh, locked read immediately beforehand, so a stale
 * preview -- or a catalog/account edit racing the confirmation dialog -- can
 * never reach the single atomic write.
 */

import {
	isCanonicalSubscriptionAccountId,
	readConfig,
	validateConfig,
	writeConfig,
	type ConfigWriteOutcome,
	type MultiAccountConfig,
} from "./config.js";
import {
	findSubscriptionPlanPreset,
	loadEffectiveSubscriptionPlanCatalog,
	type CatalogAccountType,
	type CatalogProvider,
	type SubscriptionPlanCatalog,
	type SubscriptionPlanPreset,
} from "./subscription-plan-catalog.js";
import {
	assertValidEffectiveFrom,
	createAccountRateRecord,
	normalizeAccountRateHistory,
	type AccountRateRecord,
} from "./account-rate-history.js";
import {
	MACHINE_LEASE_TTL_MS,
	acquireMachineLease,
	type MachineLeaseHandle,
	type MachineLeaseOptions,
} from "./machine-lease.js";
import { routingConfigLockPath } from "./routing-config-transaction.js";

export class AccountPlanAssignmentError extends Error {
	constructor(message: string) {
		super(`[account-plan-assignment] ${message}`);
		this.name = "AccountPlanAssignmentError";
	}
}

/**
 * A fixed, non-caller-controlled provenance string for an explicit
 * `--monthly-usd` override. `createAccountRateRecord` requires override
 * provenance whenever an override amount is supplied; this command never
 * accepts free-text provenance from the operator, so every override this
 * command produces carries exactly this string.
 */
export const OPERATOR_OVERRIDE_PROVENANCE =
	"operator-provided override via account set-plan";

export interface AccountPlanAssignmentInput {
	readonly accountId: string;
	readonly presetId: string;
	/** RFC 3339 instant with an explicit "Z" or numeric offset. */
	readonly effectiveFrom: string;
	readonly monthlyUsdOverride?: number;
}

export interface AccountPlanAssignmentPreview {
	readonly accountId: string;
	readonly provider: CatalogProvider;
	readonly accountType: CatalogAccountType;
	readonly presetId: string;
	readonly presetLabel: string;
	readonly monthlyUsd: number;
	readonly isOverride: boolean;
	readonly effectiveFrom: string;
	readonly catalogVersion: number;
}

/**
 * Resolves and validates one candidate assignment against a supplied config
 * and resolved catalog snapshot. Pure: performs no I/O and never guesses a
 * missing or malformed input. Throws {@link AccountPlanAssignmentError} naming
 * the rejected account id or preset id, or an `AccountRateHistoryError` (via
 * {@link assertValidEffectiveFrom}) for a malformed `effectiveFrom`.
 */
export function resolveAccountPlanAssignmentPreview(
	input: AccountPlanAssignmentInput,
	config: Pick<MultiAccountConfig, "accountLimit">,
	catalog: SubscriptionPlanCatalog,
): AccountPlanAssignmentPreview {
	if (!isCanonicalSubscriptionAccountId(input.accountId, config.accountLimit)) {
		throw new AccountPlanAssignmentError(
			`Unknown account "${input.accountId}". It is not a configured canonical account.`,
		);
	}
	const preset = findSubscriptionPlanPreset(catalog, input.presetId);
	if (preset === undefined) {
		throw new AccountPlanAssignmentError(
			`Unknown preset "${input.presetId}". No catalog preset matches that id.`,
		);
	}
	assertValidEffectiveFrom(input.effectiveFrom, "--effective-from");
	if (
		input.monthlyUsdOverride !== undefined &&
		(!Number.isFinite(input.monthlyUsdOverride) || input.monthlyUsdOverride < 0)
	) {
		throw new AccountPlanAssignmentError(
			"--monthly-usd must be a finite, non-negative USD amount.",
		);
	}
	const isOverride = input.monthlyUsdOverride !== undefined;
	return {
		accountId: input.accountId,
		provider: preset.provider,
		accountType: preset.accountType,
		presetId: preset.id,
		presetLabel: preset.label,
		monthlyUsd: isOverride ? (input.monthlyUsdOverride as number) : preset.monthlyUsd,
		isOverride,
		effectiveFrom: input.effectiveFrom,
		catalogVersion: catalog.version,
	};
}

/**
 * Builds the immutable candidate record for one resolved preset, copying only
 * the allowlisted fields `createAccountRateRecord` accepts. An explicit
 * override always carries the fixed {@link OPERATOR_OVERRIDE_PROVENANCE};
 * this function never accepts caller-supplied provenance text.
 */
export function buildAccountPlanAssignmentRecord(
	input: AccountPlanAssignmentInput,
	preset: SubscriptionPlanPreset,
	catalogVersion: number,
): AccountRateRecord {
	return createAccountRateRecord({
		accountId: input.accountId,
		preset,
		catalogVersion,
		effectiveFrom: input.effectiveFrom,
		...(input.monthlyUsdOverride !== undefined
			? {
					monthlyUsdOverride: input.monthlyUsdOverride,
					overrideProvenance: OPERATOR_OVERRIDE_PROVENANCE,
				}
			: {}),
	});
}

/**
 * Returns true when every term `preview` displayed to the operator for
 * confirmation is still present, byte-for-byte, in `freshPreview` -- the
 * preview re-resolved from the locked, current read immediately before the
 * atomic write. Compares every operator-confirmed term (account, provider,
 * account type, preset id and label, the copied or overridden monthly rate,
 * the effective instant, and catalog version), never merely `catalogVersion`
 * or object identity: {@link resolveSubscriptionPlanCatalog} keeps the
 * shipped catalog's `version` unchanged across a machine-global override
 * edit, so a `catalogVersion`-only check would miss exactly the price or
 * definition drift this function exists to catch, and a fresh preview is
 * always a newly built object, so reference identity never applies.
 */
function confirmedPreviewTermsStillMatch(
	preview: AccountPlanAssignmentPreview,
	freshPreview: AccountPlanAssignmentPreview,
): boolean {
	return (
		preview.accountId === freshPreview.accountId &&
		preview.provider === freshPreview.provider &&
		preview.accountType === freshPreview.accountType &&
		preview.presetId === freshPreview.presetId &&
		preview.presetLabel === freshPreview.presetLabel &&
		preview.monthlyUsd === freshPreview.monthlyUsd &&
		preview.isOverride === freshPreview.isOverride &&
		preview.effectiveFrom === freshPreview.effectiveFrom &&
		preview.catalogVersion === freshPreview.catalogVersion
	);
}

export type AccountPlanAssignmentCommitResult =
	| { readonly status: "applied"; readonly record: AccountRateRecord; readonly outcome: ConfigWriteOutcome }
	| { readonly status: "declined" }
	| { readonly status: "busy" };

export interface AccountPlanAssignmentTransactionOptions {
	readonly configPath: string;
	readonly lockPath?: string;
	readonly input: AccountPlanAssignmentInput;
	/** Called once with the resolved preview before {@link confirm} runs. */
	readonly onPreview: (preview: AccountPlanAssignmentPreview) => void;
	/** Never called while a machine lease is held. */
	readonly confirm: () => boolean | Promise<boolean>;
	readonly now?: () => number;
	readonly acquireLease?: (
		options: MachineLeaseOptions,
	) => MachineLeaseHandle | undefined;
	readonly readConfigImpl?: (configPath: string) => MultiAccountConfig;
	readonly writeConfigImpl?: (
		configPath: string,
		config: MultiAccountConfig,
		onCommitted?: () => void,
	) => ConfigWriteOutcome;
}

/**
 * Commits one account plan assignment.
 *
 * 1. Reads config unlocked, resolves and validates the preview, and hands it
 *    to `onPreview` -- no lease is held yet.
 * 2. Awaits `confirm()`. A decline returns `{status:"declined"}` and performs
 *    no further work: retained bytes are untouched.
 * 3. Acquires the machine lease guarding `config.json`. A held lease returns
 *    `{status:"busy"}` immediately; no write is attempted.
 * 4. Re-reads config under the lease and re-resolves the preview against that
 *    fresh snapshot, then compares every operator-confirmed term (account,
 *    provider, account type, preset id and label, the copied or overridden
 *    monthly rate, the effective instant, and catalog version) against that
 *    fresh preview. A stale preset id, removed account slot, or any catalog
 *    edit racing the dialog -- including a price or definition change the
 *    operator never saw -- is rejected here, before anything is written. No
 *    automatic re-prompt: the caller must rerun the command to see and
 *    confirm the fresh terms.
 * 5. Builds the candidate record, appends it to that account's existing
 *    history, and normalizes the result -- a duplicate or overlapping
 *    `effectiveFrom` throws `AccountRateHistoryError` and nothing is written.
 * 6. Verifies the fully-built candidate config parses back through
 *    `validateConfig` -- a structural self-check performed before the
 *    candidate ever reaches disk.
 * 7. Performs exactly one atomic write via `writeConfig`.
 *
 * Every step before (7) can throw or return without ever calling the write
 * implementation, so a failure at validation, confirmation, the lease, or this
 * pre-write verification always leaves the persisted bytes exactly as they
 * were.
 */
export async function commitAccountPlanAssignment(
	options: AccountPlanAssignmentTransactionOptions,
): Promise<AccountPlanAssignmentCommitResult> {
	const read = options.readConfigImpl ?? readConfig;
	const write = options.writeConfigImpl ?? writeConfig;
	const acquire = options.acquireLease ?? acquireMachineLease;
	const now = options.now ?? Date.now;
	const lockPath = options.lockPath ?? routingConfigLockPath(options.configPath);

	const promptConfig = read(options.configPath);
	const promptCatalog = loadEffectiveSubscriptionPlanCatalog(
		promptConfig.subscriptionPlanCatalogOverrides ?? {},
	);
	const preview = resolveAccountPlanAssignmentPreview(
		options.input,
		promptConfig,
		promptCatalog,
	);
	options.onPreview(preview);

	const confirmed = await options.confirm();
	if (!confirmed) return { status: "declined" };

	const handle = acquire({ lockPath, ttlMs: MACHINE_LEASE_TTL_MS, now });
	if (handle === undefined) return { status: "busy" };

	try {
		// Fresh, locked re-read and re-validation. This is the pre-write
		// verification step: the candidate is re-derived and re-checked against
		// the CURRENT catalog, account limit, and history immediately before the
		// single atomic write, so a stale preview -- or a concurrent edit that
		// landed between the preview and this confirmation -- can never reach
		// disk.
		const fresh = read(options.configPath);
		const freshCatalog = loadEffectiveSubscriptionPlanCatalog(
			fresh.subscriptionPlanCatalogOverrides ?? {},
		);
		const freshPreview = resolveAccountPlanAssignmentPreview(
			options.input,
			fresh,
			freshCatalog,
		);
		if (!confirmedPreviewTermsStillMatch(preview, freshPreview)) {
			// Fail closed: a term the operator confirmed (account, provider,
			// account type, preset, its label, the copied or overridden monthly
			// rate, the effective instant, or catalog version) no longer matches
			// the fresh, locked snapshot -- most commonly a machine-global
			// catalog override edit racing the confirmation dialog. Reject
			// outright with no write and no automatic re-prompt; the operator
			// reruns the command to see and confirm the current terms. This
			// never touches `fresh`, so any unrelated concurrent config edit it
			// already observed is preserved, not rolled back.
			throw new AccountPlanAssignmentError(
				`Confirmed terms for "${options.input.accountId}" changed before the write ` +
					`could be committed (e.g. a concurrent catalog edit). Nothing was ` +
					`written; rerun account set-plan to review and confirm the current ` +
					`terms.`,
			);
		}
		const preset = findSubscriptionPlanPreset(freshCatalog, freshPreview.presetId);
		if (preset === undefined) {
			// Unreachable except under a racing catalog edit between the two
			// lookups immediately above: resolveAccountPlanAssignmentPreview
			// already proved this preset id resolves in freshCatalog.
			throw new AccountPlanAssignmentError(
				`Preset "${options.input.presetId}" is no longer available.`,
			);
		}
		const record = buildAccountPlanAssignmentRecord(
			options.input,
			preset,
			freshCatalog.version,
		);
		const existingCandidates = (
			fresh.accountRateHistory?.[options.input.accountId] ?? []
		).map((existingRecord) => ({ record: existingRecord }));
		const normalized = normalizeAccountRateHistory([
			...existingCandidates,
			{ record },
		]);
		const candidate: MultiAccountConfig = {
			...fresh,
			accountRateHistory: {
				...fresh.accountRateHistory,
				[options.input.accountId]: normalized,
			},
		};
		// Structural self-check only -- no disk I/O -- performed before the
		// single atomic write is ever attempted.
		validateConfig(candidate);
		const outcome = write(options.configPath, candidate);
		return { status: "applied", record, outcome };
	} finally {
		handle.release();
	}
}
