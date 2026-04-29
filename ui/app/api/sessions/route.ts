import { isAuthed } from "@/lib/auth";
import { isValidSessionName, listSessions, newSession } from "@/lib/tmux";
import {
  FsGuardError,
  assertAccessibleDir,
  resolveSafePath,
} from "@/lib/fs/guard";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  try {
    const sessions = await listSessions();
    return Response.json(sessions);
  } catch (err) {
    log.error("sessions.list.error", { message: (err as Error).message });
    return new Response("Internal Error", { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    cwd?: unknown;
  };
  const name = typeof body.name === "string" ? body.name : "";
  if (!isValidSessionName(name)) {
    return new Response("Invalid name", { status: 400 });
  }

  let resolvedCwd: string | undefined;
  let relCwd = "";
  if (body.cwd !== undefined && body.cwd !== null && body.cwd !== "") {
    if (typeof body.cwd !== "string") {
      return new Response("Invalid cwd", { status: 400 });
    }
    try {
      const { abs, rel } = resolveSafePath(body.cwd);
      await assertAccessibleDir(abs);
      resolvedCwd = abs;
      relCwd = rel;
    } catch (err) {
      if (err instanceof FsGuardError) {
        return new Response(err.message, { status: err.status });
      }
      throw err;
    }
  }

  try {
    await newSession(name, resolvedCwd);
    log.info("sessions.create", { name, cwd: relCwd });
    return Response.json({ name }, { status: 201 });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/duplicate session|already exists/i.test(stderr)) {
      return new Response("Conflict", { status: 409 });
    }
    log.error("sessions.create.error", { name, stderr });
    return new Response("Internal Error", { status: 500 });
  }
}
