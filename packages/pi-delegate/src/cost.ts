/**
 * Helpers for picking a cheap model for transcript summarization.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isModelInScope, type ModelScope } from "./model-selection.js";

/**
 * Total per-million-token cost as a simple proxy for "cheapness".
 * Weighted 1:4 in/out to reflect typical summarization shape (lots of input,
 * modest output). Falls back to Infinity for models without cost info.
 *
 * WARNING (issue #13 nit): the 1:4 weighting is SUMMARIZATION-SPECIFIC.
 * Do not reuse this score to rank models for balanced or generation-heavy
 * workloads — it systematically over-penalizes models with expensive output
 * tokens relative to how such workloads actually bill.
 */
function costScore(m: Model<any>): number {
	if (!m.cost) return Number.POSITIVE_INFINITY;
	const { input, output } = m.cost;
	if (!Number.isFinite(input) || !Number.isFinite(output)) return Number.POSITIVE_INFINITY;
	return input + 4 * output;
}

function hasKnownPricing(m: Model<Api>): boolean {
	return Boolean(
		m.cost &&
		Number.isFinite(m.cost.input) &&
		Number.isFinite(m.cost.output) &&
		m.cost.input >= 0 &&
		m.cost.output >= 0,
	);
}

/**
 * Heuristic: is this model suitable for a one-shot text summarisation call?
 *
 * - Must accept text input (sanity — skip pure-image / pure-audio models).
 * - Skip the `faux` provider, which is a pi-ai test harness that replays
 *   canned responses.
 * - Reasoning-only models are risky because the chat completion often comes
 *   back as reasoning-only content with an empty text block, and the
 *   summariser drops reasoning blocks. We keep them as a last resort
 *   (see `pickCheapestAvailable`), but prefer non-reasoning models.
 */
function acceptsTextInput(m: Model<any>): boolean {
	return Array.isArray(m.input) && m.input.includes("text");
}

function isFauxProvider(m: Model<any>): boolean {
	return m.provider === "faux";
}

/**
 * OpenRouter's opportunistic `:free` routes are not reliable enough for
 * unattended control-plane text. They can disappear, rate-limit aggressively,
 * or return an otherwise successful response with no text. Automatic routing
 * must never select one; an operator can still name one explicitly where a
 * call site supports an explicit model reference.
 */
function isOpenRouterFreeRoute(m: Model<any>): boolean {
	return m.provider.toLowerCase() === "openrouter" && m.id.toLowerCase().endsWith(":free");
}

export function pickCheapestAvailable(
	registry: ModelRegistry,
	scope?: ModelScope,
): Model<any> | undefined {
	const avail = registry.getAvailable().filter((model) => isModelInScope(model, scope));
	if (avail.length === 0) return undefined;

	// `:free` is a hard automatic-routing exclusion, not a soft suitability
	// preference. If every available model is excluded, fail closed rather than
	// silently choosing a route the operator did not explicitly request.
	const policyEligible = avail.filter((m) => !isOpenRouterFreeRoute(m) && hasKnownPricing(m));
	if (policyEligible.length === 0) return undefined;

	// Filter out unsuitable models. If the filter removes everything, fall
	// back to the policy-eligible list so a pathological registry can still use
	// an explicitly non-free model.
	const usable = policyEligible.filter((m) => acceptsTextInput(m) && !isFauxProvider(m));
	const pool = usable.length > 0 ? usable : policyEligible;

	// Prefer non-reasoning models (they reliably emit text content); only
	// pick a reasoning model if nothing else is available.
	const nonReasoning = pool.filter((m) => !m.reasoning);
	const tier = nonReasoning.length > 0 ? nonReasoning : pool;

	return [...tier].sort((a, b) => costScore(a) - costScore(b))[0];
}
