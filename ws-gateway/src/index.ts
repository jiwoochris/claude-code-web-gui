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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_TTS_MODEL = process.env.OPENROUTER_TTS_MODEL ?? "openai/gpt-audio";
const OPENROUTER_TTS_VOICE = process.env.OPENROUTER_TTS_VOICE ?? "alloy";
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

// Force tmux server-wide options the webgui depends on:
//   - extended-keys always:           always forward CSI u modified-key
//                                     sequences to inner panes (the default
//                                     `on` only forwards when the app DECSETs
//                                     extended keys, which Claude Code may
//                                     not do early enough)
//   - extended-keys-format csi-u:     keep the wire format as ESC[13;2u
//                                     instead of tmux's default xterm
//                                     `ESC[27;2;13~`, which Claude Code's
//                                     input parser does NOT treat as
//                                     Shift+Enter
//   - terminal-features extkeys:      declare CSI u capability on tmux's
//                                     outer xterm-256color terminfo entry
// Without all three, the browser's ESC[13;2u for Shift+Enter is dropped or
// rewritten by tmux and Claude Code only sees a bare CR (== submit).
// Idempotent and silent on failure — if tmux isn't reachable yet there's
// nothing to configure.
async function ensureTmuxExtendedKeys(): Promise<void> {
  try {
    await execFileP("tmux", ["set-option", "-g", "extended-keys", "always"]);
    await execFileP("tmux", [
      "set-option",
      "-g",
      "extended-keys-format",
      "csi-u",
    ]);
    await execFileP("tmux", [
      "set-option",
      "-gas",
      "terminal-features",
      "xterm*:extkeys",
    ]);
  } catch {
    /* tmux server may not be running yet; the next tmux invocation will
       inherit options from ~/.tmux.conf when the server actually starts */
  }
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
// Briefing flow:
//   1. Inject a Korean "summarize the conversation" prompt into the running
//      Claude Code TUI via `tmux send-keys` (same Esc/C-u prelude as /clear).
//   2. Snapshot the active transcript .jsonl byte size *before* injecting,
//      then poll for new assistant text past that offset. We use a settling
//      window so tool_use intermediate turns don't end up being read aloud.
//   3. POST the resulting text to OpenRouter (openai/gpt-audio by default)
//      and ship the returned base64 mp3 back over the WebSocket. The UI
//      decodes and plays it via <audio>.
const CLAUDE_PROJECTS_DIR = path.join(
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects"),
);

const BRIEFING_PROMPT =
  "방금까지 우리가 나눈 대화를 라디오 진행자처럼 자연스럽고 짧게 한국어 대화체로 브리핑해줘. " +
  "어떤 도구도 호출하지 말고 즉시 답하고, 마크다운·코드블록·불릿·이모지 없이, " +
  "음성으로 들었을 때 자연스러운 2~4문장으로만.";

const BRIEFING_TOTAL_TIMEOUT_MS = 90_000;
const BRIEFING_SETTLE_MS = 1_800;
const BRIEFING_POLL_MS = 400;

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

async function readLastAssistantTextSince(
  jsonlPath: string,
  startByte: number,
): Promise<string | null> {
  let st: { size: number };
  try {
    st = await fs.stat(jsonlPath);
  } catch {
    return null;
  }
  if (st.size <= startByte) return null;
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(jsonlPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(st.size - startByte);
    await fh.read(buf, 0, buf.length, startByte);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln) continue;
      const t = extractAssistantText(ln);
      if (t) return t;
    }
    return null;
  } finally {
    try {
      await fh.close();
    } catch {
      /* ignore */
    }
  }
}

