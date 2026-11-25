/** Request signals the cache guard reads: Pi's idle cache-warm request, and which system sections changed when the provider payload lost its tags. */
type Hashes = ReadonlyMap<string, string>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Pi's idle warmer sends a one-token output cap (OpenAI Responses clamps it to 16); a warm request must not change the real-request baseline. */
export function isWarmRequest(payload: Record<string, unknown>): boolean {
	const config = record(payload.config) ? payload.config : {};
	return [payload.max_tokens, payload.max_output_tokens, payload.max_completion_tokens, config.maxOutputTokens].includes(1) || payload.max_output_tokens === 16;
}

/** Hashes of the leading system message's sections, the names the context had before the provider payload dropped its tags. A null section counts as absent. */
export function leadingSectionHashes(messages: readonly { role: string }[], hash: (value: unknown) => string): Map<string, string> {
	const leading = messages[0];
	const sections = leading?.role === "system" ? (leading as { sections?: Record<string, string | null> }).sections ?? {} : {};
	return new Map(Object.entries(sections).flatMap(([name, value]) => (value === null ? [] : [[name, hash(value)] as const])));
}

function differing(previous: Hashes, next: Hashes): string[] {
	const names = [...new Set([...previous.keys(), ...next.keys()])];
	return names.filter((name) => name !== "whole-prompt" && previous.get(name) !== next.get(name));
}

/** Names the changed system sections: payload tags first, then the context's section names, then the whole prompt. */
export function changedSections(previous: { readonly sections: Hashes; readonly seen: Hashes }, next: { readonly sections: Hashes; readonly seen: Hashes }): string[] {
	const tagged = differing(previous.sections, next.sections);
	if (tagged.length > 0) return tagged;
	const seen = differing(previous.seen, next.seen);
	return seen.length > 0 ? seen : ["whole-prompt (extension attribution unavailable)"];
}
