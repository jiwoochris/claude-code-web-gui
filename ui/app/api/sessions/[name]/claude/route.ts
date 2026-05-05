import { isAuthed } from "@/lib/auth";
import {
  getPaneCommand,
  hasSession,
  isShellCommand,
  isValidSessionName,
  sendKey,
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
      // Discard whatever the user has half-typed in the Claude TUI input box
      // before injecting "/clear". A single Esc cancels in-progress streaming
      // or clears the partial input; a *second* Esc opens Claude's rewind /
      // previous-message selector, which would then swallow the "/clear"
      // text. Follow up with C-u to drain any leftover readline buffer in
      // case Esc was a no-op (idle + empty input). The short pause lets the
      // TUI re-render an empty input before the slash command + Enter arrive
      // together as one batch (otherwise Enter can land while the input is
      // still settling and the TUI ignores it).
      await sendKey(name, "Escape");
      await sendKey(name, "C-u");
      await new Promise((r) => setTimeout(r, 120));
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