async function statSize(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tmuxSendKeys(sessionName: string, ...keys: string[]): Promise<void> {
  await execFileP("tmux", ["send-keys", "-t", sessionName, ...keys]);
}

async function tmuxPaneCommand(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("tmux", [
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_current_command}",
    ]);
    const cmd = stdout.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

// Inject a fresh prompt into the Claude TUI. Mirrors the /clear path in the
// UI's claude API route — Esc cancels any in-flight stream / clears partial
// input, C-u drains the readline buffer, then a short pause lets the input
// box re-render before we type.
async function injectBriefingPrompt(sessionName: string): Promise<void> {
  await tmuxSendKeys(sessionName, "Escape");
  await tmuxSendKeys(sessionName, "C-u");
  await sleep(150);
  await tmuxSendKeys(sessionName, BRIEFING_PROMPT, "Enter");
}

async function waitForBriefingResponse(
  jsonlPath: string,
  startByte: number,
): Promise<string | null> {
  const deadline = Date.now() + BRIEFING_TOTAL_TIMEOUT_MS;
  let lastText: string | null = null;
  let lastSeenAt = Date.now();
  while (Date.now() < deadline) {
    const text = await readLastAssistantTextSince(jsonlPath, startByte);
    if (text && text !== lastText) {
      lastText = text;
      lastSeenAt = Date.now();
    }
    if (lastText && Date.now() - lastSeenAt >= BRIEFING_SETTLE_MS) {
      return lastText;
    }
    await sleep(BRIEFING_POLL_MS);
  }
  return lastText;
}

interface BriefingAudio {
  audio: string; // base64
  mime: string;
  text: string;
}

async function synthesizeViaOpenRouter(text: string): Promise<BriefingAudio> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_TTS_MODEL,
      modalities: ["text", "audio"],
      audio: { voice: OPENROUTER_TTS_VOICE, format: "mp3" },
      messages: [
        {
          role: "system",
          content:
            "You speak the user's text aloud verbatim in a natural, conversational Korean broadcast tone. Do not paraphrase, summarize, translate, comment, or add anything — read it as-is.",
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { audio?: { data?: string; format?: string } } }>;
  };
  const audio = json.choices?.[0]?.message?.audio;
  if (!audio?.data) {
    throw new Error("openrouter response missing audio.data");
  }
  const fmt = audio.format ?? "mp3";
  const mime = fmt === "wav" ? "audio/wav" : fmt === "opus" ? "audio/ogg" : "audio/mpeg";
  return { audio: audio.data, mime, text };
}

interface BriefingResult {
  ok: boolean;
  reason?: string;
  text?: string;
  audio?: string;
  mime?: string;
}

async function runBriefing(sessionName: string): Promise<BriefingResult> {
  const cwd = await tmuxPanePath(sessionName);
  if (!cwd) return { ok: false, reason: "no_pane_path" };
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(cwd));
  const jsonl = await findLatestJsonl(projectDir);
  if (!jsonl) return { ok: false, reason: "no_transcript" };

  const paneCmd = (await tmuxPaneCommand(sessionName))?.toLowerCase() ?? "";
  if (!paneCmd.includes("claude") && !paneCmd.includes("node")) {
    // Pane is in a shell — typing the prompt would just clutter the terminal
    // without actually reaching Claude.
    return { ok: false, reason: "claude_not_running" };
  }

  if (!OPENROUTER_API_KEY) {
    return { ok: false, reason: "no_api_key" };
  }

  const startByte = await statSize(jsonl);
  try {
    await injectBriefingPrompt(sessionName);
  } catch (err) {
    return { ok: false, reason: `tmux_send_failed:${(err as Error).message}` };
  }

  const text = await waitForBriefingResponse(jsonl, startByte);
  if (!text) return { ok: false, reason: "no_assistant_text" };

  try {
    const audio = await synthesizeViaOpenRouter(text);
    return { ok: true, text: audio.text, audio: audio.audio, mime: audio.mime };
  } catch (err) {
    return { ok: false, reason: `tts_failed:${(err as Error).message}`, text };
  }
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
        void runBriefing(sessionName)
          .then((res) => {
            if (ws.readyState !== ws.OPEN) return;
            if (res.ok) {
              ws.send(
                JSON.stringify({
                  type: "briefing_audio",
                  id: reqId,
                  audio: res.audio,
                  mime: res.mime,
                  text: res.text,
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: "briefing_error",
                  id: reqId,
                  reason: res.reason,
                  text: res.text,
                }),
              );
            }
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
                  type: "briefing_error",
                  id: reqId,
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
  void ensureTmuxExtendedKeys();
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
