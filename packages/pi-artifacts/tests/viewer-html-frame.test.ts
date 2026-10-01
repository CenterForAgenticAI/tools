import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewer = fs.readFileSync(path.join(root, "web", "view.html"), "utf8");

function functionSource(name: string) {
  const start = viewer.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = viewer.indexOf("\nfunction ", start + 1);
  return viewer.slice(start, end === -1 ? undefined : end);
}

test("HTML artifact frame lets authored links open new tabs outside annotation mode only", () => {
  const renderHtml = functionSource("renderHtml");
  assert.match(renderHtml, /<iframe id="htmlframe"[^>]*sandbox="\$\{sandbox\}"/, "the frame takes its sandbox from one computed value");
  const reading = /const sandbox = annotationActive\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/.exec(renderHtml);
  assert.ok(reading, "sandbox depends on annotation mode");
  const [annotating, normal] = [new Set(reading[1].split(/\s+/)), new Set(reading[2].split(/\s+/))];
  assert.deepEqual(normal, new Set(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]), "reading mode: links open a normal new tab");
  assert.deepEqual(annotating, new Set(["allow-scripts"]), "annotation mode keeps link navigation disabled");
  for (const token of [...normal, ...annotating]) {
    assert.doesNotMatch(token, /^allow-(same-origin|top-navigation|forms|modals|downloads)/, `${token} must not widen the artifact's own powers`);
  }
  assert.match(functionSource("renderBrowserContent"), /<iframe class="htmlframe" sandbox src=/, "generic browser content keeps an empty, fully restrictive sandbox");
});
