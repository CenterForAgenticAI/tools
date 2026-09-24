/* pi-artifacts GitLab references v1.0.0 */
(() => {
  "use strict";

  const references = [...document.querySelectorAll("a.gl-ref")];
  if (!references.length) return;

  let activeReference = null;
  let frame = 0;

  for (const reference of references) {
    // The generator supplies title as a no-JavaScript fallback. Once this
    // visual tooltip is available, remove it so browsers do not show both.
    reference.removeAttribute("title");
    reference.addEventListener("pointerenter", () => showTooltip(reference));
    reference.addEventListener("pointerleave", () => {
      if (document.activeElement !== reference) hideTooltip(reference);
    });
    reference.addEventListener("focus", () => showTooltip(reference));
    reference.addEventListener("blur", () => hideTooltip(reference));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeReference) hideTooltip(activeReference);
  });
  document.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.visualViewport?.addEventListener("resize", schedulePosition, { passive: true });
  window.visualViewport?.addEventListener("scroll", schedulePosition, { passive: true });

  function showTooltip(reference) {
    if (activeReference && activeReference !== reference) hideTooltip(activeReference);
    activeReference = reference;
    reference.dataset.glTooltipVisible = "true";
    schedulePosition();
  }

  function hideTooltip(reference) {
    if (!reference) return;
    delete reference.dataset.glTooltipVisible;
    if (activeReference === reference) activeReference = null;
    window.cancelAnimationFrame(frame);
    frame = 0;
  }

  function schedulePosition() {
    if (!activeReference || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      positionTooltip(activeReference);
    });
  }

  function positionTooltip(reference) {
    if (!reference?.isConnected) {
      hideTooltip(reference);
      return;
    }
    const tooltip = reference.querySelector(".gl-ref-tooltip");
    if (!tooltip) return;

    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportRight = viewportLeft + (viewport?.width || window.innerWidth);
    const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
    const padding = 8;
    const gap = 8;
    const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    const availableWidth = Math.max(0, viewportRight - viewportLeft - (padding * 2));
    tooltip.style.maxWidth = `${Math.min(25 * rootFontSize, availableWidth)}px`;
    const referenceRect = reference.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = referenceRect.left + (referenceRect.width - tooltipRect.width) / 2;
    left = clamp(left, viewportLeft + padding, viewportRight - tooltipRect.width - padding);

    let top = referenceRect.top - tooltipRect.height - gap;
    reference.dataset.glTooltipPlacement = "above";
    if (top < viewportTop + padding) {
      top = referenceRect.bottom + gap;
      reference.dataset.glTooltipPlacement = "below";
    }
    top = clamp(top, viewportTop + padding, viewportBottom - tooltipRect.height - padding);

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }
})();
