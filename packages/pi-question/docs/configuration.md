# Configuration reference

The extension reads the `piQuestion` object from two settings files:

1. user settings at `~/.pi/agent/settings.json`;
2. project settings at `.pi/settings.json`, which override user settings.

Defaults apply first. Each valid layer is merged over the previous result. An
invalid `piQuestion` value causes that entire layer to be ignored with one
warning; earlier valid layers remain in effect. Unreadable files and malformed
JSON are ignored without a warning.

## Settings

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timeoutMs` | non-negative finite number | `0` | Deadline in milliseconds. Fractional values are rounded down. `0` disables the deadline. |
| `onTimeout` | `"cancel" \| "recommended" \| "error"` | `"cancel"` | Action when the deadline passes. |
| `surfaces` | surface-name array | `["host", "tui", "dialogs"]` | Allowed surfaces. Only `dialogs` is implemented. |
| `blockedSignal` | boolean | `true` | Emit `herdr:blocked` while an answer surface is waiting. |

There is no per-call configuration and no setting for changing the tool name.

## Timeout policies

- `cancel` returns an answer with `status: "timeout"` and no selection.
- `recommended` applies the question's recommended option only when one exists
  and the category is neither `scope-product` nor `security-permission`. The
  answer has `status: "answered"` and `defaulted: true`.
- `error` rejects the tool call after the active surface settles.

At the deadline, the extension aborts the active surface and waits for it to
settle before applying the policy. A host that ignores the supplied
`AbortSignal` can therefore delay completion beyond `timeoutMs`.

## Blocked signal

When enabled, the extension emits `herdr:blocked` before waiting on a human and
clears it on success, cancellation, timeout, or failure. It emits no signal for
the `none` surface because no human interaction begins.
