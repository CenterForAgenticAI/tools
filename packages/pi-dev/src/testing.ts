import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type LifecycleEvent = "session_start" | "session_shutdown";

const lifecycleEvents = new Set<LifecycleEvent>(["session_start", "session_shutdown"]);
const supportedModes = new Set<ConformanceMode>(["print", "rpc", "tui"]);

export type ConformanceMode = Extract<ExtensionContext["mode"], "print" | "rpc" | "tui">;
export type WidgetComponent = Component & { dispose?(): void };
export type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;
export type WidgetValue = string[] | WidgetComponent;

export interface ConformanceOptions {
  mode?: ConformanceMode;
  cwd?: string;
  uiContext?: ExtensionUIContext | null;
}

export interface RpcStatusEmission {
  readonly key: string;
  readonly value: string | undefined;
}

export interface RpcWidgetEmission {
  readonly key: string;
  readonly content: string[] | undefined;
  readonly options?: { placement?: "aboveEditor" | "belowEditor" };
}

export interface RenderObservation {
  readonly key: string;
  readonly width: number;
  readonly output: string[];
}

export interface RegisteredHandlerObservation {
  readonly event: string;
  readonly handler: (...args: unknown[]) => unknown;
}

export interface EventBusProviderObservation {
  readonly channel: string;
  readonly handler: (data: unknown) => void;
  readonly active: boolean;
}

export interface ConformanceRebindOptions {
  cwd?: string;
  mode?: ConformanceMode;
  ui?: ExtensionUIContext;
  sessionManager?: ExtensionContext["sessionManager"];
  modelRegistry?: ExtensionContext["modelRegistry"];
  model?: ExtensionContext["model"];
  signal?: ExtensionContext["signal"];
}

export interface ConformanceSnapshot {
  readonly mode: ConformanceMode;
  readonly hasUI: boolean;
  readonly statuses: readonly (readonly [string, string])[];
  readonly widgets: readonly (readonly [string, unknown])[];
  readonly rpcStatus: readonly RpcStatusEmission[];
  readonly rpcWidgets: readonly RpcWidgetEmission[];
  readonly renderObservations: readonly RenderObservation[];
  readonly handlers: readonly { readonly event: string }[];
  readonly providers: readonly { readonly channel: string; readonly active: boolean }[];
}

export interface ConformanceHarness {
  readonly pi: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly ctx: ExtensionContext;
  readonly currentContext: ExtensionContext;
  readonly noopUI: ExtensionUIContext;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly statuses: ReadonlyMap<string, string>;
  readonly widgets: ReadonlyMap<string, WidgetValue>;
  readonly rpcStatus: readonly RpcStatusEmission[];
  readonly rpcWidgets: readonly RpcWidgetEmission[];
  readonly renderObservations: readonly RenderObservation[];
  readonly handlers: readonly RegisteredHandlerObservation[];
  readonly providers: readonly EventBusProviderObservation[];
  setUIContext(uiContext: ExtensionUIContext | null | undefined, mode?: ConformanceMode): ExtensionContext;
  rebind(overrides?: ConformanceRebindOptions): ExtensionContext;
  fire(event: LifecycleEvent): Promise<void>;
  getStatus(key: string): string | undefined;
  getWidget(key: string): WidgetValue | undefined;
  getRegisteredHandlers(event?: string): readonly RegisteredHandlerObservation[];
  getEventBusProviders(channel?: string): readonly EventBusProviderObservation[];
  render(widths: number | readonly number[]): readonly RenderObservation[];
  snapshot(): ConformanceSnapshot;
}

export type ConformanceContext = ConformanceHarness;

interface LifecycleRegistration {
  readonly event: LifecycleEvent;
  readonly invoke: (event: unknown, context: ExtensionContext) => unknown;
}

interface ProviderRecord extends EventBusProviderObservation {
  active: boolean;
}

interface HarnessState {
  mode: ConformanceMode;
  cwd: string;
  ui: ExtensionUIContext;
  readonly statuses: Map<string, string>;
  readonly widgets: Map<string, WidgetValue>;
  readonly rpcStatus: RpcStatusEmission[];
  readonly rpcWidgets: RpcWidgetEmission[];
  readonly renderObservations: RenderObservation[];
  readonly handlers: RegisteredHandlerObservation[];
  readonly lifecycleHandlers: LifecycleRegistration[];
  readonly providers: ProviderRecord[];
  readonly noopUI: ExtensionUIContext;
  readonly tui: TUI;
  readonly theme: Theme;
}

