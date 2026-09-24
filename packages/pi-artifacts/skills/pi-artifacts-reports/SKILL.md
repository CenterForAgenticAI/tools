---
name: pi-artifacts-reports
description: >
  Create self-contained HTML analysis reports with the pi-artifacts house templates: a recommended
  combined narrative-first report with synchronized evidence on demand, or standalone narrative and
  detailed reports. Use when agent-produced analysis needs verifiable evidence and an accessible,
  listenable explanation.
---

# pi-artifacts narrative-first reports

Use the combined report template by default when analysis has two valid reading modes:

1. a **narrative** that explains the result as a coherent story and can be read aloud by the browser;
2. **evidence** with the complete raw observations, tables, code, uncertainty, and severity.

The combined kind embeds both in one artifact. It opens narrative-first and reveals evidence on
demand. This is more reliable than a generated pair because separately registered artifacts do not
share sibling paths: their relative `companionHref` links can return 404. Use standalone
`narrative` or `detailed` kinds only when one reading mode genuinely stands alone. Do not add an
evidence layer to a brief answer or duplicate raw data merely to justify the format.

## What each report owns

### Narrative layer

Write for a person who wants the conclusion, the sequence of events, and the consequences.

- Lead with the situation and why it matters.
- Connect evidence in prose instead of copying tables.
- Explain technical terms on first use.
- End with decisions, consequences, or next steps.
- Keep paragraphs short enough to hear comfortably.
- Map each section to relevant evidence when verification material exists.

The generated narrative includes the dependency-free Web Speech API reader. It provides whole-report
playback, per-section playback, read-from-here controls, pause/resume/stop, rate and voice choices,
progress, follow-along highlighting, reduced-motion-aware scrolling, keyboard help, and a polite live
status. It creates no player when speech synthesis is unavailable.

The player is dismissible. **Hide** collapses it to a small **Listen** pill in the same corner, and
`Alt+Shift+L` toggles it from anywhere outside a text field. The choice persists across reports and
reloads, so a reader who never wants the player sees it once. Hiding never stops playback: the
collapsed pill reports `Listening` or `Paused`, and the live status region stays outside the
collapsed panel so a hidden player can still announce.

The evidence pane is independent of this player and works even when the Web Speech API is absent.
It has three opening affordances: a mapped section's **Evidence** button, the header's global
**Evidence** toggle, and `Alt+Shift+E` outside text-entry controls. The shortcut hint also appears in
the evidence header, not only in audio help. The pane starts `hidden` on every page load, so it is
outside the accessibility tree and tab order. Unlike the audio-reader panel, its open state and
follow state are never written to browser storage.

Opening moves focus to the pane. Closing returns focus to the exact opening control. Wide screens
show a fixed two-pane split; below 62rem, evidence replaces the narrative and **Back to the
narrative** restores both narrative scroll position and focus. The evidence pane has its own complete
table of contents. When a narrative section maps to multiple targets, it also shows links to the
remaining related evidence.

**Follow narrative** starts on. While it remains on, narrative scrolling synchronizes the evidence
pane to the visible mapped section's first target. A manual evidence scroll or an evidence table-of-
contents choice turns follow off and announces that change through a polite live region. Leave the
visible follow control available so the reader can resume synchronization. Opening or closing
evidence must not stop, pause, restart, or otherwise change audio playback.

### Evidence layer

Keep the evidence complete and easy to inspect.

- Preserve raw analysis, source excerpts, commands, output, and uncertainty.
- Put wide tables inside `<div class="report-table-wrap">`.
- Give every table a `<caption>` and use `<th scope="col">` or `<th scope="row">`.
- Use `<pre><code>` for code and command output.
- Use `.severity` with `.severity-critical`, `.severity-high`, `.severity-medium`,
  `.severity-low`, or `.severity-note` where a compact severity label helps.
- Keep evidence section IDs stable so narrative mappings remain valid.

## Source files

The package owns these stable inputs:

```text
templates/report/
├── combined-template.html
├── narrative-template.html
├── detailed-template.html
├── report-evidence.js
├── report-gl-refs.js
├── report-reader.css
└── report-reader.js
```

Do not copy these assets into another project and edit them there. Use the generator so the output
contains the current versioned CSS and reader runtime.

Author each body as an HTML fragment, not a complete document:

```html
<p>Optional opening context.</p>

<section id="situation">
  <h2>The situation</h2>
  <p>Story-form analysis…</p>
</section>

<section id="consequence">
  <h2>What it means</h2>
  <p>Consequence and next step…</p>
</section>
```

Every section needs a unique, quoted `id` and a non-empty heading. IDs must also be unique across the
two fragments in a combined report. The generator uses narrative IDs for the primary table of
contents and audio section playback; evidence IDs go only into the evidence pane's table of contents.

