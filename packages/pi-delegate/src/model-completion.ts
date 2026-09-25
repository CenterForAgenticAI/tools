import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRuntimeLike } from "./sdk-model-runtime.js";
import { findModel, isModelInScope, type ModelScope } from "./model-selection.js";

/** Stable built-in destination selected by literal `auto` text-completion routing. */
export const AUTO_TEXT_COMPLETION_MODEL_REF = "anthropic/claude-haiku-4-5";

/** A one-shot text completion function, injectable for deterministic tests. */
export type TextCompletionFunction = (
	model: Model<Api>,
	context: Context,
	options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export interface AuthenticatedTextCompletionOptions {
	model: Model<Api>;
	registry: ModelRegistry;
	modelRuntime?: ModelRuntimeLike;
	systemPrompt: string;
	messages: Message[];
	signal?: AbortSignal;
	/** Optional hard character limit applied after text blocks are joined and trimmed. */
	maxTextChars?: number;
	/** Test seam; production callers use pi-ai's compat/root complete export. */
	complete?: TextCompletionFunction;
}

export interface AuthenticatedTextCompletionResult {
	text: string;
	response: AssistantMessage;
}

export class TextCompletionAbortedError extends Error {
	constructor() {
		super("Text completion aborted");
		this.name = "TextCompletionAbortedError";
	}
}

/**
 * Resolve an explicitly configured text-completion model.
 *
 * Omission deliberately resolves to nothing (and therefore cannot trigger a
 * provider call). The literal `auto` deterministically selects the built-in
 * Claude Haiku 4.5 destination and fails closed when that model is unavailable.
 * Every other accepted reference must identify `provider/model`.
 */
export function resolveTextCompletionModel(
	registry: ModelRegistry,
	ref: string | undefined,
	scope?: ModelScope,
): Model<Api> | undefined {
	if (ref === undefined) return undefined;
	if (ref === "auto") {
		return registry
			.getAvailable()
			.find(
				(candidate) =>
					`${candidate.provider}/${candidate.id}` === AUTO_TEXT_COMPLETION_MODEL_REF &&
					isModelInScope(candidate, scope),
			) as Model<Api> | undefined;
	}
	if (!/^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/.test(ref)) return undefined;

	const separator = ref.indexOf("/");
	const provider = ref.slice(0, separator);
	const id = ref.slice(separator + 1);
	return findModel(registry, provider, id, scope) as Model<Api> | undefined;
}

/** Load pi-ai's compatible one-shot completion helper. */
export async function loadTextCompletionFunction(): Promise<TextCompletionFunction> {
	const compat = await import("@earendil-works/pi-ai/compat");
	const complete = compat.complete as TextCompletionFunction;
	if (typeof complete !== "function") {
		throw new Error("@earendil-works/pi-ai complete() helper is unavailable");
	}
	return complete;
}

/**
 * Perform one authenticated completion and return only joined text plus the
 * original response (for exact usage accounting by callers). Authentication,
 * provider errors, and cancellation reject; a valid response containing no
 * text resolves with `text: ""` so callers can retain their factual fallback.
 */
export async function completeAuthenticatedText(
	opts: AuthenticatedTextCompletionOptions,
): Promise<AuthenticatedTextCompletionResult> {
	const { model, registry, modelRuntime, systemPrompt, messages, signal, maxTextChars } = opts;
	if (
		maxTextChars !== undefined &&
		(!Number.isSafeInteger(maxTextChars) || maxTextChars <= 0)
	) {
		throw new Error("maxTextChars must be a positive safe integer");
	}

	let response: AssistantMessage;
	if (!opts.complete && typeof modelRuntime?.complete === "function") {
		response = await modelRuntime.complete(model, { systemPrompt, messages }, { signal }) as AssistantMessage;
	} else {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error((auth as { ok: false; error: string }).error);
		}
		if (!auth.apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const complete = opts.complete ?? (await loadTextCompletionFunction());
		response = await complete(
			model,
			{ systemPrompt, messages },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
	}
	if (response.stopReason === "aborted") {
		throw new TextCompletionAbortedError();
	}

	const text = response.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();

	return {
		text: maxTextChars === undefined ? text : text.slice(0, maxTextChars).trimEnd(),
		response,
	};
}