type UIOverrides = {
  setStatus(key: string, text: string | undefined): void;
  setWidget: ExtensionUIContext["setWidget"];
};

function assertMode(mode: ConformanceMode): void {
  if (!supportedModes.has(mode)) throw new RangeError(`Unsupported conformance mode: ${String(mode)}`);
}

function frozen<T extends object>(record: T): Readonly<T> {
  return Object.freeze(record);
}

function createUI(theme: Theme, overrides: UIOverrides): ExtensionUIContext {
  const ui = {
    select(_title: string, _options: string[], _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    confirm(_title: string, _message: string, _opts?: ExtensionUIDialogOptions): Promise<boolean> {
      return Promise.resolve(false);
    },
    input(_title: string, _placeholder?: string, _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    notify(_message: string, _type?: "info" | "warning" | "error"): void {},
    onTerminalInput(_handler: ExtensionUIContext["onTerminalInput"] extends (handler: infer H) => unknown ? H : never): () => void {
      return () => {};
    },
    setStatus: overrides.setStatus,
    setWorkingMessage(_message?: string): void {},
    setWorkingVisible(_visible: boolean): void {},
    setWorkingIndicator(_options?: Parameters<ExtensionUIContext["setWorkingIndicator"]>[0]): void {},
    setHiddenThinkingLabel(_label?: string): void {},
    setWidget: overrides.setWidget,
    setFooter(_factory: CallableFunction | undefined): void {},
    setHeader(_factory: CallableFunction | undefined): void {},
    setTitle(_title: string): void {},
    custom<T>(_factory: CallableFunction, _options?: object): Promise<T> {
      return Promise.reject(new Error("custom UI is not implemented by the conformance harness"));
    },
    pasteToEditor(_text: string): void {},
    setEditorText(_text: string): void {},
    getEditorText(): string {
      return "";
    },
    editor(_title: string, _prefill?: string): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    addAutocompleteProvider(_factory: CallableFunction): void {},
    setEditorComponent(_factory: CallableFunction | undefined): void {},
    getEditorComponent(): undefined {
      return undefined;
    },
    // Theme is an opaque identity sentinel; this harness has no practical Theme constructor.
    theme,
    getAllThemes(): { name: string; path: string | undefined }[] {
      return [];
    },
    getTheme(_name: string): Theme | undefined {
      return undefined;
    },
    setTheme(_theme: string | Theme): { success: boolean; error?: string } {
      return { success: false };
    },
    getToolsExpanded(): boolean {
      return false;
    },
    setToolsExpanded(_expanded: boolean): void {},
  } satisfies ExtensionUIContext;
  return ui;
}

function createNoopUI(theme: Theme): ExtensionUIContext {
  return createUI(theme, {
    setStatus: () => {},
    setWidget: () => {},
  });
}

function createComponentUI(state: HarnessState): ExtensionUIContext {
  function setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: string[] | WidgetFactory | undefined, _options?: ExtensionWidgetOptions): void {
    if (state.mode === "rpc") return;
    if (typeof content === "function") state.widgets.set(key, content(state.tui, state.theme));
    else if (content === undefined) state.widgets.delete(key);
    else state.widgets.set(key, content);
  }

  return createUI(state.theme, {
    setStatus: (key: string, text: string | undefined): void => {
      if (text === undefined) state.statuses.delete(key);
      else state.statuses.set(key, text);
    },
    setWidget,
  });
}

function createRpcUI(state: HarnessState): ExtensionUIContext {
  function setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
  function setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: ExtensionWidgetOptions): void {
    if (typeof content === "function") return;
    if (content === undefined) state.widgets.delete(key);
    else state.widgets.set(key, content);
    const emission = options === undefined ? { key, content } : { key, content, options };
    state.rpcWidgets.push(frozen(emission));
  }

  return createUI(state.theme, {
    setStatus: (key: string, value: string | undefined): void => {
      if (value === undefined) state.statuses.delete(key);
      else state.statuses.set(key, value);
      state.rpcStatus.push(frozen({ key, value }));
    },
    setWidget,
  });
}

function createContext(state: HarnessState): ExtensionContext {
  // These services are opaque identity sentinels; the harness only needs stable identities for rebinding tests.
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const modelRegistry = {} as ExtensionContext["modelRegistry"];
  const model: ExtensionContext["model"] = undefined;
  const signal: ExtensionContext["signal"] = undefined;
  const context = {
    get ui(): ExtensionUIContext { return state.ui; },
    get mode(): ConformanceMode { return state.mode; },
    get hasUI(): boolean { return state.ui !== state.noopUI; },
    get cwd(): string { return state.cwd; },
    sessionManager,
    modelRegistry,
    model,
    scopedModels: [],
    isIdle: (): boolean => true,
    isProjectTrusted: (): boolean => true,
    signal,
    abort: (): void => {},
    hasPendingMessages: (): boolean => false,
    shutdown: (): void => {},
    getContextUsage: (): ReturnType<ExtensionContext["getContextUsage"]> => undefined,
    compact: (_options?: Parameters<ExtensionContext["compact"]>[0]): void => {},
    getSystemPrompt: (): string => "",
  } satisfies ExtensionContext;
  return context;
}

