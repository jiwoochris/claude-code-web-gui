import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { isAuthed } from "@/lib/auth";
import { FsGuardError, getWorkspaceRoot, resolveSafePath } from "@/lib/fs/guard";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilename(base: string, fallback: string): { ascii: string; utf8: string } {
  const utf8 = base || fallback;
  const ascii = utf8.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || fallback;
  return { ascii, utf8: encodeURIComponent(utf8) };
}

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";

  try {
    const { abs } = resolveSafePath(relParam);
    const lst = await fs.lstat(abs).catch(() => null);
    if (!lst) throw new FsGuardError("Not found", 404);
    if (lst.isSymbolicLink()) throw new FsGuardError("Symlinks are not followed", 403);

    const root = getWorkspaceRoot();
    const isRoot = abs === root;
    const base = isRoot ? path.basename(root) || "workspace" : path.basename(abs);

    if (lst.isFile()) {
      const { ascii, utf8 } = safeFilename(base, "download.bin");
      const nodeStream = createReadStream(abs);
      const webStream = new ReadableStream({
        start(controller) {
          nodeStream.on("data", (c) => controller.enqueue(c));
          nodeStream.on("end", () => controller.close());
          nodeStream.on("error", (e) => controller.error(e));
        },
        cancel() {
          nodeStream.destroy();
        },
      });
      log.info("fs.download.file", { path: relParam, size: lst.size });
      return new Response(webStream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(lst.size),
          "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (!lst.isDirectory()) throw new FsGuardError("Unsupported entry", 400);

    const zipName = `${base}.zip`;
    const { ascii, utf8 } = safeFilename(zipName, "download.zip");
    const archive = archiver("zip", { zlib: { level: 6 } });

    const webStream = new ReadableStream({
      start(controller) {
        archive.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        archive.on("end", () => controller.close());
        archive.on("warning", (err) => log.warn("fs.download.zip.warn", { msg: err.message }));
        archive.on("error", (err) => {
          log.error("fs.download.zip.error", { msg: err.message });
          controller.error(err);
        });
        archive.directory(abs, base);
        archive.finalize().catch((err) => controller.error(err));
      },
      cancel() {
        archive.abort();
      },
    });

    log.info("fs.download.zip", { path: relParam });
    return new Response(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof FsGuardError) {
      return new Response(err.message, { status: err.status });
    }
    log.error("fs.download.error", { path: relParam, message: (err as Error).message });
    return new Response("Internal Error", { status: 500 });
  }
}
