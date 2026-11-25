#!/usr/bin/env node
/**
 * mask-last-K: an example external context strategy for the strategy bench (pi-context-aware#470).
 *
 * It keeps the last K tool results as they are and stubs every older one, the observation-masking
 * control from the masking literature. Each stub's text says what was there; the bench appends the
 * context_recall pointer itself. It reads one request per line on standard input and writes one reply
 * per line on standard output, as docs/strategy-protocol.md describes. It keeps no state between
 * requests, takes no arguments and reads no environment: the view is its only input.
 *
 * Run it in the bench:  npm run bench:strategy -- --corpus <label>=<dir> --external mask-last-k=<this file>
 * Check it:             npm run bench:strategy -- --conformance mask-last-k=<this file>
 */

import { createInterface } from "node:readline";

/** Tool results kept as they are, newest first. */
const K = 5;
/** Smaller results are not worth a stub. */
const MIN_TOKENS = 200;

/** One plan that stubs every tool result older than the last K that the view lets a stub take, or no plan. */
function plans(view) {
	const kept = new Set(view.protectedEntryIds);
	for (const hide of view.hides) kept.add(hide.targetId);
	for (const fold of view.folds) kept.add(fold.carrierId);
	const results = view.entries.filter((entry) => entry.role === "toolResult");
	const older = results.slice(0, Math.max(0, results.length - K));
	const stubs = older
		.filter((entry) => !kept.has(entry.id) && entry.hint !== "verbatim" && entry.tokens >= MIN_TOKENS)
		.map((entry) => ({ kind: "stub", entryId: entry.id, text: `[Older tool result masked: ${entry.tokens} tokens.]` }));
	return stubs.length > 0 ? [stubs] : [];
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (line.trim().length === 0) continue;
	const request = JSON.parse(line);
	// A protocol this script does not know: exit without a reply; the bench counts the request as refused.
	if (request.protocol !== 1) process.exit(2);
	process.stdout.write(`${JSON.stringify({ plans: plans(request.view) })}\n`);
}
