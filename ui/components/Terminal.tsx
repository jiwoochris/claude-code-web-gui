"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "connecting" | "open" | "retrying" | "closed" | "error";

interface Props {
  name: string;
}

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;

function wsUrlFor(name: string): string {
  if (typeof window === "undefined") return "";
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) {
    const base = explicit.replace(/\/$/, "");
    return `${base}/ws/${encodeURIComponent(name)}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const port = process.env.NEXT_PUBLIC_WS_PORT ?? "3001";
  return `${proto}//${host}:${port}/ws/${encodeURIComponent(name)}`;
}

export function Terminal({ name }: Props) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(true);

  const [status, setStatus] = useState<Status>("connecting");
  const [size, setSize] = useState<{ cols: number; rows: number }>({
    cols: 120,
    rows: 40,
  });
  const [banner, setBanner] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const briefingPendingRef = useRef<{
    id: string;
    resolve: (text: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = termRef.current;
    if (!ws || !term || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  const doFit = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    try {
      fit.fit();
      setSize({ cols: term.cols, rows: term.rows });
      sendResize();
    } catch {
      /* ignore resize errors pre-mount */
    }
  }, [sendResize]);

  const connect = useCallback(async () => {
    if (!aliveRef.current) return;
    const term = termRef.current;
    if (!term) return;

    setStatus(retryRef.current > 0 ? "retrying" : "connecting");

    const url = wsUrlFor(name);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus("error");
      setBanner("WebSocket 연결을 열 수 없습니다.");
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setStatus("open");
      setBanner(null);
      sendResize();
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    };

    ws.onmessage = (ev) => {
      const t = termRef.current;
      if (!t) return;
      if (typeof ev.data === "string") {
        // Only object-shaped payloads are control messages (ping/pong).
        // Anything else — including bare JSON values like a single digit
        // echoed back from the pty — must flow through to the terminal.
        if (ev.data.startsWith("{")) {
          try {
            const msg = JSON.parse(ev.data);
            if (msg?.type === "ping" || msg?.type === "pong") return;
            if (msg?.type === "briefing") {
              const pending = briefingPendingRef.current;
              if (pending && (!msg.id || msg.id === pending.id)) {
                clearTimeout(pending.timer);
                briefingPendingRef.current = null;
                pending.resolve(typeof msg.text === "string" ? msg.text : null);
              }
              return;
            }
          } catch {
            /* fall through and write as raw text */
          }
        }
        t.write(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        t.write(new Uint8Array(ev.data));
      } else if (ev.data instanceof Blob) {
        ev.data.arrayBuffer().then((buf) => t.write(new Uint8Array(buf)));
      }
    };

    ws.onerror = () => {
      // onclose will follow — don't duplicate retries here.
    };

    ws.onclose = (ev) => {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (!aliveRef.current) return;

      if (ev.code === 4401) {
        setStatus("error");
        setBanner("인증이 만료되었습니다. 다시 로그인하세요.");
        router.replace(`/login?next=${encodeURIComponent(`/s/${name}`)}`);
        return;
      }
      if (ev.code === 4404) {
        // Session is gone (tmux reported "can't find session"). This is the
        // natural terminal state after Ctrl-D, `exit`, or an external kill —
        // not an error condition from the user's perspective.
        setStatus("closed");
        setBanner("세션이 종료되었습니다.");
        return;
      }
      if (ev.code === 4400) {
        setStatus("error");
        setBanner("세션 이름이 올바르지 않습니다.");
        return;
      }

      // 4000 = tmux attach exited cleanly (C-b d, shell exit, etc.). Try one
      // quick reattach in case the session survived; the follow-up will land
      // in 4404 if it didn't.
      const cleanExit = ev.code === 4000;
      retryRef.current += 1;
      if (retryRef.current > MAX_RETRIES) {
        setStatus("closed");
        setBanner(
          cleanExit
            ? "세션 연결이 종료되었습니다."
            : "연결이 끊어졌습니다. '재연결'을 눌러 다시 시도하세요.",
        );
        return;
      }
      const delay = cleanExit
        ? 300
        : Math.min(RETRY_BASE_MS * 2 ** (retryRef.current - 1), 8_000);
      setStatus("retrying");
      setBanner(
        cleanExit
          ? `세션이 detach 되어 다시 연결 중… (${retryRef.current}/${MAX_RETRIES})`
          : `⚠ 연결이 끊어졌습니다. 재연결 중… (${retryRef.current}/${MAX_RETRIES})`,
      );
      retryTimerRef.current = setTimeout(() => {
        if (aliveRef.current) void connect();
      }, delay);
    };
  }, [name, router, sendResize]);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    (async () => {
      const host = hostRef.current;
      if (!host) return;

      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      // xterm.css is injected globally via the import below.
      await import("@xterm/xterm/css/xterm.css");

      if (cancelled) return;

      const term = new XTerm({
        convertEol: false,
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        allowProposedApi: true,
        scrollback: 10_000,
        theme: {
          background: "#ffffff",
          foreground: "#1b1f27",
          cursor: "#c06a00",
          cursorAccent: "#ffffff",
          selectionBackground: "rgba(192, 106, 0, 0.22)",
          black: "#1b1f27",
          red: "#c62a36",
          green: "#137e3d",
          yellow: "#a06800",
          blue: "#1f5fbf",
          magenta: "#9333a8",
          cyan: "#0a7c8a",
          white: "#5b6472",
          brightBlack: "#5b6472",
          brightRed: "#d63b48",
          brightGreen: "#1a9a4d",
          brightYellow: "#c08400",
          brightBlue: "#2b76d9",
          brightMagenta: "#a948bd",
          brightCyan: "#0e9bad",
          brightWhite: "#1b1f27",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          // Don't hijack selection drags — only act on a real click.
          if (event.type !== "click" && event.type !== "auxclick") return;
          if (event.button !== 0 && event.button !== 1) return;
          window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
      term.open(host);

      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* WebGL not available; fall back to canvas/DOM renderer */
      }

      termRef.current = term;
      fitRef.current = fit;

      // Shift+Enter sends ESC+CR (the same sequence native terminals like
      // iTerm/Terminal.app emit for Alt/Shift+Enter). TUIs such as Claude
      // Code treat this as "insert newline" while a bare CR still submits.
      // A lone LF is dropped by some TUIs inside tmux, which is why the
      // web GUI's old `\n` payload didn't work. Ctrl+C copies the current
      // selection when there is one (otherwise it falls through as SIGINT).
      // Ctrl+V pastes from the browser clipboard.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;

        if (
          ev.key === "Enter" &&
          ev.shiftKey &&
          !ev.ctrlKey &&
          !ev.altKey &&
          !ev.metaKey
        ) {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode("\x1b\r"));
          }
          return false;
        }

        if (
          ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          !ev.shiftKey &&
          (ev.key === "c" || ev.key === "C") &&
          termRef.current?.hasSelection()
        ) {
          const text = termRef.current.getSelection();
          if (text) {
            void navigator.clipboard.writeText(text).catch(() => {
              /* clipboard unavailable or denied */
            });
          }
          return false;
        }

        // Ctrl+Backspace deletes the previous word (sends ^W, U+0017).
        // Browsers don't emit a character for Ctrl+Backspace, so xterm
        // would otherwise drop it.
        if (
          ev.key === "Backspace" &&
          ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          !ev.shiftKey
        ) {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode("\x17"));
          }
          return false;
        }

        if (
          ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          (ev.key === "v" || ev.key === "V")
        ) {
          void (async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) termRef.current?.paste(text);
            } catch {
              /* clipboard unavailable or denied */
            }
          })();
          return false;
        }

        return true;
      });

      term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });

      term.onResize(({ cols, rows }) => {
        setSize({ cols, rows });
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      doFit();
      const ro = new ResizeObserver(() => doFit());
      ro.observe(host);

      await connect();

      return () => {
        ro.disconnect();
      };
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      try {
        termRef.current?.dispose();
      } catch {
        /* noop */
      }
      termRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const reconnect = () => {
    retryRef.current = 0;
    setBanner(null);
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    void connect();
  };

  const extractLastAssistantText = useCallback((): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const raw: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      raw.push(line ? line.translateToString(true) : "");
    }

    const BOX_CHARS_G = /[│┃╭╮╰╯─━└┘┌┐╔╗╚╝║═┏┓┗┛┃]/g;
    const BOX_TOP_CHARS = /[╭┌╔┏]/;
    const isBoxOrEmpty = (s: string) => {
      const t = s.trim();
      if (t === "") return true;
      const stripped = t.replace(BOX_CHARS_G, "").trim();
      return stripped === "" || /^[╭╮╰╯┌┐└┘┏┓┗┛]/.test(t);
    };

    // Claude Code TUI renders the input box (╭─╮ │>│ ╰─╯) plus a status
    // footer ("? for shortcuts", model name, …) at the very bottom of the
    // pane. Without skipping past the box's top edge, the trailing
    // "trim box-or-empty" pass stops at the footer (plain text, not a box
    // line) and we'd end up speaking the footer instead of the assistant's
    // last reply. So: find the top edge of the most recent input box and
    // treat everything from there downward as chrome.
    let boxTop = -1;
    for (let i = raw.length - 1; i >= 0; i--) {
      if (BOX_TOP_CHARS.test(raw[i])) {
        boxTop = i;
        break;
      }
    }

    let end = boxTop >= 0 ? boxTop : raw.length;
    while (end > 0 && isBoxOrEmpty(raw[end - 1])) end--;

    let start = end;
    for (let i = end - 1; i >= 0; i--) {
      if (isBoxOrEmpty(raw[i])) {
        start = i + 1;
        break;
      }
      const t = raw[i].replace(BOX_CHARS_G, "").trim();
      if (/^>\s/.test(t)) {
        start = i + 1;
        break;
      }
      start = i;
    }

    const cleaned = raw
      .slice(start, end)
      .map((l) => l.replace(BOX_CHARS_G, "").replace(/^\s+|\s+$/g, ""))
      .filter((l) => l !== "")
      .join(" ");

    return cleaned.slice(0, 1200);
  }, []);

  const requestTranscriptBriefing = useCallback((): Promise<string | null> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const prev = briefingPendingRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve(null);
      briefingPendingRef.current = null;
    }
    return new Promise<string | null>((resolve) => {
      const id =
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2));
      const timer = setTimeout(() => {
        if (briefingPendingRef.current?.id === id) {
          briefingPendingRef.current = null;
          resolve(null);
        }
      }, 3000);
      briefingPendingRef.current = { id, resolve, timer };
      try {
        ws.send(JSON.stringify({ type: "briefing", id }));
      } catch {
        clearTimeout(timer);
        briefingPendingRef.current = null;
        resolve(null);
      }
    });
  }, []);

  const speakText = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ko-KR";
    utter.rate = 1.05;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utter);
  }, []);

  const toggleClaude = useCallback(async () => {
    if (claudeBusy) return;
    setClaudeBusy(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(name)}/claude`,
        { method: "POST", credentials: "include" },
      );
      if (res.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(`/s/${name}`)}`);
        return;
      }
      if (res.status === 404) {
        setBanner("세션을 찾을 수 없습니다.");
        return;
      }
      if (!res.ok) {
        setBanner("Claude 명령 전송에 실패했습니다.");
        return;
      }
    } catch {
      setBanner("네트워크 오류");
    } finally {
      setClaudeBusy(false);
    }
  }, [claudeBusy, name, router]);

  const toggleBriefing = useCallback(async () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setBanner("이 브라우저는 음성 합성을 지원하지 않습니다.");
      return;
    }
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
      synth.cancel();
      setSpeaking(false);
      return;
    }

    const transcriptText = await requestTranscriptBriefing();
    const text = transcriptText ?? extractLastAssistantText();
    if (!text) {
      setBanner("읽을 답변을 찾지 못했습니다.");
      return;
    }
    speakText(text.slice(0, 4000));
  }, [extractLastAssistantText, requestTranscriptBriefing, speakText]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      const pending = briefingPendingRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        briefingPendingRef.current = null;
      }
    };
  }, []);

  const focusIfKeyboardLikelyVisible = useCallback(() => {
    // On mobile, calling term.focus() steals focus to xterm's hidden
    // <textarea>, which yanks the on-screen keyboard up even when the user
    // just wanted to tap a soft key. Only refocus when there's already a
    // physical (or soft) keyboard in play — i.e. an existing focused input.
    if (typeof window === "undefined") return;
    const isCoarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    if (isCoarse) return;
    termRef.current?.focus();
  }, []);

  const sendKey = useCallback(
    (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
      focusIfKeyboardLikelyVisible();
    },
    [focusIfKeyboardLikelyVisible],
  );

  // Synthesizes a mouse-wheel scroll for mobile (no physical wheel). xterm's
  // own viewport handles plain scrollback; TUIs that enable mouse tracking
  // (Claude Code does) instead consume an SGR wheel report, so emit both.
  const sendWheel = useCallback(
    (dir: "up" | "down") => {
      const term = termRef.current;
      if (!term) return;
      try {
        term.scrollLines(dir === "up" ? -3 : 3);
      } catch {
        /* ignore */
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const x = Math.max(1, Math.floor(term.cols / 2));
        const y = Math.max(1, Math.floor(term.rows / 2));
        const code = dir === "up" ? 64 : 65;
        ws.send(new TextEncoder().encode(`\x1b[<${code};${x};${y}M`));
      }
      focusIfKeyboardLikelyVisible();
    },
    [focusIfKeyboardLikelyVisible],
  );

  const dotClass =
    status === "open"
      ? "dot connected"
      : status === "error"
        ? "dot error"
        : "dot";

  return (
    <div className="term-page">
      <header className="term-header">
        <span className={dotClass} aria-label={`연결 상태: ${status}`} />
        <span className="name">{name}</span>
        <span className="size">
          {size.cols}×{size.rows}
        </span>
        <span className="spacer" />
        <button
          onClick={toggleBriefing}
          title={speaking ? "음성 정지" : "마지막 답변 음성 브리핑"}
          aria-pressed={speaking}
        >
          {speaking ? "⏹ 정지" : "🔊 브리핑"}
        </button>
        <button
          onClick={toggleClaude}
          disabled={claudeBusy}
          aria-busy={claudeBusy}
          title="Claude Code 시작 또는 /clear"
        >
          🤖 Claude
        </button>
        <button onClick={reconnect} title="WebSocket 재연결">
          🔌 재연결
        </button>
      </header>

      {banner && (
        <div className={`term-banner${status === "open" ? " info" : ""}`}>
          <span>{banner}</span>
          <button className="dismiss" onClick={() => setBanner(null)} aria-label="닫기">
            ×
          </button>
        </div>
      )}

      <div className="term-body">
        <div ref={hostRef} className="xterm-host" />
      </div>

      <div className="term-keys" role="toolbar" aria-label="키보드 보조키">
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x1b")} aria-label="Esc">Esc</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\t")} aria-label="Tab">Tab</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x03")} aria-label="Ctrl+C">^C</button>
        <span className="term-keys-spacer" />
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendWheel("up")} aria-label="휠 위로">⇞</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendWheel("down")} aria-label="휠 아래로">⇟</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x1b[D")} aria-label="왼쪽">←</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x1b[B")} aria-label="아래">↓</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x1b[A")} aria-label="위">↑</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey("\x1b[C")} aria-label="오른쪽">→</button>
      </div>
    </div>
  );
}
