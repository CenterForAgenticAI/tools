# Question contract

Import the pure contract without loading Pi:

```ts
import {
  LIMITS,
  buildDetails,
  narrate,
  normalizeAskRequest,
  type AskRequest,
  type Question,
  type QuestionAnswer,
} from "@centerforagenticai/pi-question/contract";
```

The contract has no runtime imports outside its own directory. It can be used by
hosts, queue workers, and other packages that need the same question and answer
shapes without registering the extension.

## Request

`AskRequest` contains a non-empty `questions` array. Each `Question` has these
fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Stable and unique within one ask. |
| `question` | `string` | Required prompt. |
| `description` | `string?` | Optional Markdown context; renderers must sanitize it. |
| `options` | `{ label: string; description?: string }[]` | One to twelve choices. Do not add an `Other` option yourself. |
| `multi` | `boolean?` | Allow more than one option. |
| `recommended` | `number?` | Zero-based recommended option. |
| `allowCustom` | `boolean?` | Offer free text; defaults to true. |
| `category` | `"implementation" \| "scope-product" \| "security-permission"` | Optional decision category. |

`normalizeAskRequest(value)` accepts this shape plus these compatibility aliases:
`prompt` or `header` for `question`, `context` for `description`, `choices` for
`options`, `recommendedIndex` for `recommended`, and `multiple` for `multi`. A
single question object is also accepted. Normalization renames and reshapes; it
does not invent options, answers, or categories.

## Answer

A `QuestionAnswer` contains `id`, `status`, and `selected`. Optional fields are
`customText`, `note`, and `defaulted`.

| Status | Meaning |
| --- | --- |
| `answered` | A human selected an option or supplied custom text. |
| `cancelled` | The human declined, closed the dialog, or cancellation won. |
| `timeout` | The deadline passed without applying a default. |
| `dismissed` | Reserved for a durable surface that can keep a request pending. |
| `unavailable` | No surface can reach a human. |

Only `answered` may carry a choice. Every other status has an empty `selected`
array. A timeout policy may apply the recommended option; that result is
`answered` with `defaulted: true`, and its narration says that no human answered.

Indices are canonical. Labels in compatible output are derived from the
question's options.

## Output compatibility

`narrate(questions, answers, delivery)` starts with a pi-ask-tool-compatible
block:

```text
User answers:
question-id: selected label
```

Multiple choices, custom input, cancellation, timeout, and unavailable results
use explicit text forms. An unavailable surface adds a warning that the caller
must not assume an answer.

`buildDetails` supplies compatible `results[]` records with `id`, `question`,
`description`, `options`, `multi`, `selectedOptions`, and `customInput`. A
single-question ask also mirrors those fields at the top level. The canonical
`answers[]` and the selected `delivery` are included alongside them.

## Limits

`LIMITS` currently exposes:

- `maxQuestions`: 8
- `minOptions`: 1
- `maxOptions`: 12
- `maxText`: 4000
