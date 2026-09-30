# Event tracing and privacy

For developers inspecting Pi lifecycle events: what the trace keeps and what it excludes.

## Event privacy model

Event tracing is disabled by default and never writes to disk. Every event passes through a strict field-by-field allowlist; implementation code never spreads, serializes, or stores the source event object.

Retained metadata is limited to values such as:

- event type and local sequence/time;
- lifecycle reason and boolean state;
- counts (messages, images, entries, tool results);
- model provider/id and selection source;
- tool name and error state;
- provider HTTP status.

The trace **does not retain** prompts, messages, system prompts, provider request payloads, headers, credentials, tokens, tool arguments, tool results, terminal commands, file contents, arbitrary event properties, configuration, or session/control IDs. `clear` removes retained records; `off` stops capture without discarding existing records.
