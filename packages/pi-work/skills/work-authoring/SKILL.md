---
name: work-authoring
description: >-
  Draft a pi-work workspec when an outcome, scope, or proof obligation is still
  unclear. Use this before turning a conversation, issue, or design into a
  markdown draft, especially when acceptance criteria need to survive lossless
  promotion into strict YAML.
disable-model-invocation: false
---

# Work authoring

Use this skill when the work is still being shaped. The output of this skill is
an honest draft and a small set of observable acceptance criteria. It is not a
status record, a dispatch plan, or a promise that the work is complete.

Load and reuse `grilling` by name when the request is vague or has meaningful
tradeoffs. Load and reuse `domain-modeling` by name when the outcome has several
actors, states, inputs, or boundaries.
Those skills own the interview and modeling methods; this skill owns the
pi-work draft envelope and criteria discipline. Do not copy those skills into
this one.

## Keep the layers separate

A pi-work draft is Markdown. A promoted workspec is pure YAML. Promotion carries
marked content into the strict schema; it does not prove the work, run a worker,
or create lifecycle state.

Keep these layers distinct:

- **Draft** — a conversational document with up to four marked regions: summary, rationale, criteria, and optional decisions.
- **Workspec** — structured intent, a work graph, node-owned criteria, and proof
  obligations. It has no `status`, `done`, lifecycle, or review-approval field.
- **Execution** — the session agent decides ordering and uses pi-delegate for
  workers. pi-work owns no scheduler or loop.
- **Verification** — `work_verify` runs authored evidence against an explicit
  tree and commit. A cache or dispatch receipt is not verification.

Do not add a spec-level requirements list or a `satisfies` mapping. Acceptance
criteria belong to exactly one node. A cross-node requirement needs an explicit
integration node with its own criterion.

## 1. Interview the outcome

Before writing prose, establish the smallest useful model. Ask one question at
a time when the answer changes the work graph or proof:

1. What outcome should exist, for whom, and how will they recognize it?
2. What is in scope, what is explicitly out of scope, and what must not change?
3. What inputs, constraints, dependencies, and external actions matter?
4. Which result is observable in the target tree, and which result needs a user
   confirmation?
5. What would make the outcome unsafe to call complete?
6. Which decisions are unresolved, who decides them, and at what boundary must
   they be settled?

Use domain modeling to name actors and boundaries rather than inventing
implementation nodes from nouns in the request. Separate a deliverable from
an activity, and separate an activity from its evidence. If an answer cannot be
known yet, record it as an open decision in the eventual workspec; do not hide
it in a confident sentence.

A good intent says why the work exists, its constraints, and its non-goals. A
good description says what outcome the workspec represents. They are related but
not the same paragraph.

## 2. Write the marked draft

Use `.work/drafts/<name>.md` unless the repository has an established draft
location. The promotion markers must be the final content of column-zero ATX
headings. Drafts may contain up to four marked regions: summary, rationale,
criteria, and optional decisions. The headings for regions that are present
must be siblings at one level. Summary, rationale and criteria are the common
set; add decisions when the work has questions that are not yet answered:

```markdown
# Ship the accessibility report

## Summary <!-- work:summary -->
Publish an accessible report with a reproducible source record and a human
confirmation that the published copy is readable.

## Why <!-- work:rationale -->
The report is required for the release review. The source record makes the
numbers traceable; the non-goals are a redesign of the reporting pipeline and
an automated claim about a human reader's judgment.

## Open decisions <!-- work:decisions -->
- publication-target: Which channel publishes the report?
  Two are plausible and they need different accessibility checks.
  tripwire: Before the publishing node is dispatched.
  decides: user

## Acceptance criteria <!-- work:criteria -->
- source-record: The source record contains the measured inputs and the report build emits `source-records`.
- published-copy: A human confirms that the published copy is the intended report and is readable.
```

The exact criteria envelope is:

- one or more top-level bullets;
- `- <id>: <statement>` with an id matching
  `[A-Za-z0-9][A-Za-z0-9._-]*`;
- unique ids within this criteria region;
- a non-empty statement; and
- optional continuation lines indented by at least two spaces or one tab.

The decisions envelope is the same bullet shape with two required fields:

- `- <id>: <question>` with the same id pattern, unique within the region;
- a non-empty question;
- optional indented continuation lines, which extend the question; and
- exactly one indented `tripwire: <when it must be answered>` line and exactly
  one indented `decides: <who answers it>` line, both after any continuation.

`work_promote` turns each entry into an `open_decisions` record. A decision
without a tripwire is a question nobody is told when to answer, so promotion
refuses the whole draft rather than emitting one. Recording the question is
the point: an unanswered question belongs in this region, never dissolved into
a confident sentence in the rationale.

Two cautions the parser will not save you from. An indented line that is not
`tripwire:` or `decides:` is treated as question prose, so an invented field
such as `owner: finance` is silently appended to the question text — write
only the two fields this envelope defines. And a draft that puts its decisions
under a heading without the `<!-- work:decisions -->` marker promotes cleanly
with no decisions at all, because an unmarked heading is ordinary prose.

Do not put the marker in a paragraph, code fence, nested heading, or heading
with trailing prose after the marker. The region ends at the next heading of
the same or higher level. Keep the criteria region byte-stable: promotion is
lossless and the criterion statements are the source text that later reviewers
see.

