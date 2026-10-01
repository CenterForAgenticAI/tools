# Session transitions
id: 0001-transitions
status: approved
context: ./CONTEXT.md

## Intent
A stopped session cannot accept a transition. Running sessions can.

## Vocabulary
Use the session and transition vocabulary in CONTEXT.md. No new terms.

## Rules
R1: A not-running session rejects every target state.
R2: A transition is allowed exactly when the source is idle, working or blocked, independent of the target state.

## Worked examples
- idle -> working: true
- blocked -> idle: true
- not-running -> working: false

## Freedoms
Implement with a predicate, match or table.

## Non-goals
Scheduling, persistence and effects are outside this finite decision.

## Open questions
None for this worked fixture.

## Approval
approved-by: pi-intent example fixture (synthetic, not a production approval)
The committed receipt is a live authoring-time Jev receipt (typesafe/jev-1.13 via OpenRouter). Regenerate it with intent-judge after any change to this record or LAWS.bend.
