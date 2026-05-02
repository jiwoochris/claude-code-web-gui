"use client";

import { useFiles } from "./files/FilesProvider";
import { FileTree } from "./files/FileTree";

export function FilesSection() {
  const {
    rootName,
    trees,
    loading,
    expanded,
    selected,
    watchOk,
    topError,
    toggleFolder,
    selectFile,
    download,
  } = useFiles();

  return (
    <div className="lnb-files">
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
          onClick={() => download("")}
          title="루트 ZIP 다운로드"
        >
          ⬇
        </button>
      </div>
      {topError ? <div className="lnb-files-err">{topError}</div> : null}
      <div className="lnb-files-tree">
        <FileTree
          trees={trees}
          loading={loading}
          expanded={expanded}
          selected={selected}
          onToggleFolder={toggleFolder}
          onSelectFile={selectFile}
          onContextMenu={(e, path, type) => {
            e.preventDefault();
            if (type === "dir" || type === "file") {
              if (confirm(`'${path || rootName}' 다운로드할까요?`)) download(path);
            }
          }}
        />
      </div>
    </div>
  );
}
