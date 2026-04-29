import { isAuthed } from "@/lib/auth";
import {
  getPaneCommand,
  hasSession,
  isShellCommand,
  isValidSessionName,
  sendLine,
} from "@/lib/tmux";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(
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
    const cmd = await getPaneCommand(name);
    const action = isShellCommand(cmd) ? "start" : "clear";
    if (action === "start") {
      await sendLine(name, "claude");
    } else {
      await sendLine(name, "/clear");
    }
    log.info("sessions.claude", { name, command: cmd, action });
    return Response.json({ action, command: cmd });
  } catch (err) {
    log.error("sessions.claude.error", {
      name,
      message: (err as Error).message,
    });
    return new Response("Internal Error", { status: 500 });
  }
}
