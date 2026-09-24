import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	buildModelDeclaration,
	type BuiltDeclaration,
	type ModelDeclarationCatalogs,
} from "./models-declaration.js";

/** Operator-approved context-window default for the bounded live Codex allowlist. */
export const CODEX_CONTEXT_WINDOW = 1_050_000;

export const CODEX_LONG_CONTEXT_MODEL_IDS = [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
] as const;

const CODEX_CONTEXT_WINDOW_BY_MODEL_ID: ReadonlyMap<string, number> = new Map(
	CODEX_LONG_CONTEXT_MODEL_IDS.map(
		(modelId) => [modelId, CODEX_CONTEXT_WINDOW] as const,
	),
);

const CODEX_MODEL_DOCUMENTATION_BASE_URL =
	"https://developers.openai.com/api/docs/models/";
const CODEX_MODEL_DOCUMENTATION_MAX_CANDIDATES = 8;
const CODEX_MODEL_DOCUMENTATION_MAX_BYTES = 64 * 1024;
const CODEX_MODEL_DOCUMENTATION_TIMEOUT_MS = 2_500;
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const CODEX_MODEL_ID_MAX_LENGTH = 128;
const CODEX_MODEL_ID = /^(?=.*\d)[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

type CodexEvidenceFailure =
	| "invalid-id"
	| "candidate-limit"
	| "unavailable"
	| "redirect"
	| "response-size"
	| "metadata"
	| "network-or-timeout";

type CodexEvidenceOutcome =
	| { readonly status: "verified"; readonly modelId: string }
	| { readonly status: "skipped"; readonly reason: CodexEvidenceFailure };

export type CodexLongContextResolution = {
	readonly contextWindowByModelId: ReadonlyMap<string, number>;
	readonly liveCompleteOfflineModelIds: ReadonlySet<string>;
	readonly diagnostics: readonly string[];
};

export type CodexLongContextResolutionOptions = {
	/** Test seam and explicit transport boundary. Production uses global fetch. */
	readonly fetchDocumentation?: typeof fetch;
	/** Deterministic clock seam for the UTC-day candidate rotation. */
	readonly now?: () => number;
	/** Test-only lower bounds; callers cannot raise the production caps. */
	readonly maxCandidates?: number;
	readonly maxResponseBytes?: number;
	readonly timeoutMs?: number;
};

export type CodexModelDefaultChange = {
	readonly modelId: string;
	readonly previousContextWindow: number | undefined;
	readonly contextWindow: number | undefined;
	readonly hadOverride: boolean;
};

type CodexModelDefaultsPlan = {
	readonly providers: Record<string, Record<string, unknown>>;
	readonly changes: readonly CodexModelDefaultChange[];
	readonly contextWindowByModelId: ReadonlyMap<string, number>;
};

class CodexEvidenceError extends Error {
	readonly reason: CodexEvidenceFailure;

	constructor(reason: CodexEvidenceFailure) {
		super(reason);
		this.reason = reason;
	}
}

function lowerBoundedLimit(
	value: number | undefined,
	productionMaximum: number,
): number {
	return Number.isSafeInteger(value) && (value ?? 0) > 0
		? Math.min(value as number, productionMaximum)
		: productionMaximum;
}

function isRestrictedModelId(modelId: string): boolean {
	return (
		modelId.length <= CODEX_MODEL_ID_MAX_LENGTH && CODEX_MODEL_ID.test(modelId)
	);
}

function selectBoundedCandidates(
	candidates: readonly string[],
	maximumCandidates: number,
	nowMs: number,
): readonly string[] {
	if (candidates.length <= maximumCandidates) return candidates;
	const utcDay = Number.isFinite(nowMs) ? Math.floor(nowMs / UTC_DAY_MS) : 0;
	const start = ((utcDay % candidates.length) + candidates.length) % candidates.length;
	return Array.from(
		{ length: maximumCandidates },
		(_value, index) => candidates[(start + index) % candidates.length] as string,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCatalogFacts(model: unknown):
	| { readonly id: string; readonly contextWindow: number | undefined }
	| undefined {
	try {
		if (typeof model !== "object" || model === null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(model);
		const idDescriptor = descriptors.id;
		if (
			idDescriptor === undefined ||
			!("value" in idDescriptor) ||
			typeof idDescriptor.value !== "string"
		) {
			return undefined;
		}
		const contextWindowDescriptor = descriptors.contextWindow;
		const contextWindow =
			contextWindowDescriptor !== undefined &&
			"value" in contextWindowDescriptor &&
			typeof contextWindowDescriptor.value === "number"
				? contextWindowDescriptor.value
				: undefined;
		return { id: idDescriptor.value, contextWindow };
	} catch {
		return undefined;
	}
}

async function readBoundedDocumentation(
	response: Response,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (
		contentLength !== null &&
		/^\d+$/u.test(contentLength) &&
		Number(contentLength) > maximumBytes
	) {
		await response.body?.cancel();
		throw new CodexEvidenceError("response-size");
	}
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let byteCount = 0;
	let text = "";
	let rejectAborted: ((reason?: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAborted = reject;
	});
	const onAbort = () => rejectAborted?.(new CodexEvidenceError("network-or-timeout"));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		signal.throwIfAborted();
		while (true) {
			const chunk = await Promise.race([reader.read(), aborted]);
			if (chunk.done) break;
			byteCount += chunk.value.byteLength;
			if (byteCount > maximumBytes) {
				await reader.cancel();
				throw new CodexEvidenceError("response-size");
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function visibleMarkdownLines(markdown: string): string[] | undefined {
	const lines = markdown.split(/\r?\n/u);
	let fence: { readonly character: "`" | "~"; readonly length: number } | undefined;
	let inHtmlComment = false;
	let hasRawHtml = false;
	const visibleLines = lines.map((line) => {
		if (fence !== undefined) {
			const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/u)?.[1];
			if (
				closing !== undefined &&
				closing[0] === fence.character &&
				closing.length >= fence.length
			) {
				fence = undefined;
			}
			return "";
		}

		if (inHtmlComment) {
			if (line.includes("-->")) inHtmlComment = false;
			return "";
		}
		const commentStart = line.indexOf("<!--");
		if (commentStart >= 0) {
			if (!line.slice(commentStart + 4).includes("-->")) inHtmlComment = true;
			return "";
		}

		const opening = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
		if (opening !== undefined) {
			fence = {
				character: opening[0] as "`" | "~",
				length: opening.length,
			};
			return "";
		}

		if (
			/^ {0,3}(?:<\?|<!\[CDATA\[|<![A-Z])/iu.test(line) ||
			/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s>/]|$)/u.test(line)
		) {
			hasRawHtml = true;
			return "";
		}
		return line;
	});
	return hasRawHtml ? undefined : visibleLines;
}

function hasExactLongContextEvidence(markdown: string, modelId: string): boolean {
	const lines = visibleMarkdownLines(markdown);
	if (lines === undefined) return false;
	// Treat every visible Model ID mention as metadata. Counting only the exact
	// line would accept an alias page that also mentioned the requested ID.
	const modelIdEntries = lines.flatMap((line, index) =>
		line.includes("Model ID:") ? [{ line, index }] : [],
	);
	if (
		modelIdEntries.length !== 1 ||
		modelIdEntries[0]?.line !== `Model ID: \`${modelId}\``
	) {
		return false;
	}

	const detailHeadings = lines
		.map((line, index) => (line === "## Model details" ? index : -1))
		.filter((index) => index >= 0);
	if (
		detailHeadings.length !== 1 ||
		(modelIdEntries[0]?.index ?? Number.POSITIVE_INFINITY) >=
			(detailHeadings[0] ?? Number.NEGATIVE_INFINITY)
	) {
		return false;
	}
	const detailsStart = (detailHeadings[0] ?? -1) + 1;
	let detailsEnd = lines.length;
	for (let index = detailsStart; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^ {0,3}#{1,2}(?:[ \t]+|$)/u.test(line)) {
			detailsEnd = index;
			break;
		}
		if (
			/^ {0,3}(?:=+|-+)[ \t]*$/u.test(line) &&
			(lines[index - 1]?.trim().length ?? 0) > 0
		) {
			detailsEnd = Math.max(detailsStart, index - 1);
			break;
		}
	}
	// Any second context-window claim makes the model details ambiguous, even if
	// it uses a different number format (for example `1M` or `200,000-token`).
	const contextWindowLines = lines
		.slice(detailsStart, detailsEnd)
		.filter((line) => /context(?:[\s-]+)window/iu.test(line));
	return (
		contextWindowLines.length === 1 &&
		contextWindowLines[0] === "- 1,050,000 context window"
	);
}

async function inspectOfficialModelDocumentation(
	modelId: string,
	fetchDocumentation: typeof fetch,
	maximumBytes: number,
	timeoutMs: number,
): Promise<CodexEvidenceOutcome> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new CodexEvidenceError("network-or-timeout"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			(async (): Promise<CodexEvidenceOutcome> => {
				const response = await fetchDocumentation(
					`${CODEX_MODEL_DOCUMENTATION_BASE_URL}${modelId}.md`,
					{
						method: "GET",
						redirect: "error",
						credentials: "omit",
						cache: "no-store",
						headers: { Accept: "text/markdown" },
						signal: controller.signal,
					},
				);
				if (response.redirected) {
					return { status: "skipped", reason: "redirect" };
				}
				if (response.status !== 200) {
					return { status: "skipped", reason: "unavailable" };
				}
				const contentType = response.headers.get("content-type") ?? "";
				if (!/^text\/markdown(?:;|$)/iu.test(contentType)) {
					return { status: "skipped", reason: "metadata" };
				}
				const markdown = await readBoundedDocumentation(
					response,
					maximumBytes,
					controller.signal,
				);
				return hasExactLongContextEvidence(markdown, modelId)
					? { status: "verified", modelId }
					: { status: "skipped", reason: "metadata" };
			})(),
			timedOut,
		]);
	} catch (error) {
		return {
			status: "skipped",
			reason:
				error instanceof CodexEvidenceError
					? error.reason
					: "network-or-timeout",
		};
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		controller.abort();
	}
}

function renderEvidenceDiagnostics(
	verifiedCount: number,
	failures: ReadonlyMap<CodexEvidenceFailure, number>,
): readonly string[] {
	const diagnostics: string[] = [];
	if (verifiedCount > 0) {
		diagnostics.push(
			`verified ${verifiedCount} additional Codex ${verifiedCount === 1 ? "model" : "models"} from exact official model documentation`,
		);
	}
	const orderedReasons: readonly CodexEvidenceFailure[] = [
		"invalid-id",
		"candidate-limit",
		"unavailable",
		"redirect",
		"response-size",
		"metadata",
		"network-or-timeout",
	];
	const skippedCount = orderedReasons.reduce(
		(total, reason) => total + (failures.get(reason) ?? 0),
		0,
	);
	if (skippedCount > 0) {
		const reasonSummary = orderedReasons
			.flatMap((reason) => {
				const count = failures.get(reason) ?? 0;
				return count > 0 ? [`${reason}: ${count}`] : [];
			})
			.join(", ");
		diagnostics.push(
			`skipped ${skippedCount} unverified Codex documentation ${skippedCount === 1 ? "candidate" : "candidates"} (${reasonSummary})`,
		);
	}
	return diagnostics;
}

/**
 * Resolve offline-approved defaults plus bounded, exact official-document evidence
 * for new IDs already present in the live Codex catalog.
 */
export async function resolveCodexLongContextDefaults(
	catalog: ModelDeclarationCatalogs["openai-codex"],
	options: CodexLongContextResolutionOptions = {},
): Promise<CodexLongContextResolution> {
	const maximumCandidates = lowerBoundedLimit(
		options.maxCandidates,
		CODEX_MODEL_DOCUMENTATION_MAX_CANDIDATES,
	);
	const maximumBytes = lowerBoundedLimit(
		options.maxResponseBytes,
		CODEX_MODEL_DOCUMENTATION_MAX_BYTES,
	);
	const timeoutMs = lowerBoundedLimit(
		options.timeoutMs,
		CODEX_MODEL_DOCUMENTATION_TIMEOUT_MS,
	);
	const failures = new Map<CodexEvidenceFailure, number>();
	const addFailure = (reason: CodexEvidenceFailure, count = 1): void => {
		failures.set(reason, (failures.get(reason) ?? 0) + count);
	};
	const resolved = new Map(CODEX_CONTEXT_WINDOW_BY_MODEL_ID);
	const liveCompleteOfflineModelIds = new Set<string>();
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const model of catalog) {
		const facts = safeCatalogFacts(model);
		if (facts === undefined || seen.has(facts.id)) continue;
		seen.add(facts.id);
		const isOfflineApproved = CODEX_CONTEXT_WINDOW_BY_MODEL_ID.has(facts.id);
		const hasRestrictedId = isRestrictedModelId(facts.id);
		const providerContextWindow = facts.contextWindow;
		if (
			typeof providerContextWindow === "number" &&
			Number.isFinite(providerContextWindow) &&
			providerContextWindow >= CODEX_CONTEXT_WINDOW
		) {
			if (isOfflineApproved || hasRestrictedId) {
				// The live catalog already carries sufficient context. Preserve its exact
				// value in the unified copy and do not create a physical override.
				resolved.delete(facts.id);
				if (isOfflineApproved) liveCompleteOfflineModelIds.add(facts.id);
			} else {
				addFailure("invalid-id");
			}
			continue;
		}
		if (isOfflineApproved) continue;
		if (!hasRestrictedId) {
			addFailure("invalid-id");
			continue;
		}
		candidates.push(facts.id);
	}

	const boundedCandidates = selectBoundedCandidates(
		candidates,
		maximumCandidates,
		(options.now ?? Date.now)(),
	);
	if (candidates.length > boundedCandidates.length) {
		addFailure("candidate-limit", candidates.length - boundedCandidates.length);
	}
	const fetchDocumentation = options.fetchDocumentation ?? globalThis.fetch;
	const outcomes = await Promise.all(
		boundedCandidates.map((modelId) =>
			inspectOfficialModelDocumentation(
				modelId,
				fetchDocumentation,
				maximumBytes,
				timeoutMs,
			),
		),
	);
	let verifiedCount = 0;
	for (const outcome of outcomes) {
		if (outcome.status === "verified") {
			resolved.set(outcome.modelId, CODEX_CONTEXT_WINDOW);
			verifiedCount += 1;
		} else {
			addFailure(outcome.reason);
		}
	}
	return {
		contextWindowByModelId: resolved,
		liveCompleteOfflineModelIds,
		diagnostics: renderEvidenceDiagnostics(verifiedCount, failures),
	};
}

/**
 * Mirrors Pi 0.84.4's private `ModelOverrideSchema`. The host does not export
 * this validator; keep it aligned when the exact host dependency pin moves.
 */
const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});
const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(
		Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
	),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(
		Type.Union([Type.Number(), PercentileCutoffsSchema]),
	),
	preferred_max_latency: Type.Optional(
		Type.Union([Type.Number(), PercentileCutoffsSchema]),
	),
});
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
	max: Type.Optional(ThinkingLevelMapValueSchema),
});
const ChatTemplateKwargScalarSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
]);
const ChatTemplateKwargVariableSchema = Type.Object({
	$var: Type.Union([
		Type.Literal("thinking.enabled"),
		Type.Literal("thinking.effort"),
	]),
	omitWhenOff: Type.Optional(Type.Boolean()),
});
const ChatTemplateKwargSchema = Type.Union([
	ChatTemplateKwargScalarSchema,
	ChatTemplateKwargVariableSchema,
]);
const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	supportsFinishReason: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(
		Type.Union([
			Type.Literal("max_completion_tokens"),
			Type.Literal("max_tokens"),
		]),
	),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union(
			[
				"openai",
				"openrouter",
				"together",
				"baseten",
				"deepseek",
				"zai",
				"qwen",
				"chat-template",
				"qwen-chat-template",
				"string-thinking",
				"ant-ling",
			].map((value) => Type.Literal(value)),
		),
	),
	chatTemplateKwargs: Type.Optional(
		Type.Record(Type.String(), ChatTemplateKwargSchema),
	),
	chatTemplateArgs: Type.Optional(
		Type.Record(Type.String(), ChatTemplateKwargSchema),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	deferredToolsMode: Type.Optional(Type.Literal("kimi")),
	sessionAffinityFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openai-nosession"),
			Type.Literal("openrouter"),
		]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});
