import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SESSION_NAME_PATTERN } from "@/lib/session";

const run = promisify(execFile);

export interface TmuxSession {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
}

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await run("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created}\t#{?session_attached,1,0}\t#{session_windows}",
    ], { timeout: 3000 });

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, created, attached, windows] = line.split("\t");
        return {
          name: name ?? "",
          created: Number(created ?? 0),
          attached: attached === "1",
          windows: Number(windows ?? 0),
        };
      });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/no server running/i.test(stderr) || /no sessions/i.test(stderr)) {
      return [];
    }
    throw err;
  }
}

export async function newSession(name: string): Promise<void> {
  const cwd = process.env.WORKSPACE_ROOT ?? process.env.HOME ?? "/";
  await run("tmux", ["new-session", "-d", "-s", name, "-c", cwd], { timeout: 3000 });
}

export async function killSession(name: string): Promise<void> {
  await run("tmux", ["kill-session", "-t", name], { timeout: 3000 });
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run("tmux", ["has-session", "-t", name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
