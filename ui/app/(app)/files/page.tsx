"use client";

import { useState } from "react";
import { useFiles } from "@/components/files/FilesProvider";
import { FileViewer } from "@/components/files/FileViewer";
import { Breadcrumb } from "@/components/files/Breadcrumb";

export default function FilesPage() {
  const { rootName, selected, preview, navigateTo, download } = useFiles();
  const [markdownRaw, setMarkdownRaw] = useState(false);
  const currentPath = selected ?? "";

  const isMd =
    preview.kind === "text" && /\.(md|mdx|markdown)$/i.test(preview.path);
  const filePath =
    preview.kind === "text" ||
    preview.kind === "image" ||
    preview.kind === "pdf" ||
    preview.kind === "unavailable" ||
    preview.kind === "error" ||
    preview.kind === "loading"
      ? preview.path
      : null;

  return (
    <div className="files-page">
      <div className="fv-header">
        <Breadcrumb rootName={rootName} path={currentPath} onNavigate={navigateTo} />
        <span className="spacer" />
        {preview.kind === "pdf" && preview.renderedFromOffice ? (
          <span className="fv-tag" title="LibreOffice가 PDF로 변환한 미리보기">
            PDF로 변환됨
          </span>
        ) : null}
        {preview.kind === "pdf" ? (
          <a
            className="btn"
            href={preview.src}
            target="_blank"
            rel="noopener noreferrer"
          >
            ↗ 새 탭
          </a>
        ) : null}
        {isMd ? (
          <button
            className="btn"
            onClick={() => setMarkdownRaw((v) => !v)}
            title="렌더 / 원본 보기 전환"
          >
            {markdownRaw ? "📖 렌더" : "📝 원본"}
          </button>
        ) : null}
        {filePath ? (
          <button
            className="btn"
            onClick={() => download(filePath)}
            title="현재 파일 다운로드"
          >
            ⬇ 파일
          </button>
        ) : null}
        <button
          className="btn"
          onClick={() => download("")}
          title="루트 전체 다운로드"
        >
          ⬇ ZIP
        </button>
      </div>

      <div className="fv-pane-right" style={{ flex: 1, minHeight: 0 }}>
        <FileViewer
          state={preview}
          onDownload={download}
          markdownRaw={markdownRaw}
        />
      </div>
    </div>
  );
}
