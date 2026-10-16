/** Profile colours: `#rrggbb` or a palette name. Unset profiles get a stable colour from the name. */
export const PALETTE: Readonly<Record<string, string>> = {
	red: "#dc2626",
	orange: "#ea580c",
	amber: "#d97706",
	yellow: "#ca8a04",
	lime: "#65a30d",
	green: "#16a34a",
	teal: "#0d9488",
	cyan: "#0891b2",
	blue: "#2563eb",
	indigo: "#4f46e5",
	violet: "#7c3aed",
	pink: "#db2777",
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isColor(value: string): boolean {
	return HEX.test(value) || Object.hasOwn(PALETTE, value);
}

/** Resolve a colour setting to `#rrggbb`. Falls back to the stable colour for `name`. */
export function resolveColor(name: string, value: string | undefined): string {
	if (value !== undefined) {
		if (HEX.test(value)) return value.toLowerCase();
		const named = PALETTE[value];
		if (named !== undefined) return named;
	}
	return stableColor(name);
}

/** FNV-1a over the name, mapped onto the palette. The same name always gets the same colour. */
export function stableColor(name: string): string {
	let hash = 0x811c9dc5;
	for (const ch of name) {
		hash ^= ch.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const colours = Object.values(PALETTE);
	return colours[hash % colours.length] ?? "#2563eb";
}

/** 24-bit foreground escape for a `#rrggbb` colour. */
export function ansiFg(hex: string, text: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `\u001b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\u001b[39m`;
}