Create combined metadata with an `evidenceMap`. Every key must name a narrative `<section id>` and
every array value must name one or more evidence `<section id>` values. Omit a narrative section when
it has no evidence affordance.

```json
{
  "title": "Analysis title",
  "deck": "One-sentence description of this report.",
  "date": "2026-08-05",
  "provenance": "Agent analysis of repository state at commit abc1234",
  "language": "en",
  "evidenceMap": {
    "situation": ["event-log", "runtime-audit"],
    "consequence": ["findings-register"]
  }
}
```

The generator fails closed when a map key or target is unknown and names both the bad ID and the
fragment where it was expected. Do not add `companionHref` to combined metadata. If supplied, it is
ignored with a warning because evidence already lives in the same artifact.

## Generate the combined report

Run from the pi-artifacts repository:

```bash
node scripts/make-report.mjs \
  --kind combined \
  --body path/to/analysis-narrative-body.html \
  --evidence path/to/analysis-evidence-body.html \
  --meta path/to/analysis-combined-meta.json \
  --references path/to/gl-references.json \
  --out path/to/analysis.html
```

Omit `--references` only when the report has no GitLab references. The reference manifest is a
committed build input, not a runtime cache:

```json
{
  "defaultProject": "group/project",
  "references": {
    "#123": {
      "kind": "issue",
      "iid": 123,
      "title": "Make report citations self-contained",
      "state": "opened",
      "url": "https://gitlab.example/group/project/-/work_items/123"
    }
  }
}
```

Use these authoring forms:

- `#123` for a same-project issue;
- `!7` for a same-project merge request;
- `group/project!7` for a cross-project merge request;
- `@abcdef1` for a commit;
- `<a data-gl-ref="#123"></a>` for an explicit reference whose visible text should be the token;
- `<a data-gl-ref="#123">the tracking issue</a>` to preserve custom visible text.

The generator also upgrades an existing anchor when its `href` matches a manifest URL. It treats
`/-/issues/123` and `/-/work_items/123` as the same target and keeps the authored link text. It
walks parsed text nodes to link known bare `#NNN` tokens in prose. It never changes text inside
`code`, `pre`, `kbd`, or an existing anchor. Do not hand-edit code or command evidence to work
around linking.

Any GitLab-form token missing from the manifest stops generation and names the token and fragment
file, including bare `#NNN` prose outside the exclusion contexts. This is deliberate: add the correct
same-project entry or an explicit cross-project anchor instead of publishing a reference whose title
and state were not baked in. Each generated anchor's accessible name contains kind, number, title,
and state. Open, closed, and merged states
also use different inline SVG shapes, so color is not the only cue. The visual tooltip is
`aria-hidden`. Never add `aria-describedby` alongside the complete `aria-label`; that would announce
the same information twice. With JavaScript disabled, `title` supplies a native fallback. With
JavaScript enabled, the enhancement removes `title`, uses a fixed viewport-positioned tooltip that
cannot be clipped by the evidence or table scrollers, and dismisses it on blur or Escape.

Build or refresh a manifest before report generation when references change:

```bash
node scripts/gl-refs.mjs \
  --project group/project \
  --out path/to/gl-references.json \
  path/to/narrative-body.html path/to/evidence-body.html

node scripts/gl-refs.mjs \
  --project group/project \
  --out path/to/gl-references.json \
  --refresh \
  path/to/narrative-body.html path/to/evidence-body.html
```

The helper authenticates `glab` first, bulk-loads both open and closed items with `--all`, and falls
back to `glab issue view <iid>` when an issue or work-item type is absent from list output. It merges
only after every requested lookup succeeds and writes atomically. An authentication or lookup
failure leaves the prior manifest unchanged. Never refetch during a deterministic report build.

Metadata can instead be passed with `--title`, `--deck`, `--date`, `--provenance`, `--language`,
`--companion`, and `--companion-label`. The companion flags apply only to standalone narrative and
detailed reports. Command-line values override the metadata file. Run `node scripts/make-report.mjs
--help` for the compact reference.

The generator calculates reading time, builds the table of contents, escapes metadata, expands
manifest-backed references, and inlines the shared CSS and JavaScript. No runtime uses an external
script. Treat
generated HTML as build output: revise the body or metadata, then regenerate instead of hand-editing
the final file.

For standalone output, keep using `--kind narrative` or `--kind detailed` with the existing
`companionHref` metadata. See `examples/reports/` for all three generated forms. Regenerate them with:

```bash
npm run reports:example
```

## Self-contained rule

Each final report must work as one HTML file without the artifacts daemon or a network connection.

- Never load a CDN, remote script, stylesheet, web font, image, audio file, video, or iframe.
- Do not rely on an external URL for rendering, layout, playback, or meaning.
- Inline small images as `data:` URLs or use authored inline SVG.
- Keep source citations readable in the document itself. A citation link may be useful online, but
  its label and surrounding text must still identify the source offline.
