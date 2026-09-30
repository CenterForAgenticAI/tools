import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container } from "@earendil-works/pi-tui";

type DisposableComponent = Component & { dispose?(): void };

class BackgroundOverlay implements Component {
  private readonly frame: Container;
  private readonly content: DisposableComponent;

  constructor(content: DisposableComponent, theme: Theme) {
    this.content = content;
    const paintBackground = (line: string): string => theme.bg("customMessageBg", line);
    const paintBorder = (line: string): string => paintBackground(theme.fg("border", line));
    const box = new Box(1, 1, paintBackground);
    box.addChild(content);
    this.frame = new Container();
    this.frame.addChild(new DynamicBorder(paintBorder));
    this.frame.addChild(box);
    this.frame.addChild(new DynamicBorder(paintBorder));
  }

  get wantsKeyRelease(): boolean {
    return this.content.wantsKeyRelease === true;
  }

  handleInput(data: string): void {
    this.content.handleInput?.(data);
  }

  render(width: number): string[] {
    return this.frame.render(width);
  }

  invalidate(): void {
    this.frame.invalidate();
  }

  dispose(): void {
    this.content.dispose?.();
  }
}

export function withOverlayBackground(content: DisposableComponent, theme: Theme): DisposableComponent {
  return new BackgroundOverlay(content, theme);
}
