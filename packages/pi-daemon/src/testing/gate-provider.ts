import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";

import type { GateModelRuntimeFactoryResult } from "../daemon/bootstrap.js";

export const GATE_PROVIDER_SCRIPT_ENV = "PI_DAEMON_GATE_PROVIDER_SCRIPT";
export const DEFAULT_GATE_PROVIDER_REPLY = "pi-daemon deterministic gate reply";
export const GATE_PROVIDER_ID = "pi-daemon-gate";
export const GATE_MODEL_ID = "pi-daemon-gate-1";

export interface GateProviderTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface GateProviderTurn {
  /** Ordered assistant text emitted for one provider call. */
  readonly content: readonly GateProviderTextContent[];
}

/**
 * JSON shape read from PI_DAEMON_GATE_PROVIDER_SCRIPT:
 * `{ "turns": [{ "content": [{ "type": "text", "text": "reply" }] }] }`.
 * Calls consume turns in array order; exhaustion fails instead of reaching a
 * network provider.
 */
export interface GateProviderScript {
  readonly turns: readonly GateProviderTurn[];
}

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type ProviderStream = ReturnType<NonNullable<ProviderConfig["streamSimple"]>>;
type ProviderStreamEvent = Parameters<ProviderStream["push"]>[0];
type AssistantOutput = Extract<ProviderStreamEvent, { type: "start" }>["partial"];
type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type ModelsStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;

interface PiAiGateModule {
  readonly createAssistantMessageEventStream: () => ProviderStream;
  readonly InMemoryCredentialStore: new () => CredentialStore;
  readonly InMemoryModelsStore: new () => ModelsStore;
}

const sdkRoot = dirname(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
);
const piAiModulePath = join(
  sdkRoot,
  "node_modules/@earendil-works/pi-ai/dist/index.js",
);
const {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} = (await import(piAiModulePath)) as unknown as PiAiGateModule;

/**
 * Gate-only module factory for PI_DAEMON_MODEL_RUNTIME_MODULE.
 * It reads only PI_DAEMON_GATE_PROVIDER_SCRIPT from the supplied environment,
 * creates in-memory stores with network refresh disabled, and registers a
 * stream implementation that never performs I/O.
 */
export async function createGateModelRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<GateModelRuntimeFactoryResult> {
  const scriptPath = environment[GATE_PROVIDER_SCRIPT_ENV];
  const script =
    scriptPath === undefined
      ? defaultScript()
      : await readGateProviderScript(scriptPath);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let nextTurnIndex = 0;

  modelRuntime.registerProvider(GATE_PROVIDER_ID, {
    name: "pi-daemon deterministic gate provider",
    baseUrl: "http://127.0.0.1:1/offline-gate-provider",
    apiKey: "offline-pi-daemon-gate-key",
    api: "openai-completions",
    models: [
      {
        id: GATE_MODEL_ID,
        name: "pi-daemon deterministic gate model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4_096,
      },
    ],
    streamSimple: (model) => {
      const turnIndex = nextTurnIndex;
      nextTurnIndex += 1;
      const turn = script.turns[turnIndex];
      if (turn === undefined) {
        throw new Error(
          `deterministic gate provider script exhausted before provider call ${turnIndex + 1}`,
        );
      }

      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => emitTurn(stream, model, turn, turnIndex));
      return stream;
    },
  });

  if (modelRuntime.getModel(GATE_PROVIDER_ID, GATE_MODEL_ID) === undefined) {
    throw new Error("deterministic gate provider model did not register");
  }
  return { modelRuntime };
}

function defaultScript(): GateProviderScript {
  return {
    turns: [{ content: [{ type: "text", text: DEFAULT_GATE_PROVIDER_REPLY }] }],
  };
}

async function readGateProviderScript(path: string): Promise<GateProviderScript> {
  if (!isAbsolute(path)) {
    throw new Error(`${GATE_PROVIDER_SCRIPT_ENV} must be an absolute JSON file path`);
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${GATE_PROVIDER_SCRIPT_ENV} file at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `malformed ${GATE_PROVIDER_SCRIPT_ENV} JSON at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    return parseScript(parsed);
  } catch (error) {
    throw new Error(
      `invalid ${GATE_PROVIDER_SCRIPT_ENV} script at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function parseScript(value: unknown): GateProviderScript {
  if (!isRecord(value) || !Array.isArray(value.turns) || value.turns.length === 0) {
    throw new TypeError("expected an object with a non-empty turns array");
  }
  return { turns: value.turns.map((turn, index) => parseTurn(turn, index)) };
}

function parseTurn(value: unknown, turnIndex: number): GateProviderTurn {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length === 0) {
    throw new TypeError(`turns[${turnIndex}] must have a non-empty content array`);
  }
  return {
    content: value.content.map((block, contentIndex) =>
      parseContent(block, turnIndex, contentIndex),
    ),
  };
}

function parseContent(
  value: unknown,
  turnIndex: number,
  contentIndex: number,
): GateProviderTextContent {
  const label = `turns[${turnIndex}].content[${contentIndex}]`;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  if (value.type !== "text") throw new TypeError(`${label}.type must be text`);
  if (typeof value.text !== "string") {
    throw new TypeError(`${label}.text must be a string`);
  }
  return { type: "text", text: value.text };
}

function emitTurn(
  stream: ProviderStream,
  model: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0],
  turn: GateProviderTurn,
  turnIndex: number,
): void {
  const output: AssistantOutput = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 1_700_000_000_000 + turnIndex,
  };
  stream.push({ type: "start", partial: output });

  for (const block of turn.content) {
    const contentIndex = output.content.length;
    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex, partial: output });
    const partialBlock = output.content[contentIndex];
    if (partialBlock?.type !== "text") {
      throw new Error("deterministic gate provider text block was not created");
    }
    partialBlock.text = block.text;
    stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
    stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
  }

  output.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
