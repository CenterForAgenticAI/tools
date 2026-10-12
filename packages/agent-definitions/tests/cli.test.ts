import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCli, USAGE_EXIT, type Command, type CommandIO } from "../src/cli.ts";

function capture(): { io: CommandIO; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { cwd: "/work", stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
}

const usage = "Usage: agent-definitions <command> [options]\nCommands: alpha, lint\n";

describe("runCli", () => {
	const calls: { args: readonly string[]; cwd: string }[] = [];
	const lint: Command = async (args, io) => {
		calls.push({ args, cwd: io.cwd });
		io.stdout("linted\n");
		return 1;
	};
	const alpha: Command = async () => 0;
	const commands = { lint, alpha };

	it("passes the remaining arguments and the io to the named command and returns its status", async () => {
		const { io, out, err } = capture();
		assert.equal(await runCli(["lint", "a.md", "--json"], io, commands), 1);
		assert.deepEqual(calls, [{ args: ["a.md", "--json"], cwd: "/work" }]);
		assert.deepEqual(out, ["linted\n"]);
		assert.deepEqual(err, []);
	});

	it("prints usage to stderr with exit status 2 when no command is given", async () => {
		const { io, out, err } = capture();
		assert.equal(await runCli([], io, commands), USAGE_EXIT);
		assert.equal(USAGE_EXIT, 2);
		assert.deepEqual(out, []);
		assert.deepEqual(err, [usage]);
	});

	for (const flag of ["help", "--help", "-h"]) {
		it(`prints sorted usage to stdout with exit status 0 for ${flag}`, async () => {
			const { io, out, err } = capture();
			assert.equal(await runCli([flag], io, commands), 0);
			assert.deepEqual(out, [usage]);
			assert.deepEqual(err, []);
		});
	}

	for (const name of ["lnt", "constructor", "__proto__", "toString"]) {
		it(`rejects ${name} as an unknown command, including inherited object keys`, async () => {
			const { io, out, err } = capture();
			assert.equal(await runCli([name], io, commands), 2);
			assert.deepEqual(out, []);
			assert.deepEqual(err, [`Unknown command "${name}".\n${usage}`]);
		});
	}
});
