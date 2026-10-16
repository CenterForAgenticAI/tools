# Fold parity

`/fold-parity` reports shadow comparisons while billion-context-pi owns live folding.
It is a command, not a tool. The recorder does not change tool input, provider
messages, session entries, or the legacy `.acp.json` side file.

## What is compared

For every live `compress` call, including nested calls inside Fabric programs,
the recorder snapshots the branch and the legacy side file before and after
execution. It imports the prior folds into an **in-memory** session, translates
legacy refs, and plans the request using the native fold engine's boundary drain
path. It compares outcomes, created block counts, editable-entry coverage, tiers,
and absorbed blocks. It also records ref continuity and partial-entry coverage.

### Outcome and error type

Each call record has a typed outcome for each engine: `oursOutcome` for the
native preview and `bcpOutcome` for what billion-context-pi returned. The
recorder classifies the result text before it hashes it. Only the category is
stored, never the text.

| Outcome | Native engine | billion-context-pi |
|---|---|---|
| `accepted` | at least one fold, no request dropped | blocks created, no `Errors:` line |
| `partial` | at least one fold and a dropped request | blocks created and an `Errors:` line |
| `rejected` | no fold | result panel with 0 blocks |
| `no-op` | `content` is an empty array | `No ranges provided.` |
| `invalid-input` | no range could be parsed | `Invalid compress content (...)` or Pi's argument validation error |
| `tier3-rewrite` | never | the tier-3 rewrite rejection |
| `dead-range` | never | the repeated dead-range rejection |
| `capped-retry` | never | the per-turn retry cap |
| `aborted` | never | `Operation aborted` |
| `unknown` | | any other text |

A rejected or partial outcome also has sorted reason codes. These come from the
kernel and adapter error messages on both sides: `summary-empty`,
`summary-short`, `summary-long`, `unknown-ref`, `dangling-ref`, `consumed`,
`protected-zone`, `split`, `too-small`, `no-fold`, `header-missing`,
`stub-summary` (the native adapter refused a cut-off summary; see FP-008), or
`other` for a message that no pattern recognizes. billion-context-pi joins its errors
on one `Errors:` line; each `range <start>..<end>: <message>` error, and each
further line, is classified on its own. A recognized error therefore cannot hide
an unrecognized one, which adds `other`. If billion-context-pi creates no
blocks and reports no error, its reason is `no-fold`, which is what the native
adapter reports in that case.

The next `context` event compares the provider message list produced by
billion-context-pi with an in-memory preview of our folds, planned in call order.
The recorder runs before context-aware's history repair handler. ACP tags are
removed before hashing. Summary sequences (topic-line hash and body hash) are
compared in order; non-summary messages are compared as a multiset of role and
text hash. Images are outside this comparison.

Tool calls and tool results are compared separately from text:

- **Tool calls**: the multiset of assistant tool calls, each as its id, its tool
  name and a hash of its arguments. Arguments are serialized with sorted keys,
  so key order does not count as a difference.
- **Tool results**: the multiset of tool results, each as the id of the call it
  answers, its tool name, its error flag and the hashes of its whole text. A
  result that starts with the summary header keeps its topic-line hash in this
  tuple as well as its body hash. Because the text is keyed by the call id, a
  result that answers a different call is a difference, even when every id,
  name and error flag is unchanged.
- **Pairing**: results with no earlier matching call, and calls with no result.

Through the call id, each call's id, name and argument hash is compared with
the error flag and text hashes of the result that answers it. Ids and names that
look like identifiers are stored as they are. Any other id or name is hashed.
Argument values and result bodies are never stored. A tool call or result
without an id or a name cannot be compared, and two calls that share an id make
the binding ambiguous, so the request comparison is then inconclusive. No ACP tags observed also makes the request comparison
inconclusive.

Comparisons and JSONL appends run off the tool/provider critical path on one
serial writer per process, so at most one append is in progress at a time. Call records can precede their next-request evidence; until that
request arrives they do not establish readiness.

## Memory bounds

The recorder checks its bounds before it copies anything. One budget applies to
the whole process: every session, and every runtime that registers the
extension, including a replacement runtime while the outgoing runtime's work is
still running.

- at most 128 MiB of estimated retained data (branch copies, call inputs and
  side-file snapshots). Text counts two bytes per character. A typed-array view
  counts its whole backing buffer, because a copy copies all of it. Maps and Sets
  count their entries. A value the recorder cannot size (a class instance, an
  error, a function) is not copied; the call is inconclusive.
- at most 8 branch copies at once, counting started calls, queued call
  comparisons and next-request previews;
- at most 1,000 call identities per recorder, counting started calls and calls
  that wait for the next provider request;
- at most 1,000 outstanding work items: started calls that hold a branch copy,
  plus queued comparisons, previews, records and failure records. An item stays
  reserved until its append completes, also after a session reset.

