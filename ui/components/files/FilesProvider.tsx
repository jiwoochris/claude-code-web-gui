"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Entry } from "./FileTree";
import type { PreviewState } from "./FileViewer";

type TreeResponse = { path: string; rootName: string; entries: Entry[] };

export interface UploadProgress {
  total: number;
  done: number;
  active: string | null;
  errors: { name: string; message: string }[];
}

interface FilesContextValue {
  rootName: string;
  trees: Map<string, Entry[]>;
  loading: Set<string>;
  expanded: Set<string>;
  selected: string | null;
  preview: PreviewState;
  recentFiles: string[];
  watchOk: boolean;
  topError: string | null;
  upload: UploadProgress | null;

  toggleFolder: (relPath: string) => Promise<void>;
  selectFile: (relPath: string) => Promise<void>;
  closeFile: () => void;
  closeRecent: (relPath: string) => void;
  reloadCurrent: () => Promise<void>;
  navigateTo: (relPath: string) => Promise<void>;
  refreshTree: (relPath: string) => Promise<void>;
  download: (relPath: string) => void;
  uploadFiles: (
    targetDir: string,
    files: File[] | FileList,
  ) => Promise<{ uploaded: number; failed: number }>;
  resolveDropTarget: (path: string) => string;
}

const RECENT_FILES_LIMIT = 5;
const RECENT_FILES_STORAGE_KEY = "files-recent:v1";

const FilesContext = createContext<FilesContextValue | null>(null);

export function useFiles(): FilesContextValue {
  const ctx = useContext(FilesContext);
  if (!ctx) throw new Error("useFiles must be used within FilesProvider");
  return ctx;
}

