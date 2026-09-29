import type { SessionSummary } from "../protocol/index.js";
import type { SessionRecord } from "../registry/index.js";
import {
  deriveObservedPhase,
  type SessionStateSnapshot,
} from "../state/index.js";

export function projectSessionSummary(session: SessionRecord): SessionSummary;
export function projectSessionSummary(
  session: SessionRecord,
  liveState: SessionStateSnapshot,
): SessionSummary;
export function projectSessionSummary(
  session: SessionRecord,
  liveState?: SessionStateSnapshot,
): SessionSummary {
  const name = session.name === null ? {} : { name: session.name };
  const runtime = liveState?.runtime ?? session.runtimeState;
  const phase = liveState?.phase ?? session.lastPhase;
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
    ...name,
    runtime,
    phase,
    observedPhase: liveState?.observedPhase ?? deriveObservedPhase(runtime, phase),
    attention: liveState?.attention ?? session.attention,
    generation: session.generation,
    epoch: session.epoch,
    cursor: { entryId: session.activeLeafId, epoch: session.epoch },
    pendingQuestions: liveState?.pendingQuestions ?? [],
    heartbeat: {
      seq: 0,
      at: new Date(session.updatedAtMs).toISOString(),
    },
  };
}
