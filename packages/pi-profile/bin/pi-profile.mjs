#!/usr/bin/env node
// Prefer the built output; fall back to the TypeScript source (Node >= 24 strips types).
import { existsSync } from "node:fs";

const built = new URL("../dist/cli/main.js", import.meta.url);
const mod = await import(existsSync(built) ? built.href : new URL("../src/cli/main.ts", import.meta.url).href);
process.exitCode = mod.main(process.argv.slice(2), mod.processIo());
