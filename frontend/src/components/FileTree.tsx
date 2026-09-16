import { useMemo, useState } from 'react';
import type { FileNode, Role } from '../types';

export interface TreeEntry {
  name: string;
  path: string;
  file?: FileNode;
  children: Map<string, TreeEntry>;
}

function buildTree(files: FileNode[]): TreeEntry {
  const root: TreeEntry = { name: '', path: '', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, idx) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, idx + 1).join('/'), children: new Map() };
        node.children.set(part, child);
      }
      if (idx === parts.length - 1) {
        child.file = file;
      }
      node = child;
    });
  }
  return root;
}

interface Props {
  files: FileNode[];
  activeId: string | null;
  role: Role;
  onOpen: (file: FileNode) => void;
  onCreate: (parentDir: string) => void;
  onRename: (file: FileNode) => void;
  onDelete: (file: FileNode) => void;
}

function TreeNode({
  entry,
  depth,
  props,
  defaultOpen,
}: {
  entry: TreeEntry;
  depth: number;
  props: Props;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isDir = !entry.file;
  const canEdit = props.role !== 'viewer';

  if (isDir) {
    const children = Array.from(entry.children.values()).sort((a, b) => {
      const aDir = !a.file ? 0 : 1;
      const bDir = !b.file ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
    return (
      <div>
        <div
          className="sidebar-item"
          style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span>{open ? '▾' : '▸'}</span>
          <span>📁 {entry.name}</span>
          <span className="spacer" />
          {canEdit && (
            <span className="actions">
              <button
                className="icon"
                title="New file here"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCreate(entry.path);
                }}
              >
                ＋
              </button>
            </span>
          )}
        </div>
        {open &&
          children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              props={props}
              defaultOpen={false}
            />
          ))}
      </div>
    );
  }

  const file = entry.file!;
  const active = props.activeId === file.id;
  return (
    <div
      className={`sidebar-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: 12 + depth * 12 }}
      data-testid={`file-tree-item-${file.id}`}
      onClick={() => props.onOpen(file)}
    >
      <span>📄</span>
      <span>{entry.name}</span>
      <span className="spacer" />
      {canEdit && (
        <span className="actions">
          <button
            className="icon"
            title="Rename"
            data-testid={`rename-file-${file.id}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onRename(file);
            }}
          >
            ✎
          </button>
          <button
            className="icon"
            title="Delete"
            data-testid={`delete-file-${file.id}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete(file);
            }}
          >
            🗑
          </button>
        </span>
      )}
    </div>
  );
}

export default function FileTree(props: Props) {
  const tree = useMemo(() => buildTree(props.files), [props.files]);
  const canEdit = props.role !== 'viewer';
  const top = Array.from(tree.children.values()).sort((a, b) => {
    const aDir = !a.file ? 0 : 1;
    const bDir = !b.file ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      <div className="sidebar-section">
        <span>Files</span>
        {canEdit && (
          <button
            className="icon"
            title="New file"
            data-testid="new-file-button"
            onClick={() => props.onCreate('')}
          >
            ＋
          </button>
        )}
      </div>
      {props.files.length === 0 && (
        <div className="sidebar-item muted" style={{ fontSize: 12 }}>
          {canEdit ? 'Create your first file' : 'No files yet'}
        </div>
      )}
      {top.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          props={props}
          defaultOpen={true}
        />
      ))}
    </div>
  );
}
