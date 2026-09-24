/**
 * Closed derivation of the machine-global `unified` model declaration.
 *
 * Complete live physical models enter this pure boundary. Only named safe
 * capabilities leave it. The module touches no disk, credentials, or runtime
 * state, and every mutable descendant in a returned row is an independent copy.
 */
import { isDeepStrictEqual } from "node:util";
import type {
	AnthropicMessagesCompat,
	Api,
	Model,
	ModelCost,
	ModelCostTier,
	ModelThinkingLevel,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { GOOGLE_ANTIGRAVITY_API } from "./upstream-antigravity.js";

/** Provider id and custom API id. Both are exactly this string. */
export const LOGICAL_PROVIDER_ID = "unified";
/** Provider name rendered by Pi for the logical provider. */
export const LOGICAL_PROVIDER_DISPLAY_NAME = "unified";
/** Reserved placeholder host. The logical provider never dials it. */
export const DECLARATION_BASE_URL = "https://unused.invalid";
/** Fixed composition placeholder. This is not a credential. */
export const DECLARATION_PLACEHOLDER_KEY = "declaration-local-key";
/** Managed families in declaration order. */
export const DECLARED_FAMILIES = [
	"anthropic",
	"openai-codex",
	"google-antigravity",
] as const;

export type DeclaredFamily = (typeof DECLARED_FAMILIES)[number];

export type ModelDeclarationCatalogs = {
	readonly anthropic: readonly Model<"anthropic-messages">[];
	readonly "openai-codex": readonly Model<"openai-codex-responses">[];
	/** Optional until the composition root supplies a live Antigravity catalog. */
	readonly "google-antigravity"?: readonly Model<typeof GOOGLE_ANTIGRAVITY_API>[];
	readonly [family: string]: readonly Model<Api>[] | undefined;
};

type AnthropicLogicalCompat = Omit<
	AnthropicMessagesCompat,
	"allowedFallbackModels"
>;
type LogicalCompat = AnthropicLogicalCompat | OpenAIResponsesCompat;

export interface ModelDeclarationRow {
	id: string;
	name: string;
	api: typeof LOGICAL_PROVIDER_ID;
	baseUrl: typeof DECLARATION_BASE_URL;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Partial<Record<SamplingParamKey, number>>;
	compat?: LogicalCompat;
}

export interface BuiltDeclaration {
	models: ModelDeclarationRow[];
	diagnostics: string[];
}

export interface ModelDeclarationBuildOptions {
	/** Applied only after a Codex catalog row has passed closed projection. */
	readonly codexContextWindowByModelId?: ReadonlyMap<string, number>;
}

export type ManagedLogicalModelSource =
	| {
			readonly family: "anthropic";
			readonly model: Model<"anthropic-messages">;
	  }
	| {
			readonly family: "openai-codex";
			readonly model: Model<"openai-codex-responses">;
	  }
	| {
			readonly family: "google-antigravity";
			readonly model: Model<typeof GOOGLE_ANTIGRAVITY_API>;
	  };

const MODEL_FIELD_DISPOSITION = {
	id: "copy",
	name: "copy",
	api: "override",
	provider: "exclude",
	baseUrl: "override",
	reasoning: "copy",
	thinkingLevelMap: "copy",
	input: "copy",
	cost: "copy",
	contextWindow: "copy",
	maxTokens: "copy",
	samplingParams: "copy",
	headers: "exclude",
	compat: "copy",
} as const satisfies Record<
	keyof Model<Api>,
	"copy" | "exclude" | "override"
>;

const ANTHROPIC_COMPAT_DISPOSITION = {
	supportsEagerToolInputStreaming: "copy",
	supportsLongCacheRetention: "copy",
	sendSessionAffinityHeaders: "copy",
	supportsCacheControlOnTools: "copy",
	supportsTemperature: "copy",
	forceAdaptiveThinking: "copy",
	allowEmptySignature: "copy",
	supportsStrictTools: "copy",
	allowedFallbackModels: "exclude",
	supportsToolReferences: "copy",
} as const satisfies Record<
	keyof AnthropicMessagesCompat,
	"copy" | "exclude"
>;

const CODEX_COMPAT_DISPOSITION = {
	supportsDeveloperRole: "copy",
	sessionAffinityFormat: "copy",
	supportsLongCacheRetention: "copy",
	supportsStrictMode: "copy",
	supportsOpenAIGrammarTools: "copy",
	supportsAdditionalTools: "copy",
	supportsToolSearch: "copy",
	supportsExplicitPromptCacheMode: "copy",
} as const satisfies Record<keyof OpenAIResponsesCompat, "copy">;

const THINKING_LEVEL_DISPOSITION = {
	off: "copy",
	minimal: "copy",
	low: "copy",
	medium: "copy",
	high: "copy",
	xhigh: "copy",
	max: "copy",
} as const satisfies Record<ModelThinkingLevel, "copy">;

const COST_DISPOSITION = {
	input: "copy",
	output: "copy",
	cacheRead: "copy",
	cacheWrite: "copy",
	tiers: "copy",
} as const satisfies Record<keyof ModelCost, "copy">;

const COST_TIER_DISPOSITION = {
	input: "copy",
	output: "copy",
	cacheRead: "copy",
	cacheWrite: "copy",
	inputTokensAbove: "copy",
} as const satisfies Record<keyof ModelCostTier, "copy">;

const SAMPLING_PARAM_KEYS = [
	"top_p",
	"top_k",
	"min_p",
	"repetition_penalty",
] as const;
type SamplingParamKey = (typeof SAMPLING_PARAM_KEYS)[number];
const SAMPLING_PARAM_KEY_SET = new Set<string>(SAMPLING_PARAM_KEYS);
const SESSION_AFFINITY_FORMATS = new Set<string>([
	"openai",
	"openai-nosession",
	"openrouter",
]);
const MAX_AMBIGUITY_DIAGNOSTICS = 20;

export class ManagedModelProjectionError extends Error {
	readonly family: DeclaredFamily;
	readonly fieldPath: string;

	constructor(family: DeclaredFamily, fieldPath: string) {
		super(`The ${family} managed model has invalid capability data at ${fieldPath}.`);
		this.name = "ManagedModelProjectionError";
		this.family = family;
		this.fieldPath = fieldPath;
	}
}

function rejectProjection(
	family: DeclaredFamily,
	fieldPath: string,
): never {
	throw new ManagedModelProjectionError(family, fieldPath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype: unknown = (() => {
	try {
		return Object.getPrototypeOf(value);
	} catch {
		return undefined;
	}
	})();
	return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRequiredReasoning(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isOptionalCompatBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isRequiredFiniteCostRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRequiredFiniteTierMember(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteSamplingValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}


type CapturedOwnDataProperties = ReadonlyMap<string, PropertyDescriptor>;

function requiredCapturedValue(
	properties: CapturedOwnDataProperties,
	key: string,
	family: DeclaredFamily,
	fieldPath: string,
): unknown {
	const descriptor = properties.get(key);
	if (descriptor === undefined) return rejectProjection(family, fieldPath);
	return descriptor.value;
}

function optionalCapturedValue(
	properties: CapturedOwnDataProperties,
	key: string,
): unknown {
	return properties.get(key)?.value;
}

function projectRequiredString(
	value: unknown,
	family: DeclaredFamily,
	fieldPath: string,
): string {
	if (!isNonEmptyString(value)) return rejectProjection(family, fieldPath);
	return value;
}

function projectRequiredBoolean(
	value: unknown,
	family: DeclaredFamily,
	fieldPath: string,
): boolean {
	if (!isRequiredReasoning(value)) return rejectProjection(family, fieldPath);
	return value;
}

function exactCapturedKeys(
	properties: CapturedOwnDataProperties,
	allowed: ReadonlySet<string>,
	family: DeclaredFamily,
	fieldPath: string,
): void {
	for (const key of properties.keys()) {
		if (!allowed.has(key)) return rejectProjection(family, `${fieldPath}.${key}`);
	}
}

function optionalThinkingLevelValue(
	properties: CapturedOwnDataProperties,
	key: ModelThinkingLevel,
	family: DeclaredFamily,
): string | null | undefined {
	if (!properties.has(key)) return undefined;
	const member = requiredCapturedValue(properties, key, family, `thinkingLevelMap.${key}`);
	if (member !== null && typeof member !== "string") {
		return rejectProjection(family, `thinkingLevelMap.${key}`);
	}
	return member;
}

function projectThinkingLevelMap(
	value: unknown,
	family: DeclaredFamily,
): ThinkingLevelMap | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return rejectProjection(family, "thinkingLevelMap");
	const properties = assertOwnDataProperties(value, family, "thinkingLevelMap");
	exactCapturedKeys(
		properties,
		new Set(Object.keys(THINKING_LEVEL_DISPOSITION)),
		family,
		"thinkingLevelMap",
	);
	const projected: ThinkingLevelMap = {};
	const off = optionalThinkingLevelValue(properties, "off", family);
	if (off !== undefined) projected.off = off;
	const minimal = optionalThinkingLevelValue(properties, "minimal", family);
	if (minimal !== undefined) projected.minimal = minimal;
	const low = optionalThinkingLevelValue(properties, "low", family);
	if (low !== undefined) projected.low = low;
	const medium = optionalThinkingLevelValue(properties, "medium", family);
	if (medium !== undefined) projected.medium = medium;
	const high = optionalThinkingLevelValue(properties, "high", family);
	if (high !== undefined) projected.high = high;
	const xhigh = optionalThinkingLevelValue(properties, "xhigh", family);
	if (xhigh !== undefined) projected.xhigh = xhigh;
	const max = optionalThinkingLevelValue(properties, "max", family);
	if (max !== undefined) projected.max = max;
	return projected;
}

function capturedArrayLength(
	properties: CapturedOwnDataProperties,
	family: DeclaredFamily,
	fieldPath: string,
): number {
	const length = requiredCapturedValue(properties, "length", family, fieldPath);
	if (!Number.isSafeInteger(length) || typeof length !== "number" || length < 0) {
		return rejectProjection(family, fieldPath);
	}
	return length;
}

function projectInput(value: unknown, family: DeclaredFamily): ("text" | "image")[] {
	if (!Array.isArray(value)) return rejectProjection(family, "input");
	const properties = assertOwnDataProperties(value, family, "input");
	const length = capturedArrayLength(properties, family, "input");
	const projected: ("text" | "image")[] = [];
	for (let index = 0; index < length; index += 1) {
		const member = requiredCapturedValue(properties, String(index), family, "input");
		if (member !== "text" && member !== "image") {
			return rejectProjection(family, "input");
		}
		projected.push(member);
	}
	return projected;
}

function projectRequiredInput(
	properties: CapturedOwnDataProperties,
	family: DeclaredFamily,
): ("text" | "image")[] {
	return projectInput(requiredCapturedValue(properties, "input", family, "input"), family);
}

function projectCostTiers(
	value: unknown,
	family: DeclaredFamily,
): ModelCostTier[] {
	if (!Array.isArray(value)) return rejectProjection(family, "cost.tiers");
	const arrayProperties = assertOwnDataProperties(value, family, "cost.tiers");
	const length = capturedArrayLength(arrayProperties, family, "cost.tiers");
	const projected: ModelCostTier[] = [];
	for (let index = 0; index < length; index += 1) {
		const entry = requiredCapturedValue(
			arrayProperties,
			String(index),
			family,
			"cost.tiers",
		);
		if (!isPlainObject(entry)) return rejectProjection(family, "cost.tiers");
		const properties = assertOwnDataProperties(entry, family, "cost.tiers", [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"inputTokensAbove",
		]);
		exactCapturedKeys(
			properties,
			new Set(Object.keys(COST_TIER_DISPOSITION)),
			family,
			"cost.tiers",
		);
		const input = requiredCapturedValue(properties, "input", family, "cost.tiers.input");
		const output = requiredCapturedValue(properties, "output", family, "cost.tiers.output");
		const cacheRead = requiredCapturedValue(
			properties,
			"cacheRead",
			family,
			"cost.tiers.cacheRead",
		);
		const cacheWrite = requiredCapturedValue(
			properties,
			"cacheWrite",
			family,
			"cost.tiers.cacheWrite",
		);
		const inputTokensAbove = requiredCapturedValue(
			properties,
			"inputTokensAbove",
			family,
			"cost.tiers.inputTokensAbove",
		);
		if (!isRequiredFiniteTierMember(input)) {
			return rejectProjection(family, "cost.tiers.input");
		}
		if (!isRequiredFiniteTierMember(output)) {
			return rejectProjection(family, "cost.tiers.output");
		}
		if (!isRequiredFiniteTierMember(cacheRead)) {
			return rejectProjection(family, "cost.tiers.cacheRead");
		}
		if (!isRequiredFiniteTierMember(cacheWrite)) {
			return rejectProjection(family, "cost.tiers.cacheWrite");
		}
		if (!isRequiredFiniteTierMember(inputTokensAbove)) {
			return rejectProjection(family, "cost.tiers.inputTokensAbove");
		}
		projected.push({ input, output, cacheRead, cacheWrite, inputTokensAbove });
	}
	return projected;
}

function projectCost(value: unknown, family: DeclaredFamily): ModelCost {
	if (!isPlainObject(value)) return rejectProjection(family, "cost");
	const properties = assertOwnDataProperties(value, family, "cost", [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
	]);
	exactCapturedKeys(
		properties,
		new Set(Object.keys(COST_DISPOSITION)),
		family,
		"cost",
	);
	const input = requiredCapturedValue(properties, "input", family, "cost.input");
	const output = requiredCapturedValue(properties, "output", family, "cost.output");
	const cacheRead = requiredCapturedValue(properties, "cacheRead", family, "cost.cacheRead");
	const cacheWrite = requiredCapturedValue(
		properties,
		"cacheWrite",
		family,
		"cost.cacheWrite",
	);
	if (!isRequiredFiniteCostRate(input)) return rejectProjection(family, "cost.input");
	if (!isRequiredFiniteCostRate(output)) return rejectProjection(family, "cost.output");
	if (!isRequiredFiniteCostRate(cacheRead)) return rejectProjection(family, "cost.cacheRead");
	if (!isRequiredFiniteCostRate(cacheWrite)) return rejectProjection(family, "cost.cacheWrite");
	const projected: ModelCost = { input, output, cacheRead, cacheWrite };
	if (properties.has("tiers")) {
		const tiers = optionalCapturedValue(properties, "tiers");
		if (tiers !== undefined) projected.tiers = projectCostTiers(tiers, family);
	}
	return projected;
}

function projectRequiredCost(
	properties: CapturedOwnDataProperties,
	family: DeclaredFamily,
): ModelCost {
	return projectCost(requiredCapturedValue(properties, "cost", family, "cost"), family);
}

function projectPositiveLimit(
	value: unknown,
	family: DeclaredFamily,
	fieldPath: "contextWindow" | "maxTokens",
): number {
	if (!isPositiveFiniteLimit(value)) return rejectProjection(family, fieldPath);
	return value;
}

function projectSamplingParams(
	value: unknown,
	family: DeclaredFamily,
): Partial<Record<SamplingParamKey, number>> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return rejectProjection(family, "samplingParams");
	const properties = assertOwnDataProperties(value, family, "samplingParams");
	exactCapturedKeys(properties, SAMPLING_PARAM_KEY_SET, family, "samplingParams");
	const projected: Partial<Record<SamplingParamKey, number>> = {};
	for (const key of properties.keys()) {
		const member = requiredCapturedValue(properties, key, family, `samplingParams.${key}`);
		if (!isFiniteSamplingValue(member)) {
			return rejectProjection(family, `samplingParams.${key}`);
		}
		if (key === "top_p") projected.top_p = member;
		else if (key === "top_k") projected.top_k = member;
		else if (key === "min_p") projected.min_p = member;
		else if (key === "repetition_penalty") projected.repetition_penalty = member;
	}
	return projected;
}

function projectOptionalCompatBoolean(
	value: unknown,
	family: DeclaredFamily,
	fieldPath: string,
): boolean {
	if (!isOptionalCompatBoolean(value)) return rejectProjection(family, fieldPath);
	return value;
}

function optionalCompatBoolean(
	properties: CapturedOwnDataProperties,
	key: string,
	family: DeclaredFamily,
): boolean | undefined {
	if (!properties.has(key)) return undefined;
	return projectOptionalCompatBoolean(
		requiredCapturedValue(properties, key, family, `compat.${key}`),
		family,
		`compat.${key}`,
	);
}

function projectAnthropicCompat(
	properties: CapturedOwnDataProperties,
): AnthropicLogicalCompat {
	const projected: AnthropicLogicalCompat = {};
	const eager = optionalCompatBoolean(properties, "supportsEagerToolInputStreaming", "anthropic");
	if (eager !== undefined) projected.supportsEagerToolInputStreaming = eager;
	const longCache = optionalCompatBoolean(properties, "supportsLongCacheRetention", "anthropic");
	if (longCache !== undefined) projected.supportsLongCacheRetention = longCache;
	const affinity = optionalCompatBoolean(properties, "sendSessionAffinityHeaders", "anthropic");
	if (affinity !== undefined) projected.sendSessionAffinityHeaders = affinity;
	const toolCache = optionalCompatBoolean(properties, "supportsCacheControlOnTools", "anthropic");
	if (toolCache !== undefined) projected.supportsCacheControlOnTools = toolCache;
	const temperature = optionalCompatBoolean(properties, "supportsTemperature", "anthropic");
	if (temperature !== undefined) projected.supportsTemperature = temperature;
	const adaptive = optionalCompatBoolean(properties, "forceAdaptiveThinking", "anthropic");
	if (adaptive !== undefined) projected.forceAdaptiveThinking = adaptive;
	const emptySignature = optionalCompatBoolean(properties, "allowEmptySignature", "anthropic");
	if (emptySignature !== undefined) projected.allowEmptySignature = emptySignature;
	const strictTools = optionalCompatBoolean(properties, "supportsStrictTools", "anthropic");
	if (strictTools !== undefined) projected.supportsStrictTools = strictTools;
	const toolReferences = optionalCompatBoolean(properties, "supportsToolReferences", "anthropic");
	if (toolReferences !== undefined) projected.supportsToolReferences = toolReferences;
	return projected;
}

function isSessionAffinityFormat(
	value: unknown,
): value is NonNullable<OpenAIResponsesCompat["sessionAffinityFormat"]> {
	return typeof value === "string" && SESSION_AFFINITY_FORMATS.has(value);
}

function projectCodexCompat(
	properties: CapturedOwnDataProperties,
): OpenAIResponsesCompat {
	const projected: OpenAIResponsesCompat = {};
	const developerRole = optionalCompatBoolean(properties, "supportsDeveloperRole", "openai-codex");
	if (developerRole !== undefined) projected.supportsDeveloperRole = developerRole;
	if (properties.has("sessionAffinityFormat")) {
		const affinity = requiredCapturedValue(
			properties,
			"sessionAffinityFormat",
			"openai-codex",
			"compat.sessionAffinityFormat",
		);
		if (!isSessionAffinityFormat(affinity)) {
			return rejectProjection("openai-codex", "compat.sessionAffinityFormat");
		}
		projected.sessionAffinityFormat = affinity;
	}
	const longCache = optionalCompatBoolean(properties, "supportsLongCacheRetention", "openai-codex");
	if (longCache !== undefined) projected.supportsLongCacheRetention = longCache;
	const strictMode = optionalCompatBoolean(properties, "supportsStrictMode", "openai-codex");
	if (strictMode !== undefined) projected.supportsStrictMode = strictMode;
	const grammarTools = optionalCompatBoolean(properties, "supportsOpenAIGrammarTools", "openai-codex");
	if (grammarTools !== undefined) projected.supportsOpenAIGrammarTools = grammarTools;
	const additionalTools = optionalCompatBoolean(properties, "supportsAdditionalTools", "openai-codex");
	if (additionalTools !== undefined) projected.supportsAdditionalTools = additionalTools;
	const toolSearch = optionalCompatBoolean(properties, "supportsToolSearch", "openai-codex");
	if (toolSearch !== undefined) projected.supportsToolSearch = toolSearch;
	const promptCache = optionalCompatBoolean(
		properties,
		"supportsExplicitPromptCacheMode",
		"openai-codex",
	);
	if (promptCache !== undefined) projected.supportsExplicitPromptCacheMode = promptCache;
	return projected;
}

function captureCompatProperties(
	value: unknown,
	family: DeclaredFamily,
): CapturedOwnDataProperties | undefined {
	if (value === undefined) return undefined;
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		return rejectProjection(family, "compat");
	}
	if (!isPlainObject(value)) return rejectProjection(family, "compat");
	return assertOwnDataProperties(value, family, "compat");
}

function projectCapturedCompat(
	properties: CapturedOwnDataProperties | undefined,
	family: DeclaredFamily,
): ModelDeclarationRow["compat"] {
	if (properties === undefined) return undefined;
	// Antigravity models carry no compat overrides; `Model<typeof
	// GOOGLE_ANTIGRAVITY_API>["compat"]` types the field `never`, so any presence
	// here is a foreign shape that must fail closed rather than being silently
	// treated as an Anthropic or Codex override.
	if (family === "google-antigravity") return rejectProjection(family, "compat");
	return family === "anthropic"
		? projectAnthropicCompat(properties)
		: projectCodexCompat(properties);
}

function projectCompat(
	value: unknown,
	family: DeclaredFamily,
): ModelDeclarationRow["compat"] {
	return projectCapturedCompat(captureCompatProperties(value, family), family);
}

function sourceRecord(
	model: unknown,
	family: DeclaredFamily,
): CapturedOwnDataProperties {
	if (!isPlainObject(model)) return rejectProjection(family, "model");
	return assertOwnDataProperties(model, family, "model", [
		"id",
		"name",
		"api",
		"provider",
		"baseUrl",
		"reasoning",
		"input",
		"cost",
		"contextWindow",
		"maxTokens",
	]);
}

/** Project one complete managed physical model into one closed logical row. */
export function projectManagedLogicalModel(
	source: ManagedLogicalModelSource,
): ModelDeclarationRow {
	const sourceProperties = assertOwnDataProperties(source, "anthropic", "source", [
		"family",
		"model",
	]);
	const familyValue = requiredCapturedValue(
		sourceProperties,
		"family",
		"anthropic",
		"family",
	);
	if (
		familyValue !== "anthropic" &&
		familyValue !== "openai-codex" &&
		familyValue !== "google-antigravity"
	) {
		return rejectProjection("anthropic", "family");
	}
	const family = familyValue;
	const model = requiredCapturedValue(sourceProperties, "model", family, "model");
	const raw = sourceRecord(model, family);
	const api = requiredCapturedValue(raw, "api", family, "api");
	if (
		(family === "anthropic" && api !== "anthropic-messages") ||
		(family === "openai-codex" && api !== "openai-codex-responses") ||
		(family === "google-antigravity" && api !== GOOGLE_ANTIGRAVITY_API)
	) {
		return rejectProjection(family, "api");
	}
	const projected: Partial<ModelDeclarationRow> = {};
	projected.id = projectRequiredString(
		requiredCapturedValue(raw, "id", family, "id"),
		family,
		"id",
	);
	projected.name = projectRequiredString(
		requiredCapturedValue(raw, "name", family, "name"),
		family,
		"name",
	);
	projected.reasoning = projectRequiredBoolean(
		requiredCapturedValue(raw, "reasoning", family, "reasoning"),
		family,
		"reasoning",
	);
	const thinkingLevelMap = projectThinkingLevelMap(
		optionalCapturedValue(raw, "thinkingLevelMap"),
		family,
	);
	if (thinkingLevelMap !== undefined) projected.thinkingLevelMap = thinkingLevelMap;
	projected.input = projectRequiredInput(raw, family);
	projected.cost = projectRequiredCost(raw, family);
	projected.contextWindow = projectPositiveLimit(
		requiredCapturedValue(raw, "contextWindow", family, "contextWindow"),
		family,
		"contextWindow",
	);
	projected.maxTokens = projectPositiveLimit(
		requiredCapturedValue(raw, "maxTokens", family, "maxTokens"),
		family,
		"maxTokens",
	);
	const samplingParams = projectSamplingParams(
		optionalCapturedValue(raw, "samplingParams"),
		family,
	);
	if (samplingParams !== undefined) projected.samplingParams = samplingParams;
	const compat = projectCompat(optionalCapturedValue(raw, "compat"), family);
	if (compat !== undefined) projected.compat = compat;
	projected.api = LOGICAL_PROVIDER_ID;
	projected.baseUrl = DECLARATION_BASE_URL;
	return assertProjectedManagedModel(projected, family);
}

const PROJECTED_ROW_KEYS = new Set([
	"id",
	"name",
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"samplingParams",
	"compat",
]);
const ANTHROPIC_ONLY_COMPAT_KEYS = new Set(
	Object.keys(ANTHROPIC_COMPAT_DISPOSITION).filter(
		(key) =>
			key !== "allowedFallbackModels" &&
			!Object.hasOwn(CODEX_COMPAT_DISPOSITION, key),
	),
);
const CODEX_ONLY_COMPAT_KEYS = new Set(
	Object.keys(CODEX_COMPAT_DISPOSITION).filter(
		(key) => !Object.hasOwn(ANTHROPIC_COMPAT_DISPOSITION, key),
	),
);

function inferProjectedFamily(
	compat: CapturedOwnDataProperties | undefined,
): DeclaredFamily {
	if (compat === undefined) return "anthropic";
	let anthropic = false;
	let codex = false;
	for (const key of compat.keys()) {
		if (ANTHROPIC_ONLY_COMPAT_KEYS.has(key)) anthropic = true;
		if (CODEX_ONLY_COMPAT_KEYS.has(key)) codex = true;
	}
	if (anthropic && codex) return rejectProjection("anthropic", "compat");
	return codex ? "openai-codex" : "anthropic";
}

function isCanonicalArrayIndex(key: string): boolean {
	const index = Number(key);
	return (
		Number.isInteger(index) &&
		index >= 0 &&
		index < 2 ** 32 - 1 &&
		String(index) === key
	);
}

function isOrdinaryRetainedDataProperty(
	container: object,
	key: string | symbol,
	descriptor: PropertyDescriptor,
): boolean {
	if (typeof key !== "string") return false;
	if (!Array.isArray(container)) return descriptor.enumerable === true;
	if (key === "length") return descriptor.enumerable === false;
	return descriptor.enumerable === true && isCanonicalArrayIndex(key);
}

function assertOwnDataProperties(
	value: object,
	family: DeclaredFamily,
	fieldPath: string,
	requiredKeys: readonly string[] = [],
): CapturedOwnDataProperties {
	let keys: (string | symbol)[];
	try {
		keys = Reflect.ownKeys(value);
	} catch {
		return rejectProjection(family, fieldPath);
	}
	const properties = new Map<string, PropertyDescriptor>();
	for (const key of keys) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		} catch {
			return rejectProjection(family, fieldPath);
		}
		if (
			typeof key !== "string" ||
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			!isOrdinaryRetainedDataProperty(value, key, descriptor)
		) {
			return rejectProjection(family, fieldPath);
		}
		properties.set(key, descriptor);
	}
	for (const key of requiredKeys) {
		if (!properties.has(key)) return rejectProjection(family, `${fieldPath}.${key}`);
	}
	return properties;
}

