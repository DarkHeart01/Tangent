import { useEffect, useState, type ReactNode } from "react";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { useWorkspace } from "../lib/WorkspaceContext";
import { useSettings, setSettings, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX } from "../lib/settings";
import { notYetWired, showToast } from "../lib/toast";
import QuickOpen, { type QuickOpenItem } from "./QuickOpen";
import CustomizeLayout from "./CustomizeLayout";
import * as runtime from "../../wailsjs/runtime/runtime";
import mascot from "../assets/meow_mascot.png";

type ViewId = "explorer" | "search" | "source-control" | "run-debug" | "extensions" | "agents" | "powers";
type PanelId = "terminal" | "problems" | "output" | "debug";

type AccessBarProps = {
  activePage: "ide" | "agents";
  onSwitchPage: (page: "ide" | "agents") => void;
  onResetLayout: () => void;
  onNewSession: () => void;
  onOpenSearch: () => void;
  onToggleExplorer: () => void;
  onTogglePanel: () => void;
  onToggleSwarm: () => void;
  onOpenSettings: () => void;
  onShowView: (view: ViewId) => void;
  onShowPanel: (tab: PanelId) => void;
  menuBarVisible: boolean;
  explorerVisible: boolean;
  swarmVisible: boolean;
  panelVisible: boolean;
};

type MenuEntry =
  | { kind: "action"; label: string; shortcut?: string; onClick: () => void; checked?: boolean }
  | { kind: "expand"; label: string; expanded: boolean; onToggle: () => void; children: ReactNode }
  | { kind: "separator" };

