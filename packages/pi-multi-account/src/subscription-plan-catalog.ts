/**
 * Editable, versioned subscription-plan preset catalog.
 *
 * The catalog ships as JSON data at `config/subscription-plans.v1.json` so an
 * operator can inspect and edit it without reading TypeScript. This module
 * only validates and merges that data; it never encodes provider, account
 * type, or price information as a TypeScript constant, switch statement, or
 * map.
 *
 * Every shipped preset is an operator-provided monthly-equivalent USD
 * comparison default, not a researched provider entitlement or independently
 * verified official price. A label containing "5x" or "20x" is display text
 * only -- this module derives no token allowance, quota multiplier,
 * throughput, or availability claim from it, and reads no provider quota
 * source.
 *
 * Machine-global configuration (`src/config.ts`) may supply
 * `subscriptionPlanCatalogOverrides`, keyed by preset id: a key that matches a
 * shipped id replaces that preset; any other key adds a validated custom
 * preset. `src/config.ts` documents "No project-local override loading." --
 * there is no project-scoped catalog layer, and this module never reads one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_PROVIDERS = ["chatgpt", "anthropic"] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

export const CATALOG_ACCOUNT_TYPES = ["individual", "business", "team"] as const;
export type CatalogAccountType = (typeof CATALOG_ACCOUNT_TYPES)[number];

export const CATALOG_PRODUCT_BASES = ["per-account"] as const;
export type CatalogProductBasis = (typeof CATALOG_PRODUCT_BASES)[number];

export const MAX_PRESET_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 64;
const MAX_PROVENANCE_LENGTH = 256;

/** Lowercase, hyphen-separated identifier shape shared by every preset id. */
export const PRESET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SubscriptionPlanPreset {
	readonly id: string;
	readonly provider: CatalogProvider;
	readonly accountType: CatalogAccountType;
	readonly label: string;
	readonly monthlyUsd: number;
	readonly productBasis: CatalogProductBasis;
	readonly provenance: string;
}

export interface SubscriptionPlanCatalog {
	readonly version: number;
	readonly presets: readonly SubscriptionPlanPreset[];
}

/** Machine-global override entry: a preset's fields, keyed externally by id. */
export type SubscriptionPlanCatalogOverride = Omit<SubscriptionPlanPreset, "id">;

export class SubscriptionPlanCatalogError extends Error {
	constructor(message: string) {
		super(`[subscription-plan-catalog] ${message}`);
		this.name = "SubscriptionPlanCatalogError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogProvider(value: unknown): value is CatalogProvider {
	return (
		typeof value === "string" &&
		(CATALOG_PROVIDERS as readonly string[]).includes(value)
	);
}

function isCatalogAccountType(value: unknown): value is CatalogAccountType {
	return (
		typeof value === "string" &&
		(CATALOG_ACCOUNT_TYPES as readonly string[]).includes(value)
	);
}

function isCatalogProductBasis(value: unknown): value is CatalogProductBasis {
	return (
		typeof value === "string" &&
		(CATALOG_PRODUCT_BASES as readonly string[]).includes(value)
	);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= maxLength
	);
}

function validateProvider(value: unknown, context: string): CatalogProvider {
	if (!isCatalogProvider(value)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.provider must be one of [${CATALOG_PROVIDERS.join(", ")}].`,
		);
	}
	return value;
}

function validateAccountType(value: unknown, context: string): CatalogAccountType {
	if (!isCatalogAccountType(value)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.accountType must be one of [${CATALOG_ACCOUNT_TYPES.join(", ")}].`,
		);
	}
	return value;
}

function validateLabel(value: unknown, context: string): string {
	if (!isBoundedString(value, MAX_LABEL_LENGTH)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters.`,
		);
	}
	return value;
}

function validateMonthlyUsd(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new SubscriptionPlanCatalogError(
			`${context}.monthlyUsd must be a finite, non-negative USD amount.`,
		);
	}
	return value;
}

function validateProductBasis(value: unknown, context: string): CatalogProductBasis {
	if (!isCatalogProductBasis(value)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.productBasis must be one of [${CATALOG_PRODUCT_BASES.join(", ")}].`,
		);
	}
	return value;
}

