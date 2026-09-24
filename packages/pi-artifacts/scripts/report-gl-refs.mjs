import { parseFragment } from "parse5";

const supportedKinds = new Set(["issue", "mr", "commit", "external"]);
const skippedAutoLinkElements = new Set(["a", "code", "kbd", "pre"]);
const replacedAnchorAttributes = new Set([
  "aria-describedby",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "class",
  "data-gl-kind",
  "data-gl-ref",
  "data-gl-state",
  "href",
  "role",
  "title",
]);
const bareIssuePattern = /(^|[^\p{L}\p{N}_])(#\d+)\b/gu;

export function normalizeReferenceManifest(value, sourceName = "reference manifest") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceName} must contain an object`);
  }
  const defaultProject = requiredString(value.defaultProject, `${sourceName}.defaultProject`);
  const rawReferences = value.references;
  if (!rawReferences || typeof rawReferences !== "object" || Array.isArray(rawReferences)) {
    throw new Error(`${sourceName}.references must be an object keyed by reference token`);
  }

  const references = new Map();
  const urls = new Map();
  for (const [rawToken, rawEntry] of Object.entries(rawReferences)) {
    const token = rawToken.trim();
    if (!token) throw new Error(`${sourceName}.references must not contain an empty token`);
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`${sourceName}.references.${rawToken} must be an object`);
    }

    const rawKind = requiredString(rawEntry.kind, `${sourceName}.references.${rawToken}.kind`);
    const kind = rawKind === "merge_request" ? "mr" : rawKind;
    if (!supportedKinds.has(kind)) {
      throw new Error(`${sourceName}.references.${rawToken}.kind must be issue, mr, commit, or external`);
    }
    const iid = normalizeIid(rawEntry.iid, kind, `${sourceName}.references.${rawToken}.iid`);
    const title = requiredString(rawEntry.title, `${sourceName}.references.${rawToken}.title`);
    const state = requiredString(rawEntry.state, `${sourceName}.references.${rawToken}.state`);
    const url = requiredString(rawEntry.url, `${sourceName}.references.${rawToken}.url`);
    const normalizedUrl = normalizeGitLabUrl(url);
    if (!normalizedUrl) throw new Error(`${sourceName}.references.${rawToken}.url must be an absolute HTTP(S) URL`);
    const project = optionalString(rawEntry.project) || projectFromGitLabUrl(url) || defaultProject;
    if (kind !== "external") {
      const parsedToken = parseReferenceToken(token, defaultProject);
      const iidMatches = kind === "commit"
        ? String(parsedToken?.iid).toLowerCase() === String(iid).toLowerCase()
        : parsedToken?.iid === iid;
      if (!parsedToken || parsedToken.kind !== kind || parsedToken.project !== project || !iidMatches) {
        throw new Error(`${sourceName}.references.${rawToken} does not match its kind, iid, and project`);
      }
    }
    const entry = { token, kind, iid, title, state, url, project };
    references.set(token, entry);

    const existing = urls.get(normalizedUrl);
    if (existing && existing.token !== token) {
      throw new Error(`${sourceName} maps the same URL to both ${existing.token} and ${token}`);
    }
    urls.set(normalizedUrl, entry);
  }

  return { defaultProject, references, urls };
}

export function transformGitLabReferences(fragment, manifest, sourceName) {
  const document = parseFragment(fragment, { sourceCodeLocationInfo: true });
  const replacements = [];
  let count = 0;

  walkNodes(document, [], (node, ancestors) => {
    if (node.tagName === "a") {
      const explicitValue = attributeValue(node, "data-gl-ref");
      const explicitToken = explicitValue?.trim();
      const href = attributeValue(node, "href")?.trim();
      let entry = null;
      if (explicitValue !== undefined) {
        if (!explicitToken) throw new Error(`unknown GitLab reference (empty token) in ${sourceName}`);
        entry = manifest ? resolveReferenceToken(explicitToken, manifest) : null;
        if (!entry) throw new Error(`unknown GitLab reference ${explicitToken} in ${sourceName}`);
      } else if (href && manifest) {
        entry = manifest.urls.get(normalizeGitLabUrl(href));
      }
      if (!entry) return false;

      const location = node.sourceCodeLocation;
      if (!location?.startTag || !location.endTag) {
        if (explicitToken) throw new Error(`GitLab reference ${explicitToken} in ${sourceName} must use a closing </a> tag`);
        return false;
      }
      const innerHtml = fragment.slice(location.startTag.endOffset, location.endTag.startOffset);
      replacements.push({
        start: location.startOffset,
        end: location.endOffset,
        value: renderReferenceAnchor(entry, innerHtml, node.attrs),
      });
      count += 1;
      return false;
    }

    if (node.nodeName !== "#text") return true;
    if (ancestors.some((ancestor) => skippedAutoLinkElements.has(ancestor.tagName))) return true;
    const location = node.sourceCodeLocation;
    if (!location) return true;
    const sourceText = fragment.slice(location.startOffset, location.endOffset);
    for (const match of sourceText.matchAll(bareIssuePattern)) {
      const token = match[2];
      const entry = manifest?.references.get(token);
      if (!entry) throw new Error(`unknown GitLab reference ${token} in ${sourceName}`);
      if (entry.kind !== "issue") throw new Error(`GitLab reference ${token} in ${sourceName} must resolve to an issue`);
      const start = location.startOffset + match.index + match[1].length;
      replacements.push({ start, end: start + token.length, value: renderReferenceAnchor(entry) });
      count += 1;
    }
    return true;
  });

  replacements.sort((left, right) => right.start - left.start || right.end - left.end);
  let html = fragment;
  let previousStart = fragment.length + 1;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error(`overlapping GitLab references in ${sourceName}`);
    html = `${html.slice(0, replacement.start)}${replacement.value}${html.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return { html, count };
}