function createAPI(state: HarnessState): ExtensionAPI {
  const events = {
    emit(channel: string, data: unknown): void {
      for (const provider of state.providers) {
        if (provider.channel === channel && provider.active) provider.handler(data);
      }
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      const provider: ProviderRecord = { channel, handler, active: true };
      state.providers.push(provider);
      return (): void => { provider.active = false; };
    },
  } satisfies ExtensionAPI["events"];

  const pi = {
    on(event: string, handler: CallableFunction): void {
      const observation: RegisteredHandlerObservation = {
        event,
        handler: (...args: unknown[]): unknown => Reflect.apply(handler, undefined, args),
      };
      state.handlers.push(observation);
      if (event === "session_start" || event === "session_shutdown") {
        const lifecycleEvent: LifecycleEvent = event;
        state.lifecycleHandlers.push({
          event: lifecycleEvent,
          invoke: (eventValue: unknown, context: ExtensionContext): unknown => Reflect.apply(handler, undefined, [eventValue, context]),
        });
      }
    },
    registerTool: (..._args: unknown[]): void => {},
    registerCommand: (..._args: unknown[]): void => {},
    registerShortcut: (..._args: unknown[]): void => {},
    registerFlag: (..._args: unknown[]): void => {},
    getFlag: (..._args: unknown[]): undefined => undefined,
    registerMessageRenderer: (..._args: unknown[]): void => {},
    registerEntryRenderer: (..._args: unknown[]): void => {},
    sendMessage: (..._args: unknown[]): void => {},
    sendUserMessage: (..._args: unknown[]): void => {},
    appendEntry: (..._args: unknown[]): void => {},
    setSessionName: (..._args: unknown[]): void => {},
    getSessionName: (..._args: unknown[]): undefined => undefined,
    setLabel: (..._args: unknown[]): void => {},
    exec: async (..._args: unknown[]): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: (): string[] => [],
    getAllTools: (): ReturnType<ExtensionAPI["getAllTools"]> => [],
    setActiveTools: (..._args: unknown[]): void => {},
    getCommands: (): ReturnType<ExtensionAPI["getCommands"]> => [],
    setModel: async (..._args: unknown[]): Promise<boolean> => false,
    getThinkingLevel: (): ReturnType<ExtensionAPI["getThinkingLevel"]> => "medium",
    setThinkingLevel: (..._args: unknown[]): void => {},
    registerProvider: (..._args: unknown[]): void => {},
    unregisterProvider: (..._args: unknown[]): void => {},
    registerMarkdownTransformer: (..._args: unknown[]): void => {},
    events,
  } satisfies ExtensionAPI;
  return pi;
}

function makeUI(state: HarnessState, mode: ConformanceMode): ExtensionUIContext {
  if (mode === "print") return state.noopUI;
  return mode === "rpc" ? createRpcUI(state) : createComponentUI(state);
}

