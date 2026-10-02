import { existsSync } from "node:fs";

import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type {
  AwakeSessionHost,
  HostCommittedEntry,
  HostSdkEvent,
  HostUiRequest,
  StatefulAwakeSessionHost,
} from "../host/index.js";
import type { SessionSummary } from "../protocol/index.js";
import type {
  StreamSessionCapture,
  StreamSessionSource,
  StreamSessionState,
} from "./types.js";

export interface SessionStreamSourceOptions {
  readonly sessionId: string;
  readonly getSessionSummary: () => SessionSummary;
}

export interface BindableStreamSessionSource extends StreamSessionSource {
  bindHost(host: AwakeSessionHost | undefined): void;
  dispose(): void;
}

export interface HostStreamSessionSourceOptions {
  readonly host: AwakeSessionHost;
  readonly getSessionSummary: () => SessionSummary;
}

function isStatefulHost(
  host: AwakeSessionHost | undefined,
): host is StatefulAwakeSessionHost {
  return host !== undefined && "state" in host;
}

class SessionFileStreamSource implements BindableStreamSessionSource {
  readonly sessionId: string;
  readonly #getSessionSummary: () => SessionSummary;
  readonly #committedListeners = new Set<
    (committed: HostCommittedEntry) => void
  >();
  readonly #sdkListeners = new Set<(event: HostSdkEvent) => void>();
  readonly #uiListeners = new Set<(request: HostUiRequest) => void>();
  readonly #pendingUiQuestions = new Map<
    string,
    SessionSummary["pendingQuestions"][number]
  >();
  readonly #knownCommittedEntryIds = new Set<string>();
  readonly #syntheticCatchupEntryIds = new Set<string>();
  #host: AwakeSessionHost | undefined;
  #unsubscribeCommitted: (() => void) | undefined;
  #unsubscribeSdk: (() => void) | undefined;
  #unsubscribeUi: (() => void) | undefined;
  #generation: number | undefined;
  #lastCommittedSequence = 0;

  constructor(options: SessionStreamSourceOptions) {
    this.sessionId = options.sessionId;
    this.#getSessionSummary = options.getSessionSummary;
  }

  get committedSequence(): number {
    return this.#lastCommittedSequence;
  }

  currentState(): StreamSessionState {
    const summary = this.getSummary();
    return {
      epoch: summary.epoch,
      generation: this.currentHost(summary)?.generation ?? summary.generation,
    };
  }

  capture(): StreamSessionCapture {
    const storedSummary = this.getSummary();
    const host = this.currentHost(storedSummary);
    const summary = isStatefulHost(host)
      ? {
          ...storedSummary,
          runtime: host.state.runtime,
          phase: host.state.phase,
          observedPhase: host.state.observedPhase,
          attention: host.state.attention,
          pendingQuestions: host.ui.pendingQuestionIds.flatMap((questionId) => {
            const question =
              this.#pendingUiQuestions.get(questionId) ??
              host.state.pendingQuestions.find(
                (candidate) => candidate.questionId === questionId,
              );
            return question === undefined ? [] : [question];
          }),
        }
      : storedSummary;
    const committedManager = this.openCommittedManager(summary);
    const allEntries = committedManager?.getEntries() ?? [];
    const activeBranch = committedManager?.getBranch() ?? [];
    for (const entry of activeBranch) this.#knownCommittedEntryIds.add(entry.id);
    const leafId = committedManager?.getLeafId() ?? null;
    return {
      epoch: summary.epoch,
      generation: host?.generation ?? summary.generation,
      leafId,
      activeBranch,
      allEntries,
      summary,
    };
  }

  subscribeCommittedEntries(
    listener: (committed: HostCommittedEntry) => void,
  ): () => void {
    this.#committedListeners.add(listener);
    return () => this.#committedListeners.delete(listener);
  }

  subscribeSdkEvents(listener: (event: HostSdkEvent) => void): () => void {
    this.#sdkListeners.add(listener);
    return () => this.#sdkListeners.delete(listener);
  }