A call that would pass a bound keeps only its ids and is recorded as
inconclusive (`too-large`, reason `shadow recorder budget exceeded`). A call
whose side file is missing or unusable is handled the same way: the recorder
does not copy the branch for it. When any call in a batch is inconclusive, the
next-request comparison for that batch is inconclusive too, and the recorder does
not copy the branch again for it. If the work bound is full, a record is counted
instead of queued. When the queue empties, one inconclusive
`recorder-dropped/<n>` call record states how many were dropped. That marker is
the only write outside the work bound, and only one is written at a time. A call
whose identity was dropped never receives next-request evidence, so it stays
inconclusive.

A call's input and side-file snapshot have two owners: its own comparison and
the next-request preview. Their bytes stay counted until both have released
them. A branch copy is released as soon as its comparison has produced its
record, before the append. A session reset or shutdown releases what the session
holds and turns its queued comparisons and previews into small inconclusive
records (`recorder-error`, reason `session ended before the comparison ran`), so
their content is dropped at once. A comparison that is already running keeps its
reservation until it finishes.

## Differences and verdicts

Call differences: `outcome` (the outcome types differ), `error-type` (same
outcome, different reason codes), `outcome-unknown`, `block-count`, `coverage`,
`tier`, `absorbed`, `input-parse`, `ref-unmapped`, `import-unsupported`,
`import-skipped`, `side-file-missing`, `too-large`, and `recorder-error`.
Request differences: `summaries`, `content`, `tool-calls`, `tool-results`,
`tool-pairing`, `tool-evidence`, and `tags-absent`.

- **match**: no differences.
- **diff**: differences need investigation or a register explanation.
- **inconclusive**: `side-file-missing`, `import-unsupported`, `ref-unmapped`,
  `too-large`, `tags-absent`, `recorder-error`, `tool-evidence`, or
  `outcome-unknown` prevents a valid comparison. An `unknown` outcome or an
  `other` reason code on either side gives `outcome-unknown`; it is never
  treated as equal.

The report also treats a stored `import-skipped` diagnostic as inconclusive,
even when the recorder verdict is `diff` or a register entry explains it.

The native engine has no retry cap, dead-range breaker, tier-3 rewrite
rejection or abort of its own. Calls that end that way in billion-context-pi
are therefore `outcome` differences. Register entries FP-004 to FP-007 explain
them.

Side files are capped at 8 MB; branches at 50,000 entries; persisted message
hash lists at 2,000 entries. Exceeding a bound is inconclusive, not a match.
Coverage difference lists include at most 50 ids per side, with full counts and
SHA-256 hashes of the full sorted coverage lists. Created, absorbed and active
block-id lists are capped at 2,000 entries; a capped list makes readiness inconclusive.

### Complete report-time diff-kind table

(a) Recomputed from stored evidence; (b) inconclusive by nature, with the stored
kind blocking readiness even if a register explains it; (c) cannot be contradicted.
No current kind needs category (c). Stored and recomputed diagnostics are united.
The enumeration test requires exactly one row for every `DiffKind`.

| Kind | Class | Report-time evidence or blocking reason |
| --- | --- | --- |
| `outcome` | a | `oursOutcome.type` versus `bcpOutcome.type`, through `compareOutcomes`. |
| `error-type` | a | Both outcomes' sorted `reasons`, through `compareOutcomes`. |
| `outcome-unknown` | a | Either outcome's `type: unknown` or `reasons: other`; always blocking. |
| `block-count` | a | Both BlockEvidence `count` values. |
| `coverage` | a | Both `coverageCount` and full `coverageHash` values; retained prefixes diagnose contradictions, and an uncapped list must match its hash. |
| `tier` | a | Both BlockEvidence ordered `tiers` arrays. |
| `absorbed` | a | Both BlockEvidence `absorbed` id sets; capped evidence is inconclusive. |
| `input-parse` | a | Compress `parseKind` other than `ok`, or `parseInvalidItems` greater than zero; missing parse evidence is inconclusive. |
| `ref-unmapped` | a | Compress `refs` with absent or `BLOCKED` native mapping; missing or capped ref evidence is inconclusive. |
| `import-unsupported` | b | Unsupported or unreadable side-file input is not retained; no valid import comparison exists. |
| `import-skipped` | b | The import could not supply all prior folds; its raw source is not retained. |
| `side-file-missing` | b | No independent side-file evidence was available. |
| `too-large` | b | Bounds prevent retaining complete comparison input. Request message-count limits are also recomputed from both `total` values. |
| `recorder-error` | b | Failed or cancelled work cannot establish equality. Missing evidence, summary-array lengths and linked created/absorbed/active id contradictions also reconstruct this kind. |
| `summaries` | a | Both ordered summary topic/body hashes and native expected-summary arrays, count and render. |
| `content` | a | Both requests' non-summary role/text-hash multisets. |
| `tool-calls` | a | Both requests' call-id/name/argument-hash multisets. |
| `tool-results` | a | Both requests' result call-id/name/error/summary/topic/body-hash multisets. |
| `tool-pairing` | a | Both requests' results without earlier calls and calls without results. |
| `tool-evidence` | a | Either request's incomplete tool evidence or duplicate call ids; always blocking. |
| `tags-absent` | a | Provider request `bcp.tagsSeen: false`; always blocking. |

