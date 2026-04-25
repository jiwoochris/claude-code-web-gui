import { isAuthed } from "@/lib/auth";
import { isValidSessionName, listSessions, newSession } from "@/lib/tmux";
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

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  if (!isValidSessionName(name)) {
    return new Response("Invalid name", { status: 400 });
  }

  try {
    await newSession(name);
    log.info("sessions.create", { name });
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
