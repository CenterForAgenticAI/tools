import { parseFragment } from "parse5";

const externalHref = /^\s*https?:/i;
const openedRel = ["noopener", "noreferrer"];

/**
 * Make every authored or generated http(s) link open a new tab.
 *
 * The artifact viewer shows an HTML report inside a sandboxed frame, and most sites refuse to
 * load inside a frame, so an ordinary external link would show a blocked page. A new tab works
 * in the viewer, in the raw view, and in a saved file. `noopener noreferrer` gives the opened
 * page no handle on the report and no referrer. An authored `target` is kept unchanged, and an
 * authored `rel` is extended rather than replaced. Text inside code is never touched because
 * only parsed `<a>` elements are rewritten, by source offset.
 */
export function openExternalLinksInNewTab(fragment) {
  const document = parseFragment(fragment, { sourceCodeLocationInfo: true });
  const edits = [];
  walk(document, (node) => {
    if (node.tagName !== "a") return;
    const attrs = new Map(node.attrs.map((attribute) => [attribute.name, attribute.value]));
    if (!externalHref.test(attrs.get("href") || "") || attrs.has("target")) return;
    const location = node.sourceCodeLocation;
    if (!location?.startTag) return;
    const tagEnd = location.startTag.endOffset;
    const insertAt = fragment[tagEnd - 2] === "/" ? tagEnd - 2 : tagEnd - 1;
    const relLocation = location.startTag.attrs?.rel;
    if (attrs.has("rel") && relLocation) {
      const tokens = attrs.get("rel").split(/\s+/).filter(Boolean);
      const lower = new Set(tokens.map((token) => token.toLowerCase()));
      const merged = [...tokens, ...openedRel.filter((token) => !lower.has(token))];
      edits.push({ start: relLocation.startOffset, end: relLocation.endOffset, value: `rel="${escapeAttribute(merged.join(" "))}"` });
      edits.push({ start: insertAt, end: insertAt, value: ' target="_blank"' });
    } else {
      edits.push({ start: insertAt, end: insertAt, value: ` target="_blank" rel="${openedRel.join(" ")}"` });
    }
  });
  edits.sort((left, right) => right.start - left.start);
  let html = fragment;
  for (const edit of edits) html = `${html.slice(0, edit.start)}${edit.value}${html.slice(edit.end)}`;
  return html;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
