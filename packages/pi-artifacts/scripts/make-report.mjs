#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeReferenceManifest, transformGitLabReferences } from "./report-gl-refs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "templates", "report");
const validKinds = new Set(["narrative", "detailed", "combined"]);

export function generateReport({
  kind,
  body,
  evidence = "",
  metadata,
  references = null,
  bodySource = "report body",
  evidenceSource = "evidence fragment",
  referencesSource = "reference manifest",
}) {
  if (!validKinds.has(kind)) throw new Error("kind must be narrative, detailed, or combined");
  if (typeof body !== "string" || !body.trim()) throw new Error("report body must not be empty");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata must be an object");
  if (kind === "combined" && (typeof evidence !== "string" || !evidence.trim())) {
    throw new Error("combined report evidence must not be empty");
  }

  const normalized = normalizeMetadata(metadata, kind);
  assertSelfContainedBody(body);
  if (kind === "combined") assertSelfContainedBody(evidence);

  const narrativeSections = inspectSections(body, kind === "combined" ? "narrative fragment" : "report body");
  const evidenceSections = kind === "combined" ? inspectSections(evidence, "evidence fragment") : [];
  const referenceManifest = references ? normalizeReferenceManifest(references, referencesSource) : null;
  let renderedBody = body;
  let renderedEvidence = evidence;
  let evidenceMap = {};
  if (kind === "combined") {
    evidenceMap = normalizeEvidenceMap(metadata.evidenceMap);
    validateEvidenceMap(evidenceMap, narrativeSections, evidenceSections);
    assertCombinedIdsAreUnique(narrativeSections, evidenceSections);
    renderedBody = addEvidenceButtons(body, evidenceMap, narrativeSections);
  }

  const bodyReferences = transformGitLabReferences(renderedBody, referenceManifest, bodySource);
  renderedBody = bodyReferences.html.trim();
  let referenceCount = bodyReferences.count;
  if (kind === "combined") {
    const evidenceReferences = transformGitLabReferences(renderedEvidence, referenceManifest, evidenceSource);
    renderedEvidence = evidenceReferences.html.trim();
    referenceCount += evidenceReferences.count;
  }

  const templatePath = path.join(templateDir, `${kind}-template.html`);
  const template = fs.readFileSync(templatePath, "utf8");
  const styles = fs.readFileSync(path.join(templateDir, "report-reader.css"), "utf8").trim();
  const reader = kind === "narrative" || kind === "combined"
    ? escapeInlineScript(fs.readFileSync(path.join(templateDir, "report-reader.js"), "utf8").trim())
    : "";
  const evidenceRuntime = kind === "combined"
    ? escapeInlineScript(fs.readFileSync(path.join(templateDir, "report-evidence.js"), "utf8").trim())
    : "";
  const referenceRuntime = referenceCount
    ? `<script>\n${escapeInlineScript(fs.readFileSync(path.join(templateDir, "report-gl-refs.js"), "utf8").trim())}\n  </script>`
    : "";

  const replacements = {
    REPORT_LANGUAGE: escapeHtml(normalized.language),
    REPORT_TITLE: escapeHtml(normalized.title),
    REPORT_DECK: escapeHtml(normalized.deck),
    REPORT_DATE_ISO: escapeHtml(normalized.dateIso),
    REPORT_DATE_DISPLAY: escapeHtml(formatDate(normalized.dateIso, normalized.language)),
    REPORT_PROVENANCE: escapeHtml(normalized.provenance),
    REPORT_READING_TIME: escapeHtml(readingTime(body)),
    COMPANION_LINK: companionLink(normalized),
    REPORT_TOC: makeTocFromSections(narrativeSections),
    REPORT_STYLES: styles,
    REPORT_READER: reader,
    REPORT_BODY: renderedBody,
    REPORT_EVIDENCE: kind === "combined" ? renderedEvidence : "",
    REPORT_EVIDENCE_TOC: kind === "combined" ? makeTocFromSections(evidenceSections) : "",
    REPORT_EVIDENCE_MAP: kind === "combined" ? inlineJson(evidenceMap) : "",
    REPORT_EVIDENCE_RUNTIME: evidenceRuntime,
    REPORT_REFERENCE_RUNTIME: referenceRuntime,
  };

  let output = template;
  for (const [name, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{{${name}}}`, value);
  }

  const unresolved = output.match(/\{\{[A-Z][A-Z_]+\}\}/);
  if (unresolved) throw new Error(`template placeholder was not replaced: ${unresolved[0]}`);
  assertNoRemoteResourceReferences(output);
  return output.endsWith("\n") ? output : `${output}\n`;
}

export function makeToc(body) {
  return makeTocFromSections(inspectSections(body, "report body"));
}

function inspectSections(body, fragmentName) {
  const openings = [...body.matchAll(/<section\b([^>]*)>/gi)];
  if (!openings.length) throw new Error(`${fragmentName} must contain at least one <section id="…"> element`);

  const seen = new Set();
  return openings.map((opening, index) => {
    const attributes = opening[1];
    const idMatch = attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i);
    if (!idMatch || !idMatch[2].trim()) {
      throw new Error(`every section in the ${fragmentName} must have a quoted, non-empty id`);
    }
    const id = idMatch[2].trim();
    if (seen.has(id)) throw new Error(`duplicate section id in ${fragmentName}: ${id}`);
    seen.add(id);

    const contentStart = opening.index + opening[0].length;
    const contentEnd = index + 1 < openings.length ? openings[index + 1].index : body.length;
    const sectionStart = body.slice(contentStart, contentEnd);
    const heading = sectionStart.match(/<h([2-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
    if (!heading) throw new Error(`section ${id} in ${fragmentName} must contain a heading`);
    const label = plainText(heading[2]);
    if (!label) throw new Error(`section ${id} in ${fragmentName} must have non-empty heading text`);
    const headingStart = contentStart + heading.index;
    return {
      id,
      label,
      headingEnd: headingStart + heading[0].length,
    };
  });
}

function makeTocFromSections(sections) {
  const items = sections.map(({ id, label }) => (
    `      <li><a href="#${escapeHtml(id)}">${escapeHtml(label)}</a></li>`
  ));
  return `    <ol>\n${items.join("\n")}\n    </ol>`;
}

function normalizeEvidenceMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata.evidenceMap must be an object mapping narrative section ids to arrays of evidence section ids");
  }

  const normalized = Object.create(null);
  for (const [rawNarrativeId, rawEvidenceIds] of Object.entries(value)) {
    const narrativeId = rawNarrativeId.trim();
    if (!narrativeId) throw new Error("metadata.evidenceMap must not contain an empty narrative section id");
    if (!Array.isArray(rawEvidenceIds) || !rawEvidenceIds.length) {
      throw new Error(`metadata.evidenceMap.${rawNarrativeId} must be a non-empty array of evidence section ids`);
    }
    const evidenceIds = rawEvidenceIds.map((rawEvidenceId, index) => {
      const evidenceId = optionalString(rawEvidenceId);
      if (!evidenceId) {
        throw new Error(`metadata.evidenceMap.${rawNarrativeId}[${index}] must be a non-empty evidence section id`);
      }
      return evidenceId;
    });
    normalized[narrativeId] = [...new Set(evidenceIds)];
  }
  return normalized;
}

function validateEvidenceMap(evidenceMap, narrativeSections, evidenceSections) {
  const narrativeIds = new Set(narrativeSections.map(({ id }) => id));
  const evidenceIds = new Set(evidenceSections.map(({ id }) => id));
  const unknownNarrativeIds = Object.keys(evidenceMap).filter((id) => !narrativeIds.has(id));
  const unknownEvidenceIds = [...new Set(Object.values(evidenceMap).flat())]
    .filter((id) => !evidenceIds.has(id));
  const failures = [];
  if (unknownNarrativeIds.length) {
    failures.push(`unknown narrative section ids (expected in narrative fragment): ${unknownNarrativeIds.join(", ")}`);
  }
  if (unknownEvidenceIds.length) {
    failures.push(`unknown evidence section ids (expected in evidence fragment): ${unknownEvidenceIds.join(", ")}`);
  }
  if (failures.length) throw new Error(`metadata.evidenceMap contains ${failures.join("; ")}`);
}

function assertCombinedIdsAreUnique(narrativeSections, evidenceSections) {
  const narrativeIds = new Set(narrativeSections.map(({ id }) => id));
  const duplicates = evidenceSections.map(({ id }) => id).filter((id) => narrativeIds.has(id));
  if (duplicates.length) {
    throw new Error(`combined report section ids must be unique across fragments; found in both narrative and evidence fragments: ${duplicates.join(", ")}`);
  }
}

function addEvidenceButtons(body, evidenceMap, narrativeSections) {
  let rendered = body;
  const mappedSections = narrativeSections.filter(({ id }) => evidenceMap[id]);
  for (const section of mappedSections.toReversed()) {
    const actions = `\n  <div class="report-section-actions" data-tts-skip>\n    <button type="button" data-evidence-action="open-section" data-narrative-section-id="${escapeHtml(section.id)}" aria-label="Show evidence for: ${escapeHtml(section.label)}">Evidence</button>\n  </div>`;
    rendered = `${rendered.slice(0, section.headingEnd)}${actions}${rendered.slice(section.headingEnd)}`;
  }
  return rendered;
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeMetadata(metadata, kind) {
  const title = requiredString(metadata.title, "metadata.title");
  const deck = optionalString(metadata.deck)
    || (kind === "detailed" ? "The complete evidence and raw analysis behind the narrative report." : "A human-readable analysis with detailed evidence available on demand.");
  const provenance = optionalString(metadata.provenance) || "Agent-produced analysis";
  const language = optionalString(metadata.language) || "en";
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) {
    throw new Error("metadata.language must be a simple BCP 47 language tag, such as en or en-GB");
  }

  const suppliedDate = optionalString(metadata.date) || new Date().toISOString().slice(0, 10);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(suppliedDate) ? `${suppliedDate}T00:00:00Z` : suppliedDate);
  if (Number.isNaN(date.valueOf())) throw new Error("metadata.date must be an ISO date or timestamp");
  const dateIso = date.toISOString().slice(0, 10);

  let companionHref = "";
  let companionLabel = "";
  if (kind !== "combined") {
    companionHref = requiredString(metadata.companionHref, "metadata.companionHref");
    if (!isRelativeCompanionLink(companionHref)) {
      throw new Error("metadata.companionHref must be a relative link to the sibling report");
    }
    companionLabel = optionalString(metadata.companionLabel)
      || (kind === "narrative" ? "Open the detailed analysis" : "Read the narrative report");
  }

  return { title, deck, provenance, language, dateIso, companionHref, companionLabel };
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRelativeCompanionLink(value) {
  if (!value || value.startsWith("/") || value.startsWith("//") || value.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return !value.split(/[?#]/, 1)[0].split("/").includes("..");
}

function companionLink(metadata) {
  if (!metadata.companionHref) return "";
  return `<a href="${escapeHtml(metadata.companionHref)}">${escapeHtml(metadata.companionLabel)} <span aria-hidden="true">→</span></a>`;
}

function formatDate(dateIso, language) {
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${dateIso}T00:00:00Z`));
  } catch {
    return dateIso;
  }
}

