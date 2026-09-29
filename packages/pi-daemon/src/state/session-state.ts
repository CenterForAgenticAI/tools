import type {
  Attention,
  ObservedPhase,
  Phase,
  RuntimeState,
  SessionSummary,
} from "../protocol/index.js";
import {
  deriveSessionState,
  type PhaseDerivationInput,
  type SdkWorkState,
  type SessionFileStatus,
} from "./phase.js";

export type SessionStateSignal =
  | { readonly type: "runtime"; readonly runtime: RuntimeState }
  | { readonly type: "file_status"; readonly status: SessionFileStatus }
  | { readonly type: "fatal_failure"; readonly failed: boolean }
  | {
      readonly type: "question_opened";
      readonly question: SessionSummary["pendingQuestions"][number];
    }
  | { readonly type: "questions"; readonly pendingQuestionIds: readonly string[] }
  | { readonly type: "prompt_claimed"; readonly promptId: string }
  | { readonly type: "prompt_settled"; readonly promptId: string }
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end" }
  | { readonly type: "agent_settled" }
  | { readonly type: "retry_start" }
  | { readonly type: "retry_end" }
  | { readonly type: "compaction_start" }
  | { readonly type: "compaction_end" }
  | { readonly type: "queue"; readonly queued: boolean }
  | { readonly type: "restored" };

export interface SessionStateSnapshot {
  readonly runtime: RuntimeState;
  readonly phase: Phase;
  readonly observedPhase: ObservedPhase;
  readonly attention: Attention;
  readonly pendingQuestionIds: readonly string[];
  readonly pendingQuestions: SessionSummary["pendingQuestions"];
}

export interface SessionStateChange {
  readonly before: SessionStateSnapshot;
  readonly after: SessionStateSnapshot;
  readonly reason: SessionStateSignal["type"];
  readonly durableTransition: boolean;
}

export interface SessionStateMachineOptions {
  readonly runtime: RuntimeState;
  readonly phase: Phase;
  readonly attention: Attention;
  readonly fileStatus?: SessionFileStatus;
  readonly fatalFailure?: boolean;
}

const noSdkWork: SdkWorkState = {
  streaming: false,
  retrying: false,
  compacting: false,
  queuedContinuation: false,
};

function sameSnapshot(left: SessionStateSnapshot, right: SessionStateSnapshot): boolean {
  return (
    left.runtime === right.runtime &&
    left.phase === right.phase &&
    left.observedPhase === right.observedPhase &&
    left.attention === right.attention &&
    left.pendingQuestionIds.length === right.pendingQuestionIds.length &&
    left.pendingQuestionIds.every((id, index) => right.pendingQuestionIds[index] === id) &&
    JSON.stringify(left.pendingQuestions) === JSON.stringify(right.pendingQuestions)
  );
}

/** Stateful signal adapter around deriveSessionState; agent_end deliberately changes nothing. */
export class SessionStateMachine {
  #runtime: RuntimeState;
  #retainedPhase: Phase;
  #fileStatus: SessionFileStatus;
  #fatalFailure: boolean;
  #pendingQuestionIds: readonly string[] = [];
  readonly #pendingQuestions = new Map<
    string,
    SessionSummary["pendingQuestions"][number]
  >();
  readonly #pendingPromptIds = new Set<string>();
  #sdk: SdkWorkState = noSdkWork;
  #interrupted: boolean;
  #snapshot: SessionStateSnapshot;

  constructor(options: SessionStateMachineOptions) {
    this.#runtime = options.runtime;
    this.#retainedPhase = options.phase;
    this.#fileStatus = options.fileStatus ?? "healthy";
    this.#fatalFailure = options.fatalFailure ?? false;
    this.#interrupted = options.attention === "interrupted";
    this.#snapshot = this.derive();
  }

  get current(): SessionStateSnapshot {
    return this.#snapshot;
  }

  apply(signal: SessionStateSignal): SessionStateChange | undefined {
    const before = this.#snapshot;
    this.updateInputs(signal);
    const after = this.derive();
    if (after.phase !== "failed" && after.phase !== "gone") {
      this.#retainedPhase = after.phase;
    }
    this.#snapshot = after;
    if (sameSnapshot(before, after)) return undefined;
    return {
      before,
      after,
      reason: signal.type,
      durableTransition:
        before.phase !== after.phase || before.attention !== after.attention,
    };
  }

  private derive(): SessionStateSnapshot {
    const input: PhaseDerivationInput = {
      runtime: this.#runtime,
      previousPhase: this.#retainedPhase,
      fileStatus: this.#fileStatus,
      fatalFailure: this.#fatalFailure,
      pendingQuestionIds: this.#pendingQuestionIds,
      pendingPromptClaims: this.#pendingPromptIds.size,
      sdk: this.#sdk,
      interrupted: this.#interrupted,
    };
    const derived = deriveSessionState(input);
    return {
      runtime: this.#runtime,
      ...derived,
      pendingQuestionIds: [...this.#pendingQuestionIds],
      pendingQuestions: this.#pendingQuestionIds.flatMap((questionId) => {
        const question = this.#pendingQuestions.get(questionId);
        return question === undefined ? [] : [question];
      }),
    };
  }

  private updateInputs(signal: SessionStateSignal): void {
    switch (signal.type) {
      case "runtime":
        this.#runtime = signal.runtime;
        return;
      case "file_status":
        this.#fileStatus = signal.status;
        return;
      case "fatal_failure":
        this.#fatalFailure = signal.failed;
        return;
      case "question_opened":
        this.#pendingQuestions.set(signal.question.questionId, signal.question);
        if (!this.#pendingQuestionIds.includes(signal.question.questionId)) {
          this.#pendingQuestionIds = [...this.#pendingQuestionIds, signal.question.questionId];
        }
        return;
      case "questions":
        this.#pendingQuestionIds = [...signal.pendingQuestionIds];
        for (const questionId of this.#pendingQuestions.keys()) {
          if (!this.#pendingQuestionIds.includes(questionId)) {
            this.#pendingQuestions.delete(questionId);
          }
        }
        return;
      case "prompt_claimed":
        this.#pendingPromptIds.add(signal.promptId);
        this.#interrupted = false;
        return;
      case "prompt_settled":
        this.#pendingPromptIds.delete(signal.promptId);
        return;
      case "agent_start":
        this.#sdk = { ...this.#sdk, streaming: true };
        return;
      case "agent_end":
        return;
      case "agent_settled":
        this.#sdk = noSdkWork;
        this.#pendingPromptIds.clear();
        return;
      case "retry_start":
        this.#sdk = { ...this.#sdk, retrying: true };
        return;
      case "retry_end":
        this.#sdk = { ...this.#sdk, retrying: false };
        return;
      case "compaction_start":
        this.#sdk = { ...this.#sdk, compacting: true };
        return;
      case "compaction_end":
        this.#sdk = { ...this.#sdk, compacting: false };
        return;
      case "queue":
        this.#sdk = { ...this.#sdk, queuedContinuation: signal.queued };
        return;
      case "restored":
        this.#interrupted = true;
        this.#pendingQuestionIds = [];
        this.#pendingQuestions.clear();
        return;
    }
  }
}
