"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionsSection } from "./SessionsSection";
import { FilesSection } from "./FilesSection";

type SectionId = "sessions" | "files";

const STORAGE_KEY = "lnb:v1";

type Persisted = {
  open: Record<SectionId, boolean>;
  ratio: number; // 0..1, share of sessions section when both open
  width: number; // px, LNB width on desktop
};

const LNB_MIN_W = 200;
const LNB_MAX_W = 560;

const DEFAULT_STATE: Persisted = {
  open: { sessions: true, files: true },
  ratio: 0.45,
  width: 280,
};

function loadState(): Persisted {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const width =
      typeof parsed.width === "number" && parsed.width >= LNB_MIN_W && parsed.width <= LNB_MAX_W
        ? parsed.width
        : DEFAULT_STATE.width;
    return {
      open: {
        sessions: parsed.open?.sessions ?? true,
        files: parsed.open?.files ?? true,
      },
      ratio:
        typeof parsed.ratio === "number" && parsed.ratio > 0.1 && parsed.ratio < 0.9
          ? parsed.ratio
          : DEFAULT_STATE.ratio,
      width,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persist(state: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function Lnb() {
  const pathname = usePathname();
  const [lnbOpen, setLnbOpen] = useState(false);
  const [state, setState] = useState<Persisted>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) persist(state);
  }, [state, hydrated]);

  useEffect(() => {
    setLnbOpen(false);
  }, [pathname]);

  const toggleSection = useCallback((id: SectionId) => {
    setState((prev) => {
      const next = { ...prev.open, [id]: !prev.open[id] };
      // Force at least one section open (otherwise the resizer/body looks empty).
      if (!next.sessions && !next.files) next[id === "sessions" ? "files" : "sessions"] = true;
      return { ...prev, open: next };
    });
  }, []);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const body = bodyRef.current;
      if (!body) return;
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const rect = body.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const offset = ev.clientY - rect.top;
        let ratio = offset / rect.height;
        if (ratio < 0.15) ratio = 0.15;
        if (ratio > 0.85) ratio = 0.85;
        setState((prev) => ({ ...prev, ratio }));
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

  const startWidthResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      document.body.classList.add("col-resizing");
      const onMove = (ev: PointerEvent) => {
        let w = ev.clientX;
        if (w < LNB_MIN_W) w = LNB_MIN_W;
        if (w > LNB_MAX_W) w = LNB_MAX_W;
        setState((prev) => ({ ...prev, width: w }));
      };
      const onUp = () => {
        document.body.classList.remove("col-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    window.location.href = "/login";
  };

  const bothOpen = state.open.sessions && state.open.files;
  const ratioPct = useMemo(() => `${Math.round(state.ratio * 100)}%`, [state.ratio]);

  return (
    <>
      <div className="mobile-bar">
        <button onClick={() => setLnbOpen((v) => !v)} aria-label="사이드바 열기">
          ☰
        </button>
        <div className="title">Claude Code Web GUI</div>
      </div>

      <div
        className={`lnb-backdrop${lnbOpen ? " show" : ""}`}
        onClick={() => setLnbOpen(false)}
      />

      <aside
        className={`lnb${lnbOpen ? " open" : ""}`}
        aria-label="사이드바"
        style={hydrated ? { width: state.width, flexBasis: state.width } : undefined}
      >
        <Link href="/" className="lnb-brand">
          <div className="title">Claude Code</div>
          <div className="subtitle">Web GUI</div>
        </Link>

        <div className="lnb-body" ref={bodyRef}>
          <section
            className={`lnb-section${state.open.sessions ? " open" : ""}`}
            style={
              bothOpen
                ? { flex: `0 0 ${ratioPct}` }
                : state.open.sessions
                  ? { flex: "1 1 auto" }
                  : { flex: "0 0 auto" }
            }
          >
            <button
              type="button"
              className="lnb-section-header"
              onClick={() => toggleSection("sessions")}
              aria-expanded={state.open.sessions}
            >
              <span className="caret">{state.open.sessions ? "▾" : "▸"}</span>
              <span className="label">세션</span>
            </button>
            {state.open.sessions ? (
              <div className="lnb-section-body">
                <SessionsSection />
              </div>
            ) : null}
          </section>

          {bothOpen ? (
            <div
              className="lnb-resizer"
              onPointerDown={startResize}
              role="separator"
              aria-orientation="horizontal"
              aria-label="섹션 크기 조절"
            />
          ) : null}

          <section
            className={`lnb-section${state.open.files ? " open" : ""}`}
            style={
              bothOpen
                ? { flex: "1 1 auto" }
                : state.open.files
                  ? { flex: "1 1 auto" }
                  : { flex: "0 0 auto" }
            }
          >
            <button
              type="button"
              className="lnb-section-header"
              onClick={() => toggleSection("files")}
              aria-expanded={state.open.files}
            >
              <span className="caret">{state.open.files ? "▾" : "▸"}</span>
              <span className="label">파일</span>
            </button>
            {state.open.files ? (
              <div className="lnb-section-body">
                <FilesSection />
              </div>
            ) : null}
          </section>
        </div>

        <div className="lnb-footer">
          <button onClick={logout}>로그아웃</button>
        </div>

        <div
          className="lnb-width-handle"
          onPointerDown={startWidthResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="사이드바 폭 조절"
        />
      </aside>
    </>
  );
}
