"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

interface Props {
  source: string;
}

export function MarkdownViewer({ source }: Props) {
  const [html, setHtml] = useState<string>("");

  const parsed = useMemo(() => {
    try {
      // Parse synchronously; marked returns string when async:false (default).
      return marked.parse(source, { gfm: true, breaks: false }) as string;
    } catch (e) {
      return `<pre>마크다운 파싱 실패: ${(e as Error).message}</pre>`;
    }
  }, [source]);

  useEffect(() => {
    setHtml(
      DOMPurify.sanitize(parsed, {
        ADD_ATTR: ["target", "rel"],
      }),
    );
  }, [parsed]);

  return (
    <div
      className="fv-md-body"
      // Sanitized via DOMPurify above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
