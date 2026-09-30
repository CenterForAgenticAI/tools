import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("..", import.meta.url));
const lintFile = path.join(root, ".test-dist", "lint-contract.ts");

async function lintText(source: string) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: path.join(root, "eslint.config.js"),
    overrideConfig: [{ languageOptions: { parserOptions: { projectService: false } } }],
    ignore: false,
  });
  return eslint.lintText(source, { filePath: lintFile });
}

test("unused eslint-disable directives are errors", async () => {
  const results = await lintText("// eslint-disable-next-line no-console\nexport const value = 1;\n");
  const messages = results.flatMap((result) => result.messages);
  assert.ok(messages.some((message) => message.severity === 2 && message.message.includes("Unused eslint-disable directive")));
});

test("corrected lint source is clean", async () => {
  const results = await lintText("export const value = 1;\n");
  assert.deepEqual(results.flatMap((result) => result.messages), []);
});