function readingTime(body) {
  const text = plainText(body);
  const words = text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length || 0;
  const minutes = Math.max(1, Math.ceil(words / 225));
  return `${minutes} min read`;
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    })[name.toLowerCase()]);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function escapeInlineScript(source) {
  return source.replace(/<\/script/gi, "<\\/script");
}

function assertSelfContainedBody(body) {
  if (/<script\b/i.test(body)) throw new Error("report bodies must not contain scripts; the template owns runtime behavior");
  if (/@import\s/i.test(body)) throw new Error("report bodies must not import CSS resources");
  for (const match of body.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const value = match[2].trim();
    if (value && !value.startsWith("data:") && !value.startsWith("#")) {
      throw new Error(`report CSS resource must be inlined as a data URL: ${value}`);
    }
  }
  assertNoRemoteResourceReferences(body);

  const resourceTags = /<(img|source|video|audio|iframe|object|embed|link|image|use)\b[^>]*>/gi;
  for (const tag of body.matchAll(resourceTags)) {
    const attributes = tag[0];
    const resourceAttributes = [...attributes.matchAll(/\b(src|srcset|href|poster|data)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/gi)];
    for (const attribute of resourceAttributes) {
      const name = attribute[1].toLowerCase();
      const value = (attribute[3] || attribute[4] || "").trim();
      if (name === "srcset") throw new Error("report resources must use one inlined src value instead of srcset");
      if (value && !value.startsWith("data:") && !value.startsWith("#")) {
        throw new Error(`report resource must be inlined as a data URL: ${value}`);
      }
    }
  }
}

