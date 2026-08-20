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
import { useSettings, effectiveLevel } from "../lib/settings";
import mascot from "../assets/meow_mascot.png";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { useCodeIntel } from "../lib/codeintel/CodeIntelContext";
import { showToast } from "../lib/toast";
import { parseIncremental, findEnclosingScope, forgetFile, getTree, type TextEdit, type Span as CISpan } from "../lib/codeintel/treeSitter";
import { registerInlineCompletionProvider } from "../lib/codeintel/inlineCompletion";
import type * as monacoNS from "monaco-editor";

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

// Terminal menu's "Run Active File" (AccessBar.tsx). A small, honest set of
// interpreters -- returns null (toast, not a fake run) for anything else
// rather than guessing.
function runCommandForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "py") return `python "${path}"`;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return `node "${path}"`;
  if (ext === "ts" || ext === "tsx") return `npx tsx "${path}"`;
  if (ext === "go") return `go run "${path}"`;
  if (ext === "sh") return `bash "${path}"`;
  if (ext === "ps1") return `powershell -File "${path}"`;
  return null;
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

// Converts one Monaco content change (1-indexed line/column) into a
// tree-sitter TextEdit (0-indexed row/column) -- Monaco's `changes` array
// lists edits in descending document-offset order specifically so each one
// can be applied without adjusting for the others, which is also exactly
// what Tree.edit() needs called in that same order.
function monacoChangeToTextEdit(change: monacoNS.editor.IModelContentChange): TextEdit {
  const startIndex = change.rangeOffset;
  const oldEndIndex = change.rangeOffset + change.rangeLength;
  const newIndex = change.rangeOffset + change.text.length;
  const startPosition = { row: change.range.startLineNumber - 1, column: change.range.startColumn - 1 };
  const oldEndPosition = { row: change.range.endLineNumber - 1, column: change.range.endColumn - 1 };
  const newlineCount = (change.text.match(/\n/g) ?? []).length;
  const newEndPosition = newlineCount === 0
    ? { row: startPosition.row, column: startPosition.column + change.text.length }
    : { row: startPosition.row + newlineCount, column: change.text.length - change.text.lastIndexOf("\n") - 1 };
  return { startIndex, oldEndIndex, newIndex, startPosition, oldEndPosition, newEndPosition };
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
  // Container-mode sessions run in a full monorepo worktree, so the tree
  // root is mostly the swarm engine's own source (agents/, tools/,
  // configs/, etc) — everything the filesystem tool actually writes for
  // the user gets redirected into built/ (tools/filesystem/handler.py).
  // Auto-expand just that one root-level folder so a written file is
  // visible without the user needing to know the redirect exists at all;
  // everything else still defaults collapsed as before.
  const [open, setOpen] = useState(depth === 0 && node.is_dir && node.name === "built");
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
  // Promote built/ to the top of the root listing — it's auto-expanded
  // (see FileTreeNodePolished) and is what the user actually cares about;
  // everything else keeps its existing order.
  const ordered = tree.some((n) => n.is_dir && n.name === "built")
    ? [...tree].sort((a, b) => Number(b.is_dir && b.name === "built") - Number(a.is_dir && a.name === "built"))
    : tree;
  return <div className="file-tree">{ordered.map((node) => <FileTreeNodePolished key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} onContextMenu={onContextMenu} gitFiles={gitFiles} onExpandDir={onExpandDir} loadedDirs={loadedDirs} onSelectDir={onSelectDir} />)}</div>;
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

  // ── Live Code Intelligence Engine (only the non-treeOnly instance runs
  // this -- the sidebar's Editor instance never mounts Monaco at all, so
  // registering these listeners there would be dead weight at best and a
  // duplicate/conflicting CodeIntelUpdateFile call at worst). Needs real
  // filesystem access (the Go engine spawns a language server rooted at the
  // workspace), so it's further gated on workspace.backendRoot. ──
  const { enabled: codeIntelEnabled, diagnosticsByFile } = useCodeIntel();
  const codeIntelActive = !treeOnly && codeIntelEnabled && Boolean(workspace?.backendRoot);
  const monacoNsRef = useRef<typeof monacoNS | null>(null);
  const codeIntelDisposablesRef = useRef<{ dispose: () => void }[]>([]);
  // Refs so the once-registered Monaco listeners (below) always see current
  // state without needing to be torn down and re-registered on every
  // keystroke/tab switch.
  const codeIntelActiveRef = useRef(codeIntelActive);
  const activeTabPathRef = useRef<string | null>(null);
  const workspaceRootRef = useRef<string | null>(null);
  const scopeSpansRef = useRef<Map<string, CISpan | null>>(new Map());
  const pendingEditsRef = useRef<Map<string, TextEdit[]>>(new Map());
  const parseTimerRef = useRef<number | null>(null);
  useEffect(() => { codeIntelActiveRef.current = codeIntelActive; }, [codeIntelActive]);
  useEffect(() => { workspaceRootRef.current = workspace?.rootPath ?? null; }, [workspace?.rootPath]);
  // Tiering's focus/blur signal (spec §3: hot on focus, warm on losing
  // focus) -- fires on every tab switch, demoting whatever was active
  // before and promoting the new one.
  useEffect(() => {
    const previous = activeTabPathRef.current;
    const next = activeTab?.path ?? null;
    activeTabPathRef.current = next;
    if (!codeIntelActive || !workspace?.rootPath) return;
    if (previous && previous !== next) void wailsClient.codeIntelSetFocus(workspace.rootPath, previous, false);
    if (next) void wailsClient.codeIntelSetFocus(workspace.rootPath, next, true);
  }, [activeTab?.path, codeIntelActive, workspace?.rootPath]);

  const isTreeSitterPath = (path: string) => /\.(ts|tsx|js|jsx)$/.test(path);
  const isPythonPath = (path: string) => /\.py$/.test(path);
  const isCodeIntelPath = (path: string) => isTreeSitterPath(path) || isPythonPath(path);

  const flushCodeIntelParse = useCallback((path: string, content: string) => {
    const root = workspaceRootRef.current;
    if (!root) return;
    const cursorLine = editorRef.current
      ? ((editorRef.current as unknown as { getPosition?: () => { lineNumber: number } | null }).getPosition?.()?.lineNumber ?? 1) - 1
      : 0;

    if (isPythonPath(path)) {
      // No tree-sitter grammar for Python (Tier B is regex/filesystem
      // best-effort, entirely Go-side -- see py_adapter.go) -- send raw
      // content and let the engine extract+resolve synchronously.
      void wailsClient.codeIntelUpdateFile(root, path, content, [], [], true, cursorLine);
      return;
    }

    const edits = pendingEditsRef.current.get(path) ?? [];
    pendingEditsRef.current.delete(path);
    parseIncremental(path, content, edits)
      .then((result) => wailsClient.codeIntelUpdateFile(root, path, content, result.nodes, result.edges, !result.hasSyntaxError, cursorLine))
      .catch(() => {
        // A tree-sitter/backend hiccup here just means this one update is
        // skipped -- forget the file's parser state so the next edit does a
        // clean full parse instead of building on whatever went wrong.
        forgetFile(path);
      });
  }, []);

  const scheduleCodeIntelParse = useCallback((path: string, content: string, edit: TextEdit | null) => {
    if (edit) {
      const existing = pendingEditsRef.current.get(path) ?? [];
      existing.push(edit);
      pendingEditsRef.current.set(path, existing);
    }
    if (parseTimerRef.current !== null) window.clearTimeout(parseTimerRef.current);
    parseTimerRef.current = window.setTimeout(() => flushCodeIntelParse(path, content), 250);
  }, [flushCodeIntelParse]);

  // Registered once in onMount (see the MonacoEditor below), not per-render:
  // both read exclusively through refs so they stay correct across tab
  // switches without needing to be re-subscribed.
  const registerCodeIntelListeners = useCallback((editor: monacoNS.editor.IStandaloneCodeEditor) => {
    codeIntelDisposablesRef.current.forEach((d) => d.dispose());
    codeIntelDisposablesRef.current = [];

    // Level 1's real ghost-text completion (see inlineCompletion.ts) --
    // a global `languages` registration, not tied to this editor instance,
    // so it's registered once (module-level guard) and reads current
    // state through the same refs every other listener here uses.
    if (monacoNsRef.current) {
      registerInlineCompletionProvider(monacoNsRef.current, () => ({
        enabled: codeIntelActiveRef.current,
        root: workspaceRootRef.current,
        path: activeTabPathRef.current,
      }));
    }

    codeIntelDisposablesRef.current.push(editor.onDidChangeModelContent((event) => {
      if (!codeIntelActiveRef.current) return;
      const path = activeTabPathRef.current;
      if (!path || !isCodeIntelPath(path)) return;
      const model = editor.getModel();
      if (!model) return;
      const content = model.getValue();
      if (isPythonPath(path)) {
        scheduleCodeIntelParse(path, content, null); // no tree-sitter edits to accumulate
        return;
      }
      for (const change of event.changes) {
        scheduleCodeIntelParse(path, content, monacoChangeToTextEdit(change));
      }
    }));

    codeIntelDisposablesRef.current.push(editor.onDidChangeCursorPosition((event) => {
      if (!codeIntelActiveRef.current) return;
      const path = activeTabPathRef.current;
      const root = workspaceRootRef.current;
      if (!path || !root || !isCodeIntelPath(path)) return;

      if (isPythonPath(path)) {
        // No parse tree to walk for structural scope-exit (Tier B has no
        // grammar) -- Gate 3 falls back to file-level granularity: the
        // idle timer alone decides when to sweep, batching every dangling
        // import in the file together rather than per-function.
        const model = editor.getModel();
        const lineCount = model?.getLineCount() ?? 1;
        void wailsClient.codeIntelArmIdleFallback(root, path, { start_line: 0, start_col: 0, end_line: lineCount, end_col: 0 });
        return;
      }

      const tree = getTree(path);
      if (!tree) return;
      const row = event.position.lineNumber - 1;
      const col = event.position.column - 1;
      const scope = findEnclosingScope(tree, row, col);
      const previous = scopeSpansRef.current.get(path) ?? null;
      const changed = !previous || !scope
        ? previous !== scope
        : previous.start_line !== scope.start_line || previous.start_col !== scope.start_col || previous.end_line !== scope.end_line || previous.end_col !== scope.end_col;
      if (changed) {
        if (previous) void wailsClient.codeIntelSignalScopeExit(root, path, previous);
        scopeSpansRef.current.set(path, scope);
      }
      if (scope) void wailsClient.codeIntelArmIdleFallback(root, path, scope);
    }));
  }, [scheduleCodeIntelParse]);

  // Monaco markers (squiggles) for whatever diagnostics the context has for
  // the active file -- separate from the parse/gate pipeline above, this
  // just reflects state the context already receives from the
  // "codeintel.diagnostics" Wails event.
  useEffect(() => {
    if (!codeIntelActive || !activeTab || !monacoNsRef.current || !editorRef.current) return;
    const monaco = monacoNsRef.current;
    const model = (editorRef.current as unknown as { getModel?: () => monacoNS.editor.ITextModel | null }).getModel?.();
    if (!model) return;
    const edges = diagnosticsByFile.get(activeTab.path) ?? [];
    const markers: monacoNS.editor.IMarkerData[] = edges.map((edge) => ({
      severity: edge.resolution_state === "resolution-failed" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      message: edge.message || `Unresolved reference: ${edge.to_name}`,
      startLineNumber: edge.span.start_line + 1,
      startColumn: edge.span.start_col + 1,
      endLineNumber: edge.span.end_line + 1,
      endColumn: edge.span.end_col + 1,
    }));
    monaco.editor.setModelMarkers(model, "tangent-codeintel", markers);
  }, [codeIntelActive, activeTab, diagnosticsByFile]);

  useEffect(() => () => {
    codeIntelDisposablesRef.current.forEach((d) => d.dispose());
    if (parseTimerRef.current !== null) window.clearTimeout(parseTimerRef.current);
  }, []);

  const updateTab = useCallback((path: string, patch: Partial<OpenTab>) => setTabs((current) => ({ ...current, [path]: { ...current[path], ...patch } })), []);

  const save = useCallback(async (path: string) => {
    if (!tabs[path] || !tabs[path].dirty) return;
    updateTab(path, { saving: true });
    try {
      if (activeSessionId) await wailsClient.writeFile(activeSessionId, path, tabs[path].content);
      else await saveFile(path, tabs[path].content);
      updateTab(path, { savedContent: tabs[path].content, dirty: false, saving: false });
      // Level 2's trigger: on-demand (per save), not live -- see the plan's
      // stated cost-control rationale for folder/root-level suggestions.
      if (codeIntelActive && effectiveLevel(settings) >= 2 && workspace?.rootPath) {
        void wailsClient.codeIntelFileSaved(workspace.rootPath, path);
      }
    } catch (error) { updateTab(path, { saving: false }); setLoadError(String(error)); }
  }, [activeSessionId, codeIntelActive, saveFile, settings, tabs, updateTab, workspace?.rootPath]);

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
    forgetFile(path);
    scopeSpansRef.current.delete(path);
    if (codeIntelActive && workspace?.rootPath) void wailsClient.codeIntelForgetFile(workspace.rootPath, path);
  }, [activeSessionId, codeIntelActive, saveFile, selectedPath, tabs, workspace?.rootPath]);

  // File-menu actions (AccessBar.tsx) that need the active-editor-pane's own
  // state -- only the main (non-treeOnly) instance has real tabs, see the
  // treeOnly early-return below and the New File/Folder listeners above for
  // the mirror-image guard.
  useEffect(() => {
    if (treeOnly) return;
    const onSave = () => { if (selectedPath) void save(selectedPath); };
    const onSaveAll = () => { Object.values(tabs).filter((tab) => tab.dirty).forEach((tab) => void save(tab.path)); };
    const onSaveAs = async () => {
      if (!selectedPath || !tabs[selectedPath]) { showToast("No file open to Save As.", "info"); return; }
      const requested = window.prompt("Save As — relative path", selectedPath)?.trim();
      if (!requested || requested === selectedPath) return;
      const content = tabs[selectedPath].content;
      try {
        if (activeSessionId) await wailsClient.writeFile(activeSessionId, requested, content);
        else await saveFile(requested, content);
        setTabs((current) => {
          const next = { ...current };
          delete next[selectedPath];
          next[requested] = { path: requested, content, savedContent: content, dirty: false, saving: false, preview: false };
          return next;
        });
        setSelectedPath(requested);
        if (activeSessionId) refreshTree(activeSessionId);
        else if (workspace?.backendRoot) refreshWorkspaceTree(workspace.rootPath);
        showToast(`Saved as ${requested}`, "success");
      } catch (error) { setLoadError(String(error)); }
    };
    const onRevert = async () => {
      if (!selectedPath || !tabs[selectedPath]) { showToast("No file open to revert.", "info"); return; }
      if (tabs[selectedPath].dirty && !window.confirm(`Discard changes to ${selectedPath}?`)) return;
      try {
        const file = activeSessionId
          ? await wailsClient.readFile(activeSessionId, selectedPath)
          : workspace?.backendRoot ? await wailsClient.readWorkspaceFile(workspace.rootPath, selectedPath) : null;
        if (!file) { showToast("This file can't be reverted from disk.", "info"); return; }
        updateTab(selectedPath, { content: file.content, savedContent: file.content, dirty: false });
        showToast(`Reverted ${selectedPath}`, "success");
      } catch (error) { setLoadError(String(error)); }
    };
    const onCloseEditor = () => { if (selectedPath) void closeTab(selectedPath); };
    window.addEventListener("tangent:save-file", onSave);
    window.addEventListener("tangent:save-all", onSaveAll);
    window.addEventListener("tangent:save-file-as", onSaveAs);
    window.addEventListener("tangent:revert-file", onRevert);
    window.addEventListener("tangent:close-editor", onCloseEditor);
    return () => {
      window.removeEventListener("tangent:save-file", onSave);
      window.removeEventListener("tangent:save-all", onSaveAll);
      window.removeEventListener("tangent:save-file-as", onSaveAs);
      window.removeEventListener("tangent:revert-file", onRevert);
      window.removeEventListener("tangent:close-editor", onCloseEditor);
    };
  }, [treeOnly, selectedPath, tabs, save, closeTab, activeSessionId, saveFile, workspace, refreshTree, refreshWorkspaceTree, updateTab]);

  // File > Auto Save -- debounce-saves the active dirty tab, reusing the same
  // save() Ctrl+S already calls. Pure frontend; no new backend involved.
  useEffect(() => {
    if (treeOnly || !settings.autoSaveEnabled) return;
    const path = selectedPath;
    if (!path || !tabs[path]?.dirty) return;
    const timer = window.setTimeout(() => void save(path), 1200);
    return () => window.clearTimeout(timer);
  }, [treeOnly, settings.autoSaveEnabled, selectedPath, tabs, save]);

  // Edit/Selection-menu commands (AccessBar.tsx) -- almost all of these are
  // real, standard Monaco actions, dispatched by id and run directly against
  // the mounted editor instance via Monaco's own trigger() entry point.
  // selectAll is handled by hand since "editor.action.selectAll" isn't a
  // reliably-registered action id across Monaco versions.
  useEffect(() => {
    if (treeOnly) return;
    const onEditorCommand = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      const ed = editorRef.current as unknown as {
        trigger?: (source: string, handlerId: string, payload: unknown) => void;
        focus?: () => void;
        getModel?: () => { getFullModelRange?: () => unknown } | null;
        setSelection?: (range: unknown) => void;
      } | null;
      if (!id || !ed) { showToast("Open a file first.", "info"); return; }
      if (id === "selectAll") {
        const range = ed.getModel?.()?.getFullModelRange?.();
        if (range) ed.setSelection?.(range);
      } else {
        ed.trigger?.("menu", id, null);
      }
      ed.focus?.();
    };
    window.addEventListener("tangent:editor-command", onEditorCommand);
    return () => window.removeEventListener("tangent:editor-command", onEditorCommand);
  }, [treeOnly]);

  // Terminal menu's "Run Active File" / "Run Selected Text" -- computed here
  // (this instance owns selectedPath/the live selection) and handed off to
  // Terminal.tsx as a plain command string via tangent:terminal-run.
  useEffect(() => {
    if (treeOnly) return;
    const onRunActiveFile = () => {
      if (!selectedPath) { showToast("Open a file first.", "info"); return; }
      const command = runCommandForPath(selectedPath);
      if (!command) { showToast("Don't know how to run this file type yet.", "info"); return; }
      window.dispatchEvent(new CustomEvent("tangent:terminal-run", { detail: { command } }));
      window.dispatchEvent(new CustomEvent("tangent:focus-terminal"));
    };
    const onRunSelectedText = () => {
      const ed = editorRef.current as unknown as { getModel?: () => { getValueInRange?: (range: unknown) => string } | null; getSelection?: () => unknown } | null;
      const selection = ed?.getSelection?.();
      const text = selection ? ed?.getModel?.()?.getValueInRange?.(selection) : "";
      if (!text?.trim()) { showToast("Select some text first.", "info"); return; }
      window.dispatchEvent(new CustomEvent("tangent:terminal-run", { detail: { command: text } }));
      window.dispatchEvent(new CustomEvent("tangent:focus-terminal"));
    };
    window.addEventListener("tangent:run-active-file", onRunActiveFile);
    window.addEventListener("tangent:run-selected-text", onRunSelectedText);
    return () => {
      window.removeEventListener("tangent:run-active-file", onRunActiveFile);
      window.removeEventListener("tangent:run-selected-text", onRunSelectedText);
    };
  }, [treeOnly, selectedPath]);

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
          onMount={(editor, monaco) => { editorRef.current = editor; monacoNsRef.current = monaco; registerCodeIntelListeners(editor); gutterDecorationIds.current = editor.deltaDecorations([], gutterDiff ? gutterDecorations(gutterDiff.original, gutterDiff.modified) : []); tryReveal(); }}
          onChange={(value) => updateTab(activeTab.path, { content: value ?? "", dirty: (value ?? "") !== activeTab.savedContent, preview: false })}
          options={{ minimap: { enabled: settings.editorMinimap }, fontFamily: "Cascadia Code, Consolas, 'SFMono-Regular', monospace", fontSize: settings.editorFontSize, tabSize: settings.editorTabSize, lineNumbers: settings.editorLineNumbers ? "on" : "off", padding: { top: 12 }, smoothScrolling: true, scrollBeyondLastLine: false, renderWhitespace: "selection", wordWrap: settings.editorWordWrap, automaticLayout: true, multiCursorModifier: settings.editorMultiCursorModifier, columnSelection: settings.editorColumnSelection }}
        />
      </> : <div className="editor-empty"><img src={mascot} alt="Tangent" className="editor-empty__logo-img" /><div className="editor-empty__wordmark">TANGENT</div><p>Select a file from Explorer to start editing.</p><p className="editor-empty__hint">Start a swarm session to create an editable worktree.</p></div>}
    </div>
  </div>;
}
