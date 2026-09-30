#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

if (pkg.type !== "module") {
  throw new Error('package.json must set "type": "module" so built extension output is ESM.');
}

if (!Array.isArray(pkg.pi?.extensions) || !pkg.pi.extensions.includes("./index.ts")) {
  throw new Error('package.json pi.extensions must explicitly include "./index.ts".');
}

if (pkg.exports?.["./integration-seam"] !== "./integration-seam.ts") {
  throw new Error('package.json must export the documented "./integration-seam" subpath.');
}

for (const file of ["dist/index.js", "dist/integration-seam.js", "dist/logic.js", "dist/thinking-policy.js"]) {
  if (!existsSync(file)) {
    throw new Error(`${file} was not emitted by npm run build.`);
  }
}

await import(new URL("../dist/logic.js", import.meta.url));
await import(new URL("../dist/integration-seam.js", import.meta.url));
await import(new URL("../dist/thinking-policy.js", import.meta.url));
const builtExtension = await import(new URL("../dist/index.js", import.meta.url));

if (typeof builtExtension.default !== "function") {
  throw new Error("dist/index.js must default-export the Pi extension registration function.");
}

const registered = { tools: new Set(), commands: new Set(), shortcuts: new Set(), events: [] };
builtExtension.default({
  on(name) {
    registered.events.push(name);
  },
  registerTool(tool) {
    registered.tools.add(tool.name);
  },
  registerCommand(name) {
    registered.commands.add(name);
  },
  registerShortcut(shortcut) {
    registered.shortcuts.add(shortcut.toLowerCase());
  },
  setThinkingLevel() {},
  getThinkingLevel() {
    return "medium";
  },
  appendEntry() {},
});

if (!registered.tools.has("set_thinking_effort")) {
  throw new Error("built extension did not register set_thinking_effort.");
}

for (const command of ["thinking-baseline", "thinking-status", "thinking-bounds", "thinking-reset", "thinking-toggle", "thinking-higher", "thinking-lower"]) {
  if (!registered.commands.has(command)) {
    throw new Error(`built extension did not register /${command}.`);
  }
}

for (const shortcut of ["alt+.", "alt+,"]) {
  if (!registered.shortcuts.has(shortcut)) {
    throw new Error(`built extension did not register shortcut ${shortcut}.`);
  }
}
// Terminals and window managers swallow these, so they must stay unregistered.
for (const shortcut of ["shift+tab", "alt+shift+tab", "ctrl+shift+tab"]) {
  if (registered.shortcuts.has(shortcut)) {
    throw new Error(`built extension must not register unreachable shortcut ${shortcut}.`);
  }
}

const npmPackJson = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const [pack] = JSON.parse(npmPackJson);
const files = new Set(pack.files.map((entry) => entry.path));

if (existsSync(pack.filename)) {
  throw new Error(`npm pack --dry-run unexpectedly created ${pack.filename}.`);
}

for (const expected of ["index.ts", "integration-seam.ts", "logic.ts", "thinking-policy.ts", "package.json", "README.md"]) {
  if (!files.has(expected)) {
    throw new Error(`npm pack dry-run is missing ${expected}.`);
  }
}

console.log(`Package smoke passed: ${pack.filename} (${pack.files.length} files in dry-run).`);
