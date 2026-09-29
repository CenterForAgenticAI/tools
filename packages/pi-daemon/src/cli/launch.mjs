#!/usr/bin/env node

import "../daemon/source-hooks.mjs";

const { runCli } = await import("./index.js");
const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
