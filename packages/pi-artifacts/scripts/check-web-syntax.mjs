import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const standaloneScriptDirs = [webDir, path.join(root, "templates", "report")];

function check(source, label, args = ["--check", "--input-type=module"]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    input: source,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`web syntax error in ${label}\n${result.stderr || result.stdout}`);
    process.exitCode = 1;
  }
}

for (const name of fs.readdirSync(webDir).filter((entry) => entry.endsWith(".html")).sort()) {
  const html = fs.readFileSync(path.join(webDir, name), "utf8");
  const modules = [...html.matchAll(/<script\s+type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  modules.forEach((match, index) => check(match[1], `${name} inline module #${index + 1}`));
}

for (const directory of standaloneScriptDirs) {
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".js")).sort()) {
    const file = path.join(directory, name);
    check(undefined, path.relative(root, file), ["--check", file]);
  }
}

if (!process.exitCode) console.log("web syntax ok");
