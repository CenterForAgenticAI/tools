# Integration reference

For extension authors and worker-launcher maintainers, this page defines adaptive-thinking's event-bus and inherited-policy protocols.

## Foreground-session integration snapshot (protocol v1)

Other loaded Pi extensions can read adaptive-thinking state without parsing the
system prompt or reading `~/.pi/agent/adaptive-thinking.json`. The seam is
read-only and uses Pi's session-local extension event bus:

- `adaptive-thinking:snapshot:request:v1` — request the current snapshot;
- `adaptive-thinking:snapshot:response:v1` — receive a request-correlated
  snapshot response;
- `adaptive-thinking:snapshot:changed:v1` — receive deduplicated state-change
  notifications.

Requests, responses, and snapshots carry `protocolVersion: 1`. Consumers must
subscribe before requesting because the event bus has no replay. A request has
a non-empty `requestId`; the matching response echoes it:

```ts
import {
  ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
  ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL,
  ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL,
  ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL,
  type AdaptiveThinkingSnapshotResponseV1,
  type AdaptiveThinkingSnapshotV1,
} from "@centerforagenticai/pi-adaptive-thinking/integration-seam";

let current: AdaptiveThinkingSnapshotV1 | undefined;

pi.events.on(ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL, (value) => {
  const snapshot = value as AdaptiveThinkingSnapshotV1;
  if (snapshot.protocolVersion === ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION) {
    current = snapshot;
  }
});

const requestId = crypto.randomUUID();
const unsubscribe = pi.events.on(ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL, (value) => {
  const response = value as AdaptiveThinkingSnapshotResponseV1;
  if (response.protocolVersion === 1 && response.requestId === requestId) {
    current = response.snapshot;
    unsubscribe();
  }
});

pi.events.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
  protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
  requestId,
});
```

The seam ignores malformed/unsupported requests and requests received before a
successful `session_start`. Pi's EventBus delivery is local and non-awaitable;
handlers should do synchronous state capture and move asynchronous work outside
the event callback.

The snapshot reports enablement, baseline, configured min/max bounds, current
effective level, effective-value source, override scope/countdown, model
identity, Pi's runtime-supported thinking levels for that model, and the
adjacent `modelAgentSelectableLevels` subset. Runtime-supported levels use Pi's
ordering (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), so a Pi
0.83 model with `thinkingLevelMap: { max: "max" }` reports `max` capability.
`modelAgentSelectableLevels` intersects those model capabilities with enabled
agent control and the current configured/session-local bounds, and excludes
`off` and `minimal`. It is empty while dynamic adjustment is disabled.
Consequently it includes `max` only after the user explicitly permits `max` in
the active bounds. Force-adaptive compatibility still removes unsupported
`off`. Source is one of `baseline`, `user`, `agent`, or the reserved
`external-recommendation` value.
Every snapshot is detached from internal state; v1 exposes no mutation or
recommendation method.

`controlScope: "current-session"` is deliberate. This API describes only the
Pi session instance whose event bus answered the request. It does not configure
independently spawned delegate workers; their bounds remain a `pi-delegate`
invocation concern and each worker has its own extension instance/event bus.

## Session-local delegate policy (protocol v1)

When `pi-delegate` starts a worker with `thinkingMin` or `thinkingMax`, this
extension accepts the worker-local policy over the shared Pi event bus. This
independently spawned worker seam is distinct from the foreground-session
snapshot and change-notification API. The protocol uses these exact channels
and entry type:

- `pi-delegate:adaptive-thinking-policy` — policy payload
- `adaptive-thinking:pi-delegate-policy-accepted` — ACK containing protocol
  version, `policyId`, and the canonical provider identity `adaptive-thinking`
- `pi-delegate-thinking-policy` — versioned session entry used to restore the
  policy after a worker restart

Other launchers can pass the same ceiling through
`PI_ADAPTIVE_THINKING_POLICY` as JSON:

```json
{"version":1,"thinkingMin":"medium","thinkingMax":"high"}
```

Both level fields are optional and use the same level vocabulary and range
validation as the event-bus policy. At `session_start`, environment, delegate,
and configured bounds are intersected; no source can widen another. The
completed environment range is persisted as `adaptive-thinking-env-policy` and
is written back to `process.env`, so normally spawned descendants inherit the
effective configured-and-policy range. Because `process.env` is shared, extension
instances coordinate through a process-wide registry (also shared by duplicate
module copies): the child-visible value is the intersection of the originally
inherited ceiling and every live session range. Consequently, while a bounded
session is alive in a shared host such as `pi-daemon`, children spawned by an
otherwise unbounded sibling are narrowed too. This is intentionally safe but can
be surprising. Session shutdown removes only that session's range and recomputes
the export; incompatible live ranges export the fail-closed `off`–`off` range.
A launcher that explicitly scrubs or replaces the child environment bypasses
this transport and cannot be bounded by this extension. Malformed environment
JSON is replaced with the same fail-closed `off`–`off` range, emits a visible
warning, and aborts the session rather than falling back to wider bounds. The
status bar and `/thinking-status` identify whether the effective ceiling comes
from `config`, `env`, `delegate`, or tied sources.

The policy is validated before it is accepted, including completion of
one-sided ranges from read-only global fallbacks and validation of any explicit
baseline against that completed range. Protocol v1 carries explicit levels only.
A `model-min`/`model-max` sentinel in the global fallback resolves against the
built-in defaults before the merge, never against the worker's own model, so a
worker cannot widen past the authority its caller granted. Its baseline and bounds are kept in the
extension factory closure, so they apply only to that worker session. Tool
requests are clamped to the worker's declared range. `max` and `xhigh` are
distinct ordered levels: a delegated request or runtime selection of `max`
clamps to `xhigh` under the default ceiling, and remains `max` only when the
session policy explicitly permits it. The input, prompt, and provider-adjacent
gates enforce the same exact ordering, so `max` cannot bypass an `xhigh` or
lower delegated ceiling. A delegated policy never writes
`~/.pi/agent/adaptive-thinking.json` or alters a sibling session's runtime
thinking state. Its range does participate in the process-wide child-environment
intersection described above. If a persisted policy has an explicit baseline,
that baseline wins over stale adaptive state and global configuration during
session start/restart. Malformed matching policy metadata or bounded
restart-state payloads fail closed rather than falling back to global policy.
