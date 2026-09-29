import { existsSync, readFileSync } from "node:fs";

import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface CommittedSessionEntry {
  readonly entry: SessionEntry;
  readonly sessionFile: string;
}

export interface PersistenceObserver {
  readonly observedPersistEntryIds: ReadonlySet<string>;
  stop(): void;
}

export type CommittedEntryListener = (committed: CommittedSessionEntry) => void;
export type PersistenceObserverErrorListener = (error: unknown) => void;

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function readDiskEntries(sessionFile: string): SessionEntry[] {
  if (!existsSync(sessionFile)) return [];
  return parseSessionEntries(readFileSync(sessionFile, "utf8")).filter(
    isSessionEntry,
  );
}

export function observeSessionManagerPersistence(
  manager: SessionManager,
  listener: CommittedEntryListener,
  onError: PersistenceObserverErrorListener = () => undefined,
): PersistenceObserver {
  const sessionFile = manager.getSessionFile();
  const publishedIds = new Set(
    sessionFile === undefined
      ? []
      : readDiskEntries(sessionFile).map(({ id }) => id),
  );
  const observedPersistEntryIds = new Set<string>();
  const originalPersist = manager._persist.bind(manager);
  let stopped = false;

  const wrappedPersist: SessionManager["_persist"] = (entry) => {
    originalPersist(entry);
    observedPersistEntryIds.add(entry.id);

    try {
      const currentSessionFile = manager.getSessionFile();
      if (currentSessionFile === undefined) return;
      for (const diskEntry of readDiskEntries(currentSessionFile)) {
        if (publishedIds.has(diskEntry.id)) continue;
        publishedIds.add(diskEntry.id);
        listener({ entry: diskEntry, sessionFile: currentSessionFile });
      }
    } catch (error) {
      onError(error);
    }
  };

  manager._persist = wrappedPersist;

  return {
    observedPersistEntryIds,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (manager._persist === wrappedPersist) manager._persist = originalPersist;
    },
  };
}
