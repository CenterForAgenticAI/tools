import { randomUUID } from "node:crypto";

import {
  Theme,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  HostBlockingUiMethod,
  HostUiAnswer,
  HostUiAnswerResult,
  HostUiBridge,
  HostUiProtocolAnswer,
  HostUiFrame,
  HostUiRequest,
} from "./session-host.js";

type PendingQuestion = {
  readonly method: HostBlockingUiMethod;
  answer(answer: HostUiAnswer): boolean;
  cancel(): void;
};

type TextMethod = Exclude<HostBlockingUiMethod, "confirm">;
type WidgetFactory = Exclude<
  Parameters<ExtensionUIContext["setWidget"]>[1],
  string[] | undefined
>;
type WidgetContent = string[] | WidgetFactory | undefined;

function createHeadlessTheme(): Theme {
  const foreground = {
    accent: "",
    border: "",
    borderAccent: "",
    borderMuted: "",
    success: "",
    error: "",
    warning: "",
    muted: "",
    dim: "",
    text: "",
    thinkingText: "",
    searchMatchText: "",
    userMessageText: "",
    customMessageText: "",
    customMessageLabel: "",
    toolTitle: "",
    toolOutput: "",
    mdHeading: "",
    mdLink: "",
    mdLinkUrl: "",
    mdCode: "",
    mdCodeBlock: "",
    mdCodeBlockBorder: "",
    mdQuote: "",
    mdQuoteBorder: "",
    mdHr: "",
    mdListBullet: "",
    toolDiffAdded: "",
    toolDiffRemoved: "",
    toolDiffContext: "",
    syntaxComment: "",
    syntaxKeyword: "",
    syntaxFunction: "",
    syntaxVariable: "",
    syntaxString: "",
    syntaxNumber: "",
    syntaxType: "",
    syntaxOperator: "",
    syntaxPunctuation: "",
    thinkingOff: "",
    thinkingMinimal: "",
    thinkingLow: "",
    thinkingMedium: "",
    thinkingHigh: "",
    thinkingXhigh: "",
    thinkingMax: "",
    bashMode: "",
  } satisfies ConstructorParameters<typeof Theme>[0];
  const backgrounds = {
    selectedBg: "",
    searchMatchBg: "",
    userMessageBg: "",
    customMessageBg: "",
    toolPendingBg: "",
    toolSuccessBg: "",
    toolErrorBg: "",
  } satisfies ConstructorParameters<typeof Theme>[1];
  return new Theme(foreground, backgrounds, "truecolor", {
    name: "pi-daemon-headless",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return (
    Object.keys(value).toSorted().join("\0") ===
    [...expected].toSorted().join("\0")
  );
}

function parseTextAnswer(
  method: TextMethod,
  answer: HostUiAnswer,
): { readonly valid: true; readonly value: string | undefined } | { readonly valid: false } {
  if (answer.method !== method) return { valid: false };
  if ("cancelled" in answer && answer.cancelled && hasExactKeys(answer, ["method", "cancelled"])) {
    return { valid: true, value: undefined };
  }
  if ("value" in answer && typeof answer.value === "string" && hasExactKeys(answer, ["method", "value"])) {
    return { valid: true, value: answer.value };
  }
  return { valid: false };
}

function parseProtocolAnswer(
  method: HostBlockingUiMethod,
  answer: HostUiProtocolAnswer,
): HostUiAnswer | undefined {
  if (!isRecord(answer)) return undefined;
  if (
    "cancelled" in answer &&
    answer.cancelled === true &&
    hasExactKeys(answer, ["cancelled"])
  ) {
    if (method === "confirm") return { method, cancelled: true };
    return { method, cancelled: true };
  }
  if (
    method === "confirm" &&
    "confirmed" in answer &&
    typeof answer.confirmed === "boolean" &&
    hasExactKeys(answer, ["confirmed"])
  ) {
    return { method, confirmed: answer.confirmed };
  }
  if (
    method !== "confirm" &&
    "value" in answer &&
    typeof answer.value === "string" &&
    hasExactKeys(answer, ["value"])
  ) {
    return { method, value: answer.value };
  }
  return undefined;
}

function parseConfirmAnswer(
  answer: HostUiAnswer,
): { readonly valid: true; readonly value: boolean } | { readonly valid: false } {
  if (answer.method !== "confirm") return { valid: false };
  if ("cancelled" in answer && answer.cancelled && hasExactKeys(answer, ["method", "cancelled"])) {
    return { valid: true, value: false };
  }
  if ("confirmed" in answer && typeof answer.confirmed === "boolean" && hasExactKeys(answer, ["method", "confirmed"])) {
    return { valid: true, value: answer.confirmed };
  }
  return { valid: false };
}

export class DaemonExtensionUi implements HostUiBridge {
  readonly context: ExtensionUIContext;

  readonly #pending = new Map<string, PendingQuestion>();
  readonly #subscribers = new Set<(frame: HostUiFrame) => void>();
  #editorText = "";
  #toolsExpanded = false;
  #acceptingQuestions = true;

  constructor(
    theme: Theme = createHeadlessTheme(),
    private readonly questionId: () => string = randomUUID,
  ) {
    this.context = {
      select: (title, options, dialogOptions) =>
        this.openTextQuestion(
          "select",
          title,
          { options: [...options] },
          dialogOptions,
        ),
      confirm: (title, message, dialogOptions) =>
        this.openConfirmQuestion(title, message, dialogOptions),
      input: (title, placeholder, dialogOptions) =>
        this.openTextQuestion(
          "input",
          title,
          placeholder === undefined ? {} : { placeholder },
          dialogOptions,
        ),
      editor: (title, prefill) =>
        this.openTextQuestion(
          "editor",
          title,
          prefill === undefined ? {} : { prefill },
          undefined,
        ),
      notify: (message, type) => this.notice("notify", { message, type }),
      onTerminalInput: () => () => undefined,
      setStatus: (key, text) => this.notice("setStatus", { key, text }),
      setWorkingMessage: (message) =>
        this.notice("setWorkingMessage", { message }),
      setWorkingVisible: (visible) =>
        this.notice("setWorkingVisible", { visible }),
      setWorkingIndicator: (options) =>
        this.notice("setWorkingIndicator", {
          options: options === undefined ? undefined : structuredClone(options),
        }),
      setHiddenThinkingLabel: (label) =>
        this.notice("setHiddenThinkingLabel", { label }),
      setWidget: (key: string, content: WidgetContent, options) => {
        if (content === undefined || Array.isArray(content)) {
          this.notice("setWidget", {
            key,
            content: content === undefined ? undefined : [...content],
            placement: options?.placement,
          });
        }
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: (title) => this.notice("setTitle", { title }),
      custom: async <T>() => undefined as T,
      pasteToEditor: (text) => {
        this.#editorText = text;
        this.notice("pasteToEditor", { text });
      },
      setEditorText: (text) => {
        this.#editorText = text;
        this.notice("setEditorText", { text });
      },
      getEditorText: () => this.#editorText,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme,
      getAllThemes: () => [
        { name: theme.name ?? "pi-daemon-headless", path: theme.sourcePath },
      ],
      getTheme: (name) => (name === theme.name ? theme : undefined),
      setTheme: () => ({
        success: false,
        error: "Theme switching is unavailable in headless mode",
      }),
      getToolsExpanded: () => this.#toolsExpanded,
      setToolsExpanded: (expanded) => {
        this.#toolsExpanded = expanded;
        this.notice("setToolsExpanded", { expanded });
      },
    };
  }

  get pendingQuestionCount(): number {
    return this.#pending.size;
  }

  get pendingQuestionIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  subscribe(listener: (frame: HostUiFrame) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  answer(questionId: string, answer: HostUiAnswer): boolean {
    return this.#pending.get(questionId)?.answer(answer) ?? false;
  }

  answerProtocol(
    questionId: string,
    answer: HostUiProtocolAnswer,
  ): HostUiAnswerResult {
    const pending = this.#pending.get(questionId);
    if (pending === undefined) return "unknown_question";
    const parsed = parseProtocolAnswer(pending.method, answer);
    if (parsed === undefined) return "invalid_ui_answer";
    return pending.answer(parsed) ? "answered" : "unknown_question";
  }

  cancelPending(): void {
    for (const pending of [...this.#pending.values()]) pending.cancel();
  }

  close(): void {
    this.#acceptingQuestions = false;
    this.cancelPending();
  }

  private notice(method: string, data: Record<string, unknown>): void {
    this.emit({ kind: "notice", method, data });
  }

  private emit(frame: HostUiFrame): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(frame);
      } catch {
        // A transport subscriber cannot change extension UI behavior.
      }
    }
  }

  private openTextQuestion(
    method: TextMethod,
    title: string,
    details: Omit<
      HostUiRequest,
      "kind" | "questionId" | "method" | "title" | "timeout"
    >,
    options: ExtensionUIDialogOptions | undefined,
  ): Promise<string | undefined> {
    return this.openQuestion(
      method,
      title,
      details,
      undefined,
      options,
      (answer) => parseTextAnswer(method, answer),
    );
  }

  private openConfirmQuestion(
    title: string,
    message: string,
    options: ExtensionUIDialogOptions | undefined,
  ): Promise<boolean> {
    return this.openQuestion(
      "confirm",
      title,
      { message },
      false,
      options,
      parseConfirmAnswer,
    );
  }

  private openQuestion<T>(
    method: HostBlockingUiMethod,
    title: string,
    details: Omit<
      HostUiRequest,
      "kind" | "questionId" | "method" | "title" | "timeout"
    >,
    defaultValue: T,
    options: ExtensionUIDialogOptions | undefined,
    parse: (
      answer: HostUiAnswer,
    ) => { readonly valid: true; readonly value: T } | { readonly valid: false },
  ): Promise<T> {
    if (!this.#acceptingQuestions || options?.signal?.aborted === true) {
      return Promise.resolve(defaultValue);
    }

    const questionId = `ui-${this.questionId()}`;
    const request: HostUiRequest = {
      kind: "request",
      questionId,
      method,
      title,
      ...details,
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    };

    return new Promise<T>((resolve) => {
      let opening = true;
      let settled = false;
      let queued: { readonly value: T } | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const complete = (value: T): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(questionId);
        this.emit({
          kind: "phase",
          phase: this.#pending.size === 0 ? "unblocked" : "blocked",
          questionId,
          pendingQuestionIds: this.pendingQuestionIds,
        });
        resolve(value);
      };
      const finish = (value: T): boolean => {
        if (settled) return false;
        settled = true;
        if (opening) {
          queued = { value };
        } else {
          complete(value);
        }
        return true;
      };
      const onAbort = (): void => {
        finish(defaultValue);
      };
      const pending: PendingQuestion = {
        method,
        answer: (answer) => {
          const parsed = parse(answer);
          if (!parsed.valid) return false;
          return finish(parsed.value);
        },
        cancel: onAbort,
      };
      this.#pending.set(questionId, pending);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.timeout !== undefined) {
        timeout = setTimeout(onAbort, options.timeout);
      }
      this.emit(request);
      this.emit({
        kind: "phase",
        phase: "blocked",
        questionId,
        pendingQuestionIds: this.pendingQuestionIds,
      });
      opening = false;
      if (queued !== undefined) complete(queued.value);
    });
  }
}
