"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";

type Session = {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
};

type DirEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
};

type TreeResponse = {
  path: string;
  rootName: string;
  entries: DirEntry[];
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

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function SessionsSection() {
  const router = useRouter();
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

  // Directory picker (loaded only while create form is open).
  const [rootName, setRootName] = useState<string>("workspace");
  const [dirChildren, setDirChildren] = useState<Map<string, DirEntry[]>>(
    new Map(),
  );
  const [dirLoading, setDirLoading] = useState<Set<string>>(new Set());
  const [dirExpanded, setDirExpanded] = useState<Set<string>>(new Set([""]));
  const [selectedCwd, setSelectedCwd] = useState<string>("");
  const [dirError, setDirError] = useState<string | null>(null);

  const loadDir = useCallback(async (relPath: string) => {
    setDirLoading((prev) => {
      if (prev.has(relPath)) return prev;
      const next = new Set(prev);
      next.add(relPath);
      return next;
    });
    try {
      const url = `/api/fs/tree?path=${encodeURIComponent(relPath)}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        setDirError("디렉토리를 불러오지 못했습니다.");
        return;
      }
      const data = (await res.json()) as TreeResponse;
      if (data.rootName) setRootName(data.rootName);
      const dirs = data.entries.filter((e) => e.type === "dir");
      setDirChildren((prev) => {
        const next = new Map(prev);
        next.set(relPath, dirs);
        return next;
      });
    } catch {
      setDirError("네트워크 오류");
    } finally {
      setDirLoading((prev) => {
        const next = new Set(prev);
        next.delete(relPath);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (creating && !dirChildren.has("")) {
      void loadDir("");
    }
  }, [creating, dirChildren, loadDir]);

  const startCreate = () => {
    setCreateErr(null);
    setNewName("");
    setSelectedCwd("");
    setDirExpanded(new Set([""]));
    setDirError(null);
    setCreating(true);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName("");
    setCreateErr(null);
    setDirError(null);
  };

  const toggleDir = useCallback(
    (relPath: string) => {
      setDirExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(relPath)) {
          next.delete(relPath);
        } else {
          next.add(relPath);
          if (!dirChildren.has(relPath)) void loadDir(relPath);
        }
        return next;
      });
    },
    [dirChildren, loadDir],
  );

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
          body: JSON.stringify({ name, cwd: selectedCwd }),
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
    [newName, selectedCwd, mutate, router, submitting],
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

  return (
    <>
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
            <div className="dir-picker" role="tree" aria-label="작업 디렉토리 선택">
              <div className="dir-picker-label">시작 디렉토리</div>
              <DirNode
                rel=""
                label={rootName}
                selected={selectedCwd === ""}
                expanded={dirExpanded.has("")}
                loading={dirLoading.has("")}
                hasChildren={(dirChildren.get("") ?? []).length > 0}
                onToggle={() => toggleDir("")}
                onSelect={() => setSelectedCwd("")}
              />
              {dirExpanded.has("") && (
                <DirChildren
                  parent=""
                  entries={dirChildren.get("") ?? []}
                  expanded={dirExpanded}
                  loading={dirLoading}
                  childMap={dirChildren}
                  selected={selectedCwd}
                  onToggle={toggleDir}
                  onSelect={setSelectedCwd}
                />
              )}
              {dirError && <div className="hint err">{dirError}</div>}
            </div>
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
    </>
  );
}

function DirNode({
  rel,
  label,
  depth = 0,
  selected,
  expanded,
  loading,
  hasChildren,
  onToggle,
  onSelect,
}: {
  rel: string;
  label: string;
  depth?: number;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={`dir-node${selected ? " selected" : ""}`}
      style={{ paddingLeft: 4 + depth * 12 }}
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={selected}
    >
      <button
        type="button"
        className="twist"
        onClick={onToggle}
        aria-label={expanded ? "접기" : "펼치기"}
        tabIndex={-1}
      >
        {loading ? "…" : expanded ? "▾" : hasChildren || !expanded ? "▸" : " "}
      </button>
      <button
        type="button"
        className="dir-label"
        onClick={onSelect}
        title={rel || "/"}
      >
        <span className="icon">{expanded ? "📂" : "📁"}</span>
        <span className="name">{label}</span>
      </button>
    </div>
  );
}

function DirChildren({
  parent,
  entries,
  expanded,
  loading,
  childMap,
  selected,
  onToggle,
  onSelect,
  depth = 1,
}: {
  parent: string;
  entries: DirEntry[];
  expanded: Set<string>;
  loading: Set<string>;
  childMap: Map<string, DirEntry[]>;
  selected: string;
  onToggle: (rel: string) => void;
  onSelect: (rel: string) => void;
  depth?: number;
}) {
  if (entries.length === 0) {
    if (loading.has(parent)) {
      return (
        <div className="dir-empty" style={{ paddingLeft: 4 + depth * 12 }}>
          불러오는 중…
        </div>
      );
    }
    return (
      <div className="dir-empty" style={{ paddingLeft: 4 + depth * 12 }}>
        (하위 디렉토리 없음)
      </div>
    );
  }
  return (
    <>
      {entries.map((child) => {
        const rel = joinPath(parent, child.name);
        const isExpanded = expanded.has(rel);
        const subs = childMap.get(rel) ?? [];
        return (
          <div key={rel}>
            <DirNode
              rel={rel}
              label={child.name}
              depth={depth}
              selected={selected === rel}
              expanded={isExpanded}
              loading={loading.has(rel)}
              hasChildren={subs.length > 0 || !childMap.has(rel)}
              onToggle={() => onToggle(rel)}
              onSelect={() => onSelect(rel)}
            />
            {isExpanded && (
              <DirChildren
                parent={rel}
                entries={subs}
                expanded={expanded}
                loading={loading}
                childMap={childMap}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
