---
name: pi-artifacts-authoring
description: >
  Choose an artifact format by the reader's next action, then use an optional small-output Markdown
  aid for a recommendation, experiment report, runbook/handoff, or verification record. Load before
  producing a durable deliverable for pi-artifacts when its form is not already fixed.
---

# Choose the artifact format by reader need

Start from the reader's next action. Markdown is the default. Register it directly with the
`artifact` tool; an aid or template is optional.

## Decision guide

| Reader's next action | Family | Default form |
| --- | --- | --- |
| Choose | Recommendation/design memo | Markdown |
| Understand | Explained technical audit | Markdown; combined HTML only when linked prose and detailed findings are both needed |
| Sort/find | Triage explorer | Interactive HTML only for a demonstrated navigation or filtering need |
| Compare | Experiment report | Markdown; focused HTML only for a demonstrated large-comparison need |
| Execute/resume | Plan, runbook, or handoff | Markdown |
| Verify | Verification record | Short Markdown plus media/data files |

Use interactive HTML only when the output demonstrates a navigation, filtering, comparison, or
media need that Markdown cannot present usefully. Use the combined report only for a deep technical
audit that needs readable prose linked to detailed findings. Load `pi-artifacts-reports` for that
case. Keep JSON, JSONL, CSV, screenshots, recordings, and archives as supporting files rather than
inventing a prose sidecar schema.

## Optional Markdown aids

Each aid is optional, permits a short output, and marks every section optional:

- [Recommendation/design memo](aids/recommendation-design-memo.md)
- [Experiment report](aids/experiment-report.md)
- [Runbook/handoff](aids/runbook-handoff.md)
- [Verification record](aids/verification-record.md)

Use only the sections that help the reader. When no aid fits, write the document needed and register
it directly. Direct registration remains a supported path for every format.

## Ownership boundary

- The companion development-tools package owns cross-project routing and output-selection
  skills. Its `choosing-output-format` skill loads this skill rather than carrying another
  decision table.
- This package owns registration and storage semantics, viewers, report templates and
  generators, and these authoring aids.
- Consuming repositories own their content, measurements, fixtures, and conclusions. They can
  register documents directly and do not need a universal artifact schema.

Generated narrative and combined reports omit audio unless metadata sets `"audio": true`. Stored
artifact bytes are unchanged; only newly generated output follows that setting.

Related work covers versioned templates, print/PDF output, and reader-oriented format selection.
The original design discussion is part of the project history; the implementation and current
reader guidance in this package are authoritative.
