// Injected as a classic inline script ahead of authored markup in an opaque HTML iframe.
// It never receives comment bodies and only exchanges selector/placement metadata plus
// inert selection geometry over a random per-frame channel. Server CSP blocks
// network/form/navigation escape hatches.
const TYPE = "pi-artifact-annotation";
const CHANNEL = new URL(location.href).searchParams.get("channel");
const PARENT_ORIGIN = (() => { try { return new URL(document.referrer).origin; } catch { return ""; } })();
const CONTEXT_LENGTH = 128;

const bridgeStyle = document.createElement("style");
bridgeStyle.textContent = "mark[data-pa-annotation]{cursor:pointer}mark[data-pa-active]{outline:2px solid #0969da!important;outline-offset:2px}";
document.head.appendChild(bridgeStyle);

function send(action, payload = {}) {
  if (CHANNEL) parent.postMessage({ type: TYPE, channel: CHANNEL, action, ...payload }, "*");
}

// Defense in depth for authored documents. The server CSP is authoritative; these guards
// keep accidental form/API/navigation actions inert even when authored code calls them.
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
  try { window[name] = function () { throw new Error("network is disabled in annotation mode"); }; } catch { /* non-writable browser API */ }
}
try { navigator.sendBeacon = () => false; } catch { /* non-writable browser API */ }
try { window.open = () => null; } catch { /* non-writable browser API */ }
document.addEventListener("submit", (event) => event.preventDefault(), true);
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (link && !String(link.getAttribute("href")).startsWith("#")) event.preventDefault();
}, true);

function selector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (element === document.documentElement) return "html";
  const parts = [];
  for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    let index = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) index++;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
  }
  return `html>${parts.join(">")}`;
}
function offsets(root, range) {
  try {
    const start = document.createRange(); start.selectNodeContents(root); start.setEnd(range.startContainer, range.startOffset);
    const end = document.createRange(); end.selectNodeContents(root); end.setEnd(range.endContainer, range.endOffset);
    return { start: start.toString().length, end: end.toString().length };
  } catch { return { start: -1, end: -1 }; }
}
function selectedTarget() {
  const selection = getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  let root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  while (root?.matches?.("mark[data-pa-annotation]")) root = root.parentElement;
  if (!root) return null;
  const { start, end } = offsets(root, range);
  const quote = range.toString();
  if (start < 0 || end <= start || !quote.trim()) return null;
  const corpus = root.textContent || "";
  const rect = range.getBoundingClientRect();
  return {
    target: { type: "html", selector: selector(root), start, end, quote, prefix: corpus.slice(Math.max(0, start - CONTEXT_LENGTH), start), suffix: corpus.slice(end, end + CONTEXT_LENGTH) },
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
  };
}
document.addEventListener("mouseup", () => { const selected = selectedTarget(); if (selected) send("select", selected); });
document.addEventListener("touchend", () => setTimeout(() => { const selected = selectedTarget(); if (selected) send("select", selected); }, 0), { passive: true });
let selectionChangeTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    const selected = selectedTarget();
    if (selected) send("select", selected);
    else send("clear-selection");
  }, 0);
});

function mark(target, id) {
  let root; try { root = document.querySelector(target.selector); } catch { return; }
  if (!root || (root.textContent || "").slice(target.start, target.end) !== target.quote) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const pieces = []; let node; let offset = 0;
  while ((node = walker.nextNode())) {
    const start = Math.max(offset, target.start), end = Math.min(offset + node.data.length, target.end);
    if (start < end && !node.parentElement?.closest("mark[data-pa-annotation]")) pieces.push({ node, start: start - offset, end: end - offset });
    offset += node.data.length;
  }
  for (const piece of pieces.reverse()) {
    const range = document.createRange(); range.setStart(piece.node, piece.start); range.setEnd(piece.node, piece.end);
    const element = document.createElement("mark"); element.dataset.paAnnotation = id;
    try { range.surroundContents(element); element.onclick = () => send("open", { id }); } catch { /* overlapping DOM range */ }
  }
}
function clearMarks() {
  for (const element of document.querySelectorAll("mark[data-pa-annotation]")) element.replaceWith(...element.childNodes);
  document.body?.normalize();
}
addEventListener("message", (event) => {
  const data = event.data;
  if (!CHANNEL || event.source !== parent || event.origin !== PARENT_ORIGIN || data?.type !== TYPE || data.channel !== CHANNEL) return;
  if (data.action === "focus" && typeof data.id === "string" && /^[a-f0-9]{32}$/.test(data.id)) {
    const marks = document.querySelectorAll("mark[data-pa-annotation]");
    for (const element of marks) element.toggleAttribute("data-pa-active", element.dataset.paAnnotation === data.id);
    document.querySelector(`mark[data-pa-annotation="${data.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (data.action === "placements" && Array.isArray(data.placements)) {
    clearMarks();
    for (const item of data.placements) if (/^[a-f0-9]{32}$/.test(item?.id) && item.placement?.target?.type === "html" && (item.placement.state === "anchored" || item.placement.state === "migrated")) mark(item.placement.target, item.id);
    return;
  }
  if (data.action !== "origins" || !Array.isArray(data.origins)) return;
  const results = data.origins.map((item) => {
    const origin = item?.origin; const target = origin?.target; let root;
    try { root = target?.type === "html" ? document.querySelector(target.selector) : null; } catch { root = null; }
    const provenance = (method, confidence) => ({ representationVersion: 1, sourceVersionId: origin?.versionId, sourceBlob: origin?.blob, method, confidence, placedAt: Date.now() });
    if (!root || !target?.quote) return { annotationId: item?.id, placement: { versionId: data.versionId, state: "orphaned", reason: "not-found", provenance: provenance("not-found", "none") } };
    const corpus = root.textContent || ""; const exact = corpus.slice(target.start, target.end) === target.quote;
    if (exact) return { annotationId: item.id, placement: { versionId: data.versionId, state: "anchored", target, provenance: provenance("exact-position", "high") } };
    const matches = []; for (let at = corpus.indexOf(target.quote); at !== -1; at = corpus.indexOf(target.quote, at + Math.max(1, target.quote.length))) {
      if ((!target.prefix || corpus.slice(Math.max(0, at - target.prefix.length), at) === target.prefix) && (!target.suffix || corpus.slice(at + target.quote.length, at + target.quote.length + target.suffix.length) === target.suffix)) matches.push(at);
    }
    if (matches.length === 1) return { annotationId: item.id, placement: { versionId: data.versionId, state: "migrated", target: { ...target, start: matches[0], end: matches[0] + target.quote.length }, provenance: provenance("unique-context", "high") } };
    return { annotationId: item.id, placement: { versionId: data.versionId, state: matches.length ? "ambiguous" : "orphaned", reason: matches.length ? "ambiguous" : "not-found", provenance: provenance(matches.length ? "ambiguous" : "not-found", "none") } };
  });
  send("placement-results", { placements: results });
});

// The bridge is injected before authored markup so it survives document CSP, but selector
// roots do not exist until parsing (and often author startup) completes. Resolve only after
// the load event and two frames, when static and synchronous presentation DOM is stable.
function announceReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => send("ready")));
}
if (document.readyState === "complete") announceReady();
else addEventListener("load", announceReady, { once: true });
