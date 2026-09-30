import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";

export const PI_DEV_VERSION = "0.2.0";

export type DevSubcommand =
  | "help"
  | "tools"
  | "prompt"
  | "context"
  | "usage"
  | "extensions"
  | "ui"
  | "demo"
  | "events"
  | "doctor";

export type TraceMetadataValue = string | number | boolean;
export type TraceMetadata = Readonly<Record<string, TraceMetadataValue>>;

export interface TraceRecord {
  readonly sequence: number;
  readonly at: string;
  readonly event: ExtensionEvent["type"];
  readonly metadata: TraceMetadata;
}

export type TextPresentationDelivery = "viewer" | "session-entry";
export type TextCopyHandler = (text: string) => Promise<void>;
export type TextFileWriter = (file: string, data: string) => Promise<void>;

export interface TextPresentation {
  readonly title: string;
  readonly body: string;
  readonly warning?: boolean;
  /** Copy the raw body when the viewer's copy shortcut is pressed. */
  readonly onCopy?: TextCopyHandler;
  /**
   * `viewer` is temporary interactive UI. `session-entry` renders in the main
   * transcript, persists with the session, and is never sent to the model.
   */
  readonly delivery?: TextPresentationDelivery;
}

export interface SessionTextPresentationData {
  readonly version: 1;
  readonly title: string;
  readonly body: string;
  readonly warning: boolean;
}

export type TextPresenter = (
  ctx: ExtensionCommandContext,
  presentation: TextPresentation,
) => Promise<void>;

export interface ObservableSource {
  readonly path: string;
  readonly source: string;
  readonly scope: SourceInfo["scope"];
  readonly origin: SourceInfo["origin"];
  readonly baseDir?: string;
  readonly version?: string;
  readonly tools: readonly string[];
  readonly commands: readonly string[];
}

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorDependencies {
  readonly pathExists: (file: string) => boolean;
  readonly piVersion: string;
}

export type ContextUsageOpener = (
  ctx: ExtensionContext,
  options?: BuildSystemPromptOptions,
) => Promise<void>;

export interface DevCommandDependencies {
  readonly present: TextPresenter;
  readonly openContextUsage: ContextUsageOpener;
  readonly doctor: DoctorDependencies;
  readonly copyToClipboard: TextCopyHandler;
  readonly writeFile: TextFileWriter;
  readonly readPackageJson?: (directory: string) => string;
}

export interface DevExtensionDependencies {
  readonly present?: TextPresenter;
  readonly openContextUsage?: ContextUsageOpener;
  readonly doctor?: Partial<DoctorDependencies>;
  readonly copyToClipboard?: TextCopyHandler;
  readonly writeFile?: TextFileWriter;
  readonly now?: () => Date;
  readonly eventCapacity?: number;
  readonly readPackageJson?: (directory: string) => string;
}
