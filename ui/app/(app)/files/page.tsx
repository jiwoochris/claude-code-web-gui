"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumb } from "./_components/Breadcrumb";
import { FileTree, type Entry } from "./_components/FileTree";
import { FileViewer, type PreviewState } from "./_components/FileViewer";

type TreeResponse = { path: string; rootName: string; entries: Entry[] };

export default function FilesPage() {
  const [rootName, setRootName] = useState("workspace");
  const [trees, setTrees] = useState<Map<string, Entry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "empty" });
  const [connId, setConnId] = useState<string | null>(null);
  const [watchOk, setWatchOk] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const connIdRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const expandedRef = useRef<Set<string>>(new Set([""]));
  const treesRef = useRef<Map<string, Entry[]>>(new Map());
  const imageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    connIdRef.current = connId;
  }, [connId]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    treesRef.current = trees;
  }, [trees]);

  const markLoading = useCallback((p: string, on: boolean) => {
    setLoading((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  const fetchTree = useCallback(async (relPath: string): Promise<Entry[] | null> => {
    markLoading(relPath, true);
    try {
      const url = `/api/fs/tree?path=${encodeURIComponent(relPath)}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) {
        window.location.href = "/login";
        return null;
      }
      if (!res.ok) {
        setTopError(`트리 로드 실패 (${res.status})`);
        return null;
      }
      const data = (await res.json()) as TreeResponse;
      if (data.rootName) setRootName(data.rootName);
      setTrees((prev) => {
        const next = new Map(prev);
        next.set(relPath, data.entries);
        return next;
      });
      setTopError(null);
      return data.entries;
    } catch (e) {
      setTopError((e as Error).message);
      return null;
    } finally {
      markLoading(relPath, false);
    }
  }, [markLoading]);

  const subscribeWatch = useCallback(
    async (relPath: string, mode: "dir" | "file", action: "add" | "remove") => {
      const conn = connIdRef.current;
      if (!conn) return;
      try {
        await fetch("/api/fs/watch/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ conn, path: relPath, mode, action }),
        });
      } catch {
        /* non-fatal */
      }
    },
    [],
  );

  const openFile = useCallback(async (relPath: string) => {
    setSelected(relPath);
    setPreview({ kind: "loading", path: relPath });
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }
    try {
      const res = await fetch(`/api/fs/file?path=${encodeURIComponent(relPath)}`, {
        credentials: "include",
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 413) {
        const info = (await res.json()) as { reason: "too_large" | "binary"; size: number; mime: string };
        setPreview({ kind: "unavailable", path: relPath, ...info });
        return;
      }
      if (!res.ok) {
        setPreview({ kind: "error", path: relPath, message: `HTTP ${res.status}` });
        return;
      }
      const ct = res.headers.get("Content-Type") ?? "application/octet-stream";
      if (ct.startsWith("image/")) {
        const blob = await res.blob();
        const src = URL.createObjectURL(blob);
        imageUrlRef.current = src;
        setPreview({ kind: "image", path: relPath, src, mime: ct });
        return;
      }
      const text = await res.text();
      setPreview({ kind: "text", path: relPath, content: text });
    } catch (e) {
      setPreview({ kind: "error", path: relPath, message: (e as Error).message });
    }
  }, []);

  const handleSelectFile = useCallback(
    async (relPath: string) => {
      const prev = selectedRef.current;
      if (prev && prev !== relPath) subscribeWatch(prev, "file", "remove");
      await openFile(relPath);
      subscribeWatch(relPath, "file", "add");
    },
    [openFile, subscribeWatch],
  );

  const handleToggleFolder = useCallback(
    async (relPath: string) => {
      const isOpen = expandedRef.current.has(relPath);
      if (isOpen) {
        // collapse: unsubscribe this dir (children are independently subscribed; unsubscribe them too if expanded)
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(relPath);
          // also collapse descendants
          for (const p of prev) {
            if (p !== "" && p.startsWith(relPath + "/")) next.delete(p);
          }
          return next;
        });
        subscribeWatch(relPath, "dir", "remove");
        for (const p of expandedRef.current) {
          if (p !== "" && p.startsWith(relPath + "/")) subscribeWatch(p, "dir", "remove");
        }
      } else {
        if (!treesRef.current.get(relPath)) await fetchTree(relPath);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(relPath);
          return next;
        });
        subscribeWatch(relPath, "dir", "add");
      }
    },
    [fetchTree, subscribeWatch],
  );

  const handleDownload = useCallback((relPath: string) => {
    const url = `/api/fs/download?path=${encodeURIComponent(relPath)}`;
    window.location.href = url;
  }, []);

  const handleBreadcrumbNavigate = useCallback(
    async (relPath: string) => {
      // Expand all ancestors and the target so the target's children are visible.
      const parts = relPath ? relPath.split("/") : [];
      const ancestors = [""];
      for (let i = 0; i < parts.length; i++) ancestors.push(parts.slice(0, i + 1).join("/"));
      for (const anc of ancestors) {
        if (!treesRef.current.get(anc)) await fetchTree(anc);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const anc of ancestors) next.add(anc);
        return next;
      });
      for (const anc of ancestors) subscribeWatch(anc, "dir", "add");
    },
    [fetchTree, subscribeWatch],
  );

  // Initial load: fetch root tree.
  useEffect(() => {
    fetchTree("");
  }, [fetchTree]);

  // Open SSE connection once, manage lifecycle.
  useEffect(() => {
    const es = new EventSource("/api/fs/watch", { withCredentials: true });

    es.addEventListener("hello", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { conn: string };
        setConnId(data.conn);
        setWatchOk(true);
      } catch {
        /* noop */
      }
    });

    es.addEventListener("change", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          type: string;
          path: string;
        };
        const changed = data.path;
        const sel = selectedRef.current;
        if (sel && sel === changed && (data.type === "change" || data.type === "add")) {
          openFile(sel);
        }
        // Refresh the parent directory's tree if that parent is currently loaded.
        const lastSlash = changed.lastIndexOf("/");
        const parentPath = lastSlash < 0 ? "" : changed.slice(0, lastSlash);
        if (treesRef.current.has(parentPath)) {
          fetchTree(parentPath);
        }
      } catch {
        /* noop */
      }
    });

    es.addEventListener("ping", () => {
      /* keepalive */
    });

    es.onerror = () => {
      setWatchOk(false);
    };

    return () => {
      es.close();
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
      }
    };
  }, [fetchTree, openFile]);

  // Re-subscribe root once the connection is established.
  useEffect(() => {
    if (!connId) return;
    subscribeWatch("", "dir", "add");
    for (const p of expandedRef.current) {
      if (p) subscribeWatch(p, "dir", "add");
    }
    if (selectedRef.current) subscribeWatch(selectedRef.current, "file", "add");
  }, [connId, subscribeWatch]);

  const currentPath = selected ?? "";

  return (
    <div className="files-page">
      <div className="fv-header">
        <Breadcrumb rootName={rootName} path={currentPath} onNavigate={handleBreadcrumbNavigate} />
        <span className="spacer" />
        <span className={`watch-status${watchOk ? " ok" : ""}`} title={watchOk ? "실시간 감시 중" : "감시 연결 안됨"}>
          {watchOk ? "● LIVE" : "○ offline"}
        </span>
        <button className="btn" onClick={() => handleDownload("")} title="루트 전체 다운로드">
          ⬇ ZIP
        </button>
      </div>

      {topError ? <div className="fv-banner err">{topError}</div> : null}

      <div className="fv-split">
        <aside className="fv-pane-left">
          <FileTree
            trees={trees}
            loading={loading}
            expanded={expanded}
            selected={selected}
            onToggleFolder={handleToggleFolder}
            onSelectFile={handleSelectFile}
            onContextMenu={(e, path, type) => {
              e.preventDefault();
              if (type === "dir" || type === "file") {
                if (confirm(`'${path || rootName}' 다운로드할까요?`)) handleDownload(path);
              }
            }}
          />
        </aside>
        <section className="fv-pane-right">
          <FileViewer state={preview} onDownload={handleDownload} />
        </section>
      </div>
    </div>
  );
}