## Count and cut-over rule

The fingerprint is SHA-256 over sorted relative paths and contents of compiled
`.js` files under `folds/`. The command displays its first 12 hex characters.
The effective `folds.firstUserMessage` and `folds.firstUserMessageMaxTokens`
values are hashed with that engine fingerprint. Their sources are not hashed.
Only calls recorded under the current fingerprint count. The most recent 500
calls determine readiness: at least 500 calls, no unexplained differences and
no inconclusive calls, including their next-request evidence. An engine change
resets the count. Recorder and register changes do not change the fingerprint.
Records also carry a schema version (`v`, currently 5). Version 5 adds full
coverage hashes, native created and active block ids, id-list cap flags, and
parser invalid-item counts. Versions 3 and 4 never shipped; main writes version
2. Versions 1–4 do not count toward readiness. The store reader skips every
older version and rejects any other value, including a newer version, so
readiness is then unknown.
Each next request carries the preview's active-fold count and sorted active
block ids after imports, accepted calls and absorption. The active-id list and
both expected-summary arrays must have that count, including zero for a genuine
no-fold request. Disagreement is inconclusive even if stored diffs are empty.
Parity-only changes do not alter the fold-code fingerprint, so the
schema change resets earlier counts even when the fingerprint is unchanged.

### Report-time trust boundary

The report guards against bugs in our own evidence collection and comparison,
and against stale or inconsistent records. It does not guard against a deliberately
fabricated record set that is consistent everywhere, including with bcp's
independent evidence: that is indistinguishable from a genuine no-op.
bcp's side of each record is the independent source: `bcp` BlockEvidence from
its side file, `bcpOutcome` from its tool result, and `bcp` RequestHashes from
the provider request. Our side must agree with it, or the difference must be
explained.

Stored diffs cannot certify a match. At report time, each request with both
sides' hashes is compared again with `compareNextRequest`. Block-count, tier,
absorbed-block and outcome comparisons also run again on stored call evidence.
Full coverage counts and hashes are always compared, including when the
50-id diagnostic prefixes are capped. Prefix contradictions also produce a
coverage difference. An uncapped prefix must hash to its stored digest.
The recorder uses the same block comparison helper with its full coverage lists.
The report uses the union of stored and recomputed diffs, so a stored diagnostic
that bounded evidence cannot reproduce remains effective.

The report and the CI differential use one validator, `parityEvidenceFault` in
`src/parity/evidence.ts`. A conclusive compress record needs both BlockEvidence
values with every field, both outcomes, parse evidence and ref evidence. A
conclusive request needs both RequestHashes values, linked call IDs and our
expected summary evidence. Outcome types, reject reasons, parse kinds, fold tiers
and diff kinds must come from the recorder's closed vocabularies, and each count
must agree with the list it describes. Missing, unknown or inconsistent evidence
is a recorder fault, not a match. The optional `counterfactualOurs` is checked
like `ours` when it is present.

A next request's refusal evidence has its own check in the same file,
`refusalEvidenceFault`. A refusal entry (FP-004 to FP-007) explains nothing until
the evidence passes it. The check requires all of these:

- `refused` is a non-empty array. Each item has a non-empty call ID from this
  request's `toolCallIds`, no ID appears twice, and each ending is one of
  `REFUSAL_OUTCOMES` in `src/parity/records.ts`.
- `counterfactual.diffs` is an array of diffs. Each diff has a known kind, and
  any counts, ID lists and reason it holds have the correct types.
- `counterfactual.delta` matches `RequestDelta`, with only the fields that
  `refusedFoldDelta` in `src/parity/compare.ts` writes. The verdict
  `refused-folds-only` has no reason and needs `refusedFolds`, `coveredEntries`
  and `removedMessages`. The verdict `other` needs a reason from
  `RequestDeltaReason` and the counts that reason carries: `removedMessages` for
  `summary-missing`, and both `removedMessages` and `mismatchAt` for
  `message-changed`. Each count is a safe non-negative integer. A missing count,
  an extra count, or an unknown field is a fault.
- `counterfactualOurs` is valid RequestHashes.

The writer always writes complete evidence. If the stored evidence is partial
or malformed, the request's differences stay unexplained: they count as `diff`,
not `explained`. This applies even when the delta's verdict alone says
`refused-folds-only`.

