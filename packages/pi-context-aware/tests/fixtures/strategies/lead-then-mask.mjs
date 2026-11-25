#!/usr/bin/env node
/**
 * mask-last-K behind a lead plan, for tests/strategy-conformance.test.ts (pi-context-aware#470). It runs
 * mask-last-k.mjs on the same request and answers with its plans, after the lead its one argument names:
 * `say` puts a say-only plan first, `empty` an empty plan, and `repeat` sends the stub plan twice. With no
 * argument it answers as mask-last-k does. The bench must check every plan of the reply, so each variant
 * hides the same entries as mask-last-k alone.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const mask = spawnSync(process.execPath, [fileURLToPath(new URL("./mask-last-k.mjs", import.meta.url))], { input: Buffer.concat(chunks), stdio: ["pipe", "pipe", "ignore"] });
if (mask.status !== 0) process.exit(mask.status ?? 1);
const { plans } = JSON.parse(mask.stdout.toString("utf8"));
const lead = process.argv[2] === "say" ? [[{ kind: "say", text: "Older tool results are masked." }]] : process.argv[2] === "empty" ? [[]] : [];
const tail = process.argv[2] === "repeat" ? [...plans, ...plans] : plans;
process.stdout.write(`${JSON.stringify({ plans: [...lead, ...tail] })}\n`);
