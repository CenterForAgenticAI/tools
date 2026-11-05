/**
 * The most output space the generation-reserve trigger holds back. The reserve is the model's real
 * maximum output, capped here: a 128,000-token output limit on a 272,000-token window would otherwise
 * compact at 47% for a reply that is almost never that long. 32,768 tokens is about 25,000 words in one
 * reply; it leaves at least 87% of a 272,000-token window and 96% of a 1,000,000-token window usable.
 */
export const DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS = 32_768;
export const GENERATION_PROTOCOL_OVERHEAD_TOKENS = 2_048;

export interface GenerationBudgetAssessmentInput {
	contextWindow: number;
	usedTokens: number;
	configuredOutputReserveTokens: number;
	modelMaxOutputTokens?: number;
	protocolOverheadTokens?: number;
}

export interface GenerationBudgetAssessment {
	contextWindow: number;
	usedTokens: number;
	headroomTokens: number;
	outputReserveTokens: number;
	protocolOverheadTokens: number;
	requiredHeadroomTokens: number;
	shortfallTokens: number;
	safe: boolean;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

export function normalizeGenerationOutputReserve(value: unknown): number {
	return positiveInteger(value, DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS);
}

export function parseGenerationOutputReserve(value: string): number | null {
	const match = value.trim().toLowerCase().replaceAll("_", "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
	if (!match) return null;
	const scalar = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	const tokens = Number(match[1]) * scalar;
	if (!Number.isFinite(tokens) || tokens < 1) return null;
	return Math.floor(tokens);
}

export function assessGenerationBudget(input: GenerationBudgetAssessmentInput): GenerationBudgetAssessment {
	const contextWindow = positiveInteger(input.contextWindow, 0);
	const usedTokens = nonNegativeInteger(input.usedTokens, 0);
	const configuredOutputReserve = normalizeGenerationOutputReserve(input.configuredOutputReserveTokens);
	const modelMaxOutput = positiveInteger(input.modelMaxOutputTokens, configuredOutputReserve);
	const outputReserveTokens = Math.min(contextWindow, configuredOutputReserve, modelMaxOutput);
	const protocolOverheadTokens = Math.min(
		contextWindow,
		input.protocolOverheadTokens === undefined
			? GENERATION_PROTOCOL_OVERHEAD_TOKENS
			: nonNegativeInteger(input.protocolOverheadTokens, 0),
	);
	const requiredHeadroomTokens = Math.min(
		contextWindow,
		outputReserveTokens + protocolOverheadTokens,
	);
	const headroomTokens = Math.max(0, contextWindow - usedTokens);
	const shortfallTokens = Math.max(0, requiredHeadroomTokens - headroomTokens);

	return {
		contextWindow,
		usedTokens,
		headroomTokens,
		outputReserveTokens,
		protocolOverheadTokens,
		requiredHeadroomTokens,
		shortfallTokens,
		safe: shortfallTokens === 0,
	};
}

export function isProactiveCompactionCheckpoint(stopReason: string | undefined): boolean {
	return stopReason === "stop" || stopReason === "toolUse" || stopReason === "length" || stopReason === "error";
}
