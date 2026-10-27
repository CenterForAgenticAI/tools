import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { FoldsConfig } from "../platform/config-layers.js";

/** Effective values, not their sources: a policy change starts a fresh parity window. */
export function configuredFoldFingerprint(engine: string, folds: FoldsConfig): string {
	// condensedSkills joins the hash only when on, so fingerprints from before the setting stay the same.
	const values = [engine, folds.firstUserMessage, folds.firstUserMessageMaxTokens, ...(folds.condensedSkills ? ["condensedSkills"] : [])];
	return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/**
 * Length-framed path/content pairs avoid concatenation ambiguities.
 *
 * `foldsDir` is the compiled `folds/` directory. The caller passes it, because a path
 * relative to this module is wrong once the module is bundled into `dist/extension.js`.
 */
export function foldEngineFingerprint(foldsDir: string): string {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.relative(foldsDir, file).split(path.sep).join("/"));
		}
	};
	visit(foldsDir);
	if (files.length === 0) throw new Error("No compiled fold engine files");
	const hash = createHash("sha256");
	for (const relative of files.sort()) {
		const content = readFileSync(path.join(foldsDir, relative));
		hash.update(`${Buffer.byteLength(relative)}:`).update(relative).update(`${content.length}:`).update(content);
	}
	return hash.digest("hex");
}
