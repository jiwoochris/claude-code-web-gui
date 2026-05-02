"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Terminal } from "./Terminal";
import { FileViewer } from "./files/FileViewer";
import { useFiles } from "./files/FilesProvider";

type MobileTab = "file" | "term";

const STORAGE_KEY = "session-split:v1";

function loadRatio(): number {
  if (typeof window === "undefined") return 0.5;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0.5;
    const n = parseFloat(raw);
    if (isNaN(n) || n <= 0.1 || n >= 0.9) return 0.5;
    return n;
  } catch {
    return 0.5;
  }
}

interface Props {
  name: string;
}

export function SessionShell({ name }: Props) {
  const { selected, preview, closeFile, download } = useFiles();
  const [ratio, setRatio] = useState(0.5);
  const [hydrated, setHydrated] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("term");
  const [isMobile, setIsMobile] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRatio(loadRatio());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // When a file is opened on mobile, jump to the file tab.
  useEffect(() => {
    if (selected && isMobile) setMobileTab("file");
  }, [selected, isMobile]);

  useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem(STORAGE_KEY, String(ratio));
      } catch {
        /* ignore */
      }
    }
  }, [ratio, hydrated]);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const split = splitRef.current;
      if (!split) return;
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const rect = split.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const offset = ev.clientY - rect.top;
        let r = offset / rect.height;
        if (r < 0.15) r = 0.15;
        if (r > 0.85) r = 0.85;
        setRatio(r);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const hasFile = selected !== null;

  if (!hasFile) {
    return (
      <div className="session-shell">
        <div className="session-pane term-only">
          <Terminal name={name} />
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="session-shell">
        <div className="session-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mobileTab === "file"}
            className={mobileTab === "file" ? "active" : ""}
            onClick={() => setMobileTab("file")}
          >
            📄 파일
          </button>
          <button
            role="tab"
            aria-selected={mobileTab === "term"}
            className={mobileTab === "term" ? "active" : ""}
            onClick={() => setMobileTab("term")}
          >
            💻 터미널
          </button>
          <span className="spacer" />
          <button
            className="close"
            onClick={closeFile}
            title="파일 닫기"
            aria-label="파일 닫기"
          >
            ✕
          </button>
        </div>
        <div className="session-mobile-body">
          {mobileTab === "file" ? (
            <div className="session-pane file-pane">
              <FileViewer state={preview} onDownload={download} />
            </div>
          ) : (
            <div className="session-pane term-pane">
              <Terminal name={name} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const topPct = `${Math.round(ratio * 100)}%`;

  return (
    <div className="session-shell">
      <div className="session-split" ref={splitRef}>
        <div
          className="session-pane file-pane"
          style={{ flex: `0 0 ${topPct}` }}
        >
          <div className="session-file-bar">
            <span className="path" title={selected ?? ""}>{selected}</span>
            <span className="spacer" />
            <button
              className="close"
              onClick={closeFile}
              title="파일 닫기"
              aria-label="파일 닫기"
            >
              ✕
            </button>
          </div>
          <div className="session-file-host">
            <FileViewer state={preview} onDownload={download} />
          </div>
        </div>
        <div
          className="session-resizer"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="파일/터미널 비율 조절"
        />
        <div className="session-pane term-pane" style={{ flex: "1 1 auto" }}>
          <Terminal name={name} />
        </div>
      </div>
    </div>
  );
}
