export const clearChecklistItem3Tagged = `<result action="proceed" confidence="high">
<expanded_seed_prompt>
Design and implement a practical test and benchmark suite for agent/extensions/context-aware seed expansion and compaction handoff behavior. Focus on parser/preview tests for the tagged protocol, ambiguity handling, /compact-then and compact_session paths, approval/autonomous modes, compaction sequencing, transcript metadata, and failure handling. Relevant files are agent/extensions/context-aware/index.ts, agent/extensions/context-aware/seed-expansion.ts, agent/extensions/context-aware/seed-expansion-spec.md, agent/extensions/context-aware/package.json, and agent/extensions/context-aware/tsconfig.json. Verify with tsc -p agent/extensions/context-aware/tsconfig.json --noEmit --pretty false and the new test command.
</expanded_seed_prompt>
<assumptions>
- Item #3 refers to the latest active checklist item, not earlier completed items.
</assumptions>
<unresolved_questions>
(none)
</unresolved_questions>
<summary_focus_hints>
- Preserve that seed expansion must finish before compaction starts.
- Preserve that live preview uses tagged streamed output.
</summary_focus_hints>
</result>`;

export const ambiguousItem3Tagged = `<result action="clarify" confidence="low">
<question>
Which item #3 should the next phase continue: the earlier UI color-theme task or the later compaction sequencing tests?
</question>
<options>
- Earlier UI item #3: color theme.
- Later compaction item #3: sequencing tests.
</options>
<blocking_reason>
The conversation contains two plausible numbered lists and both have an item #3.
</blocking_reason>
</result>`;

export const legacyJsonProceed = JSON.stringify({
  action: "proceed",
  confidence: "medium",
  expanded_seed_prompt: "Continue by writing deterministic streaming tests for the seed expansion preview parser.",
  assumptions: ["The raw seed refers to the current parser task."],
  unresolved_questions: ["Confirm exact test runner before adding CI scripts."],
  summary_focus_hints: ["The parser accepts tagged output and JSON fallback."],
});
