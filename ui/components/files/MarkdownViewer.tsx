"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

interface Props {
  source: string;
  // Workspace-relative path of the markdown file. Used to resolve
  // relative asset URLs (e.g. `![](images/foo.png)`) against the file's
  // own directory and rewrite them to the `/api/fs/file` route.
  basePath?: string;
}

// Anything that already has a scheme, is protocol-relative, an in-page
// anchor, or a data/blob URL is considered "external" and left alone.
function isExternalSrc(src: string): boolean {
  if (!src) return true;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
}

function resolveWorkspacePath(basePath: string, src: string): string | null {
  if (isExternalSrc(src)) return null;
  // Strip query/fragment so they survive the round-trip into the API URL.
  let suffix = "";
  const hashIdx = src.indexOf("#");
  if (hashIdx >= 0) {
    suffix = src.slice(hashIdx) + suffix;
    src = src.slice(0, hashIdx);
  }
  const queryIdx = src.indexOf("?");
  if (queryIdx >= 0) {
    suffix = src.slice(queryIdx) + suffix;
    src = src.slice(0, queryIdx);
  }
  // Workspace-root-absolute (`/foo.png`) → drop leading slashes.
  if (src.startsWith("/")) {
    return src.replace(/^\/+/, "") + suffix;
  }
  const idx = basePath.lastIndexOf("/");
  const dir = idx >= 0 ? basePath.slice(0, idx) : "";
  const parts = (dir ? dir.split("/") : []).concat(src.split("/"));
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack.join("/") + suffix;
}

function rewriteAssetUrls(html: string, basePath: string | undefined): string {
  if (!basePath || typeof window === "undefined") return html;
  const doc = new DOMParser().parseFromString(
    `<div id="__md_root__">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("__md_root__");
  if (!root) return html;

  const rewriteAttr = (el: Element, attr: string) => {
    const v = el.getAttribute(attr);
    if (!v) return;
    const resolved = resolveWorkspacePath(basePath, v);
    if (resolved == null) return;
    el.setAttribute(attr, `/api/fs/file?path=${encodeURIComponent(resolved)}`);
  };

  root
    .querySelectorAll<HTMLImageElement>("img[src]")
    .forEach((el) => rewriteAttr(el, "src"));
  root
    .querySelectorAll<HTMLSourceElement>("source[src]")
    .forEach((el) => rewriteAttr(el, "src"));
  root
    .querySelectorAll<HTMLVideoElement>("video[src]")
    .forEach((el) => rewriteAttr(el, "src"));
  root
    .querySelectorAll<HTMLAudioElement>("audio[src]")
    .forEach((el) => rewriteAttr(el, "src"));

  return root.innerHTML;
}

export function MarkdownViewer({ source, basePath }: Props) {
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
    const sanitized = DOMPurify.sanitize(parsed, {
      ADD_ATTR: ["target", "rel"],
    });
    setHtml(rewriteAssetUrls(sanitized, basePath));
  }, [parsed, basePath]);

  return (
    <div
      className="fv-md-body"
      // Sanitized via DOMPurify above; URL rewrite only mutates known
      // asset attributes on the post-sanitize tree.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
