import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The archive rules as model/Domain.bend states them (laws L27-L29), read as
 * text, so a change to the model's rules fails here and points at the code
 * tests to update. These checks read the model only, never the code:
 * tests/archive.test.ts proves the code does each of these.
 */
function bendDef(name: string): string {
	const text = readFileSync("model/Domain.bend", "utf8");
	const start = text.indexOf("def " + name + "(");
	assert.ok(start >= 0, name + " is in model/Domain.bend");
	const rest = text.slice(start).split("\n");
	const body: string[] = [rest[0] ?? ""];
	for (const line of rest.slice(1)) {
		if (line.length > 0 && !line.startsWith(" ")) break;
		body.push(line);
	}
	return body.join("\n");
}

describe("model/Domain.bend still states the archive rules the code is tested against", () => {
	it("archivePlan: a dry run only reports; only a matching copy leads to a stub (L27, L29)", () => {
		const d = bendDef("archivePlan");
		assert.match(d, /case True\{\}:\n\s+\[Report\{\}\]\n/);
		assert.equal((d.match(/Stub\{\}/g) ?? []).length, 1);
		assert.match(d, /case CopyMatches\{\}:\n\s+\[Report\{\}, Compress\{\}, Verified\{\}, Record\{\}, Stub\{\}\]/);
	});
	it("restoreAct: only a stub with no added lines is replaced (L28)", () => {
		const d = bendDef("restoreAct");
		assert.match(d, /case 0n:\n\s+ReplaceStub\{\}\n\s+case 1n\+n:\n\s+KeepBoth\{\}/);
	});
});