- Prefer one combined artifact so registration cannot break a relative sibling link.

The generator rejects body scripts, remote CSS resources, non-inline resource attributes, and
external companion links. It runs the same self-containment check over both combined fragments and
the final HTML. Ordinary source links do not make the report dependent on the network.

## Accessibility checklist

Before registering a report, confirm:

- [ ] One `<h1>` comes from metadata; section headings begin at `<h2>` and do not skip levels.
- [ ] Every top-level section has a stable, unique `id`.
- [ ] Link text explains its destination without relying on “click here.”
- [ ] Images have useful `alt` text; decorative images use empty `alt=""`.
- [ ] Tables have captions, scoped headers, and no layout-only cells.
- [ ] Color is not the only way severity or status is communicated.
- [ ] Every generated GitLab reference names its kind, number, title, and state; its tooltip is
      `aria-hidden` and the anchor has no `aria-describedby`.
- [ ] Bare issue tokens remain literal inside `code`, `pre`, `kbd`, and authored links.
- [ ] The narrative makes sense as plain text and contains no instruction that depends only on
      visual position.
- [ ] Content remains normal semantic DOM text. Never add `aria-hidden` to report content to make
      the audio reader easier to implement.
- [ ] Evidence starts with the `hidden` attribute, enters the accessibility tree only when opened,
      and contains no audio section buttons.
- [ ] Opening evidence moves focus into its pane. Closing restores focus to the opener; narrow mode
      also restores narrative scroll position.
- [ ] Manual evidence scrolling and evidence table-of-contents choices turn follow off and announce
      the change through a polite live region.
- [ ] The report does not autoplay. Playback starts only after a person activates a control.
- [ ] Every authored interactive control has an accessible name and works from the keyboard.
- [ ] At 200% zoom, content remains readable without horizontal scrolling except inside deliberate
      table and code scrollers.
- [ ] Print preview has readable contrast and does not include the floating audio controls.
- [ ] Light and dark system themes both remain legible.

The browser reader supplements real screen readers. It does not replace normal headings, landmarks,
link text, table semantics, or alternative text.

## Browser verification

Open the generated combined report in a current Chromium or Safari browser and check:

1. **Play** reads the title, description, and body. Pause, Resume, and Stop update state correctly.
2. **Read this section** stops current speech and reads only that section.
3. **Read from here** reads the selected section and every later section.
4. Rate and voice choices survive a reload when storage is available.
5. The voice list appears even when the browser loads voices after the page.
6. Progress advances and the current passage is highlighted. Browsers without speech boundary
   events still highlight the current paragraph.
7. Follow-along scrolling becomes immediate, not smooth, when reduced motion is enabled.
8. The Help dialog documents `Alt+Shift+Space`, `Alt+Shift+S`, `Alt+Shift+H`, and `Alt+Shift+L`.
9. Navigating away cancels speech.
10. With speech synthesis disabled or unavailable, no audio player or section audio buttons appear.
11. **Hide** collapses the player to the `Listen` pill, moves focus to it, and persists the choice;
    the pill restores the panel and returns focus to **Play**. `Alt+Shift+L` toggles both ways.
12. Hiding mid-playback keeps the audio running and the pill shows the transport state.
13. The initial view is narrative-only; evidence is absent from the accessibility tree and tab order.
14. Every mapped section has one **Evidence** button with the section title in its accessible name;
    unmapped sections have no evidence button.
15. Section buttons open the first mapped target and move focus to the pane. The global toggle uses
    the visible mapped narrative section, then falls back to the first evidence section.
16. Narrative scrolling follows mapped targets. A manual evidence scroll and an evidence table-of-
    contents choice each turn follow off and produce a polite announcement; the follow control
    resumes synchronization.
17. Closing returns focus to the opening control without changing active audio playback.
18. Below 62rem, evidence replaces the narrative and **Back to the narrative** restores narrative
    scroll and focus. At or above 62rem, both panes remain visible.
19. A GitLab reference tooltip opens on hover and keyboard focus, closes on blur and Escape, flips
    near viewport edges, and remains visible when its anchor is inside the evidence pane or a wide
    table scroller. Confirm the native browser tooltip does not also appear.
20. Print preview contains the narrative followed by every evidence section, with reader and evidence
    controls omitted.

Voice availability and boundary events depend on the browser and operating system. Do not promise a
specific installed voice or word-level boundary behavior.

## Validate and register

Run the repository checks after changing the template, helper, or source examples:

```bash
npm run check
```

Then register the one generated combined file as an artifact and return its viewer URL. Keep the
source bodies and metadata in the producing project when the report may be regenerated later.