function compatAllowedKeys(family: DeclaredFamily): ReadonlySet<string> {
	switch (family) {
		case "anthropic":
			return new Set(Object.keys(ANTHROPIC_COMPAT_DISPOSITION));
		case "openai-codex":
			return new Set(Object.keys(CODEX_COMPAT_DISPOSITION));
		case "google-antigravity":
			return new Set();
	}
}

function validateProjectedManagedModel(
	value: unknown,
	familyHint?: DeclaredFamily,
): asserts value is ModelDeclarationRow {
	const errorFamily = familyHint ?? "anthropic";
	if (!isPlainObject(value)) return rejectProjection(errorFamily, "model");
	const properties = assertOwnDataProperties(value, errorFamily, "model", [
		"id",
		"name",
		"api",
		"baseUrl",
		"reasoning",
		"input",
		"cost",
		"contextWindow",
		"maxTokens",
	]);
	const compat = captureCompatProperties(optionalCapturedValue(properties, "compat"), errorFamily);
	const family = familyHint ?? inferProjectedFamily(compat);
	if (compat !== undefined) {
		exactCapturedKeys(compat, compatAllowedKeys(family), family, "compat");
	}
	exactCapturedKeys(properties, PROJECTED_ROW_KEYS, family, "model");
	projectRequiredString(requiredCapturedValue(properties, "id", family, "id"), family, "id");
	projectRequiredString(
		requiredCapturedValue(properties, "name", family, "name"),
		family,
		"name",
	);
	projectRequiredBoolean(
		requiredCapturedValue(properties, "reasoning", family, "reasoning"),
		family,
		"reasoning",
	);
	projectThinkingLevelMap(optionalCapturedValue(properties, "thinkingLevelMap"), family);
	projectRequiredInput(properties, family);
	projectRequiredCost(properties, family);
	projectPositiveLimit(
		requiredCapturedValue(properties, "contextWindow", family, "contextWindow"),
		family,
		"contextWindow",
	);
	projectPositiveLimit(
		requiredCapturedValue(properties, "maxTokens", family, "maxTokens"),
		family,
		"maxTokens",
	);
	projectSamplingParams(optionalCapturedValue(properties, "samplingParams"), family);
	if (compat?.has("allowedFallbackModels")) {
		return rejectProjection(family, "compat.allowedFallbackModels");
	}
	projectCapturedCompat(compat, family);
	if (requiredCapturedValue(properties, "api", family, "api") !== LOGICAL_PROVIDER_ID) {
		return rejectProjection(family, "api");
	}
	if (
		requiredCapturedValue(properties, "baseUrl", family, "baseUrl") !==
		DECLARATION_BASE_URL
	) {
		return rejectProjection(family, "baseUrl");
	}
}

