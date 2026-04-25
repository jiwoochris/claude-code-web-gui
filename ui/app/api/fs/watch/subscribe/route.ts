import { isAuthed } from "@/lib/auth";
import { FsGuardError, resolveSafePath } from "@/lib/fs/guard";
import { hasConnection, subscribe, unsubscribe } from "@/lib/fs/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conn?: string;
  path?: string;
  mode?: "dir" | "file";
  action?: "add" | "remove";
}

export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const { conn, path: relPath, mode, action } = body;

  if (!conn || typeof conn !== "string" || !hasConnection(conn)) {
    return new Response("Unknown connection", { status: 404 });
  }
  if (mode !== "dir" && mode !== "file") {
    return new Response("Invalid mode", { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return new Response("Invalid action", { status: 400 });
  }

  try {
    const { abs } = resolveSafePath(relPath ?? "");
    if (action === "add") subscribe(conn, abs, mode);
    else unsubscribe(conn, abs, mode);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof FsGuardError) {
      return new Response(err.message, { status: err.status });
    }
    throw err;
  }
}
