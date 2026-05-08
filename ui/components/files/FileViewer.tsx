"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const PdfCanvasViewer = dynamic(
  () => import("./PdfCanvasViewer").then((m) => m.PdfCanvasViewer),
  { ssr: false, loading: () => <div className="fv-loading">PDF 불러오는 중…</div> },
);

const MarkdownViewer = dynamic(
  () => import("./MarkdownViewer").then((m) => m.MarkdownViewer),
  { ssr: false, loading: () => <div className="fv-loading">마크다운 렌더링…</div> },
);

function isMarkdownPath(p: string | null): boolean {
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown");
}

export function isHtmlPath(p: string | null): boolean {
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function useIsTouchDevice(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setTouch(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return touch;
}

const MonacoEditor = dynamic(async () => {
  // Silence Monaco's worker warning. Read-only previews don't need language
  // workers; the fallback tokenizes on the main thread, which is fine here.
  if (typeof window !== "undefined") {
    (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker() {
        const blob = new Blob(["self.onmessage = () => {};"], {
          type: "application/javascript",
        });
        return new Worker(URL.createObjectURL(blob));
      },
    };
  }
  const [{ loader, Editor }, monaco] = await Promise.all([
    import("@monaco-editor/react"),
    import("monaco-editor"),
  ]);
  loader.config({ monaco });
  return Editor;
}, { ssr: false, loading: () => <div className="fv-loading">에디터를 불러오는 중…</div> });

function languageFromPath(p: string | null): string {
  if (!p) return "plaintext";
  const lower = p.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    mdx: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sql: "sql",
    xml: "xml",
    svg: "xml",
    dockerfile: "dockerfile",
  };
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return map[ext] ?? "plaintext";
}

export type PreviewState =
  | { kind: "empty" }
  | { kind: "loading"; path: string }
  | { kind: "text"; path: string; content: string }
  | { kind: "image"; path: string; src: string; mime: string }
  | {
      kind: "pdf";
      path: string;
      src: string;
      renderedFromOffice: boolean;
      sourceExt?: string;
      notes?: string[];
    }
  | { kind: "unavailable"; path: string; reason: "too_large" | "binary"; size: number; mime: string }
  | { kind: "error"; path: string; message: string };

interface Props {
  state: PreviewState;
  onDownload: (path: string) => void;
  markdownRaw?: boolean;
  htmlRaw?: boolean;
}

export function FileViewer({
  state,
  onDownload,
  markdownRaw = false,
  htmlRaw = false,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const isTouch = useIsTouchDevice();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (state.kind === "empty") {
    return (
      <div className="fv-empty">
        <div className="muted">왼쪽 트리에서 파일을 선택하세요.</div>
      </div>
    );
  }

  if (state.kind === "loading") {
    return <div className="fv-empty"><div className="muted">{state.path} 불러오는 중…</div></div>;
  }

  if (state.kind === "error") {
    return (
      <div className="fv-empty">
        <div className="err">불러오기 실패: {state.message}</div>
        <button className="btn" onClick={() => onDownload(state.path)}>
          ⬇ 다운로드 시도
        </button>
      </div>
    );
  }

  if (state.kind === "pdf") {
    // For pptx renders we always use the canvas viewer so per-slide speaker
    // notes can be inlined under each page. Other PDFs keep the native
    // browser viewer on desktop for its zoom/search controls.
    const useCanvas = isTouch || state.sourceExt === "pptx";
    return (
      <div className="fv-pdf">
        {useCanvas ? (
          <PdfCanvasViewer src={state.src} notes={state.notes} />
        ) : (
          <iframe
            className="fv-pdf-frame"
            src={state.src}
            title={state.path}
          />
        )}
      </div>
    );
  }

  if (state.kind === "image") {
    return (
      <div className="fv-image">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.src} alt={state.path} />
        <div className="fv-foot">
          <span className="muted">{state.mime}</span>
          <button className="btn" onClick={() => onDownload(state.path)}>
            ⬇ 다운로드
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "unavailable") {
    const reason = state.reason === "binary"
      ? "바이너리 파일은 미리보기가 없습니다."
      : "파일이 너무 큽니다 (2MB 초과).";
    return (
      <div className="fv-empty">
        <div className="muted">{reason}</div>
        <div className="muted small">
          {state.mime} · {formatBytes(state.size)}
        </div>
        <button className="btn primary" onClick={() => onDownload(state.path)}>
          ⬇ 다운로드
        </button>
      </div>
    );
  }

  // text
  const isMd = isMarkdownPath(state.path);
  const isHtml = isHtmlPath(state.path);
  return (
    <div className="fv-text">
      {isMd && !markdownRaw ? (
        <div className="fv-md-host">
          <MarkdownViewer source={state.content} basePath={state.path} />
        </div>
      ) : isHtml && !htmlRaw ? (
        <iframe
          className="fv-html-frame"
          title={state.path}
          srcDoc={state.content}
          // No allow-same-origin: scripts run, but the iframe is a null
          // origin and can't read this app's cookies/storage. allow-popups
          // lets target=_blank links work; allow-forms lets demo forms
          // submit to their own action URL.
          sandbox="allow-scripts allow-popups allow-forms"
          referrerPolicy="no-referrer"
        />
      ) : (
      <div ref={hostRef} className="fv-editor-host">
        {mounted ? (
          <MonacoEditor
            height="100%"
            path={state.path}
            language={languageFromPath(state.path)}
            value={state.content}
            theme="vs"
            onMount={(editor) => {
              // On touch devices, Monaco's hidden <textarea.inputarea>
              // grabs focus when the user taps to scroll, which triggers
              // the on-screen keyboard. The editor is read-only here, so
              // we make the textarea unable to summon the keyboard.
              if (
                typeof window === "undefined" ||
                !window.matchMedia?.("(pointer: coarse)").matches
              ) {
                return;
              }
              const root = editor.getDomNode();
              const ta = root?.querySelector<HTMLTextAreaElement>(
                "textarea.inputarea",
              );
              if (ta) {
                ta.setAttribute("readonly", "");
                ta.setAttribute("inputmode", "none");
                ta.setAttribute("aria-hidden", "true");
                ta.tabIndex = -1;
              }
            }}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              renderWhitespace: "selection",
              wordWrap: "on",
              wrappingStrategy: "advanced",
              automaticLayout: true,
            }}
          />
        ) : null}
      </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