export function FilesProvider({ children }: { children: React.ReactNode }) {
  const [rootName, setRootName] = useState("workspace");
  const [trees, setTrees] = useState<Map<string, Entry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "empty" });
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [connId, setConnId] = useState<string | null>(null);
  const [watchOk, setWatchOk] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadProgress | null>(null);

  const connIdRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const expandedRef = useRef<Set<string>>(new Set([""]));
  const treesRef = useRef<Map<string, Entry[]>>(new Map());
  const imageUrlRef = useRef<string | null>(null);
  const recentFilesRef = useRef<string[]>([]);
  const recentHydratedRef = useRef(false);
  // Bumped whenever the iframe-rendered preview should bypass its cache
  // (manual reload + SSE change). Appended as &v=N to PDF/render URLs so
  // the browser actually re-fetches instead of reusing the cached blob.
  const reloadTickRef = useRef(0);

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
  useEffect(() => {
    recentFilesRef.current = recentFiles;
  }, [recentFiles]);

  // Hydrate recent files from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_FILES_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          const clean = arr
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .slice(0, RECENT_FILES_LIMIT);
          if (clean.length > 0) setRecentFiles(clean);
        }
      }
    } catch {
      /* ignore */
    }
    recentHydratedRef.current = true;
  }, []);

  // Persist recent files after hydration so initial mount doesn't clobber.
  useEffect(() => {
    if (!recentHydratedRef.current) return;
    try {
      localStorage.setItem(
        RECENT_FILES_STORAGE_KEY,
        JSON.stringify(recentFiles),
      );
    } catch {
      /* ignore */
    }
  }, [recentFiles]);

  const markLoading = useCallback((p: string, on: boolean) => {
    setLoading((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  const fetchTree = useCallback(
    async (relPath: string): Promise<Entry[] | null> => {
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
    },
    [markLoading],
  );

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

    const dot = relPath.lastIndexOf(".");
    const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : "";
    const PDF_EXTS = new Set(["pdf"]);
    const OFFICE_EXTS = new Set([
      "pptx",
      "ppt",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "odt",
      "odp",
      "ods",
      "rtf",
    ]);

    const tickQs = reloadTickRef.current
      ? `&v=${reloadTickRef.current}`
      : "";

    if (PDF_EXTS.has(ext)) {
      setPreview({
        kind: "pdf",
        path: relPath,
        src: `/api/fs/file?path=${encodeURIComponent(relPath)}${tickQs}`,
        renderedFromOffice: false,
        sourceExt: "pdf",
      });
      return;
    }
    if (OFFICE_EXTS.has(ext)) {
      // Probe the render endpoint: if it succeeds, embed the produced
      // PDF; otherwise surface a meaningful error so the user can still
      // download the source file.
      try {
        const probe = await fetch(
          `/api/fs/render?path=${encodeURIComponent(relPath)}${tickQs}`,
          { method: "HEAD", credentials: "include" },
        );
        if (probe.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (probe.ok) {
          setPreview({
            kind: "pdf",
            path: relPath,
            src: `/api/fs/render?path=${encodeURIComponent(relPath)}${tickQs}`,
            renderedFromOffice: true,
            sourceExt: ext,
          });
          if (ext === "pptx") {
            // Fetch speaker notes asynchronously and merge into the preview
            // when they arrive. The PDF itself is usable without notes, so
            // any failure here is silent.
            void fetch(
              `/api/fs/pptx-notes?path=${encodeURIComponent(relPath)}`,
              { credentials: "include" },
            )
              .then(async (r) => {
                if (!r.ok) return null;
                return (await r.json()) as { notes: string[] };
              })
              .then((data) => {
                if (!data) return;
                if (selectedRef.current !== relPath) return;
                setPreview((prev) =>
                  prev.kind === "pdf" && prev.path === relPath
                    ? { ...prev, notes: data.notes }
                    : prev,
                );
              })
              .catch(() => {
                /* notes are best-effort */
              });
          }
          return;
        }
        if (probe.status === 503) {
          setPreview({
            kind: "error",
            path: relPath,
            message:
              "PPT/문서 미리보기를 위해 LibreOffice(soffice)가 서버에 설치되어 있어야 합니다.",
          });
          return;
        }
        setPreview({
          kind: "error",
          path: relPath,
          message: `미리보기 변환 실패 (HTTP ${probe.status})`,
        });
        return;
      } catch (e) {
        setPreview({
          kind: "error",
          path: relPath,
          message: (e as Error).message,
        });
        return;
      }
    }

    try {
      const res = await fetch(
        `/api/fs/file?path=${encodeURIComponent(relPath)}${tickQs}`,
        { credentials: "include", cache: "no-store" },
      );
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 413) {
        const info = (await res.json()) as {
          reason: "too_large" | "binary";
          size: number;
          mime: string;
        };
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

  const selectFile = useCallback(
    async (relPath: string) => {
      const prev = selectedRef.current;
      if (prev && prev !== relPath) subscribeWatch(prev, "file", "remove");
      setRecentFiles((list) => {
        const filtered = list.filter((p) => p !== relPath);
        return [relPath, ...filtered].slice(0, RECENT_FILES_LIMIT);
      });
      await openFile(relPath);
      subscribeWatch(relPath, "file", "add");
    },
    [openFile, subscribeWatch],
  );

  // Removes `path` from the recent list. If it was the active file, switch to
  // a neighboring tab (the one that takes its index) or fall back to empty.
  const closeRecent = useCallback(
    (path: string) => {
      const list = recentFilesRef.current;
      const idx = list.indexOf(path);
      if (idx < 0) return;
      const remaining = list.filter((p) => p !== path);
      setRecentFiles(remaining);
      if (selectedRef.current !== path) return;
      subscribeWatch(path, "file", "remove");
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
      }
      if (remaining.length === 0) {
        setSelected(null);
        setPreview({ kind: "empty" });
        return;
      }
      const nextIdx = Math.min(idx, remaining.length - 1);
      const next = remaining[nextIdx];
      void openFile(next);
      subscribeWatch(next, "file", "add");
    },
    [openFile, subscribeWatch],
  );

  const reloadCurrent = useCallback(async () => {
    const cur = selectedRef.current;
    if (!cur) return;
    reloadTickRef.current += 1;
    await openFile(cur);
  }, [openFile]);

  const closeFile = useCallback(() => {
    const cur = selectedRef.current;
    if (cur) {
      closeRecent(cur);
      return;
    }
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }
    setSelected(null);
    setPreview({ kind: "empty" });
  }, [closeRecent]);

  const toggleFolder = useCallback(
    async (relPath: string) => {
      const isOpen = expandedRef.current.has(relPath);
      if (isOpen) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(relPath);
          for (const p of prev) {
            if (p !== "" && p.startsWith(relPath + "/")) next.delete(p);
          }
          return next;
        });
        subscribeWatch(relPath, "dir", "remove");
        for (const p of expandedRef.current) {
          if (p !== "" && p.startsWith(relPath + "/")) {
            subscribeWatch(p, "dir", "remove");
          }
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

  const navigateTo = useCallback(
    async (relPath: string) => {
      const parts = relPath ? relPath.split("/") : [];
      const ancestors = [""];
      for (let i = 0; i < parts.length; i++) {
        ancestors.push(parts.slice(0, i + 1).join("/"));
      }
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

  const download = useCallback((relPath: string) => {
    const url = `/api/fs/download?path=${encodeURIComponent(relPath)}`;
    window.location.href = url;
  }, []);

  // Given a tree path (file or folder), figure out which folder an upload
  // should land in. Caller passes whatever the user dropped onto.
  const resolveDropTarget = useCallback((p: string): string => {
    if (!p) return "";
    if (treesRef.current.has(p)) return p; // known directory
    const slash = p.lastIndexOf("/");
    return slash < 0 ? "" : p.slice(0, slash);
  }, []);

  const uploadFiles = useCallback(
    async (targetDir: string, input: File[] | FileList) => {
      const files: File[] = Array.from(input as ArrayLike<File>).filter(
        (f) => f && typeof f === "object" && "size" in f,
      );
      if (files.length === 0) return { uploaded: 0, failed: 0 };

      setUpload({
        total: files.length,
        done: 0,
        active: files[0]?.name ?? null,
        errors: [],
      });

      let uploaded = 0;
      const errors: { name: string; message: string }[] = [];
      // Send sequentially so progress is meaningful and we don't blast a
      // whole drop of dozens of files at the server in parallel.
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setUpload((prev) =>
          prev
            ? { ...prev, active: f.name, done: i }
            : prev,
        );
        try {
          const fd = new FormData();
          fd.append("path", targetDir);
          fd.append("file", f, f.name);
          const res = await fetch("/api/fs/upload", {
            method: "POST",
            body: fd,
            credentials: "include",
          });
          if (res.status === 401) {
            window.location.href = "/login";
            return { uploaded, failed: errors.length + (files.length - i) };
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            errors.push({
              name: f.name,
              message: text || `HTTP ${res.status}`,
            });
          } else {
            uploaded++;
          }
        } catch (e) {
          errors.push({ name: f.name, message: (e as Error).message });
        }
      }

      // Refresh the destination tree so the new files appear immediately
      // even if the SSE watcher is slow or disconnected.
      await fetchTree(targetDir).catch(() => null);

      setUpload({
        total: files.length,
        done: files.length,
        active: null,
        errors,
      });
      // Auto-clear the toast a few seconds after a clean run.
      if (errors.length === 0) {
        setTimeout(() => setUpload(null), 2500);
      }
      if (errors.length > 0) {
        setTopError(
          `업로드 실패 ${errors.length}건 — ${errors[0].name}: ${errors[0].message}`,
        );
      } else {
        setTopError(null);
      }
      return { uploaded, failed: errors.length };
    },
    [fetchTree],
  );

  // Initial root tree load.
  useEffect(() => {
    fetchTree("");
  }, [fetchTree]);

  // Single SSE connection for the entire (app) shell.
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
          // Bump cache-buster so iframe-rendered previews (PDF/PPTX/etc)
          // actually re-fetch instead of reusing the cached blob.
          reloadTickRef.current += 1;
          openFile(sel);
        }
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

  // Re-subscribe when connection (re)opens.
  useEffect(() => {
    if (!connId) return;
    subscribeWatch("", "dir", "add");
    for (const p of expandedRef.current) {
      if (p) subscribeWatch(p, "dir", "add");
    }
    if (selectedRef.current) subscribeWatch(selectedRef.current, "file", "add");
  }, [connId, subscribeWatch]);

  const value = useMemo<FilesContextValue>(
    () => ({
      rootName,
      trees,
      loading,
      expanded,
      selected,
      preview,
      recentFiles,
      watchOk,
      topError,
      upload,
      toggleFolder,
      selectFile,
      closeFile,
      closeRecent,
      reloadCurrent,
      navigateTo,
      refreshTree: async (p: string) => {
        await fetchTree(p);
      },
      download,
      uploadFiles,
      resolveDropTarget,
    }),
    [
      rootName,
      trees,
      loading,
      expanded,
      selected,
      preview,
      recentFiles,
      watchOk,
      topError,
      upload,
      toggleFolder,
      selectFile,
      closeFile,
      closeRecent,
      reloadCurrent,
      navigateTo,
      fetchTree,
      download,
      uploadFiles,
      resolveDropTarget,
    ],
  );

  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}
