import { isAuthed } from "@/lib/auth";
import {
  FsGuardError,
  assertAccessibleFile,
  resolveSafePath,
} from "@/lib/fs/guard";
import { PptxNotesError, extractPptxNotes } from "@/lib/fs/pptxNotes";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const relParam = url.searchParams.get("path") ?? "";

  try {
    const { abs } = resolveSafePath(relParam);
    await assertAccessibleFile(abs);

    if (!abs.toLowerCase().endsWith(".pptx")) {
      return new Response("Not a pptx file", { status: 415 });
    }

    const result = await extractPptxNotes(abs);
    return Response.json(result, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (err) {
    if (err instanceof FsGuardError || err instanceof PptxNotesError) {
      return new Response(err.message, { status: err.status });
    }
    log.error("fs.pptxNotes.error", {
      path: relParam,
      message: (err as Error).message,
    });
    return new Response("Failed to extract notes", { status: 500 });
  }
}