/** Validate one projected row in place and return the same object. */
export function assertProjectedManagedModel(
	value: unknown,
	familyHint?: DeclaredFamily,
): ModelDeclarationRow {
	validateProjectedManagedModel(value, familyHint);
	return value;
}

function freezeIfObject(value: unknown): void {
	if (typeof value === "object" && value !== null) Object.freeze(value);
}

function freezeProjectedManagedModel(row: ModelDeclarationRow): void {
	const properties = assertOwnDataProperties(row, "anthropic", "model");
	freezeIfObject(optionalCapturedValue(properties, "thinkingLevelMap"));
	freezeIfObject(requiredCapturedValue(properties, "input", "anthropic", "input"));
	const cost = requiredCapturedValue(properties, "cost", "anthropic", "cost");
	if (!isPlainObject(cost)) return rejectProjection("anthropic", "cost");
	const costProperties = assertOwnDataProperties(cost, "anthropic", "cost");
	const tiers = optionalCapturedValue(costProperties, "tiers");
	if (tiers !== undefined) {
		if (!Array.isArray(tiers)) return rejectProjection("anthropic", "cost.tiers");
		const tierProperties = assertOwnDataProperties(tiers, "anthropic", "cost.tiers");
		const length = capturedArrayLength(tierProperties, "anthropic", "cost.tiers");
		for (let index = 0; index < length; index += 1) {
			freezeIfObject(
				requiredCapturedValue(
					tierProperties,
					String(index),
					"anthropic",
					"cost.tiers",
				),
			);
		}
		Object.freeze(tiers);
	}
	Object.freeze(cost);
	freezeIfObject(optionalCapturedValue(properties, "samplingParams"));
	freezeIfObject(optionalCapturedValue(properties, "compat"));
	Object.freeze(row);
}

