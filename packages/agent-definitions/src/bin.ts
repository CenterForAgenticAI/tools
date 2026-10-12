#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { commands } from "./commands.ts";

process.exitCode = await runCli(
	process.argv.slice(2),
	{
		cwd: process.cwd(),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	},
	commands,
);
