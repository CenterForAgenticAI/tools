import type { Cursor } from "../protocol/index.js";
import {
  StreamRequestError,
  type ReplayCursorPlan,
  type ReplayCursorSnapshot,
} from "./types.js";

export function validateReplayCursor(
  cursor: Cursor | null,
  snapshot: ReplayCursorSnapshot,
): ReplayCursorPlan {
  if (cursor === null || cursor.entryId === null) {
    if (cursor !== null && cursor.epoch > snapshot.epoch) {
      throw new StreamRequestError(
        "stale_epoch",
        `cursor epoch ${cursor.epoch} is newer than active epoch ${snapshot.epoch}`,
        { cursorEpoch: cursor.epoch, activeEpoch: snapshot.epoch },
      );
    }
    return {
      outcome: "ok",
      from: { entryId: null, epoch: snapshot.epoch },
      startIndex: 0,
    };
  }

  if (cursor.epoch > snapshot.epoch) {
    throw new StreamRequestError(
      "stale_epoch",
      `cursor epoch ${cursor.epoch} is newer than active epoch ${snapshot.epoch}`,
      { cursorEpoch: cursor.epoch, activeEpoch: snapshot.epoch },
    );
  }

  const activeIndex = snapshot.activeBranch.findIndex(
    (entry) => entry.id === cursor.entryId,
  );
  if (activeIndex !== -1) {
    return { outcome: "ok", from: cursor, startIndex: activeIndex + 1 };
  }

  const entriesById = new Map(snapshot.allEntries.map((entry) => [entry.id, entry]));
  const cursorEntry = entriesById.get(cursor.entryId);
  if (cursorEntry === undefined) {
    if (cursor.epoch === snapshot.epoch) {
      throw new StreamRequestError(
        "cursor_unknown",
        `unknown cursor entry: ${cursor.entryId}`,
      );
    }
    throw new StreamRequestError(
      "stale_epoch",
      `cursor entry ${cursor.entryId} cannot be related to active epoch ${snapshot.epoch}`,
      { cursorEpoch: cursor.epoch, activeEpoch: snapshot.epoch },
    );
  }

  const cursorAncestors = new Set<string>();
  let candidate = cursorEntry;
  while (!cursorAncestors.has(candidate.id)) {
    cursorAncestors.add(candidate.id);
    if (candidate.parentId === null) break;
    const parent = entriesById.get(candidate.parentId);
    if (parent === undefined) break;
    candidate = parent;
  }

  for (let index = snapshot.activeBranch.length - 1; index >= 0; index -= 1) {
    const activeEntry = snapshot.activeBranch[index];
    if (activeEntry !== undefined && cursorAncestors.has(activeEntry.id)) {
      return {
        outcome: "cursor_off_branch",
        from: cursor,
        forkPoint: { entryId: activeEntry.id, epoch: snapshot.epoch },
        startIndex: index + 1,
      };
    }
  }

  throw new StreamRequestError(
    "stale_epoch",
    `cursor entry ${cursor.entryId} cannot be related to active epoch ${snapshot.epoch}`,
    { cursorEpoch: cursor.epoch, activeEpoch: snapshot.epoch },
  );
}