function renderMenu(entries: MenuEntry[]) {
  return entries.map((entry, index) => {
    if (entry.kind === "separator") return <hr key={index} />;
    if (entry.kind === "expand") return (
      <div key={entry.label} className="menu-expand">
        <button onClick={entry.onToggle}>
          <span>{entry.label}</span>
          <span className={`codicon ${entry.expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
        </button>
        {entry.expanded && <div className="menu-expand__body">{entry.children}</div>}
      </div>
    );
    return (
      <button key={entry.label} onClick={entry.onClick}>
        <span>{entry.checked !== undefined && <span className={`codicon codicon-check menu-item__check ${entry.checked ? "" : "is-hidden"}`} />}{entry.label}</span>
        {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
      </button>
    );
  });
}

function flattenCommands(group: string, entries: MenuEntry[]): QuickOpenItem[] {
  return entries
    .filter((entry): entry is Extract<MenuEntry, { kind: "action" }> => entry.kind === "action")
    .map((entry) => ({ id: `${group}:${entry.label}`, label: `${group}: ${entry.label}`, hint: entry.shortcut, onRun: entry.onClick }));
}

// Merges what used to be two separate, mostly-unmounted pieces (MenuBar's
// File/Edit/… dropdowns and TitleBar's native-window controls) into the one
// "Access Bar" Figma's design calls for: pill page switcher (Agents/IDE —
// see AgentsWorkspace.tsx and the App.tsx page-level split), menu,
// command/search box, layout toggles, window controls. The window itself
// runs frameless (main.go's Frameless: true); this is now the only titlebar.
//
// Every top-level menu (File/Edit/Selection/View/Go/Run) is built out to
// match VS Code's real menu content (per explicit reference screenshots, not
// Figma — Figma only covers basic IDE structuring). Every item is genuinely
// clickable: real actions wire to existing bindings, real Monaco commands
// (via the tangent:editor-command bridge in Editor.tsx), or real window/
// settings state; anything with no backing capability shows a toast instead
// of doing nothing or being disabled — see FRONTEND_MOCKS.md for the running
// list of which is which. Command Palette (Ctrl+Shift+P) is a real, working
// quick-open over every real action across all six menus.
export default function AccessBar({ activePage, onSwitchPage, onResetLayout, onNewSession, onOpenSearch, onToggleExplorer, onTogglePanel, onToggleSwarm, onOpenSettings, onShowView, onShowPanel, menuBarVisible, explorerVisible, swarmVisible, panelVisible }: AccessBarProps) {
  const { openFile, openFolder, createFile, closeWorkspace, workspace, recentProjects, openRecent } = useWorkspace();
  const settings = useSettings();
  const [open, setOpen] = useState<string | null>(null);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [lightTheme, setLightTheme] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const hasWindowRuntime = () => typeof window !== "undefined" && typeof (window as any).runtime?.WindowIsMaximised === "function";

  useEffect(() => {
    if (!hasWindowRuntime()) return;
    void runtime.WindowIsMaximised().then(setMaximized).catch(() => undefined);
    void runtime.WindowIsFullscreen().then(setFullscreen).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen(null); setRecentExpanded(false); setAppearanceExpanded(false);
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  const closeMenu = () => { setOpen(null); setRecentExpanded(false); setAppearanceExpanded(false); };
  const run = async (action: () => Promise<void>) => { closeMenu(); try { await action(); } catch (error) { window.alert(String(error)); } };
  const act = (fn: () => void) => () => { closeMenu(); fn(); };
  const mock = (feature: string) => act(() => notYetWired(feature));
  const fileAction = (name: string) => act(() => window.dispatchEvent(new CustomEvent(`tangent:${name}`)));
  const editorAction = (id: string) => act(() => window.dispatchEvent(new CustomEvent("tangent:editor-command", { detail: { id } })));

  const item = (name: string, menu: ReactNode) => (
    <div className="menu-bar__item-wrap">
      <button className={`menu-bar__item ${open === name ? "is-open" : ""}`} onClick={() => setOpen((current) => { const next = current === name ? null : name; setRecentExpanded(false); setAppearanceExpanded(false); return next; })}>{name}</button>
      {open === name && <div className="menu-dropdown">{menu}</div>}
    </div>
  );

  const toggleFullscreen = async () => {
    if (!hasWindowRuntime()) { showToast("Full screen only works in the desktop app.", "info"); return; }
    try {
      if (fullscreen) runtime.WindowUnfullscreen(); else runtime.WindowFullscreen();
      setFullscreen(!fullscreen);
    } catch { /* browser dev */ }
  };
  const zoomIn = () => setSettings({ uiZoomLevel: Math.min(ZOOM_MAX, Math.round((settings.uiZoomLevel + ZOOM_STEP) * 100) / 100) });
  const zoomOut = () => setSettings({ uiZoomLevel: Math.max(ZOOM_MIN, Math.round((settings.uiZoomLevel - ZOOM_STEP) * 100) / 100) });
  const zoomReset = () => setSettings({ uiZoomLevel: 1 });

  const fileMenu: MenuEntry[] = [
    { kind: "action", label: "New Text File", shortcut: "Ctrl+N", onClick: act(() => void createFile()) },
    { kind: "action", label: "New File…", shortcut: "Ctrl+Alt+Windows+N", onClick: act(() => { const name = window.prompt("File name"); if (name?.trim()) void createFile("", name.trim()); }) },
    { kind: "action", label: "New Window", onClick: mock("New Window") },
    { kind: "action", label: "New Window with Profile", onClick: mock("New Window with Profile") },
    { kind: "separator" },
    { kind: "action", label: "Open File…", shortcut: "Ctrl+O", onClick: () => void run(openFile) },
    { kind: "action", label: "Open Folder…", shortcut: "Ctrl+K Ctrl+O", onClick: () => void run(openFolder) },
    { kind: "action", label: "Open Workspace from File…", onClick: mock("Multi-root workspace files") },
    {
      kind: "expand", label: "Open Recent", expanded: recentExpanded, onToggle: () => setRecentExpanded((v) => !v),
      children: recentProjects.length
        ? recentProjects.map((project) => <button key={project.path} onClick={() => void run(() => openRecent(project))} title={project.path}>{project.name}</button>)
        : <span className="menu-expand__empty">No recent projects</span>,
    },
    { kind: "separator" },
    { kind: "action", label: "Add Folder to Workspace…", onClick: mock("Multi-root workspaces") },
    { kind: "action", label: "Save Workspace As…", onClick: mock("Workspace files") },
    { kind: "action", label: "Duplicate Workspace", onClick: mock("Workspace files") },
    { kind: "separator" },
    { kind: "action", label: "Save", shortcut: "Ctrl+S", onClick: fileAction("save-file") },
    { kind: "action", label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: fileAction("save-file-as") },
    { kind: "action", label: "Save All", shortcut: "Ctrl+K S", onClick: fileAction("save-all") },
    { kind: "separator" },
    { kind: "action", label: "Share", onClick: mock("Share") },
    { kind: "separator" },
    { kind: "action", label: "Auto Save", checked: settings.autoSaveEnabled, onClick: act(() => setSettings({ autoSaveEnabled: !settings.autoSaveEnabled })) },
    { kind: "action", label: "Preferences", onClick: act(onOpenSettings) },
    { kind: "separator" },
    { kind: "action", label: "Revert File", onClick: fileAction("revert-file") },
    { kind: "action", label: "Close Editor", shortcut: "Ctrl+F4", onClick: fileAction("close-editor") },
    { kind: "action", label: "Close Folder", shortcut: "Ctrl+K F", onClick: act(closeWorkspace) },
    { kind: "action", label: "Close Window", shortcut: "Alt+F4", onClick: act(quit) },
    { kind: "separator" },
    { kind: "action", label: "Exit", onClick: act(quit) },
  ];

  const editMenu: MenuEntry[] = [
    { kind: "action", label: "Undo", shortcut: "Ctrl+Z", onClick: editorAction("undo") },
    { kind: "action", label: "Redo", shortcut: "Ctrl+Y", onClick: editorAction("redo") },
    { kind: "separator" },
    { kind: "action", label: "Cut", shortcut: "Ctrl+X", onClick: editorAction("editor.action.clipboardCutAction") },
    { kind: "action", label: "Copy", shortcut: "Ctrl+C", onClick: editorAction("editor.action.clipboardCopyAction") },
    { kind: "action", label: "Paste", shortcut: "Ctrl+V", onClick: editorAction("editor.action.clipboardPasteAction") },
    { kind: "separator" },
    { kind: "action", label: "Find", shortcut: "Ctrl+F", onClick: editorAction("actions.find") },
    { kind: "action", label: "Replace", shortcut: "Ctrl+H", onClick: editorAction("editor.action.startFindReplaceAction") },
    { kind: "separator" },
    { kind: "action", label: "Find in Files", shortcut: "Ctrl+Shift+F", onClick: act(onOpenSearch) },
    { kind: "action", label: "Replace in Files", shortcut: "Ctrl+Shift+H", onClick: mock("Replace across files") },
    { kind: "separator" },
    { kind: "action", label: "Toggle Line Comment", shortcut: "Ctrl+/", onClick: editorAction("editor.action.commentLine") },
    { kind: "action", label: "Toggle Block Comment", shortcut: "Shift+Alt+A", onClick: editorAction("editor.action.blockComment") },
    { kind: "action", label: "Emmet: Expand Abbreviation", shortcut: "Tab", onClick: mock("Emmet") },
  ];

  const selectionMenu: MenuEntry[] = [
    { kind: "action", label: "Select All", shortcut: "Ctrl+A", onClick: editorAction("selectAll") },
    { kind: "action", label: "Expand Selection", shortcut: "Shift+Alt+RightArrow", onClick: editorAction("editor.action.smartSelect.expand") },
    { kind: "action", label: "Shrink Selection", shortcut: "Shift+Alt+LeftArrow", onClick: editorAction("editor.action.smartSelect.shrink") },
    { kind: "separator" },
    { kind: "action", label: "Copy Line Up", shortcut: "Shift+Alt+UpArrow", onClick: editorAction("editor.action.copyLinesUpAction") },
    { kind: "action", label: "Copy Line Down", shortcut: "Shift+Alt+DownArrow", onClick: editorAction("editor.action.copyLinesDownAction") },
    { kind: "action", label: "Move Line Up", shortcut: "Alt+UpArrow", onClick: editorAction("editor.action.moveLinesUpAction") },
    { kind: "action", label: "Move Line Down", shortcut: "Alt+DownArrow", onClick: editorAction("editor.action.moveLinesDownAction") },
    { kind: "action", label: "Duplicate Selection", onClick: editorAction("editor.action.duplicateSelection") },
    { kind: "separator" },
    { kind: "action", label: "Add Cursor Above", shortcut: "Ctrl+Alt+UpArrow", onClick: editorAction("editor.action.insertCursorAbove") },
    { kind: "action", label: "Add Cursor Below", shortcut: "Ctrl+Alt+DownArrow", onClick: editorAction("editor.action.insertCursorBelow") },
    { kind: "action", label: "Add Cursors to Line Ends", shortcut: "Shift+Alt+I", onClick: editorAction("editor.action.insertCursorAtEndOfEachLineSelected") },
    { kind: "action", label: "Add Next Occurrence", shortcut: "Ctrl+D", onClick: editorAction("editor.action.addSelectionToNextFindMatch") },
    { kind: "action", label: "Add Previous Occurrence", onClick: editorAction("editor.action.addSelectionToPreviousFindMatch") },
    { kind: "action", label: "Select All Occurrences", shortcut: "Ctrl+Shift+L", onClick: editorAction("editor.action.selectHighlights") },
    { kind: "separator" },
    { kind: "action", label: "Switch to Ctrl+Click for Multi-Cursor", checked: settings.editorMultiCursorModifier === "ctrlCmd", onClick: act(() => setSettings({ editorMultiCursorModifier: settings.editorMultiCursorModifier === "ctrlCmd" ? "alt" : "ctrlCmd" })) },
    { kind: "action", label: "Column Selection Mode", checked: settings.editorColumnSelection, onClick: act(() => setSettings({ editorColumnSelection: !settings.editorColumnSelection })) },
  ];

  const viewMenu: MenuEntry[] = [
    { kind: "action", label: "Command Palette…", shortcut: "Ctrl+Shift+P", onClick: act(() => setPaletteOpen(true)) },
    { kind: "action", label: "Open View…", onClick: mock("Open View quick-pick") },
    { kind: "separator" },
    {
      kind: "expand", label: "Appearance", expanded: appearanceExpanded, onToggle: () => setAppearanceExpanded((v) => !v),
      children: <>
        <button onClick={() => void toggleFullscreen()}><span>{fullscreen ? <span className="codicon codicon-check menu-item__check" /> : <span className="menu-item__check is-hidden" />}Full Screen</span><kbd>F11</kbd></button>
        <button onClick={act(zoomIn)}><span>Zoom In</span><kbd>Ctrl+=</kbd></button>
        <button onClick={act(zoomOut)}><span>Zoom Out</span><kbd>Ctrl+-</kbd></button>
        <button onClick={act(zoomReset)}><span>Reset Zoom</span></button>
      </>,
    },
    { kind: "action", label: "Editor Layout", onClick: mock("Split-editor layouts") },
    { kind: "separator" },
    { kind: "action", label: "Explorer", shortcut: "Ctrl+Shift+E", onClick: act(() => onShowView("explorer")) },
    { kind: "action", label: "Search", shortcut: "Ctrl+Shift+F", onClick: act(onOpenSearch) },
    { kind: "action", label: "Source Control", onClick: act(() => onShowView("source-control")) },
    { kind: "action", label: "Run", shortcut: "Ctrl+Shift+D", onClick: act(() => onShowView("run-debug")) },
    { kind: "action", label: "Extensions", shortcut: "Ctrl+Shift+X", onClick: act(() => onShowView("extensions")) },
    { kind: "action", label: "Testing", onClick: mock("Testing panel") },
    { kind: "separator" },
    { kind: "action", label: "Chat", shortcut: "Ctrl+Alt+I", onClick: act(() => onSwitchPage("agents")) },
    { kind: "action", label: "Browser", shortcut: "Ctrl+Alt+/", onClick: mock("Embedded browser") },
    { kind: "separator" },
    { kind: "action", label: "Problems", shortcut: "Ctrl+Shift+M", onClick: act(() => onShowPanel("problems")) },
    { kind: "action", label: "Output", shortcut: "Ctrl+Shift+U", onClick: act(() => onShowPanel("output")) },
    { kind: "action", label: "Debug Console", shortcut: "Ctrl+Shift+Y", onClick: act(() => onShowPanel("debug")) },
    { kind: "action", label: "Terminal", shortcut: "Ctrl+`", onClick: act(() => onShowPanel("terminal")) },
    { kind: "separator" },
    { kind: "action", label: "Word Wrap", shortcut: "Alt+Z", checked: settings.editorWordWrap === "on", onClick: act(() => setSettings({ editorWordWrap: settings.editorWordWrap === "on" ? "off" : "on" })) },
  ];

  const goMenu: MenuEntry[] = [
    { kind: "action", label: "Back", shortcut: "Alt+LeftArrow", onClick: mock("Navigation history") },
    { kind: "action", label: "Forward", shortcut: "Alt+RightArrow", onClick: mock("Navigation history") },
    { kind: "action", label: "Last Edit Location", shortcut: "Ctrl+K Ctrl+Q", onClick: mock("Edit-location history") },
    { kind: "separator" },
    { kind: "action", label: "Switch Editor", onClick: mock("Multiple editor groups") },
    { kind: "action", label: "Switch Group", onClick: mock("Multiple editor groups") },
    { kind: "separator" },
    { kind: "action", label: "Go to File…", shortcut: "Ctrl+P", onClick: mock("Fuzzy file quick-open") },
    { kind: "action", label: "Go to Symbol in Workspace…", shortcut: "Ctrl+T", onClick: mock("Workspace symbol search") },
    { kind: "separator" },
    { kind: "action", label: "Go to Symbol in Editor…", shortcut: "Ctrl+Shift+O", onClick: editorAction("editor.action.quickOutline") },
    { kind: "action", label: "Go to Definition", shortcut: "F12", onClick: editorAction("editor.action.revealDefinition") },
    { kind: "action", label: "Go to Declaration", onClick: editorAction("editor.action.revealDeclaration") },
    { kind: "action", label: "Go to Type Definition", onClick: editorAction("editor.action.goToTypeDefinition") },
    { kind: "action", label: "Go to Implementations", shortcut: "Ctrl+F12", onClick: editorAction("editor.action.goToImplementation") },
    { kind: "action", label: "Go to References", shortcut: "Shift+F12", onClick: editorAction("editor.action.goToReferences") },
    { kind: "separator" },
    { kind: "action", label: "Go to Line/Column…", shortcut: "Ctrl+G", onClick: editorAction("editor.action.gotoLine") },
    { kind: "action", label: "Go to Bracket", shortcut: "Ctrl+Shift+\\", onClick: editorAction("editor.action.jumpToBracket") },
    { kind: "separator" },
    { kind: "action", label: "Next Problem", shortcut: "F8", onClick: editorAction("editor.action.marker.next") },
    { kind: "action", label: "Previous Problem", shortcut: "Shift+F8", onClick: editorAction("editor.action.marker.prev") },
    { kind: "separator" },
    { kind: "action", label: "Next Change", shortcut: "Alt+F3", onClick: mock("Diff navigation") },
    { kind: "action", label: "Previous Change", shortcut: "Shift+Alt+F3", onClick: mock("Diff navigation") },
  ];

  const runMenu: MenuEntry[] = [
    { kind: "action", label: "Start Debugging", shortcut: "F5", onClick: mock("Debugging") },
    { kind: "action", label: "Run Without Debugging", shortcut: "Ctrl+F5", onClick: mock("Run configurations") },
    { kind: "action", label: "Stop Debugging", shortcut: "Shift+F5", onClick: mock("Debugging") },
    { kind: "action", label: "Restart Debugging", shortcut: "Ctrl+Shift+F5", onClick: mock("Debugging") },
    { kind: "separator" },
    { kind: "action", label: "Open Configurations", onClick: mock("launch.json") },
    { kind: "action", label: "Add Configuration…", onClick: mock("launch.json") },
    { kind: "separator" },
    { kind: "action", label: "Step Over", shortcut: "F10", onClick: mock("Debugging") },
    { kind: "action", label: "Step Into", shortcut: "F11", onClick: mock("Debugging") },
    { kind: "action", label: "Step Out", shortcut: "Shift+F11", onClick: mock("Debugging") },
    { kind: "action", label: "Continue", shortcut: "F5", onClick: mock("Debugging") },
    { kind: "separator" },
    { kind: "action", label: "Toggle Breakpoint", shortcut: "F9", onClick: mock("Breakpoints") },
    { kind: "action", label: "New Breakpoint", onClick: mock("Breakpoints") },
    { kind: "separator" },
    { kind: "action", label: "Enable All Breakpoints", onClick: mock("Breakpoints") },
    { kind: "action", label: "Disable All Breakpoints", onClick: mock("Breakpoints") },
    { kind: "action", label: "Remove All Breakpoints", onClick: mock("Breakpoints") },
    { kind: "separator" },
    { kind: "action", label: "Install Additional Debuggers…", onClick: act(() => onShowView("extensions")) },
    { kind: "separator" },
    { kind: "action", label: "Start Session from Agent Swarm", onClick: act(onNewSession) },
  ];

  const openExternal = (url: string) => {
    if (hasWindowRuntime()) { try { runtime.BrowserOpenURL(url); return; } catch { /* fall through */ } }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const terminalMenu: MenuEntry[] = [
    { kind: "action", label: "New Terminal", shortcut: "Ctrl+Shift+`", onClick: act(() => window.dispatchEvent(new CustomEvent("tangent:new-terminal"))) },
    { kind: "action", label: "Split Terminal", shortcut: "Ctrl+Shift+5", onClick: mock("Split-pane terminals") },
    { kind: "action", label: "New Terminal Window", shortcut: "Ctrl+Shift+Alt+`", onClick: mock("New Terminal Window") },
    { kind: "separator" },
    { kind: "action", label: "Run Task…", onClick: mock("Tasks (tasks.json)") },
    { kind: "action", label: "Run Build Task…", shortcut: "Ctrl+Shift+B", onClick: mock("Tasks (tasks.json)") },
    { kind: "action", label: "Run Active File", onClick: act(() => window.dispatchEvent(new CustomEvent("tangent:run-active-file"))) },
    { kind: "action", label: "Run Selected Text", onClick: act(() => window.dispatchEvent(new CustomEvent("tangent:run-selected-text"))) },
    { kind: "separator" },
    { kind: "action", label: "Show Running Tasks…", onClick: mock("Tasks (tasks.json)") },
    { kind: "action", label: "Restart Running Task…", onClick: mock("Tasks (tasks.json)") },
    { kind: "action", label: "Terminate Task…", onClick: mock("Tasks (tasks.json)") },
    { kind: "separator" },
    { kind: "action", label: "Configure Tasks…", onClick: mock("Tasks (tasks.json)") },
    { kind: "action", label: "Configure Default Build Task…", onClick: mock("Tasks (tasks.json)") },
  ];

  const helpMenu: MenuEntry[] = [
    { kind: "action", label: "Welcome", onClick: mock("A dedicated Welcome tour") },
    { kind: "action", label: "Show All Commands", shortcut: "Ctrl+Shift+P", onClick: act(() => setPaletteOpen(true)) },
    { kind: "action", label: "Documentation", onClick: act(() => openExternal("https://github.com/DarkHeart01/Tangent#readme")) },
    { kind: "action", label: "Editor Playground", onClick: mock("Editor Playground") },
    { kind: "action", label: "Open Walkthrough…", onClick: mock("Onboarding walkthrough") },
    { kind: "action", label: "Show Release Notes", onClick: mock("Release notes") },
    { kind: "action", label: "Get Started with Accessibility Features", onClick: mock("Accessibility guide") },
    { kind: "action", label: "Ask Tangent", onClick: act(() => onSwitchPage("agents")) },
    { kind: "separator" },
    { kind: "action", label: "Keyboard Shortcuts Reference", shortcut: "Ctrl+K Ctrl+R", onClick: mock("Shortcuts reference") },
    { kind: "action", label: "Video Tutorials", onClick: mock("Video tutorials") },
    { kind: "action", label: "Tips and Tricks", onClick: mock("Tips and tricks") },
    { kind: "separator" },
    { kind: "action", label: "Join Us on YouTube", onClick: mock("A YouTube channel") },
    { kind: "action", label: "Search Feature Requests", onClick: act(() => openExternal("https://github.com/DarkHeart01/Tangent/issues")) },
    { kind: "action", label: "Report Issue", onClick: act(() => openExternal("https://github.com/DarkHeart01/Tangent/issues/new")) },
    { kind: "separator" },
    { kind: "action", label: "View License", onClick: mock("A LICENSE file") },
    { kind: "action", label: "Privacy Statement", onClick: mock("A privacy statement") },
    { kind: "separator" },
    { kind: "action", label: "Toggle Developer Tools", onClick: mock("A DevTools toggle binding") },
    { kind: "action", label: "Open Process Explorer", onClick: mock("Process Explorer") },
    { kind: "separator" },
    { kind: "action", label: "Check for Updates…", onClick: mock("An update checker") },
    { kind: "separator" },
    { kind: "action", label: "About", onClick: act(() => window.alert("Tangent IDE — agent-assisted development workspace")) },
  ];

  const commands: QuickOpenItem[] = [
    ...flattenCommands("File", fileMenu),
    ...flattenCommands("Edit", editMenu),
    ...flattenCommands("Selection", selectionMenu),
    ...flattenCommands("View", viewMenu),
    ...flattenCommands("Go", goMenu),
    ...flattenCommands("Run", runMenu),
    ...flattenCommands("Terminal", terminalMenu),
    ...flattenCommands("Help", helpMenu),
  ];

  const toggleMaximize = async () => {
    if (!hasWindowRuntime()) return;
    try {
      const current = await runtime.WindowIsMaximised();
      if (current) runtime.WindowUnmaximise(); else runtime.WindowMaximise();
      setMaximized(!current);
    } catch { /* browser development mode has no Wails window */ }
  };
  const minimize = () => { if (hasWindowRuntime()) { try { runtime.WindowMinimise(); } catch { /* browser dev */ } } };
  function quit() { if (hasWindowRuntime()) { try { runtime.Quit(); } catch { /* browser dev */ } } else showToast("Closing only works in the desktop app.", "info"); }
  const toggleTheme = () => {
    setLightTheme((value) => {
      const next = !value;
      document.documentElement.classList.toggle("theme-light", next);
      try { if (next) runtime.WindowSetLightTheme(); else runtime.WindowSetDarkTheme(); } catch { /* browser dev */ }
      return next;
    });
  };

  const drag = { "--wails-draggable": "drag" } as React.CSSProperties;
  const noDrag = { "--wails-draggable": "no-drag" } as React.CSSProperties;

  return (
    <header className="access-bar" style={drag}>
      <div className="access-bar__left" style={noDrag}>
        <div className="access-bar__brand">
          <img src={mascot} alt="Tangent" className="access-bar__logo" />
        </div>
        <div className="access-bar__pills">
          <button className={`access-bar__pill ${activePage === "agents" ? "is-active" : ""}`} onClick={() => onSwitchPage("agents")}>Agents</button>
          <button className={`access-bar__pill ${activePage === "ide" ? "is-active" : ""}`} onClick={() => onSwitchPage("ide")}>IDE</button>
        </div>
        {menuBarVisible && (
          <nav className="menu-bar" aria-label="Application menu">
            {item("File", renderMenu(fileMenu))}
            {item("Edit", renderMenu(editMenu))}
            {item("Selection", renderMenu(selectionMenu))}
            {item("View", renderMenu(viewMenu))}
            {item("Go", renderMenu(goMenu))}
            {item("Run", renderMenu(runMenu))}
            {item("Terminal", renderMenu(terminalMenu))}
            {item("Help", renderMenu(helpMenu))}
          </nav>
        )}
      </div>
      <button className="access-bar__search" style={noDrag} onClick={onOpenSearch} title="Search workspace">
        <span className="codicon codicon-search" />
        <span>{workspace?.name ?? "Tangent"}</span>
      </button>
      <div className="access-bar__tools" style={noDrag}>
        <button className="access-bar__icon" onClick={toggleTheme} title={lightTheme ? "Use dark theme" : "Use light theme"}><span className="codicon codicon-color-mode" /></button>
        <span className="access-bar__separator" />
        <button className={`access-bar__icon ${customizeOpen ? "is-active" : ""}`} onClick={() => setCustomizeOpen((v) => !v)} title="Customize Layout"><span className="codicon codicon-layout" /></button>
        <button className={`access-bar__icon ${explorerVisible ? "is-active" : ""}`} onClick={onToggleExplorer} title="Toggle Primary Side Bar"><span className="codicon codicon-layout-sidebar-left" /></button>
        <button className={`access-bar__icon ${panelVisible ? "is-active" : ""}`} onClick={onTogglePanel} title="Toggle Panel"><span className="codicon codicon-layout-panel" /></button>
        <button className={`access-bar__icon ${swarmVisible ? "is-active" : ""}`} onClick={onToggleSwarm} title="Toggle Secondary Side Bar"><span className="codicon codicon-layout-sidebar-right" /></button>
        <span className="access-bar__separator" />
        <button className="window-control" onClick={minimize} title="Minimize"><span className="codicon codicon-chrome-minimize" /></button>
        <button className="window-control" onClick={() => void toggleMaximize()} title={maximized ? "Restore" : "Maximize"}><span className={`codicon ${maximized ? "codicon-chrome-restore" : "codicon-chrome-maximize"}`} /></button>
        <button className="window-control window-control--close" onClick={quit} title="Close"><span className="codicon codicon-chrome-close" /></button>
      </div>
      {paletteOpen && <QuickOpen items={commands} onClose={() => setPaletteOpen(false)} centered={settings.quickInputPosition === "center"} />}
      {customizeOpen && (
        <CustomizeLayout
          onClose={() => setCustomizeOpen(false)}
          explorerVisible={explorerVisible}
          swarmVisible={swarmVisible}
          panelVisible={panelVisible}
          onToggleExplorer={onToggleExplorer}
          onToggleSwarm={onToggleSwarm}
          onTogglePanel={onTogglePanel}
          onResetSizes={onResetLayout}
          fullscreen={fullscreen}
          onToggleFullscreen={() => void toggleFullscreen()}
        />
      )}
    </header>
  );
}