function assertNoRemoteResourceReferences(html) {
  const remoteResource = /<(?:script|link|img|source|video|audio|iframe|object|embed|image|use)\b[^>]*\b(?:src|srcset|href|poster|data)\s*=\s*(?:["']\s*)?https?:\/\//i;
  if (remoteResource.test(html)) throw new Error("generated reports must not contain remote resource references");
  if (/@import\s+(?:url\()?\s*["']?https?:\/\//i.test(html) || /url\(\s*["']?https?:\/\//i.test(html)) {
    throw new Error("generated reports must not contain remote CSS resources");
  }
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set([
    "kind",
    "body",
    "evidence",
    "out",
    "meta",
    "references",
    "title",
    "deck",
    "date",
    "provenance",
    "language",
    "companion",
    "companion-label",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/make-report.mjs --kind narrative|detailed --body BODY.html --out REPORT.html --meta METADATA.json [--references REFERENCES.json]
  node scripts/make-report.mjs --kind combined --body NARRATIVE.html --evidence EVIDENCE.html --out REPORT.html --meta METADATA.json [--references REFERENCES.json]

Metadata JSON:
  { "title": "…", "deck": "…", "date": "YYYY-MM-DD", "provenance": "…",
    "language": "en", "companionHref": "sibling-report.html", "companionLabel": "…" }

Combined metadata replaces companionHref with:
  { "evidenceMap": { "narrative-section-id": ["evidence-section-id"] } }

Reference manifests contain { "defaultProject": "group/project", "references": { "#123": { … } } }.
Use --references to expand data-gl-ref anchors, matching GitLab URL anchors, and known bare #NNN tokens.

Metadata fields can also be passed as --title, --deck, --date, --provenance, --language,
--companion, and --companion-label. Command-line values override the JSON file.
`);
}

function loadMetadata(metaPath) {
  if (!metaPath) return {};
  const parsed = loadJsonObject(metaPath, "metadata JSON");
  return parsed;
}

function loadJsonObject(filePath, label) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain an object`);
  return parsed;
}

function run(argv) {
  const args = parseArguments(argv);
  if (args.help) {
    printUsage();
    return;
  }

  const kind = args.kind;
  if (!kind) throw new Error("--kind is required");
  if (!args.body) throw new Error("--body is required");
  if (kind === "combined" && !args.evidence) throw new Error("--evidence is required for --kind combined");
  if (kind !== "combined" && args.evidence) throw new Error("--evidence is only valid with --kind combined");
  if (!args.out) throw new Error("--out is required");

  const metadata = {
    ...loadMetadata(args.meta),
    ...(args.title ? { title: args.title } : {}),
    ...(args.deck ? { deck: args.deck } : {}),
    ...(args.date ? { date: args.date } : {}),
    ...(args.provenance ? { provenance: args.provenance } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.companion ? { companionHref: args.companion } : {}),
    ...(args["companion-label"] ? { companionLabel: args["companion-label"] } : {}),
  };

  if (kind === "combined" && optionalString(metadata.companionHref)) {
    process.stderr.write("make-report: warning: metadata.companionHref is ignored for combined reports because evidence is embedded in the same artifact\n");
  }

  const bodyPath = path.resolve(args.body);
  const evidencePath = args.evidence ? path.resolve(args.evidence) : "";
  const referencesPath = args.references ? path.resolve(args.references) : "";
  const body = fs.readFileSync(bodyPath, "utf8");
  const evidence = evidencePath ? fs.readFileSync(evidencePath, "utf8") : "";
  const references = referencesPath ? loadJsonObject(referencesPath, "reference manifest") : null;
  const output = generateReport({
    kind,
    body,
    evidence,
    metadata,
    references,
    bodySource: bodyPath,
    evidenceSource: evidencePath || "evidence fragment",
    referencesSource: referencesPath || "reference manifest",
  });
  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  process.stdout.write(`wrote ${outputPath}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`make-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
