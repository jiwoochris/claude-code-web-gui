import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { isAuthed } from "@/lib/auth";
import {
  FsGuardError,
  assertAccessibleFile,
  resolveSafePath,
} from "@/lib/fs/guard";
import {
  OfficeRenderError,
  RENDERABLE_OFFICE_EXTS,
  renderOfficeToPdf,
} from "@/lib/fs/officeRender";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INPUT_BYTES = 200 * 1024 * 1024;

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return "";
  return p.slice(dot + 1).toLowerCase();
}

function errorToResponse(err: unknown, withBody: boolean, relParam: string): Response {
  if (err instanceof FsGuardError) {
    return withBody
      ? new Response(err.message, { status: err.status })
      : new Response(null, { status: err.status });
  }
  if (err instanceof OfficeRenderError) {
    return withBody
      ? new Response(err.message, { status: err.status })
      : new Response(null, { status: err.status });
  }
  log.error("fs.render.error", {
    path: relParam,
    message: (err as Error).message,
  });
  return withBody
    ? new Response("Render failed", { status: 500 })
    : new Response(null, { status: 500 });
}

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";

  try {
    const { abs } = resolveSafePath(relParam);
    await assertAccessibleFile(abs);

    const ext = extOf(abs);
    if (!RENDERABLE_OFFICE_EXTS.has(ext)) {
      return new Response("Not a renderable office document", { status: 415 });
    }

    const stat = await fs.stat(abs);
    if (stat.size > MAX_INPUT_BYTES) {
      return Response.json(
        { reason: "too_large", size: stat.size },
        { status: 413 },
      );
    }

    const { pdfPath, pdfSize } = await renderOfficeToPdf(abs);

    const nodeStream = createReadStream(pdfPath);
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
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfSize),
        "Content-Disposition": `inline; filename="${path
          .basename(abs)
          .replace(/\.[^.]+$/, "")}.pdf"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    return errorToResponse(err, true, relParam);
  }
}

export async function HEAD(req: Request) {
  if (!(await isAuthed())) return new Response(null, { status: 401 });
  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";
  try {
    const { abs } = resolveSafePath(relParam);
    await assertAccessibleFile(abs);
    const ext = extOf(abs);
    if (!RENDERABLE_OFFICE_EXTS.has(ext)) {
      return new Response(null, { status: 415 });
    }
    const stat = await fs.stat(abs);
    if (stat.size > MAX_INPUT_BYTES) {
      return new Response(null, { status: 413 });
    }
    const { pdfSize } = await renderOfficeToPdf(abs);
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfSize),
      },
    });
  } catch (err) {
    return errorToResponse(err, false, relParam);
  }
}
