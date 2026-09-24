import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "templates", "report");
const generator = path.join(root, "scripts", "make-report.mjs");
const glRefsHelper = path.join(root, "scripts", "gl-refs.mjs");

function runGenerator(args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
}

function runGlRefs(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [glRefsHelper, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeFixture(directory: string, body: string, metadata: Record<string, unknown>) {
  const bodyPath = path.join(directory, "body.html");
  const metadataPath = path.join(directory, "metadata.json");
  const outputPath = path.join(directory, "report.html");
  fs.writeFileSync(bodyPath, body);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { bodyPath, metadataPath, outputPath };
}

test("report templates and reader runtime expose the house-standard hooks", () => {
  const narrative = fs.readFileSync(path.join(templateDir, "narrative-template.html"), "utf8");
  const detailed = fs.readFileSync(path.join(templateDir, "detailed-template.html"), "utf8");
  const combined = fs.readFileSync(path.join(templateDir, "combined-template.html"), "utf8");
  const reader = fs.readFileSync(path.join(templateDir, "report-reader.js"), "utf8");
  const evidence = fs.readFileSync(path.join(templateDir, "report-evidence.js"), "utf8");
  const references = fs.readFileSync(path.join(templateDir, "report-gl-refs.js"), "utf8");
  const styles = fs.readFileSync(path.join(templateDir, "report-reader.css"), "utf8");

  for (const template of [narrative, detailed]) {
    assert.match(template, /href="#main-content"/);
    assert.match(template, /<nav class="report-toc"/);
    assert.match(template, /<main class="report-main" id="main-content"/);
    assert.match(template, /\{\{REPORT_TITLE\}\}/);
    assert.match(template, /\{\{REPORT_PROVENANCE\}\}/);
    assert.match(template, /\{\{REPORT_READING_TIME\}\}/);
    assert.match(template, /\{\{COMPANION_LINK\}\}/);
    assert.match(template, /\{\{REPORT_BODY\}\}/);
    assert.match(template, /\{\{REPORT_REFERENCE_RUNTIME\}\}/);
  }

  assert.match(narrative, /\{\{REPORT_READER\}\}/);
  assert.doesNotMatch(detailed, /\{\{REPORT_READER\}\}/);
  assert.match(narrative, /data-report-narrative/);
  assert.match(narrative, /pi-artifacts narrative report template v1\.1\.0/);
  assert.match(detailed, /pi-artifacts detailed report template v1\.1\.0/);
  assert.match(combined, /pi-artifacts combined report template v1\.1\.0/);
  assert.match(combined, /<main[^>]+data-report-narrative/);
  assert.match(combined, /id="report-evidence-pane"[^>]+hidden/);
  assert.match(combined, /aria-expanded="false" aria-controls="report-evidence-pane"/);
  assert.match(combined, /\{\{REPORT_EVIDENCE_TOC\}\}/);
  assert.match(combined, /\{\{REPORT_EVIDENCE\}\}/);
  assert.match(combined, /\{\{REPORT_EVIDENCE_RUNTIME\}\}/);
  assert.match(combined, /\{\{REPORT_REFERENCE_RUNTIME\}\}/);
  assert.match(combined, /<kbd>Alt<\/kbd> \+ <kbd>Shift<\/kbd> \+ <kbd>E<\/kbd>/);
  assert.match(reader, /pi-artifacts report reader v1\.3\.0/);
  assert.match(reader, /document\.querySelector\("\[data-report-narrative\]"\)/);
  assert.match(reader, /voiceschanged/);
  assert.match(reader, /beforeunload/);
  assert.match(reader, /pagehide/);
  assert.match(reader, /MAX_CHUNK_CHARS = 160/);
  assert.match(reader, /onboundary/);
  assert.match(reader, /aria-live="polite"/);
  assert.match(reader, /prefers-reduced-motion/);

  // The player must be dismissible, and the collapsed state must stay operable:
  // a hide control, a labelled launcher, a persisted preference, and a shortcut.
  assert.match(reader, /data-reader-action="hide"/);
  assert.match(reader, /data-reader-action="show"/);
  assert.match(reader, /pi-artifacts report reader v1\.3\.0/);
  assert.match(reader, /class="report-reader-launcher"/);
  assert.match(reader, /aria-controls="report-reader-panel"/);
  assert.match(reader, /aria-expanded="true"/);
  assert.match(reader, /STORAGE_HIDDEN = "pi-artifacts\.report-reader\.hidden\.v1"/);
  assert.match(reader, /function setPanelVisible/);
  assert.match(reader, /Hide or show this player/);
  // The live region and help dialog sit outside the collapsible panel so a
  // hidden player can still announce, and the aside keeps its own name.
  assert.match(reader, /reader\.setAttribute\("aria-label", "Audio reader"\)/);
  assert.match(
    reader,
    /<\/div>\s*<button type="button" class="report-reader-launcher"[\s\S]*?<span class="report-visually-hidden" data-reader-live/,
  );
  assert.match(evidence, /pi-artifacts report evidence pane v1\.1\.0/);
  assert.match(evidence, /event\.key\.toLowerCase\(\) !== "e"/);
  assert.match(evidence, /isTextEntryTarget\(event\.target\)/);
  assert.match(evidence, /new window\.IntersectionObserver/);
  assert.match(evidence, /evidenceScroll\.addEventListener\("scroll", handleEvidenceScroll/);
  assert.match(evidence, /setFollowEnabled\(false, "Follow narrative turned off because you chose an evidence section\."\)/);
  assert.match(evidence, /dataset\.evidenceOpen/);
  assert.doesNotMatch(evidence, /localStorage|sessionStorage/);
  assert.doesNotMatch(evidence, /speechSynthesis|\.cancel\(|\.pause\(/);
  assert.match(styles, /pi-artifacts report styles \+ reader v1\.3\.0/);
  assert.match(styles, /\.report-reader-panel \{/);
  assert.match(styles, /\.gl-ref-tooltip \{[\s\S]*?position: fixed;/);
  assert.match(styles, /\.gl-ref-tooltip::before \{[\s\S]*?content: attr\(data-gl-tooltip-meta\)/);
  assert.match(styles, /\.gl-ref-tooltip::after \{[\s\S]*?content: attr\(data-gl-tooltip-title\)/);
  assert.match(styles, /\.gl-ref-state-closed,[\s\S]*?color: var\(--report-muted\)/);
  assert.doesNotMatch(references, /!important/);
  assert.match(references, /pi-artifacts GitLab references v1\.0\.0/);
  assert.match(references, /reference\.removeAttribute\("title"\)/);
  assert.match(references, /event\.key === "Escape"/);
  assert.match(references, /reference\.addEventListener\("blur"/);
  assert.match(references, /document\.addEventListener\("scroll", schedulePosition, \{ capture: true/);
  assert.match(references, /window\.visualViewport/);
  assert.match(references, /getBoundingClientRect\(\)/);
  assert.match(styles, /\.report-reader \.report-reader-launcher \{/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
  assert.match(styles, /@media print/);
});

test("combined evidence skip link starts hidden and tracks pane visibility", () => {
  const combined = fs.readFileSync(path.join(templateDir, "combined-template.html"), "utf8");
  const evidence = fs.readFileSync(path.join(templateDir, "report-evidence.js"), "utf8");

  assert.match(
    combined,
    /<a class="report-skip-link report-evidence-skip-link" href="#report-evidence-content" hidden>Skip to evidence<\/a>/,
  );
  assert.match(evidence, /pane\.hidden = false;\s*evidenceSkipLink\.hidden = false;/);
  assert.match(evidence, /pane\.hidden = true;\s*evidenceSkipLink\.hidden = true;/);
});

test("narrative generator emits valid self-contained HTML with inline reader assets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-generator-"));
  const fixture = writeFixture(directory, `
<p>Opening context for the report.</p>
<section id="first"><h2>First &amp; foremost</h2><p>${"Evidence becomes a clear explanation. ".repeat(100)}</p></section>
<section id="second"><h2>Second step</h2><p>Finish with the consequence.</p></section>
`, {
    title: "Review <one> & two",
    deck: "A concise narrative.",
    date: "2026-08-05",
    provenance: "Deterministic smoke test",
    language: "en",
    companionHref: "review-detailed.html",
  });

  const result = runGenerator([
    "--kind", "narrative",
    "--body", fixture.bodyPath,
    "--meta", fixture.metadataPath,
    "--out", fixture.outputPath,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const html = fs.readFileSync(fixture.outputPath, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Review &lt;one&gt; &amp; two<\/title>/);
  assert.match(html, /<time datetime="2026-08-05">August 5, 2026<\/time>/);
  assert.match(html, /<li><a href="#first">First &amp; foremost<\/a><\/li>/);
  assert.match(html, /href="review-detailed\.html"/);
  assert.match(html, /pi-artifacts report styles \+ reader v1\.3\.0/);
  assert.match(html, /pi-artifacts report reader v1\.3\.0/);
  assert.match(html, /3 min read/);
  assert.match(html, /<section id="second">/);
  assert.match(html, /<\/body>\s*<\/html>\s*$/);
  assert.doesNotMatch(html, /\{\{(?:REPORT_|COMPANION_)/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=/i);
  assert.doesNotMatch(html, /<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["']https?:\/\//i);

  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(inlineScript, "generated narrative should contain an inline reader script");
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=commonjs"], {
    input: inlineScript,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("detailed generator uses the shared styles without adding the speech runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-detailed-"));
  const fixture = writeFixture(directory, `
<section id="evidence"><h2>Evidence</h2><div class="report-table-wrap"><table><tr><th>Item</th><td>Fact</td></tr></table></div></section>
`, {
    title: "Detailed evidence",
    deck: "Raw analysis.",
    date: "2026-08-05",
    provenance: "Deterministic smoke test",
    language: "en-GB",
    companionHref: "review-narrative.html",
  });

  const result = runGenerator([
    "--kind", "detailed",
    "--body", fixture.bodyPath,
    "--meta", fixture.metadataPath,
    "--out", fixture.outputPath,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const html = fs.readFileSync(fixture.outputPath, "utf8");
  assert.match(html, /class="report report-detailed"/);
  assert.match(html, /class="report-table-wrap"/);
  assert.match(html, /pi-artifacts report styles \+ reader v1\.3\.0/);
  assert.match(html, /href="review-narrative\.html"/);
  assert.doesNotMatch(html, /pi-artifacts report reader v1\.\d+\.\d+/);
  assert.doesNotMatch(html, /<script>/);
});

test("combined generator emits one self-contained narrative-first report with mapped evidence controls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-combined-"));
  const fixture = writeFixture(directory, `
<section id="first"><h2>First finding</h2><p>Narrative one.</p></section>
<section id="unmapped"><h2>Unmapped finding</h2><p>Narrative two.</p></section>
`, {
    title: "Combined analysis",
    deck: "Narrative first, evidence on demand.",
    date: "2026-08-05",
    provenance: "Deterministic smoke test",
    language: "en",
    companionHref: "ignored-detailed.html",
    evidenceMap: { first: ["evidence-one", "evidence-two"] },
  });
  const evidencePath = path.join(directory, "evidence.html");
  fs.writeFileSync(evidencePath, `
<section id="evidence-one"><h2>Evidence one</h2><p>Detailed fact one.</p></section>
<section id="evidence-two"><h2>Evidence two</h2><p>Detailed fact two.</p></section>
`);

  const result = runGenerator([
    "--kind", "combined",
    "--body", fixture.bodyPath,
    "--evidence", evidencePath,
    "--meta", fixture.metadataPath,
    "--out", fixture.outputPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: metadata\.companionHref is ignored for combined reports/);

  const html = fs.readFileSync(fixture.outputPath, "utf8");
  assert.match(html, /class="report report-combined"/);
  assert.match(html, /<aside class="report-evidence-pane" id="report-evidence-pane"[^>]* hidden>/);
  assert.match(html, /<section id="first">[\s\S]*?aria-label="Show evidence for: First finding">Evidence<\/button>/);
  assert.doesNotMatch(html, /data-narrative-section-id="unmapped"/);
  assert.match(html, /<section id="evidence-one">[\s\S]*?Detailed fact one\./);
  assert.match(html, /pi-artifacts report reader v1\.3\.0/);
  assert.match(html, /pi-artifacts report evidence pane v1\.1\.0/);
  assert.match(html, /event\.key\.toLowerCase\(\) !== "e"/);
  assert.match(html, /Toggle with <kbd>Alt<\/kbd> \+ <kbd>Shift<\/kbd> \+ <kbd>E<\/kbd>/);
  assert.doesNotMatch(html, /ignored-detailed\.html/);

  const primaryToc = html.match(/<nav class="report-toc"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(primaryToc);
  assert.match(primaryToc, /href="#first"/);
  assert.match(primaryToc, /href="#unmapped"/);
  assert.doesNotMatch(primaryToc, /href="#evidence-one"|href="#evidence-two"/);
  const evidenceToc = html.match(/<nav class="report-evidence-toc"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(evidenceToc);
  assert.match(evidenceToc, /href="#evidence-one"/);
  assert.match(evidenceToc, /href="#evidence-two"/);
  assert.doesNotMatch(evidenceToc, /href="#first"|href="#unmapped"/);

  const evidenceMarkup = html.match(/<div class="report-main report-evidence-content"[\s\S]*?<\/div>\s*<\/aside>/)?.[0];
  assert.ok(evidenceMarkup);
  assert.doesNotMatch(evidenceMarkup, /Read this section|Read from here|report-section-actions/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=/i);
  assert.doesNotMatch(html, /<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["']https?:\/\//i);

  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(inlineScripts.length, 2);
  for (const inlineScript of inlineScripts) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=commonjs"], {
      input: inlineScript,
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("combined generator names unknown evidenceMap ids and their expected fragments", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-combined-map-"));
  const fixture = writeFixture(directory, `
<section id="known-narrative"><h2>Known narrative</h2><p>Story.</p></section>
`, {
    title: "Invalid combined analysis",
    date: "2026-08-05",
    evidenceMap: {
      "missing-narrative": ["known-evidence"],
      "known-narrative": ["missing-evidence"],
    },
  });
  const evidencePath = path.join(directory, "evidence.html");
  fs.writeFileSync(evidencePath, `
<section id="known-evidence"><h2>Known evidence</h2><p>Fact.</p></section>
`);

  const result = runGenerator([
    "--kind", "combined",
    "--body", fixture.bodyPath,
    "--evidence", evidencePath,
    "--meta", fixture.metadataPath,
    "--out", fixture.outputPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /metadata\.evidenceMap contains unknown narrative section ids \(expected in narrative fragment\): missing-narrative; unknown evidence section ids \(expected in evidence fragment\): missing-evidence/,
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
});

test("GitLab references expand all kinds, upgrade URLs, encode state beyond color, preserve literal contexts, and keep tooltip text out of readable DOM", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-gl-refs-"));
  const fixture = writeFixture(directory, `
<section id="references"><h2>References</h2>
  <p>Bare #123.</p>
  <p><a data-gl-ref="#124" aria-describedby="old-description" aria-labelledby="old-label" title="old title">the closed issue</a></p>
  <p><a data-gl-ref="!2"></a> <a data-gl-ref="other/project!7">the merged change</a></p>
  <p><a data-gl-ref="@abcdef1"></a> <a data-gl-ref="reference-guide">the guide</a></p>
  <p><a href="https://gitlab.example.test/group/project/-/issues/123">author-supplied link text</a></p>
  <p><code>#123</code> <kbd>#123</kbd> <a href="#kept">#123</a></p>
  <pre><code>command --issue #123
output #123 stays literal</code></pre>
</section>
`, {
    title: "Reference report",
    date: "2026-08-05",
    companionHref: "reference-detailed.html",
  });
  const referencesPath = path.join(directory, "references.json");
  fs.writeFileSync(referencesPath, `${JSON.stringify({
    defaultProject: "group/project",
    references: {
      "#123": { kind: "issue", iid: 123, title: "Open issue", state: "opened", url: "https://gitlab.example.test/group/project/-/work_items/123" },
      "#124": { kind: "issue", iid: 124, title: "Closed issue", state: "closed", url: "https://gitlab.example.test/group/project/-/work_items/124" },
      "!2": { kind: "mr", iid: 2, title: "Open merge request", state: "opened", url: "https://gitlab.example.test/group/project/-/merge_requests/2" },
      "other/project!7": { kind: "mr", iid: 7, title: "Merged change", state: "merged", url: "https://gitlab.example.test/other/project/-/merge_requests/7", project: "other/project" },
      "@abcdef1": { kind: "commit", iid: "abcdef1", title: "Commit title", state: "committed", url: "https://gitlab.example.test/group/project/-/commit/abcdef1" },
      "reference-guide": { kind: "external", iid: "guide", title: "Reference guide", state: "available", url: "https://gitlab.example.test/help/guide" },
    },
  }, null, 2)}\n`);

  const result = runGenerator([
    "--kind", "narrative",
    "--body", fixture.bodyPath,
    "--meta", fixture.metadataPath,
    "--references", referencesPath,
    "--out", fixture.outputPath,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const html = fs.readFileSync(fixture.outputPath, "utf8");
  assert.match(html, /class="gl-ref gl-ref-issue gl-ref-state-open"/);
  assert.match(html, /class="gl-ref gl-ref-issue gl-ref-state-closed"/);
  assert.match(html, /class="gl-ref gl-ref-mr gl-ref-state-open"/);
  assert.match(html, /class="gl-ref gl-ref-mr gl-ref-state-merged"/);
  assert.match(html, /class="gl-ref gl-ref-commit gl-ref-state-committed"/);
  assert.match(html, /class="gl-ref gl-ref-external gl-ref-state-available"/);
  const iconFor = (kind: string, state: string) => {
    const match = html.match(new RegExp(`class="gl-ref gl-ref-${kind} gl-ref-state-${state}"[^>]*>(<svg[\\s\\S]*?</svg>)`));
    assert.ok(match, `missing ${kind}/${state} reference icon`);
    return match[1];
  };
  assert.notEqual(iconFor("issue", "open"), iconFor("issue", "closed"));
  assert.notEqual(iconFor("mr", "open"), iconFor("mr", "merged"));
  assert.match(html, /aria-label="Issue #123: Open issue — open" title="Issue #123: Open issue — open"/);
  assert.match(html, /aria-label="Issue #124: Closed issue — closed"/);
  assert.match(html, /aria-label="Merge request !7: Merged change — merged"/);
  assert.match(html, /aria-label="Commit @abcdef1: Commit title — committed"/);
  assert.match(html, /aria-label="Reference guide: Reference guide — available"/);
  assert.match(html, /class="gl-ref-tooltip" data-gl-tooltip-meta="Issue #123 · open" data-gl-tooltip-title="Open issue" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /class="gl-ref-tooltip"[^>]*>[^<]+<\/span>/);
  assert.doesNotMatch(html, /<a class="gl-ref[^>]+aria-describedby=/);
  assert.doesNotMatch(html, /<a class="gl-ref[^>]+aria-labelledby=/);
  assert.doesNotMatch(html, /old title/);
  assert.match(html, /<span class="gl-ref-text">the closed issue<\/span>/);
  assert.match(html, /<span class="gl-ref-text">author-supplied link text<\/span>/);
  assert.match(html, /href="https:\/\/gitlab\.example\.test\/group\/project\/-\/work_items\/123" data-gl-ref="#123"/);
  assert.match(html, /Bare <a class="gl-ref[\s\S]*?<\/a>\.<\/p>/);
  assert.match(html, /<code>#123<\/code>/);
  assert.match(html, /<kbd>#123<\/kbd>/);
  assert.match(html, /<a href="#kept">#123<\/a>/);
  assert.match(html, /<pre><code>command --issue #123\noutput #123 stays literal<\/code><\/pre>/);
  assert.match(html, /pi-artifacts GitLab references v1\.0\.0/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=/i);
  assert.doesNotMatch(html, /<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["']https?:\/\//i);
});

test("generator fails closed on an unknown GitLab token and names its source file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-gl-ref-unknown-"));
  const fixture = writeFixture(directory, `
<section id="unknown"><h2>Unknown reference</h2><p>Bare #999 must fail.</p></section>
`, {
    title: "Unknown reference",
    date: "2026-08-05",
    companionHref: "unknown-detailed.html",
  });
  const referencesPath = path.join(directory, "references.json");
  fs.writeFileSync(referencesPath, `${JSON.stringify({
    defaultProject: "group/project",
    references: {
      "#123": { kind: "issue", iid: 123, title: "Known", state: "opened", url: "https://gitlab.example.test/group/project/-/work_items/123" },
    },
  })}\n`);

  const result = runGenerator([
    "--kind", "narrative",
    "--body", fixture.bodyPath,
    "--meta", fixture.metadataPath,
    "--references", referencesPath,
    "--out", fixture.outputPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown GitLab reference #999/);
  assert.ok(result.stderr.includes(fixture.bodyPath), result.stderr);
  assert.equal(fs.existsSync(fixture.outputPath), false);
});

test("generator rejects remote or unresolved report resources", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-remote-"));
  const fixture = writeFixture(directory, `
<section id="remote"><h2>Remote dependency</h2><img src=https://cdn.example.test/chart.png alt="Chart" /></section>
`, {
    title: "Unsafe report",
    deck: "Should fail.",
    date: "2026-08-05",
    provenance: "Deterministic smoke test",
    language: "en",
    companionHref: "safe-detailed.html",
  });

  const result = runGenerator([
    "--kind", "narrative",
    "--body", fixture.bodyPath,
    "--meta", fixture.metadataPath,
    "--out", fixture.outputPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remote resource|data URL/);
  assert.equal(fs.existsSync(fixture.outputPath), false);
});

test("gl-refs helper bulk-loads issues, falls back to issue view, merges, and refreshes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gl-refs-helper-"));
  const fakeGlab = path.join(directory, "glab");
  const logPath = path.join(directory, "glab.log");
  fs.writeFileSync(fakeGlab, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GLAB_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "auth") process.exit(0);
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ iid: 30, title: "Bulk issue", state: "opened", web_url: "https://gitlab.example.test/group/project/-/work_items/30" }]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view" && args[2] === "29") {
  process.stdout.write(JSON.stringify({ iid: 29, title: "Fallback work item", state: "opened", web_url: "https://gitlab.example.test/group/project/-/work_items/29" }));
  process.exit(0);
}
process.stderr.write("unexpected fake glab call: " + args.join(" "));
process.exit(2);
`);
  fs.chmodSync(fakeGlab, 0o755);
  const fragmentPath = path.join(directory, "fragment.html");
  const outputPath = path.join(directory, "references.json");
  fs.writeFileSync(fragmentPath, `<section id="x"><h2>X</h2><p>Fallback #29 and bulk #30.</p><pre>#29</pre></section>\n`);

  const result = runGlRefs([
    "--project", "group/project",
    "--out", outputPath,
    fragmentPath,
  ], { GLAB: fakeGlab, GLAB_LOG: logPath });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(manifest.references["#29"].title, "Fallback work item");
  assert.equal(manifest.references["#30"].title, "Bulk issue");
  const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const issueList = calls.find((args) => args[0] === "issue" && args[1] === "list");
  assert.ok(issueList);
  assert.ok(issueList.includes("--all"));
  // --all (-A) includes open and closed; --closed (-c) would select only closed.
  assert.equal(issueList.includes("--closed"), false);
  assert.equal(issueList.includes("--state"), false);
  assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "view" && args[2] === "29"));

  manifest.references["#30"].title = "Stale title";
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(fragmentPath, `<section id="x"><h2>X</h2><p>Refresh #30.</p></section>\n`);
  const refresh = runGlRefs([
    "--project", "group/project",
    "--out", outputPath,
    "--refresh",
    fragmentPath,
  ], { GLAB: fakeGlab, GLAB_LOG: logPath });
  assert.equal(refresh.status, 0, refresh.stderr);
  const refreshed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(refreshed.references["#30"].title, "Bulk issue");
  assert.equal(refreshed.references["#29"].title, "Fallback work item");
});

test("gl-refs helper fails loudly on authentication failure without changing the manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gl-refs-auth-"));
  const fakeGlab = path.join(directory, "glab");
  fs.writeFileSync(fakeGlab, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  process.stderr.write("not authenticated");
  process.exit(1);
}
process.exit(2);
`);
  fs.chmodSync(fakeGlab, 0o755);
  const fragmentPath = path.join(directory, "fragment.html");
  const outputPath = path.join(directory, "references.json");
  fs.writeFileSync(fragmentPath, `<section id="x"><h2>X</h2><p>Missing #29.</p></section>\n`);
  const original = `${JSON.stringify({
    defaultProject: "group/project",
    references: {
      "#30": { kind: "issue", iid: 30, title: "Existing", state: "opened", url: "https://gitlab.example.test/group/project/-/work_items/30" },
    },
  }, null, 2)}\n`;
  fs.writeFileSync(outputPath, original);

  const result = runGlRefs([
    "--project", "group/project",
    "--out", outputPath,
    fragmentPath,
  ], { GLAB: fakeGlab });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /glab authentication failed: not authenticated/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), original);
});

test("gl-refs helper does not write records fetched before a later fallback fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gl-refs-partial-"));
  const fakeGlab = path.join(directory, "glab");
  fs.writeFileSync(fakeGlab, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth") process.exit(0);
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ iid: 31, title: "Fetched first", state: "opened", web_url: "https://gitlab.example.test/group/project/-/work_items/31" }]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  process.stderr.write("individual lookup failed");
  process.exit(1);
}
process.exit(2);
`);
  fs.chmodSync(fakeGlab, 0o755);
  const fragmentPath = path.join(directory, "fragment.html");
  const outputPath = path.join(directory, "references.json");
  fs.writeFileSync(fragmentPath, `<section id="x"><h2>X</h2><p>Listed #31 then missing #29.</p></section>\n`);
  const original = `${JSON.stringify({
    defaultProject: "group/project",
    references: {
      "#30": { kind: "issue", iid: 30, title: "Existing", state: "opened", url: "https://gitlab.example.test/group/project/-/work_items/30" },
    },
  }, null, 2)}\n`;
  fs.writeFileSync(outputPath, original);

  const result = runGlRefs([
    "--project", "group/project",
    "--out", outputPath,
    fragmentPath,
  ], { GLAB: fakeGlab });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not fetch #29.*individual lookup failed/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), original);
});

test("committed demonstration reports are reproducible", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-report-examples-"));
  const examples = [
    { kind: "narrative", body: "narrative-body.html", meta: "narrative-meta.json", references: "gl-references.json" },
    { kind: "detailed", body: "detailed-body.html", meta: "detailed-meta.json" },
    { kind: "combined", body: "narrative-body.html", evidence: "detailed-body.html", meta: "combined-meta.json", references: "gl-references.json" },
  ];
  for (const example of examples) {
    const outputPath = path.join(directory, `demo-${example.kind}.html`);
    const result = runGenerator([
      "--kind", example.kind,
      "--body", path.join(root, "examples", "reports", example.body),
      ...(example.evidence
        ? ["--evidence", path.join(root, "examples", "reports", example.evidence)]
        : []),
      ...(example.references
        ? ["--references", path.join(root, "examples", "reports", example.references)]
        : []),
      "--meta", path.join(root, "examples", "reports", example.meta),
      "--out", outputPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const generated = fs.readFileSync(outputPath, "utf8");
    assert.equal(
      generated,
      fs.readFileSync(path.join(root, "examples", "reports", `demo-${example.kind}.html`), "utf8"),
    );
    if (example.kind === "combined") {
      assert.match(generated, /aria-label="Issue #123: Demonstrate report references without a network dependency — open"/);
    }
  }
});