export function scanGitLabReferences(fragment, defaultProject, sourceName = "report fragment") {
  const document = parseFragment(fragment, { sourceCodeLocationInfo: true });
  const requests = new Map();

  walkNodes(document, [], (node, ancestors) => {
    if (node.tagName === "a") {
      const explicitValue = attributeValue(node, "data-gl-ref");
      const explicitToken = explicitValue?.trim();
      if (explicitValue !== undefined) {
        if (!explicitToken) throw new Error(`unsupported GitLab reference token (empty token) in ${sourceName}`);
        addRequest(requests, parseReferenceToken(explicitToken, defaultProject), explicitToken, sourceName);
      }
      const href = attributeValue(node, "href")?.trim();
      const fromUrl = href ? referenceRequestFromUrl(href, defaultProject) : null;
      if (fromUrl) requests.set(fromUrl.token, fromUrl);
      return false;
    }
    if (node.nodeName !== "#text") return true;
    if (ancestors.some((ancestor) => skippedAutoLinkElements.has(ancestor.tagName))) return true;
    scanTextForRequests(node.value || "", defaultProject, requests);
    return true;
  });

  return requests;
}

export function parseReferenceToken(token, defaultProject) {
  const value = token.trim();
  let match = value.match(/^([\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+)([#!])(\d+)$/u);
  if (match) {
    return {
      token: value,
      project: match[1],
      kind: match[2] === "#" ? "issue" : "mr",
      iid: Number(match[3]),
    };
  }
  match = value.match(/^([#!])(\d+)$/);
  if (match) {
    return {
      token: value,
      project: defaultProject,
      kind: match[1] === "#" ? "issue" : "mr",
      iid: Number(match[2]),
    };
  }
  match = value.match(/^@([0-9a-f]{7,40})$/i);
  if (match) return { token: value, project: defaultProject, kind: "commit", iid: match[1] };
  return null;
}

export function referenceTokenForEntry(entry, defaultProject) {
  const projectPrefix = entry.project && entry.project !== defaultProject ? entry.project : "";
  if (entry.kind === "issue") return `${projectPrefix}#${entry.iid}`;
  if (entry.kind === "mr") return `${projectPrefix}!${entry.iid}`;
  if (entry.kind === "commit") return `@${entry.iid}`;
  return String(entry.iid);
}

export function normalizeGitLabUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/-\/(?:issues|work_items)\/(\d+)\/?$/i, "/-/issues/$1")
    .replace(/\/$/, "");
  return url.href.replace(/\/$/, "");
}

function resolveReferenceToken(token, manifest) {
  const exact = manifest.references.get(token);
  if (exact) return exact;
  const parsed = parseReferenceToken(token, manifest.defaultProject);
  if (!parsed) return null;
  if (parsed.project === manifest.defaultProject) {
    const localToken = parsed.kind === "issue" ? `#${parsed.iid}`
      : parsed.kind === "mr" ? `!${parsed.iid}`
        : `@${parsed.iid}`;
    return manifest.references.get(localToken) || null;
  }
  return null;
}

function renderReferenceAnchor(entry, authoredInnerHtml = "", authoredAttributes = []) {
  const state = displayState(entry.state);
  const kindLabel = entry.kind === "issue" ? "Issue"
    : entry.kind === "mr" ? "Merge request"
      : entry.kind === "commit" ? "Commit"
        : "Reference";
  const identifier = entry.kind === "issue" ? `#${entry.iid}`
    : entry.kind === "mr" ? `!${entry.iid}`
      : entry.kind === "commit" ? `@${entry.iid}`
        : String(entry.iid);
  const accessibleName = `${kindLabel} ${identifier}: ${entry.title} — ${state}`;
  const authoredClass = authoredAttributes.find((attribute) => attribute.name === "class")?.value.trim() || "";
  const classes = ["gl-ref", `gl-ref-${entry.kind}`, `gl-ref-state-${cssToken(state)}`, authoredClass]
    .filter(Boolean)
    .join(" ");
  const preservedAttributes = authoredAttributes
    .filter((attribute) => !replacedAnchorAttributes.has(attribute.name))
    .map((attribute) => ` ${attribute.name}="${escapeHtml(attribute.value)}"`)
    .join("");
  const visibleContent = authoredInnerHtml.trim()
    ? authoredInnerHtml
    : escapeHtml(entry.token || identifier);

  return `<a class="${escapeHtml(classes)}" href="${escapeHtml(entry.url)}" data-gl-ref="${escapeHtml(entry.token)}" data-gl-kind="${entry.kind}" data-gl-state="${escapeHtml(state)}" aria-label="${escapeHtml(accessibleName)}" title="${escapeHtml(accessibleName)}"${preservedAttributes}>${referenceIcon(entry.kind, state)}<span class="gl-ref-text">${visibleContent}</span><span class="gl-ref-tooltip" data-gl-tooltip-meta="${escapeHtml(`${kindLabel} ${identifier} · ${state}`)}" data-gl-tooltip-title="${escapeHtml(entry.title)}" aria-hidden="true"></span></a>`;
}

function referenceIcon(kind, state) {
  const common = `class="gl-ref-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"`;
  if (kind === "issue" && state === "closed") {
    return `<svg ${common}><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4.75 8 2.05 2.05 4.45-4.45" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>`;
  }
  if (kind === "issue") {
    return `<svg ${common}><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/></svg>`;
  }
  if (kind === "mr" && state === "merged") {
    return `<svg ${common}><path d="M4 3v4c0 2.75 2 4 4 4h2.25M8.5 3H12v3.5M8.5 6.5 12 3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><circle cx="4" cy="3" r="1.5" fill="currentColor"/><path d="m9.5 10.75 1.25 1.25 2.25-2.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>`;
  }
  if (kind === "mr" && state === "closed") {
    return `<svg ${common}><path d="M4 3v7M11.5 3 8.75 5.75M8.75 3l2.75 2.75M11.5 9.25l-2.75 2.75m0-2.75L11.5 12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><circle cx="4" cy="3" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/></svg>`;
  }
  if (kind === "mr") {
    return `<svg ${common}><path d="M4 3v7.5M11 5V3m0 0L8.75 5.25M11 3l2.25 2.25M4 8c0-2 1.5-3 3.25-3H11v5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><circle cx="4" cy="3" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="11" cy="12" r="1.5" fill="currentColor"/></svg>`;
  }
  if (kind === "commit") {
    return `<svg ${common}><path d="M1.5 8h4m5 0h4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><circle cx="8" cy="8" r="2.75" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  return `<svg ${common}><path d="M6.5 3H3.75A1.75 1.75 0 0 0 2 4.75v7.5A1.75 1.75 0 0 0 3.75 14h7.5A1.75 1.75 0 0 0 13 12.25V9.5M8 2h6v6M14 2 7 9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>`;
}

function scanTextForRequests(text, defaultProject, requests) {
  const occupied = [];
  for (const match of text.matchAll(/\b([\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+)([#!])(\d+)\b/gu)) {
    const token = `${match[1]}${match[2]}${match[3]}`;
    const request = parseReferenceToken(token, defaultProject);
    if (request) requests.set(token, request);
    occupied.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/(^|[^\p{L}\p{N}_/])([#!]\d+)\b/gu)) {
    const start = match.index + match[1].length;
    if (occupied.some(([from, to]) => start >= from && start < to)) continue;
    const request = parseReferenceToken(match[2], defaultProject);
    if (request) requests.set(request.token, request);
  }
  for (const match of text.matchAll(/(^|[^\p{L}\p{N}_])(@[0-9a-f]{7,40})\b/giu)) {
    const request = parseReferenceToken(match[2], defaultProject);
    if (request) requests.set(request.token, request);
  }
}

function referenceRequestFromUrl(value, defaultProject) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/(.+?)\/-\/(issues|work_items|merge_requests|commit(?:s)?)\/([^/]+)\/?$/i);
  if (!match) return null;
  const project = match[1].split("/").map((part) => decodeURIComponent(part)).join("/");
  const resource = match[2].toLowerCase();
  const rawIid = decodeURIComponent(match[3]);
  const kind = resource === "issues" || resource === "work_items" ? "issue"
    : resource === "merge_requests" ? "mr"
      : "commit";
  if ((kind === "issue" || kind === "mr") && !/^\d+$/.test(rawIid)) return null;
  if (kind === "commit" && !/^[0-9a-f]{7,40}$/i.test(rawIid)) return null;
  const iid = kind === "commit" ? rawIid : Number(rawIid);
  const token = referenceTokenForEntry({ kind, iid, project }, defaultProject);
  return { token, project, kind, iid };
}

function addRequest(requests, request, token, sourceName) {
  if (!request) throw new Error(`unsupported GitLab reference token ${token} in ${sourceName}`);
  requests.set(request.token, request);
}

function walkNodes(node, ancestors, visit) {
  const shouldDescend = visit(node, ancestors);
  if (shouldDescend === false) return;
  const nextAncestors = node.tagName ? [...ancestors, node] : ancestors;
  for (const child of node.childNodes || []) walkNodes(child, nextAncestors, visit);
}

function attributeValue(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function projectFromGitLabUrl(value) {
  try {
    const url = new URL(value);
    const marker = url.pathname.indexOf("/-/");
    if (marker <= 1) return "";
    return url.pathname.slice(1, marker).split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return "";
  }
}

function normalizeIid(value, kind, label) {
  if (kind === "issue" || kind === "mr") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
    return number;
  }
  const normalized = optionalString(value) || (typeof value === "number" ? String(value) : "");
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function displayState(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "opened") return "open";
  return normalized;
}

function cssToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
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
