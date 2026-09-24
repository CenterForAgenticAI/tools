import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  matchesKey,
  fuzzyMatch,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
  Text,
} from "@earendil-works/pi-tui";
import type {
  LogicalModelCandidate,
  LogicalModelSelector,
} from "./logical-model-switcher.js";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";

function sameModel(left: Model<Api> | undefined, right: Model<Api>): boolean {
  return left?.provider === right.provider && left.id === right.id;
}

/**
 * Public-TUI searchable component for the logical model command. It receives a
 * pre-filtered candidate set and never resolves models or reads the registry.
 */
export class LogicalModelSelectorComponent
  extends Container
  implements Focusable
{
  private readonly tui: TUI;
  private readonly candidates: readonly LogicalModelCandidate[];
  private readonly searchInput: Input;
  private readonly list: Container;
  private readonly keybindings: KeybindingsManager;
  private visibleCandidates: readonly LogicalModelCandidate[];
  private selectedIndex: number;
  private closed = false;
  private focusedState = false;
  private readonly onSelect: (candidate: LogicalModelCandidate) => void;
  private readonly onCancel: () => void;

  constructor(
    tui: TUI,
    candidates: readonly LogicalModelCandidate[],
    currentModel: Model<Api> | undefined,
    onSelect: (candidate: LogicalModelCandidate) => void,
    onCancel: () => void,
    keybindings: KeybindingsManager = getKeybindings(),
  ) {
    super();
    this.tui = tui;
    this.candidates = candidates;
    this.visibleCandidates = candidates;
    this.keybindings = keybindings;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    const currentIndex = candidates.findIndex(({ model }) =>
      sameModel(currentModel, model),
    );
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;

    this.addChild(new Text("Select a unified model", 0, 0));
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.list = new Container();
    this.addChild(this.list);
    this.updateList();
    this.tui.requestRender();
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.searchInput.focused = value;
  }

  getVisibleCandidates(): readonly LogicalModelCandidate[] {
    return this.visibleCandidates;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getSearchInput(): Input {
    return this.searchInput;
  }

  override invalidate(): void {
    super.invalidate();
    this.searchInput.invalidate();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keyMatches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (this.keyMatches(data, "tui.select.down")) {
      this.move(1);
      return;
    }
    if (this.keyMatches(data, "tui.select.confirm")) {
      this.confirm();
      return;
    }
    if (this.keyMatches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }

    this.searchInput.handleInput(data);
    this.filter(this.searchInput.getValue());
    this.tui.requestRender();
  }

  private keyMatches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean {
    return this.keybindings.matches(data, keybinding) &&
      this.keybindings.getKeys(keybinding).some((key) => matchesKey(data, key));
  }

  private move(delta: number): void {
    if (this.visibleCandidates.length === 0) return;
    const length = this.visibleCandidates.length;
    this.selectedIndex = (this.selectedIndex + delta + length) % length;
    this.updateList();
    this.tui.requestRender();
  }

  private filter(query: string): void {
    if (query.length === 0) {
      this.visibleCandidates = this.candidates;
      this.selectedIndex = Math.min(
        this.selectedIndex,
        Math.max(0, this.visibleCandidates.length - 1),
      );
    } else {
      this.visibleCandidates = this.candidates.filter((candidate) =>
        fuzzyMatch(
          query,
          `unified pi-multi-account ${LOGICAL_PROVIDER_ID}/${candidate.id} ${candidate.id} ${candidate.name}`,
        ).matches,
      );
      this.selectedIndex = 0;
    }
    this.updateList();
  }

  private updateList(): void {
    this.list.clear();
    if (this.visibleCandidates.length === 0) {
      this.list.addChild(new Text("No matching unified models", 0, 0));
      return;
    }
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.visibleCandidates.length - maxVisible,
      ),
    );
    const endIndex = Math.min(
      startIndex + maxVisible,
      this.visibleCandidates.length,
    );

    for (let index = startIndex; index < endIndex; index += 1) {
      const candidate = this.visibleCandidates[index];
      if (candidate === undefined) continue;
      const marker = index === this.selectedIndex ? "→ " : "  ";
      this.list.addChild(
        new Text(`${marker}${candidate.id} [unified]`, 0, 0),
      );
    }

    if (startIndex > 0 || endIndex < this.visibleCandidates.length) {
      this.list.addChild(
        new Text(
          `  (${this.selectedIndex + 1}/${this.visibleCandidates.length})`,
          0,
          0,
        ),
      );
    }
  }

  private confirm(): void {
    const candidate = this.visibleCandidates[this.selectedIndex];
    if (candidate === undefined) return;
    this.closed = true;
    this.onSelect(candidate);
  }

  public cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.onCancel();
  }
}

/** Adapter that exposes the component through the public extension UI seam. */
export class LogicalModelSelectorAdapter implements LogicalModelSelector {
  async select(input: {
    candidates: readonly LogicalModelCandidate[];
    currentModel: Model<Api> | undefined;
    ui: ExtensionUIContext;
    signal?: AbortSignal;
  }): Promise<LogicalModelCandidate | undefined> {
    let removeAbortListener = (): void => {};
    const finish = (done: (candidate: LogicalModelCandidate | undefined) => void) =>
      (candidate: LogicalModelCandidate | undefined): void => {
        removeAbortListener();
        done(candidate);
      };
    return input.ui.custom<LogicalModelCandidate | undefined>(
      (tui, _theme, keybindings, done): Component => {
        const complete = finish(done);
        const component = new LogicalModelSelectorComponent(
          tui,
          input.candidates,
          input.currentModel,
          complete,
          () => complete(undefined),
          keybindings,
        );
        if (input.signal !== undefined) {
          const onAbort = (): void => component.cancel();
          input.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => {
            input.signal?.removeEventListener("abort", onAbort);
            removeAbortListener = () => {};
          };
          if (input.signal.aborted) onAbort();
        }
        return component;
      },
    );
  }
}

export function createLogicalModelSelector(): LogicalModelSelector {
  return new LogicalModelSelectorAdapter();
}