function validateProjectedManagedModels(
	projectedModels: unknown[],
): asserts projectedModels is ModelDeclarationRow[] {
	const properties = assertOwnDataProperties(projectedModels, "anthropic", "models");
	const length = capturedArrayLength(properties, "anthropic", "models");
	for (let index = 0; index < length; index += 1) {
		const row = requiredCapturedValue(properties, String(index), "anthropic", "models");
		validateProjectedManagedModel(row);
		freezeProjectedManagedModel(row);
	}
}

/** Validate and deeply freeze projected registration input in place. */
export function assertProjectedManagedModels(
	projectedModels: unknown[],
): ModelDeclarationRow[] {
	validateProjectedManagedModels(projectedModels);
	Object.freeze(projectedModels);
	return projectedModels;
}

function isDeclaredFamily(value: string): value is DeclaredFamily {
	return (DECLARED_FAMILIES as readonly string[]).includes(value);
}

function applyProjectedCodexContextWindow(
	row: ModelDeclarationRow,
	options: ModelDeclarationBuildOptions,
): ModelDeclarationRow {
	const contextWindow = options.codexContextWindowByModelId?.get(row.id);
	if (contextWindow === undefined) return row;
	row.contextWindow = projectPositiveLimit(
		contextWindow,
		"openai-codex",
		"contextWindow",
	);
	return row;
}

