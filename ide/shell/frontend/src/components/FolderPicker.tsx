import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as wailsClient from "../lib/wailsClient";

type FolderPickerProps = {
  initialPath: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
};

function parentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separator < 0) return normalized;
  const parent = normalized.slice(0, separator);
  return parent || normalized.slice(0, separator + 1);
}

// getWorkspaceDir(root, "") returns child nodes whose .path is RELATIVE to root
// (a bare name like "AppData"). Navigating/selecting needs the absolute path,
// otherwise the Go backend resolves the bare name against its own cwd
// (build\bin\AppData) and GetFileAttributesEx fails. Join onto the current
// absolute directory instead.
function joinPath(base: string, name: string): string {
  const trimmed = base.replace(/[\\/]+$/, "");
  return `${trimmed}\\${name}`;
}

export default function FolderPicker({ initialPath, onCancel, onSelect }: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [folders, setFolders] = useState<wailsClient.FileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState(initialPath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const nodes = await wailsClient.getWorkspaceDir(trimmed, "");
      setCurrentPath(trimmed);
      setPathInput(trimmed);
      setSelectedPath(trimmed);
      setFolders(nodes.filter((node) => node.is_dir).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (cause) {
      setFolders([]);
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(initialPath); }, [initialPath, load]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    pathRef.current?.focus();
    pathRef.current?.select();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const parent = useMemo(() => parentPath(currentPath), [currentPath]);
  const navigateInput = () => { const next = pathInput.trim(); if (next) void load(next); };
  const select = () => { if (selectedPath.trim()) onSelect(selectedPath.trim()); };

  return <div className="folder-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
      <header className="folder-picker__header">
        <div><strong id="folder-picker-title">Open Folder</strong><small>Select a workspace folder</small></div>
        <button className="folder-picker__close" onClick={onCancel} aria-label="Close">×</button>
      </header>
      <div className="folder-picker__path-row">
        <button onClick={() => void load(parent)} disabled={parent === currentPath} title="Go up">↑</button>
        <input ref={pathRef} value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") navigateInput(); }} aria-label="Folder path" />
        <button onClick={navigateInput}>Go</button>
      </div>
      <div className="folder-picker__current">{currentPath}</div>
      <div className="folder-picker__list">
        {loading && <div className="folder-picker__empty">Loading folders…</div>}
        {!loading && error && <div className="folder-picker__error">{error}</div>}
        {!loading && !error && !folders.length && <div className="folder-picker__empty">No subfolders</div>}
        {!loading && !error && folders.map((folder) => {
          const absPath = joinPath(currentPath, folder.name);
          return <button key={absPath} className={`folder-picker__folder ${selectedPath === absPath ? "is-selected" : ""}`} onClick={() => setSelectedPath(absPath)} onDoubleClick={() => void load(absPath)}>
            <span className="codicon codicon-folder" /> <span>{folder.name}</span>
          </button>;
        })}
      </div>
      <footer className="folder-picker__footer">
        <span className="folder-picker__hint">Double-click a folder to browse it</span>
        <div><button className="folder-picker__cancel" onClick={onCancel}>Cancel</button><button className="folder-picker__open" onClick={select} disabled={loading || Boolean(error)}>Open Folder</button></div>
      </footer>
    </section>
  </div>;
}
