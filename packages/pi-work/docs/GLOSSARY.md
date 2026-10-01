# Glossary

<!-- Generated from .pi/glossary.json by pi-caair-dev-tools (simple-language). Do not edit by hand. -->

## agent profile

Prompt-free named bundle of reusable slot settings, separate from agent identity and overridden by inline worker settings

Also: agent profiles

Kept because: Narrow external feature meaning that readers would otherwise likely guess wrong

## compiled intent

Optional Lean model that constrains allowed state changes and is consulted during decomposition and checked through model builds

Also: compiled-intent

Kept because: Coined architecture concept with two explicit integration hooks

## contract assembler

Single exhaustive function that renders node context into worker briefs, reviewer views, and remediation briefs without dropping schema fields

Kept because: Core AG4 mechanism for lossless handoffs

## criteria block

Strictly formatted region in a Markdown draft whose criterion IDs and statements are carried verbatim into the promoted specification

Kept because: Names the lossless machine-consumed draft-to-specification handoff

## delegate

Pi tool that starts agent work with configured isolation, budgets, escalation, and result handling

Also: delegate tool

Kept because: Distinguishes the specific tool from the ordinary verb

## detached orchestrate

Mode where an independent driver process continues outside the originating Pi session and may run nested delegation

Also: detached orchestrate mode

Kept because: Specific pi-delegate execution mode used in boundary and topology discussions

## dispatch plan

Compiled description of one ready node, including its brief, agent settings, write scope, and ready-to-run delegate arguments

Also: delegate dispatch plan, dispatch plans

Kept because: Core handoff artifact between pi-work and the session agent

## dogfood sidecar

Deferred Lean model of this project’s lifecycle, triggered only after the schema survives two real projects without churn

Also: dogfood sidecar tripwire, dogfood-sidecar, dogfood-sidecar tripwire

Kept because: Coined name for accepted wayfinder item W2

## Git-native state

Architecture in which commits and branches are the durable authority for progress instead of a separate database or journal

Also: Git-native state model, git native, git native state

Kept because: Names the state-ownership correction contrasted with graft’s journal era

## intent

Workspec field carrying rationale, constraints, and non-goals into worker briefs and reviewer context

Kept because: Has a sharpened project meaning deliberately distinct from description

## pi-delegate

Pi extension responsible for agent dispatch, isolation, budgets, recovery, and escalation

Kept because: Coined dependency name whose boundary with pi-work is central to the design

## pi-work

Pi extension for structured workspec authoring, verification, and plan compilation that owns neither execution nor persistent run state

Kept because: Coined project name reinforced by the implemented branch README and design corpus

## positive floor

Verification rule requiring proof of an observed effect, such as exit zero plus matched output or a nonzero test count

Kept because: Coined shorthand for preventing vacuous-green checks

## review contract

Reviewer-facing projection of a node’s full context, owned criteria, and reported evidence

Kept because: Names a specific assembled view rather than a generic agreement

## reviewed node

Execution pattern where a worker’s output is inspected by a separate reviewer whose typed verdict gates advancement

Also: reviewed-node, reviewed-node execution

Kept because: Specific pi-delegate seam repeatedly referenced by pi-work’s review design

## touches

Node field naming intended write paths, compiled into delegated-worker confinement

Also: touches write scope

Kept because: Project-specific scope contract used by the schema, enforcement ADRs, and implementation briefs

## tree identity

The combination of a worktree’s filesystem path and the resolved commit hash it contains

Kept because: Required on verification results to detect evidence from the wrong checkout or an older commit

## wayfinder item

Named open decision with a tripwire stating when it must be revisited

Also: decide-later, decide-later item, wayfinder entry

Kept because: Coined planning concept for deliberate deferral without speculative machinery

## work node

One executable unit in a specification graph, with its own task, dependencies, acceptance criteria, evidence, and write scope

Also: WorkNode, work-node

Kept because: Core recursive unit throughout the design and implementation

## workspec

Structured YAML document describing agent-directed work as a graph of executable units with owned completion criteria

Also: Workspec v2, work-spec

Kept because: Coined spelling for the project’s central validated artifact

## advisory disposition

A recorded acceptance of one warning, naming its subject, the reason, who accepted it and when, which annotates that warning rather than hiding it.

Also: advisory_dispositions, disposition

Kept because: Names the advisory_dispositions specification field and the disposition-targets-error and disposition-unmatched finding codes built on it; "accepted warning" alone loses the recorded-act meaning that distinguishes it from suppression.
