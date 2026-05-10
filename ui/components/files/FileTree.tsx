"use client";

import { useMemo, useState } from "react";

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
  onDropFiles?: (targetDir: string, files: FileList) => void;
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
  onDropFiles,
}: Props) {
  const rootChildren = trees.get("") ?? [];
  const [dragOver, setDragOver] = useState<string | null>(null);

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
        onDropFiles={onDropFiles}
        dragOver={dragOver}
        setDragOver={setDragOver}
      />
    </div>
  );
}

type LevelProps = Pick<
  Props,
  | "trees"
  | "loading"
  | "expanded"
  | "selected"
  | "onToggleFolder"
  | "onSelectFile"
  | "onContextMenu"
  | "onDropFiles"
> & {
  dragOver: string | null;
  setDragOver: (p: string | null) => void;
};

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
  onDropFiles,
  dragOver,
  setDragOver,
}: {
  parent: string;
  entries: Entry[];
  depth: number;
} & LevelProps) {
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
          onDropFiles={onDropFiles}
          dragOver={dragOver}
          setDragOver={setDragOver}
        />
      ))}
    </ul>
  );
}

function hasFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
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
  onDropFiles,
  dragOver,
  setDragOver,
}: {
  entry: Entry;
  parent: string;
  depth: number;
} & LevelProps) {
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

  const dropAccepted = !!onDropFiles && isDir;
  const isDragTarget = dropAccepted && dragOver === full;

  const handleDragOver = (e: React.DragEvent) => {
    if (!dropAccepted || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (dragOver !== full) setDragOver(full);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!dropAccepted) return;
    // Only clear when leaving to something outside this node.
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as Node).contains(related)) return;
    if (dragOver === full) setDragOver(null);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!dropAccepted || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) onDropFiles?.(full, files);
  };

  return (
    <li role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
      <button
        className={`fv-node${isSelected ? " selected" : ""}${isDir ? " is-dir" : ""}${isDragTarget ? " drag-target" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={handleContext}
        onDragOver={dropAccepted ? handleDragOver : undefined}
        onDragEnter={dropAccepted ? handleDragOver : undefined}
        onDragLeave={dropAccepted ? handleDragLeave : undefined}
        onDrop={dropAccepted ? handleDrop : undefined}
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
          onDropFiles={onDropFiles}
          dragOver={dragOver}
          setDragOver={setDragOver}
        />
      ) : null}
    </li>
  );
}
