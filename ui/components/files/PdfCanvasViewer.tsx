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
// base16 methods) and Map.prototype.getOrInsertComputed (TC39 upsert
// proposal). iOS Safari < 18.4 and older Chromes don't ship these yet, so
// installing tiny polyfills on first load lets pdf.js run on those browsers.
function polyfillForPdfJs(): void {
  const u8 = Uint8Array.prototype as Uint8Array & {
    toHex?: () => string;
    setFromHex?: (hex: string) => { read: number; written: number };
  };
  if (typeof u8.toHex !== "function") {
    Object.defineProperty(u8, "toHex", {
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
  if (typeof u8.setFromHex !== "function") {
    Object.defineProperty(u8, "setFromHex", {
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
  const mapProto = Map.prototype as Map<unknown, unknown> & {
    getOrInsertComputed?: <K, V>(key: K, cb: (key: K) => V) => V;
  };
  if (typeof mapProto.getOrInsertComputed !== "function") {
    Object.defineProperty(mapProto, "getOrInsertComputed", {
      value: function getOrInsertComputed<K, V>(
        this: Map<K, V>,
        key: K,
        callbackfn: (key: K) => V,
      ): V {
        if (typeof callbackfn !== "function") {
          throw new TypeError("callbackfn must be a function");
        }
        if (this.has(key)) return this.get(key) as V;
        const value = callbackfn(key);
        this.set(key, value);
        return value;
      },
      configurable: true,
      writable: true,
    });
  }
  const wmProto = WeakMap.prototype as WeakMap<object, unknown> & {
    getOrInsertComputed?: <K extends object, V>(
      key: K,
      cb: (key: K) => V,
    ) => V;
  };
  if (typeof wmProto.getOrInsertComputed !== "function") {
    Object.defineProperty(wmProto, "getOrInsertComputed", {
      value: function getOrInsertComputed<K extends object, V>(
        this: WeakMap<K, V>,
        key: K,
        callbackfn: (key: K) => V,
      ): V {
        if (typeof callbackfn !== "function") {
          throw new TypeError("callbackfn must be a function");
        }
        if (this.has(key)) return this.get(key) as V;
        const value = callbackfn(key);
        this.set(key, value);
        return value;
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
  polyfillForPdfJs();
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=polyfill2";
  return pdfjs;
}

export function PdfCanvasViewer({ src, notes }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const noteNodesRef = useRef<HTMLDivElement[]>([]);
  const slotsRef = useRef<HTMLDivElement[]>([]);
  const jumpInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpEditing, setJumpEditing] = useState(false);
  const [jumpValue, setJumpValue] = useState("");

  function jumpToPage(target: number) {
    if (!Number.isFinite(target)) return;
    const clamped = Math.min(Math.max(Math.round(target), 1), pageCount || 1);
    const slot = slotsRef.current[clamped - 1];
    if (!slot) return;
    slot.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(clamped);
  }

  function commitJump() {
    const n = parseInt(jumpValue, 10);
    if (Number.isFinite(n)) jumpToPage(n);
    setJumpEditing(false);
  }

  useEffect(() => {
    if (jumpEditing) {
      jumpInputRef.current?.focus();
      jumpInputRef.current?.select();
    }
  }, [jumpEditing]);

  // Track which slide is most visible inside the scroll container so the
  // page indicator can mirror "page X of Y" without controlling scroll.
  useEffect(() => {
    if (status !== "ready" || pageCount === 0) return;
    const root = scrollRef.current;
    if (!root) return;

    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(
            (entry.target as HTMLElement).dataset.page || "0",
          );
          if (!page) continue;
          ratios.set(page, entry.intersectionRatio);
        }
        let bestPage = 0;
        let bestRatio = -1;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = page;
          }
        }
        if (bestPage > 0) setCurrentPage(bestPage);
      },
      {
        root,
        // Steps so a slide that's only partly in view still reports a
        // ratio we can compare against its neighbors.
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const slot of slotsRef.current) {
      if (slot) observer.observe(slot);
    }

    return () => observer.disconnect();
  }, [status, pageCount]);

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
    setCurrentPage(1);
    if (hostRef.current) hostRef.current.innerHTML = "";
    noteNodesRef.current = [];
    slotsRef.current = [];

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;

        const loadingTask = pdfjs.getDocument({
          url: src,
          withCredentials: true,
          // Pull the whole file in one go. /api/fs/render doesn't advertise
          // Accept-Ranges, and pdf.js + a non-range server with auto-fetch
          // disabled used to drop on-demand font fetches mid-deck — late
          // pages then rendered with system-font fallback (random ASCII).
          disableAutoFetch: false,
          disableStream: false,
          disableRange: true,
          // Some Android browsers (notably Samsung Internet) have shaky
          // OffscreenCanvas implementations that mis-rasterize embedded
          // CFF outlines, producing garbled glyphs. Forcing main-thread
          // canvas keeps rendering deterministic across browsers.
          isOffscreenCanvasSupported: false,
          // iOS Safari rejects most of the OTFs pdf.js synthesizes from
          // CFF Type 0 fonts (LibreOffice's output for Korean PPTX), and
          // when the @font-face load fails pdf.js silently falls back to
          // drawing each glyph with the system font and the original byte
          // codes — CID sequences then surface as random uppercase ASCII
          // ("AKSBXHDJDKWN"). Forcing the Path2D path everywhere bypasses
          // the FontFace pipeline entirely so glyphs come straight from
          // the embedded outlines. Desktop loses a small amount of speed
          // but keeps perfectly correct text, which is the priority for
          // a read-only preview.
          disableFontFace: true,
          // Don't try to substitute embedded fonts with locally installed
          // system fonts — the local copy can disagree with the PDF's
          // encoding/CMap and produce garbled output even when the
          // embedded font would have rendered fine.
          useSystemFonts: false,
          // CIDFont character-code → glyph maps. PPTX-converted PDFs that
          // use Korean text reference predefined CMaps like KSCms-UHC-H;
          // without these files pdf.js can't decode the codes and renders
          // Hangul as random ASCII letters. Files are copied into
          // /public/pdfjs/ by scripts/copy-pdf-worker.mjs.
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
        });
        doc = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(doc.numPages);

        const host = hostRef.current;
        if (!host) return;

        // Render the bitmap at viewport × DPR (clamped) for crispness, and
        // let CSS scale the canvas to the container width via `width: 100%;
        // height: auto`. We deliberately do NOT key the bitmap size off the
        // host's clientWidth — on mobile the file pane sometimes mounts with
        // 0 clientWidth, which used to collapse slots to zero width and made
        // only speaker notes visible.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          if (cancelled) return;

          const page: PDFPageProxy = await doc.getPage(pageNum);
          if (cancelled) return;

          const viewport = page.getViewport({ scale: dpr });

          const slot = document.createElement("div");
          slot.className = "fv-pdf-slot";
          slot.dataset.page = String(pageNum);
          host.appendChild(slot);
          slotsRef.current[pageNum - 1] = slot;

          const canvas = document.createElement("canvas");
          canvas.className = "fv-pdf-page";
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
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
          const task = page.render({
            canvas,
            canvasContext: ctx,
            viewport,
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
    <div className="fv-pdf-wrap">
      <div className="fv-pdf-canvas" ref={scrollRef}>
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
      {status === "ready" && pageCount > 0 ? (
        jumpEditing ? (
          <form
            className="fv-pdf-pageind editing"
            onSubmit={(e) => {
              e.preventDefault();
              commitJump();
            }}
          >
            <input
              ref={jumpInputRef}
              className="fv-pdf-pageind-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              value={jumpValue}
              onChange={(e) => setJumpValue(e.target.value)}
              onBlur={commitJump}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setJumpEditing(false);
                }
              }}
              aria-label={`페이지 이동 (1-${pageCount})`}
            />
            <span> / {pageCount}</span>
          </form>
        ) : (
          <button
            type="button"
            className="fv-pdf-pageind"
            onClick={() => {
              setJumpValue(String(currentPage));
              setJumpEditing(true);
            }}
            aria-label={`현재 페이지 ${currentPage} / ${pageCount}, 클릭하여 페이지 이동`}
            title="클릭하여 페이지 이동"
          >
            {currentPage} / {pageCount}
          </button>
        )
      ) : null}
    </div>
  );
}
