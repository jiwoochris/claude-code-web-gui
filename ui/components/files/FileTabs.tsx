"use client";

import { useFiles } from "./FilesProvider";

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

export function FileTabs() {
  const { recentFiles, selected, selectFile, closeRecent } = useFiles();
  if (recentFiles.length === 0) return null;

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
    </div>
  );
}
