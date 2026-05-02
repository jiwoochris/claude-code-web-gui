"use client";

import { useFiles } from "@/components/files/FilesProvider";
import { FileViewer } from "@/components/files/FileViewer";
import { Breadcrumb } from "@/components/files/Breadcrumb";

export default function FilesPage() {
  const { rootName, selected, preview, navigateTo, download } = useFiles();
  const currentPath = selected ?? "";

  return (
    <div className="files-page">
      <div className="fv-header">
        <Breadcrumb rootName={rootName} path={currentPath} onNavigate={navigateTo} />
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => download("")}
          title="루트 전체 다운로드"
        >
          ⬇ ZIP
        </button>
      </div>

      <div className="fv-pane-right" style={{ flex: 1, minHeight: 0 }}>
        <FileViewer state={preview} onDownload={download} />
      </div>
    </div>
  );
}
