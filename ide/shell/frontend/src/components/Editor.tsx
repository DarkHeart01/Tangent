import "../lib/monacoSetup";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor, { DiffEditor as MonacoDiffEditor } from "@monaco-editor/react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import * as wailsClient from "../lib/wailsClient";
import type { FileNode } from "../lib/wailsClient";
import { useWorkspace } from "../lib/WorkspaceContext";
import { logInfo, reportError } from "../lib/errorReporting";
import { useSettings } from "../lib/settings";
import mascot from "../assets/meow_mascot.png";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

type OpenTab = { path: string; content: string; savedContent: string; dirty: boolean; saving: boolean; preview: boolean };

type MonacoLikeEditor = { deltaDecorations: (oldIds: string[], decorations: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; options: { isWholeLine?: boolean; linesDecorationsClassName?: string } }>) => string[] };

function gutterDecorations(original: string, modified: string) {
  const before = original.split("\n");
  const after = modified.split("\n");
  const decorations: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; options: { isWholeLine: boolean; linesDecorationsClassName: string } }> = [];
  const max = Math.max(before.length, after.length);
  let index = 0;
  while (index < max) {
    if (before[index] === after[index]) { index += 1; continue; }
    const start = index + 1;
    while (index < max && before[index] !== after[index]) index += 1;
    const end = Math.max(start, index);
    const kind = start > before.length ? "added" : index > after.length ? "deleted" : "modified";
    decorations.push({ range: { startLineNumber: Math.min(start, Math.max(1, after.length)), startColumn: 1, endLineNumber: Math.min(end, Math.max(1, after.length)), endColumn: 1 }, options: { isWholeLine: true, linesDecorationsClassName: `tangent-gutter-${kind}` } });
  }
  return decorations;
}

// Replaces node.children at `path` within a nested tree, leaving everything
// else untouched. Backs on-demand directory expansion for backendRoot
// workspaces - see GetWorkspaceDir/loadedDirs in the Editor component below.
function setChildrenAt(tree: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return tree.map((node) => {
    if (node.path === path) return { ...node, children } as unknown as FileNode;
    if (node.is_dir && node.children && path.startsWith(`${node.path}/`)) {
      return { ...node, children: setChildrenAt(node.children, path, children) } as unknown as FileNode;
    }
    return node;
  });
}

function localTree(files: { path: string }[], folders: string[] = []): FileNode[] {
  const roots: FileNode[] = [];
  for (const entry of [...folders.map((path) => ({ path, is_dir: true })), ...files.map((file) => ({ path: file.path, is_dir: false }))]) {
    const parts = entry.path.split("/"); let current = roots;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let node = current.find((item) => item.name === part);
      const isDir = index < parts.length - 1 || entry.is_dir;
      if (!node) { const created = { name: part, path, is_dir: isDir, children: isDir ? [] : undefined } as unknown as FileNode; current.push(created); node = created; }
      else if (isDir && !node.is_dir) { node.is_dir = true; node.children = []; }
      if (node.is_dir) current = node.children ?? (node.children = []);
    });
  }
  const sort = (nodes: FileNode[]) => { nodes.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name)); nodes.forEach((node) => node.children && sort(node.children)); };
  sort(roots); return roots;
}

// readDirectory in WorkspaceContext no longer reads file content up front
// (large folders were crashing the WebView2 renderer), so browser-handle
// based files carry an empty placeholder until actually opened.
async function loadLocalFileContent(file: { path: string; content: string; handle?: unknown } | undefined) {
  if (!file) return file;
  const handle = file.handle as { getFile?: () => Promise<{ text: () => Promise<string> }> } | undefined;
  if (!handle || typeof handle.getFile !== "function") return file;
  const blob = await handle.getFile();
  return { ...file, content: await blob.text() };
}

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx"].includes(ext ?? "")) return "typescript";
  if (["js", "jsx"].includes(ext ?? "")) return "javascript";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  if (["yaml", "yml"].includes(ext ?? "")) return "yaml";
  if (ext === "py") return "python";
  return "plaintext";
}

