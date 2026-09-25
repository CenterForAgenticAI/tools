import type { ScalarTag } from "yaml";

/**
 * Extended YAML Support's presentation-only block-scalar tag vocabulary.
 * Tags are case-sensitive and are accepted only on literal/folded scalars.
 */
export const ALLOWED_TAGS = [
	"!md", "!markdown", "!py", "!python", "!json", "!ts", "!typescript",
	"!rs", "!rust", "!bash", "!sh", "!shell", "!rb", "!ruby", "!diff",
	"!patch", "!toml",
] as const;

export type AllowedTag = (typeof ALLOWED_TAGS)[number];
export const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(ALLOWED_TAGS);

/** Custom tags preserve their scalar value; they add no semantic meaning. */
export const customTags: ScalarTag[] = ALLOWED_TAGS.map((tag) => ({
	tag,
	identify: () => false,
	resolve: (value: string) => value,
}));

export function isAllowedTag(tag: string | undefined): tag is AllowedTag {
	return tag !== undefined && ALLOWED_TAG_SET.has(tag);
}
