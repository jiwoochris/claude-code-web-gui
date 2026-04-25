import { isAuthed } from "@/lib/auth";
import { hasSession, isValidSessionName, killSession } from "@/lib/tmux";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const { name } = await ctx.params;
  if (!isValidSessionName(name)) {
    return new Response("Invalid name", { status: 400 });
  }

  if (!(await hasSession(name))) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    await killSession(name);
    log.info("sessions.kill", { name });
    return new Response(null, { status: 204 });
  } catch (err) {
    log.error("sessions.kill.error", { name, message: (err as Error).message });
    return new Response("Internal Error", { status: 500 });
  }
}
