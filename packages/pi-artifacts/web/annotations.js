// Shared, dependency-free text-range helpers for the viewer annotation UI.
const CONTEXT_LENGTH = 128;

function textOffset(root, node, point) {
  // Range boundaries from touch/browser selection are often element+child-index boundaries
  // (for example selectNodeContents(<h1>)), not only Text+character boundaries.
  try {
    const prefix = document.createRange();
    prefix.setStart(root, 0);
    prefix.setEnd(node, point);
    return prefix.toString().length;
  } catch { return -1; }
}

function selectionRange(root) {
  const selection = getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

export function selectedTextTarget(root) {
  if (!root) return null;
  const range = selectionRange(root);
  if (!range) return null;

  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  const quote = range.toString();
  if (start < 0 || end <= start || !quote.trim()) return null;

  const visible = root.textContent || "";
  return {
    type: "text",
    start,
    end,
    quote,
    prefix: visible.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: visible.slice(end, end + CONTEXT_LENGTH),
  };
}

function currentTextPlacement(annotation, versionId) {
  return annotation.placements?.find((placement) =>
    placement.versionId === versionId &&
    (placement.state === "anchored" || placement.state === "migrated") &&
    placement.target?.type === "text",
  );
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

// This deliberately serializes text nodes rather than innerHTML/textContent markup: annotation
// wrapper elements contribute no corpus bytes, so saved offsets remain relative to the rendered
// artifact corpus even after existing highlights have been inserted.
function renderedCorpus(root) { return textNodes(root).map((node) => node.data).join(""); }
function insideAnnotationMark(node) { return node.parentElement?.closest(".annotation-mark") !== null; }

// Stored offsets describe the source snapshot, while Markdown rendering can alter the visible
// corpus. Never highlight merely because an offset exists: resolve only an exact quote, or one
// unique quote+context match in the rendered text. This prevents a stale placement from marking
// unrelated content after rendering changes.
function resolveRenderedTextPlacement(root, target) {
  const corpus = renderedCorpus(root);
  const exact = corpus.slice(target.start, target.end) === target.quote &&
    (!target.prefix || corpus.slice(Math.max(0, target.start - target.prefix.length), target.start) === target.prefix) &&
    (!target.suffix || corpus.slice(target.end, target.end + target.suffix.length) === target.suffix);
  if (exact) return target;
  let match = -1;
  let count = 0;
  for (let at = corpus.indexOf(target.quote); at !== -1; at = corpus.indexOf(target.quote, at + Math.max(1, target.quote.length))) {
    const prefix = !target.prefix || corpus.slice(Math.max(0, at - target.prefix.length), at) === target.prefix;
    const suffix = !target.suffix || corpus.slice(at + target.quote.length, at + target.quote.length + target.suffix.length) === target.suffix;
    if (prefix && suffix) { match = at; count++; }
  }
  return count === 1 ? { ...target, start: match, end: match + target.quote.length } : null;
}

// This taxonomy is deliberately computed against the rendered browser corpus, never the
// daemon's raw artifact bytes. It is also used for bulk placement persistence on a selected
// immutable snapshot.
export function resolveRenderedPlacement(root, annotation, versionId) {
  const target = annotation.origin?.target;
  if (!root || !target || target.type !== "text") return { versionId, state: "orphaned", reason: "not-found", provenance: { representationVersion: 1, sourceVersionId: annotation.origin.versionId, sourceBlob: annotation.origin.blob, method: "not-found", confidence: "none", placedAt: Date.now() } };
  const exact = resolveRenderedTextPlacement(root, target);
  if (exact) {
    const anchored = exact.start === target.start && exact.end === target.end;
    return { versionId, state: anchored ? "anchored" : "migrated", target: exact, provenance: { representationVersion: 1, sourceVersionId: annotation.origin.versionId, sourceBlob: annotation.origin.blob, method: anchored ? "exact-position" : "unique-context", confidence: "high", placedAt: Date.now() } };
  }
  const corpus = renderedCorpus(root); let matches = 0;
  for (let at = corpus.indexOf(target.quote); at !== -1; at = corpus.indexOf(target.quote, at + Math.max(1, target.quote.length))) {
    const prefix = !target.prefix || corpus.slice(Math.max(0, at - target.prefix.length), at) === target.prefix;
    const suffix = !target.suffix || corpus.slice(at + target.quote.length, at + target.quote.length + target.suffix.length) === target.suffix;
    if (prefix && suffix) matches++;
  }
  return { versionId, state: matches ? "ambiguous" : "orphaned", reason: matches ? "ambiguous" : "not-found", provenance: { representationVersion: 1, sourceVersionId: annotation.origin.versionId, sourceBlob: annotation.origin.blob, method: matches ? "ambiguous" : "not-found", confidence: "none", placedAt: Date.now() } };
}

function annotationPieces(root, target) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let node;
  let offset = 0;

  while ((node = walker.nextNode())) {
    const start = Math.max(offset, target.start);
    const end = Math.min(offset + node.data.length, target.end);
    // Keep offsets over all corpus text, but never surround a range that is already wrapped.
    // Overlapping annotations remain separately listed in the drawer instead of nesting marks.
    if (start < end && !insideAnnotationMark(node)) pieces.push({ node, start: start - offset, end: end - offset });
    offset += node.data.length;
  }
  return pieces;
}

function markPiece(piece, annotationId) {
  const range = document.createRange();
  range.setStart(piece.node, piece.start);
  range.setEnd(piece.node, piece.end);
  const mark = document.createElement("mark");
  mark.className = "annotation-mark";
  mark.dataset.annotationId = annotationId;
  try { range.surroundContents(mark); } catch { /* malformed/overlapping rendered DOM is not marked */ }
}

export function applyTextAnnotations(root, annotations, versionId) {
  if (!root) return;
  for (const annotation of annotations) {
    const placement = currentTextPlacement(annotation, versionId);
    if (!placement) continue;
    const target = resolveRenderedTextPlacement(root, placement.target);
    if (!target) continue;
    for (const piece of annotationPieces(root, target).reverse()) {
      markPiece(piece, annotation.id);
    }
  }
}

export function clearTextAnnotations(root) {
  if (!root) return;
  for (const mark of root.querySelectorAll("mark.annotation-mark")) mark.replaceWith(...mark.childNodes);
  root.normalize();
}
