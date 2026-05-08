"use client";

import { useCallback, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useFiles } from "./files/FilesProvider";
import { FileTree } from "./files/FileTree";

export function FilesSection() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    rootName,
    trees,
    loading,
    expanded,
    selected,
    watchOk,
    topError,
    upload,
    toggleFolder,
    selectFile,
    download,
    uploadFiles,
    resolveDropTarget,
  } = useFiles();

  // The file viewer only renders on /s/[name] (split with terminal) and
  // /files (standalone). On the dashboard or any other route, clicking a
  // file in the LNB would otherwise update state silently with nowhere
  // to display — route to /files in that case.
  const handleSelectFile = useCallback(
    async (path: string) => {
      if (pathname && !pathname.startsWith("/s/") && pathname !== "/files") {
        router.push("/files");
      }
      await selectFile(path);
    },
    [pathname, router, selectFile],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  // Where uploads land when dropped on the section background or picked
  // through the toolbar button: the parent of the currently-open file, or
  // the workspace root when nothing is selected.
  const sectionTarget = useCallback((): string => {
    if (!selected) return "";
    return resolveDropTarget(selected);
  }, [selected, resolveDropTarget]);

  const hasFiles = (e: React.DragEvent) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      uploadFiles(sectionTarget(), files);
    }
  };

  const onTreeDrop = (targetDir: string, files: FileList) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    uploadFiles(targetDir, files);
  };

  const onPickFiles = () => fileInputRef.current?.click();
  const onPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) uploadFiles(sectionTarget(), list);
    // Reset so the same file can be picked twice in a row.
    e.target.value = "";
  };

  const sectionTargetLabel = sectionTarget() || rootName;

  return (
    <div
      className={`lnb-files${dragActive ? " drag-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="lnb-files-toolbar">
        <span className="root" title={rootName}>📁 {rootName}</span>
        <span className="spacer" />
        <span
          className={`watch-status${watchOk ? " ok" : ""}`}
          title={watchOk ? "실시간 감시 중" : "감시 연결 안됨"}
        >
          {watchOk ? "● LIVE" : "○"}
        </span>
        <button
          className="lnb-icon-btn"
          onClick={onPickFiles}
          title={`파일 업로드 → ${sectionTargetLabel}`}
        >
          ⬆
        </button>
        <button
          className="lnb-icon-btn"
          onClick={() => download("")}
          title="루트 ZIP 다운로드"
        >
          ⬇
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={onPickerChange}
      />
      {topError ? <div className="lnb-files-err">{topError}</div> : null}
      {upload ? (
        <div className="lnb-files-progress" role="status">
          {upload.done < upload.total ? (
            <>
              <span className="spin" aria-hidden>↻</span>
              <span className="text">
                업로드 중 ({upload.done + 1}/{upload.total})
                {upload.active ? ` · ${upload.active}` : ""}
              </span>
            </>
          ) : upload.errors.length === 0 ? (
            <span className="text ok">완료 · {upload.total}개 파일</span>
          ) : (
            <span className="text err">
              {upload.total - upload.errors.length}/{upload.total} 성공 · 실패 {upload.errors.length}건
            </span>
          )}
        </div>
      ) : null}
      <div className="lnb-files-tree">
        <FileTree
          trees={trees}
          loading={loading}
          expanded={expanded}
          selected={selected}
          onToggleFolder={toggleFolder}
          onSelectFile={handleSelectFile}
          onContextMenu={(e, path, type) => {
            e.preventDefault();
            if (type === "dir" || type === "file") {
              if (confirm(`'${path || rootName}' 다운로드할까요?`)) download(path);
            }
          }}
          onDropFiles={onTreeDrop}
        />
      </div>
      {dragActive ? (
        <div className="lnb-files-dropzone" aria-hidden>
          <div className="msg">
            <div className="title">파일을 여기에 놓아주세요</div>
            <div className="hint">
              📁 {sectionTargetLabel} 에 업로드됩니다 (개별 폴더 위에 놓으면 그 폴더로)
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