Both gates also count calls with one judgment, `judgeParityCalls` in
`src/parity/report.ts`. It recomputes each record's diffs from both sides'
evidence and joins them with the stored diffs, so a record stored as a match
still fails when its evidence disagrees. The differential takes this judgment
from the built package and lists every failing call; the report counts the last
500. The differential also fails on a request that links no call in its case.
A stored inconclusive verdict also remains inconclusive. Every call needs a
linked next request, regardless of its `awaitingNextRequest` flag.

The recorder writes one compress record per call and lists each call in
exactly one next request. The report enforces this for each session id and
tool call id pair. A second compress record for the same call, a call linked
by more than one request, or a request that lists a call twice is a recorder
fault. The affected calls and requests are inconclusive, so one call cannot
count toward the 500 more than once.

The cross-record check uses block-id sets, not count arithmetic. In linked
`toolCallIds` order it collects native `createdIds` and `absorbed` ids. Every
created id not subsequently absorbed (including within the same call) must
appear in the request's `activeFoldIds`. No absorbed id may remain active.
Created-id lengths must equal call counts. Missing, duplicate, reused or capped
ids make the request inconclusive. Imported ids may remain active without
being created by a linked call, unless a linked call absorbed them. All linked
calls are checked, including calls outside the latest 500-call window.

Why this check is sound for engine-generated ids: `previewShadowCalls` uses one
isolated manager, appends every accepted range's drafts, and retains absorbed
metadata. `foldStateFromBranch` rebuilds `nextBlockId` as the highest retained
block number plus one. The kernel's `allocateBlockId` increments that counter.
Rejected ranges append nothing. Imports preserve bcp ids; an already-folded
branch is not imported again. Thus accepted ranges cannot reuse an id within a
preview. Internal absorption (`b1`, then `b2` absorbing `b1`) requires only `b2`
active. Absorbing imported `b1`/`b2` and independently creating `b3`/`b4` requires
both new ids active, rather than subtracting imported ids from the created count.

### Regression mutation checks

Version-5 verification killed 34 mutations: each named test failed an assertion
with exit 1, and every mutation was restored. Code mutations changed only the
generated test build. The table mutation temporarily removed one documentation
row, without changing its test.

Unless noted, tests are in `tests/fold-parity-summary-evidence.test.ts`.

| Control removed or broken | Test that went red |
| --- | --- |
| Full sorted digest | R5 coverage hash is the full sorted SHA-256 digest |
| Full coverage count | R5 capped coverage count contradiction blocks readiness at 500 |
| Full coverage digest | R5 capped coverage tail contradiction blocks readiness at 500 |
| Retained prefix comparison | R5 capped coverage prefix contradiction blocks readiness at 500 |
| Uncapped digest consistency | R5 uncapped coverage must agree with its full digest |
| Failed parse reconstruction | R5 failed parse evidence cannot be cleared into a match at 500 |
| Invalid parser item reconstruction | R5 ok parse with dropped items cannot lose input-parse |
| Unmapped ref reconstruction | R5 unmapped stored refs are reconstructed |
| Required parse kind | R5 conclusive calls require parseKind evidence |
| Required invalid-item count | R5 conclusive calls require parseInvalidItems evidence |
| Required refs | R5 conclusive calls require refs evidence |
| Required ref continuity | R5 conclusive calls require refContinuity evidence |
| Ref cap consistency | R5 capped ref evidence is inconclusive |
| Block count versus tiers | R5 block counts must agree with tier evidence |
| Active-id length | R5 active ids length evidence is inconclusive |
| Active-id uniqueness | R5 active ids duplicate evidence is inconclusive |
| Active-id sorting | R5 active ids must remain sorted |
| Active-id cap | R5 active ids capped evidence is inconclusive |
| Created-id length | R5 created ids length evidence is inconclusive |
| Linked id reuse | R5 linked calls cannot reuse a created block id |
| Created survivor membership | R5 imported absorption cannot hide a surviving created id at 500 |
| Absorbed-id absence | R5 an absorbed imported id cannot remain active |
| Created-id cap checks | R5 created ids capped evidence is inconclusive |
| Absorbed-id cap checks | R5 absorbed ids capped evidence is inconclusive |
| Stored-diff union | R5 matching capped coverage preserves stored diagnostics in the union |
| Import-skipped blocking | R5 import-skipped remains blocking even with a register explanation |
| Request recomputation | R4 lost summaries with stored match are recomputed at 500 |
| Recorder active-id field | recorder settings reach previews, persist folded-opening evidence and reset the command window (`fold-parity-recorder.test.ts`) |
| Recorder cap field | recorder settings reach previews, persist folded-opening evidence and reset the command window (`fold-parity-recorder.test.ts`) |
| Created-id capture | R5 imported absorption cannot hide a surviving created id at 500 |
| Internal absorption allowance | R4 within-call absorption and later zero-created calls preserve a sound bound |
| Empty initial created set | a genuine no-fold preview remains a valid match at 500 calls |
| FP-001 explanation | R4 genuine accepted evidence and FP-001 reach readiness at 500 |
| One diff-kind table row | R5 every DiffKind has exactly one report-time evidence table row (`fold-parity-report.test.ts`) |

