import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { unsealData } from "iron-session";
import { parse as parseCookie } from "cookie";

const execFileP = promisify(execFile);

// ── 상수 ──────────────────────────────────────────────────────
// Port is fixed at 3001 by design (§10.1); `PORT` env exists only so devs
// can sidestep local port collisions.
const PORT = Number(process.env.PORT ?? 3001);
const COOKIE_NAME = "claude_gui_session";
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
// 허용 오리진: 환경에 따라 추가/수정. 빈 배열이면 Origin 검증을 스킵(직접 IP:port 접근 시).
const ALLOWED_ORIGINS: string[] = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const PING_INTERVAL_MS = 30_000;
// ──────────────────────────────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "ws.boot.missing_secret",
      msg: "SESSION_SECRET missing or shorter than 32 chars",
    }),
  );
  process.exit(1);
}

function log(level: "info" | "warn" | "error", event: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function getClientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function isAuthed(cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader) return false;
  const cookies = parseCookie(cookieHeader);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return false;
  try {
    const data = await unsealData<{ authed?: boolean }>(raw, {
      password: SESSION_SECRET!,
    });
    return data?.authed === true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

// ── Claude Code transcript briefing ───────────────────────────
// Resolve the assistant's most recent text turn for `sessionName` by:
//   1. Asking tmux for the pane's current working directory.
//   2. Translating that cwd into Claude's project-encoded directory under
//      ~/.claude/projects/ (Claude replaces "/" with "-" verbatim).
//   3. Reading the most recently modified .jsonl in that directory and
//      walking it backward for the last `assistant` message with text content.
// Returns null when any step fails — the UI falls back to the terminal scrape.
const CLAUDE_PROJECTS_DIR = path.join(
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects"),
);

async function tmuxPanePath(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("tmux", [
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_current_path}",
    ]);
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

function encodeProjectDir(cwd: string): string {
  // Claude Code's encoding: replace every "/" with "-". A leading "/"
  // therefore becomes a leading "-", matching the on-disk layout.
  return cwd.replace(/\//g, "-");
}

async function findLatestJsonl(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(projectDir, name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    } catch {
      /* ignore */
    }
  }
  return bestPath;
}

type AssistantContent =
  | { type: "text"; text?: string }
  | { type: string; [k: string]: unknown };

function extractAssistantText(line: string): string | null {
  let obj: {
    message?: {
      type?: string;
      role?: string;
      content?: AssistantContent[] | string;
    };
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const message = obj.message;
  if (!message || message.type !== "message" || message.role !== "assistant") {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

async function readLastAssistantText(jsonlPath: string): Promise<string | null> {
  let buf: string;
  try {
    buf = await fs.readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const lines = buf.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    const text = extractAssistantText(ln);
    if (text) return text;
  }
  return null;
}

async function getBriefingText(sessionName: string): Promise<{ text: string | null; reason?: string }> {
  const cwd = await tmuxPanePath(sessionName);
  if (!cwd) return { text: null, reason: "no_pane_path" };
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd));
  const jsonl = await findLatestJsonl(projectDir);
  if (!jsonl) return { text: null, reason: "no_transcript" };
  const text = await readLastAssistantText(jsonl);
  if (!text) return { text: null, reason: "no_assistant_text" };
  return { text };
}
// ──────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const ip = getClientIp(req);

  // Origin 화이트리스트 검증 (설정된 경우만)
  if (ALLOWED_ORIGINS.length > 0) {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      log("warn", "ws.upgrade.origin_denied", { ip, origin });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  const authed = await isAuthed(req.headers.cookie);
  if (!authed) {
    log("warn", "ws.upgrade.unauthorized", { ip });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const match = req.url?.match(/^\/ws\/([a-zA-Z0-9_-]{1,32})$/);
  if (!match) {
    log("warn", "ws.upgrade.bad_path", { ip, url: req.url });
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, match[1]);
  });
});

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage, sessionName: string) => {
  const ip = getClientIp(req);

  if (!SESSION_NAME_RE.test(sessionName)) {
    ws.close(4400, "Bad name");
    return;
  }

  let term: pty.IPty;
  try {
    term = pty.spawn("tmux", ["attach", "-t", sessionName], {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: process.env.HOME ?? "/",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        LANG: process.env.LANG ?? "en_US.UTF-8",
      } as { [k: string]: string },
    });
  } catch (err) {
    log("error", "ws.pty.spawn_failed", {
      ip,
      sessionName,
      message: (err as Error).message,
    });
    ws.close(4500, "spawn failed");
    return;
  }

  log("info", "ws.connection.open", { ip, sessionName, pid: term.pid });

  let ptyExited = false;
  let sessionMissing = false;
  let stderrBuf = "";

  const onDataDisposable = term.onData((data) => {
    // tmux may print "can't find session: X" then exit with code 1.
    if (!sessionMissing && /can't find session|no sessions|session not found/i.test(data)) {
      sessionMissing = true;
    }
    stderrBuf = (stderrBuf + data).slice(-512);
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  const onExitDisposable = term.onExit(({ exitCode, signal }) => {
    ptyExited = true;
    log("info", "ws.pty.exit", { ip, sessionName, exitCode, signal });
    if (ws.readyState === ws.OPEN) {
      // 4404: session is gone (tmux said "can't find session"). The retry will
      //       definitely fail, so surface the cause.
      // 4000: tmux attach exited cleanly (user did `C-b d`, or a shell in the
      //       last window exited, etc.). The session *may* still be alive but
      //       treating this as a network drop (auto-retry N times) is wrong —
      //       we hand control back to the user with a neutral message.
      const code = sessionMissing ? 4404 : 4000;
      ws.close(code, sessionMissing ? "session not found" : "pty exited");
    }
  });

  ws.on("message", (data, isBinary) => {
    if (ptyExited) return;
    if (isBinary) {
      try {
        term.write(data as Buffer);
      } catch {
        /* pty may already be dead */
      }
      return;
    }
    const text = data.toString();
    try {
      const msg = JSON.parse(text) as {
        type?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        const cols = Math.max(1, Math.floor(msg.cols!));
        const rows = Math.max(1, Math.floor(msg.rows!));
        try {
          term.resize(cols, rows);
        } catch {
          /* ignore resize errors */
        }
        return;
      }
      if (msg.type === "ping") {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "briefing") {
        const reqId = (msg as { id?: string }).id;
        void getBriefingText(sessionName)
          .then((res) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(
              JSON.stringify({
                type: "briefing",
                id: reqId,
                text: res.text,
                reason: res.reason,
              }),
            );
          })
          .catch((err) => {
            log("warn", "ws.briefing.error", {
              ip,
              sessionName,
              message: (err as Error).message,
            });
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "briefing",
                  id: reqId,
                  text: null,
                  reason: "error",
                }),
              );
            }
          });
        return;
      }
    } catch {
      // Non-JSON text payloads are treated as raw input.
      try {
        term.write(text);
      } catch {
        /* pty may already be dead */
      }
    }
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.ping();
      } catch {
        /* noop */
      }
    }
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(pingTimer);
    onDataDisposable.dispose();
    onExitDisposable.dispose();
    if (!ptyExited) {
      try {
        term.kill();
      } catch {
        /* noop */
      }
    }
  };

  ws.on("close", (code, reason) => {
    log("info", "ws.connection.close", {
      ip,
      sessionName,
      code,
      reason: reason.toString(),
    });
    cleanup();
  });

  ws.on("error", (err) => {
    log("warn", "ws.connection.error", {
      ip,
      sessionName,
      message: err.message,
    });
  });
});

server.listen(PORT, () => {
  log("info", "ws.boot.listen", { port: PORT, allowedOrigins: ALLOWED_ORIGINS });
});

function shutdown(signal: string) {
  log("info", "ws.boot.shutdown", { signal });
  wss.clients.forEach((ws) => {
    try {
      ws.close(1001, "server shutting down");
    } catch {
      /* noop */
    }
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
