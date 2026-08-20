import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { SessionProvider, useSession } from "./lib/SessionContext";
import Terminal from "./components/Terminal";
import Dashboard from "./components/Dashboard";
import Editor from "./components/Editor";
import HumanGateBanner from "./components/HumanGateBanner";
import WalkthroughPanel from "./components/WalkthroughPanel";
import SessionList from "./components/SessionList";
import SessionTabs from "./components/SessionTabs";
import WelcomeView from "./components/WelcomeView";
import AccessBar from "./components/AccessBar";
import AgentsWorkspace from "./components/AgentsWorkspace";
import SearchPanel from "./components/SearchPanel";
import SourceControl from "./components/SourceControl";
import RunDebugPanel from "./components/RunDebugPanel";
import ExtensionsPanel from "./components/ExtensionsPanel";
import AgentsPanel from "./components/AgentsPanel";
import PowersPanel from "./components/PowersPanel";
import SettingsPage from "./components/SettingsPage";
import ContextMenu, { type ContextMenuItem } from "./components/ContextMenu";
import { WorkspaceProvider, useWorkspace } from "./lib/WorkspaceContext";
import { CodeIntelProvider, useCodeIntel } from "./lib/codeintel/CodeIntelContext";
import CodeIntelSuggestionPanel from "./components/CodeIntelSuggestionPanel";
import ToastHost from "./components/ToastHost";
import { useSettings, setSettings, effectiveLevel } from "./lib/settings";
import * as wailsClient from "./lib/wailsClient";
import * as runtime from "../wailsjs/runtime/runtime";