An active-length mutation initially survived because the missing survivor also
blocked the fixture. The fixture now has an extra allowed imported id, while
its count and summary arrays remain unchanged. It isolates the length check.
The duplicate-active fixture likewise has coherent counts and summaries.

Independent synthetic probes use genuine 55-entry comparator coverage and
check its digest with Node's SHA-256 over sorted JSON ids. Count 56 versus 55,
a changed prefix, a changed tail, failed parsing with cleared diagnostics and
imported absorption with one surviving id all block readiness at 500, both
in memory and after JSONL round-trip. Genuine two-survivor imported absorption,
accepted FP-001 and no-fold controls reach readiness in both forms.

#### Earlier round-four checks

Round-four checks mutate generated test-build code only, leaving tracked source
and assertions unchanged. Each mutation below failed a named assertion (exit 1),
then was restored. All named tests are in
`tests/fold-parity-summary-evidence.test.ts`.

| Control removed or broken | Test that went red |
| --- | --- |
| Request recomputation | R4 lost summaries with stored match are recomputed at 500 |
| Block-count comparison | R4 block-count is recomputed despite empty stored diffs |
| Evidence fault checks | R4 conclusive records missing either side or outcome are inconclusive |
| Unconditional request linkage | R4 every call needs a linked request without trusting awaitingNextRequest |
| Cross-record bound | R4 erased count and evidence cannot contradict linked accepted calls at 500 |
| Coverage comparison | R4 coverage is recomputed from compress evidence |
| Tier comparison | R4 tier is recomputed from compress evidence |
| Absorbed comparison | R4 absorbed is recomputed from compress evidence |
| Outcome comparison | R4 outcome is recomputed from compress evidence |
| Error-type comparison | R4 error-type is recomputed from compress evidence |
| Unknown-outcome comparison | R4 outcome-unknown is recomputed from compress evidence |
| Stored-diff union (version-5 replacement) | R5 matching capped coverage preserves stored diagnostics in the union |
| Internal absorption remains valid | R4 within-call absorption and later zero-created calls preserve a sound bound |
| Later-call absorption remains valid | R4 imported absorption keeps one survivor and batch order is independent of timestamps |
| Stored inconclusive verdict retention | R4 stored inconclusive verdicts cannot be promoted by recomputation |
| Register explanations | R4 genuine accepted evidence and FP-001 reach readiness at 500 |
| Zero initial bound | a genuine no-fold preview remains a valid match at 500 calls |

The hand-built report, register, tool-semantics, mixed-schema and fingerprint
fixtures now carry matched validation-rejection block/outcome evidence.
Report fixtures also link genuine empty request-hash evidence on both sides;
semantics fixtures supply the missing bcp hashes. The no-fold positive control
now runs the actual comparator on a matched short-summary rejection instead of
changing only an accepted call's native count. Existing assertions are unchanged.

The command shows match / explained / diff / inconclusive counts, register hits,
and up to 20 unexplained or inconclusive calls. Register explanations apply at
report time, including to earlier records.

## Difference register

Each entry explains one investigated difference. Entries are added to
`src/parity/register.ts` and this page together, with a specific reason and a
predicate that matches only that difference.

| ID | Title | Reason | Issue |
| --- | --- | --- | --- |
| FP-001 | Summary placement | Native folds send a summary message; bcp drops its rendered `acp_summary_*` messages. Applies only when bcp has no summary and our rendered summary bodies and topic lines match the independent expected hashes from planned imported blocks and accepted compress inputs, in count and order. Missing evidence, lost, extra, reordered, or corrupted summaries stay unexplained. | pi-context-aware#175 |
| FP-002 | Compress-call arguments | bcp shortens summaries longer than 200 characters inside `compress` arguments to a 199-character prefix plus an ellipsis (without splitting a surrogate pair). Native requests keep the arguments verbatim. Applies only when the exact shortened argument hashes match, with the same call IDs and tool names. | pi-context-aware#130 |
| FP-003 | First user message folded | bcp pins the opening user. The native policy can fold it with `fold`, or with `keep-under-tokens` above its limit. Applies only with evidence that the effective policy folded it, its original user hash is the sole non-summary content difference, and its expected replacement summary body is present with user role before the first assistant. Missing replacement evidence stays unexplained. Existing request and block fields are unchanged. | pi-context-aware#130 |
| FP-004 | Retry cap | billion-context-pi refuses every compress call after three failed calls in a turn (`capped-retry`). The native engine has no retry cap. Applies only as described below. | pi-context-aware#131 |
| FP-005 | Dead-range breaker | billion-context-pi refuses an exact compress call that already failed (`dead-range`). The native engine evaluates every call. Applies only as described below. | pi-context-aware#131 |
| FP-006 | Tier-3 rewrite rejection | billion-context-pi refuses a call that only re-condenses tier-3 blocks (`tier3-rewrite`). The native engine has no such rejection. Applies only as described below. | pi-context-aware#131 |
| FP-007 | Abort | billion-context-pi stops a call when its signal aborts (`aborted`). The native preview runs to completion. Applies only as described below. | pi-context-aware#131 |
| FP-008 | Cut-off summaries are refused | The native adapter refuses a summary of at most 200 characters that ends in `…`, or a copied block pointer (`stub-summary`). billion-context-pi folds such a summary. Applies only to call differences, as described below. | pi-context-aware#173 |

