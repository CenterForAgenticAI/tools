#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// `npm run` exports user config such as allow-scripts, which npm rejects in the nested project install.
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"));
const temp = mkdtempSync(path.join(os.tmpdir(), "pi-dev-package-smoke-"));
try {
  const packDir = path.join(temp, "pack");
  const installDir = path.join(temp, "install");
  mkdirSync(packDir);
  mkdirSync(installDir);
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const manifestEntry = packageJson.pi?.extensions?.[0];
  if (manifestEntry !== "./index.ts") throw new Error("package manifest must load ./index.ts");
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...(packageJson.bundleDependencies ?? []),
  ];
  if (dependencyNames.some((name) => name.includes("pi-artifacts"))) {
    throw new Error("pi-dev must not depend on pi-artifacts in any form");
  }
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], { cwd: root, encoding: "utf8" }))[0];
  execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(packDir, packed.filename)], { cwd: installDir, stdio: "inherit", env: npmEnv });
  const installed = path.join(installDir, "node_modules", packageJson.name);
  if (!existsSync(path.join(installed, "index.ts"))) throw new Error("packed pi-dev is missing index.ts");
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const root = await import(${JSON.stringify(packageJson.name)}); if (typeof root.runDoctor !== "function") throw new Error("installed root export has no runDoctor function"); const testing = await import(${JSON.stringify(`${packageJson.name}/testing`)}); if (typeof testing.conformanceContext !== "function") throw new Error("installed testing export has no conformanceContext function");`,
  ], { cwd: installDir, stdio: "inherit" });
  const require = createRequire(import.meta.url);
  const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const jitiPath = require.resolve("jiti", { paths: [path.dirname(codingAgentEntry)] });
  const { createJiti } = await import(jitiPath);
  const extension = await createJiti(installDir).import(path.join(installed, "index.ts"));
  if (typeof extension.default !== "function") throw new Error("installed extension has no default factory");
  console.log("package/jiti smoke: ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