  subscribeUi(listener: (request: HostUiRequest) => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  bindHost(host: AwakeSessionHost | undefined): void {
    if (host?.sessionId !== undefined && host.sessionId !== this.sessionId) {
      throw new TypeError("cannot bind another session's host to a stream source");
    }
    if (host === this.#host) return;
    this.stopHostSubscriptions();
    this.#host = host;
    if (host === undefined) {
      this.#pendingUiQuestions.clear();
      return;
    }
    if (host.generation !== this.#generation) {
      this.#generation = host.generation;
      this.#lastCommittedSequence = 0;
      this.#pendingUiQuestions.clear();
      this.#syntheticCatchupEntryIds.clear();
    }

    this.#unsubscribeCommitted = host.subscribeCommittedEntries((committed) => {
      if (committed.sessionId !== this.sessionId) return;
      this.#knownCommittedEntryIds.add(committed.entry.id);
      if (this.#syntheticCatchupEntryIds.delete(committed.entry.id)) return;
      this.publishCommitted(committed.entry);
    });
    this.#unsubscribeSdk = host.subscribeSdkEvents((event) => {
      if (event.sessionId !== this.sessionId) return;
      for (const listener of this.#sdkListeners) listener(event);
    });
    this.#unsubscribeUi = host.ui.subscribe((frame) => {
      if (
        host !== this.#host ||
        host.sessionId !== this.sessionId ||
        host.generation !== this.#generation
      ) {
        return;
      }
      if (frame.kind === "request") {
        this.#pendingUiQuestions.set(frame.questionId, {
          questionId: frame.questionId,
          method: frame.method,
          title: frame.title,
        });
        for (const listener of this.#uiListeners) listener(frame);
        return;
      }
      if (frame.kind === "phase") {
        const pendingIds = new Set(frame.pendingQuestionIds);
        for (const questionId of this.#pendingUiQuestions.keys()) {
          if (!pendingIds.has(questionId)) this.#pendingUiQuestions.delete(questionId);
        }
      }
    });

    const summary = this.getSummary();
    const committedManager = this.openCommittedManager(summary);
    for (const entry of committedManager?.getBranch() ?? []) {
      if (this.#knownCommittedEntryIds.has(entry.id)) continue;
      this.#knownCommittedEntryIds.add(entry.id);
      if (this.#committedListeners.size > 0) {
        this.#syntheticCatchupEntryIds.add(entry.id);
      }
      this.publishCommitted(entry);
    }
  }

  dispose(): void {
    this.stopHostSubscriptions();
    this.#host = undefined;
    this.#committedListeners.clear();
    this.#sdkListeners.clear();
    this.#uiListeners.clear();
    this.#pendingUiQuestions.clear();
    this.#knownCommittedEntryIds.clear();
    this.#syntheticCatchupEntryIds.clear();
  }

  /**
   * The bound host, unless the registry has moved past its generation. A host
   * left bound after it slept (the registry generation advances on every sleep)
   * never supplies session state; the stored summary does.
   */
  private currentHost(summary: SessionSummary): AwakeSessionHost | undefined {
    const host = this.#host;
    return host !== undefined && host.generation >= summary.generation ? host : undefined;
  }

  private getSummary(): SessionSummary {
    const summary = this.#getSessionSummary();
    if (summary.sessionId !== this.sessionId) {
      throw new TypeError("stream summary belongs to another session");
    }
    return summary;
  }

  private openCommittedManager(summary: SessionSummary): SessionManager | undefined {
    if (!existsSync(summary.sessionFile)) return undefined;
    const manager = SessionManager.open(summary.sessionFile);
    if (manager.getSessionId() !== this.sessionId) {
      throw new TypeError("committed stream snapshot belongs to another session");
    }
    return manager;
  }

  private publishCommitted(entry: SessionEntry): void {
    this.#lastCommittedSequence += 1;
    const committed: HostCommittedEntry = {
      sequence: this.#lastCommittedSequence,
      sessionId: this.sessionId,
      cursor: { entryId: entry.id },
      entry,
    };
    for (const listener of this.#committedListeners) listener(committed);
  }

  private stopHostSubscriptions(): void {
    this.#unsubscribeCommitted?.();
    this.#unsubscribeSdk?.();
    this.#unsubscribeUi?.();
    this.#unsubscribeCommitted = undefined;
    this.#unsubscribeSdk = undefined;
    this.#unsubscribeUi = undefined;
  }
}

export function createSessionStreamSource(
  options: SessionStreamSourceOptions,
): BindableStreamSessionSource {
  return new SessionFileStreamSource(options);
}

export function createHostStreamSessionSource(
  options: HostStreamSessionSourceOptions,
): BindableStreamSessionSource {
  const source = createSessionStreamSource({
    sessionId: options.host.sessionId,
    getSessionSummary: options.getSessionSummary,
  });
  source.bindHost(options.host);
  return source;
}