Every shadow next-request comparison requires expected-summary evidence. An
explicit empty body and topic list certifies that no summaries were planned;
either list absent is inconclusive and blocks readiness. A mismatch between
planned and rendered summary bodies or topics is a summary diagnostic, even when
both engines send no summaries.
This prevents total summary loss from counting as a match.

Register explanations use next-request evidence, not just the difference kind.
Historical records without exact shortened-argument hashes or folded-opening
evidence stay unexplained. No raw arguments or opening text are stored.
Call coverage excludes bcp's metadata-only pinned opening when the native policy
keeps it; when the native policy folds it, its request difference is FP-003.
New entries must be added to `src/parity/register.ts` and this page together.

### Endings only billion-context-pi has (FP-004 to FP-007)

FP-004 to FP-007 cover endings only billion-context-pi has. In each,
billion-context-pi refused the call and created no fold. The native preview has
no such guard, so it evaluates the call and may fold it. For a call that ended
this way, with no rejection reason, an entry explains:

- the `outcome` difference between the native result and the refusal;
- when the native preview created at least one fold and billion-context-pi
  created none: `block-count`, and `coverage`, `tier` and `absorbed`
  differences with nothing on the billion-context-pi side. A difference that
  lists billion-context-pi ids, or whose count and id list disagree, is not
  explained.

A refusal can also change the next request, but so can an unrelated defect in
the same request. The recorder therefore tests the cause in two steps. When a
batch contains calls that billion-context-pi refused with one of these endings,
and the native preview of the batch differs from billion-context-pi's request,
the recorder builds a second native preview of the same batch without the
refused calls. It compares that counterfactual preview with billion-context-pi's
request too. It then checks the full native request against the counterfactual
native request. The full request must be the counterfactual request with only
the refused calls' own folds applied:

- the counterfactual messages from the entries those folds cover are gone;
- each refused fold's summary stands at its carrier entry, with the hash of the
  summary that fold wrote (a refused fold that a later refused fold absorbed has
  no summary of its own);
- every other message is identical, by hash, source entry and order. This
  includes retained messages, tool calls and results outside the refused
  coverage, and each accepted sibling's summary (topic hash and body hash).

The check uses the fold records the preview creates and the entry each request
message comes from. It also requires the accepted calls in the batch to fold
the same way in both previews: the same calls, tiers, covered entries and
summary hashes. Anything else fails, with a closed reason:

| Reason | Meaning |
|---|---|
| `attribution-unavailable` | A request message cannot be traced to its session entry. |
| `too-large` | A request exceeds 2,000 messages. |
| `unattributed-fold` | A refused fold has no summary, or a fold appears for a call the counterfactual omitted. |
| `sibling-covered` | A refused fold covers an entry that an accepted sibling's fold covers, in either preview. This includes a refused fold that absorbs a sibling's block. |
| `sibling-absorbed` | A refused fold absorbs a sibling's block, or a sibling absorbs a refused block. |
| `sibling-changed` | An accepted sibling folds differently with and without the refused calls. |
| `summary-missing` | A refused fold's carrier has no message in the counterfactual request. |
| `message-changed` | Some other message differs, is missing, is extra, or is out of order. |

The next-request record keeps the evidence: `refused` lists each refused call
and its ending; `counterfactual.diffs` holds the counterfactual comparison;
`counterfactual.delta` holds the check's verdict (`refused-folds-only` or
`other`), its reason, and counts: refused folds, covered entries, removed
messages and the index of the first mismatch; and `counterfactualOurs` holds
the counterfactual preview's request hashes and source evidence, in the same
form as `ours`. None of these holds message text, summaries or tool arguments.
The fields are optional, so the schema version (5) does not change. The shared
validator checks `counterfactualOurs` like `ours`. `refusalEvidenceFault` checks
all four fields together (see the report-time trust boundary). If one of them is
partial or malformed, the request is not explained.

