import { createHash } from "node:crypto";

export const KERNEL_TEST_COMMIT = "5d7b5380df0aef87d9c96f2993dc8e2368dddb91";
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Only import specifiers may change; reversing the recorded edits must recover upstream bytes. */
export function verifyTestFile(text, record) {
	if (sha256(text) !== record.sha256) throw new Error(`${record.file}: vendored sha256 mismatch`);
	let upstream = text;
	for (const { from, to, count } of record.changes) {
		const specifier = new RegExp(`(?<=(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*)["'])${to.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=["'])`, "gu");
		const matches = [...upstream.matchAll(specifier)];
		if (matches.length !== count) throw new Error(`${record.file}: recorded import count mismatch`);
		upstream = upstream.replace(specifier, from);
	}
	if (sha256(upstream) !== record.upstreamSha256) throw new Error(`${record.file}: upstream sha256 mismatch`);
	return upstream;
}

export function relocateTest(text) {
	const changes = new Map();
	const relocated = text.replace(/(?<=(?:\bfrom\s*|\bimport\s*\(\s*)["'])\.\.\/src\/[^"']+(?=["'])/gu, (from) => {
		const to = from.replace("../src/", "../../src/folds/kernel/");
		const previous = changes.get(from);
		changes.set(from, { from, to, count: (previous?.count ?? 0) + 1 });
		return to;
	});
	return { text: relocated, changes: [...changes.values()] };
}
