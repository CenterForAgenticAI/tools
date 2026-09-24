import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type {
  AgentStartEvent,
  CompactionResult,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };
type AfterProviderResponseEvent = {
  readonly type: "after_provider_response";
  readonly status: number;
  readonly headers: Record<string, string>;
};
type MessageUpdateEvent = { readonly type: "message_update"; readonly message: unknown };
type MessageEndEvent = { readonly type: "message_end"; readonly message: unknown };
type AgentSettledEvent = { readonly type: "agent_settled" };
type ToolExecutionStartEvent = { readonly type: "tool_execution_start" };
type ToolExecutionEndEvent = { readonly type: "tool_execution_end" };
import type { CommandSession, MultiAccountCommandController } from "./commands.js";
import type { CompactionRouter } from "./compaction.js";
import type {
  ContinuationController,
  ContinuationDestination,
  ContinuationStartResult,
} from "./continuation.js";
import { DiagnosticLog } from "./diagnostics.js";
import type { RuntimeReference } from "./runtime-state.js";
import { RuntimeState } from "./runtime-state.js";
import type { UsageLedger } from "./usage.js";
import type { ContinuationWatchdog } from "./watchdog.js";
import {
  renderLogicalModelSwitchResult,
  type LogicalModelSwitchResult,
} from "./logical-model-switcher.js";

type PublicLifecycleEventMap = {
  session_before_compact: SessionBeforeCompactEvent;
  session_shutdown: SessionShutdownEvent;
  agent_start: AgentStartEvent;
  after_provider_response: AfterProviderResponseEvent;
  message_update: MessageUpdateEvent;
  message_end: MessageEndEvent;
  agent_settled: AgentSettledEvent;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_end: ToolExecutionEndEvent;
  input: InputEvent;
};

type PublicLifecycleEventName = keyof PublicLifecycleEventMap;
type PublicHandlerResult<TName extends PublicLifecycleEventName> =
  TName extends "session_before_compact" ? SessionBeforeCompactResult | void
    : TName extends "input" ? InputEventResult | void
      : void;

export interface LifecycleHost {
  on<TName extends PublicLifecycleEventName>(
    event: TName,
    handler: (
      event: PublicLifecycleEventMap[TName],
      context: ExtensionContext,
    ) => PublicHandlerResult<TName> | Promise<PublicHandlerResult<TName>>,
  ): void | (() => void);
  registerCommand(
    name: string,
    options: {
      readonly description?: string;
      readonly getArgumentCompletions?: (
        argumentPrefix: string,
      ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
      readonly handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
    },
  ): void | (() => void);
}

export interface LifecycleDependencies {
  readonly state: RuntimeState;
  readonly usage: UsageLedger;
  readonly diagnostics: DiagnosticLog;
  readonly commands: MultiAccountCommandController;
  readonly continuation: ContinuationController;
  readonly watchdog: ContinuationWatchdog;
  readonly compaction: CompactionRouter;
  /**
   * Acts on the failure classified during the agent run that just settled:
   * switch, park, or resume. Invoked only from `agent_settled`, never from
   * `message_end`, and at most once per settled run.
   */
  readonly settleTurn: () => void | Promise<void>;
  readonly clearStatus: () => void | Promise<void>;
  /** Executes the operator-only exact logical-model switch command. */
  readonly switchModel: (
    args: string,
    context: ExtensionCommandContext,
    signal: AbortSignal,
  ) => Promise<LogicalModelSwitchResult>;
  /**
   * Synchronous argument completion for `/multi-account`. The lifecycle only
   * forwards this to the host registration; it parses no grammar itself.
   */
  readonly completeMultiAccount: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null;
  /**
   * Synchronous argument completion for `/multi-account-model`. The lifecycle
   * only forwards this to the host registration; it parses no grammar itself.
   */
  readonly completeLogicalModel: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null;
  /** Invalidates exact-object logical routing associations on every cancellation path. */
  readonly invalidateLogicalTerminalAssociations?: () => void;
}

function messageError(message: unknown): unknown | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  return record.errorMessage;
}

/** Public-lifecycle-only coordinator. It intentionally registers no proactive request hook. */
export class MultiAccountLifecycle {
  readonly #dependencies: LifecycleDependencies;
  readonly #unregister: Array<() => void> = [];
  readonly #observedAbortSignals = new WeakSet<AbortSignal>();
  /**
   * One shutdown-linked controller for every operator dialog this session opens.
   * A modal selector or input has no other way to learn that Pi is going away,
   * and a dialog that outlives the session could commit after shutdown.
   */
  readonly #shutdownAbort = new AbortController();
  #shutdown = false;

