import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import * as wailsClient from "./wailsClient";
import { logInfo, reportError } from "./errorReporting";
import FolderPicker from "../components/FolderPicker";

export type LocalFile = { path: string; content: string; writable?: boolean; handle?: unknown; parentHandle?: unknown };
export type LocalWorkspace = { name: string; rootPath: string; files: LocalFile[]; folders: string[]; folderHandles?: Record<string, unknown>; loadedFolders?: Set<string>; backendRoot?: boolean };
export type RecentProject = { name: string; path: string };

type WorkspaceContextValue = {
  workspace: LocalWorkspace | null;
  recentProjects: RecentProject[];
  openFolder: () => Promise<void>;
  openFile: () => Promise<void>;
  createFile: (parentPath?: string) => Promise<void>;
  openRecent: (project: RecentProject) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  createFolder: (parentPath?: string) => Promise<void>;
  renamePath: (path: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  closeWorkspace: () => void;
  loadFolderChildren: (path: string) => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const RECENT_KEY = "tangent.ide.recent-projects";

function readRecent(): RecentProject[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentProject[]; } catch { return []; }
}

// Lists only a directory's immediate children - deliberately not recursive
// and deliberately does not read file content. Walking the entire tree
// eagerly (as this used to do) means opening a heavy repo - node_modules,
// build output, vendored deps, tens of thousands of entries - enumerates
// and materializes all of it into the WebView2 renderer's memory in one
// shot before the tree even renders, which can crash the renderer outright.
// Subdirectories are instead expanded on demand (see loadFolderChildren
// below and its use in Editor.tsx's FileTreeNodePolished), exactly like a
// real IDE explorer, and file content loads lazily on open (see
// loadLocalFileContent in Editor.tsx) - nothing is hidden, it just isn't
// all loaded at once.
async function listEntries(handle: any, prefix: string): Promise<{ files: LocalFile[]; folders: string[]; folderHandles: Record<string, unknown> }> {
  const files: LocalFile[] = [];
  const folders: string[] = [];
  const folderHandles: Record<string, unknown> = {};
  if (!handle?.values) return { files, folders, folderHandles };
  for await (const entry of handle.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") { folders.push(path); folderHandles[path] = entry; }
    else if (entry.kind === "file") files.push({ path, content: "", writable: typeof entry.createWritable === "function", handle: entry, parentHandle: handle });
  }
  folders.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, folders, folderHandles };
}

