# Analysis report reference

For report authors: when to use the house report templates and how to generate evidence-linked, self-contained output.

## Choosing and generating analysis reports

Markdown is the default for new outputs. The bundled
[`pi-artifacts-authoring`](../skills/pi-artifacts-authoring/SKILL.md) skill owns the one reader-action
decision guide and four optional small-output Markdown aids. Direct registration remains supported
when no aid fits. README and the other bundled skills point to that guide rather than duplicating its
table.

Choose interactive HTML only for a demonstrated navigation, filtering, comparison, or media need.
Use `templates/report/` combined output only for a deep technical audit whose readable prose must
link to detailed findings. The combined form keeps both layers in one self-contained artifact and
avoids sibling-path failures after separate registration.

Generated reports have no audio reader by default. Set `"audio": true` only for a narrative or
combined report whose reader asked to listen. Without that exact boolean, generated output has no
reader runtime, script wrapper, or claim that audio is present. Evidence navigation and GitLab
reference behavior remain independent. Existing stored artifact bytes are unchanged.

Write narrative and evidence fragments with unique `<section id="…">` elements. Map narrative
sections to one or more evidence sections in metadata:

```json
{
  "title": "Analysis title",
  "date": "2026-08-05",
  "provenance": "Agent analysis of repository state at commit abc1234",
  "evidenceMap": {
    "what-happened": ["event-log", "runtime-audit"],
    "what-to-do": ["findings-register"]
  }
}
```

Then generate one file:

```bash
node scripts/make-report.mjs \
  --kind combined \
  --body path/to/narrative-body.html \
  --evidence path/to/evidence-body.html \
  --meta path/to/combined-meta.json \
  --out path/to/report.html
```

### GitLab references in reports

Bake GitLab titles and states into the generated file so references remain useful offline. Supply a
manifest with the explicit `--references` flag:

```bash
node scripts/make-report.mjs \
  --kind combined \
  --body path/to/narrative-body.html \
  --evidence path/to/evidence-body.html \
  --meta path/to/combined-meta.json \
  --references path/to/gl-references.json \
  --out path/to/report.html
```

The manifest has one default project and entries keyed by GitLab reference token:

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

Use `#123` for an issue, `!7` for a merge request in the default project,
`group/project!7` for a cross-project merge request, and `@abcdef1` for a commit. For deliberate
references and custom visible text, write `<a data-gl-ref="#123">the tracking issue</a>`. An empty
anchor uses the token as its text. Existing links whose `href` matches a manifest URL are upgraded
without changing the author's link text; issue and work-item URL forms are treated as equivalent.
Known bare `#NNN` text is also linked by walking parsed text nodes. Text inside `code`, `pre`, `kbd`,
or an existing anchor is never changed.

Any GitLab-form token outside the exclusion contexts that is absent from the manifest stops
generation and names both the token and source file. This includes bare `#NNN` prose; add the correct
same-project or explicit cross-project reference instead of silently shipping an unresolved number.
Generated links carry kind, number, title, and state in one accessible name. Their
inline SVG shape also distinguishes open, closed, and merged states; color is only decorative. The
visual tooltip is hidden from assistive technology. Its script removes the native `title` fallback,
positions the tooltip against the viewport so evidence and table scrollers cannot clip it, and
closes it on blur or Escape.

Create or update a manifest from authored fragments with the authenticated `glab` CLI:

```bash
node scripts/gl-refs.mjs \
  --project group/project \
  --out path/to/gl-references.json \
  path/to/narrative-body.html path/to/evidence-body.html

# Refresh already-recorded titles and states as well as adding missing entries.
node scripts/gl-refs.mjs --project group/project --out path/to/gl-references.json \
  --refresh path/to/narrative-body.html path/to/evidence-body.html
```

The helper bulk-loads open and closed items with `glab ... list --all`, then calls `glab issue view`
for requested work-item types that list output omits. It authenticates before fetching and writes
only after every requested entry succeeds, so an authentication or lookup failure cannot replace a
good manifest with partial data. Commit the manifest and use it as the build input; report builds do
not contact GitLab.

Mapped narrative sections get an **Evidence** button, the header has a global **Evidence** toggle,
and `Alt+Shift+E` toggles the pane outside text-entry controls. On wide screens, evidence opens on
the right; on narrow screens, it replaces the narrative until **Back to the narrative** is used.
Opening from a mapped section selects its first target. With **Follow narrative** on, narrative
scrolling keeps that target synchronized. Manually scrolling evidence or choosing its own table of
contents turns follow off, announces the change politely, and leaves a visible control to resume it.

The evidence pane is `hidden` at startup, absent from the accessibility tree and tab order. Opening
moves focus into it; closing restores focus to the opening control and, on narrow screens, restores
the narrative scroll position. The evidence pane has its own heading, complete table of contents,
related-evidence links, close control, shortcut hint, and polite live status. Printing produces the
narrative followed by all evidence, with interactive controls suppressed.

Use `--kind narrative` or `--kind detailed` for a genuinely standalone reading mode. Those existing
kinds still use a relative `companionHref` and otherwise work unchanged. The helper rejects body
scripts, remote or unresolved resources, duplicate/missing section IDs, and every unknown
`evidenceMap` key or target. A reproducible example of all three kinds lives under
`examples/reports/`; the combined example turns its bare `#123` into a manifest-backed reference.
Regenerate all three files with `npm run reports:example`. Load the
`pi-artifacts-reports` skill for the full authoring and browser-verification workflow.
