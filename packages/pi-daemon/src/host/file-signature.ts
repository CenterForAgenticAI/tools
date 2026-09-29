import { statSync } from "node:fs";
import { dirname } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface SessionFileSignature {
  readonly size: number;
  readonly leafId: string | null;
}

export interface SessionFileState {
  readonly signature: SessionFileSignature;
  readonly branchEntryIds: readonly string[];
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function readSessionFileState(sessionFile: string): SessionFileState {
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(sessionFile);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { signature: { size: 0, leafId: null }, branchEntryIds: [] };
    }
    throw error;
  }

  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  const after = statSync(sessionFile);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`session file changed while its signature was read: ${sessionFile}`);
  }

  return {
    signature: { size: after.size, leafId: manager.getLeafId() },
    branchEntryIds: manager.getBranch().map(({ id }) => id),
  };
}

export function sessionFileStateEquals(
  left: SessionFileState,
  right: SessionFileState,
): boolean {
  return (
    left.signature.size === right.signature.size &&
    left.signature.leafId === right.signature.leafId &&
    left.branchEntryIds.length === right.branchEntryIds.length &&
    left.branchEntryIds.every((entryId, index) => entryId === right.branchEntryIds[index])
  );
}