The counterfactual request need not equal billion-context-pi's request. It
keeps every known difference from earlier in the session, because the refused
calls are the only thing it omits: a fold summary billion-context-pi drops
(FP-001), a compress summary it shortened (FP-002), or an opening user message
the native policy folded (FP-003). The counterfactual is clean when each of its
differences is one that FP-001, FP-002 or FP-003 explains, judged against the
counterfactual's own evidence (`counterfactualOurs`) with the same predicates
as the register entries. The report recomputes these differences from that
evidence and joins them with the stored ones, so a stored empty list cannot
hide a difference. Any other difference, or missing or malformed evidence,
leaves the counterfactual unclean.

An entry explains the next request's `summaries`, `content`, `tool-calls` and
`tool-results` differences only when both steps pass: the counterfactual is
clean, and the delta is `refused-folds-only`. Otherwise every difference in
that request stays unexplained. A request record without this evidence,
including one written before the check existed, is not explained either. The decision uses only the request record, so it is the same for every
call in the batch, whether or not the other calls are inside the 500-call
window. An accepted call in the same batch is therefore explained when the
request is. When a batch has refusals with different endings, the request's
differences count toward the first entry whose ending is in the batch.

The check proves that the full request is the counterfactual request with the
refused folds applied as the preview recorded them. It does not judge whether
a refused fold's summary is good: billion-context-pi made no fold to compare it
with.

The active-fold bound (see the report-time trust boundary) is checked on the
counterfactual request when the record has one. Each call's compress record is
previewed alone from billion-context-pi's side file, which has no fold for a
refused call, so a later accepted call in the batch can allocate the refused
fold's native block id. The counterfactual follows billion-context-pi's state,
so the bound is checked against `counterfactualOurs` with the refused calls
left out. A call is left out only when its own compress record has the refused
ending and no billion-context-pi fold. The delta check ties the full request to
the counterfactual one.

The counterfactual preview reuses the batch's branch copy and runs after the
first preview is released, so it adds no copy to the memory bounds. Until the
check is done, the recorder keeps only the first preview's request hashes, the
entry id of each hashed message (at most 2,000) and its fold ids. If the
counterfactual cannot be computed, the request is inconclusive
(`recorder-error`, reason `counterfactual preview failed`). If its comparison
is inconclusive, for example `too-large`, the request is inconclusive too
(`recorder-error`, reason `counterfactual preview inconclusive`), and
`counterfactual.diffs` keeps the cause.

The entries explain nothing else: not `tool-pairing`, not an inconclusive kind,
and not a difference where billion-context-pi has something the native preview
lacks. The calls still count toward 500, and the report shows how many
differences each entry explained.

These four were registered as explained on 2026-10-11, instead of excluding the
calls or keeping them as blockers, so the gate can pass while each case stays
counted. The native engine still lacks these guards; whether it needs them is a
separate question.

One known limit stays a blocker. In one batch, a refused fold can cover an
entry that an accepted fold covers, or absorb the accepted fold's block. The
native engine does both with no fault injected: a refused fold of entries 1-8
before an accepted fold of entries 5-8, or an accepted fold of entries 5-8
before a refused fold of entries 1-10. The check then fails with
`sibling-covered`, so that request stays unexplained and the gate is not ready.
This is deliberate (decided 2026-10-11): the rule above cannot prove what the
accepted fold's summary becomes in these shapes. pi-context-aware#177 tracks explaining
them or giving the native engine the same guards.

Each control below was removed in the generated test build only. The named
test in `tests/fold-parity-attribution.test.ts` then failed an assertion
(exit 1), and the control was restored.

| Control removed or broken | Test that went red |
| --- | --- |
| Known differences explain the counterfactual | a refusal after an earlier accepted fold, after a compress call with a long summary, and after the opening user message was folded is explained |
| Only FP-001 to FP-003 explain the counterfactual | after each background, a counterfactual difference no register entry explains keeps the refusal unexplained |
| Entries judge the counterfactual's own evidence | a refusal after a compress call with a long summary, and after the opening user message was folded, is explained |
| Recomputation from the counterfactual's evidence | a stored clean counterfactual cannot hide a difference its own evidence shows |
| Counterfactual evidence is required | a counterfactual without its request evidence explains nothing, even when its stored list is empty |
| Validation of `counterfactualOurs` | malformed counterfactual request evidence is a recorder fault |
| Active-fold bound on the counterfactual request | a dead-range refusal with an accepted sibling fold is explained when the full request differs only by the refused fold |
| Refused calls confirmed by their compress records | a refused list that names an accepted call cannot take that call's block ids out of the active-fold bound |