function Shell() {
  const { activeSessionId, activeWsClient, reconnectActiveWs, newSession } = useSession();
  const { workspace, createFile, createFolder, openFolder, closeWorkspace } = useWorkspace();
  const { enabled: codeIntelEnabled, setEnabledForWorkspace, diagnosticsByFile, diagnosticCount } = useCodeIntel();
  const settings = useSettings();
  const { codeIntelPythonEnabled } = settings;
  const wsStatus = activeWsClient?.status ?? "closed";
  const [bottomTab, setBottomTab] = useState<"terminal" | "problems" | "output" | "debug">("terminal");
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [swarmWidth, setSwarmWidth] = useState(380);
  const [bottomHeight, setBottomHeight] = useState(230);
  const [workspaceMenu, setWorkspaceMenu] = useState<{ x: number; y: number } | null>(null);
  const [swarmView, setSwarmView] = useState<"live" | "walkthrough">("live");
  const [activeView, setActiveView] = useState<"explorer" | "search" | "source-control" | "run-debug" | "extensions" | "agents" | "powers">("explorer");
  const [showSettings, setShowSettings] = useState(false);
  const [activePage, setActivePage] = useState<"ide" | "agents">("ide");
  // Collapse toggles for the Access Bar's layout icons — remember the last
  // non-zero size so re-expanding restores whatever the user had resized to,
  // rather than snapping back to the default.
  const lastExplorerWidth = useRef(explorerWidth);
  const lastSwarmWidth = useRef(swarmWidth);
  const lastBottomHeight = useRef(bottomHeight);
  useEffect(() => { if (explorerWidth > 0) lastExplorerWidth.current = explorerWidth; }, [explorerWidth]);
  useEffect(() => { if (swarmWidth > 0) lastSwarmWidth.current = swarmWidth; }, [swarmWidth]);
  useEffect(() => { if (bottomHeight > 0) lastBottomHeight.current = bottomHeight; }, [bottomHeight]);
  const toggleExplorer = () => setExplorerWidth((w) => (w > 0 ? 0 : lastExplorerWidth.current || 240));
  const toggleSwarm = () => setSwarmWidth((w) => (w > 0 ? 0 : lastSwarmWidth.current || 380));
  const togglePanel = () => setBottomHeight((h) => (h > 0 ? 0 : lastBottomHeight.current || 230));
  // View menu's Problems/Output/Debug Console/Terminal items should both
  // select the tab and un-collapse the panel if it's currently hidden.
  const showPanel = useCallback((tab: "terminal" | "problems" | "output" | "debug") => {
    setBottomTab(tab);
    setBottomHeight((h) => (h > 0 ? h : lastBottomHeight.current || 230));
  }, []);
  // Customize Layout > Modes > Zen Mode -- collapses both sidebars and the
  // panel (reusing the same collapse/restore refs as the individual
  // visibility toggles) and hides the activity/menu/status bars via settings
  // flags (see the effective* booleans below). Escape exits, matching VS Code.
  const zenModeRef = useRef(false);
  useEffect(() => {
    if (settings.zenMode === zenModeRef.current) return;
    zenModeRef.current = settings.zenMode;
    if (settings.zenMode) {
      setExplorerWidth(0); setSwarmWidth(0); setBottomHeight(0);
    } else {
      setExplorerWidth(lastExplorerWidth.current || 240);
      setSwarmWidth(lastSwarmWidth.current || 380);
      setBottomHeight(lastBottomHeight.current || 230);
    }
  }, [settings.zenMode]);
  useEffect(() => {
    if (!settings.zenMode) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSettings({ zenMode: false }); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [settings.zenMode]);
  const effectiveMenuBarVisible = settings.menuBarVisible && !settings.zenMode;
  const effectiveActivityBarVisible = settings.activityBarVisible && !settings.zenMode;
  const effectiveStatusBarVisible = settings.statusBarVisible && !settings.zenMode;
  useEffect(() => {
    const focusTerminal = () => setBottomTab("terminal");
    window.addEventListener("tangent:focus-terminal", focusTerminal);
    return () => window.removeEventListener("tangent:focus-terminal", focusTerminal);
  }, []);
  // Footer data — published by SourceControl (git branch, once mounted) and
  // Dashboard (active-session budget) via window events rather than lifting
  // their state up, same pattern the file tree's git badges already use.
  const [gitSummary, setGitSummary] = useState<wailsClient.GitStatus | null>(null);
  const [sessionBudget, setSessionBudget] = useState<{ spent: number; allocated: number; progress: number } | null>(null);
  useEffect(() => {
    const onGit = (event: Event) => setGitSummary((event as CustomEvent<wailsClient.GitStatus | null>).detail ?? null);
    const onBudget = (event: Event) => setSessionBudget((event as CustomEvent<typeof sessionBudget>).detail ?? null);
    window.addEventListener("tangent:git-status-summary", onGit);
    window.addEventListener("tangent:session-budget", onBudget);
    return () => { window.removeEventListener("tangent:git-status-summary", onGit); window.removeEventListener("tangent:session-budget", onBudget); };
  }, []);
  // Real badge on the Source Control activity-bar icon (VS Code shows one
  // too) -- sum of changed/staged/conflicted files from the same GitStatus
  // the footer's branch indicator already reads.
  const changedCount = gitSummary ? gitSummary.changes.length + gitSummary.staged.length + gitSummary.conflicts.length : 0;
  const reportIssue = () => {
    const url = "https://github.com/DarkHeart01/Tangent/issues/new";
    if (typeof (window as any).runtime?.BrowserOpenURL === "function") { try { runtime.BrowserOpenURL(url); return; } catch { /* fall through */ } }
    window.open(url, "_blank", "noopener,noreferrer");
  };
  // The engine needs real filesystem access (it spawns a language server
  // with the workspace as its cwd) -- only meaningful for a workspace opened
  // through the native folder picker (workspace.backendRoot), not a
  // browser File System Access API or single-file workspace. When no such
  // workspace is open there's nothing valid to pass as a root; the Go side
  // tears down any previous engine instance the next time this fires with a
  // real root (or on app shutdown), so this is a no-op rather than a leak
  // in the common case of switching between workspaces.
  useEffect(() => {
    if (workspace?.backendRoot && workspace.rootPath) {
      void setEnabledForWorkspace(workspace.rootPath, codeIntelEnabled).catch(() => {});
    }
  }, [codeIntelEnabled, workspace?.backendRoot, workspace?.rootPath, setEnabledForWorkspace]);
  // Per-adapter toggle (spec §7): independent of the master switch above,
  // only meaningful once it's on.
  useEffect(() => {
    if (codeIntelEnabled) void wailsClient.codeIntelSetPythonEnabled(codeIntelPythonEnabled).catch(() => {});
  }, [codeIntelEnabled, codeIntelPythonEnabled]);
  // Three-level suggestion system: push the resolved numeric level (manual
  // or adaptive-derived) whenever it changes. Level 1 is always active once
  // enabled; this only gates whether folder/root-level triggers can fire.
  const level = effectiveLevel(settings);
  useEffect(() => {
    if (codeIntelEnabled) void wailsClient.codeIntelSetLevel(level).catch(() => {});
  }, [codeIntelEnabled, level]);
  // Opening a file (incl. from a search result) should surface the editor.
  useEffect(() => {
    const showEditor = () => setShowSettings(false);
    window.addEventListener("tangent:open-file", showEditor);
    return () => window.removeEventListener("tangent:open-file", showEditor);
  }, []);
  const beginResize = useCallback((target: "explorer" | "swarm" | "bottom", event: React.PointerEvent) => {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, explorer: explorerWidth, swarm: swarmWidth, bottom: bottomHeight };
    // When the Primary Side Bar is on the right (Customize Layout), its
    // resize handle sits on its left edge, so dragging left (negative delta)
    // should grow it -- invert the sign to match.
    const explorerSign = settings.primarySideBarPosition === "right" ? -1 : 1;
    const move = (next: PointerEvent) => {
      if (target === "explorer") setExplorerWidth(Math.min(420, Math.max(180, start.explorer + explorerSign * (next.clientX - start.x))));
      if (target === "swarm") setSwarmWidth(Math.min(520, Math.max(300, start.swarm - (next.clientX - start.x))));
      if (target === "bottom") setBottomHeight(Math.min(window.innerHeight * .7, Math.max(130, start.bottom - (next.clientY - start.y))));
    };
    const stop = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); document.body.style.cursor = ""; };
    document.body.style.cursor = target === "bottom" ? "row-resize" : "col-resize";
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", stop, { once: true });
  }, [bottomHeight, explorerWidth, swarmWidth, settings.primarySideBarPosition]);
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

  const sideBarRight = settings.primarySideBarPosition === "right";
  const activityBarEl = effectiveActivityBarVisible && (
    <nav className="activity-bar" aria-label="Activity bar">
      <button className={`activity-bar__button ${activeView === "explorer" && !showSettings ? "is-active" : ""}`} title="Explorer" aria-label="Explorer" onClick={() => { setActiveView("explorer"); setShowSettings(false); }}><span className="codicon codicon-files" /></button>
      <button className={`activity-bar__button ${activeView === "search" && !showSettings ? "is-active" : ""}`} title="Search" aria-label="Search" onClick={() => { setActiveView("search"); setShowSettings(false); }}><span className="codicon codicon-search" /></button>
      <button className={`activity-bar__button ${activeView === "source-control" && !showSettings ? "is-active" : ""}`} title="Source Control" aria-label="Source Control" onClick={() => { setActiveView("source-control"); setShowSettings(false); }}><span className="codicon codicon-source-control" />{changedCount > 0 && <span className="activity-bar__badge">{changedCount}</span>}</button>
      <button className={`activity-bar__button ${activeView === "run-debug" && !showSettings ? "is-active" : ""}`} title="Run and Debug" aria-label="Run and Debug" onClick={() => { setActiveView("run-debug"); setShowSettings(false); }}><span className="codicon codicon-debug-alt" /></button>
      <button className={`activity-bar__button ${activeView === "extensions" && !showSettings ? "is-active" : ""}`} title="Extensions" aria-label="Extensions" onClick={() => { setActiveView("extensions"); setShowSettings(false); }}><span className="codicon codicon-extensions" /></button>
      <button className={`activity-bar__button ${activeView === "agents" && !showSettings ? "is-active" : ""}`} title="Agents" aria-label="Agents" onClick={() => { setActiveView("agents"); setShowSettings(false); }}><span className="codicon codicon-hubot" /></button>
      <button className={`activity-bar__button ${activeView === "powers" && !showSettings ? "is-active" : ""}`} title="Powers" aria-label="Powers" onClick={() => { setActiveView("powers"); setShowSettings(false); }}><span className="codicon codicon-plug" /></button>
      <span className="activity-bar__spacer" />
      <button className={`activity-bar__button ${showSettings ? "is-active" : ""}`} title="Settings" aria-label="Settings" onClick={() => setShowSettings((value) => !value)}><span className="codicon codicon-settings-gear" /></button>
      <button className="activity-bar__button" title="Account" aria-label="Account"><span className="codicon codicon-account" /></button>
    </nav>
  );

  const explorerSidebarEl = (
    <aside className="explorer-sidebar">
      <div style={{ display: activeView === "explorer" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <div className="explorer-sidebar__header">
          <span>EXPLORER</span>
          <div className="explorer-sidebar__actions">
            <button className="icon-button" title="New File" aria-label="New File" disabled={!workspace} onClick={() => window.dispatchEvent(new CustomEvent("tangent:new-file"))}><span className="codicon codicon-new-file" /></button>
            <button className="icon-button" title="New Folder" aria-label="New Folder" disabled={!workspace} onClick={() => window.dispatchEvent(new CustomEvent("tangent:new-folder"))}><span className="codicon codicon-new-folder" /></button>
          </div>
        </div>
        {workspace && <div className="explorer-sidebar__workspace" onContextMenu={(event) => { event.preventDefault(); setWorkspaceMenu({ x: event.clientX, y: event.clientY }); }}>{workspace.name}</div>}
        <Editor treeOnly />
      </div>
      {activeView === "search" && (
        <>
          <div className="explorer-sidebar__header"><span>SEARCH</span></div>
          <SearchPanel />
        </>
      )}
      {/* Mounted whenever a workspace is open (not just while the Source
          Control view is active) so its git-status polling keeps the file
          tree's change badges and the footer's branch indicator live in
          the background — same always-mounted/display-toggle pattern the
          swarm sidebar uses below for Live vs Walkthrough. */}
      {workspace && (
        <div style={{ display: activeView === "source-control" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <SourceControl root={workspace.rootPath} />
        </div>
      )}
      {activeView === "run-debug" && <RunDebugPanel />}
      {activeView === "extensions" && <ExtensionsPanel />}
      {activeView === "agents" && <AgentsPanel />}
      {activeView === "powers" && <PowersPanel />}
      {/* Primary Side Bar Position (Customize Layout): the resize handle
          always lives on the edge touching the editor, so it flips sides
          along with the sidebar. */}
      <div className={`panel-resizer panel-resizer--${sideBarRight ? "left" : "right"}`} onPointerDown={(event) => beginResize("explorer", event)} role="separator" aria-label="Resize Explorer" />
    </aside>
  );

  const editorMainEl = (
    <main className={`editor-main ${settings.centeredLayout ? "is-centered" : ""}`}>
      {showSettings ? <SettingsPage onClose={() => setShowSettings(false)} /> : !activeSessionId && !workspace ? <WelcomeView /> : <Editor />}
          <div className="panel-resizer panel-resizer--top" onPointerDown={(event) => beginResize("bottom", event)} role="separator" aria-label="Resize bottom panel" />
          <section className="bottom-panel" style={{ height: bottomHeight }}>
            <div className="bottom-panel__tabs">
              <button className={bottomTab === "terminal" ? "is-active" : ""} onClick={() => setBottomTab("terminal")}>Terminal</button>
              <button className={bottomTab === "problems" ? "is-active" : ""} onClick={() => setBottomTab("problems")}>Problems <span className="panel-count">{diagnosticCount}</span></button>
              <button className={bottomTab === "output" ? "is-active" : ""} onClick={() => setBottomTab("output")}>Output</button>
              <button className={bottomTab === "debug" ? "is-active" : ""} onClick={() => setBottomTab("debug")}>Debug Console</button>
              <button disabled title="Port forwarding isn't available yet">Ports</button>
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
              {bottomTab === "problems" && (diagnosticCount === 0 ? (
                <div className="bottom-panel__empty"><strong>No problems detected</strong><span>Problems will appear here after a file or task reports diagnostics.</span></div>
              ) : (
                <div className="problems-list">
                  {Array.from(diagnosticsByFile.entries()).flatMap(([filePath, edges]) =>
                    edges.map((edge) => {
                      const relPath = workspace?.rootPath && filePath.startsWith(workspace.rootPath)
                        ? filePath.slice(workspace.rootPath.length).replace(/^[/\\]/, "")
                        : filePath;
                      return (
                        <div
                          key={edge.id}
                          className={`problems-list__item ${edge.resolution_state === "resolution-failed" ? "problems-list__item--failed" : ""}`}
                          onClick={() => window.dispatchEvent(new CustomEvent("tangent:open-file", { detail: { path: relPath, preview: false, line: edge.span.start_line + 1 } }))}
                        >
                          <span className="codicon codicon-error" />
                          <span>
                            <strong>{edge.message || `Unresolved reference: ${edge.to_name}`}</strong>
                            <span>{relPath}:{edge.span.start_line + 1}</span>
                            {edge.cross_language && (
                              <span className="problems-list__confidence" title={`Cross-language match via ${edge.bridge_adapter ?? "unknown adapter"}`}>
                                {edge.bridge_adapter === "openapi-schema" ? "schema" : edge.bridge_adapter ?? "bridge"} · {Math.round(edge.confidence * 100)}%
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    }),
                  )}
                </div>
              ))}
              {bottomTab === "output" && <div className="bottom-panel__empty"><strong>Output channel ready</strong><span>Agent and tool output is streamed in the Terminal channel.</span></div>}
              {bottomTab === "debug" && <div className="bottom-panel__empty"><strong>Debug console</strong><span>Connect a running session to inspect runtime events.</span></div>}
            </div>
          </section>
        </main>
  );

  const swarmSidebarEl = (
    <aside className="swarm-sidebar">
      <SessionTabs />
      <div className="panel-resizer panel-resizer--left" onPointerDown={(event) => beginResize("swarm", event)} role="separator" aria-label="Resize Agent Swarm" />
      {!activeSessionId && <SessionList />}
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
  );

  // Customize Layout > Primary Side Bar Position: track sizes and DOM order
  // both flip together so the sidebar always sits directly against the
  // editor, with the activity bar on its outer edge and the swarm/secondary
  // sidebar staying the outermost-right element either way (matches VS
  // Code's real behavior: Secondary Side Bar position is independent of
  // Primary's).
  const activityBarTrack = effectiveActivityBarVisible ? "56px" : "0px";
  const gridColumns = sideBarRight
    ? `minmax(380px, 1fr) var(--explorer-width, 240px) ${activityBarTrack} var(--swarm-width, 380px)`
    : `${activityBarTrack} var(--explorer-width, 240px) minmax(380px, 1fr) var(--swarm-width, 380px)`;

  return (
    <div id="App" style={{ zoom: settings.uiZoomLevel } as React.CSSProperties}>
      <AccessBar
        activePage={activePage}
        onSwitchPage={setActivePage}
        onNewSession={newSession}
        onResetLayout={() => { setExplorerWidth(240); setSwarmWidth(380); setBottomHeight(230); }}
        onOpenSearch={() => { setActivePage("ide"); setActiveView("search"); setShowSettings(false); }}
        onToggleExplorer={toggleExplorer}
        onTogglePanel={togglePanel}
        onToggleSwarm={toggleSwarm}
        onOpenSettings={() => setShowSettings(true)}
        onShowView={(view) => { setActivePage("ide"); setActiveView(view); setShowSettings(false); }}
        onShowPanel={(tab) => { setActivePage("ide"); showPanel(tab); }}
        menuBarVisible={effectiveMenuBarVisible}
        explorerVisible={explorerWidth > 0}
        swarmVisible={swarmWidth > 0}
        panelVisible={bottomHeight > 0}
      />
      {activePage === "agents" ? <AgentsWorkspace /> : (
        <div className="ide-body" style={{ "--explorer-width": `${explorerWidth}px`, "--swarm-width": `${swarmWidth}px`, gridTemplateColumns: gridColumns } as React.CSSProperties}>
          {sideBarRight ? <>{editorMainEl}{explorerSidebarEl}{activityBarEl}{swarmSidebarEl}</> : <>{activityBarEl}{explorerSidebarEl}{editorMainEl}{swarmSidebarEl}</>}
        </div>
      )}
      {workspaceMenu && <ContextMenu x={workspaceMenu.x} y={workspaceMenu.y} items={workspaceMenuItems} onClose={() => setWorkspaceMenu(null)} />}
      {effectiveStatusBarVisible && (
        <footer className="status-bar">
          <button className="status-bar__item" title={workspace?.rootPath ?? "No folder opened"} onClick={() => { setActivePage("ide"); setActiveView("source-control"); setShowSettings(false); }} disabled={!workspace}>
            <span className="codicon codicon-git-branch" />{gitSummary?.branch ?? workspace?.name ?? "No folder opened"}
          </button>
          <button className="status-bar__item" title="Problems" onClick={() => { setActivePage("ide"); setBottomTab("problems"); }}>
            <span className="codicon codicon-error" />{diagnosticCount}
            <span className="codicon codicon-warning" />0
          </button>
          <span className="status-bar__spacer" />
          <button className={`status-bar__item ${codeIntelEnabled ? "is-on" : ""}`} title={codeIntelEnabled ? "Live Code Intelligence: on" : "Live Code Intelligence: off"} onClick={() => setSettings({ codeIntelEnabled: !codeIntelEnabled })}>
            <span className="codicon codicon-zap" />Autocomplete
          </button>
          <button className="status-bar__item" title="Report an issue" onClick={reportIssue}><span className="codicon codicon-question" />Report issue</button>
          {sessionBudget && (
            <span className="status-bar__meter" title={`${sessionBudget.spent.toFixed(2)} / ${sessionBudget.allocated.toFixed(2)} budget used`}>
              <span className="status-bar__meter-track"><span style={{ width: `${sessionBudget.progress}%` }} /></span>
              {sessionBudget.progress.toFixed(1)}% used
            </span>
          )}
        </footer>
      )}
      {codeIntelEnabled && <CodeIntelSuggestionPanel />}
      <ToastHost />
    </div>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <SessionProvider><CodeIntelProvider><Shell /></CodeIntelProvider></SessionProvider>
    </WorkspaceProvider>
  );
}

export default App;
