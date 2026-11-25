#!/usr/bin/env node
// `pi-context-aware cache-profile build`: write <agent dir>/cache-profile.json and print its table.
import { buildCacheProfile, renderCacheProfile } from "./cache-profile.js";

if (process.argv.slice(2).join(" ") !== "cache-profile build") {
	console.error("Usage: pi-context-aware cache-profile build");
	process.exitCode = 2;
} else {
	try {
		console.log(renderCacheProfile(await buildCacheProfile()));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Cache profile build failed: ${message.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").slice(0, 300)}`);
		process.exitCode = 1;
	}
}