export function conformanceContext(options: ConformanceOptions = {}): ConformanceHarness {
  const mode = options.mode ?? "print";
  assertMode(mode);
  // TUI is an opaque identity sentinel; the harness never invokes its implementation.
  const tui = {} as TUI;
  // Theme is an opaque identity sentinel; the harness only passes its stable identity to factories.
  const theme = {} as Theme;
  const noopUI = createNoopUI(theme);
  const statuses = new Map<string, string>();
  const widgets = new Map<string, WidgetValue>();
  const rpcStatus: RpcStatusEmission[] = [];
  const rpcWidgets: RpcWidgetEmission[] = [];
  const renderObservations: RenderObservation[] = [];
  const handlers: RegisteredHandlerObservation[] = [];
  const lifecycleHandlers: LifecycleRegistration[] = [];
  const providers: ProviderRecord[] = [];
  const state = {
    mode,
    cwd: options.cwd ?? globalThis.process?.cwd?.() ?? "",
    ui: noopUI,
    statuses,
    widgets,
    rpcStatus,
    rpcWidgets,
    renderObservations,
    handlers,
    lifecycleHandlers,
    providers,
    noopUI,
    tui,
    theme,
  } satisfies HarnessState;
  state.ui = options.uiContext == null ? makeUI(state, state.mode) : options.uiContext;
  const context = createContext(state);
  const pi = createAPI(state);
  const harness = {
    pi,
    context,
    ctx: context,
    get currentContext(): ExtensionContext { return context; },
    noopUI: state.noopUI,
    tui: state.tui,
    theme: state.theme,
    statuses: state.statuses,
    widgets: state.widgets,
    rpcStatus: state.rpcStatus,
    rpcWidgets: state.rpcWidgets,
    renderObservations: state.renderObservations,
    handlers: state.handlers,
    providers: state.providers,
    setUIContext(uiContext: ExtensionUIContext | null | undefined, nextMode?: ConformanceMode): ExtensionContext {
      if (nextMode !== undefined) {
        assertMode(nextMode);
        state.mode = nextMode;
      }
      state.ui = uiContext == null ? state.noopUI : uiContext;
      return context;
    },
    rebind(overrides: ConformanceRebindOptions = {}): ExtensionContext {
      if (overrides.cwd !== undefined) state.cwd = overrides.cwd;
      if (overrides.ui !== undefined) state.ui = overrides.ui;
      if (overrides.mode !== undefined) {
        assertMode(overrides.mode);
        state.mode = overrides.mode;
      }
      if (overrides.sessionManager !== undefined) context.sessionManager = overrides.sessionManager;
      if (overrides.modelRegistry !== undefined) context.modelRegistry = overrides.modelRegistry;
      if (overrides.model !== undefined) context.model = overrides.model;
      if (overrides.signal !== undefined) context.signal = overrides.signal;
      return context;
    },
    async fire(event: LifecycleEvent): Promise<void> {
      if (!lifecycleEvents.has(event)) throw new RangeError(`Unsupported conformance event: ${event}`);
      const eventValue = event === "session_start"
        ? { type: event, reason: "startup" }
        : { type: event, reason: "quit" };
      for (const registration of state.lifecycleHandlers) {
        if (registration.event === event) await registration.invoke(eventValue, context);
      }
    },
    getStatus(key: string): string | undefined { return state.statuses.get(key); },
    getWidget(key: string): WidgetValue | undefined { return state.widgets.get(key); },
    getRegisteredHandlers(event?: string): readonly RegisteredHandlerObservation[] {
      return state.handlers.filter((registration) => event === undefined || registration.event === event);
    },
    getEventBusProviders(channel?: string): readonly EventBusProviderObservation[] {
      return state.providers.filter((provider) => channel === undefined || provider.channel === channel);
    },
    render(widths: number | readonly number[]): readonly RenderObservation[] {
      const selectedWidths = typeof widths === "number" ? [widths] : widths;
      const batch: RenderObservation[] = [];
      if (state.mode !== "tui") return batch;
      for (const [key, widget] of state.widgets) {
        if (typeof widget === "function" || Array.isArray(widget) || typeof widget.render !== "function") continue;
        for (const width of selectedWidths) {
          const output = widget.render(width);
          const observation = frozen({ key, width, output });
          state.renderObservations.push(observation);
          batch.push(observation);
        }
      }
      return batch;
    },
    snapshot(): ConformanceSnapshot {
      return {
        mode: state.mode,
        hasUI: state.ui !== state.noopUI,
        statuses: [...state.statuses],
        widgets: [...state.widgets].map(([key, value]) => [key, typeof value === "function" ? "component-factory" : value]),
        rpcStatus: [...state.rpcStatus],
        rpcWidgets: [...state.rpcWidgets],
        renderObservations: [...state.renderObservations],
        handlers: state.handlers.map(({ event }) => ({ event })),
        providers: state.providers.map(({ channel, active }) => ({ channel, active })),
      };
    },
  } satisfies ConformanceHarness;
  return harness;
}

export function getStatus(harness: ConformanceHarness, key: string): string | undefined {
  return harness.getStatus(key);
}

export function getWidget(harness: ConformanceHarness, key: string): WidgetValue | undefined {
  return harness.getWidget(key);
}

export function getRenderObservations(harness: ConformanceHarness): readonly RenderObservation[] {
  return harness.renderObservations;
}

export function getRegisteredHandlers(harness: ConformanceHarness, event?: string): readonly RegisteredHandlerObservation[] {
  return harness.getRegisteredHandlers(event);
}

export function getEventBusProviders(harness: ConformanceHarness, channel?: string): readonly EventBusProviderObservation[] {
  return harness.getEventBusProviders(channel);
}
