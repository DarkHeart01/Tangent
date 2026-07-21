import { useEffect, useState } from "react";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import { useWorkspace } from "../lib/WorkspaceContext";
import * as runtime from "../../wailsjs/runtime/runtime";

export default function TitleBar() {
  const { workspace } = useWorkspace();
  const location = workspace?.rootPath ?? "No folder opened";
  const [maximized, setMaximized] = useState(false);
  const [lightTheme, setLightTheme] = useState(false);

  const hasWindowRuntime = () => typeof window !== "undefined" && typeof (window as any).runtime?.WindowIsMaximised === "function";

  useEffect(() => {
    if (!hasWindowRuntime()) return;
    void runtime.WindowIsMaximised().then(setMaximized).catch(() => undefined);
  }, []);

  const toggleMaximize = async () => {
    if (!hasWindowRuntime()) return;
    try {
      const current = await runtime.WindowIsMaximised();
      if (current) runtime.WindowUnmaximise(); else runtime.WindowMaximise();
      setMaximized(!current);
    } catch { /* browser development mode has no Wails window */ }
  };

  const minimize = () => { if (hasWindowRuntime()) { try { runtime.WindowMinimise(); } catch { /* browser development mode */ } } };
  const quit = () => { if (hasWindowRuntime()) { try { runtime.Quit(); } catch { /* browser development mode */ } } };

  const toggleTheme = () => {
    setLightTheme((value) => {
      const next = !value;
      document.documentElement.classList.toggle("theme-light", next);
      try { if (next) runtime.WindowSetLightTheme(); else runtime.WindowSetDarkTheme(); } catch { /* browser development mode */ }
      return next;
    });
  };

  return (
    <header className="title-bar" style={{ "--wails-draggable": "drag" } as React.CSSProperties}>
      <div className="title-bar__brand"><span className="title-bar__logo codicon codicon-symbol-misc" /><strong>Tangent IDE</strong></div>
      <div className="title-bar__path">{location}<span>—</span> Tangent IDE</div>
      <div className="title-bar__tools">
        <button className="title-bar__theme" onClick={toggleTheme} title={lightTheme ? "Use dark theme" : "Use light theme"} style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}><span className="codicon codicon-color-mode" /></button>
        <span className="title-bar__control-separator" />
        <button className="window-control" onClick={minimize} title="Minimize" style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}><span className="codicon codicon-chrome-minimize" /></button>
        <button className="window-control" onClick={() => void toggleMaximize()} title={maximized ? "Restore" : "Maximize"} style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}><span className={`codicon ${maximized ? "codicon-chrome-restore" : "codicon-chrome-maximize"}`} /></button>
        <button className="window-control window-control--close" onClick={quit} title="Close" style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}><span className="codicon codicon-chrome-close" /></button>
      </div>
    </header>
  );
}
