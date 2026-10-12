import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commands } from "../src/commands.ts";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function run(args: readonly string[], cwd: string) {
	return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
}

describe("agent-definitions command", () => {
	it("registers exactly the convert and lint subcommands", () => {
		assert.deepEqual(Object.keys(commands).sort(), ["convert", "lint"]);
	});

	it("prints usage and exits 2 without a subcommand", () => {
		const result = run([], process.cwd());
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "Usage: agent-definitions <command> [options]\nCommands: convert, lint\n");
	});

	it("runs lint from the process working directory and passes its exit status through", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-definitions-bin-"));
		try {
			writeFileSync(join(dir, "good.md"), "---\nname: good\ndescription: Good agent.\n---\nWork.\n");
			writeFileSync(join(dir, "bad.md"), "---\nname: bad\n---\nWork.\n");
			const good = run(["lint", "good.md"], dir);
			assert.equal(good.status, 0, good.stderr);
			const bad = run(["lint", "bad.md"], dir);
			assert.equal(bad.status, 1);
			assert.match(bad.stdout + bad.stderr, /description/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
