import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Hash at most 8 MiB per file. Larger files use size + mtime; this is bounded
// change detection, not a sandbox against a caller that restores timestamps.
export const SNAPSHOT_HASH_CAP = 8 * 1024 * 1024;
interface FileSnapshot { readonly size: number; readonly digest?: string; readonly mtimeMs?: number; readonly kind: string; readonly target?: FileSnapshot }
export type WorktreeSnapshot = ReadonlyMap<string, FileSnapshot>;

/** Include ignored files and symlink targets; realpath ancestry breaks directory loops. */
export async function snapshotWorktree(root: string): Promise<WorktreeSnapshot> {
 const files = new Map<string, FileSnapshot>();
 const visited = new Set<string>();
 async function visit(directory: string): Promise<void> {
  const resolvedDirectory = await realpath(directory);
  if (visited.has(resolvedDirectory)) return;
  visited.add(resolvedDirectory);
  try {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
   if (entry.name === ".git" || entry.name === "node_modules") continue;
   const absolute = path.join(directory, entry.name);
   const relative = path.relative(root, absolute).split(path.sep).join("/");
   const info = await lstat(absolute);
   if (info.isDirectory()) { await visit(absolute); continue; }
   if (info.isSymbolicLink()) {
    const link = { kind: "link", size: info.size, digest: createHash("sha256").update(await readlink(absolute)).digest("hex") };
    let target: FileSnapshot | undefined;
    try {
     const resolved = await stat(absolute);
     if (resolved.isDirectory()) await visit(absolute);
     else if (resolved.isFile()) target = resolved.size > SNAPSHOT_HASH_CAP
      ? { kind: "file", size: resolved.size, mtimeMs: resolved.mtimeMs }
      : { kind: "file", size: resolved.size, digest: createHash("sha256").update(await readFile(absolute)).digest("hex") };
    } catch (error) {
     // Dangling links are valid snapshots; all other read failures abort detection.
     if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    files.set(relative, { ...link, ...(target === undefined ? {} : { target }) });
   } else if (info.isFile()) {
    files.set(relative, info.size > SNAPSHOT_HASH_CAP
     ? { kind: "file", size: info.size, mtimeMs: info.mtimeMs }
     : { kind: "file", size: info.size, digest: createHash("sha256").update(await readFile(absolute)).digest("hex") });
   } else throw new Error(`Unsupported worktree file: ${relative}`);
  }
  } finally { visited.delete(resolvedDirectory); }
 }
 await visit(root);
 return files;
}

/** Cache storage may not exist before the first dispatch; other read errors fail closed. */
export async function snapshotOptionalDirectory(root: string): Promise<WorktreeSnapshot> {
 try { await lstat(root); }
 catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
  throw error;
 }
 return snapshotWorktree(root);
}

function sameSnapshot(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
 if (!a || !b) return a === b;
 return a.kind === b.kind && a.size === b.size && a.digest === b.digest && a.mtimeMs === b.mtimeMs && sameSnapshot(a.target, b.target);
}

export function changedSnapshotPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
 return [...new Set([...before.keys(), ...after.keys()])].filter(file => {
  const a = before.get(file), b = after.get(file);
  return !sameSnapshot(a, b);
 });
}
