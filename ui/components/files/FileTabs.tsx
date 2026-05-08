"use client";

import { useState } from "react";
import { useFiles } from "./FilesProvider";

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

export function FileTabs() {
  const { recentFiles, selected, selectFile, closeRecent, reloadCurrent } =
    useFiles();
  const [reloading, setReloading] = useState(false);

  if (recentFiles.length === 0) return null;

  const handleReload = async () => {
    if (!selected || reloading) return;
    setReloading(true);
    try {
      await reloadCurrent();
    } finally {
      // Brief flash so the user sees the spinner even on fast refreshes.
      setTimeout(() => setReloading(false), 200);
    }
  };

  return (
    <div className="file-tabs" role="tablist" aria-label="열린 파일">
      {recentFiles.map((path) => {
        const active = path === selected;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            className={`file-tab${active ? " active" : ""}`}
            title={path}
            onClick={() => {
              if (!active) void selectFile(path);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeRecent(path);
              }
            }}
          >
            <span className="tab-name">{basename(path)}</span>
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeRecent(path);
              }}
              aria-label={`${basename(path)} 탭 닫기`}
              title="탭 닫기"
            >
              ✕
            </button>
          </div>
        );
      })}
      <span className="file-tabs-spacer" />
      <button
        type="button"
        className={`file-tabs-action${reloading ? " spinning" : ""}`}
        onClick={handleReload}
        disabled={!selected || reloading}
        title="현재 파일 다시 렌더링"
        aria-label="현재 파일 다시 렌더링"
      >
        ↻
      </button>
    </div>
  );
}
