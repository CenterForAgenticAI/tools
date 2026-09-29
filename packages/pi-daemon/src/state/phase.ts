import type {
  Attention,
  ObservedPhase,
  Phase,
  RuntimeState,
} from "../protocol/index.js";

export type SessionFileStatus = "healthy" | "missing" | "header_mismatch";

export interface SdkWorkState {
  readonly streaming: boolean;
  readonly retrying: boolean;
  readonly compacting: boolean;
  readonly queuedContinuation: boolean;
}

export interface PhaseDerivationInput {
  readonly runtime: RuntimeState;
  readonly previousPhase: Phase;
  readonly fileStatus: SessionFileStatus;
  readonly fatalFailure: boolean;
  readonly pendingQuestionIds: readonly string[];
  readonly pendingPromptClaims: number;
  readonly sdk: SdkWorkState;
  readonly interrupted: boolean;
}

export interface DerivedSessionState {
  readonly phase: Phase;
  readonly observedPhase: ObservedPhase;
  readonly attention: Attention;
}

function phaseFor(input: PhaseDerivationInput): Phase {
  if (input.fileStatus !== "healthy") return "gone";
  if (input.fatalFailure) return "failed";
  if (input.runtime === "asleep") return input.previousPhase;
  if (input.pendingQuestionIds.length > 0) return "blocked";
  if (
    input.pendingPromptClaims > 0 ||
    input.sdk.streaming ||
    input.sdk.retrying ||
    input.sdk.compacting ||
    input.sdk.queuedContinuation
  ) {
    return "working";
  }
  return "idle";
}

export function deriveObservedPhase(
  runtime: RuntimeState,
  phase: Phase,
): ObservedPhase {
  if (phase === "failed" || phase === "gone") return phase;
  return runtime === "asleep" ? "asleep" : phase;
}

function attentionFor(
  phase: Phase,
  pendingQuestionIds: readonly string[],
  interrupted: boolean,
): Attention {
  if (phase === "failed" || phase === "gone") return "failed";
  if (pendingQuestionIds.length > 0) return "question";
  if (interrupted) return "interrupted";
  return "none";
}

/** Derive phase and attention using .spec/03-session-model.md's first-match table. */
export function deriveSessionState(input: PhaseDerivationInput): DerivedSessionState {
  if (!Number.isSafeInteger(input.pendingPromptClaims) || input.pendingPromptClaims < 0) {
    throw new TypeError("pendingPromptClaims must be a non-negative safe integer");
  }
  const phase = phaseFor(input);
  return {
    phase,
    observedPhase: deriveObservedPhase(input.runtime, phase),
    attention: attentionFor(phase, input.pendingQuestionIds, input.interrupted),
  };
}
