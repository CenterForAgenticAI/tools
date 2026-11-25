# Strategy bench fixtures

Fixtures for `tests/strategy-bench.test.ts` (pi-context-aware#469).

- `corpus/fold-session/session.jsonl`: one recorded main session (32 requests, one tier-1 fold at request 15, provider `unified`, model `claude-opus-5-5`), redacted. Its usage figures are the recorded ones: the fidelity test reads them from this file as the expected token counts.
- `corpus/unpriced-session/session.jsonl`: written by hand. One request to a model the registry does not list.
- `recall-tail.txt`: written by hand. Three entries that continue `fold-session`: a `context_recall` call for fold `b1` in the response to request 32, its result, and one more request. The test appends it to the fold session; it is not a `.jsonl` file, so the corpus does not read it alone.

## How the fold session was redacted

Only the active branch was kept, with its parent links rewritten, and only the entry types the bench reads: messages, custom messages, context edits, compactions, model and thinking-level changes, and the fold record. Every other custom entry was dropped.

Every string the model reads was replaced character for character, so its length and the bench's token estimate stay the same: letters became `x`, digits `0`, and CJK characters `中`. Whitespace, ASCII punctuation, `—` and `…` were kept, and so was the fold heading `[Compressed conversation section]`, so the summary still reads as a fold summary. Tool names, ids, roles, timestamps, models and usage were kept. Thinking signatures, tool-result details and image data were removed, and the session's working directory became `/redacted/project`.