function iconForPath(path: string): { icon: string; tone: string } {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (ext === "py") return { icon: "codicon-symbol-method", tone: "python" };
  if (ext === "go") return { icon: "codicon-symbol-function", tone: "go" };
  if (ext === "json") return { icon: "codicon-json", tone: "json" };
  if (ext === "yaml" || ext === "yml") return { icon: "codicon-symbol-structure", tone: "yaml" };
  if (ext === "md") return { icon: "codicon-markdown", tone: "markdown" };
  if (name === ".env" || name.startsWith(".env.")) return { icon: "codicon-symbol-key", tone: "env" };
  if (name === ".gitignore") return { icon: "codicon-source-control", tone: "git" };
  if (name === "dockerfile") return { icon: "codicon-file-code", tone: "docker" };
  return { icon: "codicon-file", tone: "generic" };
}

function FileTreeNode({ node, depth, selectedPath, onSelect, onContextMenu }: { node: FileNode; depth: number; selectedPath: string | null; onSelect: (path: string, preview: boolean) => void; onContextMenu: (event: React.MouseEvent, node: FileNode) => void }) {
  const [open, setOpen] = useState(depth < 2);
  if (node.is_dir) return <div>
    <button className="file-tree__row file-tree__row--dir" style={{ paddingLeft: depth * 14 + 8 }} onClick={() => setOpen((value) => !value)} onContextMenu={(event) => onContextMenu(event, node)}>
      <span className="file-tree__chevron">{open ? "⌄" : "›"}</span><span className="file-tree__folder">▰</span>{node.name}
    </button>
    {open && node.children?.map((child) => <FileTreeNode key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} onContextMenu={onContextMenu} />)}
  </div>;
  return <button className={`file-tree__row file-tree__row--file ${node.path === selectedPath ? "is-selected" : ""}`} style={{ paddingLeft: depth * 14 + 28 }} onClick={() => onSelect(node.path, true)} onContextMenu={(event) => onContextMenu(event, node)}>
    <span className={`file-tree__file-icon file-tree__file-icon--${languageFor(node.path)}`}>{node.name.endsWith(".py") ? "●" : node.name.endsWith(".yaml") || node.name.endsWith(".yml") ? "◆" : "·"}</span>{node.name}
  </button>;
}

type TreeExpandProps = { onExpandDir: (path: string) => void; loadedDirs: Set<string>; onSelectDir: (path: string) => void };

