import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

import {
  isDaemonCustomEntry,
  type Attention,
  type Phase,
  type PromptOutcomeErrorCode,
  type PromptOutcomeName,
} from "../protocol/index.js";
import type { PromptIndexRecord, SessionRecord } from "./registry.js";

interface JsonObject {
  readonly [key: string]: unknown;
}

interface SessionHeader extends JsonObject {
  readonly type: "session";
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
}

interface SessionEntry extends JsonObject {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

export type SessionBranchContinuityStatus =
  | "unchanged"
  | "epoch_proved"
  | "unproved";

export interface SessionBranchContinuity {
  readonly status: SessionBranchContinuityStatus;
  readonly lastActiveLeafId: string | null;
  readonly currentLeafId: string | null;
  readonly epoch: number;
  readonly proofEntryId: string | null;
}

export interface SessionFileProjection {
  readonly session: SessionRecord;
  readonly prompts: readonly PromptIndexRecord[];
  readonly continuity: SessionBranchContinuity;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(line: string, lineNumber: number, sessionFile: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`invalid JSON at ${sessionFile}:${lineNumber}`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`session line is not an object at ${sessionFile}:${lineNumber}`);
  }
  return value;
}

function parseTimestamp(value: string, field: string, sessionFile: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid ${field} timestamp in ${sessionFile}`);
  }
  return timestamp;
}

function parseHeader(value: JsonObject, sessionFile: string): SessionHeader {
  if (
    value.type !== "session" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.timestamp !== "string" ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0
  ) {
    throw new Error(`invalid pi session header in ${sessionFile}`);
  }
  return value as SessionHeader;
}

function parseEntry(value: JsonObject, sessionFile: string): SessionEntry {
  if (
    typeof value.type !== "string" ||
    value.type === "session" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.timestamp !== "string"
  ) {
    throw new Error(`invalid pi session entry in ${sessionFile}`);
  }
  return value as SessionEntry;
}

function activeBranch(
  entries: readonly SessionEntry[],
  sessionFile: string,
  leafId: string | null = entries.at(-1)?.id ?? null,
): SessionEntry[] {
  const entriesById = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entriesById.has(entry.id)) {
      throw new Error(`duplicate pi session entry ID ${entry.id} in ${sessionFile}`);
    }
    entriesById.set(entry.id, entry);
  }

  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let entry = leafId === null ? undefined : entriesById.get(leafId);
  if (leafId !== null && entry === undefined) {
    throw new Error(`unknown pi session leaf ${leafId} in ${sessionFile}`);
  }
  while (entry !== undefined) {
    if (visited.has(entry.id)) {
      throw new Error(`cycle in pi session tree at ${entry.id} in ${sessionFile}`);
    }
    visited.add(entry.id);
    branch.push(entry);
    if (entry.parentId === null) {
      break;
    }
    const parent = entriesById.get(entry.parentId);
    if (parent === undefined) {
      throw new Error(
        `missing parent ${entry.parentId} for pi session entry ${entry.id} in ${sessionFile}`,
      );
    }
    entry = parent;
  }
  return branch.reverse();
}

function keyHash(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function entryAncestors(
  entryId: string | null,
  entriesById: ReadonlyMap<string, SessionEntry>,
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let currentId = entryId;
  while (currentId !== null) {
    if (visited.has(currentId)) return [];
    visited.add(currentId);
    const entry = entriesById.get(currentId);
    if (entry === undefined) return [];
    ancestors.push(entry.id);
    currentId = entry.parentId;
  }
  return ancestors;
}

function newestCommonAncestor(
  leftId: string | null,
  rightId: string | null,
  entriesById: ReadonlyMap<string, SessionEntry>,
): string | null {
  if (leftId === null || rightId === null) return null;
  const rightAncestors = new Set(entryAncestors(rightId, entriesById));
  return entryAncestors(leftId, entriesById).find((id) => rightAncestors.has(id)) ?? null;
}

function daemonEntry(entry: SessionEntry, sessionFile: string) {
  if (entry.type !== "custom" || typeof entry.customType !== "string") {
    return undefined;
  }
  const candidate = {
    type: "custom",
    customType: entry.customType,
    data: entry.data,
  };
  if (!isDaemonCustomEntry(candidate)) {
    if (entry.customType.startsWith("pi-daemon/")) {
      throw new Error(`invalid pi-daemon entry ${entry.id} in ${sessionFile}`);
    }
    return undefined;
  }
  return candidate;
}

function epochAtLeaf(
  leafId: string | null,
  entriesById: ReadonlyMap<string, SessionEntry>,
  sessionFile: string,
): number {
  let epoch = 0;
  for (const entryId of entryAncestors(leafId, entriesById).reverse()) {
    const entry = entriesById.get(entryId);
    if (entry === undefined) continue;
    const custom = daemonEntry(entry, sessionFile);
    if (custom?.customType === "pi-daemon/epoch") epoch = custom.data.toEpoch;
  }
  return epoch;
}

function deriveBranchContinuity(
  entries: readonly SessionEntry[],
  branch: readonly SessionEntry[],
  sessionFile: string,
): SessionBranchContinuity {
  const currentLeafId = branch.at(-1)?.id ?? null;
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const currentEpoch = epochAtLeaf(currentLeafId, entriesById, sessionFile);
  let firstDaemonIndex = -1;
  let anchorIndex = -1;
  let latestDaemonId: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const custom = daemonEntry(entry, sessionFile);
    if (custom === undefined) continue;
    latestDaemonId = entry.id;
    if (firstDaemonIndex === -1) firstDaemonIndex = index;
    if (
      anchorIndex === -1 &&
      (custom.customType === "pi-daemon/lifecycle" ||
        custom.customType === "pi-daemon/restored")
    ) {
      anchorIndex = index;
    }
  }
  if (anchorIndex === -1) anchorIndex = firstDaemonIndex;
  if (anchorIndex === -1) {
    return {
      status: "unchanged",
      lastActiveLeafId: currentLeafId,
      currentLeafId,
      epoch: currentEpoch,
      proofEntryId: null,
    };
  }

  let latestProof:
    | { readonly entryId: string; readonly previousLeaf: string }
    | undefined;
  for (let index = anchorIndex + 1; index < entries.length; index += 1) {
    const movedEntry = entries[index];
    const previousPhysicalLeaf = entries[index - 1];
    if (movedEntry === undefined || previousPhysicalLeaf === undefined) continue;
    const movedCustom = daemonEntry(movedEntry, sessionFile);
    if (movedEntry.parentId === previousPhysicalLeaf.id) {
      if (movedCustom?.customType !== "pi-daemon/epoch") continue;
      return {
        status: "unproved",
        lastActiveLeafId: previousPhysicalLeaf.id,
        currentLeafId,
        epoch: epochAtLeaf(previousPhysicalLeaf.id, entriesById, sessionFile),
        proofEntryId: null,
      };
    }
    if (movedCustom?.customType === "pi-daemon/epoch") {
      const data = movedCustom.data;
      const proved =
        data.previousLeaf === previousPhysicalLeaf.id &&
        data.currentLeaf === movedEntry.parentId &&
        data.forkPoint ===
          newestCommonAncestor(data.previousLeaf, data.currentLeaf, entriesById) &&
        data.fromEpoch === epochAtLeaf(data.previousLeaf, entriesById, sessionFile) &&
        data.fromEpoch < Number.MAX_SAFE_INTEGER &&
        data.toEpoch === data.fromEpoch + 1 &&
        epochAtLeaf(movedEntry.id, entriesById, sessionFile) === data.toEpoch;
      if (proved) {
        latestProof = {
          entryId: movedEntry.id,
          previousLeaf: previousPhysicalLeaf.id,
        };
        continue;
      }
    }
    return {
      status: "unproved",
      lastActiveLeafId: previousPhysicalLeaf.id,
      currentLeafId,
      epoch: epochAtLeaf(previousPhysicalLeaf.id, entriesById, sessionFile),
      proofEntryId: null,
    };
  }

  return latestProof === undefined
    ? {
        status: "unchanged",
        lastActiveLeafId: latestDaemonId ?? currentLeafId,
        currentLeafId,
        epoch: currentEpoch,
        proofEntryId: null,
      }
    : {
        status: "epoch_proved",
        lastActiveLeafId: latestProof.previousLeaf,
        currentLeafId,
        epoch: currentEpoch,
        proofEntryId: latestProof.entryId,
      };
}

function projectSessionFileBranch(
  path: string,
  nowMs: number,
  projectedLeafId?: string | null,
): SessionFileProjection {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("rebuild nowMs must be a non-negative safe integer");
  }
  const sessionFile = realpathSync(path);
  const lines = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`pi session file is empty: ${sessionFile}`);
  }

  const parsed = lines.map((line, index) =>
    parseJsonLine(line, index + 1, sessionFile),
  );
  const first = parsed[0];
  if (first === undefined) {
    throw new Error(`pi session file is empty: ${sessionFile}`);
  }
  const header = parseHeader(first, sessionFile);
  const entries = parsed
    .slice(1)
    .map((entry) => parseEntry(entry, sessionFile));
  const currentBranch = activeBranch(entries, sessionFile);
  const continuity = deriveBranchContinuity(entries, currentBranch, sessionFile);
  const branch =
    projectedLeafId === undefined
      ? currentBranch
      : activeBranch(entries, sessionFile, projectedLeafId);

  let name: string | null = null;
  let lastPhase: Phase = "idle";
  let attention: Attention = "none";
  let epoch = 0;
  let sleepAfterMs: number | null = null;
  let failureCode: string | null = null;
  let agentDir = "";
  let additionalExtensionPaths: string[] = [];
  let environment: import("../protocol/index.js").JsonValue | undefined;
  const promptsById = new Map<string, PromptIndexRecord>();
  const promptIdsByKeyHash = new Map<string, string>();

  for (const entry of branch) {
    if (entry.type === "session_info") {
      if (entry.name === undefined) {
        name = null;
      } else if (typeof entry.name === "string") {
        name = entry.name;
      } else {
        throw new Error(`invalid session name entry ${entry.id} in ${sessionFile}`);
      }
      continue;
    }

    const custom = daemonEntry(entry, sessionFile);
    if (custom === undefined) {
      continue;
    }

    switch (custom.customType) {
      case "pi-daemon/environment": {
        agentDir = custom.data.agentDir;
        additionalExtensionPaths = [...custom.data.additionalExtensionPaths];
        environment = custom.data.environment;
        break;
      }
      case "pi-daemon/restored": {
        attention = "interrupted";
        break;
      }
      case "pi-daemon/lifecycle": {
        if (custom.data.sleepAfterMs !== undefined) {
          sleepAfterMs = custom.data.sleepAfterMs;
        }
        if (custom.data.action === "failed" || custom.data.action === "gone") {
          lastPhase = custom.data.action;
          attention = "failed";
          failureCode = custom.data.reason;
        }
        break;
      }
      case "pi-daemon/phase": {
        lastPhase = custom.data.to;
        attention = custom.data.attention;
        failureCode =
          lastPhase === "failed" || lastPhase === "gone"
            ? custom.data.reason
            : null;
        break;
      }
      case "pi-daemon/epoch": {
        epoch = custom.data.toEpoch;
        break;
      }
      case "pi-daemon/prompt-claim": {
        if (attention === "interrupted") {
          attention = "none";
        }
        const hash = keyHash(custom.data.idempotencyKey);
        if (
          promptsById.has(custom.data.promptId) ||
          promptIdsByKeyHash.has(hash)
        ) {
          throw new Error(`duplicate prompt claim ${custom.data.promptId} in ${sessionFile}`);
        }
        const prompt: PromptIndexRecord = {
          sessionId: header.id,
          keyHash: hash,
          payloadHash: custom.data.payloadSha256,
          promptId: custom.data.promptId,
          claimEntryId: entry.id,
          outcomeEntryId: null,
          state: "pending",
          finalEntryId: null,
          errorCode: null,
          acceptedAtMs: parseTimestamp(
            custom.data.acceptedAt,
            "prompt acceptedAt",
            sessionFile,
          ),
          settledAtMs: null,
        };
        promptsById.set(prompt.promptId, prompt);
        promptIdsByKeyHash.set(hash, prompt.promptId);
        break;
      }
      case "pi-daemon/prompt-outcome": {
        const prompt = promptsById.get(custom.data.promptId);
        if (prompt === undefined || prompt.outcomeEntryId !== null) {
          throw new Error(
            `prompt outcome has no unique active claim ${custom.data.promptId} in ${sessionFile}`,
          );
        }
        const state: PromptOutcomeName = custom.data.outcome;
        const errorCode: PromptOutcomeErrorCode | null =
          custom.data.outcome === "settled" ? null : custom.data.errorCode;
        promptsById.set(custom.data.promptId, {
          ...prompt,
          outcomeEntryId: entry.id,
          state,
          finalEntryId: custom.data.finalEntryId ?? null,
          errorCode,
          settledAtMs: parseTimestamp(
            custom.data.settledAt,
            "prompt settledAt",
            sessionFile,
          ),
        });
        break;
      }
      default:
        break;
    }
  }

  const leaf = branch.at(-1);
  const createdAtMs = parseTimestamp(header.timestamp, "session", sessionFile);
  const updatedAtMs =
    leaf === undefined
      ? createdAtMs
      : parseTimestamp(leaf.timestamp, "session entry", sessionFile);

  return {
    session: {
      sessionId: header.id,
      sessionFile,
      fileMaterialized: true,
      cwd: header.cwd,
      name,
      agentDir,
      additionalExtensionPaths,
      ...(environment === undefined ? {} : { environment }),
      runtimeState: "asleep",
      lastPhase,
      attention,
      generation: 0,
      epoch,
      activeLeafId: leaf?.id ?? null,
      cleanShutdown: false,
      sleepAfterMs,
      sleepDeadlineMs: null,
      activityToken: 0,
      lastActivityMs: nowMs,
      failureCode,
      failureMessage: null,
      createdAtMs,
      updatedAtMs,
    },
    prompts: [...promptsById.values()],
    continuity,
  };
}

export function projectSessionFile(
  path: string,
  nowMs: number,
): SessionFileProjection {
  return projectSessionFileBranch(path, nowMs);
}

export function projectSessionFileAtLeaf(
  path: string,
  leafId: string | null,
  nowMs: number,
): SessionFileProjection {
  return projectSessionFileBranch(path, nowMs, leafId);
}
