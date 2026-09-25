// VENDORED build-time type fallback for the OPTIONAL @caair/pi-daemon peer (#35 / #470).
// Copied verbatim from @caair/pi-daemon dist .d.ts. Used ONLY when the package is
// absent (tsconfig `paths` resolves the real node_modules types first, these second),
// so pi-delegate builds/type-checks without the package. Regenerate by re-copying
// @caair/pi-daemon/dist/{client,protocol}/*.d.ts when the daemon protocol changes.
// Do not hand-edit.
import { type ChildProcess } from "node:child_process";
import { type Socket } from "node:net";
import { type Cursor, type ErrorCode, type Operation, type OperationParams, type OperationResult, type StreamFrame } from "../protocol/index.js";
export declare const PACKAGE = "@caair/pi-daemon/client";
type ClientOperation = Exclude<Operation, "hello">;
export interface DaemonClientIdentity {
    readonly name: string;
    readonly version: string;
    readonly capabilities?: readonly string[];
}
export interface DaemonDisconnectInfo {
    readonly error: Error;
}
export interface DaemonClientHooks {
    readonly onDisconnect?: (info: DaemonDisconnectInfo) => void | Promise<void>;
    readonly onReconnect?: (client: DaemonClient) => void | Promise<void>;
}
export interface ConnectDaemonOptions {
    readonly socketPath?: string;
    readonly client: DaemonClientIdentity;
    readonly protocolVersion?: string;
    readonly autoSpawn?: boolean;
    readonly startupTimeoutMs?: number;
    readonly retryIntervalMs?: number;
    readonly stateDir?: string;
    readonly agentDir?: string;
    readonly daemonEntrypoint?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly hooks?: DaemonClientHooks;
}
export interface SpawnDaemonProcessOptions {
    readonly stateDir?: string;
    readonly socketPath?: string;
    readonly agentDir?: string;
    readonly daemonEntrypoint?: string;
    readonly detached?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
}
export declare class DaemonSpawnError extends Error {
    readonly exitCode?: number;
    readonly signal?: NodeJS.Signals;
    readonly cause?: unknown;
    constructor(message: string, options?: {
        readonly exitCode?: number;
        readonly signal?: NodeJS.Signals;
        readonly cause?: unknown;
    });
}
export declare class DaemonRequestError extends Error {
    readonly code: ErrorCode;
    readonly details: unknown;
    constructor(code: ErrorCode, message: string, details?: unknown);
}
declare class AsyncQueue<T> implements AsyncIterable<T> {
    #private;
    push(value: T): void;
    end(error?: Error): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
export interface DaemonCursorStore {
    load(sessionId: string): Cursor | null | undefined | Promise<Cursor | null | undefined>;
    save(sessionId: string, cursor: Cursor): void | Promise<void>;
}
export interface DaemonAttachmentOptions {
    readonly cursorStore?: DaemonCursorStore;
    readonly onCursor?: (cursor: Cursor, frame: Extract<StreamFrame, {
        kind: "entry";
    }>) => void | Promise<void>;
}
export type AcquireLeaseOptions = Omit<Extract<OperationParams<"lease">, {
    action: "acquire";
}>, "action" | "attachmentId" | "generation">;
export type TakeoverLeaseOptions = Omit<Extract<OperationParams<"lease">, {
    action: "takeover";
}>, "action" | "attachmentId" | "generation">;
export type AttachmentWakeOptions = Omit<OperationParams<"wake">, "attachmentId" | "generation">;
export type AttachmentSleepOptions = Omit<OperationParams<"sleep">, "attachmentId" | "generation" | "leaseId">;
export type LeasePromptOptions = Omit<OperationParams<"prompt">, "attachmentId" | "leaseId" | "generation">;
export type LeaseAbortOptions = Omit<OperationParams<"abort">, "attachmentId" | "leaseId" | "generation">;
export type LeaseUiAnswerOptions = Omit<OperationParams<"ui_answer">, "attachmentId" | "leaseId" | "generation">;
export declare class DaemonAttachment implements AsyncIterable<StreamFrame> {
    #private;
    readonly client: DaemonClient;
    readonly sessionId: string;
    readonly result: OperationResult<"attach">;
    readonly attachmentId: string;
    constructor(client: DaemonClient, sessionId: string, result: OperationResult<"attach">, queue: AsyncQueue<StreamFrame>, options: DaemonAttachmentOptions);
    get cursor(): Cursor | undefined;
    [Symbol.asyncIterator](): AsyncIterator<StreamFrame>;
    acknowledge(frame: Extract<StreamFrame, {
        kind: "entry";
    }>): Promise<void>;
    wake(generation: number, options?: AttachmentWakeOptions): Promise<OperationResult<"wake">>;
    sleep(generation: number, options?: AttachmentSleepOptions): Promise<OperationResult<"sleep">>;
    recover(generation: number, options?: {
        readonly leaseId?: string;
    }): Promise<OperationResult<"recover">>;
    promptStatus(params: OperationParams<"prompt_status">): Promise<OperationResult<"prompt_status">>;
    steer(generation: number, params: Omit<OperationParams<"steer">, "attachmentId" | "generation">): Promise<OperationResult<"steer">>;
    followUp(generation: number, params: Omit<OperationParams<"follow_up">, "attachmentId" | "generation">): Promise<OperationResult<"follow_up">>;
    acquireLease(generation: number, options?: AcquireLeaseOptions): Promise<DaemonLease>;
    takeoverLease(generation: number, options: TakeoverLeaseOptions): Promise<DaemonLease>;
    replay(params: Omit<OperationParams<"replay">, "attachmentId">): Promise<OperationResult<"replay">>;
    detach(): Promise<OperationResult<"detach">>;
}
export type LeaseGrant = Extract<OperationResult<"lease">, {
    holder: unknown;
}>;
export type LeaseHeartbeatResult = Exclude<OperationResult<"lease">, LeaseGrant | {
    released: true;
}>;
export type LeaseReleaseResult = Extract<OperationResult<"lease">, {
    released: true;
}>;
export declare class DaemonLease {
    #private;
    readonly attachment: DaemonAttachment;
    readonly grant: LeaseGrant;
    readonly leaseId: string;
    readonly generation: number;
    constructor(attachment: DaemonAttachment, grant: LeaseGrant);
    get expiresAt(): string;
    get released(): boolean;
    heartbeat(): Promise<LeaseHeartbeatResult>;
    release(): Promise<LeaseReleaseResult>;
    prompt(params: LeasePromptOptions): Promise<OperationResult<"prompt">>;
    abort(params?: LeaseAbortOptions): Promise<OperationResult<"abort">>;
    answerUi(params: LeaseUiAnswerOptions): Promise<OperationResult<"ui_answer">>;
    sleep(options?: AttachmentSleepOptions): Promise<OperationResult<"sleep">>;
    recover(): Promise<OperationResult<"recover">>;
}
interface DaemonClientConnectionOptions {
    readonly hooks?: DaemonClientHooks;
    readonly reconnect?: () => Promise<DaemonClient>;
}
export declare class DaemonClient {
    #private;
    readonly hello: OperationResult<"hello">;
    constructor(socket: Socket, hello: OperationResult<"hello">, connectionOptions?: DaemonClientConnectionOptions);
    get closed(): boolean;
    request<O extends ClientOperation>(operation: O, params: OperationParams<O>, session?: string): Promise<OperationResult<O>>;
    requestWithId<O extends ClientOperation>(id: string, operation: O, params: OperationParams<O>, session?: string): Promise<OperationResult<O>>;
    attach(sessionId: string, params?: OperationParams<"attach">, options?: DaemonAttachmentOptions): Promise<DaemonAttachment>;
    promptStatus(sessionId: string, params: OperationParams<"prompt_status">): Promise<OperationResult<"prompt_status">>;
    recover(sessionId: string, params: OperationParams<"recover">): Promise<OperationResult<"recover">>;
    close(): void;
    reconnect(): Promise<DaemonClient>;
    private receive;
    private routeStreamFrame;
    private queueForAttachment;
    private endAttachment;
    private fail;
}
export declare function spawnDaemonProcess(options?: SpawnDaemonProcessOptions): ChildProcess;
export declare function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonClient>;
export {};
//# sourceMappingURL=index.d.ts.map