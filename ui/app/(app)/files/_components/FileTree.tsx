"use client";

import { useMemo } from "react";

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface Entry {
  name: string;
  type: EntryKind;
  size: number;
  mtime: number;
}

interface Props {
  // key: directory relative path ("" for root); value: its children or undefined while loading.
  trees: Map<string, Entry[]>;
  loading: Set<string>;
  expanded: Set<string>;
  selected: string | null;
  onToggleFolder: (relPath: string) => void;
  onSelectFile: (relPath: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, type: EntryKind) => void;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function iconFor(entry: Entry, isOpen: boolean): string {
  if (entry.type === "dir") return isOpen ? "📂" : "📁";
  if (entry.type === "symlink") return "🔗";
  return "📄";
}

export function FileTree({
  trees,
  loading,
  expanded,
  selected,
  onToggleFolder,
  onSelectFile,
  onContextMenu,
}: Props) {
  const rootChildren = trees.get("") ?? [];

  return (
    <div className="fv-tree" role="tree">
      <TreeLevel
        parent=""
        entries={rootChildren}
        depth={0}
        trees={trees}
        loading={loading}
        expanded={expanded}
        selected={selected}
        onToggleFolder={onToggleFolder}
        onSelectFile={onSelectFile}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

function TreeLevel({
  parent,
  entries,
  depth,
  trees,
  loading,
  expanded,
  selected,
  onToggleFolder,
  onSelectFile,
  onContextMenu,
}: {
  parent: string;
  entries: Entry[];
  depth: number;
} & Omit<Props, "trees" | "loading" | "expanded" | "selected" | "onToggleFolder" | "onSelectFile" | "onContextMenu"> &
  Pick<
    Props,
    "trees" | "loading" | "expanded" | "selected" | "onToggleFolder" | "onSelectFile" | "onContextMenu"
  >) {
  return (
    <ul className="fv-list" role="group">
      {entries.map((entry) => (
        <TreeNode
          key={entry.name}
          entry={entry}
          parent={parent}
          depth={depth}
          trees={trees}
          loading={loading}
          expanded={expanded}
          selected={selected}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  parent,
  depth,
  trees,
  loading,
  expanded,
  selected,
  onToggleFolder,
  onSelectFile,
  onContextMenu,
}: {
  entry: Entry;
  parent: string;
  depth: number;
} & Pick<
  Props,
  "trees" | "loading" | "expanded" | "selected" | "onToggleFolder" | "onSelectFile" | "onContextMenu"
>) {
  const full = useMemo(() => joinPath(parent, entry.name), [parent, entry.name]);
  const isDir = entry.type === "dir";
  const isOpen = isDir && expanded.has(full);
  const isSelected = selected === full;
  const isLoading = loading.has(full);
  const children = trees.get(full);

  const handleClick = () => {
    if (entry.type === "symlink" || entry.type === "other") return;
    if (isDir) onToggleFolder(full);
    else onSelectFile(full);
  };

  const handleContext = (e: React.MouseEvent) => {
    if (!onContextMenu) return;
    e.preventDefault();
    onContextMenu(e, full, entry.type);
  };

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <button
        className={`fv-node${isSelected ? " selected" : ""}${isDir ? " is-dir" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={handleContext}
        title={entry.type === "symlink" ? "심볼릭 링크 (접근 불가)" : full}
      >
        <span className="twist">{isDir ? (isOpen ? "▾" : "▸") : ""}</span>
        <span className="icon">{iconFor(entry, isOpen)}</span>
        <span className="name">{entry.name}</span>
        {isLoading ? <span className="spin" aria-hidden>…</span> : null}
      </button>
      {isDir && isOpen && children ? (
        <TreeLevel
          parent={full}
          entries={children}
          depth={depth + 1}
          trees={trees}
          loading={loading}
          expanded={expanded}
          selected={selected}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
          onContextMenu={onContextMenu}
        />
      ) : null}
    </li>
  );
}