const OpenAIResponsesCompatSchema = Type.Object({
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	sessionAffinityFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openai-nosession"),
			Type.Literal("openrouter"),
		]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsAdditionalTools: Type.Optional(Type.Boolean()),
	supportsToolSearch: Type.Optional(Type.Boolean()),
});
const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	allowEmptySignature: Type.Optional(Type.Boolean()),
	supportsStrictTools: Type.Optional(Type.Boolean()),
	supportsToolReferences: Type.Optional(Type.Boolean()),
});
const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);
const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
});
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(
		Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
			tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});
const validateModelOverride = Compile(ModelOverrideSchema);

function invalidModelOverride(): never {
	throw new Error(
		"The openai-codex provider has an invalid model override; it will not be replaced.",
	);
}

/** Validate operator overrides and plan only the resolved context-window mutations. */
export function planCodexModelDefaults(
	providersValue: unknown,
	contextWindowByModelId: ReadonlyMap<string, number> =
		CODEX_CONTEXT_WINDOW_BY_MODEL_ID,
	liveCompleteOfflineModelIds: ReadonlySet<string> = new Set(),
): CodexModelDefaultsPlan {
	if (providersValue !== undefined && !isRecord(providersValue)) {
		return invalidModelOverride();
	}
	const providers = providersValue ?? {};
	const codexValue = providers["openai-codex"];
	if (codexValue !== undefined && !isRecord(codexValue)) {
		return invalidModelOverride();
	}
	const codex = codexValue ?? {};
	const overridesValue = codex.modelOverrides;
	if (overridesValue !== undefined && !isRecord(overridesValue)) {
		return invalidModelOverride();
	}
	const existingOverrides = overridesValue ?? {};
	for (const override of Object.values(existingOverrides)) {
		if (!validateModelOverride.Check(override)) return invalidModelOverride();
	}

	const mergedOverrides: Record<string, unknown> = { ...existingOverrides };
	const changes: CodexModelDefaultChange[] = [];
	for (const modelId of liveCompleteOfflineModelIds) {
		if (!CODEX_CONTEXT_WINDOW_BY_MODEL_ID.has(modelId)) continue;
		const existing = existingOverrides[modelId] as
			| Record<string, unknown>
			| undefined;
		if (existing?.contextWindow !== CODEX_CONTEXT_WINDOW) continue;
		const remaining = { ...existing };
		delete remaining.contextWindow;
		if (Object.keys(remaining).length === 0) {
			delete mergedOverrides[modelId];
		} else {
			mergedOverrides[modelId] = remaining;
		}
		changes.push({
			modelId,
			previousContextWindow: CODEX_CONTEXT_WINDOW,
			contextWindow: undefined,
			hadOverride: true,
		});
	}
	for (const [modelId, contextWindow] of contextWindowByModelId) {
		const hadOverride = Object.hasOwn(existingOverrides, modelId);
		if (hadOverride && !CODEX_CONTEXT_WINDOW_BY_MODEL_ID.has(modelId)) {
			// Exact documentation authorizes a dynamic default; it does not transfer
			// ownership of an operator's existing override to this transaction.
			continue;
		}
		const existing = existingOverrides[modelId] as
			| Record<string, unknown>
			| undefined;
		const previousContextWindow = existing?.contextWindow as number | undefined;
		if (previousContextWindow !== contextWindow) {
			changes.push({
				modelId,
				previousContextWindow,
				contextWindow,
				hadOverride,
			});
		}
		mergedOverrides[modelId] = {
			...existing,
			contextWindow,
		};
	}

	return {
		providers: {
			...providers,
			"openai-codex": {
				...codex,
				modelOverrides: mergedOverrides,
			},
		},
		changes,
		contextWindowByModelId,
	};
}

/** Build a declaration whose validated Codex row copies carry the resolved defaults. */
export function buildModelDeclarationWithCodexDefaults(
	catalogs: ModelDeclarationCatalogs,
	contextWindowByModelId: ReadonlyMap<string, number> =
		CODEX_CONTEXT_WINDOW_BY_MODEL_ID,
): BuiltDeclaration {
	return buildModelDeclaration(catalogs, {
		codexContextWindowByModelId: contextWindowByModelId,
	});
}
