export type TierModelDestination = "anthropic" | "openai" | "openrouter";

export type TierModelMap = Readonly<
	Partial<Record<TierModelDestination, Readonly<Record<string, string>>>>
>;

export const MAX_TIER_MODEL_ID_LENGTH = 256;

const TIER_MODEL_DESTINATIONS: readonly TierModelDestination[] = [
	"anthropic",
	"openai",
	"openrouter",
];
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isTierModelDestination(
	value: unknown,
): value is TierModelDestination {
	return TIER_MODEL_DESTINATIONS.includes(value as TierModelDestination);
}

function isValidRequestedModel(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "*" &&
		value.length > 0 &&
		value.length <= MAX_TIER_MODEL_ID_LENGTH &&
		value.trim().length > 0 &&
		!CONTROL_CHARACTER.test(value)
	);
}

export function resolveTierModel(
	requested: string,
	destination: TierModelDestination,
	catalog: readonly string[],
	map: TierModelMap,
): string | undefined {
	if (!isValidRequestedModel(requested) || !isTierModelDestination(destination)) {
		return undefined;
	}
	if (catalog.includes(requested)) return requested;

	const mapped = map[destination]?.[requested];
	return mapped !== undefined && catalog.includes(mapped) ? mapped : undefined;
}
