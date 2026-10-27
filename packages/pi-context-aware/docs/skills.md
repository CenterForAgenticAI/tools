This page is for agents and extension authors who load skills with `load_skill`.

# Skills

`load_skill` returns the text of one skill's `SKILL.md`. It records each load in a session skill registry, so a second load of the same unchanged skill returns a short pointer instead of the whole body again.

pi-context-aware registers `load_skill`. Pi keeps the first tool registered under a name, and the default profile loads `pi-caair-dev-tools` before this package, so dev-tools' copy is the one sessions use until pi-caair-dev-tools#566 makes it step aside. A profile that installs this package without dev-tools gets this copy.

## Resolving a name

`load_skill({ name })` looks the name up in this order and never builds a path from it:

1. the skills Pi discovered for this session (the `<available_skills>` list);
2. when the name is not there, a fresh discovery of user, project and package skills.

An unknown name returns an error that lists the available names. Use one of them, or say the skill could not be loaded.

## The pointer contract

When the result says a skill is already loaded, follow the pointer. Do not load the skill again.

| Earlier load | Result |
| --- | --- |
| Same file, full copy still in context | `Skill "glab" is already loaded at m00010 (unchanged). Re-read that result; do not load it again.` |
| Same file, copy folded by a native fold | The block id and the reachable restore call, such as `decompress({ blockId: "b3" })` or `extensions.decompress({ blockId: "b3" })`; the full body when no restore call is reachable |
| The file changed since the load | The full new body, with a note that it replaces the earlier copy |
| Made by another tool, or edited after delivery (partial) | The full body |
| No longer in context, for example after a compaction | The full body |
| `force: true` | The full body |

While billion-context-pi does the live compression, every load returns the full body. A billion-context-pi block cannot be matched to a registry record, so a pointer could name text the agent no longer has. Pointers start when the native fold engine owns compression (pi-context-aware#137).

## Partial loads

A load made inside another tool, such as a `fabric_exec` program, returns its body to that program, not to the transcript. The program may print only part of it. The registry records such a load as `partial`, with the calling tool call's id when Pi reports it, and does not protect the calling tool's result. The next direct `load_skill` call returns the full body. A load counts as nested when its tool call carries a `parentToolCallId`, or when its call id has Pi's or Fabric's nested form (`outer/inner`, `fabric_…`, `jev:…`).

## The registry

Each load appends one `context-aware.skill-registry.v1` custom entry: name, resolved path, sha256 of the body, sha256 of the full result, size, tool call id, the calling tool call's id when nested, `full` or `partial`, and the load time. The state shown to the agent is worked out from the branch each time, so it follows restarts, `/tree` moves and compactions without a separate update:

- `visible`: the full result is in context, at its message ref.
- `compressed`: a native fold covers the result; the block id restores it.
- `partial`: nested, or the text in context differs from what was delivered.
- `gone`: the result is no longer in context.

`/context-status` lists loaded skills with their state and size, and the context service reports them through `skills.loaded()` (see [context-service.md](context-service.md#loaded-skills)).

## Fold protection

The native fold kernel keeps a recorded `load_skill` result out of a fold. Protection matches the exact result text the registry recorded, not the tool name, so a refusal or any other `load_skill` text folds like an ordinary result. This is proven against the kernel (`planFold`) only. billion-context-pi does production compression until pi-context-aware#137, and it does not see this protection.

## Condensed skills

A skill can ship a `condensed.md` beside its `SKILL.md`: a short version of its rules, written by its author. This is off unless `folds.condensedSkills` is `true` (see [configuration.md](configuration.md#folds)); it stays off by default until a replay comparison shows agents still follow a skill's hard rules after the swap.

When it is on:

- **Capture.** Context-aware reads `condensed.md` when `load_skill` delivers a full body, and when a run's prompt carries a `<skill location="…">` block (a `/skill:` message or a pi-stack verb) whose location is a skill Pi loaded for the run. It reads only the `condensed.md` beside that skill's `SKILL.md`, never a path named only in message text. Another extension can register condensed text through the context service ([context-service.md](context-service.md#condensed-skill-registration)). The text is stored in a `context-aware.skill-condensed.v1` custom entry, which the model never sees, so editing the file later does not change what a fold shows.
- **Never next to the full text.** No result or message carries the condensed text while the full body is shown.
- **Swap on fold.** When a native fold covers a user or custom message holding a captured skill block, the engine replaces only that block, through a context edit, and keeps the rest of the message byte for byte. The message is not summarized by the fold model, and the swapped block carries no fold summary header. A kept opening message (`folds.firstUserMessage: keep`) shrinks the same way. `load_skill` results are not swapped; they stay protected.
- **Three levels.** The full block, then `<skill name="…" location="…" form="condensed">` with the condensed rules and one line saying how to get the full text, then `form="stub"` once the registering extension ends its owner key.
- **One record per form.** Each form of a skill block (with a digest, or without one) keeps its own captured record. A live registered form keeps its registered text and owner when the same form is captured again. A later registration still replaces an earlier capture.
- **After a compaction,** each location resends at most one block in a `context-aware.skill-condensed-resend` message that does not start a turn. It uses the most recently captured form that is still condensed and whose full text is gone.

A skill without `condensed.md` keeps the behaviour described above. The swap is proven against the native fold planner (`planFold`) only. billion-context-pi does production compression until pi-context-aware#137, and it does not see condensed skills.
