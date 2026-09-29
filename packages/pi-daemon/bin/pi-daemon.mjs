#!/usr/bin/env node

const { runCli } = await import("../dist/cli/index.js");
const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
