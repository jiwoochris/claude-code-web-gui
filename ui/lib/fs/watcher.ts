import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getWorkspaceRoot } from "./guard";
import { log } from "@/lib/logger";

export type FsEventType = "add" | "addDir" | "unlink" | "unlinkDir" | "change";

export interface FsEvent {
  type: FsEventType;
  path: string;
}

type Emit = (event: string, data: unknown) => void;

interface Connection {
  id: string;
  emit: Emit;
  watchers: Map<string, FSWatcher>;
  keepalive: ReturnType<typeof setInterval>;
}

const connections = new Map<string, Connection>();

function newId(): string {
  return "c_" + randomBytes(6).toString("hex");
}

function relFromRoot(abs: string): string {
  const root = getWorkspaceRoot();
  if (abs === root) return "";
  const rel = path.relative(root, abs);
  return rel;
}

export function createConnection(emit: Emit): string {
  const id = newId();
  const keepalive = setInterval(() => {
    try {
      emit("ping", { t: Date.now() });
    } catch {
      /* connection closed; close() will be invoked separately */
    }
  }, 25_000);
  connections.set(id, {
    id,
    emit,
    watchers: new Map(),
    keepalive,
  });
  log.info("fs.watch.open", { conn: id });
  return id;
}

export function closeConnection(id: string): void {
  const conn = connections.get(id);
  if (!conn) return;
  clearInterval(conn.keepalive);
  for (const [key, w] of conn.watchers.entries()) {
    w.close().catch(() => {});
    conn.watchers.delete(key);
  }
  connections.delete(id);
  log.info("fs.watch.close", { conn: id });
}

export function subscribe(id: string, absPath: string, mode: "dir" | "file"): boolean {
  const conn = connections.get(id);
  if (!conn) return false;
  const key = `${mode}:${absPath}`;
  if (conn.watchers.has(key)) return true;

  const watcher = chokidar.watch(absPath, {
    depth: mode === "dir" ? 0 : 0,
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    usePolling: false,
  });

  const onEvent = (type: FsEventType) => (p: string) => {
    const rel = relFromRoot(p);
    conn.emit("change", { type, path: rel });
  };

  watcher
    .on("add", onEvent("add"))
    .on("addDir", onEvent("addDir"))
    .on("unlink", onEvent("unlink"))
    .on("unlinkDir", onEvent("unlinkDir"))
    .on("change", onEvent("change"))
    .on("error", (err) => {
      log.warn("fs.watch.error", { conn: id, path: absPath, msg: (err as Error).message });
    });

  conn.watchers.set(key, watcher);
  return true;
}

export function unsubscribe(id: string, absPath: string, mode: "dir" | "file"): boolean {
  const conn = connections.get(id);
  if (!conn) return false;
  const key = `${mode}:${absPath}`;
  const w = conn.watchers.get(key);
  if (!w) return true;
  w.close().catch(() => {});
  conn.watchers.delete(key);
  return true;
}

export function hasConnection(id: string): boolean {
  return connections.has(id);
}
