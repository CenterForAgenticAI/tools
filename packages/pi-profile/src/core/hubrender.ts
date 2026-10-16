import { Refusal } from "./result.ts";
import { renderProfile, renderSettings, type Json, type TokenHost } from "./tokens.ts";

/**
 * A hub file rendered for this host: `profile.json` and `settings.json` with
 * their path tokens expanded and `sessionDir` set from `sessionDir`; any other
 * file as it is. `sync pull` writes this; `sync push` records its id, so a
 * later pull can tell a render that changed (a new session store, say) from a
 * local file that was never in rendered form.
 */
export function renderFile(rel: string, bytes: Buffer, host: TokenHost, sessionDir: string | undefined): { bytes: Buffer; json?: Json; warnings: readonly string[] } {
	if (rel !== "profile.json" && rel !== "settings.json") return { bytes, warnings: [] };
	const text = bytes.toString("utf8");
	let json: Json;
	try {
		json = JSON.parse(text) as Json;
	} catch {
		throw new Refusal(`${rel} in the hub is not valid JSON`);
	}
	const t = rel === "settings.json" ? renderSettings(json, host, sessionDir) : renderProfile(json, host);
	if (JSON.stringify(t.json) === JSON.stringify(json)) return { bytes, json, warnings: t.warnings };
	const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? "\t";
	return { bytes: Buffer.from(`${JSON.stringify(t.json, null, indent)}\n`), json: t.json, warnings: t.warnings };
}
