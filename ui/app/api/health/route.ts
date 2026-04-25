import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const runtime = "nodejs";

export async function GET() {
  try {
    await run("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 2000 });
    return Response.json({ ok: true, tmux: "ok" });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const noServer = /no server running/i.test(stderr) || /no sessions/i.test(stderr);
    if (noServer) {
      return Response.json({ ok: true, tmux: "idle" });
    }
    return Response.json({ ok: false, tmux: "error" }, { status: 503 });
  }
}
