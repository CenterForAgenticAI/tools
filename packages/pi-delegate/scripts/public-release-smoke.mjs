#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

assert.equal(manifest.name, "@centerforagenticai/pi-delegate");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.optionalDependencies, undefined);
assert.equal(manifest.peerDependenciesMeta, undefined);
assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

for (const entries of Object.values(manifest.pi ?? {})) {
  for (const entry of entries) await access(path.join(root, entry));
}

const runtime = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
const escalations = await import(pathToFileURL(path.join(root, "dist", "escalation-api.js")).href);
const skillResource = await import(pathToFileURL(path.join(root, "dist", "skill-resource.js")).href);
assert.equal(typeof runtime.delegateFromCli, "function");
assert.equal(typeof runtime.hasActiveDelegateWork, "function");
assert.equal(typeof escalations.inspectEscalations, "function");
assert.equal(typeof escalations.resolveOperatorEscalation, "function");
assert.equal(typeof skillResource.resolveSkillResource, "function");
assert.equal(typeof skillResource.bundledSkillPath, "function");

console.log("public release smoke passed");
