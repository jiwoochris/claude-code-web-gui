import { promises as fs } from "node:fs";
import path from "node:path";
import { isAuthed } from "@/lib/auth";
import {
  FsGuardError,
  assertAccessibleDir,
  getWorkspaceRoot,
  resolveSafePath,
  statSafe,
} from "@/lib/fs/guard";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";

  try {
    const { abs, rel } = resolveSafePath(relParam);
    await assertAccessibleDir(abs);

    const names = await fs.readdir(abs);
    const entries = await Promise.all(
      names.map(async (name) => {
        const meta = await statSafe(path.join(abs, name));
        return meta;
      }),
    );

    const filtered = entries.filter((e): e is NonNullable<typeof e> => e !== null);
    filtered.sort((a, b) => {
      const order = (t: string) => (t === "dir" ? 0 : 1);
      const d = order(a.type) - order(b.type);
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    });

    const rootName = path.basename(getWorkspaceRoot()) || "workspace";
    return Response.json({ path: rel, rootName, entries: filtered });
  } catch (err) {
    if (err instanceof FsGuardError) {
      return new Response(err.message, { status: err.status });
    }
    log.error("fs.tree.error", { path: relParam, message: (err as Error).message });
    return new Response("Internal Error", { status: 500 });
  }
}
