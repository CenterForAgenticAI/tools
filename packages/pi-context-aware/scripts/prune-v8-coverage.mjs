/**
 * Drop the parts of raw V8 coverage files that c8 can never report on, so
 * `c8 report` merges less.
 *
 * c8 parses every raw file and keeps them all in memory while it merges them.
 * With `exclude-after-remap` it filters nothing before the merge, so the heap
 * peaks above 2 GB for this suite: most of each file is Node's own modules,
 * dependencies under node_modules, and their source maps. Node 24 in the
 * pi-latest CI job gets about 2 GB of old space in a container with less than
 * 16 GB of memory, and the merge ran out of heap there.
 *
 * Only entries c8 would drop or exclude anyway are removed:
 * - a script whose URL is not a file:// URL (`node:` modules, evals, empty
 *   URLs). c8 turns these into relative paths and omits them (`omit-relative`
 *   defaults to true);
 * - a script under a node_modules directory. Its remapped sources stay under
 *   node_modules, which test-exclude always excludes;
 * - a source-map-cache entry whose script was removed;
 * - a source-map-cache entry that a later file in the directory also holds.
 *   c8 collects the caches with Object.assign in directory order, so only the
 *   last copy of each URL's source map is ever read. Every test process that
 *   loads the compiled sources carries all their maps, so this is most of what
 *   is left.
 * The merge combines each URL separately, so removing whole scripts leaves
 * every other script's merged counts unchanged.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Whether c8 could report on a script with this URL.
 */
export function reportableScriptUrl(url) {
	if (typeof url !== "string" || !url.startsWith("file://")) return false;
	return !url.includes("/node_modules/");
}

/**
 * The process coverage with unreportable scripts removed, and source maps kept
 * only for the URLs `keepSourceMap` accepts (by default, every reportable one).
 */
export function pruneProcessCoverage(report, keepSourceMap = reportableScriptUrl) {
	const result = report.result.filter((script) => reportableScriptUrl(script.url));
	const pruned = { result };
	const sourceMaps = report["source-map-cache"];
	if (sourceMaps && typeof sourceMaps === "object") {
		const kept = {};
		for (const url of Object.keys(sourceMaps)) {
			if (reportableScriptUrl(url) && keepSourceMap(url)) kept[url] = sourceMaps[url];
		}
		pruned["source-map-cache"] = kept;
	}
	return pruned;
}

function readCoverage(file) {
	try {
		const report = JSON.parse(fs.readFileSync(file, "utf8"));
		return report && Array.isArray(report.result) ? report : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Rewrite every coverage file in a directory, one file in memory at a time.
 *
 * Files are visited in readdirSync order, the order c8 reads them in. A file
 * that is not JSON coverage is left as it is; c8 skips it too.
 * Returns the bytes before and after.
 */
export function pruneCoverageDirectory(directory) {
	const files = fs
		.readdirSync(directory)
		.map((name) => path.join(directory, name))
		.filter((file) => fs.statSync(file).isFile());

	// The last file holding each URL's source map.
	const lastHolder = new Map();
	for (const file of files) {
		const report = readCoverage(file);
		for (const url of Object.keys(report?.["source-map-cache"] ?? {})) lastHolder.set(url, file);
	}

	let before = 0;
	let after = 0;
	for (const file of files) {
		const size = fs.statSync(file).size;
		before += size;
		const report = readCoverage(file);
		if (!report) {
			after += size;
			continue;
		}
		const text = JSON.stringify(pruneProcessCoverage(report, (url) => lastHolder.get(url) === file));
		after += Buffer.byteLength(text);
		fs.writeFileSync(file, text);
	}
	return { before, after };
}