Use EARS-style phrasing as writing discipline, not as a schema field. EARS
means expressing a requirement in terms of a condition, an actor or system,
an observable action, and an expected result. Prefer:

```text
When the report is built from the release inputs, the build emits
`source-records` and writes the named artifact.
```

over:

```text
The report works correctly.
```

Do not add `pattern`, `ears`, `satisfies`, or a requirement enum. The schema
stores the active `id`, `statement`, one evidence object, and an optional
recorded amendment chain. Criteria quality is judgment owned by this skill and
the later reviewer, not a guessed parser.

### One criterion, one check

A criterion carries exactly one evidence object, so a criterion that fuses two
different checks cannot express evidence for either. Split it.

The tell is that the halves would be proved differently. `npm test` runs the
compiled suite **and** a past mutant run was observed failing is two criteria:
the first is a `command`, the second is a `user` confirmation of something
already witnessed. Written as one, both collapse to `user`, the weakest kind,
and the machine-checkable half stops being checked.

Split on the evidence, not on the sentence. Two clauses proved by the same
command are one criterion; one clause needing two different proofs is two.

This is not enforced mechanically. Detecting it means guessing from wording,
and most criteria legitimately contain "and", so a check would flag honest
criteria and train its reader to ignore it. It is caught here and at review.

Splitting a criterion that is already promoted changes the draft too: every
criterion must match its draft text or carry a recorded amendment chain, so
amend the original through `work_amend_criterion` and add the new half to the
draft's criteria region.

## 3. Choose evidence honestly

Every promoted criterion needs one evidence kind:

- `command` has `run` and `expect.exit`. Add a non-empty
  `expect.output_includes` positive output floor whenever the command must prove
  an observed effect. The current schema still accepts an absent or empty floor,
  but `work_verify` fails closed for it; never write a criterion that only passes
  because a command exited 0. Optionally set `timeout_ms` alongside `run`
  and `expect` when a gate needs more than the 30,000 ms default; it must be
  an integer from 1,000 to 3,600,000 ms (one hour). Invalid values fail
  validation rather than being clamped. Draft Markdown criteria are preserved
  verbatim by `work_promote`; add `timeout_ms` to the evidence object when
  decomposing the promoted skeleton.
- `agent` names an agent, its named `inputs`, and a `rubric`. In v1 this returns
  the typed `agent-unavailable` outcome and fails closed because pi-work's
  trusted adapter for the required pi-delegate programmatic-client contract is
  not available. It is unavailable, not skipped. Do not inject a judge, call a
  private verifier, or treat an agent's prose as trusted evidence. Use `user`
  evidence for judgment work in v1.
- `user` has a `prompt`. It requires an explicit human confirmation through the
  host UI or an exact challenge in the real session file. Silence, an assistant
  statement, or a cache record is not confirmation.

Use `!md` for prose block scalars and `!bash` for shell evidence in the promoted
YAML. These tags are presentation only; they do not alter semantics. Other
allowlisted scalar tags are also syntax highlighting, not evidence authority.

## 4. Promote without claiming completion

Before promotion, check that the draft contains the required criteria marker.
`work_promote` carries that criteria block verbatim, retains the visible source-draft
path, and fails loudly when the block is missing or malformed. `work_validate`
re-reads that draft and derives each criterion's SHA-256 root from its statement;
no root value is authored in the workspec. Optional summary and rationale regions seed
`description` and `intent`; missing optional regions are reported explicitly,
not silently invented. If the host command can prompt for missing optional
regions, the command may do so; the non-interactive tool must not pretend that a
user supplied them.

After promotion, inspect the YAML rather than assuming the skeleton is sound:

- `title`, `description`, `intent`, and `work` are present;
- the first generated comment visibly names the source draft used for lineage;
- every node has an `id` and `task`;
- `work` and `checklist` are mutually exclusive on each node;
- `depends_on` names siblings only;
- each criterion is on one owning node and has exactly one evidence object;
- there is no lifecycle/status field; and
- each command criterion has a meaningful expected effect.

Run `work_validate({ path: "<spec-path>" })` and read its typed result. A
warning is not an error, but a valid result is not proof that the work happened.
Keep the source YAML and its validation output available for the decomposition
step.

## Authoring limits in v1

- Do not promise `verified-this-session` from a draft, a promoted file, a
  dispatch receipt, or a cache hit.
- `work_status --refresh` is blocked in v1, so the status surface cannot report
  `verified-this-session`. It reports observation states or `unverified` until a
  real authority constructor is available.
- A source-level `work_validate` or `work_promote` export can be exercised by
  tests or a direct host integration, but do not claim a tool ran unless the
  host actually registered and invoked it.
- Review approval is reporting data, not part of v1 `done`. A node is done only
  from current-session evidence green plus full checklist accounting.
- A green evidence result is narrow: it proves the authored evidence ran through
  the authoritative verifier for the explicit tree and commit and that the
  verifier accepted its concrete proof and checklist accounting. It does not
  prove hermetic execution, reproducibility, adequate criteria, independent
  truth of checklist or external-action claims, review approval, or durable
  authority after serialization.

If the request needs a capability that is not available, record the limitation
or an `open_decisions` entry. Never convert an aspiration into a criterion that
the v1 tools cannot execute or prove.
