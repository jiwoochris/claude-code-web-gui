import http from "node:http";
import { execFile } from "node:child_process";
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

// ── Claude Code briefing ──────────────────────────────────────
// /btw is a Claude Code "side question" — it answers without polluting the
// main thread's context, and it does NOT write its turn to the project
// transcript .jsonl. Briefing therefore runs as a two-phase exchange with
// the UI:
//   1. UI → "briefing_inject" → ws-gateway injects `/btw <prompt>` via
//      tmux send-keys; the response is rendered only into the Claude TUI.
//   2. UI watches its own xterm buffer for the response to settle, scrapes
//      the assistant text out, and sends it back via "briefing_synth".
//   3. ws-gateway streams the text through OpenRouter openai/gpt-audio
//      (pcm16, stream:true) and ships back base64 WAV as "briefing_audio".

// Sent verbatim after `/btw `. Kept short because (a) /btw answers from
// existing context anyway and (b) the UI uses the prompt's distinctive head
// as a textual anchor when scraping the response out of the xterm buffer —
// shorter and more recognizable means the anchor scan is more reliable.
const BRIEFING_SIDE_COMMAND = "/btw";
const BRIEFING_PROMPT = "방금까지 진행한 너의 마지막 작업 및 대화를 요약해줘.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tmuxSendKeys(sessionName: string, ...keys: string[]): Promise<void> {
  await execFileP("tmux", ["send-keys", "-t", sessionName, ...keys]);
}