function FileTreeNodePolished({ node, depth, selectedPath, onSelect, onContextMenu, gitFiles, onExpandDir, loadedDirs, onSelectDir }: { node: FileNode; depth: number; selectedPath: string | null; onSelect: (path: string, preview: boolean) => void; onContextMenu: (event: React.MouseEvent, node: FileNode) => void; gitFiles: Record<string, string> } & TreeExpandProps) {
  const [open, setOpen] = useState(false);
  const { workspace, loadFolderChildren } = useWorkspace();
  const gitStatus = gitFiles[node.path];
  const folderChanged = node.is_dir && Object.entries(gitFiles).some(([path, status]) => status !== "I" && path.startsWith(`${node.path}/`));
  // Subdirectories are only enumerated on first expand, whether the
  // workspace is backendRoot (GetWorkspaceDir, see onExpandDir/loadedDirs in
  // the Editor component) or a local browser File System Access handle (see
  // listEntries/loadFolderChildren in WorkspaceContext.tsx) - eager
  // recursion in either was crashing on big repos.
  const toggle = () => setOpen((value) => {
    const next = !value;
    if (next) {
      if (workspace?.backendRoot) {
        if (!loadedDirs.has(node.path)) onExpandDir(node.path);
      } else if (workspace && workspace.folderHandles?.[node.path] && !workspace.loadedFolders?.has(node.path)) {
        void loadFolderChildren(node.path);
      }
    }
    return next;
  });
  if (node.is_dir) return <div>
    <button className={`file-tree__row file-tree__row--dir ${node.path === selectedPath ? "is-selected" : ""}`} style={{ paddingLeft: depth * 14 + 8 }} onClick={() => { onSelectDir(node.path); toggle(); }} onContextMenu={(event) => onContextMenu(event, node)}>
      <span className={`file-tree__chevron codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
      <span className={`file-tree__folder codicon ${open ? "codicon-folder-opened" : "codicon-folder"}`} />
      <span className={folderChanged ? "file-tree__folder-name--changed" : ""}>{node.name}</span>
    </button>
    {open && node.children?.map((child) => <FileTreeNodePolished key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} onContextMenu={onContextMenu} gitFiles={gitFiles} onExpandDir={onExpandDir} loadedDirs={loadedDirs} onSelectDir={onSelectDir} />)}
  </div>;
  const fileIcon = iconForPath(node.path);
  return <button className={`file-tree__row file-tree__row--file ${node.path === selectedPath ? "is-selected" : ""}`} style={{ paddingLeft: depth * 14 + 28 }} onClick={() => onSelect(node.path, true)} onDoubleClick={() => onSelect(node.path, false)} onContextMenu={(event) => onContextMenu(event, node)}>
    <span className={`file-tree__file-icon file-tree__file-icon--${fileIcon.tone} codicon ${fileIcon.icon}`} />
    <span>{node.name}</span>{gitStatus && <span className={`file-tree__git-badge file-tree__git-badge--${gitStatus}`}>{gitStatus}</span>}
  </button>;
}

function Tree({ tree, selectedPath, onSelect, onContextMenu, gitFiles, onExpandDir, loadedDirs, onSelectDir, emptyLabel }: { tree: FileNode[]; selectedPath: string | null; onSelect: (path: string, preview: boolean) => void; onContextMenu: (event: React.MouseEvent, node: FileNode) => void; gitFiles: Record<string, string>; emptyLabel?: string } & TreeExpandProps) {
  if (!tree.length) return <div className="file-tree__empty">{emptyLabel ?? "Start a session to browse its worktree."}</div>;
  return <div className="file-tree">{tree.map((node) => <FileTreeNodePolished key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} onContextMenu={onContextMenu} gitFiles={gitFiles} onExpandDir={onExpandDir} loadedDirs={loadedDirs} onSelectDir={onSelectDir} />)}</div>;
}

export default function Editor({ treeOnly = false }: { treeOnly?: boolean } = {}) {
  const { activeSessionId, activeWsClient } = useSession();
  const { workspace, saveFile, createFile, createFolder, renamePath, deletePath } = useWorkspace();
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loadedDirs, setLoadedDirs] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Record<string, OpenTab>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedIsDir, setSelectedIsDir] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const [gitFiles, setGitFiles] = useState<Record<string, string>>({});
  const [diffView, setDiffView] = useState<{ path: string; original: string; modified: string; staged: boolean; inline: boolean } | null>(null);
  const editorRef = useRef<MonacoLikeEditor | null>(null);
  const gutterDecorationIds = useRef<string[]>([]);
  const [gutterDiff, setGutterDiff] = useState<wailsClient.GitDiff | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);
  const settings = useSettings();

  // Jumps the editor to a pending line once its file is the active tab and
  // Monaco is mounted (a search result carries the target line). Retried from
  // both the selectedPath effect and onMount because either can happen first.
  const tryReveal = useCallback(() => {
    const target = pendingRevealRef.current;
    const ed = editorRef.current as unknown as { revealLineInCenter?: (n: number) => void; setPosition?: (p: { lineNumber: number; column: number }) => void; focus?: () => void } | null;
    if (!target || !ed || selectedPath !== target.path || typeof ed.revealLineInCenter !== "function") return;
    ed.revealLineInCenter(target.line);
    ed.setPosition?.({ lineNumber: target.line, column: 1 });
    ed.focus?.();
    pendingRevealRef.current = null;
  }, [selectedPath]);

  const refreshTree = useCallback(async (sessionId: string) => {
    try { setTree(await wailsClient.getWorkspaceTree(sessionId)); setLoadError(null); }
    catch (error) { setTree([]); setLoadError(String(error)); }
  }, []);

  // Only the root level - GetWorkspaceTreeAt walks the whole tree eagerly,
  // which for a heavy repo (node_modules, build output, vendored deps) sends
  // one huge nested payload over the Wails IPC bridge before the explorer
  // can render anything. Subdirectories load on demand via expandBackendDir.
  const refreshWorkspaceTree = useCallback(async (root: string) => {
    logInfo("workspace-tree", `loading root of ${root}`);
    try {
      const nodes = await wailsClient.getWorkspaceDir(root, "");
      setTree(nodes); setLoadedDirs(new Set([""])); setLoadError(null);
      logInfo("workspace-tree", `root loaded (${nodes.length} entries)`);
    }
    catch (error) { setTree([]); setLoadError(String(error)); reportError("workspace-tree", error); }
  }, []);

  const expandBackendDir = useCallback(async (path: string) => {
    if (!workspace?.backendRoot) return;
    try {
      const children = await wailsClient.getWorkspaceDir(workspace.rootPath, path);
      setTree((current) => setChildrenAt(current, path, children));
      setLoadedDirs((current) => new Set(current).add(path));
    } catch (error) { setLoadError(String(error)); }
  }, [workspace]);

  useEffect(() => {
    const handler = (event: Event) => setGitFiles((event as CustomEvent<Record<string, string>>).detail ?? {});
    window.addEventListener("tangent:git-status", handler);
    return () => window.removeEventListener("tangent:git-status", handler);
  }, []);

  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; staged?: boolean }>).detail;
      if (!detail?.path || !workspace?.backendRoot) return;
      try {
        const diff = await wailsClient.gitDiff(workspace.rootPath, detail.path, Boolean(detail.staged));
        setDiffView({ ...diff, inline: false });
      } catch (error) { setLoadError(String(error)); }
    };
    window.addEventListener("tangent:open-diff", handler);
    return () => window.removeEventListener("tangent:open-diff", handler);
  }, [workspace]);

  useEffect(() => {
    setTree(activeSessionId || workspace?.backendRoot ? [] : localTree(workspace?.files ?? [], workspace?.folders ?? [])); setTabs({}); setSelectedPath(null); setLoadError(null);
    if (activeSessionId) refreshTree(activeSessionId);
    else if (workspace?.backendRoot) refreshWorkspaceTree(workspace.rootPath);
  // A new session changes the authoritative tree and resets editor state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, refreshTree, refreshWorkspaceTree]);

  useEffect(() => {
    if (!activeSessionId) {
      if (workspace?.backendRoot) void refreshWorkspaceTree(workspace.rootPath);
      else setTree(localTree(workspace?.files ?? [], workspace?.folders ?? []));
    }
  }, [activeSessionId, refreshWorkspaceTree, workspace]);

  useEffect(() => {
    if (!activeWsClient || !activeSessionId) return;
    return onEnvelopeType(activeWsClient, "file.changed", (payload) => {
      refreshTree(activeSessionId);
      const tab = tabs[payload.path];
      if (tab && !tab.dirty) void openFile(payload.path, false);
    });
  // The websocket callback intentionally reads the latest tab map through the callback below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWsClient, activeSessionId, refreshTree]);

  const openFile = useCallback(async (path: string, preview = true) => {
    setDiffView(null);
    const existing = tabs[path];
    if (existing) {
      setSelectedPath(path);
      if (!preview && existing.preview) setTabs((current) => ({ ...current, [path]: { ...current[path], preview: false } }));
      return;
    }
    try {
      const file = activeSessionId ? await wailsClient.readFile(activeSessionId, path) : workspace?.backendRoot ? await wailsClient.readWorkspaceFile(workspace.rootPath, path) : await loadLocalFileContent(workspace?.files.find((item) => item.path === path));
      if (!file) return;
      setTabs((current) => {
        const next = { ...current };
        if (preview) {
          const reusable = Object.values(next).find((tab) => tab.preview && !tab.dirty && tab.path !== path);
          if (reusable) delete next[reusable.path];
        }
        next[path] = { path, content: file.content, savedContent: file.content, dirty: false, saving: false, preview };
        return next;
      });
      setSelectedPath(path);
      setLoadError(null);
    } catch (error) { setLoadError(String(error)); }
  }, [activeSessionId, tabs, workspace]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string | { path: string; preview?: boolean; line?: number }>).detail;
      const path = typeof detail === "string" ? detail : detail?.path;
      const preview = typeof detail === "string" ? true : detail?.preview ?? true;
      const line = typeof detail === "string" ? undefined : detail?.line;
      if (!path) return;
      pendingRevealRef.current = line && line > 0 ? { path, line } : null;
      void openFile(path, preview);
    };
    window.addEventListener("tangent:open-file", handler);
    return () => window.removeEventListener("tangent:open-file", handler);
  }, [openFile]);

  // Reveal a pending search-target line once the file is active (rAF lets
  // Monaco swap to the new model first).
  useEffect(() => {
    if (!pendingRevealRef.current) return;
    const raf = requestAnimationFrame(tryReveal);
    return () => cancelAnimationFrame(raf);
  }, [selectedPath, tryReveal]);

  const activeTab = selectedPath ? tabs[selectedPath] : null;
  useEffect(() => {
    let cancelled = false;
    if (!activeTab || !workspace?.backendRoot || !gitFiles[activeTab.path]) {
      setGutterDiff(null);
      gutterDecorationIds.current = editorRef.current?.deltaDecorations(gutterDecorationIds.current, []) ?? [];
      return () => { cancelled = true; };
    }
    void wailsClient.gitDiff(workspace.rootPath, activeTab.path, false).then((diff) => { if (!cancelled) setGutterDiff(diff); }).catch(() => { if (!cancelled) setGutterDiff(null); });
    return () => { cancelled = true; };
  }, [activeTab, gitFiles, workspace]);
  useEffect(() => {
    if (!editorRef.current) return;
    gutterDecorationIds.current = editorRef.current.deltaDecorations(gutterDecorationIds.current, gutterDiff ? gutterDecorations(gutterDiff.original, gutterDiff.modified) : []);
  }, [gutterDiff]);
  const updateTab = useCallback((path: string, patch: Partial<OpenTab>) => setTabs((current) => ({ ...current, [path]: { ...current[path], ...patch } })), []);

  const save = useCallback(async (path: string) => {
    if (!tabs[path] || !tabs[path].dirty) return;
    updateTab(path, { saving: true });
    try {
      if (activeSessionId) await wailsClient.writeFile(activeSessionId, path, tabs[path].content);
      else await saveFile(path, tabs[path].content);
      updateTab(path, { savedContent: tabs[path].content, dirty: false, saving: false });
    } catch (error) { updateTab(path, { saving: false }); setLoadError(String(error)); }
  }, [activeSessionId, saveFile, tabs, updateTab]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && selectedPath) { event.preventDefault(); void save(selectedPath); } };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [save, selectedPath]);

  const closeTab = useCallback(async (path: string) => {
    const tab = tabs[path];
    if (tab?.dirty && !window.confirm(`Save changes to ${path} before closing?`)) return;
    if (tab?.dirty) {
      try { if (activeSessionId) await wailsClient.writeFile(activeSessionId, path, tab.content); else await saveFile(path, tab.content); }
      catch (error) { setLoadError(String(error)); return; }
    }
    setTabs((current) => { const next = { ...current }; delete next[path]; return next; });
    if (selectedPath === path) setSelectedPath(Object.keys(tabs).find((key) => key !== path) ?? null);
  }, [activeSessionId, saveFile, selectedPath, tabs]);

  const tabList = useMemo(() => Object.values(tabs), [tabs]);
  const showContextMenu = (event: React.MouseEvent, node: FileNode) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  };
  const copyPath = async (path: string) => { try { await navigator.clipboard?.writeText(path); } catch { /* clipboard permissions are optional */ } };
  const openTerminal = () => window.dispatchEvent(new CustomEvent("tangent:focus-terminal"));
  const deleteNode = async (path: string) => {
    if (activeSessionId) { window.alert("Deleting session worktree files requires the backend workspace API."); return; }
    await deletePath(path);
    setTabs((current) => { const next = { ...current }; Object.keys(next).filter((key) => key === path || key.startsWith(`${path}/`)).forEach((key) => delete next[key]); return next; });
    if (selectedPath === path || selectedPath?.startsWith(`${path}/`)) setSelectedPath(null);
  };
  const contextItems: ContextMenuItem[] = contextMenu ? [
    { label: "Open File…", onClick: () => { if (!contextMenu.node.is_dir) window.dispatchEvent(new CustomEvent("tangent:open-file", { detail: { path: contextMenu.node.path, preview: false } })); }, disabled: contextMenu.node.is_dir },
    { label: "Rename…", onClick: () => void renamePath(contextMenu.node.path) },
    { label: "New File…", onClick: () => createFile(contextMenu.node.is_dir ? contextMenu.node.path : ""), disabled: Boolean(activeSessionId) },
    { label: "New Folder…", onClick: () => createFolder(contextMenu.node.is_dir ? contextMenu.node.path : ""), disabled: Boolean(activeSessionId) },
    { label: "Open in Integrated Terminal", onClick: openTerminal },
    { label: "Copy Path", shortcut: "Shift+Alt+C", onClick: () => void copyPath(contextMenu.node.path) },
    { label: "Copy Relative Path", shortcut: "Ctrl+K Ctrl+Shift+C", onClick: () => void copyPath(contextMenu.node.path) },
    { separator: true, label: "" },
    { label: "Delete", onClick: () => void deleteNode(contextMenu.node.path) },
  ] : [];
  // Explorer-header New File / New Folder buttons (dispatched from App). Only
  // the tree instance handles them, creating inside the selected folder (or the
  // selected file's parent, or the workspace root when nothing is selected).
  useEffect(() => {
    if (!treeOnly) return;
    const targetDir = () => selectedPath ? (selectedIsDir ? selectedPath : selectedPath.split("/").slice(0, -1).join("/")) : "";
    const onNewFile = () => void createFile(targetDir());
    const onNewFolder = () => void createFolder(targetDir());
    window.addEventListener("tangent:new-file", onNewFile);
    window.addEventListener("tangent:new-folder", onNewFolder);
    return () => { window.removeEventListener("tangent:new-file", onNewFile); window.removeEventListener("tangent:new-folder", onNewFolder); };
  }, [treeOnly, selectedPath, selectedIsDir, createFile, createFolder]);

  const breadcrumbRoot = workspace?.name ?? (activeSessionId ? `session/${activeSessionId}` : "tangent-swarm");
  if (treeOnly) return <>
    <Tree tree={tree} selectedPath={selectedPath}
      onSelect={(path, preview) => { setSelectedPath(path); setSelectedIsDir(false); window.dispatchEvent(new CustomEvent("tangent:open-file", { detail: { path, preview } })); }}
      onSelectDir={(path) => { setSelectedPath(path); setSelectedIsDir(true); }}
      onContextMenu={showContextMenu} gitFiles={gitFiles} onExpandDir={(path) => void expandBackendDir(path)} loadedDirs={loadedDirs}
      emptyLabel={workspace ? "This folder is empty." : activeSessionId ? undefined : "Open a folder to start browsing files."} />
    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextItems} onClose={() => setContextMenu(null)} />}
  </>;

  return <div className="editor-workspace">
    <div className="editor-tabs" ref={tabStripRef} onWheel={(event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        event.currentTarget.scrollLeft += event.deltaY;
      }
    }}>
      {tabList.map((tab) => <button key={tab.path} className={`editor-tab ${tab.path === selectedPath ? "is-active" : ""} ${tab.preview ? "is-preview" : ""}`} onClick={() => setSelectedPath(tab.path)}>
        <span className={`editor-tab__icon editor-tab__icon--${languageFor(tab.path)}`}>{languageFor(tab.path) === "python" ? "●" : "◆"}</span>{tab.path.split("/").pop()}
        {tab.dirty && <span className="editor-tab__dirty">●</span>}
        <span className="editor-tab__close" onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}>×</span>
      </button>)}
      {!tabList.length && <span className="editor-tabs__empty">No file open</span>}
    </div>
    <div className="editor-breadcrumb"><span className="editor-breadcrumb__root">{breadcrumbRoot}</span><span className="editor-breadcrumb__separator codicon codicon-chevron-right" /><span className="editor-breadcrumb__path">{selectedPath ?? "No file selected"}</span></div>
    {loadError && <div className="editor-inline-error">{loadError}</div>}
    <div className="editor-pane">
      {diffView ? <>
        <div className="diff-toolbar"><strong>{diffView.path}</strong><span /><button className={diffView.inline ? "is-active" : ""} onClick={() => setDiffView((current) => current ? { ...current, inline: true } : current)}>Inline</button><button className={!diffView.inline ? "is-active" : ""} onClick={() => setDiffView((current) => current ? { ...current, inline: false } : current)}>Side by side</button><button className="icon-button" onClick={() => setDiffView(null)} title="Close diff">×</button></div>
        <MonacoDiffEditor
          height="100%" language={languageFor(diffView.path)} theme={settings.theme === "light" ? "vs" : "vs-dark"} original={diffView.original} modified={diffView.modified}
          options={{ renderSideBySide: !diffView.inline, minimap: { enabled: settings.editorMinimap }, fontFamily: "Cascadia Code, Consolas, 'SFMono-Regular', monospace", fontSize: settings.editorFontSize, automaticLayout: true, scrollBeyondLastLine: false }}
        />
      </> : activeTab ? <>
        <div className="editor-pane__meta"><span>{activeTab.path}</span><span>{activeTab.saving ? "Saving…" : activeTab.dirty ? "Unsaved" : "Saved"}</span></div>
        <MonacoEditor
          height="100%" language={languageFor(activeTab.path)} value={activeTab.content} theme={settings.theme === "light" ? "vs" : "vs-dark"}
          onMount={(editor) => { editorRef.current = editor; gutterDecorationIds.current = editor.deltaDecorations([], gutterDiff ? gutterDecorations(gutterDiff.original, gutterDiff.modified) : []); tryReveal(); }}
          onChange={(value) => updateTab(activeTab.path, { content: value ?? "", dirty: (value ?? "") !== activeTab.savedContent, preview: false })}
          options={{ minimap: { enabled: settings.editorMinimap }, fontFamily: "Cascadia Code, Consolas, 'SFMono-Regular', monospace", fontSize: settings.editorFontSize, tabSize: settings.editorTabSize, lineNumbers: settings.editorLineNumbers ? "on" : "off", padding: { top: 12 }, smoothScrolling: true, scrollBeyondLastLine: false, renderWhitespace: "selection", wordWrap: settings.editorWordWrap, automaticLayout: true }}
        />
      </> : <div className="editor-empty"><img src={mascot} alt="Tangent" className="editor-empty__logo-img" /><h2>Tangent IDE</h2><p>Select a file from Explorer to start editing.</p><p className="editor-empty__hint">Start a swarm session to create an editable worktree.</p></div>}
    </div>
  </div>;
}