function validateProvenance(value: unknown, context: string): string {
	if (!isBoundedString(value, MAX_PROVENANCE_LENGTH)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.provenance must be a non-empty string of at most ${MAX_PROVENANCE_LENGTH} characters.`,
		);
	}
	return value;
}

const PRESET_FIELDS = new Set([
	"id",
	"provider",
	"accountType",
	"label",
	"monthlyUsd",
	"productBasis",
	"provenance",
]);

/**
 * Validates one candidate preset object. Allowlists exactly the fields above
 * and rejects any other field -- including an entitlement-, quota-, or
 * verification-timestamp-shaped one -- before it can enter the effective
 * catalog. An explicit `monthlyUsd: 0` is valid.
 */
export function parseSubscriptionPlanPreset(
	value: unknown,
	context: string,
): SubscriptionPlanPreset {
	if (!isRecord(value)) {
		throw new SubscriptionPlanCatalogError(`${context} must be a JSON object.`);
	}
	const unknownKeys = Object.keys(value).filter((key) => !PRESET_FIELDS.has(key));
	if (unknownKeys.length > 0) {
		throw new SubscriptionPlanCatalogError(
			`${context} has unsupported field "${unknownKeys[0]}".`,
		);
	}
	const id = value["id"];
	if (!isBoundedString(id, MAX_PRESET_ID_LENGTH) || !PRESET_ID_PATTERN.test(id)) {
		throw new SubscriptionPlanCatalogError(
			`${context}.id must be a lowercase, hyphen-separated identifier of at most ${MAX_PRESET_ID_LENGTH} characters.`,
		);
	}
	return {
		id,
		provider: validateProvider(value["provider"], context),
		accountType: validateAccountType(value["accountType"], context),
		label: validateLabel(value["label"], context),
		monthlyUsd: validateMonthlyUsd(value["monthlyUsd"], context),
		productBasis: validateProductBasis(value["productBasis"], context),
		provenance: validateProvenance(value["provenance"], context),
	};
}

const OVERRIDE_FIELDS = new Set([
	"provider",
	"accountType",
	"label",
	"monthlyUsd",
	"productBasis",
	"provenance",
]);

/**
 * Validates one machine-global override object. The preset id is the map key
 * in `subscriptionPlanCatalogOverrides`, not a field on this object, so `id`
 * is rejected here as an unsupported field.
 */
export function parseSubscriptionPlanCatalogOverride(
	value: unknown,
	context: string,
): SubscriptionPlanCatalogOverride {
	if (!isRecord(value)) {
		throw new SubscriptionPlanCatalogError(`${context} must be a JSON object.`);
	}
	const unknownKeys = Object.keys(value).filter((key) => !OVERRIDE_FIELDS.has(key));
	if (unknownKeys.length > 0) {
		throw new SubscriptionPlanCatalogError(
			`${context} has unsupported field "${unknownKeys[0]}".`,
		);
	}
	return {
		provider: validateProvider(value["provider"], context),
		accountType: validateAccountType(value["accountType"], context),
		label: validateLabel(value["label"], context),
		monthlyUsd: validateMonthlyUsd(value["monthlyUsd"], context),
		productBasis: validateProductBasis(value["productBasis"], context),
		provenance: validateProvenance(value["provenance"], context),
	};
}

/**
 * Parses one complete catalog document: a positive integer `version` and an
 * array of presets with distinct ids. Used for both the shipped asset and any
 * test fixture that exercises catalog-shape validation.
 */
export function parseSubscriptionPlanCatalog(value: unknown): SubscriptionPlanCatalog {
	if (!isRecord(value)) {
		throw new SubscriptionPlanCatalogError("Catalog must be a JSON object.");
	}
	const unknownKeys = Object.keys(value).filter(
		(key) => key !== "version" && key !== "presets",
	);
	if (unknownKeys.length > 0) {
		throw new SubscriptionPlanCatalogError(
			`Catalog has unsupported field "${unknownKeys[0]}".`,
		);
	}
	const version = value["version"];
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new SubscriptionPlanCatalogError(
			"Catalog version must be a positive integer.",
		);
	}
	const presetsValue = value["presets"];
	if (!Array.isArray(presetsValue)) {
		throw new SubscriptionPlanCatalogError("Catalog presets must be an array.");
	}
	const presets: SubscriptionPlanPreset[] = [];
	const seenIds = new Set<string>();
	presetsValue.forEach((candidate, index) => {
		const preset = parseSubscriptionPlanPreset(candidate, `presets[${index}]`);
		if (seenIds.has(preset.id)) {
			throw new SubscriptionPlanCatalogError(
				`Catalog contains duplicate preset id "${preset.id}".`,
			);
		}
		seenIds.add(preset.id);
		presets.push(preset);
	});
	return { version, presets: Object.freeze(presets) };
}

const SHIPPED_CATALOG_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"config",
	"subscription-plans.v1.json",
);

/**
 * Loads and validates the shipped catalog asset directly from disk on every
 * call. Read-only: never copies, caches to another location, or writes
 * anything, including on first run.
 */
export function loadShippedSubscriptionPlanCatalog(): SubscriptionPlanCatalog {
	const raw = readFileSync(SHIPPED_CATALOG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SubscriptionPlanCatalogError(
			`Shipped catalog at ${SHIPPED_CATALOG_PATH} is not valid JSON.`,
		);
	}
	return parseSubscriptionPlanCatalog(parsed);
}

/**
 * Merges machine-global overrides into a base catalog. An override id that
 * matches an existing preset id replaces that preset in place; any other
 * override id appends a validated custom preset. The merged catalog keeps the
 * base catalog's `version` -- overrides change presets, not the shipped
 * asset's data version.
 */
export function resolveSubscriptionPlanCatalog(
	base: SubscriptionPlanCatalog,
	overrides: Readonly<Record<string, SubscriptionPlanCatalogOverride>>,
): SubscriptionPlanCatalog {
	const byId = new Map<string, SubscriptionPlanPreset>();
	for (const preset of base.presets) {
		byId.set(preset.id, preset);
	}
	for (const [id, override] of Object.entries(overrides)) {
		byId.set(id, { id, ...override });
	}
	return {
		version: base.version,
		presets: Object.freeze([...byId.values()]),
	};
}

/** Loads the shipped catalog and applies machine-global overrides in one call. */
export function loadEffectiveSubscriptionPlanCatalog(
	overrides: Readonly<Record<string, SubscriptionPlanCatalogOverride>>,
): SubscriptionPlanCatalog {
	return resolveSubscriptionPlanCatalog(
		loadShippedSubscriptionPlanCatalog(),
		overrides,
	);
}

/** Finds a preset by id in an already-resolved catalog, or `undefined`. */
export function findSubscriptionPlanPreset(
	catalog: SubscriptionPlanCatalog,
	presetId: string,
): SubscriptionPlanPreset | undefined {
	return catalog.presets.find((preset) => preset.id === presetId);
}
