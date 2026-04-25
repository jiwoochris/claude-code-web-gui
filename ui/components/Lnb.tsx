"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import useSWR from "swr";

type Session = {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
};

const fetcher = async (url: string): Promise<Session[]> => {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return [];
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function Lnb() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ name?: string }>();
  const currentName = params?.name ?? null;

  const { data, error, isLoading, mutate } = useSWR<Session[]>(
    "/api/sessions",
    fetcher,
    { refreshInterval: 10_000, revalidateOnFocus: true },
  );

  const sessions = data ?? [];

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [lnbOpen, setLnbOpen] = useState(false);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    setLnbOpen(false);
  }, [pathname]);

  const startCreate = () => {
    setCreateErr(null);
    setNewName("");
    setCreating(true);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateErr(null);
  };

  const submitCreate = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (submitting) return;
      const name = newName.trim();
      if (!NAME_RE.test(name)) {
        setCreateErr("영문/숫자/_/- 1~32자");
        return;
      }
      setSubmitting(true);
      setCreateErr(null);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ name }),
        });
        if (res.status === 409) {
          setCreateErr("이미 존재하는 이름입니다.");
          return;
        }
        if (!res.ok) {
          setCreateErr("생성에 실패했습니다.");
          return;
        }
        await mutate();
        setCreating(false);
        setNewName("");
        router.push(`/s/${encodeURIComponent(name)}`);
      } catch {
        setCreateErr("네트워크 오류");
      } finally {
        setSubmitting(false);
      }
    },
    [newName, mutate, router, submitting],
  );

  const killSession = async (name: string) => {
    if (!confirm(`세션 '${name}' 을(를) 종료할까요?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) {
      alert("삭제에 실패했습니다.");
      return;
    }
    await mutate();
    if (currentName === name) router.push("/");
  };

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    window.location.href = "/login";
  };

  return (
    <>
      <div className="mobile-bar">
        <button onClick={() => setLnbOpen((v) => !v)} aria-label="세션 목록 열기">
          ☰
        </button>
        <div className="title">Claude Code Web GUI</div>
      </div>

      <div className={`lnb-backdrop${lnbOpen ? " show" : ""}`} onClick={() => setLnbOpen(false)} />

      <aside className={`lnb${lnbOpen ? " open" : ""}`} aria-label="세션 내비게이션">
        <Link href="/" className="lnb-brand">
          <div className="title">Claude Code</div>
          <div className="subtitle">Web GUI</div>
        </Link>

        <div className="lnb-create">
          {!creating ? (
            <button className="btn-new" onClick={startCreate}>
              + 새 세션
            </button>
          ) : (
            <form className="inline-form" onSubmit={submitCreate}>
              <input
                ref={inputRef}
                value={newName}
                placeholder="세션 이름"
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (createErr) setCreateErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancelCreate();
                }}
                aria-invalid={createErr !== null}
                maxLength={32}
              />
              <div className="actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={submitting}
                  aria-busy={submitting}
                >
                  {submitting ? "…" : "생성"}
                </button>
                <button type="button" onClick={cancelCreate} disabled={submitting}>
                  취소
                </button>
              </div>
              {createErr ? (
                <div className="hint err">{createErr}</div>
              ) : (
                <div className="hint">Enter 생성 · Esc 취소</div>
              )}
            </form>
          )}
        </div>

        <div className="lnb-sessions" aria-busy={isLoading}>
          <div className="lnb-sessions-header">
            <span>활성 세션</span>
            <span className="count">{sessions.length}</span>
          </div>

          {error ? (
            <div className="lnb-empty">세션 목록을 가져오지 못했습니다.</div>
          ) : sessions.length === 0 ? (
            <div className="lnb-empty">
              세션이 없습니다.
              <br />
              <strong>+ 새 세션</strong>을 눌러
              <br />
              첫 세션을 만들어 보세요.
            </div>
          ) : (
            sessions.map((s) => {
              const active = s.name === currentName;
              return (
                <Link
                  key={s.name}
                  href={`/s/${encodeURIComponent(s.name)}`}
                  className={`lnb-session${active ? " active" : ""}${s.attached ? " attached" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span
                    className="dot"
                    aria-label={s.attached ? "연결됨" : "분리됨"}
                    title={s.attached ? "attached" : "detached"}
                  />
                  <span className="meta">
                    <span className="name">{s.name}</span>
                    <span className="sub">
                      창 {s.windows}개{s.attached ? " · 사용 중" : ""}
                    </span>
                  </span>
                  <button
                    className="kill"
                    aria-label={`${s.name} 세션 삭제`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      killSession(s.name);
                    }}
                  >
                    ✕
                  </button>
                </Link>
              );
            })
          )}
        </div>

        <div className="lnb-footer">
          <Link
            href="/files"
            className={`lnb-link${pathname?.startsWith("/files") ? " active" : ""}`}
          >
            📁 파일 탐색기
          </Link>
          <button onClick={() => mutate()} disabled={isLoading}>
            ↻ 새로고침
          </button>
          <button onClick={logout}>로그아웃</button>
        </div>
      </aside>
    </>
  );
}