// `tmux send-keys -l` treats every argument as literal text — no key-name
// parsing. Required for prompts containing multibyte chars or characters
// that happen to overlap tmux's key-name tokens (e.g. "Enter" inside a
// sentence). The Enter that submits the prompt must be sent as a *separate*
// send-keys call without -l so tmux interprets it as the Enter key.
async function tmuxSendLiteral(sessionName: string, text: string): Promise<void> {
  await execFileP("tmux", ["send-keys", "-t", sessionName, "-l", text]);
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

// Inject a fresh `/btw <prompt>` into the Claude TUI. Mirrors the /clear
// path in the UI's claude API route — Esc cancels any in-flight stream /
// clears partial input, C-u drains the readline buffer, a short pause lets
// the input box re-render, then we send the literal text and Enter as two
// distinct send-keys calls so the multibyte payload doesn't trip tmux's
// key-name parser.
async function injectBriefingPrompt(sessionName: string): Promise<void> {
  await tmuxSendKeys(sessionName, "Escape");
  await tmuxSendKeys(sessionName, "C-u");
  await sleep(150);
  await tmuxSendLiteral(sessionName, `${BRIEFING_SIDE_COMMAND} ${BRIEFING_PROMPT}`);
  await sleep(80);
  await tmuxSendKeys(sessionName, "Enter");
}

interface BriefingAudio {
  audio: string; // base64
  mime: string;
  text: string;
}

// OpenRouter's openai/gpt-audio rejects non-streaming requests
// ("Audio output requires stream: true") AND restricts the streaming format
// to pcm16 ("does not support 'mp3' when stream=true"). So we always stream
// and reassemble PCM16 chunks ourselves, then wrap them in a WAV header for
// the browser. OpenAI's gpt-4o audio output is fixed at 24 kHz / 16-bit /
// mono, which matches what OpenRouter forwards.
const OPENROUTER_PCM_SAMPLE_RATE = 24_000;
const OPENROUTER_PCM_CHANNELS = 1;
const OPENROUTER_PCM_BITS = 16;
const OPENROUTER_FETCH_TIMEOUT_MS = 90_000;

function wrapPcm16AsWav(pcm: Buffer): Buffer {
  const channels = OPENROUTER_PCM_CHANNELS;
  const sampleRate = OPENROUTER_PCM_SAMPLE_RATE;
  const bitsPerSample = OPENROUTER_PCM_BITS;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesizeViaOpenRouter(text: string): Promise<BriefingAudio> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_TTS_MODEL,
        modalities: ["text", "audio"],
        audio: { voice: OPENROUTER_TTS_VOICE, format: "pcm16" },
        stream: true,
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
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timeoutId);
    const body = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  const pcmChunks: Buffer[] = [];
  let sseBuf = "";
  let providerError: string | null = null;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      sseBuf += decoder.decode(chunk, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trimStart();
        if (!payload || payload === "[DONE]") continue;
        let obj: {
          error?: { message?: string };
          choices?: Array<{
            delta?: { audio?: { data?: string } };
          }>;
        };
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj.error?.message) {
          providerError = obj.error.message;
          continue;
        }
        const data = obj.choices?.[0]?.delta?.audio?.data;
        if (typeof data === "string" && data.length > 0) {
          pcmChunks.push(Buffer.from(data, "base64"));
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (providerError && pcmChunks.length === 0) {
    throw new Error(`openrouter provider: ${providerError}`);
  }
  if (pcmChunks.length === 0) {
    throw new Error("openrouter response had no audio data");
  }
  const wav = wrapPcm16AsWav(Buffer.concat(pcmChunks));
  return { audio: wav.toString("base64"), mime: "audio/wav", text };
}

interface BriefingInjectResult {
  ok: boolean;
  reason?: string;
}

async function runBriefingInject(sessionName: string): Promise<BriefingInjectResult> {
  // tmux's `pane_current_command` reports the *name* of the foreground proc,
  // which on macOS comes from p_comm. Claude Code sets its proc name to its
  // version string (e.g. "2.1.133"), so we cannot match on "claude"/"node"
  // directly. Mirror the UI's isShellCommand logic instead — if the pane is
  // running anything other than a known shell, we assume Claude is up.
  const SHELL_NAMES = new Set([
    "bash", "zsh", "sh", "fish", "dash", "ash", "ksh", "tcsh", "csh",
    "nu", "pwsh", "powershell",
  ]);
  const rawPaneCmd = (await tmuxPaneCommand(sessionName)) ?? "";
  const paneCmd = rawPaneCmd.replace(/^-/, "").toLowerCase();
  if (paneCmd === "" || SHELL_NAMES.has(paneCmd)) {
    return { ok: false, reason: "claude_not_running" };
  }
  if (!OPENROUTER_API_KEY) {
    return { ok: false, reason: "no_api_key" };
  }
  try {
    await injectBriefingPrompt(sessionName);
  } catch (err) {
    return { ok: false, reason: `tmux_send_failed:${(err as Error).message}` };
  }
  return { ok: true };
}

interface BriefingSynthResult {
  ok: boolean;
  reason?: string;
  audio?: string;
  mime?: string;
}

async function runBriefingSynth(text: string): Promise<BriefingSynthResult> {
  if (!OPENROUTER_API_KEY) return { ok: false, reason: "no_api_key" };
  if (!text || text.trim().length === 0) return { ok: false, reason: "empty_text" };
  try {
    const audio = await synthesizeViaOpenRouter(text);
    return { ok: true, audio: audio.audio, mime: audio.mime };
  } catch (err) {
    return { ok: false, reason: `tts_failed:${(err as Error).message}` };
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
      if (msg.type === "briefing_inject") {
        const reqId = (msg as { id?: string }).id;
        log("info", "ws.briefing.inject_start", { ip, sessionName });
        void runBriefingInject(sessionName)
          .then((res) => {
            if (ws.readyState !== ws.OPEN) return;
            if (res.ok) {
              log("info", "ws.briefing.inject_ok", { ip, sessionName });
              // Echo the prompt back so the UI can anchor its xterm scrape
              // on the exact text Claude will display above its answer.
              ws.send(
                JSON.stringify({
                  type: "briefing_inject_ok",
                  id: reqId,
                  prompt: BRIEFING_PROMPT,
                }),
              );
            } else {
              log("info", "ws.briefing.inject_failed", {
                ip,
                sessionName,
                reason: res.reason,
              });
              ws.send(
                JSON.stringify({
                  type: "briefing_error",
                  id: reqId,
                  reason: res.reason,
                }),
              );
            }
          })
          .catch((err) => {
            log("warn", "ws.briefing.inject_error", {
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
      if (msg.type === "briefing_synth") {
        const reqId = (msg as { id?: string }).id;
        const text = (msg as { text?: string }).text ?? "";
        log("info", "ws.briefing.synth_start", {
          ip,
          sessionName,
          chars: text.length,
          preview: text.slice(0, 200),
        });
        void runBriefingSynth(text)
          .then((res) => {
            if (ws.readyState !== ws.OPEN) return;
            if (res.ok) {
              log("info", "ws.briefing.synth_ok", {
                ip,
                sessionName,
                bytes: Math.floor(((res.audio?.length ?? 0) * 3) / 4),
              });
              ws.send(
                JSON.stringify({
                  type: "briefing_audio",
                  id: reqId,
                  audio: res.audio,
                  mime: res.mime,
                }),
              );
            } else {
              log("warn", "ws.briefing.synth_failed", {
                ip,
                sessionName,
                reason: res.reason,
              });
              ws.send(
                JSON.stringify({
                  type: "briefing_error",
                  id: reqId,
                  reason: res.reason,
                }),
              );
            }
          })
          .catch((err) => {
            log("warn", "ws.briefing.synth_error", {
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