function chooseBrowserFiles(directory: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = directory;
    if (directory) input.setAttribute("webkitdirectory", "");
    input.onchange = () => resolve(Array.from(input.files ?? [])); input.click();
  });
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<LocalWorkspace | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(readRecent);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerInitialPath, setFolderPickerInitialPath] = useState("");

  const remember = useCallback((project: RecentProject) => {
    setRecentProjects((current) => {
      const next = [project, ...current.filter((item) => item.path !== project.path)].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const openFolder = useCallback(async () => {
    // The Wails desktop app uses the in-app picker below instead of the
    // native Windows folder dialog. That avoids the COM/WebView2 crash path
    // while still producing the absolute path needed by the backend explorer
    // and terminal.
    if (wailsClient.isWailsDesktop()) {
      try {
        const home = await wailsClient.getUserHomePath();
        setFolderPickerInitialPath(home);
        setFolderPickerOpen(true);
      } catch (error) {
        window.alert(`Could not determine your home folder: ${String(error)}`);
      }
      return;
    }
    // Plain browser dev (npm run dev, no Wails desktop runtime): there's no
    // Go backend to validate a typed path against, so fall back to the
    // browser's own folder picker(s). Lazy per-level listing here too (see
    // listEntries) so a heavy repo can't blow up renderer memory this way
    // either.
    const picker = (window as any).showDirectoryPicker;
    if (typeof picker !== "function") {
      const selected = await chooseBrowserFiles(true); const root = (selected[0] as any)?.webkitRelativePath?.split("/")[0] ?? "workspace";
      const files = await Promise.all(selected.map(async (file) => {
        const relative = (file as any).webkitRelativePath || file.name;
        const path = relative.startsWith(`${root}/`) ? relative.slice(root.length + 1) : relative;
        return { path, content: await file.text(), writable: false };
      }));
      const next = { name: root, rootPath: root, files, folders: [] }; setWorkspace(next); remember({ name: next.name, path: next.rootPath }); return;
    }
    const handle = await picker({ mode: "readwrite" });
    const { files, folders, folderHandles } = await listEntries(handle, "");
    const next: LocalWorkspace = {
      name: handle.name,
      rootPath: handle.name,
      files,
      folders,
      folderHandles: { "": handle, ...folderHandles },
      loadedFolders: new Set([""]),
    };
    setWorkspace(next);
    remember({ name: next.name, path: next.rootPath });
  }, [remember]);

  const selectNativeFolder = useCallback(async (path: string) => {
    logInfo("folder-open", `validating path: ${path}`);
    try {
      const info = await wailsClient.validateWorkspacePath(path);
      logInfo("folder-open", `validated, setting workspace: ${info.path}`);
      const next: LocalWorkspace = { name: info.name, rootPath: info.path, files: [], folders: [], backendRoot: true };
      setWorkspace(next);
      remember({ name: next.name, path: next.rootPath });
      setFolderPickerOpen(false);
      logInfo("folder-open", "workspace state committed");
    } catch (error) {
      reportError("folder-open", error);
      window.alert(`Could not open "${path}": ${String(error)}`);
    }
  }, [remember]);

  const closeFolderPicker = useCallback(() => setFolderPickerOpen(false), []);

  // Fetches one directory's immediate children on demand (see listEntries
  // above for why this isn't done recursively up front) and merges them
  // into workspace state. A no-op for folders that are already loaded, have
  // no known handle (sessions/backendRoot workspaces don't use this), or
  // that have no handle recorded because they came from a fallback path.
  const loadFolderChildren = useCallback(async (path: string) => {
    const current = workspace;
    if (!current || current.backendRoot || current.loadedFolders?.has(path)) return;
    const handle = current.folderHandles?.[path];
    if (!handle) return;
    const { files, folders, folderHandles } = await listEntries(handle, path);
    setWorkspace((base) => {
      if (!base) return base;
      const existingFiles = new Set(base.files.map((item) => item.path));
      const existingFolders = new Set(base.folders);
      const loadedFolders = new Set(base.loadedFolders ?? []);
      loadedFolders.add(path);
      return {
        ...base,
        files: [...base.files, ...files.filter((item) => !existingFiles.has(item.path))],
        folders: [...base.folders, ...folders.filter((item) => !existingFolders.has(item))],
        folderHandles: { ...base.folderHandles, ...folderHandles },
        loadedFolders,
      };
    });
  }, [workspace]);

  const openFile = useCallback(async () => {
    const picker = (window as any).showOpenFilePicker;
    if (typeof picker !== "function") {
      const [file] = await chooseBrowserFiles(false); if (!file) return;
      const next = { name: file.name, rootPath: file.name, files: [{ path: file.name, content: await file.text(), writable: false }], folders: [] }; setWorkspace(next); remember({ name: next.name, path: next.rootPath }); return;
    }
    const [handle] = await picker({ multiple: false }); const file = await handle.getFile(); const next = { name: file.name, rootPath: file.name, files: [{ path: file.name, content: await file.text(), writable: typeof handle.createWritable === "function", handle }], folders: [] };
    setWorkspace(next); remember({ name: next.name, path: next.rootPath });
  }, [remember]);

  const openRecent = useCallback(async (project: RecentProject) => {
    // In the Wails desktop app we already have the exact path, so reopen it
    // directly instead of re-prompting (openFolder's dialog-avoidance path
    // needs a path to validate, but doesn't need to ask for one it already
    // has).
    if (wailsClient.isWailsDesktop()) {
      try {
        const info = await wailsClient.validateWorkspacePath(project.path);
        const next: LocalWorkspace = { name: info.name, rootPath: info.path, files: [], folders: [], backendRoot: true };
        setWorkspace(next);
        remember({ name: next.name, path: next.rootPath });
      } catch (error) {
        window.alert(`Could not reopen "${project.path}": ${String(error)}`);
      }
      return;
    }
    return openFolder();
  }, [openFolder, remember]);
  const createFile = useCallback(async (parentPath = "") => {
    const current = workspace;
    const existing = new Set(current?.files.map((item) => item.path) ?? []);
    let index = 1; let path = parentPath ? `${parentPath}/untitled.txt` : "untitled.txt";
    const stem = parentPath ? `${parentPath}/untitled` : "untitled";
    while (existing.has(path)) path = `${stem}-${index++}.txt`;
    if (current?.backendRoot) {
      await wailsClient.writeWorkspaceFile(current.rootPath, path, "");
    }
    setWorkspace((base) => {
      const next = base ?? { name: "Untitled Workspace", rootPath: "Home", files: [], folders: [] };
      return { ...next, files: [...next.files, { path, content: "", writable: !next.backendRoot }] };
    });
  }, [workspace]);
  const renamePath = useCallback(async (path: string) => {
    const current = workspace;
    if (!current) return;
    const requested = window.prompt("New name", path.split("/").pop() ?? path)?.trim();
    if (!requested || requested.includes("/") || requested.includes("\\") || requested === "." || requested === "..") return;
    const parent = path.split("/").slice(0, -1).join("/");
    const nextPath = parent ? `${parent}/${requested}` : requested;
    if (current.backendRoot) await wailsClient.renameWorkspacePath(current.rootPath, path, nextPath);
    else {
      const prefix = `${path}/`;
      setWorkspace((base) => base ? {
        ...base,
        files: base.files.map((file) => file.path === path || file.path.startsWith(prefix) ? { ...file, path: file.path === path ? nextPath : `${nextPath}/${file.path.slice(prefix.length)}` } : file),
        folders: base.folders.map((folder) => folder === path || folder.startsWith(prefix) ? (folder === path ? nextPath : `${nextPath}/${folder.slice(prefix.length)}`) : folder),
      } : base);
      return;
    }
    setWorkspace((base) => {
      if (!base) return base;
      const prefix = `${path}/`;
      return {
        ...base,
        files: base.files.map((file) => file.path === path || file.path.startsWith(prefix) ? { ...file, path: file.path === path ? nextPath : `${nextPath}/${file.path.slice(prefix.length)}` } : file),
        folders: base.folders.map((folder) => folder === path || folder.startsWith(prefix) ? (folder === path ? nextPath : `${nextPath}/${folder.slice(prefix.length)}`) : folder),
      };
    });
  }, [workspace]);
  const createFolder = useCallback(async (parentPath = "") => {
    const requested = window.prompt("Folder name", "new-folder")?.trim();
    if (!requested) return;
    const clean = requested.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!clean || clean.includes("..")) return;
    const currentWorkspace = workspace;
    const path = parentPath ? `${parentPath}/${clean}` : clean;
    if (currentWorkspace?.backendRoot) await wailsClient.createWorkspaceFolder(currentWorkspace.rootPath, path);
    const parentHandle = currentWorkspace?.folderHandles?.[parentPath];
    if (parentHandle && typeof (parentHandle as any).getDirectoryHandle === "function") {
      try { await (parentHandle as any).getDirectoryHandle(clean, { create: true }); }
      catch (error) { window.alert(`Could not create ${clean}: ${String(error)}`); return; }
    }
    setWorkspace((current) => {
      const base = current ?? { name: "Untitled Workspace", rootPath: "Home", files: [], folders: [] };
      if (base.folders.includes(path)) return base;
      return { ...base, folders: [...base.folders, path] };
    });
  }, [workspace]);
  const deletePath = useCallback(async (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    const currentWorkspace = workspace;
    if (currentWorkspace?.backendRoot) await wailsClient.deleteWorkspacePath(currentWorkspace.rootPath, path);
    const file = currentWorkspace?.files.find((item) => item.path === path);
    const parentPath = path.split("/").slice(0, -1).join("/");
    const parentHandle = file?.parentHandle ?? currentWorkspace?.folderHandles?.[parentPath];
    if (parentHandle && typeof (parentHandle as any).removeEntry === "function") {
      try { await (parentHandle as any).removeEntry(path.split("/").pop(), { recursive: true }); }
      catch (error) { window.alert(`Could not delete ${path}: ${String(error)}`); return; }
    }
    setWorkspace((current) => {
      if (!current) return current;
      const prefix = `${path}/`;
      return {
        ...current,
        files: current.files.filter((file) => file.path !== path && !file.path.startsWith(prefix)),
        folders: current.folders.filter((folder) => folder !== path && !folder.startsWith(prefix)),
      };
    });
  }, [workspace]);
  const saveFile = useCallback(async (path: string, content: string) => {
    if (workspace?.backendRoot) await wailsClient.writeWorkspaceFile(workspace.rootPath, path, content);
    const file = workspace?.files.find((item) => item.path === path);
    if (file?.handle && typeof (file.handle as any).createWritable === "function") {
      const writable = await (file.handle as any).createWritable(); await writable.write(content); await writable.close();
    }
    setWorkspace((current) => current ? { ...current, files: current.files.map((item) => item.path === path ? { ...item, content } : item) } : current);
  }, [workspace]);
  const closeWorkspace = useCallback(() => setWorkspace(null), []);

  const value = useMemo(() => ({ workspace, recentProjects, openFolder, openFile, createFile, createFolder, renamePath, deletePath, openRecent, saveFile, closeWorkspace, loadFolderChildren }), [workspace, recentProjects, openFolder, openFile, createFile, createFolder, renamePath, deletePath, openRecent, saveFile, closeWorkspace, loadFolderChildren]);
  return <WorkspaceContext.Provider value={value}>
    {children}
    {folderPickerOpen && folderPickerInitialPath && (
      <FolderPicker
        initialPath={folderPickerInitialPath}
        onCancel={closeFolderPicker}
        onSelect={(path) => void selectNativeFolder(path)}
      />
    )}
  </WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