  constructor(dependencies: LifecycleDependencies) {
    this.#dependencies = dependencies;
  }

  register(host: LifecycleHost): void {
    const executeLogicalModel = async (
      args: string,
      context: ExtensionCommandContext,
    ): Promise<{ output: string; level: "info" | "warning" }> => {
      const result = await this.#dependencies.switchModel(
        args,
        context,
        this.#shutdownAbort.signal,
      );
      return {
        output: renderLogicalModelSwitchResult(result),
        level:
          result.status === "selected" || result.status === "cancelled"
            ? "info"
            : "warning",
      };
    };
    const multiAccountHandler = async (
      args: string,
      context: ExtensionCommandContext,
    ): Promise<void> => {
      await this.#isolated("lifecycle.command", async () => {
        if (this.#shutdown) return;
        let outputLevel: "info" | "warning" = "info";
        const session: CommandSession = {
          mode: context.mode,
          hasUI: context.hasUI,
          ui: context.ui,
          switchLogicalModel: async (argument) => {
            const rendered = await executeLogicalModel(argument, context);
            outputLevel = rendered.level;
            return rendered.output;
          },
          signal: this.#shutdownAbort.signal,
        };
        const output = await this.#dependencies.commands.execute(args, session);
        if (this.#shutdown) return;
        context.ui.notify(
          this.#dependencies.diagnostics.sanitizeOutput(output),
          outputLevel,
        );
      });
    };
    this.#capture(host.registerCommand("multi-account", {
      description: "Manage Anthropic and Codex OAuth accounts.",
      getArgumentCompletions: (argumentPrefix) =>
        this.#dependencies.completeMultiAccount(argumentPrefix),
      handler: multiAccountHandler,
    }));

    const multiAccountModelHandler = async (
      args: string,
      context: ExtensionCommandContext,
    ): Promise<void> => {
      await this.#isolated("lifecycle.logical-model-command", async () => {
        if (this.#shutdown) return;
        const rendered = await executeLogicalModel(args, context);
        if (this.#shutdown) return;
        context.ui.notify(
          "Deprecated: use /multi-account model instead.",
          "warning",
        );
        context.ui.notify(
          this.#dependencies.diagnostics.sanitizeOutput(rendered.output),
          rendered.level,
        );
      });
    };
    this.#capture(host.registerCommand("multi-account-model", {
      description: "Deprecated alias for /multi-account model.",
      getArgumentCompletions: (argumentPrefix) =>
        this.#dependencies.completeLogicalModel(argumentPrefix),
      handler: multiAccountModelHandler,
    }));

    this.#capture(host.on("agent_start", async (_event, context) => {
      if (this.#shutdown) return;
      await this.#isolated("lifecycle.agent-start", () => this.#observeAbort(context.signal));
    }));

    this.#capture(host.on("after_provider_response", async (event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.after-provider-response", () => {
        this.#dependencies.diagnostics.recordHeaders("provider.response", event.headers);
      });
    }));

    this.#capture(host.on("message_update", async (_event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.message-update", () => this.#dependencies.watchdog.progressAll());
    }));

    this.#capture(host.on("message_end", async (event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.message-end", () => {
        this.#dependencies.watchdog.progressAll();
        const error = messageError(event.message);
        if (error !== undefined) {
          // Provider error bodies can contain credential values, request payloads,
          // message content, endpoint diagnostics, or account metadata. Persist only
          // the bounded fact that an error occurred; routing records its own safe
          // classification separately.
          this.#dependencies.diagnostics.record(
            "error",
            "provider.message",
            "The provider message ended with an error; raw details were omitted.",
          );
        }
      });
    }));

    // Pi emits `agent_settled` once per prompt-driven run, from a `finally`
    // wrapping both the agent loop and its retry/compaction loop, so it is the
    // first moment at which no further automatic retry can run. `message_end`
    // fires once per retry attempt — four times per turn in the 2026-08-05
    // trace, one initial request plus three backoff retries — so switching
    // there fights Pi's own retry layer. Classification stays on `message_end`;
    // the switch, park, or resume happens only here.
    this.#capture(host.on("agent_settled", async (_event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.agent-settled", () => this.#dependencies.settleTurn());
    }));

    this.#capture(host.on("tool_execution_start", async (_event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.tool-start", () => this.#dependencies.watchdog.setAllToolsRunning(true));
    }));

    this.#capture(host.on("tool_execution_end", async (_event, context) => {
      if (this.#shutdown) return;
      this.#observeAbort(context.signal);
      await this.#isolated("lifecycle.tool-end", () => this.#dependencies.watchdog.setAllToolsRunning(false));
    }));

    this.#capture(host.on("input", async (event) => {
      if (this.#shutdown) return { action: "continue" } as const;
      await this.#isolated("lifecycle.input", () => {
        if (event.source !== "extension") this.cancelPendingActivity("fresh-input");
      });
      return { action: "continue" } as const;
    }));

    this.#capture(host.on("session_before_compact", async (event) => {
      if (this.#shutdown) return;
      return this.#isolated("lifecycle.compaction", () => this.#dependencies.compaction.route(event));
    }));

    this.#capture(host.on("session_shutdown", async () => {
      await this.#isolated("lifecycle.session-shutdown", () => this.shutdown());
    }));
  }

  /** Called only by classified post-failure integration, never before a request. */
  async handleClassifiedFailure(
    failedTurnRef: RuntimeReference,
    destination: ContinuationDestination,
  ): Promise<ContinuationStartResult | undefined> {
    if (this.#shutdown) return undefined;
    return this.#isolated("lifecycle.reactive-failure", () =>
      this.#dependencies.continuation.start(failedTurnRef, destination));
  }

  cancelPendingActivity(reason: "abort" | "fresh-input" | "stop" | "shutdown"): void {
    if (this.#shutdown && reason !== "shutdown") return;
    this.#isolatedSync(
      "lifecycle.cancel-logical-attribution",
      () => this.#dependencies.invalidateLogicalTerminalAssociations?.(),
    );
    this.#isolatedSync("lifecycle.cancel-watchdog", () => this.#dependencies.watchdog.cancelAll());
    this.#isolatedSync("lifecycle.cancel-continuation", () => this.#dependencies.continuation.cancelAll());
    this.#dependencies.diagnostics.record("info", "lifecycle.cancel", `Pending activity cancelled: ${reason}.`);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    // Aborted synchronously and first: an open dialog must be dismissed before
    // shutdown waits on anything, or a pending configure flow could still reach
    // its commit.
    this.#shutdownAbort.abort();
    this.cancelPendingActivity("shutdown");
    await this.#isolated("lifecycle.command-shutdown", () => this.#dependencies.commands.shutdown());
    await this.#isolated("lifecycle.state-clear", () => this.#dependencies.state.clearAll());
    await this.#isolated("lifecycle.usage-clear", () => this.#dependencies.usage.clear());
    await this.#isolated("lifecycle.clear-status", this.#dependencies.clearStatus);
    const unregisterCallbacks = this.#unregister.splice(0);
    const unregisterTasks: Array<Promise<unknown>> = [];
    for (let index = unregisterCallbacks.length - 1; index >= 0; index -= 1) {
      const unregister = unregisterCallbacks[index];
      if (unregister) unregisterTasks.push(this.#isolated("lifecycle.unregister", unregister));
    }
    await Promise.all(unregisterTasks);
    this.#dependencies.diagnostics.clear();
  }

  isShutdown(): boolean {
    return this.#shutdown;
  }

  #capture(unregister: void | (() => void)): void {
    if (typeof unregister === "function") this.#unregister.push(unregister);
  }

  #observeAbort(signal: AbortSignal | undefined): void {
    if (!signal || this.#observedAbortSignals.has(signal)) return;
    this.#observedAbortSignals.add(signal);
    if (signal.aborted) {
      this.cancelPendingActivity("abort");
      return;
    }
    signal.addEventListener("abort", () => this.cancelPendingActivity("abort"), { once: true });
  }

  #isolatedSync<TResult>(category: string, operation: () => TResult): TResult | undefined {
    try {
      return operation();
    } catch (error) {
      this.#dependencies.diagnostics.recordError(category, error);
      return undefined;
    }
  }

  async #isolated<TResult>(category: string, operation: () => TResult | Promise<TResult>): Promise<TResult | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.#dependencies.diagnostics.recordError(category, error);
      return undefined;
    }
  }
}
