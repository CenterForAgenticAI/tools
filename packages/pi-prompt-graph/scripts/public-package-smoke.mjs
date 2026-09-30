#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(packageJson.name, "@centerforagenticai/pi-prompt-graph", "run this smoke test in the cleaned public export");
assert.deepEqual(packageJson.pi?.extensions, ["./dist/index.js"], "the public manifest must declare the built extension");

const extensionPath = join(root, packageJson.pi.extensions[0]);
const extensionModule = await import(pathToFileURL(extensionPath).href);
assert.equal(typeof extensionModule.default, "function", "the declared extension must export a default loader");

const commands = new Map();
const tools = new Map();
const listeners = new Map();
extensionModule.default({
  on(event, listener) {
    listeners.set(event, listener);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
});
assert.ok(commands.has("graph"), "loading the manifest extension must register /graph");
assert.ok(tools.has("graph_transition"), "loading the manifest extension must register graph_transition");
assert.ok(listeners.has("tool_call"), "loading the manifest extension must install its tool guard");

const parserModule = await import(pathToFileURL(join(root, "dist/pure/parser.js")).href);
const shorthandExample = await readFile(join(root, "examples/fix-until-green.md"), "utf8");
const shorthandSection = shorthandExample.match(/## Shorthand\s+```yaml\s+([\s\S]*?)```/)?.[1];
const shorthand = shorthandSection?.match(/^graph:\s*(.+)$/m)?.[1];
assert.ok(shorthand, "fix-until-green.md must include its shorthand form");
const parsed = parserModule.parseShorthand(shorthand);
assert.ok(parsed.body, `the built parser must accept the exported shorthand: ${JSON.stringify(parsed.diagnostics)}`);
assert.equal(parsed.body.nodes.verify.limit, 3);
assert.equal(parsed.body.nodes.verify.onLimit, "fail");
assert.equal(parsed.body.nodes.verify.on?.fail, "implement");

const compilerModule = await import(pathToFileURL(join(root, "dist/pure/compiler.js")).href);
const examplesRoot = join(root, "examples");
const exampleFiles = (await readdir(examplesRoot)).filter((name) => name.endsWith(".md") && name !== "README.md").sort();
assert.deepEqual(exampleFiles, ["fix-until-green.md", "release-gate.md", "review-revise.md", "scan-consolidate.md"]);
for (const file of exampleFiles) {
  const text = await readFile(join(examplesRoot, file), "utf8");
  const document = parseFrontmatter(text).frontmatter;
  const result = compilerModule.compile({
    document,
    bodyBytes: Buffer.byteLength(text),
    origin: { scope: "project", path: `examples/${file}`, sha256: "0".repeat(64) },
  });
  assert.ok(result.graph, `${file} must compile from the public tarball: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"), false, `${file} must have no compiler errors`);
}

const command = commands.get("graph");
const notifications = [];
const ctx = { cwd: root, ui: { notify(message) { notifications.push(message); } } };
await command.handler("check public-smoke-missing", ctx);
assert.match(notifications.at(-1) ?? "", /Graph public-smoke-missing was not found\./, "the loaded command must execute, not merely register");

process.stdout.write(`public-package smoke passed: ${basename(extensionPath)}, parser, ${exampleFiles.length} examples\n`);
