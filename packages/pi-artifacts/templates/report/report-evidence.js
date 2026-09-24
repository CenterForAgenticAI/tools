/* pi-artifacts report evidence pane v1.1.0 */
(() => {
  "use strict";

  const pane = document.querySelector("#report-evidence-pane");
  const narrative = document.querySelector("[data-report-narrative]");
  const narrativeView = document.querySelector("[data-report-narrative-view]");
  const evidenceContent = document.querySelector("#report-evidence-content");
  const mapElement = document.querySelector("#report-evidence-map");
  if (!pane || !narrative || !narrativeView || !evidenceContent || !mapElement) return;

  let evidenceMap;
  try {
    evidenceMap = JSON.parse(mapElement.textContent || "{}");
  } catch {
    return;
  }

  const globalToggle = requiredControl("[data-evidence-action='toggle']", document);
  const closeButton = requiredControl("[data-evidence-action='close']", pane);
  const followButton = requiredControl("[data-evidence-action='follow']", pane);
  const evidenceScroll = requiredControl("[data-evidence-scroll]", pane);
  const evidenceToc = requiredControl(".report-evidence-toc", pane);
  const related = requiredControl(".report-related-evidence", pane);
  const relatedList = requiredControl("[data-related-evidence-list]", related);
  const liveStatus = requiredControl("[data-evidence-live]", pane);
  const evidenceSkipLink = requiredControl(".report-evidence-skip-link", document);
  const mainSkipLink = document.querySelector(".report-skip-link:not(.report-evidence-skip-link)");
  const reportHeader = document.querySelector(".report-header");
  const reportFooter = document.querySelector(".report-footer");
  const narrowViewport = window.matchMedia("(max-width: 61.999rem)");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const narrativeSections = [...narrative.querySelectorAll("section[id]")]
    .filter((section) => Object.hasOwn(evidenceMap, section.id));
  const evidenceSections = [...evidenceContent.querySelectorAll("section[id]")];
  const evidenceSectionsById = new Map(evidenceSections.map((section) => [section.id, section]));
  const sectionOpeners = [...narrative.querySelectorAll("[data-evidence-action='open-section']")];
  const backgroundElements = [mainSkipLink, reportHeader, narrativeView, reportFooter].filter(Boolean);

  let evidenceOpen = false;
  let followEnabled = true;
  let activeNarrativeId = "";
  let openingTrigger = globalToggle;
  let narrativeScrollPosition = window.scrollY;
  let isNarrow = narrowViewport.matches;
  let programmaticEvidenceScroll = false;
  let programmaticScrollTimer = 0;
  let openingNarrativeId = "";
  let openingNarrativeTimer = 0;
  let printRevealedHiddenPane = false;

  globalToggle.addEventListener("click", () => {
    if (evidenceOpen) closeEvidence();
    else openEvidence(globalToggle);
  });
  closeButton.addEventListener("click", closeEvidence);
  followButton.addEventListener("click", () => {
    if (followEnabled) {
      setFollowEnabled(false, "Follow narrative turned off.");
      return;
    }
    setFollowEnabled(true, "Follow narrative turned on.");
    const section = currentMappedNarrativeSection();
    if (section) syncToNarrativeSection(section.id);
  });

  for (const opener of sectionOpeners) {
    opener.addEventListener("click", () => {
      openEvidence(opener, opener.dataset.narrativeSectionId || "");
    });
  }

  evidenceToc.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
    if (!link) return;
    const target = evidenceTargetFromLink(link);
    if (!target) return;
    event.preventDefault();
    setFollowEnabled(false, "Follow narrative turned off because you chose an evidence section.");
    scrollEvidenceTo(target, { focusTarget: true });
  });

  related.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
    if (!link) return;
    const target = evidenceTargetFromLink(link);
    if (!target) return;
    event.preventDefault();
    setFollowEnabled(false, "Follow narrative turned off because you chose related evidence.");
    scrollEvidenceTo(target, { focusTarget: true });
  });

  evidenceScroll.addEventListener("scroll", handleEvidenceScroll, { passive: true });
  evidenceScroll.addEventListener("wheel", () => {
    programmaticEvidenceScroll = false;
  }, { passive: true });
  evidenceScroll.addEventListener("touchmove", () => {
    programmaticEvidenceScroll = false;
  }, { passive: true });
  evidenceScroll.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      programmaticEvidenceScroll = false;
    }
  });
  evidenceScroll.addEventListener("scrollend", () => {
    programmaticEvidenceScroll = false;
  });

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.key.toLowerCase() !== "e" || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    if (evidenceOpen) closeEvidence();
    else openEvidence(event.target);
  });

  const observer = typeof window.IntersectionObserver === "function"
    ? new window.IntersectionObserver(handleNarrativeIntersections, {
      root: null,
      rootMargin: "-20% 0px -60% 0px",
      threshold: [0, 0.01],
    })
    : null;
  if (observer) {
    for (const section of narrativeSections) observer.observe(section);
  } else {
    window.addEventListener("scroll", handleNarrativeIntersections, { passive: true });
  }

  narrowViewport.addEventListener?.("change", handleViewportChange);
  window.addEventListener("beforeprint", revealEvidenceForPrint);
  window.addEventListener("afterprint", restoreEvidenceAfterPrint);
  updateFollowControl();

  function requiredControl(selector, root) {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`Missing report evidence control: ${selector}`);
    return element;
  }

  function openEvidence(trigger, requestedNarrativeId = "") {
    openingTrigger = isUsableFocusTarget(trigger) ? trigger : globalToggle;
    narrativeScrollPosition = window.scrollY;
    isNarrow = narrowViewport.matches;
    evidenceOpen = true;
    setFollowEnabled(true);

    const requestedSection = requestedNarrativeId
      ? narrativeSections.find((section) => section.id === requestedNarrativeId)
      : currentMappedNarrativeSection();
    activeNarrativeId = requestedSection?.id || "";
    clearOpeningNarrativeLock();
    if (requestedNarrativeId && activeNarrativeId) {
      openingNarrativeId = activeNarrativeId;
      openingNarrativeTimer = window.setTimeout(clearOpeningNarrativeLock, 500);
    }
    const firstTargetId = activeNarrativeId ? evidenceMap[activeNarrativeId]?.[0] : evidenceSections[0]?.id;

    pane.hidden = false;
    evidenceSkipLink.hidden = false;
    document.body.dataset.evidenceOpen = "true";
    document.body.dataset.evidenceMode = isNarrow ? "narrow" : "wide";
    globalToggle.setAttribute("aria-expanded", "true");
    globalToggle.setAttribute("aria-label", "Hide evidence");
    closeButton.textContent = isNarrow ? "Back to the narrative" : "Close evidence";
    setBackgroundInert(isNarrow);
    updateRelatedLinks(activeNarrativeId);

    window.requestAnimationFrame(() => {
      const target = firstTargetId ? evidenceSectionsById.get(firstTargetId) : evidenceSections[0];
      if (target) scrollEvidenceTo(target);
      closeButton.focus({ preventScroll: true });
    });
  }

  function closeEvidence() {
    if (!evidenceOpen) return;
    const returnFocus = openingTrigger instanceof HTMLElement && openingTrigger.isConnected
      ? openingTrigger
      : globalToggle;
    const restoreNarrativeScroll = isNarrow;

    evidenceOpen = false;
    pane.hidden = true;
    evidenceSkipLink.hidden = true;
    delete document.body.dataset.evidenceOpen;
    delete document.body.dataset.evidenceMode;
    globalToggle.setAttribute("aria-expanded", "false");
    globalToggle.setAttribute("aria-label", "Show evidence");
    setBackgroundInert(false);
    clearProgrammaticScroll();
    clearOpeningNarrativeLock();

    window.requestAnimationFrame(() => {
      if (restoreNarrativeScroll) window.scrollTo({ top: narrativeScrollPosition, behavior: "auto" });
      returnFocus.focus({ preventScroll: restoreNarrativeScroll });
    });
  }

  function handleViewportChange(event) {
    const nextNarrow = event.matches;
    if (nextNarrow === isNarrow) return;
    if (evidenceOpen && nextNarrow) narrativeScrollPosition = window.scrollY;
    isNarrow = nextNarrow;
    closeButton.textContent = isNarrow ? "Back to the narrative" : "Close evidence";
    if (!evidenceOpen) return;
    document.body.dataset.evidenceMode = isNarrow ? "narrow" : "wide";
    setBackgroundInert(isNarrow);
    if (!isNarrow) window.scrollTo({ top: narrativeScrollPosition, behavior: "auto" });
  }

  function setBackgroundInert(inert) {
    for (const element of backgroundElements) element.inert = inert;
  }

  function handleNarrativeIntersections() {
    const section = currentMappedNarrativeSection();
    if (!section || section.id === activeNarrativeId) return;
    if (openingNarrativeId && section.id !== openingNarrativeId) return;
    clearOpeningNarrativeLock();
    activeNarrativeId = section.id;
    updateRelatedLinks(activeNarrativeId);
    if (evidenceOpen && followEnabled && !isNarrow) syncToNarrativeSection(activeNarrativeId);
  }

  function currentMappedNarrativeSection() {
    if (!narrativeSections.length) return null;
    const anchor = window.innerHeight * 0.32;
    const visible = narrativeSections.filter((section) => {
      const rect = section.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    if (!visible.length) return null;
    return visible.reduce((best, section) => {
      const distance = Math.abs(section.getBoundingClientRect().top - anchor);
      const bestDistance = Math.abs(best.getBoundingClientRect().top - anchor);
      return distance < bestDistance ? section : best;
    });
  }

  function syncToNarrativeSection(narrativeId) {
    const targetId = evidenceMap[narrativeId]?.[0];
    const target = targetId ? evidenceSectionsById.get(targetId) : null;
    if (!target) return;
    updateRelatedLinks(narrativeId);
    scrollEvidenceTo(target);
  }

  function handleEvidenceScroll() {
    if (programmaticEvidenceScroll) return;
    setFollowEnabled(false, "Follow narrative turned off because you scrolled the evidence pane.");
  }

  function setFollowEnabled(enabled, announcement = "") {
    const changed = followEnabled !== enabled;
    followEnabled = enabled;
    updateFollowControl();
    if (changed && announcement) announce(announcement);
  }

  function updateFollowControl() {
    followButton.setAttribute("aria-pressed", followEnabled ? "true" : "false");
    followButton.textContent = `Follow narrative: ${followEnabled ? "on" : "off"}`;
  }

  function updateRelatedLinks(narrativeId) {
    const relatedIds = narrativeId ? (evidenceMap[narrativeId] || []).slice(1) : [];
    relatedList.replaceChildren();
    related.hidden = relatedIds.length === 0;
    for (const id of relatedIds) {
      const section = evidenceSectionsById.get(id);
      if (!section) continue;
      const heading = section.querySelector(":scope > h2, :scope > h3, h2, h3");
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${id}`;
      link.textContent = heading?.textContent?.trim() || id;
      item.append(link);
      relatedList.append(item);
    }
  }

  function evidenceTargetFromLink(link) {
    const rawId = link.getAttribute("href")?.slice(1) || "";
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = rawId;
    }
    return evidenceSectionsById.get(id) || null;
  }

  function scrollEvidenceTo(target, options = {}) {
    const { focusTarget = false } = options;
    clearProgrammaticScroll();
    programmaticEvidenceScroll = true;
    const scrollRect = evidenceScroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, evidenceScroll.scrollTop + targetRect.top - scrollRect.top - 16);
    evidenceScroll.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
    programmaticScrollTimer = window.setTimeout(() => {
      programmaticEvidenceScroll = false;
    }, reducedMotion ? 80 : 800);
    if (focusTarget) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    }
  }

  function clearProgrammaticScroll() {
    window.clearTimeout(programmaticScrollTimer);
    programmaticEvidenceScroll = false;
  }

  function clearOpeningNarrativeLock() {
    window.clearTimeout(openingNarrativeTimer);
    openingNarrativeTimer = 0;
    openingNarrativeId = "";
  }

  function announce(message) {
    liveStatus.textContent = "";
    window.setTimeout(() => {
      liveStatus.textContent = message;
    }, 20);
  }

  function revealEvidenceForPrint() {
    printRevealedHiddenPane = pane.hidden;
    if (printRevealedHiddenPane) pane.hidden = false;
  }

  function restoreEvidenceAfterPrint() {
    if (printRevealedHiddenPane) pane.hidden = true;
    printRevealedHiddenPane = false;
  }

  function isTextEntryTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select"))
      || (target instanceof HTMLElement && target.isContentEditable);
  }

  function isUsableFocusTarget(target) {
    return target instanceof HTMLElement
      && target.isConnected
      && target !== document.body
      && target !== document.documentElement;
  }
})();