/** Build ordered, unambiguous rows from complete family-keyed live catalogs. */
export function buildModelDeclaration(
	catalogs: ModelDeclarationCatalogs,
	options: ModelDeclarationBuildOptions = {},
): BuiltDeclaration {
	const projectedByFamily = new Map<DeclaredFamily, ModelDeclarationRow[]>();
	for (const family of DECLARED_FAMILIES) {
		const rows: ModelDeclarationRow[] = [];
		if (family === "anthropic") {
			for (const model of catalogs.anthropic) {
				rows.push(projectManagedLogicalModel({ family, model }));
			}
		} else if (family === "openai-codex") {
			for (const model of catalogs["openai-codex"]) {
				const projected = projectManagedLogicalModel({ family, model });
				rows.push(applyProjectedCodexContextWindow(projected, options));
			}
		} else {
			for (const model of catalogs["google-antigravity"] ?? []) {
				rows.push(projectManagedLogicalModel({ family, model }));
			}
		}
		projectedByFamily.set(family, rows);
	}

	const owners = new Map<string, Set<DeclaredFamily>>();
	for (const family of DECLARED_FAMILIES) {
		for (const row of projectedByFamily.get(family) ?? []) {
			const existing = owners.get(row.id);
			if (existing === undefined) owners.set(row.id, new Set([family]));
			else existing.add(family);
		}
	}

	const models: ModelDeclarationRow[] = [];
	const emitted = new Set<string>();
	for (const family of DECLARED_FAMILIES) {
		for (const row of projectedByFamily.get(family) ?? []) {
			if (emitted.has(row.id)) continue;
			const owningFamilies = owners.get(row.id);
			if (owningFamilies === undefined || owningFamilies.size !== 1) continue;
			emitted.add(row.id);
			models.push(row);
		}
	}

	const ambiguous = [...owners]
		.filter(([, families]) => families.size > 1)
		.map(([id]) => id)
		.sort();
	const diagnostics = ambiguous
		.slice(0, MAX_AMBIGUITY_DIAGNOSTICS)
		.map(
			(id) =>
				`omitted ambiguous model id ${id}: served by more than one managed family, so no family can be chosen for it`,
		);
	const overflow = ambiguous.length - MAX_AMBIGUITY_DIAGNOSTICS;
	if (overflow > 0) {
		diagnostics.push(
			`omitted ${overflow} further ambiguous model ids beyond the first ${MAX_AMBIGUITY_DIAGNOSTICS}`,
		);
	}
	for (const key of Object.keys(catalogs)) {
		if (!isDeclaredFamily(key)) {
			diagnostics.push(`ignored unknown catalog family ${key}`);
		}
	}
	return { models, diagnostics };
}

