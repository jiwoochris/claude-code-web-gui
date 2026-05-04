import { promises as fs, createReadStream } from "node:fs";
import mime from "mime-types";
import { isAuthed } from "@/lib/auth";
import {
  FsGuardError,
  assertAccessibleFile,
  resolveSafePath,
} from "@/lib/fs/guard";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_DOC_BYTES = 100 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 4096;

// Extensions that the browser (or our viewer) can render directly even
// though they're "binary". For these we skip the NUL-byte check and use
// a much larger size budget so the iframe can stream the bytes.
const INLINE_DOC_EXTS = new Set(["pdf"]);

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return "";
  return p.slice(dot + 1).toLowerCase();
}

async function looksBinary(abs: string): Promise<boolean> {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";

  try {
    const { abs } = resolveSafePath(relParam);
    await assertAccessibleFile(abs);

    const stat = await fs.stat(abs);
    const mimeType = mime.lookup(abs) || "application/octet-stream";
    const isImage = typeof mimeType === "string" && mimeType.startsWith("image/");
    const isInlineDoc = INLINE_DOC_EXTS.has(extOf(abs));

    if (isInlineDoc) {
      if (stat.size > MAX_INLINE_DOC_BYTES) {
        return Response.json(
          { reason: "too_large", size: stat.size, mime: mimeType },
          { status: 413 },
        );
      }
    } else {
      if (!isImage && stat.size > MAX_PREVIEW_BYTES) {
        return Response.json(
          { reason: "too_large", size: stat.size, mime: mimeType },
          { status: 413 },
        );
      }

      if (!isImage && (await looksBinary(abs))) {
        return Response.json(
          { reason: "binary", size: stat.size, mime: mimeType },
          { status: 413 },
        );
      }
    }

    const nodeStream = createReadStream(abs);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": typeof mimeType === "string" ? mimeType : "application/octet-stream",
        "Content-Length": String(stat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof FsGuardError) {
      return new Response(err.message, { status: err.status });
    }
    log.error("fs.file.error", { path: relParam, message: (err as Error).message });
    return new Response("Internal Error", { status: 500 });
  }
}
