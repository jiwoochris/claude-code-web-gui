"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";

interface Props {
  src: string;
  // Per-slide speaker notes, in slide order. notes[i] is rendered below
  // page i+1 if non-empty. Updates after the document is rendered are
  // applied without re-rendering the canvases.
  notes?: string[];
}

// pdf.js 5.x calls Uint8Array.prototype.toHex/setFromHex (TC39 Uint8Array
// base16 methods). iOS Safari < 18.2 and older Chromes don't ship them yet,
// so installing a tiny polyfill on first load lets pdf.js run on those
// browsers.
function polyfillUint8ArrayBase16(): void {
  const proto = Uint8Array.prototype as Uint8Array & {
    toHex?: () => string;
    setFromHex?: (hex: string) => { read: number; written: number };
  };
  if (typeof proto.toHex !== "function") {
    Object.defineProperty(proto, "toHex", {
      value: function toHex(this: Uint8Array): string {
        let out = "";
        for (let i = 0; i < this.length; i++) {
          out += this[i].toString(16).padStart(2, "0");
        }
        return out;
      },
      configurable: true,
      writable: true,
    });
  }
  if (typeof proto.setFromHex !== "function") {
    Object.defineProperty(proto, "setFromHex", {
      value: function setFromHex(this: Uint8Array, hex: string) {
        const clean = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1);
        const max = Math.min(clean.length / 2, this.length);
        let read = 0;
        for (let i = 0; i < max; i++) {
          const byte = parseInt(clean.substr(i * 2, 2), 16);
          if (Number.isNaN(byte)) break;
          this[i] = byte;
          read = i + 1;
        }
        return { read: read * 2, written: read };
      },
      configurable: true,
      writable: true,
    });
  }
}

// Lazy ESM import so the bundle stays out of the initial chunk and Node-only
// code paths in pdfjs are never reached during SSR. The worker is shipped as
// a static file under /public/pdfjs/ (see scripts.copy-pdf-worker) so the
// browser fetches it from the same origin without bundler-specific imports.
async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  polyfillUint8ArrayBase16();
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=polyfill1";
  return pdfjs;
}

export function PdfCanvasViewer({ src, notes }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const noteNodesRef = useRef<HTMLDivElement[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  // Re-apply notes whenever they change without re-rendering canvases.
  useEffect(() => {
    for (let i = 0; i < noteNodesRef.current.length; i++) {
      const node = noteNodesRef.current[i];
      if (!node) continue;
      const text = notes?.[i]?.trim() ?? "";
      if (text) {
        node.textContent = text;
        node.style.display = "";
      } else {
        node.textContent = "";
        node.style.display = "none";
      }
    }
  }, [notes, pageCount, status]);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    const renderTasks: RenderTask[] = [];

    setStatus("loading");
    setError(null);
    setPageCount(0);
    if (hostRef.current) hostRef.current.innerHTML = "";
    noteNodesRef.current = [];

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;

        const loadingTask = pdfjs.getDocument({
          url: src,
          withCredentials: true,
          // Keep memory bounded for long decks on phones.
          disableAutoFetch: true,
          disableStream: false,
        });
        doc = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(doc.numPages);

        const host = hostRef.current;
        if (!host) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          if (cancelled) return;

          const page: PDFPageProxy = await doc.getPage(pageNum);
          if (cancelled) return;

          const viewportBase = page.getViewport({ scale: 1 });
          const cssWidth = host.clientWidth || viewportBase.width;
          const scale = cssWidth / viewportBase.width;
          const viewport = page.getViewport({ scale });

          const slot = document.createElement("div");
          slot.className = "fv-pdf-slot";
          slot.style.width = `${Math.floor(viewport.width)}px`;
          host.appendChild(slot);

          const canvas = document.createElement("canvas");
          canvas.className = "fv-pdf-page";
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          slot.appendChild(canvas);

          const noteNode = document.createElement("div");
          noteNode.className = "fv-pdf-note";
          const initialNote = notes?.[pageNum - 1]?.trim() ?? "";
          if (initialNote) {
            noteNode.textContent = initialNote;
          } else {
            noteNode.style.display = "none";
          }
          slot.appendChild(noteNode);
          noteNodesRef.current[pageNum - 1] = noteNode;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            page.cleanup();
            continue;
          }
          const transform =
            dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] as const : null;
          const task = page.render({
            canvas,
            canvasContext: ctx,
            viewport,
            transform: transform ? Array.from(transform) : undefined,
          });
          renderTasks.push(task);
          try {
            await task.promise;
          } catch (e) {
            if (cancelled) return;
            throw e;
          } finally {
            page.cleanup();
          }
        }

        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message || "PDF 로드 실패");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      for (const t of renderTasks) {
        try {
          t.cancel();
        } catch {
          /* ignore */
        }
      }
      doc?.cleanup().catch(() => {});
      doc?.destroy().catch(() => {});
    };
  }, [src]);

  return (
    <div className="fv-pdf-canvas">
      {status === "loading" ? (
        <div className="fv-loading">PDF 불러오는 중…</div>
      ) : null}
      {status === "error" ? (
        <div className="err">PDF 표시 실패: {error}</div>
      ) : null}
      <div
        ref={hostRef}
        className="fv-pdf-pages"
        data-pages={pageCount || undefined}
      />
    </div>
  );
}
