import path from "node:path";
import { promises as fs } from "node:fs";

export class FsGuardError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "FsGuardError";
  }
}

export function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (!root) {
    throw new FsGuardError("WORKSPACE_ROOT is not configured", 500);
  }
  return path.resolve(root);
}

export function resolveSafePath(relative: string): { abs: string; rel: string } {
  const root = getWorkspaceRoot();
  const cleanedInput = (relative ?? "").replace(/^\/+/, "");
  const abs = path.resolve(root, cleanedInput);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new FsGuardError("Path escapes workspace root", 403);
  }
  const rel = abs === root ? "" : path.relative(root, abs);
  return { abs, rel };
}

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface EntryMeta {
  name: string;
  type: EntryKind;
  size: number;
  mtime: number;
}

export async function statSafe(abs: string): Promise<EntryMeta | null> {
  try {
    const lst = await fs.lstat(abs);
    let type: EntryKind;
    if (lst.isSymbolicLink()) type = "symlink";
    else if (lst.isDirectory()) type = "dir";
    else if (lst.isFile()) type = "file";
    else type = "other";
    return {
      name: path.basename(abs),
      type,
      size: type === "file" ? lst.size : 0,
      mtime: Math.floor(lst.mtimeMs / 1000),
    };
  } catch {
    return null;
  }
}

export async function assertAccessibleFile(abs: string): Promise<void> {
  const lst = await fs.lstat(abs).catch(() => null);
  if (!lst) throw new FsGuardError("Not found", 404);
  if (lst.isSymbolicLink()) throw new FsGuardError("Symlinks are not followed", 403);
  if (!lst.isFile()) throw new FsGuardError("Not a file", 400);
}

export async function assertAccessibleDir(abs: string): Promise<void> {
  const lst = await fs.lstat(abs).catch(() => null);
  if (!lst) throw new FsGuardError("Not found", 404);
  if (lst.isSymbolicLink()) throw new FsGuardError("Symlinks are not followed", 403);
  if (!lst.isDirectory()) throw new FsGuardError("Not a directory", 400);
}
