"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";

interface Props {
  src: string;
}

// Lazy ESM import so the bundle stays out of the initial chunk and Node-only
// code paths in pdfjs are never reached during SSR. The worker is shipped as
// a static file under /public/pdfjs/ (see scripts.copy-pdf-worker) so the
// browser fetches it from the same origin without bundler-specific imports.
async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  return pdfjs;
}

export function PdfCanvasViewer({ src }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    const renderTasks: RenderTask[] = [];

    setStatus("loading");
    setError(null);
    setPageCount(0);
    if (hostRef.current) hostRef.current.innerHTML = "";

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

          const canvas = document.createElement("canvas");
          canvas.className = "fv-pdf-page";
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          host.appendChild(canvas);

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