export type InstalledDeclarationStatus =
	| "absent"
	| "unreadable"
	| "mismatched"
	| "matched";

/** Compare complete validated managed rows in their declared order. */
export function inspectInstalledDeclaration(
	parsed: unknown,
	expectedModels: readonly ModelDeclarationRow[],
): InstalledDeclarationStatus {
	if (!isPlainObject(parsed)) return "unreadable";
	const providers = parsed.providers;
	if (providers === undefined) return "absent";
	if (!isPlainObject(providers)) return "unreadable";
	const declaration = providers[LOGICAL_PROVIDER_ID];
	if (declaration === undefined) return "absent";
	if (!isPlainObject(declaration)) return "unreadable";
	if (
		declaration.api !== LOGICAL_PROVIDER_ID ||
		declaration.baseUrl !== DECLARATION_BASE_URL ||
		declaration.name !== LOGICAL_PROVIDER_DISPLAY_NAME ||
		typeof declaration.apiKey !== "string" ||
		declaration.apiKey === "" ||
		!Array.isArray(declaration.models)
	) {
		return "mismatched";
	}
	try {
		for (const row of expectedModels) assertProjectedManagedModel(row);
		for (const row of declaration.models) assertProjectedManagedModel(row);
	} catch {
		return "mismatched";
	}
	return isDeepStrictEqual(declaration.models, expectedModels)
		? "matched"
		: "mismatched";
}
