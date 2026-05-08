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
  const [briefingState, setBriefingState] = useState<"idle" | "loading" | "playing">(
    "idle",
  );
  const [claudeBusy, setClaudeBusy] = useState(false);
  type BriefingMsg =
    | { type: "briefing_inject_ok" }
    | { type: "briefing_audio"; audio: string; mime: string }
    | { type: "briefing_error"; reason?: string };
  const briefingPendingRef = useRef<{
    id: string;
    resolve: (msg: BriefingMsg | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const briefingAudioRef = useRef<HTMLAudioElement | null>(null);
  const briefingAudioUrlRef = useRef<string | null>(null);
  // Timestamp of the last pty payload we forwarded to xterm. Set by
  // ws.onmessage for every chunk. The briefing flow uses this as a
  // settling signal — once the pane has been quiet for ~2s after the
  // /btw injection, we assume the side answer has finished rendering.
  const lastTermDataAtRef = useRef<number>(0);

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
            if (
              msg?.type === "briefing_inject_ok" ||
              msg?.type === "briefing_audio" ||
              msg?.type === "briefing_error"
            ) {
              const pending = briefingPendingRef.current;
              if (pending && (!msg.id || msg.id === pending.id)) {
                clearTimeout(pending.timer);
                briefingPendingRef.current = null;
                pending.resolve(msg as BriefingMsg);
              }
              return;
            }
          } catch {
            /* fall through and write as raw text */
          }
        }
        lastTermDataAtRef.current = Date.now();
        t.write(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        lastTermDataAtRef.current = Date.now();
        t.write(new Uint8Array(ev.data));
      } else if (ev.data instanceof Blob) {
        lastTermDataAtRef.current = Date.now();
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
        // OSC 8 hyperlink handler. Claude Code (and most modern CLIs)
        // emit `[label](url)` as an OSC 8 escape sequence — the URL lives
        // in cell metadata, not as visible characters — so neither the
        // WebLinksAddon nor our markdown-text regex provider can see it.
        // Without a linkHandler xterm parses the OSC 8 silently but does
        // nothing on click, which matches the symptom: blue label, no
        // hover underline, no navigation. We open the URL in a new tab on
        // primary/middle click only.
        linkHandler: {
          activate(event, text) {
            // TEMP DIAGNOSTIC — remove once clickable-link issue is solved.
            console.log("[xterm linkHandler.activate]", {
              button: event.button,
              text,
            });
            if (event.button !== 0 && event.button !== 1) return;
            window.open(text, "_blank", "noopener,noreferrer");
          },
          hover(_event, text) {
            // TEMP DIAGNOSTIC — proves OSC 8 hyperlinks are being seen.
            console.log("[xterm linkHandler.hover]", text);
          },
          leave() {
            /* no-op */
          },
          allowNonHttpProtocols: false,
        },
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
          // xterm fires activate from mouseup once it has confirmed the
          // mousedown/mouseup landed on the same link, so we only need to
          // gate out non-primary buttons here (right-click, etc.).
          if (event.button !== 0 && event.button !== 1) return;
          window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );

      // Markdown-style link provider: makes `[label](https://…)` clickable on
      // the *label* too, not just the bare URL inside the parens. The default
      // WebLinksAddon only detects exposed URLs, so when Claude prints output
      // like "[열기](https://…)" the user sees rendered-looking markdown but
      // clicking the label does nothing. We walk the logical (possibly
      // wrapped) line so a single `[…](…)` that line-wraps still matches —
      // long URLs (~100+ chars) routinely wrap across two buffer lines, and
      // without this the regex never matches because each buffer line is
      // searched in isolation. xterm's ILink range is single-line, so when a
      // match spans wrapped lines we emit one ILink per buffer line covering
      // just the cells that fall on it. We also map string indices back to
      // cell columns so wide chars (Korean, CJK) line up correctly.
      const MD_LINK = /\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g;
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const t = termRef.current;
          if (!t) return callback(undefined);
          const buffer = t.buffer.active;

          // Walk up to the start of the logical line. `isWrapped` on a
          // buffer line means "this line is the continuation of the line
          // above", so we keep stepping up while the current line is
          // wrapped.
          let startLineNum = bufferLineNumber;
          while (startLineNum > 1) {
            const cur = buffer.getLine(startLineNum - 1);
            if (!cur || !cur.isWrapped) break;
            startLineNum -= 1;
          }

          // Walk forward collecting cells until the next line is no longer
          // a wrap continuation. Track which buffer line and cell columns
          // each visible char came from.
          const cellLine: number[] = [];
          const cellStartCol: number[] = [];
          const cellEndCol: number[] = [];
          const chars: string[] = [];
          let curLineNum = startLineNum;
          while (true) {
            const line = buffer.getLine(curLineNum - 1);
            if (!line) break;
            for (let x = 0; x < line.length; x++) {
              const cell = line.getCell(x);
              if (!cell) continue;
              const w = cell.getWidth();
              if (w === 0) continue; // continuation cell of a wide char
              const ch = cell.getChars();
              chars.push(ch === "" ? " " : ch);
              cellLine.push(curLineNum);
              cellStartCol.push(x + 1);
              cellEndCol.push(x + (w === 2 ? 2 : 1));
            }
            const next = buffer.getLine(curLineNum);
            if (!next || !next.isWrapped) break;
            curLineNum += 1;
          }
          const text = chars.join("");

          // TEMP DIAGNOSTIC — when a line obviously *looks* like a markdown
          // link (or part of one), log what we actually see so we can tell
          // whether the visible chars even contain `[…](url)` or whether the
          // link is hidden behind an OSC 8 escape with no visible chars.
          if (
            /\]\(https?:\/\//.test(text) ||
            /\[[^\]]{0,40}\]\(/.test(text) ||
            text.includes("캘린더에서 보기")
          ) {
            console.log("[md link provider line]", {
              bufferLineNumber,
              startLineNum,
              endLineNum: curLineNum,
              text: text.slice(0, 400),
            });
          }

          const links: import("@xterm/xterm").ILink[] = [];
          MD_LINK.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = MD_LINK.exec(text)) !== null) {
            const startIdx = m.index;
            const endIdx = m.index + m[0].length - 1;
            if (startIdx >= chars.length || endIdx >= chars.length) continue;
            const url = m[2];

            // Split the match into per-buffer-line segments and only emit
            // the segment that lives on bufferLineNumber. The provider is
            // called once per visible buffer line, and ILink.range is
            // restricted to a single y, so each line owns its own slice.
            let segStart = startIdx;
            while (segStart <= endIdx) {
              const segLine = cellLine[segStart];
              let segEnd = segStart;
              while (segEnd + 1 <= endIdx && cellLine[segEnd + 1] === segLine) {
                segEnd += 1;
              }
              if (segLine === bufferLineNumber) {
                links.push({
                  range: {
                    start: {
                      x: cellStartCol[segStart],
                      y: bufferLineNumber,
                    },
                    end: { x: cellEndCol[segEnd], y: bufferLineNumber },
                  },
                  text: text.slice(segStart, segEnd + 1),
                  activate: (event) => {
                    if (event.button !== 0 && event.button !== 1) return;
                    window.open(url, "_blank", "noopener,noreferrer");
                  },
                });
              }
              segStart = segEnd + 1;
            }
          }

          callback(links.length ? links : undefined);
        },
      });

      // TEMP DIAGNOSTIC — log OSC 8 escape sequences as they arrive so we
      // can confirm whether Claude Code is actually emitting hyperlinks for
      // markdown `[label](url)` output. Returning false leaves xterm's
      // native OSC 8 handler in charge.
      try {
        term.parser.registerOscHandler(8, (data) => {
          console.log("[xterm OSC 8]", JSON.stringify(data));
          return false;
        });
      } catch (e) {
        console.warn("[xterm registerOscHandler failed]", e);
      }

      term.open(host);

      // Temporarily disabled while diagnosing why markdown links aren't
      // clickable — the WebGL renderer has historically had gaps around
      // hyperlink hover/click rendering. Re-enable once the link issue
      // is understood.
      // try {
      //   const { WebglAddon } = await import("@xterm/addon-webgl");
      //   const webgl = new WebglAddon();
      //   webgl.onContextLoss(() => webgl.dispose());
      //   term.loadAddon(webgl);
      // } catch {
      //   /* WebGL not available; fall back to canvas/DOM renderer */
      // }

      termRef.current = term;
      fitRef.current = fit;

      // Shift+Enter sends the literal backslash + CR pair (0x5c 0x0d).
      // Claude Code's input parser treats `\` immediately followed by Enter
      // as "insert newline, don't submit" in every terminal regardless of
      // keyboard-protocol negotiation. The CSI u variant (ESC[13;2u) only
      // works once Claude Code has DECSET kitty keyboard mode and the
      // terminal chain (xterm.js -> tmux -> claude) all agree on the
      // protocol — fragile in our setup. The backslash-Enter convention is
      // what `/terminal-setup` configures iTerm2/VS Code/WezTerm to emit.
      // Ctrl+C copies the current selection when there is one (otherwise it
      // falls through as SIGINT). Ctrl+V pastes from the browser clipboard.
      const isCoarsePointer =
        typeof window !== "undefined" &&
        window.matchMedia?.("(pointer: coarse)").matches;

      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;

        // IME composition (Korean, Japanese, Chinese, etc.) — let xterm's
        // textarea handle it via composition events. Returning true here
        // would have xterm try to interpret a 229/Unidentified keydown as
        // a literal key, which corrupts or drops the composed character.
        if (
          ev.isComposing ||
          ev.keyCode === 229 ||
          ev.key === "Process" ||
          ev.key === "Unidentified"
        ) {
          return true;
        }

        // Mobile/touch: skip the desktop chord shortcuts entirely. They
        // only matter for hardware-keyboard chords (Shift+Enter, Ctrl+C,
        // Ctrl+V, Ctrl+Backspace), and intercepting keydown on Android
        // Gboard / iOS keyboards has been observed to drop or duplicate
        // characters around space and Enter when an IME is composing.
        if (isCoarsePointer) return true;

        if (
          ev.key === "Enter" &&
          ev.shiftKey &&
          !ev.ctrlKey &&
          !ev.altKey &&
          !ev.metaKey
        ) {
          // Returning false from xterm's custom handler stops xterm's own
          // processing but does NOT cancel the browser default — the hidden
          // textarea would otherwise insert "\n" and xterm would forward
          // that as a stray byte right after our manual "\\\r", which
          // Claude Code then sees as a submit. preventDefault keeps the
          // textarea silent so only our two bytes reach the pty.
          ev.preventDefault();
          ev.stopPropagation();
          // Defer the actual send by one task tick. When a Korean IME (or
          // any other composing IME) is on the last character of a run,
          // the browser commits that character on the Enter keydown and
          // fires the `input` event immediately after our handler. If we
          // send "\\\r" synchronously here, the committed character (e.g.
          // the "요" in "안녕하세요") arrives at the pty AFTER our newline
          // payload — Claude Code then renders it as `안녕하세\n요`. A
          // setTimeout 0 lets the input event flush the composed text via
          // term.onData first, so the bytes hit the pty in the right
          // order: composed text, then newline.
          setTimeout(() => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(new TextEncoder().encode("\\\r"));
            }
          }, 0);
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

  const stopBriefingAudio = useCallback(() => {
    const audio = briefingAudioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* noop */
      }
      audio.src = "";
      briefingAudioRef.current = null;
    }
    const url = briefingAudioUrlRef.current;
    if (url) {
      URL.revokeObjectURL(url);
      briefingAudioUrlRef.current = null;
    }
  }, []);

  // Single in-flight briefing slot. Replacing the pending entry rejects the
  // previous one so we never hang multiple resolvers.
  const sendBriefingRequest = useCallback(
    (payload: { type: "briefing_inject" | "briefing_synth"; text?: string }, timeoutMs: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
      const prev = briefingPendingRef.current;
      if (prev) {
        clearTimeout(prev.timer);
        prev.resolve(null);
        briefingPendingRef.current = null;
      }
      return new Promise<BriefingMsg | null>((resolve) => {
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
        const timer = setTimeout(() => {
          if (briefingPendingRef.current?.id === id) {
            briefingPendingRef.current = null;
            resolve(null);
          }
        }, timeoutMs);
        briefingPendingRef.current = { id, resolve, timer };
        try {
          ws.send(JSON.stringify({ ...payload, id }));
        } catch {
          clearTimeout(timer);
          briefingPendingRef.current = null;
          resolve(null);
        }
      });
    },
    [],
  );

  // Wait until xterm hasn't received any new pty bytes for `quietMs`. Caller
  // passes `since` (timestamp captured *after* the inject ack) so we don't
  // mistake pre-injection idleness for the response settling.
  const waitForTerminalSettle = useCallback(
    (since: number, quietMs: number, maxMs: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          const now = Date.now();
          if (now - startedAt > maxMs) {
            // Timed out without observing a quiet stretch. The buffer may
            // still hold a usable response, so we report timeout=false and
            // let the caller decide whether to scrape anyway.
            resolve(false);
            return;
          }
          const last = lastTermDataAtRef.current;
          // Settled only if (a) we've seen at least one byte after the
          // inject and (b) it's been quiet for the full quietMs.
          if (last >= since && now - last >= quietMs) {
            resolve(true);
            return;
          }
          setTimeout(tick, 200);
        };
        tick();
      });
    },
    [],
  );

  // Pull the most recent assistant text out of the xterm scrollback. Strips
  // Claude TUI box drawing (╭─╮ │>│ ╰─╯) and the status footer; returns the
  // contiguous run of plain lines just above the input box.
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

    return cleaned.slice(0, 2000);
  }, []);

  const playBase64Audio = useCallback(
    (base64: string, mime: string): Promise<void> => {
      stopBriefingAudio();
      const bin = atob(base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      briefingAudioUrlRef.current = url;
      const audio = new Audio(url);
      briefingAudioRef.current = audio;
      return new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          stopBriefingAudio();
          resolve();
        };
        audio.onerror = () => {
          stopBriefingAudio();
          reject(new Error("audio playback failed"));
        };
        audio.play().catch((err) => {
          stopBriefingAudio();
          reject(err);
        });
      });
    },
    [stopBriefingAudio],
  );

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
    if (briefingState === "playing") {
      stopBriefingAudio();
      setBriefingState("idle");
      return;
    }
    if (briefingState === "loading") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setBanner("WebSocket이 연결되어 있지 않습니다.");
      return;
    }

    setBriefingState("loading");
    setBanner("Claude에게 /btw 브리핑을 요청하는 중…");
    const reasonMessages: Record<string, string> = {
      claude_not_running: "이 세션에서 Claude Code가 실행 중이 아닙니다.",
      no_api_key: "OPENROUTER_API_KEY가 설정되어 있지 않습니다.",
      empty_text: "브리핑 응답을 추출하지 못했습니다.",
    };

    // Phase 1: ask the gateway to inject `/btw <prompt>` into the TUI.
    const injectAt = Date.now();
    const inject = await sendBriefingRequest({ type: "briefing_inject" }, 15_000);
    if (!inject) {
      setBanner("브리핑 요청이 시간 초과되었습니다.");
      setBriefingState("idle");
      return;
    }
    if (inject.type === "briefing_error") {
      const reason = inject.reason ?? "error";
      setBanner(reasonMessages[reason] ?? `브리핑 실패: ${reason}`);
      setBriefingState("idle");
      return;
    }
    if (inject.type !== "briefing_inject_ok") {
      setBanner("예상치 못한 응답을 받았습니다.");
      setBriefingState("idle");
      return;
    }

    // Phase 2: wait for the TUI to render and settle, then scrape the
    // visible answer out of the xterm buffer. /btw doesn't write to
    // ~/.claude/projects/*.jsonl, so the buffer is the only source of truth.
    setBanner("Claude의 답변을 기다리는 중…");
    await waitForTerminalSettle(injectAt, 2_000, 60_000);
    const scraped = extractLastAssistantText();
    if (!scraped) {
      setBanner("브리핑 응답을 화면에서 찾지 못했습니다.");
      setBriefingState("idle");
      return;
    }

    // Phase 3: synthesize via OpenRouter on the gateway.
    setBanner("음성 합성 중…");
    const synth = await sendBriefingRequest(
      { type: "briefing_synth", text: scraped },
      120_000,
    );
    if (!synth) {
      setBanner("음성 합성이 시간 초과되었습니다.");
      setBriefingState("idle");
      return;
    }
    if (synth.type === "briefing_error") {
      const reason = synth.reason ?? "error";
      setBanner(reasonMessages[reason] ?? `음성 합성 실패: ${reason}`);
      setBriefingState("idle");
      return;
    }
    if (synth.type !== "briefing_audio") {
      setBanner("예상치 못한 응답을 받았습니다.");
      setBriefingState("idle");
      return;
    }

    setBanner(null);
    setBriefingState("playing");
    try {
      await playBase64Audio(synth.audio, synth.mime || "audio/wav");
    } catch {
      setBanner("음성 재생에 실패했습니다.");
    } finally {
      setBriefingState("idle");
    }
  }, [
    briefingState,
    extractLastAssistantText,
    playBase64Audio,
    sendBriefingRequest,
    stopBriefingAudio,
    waitForTerminalSettle,
  ]);

  useEffect(() => {
    return () => {
      stopBriefingAudio();
      const pending = briefingPendingRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        briefingPendingRef.current = null;
      }
    };
  }, [stopBriefingAudio]);

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
          disabled={briefingState === "loading"}
          aria-busy={briefingState === "loading"}
          aria-pressed={briefingState === "playing"}
          title={
            briefingState === "playing"
              ? "음성 정지"
              : briefingState === "loading"
                ? "Claude 브리핑 준비 중…"
                : "Claude에게 대화 브리핑을 요청하고 음성으로 들려줍니다"
          }
        >
          {briefingState === "playing"
            ? "⏹ 정지"
            : briefingState === "loading"
              ? "⏳ 브리핑…"
              : "🔊 브리핑"}
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
