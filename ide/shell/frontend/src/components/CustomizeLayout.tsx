import { useSettings, setSettings } from "../lib/settings";
import { notYetWired } from "../lib/toast";

type CustomizeLayoutProps = {
  onClose: () => void;
  explorerVisible: boolean;
  swarmVisible: boolean;
  panelVisible: boolean;
  onToggleExplorer: () => void;
  onToggleSwarm: () => void;
  onTogglePanel: () => void;
  onResetSizes: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
};

function Mark({ on }: { on: boolean }) {
  return <span className={`codicon codicon-check menu-item__check ${on ? "" : "is-hidden"}`} />;
}

// VS Code's real "Customize Layout" panel (opened from the Access Bar's
// layout icon) -- almost entirely real, reusing the same collapse state the
// individual layout-toggle icons already drive. Panel Alignment is the one
// section that's genuinely mocked: VS Code aligns the panel against the
// whole window (including under the sidebars), but ours only ever spans the
// editor column, so Left/Right/Justify have nothing real to mean here.
export default function CustomizeLayout({ onClose, explorerVisible, swarmVisible, panelVisible, onToggleExplorer, onToggleSwarm, onTogglePanel, onResetSizes, fullscreen, onToggleFullscreen }: CustomizeLayoutProps) {
  const settings = useSettings();

  const reset = () => {
    setSettings({ menuBarVisible: true, activityBarVisible: true, statusBarVisible: true, primarySideBarPosition: "left", quickInputPosition: "top", zenMode: false, centeredLayout: false });
    if (!explorerVisible) onToggleExplorer();
    if (!swarmVisible) onToggleSwarm();
    if (!panelVisible) onTogglePanel();
    onResetSizes();
  };

  return (
    <div className="customize-layout">
      <div className="customize-layout__header">
        <span>Customize Layout</span>
        <div>
          <button title="Restore Defaults" onClick={reset}><span className="codicon codicon-refresh" /></button>
          <button title="Close" onClick={onClose}><span className="codicon codicon-close" /></button>
        </div>
      </div>
      <div className="customize-layout__body">
        <button onClick={() => setSettings({ menuBarVisible: !settings.menuBarVisible })}><Mark on={settings.menuBarVisible} /><span>Menu Bar</span></button>
        <button onClick={() => setSettings({ activityBarVisible: !settings.activityBarVisible })}><Mark on={settings.activityBarVisible} /><span>Activity Bar</span></button>
        <button onClick={onToggleExplorer}><Mark on={explorerVisible} /><span>Primary Side Bar</span><kbd>Ctrl+B</kbd></button>
        <button onClick={onToggleSwarm}><Mark on={swarmVisible} /><span>Secondary Side Bar</span><kbd>Ctrl+Alt+B</kbd></button>
        <button onClick={onTogglePanel}><Mark on={panelVisible} /><span>Panel</span><kbd>Ctrl+J</kbd></button>
        <button onClick={() => setSettings({ statusBarVisible: !settings.statusBarVisible })}><Mark on={settings.statusBarVisible} /><span>Status Bar</span></button>
        <hr />
        <div className="customize-layout__group-label">Primary Side Bar Position</div>
        <button onClick={() => setSettings({ primarySideBarPosition: "left" })}><Mark on={settings.primarySideBarPosition === "left"} /><span>Left</span></button>
        <button onClick={() => setSettings({ primarySideBarPosition: "right" })}><Mark on={settings.primarySideBarPosition === "right"} /><span>Right</span></button>
        <hr />
        <div className="customize-layout__group-label">Panel Alignment</div>
        <button onClick={() => notYetWired("Panel alignment — our panel always spans the editor column")}><Mark on={false} /><span>Left</span></button>
        <button onClick={() => notYetWired("Panel alignment")}><Mark on={false} /><span>Right</span></button>
        <button onClick={() => notYetWired("Panel alignment")}><Mark on={true} /><span>Center</span></button>
        <button onClick={() => notYetWired("Panel alignment")}><Mark on={false} /><span>Justify</span></button>
        <hr />
        <div className="customize-layout__group-label">Quick Input Position</div>
        <button onClick={() => setSettings({ quickInputPosition: "top" })}><Mark on={settings.quickInputPosition === "top"} /><span>Top</span></button>
        <button onClick={() => setSettings({ quickInputPosition: "center" })}><Mark on={settings.quickInputPosition === "center"} /><span>Center</span></button>
        <hr />
        <div className="customize-layout__group-label">Modes</div>
        <button onClick={onToggleFullscreen}><Mark on={fullscreen} /><span>Full Screen</span><kbd>F11</kbd></button>
        <button onClick={() => setSettings({ zenMode: !settings.zenMode })}><Mark on={settings.zenMode} /><span>Zen Mode</span><kbd>Ctrl+K Z</kbd></button>
        <button onClick={() => setSettings({ centeredLayout: !settings.centeredLayout })}><Mark on={settings.centeredLayout} /><span>Centered Layout</span></button>
      </div>
    </div>
  );
}
