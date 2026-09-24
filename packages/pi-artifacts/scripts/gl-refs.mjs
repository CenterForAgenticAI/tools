#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  normalizeReferenceManifest,
  referenceTokenForEntry,
  scanGitLabReferences,
} from "./report-gl-refs.mjs";

function parseArguments(argv) {
  const values = { fragments: [], refresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--refresh") {
      values.refresh = true;
      continue;
    }
    if (argument === "--project" || argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    values.fragments.push(argument);
  }
  return values;
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/gl-refs.mjs --project GROUP/PROJECT --out REFERENCES.json [--refresh] FRAGMENT.html [...]

The helper scans prose and reference anchors, authenticates glab, bulk-loads issues and merge
requests, falls back to an individual view for entries absent from list output, merges successful
results into the manifest, and writes atomically. Without --refresh, existing entries are retained.
`);
}

export function buildReferenceManifest({ project, outputPath, fragments, refresh = false, glab = process.env.GLAB || "glab" }) {
  if (!outputPath) throw new Error("--out is required");
  if (!fragments?.length) throw new Error("at least one report fragment is required");

  const resolvedOutput = path.resolve(outputPath);
  const existing = loadExistingManifest(resolvedOutput);
  const defaultProject = project?.trim() || existing?.defaultProject || "";
  if (!defaultProject) throw new Error("--project is required when the output manifest does not exist");
  if (existing && project?.trim() && existing.defaultProject !== project.trim()) {
    throw new Error(`--project ${project.trim()} does not match existing manifest project ${existing.defaultProject}`);
  }

  const requests = new Map();
  for (const fragmentPath of fragments) {
    const resolved = path.resolve(fragmentPath);
    const fragment = fs.readFileSync(resolved, "utf8");
    for (const [token, request] of scanGitLabReferences(fragment, defaultProject, resolved)) {
      requests.set(token, request);
    }
  }
  if (!requests.size) throw new Error("no GitLab reference tokens or URLs were found in the supplied fragments");

  const existingReferences = existing?.raw.references || {};
  const pending = [...requests.values()].filter((request) => refresh || !existingReferences[request.token]);
  if (!pending.length) return existing.raw;

  runGlab(glab, ["auth", "status"], "glab authentication failed");
  const fetched = fetchRequests(glab, pending, defaultProject);
  if (fetched.size !== pending.length) {
    const missing = pending.filter((request) => !fetched.has(request.token)).map((request) => request.token);
    throw new Error(`refusing to write a partial manifest; missing: ${missing.join(", ")}`);
  }

  const mergedReferences = { ...existingReferences };
  for (const request of pending) mergedReferences[request.token] = fetched.get(request.token);
  const orderedReferences = Object.fromEntries(Object.entries(mergedReferences).sort(([left], [right]) => {
    return left.localeCompare(right, "en", { numeric: true });
  }));
  const manifest = { defaultProject, references: orderedReferences };
  normalizeReferenceManifest(manifest, resolvedOutput);
  writeJsonAtomically(resolvedOutput, manifest);
  return manifest;
}

function fetchRequests(glab, requests, defaultProject) {
  const fetched = new Map();
  const projects = [...new Set(requests.map((request) => request.project))];
  for (const project of projects) {
    const projectRequests = requests.filter((request) => request.project === project);
    const issues = projectRequests.filter((request) => request.kind === "issue");
    const mergeRequests = projectRequests.filter((request) => request.kind === "mr");
    const commits = projectRequests.filter((request) => request.kind === "commit");

    if (issues.length) {
      const listed = runGlabJson(
        glab,
        ["issue", "list", "-R", project, "--all", "--per-page", "100", "--output", "json"],
        `could not list issues for ${project}`,
      );
      const byIid = indexByIid(listed);
      for (const request of issues) {
        let record = byIid.get(String(request.iid));
        if (!record) {
          record = runGlabJson(
            glab,
            ["issue", "view", String(request.iid), "-R", project, "--output", "json"],
            `could not fetch ${request.token}; it was absent from issue list output`,
          );
        }
        fetched.set(request.token, entryFromRecord(record, request, defaultProject));
      }
    }

    if (mergeRequests.length) {
      const listed = runGlabJson(
        glab,
        ["mr", "list", "-R", project, "--all", "--per-page", "100", "--output", "json"],
        `could not list merge requests for ${project}`,
      );
      const byIid = indexByIid(listed);
      for (const request of mergeRequests) {
        let record = byIid.get(String(request.iid));
        if (!record) {
          record = runGlabJson(
            glab,
            ["mr", "view", String(request.iid), "-R", project, "--output", "json"],
            `could not fetch ${request.token}; it was absent from merge request list output`,
          );
        }
        fetched.set(request.token, entryFromRecord(record, request, defaultProject));
      }
    }

    for (const request of commits) {
      const projectId = encodeURIComponent(project);
      const record = runGlabJson(
        glab,
        ["api", `projects/${projectId}/repository/commits/${request.iid}`],
        `could not fetch ${request.token}`,
      );
      fetched.set(request.token, entryFromRecord(record, request, defaultProject));
    }
  }
  return fetched;
}

function entryFromRecord(record, request, defaultProject) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`glab returned an invalid record for ${request.token}`);
  }
  const title = firstString(record.title, record.name, record.message)?.split("\n", 1)[0] || "";
  const state = request.kind === "commit"
    ? firstString(record.state) || "committed"
    : firstString(record.state);
  const url = firstString(record.web_url, record.webUrl, record.url);
  if (!title || !state || !url) {
    throw new Error(`glab record for ${request.token} is missing title, state, or web URL`);
  }
  let iid;
  if (request.kind === "commit") {
    const returnedSha = firstString(record.id, record.sha, request.iid);
    if (!returnedSha.toLowerCase().startsWith(String(request.iid).toLowerCase())) {
      throw new Error(`glab returned commit ${returnedSha} while fetching ${request.token}`);
    }
    iid = request.iid;
  } else {
    iid = positiveInteger(record.iid ?? record.id ?? request.iid, `${request.token} iid`);
  }
  const entry = { kind: request.kind, iid, title, state, url };
  if (request.project !== defaultProject) entry.project = request.project;
  const expectedToken = referenceTokenForEntry({ ...entry, project: request.project }, defaultProject);
  if (expectedToken !== request.token) {
    throw new Error(`glab returned ${expectedToken} while fetching ${request.token}`);
  }
  return entry;
}

function indexByIid(value) {
  const records = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : null;
  if (!records) throw new Error("glab list output was not a JSON array");
  const byIid = new Map();
  for (const record of records) {
    const iid = record?.iid ?? record?.id;
    if (iid !== undefined && iid !== null) byIid.set(String(iid), record);
  }
  return byIid;
}

function loadExistingManifest(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  const raw = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const normalized = normalizeReferenceManifest(raw, outputPath);
  return { raw, defaultProject: normalized.defaultProject };
}

function runGlabJson(glab, args, label) {
  const result = runGlab(glab, args, label);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: glab returned invalid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
}

function runGlab(glab, args, label) {
  const result = spawnSync(glab, args, {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${label}: ${detail}`);
  }
  return result;
}

function writeJsonAtomically(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    fs.renameSync(temporary, outputPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!(cleanupError && typeof cleanupError === "object" && cleanupError.code === "ENOENT")) {
        process.stderr.write(`gl-refs: could not remove ${temporary}: ${String(cleanupError)}\n`);
      }
    }
    throw error;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function positiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function run(argv) {
  const args = parseArguments(argv);
  if (args.help) {
    printUsage();
    return;
  }
  const outputPath = args.out;
  buildReferenceManifest({
    project: args.project,
    outputPath,
    fragments: args.fragments,
    refresh: args.refresh,
  });
  process.stdout.write(`wrote ${path.resolve(outputPath)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gl-refs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
