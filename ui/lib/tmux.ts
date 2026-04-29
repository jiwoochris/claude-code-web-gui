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

export async function newSession(name: string, cwd?: string): Promise<void> {
  const startDir = cwd ?? process.env.WORKSPACE_ROOT ?? process.env.HOME ?? "/";
  await run("tmux", ["new-session", "-d", "-s", name, "-c", startDir], { timeout: 3000 });
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

export async function getPaneCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      "tmux",
      ["display-message", "-p", "-t", name, "#{pane_current_command}"],
      { timeout: 3000 },
    );
    const cmd = stdout.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

// Send literal text + Enter into a tmux session. tmux's send-keys can take
// the literal text and the `Enter` key in a single invocation; that delivers
// them as one contiguous batch to the pty, so TUIs like Claude Code don't
// race between displaying the typed text and acting on the submit key.
export async function sendLine(name: string, text: string): Promise<void> {
  await run("tmux", ["send-keys", "-t", name, text, "Enter"], { timeout: 3000 });
}

export async function sendKey(name: string, key: string): Promise<void> {
  await run("tmux", ["send-keys", "-t", name, key], { timeout: 3000 });
}

const SHELL_COMMANDS = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "powershell",
]);

export function isShellCommand(cmd: string | null): boolean {
  if (!cmd) return false;
  const c = cmd.replace(/^-/, "").toLowerCase();
  return SHELL_COMMANDS.has(c);
}
