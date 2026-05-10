import { isAuthed } from "@/lib/auth";
import {
  getPaneCommand,
  hasSession,
  isShellCommand,
  isValidSessionName,
  sendKey,
  sendKeyRepeat,
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
      // Drain whatever the user has half-typed in the Claude TUI input box
      // before injecting "/clear". A single Esc cancels in-progress
      // streaming and may clear a single-line partial; a *second* Esc opens
      // Claude's rewind / previous-message selector, so we only press it
      // once. C-u alone is not enough because it kills back to the start of
      // the *current* line only — for multi-line input typed via
      // Shift+Enter (\\ + CR), the lines above the cursor stay put and
      // "/clear" then lands appended to leftover text, which Claude
      // submits as a regular prompt instead of a slash command. A long
      // burst of Backspaces drains the entire buffer regardless of how
      // many newlines it contains. The short pause lets the TUI re-render
      // an empty input before the slash command + Enter arrive together
      // as one batch (otherwise Enter can land while the input is still
      // settling and the TUI ignores it).
      await sendKey(name, "Escape");
      await new Promise((r) => setTimeout(r, 50));
      await sendKeyRepeat(name, "BSpace", 512);
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
