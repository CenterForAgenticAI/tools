# Answer surfaces

A surface is one way to put an `ask` request in front of a human. Selection uses
declared capability; the extension never calls a UI method merely to probe
whether it exists.

## Current selection

The extension recognizes these names in configuration:

| Name | Status | Behavior |
| --- | --- | --- |
| `dialogs` | Implemented | Uses Pi's `select` and `input` dialogs when the session declares a UI. |
| `host` | Not implemented | Reserved for a structured channel supplied by an embedding host. |
| `tui` | Not implemented | Reserved for a richer terminal surface. |
| `none` | Fallback | Returns `unavailable` for every question. |

Today, `dialogs` is selected when it is allowed and the session declares a UI;
otherwise the extension uses `none`. Configuration cannot enable an
unimplemented surface.

## Dialog behavior

Single-select questions use `select`. Multi-select questions use one `input`
dialog that accepts comma-separated option numbers and optional custom text.
Option descriptions are not shown, so dialog delivery is marked as degraded.

When custom input is allowed, the option label `Other (type your own)` opens an
`input` dialog. The caller should not include that label among its own options.

A host returning `undefined` means the dialog was cancelled. Rejected dialogs
reject the tool call. The caller's `AbortSignal` is forwarded to each dialog.

## Non-answers

`cancelled`, `timeout`, `dismissed`, and `unavailable` never carry a selection.
The `none` surface returns `unavailable` and adds a narration warning so an
agent cannot confuse a missing human with an empty choice.

A recommended timeout default is the only non-human path that produces an
`answered` result. It is marked `defaulted: true` and is not allowed for
`scope-product` or `security-permission` questions.