Each refusal-evidence control below (review round 4) was removed or loosened in
the generated test build only. The named tests in
`tests/fold-parity-evidence.test.ts`, `tests/fold-parity-report.test.ts` and
`tests/fold-parity-attribution.test.ts` then failed (exit 1), and the control
was restored.

| Control removed or broken | Test that went red |
| --- | --- |
| The register requires `refusalEvidenceFault` to pass | the round-4 probe: a delta that holds only its verdict does not explain a full-only retained-read corruption; partial or malformed refusal, counterfactual and delta evidence is never explained; a malformed counterfactual diff that a known entry would match is never explained |
| `refusedFolds`, `coveredEntries`, and the counts each outcome needs | partial or malformed refusal, counterfactual and delta evidence is never explained; the delta validator accepts exactly the deltas the writer produces |
| Counts the writer never sets for an outcome are absent | the same two tests |
| Closed verdict and reason combinations | the delta validator rejects verdicts and reasons outside the closed combinations |
| `refused` IDs, uniqueness and closed endings | partial or malformed refusal, counterfactual and delta evidence is never explained; refusal evidence needs refused calls of this batch with closed endings |
| Well-formed `counterfactual.diffs` | a malformed counterfactual diff that a known entry would match is never explained |

### Cut-off summaries are refused (FP-008)

The native adapter refuses a summary that is a copy of a shortened earlier
summary (`src/folds/stub-summary.ts`, pi-context-aware#173):

- a summary that ends in `…` and is at most 200 characters long after trailing
  whitespace is trimmed. billion-context-pi shows each earlier compress call
  with its summary cut to 199 characters plus `…`, at most 200 characters, and
  models copy that shape into new calls. A longer summary that ends in `…`
  still folds.
- a block pointer such as `summary kept in block b6 (9,585 chars)`, copied as
  is.

billion-context-pi accepts such a summary, so the range folds into one cut-off
line. The native outcome then has the reason code `stub-summary`, never the
summary. FP-008 explains a call only when its `oursOutcome` has that code and
billion-context-pi accepted the call, and then only the call differences a
missing native fold causes:

- the `outcome` difference `ours=rejected; bcp=accepted`, or
  `ours=partial; bcp=accepted` when the call's outcome is partial;
- when the native preview created fewer folds than billion-context-pi:
  `block-count`, and `coverage`, `tier` and `absorbed` differences with nothing
  on the native side.

The call's next request also differs, because billion-context-pi folded the
range. No evidence shows that the missing fold alone causes those differences,
so FP-008 does not explain them, and the call counts as a difference.

In live mode the native engine shows an earlier fold call without a cut-off
summary (`src/folds/fold-call-render.ts`). Each item of a fold tool call that
made a fold on the branch shows the pointer `summary kept in block bN (C chars)`
in place of its summary. `C` is the length of the summary the model wrote. The
fold's summary message still carries the full text, so the call does not repeat
it. Other tool calls, and items whose fold was refused, stay as the model wrote
them. The session file keeps the original arguments. The match is by request id
(`<tool call id>#<item index>`). A shadow session has no native fold calls, so
the preview and FP-002 do not change.

## Storage, privacy, and erasure

Diagnostics live outside the session:

```text
<configuredAgentDir>/fold-parity/v1/sessions/<sessionId>.jsonl
```

`PI_CODING_AGENT_DIR` selects the agent directory when set. Records contain ids,
refs, counts, hashes, tool names, outcome categories, producer metadata, and
bounded diagnostic reasons. They never contain message, summary, tool-argument or
error text. Tool-result text is hashed, not persisted. Topic lines are also
hashed. Transient snapshots contain content only in memory.

The recorder creates `fold-parity`, `v1` and `sessions` with mode 0700 and
session files with mode 0600. Each of these directories must be a real
directory owned by the current user, not a symlink. A session file is opened
without following a symlink, and it must be a regular file with one link that
the current user owns. A redirected store is rejected: the write fails, the
failure is ignored, and the live call is not affected.

These checks cannot be raced. The recorder holds each checked directory open
and opens the next name through that directory's descriptor
(`/proc/self/fd/<fd>/<name>`), never by its pathname again. A directory that is
renamed or replaced by a symlink after its check therefore cannot redirect a
read or a write. On a platform without such descriptor paths (for example
macOS, or Linux without `/proc`), the store is refused in the same way, so the
recorder writes nothing there. `/fold-parity` then
reports that readiness is unknown. This refusal is deliberate (decided
2026-10-11): Linux evidence is enough for the cut-over, and a fallback to
pathname checks would reopen the race. The `v1` in the path is the store layout, not
the record schema version.

Delete a session's JSONL file to erase its diagnostics. Issue pi-context-aware#151 must also
delete `fold-parity/v1/sessions/<id>.jsonl` when erasing that session. This
recorder does not import folds into any persisted session; that remains blocked
until pi-context-aware#151 lands.
