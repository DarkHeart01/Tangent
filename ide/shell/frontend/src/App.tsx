import { useCallback, useEffect, useState } from "react";
import "./App.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { SessionProvider, useSession } from "./lib/SessionContext";
import Terminal from "./components/Terminal";
import Dashboard from "./components/Dashboard";
import Editor from "./components/Editor";
import HumanGateBanner from "./components/HumanGateBanner";
import WalkthroughPanel from "./components/WalkthroughPanel";
import SessionList from "./components/SessionList";
import WelcomeView from "./components/WelcomeView";
import MenuBar from "./components/MenuBar";
import SearchPanel from "./components/SearchPanel";
import SettingsPage from "./components/SettingsPage";
import ContextMenu, { type ContextMenuItem } from "./components/ContextMenu";
import { WorkspaceProvider, useWorkspace } from "./lib/WorkspaceContext";

function Shell() {
  const { activeSessionId, activeWsClient, reconnectActiveWs, newSession } = useSession();
  const { workspace, createFile, createFolder, openFolder, closeWorkspace } = useWorkspace();
  const wsStatus = activeWsClient?.status ?? "closed";
  const [bottomTab, setBottomTab] = useState<"terminal" | "problems" | "output" | "debug">("terminal");
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [swarmWidth, setSwarmWidth] = useState(380);
  const [bottomHeight, setBottomHeight] = useState(230);
  const [workspaceMenu, setWorkspaceMenu] = useState<{ x: number; y: number } | null>(null);
  const [swarmView, setSwarmView] = useState<"live" | "walkthrough">("live");
  const [activeView, setActiveView] = useState<"explorer" | "search">("explorer");
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    const focusTerminal = () => setBottomTab("terminal");
    window.addEventListener("tangent:focus-terminal", focusTerminal);
    return () => window.removeEventListener("tangent:focus-terminal", focusTerminal);
  }, []);
  // Opening a file (incl. from a search result) should surface the editor.
  useEffect(() => {
    const showEditor = () => setShowSettings(false);
    window.addEventListener("tangent:open-file", showEditor);
    return () => window.removeEventListener("tangent:open-file", showEditor);
  }, []);
  const beginResize = useCallback((target: "explorer" | "swarm" | "bottom", event: React.PointerEvent) => {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, explorer: explorerWidth, swarm: swarmWidth, bottom: bottomHeight };
    const move = (next: PointerEvent) => {
      if (target === "explorer") setExplorerWidth(Math.min(420, Math.max(180, start.explorer + next.clientX - start.x)));
      if (target === "swarm") setSwarmWidth(Math.min(520, Math.max(300, start.swarm - (next.clientX - start.x))));
      if (target === "bottom") setBottomHeight(Math.min(window.innerHeight * .7, Math.max(130, start.bottom - (next.clientY - start.y))));
    };
    const stop = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); document.body.style.cursor = ""; };
    document.body.style.cursor = target === "bottom" ? "row-resize" : "col-resize";
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", stop, { once: true });
  }, [bottomHeight, explorerWidth, swarmWidth]);
  const openTerminal = () => window.dispatchEvent(new CustomEvent("tangent:focus-terminal"));
  const copyWorkspacePath = async () => { try { await navigator.clipboard?.writeText(workspace?.rootPath ?? ""); } catch { /* clipboard permissions are optional */ } };
  const workspaceMenuItems: ContextMenuItem[] = [
    { label: "New File…", onClick: () => createFile(), disabled: Boolean(activeSessionId) },
    { label: "New Folder…", onClick: () => createFolder(), disabled: Boolean(activeSessionId) },
    { label: "Open Folder…", onClick: () => void openFolder() },
    { label: "Open in Integrated Terminal", onClick: openTerminal },
    { separator: true, label: "" },
    { label: "Copy Path", shortcut: "Shift+Alt+C", onClick: () => void copyWorkspacePath() },
    { label: "Copy Relative Path", shortcut: "Ctrl+K Ctrl+Shift+C", onClick: () => void copyWorkspacePath() },
    { separator: true, label: "" },
    { label: "Remove Folder from Workspace", onClick: closeWorkspace },
    { label: "Delete", onClick: () => { if (window.confirm("Remove this workspace from Tangent IDE?")) closeWorkspace(); } },
  ];

  return (
    <div id="App">
      <MenuBar
        onTerminal={() => setBottomTab("terminal")}
        onNewSession={newSession}
        onResetLayout={() => { setExplorerWidth(240); setSwarmWidth(380); setBottomHeight(230); }}
      />
      <div className="ide-body" style={{ "--explorer-width": `${explorerWidth}px`, "--swarm-width": `${swarmWidth}px` } as React.CSSProperties}>
        <nav className="activity-bar" aria-label="Activity bar">
          <button className={`activity-bar__button ${activeView === "explorer" && !showSettings ? "is-active" : ""}`} title="Explorer" aria-label="Explorer" onClick={() => { setActiveView("explorer"); setShowSettings(false); }}><span className="codicon codicon-files" /></button>
          <button className={`activity-bar__button ${activeView === "search" && !showSettings ? "is-active" : ""}`} title="Search" aria-label="Search" onClick={() => { setActiveView("search"); setShowSettings(false); }}><span className="codicon codicon-search" /></button>
          <button className="activity-bar__button" title="Extensions" aria-label="Extensions"><span className="codicon codicon-symbol-misc" /></button>
          <span className="activity-bar__spacer" />
          <button className={`activity-bar__button ${showSettings ? "is-active" : ""}`} title="Settings" aria-label="Settings" onClick={() => setShowSettings((value) => !value)}><span className="codicon codicon-settings-gear" /></button>
        </nav>

        <aside className="explorer-sidebar">
          {activeView === "search" ? (
            <>
              <div className="explorer-sidebar__header"><span>SEARCH</span></div>
              <SearchPanel />
            </>
          ) : (
            <>
              <div className="explorer-sidebar__header">
                <span>EXPLORER</span>
                <div className="explorer-sidebar__actions">
                  <button className="icon-button" title="New File" aria-label="New File" disabled={!workspace} onClick={() => window.dispatchEvent(new CustomEvent("tangent:new-file"))}><span className="codicon codicon-new-file" /></button>
                  <button className="icon-button" title="New Folder" aria-label="New Folder" disabled={!workspace} onClick={() => window.dispatchEvent(new CustomEvent("tangent:new-folder"))}><span className="codicon codicon-new-folder" /></button>
                </div>
              </div>
              {workspace && <div className="explorer-sidebar__workspace" onContextMenu={(event) => { event.preventDefault(); setWorkspaceMenu({ x: event.clientX, y: event.clientY }); }}>{workspace.name}</div>}
              <Editor treeOnly />
            </>
          )}
          <div className="panel-resizer panel-resizer--right" onPointerDown={(event) => beginResize("explorer", event)} role="separator" aria-label="Resize Explorer" />
        </aside>

        <main className="editor-main">
          {showSettings ? <SettingsPage onClose={() => setShowSettings(false)} /> : !activeSessionId && !workspace ? <WelcomeView /> : <Editor />}
          <div className="panel-resizer panel-resizer--top" onPointerDown={(event) => beginResize("bottom", event)} role="separator" aria-label="Resize bottom panel" />
          <section className="bottom-panel" style={{ height: bottomHeight }}>
            <div className="bottom-panel__tabs">
              <button className={bottomTab === "terminal" ? "is-active" : ""} onClick={() => setBottomTab("terminal")}>Terminal</button>
              <button className={bottomTab === "problems" ? "is-active" : ""} onClick={() => setBottomTab("problems")}>Problems <span className="panel-count">0</span></button>
              <button className={bottomTab === "output" ? "is-active" : ""} onClick={() => setBottomTab("output")}>Output</button>
              <button className={bottomTab === "debug" ? "is-active" : ""} onClick={() => setBottomTab("debug")}>Debug Console</button>
              <span className="bottom-panel__spacer" />
              {activeSessionId && <span className={`connection-state connection-state--${wsStatus}`}><i /> {wsStatus}</span>}
              {activeSessionId && <button className="text-button" onClick={reconnectActiveWs}>Reconnect</button>}
            </div>
            <div className="bottom-panel__content">
              {/* No key on <Terminal>: a workspace change must not tear down
                  and respawn the native PTY (taskkill + ConPTY re-spawn) every
                  time a folder opens. Existing terminals persist; new ones open
                  in the current workspace cwd, like a real IDE. */}
              <div className="bottom-panel__terminal-host" hidden={bottomTab !== "terminal"}><Terminal /></div>
              {bottomTab === "problems" && <div className="bottom-panel__empty"><strong>No problems detected</strong><span>Problems will appear here after a file or task reports diagnostics.</span></div>}
              {bottomTab === "output" && <div className="bottom-panel__empty"><strong>Output channel ready</strong><span>Agent and tool output is streamed in the Terminal channel.</span></div>}
              {bottomTab === "debug" && <div className="bottom-panel__empty"><strong>Debug console</strong><span>Connect a running session to inspect runtime events.</span></div>}
            </div>
          </section>
        </main>

        <aside className="swarm-sidebar">
          <div className="swarm-sidebar__header">
            <span>AGENT SWARM</span>
            <button className="swarm-new-button" onClick={newSession}>+ New</button>
          </div>
          <div className="panel-resizer panel-resizer--left" onPointerDown={(event) => beginResize("swarm", event)} role="separator" aria-label="Resize Agent Swarm" />
          <SessionList />
          {activeSessionId && <HumanGateBanner />}
          {activeSessionId && (
            <>
              <div className="swarm-view-tabs">
                <button className={swarmView === "live" ? "is-active" : ""} onClick={() => setSwarmView("live")}>Live</button>
                <button className={swarmView === "walkthrough" ? "is-active" : ""} onClick={() => setSwarmView("walkthrough")}>Walkthrough</button>
              </div>
              {/* Both mount so each keeps its own WS subscription/history; only
                  the selected one is shown. Walkthrough = per-phase CDD contract
                  cards (the README's Contracting / artifact-contract surface). */}
              <div className="swarm-view" style={{ display: swarmView === "live" ? "flex" : "none" }}><Dashboard /></div>
              <div className="swarm-view" style={{ display: swarmView === "walkthrough" ? "flex" : "none" }}><WalkthroughPanel /></div>
            </>
          )}
        </aside>
      </div>
      {workspaceMenu && <ContextMenu x={workspaceMenu.x} y={workspaceMenu.y} items={workspaceMenuItems} onClose={() => setWorkspaceMenu(null)} />}
      {/* Git/Source Control UI is intentionally disabled for now. The backend
          and SourceControl component remain available for a future re-enable. */}
      <footer className="status-bar"><span className="status-bar__spacer" /><span className="status-bar__item">{workspace?.rootPath ?? "No folder opened"}</span></footer>
    </div>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <SessionProvider><Shell /></SessionProvider>
    </WorkspaceProvider>
  );
}

export default App;
