/* pi-artifacts report reader v1.3.0 */
(() => {
  "use strict";

  const synthesis = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synthesis || typeof synthesis.speak !== "function" || typeof Utterance !== "function") {
    return;
  }

  const main = document.querySelector("[data-report-narrative]");
  if (!main) return;

  const STORAGE_RATE = "pi-artifacts.report-reader.rate.v1";
  const STORAGE_VOICE = "pi-artifacts.report-reader.voice.v1";
  const STORAGE_HIDDEN = "pi-artifacts.report-reader.hidden.v1";
  // Chromium can stop firing events during utterances of roughly 15 seconds or more.
  // Keeping each utterance short avoids that stall without a disruptive pause/resume timer.
  const MAX_CHUNK_CHARS = 160;
  const documentLanguage = (document.documentElement.lang || navigator.language || "en").toLowerCase();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const reader = document.createElement("aside");
  reader.className = "report-reader";
  reader.dataset.ttsSkip = "";
  // The panel is collapsible, so the aside carries its own accessible name: an
  // aria-labelledby pointing into the panel would lose its target while hidden.
  reader.setAttribute("aria-label", "Audio reader");
  reader.innerHTML = `
    <div class="report-reader-panel" id="report-reader-panel" data-reader-panel>
      <div class="report-reader-title-row">
        <h2 class="report-reader-title" id="report-reader-title">Listen to this report</h2>
        <div class="report-reader-title-actions">
          <button type="button" data-reader-action="help" aria-label="Open audio reader keyboard shortcut help" aria-haspopup="dialog" aria-controls="report-reader-help">Help</button>
          <button type="button" data-reader-action="hide" aria-label="Hide the audio reader" aria-expanded="true" aria-controls="report-reader-panel">Hide</button>
        </div>
      </div>
      <div class="report-reader-actions" aria-label="Audio reader playback controls">
        <button type="button" data-reader-action="play" aria-label="Play report from the beginning">Play</button>
        <button type="button" data-reader-action="pause" aria-label="Pause report audio">Pause</button>
        <button type="button" data-reader-action="resume" aria-label="Resume report audio">Resume</button>
        <button type="button" data-reader-action="stop" aria-label="Stop report audio">Stop</button>
      </div>
      <div class="report-reader-options">
        <label class="report-reader-field">
          <span>Rate</span>
          <select data-reader-rate aria-label="Choose report audio speaking rate">
            <option value="0.75">0.75×</option>
            <option value="1">1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="1.75">1.75×</option>
            <option value="2">2×</option>
          </select>
        </label>
        <label class="report-reader-field">
          <span>Voice</span>
          <select data-reader-voice aria-label="Choose report audio voice">
            <option value="">System default</option>
          </select>
        </label>
      </div>
      <div class="report-reader-progress-row">
        <progress data-reader-progress max="1" value="0" aria-label="Report audio progress" aria-valuetext="Not started"></progress>
        <span class="report-reader-status" data-reader-status aria-hidden="true">Ready</span>
      </div>
    </div>
    <button type="button" class="report-reader-launcher" data-reader-action="show" aria-label="Show the audio reader" aria-expanded="false" aria-controls="report-reader-panel" hidden>Listen</button>
    <span class="report-visually-hidden" data-reader-live aria-live="polite" aria-atomic="true"></span>
    <dialog class="report-reader-help-dialog" id="report-reader-help" aria-labelledby="report-reader-help-title">
      <h2 id="report-reader-help-title">Audio reader shortcuts</h2>
      <p>Shortcuts work when focus is outside a form control.</p>
      <table>
        <tbody>
          <tr><th scope="row"><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd></th><td>Play or pause</td></tr>
          <tr><th scope="row"><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd></th><td>Stop</td></tr>
          <tr><th scope="row"><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd></th><td>Open this help</td></tr>
          <tr><th scope="row"><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd></th><td>Hide or show this player</td></tr>
        </tbody>
      </table>
      <p class="report-reader-help-actions"><button type="button" data-reader-action="close-help" aria-label="Close audio reader keyboard shortcut help">Close</button></p>
    </dialog>
  `;
  document.body.append(reader);

  const playButton = requiredControl("[data-reader-action='play']");
  const pauseButton = requiredControl("[data-reader-action='pause']");
  const resumeButton = requiredControl("[data-reader-action='resume']");
  const stopButton = requiredControl("[data-reader-action='stop']");
  const helpButton = requiredControl("[data-reader-action='help']");
  const closeHelpButton = requiredControl("[data-reader-action='close-help']");
  const hideButton = requiredControl("[data-reader-action='hide']");
  const launcherButton = requiredControl("[data-reader-action='show']");
  const panel = requiredControl("[data-reader-panel]");
  const rateSelect = requiredControl("[data-reader-rate]");
  const voiceSelect = requiredControl("[data-reader-voice]");
  const progress = requiredControl("[data-reader-progress]");
  const visualStatus = requiredControl("[data-reader-status]");
  const liveStatus = requiredControl("[data-reader-live]");
  const helpDialog = requiredControl("#report-reader-help");

  const savedRate = Number(readPreference(STORAGE_RATE));
  rateSelect.value = [0.75, 1, 1.25, 1.5, 1.75, 2].includes(savedRate) ? String(savedRate) : "1";

  let voices = [];
  let selectedVoiceKey = "";
  let preferredVoiceKey = readPreference(STORAGE_VOICE);
  let runId = 0;
  let queue = [];
  let queueIndex = 0;
  let completedCharacters = 0;
  let totalCharacters = 0;
  let phase = "idle";
  let currentBlock = null;
  let panelVisible = true;

  const topLevelSections = [...main.querySelectorAll("section[id]")]
    .filter((section) => !section.parentElement?.closest("section"));

  for (const [sectionIndex, section] of topLevelSections.entries()) {
    const heading = section.querySelector(":scope > h2, :scope > h3, h2, h3");
    if (!heading) continue;
    const title = heading.textContent?.trim() || `Section ${sectionIndex + 1}`;
    let actions = heading.nextElementSibling;
    if (!actions?.classList.contains("report-section-actions")) {
      actions = document.createElement("div");
      actions.className = "report-section-actions";
      heading.insertAdjacentElement("afterend", actions);
    }
    actions.dataset.ttsSkip = "";

    const sectionButton = document.createElement("button");
    sectionButton.type = "button";
    sectionButton.textContent = "Read this section";
    sectionButton.setAttribute("aria-label", `Read section: ${title}`);
    sectionButton.addEventListener("click", () => startReading([section], `Reading ${title}`));

    const fromHereButton = document.createElement("button");
    fromHereButton.type = "button";
    fromHereButton.textContent = "Read from here";
    fromHereButton.setAttribute("aria-label", `Read report from section: ${title}`);
    fromHereButton.addEventListener("click", () => {
      startReading(topLevelSections.slice(sectionIndex), `Reading from ${title}`);
    });

    actions.prepend(sectionButton, fromHereButton);
  }

  playButton.addEventListener("click", playReport);
  pauseButton.addEventListener("click", pauseReading);
  resumeButton.addEventListener("click", resumeReading);
  stopButton.addEventListener("click", () => stopReading(true));
  helpButton.addEventListener("click", openHelp);
  closeHelpButton.addEventListener("click", closeHelp);
  helpDialog.addEventListener("close", () => helpButton.focus());
  hideButton.addEventListener("click", () => setPanelVisible(false, { focus: true, announceChange: true }));
  launcherButton.addEventListener("click", () => setPanelVisible(true, { focus: true, announceChange: true }));

  rateSelect.addEventListener("change", () => {
    writePreference(STORAGE_RATE, rateSelect.value);
    announce(`Speaking rate ${rateSelect.value} times. The change applies to the next passage.`);
  });

  voiceSelect.addEventListener("change", () => {
    selectedVoiceKey = voiceSelect.value;
    preferredVoiceKey = selectedVoiceKey;
    writePreference(STORAGE_VOICE, selectedVoiceKey);
    const voice = selectedVoice();
    announce(`${voice ? voice.name : "System default"} voice selected. The change applies to the next passage.`);
  });

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code === "Space") {
      // Space would otherwise activate whichever control has focus.
      if (isEditingTarget(event.target)) return;
      event.preventDefault();
      if (phase === "playing") pauseReading();
      else if (phase === "paused") resumeReading();
      else playReport();
      return;
    }
    // Letter shortcuts only conflict with text entry, so they stay available
    // while a reader button holds focus — notably the launcher after hiding.
    if (isTextEntryTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      stopReading(true);
    } else if (key === "h") {
      event.preventDefault();
      openHelp();
    } else if (key === "l") {
      event.preventDefault();
      setPanelVisible(!panelVisible, { focus: true, announceChange: true });
    }
  });

  // Safari and Chromium can both expose an empty voice list until voiceschanged fires.
  // The retries also cover Safari versions that deliver that event before page code attaches.
  if (typeof synthesis.addEventListener === "function") {
    synthesis.addEventListener("voiceschanged", populateVoices);
  }
  populateVoices();
  for (const delay of [50, 250, 1000, 2500]) window.setTimeout(populateVoices, delay);

  const cancelForNavigation = () => {
    runId += 1;
    synthesis.cancel();
  };
  window.addEventListener("beforeunload", cancelForNavigation);
  window.addEventListener("pagehide", cancelForNavigation);

  setPanelVisible(readPreference(STORAGE_HIDDEN) !== "1", { persist: false });
  updateControls();

  function requiredControl(selector) {
    const element = reader.querySelector(selector);
    if (!element) throw new Error(`Missing report reader control: ${selector}`);
    return element;
  }

  function readPreference(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Sandboxed and local-file reports may deny storage. Playback still works for this page.
    }
  }

  function voiceKey(voice) {
    return `${voice.voiceURI || ""}::${voice.name}::${voice.lang}`;
  }

  function populateVoices() {
    let available;
    try {
      available = synthesis.getVoices();
    } catch {
      available = [];
    }
    if (!available.length) return;

    voices = [...available].sort((left, right) => {
      const languageOrder = left.lang.localeCompare(right.lang);
      return languageOrder || left.name.localeCompare(right.name);
    });

    const fragment = document.createDocumentFragment();
    const systemOption = document.createElement("option");
    systemOption.value = "";
    systemOption.textContent = "System default";
    fragment.append(systemOption);
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voiceKey(voice);
      option.textContent = `${voice.name} (${voice.lang})${voice.default ? " — default" : ""}`;
      fragment.append(option);
    }
    voiceSelect.replaceChildren(fragment);

    const preferredExists = preferredVoiceKey === ""
      || voices.some((voice) => voiceKey(voice) === preferredVoiceKey);
    selectedVoiceKey = preferredVoiceKey !== null && preferredExists
      ? preferredVoiceKey
      : voiceKey(defaultVoice(voices));
    voiceSelect.value = selectedVoiceKey;
  }

  function defaultVoice(available) {
    const exactLanguage = available.find((voice) => voice.lang.toLowerCase() === documentLanguage && voice.default)
      || available.find((voice) => voice.lang.toLowerCase() === documentLanguage);
    if (exactLanguage) return exactLanguage;

    const languageFamily = documentLanguage.split("-")[0];
    return available.find((voice) => voice.lang.toLowerCase().startsWith(`${languageFamily}-`) && voice.default)
      || available.find((voice) => voice.lang.toLowerCase().startsWith(`${languageFamily}-`))
      || available.find((voice) => voice.default)
      || available[0];
  }

  function selectedVoice() {
    return voices.find((voice) => voiceKey(voice) === selectedVoiceKey) || null;
  }

  function playReport() {
    const intro = [...document.querySelectorAll(".report-header [data-tts]")];
    startReading([...intro, main], "Reading report from the beginning");
  }

  function startReading(scopes, label) {
    const nextQueue = buildQueue(scopes);
    if (!nextQueue.length) {
      announce("No readable text was found in this part of the report.");
      return;
    }

    stopReading(false);
    const thisRun = runId;
    queue = nextQueue;
    queueIndex = 0;
    completedCharacters = 0;
    totalCharacters = queue.reduce((total, chunk) => total + chunk.text.length, 0);
    phase = "playing";
    updateProgress(0);
    updateControls();
    announce(label);

    // A short delay after cancel() avoids a Safari race that can discard the next speak().
    window.setTimeout(() => speakNext(thisRun), 30);
  }

  function pauseReading() {
    if (phase !== "playing") return;
    synthesis.pause();
    phase = "paused";
    updateControls();
    announce("Audio paused.");
  }

  function resumeReading() {
    if (phase !== "paused") return;
    synthesis.resume();
    phase = "playing";
    updateControls();
    announce("Audio resumed.");
  }

  function stopReading(shouldAnnounce) {
    runId += 1;
    synthesis.cancel();
    queue = [];
    queueIndex = 0;
    completedCharacters = 0;
    totalCharacters = 0;
    phase = "idle";
    clearFollowAlong();
    updateProgress(0);
    updateControls();
    if (shouldAnnounce) announce("Audio stopped.");
  }

  function speakNext(thisRun) {
    if (thisRun !== runId || phase === "idle") return;
    if (queueIndex >= queue.length) {
      phase = "idle";
      clearFollowAlong();
      updateProgress(totalCharacters);
      updateControls();
      announce("Report finished.");
      return;
    }

    const chunk = queue[queueIndex];
    const utterance = new Utterance(chunk.text);
    utterance.rate = Number(rateSelect.value);
    utterance.lang = selectedVoice()?.lang || documentLanguage;
    utterance.voice = selectedVoice();

    utterance.onstart = () => {
      if (thisRun !== runId) return;
      setCurrentBlock(chunk.block);
    };
    utterance.onboundary = (event) => {
      if (thisRun !== runId) return;
      const localOffset = Math.max(0, Math.min(chunk.text.length, event.charIndex || 0));
      updateProgress(completedCharacters + localOffset);
      highlightBoundary(chunk, localOffset, event.charLength || 0, event.name || "word");
    };
    utterance.onend = () => {
      if (thisRun !== runId) return;
      completedCharacters += chunk.text.length;
      queueIndex += 1;
      updateProgress(completedCharacters);
      window.setTimeout(() => speakNext(thisRun), 0);
    };
    utterance.onerror = (event) => {
      if (thisRun !== runId) return;
      const errorName = event.error || "unknown error";
      stopReading(false);
      announce(`The audio reader stopped because speech synthesis reported ${errorName}.`);
    };

    try {
      synthesis.speak(utterance);
    } catch {
      stopReading(false);
      announce("This browser could not start speech synthesis.");
    }
  }

  function buildQueue(scopes) {
    const seen = new Set();
    const chunks = [];
    for (const scope of scopes) {
      for (const block of speakableBlocks(scope)) {
        if (seen.has(block)) continue;
        seen.add(block);
        const extracted = extractText(block);
        if (!extracted.text) continue;
        chunks.push(...chunkText(block, extracted));
      }
    }
    return chunks;
  }

  function speakableBlocks(scope) {
    const selector = "[data-tts], h1, h2, h3, h4, p, li, blockquote, figcaption, dt, dd";
    const candidates = [];
    if (scope.matches?.(selector)) candidates.push(scope);
    candidates.push(...scope.querySelectorAll(selector));

    return candidates.filter((candidate) => {
      if (candidate.closest("[data-tts-skip]")) return false;
      if (candidate.closest("[hidden], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (candidate.hasAttribute("data-tts")) return true;
      return !candidate.querySelector(selector);
    });
  }

  function extractText(block) {
    const rawText = block.textContent || "";
    const firstNonSpace = rawText.search(/\S/);
    if (firstNonSpace === -1) return { text: "", trimOffset: 0 };
    return {
      text: rawText.slice(firstNonSpace).trimEnd(),
      trimOffset: firstNonSpace,
    };
  }

  function chunkText(block, extracted) {
    const chunks = [];
    let cursor = 0;
    while (cursor < extracted.text.length) {
      while (/\s/.test(extracted.text[cursor] || "")) cursor += 1;
      if (cursor >= extracted.text.length) break;

      let end = Math.min(cursor + MAX_CHUNK_CHARS, extracted.text.length);
      if (end < extracted.text.length) {
        const windowText = extracted.text.slice(cursor, end + 1);
        const sentenceBreaks = [...windowText.matchAll(/[.!?](?:["')\]]*)\s+/g)];
        const lastSentence = sentenceBreaks.at(-1);
        const sentenceEnd = lastSentence ? lastSentence.index + lastSentence[0].length : 0;
        if (sentenceEnd >= Math.floor(MAX_CHUNK_CHARS * 0.45)) {
          end = cursor + sentenceEnd;
        } else {
          const whitespace = windowText.lastIndexOf(" ");
          if (whitespace > 0) end = cursor + whitespace + 1;
        }
      }

      const text = extracted.text.slice(cursor, end).trimEnd();
      if (text) {
        chunks.push({
          block,
          text,
          blockOffset: extracted.trimOffset + cursor,
        });
      }
      cursor = Math.max(end, cursor + 1);
    }
    return chunks;
  }

  function setCurrentBlock(block) {
    if (currentBlock === block) return;
    clearFollowAlong();
    currentBlock = block;
    currentBlock.classList.add("report-reader-current");
    currentBlock.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }

  function highlightBoundary(chunk, localOffset, reportedLength, boundaryName) {
    if (!window.CSS?.highlights || typeof window.Highlight !== "function") return;
    const textAfterBoundary = chunk.text.slice(localOffset);
    const inferred = boundaryName === "sentence"
      ? textAfterBoundary.match(/^.*?[.!?](?:["')\]]*)?(?:\s|$)/)?.[0].trimEnd().length
      : textAfterBoundary.match(/^\S+/)?.[0].length;
    const length = Math.max(1, reportedLength || inferred || 1);
    const start = chunk.blockOffset + localOffset;
    const end = Math.min(chunk.blockOffset + chunk.text.length, start + length);
    const range = rangeForTextOffsets(chunk.block, start, end);
    if (!range) return;
    window.CSS.highlights.set("pi-report-reader-follow", new window.Highlight(range));
  }

  function rangeForTextOffsets(element, start, end) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node;

    while ((node = walker.nextNode())) {
      const length = node.nodeValue?.length || 0;
      if (!startNode && start <= consumed + length) {
        startNode = node;
        startOffset = Math.max(0, start - consumed);
      }
      if (end <= consumed + length) {
        endNode = node;
        endOffset = Math.max(0, end - consumed);
        break;
      }
      consumed += length;
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, Math.min(startOffset, startNode.nodeValue?.length || 0));
    range.setEnd(endNode, Math.min(endOffset, endNode.nodeValue?.length || 0));
    return range;
  }

  function clearFollowAlong() {
    currentBlock?.classList.remove("report-reader-current");
    currentBlock = null;
    window.CSS?.highlights?.delete("pi-report-reader-follow");
  }

  function updateProgress(characters) {
    const maximum = Math.max(1, totalCharacters);
    const value = Math.max(0, Math.min(maximum, characters));
    const percent = totalCharacters ? Math.round((value / totalCharacters) * 100) : 0;
    progress.max = maximum;
    progress.value = value;
    progress.setAttribute("aria-valuetext", totalCharacters ? `${percent} percent` : "Not started");
    visualStatus.textContent = phase === "paused" ? `${percent}% paused` : phase === "playing" ? `${percent}%` : totalCharacters && value === maximum ? "Finished" : "Ready";
  }

  function updateControls() {
    pauseButton.disabled = phase !== "playing";
    resumeButton.disabled = phase !== "paused";
    stopButton.disabled = phase === "idle";
    updateLauncherLabel();
  }

  // Hiding the panel never stops playback, so the collapsed launcher has to
  // carry the transport state it is standing in for.
  function updateLauncherLabel() {
    const label = phase === "playing" ? "Listening" : phase === "paused" ? "Paused" : "Listen";
    launcherButton.textContent = label;
    launcherButton.dataset.readerPhase = phase;
    launcherButton.setAttribute(
      "aria-label",
      phase === "playing"
        ? "Show the audio reader. Currently playing."
        : phase === "paused"
          ? "Show the audio reader. Currently paused."
          : "Show the audio reader",
    );
  }

  function setPanelVisible(visible, options = {}) {
    const { focus = false, announceChange = false, persist = true } = options;
    panelVisible = visible;
    panel.hidden = !visible;
    launcherButton.hidden = visible;
    reader.dataset.readerCollapsed = visible ? "false" : "true";
    hideButton.setAttribute("aria-expanded", visible ? "true" : "false");
    launcherButton.setAttribute("aria-expanded", visible ? "true" : "false");
    if (persist) writePreference(STORAGE_HIDDEN, visible ? "0" : "1");
    updateLauncherLabel();
    if (!visible && helpDialog.hasAttribute("open")) closeHelp();
    if (focus) (visible ? playButton : launcherButton).focus();
    if (!announceChange) return;
    if (visible) {
      announce("Audio reader shown.");
    } else if (phase === "playing" || phase === "paused") {
      announce("Audio reader hidden. Playback continues. Press Alt plus Shift plus S to stop.");
    } else {
      announce("Audio reader hidden. Press Alt plus Shift plus L to show it again.");
    }
  }

  function announce(message) {
    liveStatus.textContent = "";
    window.setTimeout(() => {
      liveStatus.textContent = message;
    }, 20);
  }

  function openHelp() {
    if (helpDialog.hasAttribute("open")) return;
    if (typeof helpDialog.showModal === "function") helpDialog.showModal();
    else helpDialog.setAttribute("open", "");
  }

  function closeHelp() {
    if (typeof helpDialog.close === "function") helpDialog.close();
    else {
      helpDialog.removeAttribute("open");
      helpButton.focus();
    }
  }

  function isEditingTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, select, textarea, button, [contenteditable='true']"));
  }

  function isTextEntryTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, select, textarea, [contenteditable='true']"));
  }
})();
